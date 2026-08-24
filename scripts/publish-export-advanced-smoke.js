/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const core = require("../utils/publish-export-core");
const pageJs = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.js"),
  "utf8"
);
const pageWxml = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.wxml"),
  "utf8"
);
const pageWxss = fs.readFileSync(
  path.join(root, "pages/publish-export/publish-export.wxss"),
  "utf8"
);
const workerJs = fs.readFileSync(
  path.join(root, "workers/publish-export-worker.js"),
  "utf8"
);

const options = core.normalizeOptions({
  format: "PNG",
  quality: 101,
  maxLongEdge: 4096,
  cameraNoiseStrength: 9,
  frequencyStrength: 0,
  watermarkStrength: 4
});

assert.strictEqual(options.format, "png");
assert.strictEqual(options.quality, 100);
assert.strictEqual(options.maxLongEdge, 4096);
assert.strictEqual(options.cameraNoiseStrength, 5);
assert.strictEqual(options.frequencyStrength, 1);
assert.strictEqual(options.watermarkStrength, 4);

assert.strictEqual(
  core.chooseLocalMode(1200, 800, { maxLongEdge: 4096 }).mode,
  "cloud"
);
assert.strictEqual(
  core.chooseLocalMode(1200, 800, { maxLongEdge: 2048 }).mode,
  "local-worker"
);

const input = new Uint8ClampedArray([
  20, 30, 40, 255,
  80, 90, 100, 255,
  120, 130, 140, 255,
  200, 210, 220, 255
]);
const output = core.processRgba({
  width: 2,
  height: 2,
  data: input,
  seed: "publish-export-smoke",
  options: {
    colorOptimize: true,
    gentleSoften: false,
    gentleSharpen: true,
    cameraNoise: true,
    frequencyPerturb: true,
    resamplePerturb: false
  }
});
assert.ok(output instanceof Uint8ClampedArray);
assert.strictEqual(output.length, input.length);

[
  "publishExportCore.normalizeOptions",
  "confirmCloudExport",
  "本地处理失败，可以改用云端继续",
  "cloud.publishExport",
  "cloud.cleanupPublishExportResult"
].forEach((marker) => assert.ok(pageJs.includes(marker), `页面缺少：${marker}`));

[
  "基础色彩校正",
  "轻度降噪",
  "清晰补偿",
  "固定相机颗粒",
  "频域扰动",
  "反向重采样",
  "可见标记淡化"
].forEach((marker) => assert.ok(pageWxml.includes(marker), `页面缺少：${marker}`));
["1536px", "2048px", "4096px"].forEach((marker) => {
  assert.ok(pageJs.includes(marker), `页面尺寸选项缺少：${marker}`);
});

assert.ok(pageWxss.includes(".publish-export-canvas"), "导出画布样式缺失。");
assert.ok(workerJs.includes("publish-export-core"), "Worker 没有复用统一算法。");

console.log("publish-export advanced smoke: OK");
