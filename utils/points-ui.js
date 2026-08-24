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

function formatPromoDate(dateKey) {
  const value = String(dateKey || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  return `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

function formatPromoRange(startDate, endDate) {
  const start = formatPromoDate(startDate);
  const end = formatPromoDate(endDate);
  if (start && end) return start === end ? start : `${start}-${end}`;
  return start || end;
}

function buildPromoLabel(startDate, endDate) {
  const range = formatPromoRange(startDate, endDate);
  return `${range ? `${range}` : ""}活动期间限时全功能不扣积分`;
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  promoEndAtMs,
  getPromoRefreshDelay,
  formatPromoDate,
  formatPromoRange,
  buildPromoLabel
};
