"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const payment = require("..");
const { createFakeDb } = require("./fake-db");
const fixtures = require("./fixtures");

function baseOrder(status = "pending") {
  return {
    openid: "openid-user-a",
    openidHash: payment.sha256("openid-user-a"),
    outTradeNo: "PAY00000000000000000000000000001",
    productId: "pkg_990",
    amountFen: 990,
    grantPoints: 100,
    channel: "wxpay",
    provider: "xingju",
    pid: "1000",
    providerTradeNo: "T100",
    providerStatus: "",
    status,
    statusVersion: 2,
    reconcileRequired: true,
    nextReconcileAt: new Date("2026-08-30T10:00:00.000Z"),
    reconcileLeaseOwner: "",
    reconcileLeaseToken: "",
    reconcileLeaseEpoch: 0,
    reconcileLeaseUntil: null,
    callbackSuccessVerified: false,
    queryAttemptCount: 0,
    notFoundCount: 0,
    createdAt: new Date("2026-08-30T09:59:00.000Z"),
    updatedAt: new Date("2026-08-30T09:59:00.000Z")
  };
}

function callbackPayload(overrides = {}) {
  return Object.assign({
    pid: "1000",
    trade_no: "T100",
    out_trade_no: "PAY00000000000000000000000000001",
    type: "wxpay",
    money: "9.90",
    trade_status: "TRADE_SUCCESS",
    timestamp: "1788084000",
    sign: "verified-upstream",
    sign_type: "RSA"
  }, overrides);
}

test("ACK 前原子落 callback event，订单进 verifying 并设置补单", async () => {
  const orderId = "order-callback";
  const db = createFakeDb({ payment_orders: { [orderId]: baseOrder("pending") } });
  const payload = callbackPayload();
  const result = await payment.persistCallbackReceipt({
    db,
    payload,
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:00:00.000Z")
  });
  assert.equal(result.ack, "success");
  const order = db.read("payment_orders", orderId);
  assert.equal(order.status, "verifying");
  assert.equal(order.callbackSuccessVerified, true);
  assert.equal(order.reconcileRequired, true);
  assert.ok(order.nextReconcileAt instanceof Date);
  const event = db.read("payment_events", payment.callbackEventId(payload));
  assert.equal(event.outcome, "success");
  assert.equal(event.payloadHash, payment.callbackPayloadHash(payload));

  const duplicate = await payment.persistCallbackReceipt({
    db,
    payload,
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:01:00.000Z")
  });
  assert.equal(duplicate.ack, "success");
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.read("payment_orders", orderId).statusVersion, 3);

  const resignedPayload = callbackPayload({
    timestamp: "1788084060",
    sign: "fresh-valid-signature"
  });
  assert.equal(payment.callbackEventId(payload), payment.callbackEventId(resignedPayload));
  assert.equal(payment.callbackPayloadHash(payload), payment.callbackPayloadHash(resignedPayload));
  const resigned = await payment.persistCallbackReceipt({
    db,
    payload: resignedPayload,
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:02:00.000Z")
  });
  assert.equal(resigned.ack, "success");
  assert.equal(resigned.duplicate, true);
});

test("同一业务回调 ID 的 payloadHash 变化必须进 review 并回 fail", async () => {
  const orderId = "order-callback-conflict";
  const db = createFakeDb({ payment_orders: { [orderId]: baseOrder("pending") } });
  const first = callbackPayload();
  await payment.persistCallbackReceipt({
    db,
    payload: first,
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:00:00.000Z")
  });
  const changed = callbackPayload({ money: "19.90", timestamp: "1788084300", sign: "another-sign" });
  assert.equal(payment.callbackEventId(first), payment.callbackEventId(changed));
  const result = await payment.persistCallbackReceipt({
    db,
    payload: changed,
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:05:00.000Z")
  });
  assert.equal(result.ack, "fail");
  const order = db.read("payment_orders", orderId);
  assert.equal(order.status, "review");
  assert.equal(order.reviewFromStatus, "verifying");
  assert.equal(order.reviewReason, "callback_duplicate_conflict");
});

