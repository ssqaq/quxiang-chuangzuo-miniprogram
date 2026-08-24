/* eslint-disable no-console */

const assert = require("assert");
const http = require("http");
const XLSX = require("../cloudfunctions/api/node_modules/xlsx");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "failure-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露失败统计测试接口");

const baseDate = new Date("2026-08-23T12:00:00.000Z");
const sourceEvents = [
  {
    requestId: "failure-1",
    usageType: "image",
    action: "generate",
    provider: "pandatk",
    model: "image-model-a",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: false,
    status: 503,
    errorCode: "upstream-timeout",
    errorMessage: "上游接口超时",
    errorStatus: 503,
    retryable: true,
    attempt: 2
  },
  {
    requestId: "failure-2",
    usageType: "image",
    action: "generate",
    provider: "pandatk",
    model: "image-model-a",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: false,
    status: 503,
    errorCode: "upstream-timeout",
    errorMessage: "上游接口超时",
    errorStatus: 503,
    retryable: true,
    attempt: 1
  },
  {
    requestId: "failure-3",
    usageType: "face",
    action: "detectFaceCircle",
    provider: "dashscope",
    model: "qwen3-vl-flash",
    userHash: "user-b",
    dateKey: "2026-08-22",
    success: false,
    status: 401,
    errorCode: "invalid-api-key",
    errorMessage: "鉴权失败",
    errorStatus: 401,
    retryable: false
  },
  {
    requestId: "failure-analysis-1",
    usageType: "analysis",
    action: "analyze",
    provider: "vision-provider",
    model: "analysis-model-a",
    userHash: "user-b",
    dateKey: "2026-08-21",
    success: false,
    status: 500,
    errorCode: "provider-error",
    errorMessage: "图片分析服务异常",
    errorStatus: 500,
    retryable: true
  },
  {
    requestId: "failure-4",
    usageType: "video",
    action: "video.create",
    provider: "lingyun",
    model: "video-model-a",
    userHash: "user-c",
    dateKey: "2026-08-22",
    success: false,
    status: 429,
    errorCode: "rate-limit",
    errorMessage: "请求过于频繁",
    errorStatus: 429,
    retryable: true
  },
  {
    requestId: "failure-5",
    usageType: "video",
    action: "video.create",
    provider: "lingyun",
    model: "video-model-a",
    userHash: "user-c",
    dateKey: "2026-08-21",
    success: false,
    status: 429,
    errorCode: "rate-limit",
    errorMessage: "请求过于频繁",
    errorStatus: 429,
    retryable: true
  },
  {
    requestId: "failure-6",
    usageType: "video",
    action: "video.create",
    provider: "lingyun",
    model: "video-model-a",
    userHash: "user-c",
    dateKey: "2026-08-20",
    success: false,
    status: 500,
    errorCode: "provider-error",
    errorMessage: "供应商处理失败",
    errorStatus: 500,
    retryable: false
  },
  {
    requestId: "failure-7",
    usageType: "image",
    action: "generate",
    provider: "pandatk",
    model: "image-model-b",
    userHash: "user-d",
    dateKey: "2026-08-19",
    success: false,
    status: 400,
    errorMessage: "参数不正确"
  },
  {
    requestId: "success-1",
    usageType: "image",
    action: "generate",
    provider: "pandatk",
    model: "image-model-a",
    userHash: "user-a",
    dateKey: "2026-08-18",
    success: true,
    status: 200
  }
];

const normalizedEvents = sourceEvents.map((item) => test.normalizeModelUsageEvent(item));
const stats = test.aggregateModelUsageEvents(normalizedEvents, 30, baseDate);

assert.strictEqual(stats.last30d.total, 9);
assert.strictEqual(stats.last30d.failure, 8);
assert.strictEqual(stats.failureStats.total, 8);
assert.strictEqual(stats.failureStats.failureRate, 88.89);
assert.strictEqual(stats.failureStats.topFailureReasons.length, 5);
assert.strictEqual(stats.failureStats.topFailureReasons[0].code, "upstream-timeout");
assert.strictEqual(stats.failureStats.topFailureReasons[0].count, 2);
assert.strictEqual(stats.failureStats.failureDetails.length, 8);
assert.strictEqual(stats.failureStats.failedModels[0].failure, 3);
assert.ok(
  stats.failureStats.topFailureReasons.some((item) => item.label.includes("参数不正确")),
  "没有错误码的失败原因没有保留错误说明"
);
assert.ok(
  !stats.failureStats.topFailureReasons.some((item) => item.label === "成功"),
  "成功事件被错误统计为失败"
);

const workbookBuffer = test.buildModelUsageExportWorkbook(stats);
const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
assert.ok(workbook.SheetNames.includes("失败明细"));
assert.ok(workbook.Sheets["失败明细"]);

async function testRetryFailureRecordedOnce() {
  const server = http.createServer((request, response) => {
    response.statusCode = 503;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      error: { code: "retryable-provider-error", message: "临时失败" }
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    test.resetModelUsageTestEvents();
    const result = await test.requestWithRetry(
      `http://127.0.0.1:${address.port}`,
      { method: "POST", headers: {} },
      Buffer.from("failure"),
      {
        requestId: "retry-failure",
        action: "generate",
        provider: "demo",
        model: "demo-model",
        allowRetry: true,
        maxAttempts: 2,
        retryStatuses: [503]
      }
    );
    assert.strictEqual(result.status, 503);
    assert.strictEqual(test.getModelUsageTestEvents().length, 1);
    assert.strictEqual(test.getModelUsageTestEvents()[0].attempt, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

testRetryFailureRecordedOnce()
  .then(() => {
    console.log("model failure stats smoke: OK");
    console.log(JSON.stringify({
      failureCount: stats.failureStats.total,
      failureRate: stats.failureStats.failureRate,
      topReasonCount: stats.failureStats.topFailureReasons.length,
      failureDetailCount: stats.failureStats.failureDetails.length,
      workbookSheets: workbook.SheetNames
    }));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
