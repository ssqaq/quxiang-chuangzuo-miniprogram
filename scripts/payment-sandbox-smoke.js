/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const rechargePath = require.resolve(path.join(root, "pages", "recharge", "recharge.js"));
const accountPath = require.resolve(path.join(root, "services", "account.js"));
const launcherPath = require.resolve(path.join(root, "services", "payment-launcher.js"));

function loadPage(options = {}) {
  const oldPage = global.Page;
  const oldWx = global.wx;
  const oldAccount = require.cache[accountPath];
  const oldLauncher = require.cache[launcherPath];
  const oldRecharge = require.cache[rechargePath];
  const products = [{ productId: "pkg_2990", amountFen: 2990, amountText: "¥29.9", grantPoints: 330 }];
  const calls = { create: [], query: [], launch: 0 };
  let stored = options.initialStored || null;
  let definition;
  const accountStub = {
    getRechargeConfig: async () => options.config || { eligible: true, channels: ["wxpay"], products },
    createRequestId: () => "sandbox-request-1",
    createRechargeOrder: async (payload) => {
      calls.create.push(payload);
      if (options.createError) throw options.createError;
      return options.createResult || {
        order: { orderNo: "sandbox-order-1", status: "pending", channel: "wxpay" },
        payment: { timeStamp: "1", nonceStr: "n", package: "prepay_id=p", signType: "RSA", paySign: "s" }
      };
    },
    queryRechargeOrder: async (orderNo) => {
      calls.query.push(orderNo);
      if (options.queryError) throw options.queryError;
      return options.queryResult || {
        order: { orderNo, status: "fulfilled", grantPoints: 330 },
        account: { pointsBalance: 458 }
      };
    }
  };
  const launcherStub = {
    launchPayment: async () => {
      calls.launch += 1;
      if (options.launchError) throw options.launchError;
      return { errMsg: "requestPayment:ok" };
    }
  };
  global.Page = (value) => { definition = value; };
  global.wx = {
    getStorageSync: () => stored,
    setStorageSync: (_key, value) => { stored = Object.assign({}, value); },
    removeStorageSync: () => { stored = null; },
    showToast: () => {},
    stopPullDownRefresh: () => {}
  };
  require.cache[accountPath] = { id: accountPath, filename: accountPath, loaded: true, exports: accountStub };
  require.cache[launcherPath] = { id: launcherPath, filename: launcherPath, loaded: true, exports: launcherStub };
  delete require.cache[rechargePath];
  require(rechargePath);
  const page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data, { packages: products, selectedProductId: products[0].productId }),
    setData(patch) { Object.assign(this.data, patch); }
  });
  page._pendingOrder = stored ? Object.assign({}, stored) : null;
  return {
    page,
    calls,
    getStored: () => stored,
    restore() {
      global.Page = oldPage;
      global.wx = oldWx;
      if (oldAccount) require.cache[accountPath] = oldAccount; else delete require.cache[accountPath];
      if (oldLauncher) require.cache[launcherPath] = oldLauncher; else delete require.cache[launcherPath];
      if (oldRecharge) require.cache[rechargePath] = oldRecharge; else delete require.cache[rechargePath];
    }
  };
}

async function successCase() {
  const loaded = loadPage();
  try {
    await loaded.page.loadRechargeConfig();
    const result = await loaded.page.submitPayment();
    assert.strictEqual(loaded.calls.create.length, 1);
    assert.deepStrictEqual(loaded.calls.create[0], { requestId: "sandbox-request-1", productId: "pkg_2990" });
    assert.strictEqual(loaded.calls.launch, 1);
    assert.strictEqual(loaded.calls.query.length, 1);
    assert.strictEqual(loaded.page.data.paymentStatus, "success");
    assert.strictEqual(loaded.page.data.currentBalanceText, "458");
    assert.strictEqual(result, undefined);
  } finally { loaded.restore(); }
}

async function canceledReuseCase() {
  const error = Object.assign(new Error("cancelled"), { code: "PAYMENT_CANCELED", canceled: true });
  const loaded = loadPage({ launchError: error });
  try {
    await loaded.page.loadRechargeConfig();
    await loaded.page.submitPayment();
    await loaded.page.submitPayment();
    assert.deepStrictEqual(loaded.calls.create.map((item) => item.requestId), ["sandbox-request-1", "sandbox-request-1"]);
    assert.strictEqual(loaded.page.data.paymentStatus, "canceled");
    assert.ok(loaded.getStored() && loaded.getStored().requestId === "sandbox-request-1");
  } finally { loaded.restore(); }
}

async function gateCase() {
  const loaded = loadPage({ config: { eligible: false, channels: [], products: [], message: "充值暂未开放" } });
  try {
    await loaded.page.loadRechargeConfig();
    await loaded.page.submitPayment();
    assert.strictEqual(loaded.calls.create.length, 0);
    assert.strictEqual(loaded.calls.launch, 0);
    assert.strictEqual(loaded.page.data.eligible, false);
  } finally { loaded.restore(); }
}

async function main() {
  const source = fs.readFileSync(path.join(root, "services", "account.js"), "utf8");
  assert.ok(source.includes('channel: "wxpay"'), "服务层必须固定 wxpay");
  assert.ok(!/amountFen|grantPoints|balanceAfter|expectedBalance/.test(source.slice(source.indexOf("createRechargeOrder"), source.indexOf("queryRechargeOrder"))), "客户端不得提交金额或余额");
  await successCase();
  await canceledReuseCase();
  await gateCase();
  console.log("payment sandbox smoke: OK (本地 mock，无云端/真实支付调用)");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
