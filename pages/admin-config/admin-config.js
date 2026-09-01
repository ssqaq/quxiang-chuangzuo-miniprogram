const cloud = require("../../services/cloud");
const previewFixtures = require("../../services/admin-preview-fixtures");

const TAB_DEFS = [
  { key: "face", slot: "face", label: "人脸识别", icon: "脸", path: "/v1/chat/completions", timeout: 30 },
  { key: "imageAnalysis", slot: "imageAnalysis", label: "图片分析", icon: "图", path: "/v1/chat/completions", timeout: 30 },
  { key: "styleAnalysis", slot: "styleAnalysis", label: "网感分析", icon: "感", path: "/v1/chat/completions", timeout: 30 },
  { key: "imageGeneration", slot: "imageGeneration", label: "生图模型", icon: "生", path: "/v1/images/edits", timeout: 60 },
  { key: "video", slot: "video", label: "视频模型", icon: "视", path: "/v1/videos/generations", timeout: 120 }
];

const GROUP_DEFS = [
  { key: "standard", label: "开始新创作", note: "四项模型独立配置" },
  { key: "tencent", label: "开始新创作-腾讯版", note: "四项模型独立配置" },
  { key: "shared", label: "共享视频模型", note: "照片转实况共用" }
];

const IMAGE_MODES = [
  { value: "edits", label: "图片编辑模式" }
];

const IMAGE_SIZES = [
  { value: "1080x1440", label: "照片：1080×1440" },
  { value: "1024x1024", label: "正方形：1024×1024" },
  { value: "1440x1080", label: "横图：1440×1080" }
];

const SAMPLE_SUPPLIERS = [
  { providerKey: "dashscope", name: "阿里云百炼", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "", capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration", "video"], models: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2"], confirmedModels: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2"] },
  { providerKey: "xingju", name: "星矩", endpoint: "https://newapi.akiyo.fun/v1", apiKey: "", capabilities: ["face", "imageAnalysis", "imageGeneration", "video"], models: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2", "kling-video-v2"], confirmedModels: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2", "kling-video-v2"] },
  { providerKey: "lingyun", name: "凌云", endpoint: "https://api.lingyun.example/v1", apiKey: "", capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration", "video"], models: ["vision-pro", "vision-flash", "image-pro", "kling-video-v2"], confirmedModels: ["vision-pro", "vision-flash", "image-pro", "kling-video-v2"] },
  { providerKey: "zhipu", name: "智谱", endpoint: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration"], models: ["glm-4v", "glm-4.5v", "cogview-4"], confirmedModels: ["glm-4v", "glm-4.5v", "cogview-4"] },
  { providerKey: "volcengine", name: "火山方舟", endpoint: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", capabilities: ["imageGeneration", "video"], models: ["doubao-image", "doubao-video"], confirmedModels: ["doubao-image", "doubao-video"] },
  { providerKey: "tencent", name: "腾讯云", endpoint: "ft.tencentcloudapi.com", authProtocol: "tencent-tc3", capabilities: ["face"], models: ["FuseFace"], confirmedModels: [] }
];

const SAMPLE_BINDINGS = [
  { slot: "standard.face", role: "primary", providerKey: "xingju", providerName: "星矩", modelId: "qwen3-vl-flash", status: "ready" },
  { slot: "standard.face", role: "backup", providerKey: "lingyun", providerName: "凌云", modelId: "vision-pro", status: "ready" },
  { slot: "standard.imageAnalysis", role: "primary", providerKey: "dashscope", providerName: "阿里云百炼", modelId: "qwen3-vl-flash", status: "ready" },
  { slot: "standard.imageAnalysis", role: "backup", providerKey: "xingju", providerName: "星矩", modelId: "qwen-vl-max", status: "ready" },
  { slot: "standard.styleAnalysis", role: "primary", providerKey: "lingyun", providerName: "凌云", modelId: "vision-pro", status: "ready" },
  { slot: "standard.imageGeneration", role: "primary", providerKey: "dashscope", providerName: "阿里云百炼", modelId: "jw-gpt-image-2", status: "ready" },
  { slot: "standard.imageGeneration", role: "backup", providerKey: "xingju", providerName: "星矩", modelId: "jw-gpt-image-2", status: "ready" },
  { slot: "tencent.face", role: "primary", providerKey: "", providerName: "", modelId: "", status: "not-ready" },
  { slot: "tencent.imageAnalysis", role: "primary", providerKey: "xingju", providerName: "星矩", modelId: "qwen-vl-max", status: "ready" },
  { slot: "tencent.styleAnalysis", role: "primary", providerKey: "zhipu", providerName: "智谱", modelId: "glm-4v", status: "ready" },
  { slot: "tencent.imageGeneration", role: "primary", providerKey: "xingju", providerName: "星矩", modelId: "jw-gpt-image-2", status: "ready" },
  { slot: "shared.video", role: "primary", providerKey: "lingyun", providerName: "凌云", modelId: "kling-video-v2", status: "ready" },
  { slot: "shared.video", role: "backup", providerKey: "volcengine", providerName: "火山方舟", modelId: "doubao-video", status: "ready" }
];

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
    configScrollStyle: `height:calc(100vh - ${navigationHeight}px)`
  };
}

