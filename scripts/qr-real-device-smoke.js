const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const qrPath = path.join(root, "assets/contact/author-wechat-qr.jpg");
const workbenchJs = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.js"),
  "utf8"
);
const workbenchWxml = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxml"),
  "utf8"
);
const workbenchJson = JSON.parse(fs.readFileSync(
  path.join(root, "pages/workbench/workbench.json"),
  "utf8"
));
const imagePreviewJs = fs.readFileSync(
  path.join(root, "components/image-preview/image-preview.js"),
  "utf8"
);

assert.ok(fs.existsSync(qrPath), "二维码源文件不存在");
const header = fs.readFileSync(qrPath).subarray(0, 32);
assert.strictEqual(header[0], 0xff);
assert.strictEqual(header[1], 0xd8);
assert.ok(workbenchJs.includes('AUTHOR_QR_PATH = "/assets/contact/author-wechat-qr.jpg"'));
assert.ok(workbenchJs.includes("previewAuthorQr()"));
assert.ok(workbenchJs.includes("saveAuthorQr()"));
assert.ok(workbenchWxml.includes('show-menu-by-longpress="true"'));
assert.ok(workbenchWxml.includes('bindtap="previewAuthorQr"'));
assert.ok(workbenchWxml.includes("<image-preview"));
assert.ok(
  workbenchJson.usingComponents
    && workbenchJson.usingComponents["image-preview"]
);
assert.ok(imagePreviewJs.includes("wx.getImageInfo"));
assert.ok(imagePreviewJs.includes("renderedWidth"));
assert.ok(imagePreviewJs.includes("renderedHeight"));

console.log("qr real-device smoke: static checks OK");
console.log("真机待执行：");
console.log("1. 开发者工具清缓存后重新编译，确认版本号已更新。");
console.log("2. 真机打开工作台，展开“联系作者”，点击二维码，确认四角定位点完整可见。");
console.log("3. 真机长按二维码，确认出现“识别图中二维码/添加好友”。");
console.log("4. 用另一台手机扫描，确认能识别且内容正确。");
console.log("5. 记录结果到 docs/qr-preview-real-device-test.md，不把静态检查当成真机通过。");
