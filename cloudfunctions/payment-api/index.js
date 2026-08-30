"use strict";

const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const payment = require("aips-payment-core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const RECORD_CURSOR_VERSION = 1;
const RECORD_CURSOR_MAX_LENGTH = 768;
const RECORD_CURSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_FILTERS = Object.freeze(["all", "recharge", "spend", "reward", "refund"]);

function success(data = {}) {
  return Object.assign({ ok: true }, data);
}

function getOpenId(context) {
  const direct = context && (context.OPENID || context.openid);
  if (direct) return String(direct);
  try {
    const wxContext = cloud.getWXContext() || {};
    return String(wxContext.OPENID || wxContext.openid || "");
  } catch (_error) {
    return "";
  }
}

function requireOpenId(context) {
  const openid = getOpenId(context);
  if (!openid) {
    throw payment.paymentError("PAYMENT_AUTH_REQUIRED", "请先完成微信授权。");
  }
  return openid;
}

async function readRechargeConfig() {
  try {
    const value = await payment.readDocument(
      db.collection(payment.PAYMENT_COLLECTIONS.rechargeConfig)
        .doc(payment.LIVE_RECHARGE_CONFIG_ID)
    );
    return payment.normalizeRechargeConfig(value);
  } catch (_error) {
    // 集合未建、读取失败或配置异常时一律回退为全关，不会误开充值。
    return payment.normalizeRechargeConfig(null);
  }
}

function providerRuntime() {
  const evaluated = payment.evaluateProviderConfig(process.env);
  return {
    evaluated,
    provider: evaluated.configured
      ? new payment.XingjuProvider(evaluated.value, { timeoutMs: payment.PROVIDER_TIMEOUT_MS })
      : null
  };
}

async function getConfig(_event, context) {
  const openid = getOpenId(context);
  const switches = payment.paymentRuntimeSwitches(process.env);
  if (
    !switches.orderCreationEnabled
    || !switches.callbackProcessingEnabled
    || !switches.reconciliationEnabled
  ) {
    return success({
      eligible: false,
      channels: [],
      products: [],
      message: "",
      serverTime: new Date().toISOString()
    });
  }
  const rechargeConfig = await readRechargeConfig();
  const eligible = Boolean(openid) && payment.isEligibleOpenid(openid, rechargeConfig);
  const runtime = providerRuntime();
  const wxpayAvailable = eligible
    && rechargeConfig.channelConfig.wxpay.enabled
    && switches.orderCreationEnabled
    && runtime.evaluated.configured;
  const channels = wxpayAvailable ? ["wxpay"] : [];
  let message = "";
  if (eligible && !channels.length) message = "支付通道准备中";
  return success({
    eligible,
    channels,
    products: eligible
      ? payment.publicProducts(rechargeConfig.productConfig.enabledProductIds)
      : [],
    message,
    serverTime: new Date().toISOString()
  });
}

async function readAccount(openid) {
  const account = await payment.readDocument(
    db.collection(payment.PAYMENT_COLLECTIONS.pointsAccounts)
      .doc(payment.pointsAccountId(openid))
  );
  return payment.accountView(account);
}

function recordTypes(filter) {
  const value = normalizeRecordFilter(filter);
  if (value === "recharge") return ["recharge"];
  if (value === "spend") return ["spend"];
  if (value === "reward") return ["checkin", "daily-free", "promo-free", "refund"];
  if (value === "refund") return ["refund", "payment-reversal"];
  return [];
}

function recordCursorError() {
  return payment.paymentError(
    "PAYMENT_RECORD_CURSOR_INVALID",
    "记录翻页信息已失效，请刷新后重试。"
  );
}

function normalizeRecordFilter(value) {
  const normalized = String(value === undefined || value === null ? "" : value).trim() || "all";
  if (!RECORD_FILTERS.includes(normalized)) {
    throw payment.paymentError("PAYMENT_RECORD_FILTER_INVALID", "记录筛选条件无效。");
  }
  return normalized;
}

function recordDateMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") {
    const converted = value.toDate();
    return converted instanceof Date ? converted.getTime() : NaN;
  }
  if (value && typeof value.toMillis === "function") {
    return Number(value.toMillis());
  }
  if (value && typeof value === "object") {
    const seconds = Number(
      value.seconds !== undefined ? value.seconds
        : value._seconds !== undefined ? value._seconds
          : value._bsontype === "Timestamp" && value.low !== undefined ? value.low
            : NaN
    );
    const nanos = Number(
      value.nanoseconds !== undefined ? value.nanoseconds
        : value._nanoseconds !== undefined ? value._nanoseconds
          : 0
    );
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return (seconds * 1000) + Math.floor(nanos / 1000000);
    }
  }
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return new Date(value).getTime();
  return NaN;
}

