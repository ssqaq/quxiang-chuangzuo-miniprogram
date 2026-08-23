const config = require("./config");

App({
  globalData: {
    cloudReady: false,
    cloudEnvId: config.cloudEnvId,
    appVersion: config.appVersion,
    user: null
  },

  onLaunch() {
    if (!wx.cloud || !config.cloudEnvId || config.cloudEnvId === "YOUR_CLOUDBASE_ENV_ID") {
      return;
    }

    try {
      wx.cloud.init({
        env: config.cloudEnvId,
        traceUser: true
      });
      this.globalData.cloudReady = true;
    } catch (error) {
      console.error("云开发初始化失败", error);
      this.globalData.cloudReady = false;
    }
  }
});
