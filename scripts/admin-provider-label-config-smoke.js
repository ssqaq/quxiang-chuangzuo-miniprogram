/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-provider-label-smoke";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露管理员测试接口");
[
  "normalizeAdminProviderLabels",
  "mergeAdminProviderLabels",
  "validateAdminProviderLabels",
  "configuredAdminProviderIds"
].forEach((name) => {
  assert.strictEqual(typeof test[name], "function", `缺少测试函数：${name}`);
});

const defaults = test.normalizeAdminProviderLabels({}, { includeDefaults: true });
assert.deepStrictEqual(defaults, {
  dashscope: "阿里云百炼",
  lingyun: "凌云",
  xingju: "星炬",
  laoli: "老李",
  panda: "熊猫"
});

assert.deepStrictEqual(
  test.normalizeAdminProviderLabels({
    " CUSTOM-PROVIDER ": " 自定义服务商 ",
    lingyun: "凌云官方"
  }),
  {
    "CUSTOM-PROVIDER": "自定义服务商",
    lingyun: "凌云官方"
  }
);

assert.deepStrictEqual(
  test.mergeAdminProviderLabels(
    { lingyun: "凌云", xingju: "星炬" },
    { lingyun: "凌云官方", custom: "自定义服务商" }
  ),
  {
    custom: "自定义服务商",
    lingyun: "凌云官方",
    xingju: "星炬"
  }
);

assert.deepStrictEqual(
  test.configuredAdminProviderIds({
    face: { provider: "dashscope" },
    analysis: { provider: "DASHSCOPE" },
    image: { provider: "xingju" },
    imageBackup: { provider: "lingyun" },
    video: { provider: "custom-provider" }
  }),
  ["custom-provider", "dashscope", "lingyun", "xingju"]
);

assert.deepStrictEqual(
  test.validateAdminProviderLabels(
    { "custom-provider": "自定义服务商" },
    { video: { provider: "custom-provider" } }
  ),
  []
);

const missingErrors = test.validateAdminProviderLabels(
  { "custom-provider": "custom provider" },
  { video: { provider: "custom-provider" } }
);
assert.ok(
  missingErrors.some((item) => (
    item.includes("custom-provider") && item.includes("中文名称")
  )),
  "自定义英文服务商没有中文名称时必须报错"
);

assert.deepStrictEqual(
  test.validateAdminProviderLabels({}, {
    face: { provider: "dashscope" },
    image: { provider: "xingju" },
    imageBackup: { provider: "lingyun" }
  }),
  [],
  "三个内置服务商必须自动使用默认中文名称"
);

assert.ok(
  test.validateAdminProviderLabels("invalid", {}).some((item) => (
    item.includes("providerLabels") && item.includes("对象")
  )),
  "非对象名称配置必须被拒绝"
);

assert.ok(
  test.validateAdminProviderLabels({
    ["x".repeat(121)]: "超长服务商"
  }, {}).some((item) => item.includes("标识")),
  "超长服务商标识必须被拒绝"
);

assert.ok(
  test.validateAdminProviderLabels({
    custom: "超长中文名称".repeat(5)
  }, {}).some((item) => item.includes("custom")),
  "超长中文名称必须被拒绝"
);

const dangerous = Object.create(null);
Object.defineProperty(dangerous, "__proto__", {
  configurable: true,
  enumerable: true,
  value: "危险名称"
});
assert.ok(
  test.validateAdminProviderLabels(dangerous, {}).some((item) => (
    item.includes("标识") || item.includes("不允许")
  )),
  "危险键名必须被拒绝"
);

const normalizedPatch = test.normalizeRuntimePatch({
  providerLabels: {
    lingyun: "凌云官方",
    custom: "自定义服务商"
  }
});
assert.deepStrictEqual(normalizedPatch.providerLabels, {
  custom: "自定义服务商",
  lingyun: "凌云官方"
});

const mergedConfig = test.mergeRuntimeConfig(
  {
    providerLabels: {
      lingyun: "凌云",
      xingju: "星炬"
    }
  },
  {
    providerLabels: {
      lingyun: "凌云官方",
      custom: "自定义服务商"
    }
  }
);
assert.deepStrictEqual(mergedConfig.providerLabels, {
  custom: "自定义服务商",
  lingyun: "凌云官方",
  xingju: "星炬"
});

console.log("admin provider label config smoke tests passed");
