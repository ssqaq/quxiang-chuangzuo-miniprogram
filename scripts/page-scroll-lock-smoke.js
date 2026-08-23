const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "pages/index/index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(root, "pages/index/index.wxss"), "utf8");
const js = fs.readFileSync(path.join(root, "pages/index/index.js"), "utf8");
const pageConfig = JSON.parse(
  fs.readFileSync(path.join(root, "pages/index/index.json"), "utf8")
);

assert.ok(
  !/<page-meta\b/.test(wxml)
    && !/pageScrollStyle|pageScrollLocked/.test(js),
  "制作页必须删除动态 page-meta 页面滚动锁"
);
assert.ok(
  !/setPageScrollLock|restorePageScrollPosition|wx\.pageScrollTo/.test(js),
  "Canvas 手势链路不得再通过 pageScrollTo 补偿页面位置"
);
assert.ok(
  !/position:\s*fixed/.test(js)
    && !/top:\s*-\$\{scrollTop\}px/.test(js),
  "Canvas 手势不得再把整页改成固定定位"
);
assert.strictEqual(
  pageConfig.disableScroll,
  undefined,
  "制作页必须保留 Canvas 外部的自然页面滚动"
);

for (const eventName of ["start", "move", "end", "cancel"]) {
  assert.strictEqual(
    (wxml.match(new RegExp(`catchtouch${eventName}="onCanvasTouch`, "g")) || []).length,
    1,
    `Canvas 区域必须只有一套 catchtouch${eventName} 处理链`
  );
}
assert.ok(
  !/capture-catchtouch/.test(wxml),
  "Canvas 区域不得保留重复的捕获阶段触摸处理"
);
const stageTag = wxml.match(/<view\s+class="canvas-stage"[\s\S]*?>/);
assert.ok(stageTag, "缺少 canvas-stage");
assert.ok(
  !/catchtouch|capture-catchtouch/.test(stageTag[0]),
  "canvas-stage 不得重复绑定触摸事件"
);
assert.ok(
  /<canvas[\s\S]*?canvas-id="maskCanvas"[\s\S]*?disable-scroll="\{\{true\}\}"/.test(wxml),
  "Canvas 子组件必须继续阻止内部手势带动页面滚动"
);
assert.ok(
  /\.canvas-viewport[\s\S]*?touch-action:\s*none/.test(wxss),
  "画布视口必须保留禁止默认触摸动作的增强样式"
);
assert.ok(
  /onPageScroll\(event = \{\}\)[\s\S]*?this\._pageScrollTop = Math\.max\(0, scrollTop\);[\s\S]*?\},/.test(js),
  "页面滚动回调只能更新当前 scrollTop 缓存"
);
assert.ok(
  /createTouchCoordinateContext/.test(js)
    && /_gestureCoordinateContext/.test(js)
    && /_pinchAwaitingRelease/.test(js),
  "稳定坐标模式或双指抬手保护没有接入制作页"
);

console.log("page scroll isolation smoke: OK");
