"use strict";

const assert = require("assert");
const path = require("path");

delete process.env.ALIPAY_PROTOCOL_CONFIRMED;
const api = require(path.join(__dirname, "..", "cloudfunctions", "payment-api"));
const helpers = api.__test__;
const payment = require(path.join(__dirname, "..", "cloudfunctions", "payment-core"));

assert.strictEqual(helpers.alipayProtocolConfirmed(), false);
assert.match(payment.paymentOrderGuardId("a".repeat(64), "pkg_990"), /^LOCK_[A-F0-9]{27}$/);
assert.deepStrictEqual(
  helpers.unresolvedOrders([
    { _id: "guard", kind: "payment_guard", productId: "pkg_990" },
    { _id: "old", status: "creation_unknown", productId: "pkg_990" },
    { _id: "done", status: "fulfilled", productId: "pkg_990" },
    { _id: "review", status: "review", productId: "pkg_2990" }
  ]).map((item) => item._id),
  ["old", "review"]
);

process.env.ALIPAY_PROTOCOL_CONFIRMED = "true";
assert.strictEqual(helpers.alipayProtocolConfirmed(), true);
delete process.env.ALIPAY_PROTOCOL_CONFIRMED;
console.log("payment phase1 safety smoke: OK (protocol gate/unresolved filter)");
