const config = require("../../config");
const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");

function emptyForm() {
  return {
    image: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      model: "",
      mode: "generations",
      size: "1024x1024",
      timeoutMs: "90000",
      maxRetries: "2",
      retryEnabled: false
    },
    video: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      queryEndpoint: "",
      model: "",
      createPath: "/v1/videos/generations",
      queryPath: "/v1/videos/{taskId}",
      resolution: "720p",
      aspectRatio: "",
      timeoutMs: "90000"
    }
  };
}

function formFromConfig(result) {
  const source = result && result.effective ? result.effective : {};
  const image = source.image || {};
  const video = source.video || {};
  return {
    image: {
      provider: image.provider || "",
      baseUrl: image.baseUrl || "",
      endpoint: image.endpoint || "",
      model: image.model || "",
      mode: image.mode || "generations",
      size: image.size || "1024x1024",
      timeoutMs: String(image.timeoutMs || 90000),
      maxRetries: String(image.maxRetries || 0),
      retryEnabled: Boolean(image.retryEnabled)
    },
    video: {
      provider: video.provider || "",
      baseUrl: video.baseUrl || "",
      endpoint: video.endpoint || "",
      queryEndpoint: video.queryEndpoint || "",
      model: video.model || "",
      createPath: video.createPath || "/v1/videos/generations",
      queryPath: video.queryPath || "/v1/videos/{taskId}",
      resolution: video.resolution || "720p",
      aspectRatio: video.aspectRatio || "",
      timeoutMs: String(video.timeoutMs || 90000)
    }
  };
}

function formToConfig(form) {
  return {
    image: {
      provider: String(form.image.provider || "").trim(),
      baseUrl: String(form.image.baseUrl || "").trim(),
      endpoint: String(form.image.endpoint || "").trim(),
      model: String(form.image.model || "").trim(),
      mode: String(form.image.mode || "").trim().toLowerCase(),
      size: String(form.image.size || "").trim(),
      timeoutMs: Number(form.image.timeoutMs || 0),
      maxRetries: Number(form.image.maxRetries || 0),
      retryEnabled: Boolean(form.image.retryEnabled)
    },
    video: {
      provider: String(form.video.provider || "").trim(),
      baseUrl: String(form.video.baseUrl || "").trim(),
      endpoint: String(form.video.endpoint || "").trim(),
      queryEndpoint: String(form.video.queryEndpoint || "").trim(),
      model: String(form.video.model || "").trim(),
      createPath: String(form.video.createPath || "").trim(),
      queryPath: String(form.video.queryPath || "").trim(),
      resolution: String(form.video.resolution || "").trim(),
      aspectRatio: String(form.video.aspectRatio || "").trim(),
      timeoutMs: Number(form.video.timeoutMs || 0)
    }
  };
}

function displayLog(item) {
  const value = item || {};
  return Object.assign({}, value, {
    checkedAtText: value.checkedAt
      ? String(value.checkedAt).replace("T", " ").replace(/\.\d+Z$/, "")
      : "未知时间",
    statusText: value.ok ? "检查通过" : "需要处理",
    imageText: value.image && value.image.ready ? "生图可用" : "生图未就绪",
    videoText: value.video && value.video.ready ? "视频可用" : "视频未就绪"
  });
}

Page({
  data: {
    appVersion: config.appVersion,
    loading: true,
    saving: false,
    checking: false,
    isAdmin: false,
    form: emptyForm(),
    defaults: null,
    effective: null,
    deployment: null,
    logs: [],
    message: ""
  },

  onLoad() {
    this.loadAdminPage();
  },

  onPullDownRefresh() {
    this.loadAdminPage().finally(() => wx.stopPullDownRefresh());
  },

  async loadAdminPage() {
    if (!cloud.isCloudReady()) {
      this.setData({ loading: false, message: "云端未连接，无法读取管理员配置。" });
      return;
    }
    this.setData({ loading: true, message: "" });
    try {
      const status = await cloud.getAdminStatus();
      if (!status || !status.isAdmin) {
        this.setData({ loading: false, isAdmin: false, message: "当前账号没有管理员权限。" });
        wx.showModal({
          title: "无权访问",
          content: "当前微信账号不在管理员白名单中。",
          showCancel: false,
          success: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
        });
        return;
      }
      const [result, logs] = await Promise.all([
        cloud.getAdminConfig(),
        cloud.listDeploymentLogs()
      ]);
      this.setData({
        loading: false,
        isAdmin: true,
        form: formFromConfig(result),
        defaults: result.defaults || null,
        effective: result.effective || null,
        logs: (logs.logs || []).map(displayLog),
        message: ""
      });
      diagnosticLog.info("admin", "config-loaded", "管理员配置读取完成", {
        runtimeConfigVersion: result.version || 0
      });
    } catch (error) {
      this.setData({ loading: false, message: "管理员配置读取失败，请检查云函数部署和白名单。" });
      diagnosticLog.error("admin", "config-load-failed", "管理员配置读取失败", { error });
    }
  },

  onInput(event) {
    const section = event.currentTarget.dataset.section;
    const key = event.currentTarget.dataset.key;
    if (!section || !key) return;
    this.setData({
      [`form.${section}.${key}`]: event.detail.value
    });
  },

  onRetryChange(event) {
    this.setData({
      "form.image.retryEnabled": Array.isArray(event.detail.value)
        && event.detail.value.includes("enabled")
    });
  },

  async saveConfig() {
    if (this.data.saving) return;
    this.setData({ saving: true, message: "" });
    try {
      const result = await cloud.saveAdminConfig(formToConfig(this.data.form));
      this.setData({
        form: formFromConfig(result),
        effective: result.effective || null,
        saving: false,
        message: `配置已保存，第 ${result.version || 0} 版`
      });
      diagnosticLog.info("admin", "config-saved", "管理员配置保存完成", {
        version: result.version || 0
      });
      wx.showToast({ title: "配置已保存", icon: "success" });
    } catch (error) {
      this.setData({ saving: false });
      diagnosticLog.error("admin", "config-save-failed", "管理员配置保存失败", { error });
      this.showError("保存失败", error);
    }
  },

  async checkDeployment() {
    if (this.data.checking) return;
    this.setData({ checking: true, message: "" });
    try {
      const result = await cloud.checkDeployment();
      const logs = await cloud.listDeploymentLogs();
      this.setData({
        deployment: result,
        logs: (logs.logs || []).map(displayLog),
        checking: false,
        message: result.logWritten ? "线上部署检查完成，日志已写入。" : "检查完成，但日志写入失败。"
      });
      diagnosticLog.info("admin", "deployment-checked", "线上部署检查完成", {
        buildVersion: result.buildVersion,
        buildMarker: result.buildMarker,
        logWritten: result.logWritten
      });
    } catch (error) {
      this.setData({ checking: false });
      diagnosticLog.error("admin", "deployment-check-failed", "线上部署检查失败", { error });
      this.showError("检查失败", error);
    }
  },

  backToWorkbench() {
    wx.reLaunch({ url: "/pages/workbench/workbench" });
  },

  showError(title, error) {
    const payload = error && error.payload;
    const message = (payload && (payload.message || payload.error))
      || (error && error.message)
      || "请稍后重试";
    wx.showModal({
      title,
      content: String(message),
      showCancel: false
    });
  }
});