const INITIAL_NAVIGATION_LAYOUT = navigationLayout();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function statusLabel(binding) {
  if (!binding || binding.status === "not-ready" || binding.status === "needsReview") return "待配置";
  return binding.providerName || binding.providerKey ? "正常" : "待配置";
}

function bindingFor(bindings, slot, role) {
  const list = Array.isArray(bindings) ? bindings : [];
  const direct = list.find(item => item && item.slot === slot && (item.role || "primary") === role);
  if (direct) return direct;
  const grouped = list.find(item => item && item.slot === slot && item[role]);
  return grouped && grouped[role] ? grouped[role] : {};
}

function supplierName(suppliers, key) {
  const found = (suppliers || []).find(item => item && (item.providerKey === key || item.id === key));
  return found ? found.name || found.label || key : key || "";
}

function normaliseSuppliers(source, supplierModels) {
  const fromCloud = Array.isArray(source);
  const list = fromCloud ? source : [];
  const records = Array.isArray(supplierModels) ? supplierModels : [];
  return list.map(item => {
    const provider = Object.assign({}, item);
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    const providerRecords = records.filter(model => (
      model
      && String(model.providerKey || "") === String(item.providerKey || item.id || item.key || "")
      && model.confirmed === true
    ));
    provider.providerKey = String(item.providerKey || item.id || item.key || "");
    provider.name = String(item.name || item.label || provider.providerKey);
    provider.endpoint = String(item.endpoint || item.baseUrl || "");
    provider.confirmedModels = fromCloud
      ? Array.from(new Set(providerRecords.map(model => String(model.modelId || model.id || "")).filter(Boolean)))
      : (Array.isArray(item.confirmedModels) ? item.confirmedModels.slice() : []);
    provider.models = provider.confirmedModels.slice();
    provider.modelCapabilities = fromCloud
      ? providerRecords.reduce((map, model) => {
        const modelId = String(model.modelId || model.id || "");
        if (modelId) map[modelId] = Array.isArray(model.capabilities) ? model.capabilities.slice() : [];
        return map;
      }, {})
      : {};
    provider.capabilities = Array.from(new Set([].concat(
      Array.isArray(item.capabilities) ? item.capabilities : [],
      Array.isArray(metadata.capabilities) ? metadata.capabilities : [],
      providerRecords.reduce((all, model) => all.concat(Array.isArray(model.capabilities) ? model.capabilities : []), [])
    ).filter(Boolean)));
    return provider;
  });
}

function candidateModels(suppliers, providerKey, featureKey) {
  const provider = (suppliers || []).find(item => item.providerKey === providerKey);
  if (!provider) return [];
  const models = Array.isArray(provider.confirmedModels) ? provider.confirmedModels : [];
  return Array.from(new Set(models.filter(model => {
    const modelCapabilities = provider.modelCapabilities && provider.modelCapabilities[model];
    const capabilities = Array.isArray(modelCapabilities) && modelCapabilities.length
      ? modelCapabilities
      : (provider.capabilities || []);
    return capabilities.indexOf(featureKey) >= 0 || featureKey === "video" && capabilities.indexOf("video") >= 0;
  })));
}

