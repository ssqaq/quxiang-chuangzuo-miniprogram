const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const accountUi = require(path.join(root, "utils", "account-ui"));

const cases = [
  [0, "0"],
  ["0", "0"],
  ["-0", "0"],
  ["0.0", "0"],
  [5, "5"],
  ["5.0", "5"],
  [0.1, "0.1"],
  ["0.1", "0.1"],
  [0.15, "0.1"],
  [0.99, "0.9"],
  [55.30000000000004, "55.3"],
  ["55.30000000000004", "55.3"],
  [55.400000000000006, "55.4"],
  ["55.400000000000006", "55.4"],
  [1.01, "1"],
  ["1.09", "1"],
  [-1.09, "-1"],
  ["-1.09", "-1"],
  [-0.1, "-0.1"],
  ["-0.09", "0"],
  [-0.19, "-0.1"],
  ["5.54e1", "55.4"],
  ["5.54e-1", "0.5"],
  ["9.99", "9.9"],
  ["12345.67", "12,345.6"],
  ["1e-1", "0.1"]
];

cases.forEach(([value, expected]) => {
  assert.strictEqual(accountUi.formatPoints(value), expected, `积分格式错误: ${value}`);
});
assert.strictEqual(accountUi.formatPoints(0.19, { signed: true }), "+0.1");
assert.strictEqual(accountUi.formatPoints(-0.19, { signed: true }), "-0.1");
assert.strictEqual(accountUi.formatPoints("1.09", { maxFractionDigits: 2 }), "1.09");
assert.strictEqual(accountUi.formatPoints("1.09", { maxFractionDigits: 0 }), "1");
assert.strictEqual(accountUi.formatPoints("invalid"), "--");
assert.strictEqual(accountUi.formatPoints(NaN), "--");
assert.strictEqual(accountUi.formatPoints(Infinity), "--");

const account = accountUi.normalizeAccount({ pointsBalance: "55.19", totalPurchasedPoints: "330.99" });
assert.strictEqual(account.pointsBalanceText, "55.1");
assert.strictEqual(account.totalPurchasedPointsText, "330.9");

const record = accountUi.normalizeRecord({
  id: "decimal-checkin",
  type: "checkin",
  amount: "0.19",
  balanceAfter: "55.19",
  createdAt: "2026-09-01T00:00:00.000Z"
});
assert.strictEqual(record.amountText, "+0.1");
assert.strictEqual(record.balanceAfterText, "余额 55.1");

const sourceChecks = [
  ["pages/points/points.js", /formatPoints\(/],
  ["pages/workbench/workbench.js", /formatPoints\(/],
  ["pages/recharge/recharge.js", /formatPoints\(/],
  ["pages/profile/profile.js", /formatPoints\(/],
  ["pages/user-center/user-center.js", /normalizeAccount\(/],
  ["pages/account-records/account-records.js", /normalizeRecord|records/]
];
sourceChecks.forEach(([file, pattern]) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert(pattern.test(source), `${file} 未接入统一积分显示链路`);
});

const forbiddenChecks = [
  ["pages/recharge/recharge.js", /Math\.(?:round|trunc)\([^\n]*(?:grantPoints|points)/],
  ["pages/points/points.js", /Math\.(?:round|trunc)\([^\n]*(?:earnedToday|pointsBalance|totalEarned)/],
  ["pages/workbench/workbench.js", /Math\.(?:round|trunc)\([^\n]*(?:earnedToday|pointsBalance|nextCheckinReward)/]
  , ["pages/profile/profile.js", /Math\.(?:round|trunc)\([^\n]*earnedToday/]
];
forbiddenChecks.forEach(([file, pattern]) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert(!pattern.test(source), `${file} 仍在对积分展示做整数舍入`);
});

console.log("account points format smoke passed");
