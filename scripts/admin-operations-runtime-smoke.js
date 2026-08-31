/* eslint-disable no-console */

const assert = require("assert");

const usage = {
  today: { total: 12, failure: 1, estimatedCost: 2.5 },
  last30d: { total: 120, estimatedCost: 30, unavailableCostCount: 2 },
  days: 30,
  todayKey: "2026-08-31",
  eventCount: 120,
  summary: {
    face: { total: 20, estimatedCost: 1 },
    analysis: { total: 40, estimatedCost: 4 },
    image: { total: 50, estimatedCost: 20 },
    video: { total: 10, estimatedCost: 5 }
  },
  models: [{ provider: "供应商一", model: "模型一", total: 50, estimatedCost: 12 }],
  failureStats: { total: 4, topFailureReasons: [{ label: "超时", count: 2 }] },
  signupTrend: []
};

const users = {
  total: 3,
  users: [{ nickname: "甲", genderText: "男", userHash: "u1" }],
  signupTrend: [{ dateKey: "2026-08-31", count: 2 }]
};

const cloudMock = {
  async getModelUsageStats() { return Object.assign({ ok: true }, usage); },
  async getAdminUserStats() { return Object.assign({ ok: true }, users); },
  async getAdminConfig() { return { ok: true, effective: { points: { dailyFreeLimit: 3, imageCost: 10 } } }; }
};

global.wx = {
  stopPullDownRefresh() {},
  navigateTo() {},
  navigateBack() {},
  showToast() {}
};

const cloudPath = require.resolve("../services/cloud");
require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: cloudMock };

function loadPage() {
  let definition = null;
  global.Page = value => { definition = value; };
  const pagePath = require.resolve("../pages/admin-operations/admin-operations");
  delete require.cache[pagePath];
  require(pagePath);
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch || {}); }
  });
  return page;
}

async function run() {
  const page = loadPage();
  await page.loadData();
  assert.strictEqual(page.data.summary[0].value, "12");
  assert.strictEqual(page.data.detailRows.length, 3);
  page.toggleRow({ currentTarget: { dataset: { index: 0 } } });
  assert.strictEqual(page.data.detailRows[0].expanded, true);

  page.setView("cost", true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(page.data.activeView, "cost");
  assert.strictEqual(page.data.summary[0].value, "¥2.50");

  page.setView("users", true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(page.data.summary[0].value, "3");

  page.setView("points", true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.strictEqual(page.data.empty, false);
  assert.ok(page.data.footNote.includes("没有积分发放、消耗和余额汇总接口"));
  console.log("admin-operations-runtime-smoke: PASS (usage/cost/users/points/views/detail-expand)");
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
