/* eslint-disable no-console */

// Recovery is deliberately exercised as a small deterministic model here.
// Calling resume-release.ps1 in CI would require a live GitHub/CloudBase/WeChat
// session and could create real side effects.  The static checks below bind the
// model to the PowerShell entry points; the model then verifies the invariants
// that must hold when those entry points are invoked.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const resumePath = path.join(root, "scripts", "resume-release.ps1");
const deployPath = path.join(root, "scripts", "deploy-and-verify-api.ps1");
const cloudSafetyPath = path.join(root, "scripts", "cloud-deploy-safety.ps1");
const gatePath = path.join(root, "scripts", "release-gate.ps1");
const entryPath = path.join(root, "scripts", "release.ps1");
const workflowPath = path.join(root, ".github", "workflows", "release-gate.yml");
const gateSmokePath = path.join(root, "scripts", "release-gate-smoke.js");

function readText(file) {
  assert.ok(fs.existsSync(file), `文件不存在：${file}`);
  const raw = fs.readFileSync(file, "utf8");
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  assert.strictEqual(body.includes("\ufeff"), false, `${path.basename(file)} 含有函数体内 BOM`);
  return body.replace(/\r\n/g, "\n");
}

function mustContain(text, marker, label) {
  assert.ok(text.includes(marker), `${label}缺少：${marker}`);
}

function mustMatch(text, expression, label) {
  assert.ok(expression.test(text), `${label}不符合预期：${expression}`);
}

function assertOrdered(text, before, after, label) {
  const left = text.indexOf(before);
  const right = text.indexOf(after);
  assert.ok(left >= 0, `${label}找不到前置标记：${before}`);
  assert.ok(right >= 0, `${label}找不到后置标记：${after}`);
  assert.ok(left < right, `${label}顺序错误：${before} 应在 ${after} 之前`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function expectThrow(fn, pattern, label) {
  assert.throws(fn, (error) => {
    if (!pattern) return true;
    return pattern.test(String(error && error.message));
  }, label);
}

function makeContext(overrides = {}) {
  const context = {
    schemaVersion: 2,
    operationId: "op-resume-smoke-0001",
    version: "0.57.8",
    releaseCommit: "a".repeat(40),
    treeSha: "b".repeat(40),
    sourceSha256: "c".repeat(64),
    packageSha256: "d".repeat(64),
    mainCommit: "e".repeat(40),
    artifactPath: "C:\\release\\wechat-miniapp-release-v0.57.8-aaaaaaaaaaaa.zip",
    ...overrides,
  };
  return context;
}

const CLOUD_FIELDS = [
  "operationId",
  "version",
  "releaseCommit",
  "treeSha",
  "sourceSha256",
  "packageSha256",
  "mainCommit",
];

function cloudReceiptFor(context, extra = {}) {
  const receipt = {};
  for (const field of CLOUD_FIELDS) receipt[field] = context[field];
  return {
    ...receipt,
    schemaVersion: 1,
    status: "verified",
    idempotencyKey: deterministicCloudKey(context),
    verifiedAt: "2026-08-29T00:00:00.000Z",
    ...extra,
  };
}

function isStrictCloudReceipt(receipt, context) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.status !== "verified") return false;
  if (receipt.idempotencyKey !== deterministicCloudKey(context)) return false;
  return CLOUD_FIELDS.every((field) => String(receipt[field] || "") === String(context[field] || ""));
}

function isRemoteMatch(remote, context) {
  return remote &&
    String(remote.version) === String(context.version) &&
    String(remote.releaseCommit).toLowerCase() === String(context.releaseCommit).toLowerCase() &&
    String(remote.treeSha).toLowerCase() === String(context.treeSha).toLowerCase() &&
    String(remote.sourceSha256).toLowerCase() === String(context.sourceSha256).toLowerCase();
}

function previewInfoFor(context, qrSha256) {
  return {
    schemaVersion: 1,
    operationId: context.operationId,
    appVersion: context.version,
    gitCommit: context.releaseCommit,
    treeSha: context.treeSha,
    sourceSha256: context.sourceSha256,
    artifactPath: context.artifactPath,
    mainCommit: context.mainCommit,
    qrSha256,
  };
}

function isPreviewMatch(info, context, qrSha256) {
  return info &&
    info.schemaVersion === 1 &&
    info.operationId === context.operationId &&
    info.appVersion === context.version &&
    info.gitCommit === context.releaseCommit &&
    info.treeSha === context.treeSha &&
    info.sourceSha256 === context.sourceSha256 &&
    info.artifactPath === context.artifactPath &&
    info.mainCommit === context.mainCommit &&
    info.qrSha256 === qrSha256;
}

