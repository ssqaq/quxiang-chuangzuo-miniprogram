/* eslint-disable no-console */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const accountPath = require.resolve(path.join(root, "services", "account.js"));
const cloudPath = require.resolve(path.join(root, "services", "cloud.js"));
const oldAccountCache = require.cache[accountPath];
const oldCloudCache = require.cache[cloudPath];
const oldWx = global.wx;
const oldPage = global.Page;

let paymentCalls = 0;
let pointsCalls = 0;
let ledgerCalls = 0;
let pointsError = null;
let ledgerError = null;
let ledgerRows = [
  {
    id: "checkin-1",
    type: "checkin",
    amount: 55,
    balanceAfter: 55,
    description: "每日签到奖励",
    createdAt: "2026-08-30T15:00:00.000Z"
  },
  {
    id: "spend-1",
    type: "spend",
    amount: -10,
    balanceAfter: 45,
    description: "图片生成",
    createdAt: "2026-08-29T15:00:00.000Z"
  },
  {
    id: "recharge-1",
    type: "recharge",
    amount: 100,
    balanceAfter: 145,
    description: "充值",
    createdAt: "2026-08-28T15:00:00.000Z"
  },
  {
    id: "purchase-1",
    type: "purchase",
    amount: 100,
    balanceAfter: 245,
    description: "旧类型，不应进入充值筛选",
    createdAt: "2026-08-27T15:00:00.000Z"
  },
  {
    id: "refund-1",
    type: "refund",
    amount: 10,
    balanceAfter: 155,
    description: "支付退回",
    createdAt: "2026-08-26T15:00:00.000Z"
  },
  {
    id: "reversal-1",
    type: "payment-reversal",
    amount: 10,
    balanceAfter: 165,
    description: "支付冲正",
    createdAt: "2026-08-25T15:00:00.000Z"
  },
  {
    id: "daily-free-1",
    type: "daily-free",
    amount: 0,
    balanceAfter: 165,
    description: "每日免费次数",
    createdAt: "2026-08-24T15:00:00.000Z"
  },
  {
    id: "promo-free-1",
    type: "promo-free",
    amount: 0,
    balanceAfter: 165,
    description: "活动赠送",
    createdAt: "2026-08-23T15:00:00.000Z"
  },
  {
    id: "secret-1",
    type: "unknown",
    amount: "not-a-number",
    balanceAfter: "not-a-number",
    description: "x".repeat(200),
    secret: "must-not-leak",
    createdAt: { seconds: 1788102000 }
  }
];

const cloudStub = {
  isCloudReady() {
    return true;
  },
  getUserPoints() {
    pointsCalls += 1;
    return pointsError
      ? Promise.reject(pointsError)
      : Promise.resolve({
        ok: true,
        accountBound: true,
        pointsBalance: 55,
        totalEarned: 55,
        totalSpent: 0,
        totalPurchasedPoints: 0,
        currentStreak: 7,
        lastCheckinDate: "2026-08-30"
      });
  },
  getMyUserProfile() {
    return Promise.resolve({ nickname: "顺顺利利" });
  },
  getPointLedger() {
    ledgerCalls += 1;
    if (ledgerError) return Promise.reject(ledgerError);
    return Promise.resolve({
      ok: true,
      records: ledgerRows.map((item) => Object.assign({}, item))
    });
  }
};

function loadUserCenterPage() {
  let pageDefinition = null;
  const userCenterPath = require.resolve(path.join(root, "pages", "user-center", "user-center.js"));
  delete require.cache[userCenterPath];
  global.Page = (definition) => {
    pageDefinition = definition;
  };
  require(userCenterPath);
  assert.ok(pageDefinition, "用户中心必须注册 Page");
  return Object.assign({}, pageDefinition, {
    data: Object.assign({}, pageDefinition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    }
  });
}

