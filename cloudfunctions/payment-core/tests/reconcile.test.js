"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const payment = require("..");
const { createFakeDb } = require("./fake-db");
const fixtures = require("./fixtures");

test("creation_unknown 没有 providerTradeNo 时不猜测 out_trade_no 查单，不计 not-found 也不关单", async () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  const orderId = "order-unknown";
  const db = createFakeDb({
    payment_orders: {
      [orderId]: {
        status: "creation_unknown",
        statusVersion: 2,
        outTradeNo: "PAY00000000000000000000000000001",
        providerTradeNo: "",
        reconcileRequired: true,
        nextReconcileAt: new Date(now.getTime() - 1000),
        reconcileLeaseOwner: "",
        reconcileLeaseToken: "",
        reconcileLeaseEpoch: 0,
        reconcileLeaseUntil: null,
        queryAttemptCount: 0,
        notFoundCount: 0,
        createdAt: new Date(now.getTime() - 60 * 1000)
      }
    }
  });
  const provider = new payment.XingjuProvider(fixtures.providerConfig(), {
    request: async () => { throw new Error("不应发起 HTTP"); },
    now: () => now.getTime()
  });
  await payment.reconcileOrder({ db, provider, orderId, owner: "worker-a", now });
  const order = db.read("payment_orders", orderId);
  assert.equal(order.status, "creation_unknown");
  assert.equal(order.notFoundCount, 0);
  assert.equal(order.queryAttemptCount, 1);
  assert.equal(order.reconcileRequired, true);
  assert.equal(order.lastQueryErrorCode, "PAYMENT_PROVIDER_QUERY_REFERENCE_MISSING");
});

test("签名有效的查单必须同时匹配订单号、金额、pid、通道和状态", () => {
  const order = {
    outTradeNo: "PAY00000000000000000000000000001",
    amountFen: 990,
    pid: "1000",
    channel: "wxpay",
    providerTradeNo: "T100"
  };
  const exact = {
    __verified: true,
    __responseHash: "hash-1",
    status: 1,
    out_trade_no: order.outTradeNo,
    trade_no: "T100",
    money: "9.90",
    pid: "1000",
    type: "wxpay"
  };
  assert.equal(payment.classifyProviderQuery(order, exact, "1000").kind, "paid");
  const mismatch = payment.classifyProviderQuery(
    order,
    Object.assign({}, exact, { money: "19.90" }),
    "1000"
  );
  assert.equal(mismatch.kind, "mismatch");
  assert.deepEqual(mismatch.mismatchFields, ["amountFen"]);
});

test("wx.requestPayment 只白名单接受完整五字段", () => {
  const complete = {
    data: {
      payment: {
        timeStamp: "1700000000",
        nonceStr: "nonce-123",
        package: "prepay_id=wx_test_123",
        signType: "RSA",
        paySign: "1234567890abcdef"
      }
    }
  };
  assert.deepEqual(payment.extractWxPaymentParams(complete), complete.data.payment);
  assert.equal(payment.extractWxPaymentParams({ data: { payment: { timeStamp: "1700000000" } } }), null);
});

test("创建响应必须匹配订单，已知 trade_no 在 launcher 缺失时可安全恢复", async () => {
  const config = fixtures.providerConfig();
  const order = {
    outTradeNo: "PAY00000000000000000000000000001",
    amountFen: 990,
    amountMoney: "9.90",
    grantPoints: 100,
    pid: "1000",
    channel: "wxpay"
  };
  const exact = {
    __verified: true,
    __responseHash: "create-hash",
    data: {
      out_trade_no: order.outTradeNo,
      trade_no: "T-CREATE-100",
      money: "9.90",
      pid: "1000",
      type: "wxpay"
    }
  };
  assert.deepEqual(payment.createOrderResponseMismatches(order, exact, config), []);
  assert.deepEqual(
    payment.createOrderResponseMismatches(
      order,
      Object.assign({}, exact, { data: Object.assign({}, exact.data, { money: "59.90" }) }),
      config
    ),
    ["amountFen"]
  );

  const provider = new payment.XingjuProvider(config);
  provider.execute = async () => exact;
  await assert.rejects(
    () => provider.createOrder(order),
    (error) => {
      assert.equal(error.code, "PAYMENT_LAUNCH_PARAMS_MISSING");
      assert.equal(error.details.recoverySafe, true);
      assert.equal(error.details.providerTradeNo, "T-CREATE-100");
      assert.equal(error.details.providerCreateResponseHash, "create-hash");
      return true;
    }
  );

  provider.execute = async () => Object.assign({}, exact, {
    data: Object.assign({}, exact.data, { out_trade_no: "PAY-WRONG" })
  });
  await assert.rejects(
    () => provider.createOrder(order),
    (error) => error.code === "PAYMENT_PROVIDER_CREATE_MISMATCH"
      && error.details.recoverySafe !== true
  );
});

test("硬终止遗留 created 订单到期后只转 creation_unknown，不重建订单", async () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  const orderId = "order-hard-stop";
  let queryCalls = 0;
  const db = createFakeDb({
    payment_orders: {
      [orderId]: {
        status: "created",
        statusVersion: 1,
        outTradeNo: "PAY00000000000000000000000000002",
        providerTradeNo: "",
        reconcileRequired: true,
        nextReconcileAt: new Date(now.getTime() - 1000),
        reconcileLeaseOwner: "",
        reconcileLeaseToken: "",
        reconcileLeaseEpoch: 0,
        reconcileLeaseUntil: null,
        createClaimToken: "abandoned-create",
        queryAttemptCount: 0,
        notFoundCount: 0,
        createdAt: new Date(now.getTime() - 60 * 1000)
      }
    }
  });
  const provider = {
    config: { pid: "1000" },
    async queryOrder() {
      queryCalls += 1;
      const error = new Error("missing trade_no");
      error.code = "PAYMENT_PROVIDER_QUERY_REFERENCE_MISSING";
      throw error;
    }
  };
  await payment.reconcileOrder({ db, provider, orderId, owner: "worker-hard-stop", now });
  const recovered = db.read("payment_orders", orderId);
  assert.equal(queryCalls, 1);
  assert.equal(recovered.status, "creation_unknown");
  assert.equal(recovered.createClaimToken, "");
  assert.equal(recovered.reconcileRequired, true);
  assert.equal(recovered.creationErrorCode, "PAYMENT_CREATE_COMPLETION_UNKNOWN");
});

test("遗留 review 调度标记会在领取时清理，不再占满候选窗口", async () => {
  const now = new Date("2026-08-30T10:00:00.000Z");
  const orderId = "order-stale-review-schedule";
  const db = createFakeDb({
    payment_orders: {
      [orderId]: {
        status: "review",
        statusVersion: 7,
        reconcileRequired: true,
        nextReconcileAt: new Date(now.getTime() - 1000),
        reconcileLeaseOwner: "",
        reconcileLeaseToken: "",
        reconcileLeaseUntil: null
      }
    }
  });
  const claimed = await payment.claimReconcileLease({
    db,
    orderId,
    owner: "cleanup-worker",
    now
  });
  assert.equal(claimed, null);
  const cleaned = db.read("payment_orders", orderId);
  assert.equal(cleaned.reconcileRequired, false);
  assert.equal(cleaned.nextReconcileAt, null);
});
