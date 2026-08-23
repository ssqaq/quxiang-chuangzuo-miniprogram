const STORAGE_KEY = "display-tool-diagnostic-session-v1";
const SCHEMA_VERSION = "1.0";
const MAX_ENTRIES = 300;
const DISPLAY_LIMIT = 50;
const MAX_TEXT_LENGTH = 4000;
const MAX_PROMPT_LENGTH = 20000;
const MAX_STACK_LENGTH = 6000;

let currentState = null;

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
      return value;
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
    events: []
  };
}

function ensureState() {
  if (currentState) return currentState;
  currentState = loadPersisted() || createState({ reason: "implicit" });
  persist();
  return currentState;
}

function startSession(context = {}) {
  const api = getWx();
  if (api && typeof api.removeStorageSync === "function") {
    try {
      api.removeStorageSync(STORAGE_KEY);
    } catch (error) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[diagnostic-log] 清理旧会话失败", error);
      }
    }
  }
  currentState = createState(context);
  persist();
  return Object.assign({}, currentState.session);
}

function append(level, category, event, message, fields = {}) {
  const state = ensureState();
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
  const record = {
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
  persist();
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
  const events = ensureState().events.slice();
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
  const state = ensureState();
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
  const state = ensureState();
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
  startSession,
  info,
  warn,
  error,
  read,
  clear,
  getStats,
  getSession,
  buildReport,
  sanitize,
  normalizeError
};
