const STORAGE_KEY = "display-tool-diagnostic-session-v1";
const SCHEMA_VERSION = "1.0";
const MAX_ENTRIES = 300;
const DISPLAY_LIMIT = 50;
const MAX_TEXT_LENGTH = 4000;
const MAX_PROMPT_LENGTH = 20000;
const MAX_STACK_LENGTH = 6000;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const REMOTE_BATCH_SIZE = 20;
const REMOTE_FLUSH_DELAY_MS = 1500;

let currentState = null;
let remoteReporter = null;
let remoteContextProvider = null;
let remoteFlushTimer = null;
let remoteFlushPromise = null;

function getWx() {
  return typeof wx !== "undefined" ? wx : null;
}

function now() {
  return new Date().toISOString();
}

function createSessionId() {
  return `diag-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function basename(value) {
  const text = String(value || "");
  if (!text) return "";
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

function isSecretKey(key) {
  return /api.?key|secret|token|authorization|password|appsecret/i.test(String(key || ""));
}

function isBinaryKey(key) {
  return /base64|binary|buffer|imageData|videoData|fileContent/i.test(String(key || ""));
}

function isLocalPathKey(key) {
  return /^(filePath|tempFilePath|localPath|imagePath|videoPath|path)$/i.test(String(key || ""));
}

function textLimitForKey(key) {
  return /prompt/i.test(String(key || "")) ? MAX_PROMPT_LENGTH : MAX_TEXT_LENGTH;
}

function sanitize(value, key = "", depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (isSecretKey(key)) return "[redacted]";
  if (isBinaryKey(key)) return "[omitted]";
  if (isLocalPathKey(key) && typeof value === "string") {
    const name = basename(value);
    return name ? `[local]/${name}` : "";
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .slice(0, textLimitForKey(key));
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    Object.keys(value).slice(0, 100).forEach((childKey) => {
      result[childKey] = sanitize(value[childKey], childKey, depth + 1);
    });
    return result;
  }
  return String(value).slice(0, textLimitForKey(key));
}

function normalizeError(error) {
  if (!error) return null;
  if (typeof error === "string") {
    return { message: sanitize(error, "message") };
  }
  const payload = error.payload && typeof error.payload === "object"
    ? error.payload
    : {};
  const message = payload.message
    || payload.error
    || error.errMsg
    || error.message
    || String(error);
  const code = payload.errorCode
    || payload.code
    || error.errCode
    || error.code
    || "";
  return {
    name: sanitize(error.name || "", "name"),
    message: sanitize(message, "message"),
    code: sanitize(code, "code"),
    requestId: sanitize(payload.requestId || error.requestId || "", "requestId"),
    stack: sanitize(error.stack || "", "stack").slice(0, MAX_STACK_LENGTH),
    payload: sanitize(payload, "payload")
  };
}

function getCurrentRoute() {
  try {
    if (typeof getCurrentPages !== "function") return "";
    const pages = getCurrentPages();
    const page = pages && pages[pages.length - 1];
    return String(page && (page.route || page.__route__) || "");
  } catch (_) {
    return "";
  }
}

function getPageStack() {
  try {
    if (typeof getCurrentPages !== "function") return [];
    return (getCurrentPages() || []).map((page) => String(
      page && (page.route || page.__route__) || ""
    )).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function persist() {
  const api = getWx();
  if (!api || typeof api.setStorageSync !== "function" || !currentState) return;
  try {
    api.setStorageSync(STORAGE_KEY, currentState);
  } catch (error) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[diagnostic-log] 写入失败", error);
    }
  }
}

function eventTimeMs(event) {
  const value = event && event.time;
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function pruneExpiredState(state, nowMs = Date.now()) {
  if (!state || typeof state !== "object") return state;
  const cutoff = Number(nowMs) - RETENTION_MS;
  const events = (Array.isArray(state.events) ? state.events : [])
    .filter((event) => {
      const timestamp = eventTimeMs(event);
      return timestamp === null || timestamp > cutoff;
    })
    .slice(-MAX_ENTRIES);
  const activeIds = new Set(events.map((event) => event && event.eventId).filter(Boolean));
  state.events = events;
  state.pendingUploadIds = (Array.isArray(state.pendingUploadIds)
    ? state.pendingUploadIds
    : [])
    .filter((eventId) => activeIds.has(eventId));
  return state;
}

function loadPersisted() {
  const api = getWx();
  if (!api || typeof api.getStorageSync !== "function") return null;
  try {
    const value = api.getStorageSync(STORAGE_KEY);
    if (
      value
      && typeof value === "object"
      && value.session
      && Array.isArray(value.events)
    ) {
      const before = value.events.length;
      const normalized = pruneExpiredState(value);
      if (before !== normalized.events.length && typeof api.setStorageSync === "function") {
        api.setStorageSync(STORAGE_KEY, normalized);
      }
      return normalized;
    }
  } catch (error) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[diagnostic-log] 读取失败", error);
    }
  }
  return null;
}

function createState(context = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    session: {
      id: createSessionId(),
      startedAt: now(),
      reason: String(context.reason || "app-launch")
    },
    context: sanitize(context, "context"),
    sequence: 0,
    events: [],
    pendingUploadIds: []
  };
}

function ensureState() {
  if (currentState) return currentState;
  currentState = pruneExpiredState(
    loadPersisted() || createState({ reason: "implicit" })
  );
  persist();
  return currentState;
}

function startSession(context = {}) {
  const previous = pruneExpiredState(loadPersisted());
  currentState = createState(context);
  if (previous) {
    currentState.events = previous.events.slice(-MAX_ENTRIES);
    currentState.pendingUploadIds = previous.pendingUploadIds.slice();
  }
  persist();
  scheduleRemoteFlush(100);
  return Object.assign({}, currentState.session);
}

function remoteEvent(record) {
  if (!record || typeof record !== "object") return null;
  return {
    eventId: String(record.eventId || ""),
    sessionId: String(record.sessionId || ""),
    sequence: Number(record.sequence) || 0,
    time: String(record.time || ""),
    level: String(record.level || "info"),
    category: String(record.category || "app"),
    event: String(record.event || "unknown"),
    message: sanitize(record.message || "", "message"),
    route: String(record.route || ""),
    step: String(record.step || ""),
    requestId: String(record.requestId || ""),
    code: String(record.code || ""),
    durationMs: Number.isFinite(Number(record.durationMs))
      ? Number(record.durationMs)
      : null,
    error: sanitize(record.error, "error"),
    details: sanitize(record.details, "details")
  };
}

function scheduleRemoteFlush(delayMs = REMOTE_FLUSH_DELAY_MS) {
  if (!remoteReporter || remoteFlushTimer || remoteFlushPromise) return;
  remoteFlushTimer = setTimeout(() => {
    remoteFlushTimer = null;
    flushRemote();
  }, Math.max(0, Number(delayMs) || 0));
}

function configureRemoteReporting(options = {}) {
  remoteReporter = typeof options.reporter === "function" ? options.reporter : null;
  remoteContextProvider = typeof options.contextProvider === "function"
    ? options.contextProvider
    : null;
  if (remoteReporter) scheduleRemoteFlush(100);
}

function flushRemote() {
  if (!remoteReporter) {
    return Promise.resolve({ ok: false, skipped: true, reason: "reporter-unavailable" });
  }
  if (remoteFlushTimer) {
    clearTimeout(remoteFlushTimer);
    remoteFlushTimer = null;
  }
  if (remoteFlushPromise) return remoteFlushPromise;
  const state = pruneExpiredState(ensureState());
  const pendingIds = state.pendingUploadIds.slice(0, REMOTE_BATCH_SIZE);
  if (!pendingIds.length) {
    persist();
    return Promise.resolve({ ok: true, skipped: true, uploaded: 0 });
  }
  const pendingSet = new Set(pendingIds);
  const events = state.events
    .filter((event) => pendingSet.has(event.eventId))
    .map(remoteEvent)
    .filter(Boolean);
  if (!events.length) {
    state.pendingUploadIds = state.pendingUploadIds.filter((eventId) => !pendingSet.has(eventId));
    persist();
    return Promise.resolve({ ok: true, skipped: true, uploaded: 0 });
  }
  const context = remoteContextProvider
    ? sanitize(remoteContextProvider() || {}, "remoteContext")
    : {};
  remoteFlushPromise = Promise.resolve(remoteReporter({
    schemaVersion: SCHEMA_VERSION,
    appVersion: String(context.appVersion || state.context.appVersion || ""),
    session: Object.assign({}, state.session),
    events
  })).then((result) => {
    if (!result || result.ok === false || result.unavailable) {
      throw new Error(result && result.message || "日志上传暂时不可用");
    }
    const latest = ensureState();
    latest.pendingUploadIds = latest.pendingUploadIds.filter(
      (eventId) => !pendingSet.has(eventId)
    );
    pruneExpiredState(latest);
    persist();
    return {
      ok: true,
      uploaded: events.length,
      accepted: Number(result.accepted) || events.length
    };
  }).catch((error) => {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[diagnostic-log] 云端上报失败，稍后重试", error);
    }
    return { ok: false, uploaded: 0, error };
  }).finally(() => {
    remoteFlushPromise = null;
    if (ensureState().pendingUploadIds.length) scheduleRemoteFlush(5000);
  });
  return remoteFlushPromise;
}

function append(level, category, event, message, fields = {}) {
  const state = pruneExpiredState(ensureState());
  const error = normalizeError(fields.error);
  const requestId = fields.requestId
    || (error && error.requestId)
    || "";
  const code = fields.code
    || fields.errorCode
    || (error && error.code)
    || "";
  const durationValue = Number(fields.durationMs);
  const standardKeys = new Set([
    "route",
    "step",
    "stage",
    "requestId",
    "code",
    "errorCode",
    "durationMs",
    "error"
  ]);
  const details = {};
  Object.keys(fields || {}).forEach((key) => {
    if (!standardKeys.has(key)) details[key] = fields[key];
  });
  state.sequence += 1;
  const eventId = `${state.session.id}-${state.sequence}`;
  const record = {
    eventId,
    sessionId: state.session.id,
    sequence: state.sequence,
    time: now(),
    level: String(level || "info"),
    category: String(category || "app"),
    event: String(event || "unknown"),
    message: String(message || ""),
    route: String(fields.route || getCurrentRoute()),
    step: String(fields.step || fields.stage || ""),
    requestId: String(requestId || ""),
    code: String(code || ""),
    durationMs: Number.isFinite(durationValue) ? durationValue : null,
    error,
    details: sanitize(details, "details")
  };
  state.events = state.events.concat(record).slice(-MAX_ENTRIES);
  state.pendingUploadIds = state.pendingUploadIds.concat(eventId).slice(-MAX_ENTRIES);
  persist();
  scheduleRemoteFlush();
  return record;
}

function info(category, event, message, fields) {
  return append("info", category, event, message, fields);
}

function warn(category, event, message, fields) {
  return append("warn", category, event, message, fields);
}

function error(category, event, message, fields) {
  return append("error", category, event, message, fields);
}

function read(options = {}) {
  const state = pruneExpiredState(ensureState());
  persist();
  const events = state.events.slice();
  const filtered = options.category
    ? events.filter((item) => item.category === options.category)
    : events;
  const ordered = options.newestFirst ? filtered.reverse() : filtered;
  const limit = Number(options.limit);
  return Number.isFinite(limit) && limit >= 0
    ? ordered.slice(0, limit)
    : ordered;
}

function getStats() {
  const state = pruneExpiredState(ensureState());
  persist();
  const stats = {
    eventCount: state.events.length,
    errorCount: 0,
    warnCount: 0,
    infoCount: 0,
    categories: {}
  };
  state.events.forEach((item) => {
    const levelKey = `${item.level}Count`;
    if (Object.prototype.hasOwnProperty.call(stats, levelKey)) stats[levelKey] += 1;
    stats.categories[item.category] = (stats.categories[item.category] || 0) + 1;
  });
  return stats;
}

function getSession() {
  return Object.assign({}, ensureState().session);
}

function clear() {
  const state = ensureState();
  state.events = [];
  state.pendingUploadIds = [];
  state.sequence = 0;
  state.session.clearedAt = now();
  persist();
}

function getSystemInfo() {
  const api = getWx();
  if (!api || typeof api.getSystemInfoSync !== "function") return {};
  try {
    return sanitize(api.getSystemInfoSync(), "systemInfo");
  } catch (_) {
    return {};
  }
}

function getAccountInfo() {
  const api = getWx();
  if (!api || typeof api.getAccountInfoSync !== "function") return {};
  try {
    return sanitize(api.getAccountInfoSync(), "accountInfo");
  } catch (_) {
    return {};
  }
}

function getNetworkInfo() {
  const api = getWx();
  if (!api || typeof api.getNetworkType !== "function") {
    return Promise.resolve({ networkType: "unknown" });
  }
  return new Promise((resolve) => {
    try {
      api.getNetworkType({
        success: (result) => resolve(sanitize(result, "network")),
        fail: (networkError) => resolve({
          networkType: "unknown",
          error: normalizeError(networkError)
        })
      });
    } catch (networkError) {
      resolve({
        networkType: "unknown",
        error: normalizeError(networkError)
      });
    }
  });
}

async function buildReport(context = {}) {
  const state = pruneExpiredState(ensureState());
  persist();
  const network = await getNetworkInfo();
  const accountInfo = getAccountInfo();
  const miniProgram = accountInfo.miniProgram || {};
  const plugin = accountInfo.plugin || {};
  return {
    schemaVersion: SCHEMA_VERSION,
    copiedAt: now(),
    session: Object.assign({}, state.session),
    app: {
      appVersion: String(context.appVersion || state.context.appVersion || ""),
      cloudEnvId: String(context.cloudEnvId || ""),
      cloudFunctionName: String(context.cloudFunctionName || ""),
      envVersion: String(miniProgram.envVersion || ""),
      miniProgramVersion: String(miniProgram.version || ""),
      pluginVersion: String(plugin.version || "")
    },
    device: getSystemInfo(),
    runtime: {
      cloudReady: Boolean(context.cloudReady),
      currentRoute: getCurrentRoute(),
      pageStack: getPageStack(),
      network
    },
    summary: getStats(),
    projectSnapshot: sanitize(context.projectSnapshot || {}, "projectSnapshot"),
    events: state.events.slice()
  };
}

module.exports = {
  STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_ENTRIES,
  DISPLAY_LIMIT,
  RETENTION_MS,
  startSession,
  info,
  warn,
  error,
  read,
  clear,
  getStats,
  getSession,
  buildReport,
  configureRemoteReporting,
  flushRemote,
  pruneExpiredState,
  sanitize,
  normalizeError
};
