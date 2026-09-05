const cloud = require("./cloud");
const config = require("../config");
const accountUi = require("../utils/account-ui");

const PAYMENT_FUNCTION_NAME = String(config.paymentCloudFunctionName || "payment-api");
const POINTS_FALLBACK_SOURCE = "points-api-fallback";
const POINT_LEDGER_MAX_PAGE_SIZE = 50;
const RECORD_FILTERS = Object.freeze(["all", "recharge", "redeem", "spend", "reward", "refund"]);
const RECORD_TYPE_GROUPS = Object.freeze({
  recharge: Object.freeze(["recharge"]),
  redeem: Object.freeze(["redeem", "voucher"]),
  spend: Object.freeze(["spend"]),
  reward: Object.freeze(["checkin", "daily-free", "promo-free"]),
  refund: Object.freeze(["refund", "payment-reversal"])
});

function isAccountServiceNotDeployed(error) {
  return accountUi.accountErrorCode(error) === "ACCOUNT_SERVICE_NOT_DEPLOYED";
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizePointsAccount(result = {}) {
  const source = result && result.account && typeof result.account === "object"
    ? result.account
    : result && typeof result === "object"
      ? result
      : {};
  return {
    pointsBalance: Math.max(0, finiteNumber(source.pointsBalance)),
    totalEarned: Math.max(0, finiteNumber(source.totalEarned)),
    totalSpent: Math.max(0, finiteNumber(source.totalSpent)),
    totalPurchasedPoints: Math.max(
      0,
      finiteNumber(source.totalPurchasedPoints, finiteNumber(source.totalRecharged))
    ),
    totalReversedPurchasedPoints: Math.max(0, finiteNumber(source.totalReversedPurchasedPoints)),
    currentStreak: Math.max(0, finiteNumber(source.currentStreak)),
    lastCheckinDate: String(source.lastCheckinDate || "")
  };
}

function normalizeLedgerDate(value) {
  let candidate = value;
  if (candidate && typeof candidate.toDate === "function") candidate = candidate.toDate();
  else if (candidate && typeof candidate === "object" && candidate.$date) candidate = candidate.$date;
  else if (candidate && typeof candidate === "object" && candidate.seconds !== undefined) {
    candidate = Number(candidate.seconds) * 1000;
  }
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function sanitizePointLedgerRecord(item, index = 0) {
  const source = item && typeof item === "object" ? item : {};
  return {
    id: String(source.id || source._id || `account-record-${index}`),
    type: String(source.type || ""),
    kind: String(source.kind || ""),
    amount: finiteNumber(source.amount),
    balanceAfter: Math.max(0, finiteNumber(source.balanceAfter)),
    description: String(source.description || source.title || "").slice(0, 160),
    createdAt: normalizeLedgerDate(source.createdAt || source.updatedAt)
  };
}

function pointLedgerRecords(result) {
  return result && Array.isArray(result.records)
    ? result.records.map(sanitizePointLedgerRecord)
    : [];
}

function normalizeRecordFilter(filter) {
  const normalized = String(
    filter === undefined || filter === null ? "" : filter
  ).trim().toLowerCase() || "all";
  if (!RECORD_FILTERS.includes(normalized)) {
    const error = new Error("记录筛选条件无效。");
    error.code = "PAYMENT_RECORD_FILTER_INVALID";
    throw error;
  }
  return normalized;
}

function recordTypes(filter) {
  const normalized = normalizeRecordFilter(filter);
  return RECORD_TYPE_GROUPS[normalized]
    ? RECORD_TYPE_GROUPS[normalized].slice()
    : [];
}

function matchesRecordFilter(item, filter) {
  const normalized = normalizeRecordFilter(filter);
  const types = recordTypes(normalized);
  if (normalized === "all") return true;
  const type = String(item && (item.type || item.kind || item.category) || "").toLowerCase();
  return types.includes(type);
}

function fallbackUnavailableError(fallbackError) {
  const error = new Error("积分账户读取失败，请稍后重试。");
  error.code = "ACCOUNT_POINTS_FALLBACK_UNAVAILABLE";
  error.retryable = Boolean(fallbackError && fallbackError.retryable);
  error.cause = fallbackError || null;
  return error;
}

function shouldPropagateFallbackError(error) {
  return Boolean(error && [
    "ACCOUNT_RECORDS_PAGINATION_UNAVAILABLE",
    "PAYMENT_RECORD_FILTER_INVALID"
  ].includes(String(error.code || "")));
}

async function getPointsFallbackOverview() {
  const pointsResult = await cloud.getUserPoints({ retryLimit: 0 });
  let ledgerResult = { records: [] };
  let ledgerUnavailable = false;
  try {
    ledgerResult = await cloud.getPointLedger();
  } catch (_error) {
    // 余额是主数据；记录读取失败时仍然把余额展示出来，避免整张卡回退成 --。
    ledgerUnavailable = true;
  }
  return {
    ok: true,
    account: normalizePointsAccount(pointsResult),
    recentRecords: pointLedgerRecords(ledgerResult).slice(0, 3),
    accountBound: Boolean(pointsResult && pointsResult.accountBound),
    checkedInToday: Boolean(pointsResult && pointsResult.checkedInToday),
    source: POINTS_FALLBACK_SOURCE,
    recordsUnavailable: ledgerUnavailable
  };
}

async function getPointsFallbackRecords(options = {}) {
  const filter = normalizeRecordFilter(options.type);
  if (String(options.cursor || "")) {
    const error = new Error("积分记录暂不支持翻页，请稍后重试。");
    error.code = "ACCOUNT_RECORDS_PAGINATION_UNAVAILABLE";
    error.retryable = false;
    throw error;
  }
  const result = await cloud.getPointLedger();
  const limit = Math.min(50, Math.max(1, Number(options.limit) || 20));
  const rawRecords = pointLedgerRecords(result);
  const records = rawRecords.filter((item) => (
    matchesRecordFilter(item, filter)
  ));
  return {
    ok: true,
    // 旧 api 只提供最近 50 条且没有游标；返回这批完整数据，避免把第 21
    // 条开始的记录静默丢掉，同时明确告诉调用方这是有限回退结果。
    items: records.slice(0, POINT_LEDGER_MAX_PAGE_SIZE),
    limit,
    nextCursor: null,
    hasMore: false,
    source: POINTS_FALLBACK_SOURCE,
    paginationLimited: rawRecords.length >= POINT_LEDGER_MAX_PAGE_SIZE
  };
}

function paymentError(payload, fallbackMessage, options = {}) {
  const error = new Error(accountUi.userErrorMessage(
    payload,
    fallbackMessage || "账户服务请求失败，请稍后重试。",
    { trustedPublic: options.trustedPublic === true }
  ));
  error.code = accountUi.accountErrorCode(payload);
  error.payload = payload || null;
  error.userSafe = options.trustedPublic === true;
  return error;
}

function invokePaymentApi(action, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    if (
      typeof wx === "undefined"
      || !wx.cloud
      || typeof wx.cloud.callFunction !== "function"
      || !cloud.isCloudReady()
    ) {
      reject(paymentError(null, "云端没有连接，请检查网络后重试。"));
      return;
    }

    const retryLimit = Math.max(0, Number(options.retryLimit) || 0);
    if (retryLimit !== 0) {
      reject(paymentError(null, "支付请求不允许自动重试。"));
      return;
    }

    wx.cloud.callFunction({
      name: PAYMENT_FUNCTION_NAME,
      data: Object.assign({ action }, payload),
      success(response) {
        const result = response && response.result !== undefined
          ? response.result
          : response;
        if (!result || result.ok === false) {
          reject(paymentError(
            result,
            "账户服务暂时不可用，请稍后重试。",
            { trustedPublic: true }
          ));
          return;
        }
        resolve(result);
      },
      fail(error) {
        reject(paymentError(error, "账户服务请求失败，请稍后重试。"));
      }
    });
  });
}

