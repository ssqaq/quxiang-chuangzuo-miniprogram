const MAX_STAGE_HISTORY = 20;
const STATUSES = Object.freeze([
  "reserved",
  "queued",
  "processing",
  "succeeded",
  "failed",
  "refunding",
  "refunded"
]);

const TRANSITIONS = Object.freeze({
  "": Object.freeze(["reserved"]),
  reserved: Object.freeze(["reserved", "queued", "processing", "failed", "refunding"]),
  queued: Object.freeze(["queued", "processing", "failed", "refunding"]),
  processing: Object.freeze(["processing", "queued", "succeeded", "failed", "refunding"]),
  failed: Object.freeze(["failed", "queued", "processing", "succeeded", "refunding"]),
  refunding: Object.freeze(["refunding", "refunded"]),
  refunded: Object.freeze(["refunded"]),
  succeeded: Object.freeze(["succeeded"])
});

function text(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeStatus(value, fallback = "") {
  const status = text(value, 40).toLowerCase();
  if (STATUSES.includes(status)) return status;
  return fallback;
}

function transitionError(fromStatus, toStatus) {
  const error = new Error(
    `生图任务状态不允许从 ${fromStatus || "初始状态"} 跳到 ${toStatus || "空状态"}。`
  );
  error.code = "generation-transition-invalid";
  error.retryable = false;
  error.fromStatus = fromStatus;
  error.toStatus = toStatus;
  return error;
}

function assertTransition(fromValue, toValue) {
  const fromStatus = normalizeStatus(fromValue, "");
  const toStatus = normalizeStatus(toValue, "");
  if (!toStatus) throw transitionError(fromStatus, toStatus);
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed || !allowed.includes(toStatus)) {
    throw transitionError(fromStatus, toStatus);
  }
  return { fromStatus, toStatus };
}

function sanitizeHistoryEntry(entry = {}) {
  const status = normalizeStatus(entry.status, "");
  if (!status) return null;
  return {
    at: entry.at || new Date(),
    fromStatus: normalizeStatus(entry.fromStatus, ""),
    status,
    stage: text(entry.stage || status, 40),
    progress: Math.max(0, Math.min(100, Math.round(Number(entry.progress) || 0))),
    attemptCount: Math.max(0, Math.round(Number(entry.attemptCount) || 0)),
    actor: text(entry.actor || "system", 40),
    code: text(entry.code, 80)
  };
}

function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(sanitizeHistoryEntry)
    .filter(Boolean)
    .slice(-MAX_STAGE_HISTORY);
}

function shouldAppendHistory(previous, next) {
  if (!previous) return true;
  return (
    previous.status !== next.status
    || previous.stage !== next.stage
    || previous.code !== next.code
  );
}

function applyTransition(operation = {}, patch = {}, options = {}) {
  const current = operation && typeof operation === "object" ? operation : {};
  const update = patch && typeof patch === "object" ? Object.assign({}, patch) : {};
  const fromStatus = normalizeStatus(current.status, "");
  const requestedStatus = Object.prototype.hasOwnProperty.call(update, "status")
    ? update.status
    : fromStatus;
  const toStatus = normalizeStatus(requestedStatus, "");
  if (!fromStatus && !toStatus) return update;
  assertTransition(fromStatus, toStatus);

  const stage = text(
    options.stage
    || update.pipelineStage
    || current.pipelineStage
    || toStatus,
    40
  );
  const code = text(
    options.code
    || update.lastError && update.lastError.code
    || "",
    80
  );
  const entry = sanitizeHistoryEntry({
    at: options.at || new Date(),
    fromStatus,
    status: toStatus,
    stage,
    progress: update.progress === undefined ? current.progress : update.progress,
    attemptCount: update.attemptCount === undefined
      ? current.attemptCount
      : update.attemptCount,
    actor: options.actor || "system",
    code
  });
  const history = sanitizeHistory(current.stageHistory);
  if (shouldAppendHistory(history[history.length - 1], entry)) {
    history.push(entry);
  }
  update.stageHistory = history.slice(-MAX_STAGE_HISTORY);
  return update;
}

function isTerminalStatus(value) {
  return ["succeeded", "refunded"].includes(normalizeStatus(value, ""));
}

module.exports = {
  MAX_STAGE_HISTORY,
  STATUSES,
  TRANSITIONS,
  normalizeStatus,
  assertTransition,
  sanitizeHistory,
  applyTransition,
  isTerminalStatus
};
