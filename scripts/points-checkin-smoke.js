const assert = require("assert");
const config = require("../config");
const pointsUi = require("../utils/points-ui");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;
const db = helpers.getTestDatabase();

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function createMemoryStore() {
  const records = new Map();
  const collection = (name) => ({
    doc(id) {
      const key = `${name}/${id}`;
      return {
        async get() {
          if (!records.has(key)) {
            const error = new Error("document not exist");
            error.code = "DATABASE_DOCUMENT_NOT_EXIST";
            throw error;
          }
          return { data: clone(records.get(key)) };
        },
        async set({ data }) {
          if (data && Object.prototype.hasOwnProperty.call(data, "_id")) {
            const error = new Error("不能更新_id的值");
            error.code = "-501007";
            throw error;
          }
          records.set(key, clone(data));
          return { stats: { updated: 1 } };
        },
        async remove() {
          records.delete(key);
          return { stats: { removed: 1 } };
        }
      };
    },
    where(query = {}) {
      return {
        limit(max) {
          return {
            async get() {
              const prefix = `${name}/`;
              const rows = [...records.entries()]
                .filter(([key, value]) => (
                  key.startsWith(prefix)
                  && Object.keys(query).every((field) => value[field] === query[field])
                ))
                .slice(0, Number(max) || 20)
                .map(([key, value]) => Object.assign(
                  { _id: key.slice(prefix.length) },
                  clone(value)
                ));
              return { data: rows };
            }
          };
        }
      };
    }
  });
  return { records, collection };
}

function valuesFor(store, collectionName) {
  const prefix = `${collectionName}/`;
  return [...store.records.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value);
}

const points = helpers.resolvePointsConfig({});
assert.strictEqual(config.points.copy.cardTitle, "每日签到");
assert.strictEqual(config.points.copy.promoActive, "活动期间限时全功能不扣积分");
assert.strictEqual(config.points.copy.checkInDuplicate, "今天已经签到过了");
assert.strictEqual(config.points.copy.usageTitle, "使用说明");
assert.strictEqual(config.points.copy.backToWorkbench, "返回工作台");
assert.strictEqual(pointsUi.formatPromoDate("2026-08-24"), "8月24日");
assert.strictEqual(
  pointsUi.formatPromoRange("2026-08-24", "2026-08-25"),
  "8月24日-8月25日"
);
assert.strictEqual(
  pointsUi.buildPromoLabel("2026-08-24", "2026-08-25"),
  "8月24日-8月25日活动期间限时全功能不扣积分"
);
const promoEndAt = pointsUi.promoEndAtMs("2026-08-25");
assert.strictEqual(promoEndAt, Date.parse("2026-08-26T00:00:00.000+08:00"));
assert.strictEqual(pointsUi.getPromoRefreshDelay("2026-08-25", promoEndAt - 1500), 1500);
assert.strictEqual(pointsUi.getPromoRefreshDelay("2026-08-25", promoEndAt), 0);
assert.strictEqual(points.dailyFreeLimit, 3);
assert.strictEqual(points.imageCost, 10);
assert.strictEqual(points.videoCost, 10);
assert.strictEqual(points.checkinPoints, 5);
assert.strictEqual(points.streakBonus, 20);
assert.strictEqual(points.streakDays, 7);
assert.strictEqual(helpers.isPromoDate("2026-08-24", points), true);
assert.strictEqual(helpers.isPromoDate("2026-08-25", points), true);
assert.strictEqual(helpers.isPromoDate("2026-08-26", points), false);
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
const legacyAccountSummary = helpers.pointsSummary({
  pointsBalance: 12,
  totalEarned: 20,
  totalSpent: 8,
  currentStreak: 0,
  lastCheckinDate: ""
}, { data: {} }, points, "2026-08-30");
assert.strictEqual(legacyAccountSummary.totalPurchasedPoints, 0);
assert.strictEqual(legacyAccountSummary.totalReversedPurchasedPoints, 0);

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

  const store = createMemoryStore();
  const originalCollection = db.collection;
  const originalRunTransaction = db.runTransaction;
  db.collection = store.collection;
  db.runTransaction = async (callback) => callback({ collection: store.collection });
  try {
    const user = { OPENID: "same-day-checkin-user" };
    const first = await helpers.checkIn(user);
    const duplicate = await helpers.checkIn(user);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.duplicate, false);
    assert.strictEqual(first.earnedToday, 5);
    assert.strictEqual(first.pointsBalance, 5);
    assert.strictEqual(first.totalEarned, 5);
    assert.strictEqual(first.totalPurchasedPoints, 0);
    assert.strictEqual(first.totalReversedPurchasedPoints, 0);
    assert.strictEqual(first.currentStreak, 1);
    assert.strictEqual(duplicate.ok, true);
    assert.strictEqual(duplicate.duplicate, true);
    assert.strictEqual(duplicate.earnedToday, 0);
    assert.strictEqual(duplicate.pointsBalance, 5);
    assert.strictEqual(duplicate.totalEarned, 5);
    assert.strictEqual(duplicate.currentStreak, 1);
    const accounts = valuesFor(store, "user_accounts");
    const checkinLedger = valuesFor(store, "point_ledger")
      .filter((item) => item.type === "checkin");
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].pointsBalance, 5);
    assert.strictEqual(accounts[0].totalEarned, 5);
    assert.strictEqual(accounts[0].totalPurchasedPoints, 0);
    assert.strictEqual(accounts[0].totalReversedPurchasedPoints, 0);
    assert.strictEqual(accounts[0].currentStreak, 1);
    assert.strictEqual(checkinLedger.length, 1);
    assert.strictEqual(checkinLedger[0].amount, 5);
    assert.strictEqual(checkinLedger[0].balanceAfter, 5);
  } finally {
    db.collection = originalCollection;
    db.runTransaction = originalRunTransaction;
  }

  console.log("points/check-in smoke: OK");
}

main().catch((error) => {
  console.error(`points/check-in smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
