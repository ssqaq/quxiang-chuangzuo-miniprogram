const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexJs = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");
const indexWxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const indexWxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const clientCloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");
const cloudFunction = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);
const generationKernel = fs.readFileSync(
  path.join(root, "cloudfunctions/api/lib/generation-execution-kernel.js"),
  "utf8"
);
const generationBackend = `${cloudFunction}\n${generationKernel}`;

assert.ok(indexJs.includes("GENERATION_TIMEOUT_MS = 120000"));
assert.ok(indexJs.includes("GENERATION_POLL_DELAYS_MS = [2000, 4000, 6000]"));
assert.ok(indexJs.includes("GENERATION_POLL_TIMEOUT_MS = 15 * 60 * 1000"));
assert.ok(indexJs.includes("GENERATION_PENDING_STORAGE_KEY"));
assert.ok(indexJs.includes("startGenerationPolling"));
assert.ok(indexJs.includes("pollGenerationStatus"));
assert.ok(indexJs.includes("savePendingGenerationTask"));
assert.ok(indexJs.includes("restorePendingGenerationTask"));
assert.ok(indexJs.includes("applyGenerationResult"));
assert.ok(indexJs.includes("任务已提交"));
assert.ok(!indexJs.includes("GENERATION_RETRY_LIMIT = 2"));
assert.ok(!indexJs.includes("正在重试生成"));
assert.ok(clientCloudJs.includes("function submitGeneration"));
assert.ok(clientCloudJs.includes("function getGenerationStatus"));
assert.ok(clientCloudJs.includes('action: "getGenerationStatus"'));
assert.ok(indexWxml.includes("generation-checklist"));
assert.ok(indexWxml.includes("generation-check-row"));
assert.ok(indexWxml.includes("等待上一项完成"));
assert.ok(indexWxml.includes('id="generation-results"'));
assert.ok(indexWxml.includes("generationTaskMessage"));
assert.ok(indexWxml.includes("任务已提交，后台会自动生成"));
assert.ok(indexWxss.includes(".generation-checklist"));
assert.ok(indexWxss.includes(".generation-check-row.is-current"));
assert.ok(indexWxss.includes("@keyframes generation-check-current-pulse"));
assert.ok(indexWxss.includes(".generation-task-meta"));
assert.ok(indexWxss.includes(".generation-waiting-timeout"));
assert.ok(cloudFunction.includes('action === "getGenerationStatus"'));
assert.ok(generationBackend.includes("findGenerationRecord"));
assert.ok(generationBackend.includes("generation.idempotent_hit"));

const actionCounts = {};
const requestIds = [];

global.getApp = () => ({
  globalData: {
    cloudReady: true
  }
});
global.wx = {
  cloud: {
    callFunction({ data, success }) {
      actionCounts[data.action] = (actionCounts[data.action] || 0) + 1;
      requestIds.push(data.requestId);
      setTimeout(() => {
        if (data.action === "generate") {
          success({
            result: {
              ok: true,
              requestId: data.requestId,
              taskId: data.requestId,
              status: "queued",
              stage: "queued",
              progress: 0,
              message: "生图任务已提交"
            }
          });
          return;
        }
        success({
          result: {
            ok: true,
            requestId: data.requestId,
            taskId: data.requestId,
            status: "succeeded",
            stage: "succeeded",
            progress: 100,
            result: {
              requestId: data.requestId,
              recordId: "smoke-record",
              fileID: "cloud://result/smoke.png"
            }
          }
        });
      }, 0);
    }
  }
};

const cloud = require("../services/cloud");

async function main() {
  const submitted = await cloud.submitGeneration(
    { prompt: "smoke" },
    { requestId: "smoke-client-request" }
  );
  assert.strictEqual(submitted.status, "queued");
  assert.strictEqual(actionCounts.generate, 1);

  const status = await cloud.getGenerationStatus(
    "smoke-client-request",
    { silent: true }
  );
  assert.strictEqual(status.status, "succeeded");
  assert.strictEqual(status.result.recordId, "smoke-record");
  assert.strictEqual(actionCounts.getGenerationStatus, 1);
  assert.deepStrictEqual(requestIds, [
    "smoke-client-request",
    "smoke-client-request"
  ]);

  const aliasResult = await cloud.generateImage(
    { prompt: "alias" },
    {
      requestId: "smoke-alias-request",
      maxRetries: 9,
      onRetry() {
        throw new Error("异步提交不能触发生图重试");
      }
    }
  );
  assert.strictEqual(aliasResult.status, "queued");
  assert.strictEqual(actionCounts.generate, 2);

  console.log("generation experience smoke: OK (submit once + status polling)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
