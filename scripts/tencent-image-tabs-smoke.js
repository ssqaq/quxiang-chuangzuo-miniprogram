/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "tencent-tabs-admin";
process.env.TENCENT_FACEFUSION_SECRET_ID = "smoke-secret-id";
process.env.TENCENT_FACEFUSION_SECRET_KEY = "smoke-secret-key";
process.env.TENCENT_FACEFUSION_REGION = "ap-shanghai";
process.env.TENCENT_FACEFUSION_ENDPOINT = "https://env.example.com";

const root = path.resolve(__dirname, "..");
const dependencyRoots = [
  path.join(root, "cloudfunctions", "api", "node_modules"),
  path.join(path.dirname(path.dirname(root)), "cloudfunctions", "api", "node_modules")
].filter((candidate, index, list) => (
  fs.existsSync(candidate) && list.indexOf(candidate) === index
));
if (dependencyRoots.length) {
  process.env.NODE_PATH = [
    ...dependencyRoots,
    process.env.NODE_PATH || ""
  ].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

const pageRoot = path.join(root, "pages", "admin");
const wxml = fs.readFileSync(path.join(pageRoot, "admin.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(pageRoot, "admin.wxss"), "utf8");
const js = fs.readFileSync(path.join(pageRoot, "admin.js"), "utf8");
const api = require(path.join(root, "cloudfunctions", "api", "index.js"));
const test = api.__test;

assert.ok(test, "云函数测试接口未暴露");

assert.ok(wxml.includes('id="config-editor-image"'));
assert.strictEqual(
  (wxml.match(/id="config-editor-tencentFaceFusion"/g) || []).length,
  1,
  "腾讯版必须只有一个独立配置面板"
);
assert.strictEqual(
  wxml.includes('data-section="tencentImage"'),
  false,
  "腾讯融合不能再使用独立配置行"
);
assert.ok(wxml.includes("data-model-config=\"image\""));
assert.ok(wxml.includes("data-model-config=\"imageBackup\""));
assert.ok(wxml.includes("bindtap=\"testModelConnection\""));
assert.ok(wxml.includes("bindtap=\"getModelOptions\""));
assert.ok(wxml.includes("bindtap=\"runImageEditCapabilityProbe\""));
assert.ok(wxml.includes("bindtap=\"runImageBackupEditCapabilityProbe\""));
assert.ok(/data-section="image" data-(?:key|field-key)="apiKey"/.test(wxml));
assert.ok(/data-section="imageBackup" data-(?:key|field-key)="apiKey"/.test(wxml));
assert.ok(js.includes("event.currentTarget.dataset.fieldKey"));
assert.ok(wxml.includes("data-section=\"tencentFaceFusion\""));
assert.ok(wxml.includes("tencentPipelineWizardStep"));
assert.ok(wxml.includes("第 1 步：选择主生图模型"));
assert.ok(wxml.includes("第 2 步：要不要启用备用生图"));
assert.ok(wxml.includes("第 3 步：配置腾讯融合"));
assert.ok(wxml.includes("第 4 步：测试并保存"));
const imageEditorStart = wxml.indexOf('id="config-editor-image"');
const tencentEditorStart = wxml.indexOf('id="config-editor-tencentFaceFusion"');
assert.ok(imageEditorStart >= 0 && tencentEditorStart > imageEditorStart);
const imageEditorBlock = wxml.slice(imageEditorStart, tencentEditorStart);
assert.ok(!imageEditorBlock.includes("tencent-tabs"));
assert.ok(!imageEditorBlock.includes("tencentImageTab"));
[
  "secretId",
  "secretKey",
  "region",
  "endpoint",
  "apiVersion",
  "action",
  "model",
  "swapModelType",
  "logoAdd",
  "timeoutMs",
  "maxImageBytes"
].forEach((field) => {
  assert.ok(
    wxml.includes(`form.tencentFaceFusion.${field}`),
    `缺少腾讯融合字段 ${field}`
  );
});
assert.ok(
  wxml.includes("测试使用当前页面填写值")
    || wxml.includes("测试会使用当前页面填写的腾讯参数")
);
assert.ok(wxml.includes("tencentFaceFusionStatus.lastCallStatusText"));
assert.ok(wxml.includes("tencentFaceFusionStatus.lastErrorMessage"));
[
  "lastCallStage",
  "lastDuration",
  "lastRequestId",
  "lastCalledAt"
].forEach((field) => {
  assert.strictEqual(
    wxml.includes(`tencentFaceFusionStatus.${field}`),
    false,
    `腾讯融合页面不应展示 ${field}`
  );
});
assert.ok(!js.includes("TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY"));
assert.ok(!js.includes("saveTencentFaceFusionLocalStatus"));
assert.ok(!js.includes("mergeTencentFaceFusionStatus"));
assert.ok(js.includes('rawSection === "tencentImage"'));
assert.ok(js.includes('? "tencentFaceFusion" : rawSection'));
assert.ok(js.includes('storedActiveConfigSectionValue === "tencentImage"'));
[
  ".tencent-pipeline-config-row {",
  ".tencent-pipeline-editor {",
  ".tencent-pipeline-progress",
  ".tencent-fusion-fields {",
  ".tencent-test-result {"
].forEach((selector) => assert.ok(wxss.includes(selector), `缺少样式 ${selector}`));

const envConfig = test.resolveTencentFaceFusionConfig();
assert.strictEqual(envConfig.region, "ap-shanghai");
assert.strictEqual(envConfig.endpoint, "https://env.example.com");
assert.strictEqual(envConfig.apiVersion, "2022-09-27");
assert.strictEqual(envConfig.configured, true);

const overrideConfig = test.resolveTencentFaceFusionConfig({
  tencentFaceFusion: {
    secretId: "override-secret-id",
    secretKey: "override-secret-key",
    region: "ap-beijing",
    endpoint: "https://override.example.com",
    apiVersion: "2023-01-01",
    action: "CustomAction",
    model: "CustomModel",
    swapModelType: 7,
    logoAdd: true,
    timeoutMs: 60000,
    maxImageBytes: 4 * 1024 * 1024
  }
});
assert.deepStrictEqual(
  {
    region: overrideConfig.region,
    endpoint: overrideConfig.endpoint,
    apiVersion: overrideConfig.apiVersion,
    action: overrideConfig.action,
    model: overrideConfig.model,
    swapModelType: overrideConfig.swapModelType,
    logoAdd: overrideConfig.logoAdd,
    timeoutMs: overrideConfig.timeoutMs,
    maxImageBytes: overrideConfig.maxImageBytes,
    configured: overrideConfig.configured
  },
  {
    region: "ap-beijing",
    endpoint: "https://override.example.com",
    apiVersion: "2023-01-01",
    action: "CustomAction",
    model: "CustomModel",
    swapModelType: 7,
    logoAdd: true,
    timeoutMs: 60000,
    maxImageBytes: 4 * 1024 * 1024,
    configured: true
  },
  "管理员保存值必须覆盖环境变量"
);

const validPatch = test.normalizeRuntimePatch({
  tencentFaceFusion: {
    secretId: "patch-secret-id",
    secretKey: "patch-secret-key",
    region: "ap-guangzhou",
    endpoint: "https://facefusion.tencentcloudapi.com",
    apiVersion: "2022-09-27",
    action: "FuseFaceUltra",
    model: "FuseFaceUltra",
    swapModelType: 4,
    logoAdd: false,
    timeoutMs: 75000,
    maxImageBytes: 5 * 1024 * 1024
  }
});
assert.deepStrictEqual(test.validateRuntimePatch(validPatch), []);

[
  {
    endpoint: "http://facefusion.tencentcloudapi.com",
    message: "HTTPS"
  },
  {
    apiVersion: "2022/09/27",
    message: "YYYY-MM-DD"
  },
  {
    timeoutMs: 4999,
    message: "5000"
  },
  {
    maxImageBytes: 9 * 1024 * 1024,
    message: "8388608"
  },
  {
    swapModelType: 10,
    message: "1～9"
  }
].forEach((change) => {
  const candidate = Object.assign(
    {},
    validPatch.tencentFaceFusion,
    change
  );
  const errors = test.validateRuntimePatch({
    tencentFaceFusion: candidate
  });
  assert.ok(
    errors.some((item) => item.includes(change.message)),
    `非法腾讯参数未被拒绝：${change.message}`
  );
});

const blankSecretPatch = test.dropBlankRuntimeApiKeys(
  test.normalizeRuntimePatch({
    tencentFaceFusion: {
      secretId: "",
      secretKey: " ",
      endpoint: "https://new.example.com",
      timeoutMs: 60000
    }
  })
);
assert.deepStrictEqual(blankSecretPatch.tencentFaceFusion, {
  endpoint: "https://new.example.com",
  timeoutMs: 60000
});
const merged = test.mergeRuntimeConfig(
  {
    tencentFaceFusion: {
      secretId: "existing-secret-id",
      secretKey: "existing-secret-key",
      endpoint: "https://old.example.com",
      timeoutMs: 75000
    }
  },
  blankSecretPatch
);
assert.deepStrictEqual(merged.tencentFaceFusion, {
  secretId: "existing-secret-id",
  secretKey: "existing-secret-key",
  endpoint: "https://new.example.com",
  timeoutMs: 60000
});

console.log(
  "tencent image tabs smoke: OK (独立腾讯版卡片、主备共用、参数编辑、校验和优先级)"
);
