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
    },
    points: {
      dailyFreeLimit: "3",
      imageCost: "10",
      videoCost: "10",
      checkinPoints: "5",
      streakBonus: "20",
      streakDays: "7",
      promoStartDate: "2026-08-23",
      promoEndDate: "2026-08-24",
      timeZone: "Asia/Shanghai"
    },
    costs: {
      faceInputPerMillionTokens: "0.15",
      faceOutputPerMillionTokens: "1.5",
      image1K: "0.015",
      image2K: "0.025",
      image4K: "0.035",
      video480p: "0.2",
      video720p: "0.3",
      video1080p: "1.8",
      videoDefaultDuration: "3"
    }
  };
}

const USAGE_TYPE_META = [
  { key: "image", title: "生图模型", icon: "✦" },
  { key: "face", title: "人脸识别", icon: "◎" },
  { key: "video", title: "视频模型", icon: "▶" }
];

function emptyUsageCounter() {
  return {
    total: 0,
    success: 0,
    failure: 0,
    estimatedCost: 0,
    pricedCost: 0,
    unavailableCostCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    videoDurationSeconds: 0,
    imageResolutions: {
      "1K": { count: 0, cost: 0 },
      "2K": { count: 0, cost: 0 },
      "4K": { count: 0, cost: 0 }
    },
    videoResolutions: {
      "480p": { seconds: 0, cost: 0 },
      "720p": { seconds: 0, cost: 0 },
      "1080p": { seconds: 0, cost: 0 }
    }
  };
}

function emptyFailureStats() {
  return {
    total: 0,
    failureRate: 0,
    topFailureReasons: [],
    failedModels: [],
    failureDetails: []
  };
}

function emptyUsageStats() {
  return {
    timeZone: "Asia/Shanghai",
    days: 30,
    todayKey: "",
    today: emptyUsageCounter(),
    last7d: emptyUsageCounter(),
    last30d: emptyUsageCounter(),
    summary: {
      image: emptyUsageCounter(),
      face: emptyUsageCounter(),
      video: emptyUsageCounter()
    },
    cards: USAGE_TYPE_META.map((item) => ({
      key: item.key,
      title: item.title,
      icon: item.icon,
      total: 0,
      success: 0,
      failure: 0,
      modelText: "暂无调用"
    })),
    daily: [],
    monthly: [],
    users: [],
    models: [],
    failureStats: emptyFailureStats(),
    pricing: null,
    unavailable: false,
    message: ""
  };
}

function formatUsageStats(result) {
  const source = result || {};
  const summary = source.summary || {};
  const models = Array.isArray(source.models) ? source.models : [];
  const cards = USAGE_TYPE_META.map((meta) => {
    const counter = summary[meta.key] || emptyUsageCounter();
    const modelText = models
      .filter((item) => item.usageType === meta.key)
      .map((item) => {
        const provider = item.provider || "未知 Provider";
        const model = item.model || "未知模型";
        return `${provider} / ${model}`;
      })
      .filter((item, index, list) => list.indexOf(item) === index)
      .join("、") || "暂无调用";
    return Object.assign({}, meta, counter, { modelText });
  });
  const daily = (Array.isArray(source.daily) ? source.daily : []).map((item) => ({
    dateKey: item.dateKey,
    dateLabel: item.dateKey === source.todayKey ? `${item.dateKey} 今天` : item.dateKey,
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    image: Object.assign(emptyUsageCounter(), item.image || {}),
    face: Object.assign(emptyUsageCounter(), item.face || {}),
    video: Object.assign(emptyUsageCounter(), item.video || {})
  }));
  const monthly = (Array.isArray(source.monthly) ? source.monthly : []).map((item) => ({
    monthKey: item.monthKey || "",
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    image: Object.assign(emptyUsageCounter(), item.image || {}),
    face: Object.assign(emptyUsageCounter(), item.face || {}),
    video: Object.assign(emptyUsageCounter(), item.video || {})
  }));
  const users = (Array.isArray(source.users) ? source.users : []).map((item) => ({
    userHash: item.userHash || "anonymous",
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    byType: item.byType || {}
  }));
  const failureSource = source.failureStats || {};
  const failureStats = Object.assign(emptyFailureStats(), {
    total: Number(failureSource.total) || 0,
    failureRate: Number(failureSource.failureRate) || 0,
    topFailureReasons: (Array.isArray(failureSource.topFailureReasons)
      ? failureSource.topFailureReasons
      : []
    ).map((item) => ({
      key: item.key || "",
      code: item.code || "",
      label: item.label || "未提供错误原因",
      count: Number(item.count) || 0,
      rate: Number(item.rate) || 0,
      lastSeen: item.lastSeen || "",
      usageType: item.usageType || "",
      provider: item.provider || "",
      model: item.model || "",
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable)
    })),
    failedModels: (Array.isArray(failureSource.failedModels)
      ? failureSource.failedModels
      : []
    ).map((item) => ({
      usageType: item.usageType || "",
      provider: item.provider || "未知 Provider",
      model: item.model || "未知模型",
      total: Number(item.total) || 0,
      failure: Number(item.failure) || 0,
      failureRate: Number(item.failureRate) || 0
    })),
    failureDetails: Array.isArray(failureSource.failureDetails)
      ? failureSource.failureDetails
      : []
  });
  return Object.assign(emptyUsageStats(), source, {
    today: Object.assign(emptyUsageCounter(), source.today || {}),
    last7d: Object.assign(emptyUsageCounter(), source.last7d || {}),
    last30d: Object.assign(emptyUsageCounter(), source.last30d || {}),
    cards,
    daily,
    monthly,
    users,
    failureStats
  });
}

