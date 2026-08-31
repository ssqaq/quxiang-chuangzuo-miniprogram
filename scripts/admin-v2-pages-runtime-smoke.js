/* eslint-disable no-console */

const assert = require("assert");

const visibleKeyOne = "测试明文一号";
const visibleTc3Key = "测试明文腾讯";

const suppliers = [
  {
    providerKey: "one",
    name: "一号供应商",
    endpoint: "https://one.example/v1",
    auth: { protocol: "openai", configured: true },
    metadata: { capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration", "video"] }
  },
  {
    providerKey: "two",
    name: "二号供应商",
    endpoint: "https://two.example/v1",
    auth: { protocol: "openai", configured: true },
    metadata: { capabilities: ["face", "video"] }
  },
  {
    providerKey: "tc3",
    name: "腾讯云",
    endpoint: "",
    auth: {
      protocol: "tencent-tc3",
      configured: true,
      extra: {
        region: "ap-guangzhou",
        endpoint: "ft.tencentcloudapi.com",
        version: "2020-03-04",
        action: "FuseFace"
      }
    },
    metadata: { capabilities: ["face"] }
  }
];

const supplierModels = [
  { providerKey: "one", modelId: "confirmed-face", capabilities: ["face"], confirmed: true },
  { providerKey: "one", modelId: "pending-face", capabilities: ["face"], confirmed: false },
  { providerKey: "one", modelId: "confirmed-video", capabilities: ["video"], confirmed: true },
  { providerKey: "two", modelId: "backup-face", capabilities: ["face"], confirmed: true },
  { providerKey: "two", modelId: "backup-video", capabilities: ["video"], confirmed: true }
];

const bindings = [
  { slot: "standard.face", role: "primary", providerKey: "one", modelId: "confirmed-face", status: "ready", metadata: { timeout: 42, retry: 2 } },
  { slot: "standard.face", role: "backup", providerKey: "two", modelId: "backup-face", status: "ready" },
  { slot: "shared.video", role: "primary", providerKey: "one", modelId: "confirmed-video", status: "ready" },
  { slot: "shared.video", role: "backup", providerKey: "two", modelId: "backup-video", status: "ready" }
];

const slotWrites = [];
const providerWrites = [];
const modelWrites = [];

const cloudMock = {
  async getAdminConfigV2() {
    return { ok: true, data: { version: 12, suppliers, supplierModels, bindings } };
  },
  async getAdminProviderSecretsV2(providerKey) {
    return {
      ok: true,
      providerKey,
      credentials: providerKey === "tc3"
        ? { secretId: "测试标识腾讯", secretKey: visibleTc3Key }
        : { apiKey: providerKey === "one" ? visibleKeyOne : "测试明文二号" }
    };
  },
  async saveAdminSlotV2(payload) {
    slotWrites.push(payload);
    return { ok: true, version: Number(payload.expectedVersion) + 1 };
  },
  async saveAdminProviderV2(payload) {
    providerWrites.push(payload);
    return { ok: true, version: Number(payload.expectedVersion) + 1 };
  },
  async confirmAdminModelsV2(payload) {
    modelWrites.push(payload);
    return { ok: true, version: Number(payload.expectedVersion) + 1 };
  }
};

global.wx = {
  getWindowInfo() {
    return { windowWidth: 390, statusBarHeight: 47 };
  },
  getMenuButtonBoundingClientRect() {
    return { left: 298, top: 51, right: 385, bottom: 83, width: 87, height: 32 };
  },
  stopPullDownRefresh() {},
  navigateTo() {},
  navigateBack() {},
  showToast() {}
};

const cloudPath = require.resolve("../services/cloud");
require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: cloudMock };

function loadPage(relativePath) {
  let definition = null;
  global.Page = (value) => { definition = value; };
  const pagePath = require.resolve(relativePath);
  delete require.cache[pagePath];
  require(pagePath);
  assert.ok(definition, `${relativePath} 未注册 Page`);
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patch) {
      Object.assign(this.data, patch || {});
    }
  });
  return page;
}

function assertAllSectionsCollapsed(page, stage) {
  assert.strictEqual(page.data.mainExpanded, false, `${stage}主模型必须默认收起`);
  assert.strictEqual(page.data.backupExpanded, false, `${stage}备用模型必须默认收起`);
  assert.strictEqual(page.data.advancedExpanded, false, `${stage}高级参数必须默认收起`);
}

