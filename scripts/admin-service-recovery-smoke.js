/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
let adminStatusMode = "service-timeout";
let adminStatusCalls = 0;
let usageCalls = 0;
let usageResolve = null;
let reLaunchCount = 0;
let modalCount = 0;

const baseConfig = {
  effective: {
    face: { provider: "face", model: "face", apiKey: "face-key", apiKeyConfigured: true },
    analysis: { provider: "analysis", model: "analysis", apiKey: "analysis-key", apiKeyConfigured: true },
    image: {
      provider: "xingju",
      model: "jw-gpt-image-2",
      apiKey: "image-key",
      apiKeyConfigured: true,
      mode: "images"
    },
    imageBackup: {
      provider: "lingyun",
      model: "gpt-image-2",
      apiKey: "backup-key",
      apiKeyConfigured: true,
      mode: "edits"
    },
    video: { provider: "video", model: "video", apiKey: "video-key", apiKeyConfigured: true },
    points: {},
    costs: {}
  },
  defaults: {},
  version: 1
};

function serviceError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status || 0;
  error.payload = {
    errorCode: code,
    message,
    status: status || 0,
    requestId: "admin-recovery-smoke"
  };
  return error;
}

const cloudMock = {
  isCloudReady: () => true,
  getAdminStatus: async () => {
    adminStatusCalls += 1;
    if (adminStatusMode === "service-timeout") {
      throw serviceError("ADMIN_LOAD_TIMEOUT", "管理员权限超过8秒未返回");
    }
    if (adminStatusMode === "service-503") {
      throw serviceError("SERVER_ERROR", "upstream unavailable", 503);
    }
    if (adminStatusMode === "permission") {
      return { isAdmin: false, identityHash: "identity-hash" };
    }
    return { isAdmin: true, identityHash: "identity-hash" };
  },
  getAdminConfig: async () => baseConfig,
  getAdminImageApiKeys: async () => ({
    image: { apiKey: "image-key" },
    imageBackup: { apiKey: "backup-key" }
  }),
  getAdminGenerationQueue: async () => ({
    snapshot: { total: 0, counts: {}, kinds: {} },
    tasks: []
  }),
  getModelUsageStats: () => {
    usageCalls += 1;
    if (usageResolve) {
      return new Promise((resolve) => {
        usageResolve = resolve;
      });
    }
    return Promise.resolve({
      today: { total: 0, success: 0, failure: 0 },
      daily: [],
      monthly: [],
      users: [],
      models: [],
      failureStats: {}
    });
  },
  getImageProviderFailoverStats: async () => ({}),
  getAdminConfigAuditLogs: async () => ({ logs: [] }),
  getAdminUserStats: async () => ({ users: [], nextOffset: null }),
  getAdminDiagnosticLogs: async () => ({
    retentionHours: 72,
    summary: { total: 0, errorCount: 0, warnCount: 0, infoCount: 0, userCount: 0 },
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
  getAutoFaceProbeHistory: async () => ({ history: [], retentionDays: 30 }),
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
  showModal(options = {}) {
    modalCount += 1;
    if (typeof options.success === "function") options.success();
  },
  showToast() {},
  reLaunch() {
    reLaunchCount += 1;
  },
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

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function main() {
  let page = createPageInstance();
  await page.loadAdminPage();
  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(
    page.data.message,
    "管理员服务暂时不可用，请稍后点击重新读取。"
  );
  assert.strictEqual(reLaunchCount, 0, "服务异常不能跳离管理员页面");

  adminStatusMode = "service-503";
  page = createPageInstance();
  await page.loadAdminPage();
  assert.strictEqual(page.data.canRetry, true);
  assert.strictEqual(
    page.data.message,
    "管理员服务暂时不可用，请稍后点击重新读取。"
  );
  assert.strictEqual(reLaunchCount, 0, "503 不能被误判成无权限并跳转");

  adminStatusMode = "recover";
  page = createPageInstance();
  await page.loadAdminPage();
  await tick();
  assert.strictEqual(page.data.isAdmin, true);
  assert.strictEqual(page.data.canRetry, false);
  assert.strictEqual(page.data.message, "");
  assert.ok(adminStatusCalls >= 3, "没有覆盖失败后重新读取成功路径");

  adminStatusMode = "permission";
  page = createPageInstance();
  const launchesBeforePermission = reLaunchCount;
  await page.loadAdminPage();
  assert.strictEqual(page.data.canRetry, false);
  assert.ok(page.data.message.includes("没有管理员权限"));
  assert.strictEqual(modalCount > 0, true);
  assert.strictEqual(reLaunchCount, launchesBeforePermission + 1);

  page = createPageInstance();
  page.data.isAdmin = true;
  page._adminLoadToken = 1;
  page.data.moduleStates = Object.keys(page.data.moduleStates).reduce((states, key) => {
    states[key] = {
      status: "ready",
      label: "已读取",
      hasData: true,
      message: "",
      errorCategory: "",
      canRetry: false,
      updatedAtText: "刚刚"
    };
    return states;
  }, {});
  const moduleResult = await page.loadAdminModule(
    1,
    "usage",
    async () => {
      throw serviceError("SERVER_ERROR", "usage service unavailable", 503);
    },
    (value) => value,
    (value) => ({ usageStats: value }),
    { label: "模型用量和成本", timeoutMs: 30 }
  );
  assert.strictEqual(moduleResult.ok, false);
  assert.strictEqual(moduleResult.category, "service");
  assert.strictEqual(page.data.moduleStates.usage.errorCategory, "service");
  assert.strictEqual(page.data.moduleStates.usage.canRetry, true);
  assert.strictEqual(
    page.data.moduleStates.usage.message,
    "管理员服务暂时不可用，请点击刷新。"
  );
  assert.strictEqual(page.data.moduleStates.users.status, "ready");
  assert.strictEqual(reLaunchCount, launchesBeforePermission + 1);

  page = createPageInstance();
  page.data.isAdmin = true;
  page._adminLoadToken = 1;
  usageResolve = null;
  usageCalls = 0;
  const pendingUsage = new Promise((resolve) => {
    usageResolve = resolve;
  });
  cloudMock.getModelUsageStats = () => {
    usageCalls += 1;
    return pendingUsage;
  };
  const firstRefresh = page.refreshAll();
  const secondRefresh = page.refreshAll();
  assert.strictEqual(
    await secondRefresh,
    undefined,
    "重复点击刷新没有被去重"
  );
  assert.strictEqual(usageCalls, 1);
  usageResolve({
    today: { total: 0, success: 0, failure: 0 },
    daily: [],
    monthly: [],
    users: [],
    models: [],
    failureStats: {}
  });
  await firstRefresh;
  assert.strictEqual(page.data.refreshingAll, false);
  assert.strictEqual(page.data.canRetry, false);
  console.log("admin service recovery smoke: OK");
}

main().catch((error) => {
  console.error(`管理员服务恢复 smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
