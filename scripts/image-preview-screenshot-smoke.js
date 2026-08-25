const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const imagePreviewJs = fs.readFileSync(
  path.join(root, "components/image-preview/image-preview.js"),
  "utf8"
);
const imagePreviewWxml = fs.readFileSync(
  path.join(root, "components/image-preview/image-preview.wxml"),
  "utf8"
);
const imagePreviewWxss = fs.readFileSync(
  path.join(root, "components/image-preview/image-preview.wxss"),
  "utf8"
);
const imagePreviewJson = JSON.parse(fs.readFileSync(
  path.join(root, "components/image-preview/image-preview.json"),
  "utf8"
));
const workbenchWxml = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxml"),
  "utf8"
);
const workbenchWxss = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxss"),
  "utf8"
);
const utils = require("../utils/image-preview");

assert.strictEqual(imagePreviewJson.component, true);
[
  "fitImageIntoViewport",
  "getImageDimensions",
  "wx.getImageInfo",
  "renderedWidth",
  "renderedHeight"
].forEach((marker) => {
  assert.ok(imagePreviewJs.includes(marker), `统一预览组件缺少：${marker}`);
});
[
  "style=\"width: {{renderedWidth}}px; height: {{renderedHeight}}px;\"",
  "mode=\"scaleToFill\"",
  "show-menu-by-longpress=\"true\"",
  "bindtap=\"close\"",
  "binderror=\"onImageError\""
].forEach((marker) => {
  assert.ok(imagePreviewWxml.includes(marker), `截图回归结构缺少：${marker}`);
});
assert.ok(!imagePreviewWxss.includes("width: 100%;\n  height: 100%"));
assert.ok(imagePreviewWxss.includes("display: flex;"));
assert.ok(imagePreviewWxss.includes("align-items: center;"));
assert.ok(imagePreviewWxss.includes("justify-content: center;"));
assert.ok(
  imagePreviewWxss.includes("margin: 0 auto;")
    && !imagePreviewWxss.includes("margin: 50vh auto 0;")
    && !imagePreviewWxss.includes("transform: translateY(-50%)"),
  "预览面板仍使用会受页面滚动影响的 50vh 定位"
);
assert.ok(workbenchWxml.includes('<view class="workbench-root">'));
assert.ok(
  workbenchWxml.indexOf('<view class="workbench-root">')
    < workbenchWxml.indexOf('<view class="workbench-page">')
    && workbenchWxml.indexOf('<view class="workbench-page">')
      < workbenchWxml.indexOf("<image-preview"),
  "工作台预览没有放到不带 transform 的根容器下"
);
assert.ok(
  workbenchWxml.lastIndexOf("</view>") > workbenchWxml.lastIndexOf("</image-preview>"),
  "工作台根容器结构不完整"
);
assert.ok(workbenchWxml.includes("<image-preview"));
assert.ok(!workbenchWxss.includes(".author-qr-preview-image"));
assert.ok(!workbenchWxss.includes("height: 80%"));

const qr = utils.fitImageIntoViewport(999, 1278, 295, 549);
assert.deepStrictEqual(qr, {
  width: 295,
  height: 377,
  scale: 295 / 999
});
assert.ok(qr.width <= 295 && qr.height <= 549);
assert.ok(Math.abs(qr.width / qr.height - 999 / 1278) < 0.01);

// 预览弹窗在图片信息回调回来前也必须有可见尺寸，避免出现“只有遮罩、
// 弹窗内容被压成 1px”的模拟器回归。
assert.ok(
  imagePreviewJs.includes(
    "this.layoutImage(DEFAULT_WIDTH, DEFAULT_HEIGHT);"
  ),
  "预览组件没有同步初始化兜底布局"
);
assert.ok(
  imagePreviewJs.includes(
    "getImageInfo 回调较慢时，弹窗保持 1px"
  ),
  "预览组件没有记录初始尺寸回归原因"
);

[
  { name: "模拟器 375×667", width: 295, height: 549 },
  { name: "真机 414×896", width: 318, height: 620 },
  { name: "横向窄窗口", width: 240, height: 300 }
].forEach((viewport) => {
  const result = utils.fitImageIntoViewport(
    999,
    1278,
    viewport.width,
    viewport.height
  );
  assert.ok(result.width > 0 && result.height > 0, `${viewport.name}尺寸无效`);
  assert.ok(result.width <= viewport.width, `${viewport.name}宽度越界`);
  assert.ok(result.height <= viewport.height, `${viewport.name}高度越界`);
});

console.log("image-preview screenshot regression smoke: OK");
