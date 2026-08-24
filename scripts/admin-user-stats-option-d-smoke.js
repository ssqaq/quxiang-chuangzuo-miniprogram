/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const wxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(root, "pages/admin/admin.wxss"), "utf8");

const usersSectionStart = wxml.indexOf(
  '<view wx:if="{{activeConfigSection === \'users\'}}" class="config-editor-body">'
);
const usersSectionEnd = wxml.indexOf(
  '<view wx:if="{{activeConfigSection !== \'users\'}}" class="admin-actions">',
  usersSectionStart
);

assert.ok(usersSectionStart >= 0, "没有找到用户统计配置区。");
assert.ok(usersSectionEnd > usersSectionStart, "用户统计配置区结束位置不正确。");

const usersSection = wxml.slice(usersSectionStart, usersSectionEnd);

[
  "user-stats-d-head",
  "user-stats-d-helper",
  "user-stats-d-overview",
  "user-stats-d-total-value",
  "user-stats-d-donut",
  "user-stats-d-gender-grid",
  "user-stats-d-list-title",
  "user-stats-d-user-row"
].forEach((className) => {
  assert.ok(
    usersSection.includes(className),
    `D方案缺少页面结构：${className}`
  );
  assert.ok(
    wxss.includes(`.${className}`),
    `D方案缺少样式：${className}`
  );
});

assert.ok(
  usersSection.includes("这里显示已保存个人资料的用户，不是小程序访问人数。"),
  "没有用大白话说明用户统计范围。"
);
assert.ok(
  usersSection.includes("{{userStats.total}}"),
  "D方案没有展示总用户数。"
);
assert.ok(
  usersSection.includes("已完善资料的用户")
    && !usersSection.includes(">名用户<"),
  "总人数下方没有改成“已完善资料的用户”。"
);
assert.ok(
  usersSection.includes("{{userStats.femaleRatio}}%"),
  "D方案圆环没有展示女性占比。"
);
assert.ok(
  usersSection.includes("{{userStats.maleCount}}")
    && usersSection.includes("{{userStats.femaleCount}}"),
  "D方案没有同时展示男女人数。"
);
assert.ok(
  usersSection.includes('bindtap="refreshUserStats"')
    && usersSection.includes('bindtap="exportUserStats"')
    && usersSection.includes('bindtap="loadMoreUsers"'),
  "刷新、导出或加载更多功能被破坏。"
);
assert.ok(
  usersSection.includes("编号 {{item.userHash}}"),
  "匿名用户编号没有保留。"
);
assert.ok(
  !usersSection.includes("{{item.openid}}")
    && !usersSection.includes("{{item.openId}}")
    && !usersSection.includes("{{item._openid}}"),
  "用户统计区不应显示原始 OpenID。"
);
assert.ok(
  !usersSection.includes("user-stats-toolbar")
    && !usersSection.includes("user-summary-grid")
    && !usersSection.includes("gender-ratio-bar"),
  "旧的拥挤排版仍残留在用户统计区。"
);

console.log("admin user stats option D smoke: OK");