function makeTab(groupKey, def, bindings, suppliers) {
  const slot = `${groupKey}.${def.slot}`;
  const primary = bindingFor(bindings, slot, "primary");
  const backup = bindingFor(bindings, slot, "backup");
  const providerKey = primary.providerKey || "";
  const backupProviderKey = backup.providerKey || "";
  const primarySupplier = suppliers.find(item => item.providerKey === providerKey) || {};
  const backupSupplier = suppliers.find(item => item.providerKey === backupProviderKey) || {};
  const metadata = primary.metadata && typeof primary.metadata === "object" ? primary.metadata : {};
  const advanced = metadata.advanced && typeof metadata.advanced === "object" ? metadata.advanced : {};
  const mode = advanced.mode || "edits";
  const size = advanced.size || "1080x1440";
  const providerOptions = suppliers.filter(provider => {
    return candidateModels([provider], provider.providerKey, def.key).length > 0;
  }).map(provider => ({ providerKey: provider.providerKey, name: provider.name }));
  const modelOptions = candidateModels(suppliers, providerKey, def.key);
  const backupModelOptions = candidateModels(suppliers, backupProviderKey, def.key);
  const ready = primary.status === "ready" && Boolean(primary.providerKey && primary.modelId);
  return {
    key: def.key,
    slot,
    label: def.label,
    icon: def.icon,
    path: metadata.path || primary.path || def.path,
    providerKey,
    provider: primary.providerName || supplierName(suppliers, providerKey),
    model: primary.modelId || "",
    endpoint: primary.endpoint || primarySupplier.endpoint || "尚未配置",
    keyText: providerKey ? "已保存 · 明文仅管理员可见" : "尚未配置",
    keyLoadState: providerKey ? "loading" : "success",
    status: statusLabel(primary),
    ready,
    pendingText: primary.pending || (groupKey === "tencent" && def.key === "face" ? "换脸供应商待配置" : "供应商和模型待配置"),
    providerOptions,
    providerIndex: Math.max(0, providerOptions.findIndex(item => item.providerKey === providerKey)),
    modelOptions,
    modelIndex: Math.max(0, modelOptions.indexOf(primary.modelId || "")),
    backupEnabled: backup.status === "ready",
    backupProviderKey,
    backupProvider: backup.providerName || supplierName(suppliers, backupProviderKey),
    backupModel: backup.modelId || "",
    backupTitle: `备用${def.label}${def.label.endsWith("模型") ? "" : "模型"}`,
    backupEndpoint: backup.endpoint || backupSupplier.endpoint || "尚未配置",
    backupKeyText: backupProviderKey ? "已保存 · 明文仅管理员可见" : "尚未配置",
    backupKeyLoadState: backupProviderKey ? "loading" : "success",
    backupProviderOptions: providerOptions.filter(item => item.providerKey !== providerKey),
    backupProviderIndex: Math.max(0, providerOptions.filter(item => item.providerKey !== providerKey).findIndex(item => item.providerKey === backupProviderKey)),
    backupModelOptions,
    backupModelIndex: Math.max(0, backupModelOptions.indexOf(backup.modelId || "")),
    backupStatus: backupEnabledText(backup),
    timeout: Number(metadata.timeout === undefined ? (primary.timeout === undefined ? def.timeout : primary.timeout) : metadata.timeout),
    retry: Number(metadata.retry === undefined ? (primary.retry === undefined ? 1 : primary.retry) : metadata.retry),
    resolution: metadata.resolution || primary.resolution || (def.key === "video" ? "720p" : "1K"),
    aspectRatio: metadata.aspectRatio || primary.aspectRatio || "3:4",
    mode,
    modeIndex: Math.max(0, IMAGE_MODES.findIndex(item => item.value === mode)),
    modeLabel: (IMAGE_MODES.find(item => item.value === mode) || IMAGE_MODES[0]).label,
    size,
    sizeIndex: Math.max(0, IMAGE_SIZES.findIndex(item => item.value === size)),
    sizeLabel: (IMAGE_SIZES.find(item => item.value === size) || IMAGE_SIZES[0]).label,
    keepExistingKey: metadata.keepExistingKey !== false,
    validateBeforeSave: metadata.validateBeforeSave !== false
  };
}

