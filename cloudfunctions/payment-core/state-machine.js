"use strict";

const { PAYMENT_STATUSES, REVIEW_OVERDUE_MS } = require("./constants");
const { paymentError } = require("./errors");

const STATUS_SET = new Set(PAYMENT_STATUSES);
const RECONCILE_STOP_STATUSES = new Set([
  "fulfilled",
  "closed",
  "refund_review",
  "refunded",
  "review"
]);
const UNRESOLVED_PAYMENT_STATUSES = new Set([
  "created",
  "creation_unknown",
  "review",
  "pending",
  "verifying",
  "paid"
]);
const TRANSITIONS = Object.freeze({
  created: new Set(["pending", "creation_unknown", "verifying", "review"]),
  creation_unknown: new Set(["verifying", "paid", "review"]),
  pending: new Set(["verifying", "paid", "review"]),
  verifying: new Set(["paid", "refund_review", "review"]),
  paid: new Set(["fulfilled", "refund_review", "review"]),
  fulfilled: new Set(["refund_review", "review"]),
  closed: new Set(["review"]),
  refund_review: new Set(["refunded", "review"]),
  refunded: new Set(["review"]),
  review: new Set([])
});

function assertStatus(status) {
  if (!STATUS_SET.has(String(status || ""))) {
    throw paymentError("PAYMENT_STATUS_INVALID", "支付订单状态无效。");
  }
}

function canTransition(order, nextStatus, context = {}) {
  const from = String(order && order.status || "");
  const to = String(nextStatus || "");
  if (!STATUS_SET.has(from) || !STATUS_SET.has(to)) return false;
  if (from === to) return true;
  if (to === "closed") {
    // 星聚首版没有已证实的自动关闭状态码，仅允许审计后的人工关闭。
    return context.manualReview === true && from === "review";
  }
  if (to === "refunded") {
    return context.manualReview === true && from === "refund_review";
  }
  if (from === "review") {
    return context.manualReview === true && to === order.reviewFromStatus;
  }
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].has(to));
}

function transitionOrder(order, nextStatus, patch = {}, context = {}) {
  const source = Object.assign({}, order || {});
  assertStatus(source.status);
  assertStatus(nextStatus);
  if (!canTransition(source, nextStatus, context)) {
    throw paymentError(
      "PAYMENT_STATUS_TRANSITION_INVALID",
      `不允许从 ${source.status} 转为 ${nextStatus}。`
    );
  }
  const statusChanged = source.status !== nextStatus;
  const nextVersion = (Number(source.statusVersion) || 0) + (statusChanged ? 1 : 0);
  const value = Object.assign({}, source, patch, {
    status: nextStatus,
    statusVersion: nextVersion
  });
  if (RECONCILE_STOP_STATUSES.has(nextStatus)) {
    value.reconcileRequired = false;
    value.nextReconcileAt = null;
    value.reconcileLeaseOwner = "";
    value.reconcileLeaseToken = "";
    value.reconcileLeaseUntil = null;
    value.reconcileLeaseStatusVersion = nextVersion;
  }
  if (nextStatus === "review" && source.status !== "review") {
    value.reviewFromStatus = source.status;
    value.reviewReason = String(context.reviewReason || patch.reviewReason || "unspecified").slice(0, 120);
    value.reviewEvidence = context.reviewEvidence === undefined
      ? (patch.reviewEvidence || null)
      : context.reviewEvidence;
    value.reviewStatusVersion = nextVersion;
    const reviewAt = context.now instanceof Date
      ? context.now
      : new Date(context.now || patch.reviewedAt || Date.now());
    value.reviewedAt = reviewAt;
    value.reviewOverdueAt = new Date(reviewAt.getTime() + REVIEW_OVERDUE_MS);
    value.attentionRequired = true;
  }
  if (source.status === "review" && nextStatus !== "review") {
    value.reviewResolvedAt = context.now || new Date();
  }
  return value;
}

module.exports = {
  PAYMENT_STATUSES,
  RECONCILE_STOP_STATUSES,
  UNRESOLVED_PAYMENT_STATUSES,
  assertStatus,
  canTransition,
  transitionOrder
};
