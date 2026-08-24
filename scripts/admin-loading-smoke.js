/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
let usageResolve = null;

const baseConfig = {
  effective: {
    face: {
      provider: "face-provider",
      model: "face-model",
      apiKeyConfigured: true
    },
    analysis: {
      provider: "analysis-provider",
      model: "analysis-model",
      apiKeyConfigured: true
    },
    image: {
      provider: "image-provider",
      model: "image-model",
      apiKeyConfigured: true,
      size: "1024x1024"
    },
    video: {
      provider: "video-provider",
      model: "video-model",
      apiKeyConfigured: true,
      resolution: "720p"
    },
    points: {},
    costs: {}
  },
  defaults: {},
  version: 1
};

const delayedUsage = new Promise((resolve) => {
  usageResolve = resolve;
});

const cloudMock = {
  isCloudReady: () => true,
  getAdminStatus: async () => ({ isAdmin: true }),
  getAdminConfig: async () => baseConfig,
  getModelUsageStats: () => delayedUsage,
  getAdminUserStats: async () => ({
    total: 1,
    maleCount: 1,
    femaleCount: 0,
    maleRatio: 100,
    femaleRatio: 0,
    users: [],
    nextOffset: null
  }),
  getAdminDiagnosticLogs: async () => ({
    retentionHours: 72,
    summary: {
      total: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      userCount: 0,
      categories: []
    },
    userOptions: [],
    logs: [],
    nextOffset: null
  }),
  getAutoFaceFailureStats: async () => ({
    today: 0,
    last7d: 0,
    total30d: 0,
    byType: [],
    recent: []
  }),
  getAutoFaceProbeHistory: async () => ({
    history: [],
    retentionDays: 30
  }),
  listDeploymentLogs: async () => ({ logs: [] })
};

const diagnosticLogMock = {
  info() {},
  warn() {},
  error() {}
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") return cloudMock;
  if (request === "../../utils/diagnostic-log") return diagnosticLogMock;
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  showModal() {},
  showToast() {},
  reLaunch() {},
  stopPullDownRefresh() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "管理员页面没有注册成功");

function createPageInstance() {
  const instance = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    _adminLoadToken: 0,
    setData(patch) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") target[part] = {};
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
    }
  };
  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === "function") {
      instance[key] = pageDefinition[key].bind(instance);
    }
  });
  return instance;
}

async function main() {
  const page = createPageInstance();
  await page.loadAdminPage();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.isAdmin, true);
  assert.strictEqual(page.data.moduleStates.usage.status, "loading");
  assert.strictEqual(page.data.todayFailureText, "读取中");
  assert.strictEqual(page.data.usageStats.today.total, 0);

  usageResolve({
    todayKey: "2026-08-24",
    today: {
      total: 3,
      success: 3,
      failure: 0,
      estimatedCost: 0.000785,
      pricedCost: 0.000785
    },
    last7d: { total: 3, success: 3, failure: 0, estimatedCost: 0.000785 },
    last30d: { total: 3, success: 3, failure: 0, estimatedCost: 0.000785 },
    summary: {},
    daily: [{
      dateKey: "2026-08-24",
      total: 3,
      success: 3,
      failure: 0,
      estimatedCost: 0.000785
    }],
    monthly: [{
      monthKey: "2026-08",
      total: 3,
      estimatedCost: 0.000785,
      analysis: { estimatedCost: 0.000785 }
    }],
    users: [{
      userHash: "user-cost",
      total: 3,
      estimatedCost: 0.000785
    }],
    models: [{
      usageType: "analysis",
      provider: "test",
      model: "cost-model",
      total: 3,
      estimatedCost: 0.000785
    }],
    failureStats: {}
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.strictEqual(page.data.moduleStates.usage.status, "ready");
  assert.strictEqual(page.data.usageStats.today.total, 3);
  assert.strictEqual(page.data.todayFailureText, "0 个失败");
  assert.strictEqual(page.data.usageStats.today.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.today.pricedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.last7d.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.last30d.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.monthly[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.monthly[0].analysis.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.users[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.models[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.costTrend.days[6].costDisplay, "0.0007");
  assert.strictEqual(page.data.costTrend.totalCostDisplay, "0.0007");

  await page.refreshAll();
  assert.strictEqual(page.data.refreshingAll, false);
  assert.strictEqual(page.data.moduleStates.usage.status, "ready");
  assert.strictEqual(page.data.moduleStates.users.status, "ready");
  assert.strictEqual(page.data.moduleStates.diagnosticLogs.status, "ready");
  assert.strictEqual(page.data.moduleStates.autoFaceFailure.status, "ready");
  assert.strictEqual(page.data.moduleStates.probeHistory.status, "ready");
  assert.strictEqual(page.data.moduleStates.logs.status, "ready");
  console.log("admin loading smoke: OK (首屏不等待慢统计)");
}

main().catch((error) => {
  console.error(`admin loading smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
