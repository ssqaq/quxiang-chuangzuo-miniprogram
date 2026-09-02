/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const safety = fs.readFileSync(path.join(root, "scripts/cloud-deploy-safety.ps1"), "utf8");
const deploy = fs.readFileSync(path.join(root, "scripts/deploy-api-cloudbase-cli.ps1"), "utf8");
assert.ok(safety.includes("function Get-CloudBaseRuntimeHealth"), "缺少 CloudBase 运行健康读取");
assert.ok(safety.includes("function Assert-CloudBaseRuntimeHealth"), "缺少 CloudBase 运行健康断言");
assert.ok(/BuildVersion|BuildMarker/.test(safety + deploy), "缺少线上构建版本/标记核验");
assert.ok(/Active/.test(safety + deploy), "缺少 Active 状态核验");
assert.ok(deploy.includes("Get-CloudBaseRuntimeHealth") && deploy.includes("Assert-CloudBaseRuntimeHealth"), "部署脚本未接入健康核验");
assert.ok(!/apiKey|secretKey|providerSecretsV2/i.test(safety + deploy), "CloudBase 健康脚本不应包含敏感字段");
console.log("cloudbase-health-smoke: PASS (active/version/marker/runtime-health/no-secrets)");