async function main() {
  try {
    require.cache[cloudPath] = {
      id: cloudPath,
      filename: cloudPath,
      loaded: true,
      exports: cloudStub
    };
    delete require.cache[accountPath];
    global.wx = {
      cloud: {
        callFunction(options) {
          paymentCalls += 1;
          options.fail({
            errCode: -501000,
            errMsg: "cloud.callFunction:fail FUNCTION_NOT_FOUND"
          });
        }
      }
    };

    const accountService = require(accountPath);
    const helpers = accountService.__test__;

    const overview = await accountService.getAccountOverview();
    assert.strictEqual(paymentCalls, 1, "先尝试 payment-api 一次");
    assert.strictEqual(pointsCalls, 1, "payment-api 缺失后读取 api 积分余额");
    assert.strictEqual(ledgerCalls, 1, "payment-api 缺失后读取 api 积分记录");
    assert.strictEqual(overview.account.pointsBalance, 55);
    assert.strictEqual(overview.account.currentStreak, 7);
    assert.strictEqual(overview.recentRecords[0].type, "checkin");
    assert.strictEqual(overview.source, "points-api-fallback");
    assert.strictEqual(overview.recordsUnavailable, false);

    const sanitized = helpers.sanitizePointLedgerRecord(ledgerRows[8], 8);
    assert.strictEqual(sanitized.amount, 0, "非法积分数值必须归零");
    assert.strictEqual(sanitized.balanceAfter, 0, "非法余额数值必须归零");
    assert.strictEqual(sanitized.description.length, 160, "描述必须截断到安全长度");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(sanitized, "secret"), false);
    assert.ok(sanitized.createdAt, "微信时间戳对象必须能格式化");

    const allRecords = await accountService.getAccountRecords({ type: "all", limit: 20 });
    assert.strictEqual(allRecords.items.length, ledgerRows.length, "回退记录返回旧 api 提供的完整批次");
    assert.deepStrictEqual(
      allRecords.items.map((item) => item.id),
      ledgerRows.map((item) => item.id),
      "全部筛选必须保留旧类型和未知类型"
    );
    assert.strictEqual(allRecords.hasMore, false);
    assert.strictEqual(allRecords.paginationLimited, false);
    const spend = await accountService.getAccountRecords({ type: "spend", limit: 20 });
    assert.deepStrictEqual(spend.items.map((item) => item.type), ["spend"]);
    const recharge = await accountService.getAccountRecords({ type: "recharge", limit: 20 });
    assert.deepStrictEqual(recharge.items.map((item) => item.id), ["recharge-1"]);
    const reward = await accountService.getAccountRecords({ type: "reward", limit: 20 });
    assert.deepStrictEqual(
      reward.items.map((item) => item.type),
      ["checkin", "daily-free", "promo-free"]
    );
    const refunds = await accountService.getAccountRecords({ type: "refund", limit: 20 });
    assert.deepStrictEqual(refunds.items.map((item) => item.type), ["refund", "payment-reversal"]);

    const expectedFilterTypes = {
      all: [],
      recharge: ["recharge"],
      spend: ["spend"],
      reward: ["checkin", "daily-free", "promo-free"],
      refund: ["refund", "payment-reversal"]
    };
    Object.entries(expectedFilterTypes).forEach(([filter, types]) => {
      assert.deepStrictEqual(helpers.recordTypes(filter), types, `${filter} 回退类型矩阵必须固定`);
    });
    assert.deepStrictEqual(
      helpers.recordTypes(" Reward "),
      expectedFilterTypes.reward,
      "回退筛选必须先 trim 并转成小写"
    );
    const narrowFilters = ["recharge", "spend", "reward", "refund"];
    const expectedMembership = {
      recharge: "recharge",
      spend: "spend",
      checkin: "reward",
      "daily-free": "reward",
      "promo-free": "reward",
      refund: "refund",
      "payment-reversal": "refund"
    };
    Object.entries(expectedMembership).forEach(([type, expectedFilter]) => {
      const matched = narrowFilters.filter((filter) => helpers.matchesRecordFilter({ type }, filter));
      assert.deepStrictEqual(matched, [expectedFilter], `${type} 必须只属于一个窄筛选`);
    });
    ["purchase", "unknown", "future-v2", ""].forEach((type) => {
      const matched = narrowFilters.filter((filter) => helpers.matchesRecordFilter({ type }, filter));
      assert.deepStrictEqual(matched, [], `${type || "空类型"} 只能由全部筛选兜底`);
      assert.strictEqual(helpers.matchesRecordFilter({ type }, "all"), true);
    });
    const paymentCallsBeforeInvalidFilter = paymentCalls;
    await assert.rejects(
      () => accountService.getAccountRecords({ type: " Unsupported ", cursor: "legacy-cursor" }),
      (error) => error && error.code === "PAYMENT_RECORD_FILTER_INVALID"
    );
    assert.strictEqual(
      paymentCalls,
      paymentCallsBeforeInvalidFilter,
      "主路径必须在调用 payment-api 前校验筛选"
    );
    await assert.rejects(
      () => helpers.getPointsFallbackRecords({ type: " Unsupported ", cursor: "legacy-cursor" }),
      (error) => error && error.code === "PAYMENT_RECORD_FILTER_INVALID"
    );
    const ledgerCallsBeforeInvalidNetwork = ledgerCalls;
    ledgerError = new Error("ledger network unavailable");
    await assert.rejects(
      () => helpers.getPointsFallbackRecords({ type: " Unsupported " }),
      (error) => error && error.code === "PAYMENT_RECORD_FILTER_INVALID"
    );
    assert.strictEqual(
      ledgerCalls,
      ledgerCallsBeforeInvalidNetwork,
      "非法筛选必须在账本网络请求前失败"
    );
    ledgerError = null;
    await assert.rejects(
      () => accountService.getAccountRecords({ cursor: "legacy-cursor" }),
      (error) => error && error.code === "ACCOUNT_RECORDS_PAGINATION_UNAVAILABLE"
    );

    ledgerRows = Array.from({ length: 50 }, (_value, index) => ({
      id: `raw-page-${index}`,
      type: index === 0 ? "spend" : "unknown",
      amount: index === 0 ? -1 : 0,
      balanceAfter: 0,
      description: index === 0 ? "积分消费" : "历史记录",
      createdAt: `2026-07-${String(31 - Math.floor(index / 2)).padStart(2, "0")}T15:00:00.000Z`
    }));
    const narrowLimited = await accountService.getAccountRecords({ type: " Spend ", limit: 20 });
    assert.deepStrictEqual(narrowLimited.items.map((item) => item.id), ["raw-page-0"]);
    assert.strictEqual(
      narrowLimited.paginationLimited,
      true,
      "原始批次达到 50 条时，窄筛选命中少也必须标记分页受限"
    );

    ledgerRows = Array.from({ length: 55 }, (_value, index) => ({
      id: `row-${index}`,
      type: "checkin",
      amount: 1,
      balanceAfter: index + 1,
      description: "签到",
      createdAt: `2026-08-${String(30 - Math.floor(index / 2)).padStart(2, "0")}T15:00:00.000Z`
    }));
    const limited = await accountService.getAccountRecords({ type: "all", limit: 20 });
    assert.strictEqual(limited.items.length, 50, "旧 api 固定只提供最近 50 条");
    assert.strictEqual(limited.paginationLimited, true, "超过 50 条必须明确标记分页受限");
    assert.strictEqual(limited.hasMore, false, "没有游标能力时不能伪造下一页");

    ledgerRows = [];
    ledgerError = new Error("ledger unavailable");
    const overviewWithoutLedger = await accountService.getAccountOverview();
    assert.strictEqual(overviewWithoutLedger.account.pointsBalance, 55, "账本失败不能影响余额展示");
    assert.strictEqual(overviewWithoutLedger.recordsUnavailable, true);
    assert.deepStrictEqual(overviewWithoutLedger.recentRecords, []);
    await assert.rejects(
      () => accountService.getAccountRecords({ type: "all" }),
      (error) => error && error.code === "ACCOUNT_POINTS_FALLBACK_UNAVAILABLE"
    );

    pointsError = new Error("api unavailable");
    await assert.rejects(
      () => accountService.getAccountOverview(),
      (error) => error && error.code === "ACCOUNT_POINTS_FALLBACK_UNAVAILABLE"
    );

    ledgerError = null;
    pointsError = null;
    ledgerRows = [
      {
        id: "checkin-page",
        type: "checkin",
        amount: 55,
        balanceAfter: 55,
        description: "每日签到奖励",
        createdAt: "2026-08-30T15:00:00.000Z"
      }
    ];
    const page = loadUserCenterPage();
    await page.loadUserCenter();
    assert.strictEqual(page.data.accountServicePreparing, false, "余额回退成功后不能显示准备中");
    assert.strictEqual(page.data.account.pointsBalanceText, "55", "用户中心应显示签到余额");
    assert.strictEqual(page.data.recentRecords[0].type, "checkin", "用户中心应显示签到记录");
    assert.strictEqual(page.data.rechargeVisible, true, "payment-api 未上线时仍应保留充值入口");
    assert.strictEqual(page.data.rechargeDisabled, true, "payment-api 未上线时充值入口必须禁用");
    assert.strictEqual(page.data.rechargeHint, "充值服务暂未开放", "payment-api 未上线时必须提示服务状态");

    ledgerError = new Error("ledger unavailable");
    await page.loadUserCenter();
    assert.strictEqual(page.data.account.pointsBalanceText, "55", "账本失败时余额仍然可见");
    assert.strictEqual(page.data.recordsError, "最近记录暂时无法读取。", "账本失败必须进入错误态");
    assert.strictEqual(page.data.recentRecords.length, 0);

    pointsError = new Error("api network unavailable");
    await page.loadUserCenter();
    assert.strictEqual(page.data.accountServicePreparing, false, "积分链路故障不能被配置缺失误报成准备中");
    assert.ok(page.data.accountError, "积分链路故障必须显示余额错误态");

    const userCenterWxml = fs.readFileSync(
      path.join(root, "pages", "user-center", "user-center.wxml"),
      "utf8"
    );
    assert.ok(
      (userCenterWxml.match(/wx:if="\{\{rechargeVisible\}\}"/g) || []).length >= 2,
      "用户中心两个充值 CTA 都必须绑定可见条件"
    );
    assert.ok(userCenterWxml.includes('wx:elif="{{recordsError}}"'), "用户中心必须有记录错误态");
    const recordsWxml = fs.readFileSync(
      path.join(root, "pages", "account-records", "account-records.wxml"),
      "utf8"
    );
    const recordsJs = fs.readFileSync(
      path.join(root, "pages", "account-records", "account-records.js"),
      "utf8"
    );
    assert.ok(recordsWxml.includes("paginationLimited"), "记录页必须显示回退分页受限状态");
    assert.ok(recordsJs.includes("paginationLimited: Boolean(result.paginationLimited)"), "记录页必须接收分页受限标记");

    console.log("account points fallback smoke: OK");
  } finally {
    global.Page = oldPage;
    global.wx = oldWx;
    if (oldAccountCache) require.cache[accountPath] = oldAccountCache;
    else delete require.cache[accountPath];
    if (oldCloudCache) require.cache[cloudPath] = oldCloudCache;
    else delete require.cache[cloudPath];
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
