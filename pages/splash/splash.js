const cloud = require("../../services/cloud");

const REDIRECT_DELAY = 888;
const WORKBENCH_URL = "/pages/workbench/workbench";
const PROFILE_URL = "/pages/profile/profile";

Page({
  data: {
    redirectDelay: REDIRECT_DELAY,
    checkingProfile: true,
    errorMessage: ""
  },

  onLoad() {
    this._redirectTimer = setTimeout(() => {
      this._redirectTimer = null;
      this.checkUserProfile();
    }, REDIRECT_DELAY);
  },

  async checkUserProfile() {
    if (this._checkingProfile || this._navigating) return;
    this._checkingProfile = true;
    this.setData({ checkingProfile: true, errorMessage: "" });
    try {
      if (!cloud.isCloudReady()) {
        throw new Error("云端没有连接，请检查网络后重试。");
      }
      const result = await cloud.getMyUserProfile({ retryLimit: 1 });
      this.openPage(result && result.completed ? WORKBENCH_URL : PROFILE_URL);
    } catch (error) {
      this._checkingProfile = false;
      this.setData({
        checkingProfile: false,
        errorMessage: (error && error.message) || "资料读取失败，请重试。"
      });
    }
  },

  retryProfileCheck() {
    this.checkUserProfile();
  },

  openPage(url) {
    if (this._navigating) return;
    this._navigating = true;
    const fallback = () => {
      wx.reLaunch({
        url
      });
    };
    if (typeof wx.redirectTo !== "function") {
      fallback();
      return;
    }
    wx.redirectTo({
      url,
      fail: fallback
    });
  },

  onUnload() {
    if (this._redirectTimer) {
      clearTimeout(this._redirectTimer);
      this._redirectTimer = null;
    }
  }
});
