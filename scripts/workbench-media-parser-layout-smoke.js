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
const workbenchJs = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.js"),
  "utf8"
);

assert.ok(
  wxml.includes(
    'class="card media-parser-entry common-feature-row home-feature-card workbench-link-card"'
  )
);
assert.ok(wxml.includes('<view class="media-parser-icon">印</view>'));
assert.ok(wxml.includes('<view class="media-parser-title">免费去水印</view>'));
assert.ok(
  wxml.includes(
    '<view class="media-parser-description">版权归平台，程序不储存任何内容</view>'
  )
);
assert.ok(wxml.includes('<view class="common-feature-action">打开</view>'));
assert.ok(wxml.includes('class="home-feature-arrow media-parser-arrow"'));

assert.ok(wxml.includes('recent-card-filled'));
assert.ok(wxml.includes('class="recent-list"'));
assert.ok(wxml.includes('class="recent-item"'));
assert.ok(wxml.includes('class="recent-image"'));
assert.match(workbenchJs, /\.slice\(\s*0\s*,\s*1\s*\)/);
assert.ok(!wxml.includes('class="recent-info"'));
assert.ok(!wxml.includes('class="recent-name"'));
assert.ok(!wxml.includes('class="recent-time"'));
assert.ok(!wxml.includes('class="recent-arrow"'));

const recentCardRules = [
  ...wxss.matchAll(/\.common-feature-panel \.recent-card-filled\s*\{([^}]*)\}/g),
].map((match) => match[1]);
assert.ok(
  recentCardRules.some((body) => /height:\s*auto\s*!important/.test(body))
);
assert.ok(
  recentCardRules.some((body) => /max-height:\s*none\s*!important/.test(body))
);
assert.ok(
  recentCardRules.some((body) => /overflow:\s*hidden/.test(body))
);
assert.ok(
  /\.common-feature-panel \.recent-card-filled\s*\{[^}]*flex-wrap:\s*wrap;/.test(wxss)
);

const emptyCardStyle = wxss.match(/\.recent-card-empty\s*\{([^}]*)\}/);
assert.ok(emptyCardStyle);
assert.match(emptyCardStyle[1], /min-height:\s*0/);
assert.ok(
  /\.common-feature-panel \.common-feature-row,\s*\.common-feature-panel \.entry-card-custom\s*\{[^}]*height:\s*148rpx\s*!important;/.test(wxss)
);

const recentListStyle = wxss.match(
  /\.common-feature-panel \.recent-card-filled \.recent-list\s*\{([^}]*)\}/
);
assert.ok(recentListStyle);
assert.match(recentListStyle[1], /flex:\s*0 0 100%/);
assert.match(recentListStyle[1], /width:\s*100%/);

const recentItemStyle = wxss.match(
  /\.common-feature-panel \.recent-card-filled \.recent-item\s*\{([^}]*)\}/
);
assert.ok(recentItemStyle);
assert.match(recentItemStyle[1], /min-height:\s*112rpx/);
assert.match(recentItemStyle[1], /padding-right:\s*0/);

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
