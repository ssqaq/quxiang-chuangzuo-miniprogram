const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const pointsUi = require("../../utils/points-ui");
const app = getApp();
const AUTHOR_QR_PATH = "/assets/contact/author-wechat-qr.jpg";

const ENTRY_MODES = [
  {
    mode: "custom",
    mark: "＋",
    title: "开始新创作",
    description: "先选一张主图，再补充参考素材",
    tone: "custom"
  }
];

const TENCENT_FACE_FUSION_ROUTE = "/pages/tencent-face-fusion/tencent-face-fusion";

function hasDraft(project) {
  if (!project || typeof project !== "object") return false;
  return Boolean(
    project.mainImage
      || project.maskCircle
      || (Array.isArray(project.faceRefs) && project.faceRefs.length)
      || (Array.isArray(project.wardrobeRefs) && project.wardrobeRefs.length)
      || project.sceneDescription
      || project.poseDescription
      || project.faceDirectionDescription
      || project.lightingMakeupDescription
      || project.promptDraft
      || (Array.isArray(project.results) && project.results.length)
  );
}

function normalizeRecord(record) {
  const item = record && typeof record === "object" ? record : {};
  return {
    id: item.id || `record-${Date.now()}`,
    projectName: item.projectName || "未命名项目",
    createdAt: item.createdAt || "刚刚生成",
    imagePath: item.tempFileURL || item.path || "",
    prompt: item.prompt || ""
  };
}

function buildNewCreationUrl(mode) {
  return `/pages/index/index?mode=${mode}&new=1`;
}

const NEW_CREATION_NAVIGATION_TIMEOUT_MS = 1800;
const ADMIN_ACCESS_RETRY_DELAY_MS = 500;
const ADMIN_ACCESS_MAX_RETRIES = 8;
const ADMIN_ACCESS_CACHE_KEY = "workbench_admin_access";
const ADMIN_ACCESS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isPreviewEnvironment() {
  if (typeof wx === "undefined" || typeof wx.getAccountInfoSync !== "function") {
    return false;
  }
  try {
    const accountInfo = wx.getAccountInfoSync() || {};
    const miniProgram = accountInfo.miniProgram || {};
    return miniProgram.envVersion === "develop" || miniProgram.envVersion === "trial";
  } catch (error) {
    return false;
  }
}

function hasCachedAdminAccess() {
  if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") {
    return false;
  }
  try {
    const cached = wx.getStorageSync(ADMIN_ACCESS_CACHE_KEY);
    const confirmedAt = Number(cached && cached.confirmedAt);
    return Boolean(
      cached
      && cached.granted === true
      && confirmedAt > 0
      && Date.now() - confirmedAt < ADMIN_ACCESS_CACHE_TTL_MS
    );
  } catch (error) {
    return false;
  }
}

function rememberAdminAccess(granted) {
  if (typeof wx === "undefined") return;
  try {
    if (granted && typeof wx.setStorageSync === "function") {
      wx.setStorageSync(ADMIN_ACCESS_CACHE_KEY, {
        granted: true,
        confirmedAt: Date.now()
      });
      return;
    }
    if (!granted && typeof wx.removeStorageSync === "function") {
      wx.removeStorageSync(ADMIN_ACCESS_CACHE_KEY);
    }
  } catch (error) {
    diagnosticLog.warn("admin", "access-cache-failed", "管理员入口状态缓存失败", {
      error
    });
  }
}

function summarizeAsset(asset) {
  if (!asset || typeof asset !== "object") return null;
  return {
    name: asset.name || "",
    size: Number(asset.size || asset.compressedSize || 0),
    width: Number(asset.width || 0),
    height: Number(asset.height || 0),
    compressed: Boolean(asset.compressed),
    uploaded: Boolean(asset.fileID)
  };
}

function buildCheckInToast(result = {}) {
  const copy = config.points.copy;
  const duplicate = Boolean(result.duplicate);
  const earned = Number(result.earnedToday) || 0;
  return {
    title: duplicate
      ? copy.checkInDuplicate
      : `${copy.checkInSuccessPrefix}${earned}${copy.checkInSuccessSuffix}`,
    icon: duplicate ? "none" : "success"
  };
}