function backupEnabledText(backup) {
  return backup && backup.status === "ready" ? "已启用" : "未启用";
}

function pendingSummary(tabs) {
  const pendingTabs = (tabs || []).filter(tab => !tab.ready);
  return {
    pendingCount: pendingTabs.length,
    pendingText: pendingTabs.length === 1
      ? pendingTabs[0].pendingText
      : (pendingTabs.length > 1 ? `${pendingTabs.length} 项待配置` : "")
  };
}

function buildGroups(bindings, suppliers) {
  return GROUP_DEFS.map(group => {
    const defs = group.key === "shared" ? [TAB_DEFS[4]] : TAB_DEFS.slice(0, 4);
    const tabs = defs.map(def => makeTab(group.key, def, bindings, suppliers));
    return Object.assign({
      key: group.key,
      label: group.label,
      note: group.note,
      tabs
    }, pendingSummary(tabs));
  });
}

function summaryForGroup(group) {
  const tabs = group && Array.isArray(group.tabs) ? group.tabs : [];
  return {
    configuredCount: tabs.filter(tab => tab.ready).length,
    totalCount: tabs.length,
    backupCount: tabs.filter(tab => tab.backupEnabled).length
  };
}

function defaultExpansionFor(groupKey, tab) {
  return {
    mainExpanded: groupKey === "shared",
    backupExpanded: false,
    advancedExpanded: false
  };
}

function secretPayload(result) {
  const payload = result && result.data && typeof result.data === "object" ? result.data : result;
  if (!payload || typeof payload !== "object") return {};
  return Object.assign({}, payload.credentials || payload.secrets || {}, payload);
}

function hasVisibleSecret(secret) {
  return Boolean(secret && (secret.apiKey || secret.secretId || secret.secretKey));
}

function secretReadText(result, providerKey) {
  if (!providerKey) return "尚未配置";
  if (!result || result.status === "failure") return "读取失败 · 保留已保存状态";
  return hasVisibleSecret(result.value) ? "已保存 · 明文仅管理员可见" : "尚未配置";
}

