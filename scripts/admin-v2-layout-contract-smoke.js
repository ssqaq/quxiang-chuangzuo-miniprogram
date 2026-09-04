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
  const provider = report.pages.find(page => page.name === "provider");
  assert.deepStrictEqual(provider.checks.filter(item => item.label.startsWith("blank-space ") || item.label === "editor layout flex").map(item => item.label), [
    "editor layout flex",
    "blank-space layout position",
    "blank-space directory position",
    "blank-space directory top",
    "blank-space directory bottom",
    "blank-space directory left",
    "blank-space directory overflow",
    "blank-space directory min-height",
    "blank-space editor min-height",
    "blank-space editor column",
    "blank-space list flex",
    "blank-space list height",
    "blank-space list max-height",
    "blank-space actions margin-top",
  ]);
  ["endpoint input left padding", "key input left padding", "endpoint input alignment", "key input alignment"].forEach(label => {
    assert.strictEqual(provider.checks.find(item => item.label === label).pass, true, `${label} 必须通过`);
  });

  const mutationRoot = path.join(tempRoot, "mutation");
  contract.CONTRACTS.forEach(item => {
    [item.wxml, item.wxss].forEach(relativePath => {
      const source = path.join(root, relativePath);
      const target = path.join(mutationRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    });
  });
  const providerWxss = path.join(mutationRoot, "pages/admin-provider/admin-provider.wxss");
  const sourceWxss = fs.readFileSync(providerWxss, "utf8");
  const mutatedWxss = sourceWxss.replace("margin-top:16rpx", "margin-top:auto");
  assert.notStrictEqual(mutatedWxss, sourceWxss, "测试样式必须成功注入危险的 auto 间距");
  fs.writeFileSync(providerWxss, mutatedWxss, "utf8");
  const mutatedReport = contract.run({ root: mutationRoot, output: false });
  assert.strictEqual(mutatedReport.ok, false, "按钮 auto 间距必须让布局合同失败");
  const mutatedProvider = mutatedReport.pages.find(page => page.name === "provider");
  assert.strictEqual(mutatedProvider.checks.find(item => item.label === "blank-space actions margin-top").pass, false);
  assert.ok(fs.existsSync(report.output), "布局合同应落盘为 JSON");
  console.log("admin-v2-layout-contract-smoke: PASS (four-pages/selectors/font/geometry/blank-space mutation/hash/json)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
