const REDIRECT_DELAY = 888;
const WORKBENCH_URL = "/pages/workbench/workbench";

Page({
  data: {
    redirectDelay: REDIRECT_DELAY
  },

  onLoad() {
    this._redirectTimer = setTimeout(() => {
      this._redirectTimer = null;
      this.openWorkbench();
    }, REDIRECT_DELAY);
  },

  openWorkbench() {
    if (this._navigating) return;
    this._navigating = true;
    const fallback = () => {
      wx.reLaunch({
        url: WORKBENCH_URL
      });
    };
    if (typeof wx.redirectTo !== "function") {
      fallback();
      return;
    }
    wx.redirectTo({
      url: WORKBENCH_URL,
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
