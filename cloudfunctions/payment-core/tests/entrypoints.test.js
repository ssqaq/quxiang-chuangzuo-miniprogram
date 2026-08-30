"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

test("三个云函数入口在开关缺失时全部 fail-closed", async () => {
  delete process.env.PAYMENT_ORDER_CREATION_ENABLED;
  delete process.env.PAYMENT_CALLBACK_PROCESSING_ENABLED;
  delete process.env.PAYMENT_RECONCILIATION_ENABLED;
  const api = require("../../payment-api");
  const notify = require("../../payment-notify");
  const reconcile = require("../../payment-reconcile");

  const config = await api.main({ action: "getConfig" }, { OPENID: "test-openid" });
  assert.equal(config.ok, true);
  assert.equal(config.eligible, false);
  assert.deepEqual(config.channels, []);
  assert.deepEqual(config.products, []);

  const create = await api.main({
    action: "createOrder",
    requestId: "request_123",
    productId: "pkg_990",
    channel: "wxpay"
  }, { OPENID: "test-openid" });
  assert.equal(create.errorCode, "PAYMENT_ORDER_CREATION_DISABLED");

  const callback = await notify.main({});
  assert.equal(callback.statusCode, 503);
  assert.equal(callback.body, "fail");

  const timer = await reconcile.main({ TriggerName: "payment-reconcile" });
  assert.equal(timer.errorCode, "PAYMENT_RECONCILIATION_DISABLED");
});

test("payment-reconcile 只接受无 OPENID 的固定 Timer 身份", async () => {
  delete process.env.PAYMENT_RECONCILIATION_ENABLED;
  const reconcile = require("../../payment-reconcile");

  const spoofedClient = await reconcile.main(
    { TriggerName: "payment-reconcile" },
    { OPENID: "client-openid" }
  );
  assert.equal(spoofedClient.errorCode, "PAYMENT_RECONCILE_FORBIDDEN");

  const wrongTimer = await reconcile.main({ TriggerName: "other-timer" }, {});
  assert.equal(wrongTimer.errorCode, "PAYMENT_RECONCILE_FORBIDDEN");

  const trustedTimer = await reconcile.main({ TriggerName: "payment-reconcile" }, {});
  assert.equal(trustedTimer.errorCode, "PAYMENT_RECONCILIATION_DISABLED");
});
