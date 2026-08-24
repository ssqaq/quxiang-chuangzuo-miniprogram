const assert = require("assert");
const config = require("../config");
const pointsUi = require("../utils/points-ui");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;

const points = helpers.resolvePointsConfig({});
assert.strictEqual(config.points.copy.cardTitle, "每日签到");
assert.strictEqual(config.points.copy.promoActive, "活动期间免费");
assert.strictEqual(config.points.copy.checkInDuplicate, "今天已经签到过了");
assert.strictEqual(config.points.copy.usageTitle, "使用说明");
assert.strictEqual(config.points.copy.backToWorkbench, "返回工作台");
const promoEndAt = pointsUi.promoEndAtMs("2026-08-24");
assert.strictEqual(promoEndAt, Date.parse("2026-08-25T00:00:00.000+08:00"));
assert.strictEqual(pointsUi.getPromoRefreshDelay("2026-08-24", promoEndAt - 1500), 1500);
assert.strictEqual(pointsUi.getPromoRefreshDelay("2026-08-24", promoEndAt), 0);
assert.strictEqual(points.dailyFreeLimit, 3);
assert.strictEqual(points.imageCost, 10);
assert.strictEqual(points.videoCost, 10);
assert.strictEqual(points.checkinPoints, 5);
assert.strictEqual(points.streakBonus, 20);
assert.strictEqual(points.streakDays, 7);
assert.strictEqual(helpers.isPromoDate("2026-08-23", points), true);
assert.strictEqual(helpers.isPromoDate("2026-08-24", points), true);
assert.strictEqual(helpers.isPromoDate("2026-08-25", points), false);
assert.strictEqual(helpers.shiftDateKey("2026-08-23", -1), "2026-08-22");
assert.strictEqual(helpers.calculateNextStreak("", 0, "2026-08-23"), 1);
assert.strictEqual(helpers.calculateNextStreak("2026-08-22", 1, "2026-08-23"), 2);
assert.strictEqual(helpers.calculateNextStreak("2026-08-20", 4, "2026-08-23"), 1);
assert.strictEqual(
  helpers.getOpenId(
    { OPENID: "direct-openid" },
    () => ({ OPENID: "sdk-openid" })
  ),
  "direct-openid"
);
assert.strictEqual(
  helpers.getOpenId({}, () => ({ OPENID: "sdk-openid" })),
  "sdk-openid"
);
assert.strictEqual(
  helpers.getOpenId({}, () => ({})),
  "anonymous"
);
assert.strictEqual(
  helpers.getOpenId({}, () => {
    throw new Error("模拟身份读取失败");
  }),
  "anonymous"
);
assert.deepStrictEqual(
  helpers.stripDocumentId({ _id: "document-id", value: 1 }),
  { value: 1 }
);

async function main() {
  const summary = await api.main({ action: "getUserPoints", requestId: "points-anonymous" }, {});
  assert.strictEqual(summary.ok, true);
  assert.strictEqual(summary.accountBound, false);

  const checkIn = await api.main({ action: "checkIn", requestId: "checkin-anonymous" }, {});
  assert.strictEqual(checkIn.ok, false);
  assert.strictEqual(checkIn.errorCode, "wechat-binding-required");

  const ledger = await api.main({ action: "getPointLedger", requestId: "ledger-anonymous" }, {});
  assert.strictEqual(ledger.ok, true);
  assert.deepStrictEqual(ledger.records, []);

  console.log("points/check-in smoke: OK");
}

main().catch((error) => {
  console.error(`points/check-in smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
