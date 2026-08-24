/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "probe-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数测试入口未导出");

async function main() {
  test.resetAutoFaceProbeTestEvents();

  const forbidden = await api.main({
    action: "getAutoFaceProbeHistory"
  }, { OPENID: "not-admin" });
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");

  const probeResult = await api.main({
    action: "probeAutoFace",
    requestId: "probe-history-smoke"
  }, { OPENID: "probe-admin" });
  assert.strictEqual(probeResult.ok, true);
  assert.strictEqual(probeResult.historyWritten, true);
  assert.strictEqual(probeResult.buildVersion, "0.25.0");
  assert.strictEqual(
    probeResult.buildMarker,
    "API_BUILD_TAG_20260824_ADMIN_CONSOLE_OPTION09_V250"
  );
  assert.ok(Number.isInteger(probeResult.durationMs));
  assert.ok(probeResult.durationMs >= 0);

  const stored = test.getAutoFaceProbeTestEvents();
  assert.strictEqual(stored.length, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(stored[0], "apiKey"));
  assert.ok(!Object.prototype.hasOwnProperty.call(stored[0], "stack"));

  const baseDate = Date.now();
  for (let index = 0; index < 25; index += 1) {
    await test.writeAutoFaceProbeHistory({
      status: index % 5 === 0 ? "failed" : "ok",
      requestId: `history-${index}`,
      buildVersion: "0.25.0",
      buildMarker: "API_BUILD_TAG_20260824_ADMIN_CONSOLE_OPTION09_V250",
      nodeVersion: "Nodejs16.13",
      cloudEnvConfigured: true,
      visionConfigured: index % 2 === 0,
      provider: "dashscope",
      model: "qwen3-vl-flash",
      durationMs: index + 10,
      errorCode: index % 5 === 0 ? "probe-error" : "",
      checkedAt: new Date(baseDate + index * 1000),
      createdAt: new Date(baseDate + index * 1000)
    });
  }

  const historyResult = await api.main({
    action: "getAutoFaceProbeHistory"
  }, { OPENID: "probe-admin" });
  assert.strictEqual(historyResult.ok, true);
  assert.strictEqual(historyResult.unavailable, false);
  assert.strictEqual(historyResult.history.length, 20);
  assert.strictEqual(historyResult.history[0].requestId, "history-24");
  assert.strictEqual(historyResult.history[0].durationMs, 34);
  assert.strictEqual(historyResult.history[0].status, "ok");
  assert.ok(historyResult.history.some((item) => item.status === "failed"));
  assert.ok(historyResult.history.every((item) => !Object.prototype.hasOwnProperty.call(item, "apiKey")));
  assert.ok(historyResult.history.every((item) => !Object.prototype.hasOwnProperty.call(item, "stack")));

  const cutoff = test.autoFaceProbeHistoryCutoff(new Date(baseDate));
  await test.writeAutoFaceProbeHistory({
    status: "ok",
    buildVersion: "0.25.0",
    buildMarker: "API_BUILD_TAG_20260824_ADMIN_CONSOLE_OPTION09_V250",
    checkedAt: new Date(cutoff.getTime() - 1),
    createdAt: new Date(cutoff.getTime() - 1)
  });
  const cleanup = await test.cleanupAutoFaceProbeHistory(new Date(baseDate));
  assert.ok(cleanup.removed >= 1);

  console.log("auto face probe history smoke: OK");
  console.log(JSON.stringify({
    historyCount: historyResult.history.length,
    newestRequestId: historyResult.history[0].requestId,
    durationMs: probeResult.durationMs,
    retentionDays: historyResult.retentionDays
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
