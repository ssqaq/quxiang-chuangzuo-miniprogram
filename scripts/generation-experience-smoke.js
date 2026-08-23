const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexJs = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");
const indexWxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const indexWxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const cloudFunction = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);

assert.ok(indexJs.includes("GENERATION_TIMEOUT_MS = 120000"));
assert.ok(indexJs.includes("GENERATION_RETRY_LIMIT = 2"));
assert.ok(indexJs.includes('"upload"'));
assert.ok(indexJs.includes('"save"'));
assert.ok(indexJs.includes("createClientRequestId"));
assert.ok(indexJs.includes("generationTimedOut"));
assert.ok(indexJs.includes("正在重试生成"));
assert.ok(indexWxml.includes("generation-checklist"));
assert.ok(indexWxml.includes("generation-check-row"));
assert.ok(indexWxml.includes("等待上一项完成"));
assert.ok(indexWxml.includes("generationRetryCount"));
assert.ok(indexWxss.includes(".generation-checklist"));
assert.ok(indexWxss.includes(".generation-check-row.is-current"));
assert.ok(indexWxss.includes(".generation-waiting-footer"));
assert.ok(indexWxss.includes(".generation-waiting-timeout"));
assert.ok(indexWxss.includes("@media (min-width: 360px) and (max-width: 389px)"));
assert.ok(indexWxss.includes("@media (min-width: 400px) and (max-width: 430px)"));
assert.ok(cloudFunction.includes("findGenerationRecord"));
assert.ok(cloudFunction.includes("generation.idempotent_hit"));
assert.ok(cloudFunction.includes("event.requestId"));

let attempts = 0;
const retryEvents = [];
const requestIds = [];

global.getApp = () => ({
  globalData: {
    cloudReady: true
  }
});
global.wx = {
  cloud: {
    callFunction({ data, success }) {
      attempts += 1;
      requestIds.push(data.requestId);
      setTimeout(() => {
        if (attempts < 3) {
          success({
            result: {
              ok: false,
              retryable: true,
              errorCode: "timeout",
              message: "模拟超时",
              requestId: data.requestId
            }
          });
          return;
        }
        success({
          result: {
            ok: true,
            requestId: data.requestId,
            recordId: "smoke-record"
          }
        });
      }, 0);
    }
  }
};

const cloud = require("../services/cloud");

cloud.generateImage(
  { prompt: "smoke" },
  {
    requestId: "smoke-client-request",
    onRetry(event) {
      retryEvents.push(event);
    }
  }
).then((result) => {
  assert.strictEqual(result.recordId, "smoke-record");
  assert.strictEqual(attempts, 3);
  assert.deepStrictEqual(requestIds, [
    "smoke-client-request",
    "smoke-client-request",
    "smoke-client-request"
  ]);
  assert.strictEqual(retryEvents.length, 2);
  assert.strictEqual(retryEvents[0].attempt, 1);
  assert.strictEqual(retryEvents[1].attempt, 2);
  assert.strictEqual(retryEvents[0].maxRetries, 2);
  assert.strictEqual(retryEvents[0].delayMs, 2000);
  console.log("generation experience smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
