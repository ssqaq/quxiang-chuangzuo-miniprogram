const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
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
    records: []
  },

  onShow() {
    this._navigating = false;
    this.refreshWorkbench();
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

  openPage(url, failureTitle, logLabel) {
    if (this._navigating) return;
    this._navigating = true;
    try {
      wx.navigateTo({
        url,
        success: () => {
          console.info(`[workbench] ${logLabel}`, url);
        },
        fail: (error) => {
          console.error(`[workbench] ${failureTitle}`, error);
          this._navigating = false;
          wx.showToast({ title: failureTitle, icon: "none" });
        }
      });
    } catch (error) {
      console.error(`[workbench] ${failureTitle}`, error);
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
    wx.showToast({
      title: "正在打开制作页",
      icon: "loading",
      duration: 800
    });

    const showNavigationFailure = (error) => {
      console.error("[workbench] 制作页打开失败", { url, error });
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
        },
        fail: (error) => {
          console.warn("[workbench] 替换页面失败，改用重开方式", { url, error });
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
        storage.clearProject();
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
