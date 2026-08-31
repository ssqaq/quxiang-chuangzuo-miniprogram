/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.js"), "utf8");
const pageWxml = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxml"), "utf8");
const pageWxss = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxss"), "utf8");

let secretResponse = { ok: true, credentials: { apiKey: "server-key" } };
const providerWrites = [];
let probeCount = 0;
let modelListCount = 0;

const supplier = {
  providerKey: "dashscope",
  name: "阿里云百炼",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  auth: { protocol: "openai", configured: true },
  metadata: { capabilities: ["face"] }
};

const cloudMock = {
  async getAdminConfigV2() {
    return { ok: true, data: { version: 7, suppliers: [supplier], supplierModels: [], bindings: [] } };
  },
  async getAdminProviderSecretsV2() {
    if (secretResponse instanceof Error) throw secretResponse;
    return secretResponse;
  },
  async saveAdminProviderV2(payload) {
    providerWrites.push(payload);
    return { ok: true, version: Number(payload.expectedVersion) + 1 };
  },
  async probeAdminProviderV2() {
    probeCount += 1;
    return { ok: true };
  },
  async listAdminProviderModelsV2() {
    modelListCount += 1;
    return { ok: true, models: [] };
  }
};

global.wx = {
  getWindowInfo() {
    return { windowWidth: 390, statusBarHeight: 47 };
  },
  getMenuButtonBoundingClientRect() {
    return { left: 298, top: 51, right: 385, bottom: 83, width: 87, height: 32 };
  },
  showToast() {},
  showModal() {},
  stopPullDownRefresh() {},
  navigateTo() {},
  navigateBack() {}
};

const cloudPath = require.resolve("../services/cloud");
require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: cloudMock };

function loadPage() {
  let definition = null;
  global.Page = (value) => { definition = value; };
  const pagePath = require.resolve("../pages/admin-provider/admin-provider");
  delete require.cache[pagePath];
  require(pagePath);
  assert.ok(definition, "供应商页未注册 Page");
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data || {})),
    setData(patchValue) {
      Object.assign(this.data, patchValue || {});
    }
  });
}

function input(page, field, value) {
  page.onDraftInput({
    currentTarget: { dataset: { field } },
    detail: { value }
  });
}

function lastWrite() {
  assert.ok(providerWrites.length, "预期至少产生一次供应商保存请求");
  return providerWrites[providerWrites.length - 1];
}

async function freshPage() {
  const page = loadPage();
  await page.loadRegistry();
  await page.loadProviderSecret("dashscope");
  return page;
}

