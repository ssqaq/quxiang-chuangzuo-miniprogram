/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifestPath = path.join(root, "visual-evidence", "provider-tc3-regression.json");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

assert.ok(fs.existsSync(manifestPath), "缺少 TC3 390x844 截图回归 manifest");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.strictEqual(manifest.schemaVersion, 1, "TC3 截图合同版本必须为 1");
assert.strictEqual(manifest.state, "provider-tc3-v1", "TC3 截图必须来自 provider-tc3-v1 状态");
assert.deepStrictEqual(manifest.viewport, { width: 390, height: 844 }, "TC3 截图视口必须为 390x844");
assert.strictEqual(manifest.route.includes("providerKey=tencent"), true, "TC3 截图路由必须选中腾讯供应商");
assert.ok(manifest.screenshot, "TC3 截图路径不能为空");

const screenshotPath = path.resolve(root, manifest.screenshot);
assert.ok(fs.existsSync(screenshotPath), `TC3 截图不存在：${screenshotPath}`);
assert.ok(fs.statSync(screenshotPath).size > 0, "TC3 截图不能是空文件");
assert.strictEqual(String(manifest.sha256 || "").toLowerCase(), sha256(screenshotPath), "TC3 截图 SHA256 不匹配");

const providerWxml = fs.readFileSync(path.join(root, "pages/admin-provider/admin-provider.wxml"), "utf8");
assert.ok(providerWxml.includes("腾讯 TC3") && providerWxml.includes("SecretId") && providerWxml.includes("SecretKey"), "供应商页必须包含 TC3 字段");
assert.ok(providerWxml.includes('id="endpointInput"') && providerWxml.includes('id="keyInput"'), "供应商 API 输入必须保留稳定 id");

console.log("admin-provider-tc3-screenshot-smoke: PASS (390x844/route/hash/tc3-fields)");
