/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pageSource = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.js"), "utf8");
const pageWxml = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxml"), "utf8");
const pageWxss = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxss"), "utf8");

function getLastCssRule(selector) {
  const marker = `${selector} {`;
  const start = pageWxss.lastIndexOf(marker);
  assert.ok(start >= 0, `缺少最终样式规则：${selector}`);
  const open = pageWxss.indexOf("{", start);
  const close = pageWxss.indexOf("}", open);
  assert.ok(open >= 0 && close > open, `最终样式规则不完整：${selector}`);
  return pageWxss.slice(open + 1, close);
}

function assertCssDeclaration(rule, property, expected, message) {
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|;)\\s*${escape(property)}\\s*:\\s*${escape(expected)}(?:\\s*!important)?\\s*(?:;|$)`);
  assert.ok(pattern.test(rule), message);
}

let secretResponse = { ok: true, credentials: { apiKey: "server-key" } };
const providerWrites = [];
let probeCount = 0;
let modelListCount = 0;
let registryResponse = null;
const navigationUrls = [];
const previewStorage = Object.create(null);

const supplier = {
  providerKey: "dashscope",
  name: "阿里云百炼",
  endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  auth: { protocol: "openai", configured: true },
  metadata: { capabilities: ["face"] }
};
registryResponse = { ok: true, data: { version: 7, suppliers: [supplier], supplierModels: [], bindings: [] } };

const cloudMock = {
  async getAdminConfigV2() {
    return registryResponse;
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
  getDeviceInfo() { return { platform: "devtools" }; },
  showToast() {},
  showModal() {},
  stopPullDownRefresh() {},
  navigateTo({ url }) { navigationUrls.push(url); },
  reLaunch({ url }) { navigationUrls.push(`reLaunch:${url}`); },
  switchTab({ url }) { navigationUrls.push(`switchTab:${url}`); },
  navigateBack() {},
  getStorageSync(key) { return previewStorage[key]; },
  setStorageSync(key, value) { previewStorage[key] = value; },
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

function assertDemoKeyIsEditable(page, label) {
  assert.strictEqual(page.data.apiKeyPreview, undefined, `${label}不能保留写死的 API Key 展示值`);
  assert.ok(/^sk-[0-9a-f]{32}$/.test(String(page.data.draft.apiKey || "")), `${label}必须显示与浏览器方案一致的可编辑演示 Key`);
  assert.strictEqual(page.data.secretStatus.apiKey.text, "已保存 · 单行显示", `${label}初始状态必须与浏览器方案一致`);
  const value = `${label}-admin-editable-key`;
  input(page, "apiKey", value);
  assert.strictEqual(page.data.draft.apiKey, value, `${label}必须允许管理员修改 API Key`);
  assert.strictEqual(page.data.secretStatus.apiKey.text, "已修改", `${label}修改后必须标记为待保存`);
}

function assertEveryProviderKeyIsEditable(page) {
  assert.strictEqual(page.data.providers.length, 10, "逐供应商密钥回归必须覆盖十个目录项");
  page.data.providers.forEach((provider, index) => {
    page.selectProvider({ index });
    const tc3 = provider.authProtocol === "tencent-tc3";
    assert.strictEqual(page.data.authIsTc3, tc3, `${provider.name}必须进入正确的认证分支`);
    const field = tc3 ? "tc3.secretKey" : "apiKey";
    const value = `${provider.providerKey}-admin-editable-key`;
    input(page, field, value);
    const actual = tc3 ? page.data.draft.tc3.secretKey : page.data.draft.apiKey;
    const status = tc3 ? page.data.secretStatus.secretKey : page.data.secretStatus.apiKey;
    assert.strictEqual(actual, value, `${provider.name}的密钥必须允许管理员修改`);
    assert.strictEqual(status.text, "已修改", `${provider.name}修改密钥后必须标记为待保存`);
  });
  page.selectProvider({ index: 0 });
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

  secretResponse = { ok: true, credentials: {}, apiKeyConfigured: true };
  await page.loadProviderSecret("dashscope");
  assert.strictEqual(page.data.secretStatus.apiKey.text, "已保存 · 明文仅管理员可见", "已配置但接口不回明文时必须保留管理员配置态");

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
  assert.strictEqual((pageWxml.match(/class="field key-field credential-key-field"/g) || []).length, 2, "API Key 与 TC3 SecretKey 必须同时使用统一密钥格式类");
  assert.ok(pageWxml.includes('<input id="keyInput" class="secret-input"') && pageWxml.includes('value="{{draft.apiKey}}"') && pageWxml.includes('bindinput="onDraftInput"'), "API Key 必须始终使用管理员可编辑输入框并动态绑定 draft.apiKey");
  assert.strictEqual((pageWxml.match(/placeholder-class="credential-key-placeholder"/g) || []).length, 2, "API Key 与 TC3 SecretKey 的占位文字必须共用固定单行样式");
  assert.ok(pageWxml.includes('<input id="secretKeyInput" class="secret-input"') && pageWxml.includes('value="{{draft.tc3.secretKey}}"'), "TC3 SecretKey 必须复用同一输入格式并保持管理员可编辑");
  assert.ok(pageWxml.includes('class="field credential-id-field"') && pageWxml.includes('<input id="secretIdInput" class="secret-input"'), "TC3 SecretId 必须使用独立稳定标识并复用凭据输入格式");
  assert.ok(!pageWxml.includes("secret-display") && !pageWxml.includes("apiKeyPreview"), "API Key 不能切换为写死值或只读展示层");
  assert.ok(pageSource.includes("this.demoMode") && pageSource.includes("DEMO_API_KEY") && !pageSource.includes("apiKeyPreview"), "演示 Key 只能作为 demoMode 下的可编辑初始值，不能走只读展示层");
  assert.ok(!pageWxml.includes('disabled="{{demoMode}}"'), "演示 Key 输入框也必须保持可编辑，不能因 demoMode 禁用");
  assert.ok(pageWxml.includes('bindtap="backToDashboard"') && pageWxml.includes("返回控制台"), "供应商页右上角必须提供返回控制台入口");
  assert.ok(pageWxml.includes('class="provider-scroll"') && pageWxml.includes('show-scrollbar="false"') && pageWxml.includes('enhanced="true"'), "供应商外层滚动容器必须隐藏滚动条且保留增强滚动");
  assert.ok(pageWxml.includes('<scroll-view class="editor-scroll" scroll-y="true" show-scrollbar="false" enhanced="true">'), "编辑内容必须使用独立滚动容器");
  assert.ok(/<scroll-view class="editor-scroll"[\s\S]*<\/scroll-view>\s*<view class="editor-actions/.test(pageWxml), "底部按钮必须位于编辑滚动容器之外，固定在右栏底部");
  assert.ok(pageWxml.includes("{{!editing || draft.isTemplate ? 'single' : ''}}"), "新增供应商或模板只有保存按钮时必须使用单列操作区");
  assert.ok(pageWxml.includes("placeholder=\"{{draft.configured ? '已配置 · 输入以替换' : '尚未配置'}}\""), "API Key 输入层必须使用明确的配置态占位文案");
  assert.ok(pageWxml.includes('class="provider-list" scroll-y="true"') && pageWxml.includes('show-scrollbar="false"') && pageWxml.includes('scroll-into-view="{{activeProviderId}}"'), "供应商目录必须支持首尾滚动并隐藏滚动条");
  assert.ok(pageWxml.includes('id="provider-{{index}}"') && pageWxml.includes('wx:key="providerKey"'), "供应商目录行必须具备稳定滚动定位标识");
  assert.ok(pageWxml.includes('bindtap="toggleCapability"') && pageWxml.includes("capability-check"), "供应商能力必须使用可点击的蓝色自绘勾选态");
  assert.ok(!pageWxml.includes("<switch"), "供应商能力不能退回原生灰色 switch");
  assert.ok(pageWxml.includes("item.configured") && !pageWxml.includes("item.enabled ? '已配置' : '未配置'"), "目录状态必须使用凭据 configured，不能把 enabled 当成已配置");
  assert.ok(/\.provider-list\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(pageWxss), "供应商列表必须自适应填满目录面板");
  assert.ok(/\.provider-row\s*\{[^}]*height:\s*110rpx\s*!important[^}]*min-height:\s*110rpx\s*!important[^}]*max-height:\s*110rpx\s*!important[^}]*flex:\s*0\s+0\s+110rpx[^}]*box-sizing:\s*border-box\s*!important/.test(pageWxss), "供应商目录行高和边框盒必须锁死为 110rpx，让第八行底边始终贴齐列表底部");
  assert.ok(!/\.provider-list\s*\{[^}]*height:\s*946rpx/.test(pageWxss) && !/\.provider-list\s*\{[^}]*max-height:\s*946rpx/.test(pageWxss), "供应商列表不能锁死 946rpx 导致底部留空");
  assert.ok(/\.provider-scroll::\-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(pageWxss), "供应商外层滚动条样式必须隐藏");
  assert.ok(/\.editor-actions\s*\{[^}]*margin-top:\s*16rpx/.test(pageWxss) && !/\.editor-actions\s*\{[^}]*margin-top:\s*auto/.test(pageWxss), "底部按钮必须保留浏览器方案的固定间距，不能用 auto 撑出大块空白");
  assert.ok(/\.provider-card\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden/.test(pageWxss), "供应商外卡必须锁定可用高度并裁剪外溢内容");
  assert.ok(/\.provider-layout\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(pageWxss), "双栏容器必须填满外卡剩余高度");
  assert.ok(/\.editor-panel\s*\{[^}]*overflow:\s*hidden/.test(pageWxss), "编辑栏必须裁剪内容并把滚动交给内部滚动层");
  assert.ok(/\.editor-scroll\s*\{[^}]*height:\s*0[^}]*flex:\s*1\s+1\s+auto[^}]*overflow-y:\s*scroll/.test(pageWxss), "编辑内容滚动层必须在剩余空间内滚动");
  assert.ok(/\.editor-actions\s*\{[^}]*flex:\s*0\s+0\s+auto[^}]*grid-template-columns:\s*repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)/.test(pageWxss), "底部按钮必须是固定高度的双列操作区");
  assert.ok(/\.directory-panel\s*\{[^}]*min-height:\s*0/.test(pageWxss) && /\.editor-panel\s*\{[^}]*min-height:\s*0/.test(pageWxss) && !/min-height:\s*1162rpx/.test(pageWxss), "左右栏必须按真实内容收口，按钮下面不能保留固定高度空白");
  assert.ok(/\.provider-layout\s*\{[^}]*position:\s*relative/.test(pageWxss), "双栏容器必须建立定位上下文，让目录不再撑高整张卡片");
  assert.ok(/\.directory-panel\s*\{[^}]*position:\s*absolute[^}]*top:\s*0[^}]*bottom:\s*0[^}]*left:\s*0/.test(pageWxss), "目录栏必须跟随编辑栏高度，并在内部滚动，不能把按钮下方撑出空白");
  assert.ok(/\.editor-panel\s*\{[^}]*grid-column:\s*2/.test(pageWxss), "编辑栏必须固定在第二列并决定双栏真实高度");
  assert.ok(pageWxml.includes('class="field endpoint-field"') && pageWxml.includes('id="endpointInput"') && pageWxml.includes('id="keyInput"') && /\.provider-page\s+\.endpoint-field\s+input,[\s\S]*?\.provider-page\s+\.key-field\s+input[\s\S]*?text-align:\s*left/.test(pageWxss), "API Key 与 API 端点必须共用左对齐规则和稳定定位标识");
  const endpointRuleAt = pageWxss.lastIndexOf(".provider-page .endpoint-field input,");
  const keyRuleAt = pageWxss.lastIndexOf(".provider-page .key-field input,");
  const finalInputRules = pageWxss.slice(Math.min(endpointRuleAt, keyRuleAt));
  assert.ok(endpointRuleAt >= 0 && keyRuleAt >= 0, "API Key 与 API 端点必须存在最终专用规则");
  assert.ok(/padding-left:\s*12rpx[\s\S]*padding-right:\s*12rpx/.test(finalInputRules), "API Key 与 API 端点必须使用相同左右内边距");
  assert.ok(/text-align:\s*left[\s\S]*text-overflow:\s*ellipsis[\s\S]*white-space:\s*nowrap/.test(finalInputRules), "API Key 与 API 端点必须最终保持左对齐单行省略");
  assert.ok(/\.secret-input[\s\S]*\{[\s\S]*height:\s*70rpx[\s\S]*overflow:\s*hidden[\s\S]*white-space:\s*nowrap/.test(pageWxss), "API Key 输入层必须固定为浏览器方案对应的 36px 单行高度");
  const finalLockAt = pageWxss.lastIndexOf("/* Credential key final invariant:");
  const genericInputAt = pageWxss.lastIndexOf(".provider-page .field input {");
  assert.ok(finalLockAt > genericInputAt, "密钥字段最终锁定规则必须位于通用输入规则之后");
  const cardRule = getLastCssRule(".provider-page .credential-key-field");
  for (const [property, expected] of [["height", "124rpx"], ["min-height", "124rpx"], ["max-height", "124rpx"], ["overflow", "hidden"]]) {
    assertCssDeclaration(cardRule, property, expected, `所有密钥绿色外框必须锁定 ${property}:${expected}`);
  }
  assertCssDeclaration(cardRule, "border", "2rpx solid #89ddb9", "所有密钥字段外框必须锁定为绿色");
  assertCssDeclaration(cardRule, "background", "#f0fbf7", "所有密钥字段必须锁定为浅绿色背景");
  const headingRule = getLastCssRule(".provider-page .credential-key-field > .field-heading");
  assertCssDeclaration(headingRule, "display", "flex", "密钥标题行必须使用 flex");
  for (const [property, expected] of [["flex", "0 0 22rpx"], ["height", "22rpx"], ["min-height", "22rpx"], ["max-height", "22rpx"]]) {
    assertCssDeclaration(headingRule, property, expected, `密钥标题行必须锁定 ${property}:${expected}，不能挤掉输入框`);
  }
  assertCssDeclaration(headingRule, "flex-direction", "row", "密钥标题和状态必须横向排列");
  assertCssDeclaration(headingRule, "flex-wrap", "nowrap", "密钥标题和状态禁止换行");
  const inputRule = getLastCssRule(".provider-page .credential-key-field > .secret-input");
  for (const [property, expected] of [["flex", "0 0 70rpx"], ["height", "70rpx"], ["min-height", "70rpx"], ["max-height", "70rpx"], ["overflow", "hidden"], ["text-align", "left"], ["text-overflow", "ellipsis"], ["white-space", "nowrap"]]) {
    assertCssDeclaration(inputRule, property, expected, `API Key 与 SecretKey 输入层必须锁定 ${property}:${expected}`);
  }
  const placeholderRule = getLastCssRule(".provider-page .credential-key-placeholder");
  for (const [property, expected] of [["height", "70rpx"], ["line-height", "70rpx"], ["overflow", "hidden"], ["text-align", "left"], ["text-overflow", "ellipsis"], ["white-space", "nowrap"]]) {
    assertCssDeclaration(placeholderRule, property, expected, `已配置和未配置占位文字必须锁定 ${property}:${expected}`);
  }
  const idCardRule = getLastCssRule(".provider-page .credential-id-field");
  for (const [property, expected] of [["height", "124rpx"], ["min-height", "124rpx"], ["max-height", "124rpx"], ["overflow", "hidden"]]) {
    assertCssDeclaration(idCardRule, property, expected, `SecretId 外框必须与 SecretKey 锁定相同 ${property}:${expected}`);
  }
  const idHeadingRule = getLastCssRule(".provider-page .credential-id-field > .field-heading");
  for (const [property, expected] of [["flex", "0 0 22rpx"], ["height", "22rpx"], ["justify-content", "space-between"]]) {
    assertCssDeclaration(idHeadingRule, property, expected, `SecretId 标题行必须与 SecretKey 锁定相同 ${property}:${expected}`);
  }
  const idInputRule = getLastCssRule(".provider-page .credential-id-field > .secret-input");
  for (const [property, expected] of [["flex", "0 0 70rpx"], ["height", "70rpx"], ["min-height", "70rpx"], ["max-height", "70rpx"], ["text-align", "left"], ["text-overflow", "ellipsis"], ["white-space", "nowrap"]]) {
    assertCssDeclaration(idInputRule, property, expected, `SecretId 输入框必须与 SecretKey 锁定相同 ${property}:${expected}`);
  }
  assert.ok(!/\.provider-page \.field input\s*\{[^}]*text-align:\s*center[^}]*\}[\s\S]*\.provider-page \.endpoint-field input,[\s\S]*text-align:\s*center/.test(finalInputRules), "通用居中规则不能覆盖端点和 API Key");
  assert.ok(/\.provider-row\.spaced\s*\{[^}]*margin-top:\s*12rpx/.test(pageWxss), "第九条开始必须通过隐藏滚动列表访问，不能挤出首屏");
  assert.ok(/\.provider-row\.active\s*\{[^}]*border:\s*4rpx\s+solid[^}]*padding:\s*6rpx\s+7rpx/.test(pageWxss), "选中供应商必须使用 4rpx 边框并内缩 padding 保持尺寸不变");
  assert.ok(pageWxss.includes("env(safe-area-inset-bottom)"), "底部按钮必须避开系统安全区");
  assert.ok(!/[\uFFFD]/.test(pageSource + pageWxml + pageWxss), "供应商页不能包含替换乱码字符");

  page.backToDashboard();
  assert.ok(navigationUrls.some(url => String(url).includes("/pages/admin-dashboard/admin-dashboard")), "返回控制台必须进入管理控制台");

  registryResponse = { ok: false };
  previewStorage["admin-preview-demo"] = false;
  const devtoolsRefreshPage = loadPage();
  devtoolsRefreshPage.onLoad({});
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(devtoolsRefreshPage.demoMode, true, "开发者工具云端空数据时必须自动回到稳定演示档案");
  assertDemoKeyIsEditable(devtoolsRefreshPage, "开发者工具直接刷新");

  const demoPage = loadPage();
  demoPage.onLoad({ demo: "1" });
  await new Promise(resolve => setImmediate(resolve));
  assertDemoKeyIsEditable(demoPage, "演示供应商首次加载");
  assertEveryProviderKeyIsEditable(demoPage);
  await demoPage.loadRegistry(true);
  assertDemoKeyIsEditable(demoPage, "演示供应商刷新后");
  assert.strictEqual(demoPage.data.activeProviderId, "provider-0", "刷新后选中供应商必须继续定位到目录首行");
  await demoPage.onPullDownRefresh();
  assertDemoKeyIsEditable(demoPage, "演示供应商下拉刷新后");
  demoPage.selectProvider({ index: demoPage.data.providers.length - 1 });
  assert.strictEqual(demoPage.data.activeProviderId, `provider-${demoPage.data.providers.length - 1}`, "选中目录末行必须发出滚动定位标识");
  demoPage.selectProvider({ index: 0 });
  assert.strictEqual(demoPage.data.activeProviderId, "provider-0", "返回目录首行必须恢复滚动定位标识");
  const refreshPage = loadPage();
  refreshPage.onLoad({});
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(refreshPage.demoMode, true, "显式 demo=1 打开后，刷新无参数页面必须沿用演示模式");
  assertDemoKeyIsEditable(refreshPage, "刷新无参数页面");
  refreshPage.onLoad({ demo: "0" });
  assert.strictEqual(refreshPage.demoMode, false, "显式 demo=0 必须允许退出演示模式");

  console.log("admin-provider-contract smoke: PASS (tri-state/dirty-omit/explicit-clear/templates/example-guard/390x844)");
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
