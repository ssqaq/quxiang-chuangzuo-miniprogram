"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const payment = require("..");
const fixtures = require("./fixtures");

test("状态机只有 C4 确认的 10 个状态", () => {
  assert.deepEqual(payment.PAYMENT_STATUSES, [
    "created", "creation_unknown", "pending", "verifying", "paid",
    "fulfilled", "closed", "refund_review", "refunded", "review"
  ]);
});

test("verifying 只能主动查单确认后进 paid，closed/refunded 不能自动进入", () => {
  const verifying = { status: "verifying", statusVersion: 3 };
  assert.equal(payment.canTransition(verifying, "paid"), true);
  assert.equal(payment.canTransition(verifying, "closed"), false);
  const refundReview = { status: "refund_review", statusVersion: 8 };
  assert.equal(payment.canTransition(refundReview, "refunded"), false);
  assert.equal(payment.canTransition(refundReview, "refunded", { manualReview: true }), true);
});

test("进入 review 保留原状态、原因、证据和状态版本", () => {
  const value = payment.transitionOrder(
    {
      status: "paid",
      statusVersion: 5,
      reconcileRequired: true,
      nextReconcileAt: new Date("2026-08-30T10:00:00Z"),
      reconcileLeaseOwner: "old-worker",
      reconcileLeaseToken: "old-token",
      reconcileLeaseUntil: new Date("2026-08-30T10:03:00Z")
    },
    "review",
    {},
    { reviewReason: "ledger_conflict", reviewEvidence: { ledgerId: "L1" } }
  );
  assert.equal(value.reviewFromStatus, "paid");
  assert.equal(value.reviewReason, "ledger_conflict");
  assert.deepEqual(value.reviewEvidence, { ledgerId: "L1" });
  assert.equal(value.reviewStatusVersion, 6);
  assert.equal(value.reconcileRequired, false);
  assert.equal(value.nextReconcileAt, null);
  assert.equal(value.reconcileLeaseOwner, "");
  assert.equal(value.reconcileLeaseToken, "");
  assert.equal(value.reconcileLeaseUntil, null);
});

test("同 requestId+同指纹返原订单，换套餐则冲突", () => {
  const first = payment.requestFingerprint({
    productId: "pkg_990", amountFen: 990, grantPoints: 100, channel: "wxpay"
  });
  const same = payment.requestFingerprint({
    channel: "wxpay", grantPoints: 100, amountFen: 990, productId: "pkg_990"
  });
  const changed = payment.requestFingerprint({
    productId: "pkg_2990", amountFen: 2990, grantPoints: 330, channel: "wxpay"
  });
  const existing = { requestFingerprint: first };
  assert.equal(payment.assertIdempotentRequest(existing, same), existing);
  assert.throws(
    () => payment.assertIdempotentRequest(existing, changed),
    (error) => error.code === "IDEMPOTENCY_CONFLICT"
  );
});

test("商品金额和积分是固定常量", () => {
  assert.deepEqual(payment.PRODUCTS.map(({ productId, amountFen, grantPoints }) => ({
    productId, amountFen, grantPoints
  })), [
    { productId: "pkg_990", amountFen: 990, grantPoints: 100 },
    { productId: "pkg_2990", amountFen: 2990, grantPoints: 330 },
    { productId: "pkg_5990", amountFen: 5990, grantPoints: 688 }
  ]);
  assert.equal(payment.moneyToFen("9.90"), 990);
  assert.equal(payment.moneyToFen("9.9"), 990);
  assert.equal(payment.moneyToFen("9.999"), null);
});

