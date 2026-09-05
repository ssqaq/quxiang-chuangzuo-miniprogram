"use strict";

const MONITOR_COLLECTION = "payment_monitor_status";
const MONITOR_DOCUMENT_ID = "global";
const MONITOR_SCHEMA_VERSION = 1;
const TIMER_STALE_MS = 5 * 60 * 1000;
const PAID_UNFULFILLED_MS = 5 * 60 * 1000;
const BACKLOG_AGE_WARNING_MS = 15 * 60 * 1000;
const BACKLOG_COUNT_WARNING = 20;

const SEVERITY_RANK = Object.freeze({
  disabled: 0,
  healthy: 0,
  warning: 1,
  critical: 2
});

function dateMillis(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function maxSeverity(left, right) {
  const current = SEVERITY_RANK[left] === undefined ? "healthy" : left;
  const incoming = SEVERITY_RANK[right] === undefined ? "healthy" : right;
  return SEVERITY_RANK[incoming] > SEVERITY_RANK[current] ? incoming : current;
}

function normalizeCount(value) {
  return Math.max(0, Number(value) || 0);
}

function evaluateHealth(metrics = {}, summary = {}, options = {}) {
  if (options.mode === "disabled") {
    return { severity: "disabled", reasonCodes: ["RECONCILIATION_DISABLED"] };
  }
  let severity = "healthy";
  const reasonCodes = [];
  const push = (reason, nextSeverity) => {
    if (!reasonCodes.includes(reason)) reasonCodes.push(reason);
    severity = maxSeverity(severity, nextSeverity);
  };
  const failed = normalizeCount(summary.failed);
  const consecutiveFailureCount = normalizeCount(options.consecutiveFailureCount);
  if (failed > 0) {
    push(
      consecutiveFailureCount >= 2 ? "RECONCILE_CONSECUTIVE_FAILURES" : "RECONCILE_RUN_FAILED",
      consecutiveFailureCount >= 2 ? "critical" : "warning"
    );
  }
  if (normalizeCount(metrics.paidUnfulfilledCount) > 0) {
    push("PAID_UNFULFILLED", "critical");
  }
  if (normalizeCount(metrics.reviewCount) > 0) push("REVIEW_REQUIRED", "warning");
  if (normalizeCount(metrics.refundReviewCount) > 0) push("REFUND_REVIEW_REQUIRED", "warning");
  if (normalizeCount(metrics.dueBacklogCount) > BACKLOG_COUNT_WARNING) {
    push("DUE_BACKLOG_COUNT", "warning");
  }
  const nowMs = dateMillis(options.now || Date.now());
  const oldestDueMs = dateMillis(metrics.oldestDueAt);
  if (oldestDueMs && nowMs - oldestDueMs > BACKLOG_AGE_WARNING_MS) {
    push("DUE_BACKLOG_AGE", "warning");
  }
  return { severity, reasonCodes };
}

function buildSnapshot(options = {}) {
  const previous = options.previous && typeof options.previous === "object"
    ? options.previous
    : {};
  const summary = options.summary && typeof options.summary === "object"
    ? options.summary
    : {};
  const metrics = options.metrics && typeof options.metrics === "object"
    ? options.metrics
    : {};
  const mode = options.mode === "disabled" ? "disabled" : "enabled";
  const startedAt = options.startedAt instanceof Date
    ? options.startedAt
    : new Date(options.startedAt || Date.now());
  const completedAt = options.completedAt instanceof Date
    ? options.completedAt
    : new Date(options.completedAt || Date.now());
  const failed = normalizeCount(summary.failed);
  const runSucceeded = failed === 0 && options.runError !== true;
  const consecutiveFailureCount = runSucceeded
    ? 0
    : normalizeCount(previous.consecutiveFailureCount) + 1;
  const health = evaluateHealth(metrics, summary, {
    mode,
    now: completedAt,
    consecutiveFailureCount
  });
  const previousSuccessAt = previous.lastSuccessAt || null;
  return {
    schemaVersion: MONITOR_SCHEMA_VERSION,
    mode,
    lastRunStartedAt: startedAt,
    lastRunCompletedAt: completedAt,
    lastSuccessAt: runSucceeded ? completedAt : previousSuccessAt,
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    scanned: normalizeCount(summary.scanned),
    claimed: normalizeCount(summary.claimed || summary.processed),
    fulfilled: normalizeCount(summary.fulfilled),
    failed,
    skipped: normalizeCount(summary.skipped),
    stoppedEarly: Boolean(summary.stoppedEarly),
    dueBacklogCount: normalizeCount(metrics.dueBacklogCount),
    oldestDueAt: metrics.oldestDueAt || null,
    reviewCount: normalizeCount(metrics.reviewCount),
    refundReviewCount: normalizeCount(metrics.refundReviewCount),
    paidUnfulfilledCount: normalizeCount(metrics.paidUnfulfilledCount),
    consecutiveFailureCount,
    metricsAvailable: options.metricsAvailable !== false,
    severity: health.severity,
    reasonCodes: health.reasonCodes,
    updatedAt: completedAt
  };
}

async function countQuery(query) {
  const result = await query.count();
  return normalizeCount(result && result.total);
}

async function loadPaymentHealthMetrics(db, now = new Date()) {
  const command = db.command;
  const orders = db.collection("payment_orders");
  const dueCondition = {
    reconcileRequired: true,
    nextReconcileAt: command.lte(now)
  };
  const paidCutoff = new Date(now.getTime() - PAID_UNFULFILLED_MS);
  const [
    dueBacklogCount,
    oldestDueResult,
    reviewCount,
    refundReviewCount,
    paidUnfulfilledCount
  ] = await Promise.all([
    countQuery(orders.where(dueCondition)),
    orders.where(dueCondition).orderBy("nextReconcileAt", "asc").limit(1).get(),
    countQuery(orders.where({ status: "review" })),
    countQuery(orders.where({ status: "refund_review" })),
    countQuery(orders.where({ status: "paid", paidAt: command.lte(paidCutoff) }))
  ]);
  const oldest = oldestDueResult && Array.isArray(oldestDueResult.data)
    ? oldestDueResult.data[0]
    : null;
  return {
    dueBacklogCount,
    oldestDueAt: oldest && oldest.nextReconcileAt || null,
    reviewCount,
    refundReviewCount,
    paidUnfulfilledCount
  };
}

async function readSnapshot(db) {
  try {
    const result = await db.collection(MONITOR_COLLECTION).doc(MONITOR_DOCUMENT_ID).get();
    return result && result.data || null;
  } catch (_error) {
    return null;
  }
}

async function writeSnapshot(db, snapshot) {
  await db.collection(MONITOR_COLLECTION).doc(MONITOR_DOCUMENT_ID).set({
    data: Object.assign({}, snapshot)
  });
  return snapshot;
}

module.exports = {
  MONITOR_COLLECTION,
  MONITOR_DOCUMENT_ID,
  MONITOR_SCHEMA_VERSION,
  TIMER_STALE_MS,
  PAID_UNFULFILLED_MS,
  BACKLOG_AGE_WARNING_MS,
  BACKLOG_COUNT_WARNING,
  dateMillis,
  maxSeverity,
  evaluateHealth,
  buildSnapshot,
  loadPaymentHealthMetrics,
  readSnapshot,
  writeSnapshot
};
