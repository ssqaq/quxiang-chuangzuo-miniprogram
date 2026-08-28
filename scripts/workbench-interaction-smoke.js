const assert = require("assert");

const events = [];
const storage = {};
let page = null;
let redirectMode = "success";
let imageInfoMode = "success";

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
  navigateTo(options) {
    events.push({ type: "navigateTo", options });
    if (options && options.success) options.success();
  },
  previewImage(options) {
    events.push({ type: "previewImage", options });
    if (previewImageMode === "fail" && options.fail) {
      options.fail({ errMsg: "previewImage:fail smoke" });
    }
  },
  getImageInfo(options) {
    events.push({ type: "getImageInfo", options });
    if (imageInfoMode === "fail") {
      if (options.fail) options.fail({ errMsg: "getImageInfo:fail smoke" });
      return;
    }
    if (imageInfoMode === "empty") {
      options.success({});
      return;
    }
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

const cloudService = require("../services/cloud");
const diagnosticLog = require("../utils/diagnostic-log");
require("../pages/workbench/workbench.js");

page.setData = (next) => {
  page.data = Object.assign({}, page.data, next);
};

function diagnosticEvents() {
  return diagnosticLog.read({ newestFirst: true }) || [];
}

function hasEvent(event) {
  return diagnosticEvents().some((item) => item.event === event);
}

function navigationEventCount() {
  return events.filter((item) => (
    item.type === "navigateTo"
    || item.type === "redirectTo"
    || item.type === "reLaunch"
  )).length;
}

async function main() {
  assert.strictEqual(
    page.data.adminEntryVisible,
    true,
    "开发版和预览版必须稳定显示管理员入口"
  );
  page.onShow();
  page.data.adminVisible = false;
  const deniedNavigationCount = navigationEventCount();
  page.openTencentFaceFusion();
  assert.strictEqual(
    navigationEventCount(),
    deniedNavigationCount,
    "普通用户不能从工作台跳转到腾讯版"
  );
  assert.strictEqual(typeof page.copyDiagnosticReport, "undefined");
  assert.strictEqual(typeof page.clearDiagnosticLogs, "undefined");
  diagnosticLog.info("app", "smoke-ok", "启动成功", {
    route: "pages/workbench/workbench"
  });
  diagnosticLog.warn("cloud", "smoke-warn", "云端响应较慢", {
    durationMs: 1200
  });
  assert.ok(hasEvent("smoke-ok"));
  assert.ok(hasEvent("smoke-warn"));

  const originalGetAdminStatus = cloudService.getAdminStatus;
  cloudService.isCloudReady = () => true;
  cloudService.getAdminStatus = () => Promise.reject(new Error("smoke admin timeout"));
  await page.refreshAdminAccess();
  assert.strictEqual(
    page.data.adminEntryVisible,
    true,
    "权限检查失败时不能把预览版管理员入口隐藏"
  );
  assert.strictEqual(
    page.data.adminVisible,
    false,
    "权限检查失败时腾讯版入口必须默认隐藏"
  );
  cloudService.getAdminStatus = () => Promise.resolve({ isAdmin: true });
  await page.refreshAdminAccess();
  assert.strictEqual(page.data.adminVisible, true);
  assert.strictEqual(storage.workbench_admin_access.granted, true);
  const allowedNavigationCount = navigationEventCount();
  page.openTencentFaceFusion();
  assert.ok(
    navigationEventCount() > allowedNavigationCount,
    "管理员可以从工作台打开腾讯版"
  );
  page._navigating = false;
  cloudService.getAdminStatus = originalGetAdminStatus;

  page.previewAuthorQr();
  assert.strictEqual(page.data.authorQrPreviewVisible, true);
  assert.strictEqual(
    page.data.authorQrPreviewPath,
    "/assets/contact/author-wechat-qr.jpg"
  );
  assert.strictEqual(
    events.some((item) => item.type === "previewImage"),
    false
  );
  page.closeAuthorQrPreview();
  assert.strictEqual(page.data.authorQrPreviewVisible, false);

  page.previewAuthorQr();
  page.onAuthorQrPreviewError();
  assert.ok(events.some((item) => (
    item.type === "toast"
    && item.options.title === "二维码加载失败，请重试"
  )));
  assert.strictEqual(page.data.authorQrPreviewVisible, false);

  page.previewRecord({
    currentTarget: {
      dataset: { url: "/tmp/record-image.jpg" }
    }
  });
  assert.strictEqual(page.data.imagePreviewVisible, true);
  assert.strictEqual(page.data.imagePreviewTitle, "制作记录");
  page.onImagePreviewError();
  assert.ok(events.some((item) => (
    item.type === "toast"
    && item.options.title === "图片加载失败，请重试"
  )));
  assert.strictEqual(page.data.imagePreviewVisible, false);

  const originalQrPath = page.data.authorQrPath;
  page.data.authorQrPath = "";
  page.previewAuthorQr();
  assert.ok(events.some((item) => (
    item.type === "toast"
    && item.options.title === "当前环境不支持查看二维码"
  )));
  page.data.authorQrPath = originalQrPath;

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

  let checkInCalls = 0;
  let resolveCheckIn = null;
  cloudService.isCloudReady = () => true;
  cloudService.getMyUserProfile = () => Promise.resolve({ completed: true });
  cloudService.checkIn = () => {
    checkInCalls += 1;
    return new Promise((resolve) => {
      resolveCheckIn = resolve;
    });
  };
  page.data.points.checkedInToday = false;
  const firstCheckIn = page.checkIn();
  const duplicateCheckIn = page.checkIn();
  assert.strictEqual(firstCheckIn, duplicateCheckIn);
  await Promise.resolve();
  assert.strictEqual(checkInCalls, 1);
  resolveCheckIn({
    duplicate: false,
    earnedToday: 5,
    checkedInToday: true,
    currentStreak: 1,
    streakDays: 7
  });
  await firstCheckIn;
  assert.strictEqual(page._checkInPromise, null);
  assert.strictEqual(page.data.checkingIn, false);
  assert.ok(events.some((item) => (
    item.type === "toast"
    && item.options.title === "签到成功，+5 积分"
  )));

  console.log("workbench interaction smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
