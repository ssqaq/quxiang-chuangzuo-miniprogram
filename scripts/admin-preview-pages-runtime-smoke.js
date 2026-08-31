/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let cloudCalls = 0;
const navigationUrls = [];
const cloudMock = new Proxy({}, {
  get() {
    return async () => {
      cloudCalls += 1;
      throw new Error("演示模式禁止调用云端接口");
    };
  }
});

global.wx = {
  getWindowInfo() { return { windowWidth: 390, statusBarHeight: 47 }; },
  getMenuButtonBoundingClientRect() { return { left: 298, top: 51, right: 385, bottom: 83, width: 87, height: 32 }; },
  stopPullDownRefresh() {},
  navigateTo(event) { navigationUrls.push(event && event.url || ""); },
  navigateBack() {},
  showToast() {},
  getStorageSync() { return undefined; },
  setStorageSync() {}
};

const cloudPath = require.resolve("../services/cloud");
require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: cloudMock };

[
  "admin-dashboard",
  "admin-operations",
  "admin-config",
  "admin-provider"
].forEach(pageName => {
  const wxmlPath = path.join(__dirname, "..", "pages", pageName, `${pageName}.wxml`);
  const wxml = fs.readFileSync(wxmlPath, "utf8");
  assert.ok(wxml.includes("wx:if=\"{{showDemoControl}}\""), `${pageName} 必须支持按需显示演示开关`);
  assert.ok(wxml.includes("bindtap=\"toggleDemoMode\""), `${pageName} 演示开关必须绑定切换回调`);
});

function loadPage(relativePath) {
  let definition = null;
  global.Page = value => { definition = value; };
  const pagePath = require.resolve(relativePath);
  delete require.cache[pagePath];
  require(pagePath);
  assert.ok(definition, `${relativePath} 未注册 Page`);
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch) { Object.assign(this.data, patch || {}); }
  });
}

async function run() {
  const cases = [
    ["../pages/admin-dashboard/admin-dashboard", {}],
    ["../pages/admin-operations/admin-operations", { view: "usage" }],
    ["../pages/admin-config/admin-config", { group: "standard", tab: "face" }],
    ["../pages/admin-provider/admin-provider", {}]
  ];
  for (const [relativePath, options] of cases) {
    const page = loadPage(relativePath);
    page.onLoad(Object.assign({}, options, { demo: "1" }));
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(page.demoMode, true, `${relativePath} 必须识别 demo=1`);
    assert.strictEqual(page.data.showDemoControl, false, `${relativePath} 默认不应改变右图顶栏`);
    assert.strictEqual(page.data.source, "demo", `${relativePath} 必须使用演示数据`);
    assert.strictEqual(page.data.loading, false, `${relativePath} 演示数据加载必须完成`);
    const cloudCallsBeforeDemoActions = cloudCalls;
    if (relativePath.includes("admin-dashboard")) {
      page.openProvider();
      page.openConfig({ currentTarget: { dataset: { slot: "standard.face" } } });
      page.openMetric({ currentTarget: { dataset: { key: "usage" } } });
    }
    if (relativePath.includes("admin-config")) page.openProvider();
    if (relativePath.includes("admin-provider")) page.openConfig();
    if (relativePath.includes("admin-provider")) {
      await page.moveProvider({ currentTarget: { dataset: { direction: "down" } } });
      await page.saveProvider();
      await page.testConnection();
    }
    assert.strictEqual(cloudCalls, cloudCallsBeforeDemoActions, `${relativePath} 演示模式交互不得调用云端接口`);
    page.toggleDemoMode({ detail: { value: false } });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(page.demoMode, false, `${relativePath} 应允许关闭演示模式`);
    assert.strictEqual(page.data.demoMode, false, `${relativePath} 关闭后应同步页面状态`);
    assert.strictEqual(page.data.source, "local", `${relativePath} 关闭时只能进入本地待刷新状态`);
    assert.strictEqual(cloudCalls, cloudCallsBeforeDemoActions, `${relativePath} 关闭演示的切换动作不得读取云端`);
    const cloudCallsAfterDisable = cloudCalls;
    page.toggleDemoMode({ detail: { value: true } });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(page.demoMode, true, `${relativePath} 应允许重新打开演示模式`);
    assert.strictEqual(page.data.source, "demo", `${relativePath} 重新打开后必须回到演示数据`);
    assert.strictEqual(cloudCalls, cloudCallsAfterDisable, `${relativePath} 重新打开演示模式不得调用云端接口`);
    page.onLoad(Object.assign({}, options, { demo: "1", demoControl: "1" }));
    assert.strictEqual(page.data.showDemoControl, true, `${relativePath} demoControl=1 应显示演示开关`);
  }
  assert.ok(navigationUrls.length >= 5 && navigationUrls.every(url => url.includes("demo=1")), "演示模式页面跳转必须保留 demo=1");
  console.log("admin-preview-pages-runtime-smoke: PASS (four pages, demo toggle and no demo cloud calls)");
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
