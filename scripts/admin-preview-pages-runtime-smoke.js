/* eslint-disable no-console */

const assert = require("assert");

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
    assert.strictEqual(page.data.source, "demo", `${relativePath} 必须使用演示数据`);
    assert.strictEqual(page.data.loading, false, `${relativePath} 演示数据加载必须完成`);
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
  }
  assert.strictEqual(cloudCalls, 0, "四页演示模式不得调用云端接口");
  assert.ok(navigationUrls.length >= 5 && navigationUrls.every(url => url.includes("demo=1")), "演示模式页面跳转必须保留 demo=1");
  console.log("admin-preview-pages-runtime-smoke: PASS (four pages, no cloud calls)");
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
