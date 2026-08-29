/* eslint-disable no-console */

// This smoke only uses a temporary policy/state tree.  It verifies that
// maintenance archives terminal reservations without freeing versions and that
// lock metadata cleanup is fail-closed while an OS lock is held.

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const maintenanceScript = path.join(root, "scripts", "release-maintenance.ps1");
const lockScript = path.join(root, "scripts", "release-lock.ps1");

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodedCommand(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function runPowerShell(command, options = {}) {
  return childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(command)],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, ...options }
  );
}

function parseJson(result, label) {
  assert.strictEqual(result.status, 0, `${label} failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.length, `${label} returned no JSON`);
  try { return JSON.parse(lines[lines.length - 1]); }
  catch (error) { throw new Error(`${label} JSON parse failed: ${error.message}\n${result.stdout}`); }
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-maintenance-smoke-"));
const canonical = path.join(tempRoot, "wechat-miniapp");
const reservationRoot = path.join(tempRoot, "reservations");
const recordRoot = path.join(tempRoot, "records");
const contextRoot = path.join(tempRoot, "contexts");
const logRoot = path.join(tempRoot, "logs");
const queueRoot = path.join(tempRoot, "queue");
const artifactRoot = path.join(tempRoot, "artifacts");
const lockPath = path.join(tempRoot, "release.lock");
const policyPath = path.join(tempRoot, "policy.json");
const ownerPath = `${lockPath}.owner.json`;
const pendingPath = `${lockPath}.pending.json`;
const oldOperation = "op-20200101T000000000Z-archive01";
const liveOperation = "op-20200101T000000000Z-live01";

try {
  for (const directory of [canonical, reservationRoot, recordRoot, contextRoot, logRoot, queueRoot, artifactRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const policy = {
    schemaVersion: 1,
    canonicalRepo: canonical,
    remote: "https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git",
    branch: "main",
    lockPath,
    artifactRoot,
    reservationRoot,
    worktreeRoot: path.join(tempRoot, "worktrees"),
    recordRoot,
    contextRoot,
    logRoot,
    queueRoot,
    archiveManifestPath: path.join(tempRoot, "archive.json"),
    queue: { waitSeconds: 5, pollMilliseconds: 50, leaseSeconds: 30, staleAfterSeconds: 5 },
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy), "utf8");
  fs.writeFileSync(path.join(queueRoot, "queue.json"), JSON.stringify({ tickets: [
    { operationId: oldOperation, status: "failed", phase: "failed" },
    { operationId: liveOperation, status: "queued", phase: "prepared" },
  ] }), "utf8");
  const oldReservation = path.join(reservationRoot, `reservation-0.1.0-${oldOperation}.json`);
  const liveReservation = path.join(reservationRoot, `reservation-0.2.0-${liveOperation}.json`);
  fs.writeFileSync(oldReservation, JSON.stringify({
    schemaVersion: 1, operationId: oldOperation, targetVersion: "0.1.0", status: "failed",
    createdAt: "2020-01-01T00:00:00Z",
  }), "utf8");
  fs.writeFileSync(liveReservation, JSON.stringify({
    schemaVersion: 1, operationId: liveOperation, targetVersion: "0.2.0", status: "prepared",
    createdAt: "2020-01-01T00:00:00Z",
  }), "utf8");

  const base = [
    `. ${psQuote(maintenanceScript)}`,
    `$policy = Get-Content -LiteralPath ${psQuote(policyPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
  ];
  const inventory = parseJson(runPowerShell([
    ...base,
    "$items = @(Get-ReleaseMaintenanceReservationInventory -Policy $policy)",
    "$items | ConvertTo-Json -Depth 30 -Compress",
  ].join("; ")), "reservation inventory");
  assert.strictEqual(inventory.length, 2, "inventory should contain both reservations");
  const oldItem = inventory.find((item) => item.operationId === oldOperation);
  const liveItem = inventory.find((item) => item.operationId === liveOperation);
  assert.ok(oldItem.archiveable, "failed reservation should be archiveable");
  assert.strictEqual(liveItem.archiveable, false, "prepared reservation must not be archiveable");

  const archived = parseJson(runPowerShell([
    ...base,
    `$lock = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion 'maintenance' -TargetType 'smoke' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId 'maintenance-smoke' -LeaseSeconds 30 -Stage 'maintenance'`,
    "try { $result = Invoke-ReleaseReservationArchive -Policy $policy -OlderThanHours 1; $result | ConvertTo-Json -Depth 30 -Compress } finally { Exit-ReleaseLock -LockHandle $lock }",
  ].join("; ")), "reservation archive");
  assert.strictEqual(archived.archivedCount, 1, "exactly one terminal reservation should be archived");
  assert.ok(fs.existsSync(path.join(reservationRoot, "archive", path.basename(oldReservation))));
  assert.ok(fs.existsSync(oldReservation), "archive must not delete original reservation");
  assert.ok(fs.existsSync(liveReservation), "archive must not touch prepared reservation");
  const archiveIndex = JSON.parse(fs.readFileSync(path.join(reservationRoot, "archive", "reservation-archive-index.json"), "utf8"));
  assert.strictEqual(archiveIndex.versionReuseAllowed, false, "archived version must remain reserved");

  // Create terminal orphan lock metadata and verify the read-only inspection.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999, operationId: oldOperation, startedAt: "2020-01-01T00:00:00Z",
    processStartUtc: "2020-01-01T00:00:00Z", lastHeartbeat: "2020-01-01T00:00:00Z",
  }), "utf8");
  fs.writeFileSync(ownerPath, fs.readFileSync(lockPath));
  const inspection = parseJson(runPowerShell([
    ...base,
    "$r = Get-ReleaseLockInspection -Policy $policy -StaleAfterSeconds 5",
    "$r | ConvertTo-Json -Depth 30 -Compress",
  ].join("; ")), "orphan lock inspection");
  assert.strictEqual(inspection.osLockAvailable, true);
  assert.strictEqual(inspection.orphan, true);
  assert.strictEqual(inspection.safeToCleanup, true);

  const cleaned = parseJson(runPowerShell([
    ...base,
    "$r = Invoke-ReleaseOrphanLockMetadataCleanup -Policy $policy -ConfirmCleanup -StaleAfterSeconds 5",
    "$r | ConvertTo-Json -Depth 30 -Compress",
  ].join("; ")), "orphan lock cleanup");
  assert.strictEqual(cleaned.changed, true);
  assert.strictEqual(fs.existsSync(ownerPath), false, "owner sidecar should be removed after backup");
  assert.strictEqual(fs.statSync(lockPath).size, 0, "lock file must remain but be empty");
  assert.ok(fs.existsSync(cleaned.backupPath), "orphan metadata backup is required");

  // Hold the real OS lock in a child and ensure cleanup fails closed.
  const holderPath = path.join(tempRoot, "holder.ps1");
  fs.writeFileSync(holderPath, [
    `. ${psQuote(lockScript)}`,
    `$l = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion '0.3.0' -TargetType 'holder' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId '${liveOperation}' -LeaseSeconds 30 -Stage 'running'`,
    "try { Write-Output 'LOCKED'; [Console]::Out.Flush(); Start-Sleep -Seconds 3 } finally { Exit-ReleaseLock -LockHandle $l }",
    "",
  ].join("\n"), "utf8");
  const holder = childProcess.spawn("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath], { cwd: root, windowsHide: true, stdio: "ignore" });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ownerPath) && Date.now() < deadline) sleepMs(50);
  assert.ok(fs.existsSync(ownerPath), "holder did not acquire lock");
  const blocked = runPowerShell([
    ...base,
    "$r = Invoke-ReleaseOrphanLockMetadataCleanup -Policy $policy -ConfirmCleanup -StaleAfterSeconds 5",
    "$r | ConvertTo-Json -Depth 30 -Compress",
  ].join("; "));
  assert.notStrictEqual(blocked.status, 0, "cleanup must reject an actively held OS lock");
  holder.kill();
  try { holder.on("close", () => {}); } catch (_) { /* best effort */ }

  console.log("release maintenance smoke: OK");
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
