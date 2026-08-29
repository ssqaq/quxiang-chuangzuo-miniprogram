/* eslint-disable no-console */

// 发布报告 smoke。所有状态都写到临时目录，不碰 canonical 队列、锁、产物或
// GitHub。覆盖：四端证据全通过、缺失/不一致关闸、报告/最新清单落盘、
// 敏感错误脱敏，以及 status 入口的公开参数契约。

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const reportScript = path.join(root, "scripts", "release-report.ps1");
const statusScript = path.join(root, "scripts", "release-status.ps1");

function encodedCommand(command) {
  return Buffer.from(command, "utf16le").toString("base64");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command, options = {}) {
  return childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand(command)],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options }
  );
}

function runPowerShellFile(args, options = {}) {
  return childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options }
  );
}

function assertPowerShellOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
}

function runGit(args, cwd) {
  const result = childProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(" ")} 失败\n${result.stdout || ""}\n${result.stderr || ""}`
  );
  return String(result.stdout || "").trim();
}

function parseJsonOutput(result, label) {
  assertPowerShellOk(result, label);
  const text = String(result.stdout || "").trim();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} JSON 解析失败：${error.message}\n${text}\n${result.stderr || ""}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createZip(zipSource, output) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$source = " + psQuote(zipSource),
    "$target = " + psQuote(output),
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[IO.Compression.ZipFile]::CreateFromDirectory($source, $target)",
  ].join("; ");
  assertPowerShellOk(runPowerShell(command), "创建临时 ZIP");
  assert.ok(fs.existsSync(output) && fs.statSync(output).size > 0, "临时 ZIP 没有生成");
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-release-report-smoke-"));
  const repo = path.join(base, "repo");
  const artifactRoot = path.join(base, "artifacts");
  const contextRoot = path.join(base, "contexts");
  const recordRoot = path.join(base, "records");
  const reservationRoot = path.join(base, "reservations");
  const queueRoot = path.join(base, "queue");
  const logRoot = path.join(base, "logs");
  const reportRoot = path.join(base, "reports");
  for (const directory of [repo, artifactRoot, contextRoot, recordRoot, reservationRoot, queueRoot, logRoot, reportRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  runGit(["init"], repo);
  runGit(["config", "user.email", "smoke@example.invalid"], repo);
  runGit(["config", "user.name", "release report smoke"], repo);
  fs.writeFileSync(path.join(repo, "config.js"), 'module.exports = { appVersion: "1.2.3" };\n', "utf8");
  fs.writeFileSync(path.join(repo, "README.md"), "report smoke\n", "utf8");
  runGit(["add", "config.js", "README.md"], repo);
  runGit(["commit", "-m", "report smoke"], repo);
  const commit = runGit(["rev-parse", "HEAD"], repo);
  const tree = runGit(["rev-parse", "HEAD^{tree}"], repo);
  runGit(["update-ref", "refs/remotes/origin/main", commit], repo);

  const operationId = "op-report-smoke-001";
  const version = "1.2.3";
  const sourceSha256 = "a".repeat(64);
  const zipName = `wechat-miniapp-release-v${version}-${commit}.zip`;
  const artifactPath = path.join(artifactRoot, zipName);
  const zipSource = path.join(base, "zip-source");
  fs.mkdirSync(zipSource, { recursive: true });
  fs.writeFileSync(
    path.join(zipSource, "RELEASE-MANIFEST.txt"),
    [
      "圈像创作微信小程序发布包",
      `操作 ID：${operationId}`,
      `版本：${version}`,
      `源提交 SHA：${commit}`,
      `提交 SHA：${commit}`,
      `Git tree SHA：${tree}`,
      `源码内容 SHA256：${sourceSha256}`,
      `产物文件名：${zipName}`,
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(zipSource, "payload.txt"), "ok\n", "utf8");
  createZip(zipSource, artifactPath);
  const packageSha256 = sha256File(artifactPath);

  const qrPath = path.join(artifactRoot, `wechat-miniapp-preview-v${version}-${commit}-qr.png`);
  const infoPath = path.join(artifactRoot, `wechat-miniapp-preview-v${version}-${commit}-info.json`);
  fs.writeFileSync(qrPath, Buffer.from("fake-png-for-report-smoke"));
  const qrSha256 = sha256File(qrPath);
  writeJson(infoPath, {
    schemaVersion: 1,
    operationId,
    appVersion: version,
    gitCommit: commit,
    treeSha: tree,
    sourceSha256,
    artifactPath,
    mainCommit: commit,
    qrSha256,
  });

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cloudReceipt = {
    schemaVersion: 1,
    operationId,
    version,
    releaseCommit: commit,
    treeSha: tree,
    sourceSha256,
    packageSha256,
    mainCommit: commit,
    onlineBuildVersion: version,
    onlineBuildMarker: "API_BUILD_TAG_AUTO_VERSION_V0123",
    status: "verified",
  };
  const contextPath = path.join(contextRoot, `release-${operationId}.json`);
  const recordPath = path.join(recordRoot, `release-v${version}-${commit}.json`);
  const reservationPath = path.join(reservationRoot, `reservation-${version}-${operationId}.json`);
  writeJson(contextPath, {
    schemaVersion: 2,
    operationId,
    canonicalRepo: repo,
    remote: "https://example.invalid/repo.git",
    branch: "main",
    version,
    sourceCommit: commit,
    releaseCommit: commit,
    treeSha: tree,
    sourceSha256,
    packageSha256,
    artifactPath,
    mainCommit: commit,
    phase: "verified",
    status: "succeeded",
    terminalStatus: "succeeded",
    expiresAt,
    previewQrPath: qrPath,
    previewInfoPath: infoPath,
    cloudReceipt,
    completedAt: "2026-08-29T00:00:00.000Z",
  });
  writeJson(recordPath, {
    schemaVersion: 2,
    operationId,
    status: "succeeded",
    terminalStatus: "succeeded",
    version,
    sourceCommit: commit,
    releaseCommit: commit,
    treeSha: tree,
    sourceSha256,
    packageSha256,
    packagePath: artifactPath,
    mainCommit: commit,
    cloudReceipt,
    completedAt: "2026-08-29T00:00:00.000Z",
  });
  writeJson(reservationPath, {
    schemaVersion: 1,
    operationId,
    status: "succeeded",
    targetVersion: version,
    releaseCommit: commit,
    treeSha: tree,
    contextPath,
  });
  writeJson(path.join(queueRoot, "queue.json"), {
    schemaVersion: 1,
    nextSequence: 2,
    tickets: [{
      sequence: 1,
      ticketId: "ticket-report-smoke-001",
      operationId,
      status: "succeeded",
      phase: "succeeded",
      version,
      contextPath,
      reservationPath,
      sourcePath: repo,
      updatedAt: "2026-08-29T00:00:00.000Z",
    }],
  });

  const policyPath = path.join(base, "policy.json");
  writeJson(policyPath, {
    schemaVersion: 1,
    canonicalRepo: repo,
    remote: "https://example.invalid/repo.git",
    branch: "main",
    lockPath: path.join(base, "release.lock"),
    artifactRoot,
    reservationRoot,
    worktreeRoot: path.join(base, "worktrees"),
    recordRoot,
    contextRoot,
    logRoot,
    queueRoot,
    reportRoot,
    latestReleasePath: path.join(reportRoot, "latest-release.json"),
    archiveManifestPath: path.join(base, "archive.json"),
  });
  return { base, repo, policyPath, operationId, version, artifactPath, contextPath, infoPath, qrPath, queueRoot, reportRoot, packageSha256 };
}

function invokeReport(fixture, extra = []) {
  const args = [
    "-File", reportScript,
    "-PolicyPath", fixture.policyPath,
    "-OperationId", fixture.operationId,
    "-Json",
    ...extra,
  ];
  return runPowerShellFile(args);
}

function testReportHappyPath(fixture) {
  const report = parseJsonOutput(invokeReport(fixture), "完整验收报告");
  assert.strictEqual(report.status, "succeeded", JSON.stringify(report.issues));
  assert.strictEqual(report.verdict, "succeeded");
  assert.strictEqual(report.summary.fail, 0);
  assert.strictEqual(report.summary.pending, 0);
  for (const key of ["main", "artifact", "qr", "cloudbase"]) {
    assert.strictEqual(report.evidence[key].status, "pass", `${key} 没有 pass`);
  }
  assert.ok(fs.existsSync(path.join(fixture.reportRoot, `release-${fixture.operationId}.json`)));
  assert.ok(fs.existsSync(path.join(fixture.reportRoot, `release-${fixture.operationId}.md`)));
  const latestPath = path.join(fixture.reportRoot, "latest-release.json");
  assert.ok(fs.existsSync(latestPath), "成功报告没有更新 latest-release.json");
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  assert.strictEqual(latest.operationId, fixture.operationId);
  assert.strictEqual(latest.version, fixture.version);
  assert.strictEqual(latest.packageSha256, fixture.packageSha256);
  return report;
}

function testReportIdempotent(fixture, firstReport) {
  const second = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "重复只读报告");
  assert.strictEqual(second.status, firstReport.status);
  assert.strictEqual(second.operationId, firstReport.operationId);
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture.reportRoot, `release-${fixture.operationId}.json`), "utf8"));
  assert.strictEqual(persisted.paths.report.endsWith(`release-${fixture.operationId}.json`), true);
}

function testReservationGuards(fixture) {
  const reservationPath = path.join(
    fixture.base,
    "reservations",
    `reservation-${fixture.version}-${fixture.operationId}.json`
  );
  const original = fs.readFileSync(reservationPath, "utf8");
  fs.rmSync(reservationPath);
  let report = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "reservation 缺失报告");
  assert.strictEqual(report.status, "failed");
  assert.strictEqual(report.evidence.reservation.status, "fail");
  assert.ok(report.issues.some((item) => String(item).includes("找不到 reservation")));

  const mismatched = JSON.parse(original);
  mismatched.operationId = "op-other";
  fs.writeFileSync(reservationPath, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
  report = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "reservation operationId 不一致报告");
  assert.strictEqual(report.status, "failed");
  assert.ok(report.issues.some((item) => String(item).includes("reservation operationId 不一致")));

  mismatched.operationId = fixture.operationId;
  mismatched.targetVersion = "9.9.9";
  fs.writeFileSync(reservationPath, `${JSON.stringify(mismatched, null, 2)}\n`, "utf8");
  report = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "reservation version 不一致报告");
  assert.strictEqual(report.status, "failed");
  assert.ok(report.issues.some((item) => String(item).includes("reservation version 不一致")));

  fs.writeFileSync(reservationPath, original, "utf8");
}

function testStateConsistencyGuard(fixture) {
  const context = JSON.parse(fs.readFileSync(fixture.contextPath, "utf8"));
  const originalStatus = context.status;
  const originalPhase = context.phase;
  context.status = "prepared";
  context.phase = "prepared";
  fs.writeFileSync(fixture.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  const report = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "队列/context 状态冲突报告");
  assert.strictEqual(report.status, "failed");
  assert.ok(report.issues.some((item) => String(item).includes("队列已 succeeded")));
  context.status = originalStatus;
  context.phase = originalPhase;
  fs.writeFileSync(fixture.contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
}

function testLatestVersionGuard(fixture) {
  const command = [
    ". " + psQuote(reportScript),
    "$policy = Get-ReleaseReportPolicy -PolicyPath " + psQuote(fixture.policyPath),
    "$r = [pscustomobject][ordered]@{ status='succeeded'; operationId='op-old'; version='1.2.2'; releaseCommit='oldcommit'; treeSha='oldtree'; sourceSha256='" + "b".repeat(64) + "'; packageSha256='oldpackage'; artifactPath='old.zip' }",
    "$result = Write-ReleaseReportLatestAtomic -Policy $policy -Report $r -ReportPath 'old.json' -MarkdownPath 'old.md'",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const result = parseJsonOutput(runPowerShell(command), "latest 版本倒退保护");
  assert.strictEqual(result.updated, false);
  assert.ok(String(result.reason).includes("低于"));
  const latest = JSON.parse(fs.readFileSync(path.join(fixture.reportRoot, "latest-release.json"), "utf8"));
  assert.strictEqual(latest.operationId, fixture.operationId);

  const conflictCommand = [
    ". " + psQuote(reportScript),
    "$policy = Get-ReleaseReportPolicy -PolicyPath " + psQuote(fixture.policyPath),
    "$r = [pscustomobject][ordered]@{ status='succeeded'; operationId='op-other'; version='1.2.3'; releaseCommit='different'; treeSha='different'; sourceSha256='" + "c".repeat(64) + "'; packageSha256='different'; artifactPath='other.zip' }",
    "Write-ReleaseReportLatestAtomic -Policy $policy -Report $r -ReportPath 'other.json' -MarkdownPath 'other.md'",
  ].join("; ");
  const conflict = runPowerShell(conflictCommand);
  assert.notStrictEqual(conflict.status, 0, "同版本不同身份错误覆盖 latest");
}

function testFailClosed(fixture) {
  const info = JSON.parse(fs.readFileSync(fixture.infoPath, "utf8"));
  info.appVersion = "9.9.9";
  fs.writeFileSync(fixture.infoPath, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  const report = parseJsonOutput(invokeReport(fixture, ["-NoWrite"]), "二维码不一致报告");
  assert.strictEqual(report.status, "failed");
  assert.strictEqual(report.evidence.qr.status, "fail");
  assert.ok(report.issues.some((item) => String(item).includes("二维码 info appVersion")));
}

function testRedaction(fixture) {
  const queuePath = path.join(fixture.queueRoot, "queue.json");
  const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));
  queue.tickets[0].lastError = "token=smoke-secret-value";
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  const result = invokeReport(fixture, ["-NoWrite"]);
  assertPowerShellOk(result, "脱敏报告");
  assert.strictEqual(String(result.stdout).includes("smoke-secret-value"), false, "报告泄漏 token 原文");
  assert.strictEqual(String(result.stdout).includes("[已隐藏]"), true, "报告没有保留脱敏提示");
}

function testStatusContract() {
  const text = fs.readFileSync(statusScript, "utf8");
  for (const marker of [
    "[switch]$Json",
    "[switch]$Report",
    "[string]$OperationId",
    "Get-ReleaseQueueTickets",
    "Get-ReleaseReportData",
    "Format-StatusHuman",
    "GitHub main",
    "CloudBase",
  ]) {
    assert.ok(text.includes(marker), `release-status.ps1 缺少契约：${marker}`);
  }
}

function main() {
  assert.ok(fs.existsSync(reportScript), `文件不存在：${reportScript}`);
  const fixture = makeFixture();
  try {
    const report = testReportHappyPath(fixture);
    testReportIdempotent(fixture, report);
    testReservationGuards(fixture);
    testStateConsistencyGuard(fixture);
    testLatestVersionGuard(fixture);
    testFailClosed(fixture);
    testRedaction(fixture);
    testStatusContract();
    console.log("release report smoke: OK");
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
}

main();
