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

function buildProjectSnapshot(project) {
  const value = project && typeof project === "object" ? project : {};
  return {
    projectName: value.projectName || "",
    hasMainImage: Boolean(value.mainImage),
    mainImage: summarizeAsset(value.mainImage),
    maskCircle: value.maskCircle || null,
    hasMaskFile: Boolean(value.maskFileID),
    faceReferenceCount: Array.isArray(value.faceRefs) ? value.faceRefs.length : 0,
    wardrobeReferenceCount: Array.isArray(value.wardrobeRefs) ? value.wardrobeRefs.length : 0,
    sceneDescription: value.sceneDescription || "",
    poseDescription: value.poseDescription || "",
    faceDirectionDescription: value.faceDirectionDescription || "",
    lightingMakeupDescription: value.lightingMakeupDescription || "",
    promptDraft: value.promptDraft || "",
    negativePrompt: value.negativePrompt || "",
    lockedElements: Array.isArray(value.lockedElements) ? value.lockedElements : [],
    customLockedElements: Array.isArray(value.customLockedElements)
      ? value.customLockedElements
      : [],
    resultCount: Array.isArray(value.results) ? value.results.length : 0
  };
}

function formatDiagnosticTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDiagnosticEvent(item) {
  const details = item && item.details && Object.keys(item.details).length
    ? JSON.stringify(item.details)
    : "";
  const level = item && item.level || "info";
  const categoryLabels = {
    app: "应用启动",
    navigation: "页面操作",
    cloud: "云端服务",
    points: "积分服务",
    admin: "管理员",
    diagnostic: "排查记录"
  };
  const date = new Date(item.time);
  const pad = (value) => String(value).padStart(2, "0");
  const displayTime = Number.isNaN(date.getTime())
    ? String(item.time || "")
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return Object.assign({}, item, {
    title: `${item.category || "app"} · ${item.event || "unknown"}`,
    categoryLabel: categoryLabels[item.category] || "运行记录",
    levelLabel: level === "error" ? "错误" : (level === "warn" ? "提醒" : "正常"),
    displayTime,
    errorText: item.error && item.error.message || "",
    detailText: details.slice(0, 800),
    metaText: [
      item.requestId ? `请求 ${item.requestId}` : "",
      item.code ? `代码 ${item.code}` : "",
      Number.isFinite(Number(item.durationMs)) ? `${item.durationMs} ms` : ""
    ].filter(Boolean).join(" · "),
    expanded: level !== "info"
  });
}

function buildDiagnosticGroups(events = []) {
  const abnormal = [];
  const normal = [];
  events.forEach((item) => {
    if (item.level === "error" || item.level === "warn") {
      abnormal.push(item);
    } else {
      normal.push(item);
    }
  });
  const errorCount = abnormal.filter((item) => item.level === "error").length;
  const warnCount = abnormal.filter((item) => item.level === "warn").length;
  return [
    abnormal.length
      ? {
        key: "abnormal",
        title: "异常记录",
        note: `${errorCount} 个错误 · ${warnCount} 个提醒`,
        count: abnormal.length,
        tone: "abnormal",
        events: abnormal
      }
      : null,
    normal.length
      ? {
        key: "normal",
        title: "正常记录",
        note: "启动和服务过程",
        count: normal.length,
        tone: "normal",
        events: normal
      }
      : null
  ].filter(Boolean);
}

