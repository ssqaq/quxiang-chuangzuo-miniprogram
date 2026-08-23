const assert = require("assert");

const events = [];
const storage = {};
let page = null;
let redirectMode = "success";

global.getApp = () => ({
  globalData: {
    cloudReady: true
  }
});

global.wx = {
  cloud: {},
  getStorageSync(key) {
    return storage[key];
  },
  setStorageSync(key, value) {
    storage[key] = value;
  },
  removeStorageSync(key) {
    delete storage[key];
  },
  showToast(options) {
    events.push({ type: "toast", options });
  },
  showModal(options) {
    events.push({ type: "modal", options });
  },
  setClipboardData(options) {
    events.push({ type: "clipboard", options });
    if (options.success) options.success();
  },
  navigateTo() {},
  previewImage() {},
  redirectTo(options) {
    events.push({ type: "redirectTo", options });
    if (redirectMode === "success") {
      options.success();
      return;
    }
    options.fail({ errMsg: "redirectTo:fail smoke" });
  },
  reLaunch(options) {
    events.push({ type: "reLaunch", options });
    if (redirectMode === "fallback-success") {
      options.success();
      return;
    }
    options.fail({ errMsg: "reLaunch:fail smoke" });
  }
};

global.Page = (definition) => {
  page = definition;
};

require("../pages/workbench/workbench.js");

page.setData = (next) => {
  page.data = Object.assign({}, page.data, next);
};

page.onShow();
page.startNew({
  currentTarget: {
    dataset: { mode: "custom" }
  }
});

let logs = page.data.interactionLogs;
assert.ok(logs.some((item) => item.event === "new-creation-click"));
assert.ok(logs.some((item) => item.event === "new-creation-navigation-start"));
assert.ok(logs.some((item) => item.event === "new-creation-navigation-success"));

redirectMode = "fallback-success";
page.onShow();
page.startNew({
  currentTarget: {
    dataset: { mode: "custom" }
  }
});
logs = page.data.interactionLogs;
assert.ok(logs.some((item) => item.event === "new-creation-redirect-failed"));
assert.ok(logs.some((item) => item.event === "new-creation-fallback-success"));

redirectMode = "failed";
page.onShow();
page.startNew({
  currentTarget: {
    dataset: { mode: "custom" }
  }
});
logs = page.data.interactionLogs;
assert.ok(logs.some((item) => item.event === "new-creation-navigation-failed"));

page.copyInteractionLogs();
assert.ok(events.some((item) => item.type === "clipboard"));
page.clearInteractionLogs();
assert.deepStrictEqual(page.data.interactionLogs, []);
console.log("workbench interaction smoke: OK");
