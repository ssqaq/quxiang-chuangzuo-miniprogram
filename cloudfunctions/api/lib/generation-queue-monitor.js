const {
  STATUSES,
  normalizeStatus,
  sanitizeHistory
} = require("./generation-state-machine");

const DEFAULT_QUEUE_SETTINGS = Object.freeze({
  workerConcurrency: 1,
  alertThreshold: 5,
  alertCooldownMinutes: 10
});

function text(value, maxLength = 120) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .slice(0, maxLength);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function normalizeQueueSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    workerConcurrency: boundedInteger(
      source.workerConcurrency,
      DEFAULT_QUEUE_SETTINGS.workerConcurrency,
      1,
      4
    ),
    alertThreshold: boundedInteger(
      source.alertThreshold,
      DEFAULT_QUEUE_SETTINGS.alertThreshold,
      1,
      100
    ),
    alertCooldownMinutes: boundedInteger(
      source.alertCooldownMinutes,
      DEFAULT_QUEUE_SETTINGS.alertCooldownMinutes,
      1,
      60
    )
  };
}

function dateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    try {
      return value.toDate().getTime();
    } catch (error) {
      return 0;
    }
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value) {
  const milliseconds = dateMs(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : "";
}

function ageSeconds(value, now = new Date()) {
  const milliseconds = dateMs(value);
  if (!milliseconds) return 0;
  return Math.max(0, Math.floor((now.getTime() - milliseconds) / 1000));
}

function maskedRequestId(value) {
  const requestId = text(value, 120);
  if (!requestId) return "";
  if (requestId.length <= 8) return `…${requestId.slice(-4)}`;
  return `…${requestId.slice(-6)}`;
}

function safeKind(value) {
  return text(value, 20).toLowerCase() === "video" ? "video" : "image";
}

function safeError(value) {
  const source = value && typeof value === "object"
    ? value
    : value
      ? { message: value }
      : {};
  return {
    code: text(source.code, 80),
    message: text(source.message, 160),
    retryable: Boolean(source.retryable)
  };
}

function buildAdminOperationSummary(operation = {}, options = {}) {
  const source = operation && typeof operation === "object" ? operation : {};
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now());
  const status = normalizeStatus(source.status, "failed");
  const createdAt = source.createdAt || source.queuedAt || source.updatedAt;
  const updatedAt = source.updatedAt || source.lastHeartbeatAt || createdAt;
  return {
    operationId: text(source._id || source.id, 160),
    requestId: maskedRequestId(source.requestId),
    userHash: text(source.userHash, 40),
    kind: safeKind(source.kind),
    status,
    stage: text(source.pipelineStage || status, 40),
    progress: Math.max(0, Math.min(100, Math.round(Number(source.progress) || 0))),
    attemptCount: Math.max(0, Math.round(Number(source.attemptCount) || 0)),
    error: safeError(source.lastError),
    refundPending: Boolean(source.refundPending),
    cleanupPending: Boolean(source.cleanupPending),
    createdAt: isoDate(createdAt),
    updatedAt: isoDate(updatedAt),
    ageSeconds: ageSeconds(createdAt, now),
    idleSeconds: ageSeconds(updatedAt, now)
  };
}

function buildAdminOperationHistory(operation = {}, options = {}) {
  const source = operation && typeof operation === "object" ? operation : {};
  return {
    task: buildAdminOperationSummary(source, options),
    billing: {
      source: text(source.billing && source.billing.source, 40),
      reserved: Boolean(
        source.billing
        && (source.billing.reserved || source.billing.pointsCharged)
      ),
      refunded: Boolean(
        source.billing
        && (source.billing.refunded || source.billing.refundedAt)
      ),
      refundPending: Boolean(source.refundPending)
    },
    history: sanitizeHistory(source.stageHistory).map((entry) => ({
      at: isoDate(entry.at),
      fromStatus: entry.fromStatus,
      status: entry.status,
      stage: entry.stage,
      progress: entry.progress,
      attemptCount: entry.attemptCount,
      actor: entry.actor,
      code: entry.code
    }))
  };
}