function buildDiagnosticSummary(stats = {}) {
  const errorCount = Number(stats.errorCount) || 0;
  const warnCount = Number(stats.warnCount) || 0;
  if (errorCount || warnCount) {
    const issueCount = errorCount + warnCount;
    return {
      title: `发现 ${issueCount} 条异常记录`,
      description: errorCount
        ? "有错误需要优先排查，点开异常记录查看详情。"
        : "有提醒信息，点开异常记录查看具体原因。",
      tone: errorCount ? "error" : "warn",
      icon: errorCount ? "!" : "!"
    };
  }
  return {
    title: "本次运行正常",
    description: "没有发现错误，可以继续使用。",
    tone: "ok",
    icon: "✓"
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
    authorQrPath: AUTHOR_QR_PATH,
    savingAuthorQr: false,
    authorQrPreviewVisible: false,
    authorQrPreviewLoading: false,
    authorQrPreviewError: false,
    contactAuthorExpanded: false,
    entryModes: ENTRY_MODES,
    hasDraft: false,
    records: [],
    diagnosticEvents: [],
    diagnosticGroups: [],
    diagnosticExpanded: false,
    diagnosticStats: {
      eventCount: 0,
      errorCount: 0,
      warnCount: 0
    },
    diagnosticSummary: {
      title: "本次运行正常",
      description: "没有发现错误，可以继续使用。",
      tone: "ok",
      icon: "✓"
    },
    diagnosticSession: {
      startedAt: ""
    },
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
      billingMode: "daily-free"
    }
  },

  onShow() {
    this.clearNavigationWatchdog();
    this._navigating = false;
    this.refreshWorkbench();
    this.setData({
      diagnosticExpanded: false
    });
    const refreshSecondary = () => {
      this.refreshDiagnostics();
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
  },

  onUnload() {
    this.clearPromoRefreshTimer();
    this.clearNavigationWatchdog();
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

  refreshDiagnostics() {
    const diagnosticEvents = diagnosticLog
      .read({ limit: diagnosticLog.DISPLAY_LIMIT, newestFirst: true })
      .map(formatDiagnosticEvent);
    const diagnosticStats = diagnosticLog.getStats();
    const diagnosticSession = diagnosticLog.getSession();
    this.setData({
      diagnosticEvents,
      diagnosticGroups: buildDiagnosticGroups(diagnosticEvents),
      diagnosticStats,
      diagnosticSummary: buildDiagnosticSummary(diagnosticStats),
      diagnosticSession: Object.assign({}, diagnosticSession, {
        startedAtText: formatDiagnosticTime(diagnosticSession.startedAt)
      })
    });
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
      promoEndDate: result.promoEndDate || config.points.promoEndDate
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

  async refreshAdminAccess() {
    if (!cloud.isCloudReady()) {
      this.setData({ adminVisible: false });
      return;
    }
    try {
      const result = await cloud.getAdminStatus();
      this.setData({ adminVisible: Boolean(result && result.isAdmin) });
    } catch (error) {
      this.setData({ adminVisible: false });
      diagnosticLog.warn("admin", "status-failed", "管理员入口状态读取失败", { error });
    }
  },

  openAdmin() {
    if (!this.data.adminVisible) return;
    wx.navigateTo({ url: "/pages/admin/admin" });
  },

  recordInteraction(event, message, details = {}) {
    const method = details.error ? diagnosticLog.error : diagnosticLog.info;
    method("navigation", event, message, {
      route: details.route || "",
      durationMs: details.durationMs,
      error: details.error
    });
    this.refreshDiagnostics();
  },

  toggleDiagnosticPanel() {
    this.setData({
      diagnosticExpanded: !this.data.diagnosticExpanded
    });
  },

  toggleDiagnosticEvent(event) {
    const sequence = Number(event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.sequence
      : 0);
    if (!sequence) return;
    this.setData({
      diagnosticGroups: (this.data.diagnosticGroups || []).map((group) => Object.assign({}, group, {
        events: (group.events || []).map((item) => item.sequence === sequence
          ? Object.assign({}, item, { expanded: !item.expanded })
          : item)
      }))
    });
  },

  async copyDiagnosticReport() {
    if (!wx.setClipboardData) {
      wx.showToast({ title: "当前环境不支持复制报告", icon: "none" });
      return;
    }
    try {
      const report = await diagnosticLog.buildReport({
        appVersion: config.appVersion,
        cloudEnvId: config.cloudEnvId,
        cloudFunctionName: config.cloudFunctionName,
        cloudReady: cloud.isCloudReady(),
        projectSnapshot: buildProjectSnapshot(storage.loadProject())
      });
      wx.setClipboardData({
        data: JSON.stringify(report, null, 2),
        success: () => wx.showToast({
          title: "排查报告已复制，直接发给宝宝",
          icon: "none",
          duration: 2200
        }),
        fail: (error) => {
          diagnosticLog.error("diagnostic", "report-copy-failed", "复制排查报告失败", {
            error
          });
          this.refreshDiagnostics();
          wx.showToast({ title: "复制排查报告失败", icon: "none" });
        }
      });
    } catch (error) {
      diagnosticLog.error("diagnostic", "report-build-failed", "生成排查报告失败", {
        error
      });
      this.refreshDiagnostics();
      wx.showToast({ title: "生成排查报告失败", icon: "none" });
    }
  },

  clearDiagnosticLogs() {
    diagnosticLog.clear();
    this.setData({
      diagnosticExpanded: false
    });
    this.refreshDiagnostics();
    wx.showToast({ title: "本次排查日志已清空", icon: "success" });
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

  openPublishExport() {
    this.openPage(
      "/pages/publish-export/publish-export",
      "导出页打开失败",
      "已打开降低AI识别率再导出照片"
    );
  },

  openPhotoToVideo() {
    this.openPage(
      "/pages/photo-to-video/photo-to-video",
      "动态视频页打开失败",
      "已打开照片转动态视频"
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
    const request = this.performCheckIn();
    this._checkInPromise = request;
    const clearCheckInLock = () => {
      if (this._checkInPromise === request) {
        this._checkInPromise = null;
      }
    };
    request.then(clearCheckInLock, clearCheckInLock);
    return request;
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
    if (!this.data.authorQrPath) {
      wx.showToast({ title: "当前环境不支持查看二维码", icon: "none" });
      return;
    }

    this.setData({
      authorQrPreviewVisible: true,
      authorQrPreviewLoading: true,
      authorQrPreviewError: false
    });
  },

  onAuthorQrPreviewLoad() {
    this.setData({
      authorQrPreviewLoading: false,
      authorQrPreviewError: false
    });
  },

  onAuthorQrPreviewError() {
    this.setData({
      authorQrPreviewVisible: true,
      authorQrPreviewLoading: false,
      authorQrPreviewError: true
    });
    wx.showToast({ title: "二维码加载失败，请重新编译后再试", icon: "none" });
  },

  closeAuthorQrPreview() {
    this.setData({
      authorQrPreviewVisible: false,
      authorQrPreviewLoading: false,
      authorQrPreviewError: false
    });
  },

  stopAuthorQrPreviewClose() {},

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
      wx.previewImage({
        current: url,
        urls: [url]
      });
    }
  }
});
