/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-openid-001";

const apiModule = require("../cloudfunctions/api/index.js");
const test = apiModule.__test;

assert.ok(test, "云函数没有暴露测试接口");
assert.strictEqual(typeof test.normalizeImageProviderAttemptEvent, "function");
assert.strictEqual(typeof test.aggregateImageProviderAttemptEvents, "function");
assert.strictEqual(typeof test.recordImageProviderAttemptEvent, "function");
assert.strictEqual(typeof test.getImageProviderFailoverStats, "function");
assert.ok(
  test.requiredDatabaseCollections.includes("image_provider_attempt_events"),
  "主备统计集合没有加入初始化清单"
);

test.resetImageProviderAttemptTestEvents();
test.resetModelUsageTestEvents();

const now = new Date("2026-08-26T04:00:00.000Z");
const sourceEvents = [
  {
    requestId: "stats-request-1",
    openid: "normal-user-1",
    role: "primary",
    attempt: 1,
    provider: "xingju",
    model: "jw-gpt-image-2",
    success: false,
    status: 503,
    code: "upstream-error",
    category: "temporary",
    retryable: true,
    durationMs: 70000,
    errorMessage: "上游暂时不可用",
    createdAt: "2026-08-26T01:00:00.000Z",
  },
  {
    requestId: "stats-request-1",
    openid: "normal-user-1",
    role: "primary",
    attempt: 2,
    provider: "xingju",
    model: "jw-gpt-image-2",
    success: false,
    status: 503,
    code: "upstream-error",
    category: "temporary",
    retryable: true,
    durationMs: 71000,
    errorMessage: "上游暂时不可用",
    createdAt: "2026-08-26T01:01:00.000Z",
  },
  {
    requestId: "stats-request-1",
    openid: "normal-user-1",
    role: "backup",
    attempt: 1,
    provider: "lingyun",
    model: "gpt-image-2",
    success: true,
    status: 200,
    durationMs: 62000,
    createdAt: "2026-08-26T01:02:00.000Z",
  },
  {
    requestId: "stats-request-2",
    openid: "normal-user-2",
    role: "primary",
    attempt: 1,
    provider: "xingju",
    model: "jw-gpt-image-2",
    success: true,
    status: 200,
    durationMs: 60000,
    createdAt: "2026-08-25T01:00:00.000Z",
  },
];

const directStats = test.aggregateImageProviderAttemptEvents(
  sourceEvents,
  30,
  now
);
assert.strictEqual(directStats.totalRequests, 2);
assert.strictEqual(directStats.totalAttempts, 4);
assert.strictEqual(directStats.primary.calls, 3);
assert.strictEqual(directStats.primary.success, 1);
assert.strictEqual(directStats.primary.failure, 2);
assert.strictEqual(directStats.primary.averageDurationMs, 67000);
assert.strictEqual(directStats.backup.calls, 1);
assert.strictEqual(directStats.backup.success, 1);
assert.strictEqual(directStats.backup.averageDurationMs, 62000);
assert.strictEqual(directStats.switchCount, 1);
assert.strictEqual(directStats.switchRate, 50);
assert.strictEqual(directStats.finalBackupSuccessCount, 1);
assert.strictEqual(directStats.recentFailures.length, 2);
assert.ok(directStats.recentFailures[0].message);

async function main() {
  await Promise.all(
    sourceEvents.map((item) => test.recordImageProviderAttemptEvent(item))
  );
  const result = await apiModule.main(
    {
      action: "getImageProviderFailoverStats",
      requestId: "stats-action-smoke",
      days: 30,
    },
    { OPENID: "admin-openid-001" }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.totalRequests, 2);
  assert.strictEqual(result.primary.calls, 3);
  assert.strictEqual(result.backup.calls, 1);
  assert.strictEqual(result.switchCount, 1);
  assert.strictEqual(result.finalBackupSuccessCount, 1);
  assert.strictEqual(
    test.getModelUsageTestEvents().length,
    0,
    "主备统计不能重复写入成本/用量统计"
  );
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("normal-user-1"));
  console.log("image provider failover stats smoke: OK");
}

main().catch((error) => {
  console.error(`image provider failover stats smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
