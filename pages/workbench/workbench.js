const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const interactionLog = require("../../utils/interaction-log");
const app = getApp();

const ENTRY_MODES = [
  {
    mode: "custom",
    mark: "＋",
    title: "开始新创作",
    description: "不预设重点，自定义制作流程",
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

Page({
  data: {
    appVersion: config.appVersion,
    cloudReady: false,
    entryModes: ENTRY_MODES,
    hasDraft: false,
    records: [],
    interactionLogs: [],
    interactionLogExpanded: false
  },

  onShow() {
    this._navigating = false;
    this.refreshWorkbench();
    this.setData({
      interactionLogs: interactionLog.read()
    });
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

  recordInteraction(event, message, details = {}) {
    interactionLog.append({
      event,
      message,
      route: details.route || "",
      durationMs: details.durationMs,
      error: details.error
    });
    this.setData({
      interactionLogs: interactionLog.read()
    });
  },

  toggleInteractionLogPanel() {
    this.setData({
      interactionLogExpanded: !this.data.interactionLogExpanded
    });
  },

  copyInteractionLogs() {
    const text = interactionLog.format(
      this.data.interactionLogs,
      config.appVersion
    );
    if (!wx.setClipboardData) {
      wx.showToast({ title: "当前环境不支持复制日志", icon: "none" });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: "点击日志已复制", icon: "success" }),
      fail: () => wx.showToast({ title: "复制点击日志失败", icon: "none" })
    });
  },

  clearInteractionLogs() {
    interactionLog.clear();
    this.setData({
      interactionLogs: [],
      interactionLogExpanded: false
    });
    wx.showToast({ title: "点击日志已清空", icon: "success" });
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
    this.recordInteraction("new-creation-navigation-start", "开始打开新创作", {
      route: url
    });
    wx.showToast({
      title: "正在打开制作页",
      icon: "loading",
      duration: 800
    });

    const showNavigationFailure = (error) => {
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
      try {
        wx.reLaunch({
          url,
          success: () => {
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

    try {
      wx.redirectTo({
        url,
        success: () => {
          console.info("[workbench] 已打开制作页", url);
          this.recordInteraction(
            "new-creation-navigation-success",
            "已打开制作页",
            { route: url, durationMs: Date.now() - startedAt }
          );
        },
        fail: (error) => {
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
      console.warn("[workbench] 替换页面调用失败，改用重开方式", { url, error });
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

    wx.showModal({
      title: "开始新的创作？",
      content: "当前草稿会被清除，制作记录不会受影响。",
      confirmText: "清除并新建",
      cancelText: "保留草稿",
      success: (response) => {
        if (!response.confirm) return;
        this.recordInteraction("draft-confirmed", "确认清除草稿并新建", {
          route: target
        });
        storage.clearProject();
        this.recordInteraction("draft-cleared", "已清除旧草稿", {
          route: target
        });
        this.refreshWorkbench();
        if (app && app.globalData) {
          app.globalData.pendingNewCreation = { mode, createdAt: Date.now() };
        }
        this.openNewCreationPage(target);
      }
    });
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