function createRequestId(prefix = "payment") {
  const random = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function createUuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === "x" ? value : (value & 3 | 8)).toString(16);
  });
}

module.exports = {
  __test__: {
    paymentError,
    isAccountServiceNotDeployed,
    normalizePointsAccount,
    normalizeRecordFilter,
    recordTypes,
    matchesRecordFilter,
    sanitizePointLedgerRecord,
    getPointsFallbackOverview,
    getPointsFallbackRecords
  },
  createRequestId,
  createUuidV4,

  getUserProfile(options = {}) {
    return cloud.getMyUserProfile({
      retryLimit: options.retryLimit === undefined ? 0 : options.retryLimit,
      silent: Boolean(options.silent)
    });
  },

  getRechargeConfig() {
    return invokePaymentApi("getConfig", {}, { retryLimit: 0 });
  },

  getPendingOrderStatus(productId) {
    return invokePaymentApi("getPendingOrderStatus", {
      productId: String(productId || "")
    }, { retryLimit: 0 });
  },

  redeemPoints(options = {}) {
    return invokePaymentApi("redeem", {
      clientAttemptId: String(options.clientAttemptId || createUuidV4()),
      code: String(options.code || "")
    }, { retryLimit: 0 });
  },

  queryRedeem(requestId, clientAttemptId) {
    return invokePaymentApi("redeemStatus", {
      requestId: String(requestId || ""),
      clientAttemptId: String(clientAttemptId || "")
    }, { retryLimit: 0 });
  },

  async getAccountOverview() {
    try {
      return await invokePaymentApi("getOverview", {}, { retryLimit: 0 });
    } catch (error) {
      if (!isAccountServiceNotDeployed(error)) throw error;
      try {
        return await getPointsFallbackOverview();
      } catch (fallbackError) {
        throw fallbackUnavailableError(fallbackError);
      }
    }
  },

  async getAccountRecords(options = {}) {
    const filter = normalizeRecordFilter(options.type);
    try {
      return await invokePaymentApi("getRecords", {
        cursor: typeof options.cursor === "string" ? options.cursor : "",
        limit: Math.min(50, Math.max(1, Number(options.limit) || 20)),
        type: filter
      }, { retryLimit: 0 });
    } catch (error) {
      if (!isAccountServiceNotDeployed(error)) throw error;
      try {
        return await getPointsFallbackRecords(Object.assign({}, options, { type: filter }));
      } catch (fallbackError) {
        if (shouldPropagateFallbackError(fallbackError)) throw fallbackError;
        throw fallbackUnavailableError(fallbackError);
      }
    }
  },

  createRechargeOrder(options = {}) {
    return invokePaymentApi("createOrder", {
      requestId: String(options.requestId || createRequestId()),
      productId: String(options.productId || ""),
      channel: String(options.channel || "wxpay").toLowerCase()
    }, { retryLimit: 0 });
  },

  createAlipayRechargeOrder(options = {}) {
    return this.createRechargeOrder(Object.assign({}, options, { channel: "alipay" }));
  },

  queryRechargeOrder(orderNo) {
    return invokePaymentApi("queryOrder", {
      orderNo: String(orderNo || "")
    }, { retryLimit: 0 });
  }
};
