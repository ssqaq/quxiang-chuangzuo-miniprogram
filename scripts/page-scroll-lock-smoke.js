const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const js = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");

assert.ok(
  /page-meta[^>]*page-style="\{\{pageScrollLocked/.test(wxml),
  "制作页必须保留 page-meta 滚动锁"
);
assert.ok(
  (wxml.match(/catchtouchmove="onCanvasTouchMove"/g) || []).length >= 2,
  "画布视口和画布舞台都必须拦截触摸移动"
);
assert.ok(
  /\.canvas-viewport[\s\S]*touch-action:\s*none/.test(wxss),
  "画布视口必须声明禁止默认触摸动作"
);
assert.ok(
  /onPageScroll\(event = \{\}\)/.test(js)
    && /restorePageScrollPosition/.test(js)
    && /wx\.pageScrollTo/.test(js),
  "制作页必须在页面滚动回调中恢复锁定位置"
);
assert.ok(
  js.includes('this.setPageScrollLock(true);')
    && js.includes('this.setData({ drawing: true });'),
  "开始画圈时也必须锁住页面滚动"
);

console.log("page scroll lock smoke: OK");
