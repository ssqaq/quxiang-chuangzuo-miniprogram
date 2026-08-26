const DEFAULT_RETENTION_DAYS = 90;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 50;
const TERMINAL_STATUSES = Object.freeze(["succeeded", "refunded"]);

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function normalizeRetentionSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    retentionDays: boundedInteger(
      source.retentionDays,
      DEFAULT_RETENTION_DAYS,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS
    ),
    batchSize: boundedInteger(
      source.batchSize,
      DEFAULT_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE
    )
  });
}

function dateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : new Date(date).getTime();
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function retentionCutoff(nowValue, settingsValue = {}) {
  const settings = normalizeRetentionSettings(settingsValue);
  const nowMs = dateMs(nowValue) || Date.now();
  return new Date(
    nowMs - settings.retentionDays * 24 * 60 * 60 * 1000
  );
}

function operationRetentionDecision(operation = {}, options = {}) {
  const settings = normalizeRetentionSettings(options.settings);
  const cutoff = options.cutoff instanceof Date
    ? options.cutoff
    : retentionCutoff(options.now, settings);
  const status = String(operation && operation.status || "").trim().toLowerCase();
  if (!TERMINAL_STATUSES.includes(status)) {
    return { eligible: false, reason: "status-not-terminal", status };
  }
  if (operation.cleanupPending === true) {
    return { eligible: false, reason: "cleanup-pending", status };
  }
  if (operation.refundPending === true) {
    return { eligible: false, reason: "refund-pending", status };
  }
  if (operation.reconcilePending === true) {
    return { eligible: false, reason: "reconcile-pending", status };
  }
  const updatedAtMs = dateMs(operation.updatedAt);
  if (!updatedAtMs) {
    return { eligible: false, reason: "updated-at-invalid", status };
  }
  if (updatedAtMs > cutoff.getTime()) {
    return {
      eligible: false,
      reason: "within-retention",
      status,
      updatedAtMs
    };
  }
  return {
    eligible: true,
    reason: "eligible",
    status,
    updatedAtMs
  };
}

function text(value, maxLength = 80) {
  return String(value || "").trim().slice(0, maxLength);
}

function operationId(operation = {}) {
  return text(operation._id || operation.id, 180);
}

function sanitizeCleanupSummary(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const failureCodes = source.failureCodes && typeof source.failureCodes === "object"
    ? Object.keys(source.failureCodes).reduce((result, code) => {
        const safeCode = text(code, 80);
        if (!safeCode) return result;
        result[safeCode] = Math.max(0, Number(source.failureCodes[code]) || 0);
        return result;
      }, {})
    : {};
  return {
    source: text(source.source || "system", 20),
    retentionDays: boundedInteger(
      source.retentionDays,
      DEFAULT_RETENTION_DAYS,
      MIN_RETENTION_DAYS,
      MAX_RETENTION_DAYS
    ),
    batchSize: boundedInteger(
      source.batchSize,
      DEFAULT_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE
    ),
    cutoffAt: source.cutoffAt instanceof Date
      ? source.cutoffAt.toISOString()
      : text(source.cutoffAt, 40),
    scanned: Math.max(0, Number(source.scanned) || 0),
    removed: Math.max(0, Number(source.removed) || 0),
    skipped: Math.max(0, Number(source.skipped) || 0),
    failed: Math.max(0, Number(source.failed) || 0),
    unavailable: Boolean(source.unavailable),
    message: text(source.message, 160),
    failureCodes
  };
}

function requiredFunction(services, name) {
  const candidate = services && services[name];
  if (typeof candidate !== "function") {
    const error = new Error(`旧任务清理缺少依赖：${name}`);
    error.code = "generation-retention-dependency-missing";
    throw error;
  }
  return candidate;
}

function createGenerationOperationRetentionService(services = {}) {
  const listCandidates = requiredFunction(services, "listCandidates");
  const readOperation = requiredFunction(services, "readOperation");
  const removeOperation = requiredFunction(services, "removeOperation");
  const log = typeof services.log === "function" ? services.log : () => {};
  const now = typeof services.now === "function" ? services.now : () => new Date();

  async function cleanup(options = {}) {
    const settings = normalizeRetentionSettings(options);
    const currentTime = now();
    const cutoff = retentionCutoff(currentTime, settings);
    const source = text(options.source || "system", 20);
    const candidates = await listCandidates({
      statuses: TERMINAL_STATUSES.slice(),
      cutoff,
      batchSize: settings.batchSize
    });
    const unique = new Map();
    (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
      const id = operationId(candidate);
      if (id && !unique.has(id)) unique.set(id, candidate);
    });
    const selected = [...unique.values()]
      .sort((left, right) => dateMs(left.updatedAt) - dateMs(right.updatedAt))
      .slice(0, settings.batchSize);
    const summary = {
      source,
      retentionDays: settings.retentionDays,
      batchSize: settings.batchSize,
      cutoffAt: cutoff,
      scanned: 0,
      removed: 0,
      skipped: 0,
      failed: 0,
      unavailable: false,
      message: "",
      failureCodes: {}
    };

    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index];
      const id = operationId(candidate);
      summary.scanned += 1;
      try {
        const current = await readOperation(id);
        const decision = operationRetentionDecision(current || {}, {
          cutoff,
          settings
        });
        if (!current || !decision.eligible) {
          summary.skipped += 1;
          continue;
        }
        await removeOperation(id, current);
        summary.removed += 1;
      } catch (error) {
        const errorCode = text(
          error && error.code || "generation-history-cleanup-failed",
          80
        ) || "generation-history-cleanup-failed";
        summary.failed += 1;
        summary.failureCodes[errorCode] = (
          Number(summary.failureCodes[errorCode]) || 0
        ) + 1;
        log("warn", "generation.operation-history-cleanup-item-failed", {
          source,
          itemIndex: index,
          errorCode
        });
      }
    }

    const result = sanitizeCleanupSummary(summary);
    log("info", "generation.operation-history-cleanup", result);
    return result;
  }

  return Object.freeze({ cleanup });
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  TERMINAL_STATUSES,
  normalizeRetentionSettings,
  retentionCutoff,
  operationRetentionDecision,
  sanitizeCleanupSummary,
  createGenerationOperationRetentionService
};
