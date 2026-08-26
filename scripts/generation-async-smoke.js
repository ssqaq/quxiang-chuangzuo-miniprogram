/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.PROMO_START_DATE = "2000-01-01";
process.env.PROMO_END_DATE = "2000-01-01";
process.env.DAILY_FREE_LIMIT = "0";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露测试接口");
assert.strictEqual(test.normalizeGenerationStatus("queued"), "queued");
assert.strictEqual(test.normalizeGenerationStatus("processing"), "processing");
assert.strictEqual(test.normalizeGenerationStatus("unknown"), "failed");

const queued = test.buildGenerationStatusResult({
  requestId: "async-smoke-request",
  kind: "image",
  status: "queued",
  pipelineStage: "queued",
  attemptCount: 0
});
assert.strictEqual(queued.taskId, "async-smoke-request");
assert.strictEqual(queued.status, "queued");
assert.strictEqual(queued.stage, "queued");
assert.strictEqual(queued.progress, 0);
assert.strictEqual(queued.result, null);

const sanitized = test.sanitizeGenerationPayload({
  mode: "generations",
  prompt: "hello",
  apiKey: "must-not-be-stored",
  authorization: "Bearer must-not-be-stored",
  headers: { Authorization: "must-not-be-stored" },
  faceFileIDs: Array.from({ length: 10 }, (_, index) => `face-${index}`),
  wardrobeFileIDs: Array.from({ length: 20 }, (_, index) => `wardrobe-${index}`)
});
assert.strictEqual(sanitized.mode, "generations");
assert.strictEqual(sanitized.faceFileIDs.length, 6);
assert.strictEqual(sanitized.wardrobeFileIDs.length, 12);
assert.ok(!Object.prototype.hasOwnProperty.call(sanitized, "apiKey"));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitized, "authorization"));
assert.ok(!Object.prototype.hasOwnProperty.call(sanitized, "headers"));
assert.ok(!JSON.stringify(sanitized).includes("must-not-be-stored"));

const processing = test.buildGenerationStatusResult({
  requestId: "async-processing-request",
  status: "processing",
  pipelineStage: "upload",
  progress: 88,
  result: {
    fileID: "cloud://result/one.png",
    recordId: "record-one"
  },
  openid: "must-not-be-returned",
  payload: { prompt: "must-not-be-returned" }
});
assert.strictEqual(processing.status, "processing");
assert.strictEqual(processing.stage, "upload");
assert.strictEqual(processing.progress, 88);
assert.strictEqual(processing.result, null);
assert.ok(!JSON.stringify(processing).includes("must-not-be-returned"));

console.log("generation async smoke: OK");
