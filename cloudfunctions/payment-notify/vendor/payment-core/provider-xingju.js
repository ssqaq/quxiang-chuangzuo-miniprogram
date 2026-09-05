"use strict";

const https = require("https");
const {
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_RESPONSE_BYTES
} = require("./constants");
const { buildSignedRequest, verifySignedPayload } = require("./signature");
const { hashObject, moneyToFen } = require("./crypto");
const { paymentError } = require("./errors");

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return PROVIDER_TIMEOUT_MS;
  return Math.max(1000, Math.min(PROVIDER_TIMEOUT_MS, Math.round(parsed)));
}

function sameOriginUrl(baseUrl, pathValue) {
  const base = new URL(`${String(baseUrl || "").replace(/\/+$/, "")}/`);
  const target = new URL(String(pathValue || "").replace(/^\/+/, ""), base);
  if (base.protocol !== "https:" || target.protocol !== "https:" || target.origin !== base.origin) {
    throw paymentError("PAYMENT_PROVIDER_URL_INVALID", "支付服务地址无效。");
  }
  return target;
}

function requestFormJson(baseUrl, pathValue, params, options = {}) {
  const target = sameOriginUrl(baseUrl, pathValue);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxBytes = Math.max(1024, Math.min(
    PROVIDER_MAX_RESPONSE_BYTES,
    Number(options.maxBytes) || PROVIDER_MAX_RESPONSE_BYTES
  ));
  const body = new URLSearchParams(Object.entries(params).map(([key, value]) => (
    [key, String(value)]
  ))).toString();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(target, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "aips-payment/1"
      },
      // 不允许关闭 TLS 证书校验。
      rejectUnauthorized: true
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy();
          fail(paymentError(
            "PAYMENT_PROVIDER_RESPONSE_TOO_LARGE",
            "支付服务响应异常。",
            { uncertain: true, retryable: true }
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(paymentError(
            "PAYMENT_PROVIDER_HTTP_ERROR",
            "支付服务暂时无法响应。",
            { uncertain: true, retryable: true, details: { statusCode: response.statusCode } }
          ));
          return;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (error) {
          fail(paymentError(
            "PAYMENT_PROVIDER_RESPONSE_INVALID",
            "支付服务响应无法验证。",
            { uncertain: true, retryable: true, cause: error }
          ));
          return;
        }
        settled = true;
        resolve(payload);
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail(paymentError(
        "PAYMENT_PROVIDER_TIMEOUT",
        "支付订单正在确认，请稍后查看订单状态。",
        { uncertain: true, retryable: false }
      ));
    });
    request.on("error", (error) => fail(paymentError(
      "PAYMENT_PROVIDER_NETWORK_ERROR",
      "支付订单正在确认，请稍后查看订单状态。",
      { uncertain: true, retryable: false, cause: error }
    )));
    request.end(body);
  });
}

function verifiedProviderResponse(payload, config, nowMs) {
  const verification = verifySignedPayload(payload, config, { nowMs });
  if (!verification.ok) {
    throw paymentError(
      "PAYMENT_PROVIDER_SIGNATURE_INVALID",
      "支付服务响应验签失败。",
      { uncertain: true, retryable: false, details: { reason: verification.errorCode } }
    );
  }
  if (Number(payload.code) !== 0) {
    throw paymentError(
      "PAYMENT_PROVIDER_REJECTED",
      "支付服务未接受这次请求。",
      { uncertain: true, retryable: false, details: { providerCode: payload.code } }
    );
  }
  return Object.assign({}, payload, {
    __verified: true,
    __responseHash: hashObject(payload)
  });
}

