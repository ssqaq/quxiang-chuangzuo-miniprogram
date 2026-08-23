const MAX_TIMER_DELAY_MS = 0x7fffffff;

function promoEndAtMs(dateKey) {
  const value = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 0;
  const timestamp = Date.parse(`${value}T23:59:59.999+08:00`);
  return Number.isFinite(timestamp) ? timestamp + 1 : 0;
}

function getPromoRefreshDelay(dateKey, nowMs = Date.now()) {
  const endAt = promoEndAtMs(dateKey);
  if (!endAt) return 0;
  return Math.max(0, endAt - Number(nowMs || 0));
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  promoEndAtMs,
  getPromoRefreshDelay
};
