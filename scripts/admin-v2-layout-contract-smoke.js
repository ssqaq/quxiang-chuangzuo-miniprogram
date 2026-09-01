/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const contract = require("./admin-v2-layout-contract");

const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-layout-contract-"));
try {
  const report = contract.run({ root, output: path.join(tempRoot, "layout-contract.json") });
  assert.strictEqual(report.ok, true, "四页布局合同应通过");
  assert.deepStrictEqual(report.pages.map(item => item.name), ["dashboard", "operations", "config", "provider"]);
  assert.strictEqual(report.viewport.width, 390);
  assert.strictEqual(report.viewport.height, 844);
  assert.strictEqual(report.fontStack, contract.FONT_STACK);
  report.pages.forEach(page => {
    assert.strictEqual(page.missingSelectors.length, 0, `${page.name} 不得缺少布局选择器`);
    assert.ok(page.checks.every(item => item.pass), `${page.name} 的固定尺寸合同应全部通过`);
    assert.match(page.sourceSha256.wxml, /^[0-9a-f]{64}$/);
    assert.match(page.sourceSha256.wxss, /^[0-9a-f]{64}$/);
  });
  assert.ok(fs.existsSync(report.output), "布局合同应落盘为 JSON");
  console.log("admin-v2-layout-contract-smoke: PASS (four-pages/selectors/font/geometry/hash/json)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
