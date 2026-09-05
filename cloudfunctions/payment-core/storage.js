"use strict";

const { sha256 } = require("./crypto");

function isDocumentNotFoundError(error) {
  const code = String(error && (error.code || error.errCode) || "").toUpperCase();
  const message = String(error && (error.message || error.errMsg) || "");
  return ["DATABASE_DOCUMENT_NOT_EXIST", "DOCUMENT_NOT_FOUND", "NOT_FOUND"].includes(code)
    || /document.*(?:not exist|not found)|文档不存在/i.test(message);
}

async function readDocument(ref) {
  try {
    const result = await ref.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return null;
    throw error;
  }
}

function stripDocumentId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = Object.assign({}, value);
  delete result._id;
  return result;
}

function pointsAccountId(openid) {
  return sha256(`points:${openid}`).slice(0, 32);
}

function dateMillis(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateIso(value) {
  const milliseconds = dateMillis(value);
  return milliseconds > 0 ? new Date(milliseconds).toISOString() : "";
}

function defaultPointsAccount(openid, now = new Date()) {
  return {
    _id: pointsAccountId(openid),
    openid,
    pointsBalance: 0,
    totalEarned: 0,
    totalSpent: 0,
    totalPurchasedPoints: 0,
    totalRedeemedPoints: 0,
    totalReversedPurchasedPoints: 0,
    currentStreak: 0,
    lastCheckinDate: "",
    boundAt: now,
    updatedAt: now
  };
}

function accountView(account) {
  const source = account || {};
  return {
    pointsBalance: Math.max(0, Number(source.pointsBalance) || 0),
    totalEarned: Math.max(0, Number(source.totalEarned) || 0),
    totalSpent: Math.max(0, Number(source.totalSpent) || 0),
    totalPurchasedPoints: Math.max(0, Number(source.totalPurchasedPoints) || 0),
    totalRedeemedPoints: Math.max(0, Number(source.totalRedeemedPoints) || 0),
    totalReversedPurchasedPoints: Math.max(0, Number(source.totalReversedPurchasedPoints) || 0)
  };
}

function orderView(order) {
  if (!order) return null;
  const reviewAtValue = order.reviewedAt || order.reviewAt || order.createdAt;
  const reviewOverdueAtValue = order.reviewOverdueAt
    || (String(order.status || "") === "review" && dateMillis(reviewAtValue) > 0
      ? new Date(dateMillis(reviewAtValue) + 48 * 60 * 60 * 1000)
      : null);
  return {
    orderNo: String(order.outTradeNo || ""),
    status: String(order.status || ""),
    productId: String(order.productId || ""),
    amountFen: Math.max(0, Number(order.amountFen) || 0),
    grantPoints: Math.max(0, Number(order.grantPoints) || 0),
    channel: String(order.channel || ""),
    createdAt: dateIso(order.createdAt),
    paidAt: dateIso(order.paidAt),
    fulfilledAt: dateIso(order.fulfilledAt),
    attentionRequired: Boolean(order.attentionRequired),
    reviewAt: dateIso(reviewAtValue),
    reviewOverdueAt: dateIso(reviewOverdueAtValue),
    reviewOverdue: Boolean(
      String(order.status || "") === "review"
      && dateMillis(reviewOverdueAtValue) > 0
      && dateMillis(reviewOverdueAtValue) <= Date.now()
    )
  };
}

function ledgerView(item) {
  const source = item || {};
  return {
    id: String(source._id || ""),
    type: String(source.type || ""),
    kind: String(source.kind || ""),
    amount: Number(source.amount) || 0,
    balanceAfter: Math.max(0, Number(source.balanceAfter) || 0),
    description: String(source.description || "").slice(0, 160),
    createdAt: dateIso(source.createdAt)
  };
}

module.exports = {
  isDocumentNotFoundError,
  readDocument,
  stripDocumentId,
  pointsAccountId,
  dateMillis,
  dateIso,
  defaultPointsAccount,
  accountView,
  orderView,
  ledgerView
};
