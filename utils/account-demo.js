// 视觉回归专用的离线账户适配器。生产构建不会让它变成可达入口。
const config = require("../config");

const DEMO_PROFILE = Object.freeze({
  completed: false,
  nickname: "微信用户",
  avatarUrl: ""
});

const DEMO_RECORDS = Object.freeze([
  Object.freeze({
    id: "demo-recharge-330",
    type: "recharge",
    amount: "330",
    balanceAfter: "128.5",
    description: "330 积分套餐",
    createdAt: "2026-09-01T14:26:00+08:00"
  }),
  Object.freeze({
    id: "demo-spend-image",
    type: "spend",
    amount: "-10",
    balanceAfter: "118.5",
    description: "图片创作",
    createdAt: "2026-09-01T13:08:00+08:00"
  }),
  Object.freeze({
    id: "demo-refund-video",
    type: "payment-reversal",
    amount: "10",
    balanceAfter: "128.5",
    description: "视频生成失败退回",
    createdAt: "2026-08-31T21:42:00+08:00"
  }),
  Object.freeze({
    id: "demo-reward-checkin",
    type: "checkin",
    amount: "0.5",
    balanceAfter: "118.5",
    description: "每日签到",
    createdAt: "2026-08-31T09:15:00+08:00"
  }),
  Object.freeze({
    id: "demo-unknown",
    type: "future-v2",
    amount: "0.1",
    balanceAfter: "118.6",
    description: "积分变动",
    createdAt: "2026-08-30T08:00:00+08:00"
  })
]);

const DEMO_PRODUCTS = Object.freeze([
  Object.freeze({ productId: "pkg_990", amountFen: 990, amountText: "¥9.9", grantPoints: "100" }),
  Object.freeze({ productId: "pkg_2990", amountFen: 2990, amountText: "¥29.9", grantPoints: "330" }),
  Object.freeze({ productId: "pkg_5990", amountFen: 5990, amountText: "¥59.9", grantPoints: "688" })
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isVisualTestBuild() {
  return String(config.buildProfile || "production") === "visual-test";
}

function resolve(options = {}) {
  const source = options && typeof options === "object" ? options : {};
  const requested = String(source.demo || "") === "1";
  const enabled = isVisualTestBuild() && requested;
  const capture = String(source.capture || "") === "1";
  return {
    buildProfile: String(config.buildProfile || "production"),
    available: isVisualTestBuild(),
    enabled,
    capture,
    showControl: isVisualTestBuild() && !capture
  };
}

function createAdapter() {
  if (!isVisualTestBuild()) {
    const error = new Error("视觉演示适配器不可用");
    error.code = "ACCOUNT_DEMO_DISABLED";
    throw error;
  }
  return Object.freeze({
    demo: true,
    getUserProfile: async () => clone(DEMO_PROFILE),
    getAccountOverview: async () => ({
      account: {
        pointsBalance: "128.5",
        totalPurchasedPoints: "330",
        totalEarned: "340.5",
        totalSpent: "10"
      },
      recentRecords: clone(DEMO_RECORDS.slice(0, 3)),
      accountBound: true,
      checkedInToday: true,
      source: "visual-test-fixture"
    }),
    getRechargeConfig: async () => ({
      eligible: true,
      channels: ["wxpay"],
      products: clone(DEMO_PRODUCTS),
      message: ""
    }),
    getAccountRecords: async (options = {}) => {
      const type = String(options.type || "").trim().toLowerCase();
      const groups = {
        recharge: ["recharge"],
        redeem: ["redeem", "voucher"],
        spend: ["spend", "consume"],
        reward: ["checkin", "daily-free", "promo-free"],
        refund: ["refund", "payment-reversal"]
      };
      const items = type && groups[type]
        ? DEMO_RECORDS.filter((item) => groups[type].includes(item.type))
        : DEMO_RECORDS;
      return { items: clone(items), hasMore: false, nextCursor: null, source: "visual-test-fixture" };
    },
    redeemPoints: async () => ({
      status: "success",
      requestStatus: "success",
      points: 30,
      balance: 158.5,
      message: "演示兑换成功"
    }),
    queryRedeem: async () => ({
      status: "success",
      requestStatus: "success",
      points: 30,
      balance: 158.5,
      message: "演示兑换成功"
    })

  });
}

function queryString(enabled, capture = false) {
  const values = [];
  if (enabled) values.push("demo=1");
  if (capture) values.push("capture=1");
  return values.length ? `?${values.join("&")}` : "";
}

function pageUrl(path, enabled, capture = false) {
  return `${path}${queryString(enabled, capture)}`;
}

module.exports = {
  isVisualTestBuild,
  resolve,
  createAdapter,
  pageUrl,
  __test__: { DEMO_PROFILE, DEMO_RECORDS, DEMO_PRODUCTS, queryString }
};
