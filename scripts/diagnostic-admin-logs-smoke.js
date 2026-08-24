/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "diagnostic-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

function event(id, overrides = {}) {
  return Object.assign({
    eventId: id,
    sessionId: "diag-session",
    sequence: 1,
    time: new Date().toISOString(),
    level: "info",
    category: "generation",
    event: "smoke",
    message: "测试日志",
    route: "pages/index/index",
    step: "submit",
    requestId: `req-${id}`,
    durationMs: 321,
    details: {}
  }, overrides);
}

async function report(openid, events) {
  return api.main({
    action: "reportDiagnosticLogs",
    requestId: `report-${openid}`,
    payload: {
      appVersion: "0.31.0",
      session: { id: "diag-session" },
      events
    }
  }, { OPENID: openid });
}

async function main() {
  test.resetUserDiagnosticLogTestRows();
  const now = new Date();
  const userOne = "diagnostic-user-one";
  const userTwo = "diagnostic-user-two";
  const userOneHash = test.usageUserHash(userOne);
  const userTwoHash = test.usageUserHash(userTwo);

  const first = await report(userOne, [
    event("error-generation", {
      level: "error",
      category: "generation",
      message: "请求失败 https://private.example/path sk-super-secret-value",
      error: {
        message: "Bearer abcdef123456",
        openid: userOne,
        filePath: "C:\\private\\main.jpg"
      },
      details: {
        apiKey: "secret-key",
        prompt: "用户的完整提示词",
        fileID: "cloud://private-file"
      }
    }),
    event("warn-cloud", {
      level: "warn",
      category: "cloud",
      message: "云端响应较慢"
    })
  ]);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.accepted, 2);

  const second = await report(userTwo, [
    event("info-video", {
      level: "info",
      category: "video",
      message: "视频任务完成"
    })
  ]);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.accepted, 1);

  const rows = test.getUserDiagnosticLogTestRows();
  assert.strictEqual(rows.length, 3);
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(userOne));
  assert.ok(!serialized.includes("secret-key"));
  assert.ok(!serialized.includes("super-secret-value"));
  assert.ok(!serialized.includes("cloud://private-file"));
  assert.ok(!serialized.includes("C:\\\\private\\\\main.jpg"));
  assert.ok(!serialized.includes("用户的完整提示词"));
  assert.ok(serialized.includes(userOneHash));
  assert.ok(serialized.includes(userTwoHash));

  const forbidden = await api.main({
    action: "getAdminDiagnosticLogs",
    requestId: "diagnostic-forbidden"
  }, { OPENID: userOne });
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  const all = await api.main({
    action: "getAdminDiagnosticLogs",
    requestId: "diagnostic-admin-all",
    hours: 72,
    limit: 2
  }, { OPENID: "diagnostic-admin" });
  assert.strictEqual(all.ok, true);
  assert.strictEqual(all.summary.total, 3);
  assert.strictEqual(all.summary.errorCount, 1);
  assert.strictEqual(all.summary.warnCount, 1);
  assert.strictEqual(all.summary.infoCount, 1);
  assert.strictEqual(all.summary.userCount, 2);
  assert.strictEqual(all.logs.length, 2);
  assert.strictEqual(all.nextOffset, 2);

  const next = await api.main({
    action: "getAdminDiagnosticLogs",
    requestId: "diagnostic-admin-next",
    hours: 72,
    offset: 2,
    limit: 2
  }, { OPENID: "diagnostic-admin" });
  assert.strictEqual(next.logs.length, 1);
  assert.strictEqual(next.nextOffset, null);

  const errors = await api.main({
    action: "getAdminDiagnosticLogs",
    requestId: "diagnostic-admin-errors",
    hours: 72,
    level: "error",
    category: "generation",
    userHash: userOneHash
  }, { OPENID: "diagnostic-admin" });
  assert.strictEqual(errors.summary.total, 1);
  assert.strictEqual(errors.logs[0].level, "error");
  assert.strictEqual(errors.logs[0].category, "generation");
  assert.strictEqual(errors.logs[0].userHash, userOneHash);

  test.pushUserDiagnosticLogTestRow({
    _id: "expired-row",
    eventId: "expired-row",
    userHash: userOneHash,
    level: "error",
    category: "cloud",
    createdAt: new Date(now.getTime() - 73 * 60 * 60 * 1000),
    expiresAt: new Date(now.getTime() - 60 * 60 * 1000)
  });
  test.pushUserDiagnosticLogTestRow({
    _id: "kept-row",
    eventId: "kept-row",
    userHash: userOneHash,
    level: "info",
    category: "app",
    createdAt: new Date(now.getTime() - 71 * 60 * 60 * 1000),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000)
  });
  const cleanup = await test.cleanupDiagnosticLogs(now);
  assert.strictEqual(cleanup.retentionHours, 72);
  assert.strictEqual(cleanup.removed, 1);
  assert.ok(!test.getUserDiagnosticLogTestRows().some((item) => item._id === "expired-row"));
  assert.ok(test.getUserDiagnosticLogTestRows().some((item) => item._id === "kept-row"));
  const cleanupAgain = await test.cleanupDiagnosticLogs(now);
  assert.strictEqual(cleanupAgain.removed, 0);

  const tooOld = await report(userOne, [
    event("too-old", {
      time: new Date(now.getTime() - 73 * 60 * 60 * 1000).toISOString()
    })
  ]);
  assert.strictEqual(tooOld.accepted, 0);
  assert.strictEqual(tooOld.ignored, 1);

  console.log("diagnostic admin logs smoke: OK (权限/脱敏/分类/分页/72小时清理)");
}

main().catch((error) => {
  console.error(`diagnostic admin logs smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
