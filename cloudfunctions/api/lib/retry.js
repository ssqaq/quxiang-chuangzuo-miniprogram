const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "true" : "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function retryAfterMs(headers) {
  const raw = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30000, seconds * 1000));
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(30000, timestamp - Date.now())) : 0;
}

function delayMs(attempt, retryAfter = 0) {
  if (retryAfter > 0) return retryAfter;
  const base = Math.min(10000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
  return base + Math.floor(Math.random() * 200);
}

function shouldRetryStatus(status) {
  return DEFAULT_RETRY_STATUSES.has(Number(status));
}

function maxRetries() {
  return Math.max(0, Math.min(5, Number(env("AI_MAX_RETRIES", "2")) || 0));
}

function imageRetryEnabled() {
  return boolEnv("AI_IMAGE_RETRY_ENABLED", false);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation(operation, options = {}) {
  const attemptsAllowed = Math.max(1, Number(options.maxAttempts) || maxRetries() + 1);
  const canRetry = options.allowRetry !== false;
  let attempt = 0;
  let lastError = null;
  while (attempt < attemptsAllowed) {
    attempt += 1;
    try {
      const value = await operation(attempt);
      return { value, attempt };
    } catch (error) {
      lastError = error;
      const status = Number(error && error.status) || 0;
      const retryable = error && error.retryable !== undefined
        ? Boolean(error.retryable)
        : shouldRetryStatus(status);
      if (!canRetry || !retryable || attempt >= attemptsAllowed) break;
      await sleep(delayMs(attempt, retryAfterMs(error && error.headers)));
    }
  }
  if (lastError) {
    lastError.attempts = attempt;
    if (attempt >= attemptsAllowed && attemptsAllowed > 1) lastError.code = "retry-exhausted";
    throw lastError;
  }
  throw new Error("重试操作没有返回结果。");
}

module.exports = {
  DEFAULT_RETRY_STATUSES,
  boolEnv,
  delayMs,
  env,
  imageRetryEnabled,
  maxRetries,
  retryAfterMs,
  retryOperation,
  shouldRetryStatus,
  sleep
};
