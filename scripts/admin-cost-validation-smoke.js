/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露成本校验测试接口");
assert.strictEqual(test.validateCostNumber("0.0600", "x"), "");
assert.strictEqual(test.validateCostNumber(0.06, "x"), "");
assert.ok(test.validateCostNumber("", "x").includes("不能为空"));
assert.ok(test.validateCostNumber("-0.1", "x").includes("非负数字"));
assert.ok(test.validateCostNumber("0.12345", "x").includes("最多 4 位小数"));
assert.ok(test.validateCostNumber("abc", "x").includes("非负数字"));
assert.ok(test.validateCostNumber("100000.0001", "x").includes("0～100000"));

const validPatch = test.normalizeRuntimePatch({
  costs: {
    image: {
      perImage: {
        "1K": "0.0600",
        "2K": "0.1",
        "4K": "0.15"
      }
    },
    video: {
      perSecond: {
        "480p": "0.2",
        "720p": "0.3",
        "1080p": "1.8"
      }
    }
  }
});
assert.deepStrictEqual(test.validateRuntimePatch(validPatch), []);

const invalidPatch = test.normalizeRuntimePatch({
  costs: {
    image: {
      perImage: {
        "1K": "",
        "2K": "-0.1",
        "4K": "0.12345"
      }
    }
  }
});
const invalidErrors = test.validateRuntimePatch(invalidPatch);
assert.ok(invalidErrors.some((item) => item.includes("costs.image.perImage.1K") && item.includes("不能为空")));
assert.ok(invalidErrors.some((item) => item.includes("costs.image.perImage.2K") && item.includes("非负数字")));
assert.ok(invalidErrors.some((item) => item.includes("costs.image.perImage.4K") && item.includes("最多 4 位小数")));

let pageDefinition = null;
let saveCalls = 0;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") {
    return {
      async saveAdminConfig() {
        saveCalls += 1;
        return {};
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

const page = {
  data: JSON.parse(JSON.stringify(pageDefinition.data)),
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
  if (typeof pageDefinition[key] === "function") {
    page[key] = pageDefinition[key].bind(page);
  }
});

page.onInput({
  currentTarget: { dataset: { section: "costs", key: "image1K" } },
  detail: { value: "0.12345" }
});
assert.ok(page.data.costFieldErrors.image1K, "超过 4 位小数时必须立即显示错误");

page.onInput({
  currentTarget: { dataset: { section: "costs", key: "image1K" } },
  detail: { value: "0.0600" }
});
assert.strictEqual(page.data.costFieldErrors.image1K, "");
assert.strictEqual(page.data.imageQualityOptions[0].label, "1K（¥0.06/张）");

page.onInput({
  currentTarget: { dataset: { section: "costs", key: "video720p" } },
  detail: { value: "" }
});
assert.ok(page.data.costFieldErrors.video720p, "清空价格时必须立即显示错误");

Promise.resolve(page.saveConfig()).then(() => {
  assert.strictEqual(saveCalls, 0, "成本字段有错误时不得向云端保存配置");
  console.log("admin cost validation smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
