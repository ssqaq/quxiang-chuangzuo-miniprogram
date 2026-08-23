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
  getSystemInfoSync() {
    return { platform: "devtools", brand: "smoke" };
  },
  getAccountInfoSync() {
    return { miniProgram: { envVersion: "develop" } };
  },
  getNetworkType(options) {
    options.success({ networkType: "wifi" });
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
  previewImage(options) {
    events.push({ type: "previewImage", options });
  },
  getImageInfo(options) {
    events.push({ type: "getImageInfo", options });
    options.success({ path: "/tmp/author-wechat-qr.jpg" });
  },
  saveImageToPhotosAlbum(options) {
    events.push({ type: "saveImageToPhotosAlbum", options });
    options.success();
    if (options.complete) options.complete();
  },
  openSetting(options) {
    events.push({ type: "openSetting", options });
  },
  redirectTo(options) {
    events.push({ type: "redirectTo", options });
    if (redirectMode === "timeout") return;
    if (redirectMode === "success") {
      options.success();
      return;
    }
    options.fail({ errMsg: "redirectTo:fail smoke" });
  },
  reLaunch(options) {
    events.push({ type: "reLaunch", options });
    if (redirectMode === "fallback-success" || redirectMode === "timeout") {
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

function diagnosticEvents() {
  return page.data.diagnosticEvents || [];
}

function hasEvent(event) {
  return diagnosticEvents().some((item) => item.event === event);
}

async function main() {
  page.onShow();
  page.previewAuthorQr();
  assert.ok(events.some((item) => (
    item.type === "previewImage"
    && item.options.current === "/assets/contact/author-wechat-qr.jpg"
  )));
  page.saveAuthorQr();
  assert.ok(events.some((item) => (
    item.type === "saveImageToPhotosAlbum"
    && item.options.filePath === "/tmp/author-wechat-qr.jpg"
  )));
  assert.strictEqual(page.data.savingAuthorQr, false);

  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });

  assert.ok(hasEvent("new-creation-click"));
  assert.ok(hasEvent("new-creation-navigation-start"));
  assert.ok(hasEvent("new-creation-navigation-success"));

  redirectMode = "fallback-success";
  page.onShow();
  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });
  assert.ok(hasEvent("new-creation-redirect-failed"));
  assert.ok(hasEvent("new-creation-fallback-success"));

  redirectMode = "failed";
  page.onShow();
  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });
  assert.ok(hasEvent("new-creation-navigation-failed"));

  redirectMode = "success";
  page.onShow();
  page.data.hasDraft = true;
  const modalCountBeforeDraft = events.filter((item) => item.type === "modal").length;
  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });
  assert.ok(hasEvent("draft-auto-clear"));
  assert.ok(hasEvent("draft-cleared"));
  assert.strictEqual(
    events.filter((item) => item.type === "modal").length,
    modalCountBeforeDraft
  );
  assert.strictEqual(page.data.hasDraft, false);
  assert.ok(hasEvent("new-creation-navigation-success"));

  redirectMode = "success";
  page.onShow();
  page.data.hasDraft = true;
  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });
  assert.ok(hasEvent("draft-auto-clear"));
  assert.ok(hasEvent("draft-cleared"));

  redirectMode = "timeout";
  page.onShow();
  page._navigationTimeoutMs = 5;
  page.startNew({
    currentTarget: {
      dataset: { mode: "custom" }
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(hasEvent("new-creation-navigation-timeout"));
  assert.ok(hasEvent("new-creation-fallback-success"));

  await page.copyDiagnosticReport();
  assert.ok(events.some((item) => item.type === "clipboard"));
  page.clearDiagnosticLogs();
  assert.strictEqual(page.data.diagnosticEvents.length, 0);

  console.log("workbench interaction smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
