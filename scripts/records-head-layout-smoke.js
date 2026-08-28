const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const wxml = fs.readFileSync(
  path.join(root, "pages/records/records.wxml"),
  "utf8"
);
const wxss = fs.readFileSync(
  path.join(root, "pages/records/records.wxss"),
  "utf8"
);
const js = fs.readFileSync(
  path.join(root, "pages/records/records.js"),
  "utf8"
);

assert.ok(wxml.includes('class="records-head-top"'));
assert.ok(wxml.includes('class="section-subtitle records-head-subtitle"'));
assert.ok(wxml.includes('bindtap="backToCreate"'));
assert.ok(wxml.includes(">返回工作台</button>"));
assert.ok(!wxml.includes("返回制作"));
assert.ok(
  wxml.indexOf("records-back-button")
    > wxml.indexOf("records-head-subtitle")
);

const headStyle = wxss.match(/\.records-head\s*\{([^}]*)\}/);
assert.ok(headStyle);
assert.match(headStyle[1], /display:\s*block/);

const topStyle = wxss.match(/\.records-head-top\s*\{([^}]*)\}/);
assert.ok(topStyle);
assert.match(topStyle[1], /display:\s*flex/);
assert.match(topStyle[1], /justify-content:\s*space-between/);

const subtitleStyle = wxss.match(/\.records-head-subtitle\s*\{([^}]*)\}/);
assert.ok(subtitleStyle);
assert.match(subtitleStyle[1], /overflow:\s*hidden/);
assert.match(subtitleStyle[1], /font-size:\s*20rpx/);
assert.match(subtitleStyle[1], /line-height:\s*30rpx/);
assert.match(subtitleStyle[1], /text-overflow:\s*ellipsis/);
assert.match(subtitleStyle[1], /white-space:\s*nowrap/);

const backStyle = wxss.match(/\.records-back-button\s*\{([^}]*)\}/);
assert.ok(backStyle);
assert.match(backStyle[1], /margin-top:\s*14rpx/);
assert.match(backStyle[1], /min-width:\s*156rpx/);
assert.ok(js.includes('wx.reLaunch({ url: "/pages/workbench/workbench" })'));

console.log("records head layout smoke: OK");
