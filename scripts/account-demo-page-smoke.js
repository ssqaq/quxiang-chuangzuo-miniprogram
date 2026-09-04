const assert = require("assert");
const path = require("path");

const root = path.resolve(__dirname, "..");
const config = require(path.join(root, "config"));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applySetData(target, patch) {
  Object.entries(patch || {}).forEach(([key, value]) => {
    const parts = key.split(".");
    let cursor = target.data;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor[parts[index]] = cursor[parts[index]] && typeof cursor[parts[index]] === "object"
        ? cursor[parts[index]]
        : {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
  });
}

function loadPage(relative, serviceStub) {
  const pagePath = require.resolve(path.join(root, relative));
  const servicePath = require.resolve(path.join(root, "services", "account.js"));
  const oldPage = global.Page;
  const oldWx = global.wx;
  const oldService = require.cache[servicePath];
  let definition;
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: serviceStub };
  delete require.cache[pagePath];
  global.Page = (value) => { definition = value; };
  let storageCalls = 0;
  global.wx = {
    getStorageSync() { storageCalls += 1; throw new Error("Demo 不得读取存储"); },
    setStorageSync() { storageCalls += 1; throw new Error("Demo 不得写入存储"); },
    removeStorageSync() { storageCalls += 1; throw new Error("Demo 不得清理存储"); },
    showToast() {},
    redirectTo() {},
    navigateTo() {},
    stopPullDownRefresh() {}
  };
  require(pagePath);
  assert.ok(definition, `${relative} 未注册 Page`);
  const page = Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch) { applySetData(this, patch); }
  });
  return {
    page,
    getStorageCalls: () => storageCalls,
    restore() {
      global.Page = oldPage;
      global.wx = oldWx;
      if (oldService) require.cache[servicePath] = oldService;
      else delete require.cache[servicePath];
      delete require.cache[pagePath];
    }
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  const originalProfile = config.buildProfile;
  config.buildProfile = "visual-test";
  const forbiddenService = new Proxy({}, {
    get(_target, property) {
      return () => Promise.reject(new Error(`Demo 调用了真实账户服务：${String(property)}`));
    }
  });
  try {
    const center = loadPage("pages/user-center/user-center.js", forbiddenService);
    try {
      center.page.onLoad({ demo: "1", capture: "1" });
      center.page.onShow();
      await settle();
      assert.strictEqual(center.page.data.visualDemoEnabled, true);
      assert.strictEqual(center.page.data.account.pointsBalanceText, "128.5");
      assert.strictEqual(center.page.data.rechargeVisible, true);
      assert.strictEqual(center.getStorageCalls(), 0);
    } finally { center.restore(); }

    const records = loadPage("pages/account-records/account-records.js", forbiddenService);
    try {
      records.page.onLoad({ demo: "1", capture: "1" });
      await settle();
      assert.strictEqual(records.page.data.summary.pointsBalanceText, "128.5");
      assert.strictEqual(records.page.data.records.length, 5);
      assert.strictEqual(records.getStorageCalls(), 0);
    } finally { records.restore(); }

    const recharge = loadPage("pages/recharge/recharge.js", forbiddenService);
    try {
      recharge.page.onLoad({ demo: "1", capture: "1" });
      await settle();
      assert.strictEqual(recharge.page.data.eligible, true);
      assert.strictEqual(recharge.page.data.hasWxpay, true);
      assert.strictEqual(recharge.page.data.selectedGrantPointsText, "+330");
      await recharge.page.submitPayment();
      assert.strictEqual(recharge.page.data.paymentStatus, "success");
      assert.strictEqual(recharge.page.data.currentBalanceText, "128.5");
      assert.strictEqual(recharge.getStorageCalls(), 0);
    } finally { recharge.restore(); }
    console.log("account demo page smoke: OK (三页零真实服务/存储调用)");
  } finally {
    config.buildProfile = originalProfile;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