async function run() {
  assert.ok(pageSource.includes("SECRET_FIELDS") && pageSource.includes("secretDirty"), "页面必须显式维护三项凭据 dirty 状态");
  assert.ok(pageSource.includes("clearSecretId") && pageSource.includes("clearSecretKey"), "页面必须支持逐字段清除 TC3 凭据");

  secretResponse = { ok: true, credentials: { apiKey: "server-key", secretId: "server-id", secretKey: "server-secret" } };
  const page = await freshPage();
  assert.strictEqual(page.data.providers.length, 10, "十条模板是固定目录基线，云端同名档案只能覆盖对应模板");
  assert.strictEqual(page.data.draft.apiKey, "server-key", "success(value) 必须显示管理员明文 API Key");
  assert.strictEqual(page.data.draft.tc3.secretId, "server-id", "success(value) 必须显示管理员明文 SecretId");
  assert.strictEqual(page.data.draft.tc3.secretKey, "server-secret", "success(value) 必须显示管理员明文 SecretKey");
  assert.deepStrictEqual(page.data.secretDirty, { apiKey: false, secretId: false, secretKey: false });

  secretResponse = { ok: true, credentials: null };
  await page.loadProviderSecret("dashscope");
  assert.strictEqual(page.data.draft.apiKey, "", "success(null) 必须表达未配置，而不是读取失败");
  assert.strictEqual(page.data.secretReadState, "empty");

  secretResponse = { ok: true, credentials: { apiKey: "last-good", secretId: "last-id", secretKey: "last-secret" } };
  await page.loadProviderSecret("dashscope");
  secretResponse = { ok: false, errorCode: "TEMPORARY_UNAVAILABLE" };
  await page.loadProviderSecret("dashscope");
  assert.strictEqual(page.data.secretReadState, "failure");
  assert.strictEqual(page.data.draft.apiKey, "last-good", "读取失败必须保留上次成功值");
  assert.strictEqual(page.data.draft.tc3.secretId, "last-id", "读取失败不能清空上次 SecretId");
  assert.strictEqual(page.data.draft.tc3.secretKey, "last-secret", "读取失败不能清空上次 SecretKey");

  providerWrites.length = 0;
  await page.saveProvider();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(lastWrite(), "credentials"), false, "未改凭据必须完全 omit credentials");
  ["clearApiKey", "clearSecretId", "clearSecretKey"].forEach((field) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(lastWrite(), field), false, `读取失败后不得误发 ${field}`);
  });

  secretResponse = { ok: true, credentials: { apiKey: "old-key", secretId: "old-id", secretKey: "old-secret" } };
  const updatePage = await freshPage();
  input(updatePage, "apiKey", "new-key");
  providerWrites.length = 0;
  await updatePage.saveProvider();
  assert.deepStrictEqual(lastWrite().credentials, { apiKey: "new-key" }, "只提交真正改过的非空凭据");
  assert.strictEqual(lastWrite().clearApiKey, undefined);

  const clearPage = await freshPage();
  input(clearPage, "apiKey", "");
  input(clearPage, "tc3.secretId", "");
  input(clearPage, "tc3.secretKey", "");
  providerWrites.length = 0;
  await clearPage.saveProvider();
  const clearWrite = lastWrite();
  assert.strictEqual(clearWrite.clearApiKey, true, "清空 API Key 必须发 clearApiKey");
  assert.strictEqual(clearWrite.clearSecretId, true, "清空 SecretId 必须发 clearSecretId");
  assert.strictEqual(clearWrite.clearSecretKey, true, "清空 SecretKey 必须发 clearSecretKey");
  assert.deepStrictEqual(clearWrite.credentials, {
    clearApiKey: true,
    clearSecretId: true,
    clearSecretKey: true
  }, "clear 标志也要放进 wrapper 会转发的 credentials 对象");

  const templateIndex = clearPage.data.providers.findIndex(item => item.isTemplate && /\.example(?:\/|$)/i.test(item.endpoint || ""));
  assert.ok(templateIndex >= 0, "模板基线必须保留 .example 示例端点");
  clearPage.selectProvider({ index: templateIndex });
  const probesBefore = probeCount;
  const listsBefore = modelListCount;
  await clearPage.testConnection();
  await clearPage.fetchModels();
  assert.strictEqual(probeCount, probesBefore, ".example 模板不可执行连接测试");
  assert.strictEqual(modelListCount, listsBefore, ".example 模板不可执行模型获取");

  assert.ok(pageWxml.includes("secret-state") && pageWxml.includes("password=\"{{false}}\""), "管理员页必须显示明文凭据状态且输入框不能掩码");
  assert.ok(pageWxml.includes("item.configured") && !pageWxml.includes("item.enabled ? '已配置' : '未配置'"), "目录状态必须使用凭据 configured，不能把 enabled 当成已配置");
  assert.ok(/\.provider-list\s*\{[^}]*height:\s*992rpx/.test(pageWxss), "供应商列表视口必须固定容纳八行");
  assert.ok(/\.provider-row\.spaced\s*\{[^}]*margin-top:\s*12rpx/.test(pageWxss), "第九条开始必须通过隐藏滚动列表访问，不能挤出首屏");
  assert.ok(/\.provider-row\.active\s*\{[^}]*border:\s*4rpx\s+solid[^}]*padding:\s*6rpx\s+7rpx/.test(pageWxss), "选中供应商必须使用 4rpx 边框并内缩 padding 保持尺寸不变");
  assert.ok(pageWxss.includes("env(safe-area-inset-bottom)"), "底部按钮必须避开系统安全区");
  assert.ok(!/[\uFFFD]/.test(pageSource + pageWxml + pageWxss), "供应商页不能包含替换乱码字符");

  console.log("admin-provider-contract smoke: PASS (tri-state/dirty-omit/explicit-clear/templates/example-guard/390x844)");
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
