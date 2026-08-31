const cloud = require("../../services/cloud");

const GROUPS = [
  {
    key: "standard",
    title: "开始新创作",
    note: "四项模型分别配置，主模型与备用模型互不影响。",
    items: [
      { key: "face", slot: "standard.face", label: "人脸识别", icon: "脸" },
      { key: "imageAnalysis", slot: "standard.imageAnalysis", label: "图片分析", icon: "图" },
      { key: "styleAnalysis", slot: "standard.styleAnalysis", label: "网感分析", icon: "感" },
      { key: "imageGeneration", slot: "standard.imageGeneration", label: "生图模型", icon: "生" }
    ]
  },
  {
    key: "tencent",
    title: "开始新创作-腾讯版",
    note: "腾讯版独立维护，换脸供应商需要单独配置。",
    items: [
      { key: "face", slot: "tencent.face", label: "人脸识别", icon: "脸" },
      { key: "imageAnalysis", slot: "tencent.imageAnalysis", label: "图片分析", icon: "图" },
      { key: "styleAnalysis", slot: "tencent.styleAnalysis", label: "网感分析", icon: "感" },
      { key: "imageGeneration", slot: "tencent.imageGeneration", label: "生图模型", icon: "生" }
    ]
  }
];

const FALLBACK = {
  bindings: []
};

function bindingFor(bindings, slot) {
  return (bindings || []).find(item => item && item.slot === slot) || {};
}

function statusText(binding) {
  if (!binding || binding.status === "not-ready" || binding.status === "needsReview") return "待配置";
  return binding.providerName || binding.providerKey ? "正常" : "待配置";
}

function isReady(binding) {
  return Boolean(binding && binding.status === "ready" && (binding.modelId || binding.model));
}

Page({
  data: {
    loading: true,
    refreshing: false,
    source: "local",
    statusLabel: "本地配置待同步",
    statusTone: "warning",
    configuredCount: 0,
    totalCount: 9,
    failedCount: 0,
    standardItems: [],
    tencentItems: [],
    sharedVideo: {
      slot: "shared.video",
      label: "共享视频模型",
      detail: "照片转实况统一使用，不重复配置。",
      status: "正常",
      model: "kling-video-v2",
      provider: "凌云"
    },
    metrics: [
      { key: "usage", label: "用量", detail: "查看", icon: "量" },
      { key: "points", label: "积分", detail: "管理", icon: "积" },
      { key: "cost", label: "成本", detail: "统计", icon: "￥" },
      { key: "users", label: "用户", detail: "管理", icon: "人" }
    ]
  },

  onLoad() {
    this.loadConfig();
  },

  onPullDownRefresh() {
    this.loadConfig(true);
  },

  async loadConfig(refreshing = false) {
    this.setData({ loading: !refreshing, refreshing });
    let result = null;
    if (cloud && typeof cloud.getAdminConfigV2 === "function") {
      try {
        result = await cloud.getAdminConfigV2({ retryLimit: 0, silent: true });
      } catch (error) {
        result = null;
      }
    }
    const config = result && result.ok !== false && result.data ? result.data : (result && result.ok !== false ? result : null);
    this.applyConfig(config || FALLBACK, Boolean(config));
    if (refreshing && typeof wx !== "undefined" && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  },

  applyConfig(config, fromCloud) {
    const bindings = Array.isArray(config.bindings) ? config.bindings : FALLBACK.bindings;
    const standardItems = GROUPS[0].items.map(item => {
      const binding = bindingFor(bindings, item.slot);
      return Object.assign({}, item, {
        status: statusText(binding),
        ready: isReady(binding),
        provider: binding.providerName || binding.providerKey || "未选择供应商",
        model: binding.modelId || binding.model || "未选择模型"
      });
    });
    const tencentItems = GROUPS[1].items.map(item => {
      const binding = bindingFor(bindings, item.slot);
      return Object.assign({}, item, {
        status: statusText(binding),
        ready: isReady(binding),
        provider: binding.providerName || binding.providerKey || "待配置",
        model: binding.modelId || binding.model || "待配置"
      });
    });
    const video = bindingFor(bindings, "shared.video");
    const readyCount = bindings.filter(item => (
      item
      && item.slot !== "shared.video"
      && (item.role || "primary") === "primary"
      && isReady(item)
    )).length;
    this.setData({
      loading: false,
      refreshing: false,
      source: fromCloud ? "cloud" : "local",
      statusLabel: fromCloud ? "云端配置已同步" : "配置读取失败",
      statusTone: fromCloud ? "ready" : "warning",
      configuredCount: readyCount,
      totalCount: 8,
      standardItems,
      tencentItems,
      sharedVideo: {
        slot: "shared.video",
        label: "共享视频模型",
        detail: "照片转实况统一使用，不重复配置。",
        status: statusText(video),
        provider: video.providerName || video.providerKey || "待配置",
        model: video.modelId || video.model || "待配置"
      }
    });
  },

  openProvider() {
    wx.navigateTo({ url: "/pages/admin-provider/admin-provider" });
  },

  openConfig(event) {
    const slot = event.currentTarget.dataset.slot || "standard.face";
    const parts = String(slot).split(".");
    const group = parts[0] === "shared" ? "shared" : parts[0];
    const tab = parts[1] || "face";
    wx.navigateTo({ url: `/pages/admin-config/admin-config?group=${group}&tab=${tab}` });
  },

  openSharedVideo() {
    wx.navigateTo({ url: "/pages/admin-config/admin-config?group=shared&tab=video" });
  },

  openMetric(event) {
    const key = event.currentTarget.dataset.key || "usage";
    const sectionMap = { usage: "usage", points: "points", cost: "cost", users: "users" };
    const section = sectionMap[key] || "usage";
    wx.navigateTo({ url: `/pages/admin-operations/admin-operations?view=${section}` });
  },

  refreshAll() {
    this.loadConfig(true);
  },

  checkDeployment() {
    if (cloud && typeof cloud.checkDeployment === "function") {
      cloud.checkDeployment().then(() => wx.showToast({ title: "检查请求已提交", icon: "none" })).catch(() => wx.showToast({ title: "暂时无法检查", icon: "none" }));
      return;
    }
    wx.showToast({ title: "本地预览不检查线上部署", icon: "none" });
  },

  probeAll() {
    wx.showToast({ title: "请在供应商页逐个测试连接", icon: "none" });
  }
});