test("closed/refunded 收到迟到成功回调进 review+fail，fulfilled 精确重复回 success", async () => {
  for (const status of ["closed", "refunded"]) {
    const orderId = `order-late-${status}`;
    const db = createFakeDb({ payment_orders: { [orderId]: baseOrder(status) } });
    const result = await payment.persistCallbackReceipt({
      db,
      payload: callbackPayload(),
      providerConfig: fixtures.providerConfig(),
      now: new Date("2026-08-30T10:00:00.000Z")
    });
    assert.equal(result.ack, "fail");
    assert.equal(db.read("payment_orders", orderId).status, "review");
    assert.equal(db.read("payment_orders", orderId).reviewFromStatus, status);
  }

  const fulfilledId = "order-fulfilled-callback";
  const fulfilledDb = createFakeDb({ payment_orders: { [fulfilledId]: baseOrder("fulfilled") } });
  const fulfilled = await payment.persistCallbackReceipt({
    db: fulfilledDb,
    payload: callbackPayload(),
    providerConfig: fixtures.providerConfig(),
    now: new Date("2026-08-30T10:00:00.000Z")
  });
  assert.equal(fulfilled.ack, "success");
  assert.equal(fulfilledDb.read("payment_orders", fulfilledId).status, "fulfilled");
});

test("已落库的成功回调在订单后来 closed/refunded 后重放仍必须 review+fail", async () => {
  for (const status of ["closed", "refunded"]) {
    const orderId = `order-late-replay-${status}`;
    const db = createFakeDb({ payment_orders: { [orderId]: baseOrder("pending") } });
    const payload = callbackPayload();
    const first = await payment.persistCallbackReceipt({
      db,
      payload,
      providerConfig: fixtures.providerConfig(),
      now: new Date("2026-08-30T10:00:00.000Z")
    });
    assert.equal(first.ack, "success");

    const terminal = Object.assign(db.read("payment_orders", orderId), {
      status,
      statusVersion: 8,
      updatedAt: new Date("2026-08-30T10:10:00.000Z")
    });
    db.write("payment_orders", orderId, terminal);

    const replay = await payment.persistCallbackReceipt({
      db,
      payload,
      providerConfig: fixtures.providerConfig(),
      now: new Date("2026-08-30T10:11:00.000Z")
    });
    assert.equal(replay.ack, "fail");
    assert.equal(replay.duplicate, true);
    assert.equal(replay.conflict, true);
    const reviewed = db.read("payment_orders", orderId);
    assert.equal(reviewed.status, "review");
    assert.equal(reviewed.reviewFromStatus, status);
    assert.equal(reviewed.reviewReason, "late_success_callback");

    const repeated = await payment.persistCallbackReceipt({
      db,
      payload,
      providerConfig: fixtures.providerConfig(),
      now: new Date("2026-08-30T10:12:00.000Z")
    });
    assert.equal(repeated.ack, "fail");
    assert.equal(db.read("payment_orders", orderId).status, "review");
  }
});

test("paid 履约在一个事务内增加账户、确定性 ledger 并进 fulfilled", async () => {
  const orderId = "order-paid";
  const order = baseOrder("paid");
  order._id = orderId;
  order.statusVersion = 4;
  const accountId = payment.pointsAccountId(order.openid);
  const db = createFakeDb({
    payment_orders: { [orderId]: order },
    user_accounts: {
      [accountId]: {
        openid: order.openid,
        pointsBalance: 28,
        totalEarned: 28,
        totalSpent: 0,
        totalPurchasedPoints: 0,
        totalReversedPurchasedPoints: 0
      }
    }
  });
  const first = await payment.fulfillPaidOrder({ db, orderId, now: new Date("2026-08-30T10:00:00Z") });
  assert.equal(first.order.status, "fulfilled");
  const account = db.read("user_accounts", accountId);
  assert.equal(account.pointsBalance, 128);
  assert.equal(account.totalPurchasedPoints, 100);
  assert.equal(account.totalEarned, 28);
  const ledgerId = payment.paymentLedgerId(order.outTradeNo);
  assert.equal(db.read("point_ledger", ledgerId).amount, 100);

  const duplicate = await payment.fulfillPaidOrder({ db, orderId, now: new Date("2026-08-30T10:01:00Z") });
  assert.equal(duplicate.duplicate, true);
  assert.equal(db.read("user_accounts", accountId).pointsBalance, 128);
});