function isValidRecordTime(milliseconds) {
  return Number.isSafeInteger(milliseconds)
    && milliseconds >= 0
    && milliseconds <= 8640000000000000;
}

function cursorMacKey(openid) {
  return crypto.createHash("sha256")
    .update(`aips:point-ledger-cursor:${String(openid || "")}`, "utf8")
    .digest();
}

function cursorMac(body, openid) {
  return crypto.createHmac("sha256", cursorMacKey(openid))
    .update(body, "utf8")
    .digest("base64url");
}

function safeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function encodeRecordCursor(row, openid, filter) {
  const createdAt = recordDateMillis(row && row.createdAt);
  const id = String(row && row._id || "");
  const normalizedFilter = normalizeRecordFilter(filter);
  if (!isValidRecordTime(createdAt) || !RECORD_CURSOR_ID_PATTERN.test(id)) {
    throw payment.paymentError(
      "PAYMENT_RECORD_CURSOR_SOURCE_INVALID",
      "记录翻页信息生成失败，请刷新后重试。"
    );
  }
  const payload = {
    v: RECORD_CURSOR_VERSION,
    t: createdAt,
    i: id,
    f: normalizedFilter,
    u: payment.sha256(String(openid || ""))
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${cursorMac(body, openid)}`;
}

function decodeRecordCursor(value, openid, filter) {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string"
    || value !== value.trim()
    || value.length > RECORD_CURSOR_MAX_LENGTH
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw recordCursorError();
  }
  const [body, signature] = value.split(".");
  if (!safeEqualText(signature, cursorMac(body, openid))) throw recordCursorError();

  let decoded;
  try {
    const buffer = Buffer.from(body, "base64url");
    if (buffer.toString("base64url") !== body) throw new Error("non-canonical cursor");
    decoded = JSON.parse(buffer.toString("utf8"));
  } catch (_error) {
    throw recordCursorError();
  }

  const normalizedFilter = normalizeRecordFilter(filter);
  const keys = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? Object.keys(decoded).sort()
    : [];
  if (
    keys.join(",") !== "f,i,t,u,v"
    || decoded.v !== RECORD_CURSOR_VERSION
    || !isValidRecordTime(decoded.t)
    || typeof decoded.i !== "string"
    || !RECORD_CURSOR_ID_PATTERN.test(decoded.i)
    || decoded.f !== normalizedFilter
    || decoded.u !== payment.sha256(String(openid || ""))
  ) {
    throw recordCursorError();
  }
  return {
    createdAt: new Date(decoded.t),
    id: decoded.i,
    filter: decoded.f
  };
}

function recordQueryCondition(openid, filter, cursor) {
  const types = recordTypes(filter);
  const base = { openid };
  if (types.length === 1) base.type = types[0];
  else if (types.length > 1) base.type = db.command.in(types);
  if (!cursor) return base;
  return db.command.and(
    base,
    db.command.or(
      { createdAt: db.command.lt(cursor.createdAt) },
      { createdAt: cursor.createdAt, _id: db.command.lt(cursor.id) }
    )
  );
}

async function loadRecords(openid, event = {}) {
  const limit = Math.max(1, Math.min(50, Number(event.limit) || 20));
  const filter = normalizeRecordFilter(event.type);
  const cursor = decodeRecordCursor(event.cursor, openid, filter);
  const condition = recordQueryCondition(openid, filter, cursor);
  try {
    const result = await db
      .collection(payment.PAYMENT_COLLECTIONS.pointsLedger)
      .where(condition)
      .orderBy("createdAt", "desc")
      .orderBy("_id", "desc")
      .limit(limit + 1)
      .get();
    const rows = result && Array.isArray(result.data) ? result.data : [];
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(payment.ledgerView),
      limit,
      nextCursor: hasMore
        ? encodeRecordCursor(pageRows[pageRows.length - 1], openid, filter)
        : null,
      hasMore
    };
  } catch (error) {
    if (error && /^PAYMENT_RECORD_/.test(String(error.code || ""))) throw error;
    throw payment.paymentError(
      "PAYMENT_RECORDS_UNAVAILABLE",
      "收支记录读取失败，请重试。",
      { retryable: true, cause: error }
    );
  }
}

async function getOverview(_event, context) {
  const openid = requireOpenId(context);
  const [account, records] = await Promise.all([
    readAccount(openid),
    loadRecords(openid, { cursor: "", limit: 3, type: "all" })
  ]);
  return success({ account, recentRecords: records.items });
}

async function getRecords(event, context) {
  const openid = requireOpenId(context);
  return success(await loadRecords(openid, event));
}

function validateCreateInput(event, rechargeConfig) {
  const requestId = String(event.requestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    throw payment.paymentError("PAYMENT_REQUEST_ID_INVALID", "充值请求编号无效。");
  }
  const channel = String(event.channel || "wxpay").trim();
  if (channel !== "wxpay") {
    throw payment.paymentError("PAYMENT_CHANNEL_UNSUPPORTED", "当前版本仅支持微信支付。");
  }
  const product = payment.getProduct(event.productId);
  if (
    !product
    || !rechargeConfig.productConfig.enabledProductIds.includes(product.productId)
  ) {
    throw payment.paymentError("PAYMENT_PRODUCT_INVALID", "充值套餐不存在或已停用。");
  }
  return { requestId, channel, product };
}

function orderPaymentResponse(order) {
  const result = { order: payment.orderView(order) };
  if (order && order.status === "pending" && order.paymentLaunchParams) {
    result.payment = Object.assign({}, order.paymentLaunchParams);
  }
  return result;
}

async function createOrder(event, context) {
  const openid = requireOpenId(context);
  const switches = payment.paymentRuntimeSwitches(process.env);
  if (
    !switches.orderCreationEnabled
    || !switches.callbackProcessingEnabled
    || !switches.reconciliationEnabled
  ) {
    throw payment.paymentError("PAYMENT_ORDER_CREATION_DISABLED", "支付通道准备中，请稍后再试。");
  }
  const rechargeConfig = await readRechargeConfig();
  const openidHash = payment.sha256(openid);
  if (!payment.isEligibleOpenidHash(openidHash, rechargeConfig)) {
    throw payment.paymentError("PAYMENT_NOT_ELIGIBLE", "充值功能尚未对当前账号开放。");
  }
  if (!rechargeConfig.channelConfig.wxpay.enabled) {
    throw payment.paymentError("PAYMENT_CHANNEL_DISABLED", "支付通道准备中，请稍后再试。");
  }
  const runtime = providerRuntime();
  if (!runtime.provider) payment.requireProviderConfig(process.env);
  const { requestId, channel, product } = validateCreateInput(event, rechargeConfig);
  const hashedRequestId = payment.requestIdHash(requestId);
  const fingerprint = payment.requestFingerprint(Object.assign({}, product, { channel }));
  const orderId = payment.paymentOrderId(openidHash, hashedRequestId);
  const outTradeNo = payment.merchantOrderNo(openidHash, hashedRequestId);
  const now = new Date();
  const createClaimToken = payment.randomToken();

  const local = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(payment.PAYMENT_COLLECTIONS.orders).doc(orderId);
    const existing = await payment.readDocument(ref);
    if (existing) {
      if (existing.openidHash !== openidHash || existing.requestIdHash !== hashedRequestId) {
        throw payment.paymentError("IDEMPOTENCY_CONFLICT", "充值请求与已有订单冲突。");
      }
      payment.assertIdempotentRequest(existing, fingerprint);
      return { order: existing, shouldCreate: false };
    }
    const order = {
      _id: orderId,
      openid,
      openidHash,
      requestIdHash: hashedRequestId,
      requestFingerprint: fingerprint,
      outTradeNo,
      productId: product.productId,
      amountFen: product.amountFen,
      amountMoney: payment.fenToMoney(product.amountFen),
      grantPoints: product.grantPoints,
      channel,
      provider: "xingju",
      pid: runtime.provider.config.pid,
      status: "created",
      statusVersion: 1,
      providerStatus: "",
      providerTradeNo: "",
      callbackSuccessVerified: false,
      queryAttemptCount: 0,
      notFoundCount: 0,
      // 外部创建前先把恢复任务排好。函数若被硬终止，60 秒后只转
      // creation_unknown 并查单，绝不再次调用 create 或换 outTradeNo。
      reconcileRequired: true,
      nextReconcileAt: new Date(now.getTime() + 60 * 1000),
      reconcileLeaseOwner: "",
      reconcileLeaseToken: "",
      reconcileLeaseEpoch: 0,
      reconcileLeaseStatusVersion: 1,
      reconcileLeaseUntil: null,
      createClaimToken,
      createdAt: now,
      updatedAt: now
    };
    await ref.set({ data: payment.stripDocumentId(order) });
    return { order, shouldCreate: true };
  }, 5);

  if (!local.shouldCreate) return success(orderPaymentResponse(local.order));

  try {
    const created = await runtime.provider.createOrder(local.order);
    const updated = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(payment.PAYMENT_COLLECTIONS.orders).doc(orderId);
      const current = await payment.readDocument(ref);
      if (!current || current.createClaimToken !== createClaimToken || current.status !== "created") {
        return current;
      }
      const next = payment.transitionOrder(current, "pending", {
        providerTradeNo: created.providerTradeNo,
        providerStatus: "pending",
        providerCreateResponseHash: created.responseHash,
        paymentLaunchParams: created.payment,
        providerCreatedAt: new Date(),
        reconcileRequired: true,
        nextReconcileAt: new Date(Date.now() + 60 * 1000),
        createClaimToken: "",
        updatedAt: new Date()
      });
      await ref.set({ data: payment.stripDocumentId(next) });
      return next;
    }, 5);
    return success(orderPaymentResponse(updated));
  } catch (error) {
    const recovery = error && error.details && error.details.recoverySafe === true
      ? error.details
      : {};
    const unknown = await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(payment.PAYMENT_COLLECTIONS.orders).doc(orderId);
      const current = await payment.readDocument(ref);
      if (!current || current.createClaimToken !== createClaimToken || current.status !== "created") {
        return current;
      }
      const next = payment.transitionOrder(current, "creation_unknown", {
        createClaimToken: "",
        creationErrorCode: String(error && error.code || "PAYMENT_PROVIDER_CREATE_FAILED").slice(0, 100),
        providerTradeNo: String(recovery.providerTradeNo || "").trim().slice(0, 100),
        providerCreateResponseHash: String(recovery.providerCreateResponseHash || "").trim().slice(0, 128),
        reconcileRequired: true,
        nextReconcileAt: new Date(Date.now() + 60 * 1000),
        updatedAt: new Date()
      });
      await ref.set({ data: payment.stripDocumentId(next) });
      return next;
    }, 5);
    throw payment.paymentError(
      "PAYMENT_CREATION_UNKNOWN",
      "充值订单正在确认，请稍后到收支记录查看。",
      { details: { order: payment.orderView(unknown) } }
    );
  }
}

async function queryOrder(event, context) {
  const openid = requireOpenId(context);
  const outTradeNo = String(event.orderNo || event.outTradeNo || "").trim();
  if (!/^PAY[A-F0-9]{29}$/.test(outTradeNo)) {
    throw payment.paymentError("PAYMENT_ORDER_NO_INVALID", "充值订单号无效。");
  }
  let order = await payment.findOrderByOutTradeNo(db, outTradeNo);
  if (!order || order.openidHash !== payment.sha256(openid)) {
    throw payment.paymentError("PAYMENT_ORDER_NOT_FOUND", "充值订单不存在。");
  }
  if (
    payment.paymentRuntimeSwitches(process.env).reconciliationEnabled
    && order.reconcileRequired
    && ["created", "creation_unknown", "pending", "verifying", "paid"].includes(order.status)
  ) {
    const runtime = providerRuntime();
    await payment.reconcileOrder({
      db,
      provider: runtime.provider,
      orderId: order._id,
      owner: `api-${payment.randomToken(8)}`,
      now: new Date()
    });
    order = await payment.readDocument(
      db.collection(payment.PAYMENT_COLLECTIONS.orders).doc(order._id)
    ) || order;
  }
  return success({
    order: payment.orderView(order),
    account: await readAccount(openid)
  });
}

const ACTIONS = Object.freeze({
  getConfig,
  getRechargeConfig: getConfig,
  getOverview,
  getAccountOverview: getOverview,
  getRecords,
  getAccountRecords: getRecords,
  createOrder,
  queryOrder
});

exports.main = async (event = {}, context = {}) => {
  const action = String(event.action || "");
  const handler = ACTIONS[action];
  if (!handler) {
    return payment.toPublicFailure(payment.paymentError(
      "PAYMENT_ACTION_UNSUPPORTED",
      "不支持的支付操作。"
    ));
  }
  try {
    return await handler(event, context);
  } catch (error) {
    console.error("payment-api.failed", {
      action,
      code: String(error && error.code || "PAYMENT_INTERNAL_ERROR")
    });
    const failure = payment.toPublicFailure(error);
    if (error && error.details && error.details.order) failure.order = error.details.order;
    return failure;
  }
};

exports.__test__ = {
  getOpenId,
  validateCreateInput,
  recordTypes,
  normalizeRecordFilter,
  recordDateMillis,
  encodeRecordCursor,
  decodeRecordCursor,
  recordQueryCondition,
  loadRecords,
  orderPaymentResponse
};