Page({
  data: {
    appVersion: config.appVersion,
    pointsCopy: config.points.copy,
    cloudReady: false,
    adminVisible: false,
    adminEntryVisible: isPreviewEnvironment() || hasCachedAdminAccess(),
    authorQrPath: AUTHOR_QR_PATH,
    savingAuthorQr: false,
    contactAuthorExpanded: false,
    authorQrPreviewVisible: false,
    authorQrPreviewPath: AUTHOR_QR_PATH,
    imagePreviewVisible: false,
    imagePreviewPath: "",
    imagePreviewTitle: "图片预览",
    entryModes: ENTRY_MODES,
    hasDraft: false,
    records: [],
    points: {
      accountBound: false,
      pointsBalance: 0,
      currentStreak: 0,
      progress: 0,
      streakDays: config.points.streakDays,
      nextCheckinReward: config.points.checkinPoints,
      checkingIn: false,
      checkedInToday: false,
      freeRemaining: config.points.dailyFreeLimit,
      freeLimit: config.points.dailyFreeLimit,
      promoActive: false,
      promoStartDate: config.points.promoStartDate,
      promoEndDate: config.points.promoEndDate,
      promoLabel: pointsUi.buildPromoLabel(
        config.points.promoStartDate,
        config.points.promoEndDate
      ),
      billingMode: "daily-free"
    }
  },

  onShow() {
    this.clearNavigationWatchdog();
    this._navigating = false;
    this.refreshWorkbench();
    const refreshSecondary = () => {
      this.refreshAdminAccess();
      this.refreshPoints();
    };
    if (typeof wx.nextTick === "function") {
      wx.nextTick(refreshSecondary);
    } else {
      setTimeout(refreshSecondary, 0);
    }
    this.schedulePromoRefresh();
  },

  onHide() {
    this.clearPromoRefreshTimer();
    this.clearAdminAccessRetry();
  },

  onUnload() {
    this.clearPromoRefreshTimer();
    this.clearNavigationWatchdog();
    this.clearAdminAccessRetry();
  },

  refreshWorkbench() {
    const project = storage.loadProject();
    const draftExists = hasDraft(project);
    const records = (storage.loadRecords() || [])
      .slice(0, 1)
      .map(normalizeRecord);

    this.setData({
      cloudReady: cloud.isCloudReady(),
      hasDraft: draftExists,
      records
    });
    return draftExists;
  },

  normalizePoints(result = {}) {
    const streakDays = Number(result.streakDays) || config.points.streakDays;
    const currentStreak = Math.max(0, Number(result.currentStreak) || 0);
    const progress = currentStreak > 0 && currentStreak % streakDays === 0
      ? streakDays
      : currentStreak % streakDays;
    return Object.assign({
      accountBound: false,
      pointsBalance: 0,
      currentStreak: 0,
      progress: 0,
      streakDays,
      nextCheckinReward: Number(config.points.checkinPoints) || 0,
      checkingIn: false,
      checkedInToday: false,
      freeRemaining: config.points.dailyFreeLimit,
      freeLimit: config.points.dailyFreeLimit,
      promoActive: false,
      promoStartDate: config.points.promoStartDate,
      promoEndDate: config.points.promoEndDate,
      promoLabel: pointsUi.buildPromoLabel(
        config.points.promoStartDate,
        config.points.promoEndDate
      ),
      billingMode: "daily-free"
    }, result, {
      pointsBalance: Math.max(0, Number(result.pointsBalance) || 0),
      currentStreak,
      progress,
      progressPercent: Math.min(100, Math.max(0, progress / streakDays * 100)),
      nextCheckinReward: Math.max(
        0,
        Number(result.nextCheckinReward)
          || Number(result.checkinPoints)
          || Number(config.points.checkinPoints)
      ),
      streakDays,
      promoStartDate: result.promoStartDate || config.points.promoStartDate,
      promoEndDate: result.promoEndDate || config.points.promoEndDate,
      promoLabel: pointsUi.buildPromoLabel(
        result.promoStartDate || config.points.promoStartDate,
        result.promoEndDate || config.points.promoEndDate
      )
    });
  },

  clearPromoRefreshTimer() {
    if (this._promoRefreshTimer) {
      clearTimeout(this._promoRefreshTimer);
      this._promoRefreshTimer = null;
    }
  },

  schedulePromoRefresh() {
    this.clearPromoRefreshTimer();
    const points = this.data.points || {};
    const endDate = points.promoEndDate || config.points.promoEndDate;
    const remaining = pointsUi.getPromoRefreshDelay(endDate);
    if (remaining <= 0) {
      if (points.promoActive) {
        this.setData({ "points.promoActive": false });
      }
      return;
    }
    const wait = Math.min(remaining, pointsUi.MAX_TIMER_DELAY_MS);
    this._promoRefreshTimer = setTimeout(() => {
      this._promoRefreshTimer = null;
      if (remaining > pointsUi.MAX_TIMER_DELAY_MS) {
        this.schedulePromoRefresh();
        return;
      }
      if (this.data.points && this.data.points.promoActive) {
        this.setData({ "points.promoActive": false });
      }
      this.refreshPoints();
    }, wait);
    if (
      this._promoRefreshTimer
      && typeof this._promoRefreshTimer.unref === "function"
    ) {
      this._promoRefreshTimer.unref();
    }
  },

  async refreshPoints() {
    if (!cloud.isCloudReady()) {
      this.setData({
        points: this.normalizePoints({
          accountBound: false,
          boundMessage: config.points.copy.cloudRequired
        })
      });
      this.schedulePromoRefresh();
      return;
    }
    try {
      const result = await cloud.getUserPoints({ silent: true });
      if (result && !result.unavailable) {
        this.setData({ points: this.normalizePoints(result) });
      }
    } catch (error) {
      diagnosticLog.warn("points", "workbench-load-failed", "工作台积分卡读取失败", { error });
    } finally {
      this.schedulePromoRefresh();
    }
  },

  clearAdminAccessRetry() {
    if (this._adminAccessRetryTimer) {
      clearTimeout(this._adminAccessRetryTimer);
      this._adminAccessRetryTimer = null;
    }
  },

  scheduleAdminAccessRetry(attempt = 0) {
    if (attempt >= ADMIN_ACCESS_MAX_RETRIES || this._adminAccessRetryTimer) return;
    this._adminAccessRetryTimer = setTimeout(() => {
      this._adminAccessRetryTimer = null;
      this.refreshAdminAccess(attempt + 1);
    }, ADMIN_ACCESS_RETRY_DELAY_MS);
  },

  async refreshAdminAccess(attempt = 0) {
    if (!cloud.isCloudReady()) {
      this.scheduleAdminAccessRetry(attempt);
      return;
    }
    try {
      const result = await cloud.getAdminStatus();
      if (result && result.unavailable) {
        this.scheduleAdminAccessRetry(attempt);
        return;
      }
      this.clearAdminAccessRetry();
      const adminVisible = Boolean(result && result.isAdmin);
      rememberAdminAccess(adminVisible);
      this.setData({
        adminVisible,
        adminEntryVisible: isPreviewEnvironment() || adminVisible
      });
    } catch (error) {
      this.scheduleAdminAccessRetry(attempt);
      diagnosticLog.warn("admin", "status-failed", "管理员入口状态读取失败", { error });
    }
  },

  openAdmin() {
    if (!this.data.adminEntryVisible) return;
    wx.navigateTo({ url: "/pages/admin/admin" });
  },

  recordInteraction(event, message, details = {}) {
    const method = details.error ? diagnosticLog.error : diagnosticLog.info;
    method("navigation", event, message, {
      route: details.route || "",
      durationMs: details.durationMs,
      error: details.error
    });
  },

  clearNavigationWatchdog() {
    if (this._navigationWatchdog) {
      clearTimeout(this._navigationWatchdog);
      this._navigationWatchdog = null;
    }
  },

  startNavigationWatchdog(callback) {
    this.clearNavigationWatchdog();
    const timeoutMs = Number(this._navigationTimeoutMs) > 0
      ? Number(this._navigationTimeoutMs)
      : NEW_CREATION_NAVIGATION_TIMEOUT_MS;
    this._navigationWatchdog = setTimeout(callback, timeoutMs);
  },

  openPage(url, failureTitle, logLabel) {
    if (this._navigating) return;
    this._navigating = true;
    const startedAt = Date.now();
    this.recordInteraction(
      "navigation-start",
      "开始打开页面",
      { route: url }
    );
    try {
      wx.navigateTo({
        url,
        success: () => {
          console.info(`[workbench] ${logLabel}`, url);
          this.recordInteraction(
            "navigation-success",
            logLabel,
            { route: url, durationMs: Date.now() - startedAt }
          );
        },
        fail: (error) => {
          console.error(`[workbench] ${failureTitle}`, error);
          this.recordInteraction(
            "navigation-failed",
            failureTitle,
            { route: url, durationMs: Date.now() - startedAt, error }
          );
          this._navigating = false;
          wx.showToast({ title: failureTitle, icon: "none" });
        }
      });
    } catch (error) {
      console.error(`[workbench] ${failureTitle}`, error);
      this.recordInteraction(
        "navigation-failed",
        failureTitle,
        { route: url, durationMs: Date.now() - startedAt, error }
      );
      this._navigating = false;
      wx.showToast({ title: failureTitle, icon: "none" });
    }
  },

  navigateToIndex(url) {
    this.openPage(url, "制作页打开失败", "已打开制作页");
  },

  openNewCreationPage(url) {
    if (this._navigating) return;
    this._navigating = true;
    const startedAt = Date.now();
    let settled = false;
    let fallbackStarted = false;
    this.recordInteraction("new-creation-navigation-start", "开始打开新创作", {
      route: url
    });
    wx.showToast({
      title: "正在打开制作页",
      icon: "loading",
      duration: 800
    });

    const showNavigationFailure = (error) => {
      if (settled) return;
      settled = true;
      this.clearNavigationWatchdog();
      console.error("[workbench] 制作页打开失败", { url, error });
      this.recordInteraction(
        "new-creation-navigation-failed",
        "制作页最终打开失败",
        { route: url, durationMs: Date.now() - startedAt, error }
      );
      this._navigating = false;
      wx.showModal({
        title: "制作页打开失败",
        content: error && error.errMsg ? error.errMsg : "请重新点击进入",
        showCancel: false,
        fail: () => {
          wx.showToast({ title: "制作页打开失败", icon: "none" });
        }
      });
    };

    const relaunch = () => {
      if (settled || fallbackStarted) return;
      fallbackStarted = true;
      try {
        wx.reLaunch({
          url,
          success: () => {
            if (settled) return;
            settled = true;
            this.clearNavigationWatchdog();
            console.info("[workbench] 已通过重开方式进入制作页", url);
            this.recordInteraction(
              "new-creation-fallback-success",
              "替换页面失败后已通过重开进入制作页",
              { route: url, durationMs: Date.now() - startedAt }
            );
          },
          fail: showNavigationFailure
        });
      } catch (error) {
        showNavigationFailure(error);
      }
    };

    this.startNavigationWatchdog(() => {
      if (settled || fallbackStarted) return;
      console.warn("[workbench] 替换页面超时，改用重开方式", { url });
      this.recordInteraction(
        "new-creation-navigation-timeout",
        "页面响应较慢，准备自动重开",
        { route: url, durationMs: Date.now() - startedAt }
      );
      relaunch();
    });

    try {
      wx.redirectTo({
        url,
        success: () => {
          if (settled) return;
          settled = true;
          this.clearNavigationWatchdog();
          console.info("[workbench] 已打开制作页", url);
          this.recordInteraction(
            "new-creation-navigation-success",
            "已打开制作页",
            { route: url, durationMs: Date.now() - startedAt }
          );
        },
        fail: (error) => {
          if (settled || fallbackStarted) return;
          console.warn("[workbench] 替换页面失败，改用重开方式", { url, error });
          this.recordInteraction(
            "new-creation-redirect-failed",
            "替换页面失败，准备自动重开",
            { route: url, durationMs: Date.now() - startedAt, error }
          );
          relaunch();
        }
      });
    } catch (error) {
      if (settled || fallbackStarted) return;
      console.warn("[workbench] 替换页面调用失败，改用重开方式", { url, error });
      this.recordInteraction(
        "new-creation-redirect-threw",
        "页面跳转调用异常，准备自动重开",
        { route: url, durationMs: Date.now() - startedAt, error }
      );
      relaunch();
    }
  },

  replacePage(url, failureTitle, logLabel) {
    if (this._navigating) return;
    this._navigating = true;
    const startedAt = Date.now();
    try {
      wx.redirectTo({
        url,
        success: () => {
          console.info(`[workbench] ${logLabel}`, {
            url,
            durationMs: Date.now() - startedAt
          });
        },
        fail: (error) => {
          console.error(`[workbench] ${failureTitle}`, {
            url,
            durationMs: Date.now() - startedAt,
            error
          });
          this._navigating = false;
          wx.showModal({
            title: failureTitle,
            content: error && error.errMsg ? error.errMsg : "请重新点击进入",
            showCancel: false
          });
        }
      });
    } catch (error) {
      console.error(`[workbench] ${failureTitle}`, {
        url,
        durationMs: Date.now() - startedAt,
        error
      });
      this._navigating = false;
      wx.showModal({
        title: failureTitle,
        content: error && error.message ? error.message : "请重新点击进入",
        showCancel: false
      });
    }
  },

  startNew(event = {}) {
    const currentTarget = event.currentTarget || {};
    const dataset = currentTarget.dataset || {};
    const mode = ENTRY_MODES.some((item) => item.mode === dataset.mode)
      ? dataset.mode
      : "custom";
    const target = buildNewCreationUrl(mode);
    if (this._navigating) {
      this.recordInteraction(
        "new-creation-ignored",
        "制作页正在打开，请稍候",
        { route: target }
      );
      return;
    }
    this.recordInteraction("new-creation-click", "点击开始新创作", {
      route: target
    });
    if (!this.data.hasDraft) {
      if (app && app.globalData) {
        app.globalData.pendingNewCreation = { mode, createdAt: Date.now() };
      }
      this.openNewCreationPage(target);
      return;
    }

    this.recordInteraction(
      "draft-auto-clear",
      "检测到未完成草稿，自动清除并新建",
      { route: target }
    );
    storage.clearProject();
    this.recordInteraction("draft-cleared", "已自动清除旧草稿", {
      route: target
    });
    this.refreshWorkbench();
    if (app && app.globalData) {
      app.globalData.pendingNewCreation = { mode, createdAt: Date.now() };
    }
    this.openNewCreationPage(target);
  },

  openRecords() {
    this.openPage(
      "/pages/records/records",
      "制作记录打开失败",
      "已打开制作记录"
    );
  },

  openTencentFaceFusion() {
    if (!this.data.adminVisible) return;
    this.openPage(
      TENCENT_FACE_FUSION_ROUTE,
      "腾讯版制作页打开失败",
      "已打开腾讯版自动换脸"
    );
  },

  openPublishExport() {
    this.openPage(
      "/pages/publish-export/publish-export",
      "导出页打开失败",
      "已打开降低AI识别率再导出"
    );
  },

  openPhotoToVideo() {
    this.openPage(
      "/pages/photo-to-video/photo-to-video",
      "动态视频页打开失败",
      "已打开照片转动态视频"
    );
  },

  openMediaParser() {
    this.openPage(
      "/pages/watermark-remover/watermark-remover",
      "媒体解析页打开失败",
      "已打开媒体解析"
    );
  },

  openPoints() {
    this.openPage("/pages/points/points", "积分中心打开失败", "已打开积分中心");
  },

  checkIn() {
    if (this._checkInPromise) return this._checkInPromise;
    if (
      this.data.checkingIn
      || (this.data.points && this.data.points.checkedInToday)
    ) return Promise.resolve();
    if (!cloud.isCloudReady()) {
      wx.showToast({ title: config.points.copy.cloudRequired, icon: "none" });
      return Promise.resolve();
    }
    const request = this.checkProfileAndCheckIn();
    this._checkInPromise = request;
    const clearCheckInLock = () => {
      if (this._checkInPromise === request) {
        this._checkInPromise = null;
      }
    };
    request.then(clearCheckInLock, clearCheckInLock);
    return request;
  },

  async checkProfileAndCheckIn() {
    this.setData({ checkingIn: true });
    try {
      const profile = await cloud.getMyUserProfile({ retryLimit: 0 });
      if (!profile || !profile.completed) {
        this.setData({ checkingIn: false });
        wx.navigateTo({ url: "/pages/profile/profile?from=checkin" });
        return;
      }
    } catch (error) {
      this.setData({ checkingIn: false });
      wx.showModal({
        title: "签到前检查失败",
        content: String(error && error.message || "请稍后重试。"),
        showCancel: false
      });
      return;
    }
    return this.performCheckIn();
  },

  async performCheckIn() {
    this.setData({ checkingIn: true });
    try {
      const result = await cloud.checkIn();
      this.setData({
        checkingIn: false,
        points: this.normalizePoints(result)
      });
      wx.showToast(buildCheckInToast(result));
    } catch (error) {
      this.setData({ checkingIn: false });
      const payload = error && error.payload;
      wx.showModal({
        title: config.points.copy.checkInFailedTitle,
        content: String(
          payload && payload.message
            || error && error.message
            || config.points.copy.checkInFailedFallback
        ),
        showCancel: false
      });
    }
  },

  toggleAuthorQr() {
    this.setData({
      contactAuthorExpanded: !this.data.contactAuthorExpanded
    });
  },

  previewAuthorQr() {
    const qrPath = String(this.data.authorQrPath || "").trim();
    if (!qrPath) {
      wx.showToast({ title: "当前环境不支持查看二维码", icon: "none" });
      return;
    }
    this.setData({
      authorQrPreviewPath: qrPath,
      authorQrPreviewVisible: true,
      imagePreviewPath: qrPath,
      imagePreviewTitle: "二维码",
      imagePreviewVisible: true
    });
  },

  closeAuthorQrPreview() {
    this.setData({
      authorQrPreviewVisible: false,
      imagePreviewVisible: false
    });
  },

  onAuthorQrPreviewError() {
    this.setData({
      authorQrPreviewVisible: false,
      imagePreviewVisible: false
    });
    wx.showToast({ title: "二维码加载失败，请重试", icon: "none" });
  },

  closeImagePreview() {
    this.setData({
      imagePreviewVisible: false,
      authorQrPreviewVisible: false
    });
  },

  onImagePreviewError() {
    const isQrPreview = this.data.authorQrPreviewVisible
      || this.data.imagePreviewTitle === "二维码";
    if (isQrPreview) {
      this.onAuthorQrPreviewError();
      return;
    }
    this.setData({
      imagePreviewVisible: false,
      authorQrPreviewVisible: false
    });
    wx.showToast({ title: "图片加载失败，请重试", icon: "none" });
  },

  noop() {},

  handleAuthorQrSaveFailure(error) {
    const message = error && error.errMsg ? error.errMsg : "";
    if (/auth deny|auth denied|authorize:fail|permission/i.test(message)) {
      wx.showModal({
        title: "需要相册权限",
        content: "请在设置中允许保存到相册，再重新点击保存二维码。",
        confirmText: "去设置",
        success: (result) => {
          if (result.confirm && wx.openSetting) {
            wx.openSetting({});
          }
        }
      });
      return;
    }
    wx.showToast({ title: "二维码保存失败，请重试", icon: "none" });
  },

  saveAuthorQr() {
    if (this.data.savingAuthorQr) return;
    if (!wx.getImageInfo || !wx.saveImageToPhotosAlbum) {
      wx.showToast({ title: "当前环境不支持保存二维码", icon: "none" });
      return;
    }
    this.setData({ savingAuthorQr: true });
    wx.getImageInfo({
      src: this.data.authorQrPath,
      success: (image) => {
        wx.saveImageToPhotosAlbum({
          filePath: image.path || this.data.authorQrPath,
          success: () => {
            wx.showToast({ title: "二维码已保存到相册", icon: "success" });
          },
          fail: (error) => {
            this.handleAuthorQrSaveFailure(error);
          },
          complete: () => {
            this.setData({ savingAuthorQr: false });
          }
        });
      },
      fail: () => {
        this.setData({ savingAuthorQr: false });
        wx.showToast({ title: "二维码读取失败", icon: "none" });
      }
    });
  },

  previewRecord(event) {
    const url = event.currentTarget.dataset.url;
    if (url) {
      this.setData({
        imagePreviewPath: url,
        imagePreviewTitle: "制作记录",
        imagePreviewVisible: true
      });
    }
  }
});