async function run() {
  const configPage = loadPage("../pages/admin-config/admin-config");
  assertAllSectionsCollapsed(configPage, "页面初始化时");
  configPage.applyNavigationLayout();
  assert.ok(configPage.data.appbarStyle.includes("height:99px"), "导航总高度必须按状态栏、胶囊和右图导航基准计算");
  assert.ok(configPage.data.appbarStyle.includes("padding-right:100px"), "导航右侧必须给微信胶囊留出空间");
  assert.strictEqual(configPage.data.configScrollStyle, "height:calc(100vh - 99px)", "滚动区高度必须扣掉实测导航高度");
  ["toggleMain", "toggleBackup", "toggleAdvanced"].forEach((method, index) => {
    const field = ["mainExpanded", "backupExpanded", "advancedExpanded"][index];
    configPage[method]();
    assert.strictEqual(configPage.data[field], true, `${method} 第一次点击必须展开`);
    configPage[method]();
    assert.strictEqual(configPage.data[field], false, `${method} 第二次点击必须收起`);
  });
  configPage.initialGroup = "standard";
  configPage.initialTab = "face";
  await configPage.loadConfig();
  await configPage.loadVisibleSecrets();
  assertAllSectionsCollapsed(configPage, "真实配置加载后");
  assert.deepStrictEqual(configPage.data.selectedTab.modelOptions, ["confirmed-face"]);
  assert.ok(!configPage.data.selectedTab.modelOptions.includes("pending-face"));
  assert.deepStrictEqual(configPage.data.groups[0].tabs.map(tab => tab.slot), ["standard.face", "standard.imageAnalysis", "standard.styleAnalysis", "standard.imageGeneration"]);
  assert.strictEqual(configPage.data.configuredCount, 1);
  assert.strictEqual(configPage.data.totalCount, 4);
  assert.strictEqual(configPage.data.backupCount, 1);
  assert.strictEqual(configPage.data.selectedTab.backupTitle, "备用人脸识别模型");
  assert.strictEqual(configPage.data.selectedTab.endpoint, "https://one.example/v1");
  assert.strictEqual(configPage.data.selectedTab.backupEndpoint, "https://two.example/v1");
  assert.strictEqual(configPage.data.selectedTab.keyText, "已保存 · 明文仅管理员可见");
  assert.strictEqual(configPage.data.selectedTab.backupKeyText, "已保存 · 明文仅管理员可见");
  assert.strictEqual(configPage.data.selectedTab.timeout, 42);
  assert.strictEqual(configPage.data.selectedTab.retry, 2);
  const savedBackupProviderKey = configPage.data.selectedTab.backupProviderKey;
  const savedBackupModel = configPage.data.selectedTab.backupModel;
  configPage.onBackupEnabledChange({ detail: {} });
  assert.strictEqual(configPage.data.selectedTab.backupEnabled, false);
  assert.strictEqual(configPage.data.selectedTab.backupProviderKey, savedBackupProviderKey, "关闭备用时必须保留供应商");
  assert.strictEqual(configPage.data.selectedTab.backupModel, savedBackupModel, "关闭备用时必须保留模型");
  configPage.onBackupEnabledChange({ detail: {} });
  assert.strictEqual(configPage.data.selectedTab.backupEnabled, true);
  const firstSave = configPage.saveCurrent();
  const duplicateSave = configPage.saveCurrent();
  await Promise.all([firstSave, duplicateSave]);
  assert.strictEqual(slotWrites.length, 1, "同一功能的主备必须一次原子保存");
  assert.strictEqual(slotWrites[0].expectedVersion, 12);
  assert.strictEqual(slotWrites[0].slot, "standard.face");
  assert.deepStrictEqual(slotWrites[0].primaryPatch.metadata, { path: "/v1/chat/completions", timeout: 42, retry: 2, resolution: "1K", aspectRatio: "3:4", keepExistingKey: true, validateBeforeSave: true });
  assert.strictEqual(slotWrites[0].backupPatch.providerKey, "two");
  assert.strictEqual(slotWrites[0].backupPatch.modelId, "backup-face");
  assert.strictEqual(slotWrites[0].backupPatch.status, "ready");
  assert.deepStrictEqual(slotWrites[0].advancedPatch, {});
  assert.ok(!JSON.stringify(slotWrites[0]).includes(visibleKeyOne), "功能保存不得携带 API Key");
  assert.strictEqual(configPage.data.currentVersion, 13);
  assert.strictEqual(configPage.data.saving, false, "保存完成后必须释放按钮锁");

  configPage.selectTab({ currentTarget: { dataset: { groupIndex: 0, tabIndex: 3 } } });
  assert.strictEqual(configPage.data.selectedTab.mode, "edits", "旧生图数据缺 mode 时必须使用默认值");
  assert.strictEqual(configPage.data.selectedTab.modeLabel, "图片编辑模式");
  assert.strictEqual(configPage.data.selectedTab.size, "1080x1440", "旧生图数据缺 size 时必须使用默认值");
  assert.strictEqual(configPage.data.selectedTab.sizeLabel, "照片：1080×1440");
  await configPage.saveCurrent();
  assert.strictEqual(slotWrites.length, 2);
  assert.strictEqual(slotWrites[1].expectedVersion, 13);
  assert.strictEqual(slotWrites[1].slot, "standard.imageGeneration");
  assert.deepStrictEqual(slotWrites[1].advancedPatch, { mode: "edits", size: "1080x1440" });
  assert.strictEqual(configPage.data.currentVersion, 14);

  configPage.selectTab({ currentTarget: { dataset: { groupIndex: 0, tabIndex: 0 } } });

  configPage.onMainProviderChange({ detail: { value: 1 } });
  assert.strictEqual(configPage.data.selectedTab.providerKey, "two");
  assert.strictEqual(configPage.data.selectedTab.backupEnabled, false, "主供应商切换为原备用供应商后必须清空备用配置");
  assert.strictEqual(configPage.data.selectedTab.backupProviderKey, "");

  configPage.setData({ mainExpanded: true, backupExpanded: true, advancedExpanded: true });
  configPage.selectTab({ currentTarget: { dataset: { groupIndex: 2, tabIndex: 0 } } });
  assertAllSectionsCollapsed(configPage, "切换功能后");
  assert.deepStrictEqual(configPage.data.groups[2].tabs.map(tab => tab.slot), ["shared.video"]);
  assert.strictEqual(configPage.data.configuredCount, 1);
  assert.strictEqual(configPage.data.totalCount, 1);
  assert.strictEqual(configPage.data.backupCount, 1);

  const originalSaveSlot = cloudMock.saveAdminSlotV2;
  const failedPage = loadPage("../pages/admin-config/admin-config");
  failedPage.initialGroup = "standard";
  failedPage.initialTab = "face";
  await failedPage.loadConfig();
  failedPage.setData({ currentVersion: 30 });
  const failedWrites = [];
  cloudMock.saveAdminSlotV2 = async payload => {
    failedWrites.push(payload);
    throw new Error("atomic slot offline");
  };
  await failedPage.saveCurrent();
  assert.strictEqual(failedWrites.length, 1);
  assert.strictEqual(failedPage.data.currentVersion, 30, "原子保存失败时版本不得前移");
  assert.ok(failedPage.data.message.includes("主备配置均未更改"));
  assert.strictEqual(failedPage.data.saving, false);
  cloudMock.saveAdminSlotV2 = originalSaveSlot;

  const originalSecretGetter = cloudMock.getAdminProviderSecretsV2;
  cloudMock.getAdminProviderSecretsV2 = async () => { throw new Error("secret offline"); };
  const secretFailurePage = loadPage("../pages/admin-config/admin-config");
  secretFailurePage.initialGroup = "standard";
  secretFailurePage.initialTab = "face";
  await secretFailurePage.loadConfig();
  await secretFailurePage.loadVisibleSecrets();
  assert.strictEqual(secretFailurePage.data.selectedTab.keyLoadState, "failure");
  assert.ok(secretFailurePage.data.selectedTab.keyText.includes("读取失败"), "密钥读取失败不得误显示为尚未配置");
  cloudMock.getAdminProviderSecretsV2 = async providerKey => ({ ok: true, providerKey, credentials: {} });
  const secretEmptyPage = loadPage("../pages/admin-config/admin-config");
  secretEmptyPage.initialGroup = "standard";
  secretEmptyPage.initialTab = "face";
  await secretEmptyPage.loadConfig();
  await secretEmptyPage.loadVisibleSecrets();
  assert.strictEqual(secretEmptyPage.data.selectedTab.keyLoadState, "success");
  assert.strictEqual(secretEmptyPage.data.selectedTab.keyText, "尚未配置");
  cloudMock.getAdminProviderSecretsV2 = originalSecretGetter;

  const dashboardPage = loadPage("../pages/admin-dashboard/admin-dashboard");
  await dashboardPage.loadConfig();
  assert.strictEqual(dashboardPage.data.configuredCount, 2, "控制台必须统计八项主功能和共享视频，备用绑定不能重复计入");
  assert.strictEqual(dashboardPage.data.totalCount, 9, "控制台总数必须包含八项主功能和共享视频");

  const providerPage = loadPage("../pages/admin-provider/admin-provider");
  providerPage.applyNavigationLayout();
  assert.ok(providerPage.data.appbarStyle.includes("height:99px"));
  assert.strictEqual(providerPage.data.providerScrollStyle, "height:calc(100vh - 99px)");
  await providerPage.loadRegistry();
  assert.strictEqual(providerPage.data.providers.length, 12, "三条云端档案后应按名称去重补齐未保存模板，保证目录可滚动且首屏铺满");
  assert.strictEqual(providerPage.data.providers.slice(3).every(item => item.isTemplate && item.enabled === false), true);
  assert.strictEqual(providerPage.data.providers.slice(0, 3).every(item => item.configured === true), true, "目录已配置状态必须来自 auth.configured");
  assert.strictEqual(providerPage.data.providers.slice(3).every(item => item.configured === false), true, "未保存模板即使带默认能力也必须显示未配置");
  assert.strictEqual(providerPage.data.providers.filter(item => item.name === "腾讯云").length, 1, "同名云端档案与目录模板不能重复显示");
  assert.deepStrictEqual(providerPage.data.providers[0].capabilityRows, ["人脸识别 · 图片分析", "网感分析 · 生图模型", "视频模型"]);
  assert.strictEqual(providerPage.data.providers[2].authProtocol, "tencent-tc3");
  assert.strictEqual(providerPage.data.providers[2].tc3.apiVersion, "2020-03-04");
  await providerPage.loadProviderSecret("one");
  assert.strictEqual(providerPage.data.draft.apiKey, visibleKeyOne);
  providerPage.setData({ selectedFetchedModel: "confirmed-face" });
  await providerPage.confirmModel();
  assert.strictEqual(modelWrites[0].expectedVersion, 12);
  assert.strictEqual(providerPage.data.currentVersion, 13);
  await providerPage.moveProvider({ currentTarget: { dataset: { direction: "down" } } });
  assert.deepStrictEqual(providerWrites[0].order, ["two", "one", "tc3"], "目录模板不得写入云端排序");
  assert.strictEqual(providerWrites[0].expectedVersion, 13);

  const originalGetConfig = cloudMock.getAdminConfigV2;
  const originalSaveProvider = cloudMock.saveAdminProviderV2;
  const originalListModels = cloudMock.listAdminProviderModelsV2;
  cloudMock.getAdminConfigV2 = async () => null;
  cloudMock.saveAdminProviderV2 = async () => { throw new Error("offline"); };
  cloudMock.listAdminProviderModelsV2 = async () => ({ ok: true, models: [] });
  const offlineProviderPage = loadPage("../pages/admin-provider/admin-provider");
  await offlineProviderPage.loadRegistry();
  assert.strictEqual(offlineProviderPage.data.providers.length, 10, "接口失败时仍显示十个未配置模板，避免目录空白");
  assert.strictEqual(offlineProviderPage.data.providers.every(item => item.isTemplate && item.enabled === false), true);
  offlineProviderPage.setData({
    draft: Object.assign({}, offlineProviderPage.data.draft, {
      providerKey: "offline",
      name: "离线草稿",
      endpoint: "https://offline.invalid/v1",
      apiKey: "只存在页面草稿"
    })
  });
  await offlineProviderPage.fetchModels();
  assert.deepStrictEqual(offlineProviderPage.data.fetchedModels, [], "接口空结果时不得伪造模型");
  assert.strictEqual(offlineProviderPage.data.modelPickerOpen, false);
  await offlineProviderPage.saveProvider();
  assert.strictEqual(offlineProviderPage.data.providers.some(item => item.providerKey === "offline"), false, "云端保存失败时不得假装新增供应商");
  assert.ok(offlineProviderPage.data.message.includes("保存失败"));
  cloudMock.getAdminConfigV2 = originalGetConfig;
  cloudMock.saveAdminProviderV2 = originalSaveProvider;
  cloudMock.listAdminProviderModelsV2 = originalListModels;

  console.log("admin-v2-pages-runtime-smoke: PASS (collapsed-sections/confirmed-models/atomic-slot-save/image-advanced/secret-tristate/backup-retention/reorder/fail-closed)");
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
