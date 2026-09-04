const RECHARGE_PACKAGES = Object.freeze([
  Object.freeze({
    productId: "pkg_990",
    amountFen: 990,
    amountText: "¥9.9",
    grantPoints: 100
  }),
  Object.freeze({
    productId: "pkg_2990",
    amountFen: 2990,
    amountText: "¥29.9",
    grantPoints: 330
  }),
  Object.freeze({
    productId: "pkg_5990",
    amountFen: 5990,
    amountText: "¥59.9",
    grantPoints: 688
  })
]);

const ACCOUNT_SERVICE_NOT_READY_MESSAGE = "账户服务尚未启用，请稍后再试。";
const ACCOUNT_NETWORK_ERROR_MESSAGE = "网络不稳定，请稍后重试。";

const ACCOUNT_ERROR_MESSAGES = Object.freeze({
  ACCOUNT_SERVICE_NOT_DEPLOYED: ACCOUNT_SERVICE_NOT_READY_MESSAGE,
  FUNCTION_NOT_FOUND: ACCOUNT_SERVICE_NOT_READY_MESSAGE,
  ACCOUNT_POINTS_FALLBACK_UNAVAILABLE: "积分账户读取失败，请稍后重试。",
  ACCOUNT_RECORDS_PAGINATION_UNAVAILABLE: "积分记录暂不支持翻页，请稍后重试。",
  PAYMENT_ORDER_CREATION_DISABLED: "充值服务暂未开放。",
  PAYMENT_RECHARGE_DISABLED: "充值服务暂未开放。",
  PAYMENT_RECORD_CURSOR_INVALID: "收支记录已更新，请重新加载。",
  PAYMENT_RECORD_CURSOR_MISSING: "收支记录已更新，请重新加载。"
});

function accountErrorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const payload = error.payload && typeof error.payload === "object" ? error.payload : {};
  return [
    error.message,
    error.errMsg,
    error.error,
    payload.message,
    payload.errMsg,
    payload.error
  ].map((value) => String(value || "").trim())
    .filter((value, index, list) => value && list.indexOf(value) === index)
    .join(" ");
}

function accountErrorCode(error) {
  const payload = error && error.payload && typeof error.payload === "object"
    ? error.payload
    : {};
  const explicit = String(
    error && (error.errorCode || error.code || error.errCode)
    || payload.errorCode
    || payload.code
    || payload.errCode
    || ""
  ).trim().toUpperCase();
  const text = accountErrorText(error);
  if (
    explicit === "-501000"
    || /FUNCTION_NOT_FOUND|FUNCTIONNAME\s+PARAMETER\s+COULD\s+NOT\s+BE\s+FOUND|-501000/i.test(text)
  ) {
    return "ACCOUNT_SERVICE_NOT_DEPLOYED";
  }
  if (/NETWORK|TIMEOUT|REQUEST:FAIL|ECONN|ETIMEDOUT/i.test(`${explicit} ${text}`)) {
    return "ACCOUNT_NETWORK_ERROR";
  }
  return explicit || "ACCOUNT_REQUEST_FAILED";
}

function safeTrustedPublicMessage(error) {
  const text = accountErrorText(error);
  if (
    !text
    || text.length > 80
    || /[\r\n]/.test(text)
    || !/[\u3400-\u9fff]/.test(text)
    || /HTTPS?:\/\/|CLOUD|FUNCTION|DATABASE|COLLECTION|ERR(?:CODE|MSG)|SYSTEM\s+ERROR|\bABORT\b|\bSTACK\b|SECRET|TOKEN|API[_ -]?KEY/i.test(text)
  ) {
    return "";
  }
  return text;
}

