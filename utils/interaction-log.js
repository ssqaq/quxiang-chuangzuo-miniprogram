const diagnosticLog = require("./diagnostic-log");

function read() {
  return diagnosticLog.read({ category: "navigation" });
}

function append(entry = {}) {
  const method = entry.error ? diagnosticLog.error : diagnosticLog.info;
  return method("navigation", entry.event, entry.message, {
    route: entry.route,
    durationMs: entry.durationMs,
    error: entry.error
  });
}

function clear() {
  diagnosticLog.clear();
}

async function format(logs, appVersion) {
  const report = await diagnosticLog.buildReport({ appVersion });
  return JSON.stringify(report, null, 2);
}

module.exports = {
  MAX_ENTRIES: diagnosticLog.MAX_ENTRIES,
  read,
  append,
  clear,
  format
};
