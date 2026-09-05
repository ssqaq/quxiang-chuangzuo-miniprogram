"use strict";

const TARGET_ROUTE = "/pages/workbench/workbench";

Page({
  data: {
    redirecting: true
  },

  onLoad() {
    this.redirectToUserCenter();
  },

  onShow() {
    if (!this._redirectStarted) this.redirectToUserCenter();
  },

  redirectToUserCenter() {
    if (this._redirectStarted) return;
    this._redirectStarted = true;
    wx.redirectTo({
      url: TARGET_ROUTE,
      fail: () => {
        wx.reLaunch({
          url: TARGET_ROUTE,
          fail: () => {
            this._redirectStarted = false;
            this.setData({ redirecting: false });
            wx.showToast({ title: "用户中心打开失败，请重试", icon: "none" });
          }
        });
      }
    });
  }
});