function objectCandidate(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function extractWxPaymentParams(providerResponse) {
  const root = objectCandidate(providerResponse) || {};
  const data = objectCandidate(root.data);
  const candidates = [
    root,
    data,
    objectCandidate(root.pay_info),
    objectCandidate(root.payment),
    data && objectCandidate(data.pay_info),
    data && objectCandidate(data.payment)
  ].filter(Boolean);
  for (const item of candidates) {
    const payment = {
      timeStamp: String(item.timeStamp || "").trim(),
      nonceStr: String(item.nonceStr || "").trim(),
      package: String(item.package || "").trim(),
      signType: String(item.signType || "").trim(),
      paySign: String(item.paySign || "").trim()
    };
    if (
      /^\d{10,13}$/.test(payment.timeStamp)
      && payment.nonceStr.length >= 1
      && payment.nonceStr.length <= 64
      && /^prepay_id=[A-Za-z0-9_\-=]+$/.test(payment.package)
      && ["RSA", "MD5", "HMAC-SHA256"].includes(payment.signType)
      && payment.paySign.length >= 16
      && payment.paySign.length <= 1024
    ) {
      return payment;
    }
  }
  return null;
}

function providerData(value) {
  const source = objectCandidate(value) || {};
  return objectCandidate(source.data) || source;
}

function providerTradeNo(value) {
  const source = providerData(value);
  return String(source.trade_no || value.trade_no || "").trim().slice(0, 100);
}

function providerEnvelope(value) {
  const source = objectCandidate(value) || {};
  return Object.assign({}, source, providerData(source));
}

function createOrderResponseMismatches(order, response, providerConfig) {
  const data = providerEnvelope(response);
  const mismatches = [];
  if (data.out_trade_no && String(data.out_trade_no) !== String(order.outTradeNo)) {
    mismatches.push("outTradeNo");
  }
  if (data.money !== undefined && data.money !== null && moneyToFen(data.money) !== Number(order.amountFen)) {
    mismatches.push("amountFen");
  }
  if (
    (data.pid && String(data.pid) !== String(providerConfig.pid))
    || (order.pid && String(order.pid) !== String(providerConfig.pid))
  ) {
    mismatches.push("pid");
  }
  if (data.type && String(data.type) !== String(order.channel)) mismatches.push("channel");
  if (!String(data.trade_no || "").trim()) mismatches.push("providerTradeNo");
  return mismatches;
}

class XingjuProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.request = options.request || requestFormJson;
    this.now = options.now || (() => Date.now());
  }

  async execute(pathValue, params) {
    const signed = buildSignedRequest(params, this.config, this.now());
    const response = await this.request(
      this.config.apiBaseUrl,
      pathValue,
      signed,
      { timeoutMs: this.timeoutMs }
    );
    return verifiedProviderResponse(response, this.config, this.now());
  }

  async createOrder(order) {
    const params = {
      method: "jsapi",
      type: "wxpay",
      notify_url: this.config.notifyUrl,
      out_trade_no: order.outTradeNo,
      name: `AIPS ${order.grantPoints} 积分`,
      money: order.amountMoney,
      clientip: order.clientIp || "127.0.0.1",
      sub_openid: order.openid,
      sub_appid: order.subAppid,
      is_applet: 1
    };
    if (this.config.returnUrl) params.return_url = this.config.returnUrl;
    const response = await this.execute("api/pay/create", params);
    const mismatches = createOrderResponseMismatches(order, response, this.config);
    if (mismatches.length) {
      throw paymentError(
        "PAYMENT_PROVIDER_CREATE_MISMATCH",
        "支付服务返回的订单信息无法匹配。",
        {
          uncertain: true,
          retryable: false,
          details: {
            mismatchFields: mismatches,
            providerCreateResponseHash: response.__responseHash || ""
          }
        }
      );
    }
    const tradeNo = providerTradeNo(response);
    const payment = extractWxPaymentParams(response);
    if (!payment) {
      throw paymentError(
        "PAYMENT_LAUNCH_PARAMS_MISSING",
        "支付通道未返回可验证的微信调起参数。",
        {
          uncertain: true,
          retryable: false,
          details: {
            recoverySafe: true,
            providerTradeNo: tradeNo,
            providerCreateResponseHash: response.__responseHash || ""
          }
        }
      );
    }
    return {
      response,
      responseHash: response.__responseHash,
      providerTradeNo: tradeNo,
      payment
    };
  }

  async queryOrder(order) {
    const tradeNo = String(order && order.providerTradeNo || "").trim();
    if (!tradeNo) {
      // SDK 2.0 只证明 query 参数是 trade_no，不猜测 out_trade_no 可查。
      throw paymentError(
        "PAYMENT_PROVIDER_QUERY_REFERENCE_MISSING",
        "平台订单号尚未确认。",
        { uncertain: true, retryable: false }
      );
    }
    return this.execute("api/pay/query", { trade_no: tradeNo });
  }
}

module.exports = {
  XingjuProvider,
  requestFormJson,
  verifiedProviderResponse,
  extractWxPaymentParams,
  providerData,
  providerTradeNo,
  providerEnvelope,
  createOrderResponseMismatches,
  sameOriginUrl
};
