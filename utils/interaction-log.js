const STORAGE_KEY = "display-tool-interaction-log-v1";
const MAX_ENTRIES = 80;

function read() {
  try {
    const value = wx.getStorageSync(STORAGE_KEY);
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.warn("[interaction-log] 读取失败", error);
    return [];
  }
}

function normalizeError(error) {
  if (!error) return "";
  if (typeof error === "string") return error.slice(0, 1000);
  if (error.errMsg) return String(error.errMsg).slice(0, 1000);
  if (error.message) return String(error.message).slice(0, 1000);
  try {
    return JSON.stringify(error).slice(0, 1000);
  } catch (serializeError) {
    return String(error).slice(0, 1000);
  }
}

function append(entry = {}) {
  const record = {
    time: entry.time || new Date().toISOString(),
    event: String(entry.event || "unknown"),
    message: String(entry.message || ""),
    route: String(entry.route || ""),
    durationMs: Number.isFinite(Number(entry.durationMs))
      ? Number(entry.durationMs)
      : null,
    error: normalizeError(entry.error)
  };
  const next = read().concat(record).slice(-MAX_ENTRIES);
  try {
    wx.setStorageSync(STORAGE_KEY, next);
  } catch (error) {
    console.warn("[interaction-log] 写入失败", error);
  }
  console.info("[interaction]", record);
  return record;
}

function clear() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (error) {
    console.warn("[interaction-log] 清空失败", error);
  }
}

function format(logs, appVersion) {
  return JSON.stringify(
    {
      appVersion: String(appVersion || ""),
      copiedAt: new Date().toISOString(),
      logs: Array.isArray(logs) ? logs : read()
    },
    null,
    2
  );
}

module.exports = {
  MAX_ENTRIES,
  read,
  append,
  clear,
  format
};
