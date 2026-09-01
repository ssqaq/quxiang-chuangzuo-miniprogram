const cloud = require("../../services/cloud");
const previewFixtures = require("../../services/admin-preview-fixtures");

const CAPABILITIES = [
  { key: "face", label: "人脸识别" },
  { key: "imageAnalysis", label: "图片分析" },
  { key: "styleAnalysis", label: "网感分析" },
  { key: "imageGeneration", label: "生图模型" },
  { key: "video", label: "视频模型" }
];

const CAPABILITY_LABELS = CAPABILITIES.reduce((map, item) => {
  map[item.key] = item.label;
  return map;
}, {});

const SECRET_FIELDS = [
  { key: "apiKey", path: "apiKey", clear: "clearApiKey" },
  { key: "secretId", path: "tc3.secretId", clear: "clearSecretId" },
  { key: "secretKey", path: "tc3.secretKey", clear: "clearSecretKey" }
];

const SECRET_FIELD_BY_PATH = SECRET_FIELDS.reduce((map, item) => {
  map[item.path] = item;
  return map;
}, {});

const SAMPLE_PROVIDERS = [
  { providerKey: "dashscope", name: "阿里云百炼", authProtocol: "openai", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "", capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration", "video"], models: ["qwen3-vl-flash", "qwen-vl-max", "wan2.1-t2v-turbo"], selectedModel: "qwen3-vl-flash", confirmedModels: ["qwen3-vl-flash", "qwen-vl-max", "wan2.1-t2v-turbo"], enabled: true },
  { providerKey: "xingju", name: "星矩", authProtocol: "openai", endpoint: "https://newapi.akiyo.fun/v1", apiKey: "", capabilities: ["imageGeneration", "video"], models: ["jw-gpt-image-2", "kling-video-v2"], selectedModel: "jw-gpt-image-2", confirmedModels: ["jw-gpt-image-2", "kling-video-v2"], enabled: true },
  { providerKey: "lingyun", name: "凌云", authProtocol: "openai", endpoint: "https://api.lingyun.example/v1", apiKey: "", capabilities: ["imageAnalysis", "styleAnalysis"], models: ["vision-pro", "vision-flash"], selectedModel: "vision-pro", confirmedModels: ["vision-pro", "vision-flash"], enabled: true },
  { providerKey: "laoli", name: "老李", authProtocol: "openai", endpoint: "https://api.laoli.example/v1", apiKey: "", capabilities: [], models: [], selectedModel: "", confirmedModels: [], enabled: false },
  { providerKey: "panda", name: "熊猫", authProtocol: "openai", endpoint: "https://api.panda.example/v1", apiKey: "", capabilities: [], models: [], selectedModel: "", confirmedModels: [], enabled: false },
  { providerKey: "qwen", name: "通义千问", authProtocol: "openai", endpoint: "https://dashscope.aliyuncs.com/v1", apiKey: "", capabilities: ["imageAnalysis", "styleAnalysis"], models: ["qwen-vl-max", "qwen-vl-plus"], selectedModel: "qwen-vl-max", confirmedModels: ["qwen-vl-max", "qwen-vl-plus"], enabled: true },
  { providerKey: "zhipu", name: "智谱", authProtocol: "openai", endpoint: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", capabilities: ["face", "styleAnalysis"], models: ["glm-4v", "glm-4.5v"], selectedModel: "glm-4v", confirmedModels: ["glm-4v", "glm-4.5v"], enabled: true },
  { providerKey: "volcengine", name: "火山方舟", authProtocol: "openai", endpoint: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "", capabilities: ["imageGeneration", "video"], models: ["doubao-image", "doubao-video"], selectedModel: "doubao-image", confirmedModels: ["doubao-image", "doubao-video"], enabled: true },
  { providerKey: "tencent", name: "腾讯云", authProtocol: "tencent-tc3", endpoint: "", apiKey: "", capabilities: ["face"], models: ["FuseFace"], selectedModel: "FuseFace", confirmedModels: [], enabled: true, tc3: { secretId: "", secretKey: "", region: "ap-guangzhou", endpoint: "ft.tencentcloudapi.com", apiVersion: "2020-03-04", action: "FuseFace" } },
  { providerKey: "local", name: "本地模型", authProtocol: "openai", endpoint: "http://127.0.0.1:11434/v1", apiKey: "", capabilities: [], models: [], selectedModel: "", confirmedModels: [], enabled: false }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blankProvider() {
  return {
    providerKey: "",
    name: "",
    authProtocol: "openai",
    endpoint: "https://",
    apiKey: "",
    capabilities: [],
    models: [],
    confirmedModels: [],
    selectedModel: "",
    enabled: true,
    configured: false,
    tc3: { secretId: "", secretKey: "", region: "ap-guangzhou", endpoint: "ft.tencentcloudapi.com", apiVersion: "2020-03-04", action: "FuseFace" }
  };
}

function normaliseProvider(source) {
  const input = source && typeof source === "object" ? source : {};
  const metadata = input.metadata && typeof input.metadata === "object" ? input.metadata : {};
  const auth = input.auth && typeof input.auth === "object" ? input.auth : {};
  const authExtra = auth.extra && typeof auth.extra === "object" ? auth.extra : {};
  const capabilities = Array.isArray(input.capabilities)
    ? input.capabilities.slice()
    : Array.isArray(metadata.capabilities)
      ? metadata.capabilities.slice()
    : Object.keys(input.capabilities || {}).filter(key => input.capabilities[key] && input.capabilities[key].enabled);
  const inputTc3 = input.tc3 && typeof input.tc3 === "object" ? input.tc3 : {};
  const configured = typeof auth.configured === "boolean"
    ? auth.configured
    : typeof input.credentialConfigured === "boolean"
      ? input.credentialConfigured
      : typeof input.configured === "boolean"
        ? input.configured
        : Boolean(input.apiKey || inputTc3.secretId && inputTc3.secretKey);
  const tc3 = Object.assign({}, authExtra, inputTc3, {
    apiVersion: inputTc3.apiVersion || authExtra.version || ""
  });
  const confirmedModels = Array.isArray(input.confirmedModels)
    ? input.confirmedModels.slice()
    : Array.isArray(input.models)
      ? input.models.slice()
      : [];
  const hasExplicitSelectedModel = Object.prototype.hasOwnProperty.call(input, "selectedModel");
  const selectedModel = hasExplicitSelectedModel
    ? String(input.selectedModel || "")
    : String(input.modelId || confirmedModels[0] || "");
  return Object.assign(blankProvider(), input, {
    providerKey: String(input.providerKey || input.id || input.key || ""),
    name: String(input.name || input.label || "未命名供应商"),
    authProtocol: input.authProtocol || input.protocol || auth.protocol || (input.auth === "tc3" ? "tencent-tc3" : "openai"),
    endpoint: String(input.endpoint || input.baseUrl || ""),
    apiKey: String(input.apiKey || ""),
    capabilities,
    models: Array.isArray(input.models) ? input.models.slice() : confirmedModels.slice(),
    confirmedModels,
    selectedModel,
    configured,
    tc3: Object.assign(blankProvider().tc3, tc3),
    capabilityText: capabilities.map(key => CAPABILITY_LABELS[key] || key).join(" · ") || "暂未选择能力",
    capabilityRows: capabilityRows(capabilities)
  });
}

function markCapabilities(capabilities) {
  const active = Array.isArray(capabilities) ? capabilities : [];
  return CAPABILITIES.map(item => Object.assign({}, item, { checked: active.indexOf(item.key) >= 0 }));
}

function capabilityRows(capabilities) {
  const labels = (capabilities || []).map(key => CAPABILITY_LABELS[key] || key);
  if (!labels.length) return ["暂未选择能力"];
  const rows = [];
  for (let index = 0; index < labels.length; index += 2) {
    rows.push(labels.slice(index, index + 2).join(" · "));
  }
  return rows;
}

function secretValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function cleanSecretDirty() {
  return { apiKey: false, secretId: false, secretKey: false };
}

function emptySecretValues() {
  return { apiKey: null, secretId: null, secretKey: null };
}

function secretValuesFromDraft(draft) {
  const source = draft && typeof draft === "object" ? draft : {};
  const tc3 = source.tc3 && typeof source.tc3 === "object" ? source.tc3 : {};
  return {
    apiKey: secretValue(source.apiKey) || null,
    secretId: secretValue(tc3.secretId) || null,
    secretKey: secretValue(tc3.secretKey) || null
  };
}

function applySecretValues(draft, values, dirty) {
  const next = clone(draft || blankProvider());
  const source = values && typeof values === "object" ? values : emptySecretValues();
  const changed = dirty && typeof dirty === "object" ? dirty : cleanSecretDirty();
  if (!next.tc3 || typeof next.tc3 !== "object") next.tc3 = clone(blankProvider().tc3);
  if (!changed.apiKey) next.apiKey = secretValue(source.apiKey);
  if (!changed.secretId) next.tc3.secretId = secretValue(source.secretId);
  if (!changed.secretKey) next.tc3.secretKey = secretValue(source.secretKey);
  return next;
}

function parseSecretReadResult(result) {
  if (!result || result.ok === false || result.unavailable === true) {
    return { state: "failure", values: null };
  }
  const payload = result.data !== undefined ? result.data : result;
  if (payload && payload.ok === false) return { state: "failure", values: null };
  const nested = payload && Object.prototype.hasOwnProperty.call(payload, "credentials")
    ? payload.credentials
    : payload && Object.prototype.hasOwnProperty.call(payload, "secrets")
      ? payload.secrets
      : payload;
  if (nested !== null && nested !== undefined && typeof nested !== "object") {
    return { state: "failure", values: null };
  }
  const source = nested && typeof nested === "object" ? nested : {};
  const values = emptySecretValues();
  SECRET_FIELDS.forEach((item) => {
    const fallback = payload && typeof payload === "object" ? payload[item.key] : undefined;
    const value = source[item.key] !== undefined ? source[item.key] : fallback;
    const text = secretValue(value);
    values[item.key] = text ? text : null;
  });
  return {
    state: SECRET_FIELDS.some(item => values[item.key] !== null) ? "success" : "empty",
    values
  };
}

function secretStatusFor(state, values, dirty, options) {
  const source = values && typeof values === "object" ? values : emptySecretValues();
  const changed = dirty && typeof dirty === "object" ? dirty : cleanSecretDirty();
  const configured = Boolean(options && options.configured);
  const output = {};
  SECRET_FIELDS.forEach((item) => {
    if (changed[item.key]) {
      output[item.key] = { text: "已修改", tone: "dirty" };
    } else if (state === "loading") {
      output[item.key] = { text: "读取中", tone: "loading" };
    } else if (state === "failure") {
      output[item.key] = { text: "读取失败 · 已保留", tone: "failure" };
    } else if (source[item.key] !== null && source[item.key] !== "") {
      output[item.key] = { text: "已读取明文", tone: "ready" };
    } else if (configured) {
      output[item.key] = { text: "已保存 · 明文仅管理员可见", tone: "ready" };
    } else {
      output[item.key] = { text: "未配置", tone: "empty" };
    }
  });
  return output;
}

function secretMutation(draft, dirty) {
  const values = secretValuesFromDraft(draft);
  const changed = dirty && typeof dirty === "object" ? dirty : cleanSecretDirty();
  const credentials = {};
  const clearFlags = {};
  SECRET_FIELDS.forEach((item) => {
    if (!changed[item.key]) return;
    const value = secretValue(values[item.key]).trim();
    if (value) credentials[item.key] = value;
    else {
      credentials[item.clear] = true;
      clearFlags[item.clear] = true;
    }
  });
  return { credentials, clearFlags };
}

function isExampleEndpoint(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^(?:https?:\/\/)?(?:[^/?#]+\.)?example(?::\d+)?(?:[/?#]|$)/i.test(text)
    || /^(?:https?:\/\/)?[^/?#]*\.example(?::\d+)?(?:[/?#]|$)/i.test(text);
}

function providerEndpoint(provider) {
  const source = provider && typeof provider === "object" ? provider : {};
  if (source.authProtocol === "tencent-tc3") {
    return source.tc3 && source.tc3.endpoint || source.endpoint || "";
  }
  return source.endpoint || "";
}

function mergeDirectoryTemplates(providers) {
  const records = (Array.isArray(providers) ? providers : []).map(normaliseProvider);
  const existing = new Set(records.map(item => item.providerKey));
  const existingNames = new Set(records.map(item => item.name));
  SAMPLE_PROVIDERS.forEach(sample => {
    if (existing.has(sample.providerKey) || existingNames.has(sample.name)) return;
    records.push(normaliseProvider(Object.assign({}, sample, {
      apiKey: "",
      confirmedModels: [],
      enabled: false,
      isTemplate: true,
      selectedModel: ""
    })));
    existing.add(sample.providerKey);
    existingNames.add(sample.name);
  });
  return records;
}

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
    providerScrollStyle: `height:calc(100vh - ${navigationHeight}px)`
  };
}

const INITIAL_NAVIGATION_LAYOUT = navigationLayout();

Page({
  data: {
    loading: true,
    demoMode: false,
    fixtureId: previewFixtures.REFERENCE_FIXTURE_ID,
    showDemoControl: false,
    source: "local",
    currentVersion: 1,
    providers: [],
    providerCountText: "0 个档案",
    selectedIndex: 0,
    editing: false,
    draft: blankProvider(),
    authIsTc3: false,
    capabilities: markCapabilities([]),
    fetchedModels: [],
    selectedFetchedModel: "",
    modelPickerOpen: false,
    modelStatus: "尚未选择模型",
    modelStatusTone: "off",
    secretDirty: cleanSecretDirty(),
    secretReadState: "idle",
    secretStatus: secretStatusFor("idle", emptySecretValues(), cleanSecretDirty()),
    busy: false,
    message: "",
    canMoveUp: false,
    canMoveDown: false,
    appbarStyle: INITIAL_NAVIGATION_LAYOUT.appbarStyle,
    providerScrollStyle: INITIAL_NAVIGATION_LAYOUT.providerScrollStyle
  },

  onLoad(options) {
    this.demoMode = previewFixtures.isEnabled(options);
    this.fixtureId = previewFixtures.resolveFixtureId(options);
    this.showDemoControl = previewFixtures.isControlVisible(options);
    this.setData({ demoMode: this.demoMode, fixtureId: this.fixtureId, showDemoControl: this.showDemoControl });
    this.applyNavigationLayout();
    this.loadRegistry();
  },

  onResize() {
    this.applyNavigationLayout();
  },

  toggleDemoMode(event) {
    if (this.data.loading || this.data.busy) return;
    const rawValue = event && event.detail ? event.detail.value : undefined;
    const next = typeof rawValue === "boolean"
      ? rawValue
      : (rawValue === "1" || rawValue === 1 ? true : (rawValue === "0" || rawValue === 0 ? false : !this.demoMode));
    previewFixtures.setEnabled(next);
    this.demoMode = next;
    this._secretReadSerial = Number(this._secretReadSerial || 0) + 1;
    this.setData({ demoMode: next });
    if (next) {
      this.loadRegistry();
      return;
    }
    this._registryLoadSerial = Number(this._registryLoadSerial || 0) + 1;
    this._secretCache = Object.create(null);
    const secretDirty = cleanSecretDirty();
    this.setData({
      loading: false,
      source: "local",
      currentVersion: 1,
      providers: [],
      providerCountText: "0 个档案",
      selectedIndex: 0,
      editing: false,
      draft: blankProvider(),
      authIsTc3: false,
      capabilities: markCapabilities([]),
      fetchedModels: [],
      selectedFetchedModel: "",
      modelPickerOpen: false,
      modelStatus: "尚未选择模型",
      modelStatusTone: "off",
      secretDirty,
      secretReadState: "idle",
      secretStatus: secretStatusFor("idle", emptySecretValues(), secretDirty),
      busy: false,
      message: "演示已关闭，下拉刷新读取真实数据。",
      canMoveUp: false,
      canMoveDown: false
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
    this.loadRegistry(true);
  },

  async loadRegistry(refreshing = false) {
    const loadSerial = Number(this._registryLoadSerial || 0) + 1;
    this._registryLoadSerial = loadSerial;
    this.setData({ loading: !refreshing, message: "" });
    let result = null;
    if (!this.demoMode && cloud && typeof cloud.getAdminConfigV2 === "function") {
      try {
        result = await cloud.getAdminConfigV2({ retryLimit: 0, silent: true });
      } catch (error) {
        result = null;
      }
    }
    if (loadSerial !== this._registryLoadSerial) return;
    const payload = this.demoMode
      ? previewFixtures.adminConfig()
      : (result && result.ok !== false && result.data ? result.data : (result && result.ok !== false ? result : null));
    const savedProviders = payload && Array.isArray(payload.suppliers)
      ? this.mergeModels(payload.suppliers, payload.supplierModels)
      : [];
    const providers = mergeDirectoryTemplates(savedProviders);
    this.setData({
      loading: false,
      source: this.demoMode ? "demo" : (payload ? "cloud" : "local"),
      currentVersion: Number(payload && (payload.version || payload.providerConfigV2 && payload.providerConfigV2.version)) || 1,
      providers,
      providerCountText: `${providers.length} 个档案`
    });
    if (providers.length) this.selectProvider({ index: Math.min(this.data.selectedIndex || 0, providers.length - 1) }, false);
    else this.startAddProvider();
    if (refreshing && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  },

  mergeModels(suppliers, supplierModels) {
    const list = Array.isArray(supplierModels) ? supplierModels : [];
    return suppliers.map(item => {
      const provider = normaliseProvider(item);
      const records = list.filter(model => model && String(model.providerKey) === provider.providerKey);
      const models = records.map(model => String(model.modelId || model.id || "")).filter(Boolean);
      if (models.length) provider.models = Array.from(new Set(provider.models.concat(models)));
      provider.confirmedModels = Array.from(new Set(provider.confirmedModels.concat(records.filter(model => model.confirmed).map(model => String(model.modelId || model.id || "")).filter(Boolean))));
      provider.capabilities = Array.from(new Set(provider.capabilities.concat(records.reduce((all, model) => all.concat(Array.isArray(model.capabilities) ? model.capabilities : []), []))));
      provider.capabilityText = provider.capabilities.map(key => CAPABILITY_LABELS[key] || key).join(" · ") || "暂未选择能力";
      provider.capabilityRows = capabilityRows(provider.capabilities);
      return provider;
    });
  },

  selectProvider(event, closePicker = true) {
    const rawIndex = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.index
      : event && event.index;
    const index = Math.max(0, Math.min(Number(rawIndex) || 0, Math.max(0, this.data.providers.length - 1)));
    const provider = normaliseProvider(this.data.providers[index] || blankProvider());
    this._secretReadSerial = Number(this._secretReadSerial || 0) + 1;
    if (!this._secretCache) this._secretCache = Object.create(null);
    const cached = this._secretCache[provider.providerKey];
    const secretDirty = cleanSecretDirty();
    const initialValues = cached && cached.values
      ? cached.values
      : secretValuesFromDraft(provider);
    const initialState = provider.isTemplate
      ? "empty"
      : cached && cached.state
        ? cached.state
        : "loading";
    const draft = applySecretValues(provider, initialValues, secretDirty);
    const nextProvider = this.data.providers[index + 1];
    const previousProvider = this.data.providers[index - 1];
    if (closePicker) this.closeModelPicker();
    this.setData({
      selectedIndex: index,
      editing: true,
      draft,
      authIsTc3: provider.authProtocol === "tencent-tc3",
      capabilities: markCapabilities(provider.capabilities),
      modelStatus: provider.selectedModel ? `已选 ${provider.selectedModel}` : "尚未选择模型",
      modelStatusTone: provider.selectedModel ? "ready" : "off",
      secretDirty,
      secretReadState: initialState,
      secretStatus: secretStatusFor(initialState, secretValuesFromDraft(draft), secretDirty),
      canMoveUp: !provider.isTemplate && index > 0 && previousProvider && !previousProvider.isTemplate,
      canMoveDown: !provider.isTemplate && index < this.data.providers.length - 1 && nextProvider && !nextProvider.isTemplate,
      activeProviderId: `provider-${index}`
    });
    if (!provider.isTemplate && !this.demoMode) this.loadProviderSecret(provider.providerKey);
    if (!provider.isTemplate && this.demoMode) {
      this.setData({
        secretReadState: "empty",
        secretStatus: secretStatusFor("empty", emptySecretValues(), secretDirty, {
          configured: provider.configured
        })
      });
    }
  },

  async loadProviderSecret(providerKey) {
    if (!providerKey || !cloud) return { state: "failure", values: null };
    const isV2 = typeof cloud.getAdminProviderSecretsV2 === "function";
    const getter = isV2 ? cloud.getAdminProviderSecretsV2 : cloud.getAdminProviderSecrets;
    if (typeof getter !== "function") return { state: "failure", values: null };
    const requestId = Number(this._secretReadSerial || 0) + 1;
    this._secretReadSerial = requestId;
    if (this.data.draft.providerKey === providerKey) {
      this.setData({
        secretReadState: "loading",
        secretStatus: secretStatusFor("loading", secretValuesFromDraft(this.data.draft), this.data.secretDirty)
      });
    }
    let parsed;
    try {
      const result = await getter.call(cloud, providerKey, { retryLimit: 0, silent: true });
      parsed = parseSecretReadResult(result);
    } catch (error) {
      parsed = { state: "failure", values: null };
    }
    if (requestId !== this._secretReadSerial || this.data.draft.providerKey !== providerKey) return parsed;
    if (parsed.state === "failure") {
      const values = secretValuesFromDraft(this.data.draft);
      this.setData({
        secretReadState: "failure",
        secretStatus: secretStatusFor("failure", values, this.data.secretDirty)
      });
      return parsed;
    }
    if (!this._secretCache) this._secretCache = Object.create(null);
    this._secretCache[providerKey] = { state: parsed.state, values: clone(parsed.values) };
    const dirty = this.data.secretDirty || cleanSecretDirty();
    const draft = applySecretValues(this.data.draft, parsed.values, dirty);
    this.setData({
      draft,
      secretReadState: parsed.state,
      secretStatus: secretStatusFor(parsed.state, secretValuesFromDraft(draft), dirty)
    });
    return parsed;
  },

  startAddProvider() {
    this.closeModelPicker();
    this._secretReadSerial = Number(this._secretReadSerial || 0) + 1;
    const providers = this.data.providers || [];
    const secretDirty = cleanSecretDirty();
    this.setData({
      editing: false,
      selectedIndex: providers.length,
      draft: blankProvider(),
      authIsTc3: false,
      capabilities: markCapabilities([]),
      modelStatus: "尚未选择模型",
      modelStatusTone: "off",
      secretDirty,
      secretReadState: "empty",
      secretStatus: secretStatusFor("empty", emptySecretValues(), secretDirty),
      canMoveUp: false,
      canMoveDown: false
    });
  },

  onDraftInput(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail && event.detail.value !== undefined ? event.detail.value : "";
    const draft = clone(this.data.draft);
    this.setNested(draft, field, value);
    const secretField = SECRET_FIELD_BY_PATH[field];
    if (!secretField) {
      this.setData({ draft });
      return;
    }
    const secretDirty = Object.assign(cleanSecretDirty(), this.data.secretDirty || {});
    secretDirty[secretField.key] = true;
    this.setData({
      draft,
      secretDirty,
      secretStatus: secretStatusFor(this.data.secretReadState, secretValuesFromDraft(draft), secretDirty)
    });
  },

  setNested(target, path, value) {
    const parts = String(path || "").split(".");
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!cursor[parts[i]] || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    if (parts.length) cursor[parts[parts.length - 1]] = value;
  },

  switchAuth(event) {
    const type = event.currentTarget.dataset.auth;
    const draft = clone(this.data.draft);
    draft.authProtocol = type === "tc3" ? "tencent-tc3" : "openai";
    this.setData({ draft, authIsTc3: draft.authProtocol === "tencent-tc3" });
    this.closeModelPicker();
  },

  onCapabilityChange(event) {
    const key = event.currentTarget.dataset.cap;
    const detail = event.detail || {};
    const checked = detail.checked !== undefined
      ? Boolean(detail.checked)
      : (Array.isArray(detail.value) ? detail.value.indexOf(key) >= 0 : Boolean(detail.value));
    const draft = clone(this.data.draft);
    const values = Array.isArray(draft.capabilities) ? draft.capabilities.slice() : [];
    const index = values.indexOf(key);
    if (checked && index < 0) values.push(key);
    if (!checked && index >= 0) values.splice(index, 1);
    draft.capabilities = values;
    this.setData({ draft, capabilities: markCapabilities(values) });
  },

  async moveProvider(event) {
    if (this.demoMode) {
      this.setData({ message: "演示数据不调整供应商顺序。" });
      return;
    }
    const direction = event.currentTarget.dataset.direction === "up" ? -1 : 1;
    const index = this.data.selectedIndex;
    const next = index + direction;
    const providers = clone(this.data.providers);
    if (index < 0 || index >= providers.length || next < 0 || next >= providers.length) return;
    if (providers[index].isTemplate || providers[next].isTemplate) return;
    const temp = providers[index];
    providers[index] = providers[next];
    providers[next] = temp;
    let saved = false;
    let nextVersion = this.data.currentVersion;
    if (cloud && typeof cloud.saveAdminProviderV2 === "function") {
      try {
        const result = await cloud.saveAdminProviderV2({
          operation: "reorder",
          expectedVersion: this.data.currentVersion,
          order: providers.filter(provider => !provider.isTemplate).map(provider => provider.providerKey)
        });
        saved = Boolean(result && result.ok !== false);
        nextVersion = Number(result && (result.version || result.providerConfigV2 && result.providerConfigV2.version)) || nextVersion;
      } catch (error) {
        saved = false;
      }
    }
    if (!saved) {
      this.setData({ message: "顺序保存失败，请检查云端接口" });
      if (wx.showToast) wx.showToast({ title: "保存失败", icon: "none" });
      return;
    }
    this.setData({ providers, currentVersion: nextVersion, providerCountText: `${providers.length} 个档案`, message: "供应商顺序已保存" });
    this.selectProvider({ index: next });
  },

  async testConnection() {
    if (this.demoMode) {
      this.setData({ message: "演示数据不连接供应商。" });
      return;
    }
    const draft = this.data.draft;
    if (isExampleEndpoint(providerEndpoint(draft))) {
      this.setData({ message: "示例地址不可运行，请先填写真实 API 端点并保存" });
      if (wx.showToast) wx.showToast({ title: "请填写真实端点", icon: "none" });
      return;
    }
    this.setData({ busy: true, message: "正在测试连接..." });
    let ok = false;
    if (cloud && typeof cloud.probeAdminProviderV2 === "function") {
      try {
        const result = await cloud.probeAdminProviderV2({ provider: this.publicDraft(draft), providerKey: draft.providerKey });
        ok = Boolean(result && result.ok !== false);
      } catch (error) {
        ok = false;
      }
    }
    this.setData({ busy: false, message: ok ? "连接成功，可以获取模型" : "连接未通过，请检查端点和凭据" });
    if (wx.showToast) wx.showToast({ title: ok ? "连接成功" : "连接未通过", icon: "none" });
  },

  publicDraft(draft, dirty = this.data.secretDirty) {
    const source = draft || {};
    const tc3 = source.tc3 || {};
    const copy = clone(source);
    delete copy.apiKey;
    delete copy.secretId;
    delete copy.secretKey;
    delete copy.credentials;
    delete copy.tc3;
    delete copy.isTemplate;
    const existingConfigured = Boolean(source.auth && source.auth.configured || source.credentialConfigured || source.configured);
    const tc3Dirty = Boolean(dirty && (dirty.secretId || dirty.secretKey));
    const apiKeyDirty = Boolean(dirty && dirty.apiKey);
    copy.auth = source.authProtocol === "tencent-tc3"
      ? {
        protocol: "tencent-tc3",
        configured: tc3Dirty ? Boolean(tc3.secretId && tc3.secretKey) : Boolean(tc3.secretId && tc3.secretKey || existingConfigured),
        extra: {
          region: tc3.region || "",
          endpoint: tc3.endpoint || "",
          version: tc3.apiVersion || "",
          action: tc3.action || ""
        }
      }
      : { protocol: "openai", configured: apiKeyDirty ? Boolean(source.apiKey) : Boolean(source.apiKey || existingConfigured) };
    copy.metadata = Object.assign({}, copy.metadata || {}, { capabilities: (source.capabilities || []).slice() });
    return copy;
  },

  async fetchModels() {
    if (this.demoMode) {
      this.setData({ message: "演示数据不读取线上模型。" });
      return;
    }
    const draft = this.data.draft;
    if (isExampleEndpoint(providerEndpoint(draft))) {
      this.setData({ message: "示例地址不可运行，请先填写真实 API 端点并保存" });
      if (wx.showToast) wx.showToast({ title: "请填写真实端点", icon: "none" });
      return;
    }
    this.setData({ busy: true, message: "正在获取模型列表..." });
    let models = [];
    if (cloud && typeof cloud.listAdminProviderModelsV2 === "function") {
      try {
        const result = await cloud.listAdminProviderModelsV2({ providerKey: draft.providerKey, provider: this.publicDraft(draft) });
        models = result && Array.isArray(result.models) ? result.models : (result && result.data && Array.isArray(result.data.models) ? result.data.models : []);
      } catch (error) {
        models = [];
      }
    }
    models = Array.from(new Set(models.map(item => typeof item === "string" ? item : item.modelId || item.id).filter(Boolean)));
    this.setData({
      busy: false,
      fetchedModels: models,
      selectedFetchedModel: "",
      modelPickerOpen: models.length > 0,
      message: models.length ? `已获取 ${models.length} 个模型，请手动确认` : "未获取到模型，请先保存供应商并检查连接"
    });
  },

  chooseFetchedModel(event) {
    this.setData({ selectedFetchedModel: event.currentTarget.dataset.model || "" });
  },

  closeModelPicker() {
    this.setData({ modelPickerOpen: false, fetchedModels: [], selectedFetchedModel: "" });
  },

  async confirmModel() {
    if (this.demoMode) {
      this.setData({ message: "演示数据不保存模型确认。" });
      return;
    }
    const modelId = this.data.selectedFetchedModel;
    if (!modelId) return;
    const draft = clone(this.data.draft);
    if (!cloud || typeof cloud.confirmAdminModelsV2 !== "function") {
      this.setData({ message: "模型确认失败，请检查云端接口" });
      return;
    }
    try {
      const result = await cloud.confirmAdminModelsV2({
        providerKey: draft.providerKey,
        modelIds: [modelId],
        expectedVersion: this.data.currentVersion,
        capabilities: (draft.capabilities || []).slice(),
        candidates: [{ modelId, capabilities: (draft.capabilities || []).slice() }]
      });
      if (!result || result.ok === false) throw new Error("MODEL_CONFIRM_FAILED");
      const version = Number(result && (result.version || result.providerConfigV2 && result.providerConfigV2.version));
      const models = Array.from(new Set((draft.models || []).concat([modelId])));
      draft.models = models;
      draft.confirmedModels = (draft.confirmedModels || []).concat([modelId]).filter((item, index, list) => list.indexOf(item) === index);
      draft.selectedModel = modelId;
      this.setData({ draft, modelStatus: `已选 ${modelId}`, modelStatusTone: "ready", message: "已手动确认模型", currentVersion: version || this.data.currentVersion });
    } catch (error) {
      this.setData({ message: "模型确认失败，请重新获取后再试" });
      if (wx.showToast) wx.showToast({ title: "确认失败", icon: "none" });
      return;
    }
    this.closeModelPicker();
  },

  async saveProvider() {
    if (this.demoMode) {
      this.setData({ message: "演示数据只用于视觉预览，不会保存到线上。" });
      return;
    }
    const draft = normaliseProvider(this.data.draft);
    if (!draft.name || !draft.providerKey) {
      if (wx.showToast) wx.showToast({ title: "请填写供应商 ID 和名称", icon: "none" });
      return;
    }
    const providers = clone(this.data.providers);
    const index = this.data.editing ? this.data.selectedIndex : providers.length;
    const creatingFromTemplate = Boolean(draft.isTemplate);
    if (creatingFromTemplate) draft.enabled = true;
    delete draft.isTemplate;
    if (this.data.editing && index >= 0 && index < providers.length) providers[index] = draft;
    else providers.push(draft);
    this.setData({ busy: true, message: "正在保存供应商..." });
    let saved = false;
    if (cloud && typeof cloud.saveAdminProviderV2 === "function") {
      try {
        const publicProvider = this.publicDraft(draft, this.data.secretDirty);
        draft.auth = clone(publicProvider.auth);
        draft.configured = Boolean(publicProvider.auth && publicProvider.auth.configured);
        const mutation = secretMutation(draft, this.data.secretDirty);
        const request = {
          operation: this.data.editing && !creatingFromTemplate ? "update" : "create",
          expectedVersion: this.data.currentVersion,
          providerKey: draft.providerKey,
          provider: publicProvider
        };
        if (Object.keys(mutation.credentials).length) request.credentials = mutation.credentials;
        Object.assign(request, mutation.clearFlags);
        const result = await cloud.saveAdminProviderV2(request);
        saved = Boolean(result && result.ok !== false);
        const savedVersion = Number(result && (result.version || result.providerConfigV2 && result.providerConfigV2.version));
        if (savedVersion) this.setData({ currentVersion: savedVersion });
        const modelIds = Array.from(new Set((draft.confirmedModels || []).concat(draft.selectedModel || []).filter(Boolean)));
        if (saved && modelIds.length && typeof cloud.confirmAdminModelsV2 === "function") {
          const version = result && (result.version || result.providerConfigV2 && result.providerConfigV2.version);
          const confirmed = await cloud.confirmAdminModelsV2({
            providerKey: draft.providerKey,
            modelIds,
            expectedVersion: version,
            capabilities: (draft.capabilities || []).slice(),
            candidates: modelIds.map(modelId => ({ modelId, capabilities: (draft.capabilities || []).slice() }))
          });
          const confirmedVersion = Number(confirmed && (confirmed.version || confirmed.providerConfigV2 && confirmed.providerConfigV2.version));
          if (confirmedVersion) this.setData({ currentVersion: confirmedVersion });
        }
      } catch (error) {
        saved = false;
      }
    }
    if (!saved) {
      this.setData({ busy: false, message: "供应商保存失败，请检查云端接口" });
      if (wx.showToast) wx.showToast({ title: "保存失败", icon: "none" });
      return;
    }
    const dirty = this.data.secretDirty || cleanSecretDirty();
    if (SECRET_FIELDS.some(item => dirty[item.key])) {
      if (!this._secretCache) this._secretCache = Object.create(null);
      const values = secretValuesFromDraft(draft);
      this._secretCache[draft.providerKey] = {
        state: SECRET_FIELDS.some(item => values[item.key]) ? "success" : "empty",
        values
      };
    }
    this.setData({ busy: false, providers, providerCountText: `${providers.length} 个档案`, message: "供应商已保存到云端", secretDirty: cleanSecretDirty() });
    this.selectProvider({ index });
    if (wx.showToast) wx.showToast({ title: "保存成功", icon: "none" });
  },

  deleteProvider() {
    if (this.demoMode) {
      this.setData({ message: "演示数据不允许删除供应商。" });
      return;
    }
    const index = this.data.selectedIndex;
    if (!this.data.editing || index < 0 || index >= this.data.providers.length) return;
    const provider = this.data.providers[index];
    if (provider.isTemplate) return;
    const doDelete = async () => {
      this.setData({ busy: true, message: "正在删除供应商..." });
      let deleted = false;
      if (cloud && typeof cloud.saveAdminProviderV2 === "function") {
        try {
          const result = await cloud.saveAdminProviderV2({ operation: "delete", providerKey: provider.providerKey, expectedVersion: this.data.currentVersion });
          deleted = Boolean(result && result.ok !== false);
          const version = Number(result && (result.version || result.providerConfigV2 && result.providerConfigV2.version));
          if (version) this.setData({ currentVersion: version });
        } catch (error) {
          if (error && error.payload && error.payload.errorCode === "PROVIDER_REFERENCED") {
            this.setData({ busy: false, message: "该供应商仍被功能绑定，请先改绑后再删除" });
            if (wx.showToast) wx.showToast({ title: "供应商仍在使用", icon: "none" });
            return;
          }
        }
      }
      if (!deleted) {
        this.setData({ busy: false, message: "供应商删除失败，请检查云端接口" });
        if (wx.showToast) wx.showToast({ title: "删除失败", icon: "none" });
        return;
      }
      const providers = clone(this.data.providers);
      providers.splice(index, 1);
      const nextProviders = mergeDirectoryTemplates(providers);
      this.setData({ busy: false, providers: nextProviders, providerCountText: `${nextProviders.length} 个档案`, message: "供应商已删除" });
      if (nextProviders.length) this.selectProvider({ index: Math.min(index, nextProviders.length - 1) });
      else this.startAddProvider();
    };
    if (wx.showModal) {
      wx.showModal({ title: "删除供应商", content: `确认删除“${provider.name}”？若仍被功能绑定，系统会拒绝删除。`, success: result => { if (result.confirm) doDelete(); } });
    } else {
      doDelete();
    }
  },

  openConfig() {
    wx.navigateTo({ url: `/pages/admin-config/admin-config${this.previewQuery()}` });
  },

  goBack() {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.switchTab({ url: "/pages/workbench/workbench" });
  }
});
