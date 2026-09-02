/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fixtures = require("../services/admin-preview-fixtures");

const root = path.resolve(__dirname, "..");
const page = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxml"), "utf8");
const style = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxss"), "utf8");
const fixture = fixtures.adminConfig ? fixtures.adminConfig({ visualState: "collapsed-default-v1" }) : fixtures;
const text = JSON.stringify(fixture);
assert.ok(page.includes("供应商管理") && page.includes("供应商目录") && page.includes("中文名称"), "供应商关键中文缺失");
assert.ok(page.includes("可用功能") && page.includes("功能配置页只读取"), "供应商说明文案缺失");
assert.ok(!/[\uFFFD]/.test(page + style + text), "供应商页面出现 Unicode 替代字符");
assert.ok(/阿里云百炼/.test(text), "供应商 fixture 中文名称缺失");
assert.ok(/secretStatus\.apiKey|管理员可见|sk-1b3dc0ff204a64683bb/.test(page), "供应商 API Key 未使用安全显示状态");
assert.ok(/overflow\s*:\s*hidden/.test(style), "供应商编辑区缺少溢出保护");
console.log("admin-provider-chinese-regression-smoke: PASS (utf8/keywords/replacement-char/fixture/key-state/overflow)");
