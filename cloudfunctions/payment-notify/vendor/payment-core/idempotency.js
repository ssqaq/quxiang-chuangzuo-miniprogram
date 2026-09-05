"use strict";

const { hashObject, sha256, moneyToFen } = require("./crypto");
const { paymentError } = require("./errors");

function requestFingerprint(value) {
  return hashObject({
    productId: String(value && value.productId || ""),
    amountFen: Number(value && value.amountFen),
    grantPoints: Number(value && value.grantPoints),
    channel: String(value && value.channel || "")
  });
}

function requestIdHash(requestId) {
  return sha256(String(requestId || "").trim());
}

function paymentOrderId(openidHash, hashedRequestId) {
  return sha256(`payment-order:${openidHash}:${hashedRequestId}`).slice(0, 32);
}

function merchantOrderNo(openidHash, hashedRequestId) {
  return `PAY${sha256(`out-trade-no:${openidHash}:${hashedRequestId}`).slice(0, 29).toUpperCase()}`;
}

function paymentLedgerId(outTradeNo) {
  return sha256(`ledger:payment:${outTradeNo}`).slice(0, 32);
}

function callbackEventId(payload) {
  return sha256([
    "payment-event:callback",
    "xingju",
    String(payload && payload.type || ""),
    String(payload && payload.out_trade_no || ""),
    String(payload && payload.trade_no || ""),
    String(payload && payload.trade_status || "")
  ].join(":"));
}

function callbackPayloadHash(payload) {
  return hashObject({
    outTradeNo: String(payload && payload.out_trade_no || ""),
    tradeNo: String(payload && payload.trade_no || ""),
    tradeStatus: String(payload && payload.trade_status || ""),
    channel: String(payload && payload.type || ""),
    amountFen: moneyToFen(payload && payload.money),
    pid: String(payload && payload.pid || "")
  });
}

function assertIdempotentRequest(existingOrder, fingerprint) {
  if (!existingOrder) return null;
  if (String(existingOrder.requestFingerprint || "") !== String(fingerprint || "")) {
    throw paymentError(
      "IDEMPOTENCY_CONFLICT",
      "这次请求编号已用于其他充值内容，请重新发起。"
    );
  }
  return existingOrder;
}

module.exports = {
  requestFingerprint,
  requestIdHash,
  paymentOrderId,
  merchantOrderNo,
  paymentLedgerId,
  callbackEventId,
  callbackPayloadHash,
  assertIdempotentRequest
};
