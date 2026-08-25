const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const pageConfig = JSON.parse(
  fs.readFileSync(path.join(root, "pages/index/index.json"), "utf8")
);
const pageJs = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");

const textareaTags = Array.from(wxml.matchAll(/<textarea\b[\s\S]*?<\/textarea>/g))
  .map((match) => match[0]);

assert.strictEqual(textareaTags.length, 9, "制作页文字框数量发生变化，请同步更新真机文字框检查");
assert.ok(
  textareaTags.every((tag) => /auto-height="\{\{true\}\}"/.test(tag)),
  "制作页所有 textarea 必须启用 auto-height"
);
assert.ok(
  textareaTags.every((tag) => /adjust-position="\{\{true\}\}"/.test(tag)),
  "制作页所有 textarea 必须启用键盘避让"
);
assert.ok(
  textareaTags.every((tag) => /cursor-spacing="\d+"/.test(tag)),
  "制作页所有 textarea 必须设置 cursor-spacing"
);
assert.ok(
  /data-field="sceneDescription"/.test(wxml)
    && /data-field="poseDescription"/.test(wxml)
    && /data-field="faceDirectionDescription"/.test(wxml)
    && /data-field="lightingMakeupDescription"/.test(wxml)
    && /data-field="backgroundDescription"/.test(wxml),
  "五段主图分析文字框缺失"
);
assert.ok(
  /class="asset-note"/.test(wxml)
    && /class="textarea custom-lock-area"/.test(wxml),
  "素材备注或自定义保持项文字框缺失"
);

for (const className of ["asset-note", "compact-area", "custom-lock-area"]) {
  const match = wxss.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `缺少 .${className} 样式`);
  assert.ok(/min-height\s*:/.test(match[1]), `.${className} 必须保留最小高度`);
  assert.ok(!/(?:^|[\r\n])\s*height\s*:/.test(match[1]), `.${className} 不得写死 height`);
}

assert.strictEqual(pageConfig.disableScroll, undefined, "制作页必须保留页面自然滚动");
assert.ok(!/wx\.pageScrollTo/.test(pageJs), "文字输入修复不得重新引入页面滚动锁定补偿");
assert.ok(!/position:\s*fixed/.test(pageJs), "文字输入修复不得把页面改成 fixed 定位");

console.log("real-device textarea smoke: OK");