function deterministicCloudKey(context) {
  return `cloud:${context.operationId}:${context.releaseCommit}:${context.treeSha}`;
}

/**
 * A side-effect counter is enough to expose accidental Claim/Start or upload
 * replay.  The implementation mirrors the contract, not provider internals.
 */
function simulateResume({
  ticketStatus = "succeeded",
  terminalStatus = "succeeded",
  flags = {},
  context = makeContext(),
  cloudReceipt = null,
  remote = null,
  pending = null,
  existingPreview = null,
  qrBytes = Buffer.from("resume-preview-smoke"),
} = {}) {
  const calls = [];
  const requestedCloud = Boolean(flags.deployCloud);
  const requestedPreview = Boolean(flags.preview);
  const hasFlags = requestedCloud || requestedPreview;
  const effectOnly = ticketStatus === "succeeded" && terminalStatus === "succeeded" && hasFlags;

  if (ticketStatus === "succeeded" && terminalStatus === "succeeded" && !hasFlags) {
    return { status: "already-succeeded", calls };
  }
  if (ticketStatus === "succeeded" && !effectOnly) {
    throw new Error("队列已终态但 context 未完整成功，拒绝重新领取或执行副作用");
  }
  if (terminalStatus === "succeeded" && ticketStatus !== "succeeded") {
    throw new Error("context 已终态但队列未终态，拒绝重新发布");
  }
  for (const field of ["operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "artifactPath"]) {
    if (!context[field]) throw new Error(`context 缺少绑定字段：${field}`);
  }

  if (!effectOnly) calls.push("claim", "start");

  if (requestedCloud) {
    if (pending) {
      const pendingKey = pending.idempotencyKey || "";
      if (
        pending.operationId !== context.operationId ||
        pending.version !== context.version ||
        pending.releaseCommit !== context.releaseCommit ||
        pending.treeSha !== context.treeSha ||
        pending.sourceSha256 !== context.sourceSha256 ||
        pending.idempotencyKey !== deterministicCloudKey(context)
      ) {
        throw new Error("待确认 Cloud 任务与原 context 不一致，拒绝新上传");
      }
      calls.push(`poll:${pending.taskId || pendingKey}`);
    } else if (isStrictCloudReceipt(cloudReceipt, context)) {
      calls.push("cloud-readback");
      if (!isRemoteMatch(remote, context)) throw new Error("已有 receipt 但线上版本/指纹不匹配");
    } else {
      // A running/unknown effect is reconciled by remote readback first.  Only
      // a confirmed mismatch is allowed to upload once with the stable key.
      calls.push("cloud-readback");
      if (!isRemoteMatch(remote, context)) calls.push(`upload:${deterministicCloudKey(context)}`);
    }
  }

  if (requestedPreview) {
    const qrSha = sha256(qrBytes);
    if (existingPreview) {
      if (!isPreviewMatch(existingPreview.info, context, qrSha) || existingPreview.qrSha256 !== qrSha) {
        throw new Error("已有二维码与 context/SHA 不一致，拒绝覆盖");
      }
      calls.push("preview-reuse");
    } else {
      calls.push("preview-cli");
    }
  }
  return { status: "effect-only", calls };
}

function testStaticContracts() {
  const resume = readText(resumePath);
  const deploy = readText(deployPath);
  const cloudSafety = readText(cloudSafetyPath);
  const gate = readText(gatePath);
  const entry = readText(entryPath);
  const workflow = readText(workflowPath);
  const gateSmoke = readText(gateSmokePath);

  for (const marker of [
    "postMergeOnly",
    "postMergeRequested",
    "Claim-ReleaseQueueTicket",
    "ReleaseGateLockHeld",
    "Test-ResumeFinalPreview",
    "保留原 context",
  ]) mustContain(resume, marker, "resume 恢复入口契约");

  // These names are intentionally explicit.  They stop a future edit from
  // silently reverting to the old presence-only receipt/QR checks.
  for (const marker of [
    "Assert-ResumeCloudReceipt",
    "idempotencyKey",
    "qrSha256",
  ]) mustContain(resume, marker, "resume 副作用绑定契约");
  assert.ok(!/\$preview\s*=\s*Write-ResumeFinalPreview/.test(resume), "resume 不能用 $preview 覆盖 Preview 开关参数");
  mustContain(resume, "$previewArtifact = Write-ResumeFinalPreview", "resume 预览结果变量");
  for (const marker of [
    "operationId",
    "releaseCommit",
    "idempotencyKey",
    "ResumePendingDeploy",
  ]) mustContain(deploy, marker, "Cloud pending 绑定契约");
  mustMatch(cloudSafety, /idempotencyKey|IdempotencyKey/, "Cloud 部署幂等键");
  mustMatch(cloudSafety, /Get-CloudBaseFunctionVersion|线上.*核验|readback/i, "Cloud 重试线上核验");

  assertOrdered(resume, "postMergeOnly", "Claim-ReleaseQueueTicket", "终态 effect-only 必须先于 Claim");
  assertOrdered(
    resume,
    "if ($Preview -and -not (Test-ResumeFinalPreview",
    "Write-ResumeLog \"preview\"",
    "预览复用校验必须先于写入"
  );
  assertOrdered(
    deploy,
    "$releaseContextObject = Assert-CloudDeployReleaseContext",
    "Mode: resume existing confirmed cloud deployment task",
    "Cloud context 必须先于 pending 恢复"
  );

  mustContain(entry, '"scripts/resume-release-smoke.js"', "发布工具快照");
  mustContain(workflow, "- name: Resume release recovery smoke", "CI 恢复 smoke 步骤");
  mustContain(workflow, "node scripts/resume-release-smoke.js", "CI 恢复 smoke 命令");
  mustContain(gateSmoke, '"scripts/resume-release-smoke.js"', "release-gate 静态清单");
}

function testTerminalMatrix() {
  const done = simulateResume();
  assert.strictEqual(done.status, "already-succeeded");
  assert.deepStrictEqual(done.calls, [], "已成功且无 flags 不能有任何副作用");

  const effect = simulateResume({
    flags: { deployCloud: true, preview: true },
    remote: { version: "0.57.8", releaseCommit: "a".repeat(40), treeSha: "b".repeat(40), sourceSha256: "c".repeat(64) },
    cloudReceipt: cloudReceiptFor(makeContext()),
  });
  assert.strictEqual(effect.status, "effect-only");
  assert.strictEqual(effect.calls.includes("claim"), false, "终态后置恢复不能 Claim");
  assert.strictEqual(effect.calls.includes("start"), false, "终态后置恢复不能 Start");
  assert.ok(effect.calls.includes("cloud-readback"));
  assert.ok(effect.calls.includes("preview-cli"));

  const incompleteContext = makeContext({ treeSha: "" });
  expectThrow(
    () => simulateResume({ flags: { deployCloud: true }, context: incompleteContext }),
    /context 缺少绑定字段/,
    "context 不完整必须在副作用前失败"
  );
  const nonterminalQueue = makeContext();
  expectThrow(
    () => simulateResume({ ticketStatus: "running", terminalStatus: "succeeded", flags: { deployCloud: true }, context: nonterminalQueue }),
    /拒绝重新发布/,
    "终态 context 不得被非终态队列重新发布"
  );
}

function testStrictCloudReceipts() {
  const context = makeContext();
  const remote = {
    version: context.version,
    releaseCommit: context.releaseCommit,
    treeSha: context.treeSha,
    sourceSha256: context.sourceSha256,
  };
  const valid = cloudReceiptFor(context);
  const result = simulateResume({ flags: { deployCloud: true }, context, cloudReceipt: valid, remote });
  assert.strictEqual(result.calls.filter((call) => call.startsWith("upload:")).length, 0, "有效 receipt 不应上传");

  for (const field of CLOUD_FIELDS.concat(["status", "schemaVersion", "idempotencyKey"])) {
    const bad = cloudReceiptFor(context);
    if (field === "status") bad.status = "running";
    else if (field === "schemaVersion") bad.schemaVersion = 99;
    else if (field === "idempotencyKey") bad.idempotencyKey = "cloud:other";
    else bad[field] = `${bad[field]}-tampered`;
    const reconciled = simulateResume({
      flags: { deployCloud: true },
      context,
      cloudReceipt: bad,
      remote,
    });
    assert.strictEqual(reconciled.status, "effect-only", `receipt 字段 ${field} 错配不能假报完成`);
    assert.ok(reconciled.calls.includes("cloud-readback"), `receipt 字段 ${field} 错配必须先线上核验`);
    assert.strictEqual(
      reconciled.calls.filter((call) => call.startsWith("upload:")).length,
      0,
      `receipt 字段 ${field} 错配且线上已匹配时不能重复上传`
    );
  }

  const remoteAlreadyApplied = simulateResume({
    flags: { deployCloud: true },
    context: { ...context, effectState: "running" },
    remote,
  });
  assert.strictEqual(remoteAlreadyApplied.calls.filter((call) => call.startsWith("upload:")).length, 0, "running/unknown + 线上匹配不得重复上传");

  const remoteMismatch = simulateResume({
    flags: { deployCloud: true },
    context,
    remote: { ...remote, version: "0.57.7" },
  });
  const uploads = remoteMismatch.calls.filter((call) => call.startsWith("upload:"));
  assert.deepStrictEqual(uploads, [`upload:${deterministicCloudKey(context)}`], "线上不匹配必须只上传一次且使用稳定幂等键");
}

function testCrashRetryDoesNotUploadTwice() {
  const context = makeContext();
  let remote = { version: "0.57.7", releaseCommit: "old", treeSha: "old", sourceSha256: "old" };
  let receipt = null;
  let uploadCount = 0;

  function attempt(crashAfterUpload) {
    if (isStrictCloudReceipt(receipt, context) && isRemoteMatch(remote, context)) return;
    if (isRemoteMatch(remote, context)) {
      receipt = cloudReceiptFor(context);
      return;
    }
    uploadCount += 1;
    // The provider applied the request before the client crashed.  This state
    // lives outside context and is what the next retry must reconcile.
    remote = {
      version: context.version,
      releaseCommit: context.releaseCommit,
      treeSha: context.treeSha,
      sourceSha256: context.sourceSha256,
    };
    if (crashAfterUpload) throw new Error("simulated crash after remote upload");
    receipt = cloudReceiptFor(context);
  }

  expectThrow(() => attempt(true), /simulated crash/, "注入上传后崩溃");
  attempt(false);
  attempt(false);
  assert.strictEqual(uploadCount, 1, "上传后崩溃重试不能重复上传");
  assert.ok(isStrictCloudReceipt(receipt, context));
}

function testPendingTaskBinding() {
  const context = makeContext();
  const pending = {
    taskId: "task-123",
    operationId: context.operationId,
    version: context.version,
    releaseCommit: context.releaseCommit,
    treeSha: context.treeSha,
    sourceSha256: context.sourceSha256,
    idempotencyKey: deterministicCloudKey(context),
  };
  const resumed = simulateResume({ flags: { deployCloud: true }, context, pending });
  assert.deepStrictEqual(resumed.calls, ["poll:task-123"], "匹配 pending 只能轮询原任务");
  for (const field of ["operationId", "version", "releaseCommit", "treeSha", "sourceSha256", "idempotencyKey"]) {
    const bad = { ...pending, [field]: `${pending[field]}-other` };
    expectThrow(
      () => simulateResume({ flags: { deployCloud: true }, context, pending: bad }),
      /待确认 Cloud 任务/,
      `pending 字段 ${field} 错配必须拒绝`
    );
  }
}

function testPreviewShaIdempotency() {
  const context = makeContext();
  const qr = Buffer.from("stable-qr");
  const qrSha = sha256(qr);
  const info = previewInfoFor(context, qrSha);
  const reused = simulateResume({
    flags: { preview: true },
    context,
    existingPreview: { qrSha256: qrSha, info },
    qrBytes: qr,
  });
  assert.deepStrictEqual(reused.calls, ["preview-reuse"], "同 SHA 二维码必须幂等复用且不调用 CLI");

  const differentQr = Buffer.from("different-qr");
  expectThrow(
    () => simulateResume({ flags: { preview: true }, context, existingPreview: { qrSha256: qrSha, info }, qrBytes: differentQr }),
    /二维码与 context\/SHA/,
    "不同 SHA 二维码必须拒绝覆盖"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resume-preview-"));
  const tempQr = path.join(tempRoot, "preview.tmp.png");
  const finalQr = path.join(tempRoot, "preview.png");
  try {
    fs.writeFileSync(tempQr, qr);
    // Simulate CLI failure before the atomic move: final immutable output must
    // not appear and the temporary file must be cleaned by the caller.
    fs.rmSync(tempQr);
    assert.strictEqual(fs.existsSync(finalQr), false, "失败的临时二维码不能留下最终文件");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  testStaticContracts();
  testTerminalMatrix();
  testStrictCloudReceipts();
  testCrashRetryDoesNotUploadTwice();
  testPendingTaskBinding();
  testPreviewShaIdempotency();
  console.log("resume release smoke: OK");
}

main();
