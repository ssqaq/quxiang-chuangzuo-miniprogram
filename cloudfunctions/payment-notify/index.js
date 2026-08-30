"use strict";

const cloud = require("wx-server-sdk");
const payment = require("aips-payment-core");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CALLBACK_KEYS = Object.freeze([
  "pid",
  "trade_no",
  "out_trade_no",
  "type",
  "name",
  "money",
  "trade_status",
  "param",
  "sitename",
  "clientip",
  "device",
  "timestamp",
  "sign",
  "sign_type"
]);

function parseQueryString(value) {
  const params = new URLSearchParams(String(value || "").replace(/^\?/, ""));
  const result = {};
  for (const key of CALLBACK_KEYS) {
    const values = params.getAll(key);
    if (values.length > 1) {
      throw payment.paymentError(
        "PAYMENT_CALLBACK_QUERY_AMBIGUOUS",
        "支付回调参数重复。"
      );
    }
    if (values.length === 1) result[key] = values[0];
  }
  return result;
}

function extractCallbackParams(event = {}) {
  const candidate = event.queryStringParameters
    || (event.queryString && typeof event.queryString === "object" ? event.queryString : null);
  if (candidate && typeof candidate === "object") {
    const extracted = CALLBACK_KEYS.reduce((result, key) => {
      if (candidate[key] !== undefined && candidate[key] !== null) {
        result[key] = String(candidate[key]);
      }
      return result;
    }, {});
    if (Object.keys(extracted).length) return extracted;
  }
  if (typeof event.rawQueryString === "string") return parseQueryString(event.rawQueryString);
  if (typeof event.queryString === "string") return parseQueryString(event.queryString);
  return CALLBACK_KEYS.reduce((result, key) => {
    if (event[key] !== undefined && event[key] !== null) result[key] = String(event[key]);
    return result;
  }, {});
}

function textResponse(body, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    },
    body
  };
}

exports.main = async (event = {}) => {
  if (!payment.paymentRuntimeSwitches(process.env).callbackProcessingEnabled) {
    console.warn("payment-notify.disabled");
    return textResponse(payment.CALLBACK_FAILURE_TEXT, 503);
  }
  let providerConfig;
  try {
    providerConfig = payment.requireProviderConfig(process.env);
  } catch (error) {
    console.error("payment-notify.not-configured", {
      code: String(error && error.code || "PAYMENT_NOT_CONFIGURED")
    });
    return textResponse(payment.CALLBACK_FAILURE_TEXT, 503);
  }

  let payload;
  try {
    payload = extractCallbackParams(event);
  } catch (error) {
    console.warn("payment-notify.query-rejected", {
      code: String(error && error.code || "PAYMENT_CALLBACK_QUERY_INVALID")
    });
    return textResponse(payment.CALLBACK_FAILURE_TEXT, 400);
  }
  const verification = payment.verifySignedPayload(
    payload,
    providerConfig,
    { nowMs: Date.now(), allowMissingTimestamp: true }
  );
  if (!verification.ok) {
    // 无效签名只记限频指标，不写 payment_events，避免扫描流量污染审计集合。
    console.warn("payment-notify.signature-rejected", {
      reason: verification.errorCode
    });
    return textResponse(payment.CALLBACK_FAILURE_TEXT, 400);
  }

  try {
    const receipt = await payment.persistCallbackReceipt({
      db,
      payload,
      providerConfig,
      now: new Date()
    });
    if (receipt.ack !== payment.CALLBACK_SUCCESS_TEXT) {
      return textResponse(payment.CALLBACK_FAILURE_TEXT, 409);
    }
    // ACK 只依赖已持久化的 receipt + verifying + reconcile 证据。
    // 外部查单由 payment-reconcile 或用户查订单在事务外执行。
    return textResponse(payment.CALLBACK_SUCCESS_TEXT, 200);
  } catch (error) {
    console.error("payment-notify.persist-failed", {
      code: String(error && error.code || "PAYMENT_CALLBACK_PERSIST_FAILED")
    });
    return textResponse(payment.CALLBACK_FAILURE_TEXT, 500);
  }
};

exports.__test__ = {
  parseQueryString,
  extractCallbackParams,
  textResponse
};
