const cloud = require("../../services/cloud");
const previewFixtures = require("../../services/admin-preview-fixtures");

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

function navigationLayout() {
  let windowInfo = {};
  let menuButton = {};
  try {
    if (typeof wx !== "undefined" && typeof wx.getWindowInfo === "function") {
      windowInfo = wx.getWindowInfo() || {};
    } else if (typeof wx !== "undefined" && typeof wx.getSystemInfoSync === "function") {
      windowInfo = wx.getSystemInfoSync() || {};
    }
  } catch (error) {
    windowInfo = {};
  }
  try {
    if (typeof wx !== "undefined" && typeof wx.getMenuButtonBoundingClientRect === "function") {
      menuButton = wx.getMenuButtonBoundingClientRect() || {};
    }
  } catch (error) {
    menuButton = {};
  }
  const statusBarHeight = Math.max(0, Number(windowInfo.statusBarHeight) || 0);
  const windowWidth = Math.max(320, Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375);
  const menuTop = Number(menuButton.top);
  const menuHeight = Number(menuButton.height);
  const menuLeft = Number(menuButton.left);
  const hasMenuButton = Number.isFinite(menuTop)
    && Number.isFinite(menuHeight)
    && Number.isFinite(menuLeft)
    && menuHeight > 0
    && menuLeft > 0;
  const navigationBarHeight = hasMenuButton
    ? Math.max(52, (menuTop - statusBarHeight) * 2 + menuHeight)
    : 52;
  const navigationHeight = Math.round(statusBarHeight + navigationBarHeight);
  const capsuleRightInset = hasMenuButton
    ? Math.round(Math.max(14, windowWidth - menuLeft + 8))
    : 14;
  return {
    appbarStyle: `height:${navigationHeight}px;padding-top:${Math.round(statusBarHeight)}px;padding-right:${capsuleRightInset}px`,
    dashboardScrollStyle: `height:calc(100vh - ${navigationHeight}px)`
  };
}

const INITIAL_NAVIGATION_LAYOUT = navigationLayout();

function bindingFor(bindings, slot) {
  return (bindings || []).find(item => item && item.slot === slot) || {};
}

