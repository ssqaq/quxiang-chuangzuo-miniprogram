/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");

const wxml = fs.readFileSync(
  require("path").join(__dirname, "../pages/admin/admin.wxml"),
  "utf8"
);
assert.ok(wxml.includes("quick-launch quick-usage"), "用量快捷卡片缺失");
assert.ok(wxml.includes('bindtap="jumpToUsageSection"'), "用量快捷卡片没有跳转事件");
assert.ok(wxml.includes("entryHealth.usage.label"), "用量卡片没有状态文字");
assert.ok(wxml.includes('id="usage-section"'), "模型用量统计锚点缺失");

let pageDefinition = null;
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") return {};
  if (request === "../../utils/diagnostic-log") {
    return { info() {}, warn() {}, error() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
let scrollTarget = "";
global.wx = {
  pageScrollTo(options) {
    scrollTarget = options && options.selector || "";
  },
  getStorageSync() {
    return null;
  },
  setStorageSync() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "管理员页面没有注册成功");
const instance = {
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
    instance[key] = pageDefinition[key].bind(instance);
  }
});

instance.data.usageExpanded = false;
instance.jumpToUsageSection();
assert.strictEqual(instance.data.usageExpanded, true, "点击用量后没有展开统计卡片");
assert.strictEqual(scrollTarget, "#usage-section", "点击用量后没有滚动到模型用量统计");

console.log("admin usage entry smoke: OK");
