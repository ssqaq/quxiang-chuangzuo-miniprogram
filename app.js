const config = require("./config");
const diagnosticLog = require("./utils/diagnostic-log");
const cloud = require("./services/cloud");

App({
  globalData: {
    cloudReady: false,
    cloudEnvId: config.cloudEnvId,
    appVersion: config.appVersion,
    user: null
  },

  onLaunch() {
    diagnosticLog.startSession({
      reason: "app-launch",
      appVersion: config.appVersion
    });
    diagnosticLog.info("app", "launch", "小程序启动", {
      cloudEnvConfigured: Boolean(
        config.cloudEnvId && config.cloudEnvId !== "YOUR_CLOUDBASE_ENV_ID"
      )
    });
    if (!wx.cloud || !config.cloudEnvId || config.cloudEnvId === "YOUR_CLOUDBASE_ENV_ID") {
      diagnosticLog.warn("app", "cloud-unavailable", "云开发环境未配置或当前环境不支持", {
        cloudApiAvailable: Boolean(wx.cloud)
      });
      return;
    }

    try {
      wx.cloud.init({
        env: config.cloudEnvId,
        traceUser: true
      });
      this.globalData.cloudReady = true;
      diagnosticLog.configureRemoteReporting({
        reporter: (payload) => cloud.reportDiagnosticLogs(payload),
        contextProvider: () => ({
          appVersion: config.appVersion
        })
      });
      diagnosticLog.info("app", "cloud-ready", "云开发初始化完成", {
        cloudEnvId: config.cloudEnvId
      });
      diagnosticLog.flushRemote();
    } catch (error) {
      console.error("云开发初始化失败", error);
      this.globalData.cloudReady = false;
      diagnosticLog.error("app", "cloud-init-failed", "云开发初始化失败", {
        error
      });
    }
  },

  onError(error) {
    diagnosticLog.error("app", "global-error", "捕获到小程序全局错误", {
      error
    });
  },

  onUnhandledRejection(event = {}) {
    diagnosticLog.error("app", "unhandled-rejection", "捕获到未处理的异步错误", {
      error: event.reason || event
    });
  },

  onShow() {
    if (this.globalData.cloudReady) diagnosticLog.flushRemote();
  },

  onHide() {
    if (this.globalData.cloudReady) diagnosticLog.flushRemote();
  },

  onPageNotFound(event = {}) {
    diagnosticLog.error("navigation", "page-not-found", "访问了不存在的页面", {
      route: event.path || "",
      query: event.query || {},
      isEntryPage: Boolean(event.isEntryPage)
    });
  }
});