Page({
  data: {
    loading: true,
    demoMode: false,
    fixtureId: previewFixtures.REFERENCE_FIXTURE_ID,
    showDemoControl: false,
    source: "local",
    currentVersion: 1,
    groups: [],
    suppliers: [],
    selectedGroupIndex: 0,
    selectedTabIndex: 0,
    selectedTab: null,
    mainExpanded: false,
    backupExpanded: false,
    advancedExpanded: false,
    imageResolutions: ["1K", "2K", "4K"],
    imageModes: IMAGE_MODES,
    imageSizes: IMAGE_SIZES,
    videoResolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["3:4", "9:16", "16:9"],
    configuredCount: 0,
    totalCount: 8,
    backupCount: 0,
    saving: false,
    message: "",
    appbarStyle: INITIAL_NAVIGATION_LAYOUT.appbarStyle,
    configScrollStyle: INITIAL_NAVIGATION_LAYOUT.configScrollStyle
  },

  onLoad(options) {
    this.demoMode = previewFixtures.isEnabled(options);
    this.fixtureId = previewFixtures.resolveFixtureId(options);
    this.showDemoControl = previewFixtures.isControlVisible(options);
    this.setData({ demoMode: this.demoMode, fixtureId: this.fixtureId, showDemoControl: this.showDemoControl });
    this.applyNavigationLayout();
    this.initialGroup = options && options.group ? options.group : "standard";
    this.initialTab = options && options.tab ? options.tab : "face";
    this.loadConfig();
  },

  onResize() {
    this.applyNavigationLayout();
  },

  toggleDemoMode(event) {
    if (this.data.loading || this.data.saving) return;
    const rawValue = event && event.detail ? event.detail.value : undefined;
    const next = typeof rawValue === "boolean"
      ? rawValue
      : (rawValue === "1" || rawValue === 1 ? true : (rawValue === "0" || rawValue === 0 ? false : !this.demoMode));
    previewFixtures.setEnabled(next);
    this.demoMode = next;
    this._secretLoadSerial = Number(this._secretLoadSerial || 0) + 1;
    this.setData({ demoMode: next });
    if (next) {
      this.loadConfig();
      return;
    }
    this._configLoadSerial = Number(this._configLoadSerial || 0) + 1;
    this.setData({
      loading: false,
      source: "local",
      currentVersion: 1,
      groups: [],
      suppliers: [],
      selectedGroupIndex: 0,
      selectedTabIndex: 0,
      selectedTab: null,
      mainExpanded: false,
      backupExpanded: false,
      advancedExpanded: false,
      configuredCount: 0,
      totalCount: 0,
      backupCount: 0,
      message: "演示已关闭，下拉刷新读取真实数据。"
    });
    if (wx.showToast) wx.showToast({ title: "下拉刷新读取真实数据", icon: "none" });
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

  onPullDownRefresh() {
    this.loadConfig(true);
  },

  async loadConfig(refreshing = false) {
    const loadSerial = Number(this._configLoadSerial || 0) + 1;
    this._configLoadSerial = loadSerial;
    this.setData({ loading: !refreshing, message: "" });
    let result = null;
    if (!this.demoMode && cloud && typeof cloud.getAdminConfigV2 === "function") {
      try {
        result = await cloud.getAdminConfigV2({ retryLimit: 0, silent: true });
      } catch (error) {
        result = null;
      }
    }
    if (loadSerial !== this._configLoadSerial) return;
    const payload = this.demoMode
      ? previewFixtures.adminConfig()
      : (result && result.ok !== false && result.data ? result.data : (result && result.ok !== false ? result : null));
    const suppliers = normaliseSuppliers(payload && payload.suppliers, payload && payload.supplierModels);
    const bindings = payload && Array.isArray(payload.bindings) ? payload.bindings : [];
    const groups = buildGroups(bindings, suppliers);
    let groupIndex = groups.findIndex(group => group.key === this.initialGroup);
    if (groupIndex < 0) groupIndex = 0;
    let tabIndex = groups[groupIndex].tabs.findIndex(tab => tab.key === this.initialTab);
    if (tabIndex < 0) tabIndex = 0;
    const summary = summaryForGroup(groups[groupIndex]);
    const expansion = defaultExpansionFor(groups[groupIndex].key, groups[groupIndex].tabs[tabIndex]);
    this.setData(Object.assign({
      loading: false,
      source: this.demoMode ? "demo" : (payload ? "cloud" : "local"),
      currentVersion: Number(payload && (payload.version || payload.providerConfigV2 && payload.providerConfigV2.version)) || 1,
      suppliers,
      groups,
      selectedGroupIndex: groupIndex,
      selectedTabIndex: tabIndex,
      configuredCount: summary.configuredCount,
      totalCount: summary.totalCount,
      backupCount: summary.backupCount,
      selectedTab: groups[groupIndex].tabs[tabIndex]
    }, expansion));
    this.loadVisibleSecrets();
    if (refreshing && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  },

  selectTab(event) {
    const groupIndex = Number(event.currentTarget.dataset.groupIndex);
    const tabIndex = Number(event.currentTarget.dataset.tabIndex);
    const group = this.data.groups[groupIndex];
    if (!group || !group.tabs[tabIndex]) return;
    const summary = summaryForGroup(group);
    const expansion = defaultExpansionFor(group.key, group.tabs[tabIndex]);
    this.setData(Object.assign({ selectedGroupIndex: groupIndex, selectedTabIndex: tabIndex, selectedTab: group.tabs[tabIndex], configuredCount: summary.configuredCount, totalCount: summary.totalCount, backupCount: summary.backupCount, message: "" }, expansion));
    this.loadVisibleSecrets();
  },

  toggleMain() {
    this.setData({ mainExpanded: !this.data.mainExpanded });
  },

  toggleBackup() {
    this.setData({ backupExpanded: !this.data.backupExpanded });
  },

  toggleAdvanced() {
    this.setData({ advancedExpanded: !this.data.advancedExpanded });
  },

  currentTab() {
    const group = this.data.groups[this.data.selectedGroupIndex];
    return group && group.tabs[this.data.selectedTabIndex];
  },

  async readProviderSecret(providerKey) {
    if (!providerKey) return { status: "success", value: null };
    if (this.demoMode) return { status: "success", value: null };
    if (!cloud) return { status: "failure", error: "SECRET_READ_UNAVAILABLE" };
    const getter = typeof cloud.getAdminProviderSecretsV2 === "function"
      ? cloud.getAdminProviderSecretsV2
      : cloud.getAdminProviderSecrets;
    if (typeof getter !== "function") return { status: "failure", error: "SECRET_READ_UNAVAILABLE" };
    try {
      const result = await getter.call(cloud, providerKey, { retryLimit: 0 });
      if (!result || result.ok === false) throw new Error("SECRET_READ_FAILED");
      const value = secretPayload(result);
      return { status: "success", value: hasVisibleSecret(value) ? value : null };
    } catch (error) {
      return { status: "failure", error: error && error.message ? error.message : "SECRET_READ_FAILED" };
    }
  },

  async loadVisibleSecrets() {
    const loadSerial = Number(this._secretLoadSerial || 0) + 1;
    this._secretLoadSerial = loadSerial;
    const tab = this.currentTab();
    if (!tab) return;
    const slot = tab.slot;
    const providerKey = tab.providerKey;
    const backupProviderKey = tab.backupProviderKey;
    if (this.demoMode) {
      this.updateCurrentTab({
        keyText: providerKey ? "已保存 · 明文仅管理员可见" : "尚未配置",
        keyLoadState: "success",
        backupKeyText: backupProviderKey ? "已保存 · 明文仅管理员可见" : "尚未配置",
        backupKeyLoadState: "success"
      });
      return;
    }
    const values = await Promise.all([
      this.readProviderSecret(providerKey),
      this.readProviderSecret(backupProviderKey)
    ]);
    if (loadSerial !== this._secretLoadSerial) return;
    const current = this.currentTab();
    if (!current || current.slot !== slot || current.providerKey !== providerKey || current.backupProviderKey !== backupProviderKey) return;
    this.updateCurrentTab({
      keyText: secretReadText(values[0], providerKey),
      keyLoadState: values[0] && values[0].status || "failure",
      backupKeyText: secretReadText(values[1], backupProviderKey),
      backupKeyLoadState: values[1] && values[1].status || "failure"
    });
  },

  updateCurrentTab(patch) {
    const groups = clone(this.data.groups);
    const tab = groups[this.data.selectedGroupIndex] && groups[this.data.selectedGroupIndex].tabs[this.data.selectedTabIndex];
    if (!tab) return null;
    Object.assign(tab, patch || {});
    const group = groups[this.data.selectedGroupIndex];
    Object.assign(group, pendingSummary(group.tabs));
    const summary = summaryForGroup(group);
    this.setData({ groups, selectedTab: tab, configuredCount: summary.configuredCount, totalCount: summary.totalCount, backupCount: summary.backupCount });
    return tab;
  },

  onMainProviderChange(event) {
    const tab = this.currentTab();
    if (!tab) return;
    const index = Number(event.detail.value) || 0;
    const provider = tab.providerOptions[index];
    if (!provider) return;
    const models = candidateModels(this.data.suppliers, provider.providerKey, tab.key);
    const backupProviderOptions = tab.providerOptions.filter(item => item.providerKey !== provider.providerKey);
    const backupStillValid = backupProviderOptions.some(item => item.providerKey === tab.backupProviderKey);
    const patch = { providerKey: provider.providerKey, provider: provider.name, providerIndex: index, modelOptions: models, modelIndex: 0, model: models[0] || "", endpoint: ((this.data.suppliers.find(item => item.providerKey === provider.providerKey) || {}).endpoint || "尚未配置"), keyText: "正在读取...", keyLoadState: "loading", ready: Boolean(models.length), status: models.length ? "正常" : "待配置", backupProviderOptions };
    if (tab.backupProviderKey && !backupStillValid) {
      Object.assign(patch, { backupEnabled: false, backupStatus: "未启用", backupProviderKey: "", backupProvider: "", backupModel: "", backupEndpoint: "尚未配置", backupKeyText: "尚未配置", backupKeyLoadState: "success", backupProviderIndex: 0, backupModelIndex: 0, backupModelOptions: [] });
    } else {
      patch.backupProviderIndex = Math.max(0, backupProviderOptions.findIndex(item => item.providerKey === tab.backupProviderKey));
    }
    this.updateCurrentTab(patch);
    this.loadVisibleSecrets();
  },

  onMainModelChange(event) {
    const tab = this.currentTab();
    if (!tab) return;
    const index = Number(event.detail.value) || 0;
    const model = tab.modelOptions[index] || "";
    this.updateCurrentTab({ modelIndex: index, model, ready: Boolean(tab.providerKey && model), status: tab.providerKey && model ? "正常" : "待配置" });
  },

  onBackupEnabledChange(event) {
    const current = this.currentTab();
    if (!current) return;
    const hasExplicitValue = event && event.detail && (event.detail.value !== undefined || event.detail.checked !== undefined);
    const checked = hasExplicitValue
      ? Boolean(event.detail.value !== undefined ? event.detail.value : event.detail.checked)
      : !current.backupEnabled;
    const tab = this.updateCurrentTab({ backupEnabled: checked, backupStatus: checked ? "已启用" : "未启用" });
    if (tab && !checked) this.setData({ message: "备用模型已停用，已保留已选供应商和模型" });
  },

  onBackupProviderChange(event) {
    const tab = this.currentTab();
    if (!tab) return;
    const options = tab.backupProviderOptions || [];
    const index = Number(event.detail.value) || 0;
    const provider = options[index];
    if (!provider) return;
    const models = candidateModels(this.data.suppliers, provider.providerKey, tab.key);
    this.updateCurrentTab({ backupProviderKey: provider.providerKey, backupProvider: provider.name, backupProviderIndex: index, backupModelOptions: models, backupModelIndex: 0, backupModel: models[0] || "", backupEndpoint: ((this.data.suppliers.find(item => item.providerKey === provider.providerKey) || {}).endpoint || "尚未配置"), backupKeyText: "正在读取...", backupKeyLoadState: "loading", backupEnabled: true, backupStatus: "已启用" });
    this.loadVisibleSecrets();
  },

  onBackupModelChange(event) {
    const tab = this.currentTab();
    if (!tab) return;
    const index = Number(event.detail.value) || 0;
    this.updateCurrentTab({ backupModelIndex: index, backupModel: tab.backupModelOptions[index] || "" });
  },

  onAdvancedInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail && event.detail.value !== undefined ? event.detail.value : "";
    const patch = {};
    patch[field] = value;
    this.updateCurrentTab(patch);
  },

  onResolutionChange(event) {
    const tab = this.currentTab();
    const options = tab && tab.key === "video" ? ["480p", "720p", "1080p"] : ["1K", "2K", "4K"];
    const index = Number(event.detail.value) || 0;
    this.updateCurrentTab({ resolution: options[index] || options[0] });
  },

  onAspectRatioChange(event) {
    const options = ["3:4", "9:16", "16:9"];
    this.updateCurrentTab({ aspectRatio: options[Number(event.detail.value) || 0] || "3:4" });
  },

  onImageModeChange(event) {
    const index = Number(event.detail.value) || 0;
    const option = IMAGE_MODES[index] || IMAGE_MODES[0];
    this.updateCurrentTab({ mode: option.value, modeIndex: index, modeLabel: option.label });
  },

  onImageSizeChange(event) {
    const index = Number(event.detail.value) || 0;
    const option = IMAGE_SIZES[index] || IMAGE_SIZES[0];
    this.updateCurrentTab({ size: option.value, sizeIndex: index, sizeLabel: option.label });
  },

  onAdvancedOptionsChange(event) {
    const values = event && event.detail && Array.isArray(event.detail.value) ? event.detail.value : [];
    this.updateCurrentTab({
      keepExistingKey: values.indexOf("keepExistingKey") >= 0,
      validateBeforeSave: values.indexOf("validateBeforeSave") >= 0
    });
  },

  async saveCurrent() {
    if (this.demoMode) {
      this.setData({ message: "演示数据只用于视觉预览，不会保存到线上。" });
      return;
    }
    if (this.data.saving) return;
    const tab = this.currentTab();
    if (!tab) return;
    this.setData({ saving: true, message: "正在保存当前功能配置..." });
    let saved = false;
    try {
      if (!cloud || typeof cloud.saveAdminSlotV2 !== "function") {
        throw new Error("SLOT_SAVE_UNAVAILABLE");
      }
      const backupReady = Boolean(tab.backupEnabled && tab.backupProviderKey && tab.backupModel);
      const result = await cloud.saveAdminSlotV2({
        slot: tab.slot,
        expectedVersion: this.data.currentVersion,
        primaryPatch: {
          providerKey: tab.providerKey,
          modelId: tab.model,
          status: tab.ready ? "ready" : "not-ready",
          confirmed: true,
          metadata: {
            path: tab.path,
            timeout: Number(tab.timeout) || 30,
            retry: Number(tab.retry) || 0,
            resolution: tab.resolution,
            aspectRatio: tab.aspectRatio,
            keepExistingKey: tab.keepExistingKey !== false,
            validateBeforeSave: tab.validateBeforeSave !== false
          }
        },
        backupPatch: {
          providerKey: tab.backupProviderKey,
          modelId: tab.backupModel,
          status: backupReady ? "ready" : "not-ready",
          confirmed: true
        },
        advancedPatch: tab.key === "imageGeneration"
          ? { mode: tab.mode || "edits", size: tab.size || "1080x1440" }
          : {}
      });
      if (!result || result.ok === false) throw new Error("SLOT_SAVE_FAILED");
      const payload = result.data && typeof result.data === "object" ? result.data : result;
      const finalVersion = Number(payload.version || payload.providerConfigV2 && payload.providerConfigV2.version) || this.data.currentVersion + 1;
      saved = true;
      this.setData({ currentVersion: finalVersion, message: "已保存到云端" });
    } catch (error) {
      this.setData({ message: "保存失败，主备配置均未更改" });
    } finally {
      this.setData({ saving: false });
    }
    if (wx.showToast) wx.showToast({ title: saved ? "保存成功" : "保存失败", icon: "none" });
  },

  openProvider() {
    wx.navigateTo({ url: `/pages/admin-provider/admin-provider${this.previewQuery()}` });
  },

  backToDashboard() {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const previous = pages.length > 1 ? pages[pages.length - 2] : null;
    const previousRoute = previous ? String(previous.route || previous.__route__ || "") : "";
    if (previousRoute.includes("pages/admin-dashboard/admin-dashboard") && wx.navigateBack) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    const url = `/pages/admin-dashboard/admin-dashboard${this.previewQuery()}`;
    if (wx.redirectTo) {
      wx.redirectTo({
        url,
        fail: () => {
          if (wx.reLaunch) wx.reLaunch({ url });
        }
      });
      return;
    }
    if (wx.reLaunch) {
      wx.reLaunch({ url });
      return;
    }
    if (wx.navigateTo) wx.navigateTo({ url });
  },

  goBack() {
    if (wx.navigateBack) wx.navigateBack({ delta: 1 });
  }
});
