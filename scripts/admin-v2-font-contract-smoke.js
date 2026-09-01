/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const font = require("./admin-v2-font-contract");

const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-font-contract-"));
try {
  const report = font.run({ root, output: path.join(tempRoot, "font-contract.json") });
  assert.strictEqual(report.ok, true, "四页字体合同应通过");
  assert.strictEqual(report.profile, "admin-reference-font-v1");
  assert.deepStrictEqual(report.pages.map(item => item.name), ["dashboard", "operations", "config", "provider"]);
  report.pages.forEach(page => {
    assert.strictEqual(page.actual, report.fontStack, `${page.name} 必须使用统一字体栈`);
    assert.match(page.sourceSha256, /^[0-9a-f]{64}$/);
  });
  assert.ok(fs.existsSync(report.output), "字体合同应落盘为 JSON");
  console.log("admin-v2-font-contract-smoke: PASS (four-pages/font-stack/profile/hash/json)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