test("充值和两个通道默认全关，支付宝误配也不能开", () => {
  const defaults = payment.normalizeRechargeConfig(null);
  assert.equal(defaults.rechargeEnabled, false);
  assert.equal(defaults.channelConfig.wxpay.enabled, false);
  assert.equal(defaults.channelConfig.alipay.enabled, false);
  const configured = payment.normalizeRechargeConfig({
    rechargeEnabled: true,
    channelConfig: { wxpay: { enabled: true }, alipay: { enabled: true } },
    gray: { strategy: "hash", rolloutPercent: 100 }
  });
  assert.equal(configured.channelConfig.wxpay.enabled, true);
  assert.equal(configured.channelConfig.alipay.enabled, false);
  assert.deepEqual(payment.normalizeRechargeConfig({
    rechargeEnabled: true,
    productConfig: { enabledProductIds: [] },
    gray: { strategy: "typo", rolloutPercent: 100 }
  }).productConfig.enabledProductIds, []);
  assert.equal(payment.normalizeRechargeConfig({
    rechargeEnabled: true,
    gray: { strategy: "typo", rolloutPercent: 100 }
  }).gray.rolloutPercent, 0);
});

test("灰度只允许 whitelist/hash，配置不完整 fail-closed", () => {
  const openidHash = payment.sha256("openid-test");
  assert.equal(payment.isEligibleOpenidHash(openidHash, {
    rechargeEnabled: true,
    gray: { strategy: "whitelist", allowOpenidHashes: [openidHash] }
  }), true);
  assert.equal(payment.isEligibleOpenidHash(payment.sha256("other"), {
    rechargeEnabled: true,
    gray: { strategy: "whitelist", allowOpenidHashes: [openidHash] }
  }), false);
  assert.equal(payment.evaluateProviderConfig({}).configured, false);
  assert.equal(payment.evaluateProviderConfig({
    XINGJU_API_BASE_URL: fixtures.providerConfig().apiBaseUrl,
    XINGJU_PID: fixtures.providerConfig().pid,
    XINGJU_PLATFORM_PUBLIC_KEY: fixtures.PLATFORM_PUBLIC_KEY,
    XINGJU_MERCHANT_PRIVATE_KEY: fixtures.MERCHANT_PRIVATE_KEY,
    XINGJU_NOTIFY_URL: fixtures.providerConfig().notifyUrl
  }).configured, true);
});

test("provider 配置默认 RSA，MD5 只有测试白名单才启用", () => {
  const base = {
    XINGJU_API_BASE_URL: fixtures.providerConfig().apiBaseUrl,
    XINGJU_PID: fixtures.providerConfig().pid,
    XINGJU_NOTIFY_URL: fixtures.providerConfig().notifyUrl,
    XINGJU_SIGNATURE_MODE: "md5",
    XINGJU_MD5_KEY: fixtures.MD5_KEY,
    NODE_ENV: "test",
    XINGJU_MD5_ALLOWLIST: fixtures.providerConfig().pid,
    XINGJU_TEST_MERCHANT_ID: fixtures.providerConfig().pid,
    WECHAT_MINIAPP_TEST: "1"
  };
  assert.equal(payment.evaluateProviderConfig({}).value.signatureMode, "rsa");
  assert.equal(payment.evaluateProviderConfig(base).value.signatureMode, "md5");
  assert.equal(payment.evaluateProviderConfig(Object.assign({}, base, {
    XINGJU_MD5_ALLOWLIST: "not-allowed"
  })).value.signatureMode, "rsa");
});

test("三个支付运行时开关缺失时全关，只有显式 true 才开", () => {
  assert.deepEqual(payment.paymentRuntimeSwitches({}), {
    orderCreationEnabled: false,
    callbackProcessingEnabled: false,
    reconciliationEnabled: false
  });
  assert.deepEqual(payment.paymentRuntimeSwitches({
    PAYMENT_ORDER_CREATION_ENABLED: "true",
    PAYMENT_CALLBACK_PROCESSING_ENABLED: "TRUE",
    PAYMENT_RECONCILIATION_ENABLED: "1"
  }), {
    orderCreationEnabled: true,
    callbackProcessingEnabled: true,
    reconciliationEnabled: false
  });
});
