/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
const storage = {};

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
global.wx = {
  getStorageSync(key) {
    return storage[key] || null;
  },
  setStorageSync(key, value) {
    storage[key] = value;
  },
  pageScrollTo() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "管理员页面没有注册成功");

function createPageInstance() {
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
  return instance;
}

const firstPage = createPageInstance();
firstPage.toggleConfigSection({
  currentTarget: { dataset: { section: "users" } }
});
firstPage.toggleMonitor();
firstPage.toggleUsageCard();
firstPage.toggleUsageSection({
  currentTarget: { dataset: { usageSection: "failure" } }
});
firstPage.toggleDeploymentSection({
  currentTarget: { dataset: { deploymentSection: "logs" } }
});
firstPage.toggleMonitorSection({
  currentTarget: { dataset: { section: "diagnosticLogs" } }
});

const secondPage = createPageInstance();
secondPage.restoreMonitorLayout();

assert.strictEqual(secondPage.data.activeConfigSection, "users");
assert.strictEqual(secondPage.data.activeConfigTitle, "用户统计");
assert.strictEqual(secondPage.data.monitorExpanded, false);
assert.strictEqual(secondPage.data.usageExpanded, false);
assert.strictEqual(secondPage.data.usageSections.failure, true);
assert.strictEqual(secondPage.data.deploymentSections.logs, true);
assert.strictEqual(secondPage.data.monitorSections.diagnosticLogs, true);

console.log("admin layout state smoke: OK (展开/收起状态可恢复)");
