const config = require("../config");

const DEMO_STORAGE_KEY = "admin-preview-demo";

const SUPPLIERS = [
  {
    providerKey: "dashscope",
    name: "阿里云百炼",
    authProtocol: "openai",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration", "video"],
    models: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2"],
    confirmedModels: ["qwen3-vl-flash", "qwen-vl-max", "jw-gpt-image-2"],
    selectedModel: "qwen3-vl-flash",
    enabled: true,
    configured: true
  },
  {
    providerKey: "xingju",
    name: "星矩",
    authProtocol: "openai",
    endpoint: "https://newapi.akiyo.fun/v1",
    capabilities: ["face", "imageAnalysis", "imageGeneration", "video"],
    models: ["qwen3-vl-flash", "qwen-vl-max", "kling-video-v2"],
    confirmedModels: ["qwen3-vl-flash", "qwen-vl-max", "kling-video-v2"],
    selectedModel: "qwen3-vl-flash",
    enabled: true,
    configured: true
  },
  {
    providerKey: "lingyun",
    name: "凌云",
    authProtocol: "openai",
    endpoint: "https://api.lingyun.example/v1",
    capabilities: ["imageAnalysis", "styleAnalysis", "video"],
    models: ["vision-pro", "vision-flash", "kling-video-v2"],
    confirmedModels: ["vision-pro", "vision-flash", "kling-video-v2"],
    selectedModel: "vision-pro",
    enabled: true,
    configured: true
  },
  {
    providerKey: "zhipu",
    name: "智谱",
    authProtocol: "openai",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    capabilities: ["face", "imageAnalysis", "styleAnalysis", "imageGeneration"],
    models: ["glm-4v", "glm-4.5v", "cogview-4"],
    confirmedModels: ["glm-4v", "glm-4.5v", "cogview-4"],
    selectedModel: "glm-4v",
    enabled: true,
    configured: true
  },
  {
    providerKey: "volcengine",
    name: "火山方舟",
    authProtocol: "openai",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3",
    capabilities: ["imageGeneration", "video"],
    models: ["doubao-image", "doubao-video"],
    confirmedModels: ["doubao-image", "doubao-video"],
    selectedModel: "doubao-image",
    enabled: true,
    configured: true
  },
  {
    providerKey: "tencent",
    name: "腾讯云",
    authProtocol: "tencent-tc3",
    endpoint: "ft.tencentcloudapi.com",
    capabilities: ["face"],
    models: ["FuseFace"],
    confirmedModels: ["FuseFace"],
    selectedModel: "FuseFace",
    enabled: true,
    configured: true,
    tc3: { region: "ap-guangzhou", endpoint: "ft.tencentcloudapi.com", apiVersion: "2020-03-04", action: "FuseFace" }
  },
  {
    providerKey: "laoli",
    name: "老李",
    authProtocol: "openai",
    endpoint: "https://api.laoli.example/v1",
    capabilities: [],
    models: [],
    confirmedModels: [],
    selectedModel: "",
    enabled: false,
    configured: false
  },
  {
    providerKey: "panda",
    name: "熊猫",
    authProtocol: "openai",
    endpoint: "https://api.panda.example/v1",
    capabilities: [],
    models: [],
    confirmedModels: [],
    selectedModel: "",
    enabled: false,
    configured: false
  },
  {
    providerKey: "qwen",
    name: "通义千问",
    authProtocol: "openai",
    endpoint: "https://dashscope.aliyuncs.com/v1",
    capabilities: ["imageAnalysis", "styleAnalysis"],
    models: ["qwen-vl-max", "qwen-vl-plus"],
    confirmedModels: ["qwen-vl-max", "qwen-vl-plus"],
    selectedModel: "qwen-vl-max",
    enabled: true,
    configured: true
  },
  {
    providerKey: "local",
    name: "本地模型",
    authProtocol: "openai",
    endpoint: "http://127.0.0.1:11434/v1",
    capabilities: [],
    models: [],
    confirmedModels: [],
    selectedModel: "",
    enabled: false,
    configured: false
  }
];

const BINDINGS = [
  ["standard.face", "primary", "xingju", "星矩", "qwen3-vl-flash", "ready"],
  ["standard.face", "backup", "lingyun", "凌云", "vision-pro", "ready"],
  ["standard.imageAnalysis", "primary", "dashscope", "阿里云百炼", "qwen3-vl-flash", "ready"],
  ["standard.imageAnalysis", "backup", "xingju", "星矩", "qwen-vl-max", "ready"],
  ["standard.styleAnalysis", "primary", "lingyun", "凌云", "vision-pro", "ready"],
  ["standard.imageGeneration", "primary", "dashscope", "阿里云百炼", "jw-gpt-image-2", "ready"],
  ["standard.imageGeneration", "backup", "xingju", "星矩", "jw-gpt-image-2", "ready"],
  ["tencent.face", "primary", "", "", "", "not-ready"],
  ["tencent.imageAnalysis", "primary", "xingju", "星矩", "qwen-vl-max", "ready"],
  ["tencent.styleAnalysis", "primary", "zhipu", "智谱", "glm-4v", "ready"],
  ["tencent.imageGeneration", "primary", "xingju", "星矩", "jw-gpt-image-2", "ready"],
  ["shared.video", "primary", "lingyun", "凌云", "kling-video-v2", "ready"],
  ["shared.video", "backup", "volcengine", "火山方舟", "doubao-video", "ready"]
].map((item) => ({
  slot: item[0],
  role: item[1],
  providerKey: item[2],
  providerName: item[3],
  modelId: item[4],
  status: item[5],
  metadata: item[0].endsWith("imageGeneration") ? {
    resolution: "1K",
    advanced: { mode: "edits", size: "1080x1440" },
    timeout: 60,
    retry: 1,
    path: "/v1/images/edits",
    keepExistingKey: true,
    validateBeforeSave: true
  } : item[0] === "shared.video" ? {
    resolution: "720p",
    aspectRatio: "3:4",
    timeout: 120,
    retry: 1,
    path: "/v1/videos/generations",
    keepExistingKey: true,
    validateBeforeSave: true
  } : {
    timeout: 30,
    retry: 1,
    path: "/v1/chat/completions",
    keepExistingKey: true,
    validateBeforeSave: true
  }
}));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (["1", "true", "on", "yes"].indexOf(text) >= 0) return true;
  if (["0", "false", "off", "no"].indexOf(text) >= 0) return false;
  return null;
}

