/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const XLSX = require("../cloudfunctions/api/node_modules/xlsx");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露用户筛选测试接口。");

const baseDate = new Date("2026-08-24T04:00:00.000Z");
const rows = [
  {
    openid: "openid-alice-private",
    userHash: "aa11bb22cc33",
    nickname: "Alice 设计师",
    gender: "female",
    createdAt: new Date("2026-08-18T16:00:00.000Z"),
    updatedAt: new Date("2026-08-23T03:00:00.000Z")
  },
  {
    openid: "openid-bob-private",
    userHash: "bb22cc33dd44",
    nickname: "Bob 摄影师",
    gender: "male",
    createdAt: new Date("2026-08-19T15:59:59.999Z"),
    updatedAt: new Date("2026-08-22T03:00:00.000Z")
  },
  {
    openid: "openid-carol-private",
    userHash: "cc33dd44ee55",
    nickname: "Carol 模特",
    gender: "female",
    createdAt: new Date("2026-08-20T16:00:00.000Z"),
    updatedAt: new Date("2026-08-21T03:00:00.000Z")
  },
  {
    openid: "openid-today-private",
    userHash: "dd44ee55ff66",
    nickname: "今天用户",
    gender: "male",
    createdAt: new Date("2026-08-24T01:00:00.000Z"),
    updatedAt: new Date("2026-08-24T02:00:00.000Z")
  },
  {
    openid: "openid-old-private",
    userHash: "ee55ff66aa77",
    nickname: "旧用户",
    gender: "male",
    createdAt: new Date("2026-08-18T15:59:59.999Z"),
    updatedAt: new Date("2026-08-18T15:59:59.999Z")
  }
];

const customBoundary = test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "custom",
  startDate: "2026-08-19",
  endDate: "2026-08-19",
  baseDate
});
assert.strictEqual(customBoundary.total, 2, "自定义日期应包含当天首尾边界。");
assert.deepStrictEqual(
  customBoundary.users.map((item) => item.nickname).sort(),
  ["Alice 设计师", "Bob 摄影师"].sort()
);

const reversedCustom = test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "custom",
  startDate: "2026-08-21",
  endDate: "2026-08-19",
  baseDate
});
assert.strictEqual(reversedCustom.startDate, "2026-08-19");
assert.strictEqual(reversedCustom.endDate, "2026-08-21");
assert.strictEqual(reversedCustom.total, 3);

const futureCustom = test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "custom",
  startDate: "2030-01-01",
  endDate: "2030-01-02",
  baseDate
});
assert.strictEqual(futureCustom.startDate, "2026-08-24");
assert.strictEqual(futureCustom.endDate, "2026-08-24");
assert.strictEqual(futureCustom.total, 1, "未来日期应收紧到今天。");

const combined = test.buildAdminUserStats(rows, 0, 20, {
  search: "alice",
  dateRange: "custom",
  gender: "female",
  startDate: "2026-08-19",
  endDate: "2026-08-20",
  baseDate
});
assert.strictEqual(combined.total, 1, "搜索、日期和性别应能组合筛选。");
assert.strictEqual(combined.femaleCount, 1);
assert.strictEqual(combined.maleCount, 0);
assert.strictEqual(combined.users[0].nickname, "Alice 设计师");
assert.ok(combined.users[0].createdAt, "详情需要首次完善时间。");
assert.ok(combined.users[0].updatedAt, "详情需要最近修改时间。");
assert.ok(!Object.prototype.hasOwnProperty.call(combined.users[0], "openid"));
assert.ok(
  !JSON.stringify(combined.users[0]).includes("openid-alice-private"),
  "用户详情不能返回原始 OpenID。"
);

const workbookBuffer = test.buildAdminUserExportWorkbook(rows, baseDate, {
  search: "alice",
  dateRange: "custom",
  gender: "female",
  startDate: "2026-08-19",
  endDate: "2026-08-20"
});
const workbook = XLSX.read(workbookBuffer, { type: "buffer" });
const summaryRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["统计摘要"],
  { header: 1 }
);
const detailRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["用户明细"],
  { header: 1 }
);
assert.ok(
  summaryRows.some(
    (row) => row[0] === "日期范围" && row[1] === "2026-08-19 至 2026-08-20"
  )
);
assert.ok(summaryRows.some((row) => row[0] === "性别范围" && row[1] === "女性"));
assert.ok(summaryRows.some((row) => row[0] === "搜索条件" && row[1] === "alice"));
assert.strictEqual(detailRows.length, 2);
assert.ok(
  !JSON.stringify(detailRows).includes("openid-alice-private"),
  "导出的用户明细不能包含原始 OpenID。"
);

const root = path.resolve(__dirname, "..");
const adminJs = fs.readFileSync(path.join(root, "pages/admin/admin.js"), "utf8");
const adminWxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");
const adminWxss = fs.readFileSync(path.join(root, "pages/admin/admin.wxss"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");

const usersSectionStart = adminWxml.indexOf(
  '<view wx:if="{{activeConfigSection === \'users\'}}" class="config-editor-body">'
);
const usersSectionEnd = adminWxml.indexOf(
  '<view wx:if="{{activeConfigSection !== \'users\'}}" class="admin-actions">',
  usersSectionStart
);
assert.ok(usersSectionStart >= 0 && usersSectionEnd > usersSectionStart);
const usersSection = adminWxml.slice(usersSectionStart, usersSectionEnd);

[
  "userDateRange === 'custom'",
  "onUserCustomStartChange",
  "onUserCustomEndChange",
  "user-stats-gender-filter",
  "selectUserGender",
  "openUserDetail",
  "userDetailVisible && selectedUserDetail",
  "首次完善资料",
  "最近修改时间"
].forEach((marker) => {
  assert.ok(usersSection.includes(marker), `用户统计区缺少：${marker}`);
});

assert.strictEqual(
  (adminWxml.match(/class="user-custom-date-row"/g) || []).length,
  1,
  "自定义日期控件只能出现在用户统计区一次。"
);
assert.strictEqual(
  (adminWxml.match(/class="user-stats-gender-filter"/g) || []).length,
  1,
  "性别筛选只能出现在用户统计区一次。"
);
assert.ok(
  !usersSection.includes("{{selectedUserDetail.openid}}")
    && !usersSection.includes("{{selectedUserDetail.openId}}")
    && !usersSection.includes("{{selectedUserDetail._openid}}"),
  "用户详情弹层不能显示原始 OpenID。"
);

[
  "buildUserStatsFilters",
  "selectUserGender",
  "onUserCustomStartChange",
  "onUserCustomEndChange",
  "openUserDetail",
  "closeUserDetail"
].forEach((marker) => assert.ok(adminJs.includes(marker), `管理页缺少：${marker}`));

[
  ".user-custom-date-row",
  ".user-stats-gender-filter",
  ".user-detail-mask",
  ".user-detail-sheet"
].forEach((marker) => assert.ok(adminWxss.includes(marker), `样式缺少：${marker}`));

[
  'gender: String(filters.gender || "all")',
  'startDate: String(filters.startDate || "")',
  'endDate: String(filters.endDate || "")'
].forEach((marker) => assert.ok(cloudJs.includes(marker), `云端调用缺少：${marker}`));

console.log("admin user gender custom date detail smoke: OK");
