const assert = require("assert");
const {
  DEFAULT_QUEUE_SETTINGS,
  normalizeQueueSettings,
  buildQueueSnapshot,
  buildAdminOperationSummary,
  buildAdminOperationHistory,
  decideQueueAlert
} = require("../cloudfunctions/api/lib/generation-queue-monitor");

function date(value) {
  return new Date(value);
}

function main() {
  assert.deepStrictEqual(normalizeQueueSettings(), DEFAULT_QUEUE_SETTINGS);
  assert.deepStrictEqual(
    normalizeQueueSettings({
      workerConcurrency: 99,
      alertThreshold: 0,
      alertCooldownMinutes: 120
    }),
    {
      workerConcurrency: 4,
      alertThreshold: 1,
      alertCooldownMinutes: 60
    }
  );
  assert.deepStrictEqual(
    normalizeQueueSettings({
      workerConcurrency: "2",
      alertThreshold: "8",
      alertCooldownMinutes: "15"
    }),
    {
      workerConcurrency: 2,
      alertThreshold: 8,
      alertCooldownMinutes: 15
    }
  );

  const now = date("2026-08-26T12:00:00.000Z");
  const operations = [
    {
      _id: "operation-1",
      requestId: "request-secret-1234567890",
      openid: "openid-secret-value",
      kind: "image",
      status: "queued",
      pipelineStage: "queued",
      progress: 0,
      attemptCount: 0,
      prompt: "完整提示词不能返回",
      input: { apiKey: "secret" },
      createdAt: date("2026-08-26T11:52:00.000Z"),
      updatedAt: date("2026-08-26T11:55:00.000Z"),
      stageHistory: []
    },
    {
      _id: "operation-2",
      requestId: "video-request-2",
      openid: "openid-secret-value-2",
      kind: "video",
      status: "processing",
      pipelineStage: "provider",
      progress: 40,
      attemptCount: 1,
      createdAt: date("2026-08-26T11:58:00.000Z"),
      updatedAt: date("2026-08-26T11:59:00.000Z"),
      lastError: {
        code: "provider-pending",
        message: "上游仍在处理"
      }
    },
    {
      _id: "operation-3",
      requestId: "failed-request-3",
      openid: "openid-secret-value-3",
      kind: "image",
      status: "refunding",
      pipelineStage: "refund",
      progress: 90,
      attemptCount: 2,
      refundPending: true,
      createdAt: date("2026-08-26T11:40:00.000Z"),
      updatedAt: date("2026-08-26T11:50:00.000Z")
    }
  ];
  const snapshot = buildQueueSnapshot(operations, {
    now,
    settings: {
      workerConcurrency: 2,
      alertThreshold: 1,
      alertCooldownMinutes: 10
    }
  });
  assert.strictEqual(snapshot.total, 3);
  assert.strictEqual(snapshot.counts.queued, 1);
  assert.strictEqual(snapshot.counts.processing, 1);
  assert.strictEqual(snapshot.counts.refunding, 1);
  assert.strictEqual(snapshot.kinds.image, 2);
  assert.strictEqual(snapshot.kinds.video, 1);
  assert.strictEqual(snapshot.oldestQueuedAgeSeconds, 480);
  assert.strictEqual(snapshot.alertActive, true);
  assert.strictEqual(snapshot.workerConcurrency, 2);

  const summary = buildAdminOperationSummary(operations[0], { now });
  const serializedSummary = JSON.stringify(summary);
  assert.strictEqual(summary.operationId, "operation-1");
  assert.ok(summary.requestId.includes("…"));
  assert.ok(!serializedSummary.includes("openid-secret-value"));
  assert.ok(!serializedSummary.includes("完整提示词不能返回"));
  assert.ok(!serializedSummary.includes("secret"));
  assert.strictEqual(summary.ageSeconds, 480);

  const history = Array.from({ length: 25 }, (_, index) => ({
    at: date(`2026-08-26T11:${String(30 + index).padStart(2, "0")}:00.000Z`),
    fromStatus: index ? "processing" : "queued",
    status: "processing",
    stage: `stage-${index}`,
    progress: index * 4,
    attemptCount: index,
    actor: "worker",
    code: index === 24 ? "last-code" : ""
  }));
  const detail = buildAdminOperationHistory(Object.assign({}, operations[1], {
    stageHistory: history,
    upstream: { authorization: "Bearer secret" },
    payload: { prompt: "不能返回" }
  }), { now });
  assert.strictEqual(detail.history.length, 20);
  assert.strictEqual(detail.history[19].code, "last-code");
  assert.ok(!JSON.stringify(detail).includes("Bearer secret"));
  assert.ok(!JSON.stringify(detail).includes("不能返回"));

  const firstAlert = decideQueueAlert(snapshot, {}, { now });
  assert.strictEqual(firstAlert.action, "alert");
  assert.strictEqual(firstAlert.shouldLog, true);
  assert.strictEqual(firstAlert.nextState.active, true);

  const cooled = decideQueueAlert(snapshot, firstAlert.nextState, {
    now: date("2026-08-26T12:05:00.000Z")
  });
  assert.strictEqual(cooled.action, "hold");
  assert.strictEqual(cooled.shouldLog, false);

  const repeated = decideQueueAlert(snapshot, firstAlert.nextState, {
    now: date("2026-08-26T12:11:00.000Z")
  });
  assert.strictEqual(repeated.action, "alert");
  assert.strictEqual(repeated.shouldLog, true);

  const recoveredSnapshot = Object.assign({}, snapshot, {
    counts: Object.assign({}, snapshot.counts, { queued: 0 }),
    queuedCount: 0,
    alertActive: false
  });
  const recovered = decideQueueAlert(recoveredSnapshot, firstAlert.nextState, {
    now: date("2026-08-26T12:06:00.000Z")
  });
  assert.strictEqual(recovered.action, "recovered");
  assert.strictEqual(recovered.shouldLog, true);
  assert.strictEqual(recovered.nextState.active, false);

  console.log("generation queue monitor smoke: OK");
}

main();
