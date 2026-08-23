const crypto = require("crypto");

function createRequestId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
  } catch (_) {
    return "";
  }
}

function sanitize(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    Object.keys(value).slice(0, 40).forEach((key) => {
      if (/key|secret|token|authorization|password/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = sanitize(value[key], depth + 1);
      }
    });
    return result;
  }
  return value;
}

function log(level, event, fields = {}) {
  const payload = Object.assign({
    component: "wechat-miniapp-api",
    event,
    time: new Date().toISOString()
  }, sanitize(fields));
  const line = JSON.stringify(payload);
  if (level === "error" && console.error) console.error(line);
  else if (level === "warn" && console.warn) console.warn(line);
  else if (console.info) console.info(line);
  else console.log(line);
}

module.exports = {
  createRequestId,
  safeUrl,
  sanitize,
  log
};
