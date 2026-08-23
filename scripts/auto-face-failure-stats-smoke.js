/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "auto-face-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露自动贴脸失败统计测试接口");

function shanghaiDate(dayOffset, hour = 12) {
  return new Date(Date.UTC(2026, 7, 23 + dayOffset, hour - 8, 0, 0));
}

const dangerousReport = test.normalizeAutoFaceFailureReport({
  requestId: "face-report-1",
  failureType: "upstream",
  errorCode: "provider-error",
  message: "apiKey=sk-test-secret prompt=不要暴露内容 filePath=C:\\secret\\face.png",
  status: 503,
  retryable: true,
  stage: "cloud-failed",
  durationMs: 1234,
  appVersion: "0.20.2",
  imagePath: "C:\\secret\\face.png",
  fileID: "cloud://private/main.jpg",
  prompt: "完整提示词",
  stack: "Error: secret stack"
});

assert.strictEqual(dangerousReport.failureType, "upstream");
assert.strictEqual(dangerousReport.status, 503);
assert.strictEqual(dangerousReport.durationMs, 1234);
assert.ok(dangerousReport.message.includes("[已隐藏]"));
assert.ok(!Object.prototype.hasOwnProperty.call(dangerousReport, "imagePath"));
assert.ok(!Object.prototype.hasOwnProperty.call(dangerousReport, "fileID"));
assert.ok(!Object.prototype.hasOwnProperty.call(dangerousReport, "prompt"));
assert.ok(!Object.prototype.hasOwnProperty.call(dangerousReport, "stack"));
assert.ok(!dangerousReport.message.includes("sk-test-secret"));
assert.ok(!dangerousReport.message.includes("C:\\secret\\face.png"));

function event(dayOffset, failureType, index = 0) {
  return Object.assign(
    {},
    test.normalizeAutoFaceFailureReport({
      requestId: `stats-${dayOffset}-${index}`,
      failureType,
      errorCode: `${failureType}-error`,
      message: `${failureType} failure`,
      status: failureType === "timeout" ? 504 : 503,
      retryable: failureType !== "empty-face-detection",
      stage: "cloud-failed",
      durationMs: 500 + index,
      appVersion: "0.20.2"
    }),
    { createdAt: shanghaiDate(dayOffset, 10 + (index % 4)) }
  );
}

const sourceEvents = [
  event(0, "timeout", 1),
  event(0, "upstream", 2),
  event(-1, "upstream", 3),
  event(-8, "empty-face-detection", 4),
  event(-8, "unknown", 5),
  event(-30, "network", 6),
  ...Array.from({ length: 25 }, (_, index) => event(-2, "network", index + 10))
];

const stats = test.buildAutoFaceFailureStats(
  sourceEvents,
  shanghaiDate(0, 12)
);

assert.strictEqual(stats.today, 2, "今天统计不正确");
assert.strictEqual(stats.last7d, 28, "近 7 天统计不正确");
assert.strictEqual(stats.total30d, 30, "近 30 天统计不正确");
assert.strictEqual(stats.recent.length, 20, "最近记录应最多返回 20 条");
assert.strictEqual(
  stats.byType.find((item) => item.type === "network").count,
  25,
  "失败类型计数不正确"
);
assert.strictEqual(stats.byType[0].type, "network", "失败类型应按次数倒序");
assert.ok(stats.recent[0].createdAt, "最近记录缺少时间");
assert.ok(stats.recent.every((item) => !Object.prototype.hasOwnProperty.call(item, "stack")));

async function main() {
  test.resetAutoFaceFailureTestEvents();

  const reportResult = await api.main({
    action: "reportAutoFaceFailure",
    requestId: "api-request-1",
    payload: dangerousReport
  }, { OPENID: "normal-user" });
  assert.strictEqual(reportResult.ok, true);
  assert.strictEqual(reportResult.accepted, true);
  const stored = test.getAutoFaceFailureTestEvents();
  assert.strictEqual(stored.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(stored[0], "prompt"));
  assert.ok(!Object.prototype.hasOwnProperty.call(stored[0], "fileID"));

  const forbidden = await api.main({
    action: "getAutoFaceFailureStats"
  }, { OPENID: "not-admin" });
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  const adminStats = await api.main({
    action: "getAutoFaceFailureStats"
  }, { OPENID: "auto-face-admin" });
  assert.strictEqual(adminStats.ok, true);
  assert.ok(Array.isArray(adminStats.byType));
  assert.ok(Array.isArray(adminStats.recent));

  console.log("auto face failure stats smoke: OK");
  console.log(JSON.stringify({
    today: stats.today,
    last7d: stats.last7d,
    total30d: stats.total30d,
    recentCount: stats.recent.length,
    apiReportAccepted: reportResult.accepted,
    adminStatsAvailable: !adminStats.unavailable
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