function isEnabled(options) {
  const explicit = options && Object.prototype.hasOwnProperty.call(options, "demo")
    ? booleanValue(options.demo)
    : null;
  if (explicit !== null) return explicit;
  let stored = null;
  try {
    if (typeof wx !== "undefined" && typeof wx.getStorageSync === "function") stored = booleanValue(wx.getStorageSync(DEMO_STORAGE_KEY));
  } catch (error) {
    stored = null;
  }
  if (stored !== null) return stored;
  return Boolean(config && config.adminPreviewDemo === true);
}

function isControlVisible(options) {
  const explicit = options && Object.prototype.hasOwnProperty.call(options, "demoControl")
    ? booleanValue(options.demoControl)
    : null;
  if (explicit !== null) return explicit;
  return Boolean(config && config.adminPreviewDemoControl === true);
}

function setEnabled(enabled) {
  const value = Boolean(enabled);
  try {
    if (typeof wx !== "undefined" && typeof wx.setStorageSync === "function") wx.setStorageSync(DEMO_STORAGE_KEY, value);
  } catch (error) {
    // 本地预览没有存储能力时仍返回期望状态。
  }
  return value;
}

function supplierModels() {
  return SUPPLIERS.reduce((all, supplier) => all.concat(supplier.confirmedModels.map(modelId => ({
    providerKey: supplier.providerKey,
    modelId,
    capabilities: supplier.capabilities.slice(),
    confirmed: true
  }))), []);
}

function adminConfig() {
  const preferredOrder = ["dashscope", "xingju", "lingyun", "laoli", "panda", "qwen", "zhipu", "volcengine", "tencent", "local"];
  const order = new Map(preferredOrder.map((providerKey, index) => [providerKey, index]));
  const suppliers = SUPPLIERS.slice().sort((left, right) => (
    (order.get(left.providerKey) === undefined ? Number.MAX_SAFE_INTEGER : order.get(left.providerKey))
      - (order.get(right.providerKey) === undefined ? Number.MAX_SAFE_INTEGER : order.get(right.providerKey))
  ));
  return {
    version: 42,
    suppliers: clone(suppliers),
    supplierModels: supplierModels(),
    bindings: clone(BINDINGS),
    providerConfigV2: { version: 42 },
    source: "demo"
  };
}

function usage() {
  return {
    days: 30,
    todayKey: "2026-09-01",
    eventCount: 3842,
    errorLogCount: 199,
    today: { total: 128, failure: 3, estimatedCost: 2.86 },
    summary: {
      face: { total: 38, estimatedCost: 0.72 },
      analysis: { total: 42, estimatedCost: 0.58 },
      image: { total: 29, estimatedCost: 1.16 },
      video: { total: 19, estimatedCost: 0.4 }
    },
    failureStats: {
      total: 7,
      topFailureReasons: [
        { label: "网络超时", count: 4 },
        { label: "供应商限流", count: 3 }
      ]
    },
    models: [
      { provider: "星矩", model: "qwen3-vl-flash", total: 38, estimatedCost: 0.38 },
      { provider: "阿里云百炼", model: "jw-gpt-image-2", total: 29, estimatedCost: 1.16 },
      { provider: "凌云", model: "vision-pro", total: 25, estimatedCost: 0.47 },
      { provider: "火山方舟", model: "doubao-video", total: 10, estimatedCost: 0.21 }
    ]
  };
}

function cost() {
  const value = usage();
  value.last30d = { estimatedCost: 68.42, unavailableCostCount: 2 };
  value.today.unavailableCostCount = 0;
  return value;
}

function users() {
  return {
    total: 1286,
    signupTrend: [
      { dateKey: "2026-08-26", count: 34 },
      { dateKey: "2026-08-27", count: 41 },
      { dateKey: "2026-08-28", count: 29 },
      { dateKey: "2026-08-29", count: 46 },
      { dateKey: "2026-08-30", count: 38 },
      { dateKey: "2026-09-01", count: 27 }
    ],
    users: [
      { nickname: "演示用户 A", genderText: "未填写性别", userHash: "demo-a1" },
      { nickname: "演示用户 B", genderText: "女", userHash: "demo-b2" },
      { nickname: "演示用户 C", genderText: "男", userHash: "demo-c3" }
    ]
  };
}

function points() {
  return {
    effective: {
      points: {
        dailyFreeLimit: 3,
        imageCost: 10,
        videoCost: 10,
        checkinPoints: 5,
        streakBonus: 20,
        streakDays: 7
      }
    }
  };
}

function operations(view) {
  if (view === "cost") return cost();
  if (view === "users") return users();
  if (view === "points") return points();
  return usage();
}

module.exports = {
  DEMO_STORAGE_KEY,
  isEnabled,
  isControlVisible,
  setEnabled,
  adminConfig,
  providers: adminConfig,
  operations,
  usage,
  cost,
  users,
  points,
  clone
};