function formFromConfig(result) {
  const source = result && result.effective ? result.effective : {};
  const image = source.image || {};
  const video = source.video || {};
  const points = source.points || {};
  const costs = source.costs || {};
  const faceCosts = costs.face || {};
  const imageCosts = costs.image || {};
  const videoCosts = costs.video || {};
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
    },
    points: {
      dailyFreeLimit: String(points.dailyFreeLimit || 3),
      imageCost: String(points.imageCost || 10),
      videoCost: String(points.videoCost || 10),
      checkinPoints: String(points.checkinPoints || 5),
      streakBonus: String(points.streakBonus || 20),
      streakDays: String(points.streakDays || 7),
      promoStartDate: points.promoStartDate || "2026-08-23",
      promoEndDate: points.promoEndDate || "2026-08-24",
      timeZone: points.timeZone || "Asia/Shanghai"
    },
    costs: {
      faceInputPerMillionTokens: String(faceCosts.inputPerMillionTokens || 0.15),
      faceOutputPerMillionTokens: String(faceCosts.outputPerMillionTokens || 1.5),
      image1K: String(imageCosts.perImage && imageCosts.perImage["1K"] || 0.015),
      image2K: String(imageCosts.perImage && imageCosts.perImage["2K"] || 0.025),
      image4K: String(imageCosts.perImage && imageCosts.perImage["4K"] || 0.035),
      video480p: String(videoCosts.perSecond && videoCosts.perSecond["480p"] || 0.2),
      video720p: String(videoCosts.perSecond && videoCosts.perSecond["720p"] || 0.3),
      video1080p: String(videoCosts.perSecond && videoCosts.perSecond["1080p"] || 1.8),
      videoDefaultDuration: String(videoCosts.defaultDurationSeconds || 3)
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
    },
    points: {
      dailyFreeLimit: Number(form.points.dailyFreeLimit || 0),
      imageCost: Number(form.points.imageCost || 0),
      videoCost: Number(form.points.videoCost || 0),
      checkinPoints: Number(form.points.checkinPoints || 0),
      streakBonus: Number(form.points.streakBonus || 0),
      streakDays: Number(form.points.streakDays || 0),
      promoStartDate: String(form.points.promoStartDate || "").trim(),
      promoEndDate: String(form.points.promoEndDate || "").trim(),
      timeZone: String(form.points.timeZone || "Asia/Shanghai").trim()
    },
    costs: {
      currency: "CNY",
      face: {
        inputPerMillionTokens: Number(form.costs.faceInputPerMillionTokens || 0),
        outputPerMillionTokens: Number(form.costs.faceOutputPerMillionTokens || 0)
      },
      image: {
        defaultResolution: "1K",
        perImage: {
          "1K": Number(form.costs.image1K || 0),
          "2K": Number(form.costs.image2K || 0),
          "4K": Number(form.costs.image4K || 0)
        }
      },
      video: {
        defaultResolution: "720p",
        perSecond: {
          "480p": Number(form.costs.video480p || 0),
          "720p": Number(form.costs.video720p || 0),
          "1080p": Number(form.costs.video1080p || 0)
        },
        defaultDurationSeconds: Number(form.costs.videoDefaultDuration || 0)
      }
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
    message: "",
    usageLoading: false,
    usageExporting: false,
    usageStats: emptyUsageStats()
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
      let usageStats = emptyUsageStats();
      try {
        usageStats = formatUsageStats(await cloud.getModelUsageStats(30));
      } catch (error) {
        usageStats = Object.assign(usageStats, {
          unavailable: true,
          message: "用量统计暂时读取失败，请点击刷新。"
        });
        diagnosticLog.warn("admin", "usage-load-failed", "模型用量统计读取失败", { error });
      }
      this.setData({
        loading: false,
        isAdmin: true,
        form: formFromConfig(result),
        defaults: result.defaults || null,
        effective: result.effective || null,
        logs: (logs.logs || []).map(displayLog),
        usageStats,
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

  async refreshModelUsage() {
    if (this.data.usageLoading) return;
    this.setData({ usageLoading: true });
    try {
      const result = await cloud.getModelUsageStats(30);
      this.setData({
        usageLoading: false,
        usageStats: formatUsageStats(result)
      });
      wx.showToast({ title: "统计已刷新", icon: "success" });
    } catch (error) {
      this.setData({
        usageLoading: false,
        "usageStats.unavailable": true,
        "usageStats.message": "统计读取失败，请稍后重试。"
      });
      diagnosticLog.error("admin", "usage-refresh-failed", "模型用量统计刷新失败", { error });
      this.showError("统计刷新失败", error);
    }
  },

  async exportModelUsage() {
    if (this.data.usageExporting) return;
    this.setData({ usageExporting: true });
    try {
      const result = await cloud.exportModelUsageStats(30);
      if (!result || !result.fileID) throw new Error("Excel 文件生成失败。");
      const filePath = await cloud.downloadFile(result.fileID);
      if (!filePath || typeof wx.openDocument !== "function") {
        throw new Error("文件已生成，但当前微信版本无法打开 Excel 文件。");
      }
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath,
          fileType: "xlsx",
          showMenu: true,
          success: resolve,
          fail: reject
        });
      });
      this.setData({ usageExporting: false });
      wx.showToast({ title: "Excel已导出", icon: "success" });
    } catch (error) {
      this.setData({ usageExporting: false });
      diagnosticLog.error("admin", "usage-export-failed", "模型用量 Excel 导出失败", { error });
      this.showError("导出失败", error);
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
