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
    openid: "openid-alice",
    userHash: "aa11bb22cc33",
    nickname: "Alice 设计师",
    gender: "female",
    createdAt: new Date("2026-08-24T01:00:00.000Z")
  },
  {
    openid: "openid-bob",
    userHash: "bb22cc33dd44",
    nickname: "Bob 摄影",
    gender: "male",
    createdAt: new Date("2026-08-20T03:00:00.000Z")
  },
  {
    openid: "openid-seven-day",
    userHash: "cc33dd44ee55",
    nickname: "七天边界",
    gender: "female",
    createdAt: new Date("2026-08-18T08:00:00.000Z")
  },
  {
    openid: "openid-thirty-day",
    userHash: "dd44ee55ff66",
    nickname: "三十天边界",
    gender: "male",
    createdAt: new Date("2026-07-26T08:00:00.000Z")
  },
  {
    openid: "openid-old",
    userHash: "ee55ff66aa77",
    nickname: "更早用户",
    gender: "male",
    createdAt: new Date("2026-07-25T08:00:00.000Z")
  },
  {
    openid: "openid-incomplete",
    userHash: "ff66aa77bb88",
    nickname: "资料未完善",
    gender: "",
    createdAt: new Date("2026-08-24T02:00:00.000Z")
  }
];

const all = test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "all",
  baseDate
});
assert.strictEqual(all.total, 5);
assert.strictEqual(all.maleCount, 3);
assert.strictEqual(all.femaleCount, 2);
assert.strictEqual(all.users.length, 5);
assert.strictEqual(all.signupTrend.length, 7);

const nicknameSearch = test.buildAdminUserStats(rows, 0, 20, {
  search: "ALICE",
  dateRange: "all",
  baseDate
});
assert.strictEqual(nicknameSearch.total, 1);
assert.strictEqual(nicknameSearch.users[0].nickname, "Alice 设计师");

const hashSearch = test.buildAdminUserStats(rows, 0, 20, {
  search: "BB22CC33DD44",
  dateRange: "all",
  baseDate
});
assert.strictEqual(hashSearch.total, 1);
assert.strictEqual(hashSearch.users[0].userHash, "bb22cc33dd44");

assert.strictEqual(test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "today",
  baseDate
}).total, 1);
assert.strictEqual(test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "7d",
  baseDate
}).total, 3);
assert.strictEqual(test.buildAdminUserStats(rows, 0, 20, {
  dateRange: "30d",
  baseDate
}).total, 4);

const firstPage = test.buildAdminUserStats(rows, 0, 2, {
  dateRange: "all",
  baseDate
});
const secondPage = test.buildAdminUserStats(rows, firstPage.nextOffset, 2, {
  dateRange: "all",
  baseDate
});
assert.strictEqual(firstPage.users.length, 2);
assert.strictEqual(firstPage.nextOffset, 2);
assert.strictEqual(secondPage.users.length, 2);
assert.strictEqual(secondPage.nextOffset, 4);

const trendByDate = Object.fromEntries(
  all.signupTrend.map((item) => [item.dateKey, item.count])
);
assert.strictEqual(trendByDate["2026-08-18"], 1);
assert.strictEqual(trendByDate["2026-08-20"], 1);
assert.strictEqual(trendByDate["2026-08-24"], 1);
assert.strictEqual(
  all.signupTrend.reduce((total, item) => total + item.count, 0),
  3
);

const buffer = test.buildAdminUserExportWorkbook(rows, baseDate, {
  search: "bob",
  dateRange: "7d"
});
const workbook = XLSX.read(buffer, { type: "buffer" });
const summaryRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["统计摘要"],
  { header: 1 }
);
const detailRows = XLSX.utils.sheet_to_json(
  workbook.Sheets["用户明细"],
  { header: 1 }
);
assert.ok(summaryRows.some((row) => row[0] === "总用户数" && row[1] === 1));
assert.ok(summaryRows.some((row) => row[0] === "日期范围" && row[1] === "近7天"));
assert.ok(summaryRows.some((row) => row[0] === "搜索条件" && row[1] === "bob"));
assert.strictEqual(detailRows.length, 2);
assert.strictEqual(detailRows[1][1], "Bob 摄影");

const root = path.resolve(__dirname, "..");
const adminJs = fs.readFileSync(path.join(root, "pages/admin/admin.js"), "utf8");
const adminWxml = fs.readFileSync(path.join(root, "pages/admin/admin.wxml"), "utf8");
const adminWxss = fs.readFileSync(path.join(root, "pages/admin/admin.wxss"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");

[
  "onUserSearchInput",
  "applyUserSearch",
  "clearUserSearch",
  "selectUserDateRange",
  "formatUserSignupTrend"
].forEach((marker) => assert.ok(adminJs.includes(marker), `管理页缺少：${marker}`));
[
  "搜索昵称或匿名编号",
  "user-stats-date-filter",
  "最近7天新增用户",
  "user-signup-trend-chart"
].forEach((marker) => assert.ok(adminWxml.includes(marker), `页面缺少：${marker}`));
[
  ".user-stats-search-row",
  ".user-stats-date-option",
  ".user-signup-trend-chart"
].forEach((marker) => assert.ok(adminWxss.includes(marker), `样式缺少：${marker}`));
assert.ok(cloudJs.includes("getAdminUserStats(offset = 0, limit = 20, filters = {})"));
assert.ok(cloudJs.includes("exportAdminUserStats(filters = {})"));

console.log("admin user filter trend smoke: OK");
