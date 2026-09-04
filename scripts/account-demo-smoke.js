const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const config = require(path.join(root, "config"));
const accountUi = require(path.join(root, "utils", "account-ui"));
const accountDemo = require(path.join(root, "utils", "account-demo"));

const originalProfile = config.buildProfile;
try {
  config.buildProfile = "production";
  const productionMode = accountDemo.resolve({ demo: "1" });
  assert.strictEqual(productionMode.enabled, false, "生产构建不得启用 demo");
  assert.strictEqual(productionMode.showControl, false, "生产构建不得显示 demo 开关");
  assert.throws(() => accountDemo.createAdapter(), (error) => error.code === "ACCOUNT_DEMO_DISABLED");

  config.buildProfile = "visual-test";
  const visualMode = accountDemo.resolve({ demo: "1", capture: "1" });
  assert.strictEqual(visualMode.enabled, true, "visual-test 构建应启用 demo");
  assert.strictEqual(visualMode.showControl, false, "截图模式应隐藏 demo 开关");
  const adapter = accountDemo.createAdapter();
  return Promise.all([
    adapter.getUserProfile(),
    adapter.getAccountOverview(),
    adapter.getRechargeConfig(),
    adapter.getAccountRecords({ type: "reward" }),
    adapter.getAccountRecords({ type: "all" })
  ]).then(([profile, overview, recharge, rewards, all]) => {
    assert.strictEqual(profile.nickname, "微信用户");
    assert.strictEqual(overview.account.pointsBalance, "128.5");
    assert.strictEqual(recharge.eligible, true);
    assert.deepStrictEqual(recharge.channels, ["wxpay"]);
    assert.strictEqual(rewards.items.length, 1);
    assert.strictEqual(all.items.length, 5);
    assert.strictEqual(accountUi.formatPoints(overview.account.pointsBalance), "128.5");

    const pageSources = [
      "pages/user-center/user-center.js",
      "pages/recharge/recharge.js",
      "pages/account-records/account-records.js"
    ];
    pageSources.forEach((file) => {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      assert(source.includes("accountDemo.resolve"), `${file} 缺少 Demo 双闸门`);
      assert(source.includes("visualDemoControlVisible"), `${file} 缺少 Demo 控件状态`);
    });
    const demoSource = fs.readFileSync(path.join(root, "utils/account-demo.js"), "utf8");
    assert(!/wx\.cloud|requestPayment|apiKey|secret|privateKey/i.test(demoSource), "Demo 适配器不得触碰云函数、支付或密钥");
    console.log("account demo smoke: OK");
  }).finally(() => {
    config.buildProfile = originalProfile;
  });
} catch (error) {
  config.buildProfile = originalProfile;
  throw error;
}
