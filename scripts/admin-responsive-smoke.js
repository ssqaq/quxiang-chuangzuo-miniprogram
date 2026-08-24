/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxss = fs.readFileSync(path.join(root, "pages/admin/admin.wxss"), "utf8");
const wxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");

function mediaBlock(startMarker, endMarker) {
  const start = wxss.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `缺少响应式区间：${startMarker}`);
  const end = wxss.indexOf(endMarker, start);
  return wxss.slice(start, end === -1 ? wxss.length : end);
}

assert.ok(wxss.includes("--admin-space-"), "管理员页没有统一间距变量");
assert.ok(wxss.includes("--admin-radius-"), "管理员页没有统一圆角变量");
assert.ok(wxss.includes("border-radius: var(--admin-radius-card)"), "主卡片没有使用统一圆角变量");
assert.ok(wxss.includes("border-radius: var(--admin-radius-control)"), "操作按钮没有使用统一圆角变量");
assert.ok(wxml.includes("class=\"quick-launch-grid\""), "快捷入口结构缺失");
assert.ok(wxml.includes("class=\"monitor-section-toggle-button\""), "展开按钮结构缺失");

const usageAlignmentStart = wxss.indexOf("/* 模型用量统计与失败情况的三项操作按同一组基准线对齐。 */");
assert.notStrictEqual(usageAlignmentStart, -1, "缺少模型用量与失败情况的统一对齐规则");
const usageAlignmentBlock = wxss.slice(usageAlignmentStart);
[
  ".usage-primary-actions,\n.usage-failure-actions",
  "gap: 6rpx",
  ".usage-primary-actions > .usage-refresh-button,\n.usage-failure-actions > picker",
  "flex: 0 0 126rpx",
  ".usage-primary-actions > .usage-export-button,\n.usage-failure-actions > .model-failure-export-button",
  "flex: 0 0 176rpx",
  ".usage-primary-actions > .monitor-section-toggle-button,\n.usage-failure-actions > .usage-subsection-toggle",
  "flex: 0 0 96rpx",
  "height: 54rpx",
  "font-size: 20rpx",
  "border-radius: 14rpx"
].forEach((marker) => {
  assert.ok(usageAlignmentBlock.includes(marker), `用量/失败情况对齐规则缺少：${marker}`);
});

const widthCases = [
  {
    width: 375,
    block: mediaBlock("@media (min-width: 360px) and (max-width: 389px)", "@media (min-width: 400px)"),
    required: [
      ".admin-page",
      ".quick-launch-grid",
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
      "height: 132rpx"
    ]
  },
  {
    width: 414,
    block: mediaBlock("@media (min-width: 400px) and (max-width: 430px)", "@media (max-width: 360px)"),
    required: [
      ".admin-page",
      ".quick-launch-grid",
      "grid-template-columns: repeat(4, minmax(0, 1fr))",
      "height: 136rpx"
    ]
  }
];

widthCases.forEach(({ width, block, required }) => {
  required.forEach((marker) => {
    assert.ok(block.includes(marker), `${width}px 适配缺少：${marker}`);
  });
});

console.log("admin responsive smoke: OK (375/414 宽度规则)");
