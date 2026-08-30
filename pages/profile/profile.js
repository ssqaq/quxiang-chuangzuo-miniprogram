const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");

const WORKBENCH_URL = "/pages/workbench/workbench";
const USER_CENTER_URL = "/pages/user-center/user-center";

function privacyAuthorization() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== "function") {
      resolve();
      return;
    }
    wx.requirePrivacyAuthorize({
      success: resolve,
      fail: reject
    });
  });
}

Page({
  data: {
    loading: true,
    saving: false,
    nickname: "",
    gender: "",
    avatarPath: "",
    avatarFileID: "",
    fromCheckIn: false,
    fromUserCenter: false,
    pageTitle: "完善用户资料",
    errorMessage: ""
  },

  onLoad(options = {}) {
    const fromCheckIn = options.from === "checkin";
    const fromUserCenter = options.from === "user-center";
    const pageTitle = fromCheckIn ? "签到资料" : fromUserCenter ? "编辑个人资料" : "完善用户资料";
    this.setData({ fromCheckIn, fromUserCenter, pageTitle });
    if (typeof wx.setNavigationBarTitle === "function") {
      wx.setNavigationBarTitle({
        title: pageTitle
      });
    }
    this.loadProfile();
  },

  async loadProfile() {
    if (!cloud.isCloudReady()) {
      this.setData({
        loading: false,
        errorMessage: "云端没有连接，请检查网络后重试。"
      });
      return;
    }
    this.setData({ loading: true, errorMessage: "" });
    try {
      const result = await cloud.getMyUserProfile({ retryLimit: 1 });
      const profile = result && result.profile || {};
      this.setData({
        loading: false,
        nickname: profile.nickname || "",
        gender: profile.gender || "",
        avatarPath: profile.avatarUrl || profile.avatarFileID || "",
        avatarFileID: profile.avatarFileID || ""
      });
    } catch (error) {
      this.setData({
        loading: false,
        errorMessage: (error && error.message) || "用户资料读取失败，请重试。"
      });
      diagnosticLog.error("profile", "load-failed", "用户资料读取失败", { error });
    }
  },

  onChooseAvatar(event) {
    const avatarPath = event && event.detail && event.detail.avatarUrl || "";
    if (!avatarPath) return;
    this.setData({
      avatarPath,
      avatarFileID: /^cloud:\/\//i.test(avatarPath) ? avatarPath : "",
      errorMessage: ""
    });
  },

  onNicknameInput(event) {
    this.setData({
      nickname: String(event && event.detail && event.detail.value || "").slice(0, 32),
      errorMessage: ""
    });
  },

  chooseGender(event) {
    const gender = event.currentTarget.dataset.gender;
    if (gender !== "male" && gender !== "female") return;
    this.setData({ gender, errorMessage: "" });
  },

  validateProfile() {
    if (!this.data.avatarPath) return "请先选择微信头像。";
    if (!String(this.data.nickname || "").trim()) return "请填写微信昵称。";
    if (!["male", "female"].includes(this.data.gender)) return "请选择男性或女性。";
    return "";
  },

  async saveProfile() {
    if (this.data.saving) return;
    const validationMessage = this.validateProfile();
    if (validationMessage) {
      this.setData({ errorMessage: validationMessage });
      wx.showToast({ title: validationMessage, icon: "none" });
      return;
    }
    this.setData({ saving: true, errorMessage: "" });
    try {
      await privacyAuthorization();
      let avatarFileID = this.data.avatarFileID;
      if (!avatarFileID) {
        const uploaded = await cloud.uploadAsset(this.data.avatarPath, "avatar", {
          contentType: "image/jpeg"
        });
        avatarFileID = uploaded && uploaded.fileID || "";
      }
      if (!avatarFileID) throw new Error("头像上传失败，请重新选择头像。");
      const result = await cloud.saveMyUserProfile({
        nickname: String(this.data.nickname || "").trim(),
        avatarFileID,
        gender: this.data.gender
      });
      if (!result || !result.completed) throw new Error("资料没有保存完整，请重试。");
      this.setData({
        saving: false,
        avatarFileID,
        avatarPath: result.profile && result.profile.avatarUrl || avatarFileID
      });
      if (this.data.fromCheckIn) {
        try {
          const checkInResult = await cloud.checkIn();
          const earned = Number(checkInResult && checkInResult.earnedToday) || 0;
          wx.showToast({
            title: checkInResult && checkInResult.duplicate
              ? "今天已经签过了"
              : `签到成功，获得${earned}积分`,
            icon: checkInResult && checkInResult.duplicate ? "none" : "success"
          });
        } catch (checkInError) {
          diagnosticLog.error("profile", "checkin-after-save-failed", "资料保存后签到失败", {
            error: checkInError
          });
          wx.showToast({ title: "资料已保存，签到失败请重试", icon: "none" });
        }
      } else {
        wx.showToast({ title: "资料已保存", icon: "success" });
      }
      setTimeout(() => {
        if (this.data.fromUserCenter) {
          const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
          if (pages.length > 1 && typeof wx.navigateBack === "function") {
            wx.navigateBack({ delta: 1 });
            return;
          }
          wx.redirectTo({ url: USER_CENTER_URL });
          return;
        }
        wx.reLaunch({ url: WORKBENCH_URL });
      }, 650);
    } catch (error) {
      const message = (error && error.message) || "资料保存失败，请重试。";
      this.setData({ saving: false, errorMessage: message });
      diagnosticLog.error("profile", "save-failed", "用户资料保存失败", { error });
      wx.showModal({
        title: "保存失败",
        content: message,
        showCancel: false
      });
    }
  }
});