test("paid 前 ledger 已存在或 fence 丢失时不得入账", async () => {
  const orderId = "order-ledger-conflict";
  const order = Object.assign(baseOrder("paid"), { _id: orderId, statusVersion: 5 });
  const ledgerId = payment.paymentLedgerId(order.outTradeNo);
  const db = createFakeDb({
    payment_orders: { [orderId]: order },
    point_ledger: { [ledgerId]: { type: "recharge", amount: 100 } }
  });
  const conflict = await payment.fulfillPaidOrder({ db, orderId });
  assert.equal(conflict.review, true);
  assert.equal(db.read("payment_orders", orderId).reviewReason, "ledger_exists_before_fulfilled");

  const fencedId = "order-stale-fence";
  const fenced = Object.assign(baseOrder("paid"), {
    _id: fencedId,
    statusVersion: 8,
    reconcileLeaseOwner: "worker-new",
    reconcileLeaseToken: "token-new",
    reconcileLeaseEpoch: 3
  });
  const fencedDb = createFakeDb({ payment_orders: { [fencedId]: fenced } });
  const skipped = await payment.fulfillPaidOrder({
    db: fencedDb,
    orderId: fencedId,
    fence: { owner: "worker-old", token: "token-old", epoch: 2, statusVersion: 8 }
  });
  assert.equal(skipped.reason, "fence_lost");
  assert.equal(fencedDb.read("payment_orders", fencedId).status, "paid");
  assert.equal(fencedDb.read("point_ledger", payment.paymentLedgerId(fenced.outTradeNo)), undefined);
});

test("pending 连续 3 次签名有效 not-found 进 review，timeout/error 不计数", async () => {
  const orderId = "order-not-found";
  const db = createFakeDb({ payment_orders: { [orderId]: baseOrder("pending") } });
  for (let index = 1; index <= 3; index += 1) {
    const current = db.read("payment_orders", orderId);
    const fence = {
      owner: `worker-${index}`,
      token: `token-${index}`,
      epoch: index,
      statusVersion: current.statusVersion
    };
    db.write("payment_orders", orderId, Object.assign({}, current, {
      reconcileLeaseOwner: fence.owner,
      reconcileLeaseToken: fence.token,
      reconcileLeaseEpoch: fence.epoch,
      reconcileLeaseUntil: new Date(Date.now() + 180000)
    }));
    await payment.commitReconcileOutcome({
      db,
      orderId,
      fence,
      outcome: { kind: "not_found", responseHash: `verified-${index}` },
      now: new Date(`2026-08-30T10:0${index}:00Z`)
    });
  }
  const reviewed = db.read("payment_orders", orderId);
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.reviewFromStatus, "pending");
  assert.equal(reviewed.notFoundCount, 3);
  assert.equal(reviewed.reconcileRequired, false);
  assert.equal(reviewed.nextReconcileAt, null);
  assert.equal(reviewed.reconcileLeaseOwner, "");

  const errorId = "order-query-error";
  db.write("payment_orders", errorId, Object.assign(baseOrder("pending"), {
    reconcileLeaseOwner: "worker-error",
    reconcileLeaseToken: "token-error",
    reconcileLeaseEpoch: 1
  }));
  await payment.commitReconcileOutcome({
    db,
    orderId: errorId,
    fence: { owner: "worker-error", token: "token-error", epoch: 1, statusVersion: 2 },
    outcome: { kind: "error", errorCode: "PAYMENT_PROVIDER_TIMEOUT" },
    now: new Date("2026-08-30T10:01:00Z")
  });
  assert.equal(db.read("payment_orders", errorId).notFoundCount, 0);
  assert.equal(db.read("payment_orders", errorId).status, "pending");
});