function userErrorMessage(error, fallback = "服务暂时不可用，请稍后重试。", options = {}) {
  const safeFallback = String(fallback || "服务暂时不可用，请稍后重试。").trim()
    || "服务暂时不可用，请稍后重试。";
  const code = accountErrorCode(error);
  if (ACCOUNT_ERROR_MESSAGES[code]) return ACCOUNT_ERROR_MESSAGES[code];
  if (code === "ACCOUNT_NETWORK_ERROR") return ACCOUNT_NETWORK_ERROR_MESSAGE;
  if (options.trustedPublic === true || error && error.userSafe === true) {
    return safeTrustedPublicMessage(error) || safeFallback;
  }
  return safeFallback;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function expandScientificNotation(value) {
  const match = String(value).match(/^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/);
  if (!match) return String(value);
  const exponent = Number(match[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) return null;
  const digits = `${match[2]}${match[3] || ""}`;
  const point = match[2].length + exponent;
  if (point <= 0) return `${match[1]}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${match[1]}${digits}${"0".repeat(point - digits.length)}`;
  return `${match[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function normalizeDecimalText(value, maxFractionDigits = 1) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  if (!text) return null;
  if (/e/i.test(text)) text = expandScientificNotation(text);
  if (!text || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;

  const negative = text[0] === "-";
  const unsigned = text[0] === "+" || text[0] === "-" ? text.slice(1) : text;
  const split = unsigned.split(".");
  const whole = (split[0] || "0").replace(/^0+(?=\d)/, "") || "0";
  const fraction = (split[1] || "").slice(0, maxFractionDigits).replace(/0+$/, "");
  const isZero = whole === "0" && !fraction;
  return `${negative && !isZero ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatPoints(value, options = {}) {
  const maxFractionDigits = Number.isInteger(options.maxFractionDigits)
    ? Math.max(0, options.maxFractionDigits)
    : 1;
  const normalized = normalizeDecimalText(value, maxFractionDigits);
  if (normalized === null) {
    return options.fallback === undefined ? "--" : String(options.fallback);
  }
  const negative = normalized[0] === "-";
  const unsigned = negative ? normalized.slice(1) : normalized;
  const split = unsigned.split(".");
  const groupedWhole = split[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const magnitude = `${groupedWhole}${split[1] ? `.${split[1]}` : ""}`;
  if (negative) return `-${magnitude}`;
  return options.signed && magnitude !== "0" ? `+${magnitude}` : magnitude;
}

function formatInteger(value) {
  return formatPoints(value, { fallback: "0" });
}

function formatMoney(amountFen) {
  const amount = Math.max(0, Math.round(safeNumber(amountFen))) / 100;
  return `¥${amount.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if (typeof value.toDate === "function") return value.toDate();
    if (value.$date) return new Date(value.$date);
    if (value.seconds !== undefined) return new Date(safeNumber(value.seconds) * 1000);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "刚刚";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeProfile(result = {}) {
  const source = result && result.profile && typeof result.profile === "object"
    ? result.profile
    : result && typeof result === "object"
      ? result
      : {};
  return {
    completed: Boolean(result && result.completed || source.completed),
    nickname: String(source.nickname || "微信用户").trim() || "微信用户",
    avatarPath: String(source.avatarUrl || source.avatarFileID || source.avatarPath || "").trim()
  };
}

function normalizeAccount(source = {}) {
  const account = source && source.account && typeof source.account === "object"
    ? source.account
    : source && typeof source === "object"
      ? source
      : {};
  const totalPurchasedPoints = Math.max(
    0,
    safeNumber(account.totalPurchasedPoints, safeNumber(account.totalRecharged))
  );
  return {
    pointsBalance: Math.max(0, safeNumber(account.pointsBalance)),
    pointsBalanceText: formatPoints(account.pointsBalance, { fallback: "0" }),
    totalPurchasedPoints,
    totalPurchasedPointsText: formatPoints(totalPurchasedPoints, { fallback: "0" }),
    totalReversedPurchasedPoints: Math.max(0, safeNumber(account.totalReversedPurchasedPoints))
  };
}

function recordKind(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "recharge") return "recharge";
  if (value === "spend" || value === "consume") return "spend";
  if (value === "refund" || value === "payment-reversal") return "refund";
  if (value === "checkin" || value === "check-in") return "checkin";
  if (value === "daily-free" || value === "promo-free") return "free";
  if (value === "purchase") return "legacy-income";
  return "unknown";
}

function recordMeta(kind) {
  const map = {
    recharge: { icon: "充", label: "积分充值", tone: "recharge" },
    spend: { icon: "消", label: "积分消费", tone: "spend" },
    refund: { icon: "退", label: "积分退回", tone: "refund" },
    checkin: { icon: "签", label: "签到奖励", tone: "checkin" },
    "legacy-income": { icon: "得", label: "历史积分收入", tone: "income" },
    free: { icon: "免", label: "免费次数", tone: "free" },
    unknown: { icon: "变", label: "积分变动", tone: "neutral" }
  };
  return map[kind] || map.unknown;
}

function normalizeRecord(item = {}, index = 0) {
  const amount = safeNumber(
    item.amount !== undefined ? item.amount
      : item.delta !== undefined ? item.delta
        : item.points
  );
  const kind = recordKind(item.type || item.kind || item.category);
  const meta = recordMeta(kind);
  const id = item.id || item._id || item.requestId || item.orderNo || `account-record-${index}`;
  return {
    id: String(id),
    type: kind,
    icon: meta.icon,
    typeLabel: meta.label,
    tone: meta.tone,
    description: String(item.description || item.title || meta.label),
    createdAt: formatDateTime(item.createdAt || item.updatedAt),
    amount,
    amountText: kind === "free" && amount === 0
      ? "免费"
      : formatPoints(amount, { signed: true, fallback: "0" }),
    balanceAfterText: item.balanceAfter === undefined || item.balanceAfter === null
      ? ""
      : `余额 ${formatPoints(item.balanceAfter, { fallback: "0" })}`
  };
}

function normalizeRecords(items) {
  return (Array.isArray(items) ? items : []).map(normalizeRecord);
}

function normalizeChannels(channels) {
  if (Array.isArray(channels)) {
    return channels
      .map((item) => typeof item === "string" ? item : item && (item.id || item.channel || item.provider))
      .map((item) => String(item || "").toLowerCase())
      .filter((item, index, list) => item === "wxpay" && list.indexOf(item) === index);
  }
  if (channels && typeof channels === "object") {
    return Object.keys(channels).filter((key) => key === "wxpay" && Boolean(channels[key]));
  }
  return [];
}

function normalizeProducts(products) {
  const available = Array.isArray(products) ? products : [];
  return RECHARGE_PACKAGES.map((fixed) => {
    const matched = available.find((item) => (
      String(item && item.productId || "") === fixed.productId
      &&
      safeNumber(item && item.amountFen) === fixed.amountFen
      && safeNumber(item && (item.grantPoints !== undefined ? item.grantPoints : item.points)) === fixed.grantPoints
    ));
    return matched
      ? Object.assign({}, fixed, {
        grantPointsText: formatPoints(fixed.grantPoints, { fallback: "0" })
      })
      : null;
  }).filter(Boolean);
}

function normalizeRechargeConfig(result = {}) {
  const channels = normalizeChannels(
    result.channels !== undefined ? result.channels : result.availableChannels
  );
  return {
    eligible: Boolean(result.eligible),
    channels,
    hasWxpay: channels.includes("wxpay"),
    products: normalizeProducts(result.products || result.packages),
    message: String(result.message || "").trim()
  };
}

module.exports = {
  RECHARGE_PACKAGES,
  ACCOUNT_SERVICE_NOT_READY_MESSAGE,
  safeNumber,
  normalizeDecimalText,
  formatPoints,
  formatInteger,
  formatMoney,
  formatDateTime,
  normalizeProfile,
  normalizeAccount,
  normalizeRecord,
  normalizeRecords,
  normalizeChannels,
  normalizeProducts,
  normalizeRechargeConfig,
  accountErrorCode,
  userErrorMessage
};
