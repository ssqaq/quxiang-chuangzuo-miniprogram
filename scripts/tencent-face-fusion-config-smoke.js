/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.TENCENT_FACEFUSION_SECRET_ID = "config-smoke-secret-id";
process.env.TENCENT_FACEFUSION_SECRET_KEY = "config-smoke-secret-key";
process.env.TENCENT_FACEFUSION_REGION = "ap-shanghai";
process.env.TENCENT_FACEFUSION_ENDPOINT = "https://env.example.com";

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");
const js = fs.readFileSync(path.join(root, "pages/admin/admin.js"), "utf8");
const api = require(path.join(root, "cloudfunctions/api/index.js"));
const test = api.__test;

assert.ok(test, "云函数测试接口未暴露");
assert.strictEqual(
  (wxml.match(/id="config-editor-image"/g) || []).length,
  1,
  "生图模型必须只有一个配置编辑区"
);
assert.strictEqual(
  (wxml.match(/class="current-config-row/g) || []).length,
  5,
  "当前配置必须包含独立腾讯版行"
);
assert.strictEqual(
  wxml.includes('id="config-editor-tencentImage"')
    || wxml.includes('data-section="tencentImage"'),
  false,
  "腾讯融合不能再使用旧的独立行或独立面板"
);
const imageEditorStart = wxml.indexOf('id="config-editor-image"');
const tencentEditorStart = wxml.indexOf('id="config-editor-tencentFaceFusion"');
const imageEditorEnd = tencentEditorStart;
assert.ok(imageEditorStart >= 0 && imageEditorEnd > imageEditorStart);
assert.ok(
  !wxml.slice(imageEditorStart, imageEditorEnd).includes("tencent-tabs")
    && !wxml.slice(imageEditorStart, imageEditorEnd).includes("tencent-fusion-tab-panel")
    && !wxml.slice(imageEditorStart, imageEditorEnd).includes("tencentImageTab"),
  "普通生图配置区不能再包含腾讯融合页签"
);
assert.ok(
  wxml.includes('class="card config-editor config-editor-inline tencent-pipeline-editor"')
    && wxml.includes("tencentPipelineWizardStep")
    && wxml.includes("第 1 步：选择主生图模型")
    && wxml.includes("第 2 步：要不要启用备用生图")
    && wxml.includes("第 3 步：配置腾讯融合")
    && wxml.includes("第 4 步：测试并保存"),
  "腾讯版独立配置区缺少四步向导"
);
assert.ok(
  js.includes('activeConfigSection: "tencentFaceFusion"')
    && js.includes('activeConfigTitle: CONFIG_SECTION_TITLES.tencentFaceFusion')
    && js.includes('storedActiveConfigSectionValue === "tencentImage"')
    && js.includes('tencentPipelineWizardStep'),
  "腾讯融合校验失败或旧缓存恢复没有收口到独立腾讯版配置区"
);

const envConfig = test.resolveTencentFaceFusionConfig();
assert.deepStrictEqual(
  {
    region: envConfig.region,
    endpoint: envConfig.endpoint,
    apiVersion: envConfig.apiVersion,
    action: envConfig.action,
    model: envConfig.model,
    swapModelType: envConfig.swapModelType,
    logoAdd: envConfig.logoAdd,
    timeoutMs: envConfig.timeoutMs,
    maxImageBytes: envConfig.maxImageBytes,
    configured: envConfig.configured
  },
  {
    region: "ap-shanghai",
    endpoint: "https://env.example.com",
    apiVersion: "2022-09-27",
    action: "FuseFaceUltra",
    model: "FuseFaceUltra",
    swapModelType: 4,
    logoAdd: false,
    timeoutMs: 75000,
    maxImageBytes: 5 * 1024 * 1024,
    configured: true
  },
  "腾讯融合环境变量默认值读取不正确"
);

const validPatch = test.normalizeRuntimePatch({
  tencentFaceFusion: {
    secretId: "override-id",
    secretKey: "override-key",
    region: "ap-beijing",
    endpoint: "https://override.example.com",
    apiVersion: "2026-08-27",
    action: "CustomAction",
    model: "CustomModel",
    swapModelType: 7,
    logoAdd: true,
    timeoutMs: 60000,
    maxImageBytes: 4 * 1024 * 1024
  }
});
assert.deepStrictEqual(test.validateRuntimePatch(validPatch), []);

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
      secretId: "existing-id",
      secretKey: "existing-key",
      endpoint: "https://old.example.com",
      timeoutMs: 75000
    }
  },
  blankSecretPatch
);
assert.deepStrictEqual(merged.tencentFaceFusion, {
  secretId: "existing-id",
  secretKey: "existing-key",
  endpoint: "https://new.example.com",
  timeoutMs: 60000
});

console.log(
  "tencent face fusion config smoke: OK (独立腾讯版面板、四步向导、参数校验、密钥保留和旧缓存迁移)"
);
