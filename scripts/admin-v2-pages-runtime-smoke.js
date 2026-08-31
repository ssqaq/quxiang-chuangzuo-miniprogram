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

const bindingWrites = [];
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
  async saveAdminBindingV2(payload) {
    bindingWrites.push(payload);
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

async function run() {
  const configPage = loadPage("../pages/admin-config/admin-config");
  configPage.initialGroup = "standard";
  configPage.initialTab = "face";
  await configPage.loadConfig();
  await configPage.loadVisibleSecrets();
  assert.deepStrictEqual(configPage.data.selectedTab.modelOptions, ["confirmed-face"]);
  assert.ok(!configPage.data.selectedTab.modelOptions.includes("pending-face"));
  assert.strictEqual(configPage.data.configuredCount, 1);
  assert.strictEqual(configPage.data.totalCount, 4);
  assert.strictEqual(configPage.data.backupCount, 1);
  assert.strictEqual(configPage.data.selectedTab.endpoint, "https://one.example/v1");
  assert.strictEqual(configPage.data.selectedTab.backupEndpoint, "https://two.example/v1");
  assert.strictEqual(configPage.data.selectedTab.keyText, visibleKeyOne);
  assert.strictEqual(configPage.data.selectedTab.backupKeyText, "测试明文二号");
  assert.strictEqual(configPage.data.selectedTab.timeout, 42);
  assert.strictEqual(configPage.data.selectedTab.retry, 2);
  await configPage.saveCurrent();
  assert.strictEqual(bindingWrites.length, 2);
  assert.strictEqual(bindingWrites[0].expectedVersion, 12);
  assert.strictEqual(bindingWrites[1].expectedVersion, 13);
  assert.deepStrictEqual(bindingWrites[0].binding.metadata, { path: "/v1/chat/completions", timeout: 42, retry: 2, resolution: "1K", aspectRatio: "3:4" });

  configPage.onMainProviderChange({ detail: { value: 1 } });
  assert.strictEqual(configPage.data.selectedTab.providerKey, "two");
  assert.strictEqual(configPage.data.selectedTab.backupEnabled, false, "主供应商切换为原备用供应商后必须清空备用配置");
  assert.strictEqual(configPage.data.selectedTab.backupProviderKey, "");

  configPage.selectTab({ currentTarget: { dataset: { groupIndex: 2, tabIndex: 0 } } });
  assert.strictEqual(configPage.data.configuredCount, 1);
  assert.strictEqual(configPage.data.totalCount, 1);
  assert.strictEqual(configPage.data.backupCount, 1);

  const dashboardPage = loadPage("../pages/admin-dashboard/admin-dashboard");
  await dashboardPage.loadConfig();
  assert.strictEqual(dashboardPage.data.configuredCount, 1, "备用绑定不能重复计入控制台就绪数");

  const providerPage = loadPage("../pages/admin-provider/admin-provider");
  await providerPage.loadRegistry();
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
  assert.deepStrictEqual(providerWrites[0].order, ["two", "one", "tc3"]);
  assert.strictEqual(providerWrites[0].expectedVersion, 13);

  const originalGetConfig = cloudMock.getAdminConfigV2;
  const originalSaveProvider = cloudMock.saveAdminProviderV2;
  const originalListModels = cloudMock.listAdminProviderModelsV2;
  cloudMock.getAdminConfigV2 = async () => null;
  cloudMock.saveAdminProviderV2 = async () => { throw new Error("offline"); };
  cloudMock.listAdminProviderModelsV2 = async () => ({ ok: true, models: [] });
  const offlineProviderPage = loadPage("../pages/admin-provider/admin-provider");
  await offlineProviderPage.loadRegistry();
  assert.deepStrictEqual(offlineProviderPage.data.providers, [], "接口失败时不得显示演示供应商");
  offlineProviderPage.setData({
    draft: Object.assign({}, offlineProviderPage.data.draft, {
      providerKey: "offline",
      name: "离线草稿",
      endpoint: "https://offline.example/v1",
      apiKey: "只存在页面草稿"
    })
  });
  await offlineProviderPage.fetchModels();
  assert.deepStrictEqual(offlineProviderPage.data.fetchedModels, [], "接口空结果时不得伪造模型");
  assert.strictEqual(offlineProviderPage.data.modelPickerOpen, false);
  await offlineProviderPage.saveProvider();
  assert.deepStrictEqual(offlineProviderPage.data.providers, [], "云端保存失败时不得假装新增供应商");
  assert.ok(offlineProviderPage.data.message.includes("保存失败"));
  cloudMock.getAdminConfigV2 = originalGetConfig;
  cloudMock.saveAdminProviderV2 = originalSaveProvider;
  cloudMock.listAdminProviderModelsV2 = originalListModels;

  console.log("admin-v2-pages-runtime-smoke: PASS (confirmed-models/group-summary/plaintext-secrets/TC3/CAS/reorder/primary-count/fail-closed)");
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
