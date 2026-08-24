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
const pageJson = JSON.parse(
  fs.readFileSync(path.join(root, "pages/publish-export/publish-export.json"), "utf8")
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
  cameraNoiseStrength: 2.4,
  frequencyStrength: 0,
  watermarkStrength: 4
});

assert.strictEqual(options.format, "png");
assert.strictEqual(options.quality, 100);
assert.strictEqual(options.maxLongEdge, 2048);
assert.strictEqual(options.cameraNoiseStrength, 2.4);
assert.strictEqual(options.frequencyStrength, 1);
assert.strictEqual(options.watermarkStrength, 4);

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
assert.ok(!pageJs.includes("SIZE_OPTIONS"), "页面仍保留尺寸选择数据。");
assert.ok(!pageJs.includes("changeMaxEdge"), "页面仍保留尺寸切换逻辑。");
assert.ok(!pageWxml.includes("最长边"), "页面仍显示最长边选项。");
assert.ok(
  !pageWxml.includes("小图优先在手机处理，大图或失败时经你确认后使用云端"),
  "页面仍显示已删除的处理说明。"
);
assert.strictEqual(pageJson.navigationBarTitleText, "降低AI识别率再导出");
assert.ok(pageWxml.includes("降低AI识别率再导出"), "导出页标题文案未更新。");
assert.ok(
  pageWxml.includes(
    'value="{{cameraNoiseStrength}}" min="1" max="5" step="0.1"'
  ),
  "颗粒强度滑块没有使用连续步进。"
);
assert.ok(
  pageWxml.includes(
    'value="{{frequencyStrength}}" min="1" max="5" step="0.1"'
  ),
  "频域扰动滑块没有使用连续步进。"
);
assert.ok(
  pageWxml.includes("bindchanging=\"changeAdvancedStrength\"")
    && pageJs.includes("Math.round(value * 10) / 10"),
  "高级强度滑块没有复用顺滑拖动更新逻辑。"
);
assert.ok(
  !pageWxml.includes("高级处理后再导出照片"),
  "页面仍显示旧的导出标题。"
);

assert.ok(pageWxss.includes(".publish-export-canvas"), "导出画布样式缺失。");
assert.ok(workerJs.includes("publish-export-core"), "Worker 没有复用统一算法。");

console.log("publish-export advanced smoke: OK");
