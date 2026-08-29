/* eslint-disable no-console */

// Temporary-state smoke for rollback-release.ps1.  It proves that rollback
// validates the immutable package/manifest/context, requires explicit apply,
// writes a backup before the local pointer, and never touches CloudBase.

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rollbackScript = path.join(root, "scripts", "rollback-release.ps1");

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodedCommand(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function runPowerShell(command) {
  return childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(command)],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
  );
}

function parseJson(result, label) {
  assert.strictEqual(result.status, 0, `${label} failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  const lines = String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.length, `${label} returned no JSON`);
  try { return JSON.parse(lines[lines.length - 1]); }
  catch (error) { throw new Error(`${label} JSON parse failed: ${error.message}\n${result.stdout}`); }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-release-smoke-"));
const canonical = path.join(tempRoot, "wechat-miniapp");
const artifactRoot = path.join(tempRoot, "artifacts");
const recordRoot = path.join(tempRoot, "records");
const contextRoot = path.join(tempRoot, "contexts");
const reservationRoot = path.join(tempRoot, "reservations");
const queueRoot = path.join(tempRoot, "queue");
const logRoot = path.join(tempRoot, "logs");
const lockPath = path.join(tempRoot, "release.lock");
const version = "1.2.3";
const operationId = "op-20200101T000000000Z-rollback01";
const sourceCommit = "a".repeat(40);
const releaseCommit = "b".repeat(40);
const treeSha = "c".repeat(40);
const sourceSha256 = "d".repeat(64);
const packageName = `wechat-miniapp-release-v${version}-${releaseCommit}.zip`;
const packagePath = path.join(artifactRoot, packageName);
const recordPath = path.join(recordRoot, `release-v${version}-${releaseCommit}.json`);
const contextPath = path.join(contextRoot, `release-${operationId}.json`);

try {
  for (const directory of [canonical, artifactRoot, recordRoot, contextRoot, reservationRoot, queueRoot, logRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const manifest = [
    "圈像创作微信小程序发布包",
    `操作 ID：${operationId}`,
    `版本：${version}`,
    "源码来源：canonical",
    `源提交 SHA：${sourceCommit}`,
    `提交 SHA：${releaseCommit}`,
    `Git tree SHA：${treeSha}`,
    `源码内容 SHA256：${sourceSha256}`,
    `产物文件名：${packageName}`,
  ].join("\n");
  const pyCode = [
    "import os, zipfile",
    "p=os.environ['ROLLBACK_ZIP']",
    "m=os.environ['ROLLBACK_MANIFEST']",
    "z=zipfile.ZipFile(p, 'w', zipfile.ZIP_DEFLATED)",
    "z.writestr('app.json', '{\\\"pages\\\":[]}')",
    "z.writestr('RELEASE-MANIFEST.txt', m.encode('utf-8'))",
    "z.close()",
  ].join(";");
  const py = childProcess.spawnSync("python", ["-c", pyCode], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ROLLBACK_ZIP: packagePath, ROLLBACK_MANIFEST: manifest },
  });
  assert.strictEqual(py.status, 0, `create test ZIP failed\n${py.stdout}\n${py.stderr}`);
  const packageSha256 = crypto.createHash("sha256").update(fs.readFileSync(packagePath)).digest("hex");
  fs.writeFileSync(recordPath, JSON.stringify({
    schemaVersion: 2,
    operationId,
    status: "succeeded",
    terminalStatus: "succeeded",
    version,
    sourceCommit,
    releaseCommit,
    treeSha,
    sourceSha256,
    packageSha256,
    packagePath,
    contextPath,
    phase: "merged",
  }), "utf8");
  // Deliberately expired: rollback validates identity but does not re-use a
  // short-lived publish context to perform a new deployment.
  fs.writeFileSync(contextPath, JSON.stringify({
    schemaVersion: 2,
    operationId,
    canonicalRepo: canonical,
    remote: "https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git",
    branch: "main",
    version,
    sourceCommit,
    releaseCommit,
    treeSha,
    sourceSha256,
    artifactPath: packagePath,
    packageSha256,
    baseHead: sourceCommit,
    expiresAt: "2020-01-01T00:00:00Z",
    phase: "merged",
    status: "succeeded",
  }), "utf8");
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
  const policyPath = path.join(tempRoot, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify(policy), "utf8");
  const base = [
    `. ${psQuote(rollbackScript)}`,
    `$policy = Get-Content -LiteralPath ${psQuote(policyPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
  ];

  const preview = parseJson(runPowerShell([
    ...base,
    `$r = Invoke-ReleaseRollback -Policy $policy -TargetVersion '${version}'`,
    "$r | ConvertTo-Json -Depth 40 -Compress",
  ].join("; ")), "rollback preview");
  assert.strictEqual(preview.mode, "preview");
  assert.strictEqual(preview.validated, true);
  assert.strictEqual(fs.existsSync(path.join(artifactRoot, "wechat-miniapp-release-latest.json")), false, "preview must not write pointer");

  const rollbackId = "rb-20200101T000000000Z-smoke01";
  const applied = parseJson(runPowerShell([
    ...base,
    `$r = Invoke-ReleaseRollback -Policy $policy -TargetVersion '${version}' -Apply -RollbackId '${rollbackId}' -LockWaitSeconds 5`,
    "$r | ConvertTo-Json -Depth 40 -Compress",
  ].join("; ")), "rollback apply");
  assert.strictEqual(applied.mode, "applied");
  assert.strictEqual(applied.status, "applied");
  assert.strictEqual(applied.cloudBaseChanged, false);
  assert.strictEqual(applied.cloudBaseAction, "not-run");
  assert.ok(fs.existsSync(applied.pointerPath));
  assert.ok(fs.existsSync(applied.backupPath));
  assert.ok(fs.existsSync(applied.rollbackRecordPath));
  assert.ok(fs.existsSync(applied.logPath));
  const pointer = JSON.parse(fs.readFileSync(applied.pointerPath, "utf8"));
  assert.strictEqual(pointer.version, version);
  assert.strictEqual(pointer.releaseCommit, releaseCommit);
  assert.strictEqual(pointer.packageSha256, packageSha256);
  assert.strictEqual(pointer.cloudBaseChanged, false);
  const rollbackRecord = JSON.parse(fs.readFileSync(applied.rollbackRecordPath, "utf8"));
  assert.strictEqual(rollbackRecord.status, "applied");
  assert.strictEqual(rollbackRecord.cloudBaseAction, "not-run");
  const backup = JSON.parse(fs.readFileSync(applied.backupPath, "utf8"));
  assert.strictEqual(backup.targetPackageSha256, packageSha256);
  assert.strictEqual(backup.cloudBaseChanged, false);

  // Tampering with an immutable package must make a later rollback fail.
  fs.appendFileSync(packagePath, Buffer.from("tamper"));
  const tampered = runPowerShell([
    ...base,
    `$r = Invoke-ReleaseRollback -Policy $policy -TargetVersion '${version}'`,
    "$r | ConvertTo-Json -Depth 40 -Compress",
  ].join("; "));
  assert.notStrictEqual(tampered.status, 0, "tampered package was accepted");

  const source = fs.readFileSync(rollbackScript, "utf8");
  assert.ok(!/Invoke-(?:CloudBase|WechatIde)|deploy-api-cloudbase-cli|DeployCloud/i.test(source), "rollback entry must not invoke CloudBase/deploy commands");
  console.log("rollback release smoke: OK");
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
