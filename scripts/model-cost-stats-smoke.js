/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "cost-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露成本统计测试接口");

const costs = test.resolveCostConfig({});
assert.strictEqual(costs.currency, "CNY");
assert.strictEqual(costs.face.inputPerMillionTokens, 0.15);
assert.strictEqual(costs.face.outputPerMillionTokens, 1.5);
assert.strictEqual(costs.image.perImage["1K"], 0.015);
assert.strictEqual(costs.video.perSecond["720p"], 0.3);

const faceBilling = test.buildUsageBilling(
  { action: "detectFaceCircle" },
  {
    json: {
      usage: {
        prompt_tokens: 1000000,
        completion_tokens: 2000000,
        total_tokens: 3000000
      }
    }
  },
  costs
);
assert.strictEqual(faceBilling.billingSource, "actual");
assert.strictEqual(faceBilling.inputTokens, 1000000);
assert.strictEqual(faceBilling.outputTokens, 2000000);
assert.strictEqual(faceBilling.estimatedCost, 3.15);

const imageBilling = test.buildUsageBilling(
  { action: "generate", imageResolution: "2048x2048" },
  { json: {} },
  costs
);
assert.strictEqual(imageBilling.billingSource, "estimated");
assert.strictEqual(imageBilling.imageResolution, "2K");
assert.strictEqual(imageBilling.estimatedCost, 0.025);

const analysisBilling = test.buildUsageBilling(
  { action: "analyze" },
  {
    json: {
      usage: {
        prompt_tokens: 1000000,
        completion_tokens: 1000000,
        total_tokens: 2000000
      }
    }
  },
  costs
);
assert.strictEqual(analysisBilling.billingSource, "actual");
assert.strictEqual(analysisBilling.estimatedCost, 1.65);

const videoBilling = test.buildUsageBilling(
  {
    action: "video.create",
    videoResolution: "720p",
    videoDurationSeconds: 3
  },
  { json: {} },
  costs
);
assert.strictEqual(videoBilling.billingSource, "estimated");
assert.strictEqual(videoBilling.videoDurationSeconds, 3);
assert.strictEqual(videoBilling.estimatedCost, 0.9);

const baseDate = new Date("2026-08-23T12:00:00.000Z");
const events = [
  {
    requestId: "analysis-1",
    usageType: "analysis",
    action: "analyze",
    provider: "vision-provider",
    model: "analysis-model",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "actual",
    inputTokens: 1000000,
    outputTokens: 1000000,
    totalTokens: 2000000,
    estimatedCost: 1.65,
    costBreakdown: { inputCost: 0.15, outputCost: 1.5 }
  },
  {
    requestId: "face-1",
    usageType: "face",
    action: "detectFaceCircle",
    provider: "dashscope",
    model: "qwen3-vl-flash",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "actual",
    inputTokens: 1000000,
    outputTokens: 2000000,
    totalTokens: 3000000,
    estimatedCost: 3.15,
    costBreakdown: { inputCost: 0.15, outputCost: 3 }
  },
  {
    requestId: "image-1",
    usageType: "image",
    action: "generate",
    provider: "pandatk",
    model: "image2超分高质量1-4k",
    userHash: "user-a",
    dateKey: "2026-08-23",
    success: true,
    billingSource: "estimated",
    imageResolution: "2K",
    estimatedCost: 0.025
  },
  {
    requestId: "video-1",
    usageType: "video",
    action: "video.create",
    provider: "lingyun",
    model: "grok-imagine-video-1.5",
    userHash: "user-b",
    dateKey: "2026-08-22",
    success: true,
    billingSource: "estimated",
    videoResolution: "720p",
    videoDurationSeconds: 3,
    estimatedCost: 0.9
  },
  {
    requestId: "old-1",
    usageType: "image",
    action: "generate",
    provider: "old",
    model: "old-model",
    userHash: "user-c",
    dateKey: "2026-07-01",
    success: true
  }
];

const normalized = events.map((item) => test.normalizeModelUsageEvent(item));
const stats = test.aggregateModelUsageEvents(normalized, 30, baseDate);
assert.strictEqual(stats.today.total, 3);
assert.strictEqual(stats.today.estimatedCost, 4.825);
assert.strictEqual(stats.last30d.total, 4);
assert.strictEqual(stats.summary.analysis.total, 1);
assert.strictEqual(stats.summary.face.total, 1);
assert.strictEqual(stats.summary.image.total, 1);
assert.strictEqual(stats.summary.video.total, 1);
assert.strictEqual(stats.users[0].userHash, "user-a");
assert.strictEqual(stats.users[0].total, 3);
assert.strictEqual(stats.models.length, 4);
assert.ok(stats.monthly.some((item) => item.monthKey === "2026-08"));
assert.strictEqual(stats.daily[0].dateKey, "2026-08-23");
assert.strictEqual(stats.daily[0].image.imageResolutions["2K"].count, 1);
assert.strictEqual(stats.daily[0].face.totalTokens, 3000000);

const workbook = test.buildModelUsageExportWorkbook(stats);
assert.ok(Buffer.isBuffer(workbook));
assert.ok(workbook.length > 100);
assert.strictEqual(workbook.slice(0, 2).toString(), "PK");

console.log("model cost stats smoke: OK");
console.log(JSON.stringify({
  todayCost: stats.today.estimatedCost,
  userCount: stats.users.length,
  modelCount: stats.models.length,
  monthCount: stats.monthly.length,
  workbookBytes: workbook.length
}));
