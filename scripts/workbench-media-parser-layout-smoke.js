const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const wxml = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxml"),
  "utf8"
);
const wxss = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxss"),
  "utf8"
);

assert.ok(
  wxml.includes(
    'class="card media-parser-entry common-feature-row home-feature-card workbench-link-card"'
  )
);
assert.ok(wxml.includes('<view class="media-parser-icon">析</view>'));
assert.ok(wxml.includes('<view class="media-parser-title">免费去水印</view>'));
assert.ok(
  wxml.includes(
    '<view class="media-parser-description">版权归平台及作者所有，本程序不储存任何内容</view>'
  )
);
assert.ok(wxml.includes('<view class="common-feature-action">打开</view>'));
assert.ok(wxml.includes('class="home-feature-arrow media-parser-arrow"'));

const entryStyle = wxss.match(/\.media-parser-entry\s*\{([^}]*)\}/);
assert.ok(entryStyle);
assert.match(entryStyle[1], /display:\s*flex\s*!important/);
assert.match(entryStyle[1], /flex-direction:\s*row\s*!important/);
assert.match(entryStyle[1], /height:\s*148rpx/);
assert.match(entryStyle[1], /width:\s*100%/);

const copyStyle = wxss.match(
  /\.media-parser-entry\s+\.media-parser-copy\s*\{([^}]*)\}/
);
assert.ok(copyStyle);
assert.match(copyStyle[1], /flex:\s*1 1 0/);
assert.match(copyStyle[1], /min-width:\s*0/);

const arrowStyle = wxss.match(
  /\.media-parser-entry\s+\.media-parser-arrow\s*\{([^}]*)\}/
);
assert.ok(arrowStyle);
assert.match(arrowStyle[1], /position:\s*absolute/);
assert.match(arrowStyle[1], /right:\s*18rpx/);

console.log("workbench media parser layout smoke: OK");
