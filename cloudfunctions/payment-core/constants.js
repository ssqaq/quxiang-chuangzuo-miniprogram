"use strict";

const PAYMENT_STATUSES = Object.freeze([
  "created",
  "creation_unknown",
  "pending",
  "verifying",
  "paid",
  "fulfilled",
  "closed",
  "refund_review",
  "refunded",
  "review"
]);

const PAYMENT_COLLECTIONS = Object.freeze({
  orders: "payment_orders",
  events: "payment_events",
  rechargeConfig: "recharge_config",
  pointsAccounts: "user_accounts",
  pointsLedger: "point_ledger"
});

const LIVE_RECHARGE_CONFIG_ID = "global";
const CALLBACK_SUCCESS_TEXT = "success";
const CALLBACK_FAILURE_TEXT = "fail";
const PROVIDER_NAME = "xingju";
const PROVIDER_CHANNEL = "wxpay";
const PROVIDER_SIGN_TYPE = "RSA";
const SIGNATURE_MAX_SKEW_SECONDS = 300;
const PROVIDER_TIMEOUT_MS = 6000;
const PROVIDER_MAX_RESPONSE_BYTES = 128 * 1024;
const RECONCILE_LEASE_MS = 180 * 1000;
const RECONCILE_STOP_CLAIMING_MS = 90 * 1000;
const NOT_FOUND_REVIEW_THRESHOLD = 3;

module.exports = {
  PAYMENT_STATUSES,
  PAYMENT_COLLECTIONS,
  LIVE_RECHARGE_CONFIG_ID,
  CALLBACK_SUCCESS_TEXT,
  CALLBACK_FAILURE_TEXT,
  PROVIDER_NAME,
  PROVIDER_CHANNEL,
  PROVIDER_SIGN_TYPE,
  SIGNATURE_MAX_SKEW_SECONDS,
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_RESPONSE_BYTES,
  RECONCILE_LEASE_MS,
  RECONCILE_STOP_CLAIMING_MS,
  NOT_FOUND_REVIEW_THRESHOLD
};
