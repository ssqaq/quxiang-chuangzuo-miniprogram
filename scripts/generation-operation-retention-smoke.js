const assert = require("assert");
const retention = require(
  "../cloudfunctions/api/lib/generation-operation-retention"
);

const NOW = new Date("2026-08-26T12:00:00.000Z");
const OLD = new Date("2026-05-01T12:00:00.000Z");
const RECENT = new Date("2026-08-01T12:00:00.000Z");

async function main() {
  assert.deepStrictEqual(
    retention.normalizeRetentionSettings(),
    { retentionDays: 90, batchSize: 50 }
  );
  assert.deepStrictEqual(
    retention.normalizeRetentionSettings({
      retentionDays: 1,
      batchSize: 500
    }),
    { retentionDays: 30, batchSize: 50 }
  );
  assert.strictEqual(
    retention.retentionCutoff(NOW, { retentionDays: 90 }).toISOString(),
    "2026-05-28T12:00:00.000Z"
  );

  assert.strictEqual(
    retention.operationRetentionDecision({
      status: "succeeded",
      updatedAt: OLD
    }, { now: NOW }).eligible,
    true
  );
  assert.strictEqual(
    retention.operationRetentionDecision({
      status: "refunded",
      updatedAt: OLD
    }, { now: NOW }).eligible,
    true
  );
  [
    "reserved",
    "queued",
    "processing",
    "failed",
    "refunding"
  ].forEach((status) => {
    assert.strictEqual(
      retention.operationRetentionDecision({
        status,
        updatedAt: OLD
      }, { now: NOW }).eligible,
      false,
      `${status} 不得清理`
    );
  });
  assert.strictEqual(
    retention.operationRetentionDecision({
      status: "succeeded",
      updatedAt: RECENT
    }, { now: NOW }).reason,
    "within-retention"
  );
  ["cleanupPending", "refundPending", "reconcilePending"].forEach((flag) => {
    assert.strictEqual(
      retention.operationRetentionDecision({
        status: "refunded",
        updatedAt: OLD,
        [flag]: true
      }, { now: NOW }).eligible,
      false,
      `${flag} 时不得清理`
    );
  });
  assert.strictEqual(
    retention.operationRetentionDecision({
      status: "succeeded",
      updatedAt: "invalid"
    }, { now: NOW }).reason,
    "updated-at-invalid"
  );

  const store = new Map([
    ["old-success", {
      _id: "old-success",
      openid: "secret-openid",
      prompt: "secret prompt",
      status: "succeeded",
      updatedAt: OLD
    }],
    ["old-refund", {
      _id: "old-refund",
      status: "refunded",
      updatedAt: OLD
    }],
    ["changed-to-processing", {
      _id: "changed-to-processing",
      status: "processing",
      updatedAt: OLD
    }],
    ["pending-cleanup", {
      _id: "pending-cleanup",
      status: "refunded",
      cleanupPending: true,
      updatedAt: OLD
    }],
    ["remove-fails", {
      _id: "remove-fails",
      status: "succeeded",
      updatedAt: OLD
    }],
    ["recent-success", {
      _id: "recent-success",
      status: "succeeded",
      updatedAt: RECENT
    }]
  ]);
  const candidateSnapshot = [
    { _id: "old-success", status: "succeeded", updatedAt: OLD },
    { _id: "old-success", status: "succeeded", updatedAt: OLD },
    { _id: "old-refund", status: "refunded", updatedAt: OLD },
    { _id: "changed-to-processing", status: "succeeded", updatedAt: OLD },
    { _id: "pending-cleanup", status: "refunded", updatedAt: OLD },
    { _id: "remove-fails", status: "succeeded", updatedAt: OLD },
    { _id: "recent-success", status: "succeeded", updatedAt: RECENT }
  ];
  const removed = [];
  const logs = [];
  const service = retention.createGenerationOperationRetentionService({
    listCandidates: async () => candidateSnapshot,
    readOperation: async (id) => store.get(id) || null,
    removeOperation: async (id) => {
      if (id === "remove-fails") {
        const error = new Error("delete failed");
        error.code = "DELETE_FAILED";
        throw error;
      }
      store.delete(id);
      removed.push(id);
    },
    log: (level, event, fields) => logs.push({ level, event, fields }),
    now: () => NOW
  });
  const summary = await service.cleanup({
    source: "admin",
    retentionDays: 90,
    batchSize: 50
  });
  assert.deepStrictEqual(removed.sort(), ["old-refund", "old-success"]);
  assert.strictEqual(summary.scanned, 6, "重复候选应去重");
  assert.strictEqual(summary.removed, 2);
  assert.strictEqual(summary.skipped, 3);
  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.failureCodes.DELETE_FAILED, 1);
  assert.ok(!JSON.stringify(summary).includes("secret-openid"));
  assert.ok(!JSON.stringify(summary).includes("secret prompt"));
  assert.ok(logs.some((item) => (
    item.event === "generation.operation-history-cleanup"
  )));
  assert.ok(logs.some((item) => (
    item.event === "generation.operation-history-cleanup-item-failed"
    && item.fields.errorCode === "DELETE_FAILED"
  )));

  const many = Array.from({ length: 70 }, (_, index) => ({
    _id: `old-${index}`,
    status: "succeeded",
    updatedAt: new Date(OLD.getTime() + index * 1000)
  }));
  let batchRemoved = 0;
  const limited = retention.createGenerationOperationRetentionService({
    listCandidates: async () => many,
    readOperation: async (id) => many.find((item) => item._id === id),
    removeOperation: async () => {
      batchRemoved += 1;
    },
    now: () => NOW
  });
  const limitedSummary = await limited.cleanup({ batchSize: 50 });
  assert.strictEqual(limitedSummary.scanned, 50);
  assert.strictEqual(limitedSummary.removed, 50);
  assert.strictEqual(batchRemoved, 50);

  assert.throws(
    () => retention.createGenerationOperationRetentionService({}),
    /缺少依赖/
  );

  console.log(
    "generation operation retention smoke: OK "
    + "(90-day cutoff/terminal-only/pending guard/reread/batch/log redaction)"
  );
}

main().catch((error) => {
  console.error(
    `generation operation retention smoke 失败：${error.stack || error}`
  );
  process.exitCode = 1;
});