function emptyCounts() {
  return STATUSES.reduce((result, status) => {
    result[status] = 0;
    return result;
  }, {});
}

function buildQueueSnapshot(operations = [], options = {}) {
  const rows = Array.isArray(operations) ? operations : [];
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now());
  const settings = normalizeQueueSettings(options.settings);
  const counts = emptyCounts();
  const kinds = { image: 0, video: 0 };
  let oldestQueuedAtMs = 0;
  rows.forEach((operation) => {
    const status = normalizeStatus(operation && operation.status, "");
    if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
    kinds[safeKind(operation && operation.kind)] += 1;
    if (status === "queued") {
      const queuedAt = dateMs(
        operation && (
          operation.queuedAt
          || operation.createdAt
          || operation.updatedAt
        )
      );
      if (queuedAt && (!oldestQueuedAtMs || queuedAt < oldestQueuedAtMs)) {
        oldestQueuedAtMs = queuedAt;
      }
    }
  });
  const queuedCount = counts.queued;
  return {
    generatedAt: now.toISOString(),
    total: rows.length,
    counts,
    kinds,
    queuedCount,
    processingCount: counts.processing,
    pendingRefundCount: counts.failed + counts.refunding,
    oldestQueuedAt: oldestQueuedAtMs
      ? new Date(oldestQueuedAtMs).toISOString()
      : "",
    oldestQueuedAgeSeconds: oldestQueuedAtMs
      ? Math.max(0, Math.floor((now.getTime() - oldestQueuedAtMs) / 1000))
      : 0,
    workerConcurrency: settings.workerConcurrency,
    alertThreshold: settings.alertThreshold,
    alertCooldownMinutes: settings.alertCooldownMinutes,
    alertActive: queuedCount >= settings.alertThreshold
  };
}

function normalizeAlertState(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    active: Boolean(source.active),
    signature: text(source.signature, 160),
    lastAlertAt: isoDate(source.lastAlertAt),
    lastRecoveredAt: isoDate(source.lastRecoveredAt)
  };
}

function alertSignature(snapshot = {}) {
  return [
    Math.max(0, Number(snapshot.queuedCount) || 0),
    Math.max(0, Number(snapshot.processingCount) || 0),
    Math.max(1, Number(snapshot.alertThreshold) || 1),
    Math.max(1, Number(snapshot.workerConcurrency) || 1)
  ].join(":");
}

function decideQueueAlert(snapshot = {}, previousState = {}, options = {}) {
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now());
  const previous = normalizeAlertState(previousState);
  const active = Boolean(snapshot.alertActive);
  const signature = alertSignature(snapshot);
  const cooldownMs = Math.max(
    1,
    Number(snapshot.alertCooldownMinutes)
      || DEFAULT_QUEUE_SETTINGS.alertCooldownMinutes
  ) * 60 * 1000;
  const lastAlertMs = dateMs(previous.lastAlertAt);

  if (active) {
    const coolingDown = previous.active
      && lastAlertMs > 0
      && now.getTime() - lastAlertMs < cooldownMs;
    if (coolingDown) {
      return {
        action: "hold",
        shouldLog: false,
        nextState: Object.assign({}, previous, {
          active: true,
          signature
        })
      };
    }
    return {
      action: "alert",
      shouldLog: true,
      nextState: Object.assign({}, previous, {
        active: true,
        signature,
        lastAlertAt: now.toISOString()
      })
    };
  }

  if (previous.active) {
    return {
      action: "recovered",
      shouldLog: true,
      nextState: Object.assign({}, previous, {
        active: false,
        signature,
        lastRecoveredAt: now.toISOString()
      })
    };
  }

  return {
    action: "idle",
    shouldLog: false,
    nextState: Object.assign({}, previous, {
      active: false,
      signature
    })
  };
}

module.exports = {
  DEFAULT_QUEUE_SETTINGS,
  normalizeQueueSettings,
  buildQueueSnapshot,
  buildAdminOperationSummary,
  buildAdminOperationHistory,
  decideQueueAlert
};
