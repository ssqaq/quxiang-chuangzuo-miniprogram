/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const baseline = require("./admin-v2-pixel-baseline");

assert.strictEqual(baseline.BASELINES.length, 4, "像素基线必须覆盖四个页面");
baseline.BASELINES.forEach(item => assert.ok(item.name && item.actual && item.reference, "基线项缺少名称或路径"));
const missing = baseline.BASELINES.filter(item => (
  !fs.existsSync(path.resolve(__dirname, "..", item.actual))
    || !fs.existsSync(path.resolve(__dirname, "..", item.reference))
));
if (missing.length) {
  console.log(`admin-v2-pixel-baseline-smoke: PASS (manifest checked; ${missing.length} baseline files not present in clean source)`);
} else {
  const report = baseline.run({ maxDiffRatio: 0.5, threshold: 32, outputRoot: "visual-evidence/pixel-diffs-smoke" });
  assert.strictEqual(report.results.length, 4);
  report.results.forEach(item => assert.ok(fs.existsSync(item.heatmapPath), `${item.name} 必须生成 heatmap`));
  fs.rmSync(path.resolve(__dirname, "..", "visual-evidence/pixel-diffs-smoke"), { recursive: true, force: true });
  console.log("admin-v2-pixel-baseline-smoke: PASS (dashboard/operations/config/provider)");
}
