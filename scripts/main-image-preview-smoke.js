const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const componentDir = path.join(root, "components/main-image-preview");
const componentJs = fs.readFileSync(
  path.join(componentDir, "main-image-preview.js"),
  "utf8"
);
const componentWxml = fs.readFileSync(
  path.join(componentDir, "main-image-preview.wxml"),
  "utf8"
);
const componentWxss = fs.readFileSync(
  path.join(componentDir, "main-image-preview.wxss"),
  "utf8"
);
const componentJson = JSON.parse(
  fs.readFileSync(path.join(componentDir, "main-image-preview.json"), "utf8")
);

const pageDefinitions = [
  {
    name: "降低AI识别率再导出",
    dir: "pages/publish-export",
    subtitle: "当前将导出这些照片。"
  },
  {
    name: "照片转实况图",
    dir: "pages/photo-to-video",
    subtitle: "当前将处理这些照片。"
  }
];

assert.strictEqual(componentJson.component, true, "预览目录必须声明为组件。");
[
  "properties",
  "image",
  "hintText",
  "previewEnabled",
  "wx.getImageInfo",
  "createPinchState",
  "updatePinchView",
  "clampOffset",
  "onTouchStart",
  "onTouchMove",
  "onTouchEnd",
  "onPreviewTap",
  "onImageError"
].forEach((marker) => {
  assert.ok(componentJs.includes(marker), `共用组件缺少：${marker}`);
});
[
  "main-image-preview-card",
  "main-image-preview-viewport",
  "main-image-preview-stage",
  "main-image-preview-tip",
  "transform: translate"
].forEach((marker) => {
  assert.ok(componentWxml.includes(marker), `组件结构缺少：${marker}`);
});
[
  "DEFAULT_WIDTH",
  "DEFAULT_HEIGHT",
  "MAX_VIEWPORT_HEIGHT",
  "border: 2rpx solid #dfe6f1",
  "border-radius: 20rpx"
].forEach((marker) => {
  assert.ok(
    componentJs.includes(marker) || componentWxss.includes(marker),
    `组件尺寸样式缺少：${marker}`
  );
});

pageDefinitions.forEach(({ name, dir, subtitle }) => {
  const pageName = path.basename(dir);
  const pageJs = fs.readFileSync(
    path.join(root, dir, `${pageName}.js`),
    "utf8"
  );
  const pageWxml = fs.readFileSync(
    path.join(root, dir, `${pageName}.wxml`),
    "utf8"
  );
  const pageWxss = fs.readFileSync(
    path.join(root, dir, `${pageName}.wxss`),
    "utf8"
  );
  const pageJson = JSON.parse(
    fs.readFileSync(path.join(root, dir, `${pageName}.json`), "utf8")
  );

  assert.ok(
    pageJson.usingComponents
      && pageJson.usingComponents["main-image-preview"],
    `${name}没有注册共用预览组件。`
  );
  assert.ok(pageWxml.includes("<main-image-preview"), `${name}没有使用共用预览组件。`);
  assert.ok(
    pageWxml.includes('image="{{deviceRecords[0]}}"'),
    `${name}没有限制为第一张照片预览。`
  );
  assert.ok(pageWxml.includes("hintText="), `${name}没有显示手势提示。`);
  assert.ok(
    pageWxml.indexOf("<main-image-preview")
      < pageWxml.indexOf("device-photo-hint")
      && pageWxml.indexOf("device-photo-hint")
        < pageWxml.indexOf("upload-main-button"),
    `${name}的图片、提示、重新选择按钮顺序不正确。`
  );
  assert.ok(pageWxml.includes(subtitle), `${name}导入数量提示文案缺失。`);
  assert.ok(pageJs.includes("const count = 1;"), `${name}仍允许批量导入。`);
  assert.ok(
    !pageWxml.includes("device-photo-preview-list")
      && !pageWxss.includes("device-photo-preview-list"),
    `${name}仍保留旧缩略图列表。`
  );
});

console.log("main-image-preview smoke: OK");