function primaryBindingFor(bindings, slot) {
  return (bindings || []).find(item => (
    item
    && item.slot === slot
    && (item.role || "primary") === "primary"
  )) || {};
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
    appbarStyle: INITIAL_NAVIGATION_LAYOUT.appbarStyle,
    dashboardScrollStyle: INITIAL_NAVIGATION_LAYOUT.dashboardScrollStyle,
    loading: true,
    demoMode: false,
    fixtureId: previewFixtures.REFERENCE_FIXTURE_ID,
    showDemoControl: false,
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
      { key: "usage", label: "用量", detail: "查看" },
      { key: "points", label: "积分", detail: "管理" },
      { key: "cost", label: "成本", detail: "统计" },
      { key: "users", label: "用户", detail: "管理" }
    ]
  },

  onLoad(options) {
    this.demoMode = previewFixtures.isEnabled(options);
    this.fixtureId = previewFixtures.resolveFixtureId(options);
    this.showDemoControl = previewFixtures.isControlVisible(options);
    this.setData({ demoMode: this.demoMode, fixtureId: this.fixtureId, showDemoControl: this.showDemoControl });
    this.applyNavigationLayout();
    this.loadConfig();
  },

  applyNavigationLayout() {
    this.setData(navigationLayout());
  },

  previewQuery(separator = "?") {
    const params = [];
    if (this.demoMode) {
      params.push("demo=1");
      params.push(`fixture=${encodeURIComponent(this.fixtureId || previewFixtures.REFERENCE_FIXTURE_ID)}`);
    }
    if (this.data.showDemoControl) params.push("demoControl=1");
    return params.length ? `${separator}${params.join("&")}` : "";
  },

  onResize() {
    this.applyNavigationLayout();
  },

  toggleDemoMode(event) {
    if (this.data.loading || this.data.refreshing) return;
    const rawValue = event && event.detail ? event.detail.value : undefined;
    const next = typeof rawValue === "boolean"
      ? rawValue
      : (rawValue === "1" || rawValue === 1 ? true : (rawValue === "0" || rawValue === 0 ? false : !this.demoMode));
    previewFixtures.setEnabled(next);
    this.demoMode = next;
    this.setData({ demoMode: next });
    if (next) {
      this.loadConfig();
      return;
    }
    this._configLoadSerial = Number(this._configLoadSerial || 0) + 1;
    this.applyConfig(FALLBACK, false, false);
    this.setData({ statusLabel: "演示已关闭，下拉刷新读取线上配置" });
    if (wx.showToast) wx.showToast({ title: "下拉刷新读取真实数据", icon: "none" });
  },

  onPullDownRefresh() {
    this.loadConfig(true);
  },

  async loadConfig(refreshing = false) {
    const loadSerial = Number(this._configLoadSerial || 0) + 1;
    this._configLoadSerial = loadSerial;
    this.setData({ loading: !refreshing, refreshing });
    if (this.demoMode) {
      this.applyConfig(previewFixtures.adminConfig(), false, true);
      if (refreshing && typeof wx !== "undefined" && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      return;
    }
    let result = null;
    if (cloud && typeof cloud.getAdminConfigV2 === "function") {
      try {
        result = await cloud.getAdminConfigV2({ retryLimit: 0, silent: true });
      } catch (error) {
        result = null;
      }
    }
    if (loadSerial !== this._configLoadSerial) return;
    const config = result && result.ok !== false && result.data ? result.data : (result && result.ok !== false ? result : null);
    this.applyConfig(config || FALLBACK, Boolean(config), false);
    if (refreshing && typeof wx !== "undefined" && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  },

  applyConfig(config, fromCloud, fromDemo = false) {
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
    const video = primaryBindingFor(bindings, "shared.video");
    const featureSlots = GROUPS.reduce((slots, group) => slots.concat(group.items.map(item => item.slot)), []);
    const readyCount = featureSlots.reduce((count, slot) => count + (isReady(primaryBindingFor(bindings, slot)) ? 1 : 0), 0)
      + (isReady(video) ? 1 : 0);
    this.setData({
      loading: false,
      refreshing: false,
      source: fromDemo ? "demo" : (fromCloud ? "cloud" : "local"),
      statusLabel: fromDemo || fromCloud ? "模型配置已连接" : "配置读取失败",
      statusTone: fromDemo || fromCloud ? "ready" : "warning",
      configuredCount: readyCount,
      totalCount: featureSlots.length + 1,
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
    wx.navigateTo({ url: `/pages/admin-provider/admin-provider${this.previewQuery()}` });
  },

  openConfig(event) {
    const slot = event.currentTarget.dataset.slot || "standard.face";
    const parts = String(slot).split(".");
    const group = parts[0] === "shared" ? "shared" : parts[0];
    const tab = parts[1] || "face";
    wx.navigateTo({ url: `/pages/admin-config/admin-config?group=${group}&tab=${tab}${this.previewQuery("&")}` });
  },

  openSharedVideo() {
    wx.navigateTo({ url: `/pages/admin-config/admin-config?group=shared&tab=video${this.previewQuery("&")}` });
  },

  openMetric(event) {
    const key = event.currentTarget.dataset.key || "usage";
    const sectionMap = { usage: "usage", points: "points", cost: "cost", users: "users" };
    const section = sectionMap[key] || "usage";
    wx.navigateTo({ url: `/pages/admin-operations/admin-operations?view=${section}${this.previewQuery("&")}` });
  },

  refreshAll() {
    this.loadConfig(true);
  },

  checkDeployment() {
    if (this.demoMode) {
      wx.showToast({ title: "演示数据不检查线上部署", icon: "none" });
      return;
    }
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
