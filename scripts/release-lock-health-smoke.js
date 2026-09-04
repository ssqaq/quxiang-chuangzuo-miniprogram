/* eslint-disable no-console */

// Read-only publish-lock preflight contract.  The fixtures live in a
// temporary tree so this smoke never touches the real release queue/lock.

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const lockScript = path.join(root, "scripts", "release-lock.ps1");
const releaseScript = path.join(root, "scripts", "release.ps1");
const resumeScript = path.join(root, "scripts", "resume-release.ps1");

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
    { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, ...options }
  );
}

function parseJson(result, label) {
  assert.strictEqual(result.status, 0, `${label} failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.length, `${label} returned no JSON`);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    throw new Error(`${label} JSON parse failed: ${error.message}\n${result.stdout}`);
  }
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-lock-health-smoke-"));
const canonical = path.join(tempRoot, "wechat-miniapp");
const queueRoot = path.join(tempRoot, "queue");
const contextRoot = path.join(tempRoot, "contexts");
const recordRoot = path.join(tempRoot, "records");
const lockPath = path.join(tempRoot, "release.lock");
const policyPath = path.join(tempRoot, "policy.json");
const ownerPath = `${lockPath}.owner.json`;
const pendingPath = `${lockPath}.pending.json`;

const terminalOperation = "op-20200101T000000000Z-terminal01";
const pendingOperation = "op-20200101T000000000Z-pending01";
const otherOperation = "op-20200101T000000000Z-other01";
const unknownOperation = "op-20200101T000000000Z-unknown01";

function writeQueue(tickets) {
  fs.writeFileSync(path.join(queueRoot, "queue.json"), JSON.stringify({ tickets }), "utf8");
}

function writeOwner(operationId, pid = 999999) {
  const owner = {
    pid,
    operationId,
    startedAt: "2020-01-01T00:00:00Z",
    processStartUtc: "2020-01-01T00:00:00Z",
    lastHeartbeat: "2020-01-01T00:00:00Z",
    targetVersion: "0.1.0",
    targetType: "smoke",
  };
  const text = JSON.stringify(owner);
  fs.writeFileSync(lockPath, text, "utf8");
  fs.writeFileSync(ownerPath, text, "utf8");
}

function inspect(policy, label, expectedOperationId = "") {
  const expectedArg = expectedOperationId
    ? ` -ExpectedOperationId ${psQuote(expectedOperationId)}`
    : "";
  return parseJson(runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$policy = Get-Content -LiteralPath ${psQuote(policyPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `$result = Get-ReleasePublishLockHealth -Policy $policy -StaleAfterSeconds 5${expectedArg}`,
    "$result | ConvertTo-Json -Depth 20 -Compress",
  ].join("; ")), label);
}

try {
  for (const directory of [canonical, queueRoot, contextRoot, recordRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const policy = {
    schemaVersion: 1,
    canonicalRepo: canonical,
    lockPath,
    queueRoot,
    contextRoot,
    recordRoot,
  };
  fs.writeFileSync(policyPath, JSON.stringify(policy), "utf8");

  // No lock metadata is a healthy starting state.
  writeQueue([]);
  let result = inspect(policy, "missing lock");
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.reason, "lock-file-missing");

  // A stale owner is allowed only when its durable operation is terminal.
  writeQueue([{ operationId: terminalOperation, status: "succeeded", phase: "succeeded" }]);
  writeOwner(terminalOperation);
  result = inspect(policy, "terminal residue");
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.reason, "terminal-metadata");

  // A prepared/queued operation must block before publish can claim a lease.
  writeQueue([{ operationId: pendingOperation, status: "queued", phase: "prepared" }]);
  writeOwner(pendingOperation);
  result = inspect(policy, "non-terminal residue");
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  const blocked = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$policy = Get-Content -LiteralPath ${psQuote(policyPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    "Assert-ReleasePublishLockHealth -Policy $policy -StaleAfterSeconds 5 | ConvertTo-Json -Depth 20 -Compress",
  ].join("; "));
  assert.notStrictEqual(blocked.status, 0, "non-terminal residue must block Assert");
  assert.match(`${blocked.stdout || ""}\n${blocked.stderr || ""}`, /非终态残留锁/);

  // Only resume for this exact queued/prepared operation may opt into the
  // exception.  A different expected id must remain blocked.
  result = inspect(policy, "expected prepared residue", pendingOperation);
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.reason, "expected-nonterminal-residue");
  const allowed = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$policy = Get-Content -LiteralPath ${psQuote(policyPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `Assert-ReleasePublishLockHealth -Policy $policy -StaleAfterSeconds 5 -ExpectedOperationId ${psQuote(pendingOperation)} | ConvertTo-Json -Depth 20 -Compress`,
  ].join("; "));
  assert.strictEqual(allowed.status, 0, "同 operation 的 prepared residue 应允许显式 resume");
  result = inspect(policy, "wrong expected operation", otherOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  writeQueue([{ operationId: pendingOperation, status: "queued", phase: "pr-opened" }]);
  result = inspect(policy, "disallowed prepared phase", pendingOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  writeQueue([{ operationId: pendingOperation, status: "queued", phase: "prepared" }]);
  writeOwner(unknownOperation);
  result = inspect(policy, "unknown expected operation", unknownOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  writeOwner(pendingOperation);

  // A pending cloud task may be the only durable identity after Exit removes
  // the owner sidecar.  It is resumable only for the exact operation and only
  // while its queue ticket remains queued/prepared.
  fs.rmSync(lockPath, { force: true });
  fs.rmSync(ownerPath, { force: true });
  fs.rmSync(pendingPath, { force: true });
  const pendingRelease = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$l = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion '0.1.0' -TargetType 'health-pending' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId '${pendingOperation}' -LeaseSeconds 30 -Stage 'prepared'`,
    `Write-ReleasePending -PendingPath ${psQuote(pendingPath)} -Record ([ordered]@{ operationId = '${pendingOperation}'; taskId = 'task-smoke' })`,
    "try { Write-Output 'PENDING_ACQUIRED' } finally { Exit-ReleaseLock -LockHandle $l }",
  ].join("; "));
  assert.strictEqual(
    pendingRelease.status,
    0,
    `pending lock acquire/release failed\n${pendingRelease.stdout || ""}\n${pendingRelease.stderr || ""}`
  );
  assert.ok(fs.existsSync(pendingPath), "pending sidecar 应在释放锁后保留以供恢复");
  assert.ok(!fs.existsSync(ownerPath), "pending-only 场景不应保留 owner sidecar");
  assert.strictEqual(fs.statSync(lockPath).size, 0, "pending-only 场景锁正文必须清空");
  result = inspect(policy, "pending-only residue", pendingOperation);
  assert.strictEqual(result.healthy, true);
  assert.strictEqual(result.reason, "expected-nonterminal-residue");
  result = inspect(policy, "pending-only wrong operation", otherOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  result = inspect(policy, "pending-only without expected");
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "nonterminal-residue");
  writeOwner(pendingOperation);
  fs.writeFileSync(pendingPath, JSON.stringify({ operationId: otherOperation, taskId: "task-mismatch" }), "utf8");
  result = inspect(policy, "owner pending identity mismatch", pendingOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "metadata-mismatch");
  fs.writeFileSync(pendingPath, "{not-json", "utf8");
  result = inspect(policy, "invalid pending metadata", pendingOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "metadata-mismatch");
  fs.writeFileSync(pendingPath, JSON.stringify({ taskId: "task-missing-operation" }), "utf8");
  result = inspect(policy, "pending metadata without operation", pendingOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "metadata-mismatch");
  fs.rmSync(pendingPath, { force: true });
  writeOwner(pendingOperation);

  // A normal release must clear the embedded owner before deleting its
  // sidecar.  Prepared operations are intentionally non-terminal, so leaving
  // the old lock body behind would make the next resume fail its preflight.
  fs.rmSync(lockPath, { force: true });
  fs.rmSync(ownerPath, { force: true });
  fs.rmSync(pendingPath, { force: true });
  const acquireAndRelease = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$l = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion '0.1.0' -TargetType 'health-release' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId '${pendingOperation}' -LeaseSeconds 30 -Stage 'prepared'`,
    "try { Write-Output 'ACQUIRED' } finally { Exit-ReleaseLock -LockHandle $l }",
  ].join("; "));
  assert.strictEqual(
    acquireAndRelease.status,
    0,
    `prepared lock acquire/release failed\n${acquireAndRelease.stdout || ""}\n${acquireAndRelease.stderr || ""}`
  );
  assert.ok(!fs.existsSync(ownerPath), "正常释放后 owner sidecar 应被删除");
  assert.strictEqual(fs.statSync(lockPath).size, 0, "正常释放后锁正文必须清空");
  result = inspect(policy, "prepared release");
  assert.strictEqual(result.healthy, true, "prepared 操作正常释放后健康检查不应阻断恢复");
  assert.strictEqual(result.reason, "empty-lock-file");
  const reacquire = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$l = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion '0.1.0' -TargetType 'health-reacquire' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId '${pendingOperation}' -LeaseSeconds 30 -Stage 'resume'`,
    "try { Write-Output 'REACQUIRED' } finally { Exit-ReleaseLock -LockHandle $l }",
  ].join("; "));
  assert.strictEqual(
    reacquire.status,
    0,
    `prepared lock reacquire failed after normal release\n${reacquire.stdout || ""}\n${reacquire.stderr || ""}`
  );
  assert.ok(reacquire.stdout.includes("REACQUIRED"));

  // An actually held OS lock is a separate fail-closed condition.
  fs.rmSync(lockPath, { force: true });
  fs.rmSync(ownerPath, { force: true });
  fs.rmSync(pendingPath, { force: true });
  const holderPath = path.join(tempRoot, "holder.ps1");
  fs.writeFileSync(holderPath, [
    `. ${psQuote(lockScript)}`,
    `$l = Enter-ReleaseLock -ProjectPath ${psQuote(canonical)} -TargetVersion '0.1.1' -TargetType 'health-holder' -WaitSeconds 3 -LockPath ${psQuote(lockPath)} -ProjectId '${pendingOperation}' -LeaseSeconds 30 -Stage 'running'`,
    "try { Start-Sleep -Seconds 5 } finally { Exit-ReleaseLock -LockHandle $l }",
    "",
  ].join("\n"), "utf8");
  const holder = childProcess.spawn("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ownerPath) && Date.now() < deadline) sleepMs(50);
  assert.ok(fs.existsSync(ownerPath), "OS-lock holder did not publish owner metadata");
  result = inspect(policy, "active lock");
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "active-lock");
  result = inspect(policy, "active lock same expected operation", pendingOperation);
  assert.strictEqual(result.healthy, false);
  assert.strictEqual(result.reason, "active-lock");
  holder.kill();
  try { holder.on("close", () => {}); } catch (_) { /* best effort */ }

  // Keep the call/order contract in the release entry points.
  const releaseText = fs.readFileSync(releaseScript, "utf8");
  const resumeText = fs.readFileSync(resumeScript, "utf8");
  assert.ok(releaseText.includes("Assert-ReleasePublishLockHealth"), "release entry must call lock health preflight");
  assert.ok(resumeText.includes("Assert-ReleasePublishLockHealth"), "resume entry must call lock health preflight");
  assert.ok(releaseText.indexOf("Assert-ReleasePublishLockHealth") < releaseText.indexOf("New-ReleaseQueueTicket"), "release preflight must precede queue ticket creation");
  assert.ok(resumeText.indexOf("Assert-ReleasePublishLockHealth") < resumeText.indexOf("Claim-ReleaseQueueTicket"), "resume preflight must precede queue claim");
  assert.ok(resumeText.includes("-ExpectedOperationId $OperationId"), "resume 必须只为当前 operation 传入 expected id");

  console.log("release lock health smoke: OK");
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
