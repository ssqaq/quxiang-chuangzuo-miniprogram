/* eslint-disable no-console */

const assert = require("assert");
const http = require("http");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");

const fakeKey = "video-smoke-key-not-a-real-secret";
const requestId = "video-smoke-request-001";
let createAttempts = 0;
let queryAttempts = 0;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

async function main() {
  process.env.WECHAT_MINIAPP_TEST = "1";
  process.env.AI_VIDEO_PROVIDER = "lingyun";
  process.env.AI_VIDEO_API_KEY = fakeKey;
  process.env.AI_VIDEO_MODEL = "grok-smoke-model";
  process.env.AI_VIDEO_CREATE_PATH = "/v1/videos/generations";
  process.env.AI_VIDEO_QUERY_PATH = "/v1/videos/{taskId}";
  process.env.AI_VIDEO_TIMEOUT_MS = "5000";
  process.env.AI_MAX_RETRIES = "1";
  delete process.env.AI_VIDEO_RESOLUTION;

  const api = require("../cloudfunctions/api/index.js");
  const cloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");
  const test = api.__test;
  assert.ok(test, "云函数没有暴露测试接口");
  assert.strictEqual(test.resolveVideoConfig().resolution, "720p");

  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/videos/generations") {
      createAttempts += 1;
      const body = await readBody(request);
      assert.strictEqual(body.model, "grok-smoke-model");
      assert.strictEqual(body.resolution, "720p");
      assert.ok(body.prompt.includes("本地协议测试"));
      assert.ok(body.image && typeof body.image === "object");
      assert.ok(/^data:image\/jpeg;base64,/.test(body.image.url));
      sendJson(response, 200, { request_id: "provider-task-001" });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/videos/provider-task-001") {
      queryAttempts += 1;
      if (queryAttempts === 1) {
        sendJson(response, 503, { message: "暂时繁忙" });
        return;
      }
      sendJson(response, 200, {
        status: "done",
        video: { url: "https://video.invalid/provider-task-001.mp4" }
      });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/videos/failed-task") {
      sendJson(response, 200, {
        status: "failed",
        error: { message: "供应商拒绝了这次测试任务" }
      });
      return;
    }
    sendJson(response, 404, { message: "not found" });
  });

  const originalDownloadFile = cloud.downloadFile;
  const originalUploadFile = cloud.uploadFile;
  const originalConsole = {
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  const logs = [];
  console.info = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    process.env.AI_VIDEO_BASE_URL = `http://127.0.0.1:${address.port}`;
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    cloud.downloadFile = async () => ({
      fileContent: PNG.sync.write(png)
    });
    cloud.uploadFile = async ({ cloudPath }) => ({
      fileID: `cloud://smoke/${cloudPath}`
    });

    const created = await api.main({
      action: "createVideoTask",
      requestId,
      payload: {
        imageFileID: "cloud://smoke-source",
        prompt: "只做本地协议测试",
        durationSeconds: 3,
        resolution: "720p"
      }
    });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(created.requestId, requestId);
    assert.strictEqual(created.taskId, "provider-task-001");
    assert.ok(created.sourceImageFileID.includes("photo-to-video-sources"));
    assert.strictEqual(createAttempts, 1, "创建接口不允许自动重试");

    const queried = await api.main({
      action: "queryVideoTask",
      requestId,
      taskId: created.taskId
    });
    assert.strictEqual(queried.ok, true);
    assert.strictEqual(queried.requestId, requestId);
    assert.strictEqual(queried.status, "succeeded");
    assert.strictEqual(queried.videoURL, "https://video.invalid/provider-task-001.mp4");
    assert.strictEqual(queryAttempts, 2, "查询接口应允许重试");

    const failed = await api.main({
      action: "queryVideoTask",
      requestId,
      taskId: "failed-task"
    });
    assert.strictEqual(failed.ok, true);
    assert.strictEqual(failed.requestId, requestId);
    assert.strictEqual(failed.status, "failed");
    assert.ok(failed.error.includes("供应商拒绝"));

    assert.throws(
      () => test.normalizeVideoCreateResponse({ status: "queued" }),
      (error) => error && error.code === "VIDEO_CREATE_RESPONSE_INVALID"
    );
    assert.strictEqual(
      test.normalizeVideoQueryResponse({
        status: "done",
        video: { url: "https://video.invalid/done.mp4" }
      }).status,
      "succeeded"
    );
    assert.strictEqual(
      test.normalizeVideoQueryResponse({ status: "failed", message: "failed" }).status,
      "failed"
    );

    const joinedLogs = logs.join("\n");
    assert.ok(!joinedLogs.includes(fakeKey), "日志泄露了 API Key");
    assert.ok(!joinedLogs.includes("data:image/png;base64"), "日志泄露了图片 Data URL");
    console.log("video-provider smoke: OK (config/create/query/retry/failure/redaction)");
  } finally {
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    cloud.downloadFile = originalDownloadFile;
    cloud.uploadFile = originalUploadFile;
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(`video-provider smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
