const REDIRECT_DELAY = 1200;

Page({
  data: {
    redirectDelay: REDIRECT_DELAY
  },

  onLoad() {
    this._redirectTimer = setTimeout(() => {
      wx.reLaunch({
        url: "/pages/workbench/workbench"
      });
    }, REDIRECT_DELAY);
  },

  onUnload() {
    if (this._redirectTimer) {
      clearTimeout(this._redirectTimer);
      this._redirectTimer = null;
    }
  }
});
