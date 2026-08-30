/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.strictEqual(
  test.resolvePointsConfig({ points: { checkinPoints: "0.1" } }).checkinPoints,
  0.1
);
assert.strictEqual(
  test.resolvePointsConfig({ points: { streakBonus: "0.1234" } }).streakBonus,
  0.1234
);
assert.strictEqual(
  test.resolvePointsConfig({ points: { checkinPoints: "0.1-0.5" } }).checkinPoints,
  5,
  "历史区间脏值必须回退默认签到积分"
);
assert.deepStrictEqual(
  test.validateRuntimePatch(test.normalizeRuntimePatch({
    points: {
      imageCost: "0.1",
      videoCost: "0.25",
      checkinPoints: "0.1",
      streakBonus: "0.5"
    }
  })),
  []
);
assert.ok(
  test.validateRuntimePatch(test.normalizeRuntimePatch({
    points: { checkinPoints: "0.1-0.5" }
  })).some((item) => item.includes("points.checkinPoints")),
  "区间字符串必须被后端拒绝"
);
assert.ok(
  test.validateRuntimePatch(test.normalizeRuntimePatch({
    points: { dailyFreeLimit: "0.5" }
  })).some((item) => item.includes("points.dailyFreeLimit")),
  "免费次数仍必须是整数"
);

let pageDefinition = null;
let saveCalls = [];
let getConfigCalls = 0;
const latestEffective = {
  face: {},
  faceBackup: {},
  analysis: {},
  analysisBackup: {},
  image: {
    provider: "xingju",
    model: "latest-image",
    size: "1080x1440",
    resolution: "1K"
  },
  imageBackup: {},
  video: {},
  videoBackup: {},
  points: {
    dailyFreeLimit: 3,
    imageCost: 10,
    videoCost: 10,
    checkinPoints: 9,
    streakBonus: 20,
    streakDays: 7,
    promoStartDate: "2026-08-24",
    promoEndDate: "2026-08-25",
    timeZone: "Asia/Shanghai"
  },
  costs: {
    face: { inputPerMillionTokens: "0.15", outputPerMillionTokens: "1.5" },
    analysis: { inputPerMillionTokens: "0.15", outputPerMillionTokens: "1.5" },
    image: {
      perImage: { "1K": "0.07", "2K": "0.07", "4K": "0.07" },
      providers: {}
    },
    video: {
      perSecond: { "480p": "0.2", "720p": "0.3", "1080p": "1.8" },
      defaultDurationSeconds: "3"
    }
  },
  generationQueue: {
    workerConcurrency: 1,
    alertThreshold: 5,
    alertCooldownMinutes: 10
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") {
    return {
      async saveAdminConfig(payload) {
        saveCalls.push(payload);
        if (saveCalls.length === 1) {
          const error = new Error("配置版本冲突，请刷新后重试");
          error.payload = { errorCode: "ADMIN_CONFIG_CONFLICT" };
          throw error;
        }
        return {
          version: 13,
          effective: latestEffective,
          activeProviders: {}
        };
      },
      async getAdminConfig() {
        getConfigCalls += 1;
        return { version: 12, effective: latestEffective, activeProviders: {} };
      }
    };
  }
  if (request === "../../utils/diagnostic-log") {
    return { info() {}, warn() {}, error() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  showModal() {},
  showToast() {},
  getStorageSync() {
    return null;
  },
  setStorageSync() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;
assert.ok(pageDefinition, "管理员页面没有注册成功");

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

const page = {
  data: clone(pageDefinition.data),
  setData(patch, callback) {
    Object.keys(patch || {}).forEach((key) => {
      const parts = key.split(".");
      let target = this.data;
      parts.slice(0, -1).forEach((part) => {
        if (!target[part] || typeof target[part] !== "object") target[part] = {};
        target = target[part];
      });
      target[parts[parts.length - 1]] = patch[key];
    });
    if (typeof callback === "function") callback();
  }
};
Object.keys(pageDefinition).forEach((key) => {
  if (typeof pageDefinition[key] === "function") page[key] = pageDefinition[key].bind(page);
});

Object.keys(page.data.form.costs).forEach((key) => {
  if (!page.data.form.costs[key]) page.data.form.costs[key] = "0.1";
});
page.data.form.points.checkinPoints = "0.1";
page.data.form.image.model = "stale-image";
page._adminConfigBaselineForm = clone(page.data.form);
page._adminConfigBaselineForm.points.checkinPoints = "5";
page._adminConfigDirtySections = new Set(["points"]);
page.data.configVersion = 11;

page.onInput({
  currentTarget: { dataset: { section: "points", key: "checkinPoints" } },
  detail: { value: "0.1-0.5" }
});
assert.ok(page.data.pointFieldErrors.checkinPoints, "区间脏值必须立即提示错误");
page.onInput({
  currentTarget: { dataset: { section: "points", key: "checkinPoints" } },
  detail: { value: "0.1" }
});
assert.strictEqual(page.data.pointFieldErrors.checkinPoints, "");

page.runModelProbe = async () => {};
Promise.resolve(page.saveConfig()).then(() => {
  assert.strictEqual(getConfigCalls, 1, "版本冲突后必须只刷新一次配置");
  assert.strictEqual(saveCalls.length, 2, "版本冲突后必须自动重试一次");
  assert.strictEqual(saveCalls[0].points.checkinPoints, 0.1);
  assert.strictEqual(saveCalls[0].image, undefined, "积分保存不能携带旧图片配置");
  assert.strictEqual(saveCalls[1].expectedVersion, 12, "重试必须使用最新版本号");
  assert.strictEqual(saveCalls[1].points.checkinPoints, 0.1);
  assert.strictEqual(saveCalls[1].image, undefined, "重试仍不能覆盖并发图片配置");
  console.log("admin points/save smoke: OK");
}).catch((error) => {
  console.error(`admin points/save smoke 失败：${error.stack || error.message || error}`);
  process.exitCode = 1;
});
