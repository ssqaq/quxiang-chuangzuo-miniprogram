const assert = require("assert");
const http = require("http");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "";

const cloud = require("../cloudfunctions/api/index.js");

async function withServer(statusCode, callback) {
  const server = http.createServer((request, response) => {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: statusCode >= 200 && statusCode < 300 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  cloud.__test.resetModelUsageTestEvents();

  await withServer(200, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "POST", headers: {} },
      Buffer.from("image"),
      {
        requestId: "usage-image",
        action: "generate",
        provider: "demo-image",
        model: "demo-image-model",
        allowRetry: false
      }
    );
    assert.strictEqual(response.status, 200);
  });

  await withServer(503, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "POST", headers: {} },
      Buffer.from("face"),
      {
        requestId: "usage-face",
        action: "detectFaceCircle",
        provider: "demo-face",
        model: "demo-face-model",
        allowRetry: false
      }
    );
    assert.strictEqual(response.status, 503);
  });

  await withServer(201, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "POST", headers: {} },
      Buffer.from("video"),
      {
        requestId: "usage-video",
        action: "video.create",
        provider: "demo-video",
        model: "demo-video-model",
        allowRetry: false
      }
    );
    assert.strictEqual(response.status, 201);
  });

  await withServer(200, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "GET", headers: {} },
      null,
      {
        requestId: "usage-video-query",
        action: "video.query",
        provider: "demo-video",
        model: "demo-video-model",
        allowRetry: false
      }
    );
    assert.strictEqual(response.status, 200);
  });

  const events = cloud.__test.getModelUsageTestEvents();
  assert.strictEqual(events.length, 3);
  assert.deepStrictEqual(
    events.map((item) => item.usageType).sort(),
    ["face", "image", "video"]
  );
  assert.strictEqual(events.find((item) => item.usageType === "face").failure, undefined);
  assert.strictEqual(events.find((item) => item.usageType === "face").success, false);
  assert.strictEqual(events.find((item) => item.usageType === "image").success, true);

  const fixedDate = new Date("2026-08-23T12:00:00.000Z");
  const normalizedEvents = events.map((item) => Object.assign({}, item, {
    dateKey: "2026-08-23"
  }));
  const stats = cloud.__test.aggregateModelUsageEvents(normalizedEvents, 30, fixedDate);
  assert.strictEqual(stats.today.total, 3);
  assert.strictEqual(stats.today.success, 2);
  assert.strictEqual(stats.today.failure, 1);
  assert.strictEqual(stats.summary.image.total, 1);
  assert.strictEqual(stats.summary.face.failure, 1);
  assert.strictEqual(stats.summary.video.success, 1);
  assert.strictEqual(stats.daily[0].dateKey, "2026-08-23");

  const forbidden = await cloud.main(
    { action: "getModelUsageStats", days: 30 },
    { OPENID: "not-admin" }
  );
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  process.env.ADMIN_OPENIDS = "stats-admin";
  const adminStats = await cloud.main(
    { action: "getModelUsageStats", days: 30 },
    { OPENID: "stats-admin" }
  );
  assert.strictEqual(adminStats.ok, true);
  assert.strictEqual(adminStats.last30d.total, 3);
  assert.strictEqual(adminStats.summary.video.total, 1);

  console.log("model usage stats smoke: OK");
  console.log(JSON.stringify({
    eventCount: events.length,
    todayTotal: stats.today.total,
    todaySuccess: stats.today.success,
    todayFailure: stats.today.failure,
    videoQueriesExcluded: true
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
