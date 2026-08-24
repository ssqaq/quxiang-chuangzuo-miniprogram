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
assert.strictEqual(options.removeVisibleMarks, true);
const defaultOptions = core.normalizeOptions({});
assert.strictEqual(defaultOptions.quality, 88);
assert.strictEqual(defaultOptions.colorOptimize, true);
assert.strictEqual(defaultOptions.gentleSoften, true);
assert.strictEqual(defaultOptions.gentleSharpen, true);
assert.strictEqual(defaultOptions.cameraNoise, true);
assert.strictEqual(defaultOptions.cameraNoiseStrength, 3);
assert.strictEqual(defaultOptions.frequencyPerturb, true);
assert.strictEqual(defaultOptions.frequencyStrength, 3);
assert.strictEqual(defaultOptions.removeVisibleMarks, true);
assert.strictEqual(defaultOptions.watermarkStrength, 3);
assert.strictEqual(defaultOptions.resamplePerturb, true);
assert.strictEqual(
  core.normalizeOptions({ removeVisibleMarks: false }).removeVisibleMarks,
  false
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
[
  "让颜色看起来自然",
  "减少图片上的小杂点",
  "让图片看起来更清楚",
  "加一点相机拍出的质感",
  "轻微改变图片细节",
  "重新处理图片，尺寸不变",
  "让看得到的水印、文字或标记等信息变淡"
].forEach((marker) => assert.ok(pageWxml.includes(marker), `页面缺少简短说明：${marker}`));
[
  "轻微提亮对比度和饱和度",
  "尽量压住重新导出后的细碎噪点",
  "轻微加强边缘对比，避免过度锐化",
  "使用稳定的轻微颗粒，避免彩色噪点",
  "轻微改变高频细节，尽量不影响整体画面",
  "轻微扰动像素网格，保持输出尺寸不变",
  "仅尝试淡化可见标记，不保证移除不可见溯源或AI来源标识"
].forEach((marker) => assert.ok(!pageWxml.includes(marker), `页面仍保留过长说明：${marker}`));
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
  pageWxml.includes("bindchanging=\"previewAdvancedStrength\"")
    && pageWxml.includes("bindchange=\"commitAdvancedStrength\"")
    && pageJs.includes("previewAdvancedStrength")
    && pageJs.includes("commitAdvancedStrength"),
  "高级强度滑块没有复用顺滑拖动更新逻辑。"
);
[
  "先选择文件格式和 JPG 品质",
  "让颜色、细节和清晰度更自然",
  "相机颗粒和高级处理全部单独展示",
  "三个强度默认都是 3，可分别拖动"
].forEach((marker) => {
  assert.ok(pageWxml.includes(marker), `方案6页面缺少说明：${marker}`);
});
assert.ok(
  pageWxml.includes(
    'value="{{watermarkStrength}}" min="1" max="5" step="0.1"'
  ),
  "淡化强度滑块没有使用连续步进。"
);
const fadeStrengthIndex = pageWxml.indexOf(">淡化强度</text>");
const perturbStrengthIndex = pageWxml.indexOf(">扰动强度</text>");
assert.ok(
  fadeStrengthIndex >= 0
    && perturbStrengthIndex > fadeStrengthIndex,
  "扰动强度没有放在淡化强度下面。"
);
assert.ok(
  pageWxml.includes('data-key="removeVisibleMarks"')
    && pageWxml.includes('checked="{{removeVisibleMarks}}"')
    && pageJs.includes("removeVisibleMarks: true")
    && pageJs.includes('"removeVisibleMarks"'),
  "可见标记淡化没有显示默认开启的开关，或没有接入导出参数。"
);
assert.ok(
  pageWxml.includes("scheme6-actions")
    && !pageWxml.includes("scheme6-fixed-actions")
    && pageWxml.includes("scheme6-export-button")
    && pageWxml.includes("scheme6-back-button")
    && pageWxss.includes(".scheme6-actions")
    && !pageWxss.includes(".scheme6-fixed-actions")
    && !/\.scheme6-actions\s*\{[^}]*position\s*:\s*fixed/i.test(pageWxss),
  "方案6底部操作栏没有改成跟随页面滚动。"
);
const scheme6ExportButtonStyle = pageWxss.match(
  /\.scheme6-actions\s+\.scheme6-export-button\s*\{([^}]*)\}/
);
const scheme6BackButtonStyle = pageWxss.match(
  /\.scheme6-actions\s+\.scheme6-back-button\s*\{([^}]*)\}/
);
assert.ok(
  scheme6ExportButtonStyle
    && scheme6BackButtonStyle
    && /height:\s*82rpx/.test(scheme6ExportButtonStyle[1])
    && /min-height:\s*82rpx/.test(scheme6ExportButtonStyle[1])
    && /line-height:\s*82rpx/.test(scheme6ExportButtonStyle[1])
    && /height:\s*82rpx/.test(scheme6BackButtonStyle[1])
    && /min-height:\s*82rpx/.test(scheme6BackButtonStyle[1])
    && /line-height:\s*82rpx/.test(scheme6BackButtonStyle[1]),
  "返回工作台按钮没有和导出按钮使用相同高度。"
);
assert.ok(
  !pageWxml.includes("高级处理后再导出照片"),
  "页面仍显示旧的导出标题。"
);

assert.ok(pageWxss.includes(".publish-export-canvas"), "导出画布样式缺失。");
assert.ok(workerJs.includes("publish-export-core"), "Worker 没有复用统一算法。");

console.log("publish-export advanced smoke: OK");
