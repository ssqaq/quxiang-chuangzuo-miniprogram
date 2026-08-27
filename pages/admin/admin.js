const config = require("../../config");
const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");

const IMAGE_QUALITY_OPTIONS = Object.freeze([
  { value: "1K", label: "1K" },
  { value: "2K", label: "2K" },
  { value: "4K", label: "4K" }
]);
const IMAGE_COST_FIELD_BY_PROVIDER = Object.freeze({
  xingju: Object.freeze({
    "1K": "imageXingju1K",
    "2K": "imageXingju2K",
    "4K": "imageXingju4K"
  }),
  lingyun: Object.freeze({
    "1K": "imageLingyun1K",
    "2K": "imageLingyun2K",
    "4K": "imageLingyun4K"
  })
});
const IMAGE_COST_KEYS = Object.freeze([
  "imageXingju1K",
  "imageXingju2K",
  "imageXingju4K",
  "imageLingyun1K",
  "imageLingyun2K",
  "imageLingyun4K"
]);
const VIDEO_COST_KEYS = Object.freeze(["video480p", "video720p", "video1080p"]);
const ADMIN_COST_KEYS = Object.freeze([
  "faceInputPerMillionTokens",
  "faceOutputPerMillionTokens",
  "analysisInputPerMillionTokens",
  "analysisOutputPerMillionTokens",
  ...IMAGE_COST_KEYS,
  ...VIDEO_COST_KEYS,
  "videoDefaultDuration"
]);
const VIDEO_COST_FIELD_BY_RESOLUTION = Object.freeze({
  "480p": "video480p",
  "720p": "video720p",
  "1080p": "video1080p"
});
const IMAGE_SIZE_OPTIONS = Object.freeze([
  { value: "1080x1440", label: "照片：1080×1440" },
  { value: "1242x1660", label: "照片：1242×1660" },
  { value: "1080x1920", label: "抖音视频封面：1080×1920" }
]);
const VIDEO_QUALITY_OPTIONS = Object.freeze([
  { value: "480p", label: "480p" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" }
]);
const ADMIN_PROVIDER_LABELS = Object.freeze({
  xingju: "星炬",
  lingyun: "凌云",
  dashscope: "阿里云百炼"
});
const ADMIN_PROVIDER_VALUES = Object.freeze({
  星炬: "xingju",
  凌云: "lingyun",
  阿里云百炼: "dashscope",
  阿里百炼: "dashscope"
});
const ADMIN_PROVIDER_FORM_SECTIONS = Object.freeze([
  "face",
  "analysis",
  "image",
  "imageBackup",
  "video"
]);

function normalizeAdminProviderInput(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  const text = raw.toLowerCase();
  if (ADMIN_PROVIDER_VALUES[raw]) return ADMIN_PROVIDER_VALUES[raw];
  if (ADMIN_PROVIDER_LABELS[text]) return text;
  return raw;
}

function displayAdminProvider(value, fallback = "") {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return fallback;
  const normalized = normalizeAdminProviderInput(raw);
  return ADMIN_PROVIDER_LABELS[normalized] || raw;
}

function normalizeAdminImageProviderInput(value) {
  return normalizeAdminProviderInput(value);
}

function displayAdminImageProvider(value, fallback = "") {
  return displayAdminProvider(value, fallback);
}

function normalizeAdminImageResolution(value, fallback = "1K") {
  const text = String(value || "").trim().toUpperCase();
  if (["1K", "2K", "4K"].includes(text)) return text;
  const match = text.match(/(\d{3,5})\s*[X×]\s*(\d{3,5})/);
  if (match) {
    const longest = Math.max(Number(match[1]), Number(match[2]));
    if (longest <= 1536) return "1K";
    if (longest <= 3072) return "2K";
    return "4K";
  }
  return ["1K", "2K", "4K"].includes(String(fallback)) ? String(fallback) : "1K";
}

function formatAdminPrice(value, fallback = "") {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  const fallbackRaw = String(
    fallback === undefined || fallback === null ? "" : fallback
  ).trim();
  if (raw === "" && fallbackRaw === "") return "";
  const number = Number(raw === "" ? fallbackRaw : raw);
  if (!Number.isFinite(number) || number < 0) {
    return "";
  }
  return number.toFixed(2).replace(/\.?0+$/, "");
}

function validateAdminCostInput(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return "不能为空";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) {
    return "必须是非负数字，最多 4 位小数";
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100000) {
    return "请输入 0～100000";
  }
  return "";
}

function validateAdminCostFields(costs = {}) {
  const source = costs && typeof costs === "object" ? costs : {};
  return ADMIN_COST_KEYS.reduce((errors, key) => {
    const error = validateAdminCostInput(source[key]);
    if (error) errors[key] = error;
    return errors;
  }, {});
}

function adminCostText(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function normalizeAdminImageCostProvider(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "lingyun" || text === "凌云" || text.includes("lingyunapi")) {
    return "lingyun";
  }
  if (text === "xingju" || text === "星炬" || text.includes("akiyo.fun")) {
    return "xingju";
  }
  return text || "xingju";
}

function configuredAdminPrice(costs, key, fieldMap) {
  const source = costs && typeof costs === "object" ? costs : {};
  const field = fieldMap[key];
  if (field && Object.prototype.hasOwnProperty.call(source, field)) {
    return source[field];
  }
  if (source.perImage && Object.prototype.hasOwnProperty.call(source.perImage, key)) {
    return source.perImage[key];
  }
  if (source.perSecond && Object.prototype.hasOwnProperty.call(source.perSecond, key)) {
    return source.perSecond[key];
  }
  return undefined;
}

function configuredAdminImagePrice(costs, key, provider = "xingju") {
  const source = costs && typeof costs === "object" ? costs : {};
  const providerKey = normalizeAdminImageCostProvider(provider);
  const fieldMap = IMAGE_COST_FIELD_BY_PROVIDER[providerKey]
    || IMAGE_COST_FIELD_BY_PROVIDER.xingju;
  const field = fieldMap[key];
  if (field && Object.prototype.hasOwnProperty.call(source, field)) {
    return source[field];
  }
  const providerCosts = source.providers
    && source.providers[providerKey]
    && typeof source.providers[providerKey] === "object"
    ? source.providers[providerKey]
    : {};
  if (
    providerCosts.perImage
    && Object.prototype.hasOwnProperty.call(providerCosts.perImage, key)
  ) {
    return providerCosts.perImage[key];
  }
  if (source.perImage && Object.prototype.hasOwnProperty.call(source.perImage, key)) {
    return source.perImage[key];
  }
  return undefined;
}

function buildAdminImageQualityOptions(costs = {}, provider = "xingju") {
  return IMAGE_QUALITY_OPTIONS.map((item) => {
    const price = formatAdminPrice(configuredAdminImagePrice(
      costs,
      item.value,
      provider
    ));
    return {
      value: item.value,
      label: price
        ? `${item.value}（¥${price}/张）`
        : `${item.value}（价格读取中）`
    };
  });
}

function buildAdminVideoQualityOptions(costs = {}) {
  return VIDEO_QUALITY_OPTIONS.map((item) => {
    const price = formatAdminPrice(configuredAdminPrice(
      costs,
      item.value,
      VIDEO_COST_FIELD_BY_RESOLUTION
    ));
    return {
      value: item.value,
      label: price
        ? `${item.value}（¥${price}/秒）`
        : `${item.value}（价格读取中）`
    };
  });
}

function buildAdminImagePricingNotice(costs = {}, provider = "xingju") {
  const prices = {};
  ["1K", "2K", "4K"].forEach((key) => {
    prices[key] = formatAdminPrice(configuredAdminImagePrice(
      costs,
      key,
      provider
    ));
  });
  if (!prices["1K"] || !prices["2K"] || !prices["4K"]) {
    return "当前图片价格：正在从云端读取。";
  }
  return `当前图片价格：1K ¥${prices["1K"]}/张，2K ¥${prices["2K"]}/张，4K ¥${prices["4K"]}/张。`;
}

function buildAdminVideoPricingNotice(costs = {}) {
  const prices = {};
  ["480p", "720p", "1080p"].forEach((key) => {
    prices[key] = formatAdminPrice(configuredAdminPrice(
      costs,
      key,
      VIDEO_COST_FIELD_BY_RESOLUTION
    ));
  });
  if (!prices["480p"] || !prices["720p"] || !prices["1080p"]) {
    return "当前视频价格：正在从云端读取。";
  }
  return `当前视频价格：480p ¥${prices["480p"]}/秒，720p ¥${prices["720p"]}/秒，1080p ¥${prices["1080p"]}/秒。`;
}

function adminImageSizeValue(value) {
  const text = String(value || "").trim().toLowerCase().replace("×", "x");
  return IMAGE_SIZE_OPTIONS.some((item) => item.value === text) ? text : "";
}

function buildAdminImageSizeOptions(value) {
  const raw = String(value || "").trim().toLowerCase().replace("×", "x");
  if (!raw || adminImageSizeValue(raw)) return IMAGE_SIZE_OPTIONS.slice();
  return [
    { value: raw, label: `兼容旧尺寸：${raw}` }
  ].concat(IMAGE_SIZE_OPTIONS);
}

function normalizeAdminVideoResolution(value, fallback = "720p") {
  const text = String(value || "").trim().toLowerCase();
  if (["480p", "720p", "1080p"].includes(text)) return text;
  const match = text.match(/(480|720|1080)/);
  if (match) return `${match[1]}p`;
  return ["480p", "720p", "1080p"].includes(String(fallback))
    ? String(fallback)
    : "720p";
}

function normalizeAdminBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function normalizeAdminCapabilityValues(type, values) {
  const source = Array.isArray(values) ? values : [values];
  const output = [];
  source.forEach((value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      normalizeAdminCapabilityValues(type, value).forEach((item) => output.push(item));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => {
        const flag = value[key];
        if (typeof flag === "boolean") {
          if (flag) {
            normalizeAdminCapabilityValues(type, key)
              .forEach((item) => output.push(item));
          }
          return;
        }
        normalizeAdminCapabilityValues(type, flag)
          .forEach((item) => output.push(item));
      });
      return;
    }
    const text = String(value);
    if (type === "image") {
      (text.match(/(?:1|2|4)\s*K\b|\b\d{3,5}\s*[x×]\s*\d{3,5}\b/ig) || [])
        .forEach((item) => output.push(normalizeAdminImageResolution(item, "")));
    } else {
      (text.match(/\b(?:480|720|1080)\s*p?\b/ig) || [])
        .forEach((item) => output.push(normalizeAdminVideoResolution(item, "")));
    }
  });
  const order = type === "image" ? ["1K", "2K", "4K"] : ["480p", "720p", "1080p"];
  return order.filter((item) => output.includes(item));
}

function knownAdminCapabilities(type, form) {
  const source = form && form[type] ? form[type] : {};
  const model = String(source.model || "").trim().toLowerCase();
  const provider = String(source.provider || "").trim().toLowerCase();
  if (type === "image" && (
    model === "image2超分高质量1-4k"
    || /image2.*(?:1-4k|超分)/i.test(model)
    || provider === "pandatk"
    || provider === "panda"
    || provider === "xingju"
    || provider === "星炬"
    || provider === "lingyun"
    || provider === "凌云"
  )) {
    return ["1K", "2K", "4K"];
  }
  if (type === "video" && (
    model === "grok-imagine-video-1.5"
    || provider === "lingyun"
    || provider === "凌云"
  )) {
    return ["480p", "720p", "1080p"];
  }
  return [];
}

function buildAdminQualityOptions(type, capabilities, form) {
  const upstreamValues = normalizeAdminCapabilityValues(
    type,
    capabilities && capabilities.resolutions
  );
  const values = upstreamValues.length ? upstreamValues : knownAdminCapabilities(type, form);
  const all = type === "image"
    ? buildAdminImageQualityOptions(
        form && form.costs,
        form && form.image && form.image.provider
      )
    : buildAdminVideoQualityOptions(form && form.costs);
  return {
    options: values.length
      ? all.filter((item) => values.includes(item.value))
      : all.slice(),
    source: upstreamValues.length
      ? "upstream"
      : knownAdminCapabilities(type, form).length
        ? "known-model-rule"
        : "custom"
  };
}

function pickerIndex(options, value, fallback = 0) {
  const index = (Array.isArray(options) ? options : []).findIndex(
    (item) => item && item.value === value
  );
  return index >= 0 ? index : fallback;
}

function buildQualityPickerState(form, capabilityPayload = {}) {
  const image = form && form.image ? form.image : {};
  const imageBackup = form && form.imageBackup ? form.imageBackup : {};
  const video = form && form.video ? form.video : {};
  const imageCapability = capabilityPayload.image || {};
  const videoCapability = capabilityPayload.video || {};
  const imageQuality = buildAdminQualityOptions("image", imageCapability, form);
  const videoQuality = buildAdminQualityOptions("video", videoCapability, form);
  const imageBackupQualityOptions = buildAdminImageQualityOptions(
    form && form.costs,
    imageBackup.provider
  );
  const imageQualityValue = normalizeAdminImageResolution(
    image.resolution || image.size,
    "1K"
  );
  const imageBackupQualityValue = normalizeAdminImageResolution(
    imageBackup.resolution || imageBackup.size || image.resolution || image.size,
    "1K"
  );
  const videoQualityValue = normalizeAdminVideoResolution(video.resolution, "720p");
  const imageSizeOptions = buildAdminImageSizeOptions(image.size || "1080x1440");
  const imageSizeValue = String(image.size || "").trim().toLowerCase().replace("×", "x")
    || "1080x1440";
  const imageBackupSizeOptions = buildAdminImageSizeOptions(
    imageBackup.size || image.size || "1080x1440"
  );
  const imageBackupSizeValue = String(
    imageBackup.size || image.size || ""
  ).trim().toLowerCase().replace("×", "x") || "1080x1440";
  const imageCosts = form && form.costs ? form.costs : {};
  return Object.assign(
    {
      imageQualityOptions: imageQuality.options,
      imageQualityIndex: pickerIndex(
        imageQuality.options,
        imageQualityValue,
        0
      ),
      imageSizeOptions,
      imageSizeIndex: pickerIndex(imageSizeOptions, imageSizeValue, 0),
      imageBackupQualityOptions,
      imageBackupQualityIndex: pickerIndex(
        imageBackupQualityOptions,
        imageBackupQualityValue,
        0
      ),
      imageBackupSizeOptions,
      imageBackupSizeIndex: pickerIndex(
        imageBackupSizeOptions,
        imageBackupSizeValue,
        0
      ),
      imagePricingNotice: buildAdminImagePricingNotice(imageCosts, image.provider),
      imageBackupPricingNotice: buildAdminImagePricingNotice(
        imageCosts,
        imageBackup.provider
      ),
      videoQualityOptions: videoQuality.options,
      videoQualityIndex: pickerIndex(videoQuality.options, videoQualityValue, 1),
      videoPricingNotice: buildAdminVideoPricingNotice(imageCosts),
      imageCapabilitySource: imageQuality.source,
      videoCapabilitySource: videoQuality.source,
      imageCapabilityNotice: imageQuality.source === "upstream"
        ? "已按上游返回的生图能力显示选项。"
        : imageQuality.source === "known-model-rule"
          ? "已识别当前生图模型，支持 1K、2K、4K。"
          : "暂未识别上游能力，保留三档选项；未知模型请以实际上游支持为准。",
      videoCapabilityNotice: videoQuality.source === "upstream"
        ? "已按上游返回的视频能力显示选项。"
        : videoQuality.source === "known-model-rule"
          ? "已识别 Grok 视频模型，支持 480p、720p、1080p。"
          : "暂未识别上游能力，保留三档选项；未知模型请以实际上游支持为准。"
    },
    {
      imageProviderDisplayName: displayAdminImageProvider(image.provider),
      imageBackupProviderDisplayName: displayAdminImageProvider(imageBackup.provider)
    }
  );
}

function emptyForm() {
  return {
    face: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      apiKey: "",
      model: "",
      timeoutMs: "30000"
    },
    analysis: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      apiKey: "",
      model: "",
      timeoutMs: "30000"
    },
    image: {
      provider: "星炬",
      baseUrl: "https://newapi.akiyo.fun/v1",
      endpoint: "",
      apiKey: "",
      model: "jw-gpt-image-2",
      mode: "edits",
      size: "1080x1440",
      resolution: "1K",
      compatibilityMode: false,
      timeoutMs: "150000",
      maxRetries: "1",
      retryEnabled: true,
      retryPreferenceVersion: 1
    },
    imageBackup: {
      provider: "凌云",
      baseUrl: "https://api.lingyunapi.xyz/v1",
      endpoint: "",
      apiKey: "",
      model: "gpt-image-2",
      mode: "edits",
      size: "1080x1440",
      resolution: "1K",
      compatibilityMode: false,
      timeoutMs: "150000",
      maxRetries: "0",
      retryEnabled: false,
      retryPreferenceVersion: 1
    },
    video: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      queryEndpoint: "",
      apiKey: "",
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
      promoStartDate: "2026-08-24",
      promoEndDate: "2026-08-25",
      timeZone: "Asia/Shanghai"
    },
    costs: {
      faceInputPerMillionTokens: "0.15",
      faceOutputPerMillionTokens: "1.5",
      analysisInputPerMillionTokens: "0.15",
      analysisOutputPerMillionTokens: "1.5",
      imageXingju1K: "",
      imageXingju2K: "",
      imageXingju4K: "",
      imageLingyun1K: "",
      imageLingyun2K: "",
      imageLingyun4K: "",
      video480p: "",
      video720p: "",
      video1080p: "",
      videoDefaultDuration: "3"
    },
    generationQueue: {
      workerConcurrency: "1",
      alertThreshold: "5",
      alertCooldownMinutes: "10"
    }
  };
}

const USAGE_TYPE_META = [
  { key: "face", title: "人脸识别", icon: "脸" },
  { key: "analysis", title: "图片分析", icon: "图" },
  { key: "image", title: "生图模型", icon: "生" },
  { key: "video", title: "视频模型", icon: "视" }
];

function usageTypeLabel(type) {
  const item = USAGE_TYPE_META.find((entry) => entry.key === type);
  return item ? item.title : "模型";
}

function normalizeAdminModelLabel(value) {
  const label = String(value || "模型").trim();
  if (!label) return "模型";
  return label !== "模型" && label.endsWith("模型")
    ? label.slice(0, -2)
    : label;
}

const MODEL_DISPLAY_EMPTY_VALUES = new Set([
  "",
  "未配置",
  "未填写",
  "未读取",
  "未知",
  "未知模型",
  "暂无调用",
  "unknown",
  "null",
  "undefined"
]);

function displayModelName(value) {
  const text = String(value == null ? "" : value).trim();
  return text && !MODEL_DISPLAY_EMPTY_VALUES.has(text.toLowerCase())
    ? text.toLowerCase()
    : "未配置";
}

const MODEL_DISPLAY_ZH = Object.freeze({
  "grok-imagine-video-1.5": "视频生成模型",
  "grok-imagine-image-1.5": "图片生成模型",
  "qwen3-vl-flash": "通义千问视觉模型",
  "qwen-vl-max": "通义千问视觉模型"
});

const MODEL_ERROR_CODE_ZH = Object.freeze({
  upstream_error: "上游请求错误",
  upstream_unavailable: "上游服务不可用",
  network_error: "网络连接错误",
  timeout: "请求超时",
  timed_out: "请求超时",
  invalid_model_type: "模型类型无效",
  invalid_request: "请求参数无效",
  authentication_error: "身份验证失败",
  unauthorized: "未授权请求",
  forbidden: "没有访问权限",
  rate_limit: "请求过于频繁",
  unknown: "未知错误"
});

function displayModelNameZh(value, usageType = "") {
  const raw = displayModelName(value);
  if (MODEL_DISPLAY_ZH[raw]) return MODEL_DISPLAY_ZH[raw];
  if (raw === "未配置") return raw;
  const typeLabel = usageTypeLabel(usageType);
  return typeLabel === "模型" ? "已配置模型" : typeLabel;
}

function modelErrorCodeLabel(value) {
  const code = String(value == null ? "" : value).trim().toLowerCase();
  if (!code || code === "unknown") return "未知错误";
  if (MODEL_ERROR_CODE_ZH[code]) return MODEL_ERROR_CODE_ZH[code];
  if (/upstream|provider|gateway/.test(code)) return "上游服务错误";
  if (/network|connect|socket|dns/.test(code)) return "网络连接错误";
  if (/timeout|deadline/.test(code)) return "请求超时";
  if (/auth|credential|key/.test(code)) return "身份验证失败";
  if (/invalid|missing|parameter|request/.test(code)) return "请求参数错误";
  return "接口调用错误";
}

function modelErrorMessageLabel(value) {
  const message = String(value == null ? "" : value).trim();
  if (!message) return "未提供错误摘要";
  if (/upstream request failed for details/i.test(message)) {
    return "获取详情失败，请检查上游请求";
  }
  if (/upstream|provider|gateway/i.test(message)) {
    return "上游服务返回错误，请检查请求参数";
  }
  if (/timeout|timed out|deadline/i.test(message)) {
    return "请求超时，请稍后重试";
  }
  if (/network|connect|socket|dns/i.test(message)) {
    return "网络连接失败，请检查网络或服务地址";
  }
  if (/[\u4e00-\u9fff]/.test(message)) return message;
  return "上游服务返回错误，请检查请求参数";
}

function pickModelName() {
  let value = "";
  for (let index = 0; index < arguments.length; index += 1) {
    const item = arguments[index];
    const text = String(item == null ? "" : item).trim();
    if (text && !MODEL_DISPLAY_EMPTY_VALUES.has(text.toLowerCase())) {
      value = item;
      break;
    }
  }
  return displayModelName(value);
}

function emptyCurrentConfigModels() {
  return {
    face: "未配置",
    analysis: "未配置",
    image: "未配置",
    video: "未配置"
  };
}

function buildCurrentConfigModels(form) {
  const source = form || {};
  return ["face", "analysis", "image", "video"].reduce((result, key) => {
    result[key] = displayModelName(source[key] && source[key].model);
    return result;
  }, emptyCurrentConfigModels());
}

// 成本金额只展示到小数点后 4 位并直接截断，底层统计和 Excel 仍保留原值。
function formatCostDisplay(value) {
  const amount = Math.max(0, Number(value) || 0);
  const truncated = Math.floor(amount * 10000) / 10000;
  return truncated.toFixed(4).replace(/\.?(0+)$/, "");
}

const CONFIG_SECTION_TITLES = Object.freeze({
  face: "人脸识别模型",
  analysis: "图片分析模型",
  image: "生图模型",
  tencentImage: "生图模型-腾讯版",
  video: "视频模型",
  points: "签到与积分规则",
  costs: "模型成本配置",
  users: "用户统计"
});
const MODEL_CONFIG_SECTIONS = Object.freeze([
  "face",
  "analysis",
  "image",
  "tencentImage",
  "video"
]);

function configEditorSelector(section) {
  return MODEL_CONFIG_SECTIONS.indexOf(section) >= 0
    ? `#config-editor-${section}`
    : "#config-editor";
}

const MONITOR_SECTION_KEYS = Object.freeze([
  "generationQueue",
  "autoFaceFailure",
  "diagnosticLogs",
  "deployment"
]);
const DEPLOYMENT_SECTION_KEYS = Object.freeze([
  "probeHistory",
  "logs"
]);
const USAGE_SECTION_KEYS = Object.freeze([
  "failure",
  "daily",
  "users",
  "models",
  "monthly"
]);
const AUTO_FACE_FAILURE_SECTION_KEYS = Object.freeze([
  "failure",
  "daily",
  "users",
  "monthly"
]);
const MONITOR_LAYOUT_STORAGE_KEY = "admin-monitor-layout-v3";
const TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY = "admin-tencent-facefusion-last-test-v1";
const AUTO_FACE_FAILURE_AUTO_REFRESH_MS = 10 * 60 * 1000;
const MODEL_FAILURE_AUTO_REFRESH_MS = 10 * 60 * 1000;

function defaultUsageSections() {
  return {
    failure: false,
    daily: false,
    users: false,
    models: false,
    monthly: false
  };
}

function defaultAutoFaceFailureSections() {
  return {
    failure: true,
    daily: true,
    users: false,
    monthly: false
  };
}

function defaultDeploymentSections() {
  return {
    probeHistory: false,
    logs: false
  };
}

function emptyDashboardStatus() {
  return {
    tone: "neutral",
    title: "等待检查",
    probeDurationText: "未检查"
  };
}

function emptyFaceConfigSummary() {
  return {
    provider: "未读取",
    model: "未配置",
    ready: false
  };
}

function emptyUsageCounter() {
  return {
    total: 0,
    success: 0,
    failure: 0,
    estimatedCost: 0,
    estimatedCostDisplay: "0",
    pricedCost: 0,
    pricedCount: 0,
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

function formatUsageCounter(counter) {
  const normalized = Object.assign(emptyUsageCounter(), counter || {});
  normalized.total = Math.max(0, Number(normalized.total) || 0);
  normalized.unavailableCostCount = Math.max(0, Number(normalized.unavailableCostCount) || 0);
  normalized.pricedCount = Math.max(0, normalized.total - normalized.unavailableCostCount);
  normalized.estimatedCost = Math.max(0, Number(normalized.estimatedCost) || 0);
  normalized.pricedCost = Math.max(0, Number(normalized.pricedCost) || 0);
  normalized.estimatedCostDisplay = formatCostDisplay(normalized.estimatedCost);
  normalized.pricedCostDisplay = formatCostDisplay(normalized.pricedCost);
  return normalized;
}

function emptyFailureStats() {
  return {
    total: 0,
    totalCalls: 0,
    success: 0,
    successRate: 0,
    failureRate: 0,
    topFailureReasons: [],
    failedModels: [],
    failureDetails: [],
    details: [],
    monthly: [],
    users: []
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
      analysis: emptyUsageCounter(),
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
      modelText: "未配置",
      modelLines: ["未配置"]
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

function emptyImageProviderAttemptCounter(provider, model) {
  return {
    calls: 0,
    success: 0,
    failure: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    averageDurationText: "0.0 秒",
    provider: provider || "",
    model: model || ""
  };
}

function emptyImageProviderStats() {
  return {
    timeZone: "Asia/Shanghai",
    days: 30,
    todayKey: "",
    totalRequests: 0,
    totalAttempts: 0,
    primary: emptyImageProviderAttemptCounter("xingju", "jw-gpt-image-2"),
    backup: emptyImageProviderAttemptCounter("lingyun", "gpt-image-2"),
    switchCount: 0,
    switchRate: 0,
    switchRateText: "0%",
    finalBackupSuccessCount: 0,
    recentFailures: [],
    daily: [],
    eventCount: 0,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function formatImageProviderAttemptCounter(value, fallbackProvider, fallbackModel) {
  const source = value || {};
  const calls = Math.max(0, Number(source.calls) || 0);
  const totalDurationMs = Math.max(0, Number(source.totalDurationMs) || 0);
  const averageDurationMs = calls
    ? Math.round(totalDurationMs / calls)
    : Math.max(0, Number(source.averageDurationMs) || 0);
  return Object.assign(
    emptyImageProviderAttemptCounter(fallbackProvider, fallbackModel),
    source,
    {
      calls,
      success: Math.max(0, Number(source.success) || 0),
      failure: Math.max(0, Number(source.failure) || 0),
      totalDurationMs,
      averageDurationMs,
      averageDurationText: `${(averageDurationMs / 1000).toFixed(1)} 秒`,
      provider: displayAdminProvider(source.provider, displayAdminProvider(fallbackProvider)),
      model: source.model || fallbackModel
    }
  );
}

function formatImageProviderStats(result) {
  const source = result || {};
  const failures = (Array.isArray(source.recentFailures)
    ? source.recentFailures
    : []
  ).map((item) => {
    const durationMs = Math.max(0, Number(item.durationMs) || 0);
    return Object.assign({}, item, {
      roleText: item.role === "backup" ? "备用模型" : "主模型",
      provider: displayAdminProvider(item.provider),
      createdAtText: formatAdminDate(item.createdAt || item.dateKey),
      durationText: `${(durationMs / 1000).toFixed(1)} 秒`,
      statusText: Number(item.status) ? `HTTP ${Number(item.status)}` : "无状态码",
      message: item.message || "未提供错误原因"
    });
  });
  const daily = (Array.isArray(source.daily) ? source.daily : []).map((item) => ({
    dateKey: item.dateKey || "",
    dateLabel: item.dateKey === source.todayKey
      ? `${item.dateKey} 今天`
      : item.dateKey || "未知日期",
    totalAttempts: Math.max(0, Number(item.totalAttempts) || 0),
    primaryCalls: Math.max(0, Number(item.primaryCalls) || 0),
    primarySuccess: Math.max(0, Number(item.primarySuccess) || 0),
    primaryFailure: Math.max(0, Number(item.primaryFailure) || 0),
    backupCalls: Math.max(0, Number(item.backupCalls) || 0),
    backupSuccess: Math.max(0, Number(item.backupSuccess) || 0),
    backupFailure: Math.max(0, Number(item.backupFailure) || 0),
    switchCount: Math.max(0, Number(item.switchCount) || 0)
  }));
  return Object.assign(emptyImageProviderStats(), source, {
    days: Math.max(1, Number(source.days) || 30),
    totalRequests: Math.max(0, Number(source.totalRequests) || 0),
    totalAttempts: Math.max(0, Number(source.totalAttempts) || 0),
    primary: formatImageProviderAttemptCounter(
      source.primary,
      "xingju",
      "jw-gpt-image-2"
    ),
    backup: formatImageProviderAttemptCounter(
      source.backup,
      "lingyun",
      "gpt-image-2"
    ),
    switchCount: Math.max(0, Number(source.switchCount) || 0),
    switchRate: Math.max(0, Number(source.switchRate) || 0),
    switchRateText: source.switchRateText || `${Number(source.switchRate) || 0}%`,
    finalBackupSuccessCount: Math.max(
      0,
      Number(source.finalBackupSuccessCount) || 0
    ),
    recentFailures: failures,
    daily
  });
}

const CONFIG_AUDIT_SECTION_LABELS = Object.freeze({
  face: "人脸模型",
  analysis: "分析模型",
  image: "主图片模型",
  imageBackup: "备用图片模型",
  video: "视频模型",
  points: "积分规则",
  costs: "成本配置",
  generationQueue: "生图队列"
});

function emptyConfigAuditLogs() {
  return {
    logs: [],
    limit: 20,
    unavailable: false,
    message: ""
  };
}

function formatConfigAuditLogs(result) {
  const source = result || {};
  const logs = (Array.isArray(source.logs) ? source.logs : []).map((item) => {
    const changes = (Array.isArray(item.changes) ? item.changes : []).map((change) => {
      const section = CONFIG_AUDIT_SECTION_LABELS[change.section]
        || change.section
        || "配置";
      if (change.secret || change.field === "apiKey") {
        return {
          text: `${section} API Key：${change.configuredAfter ? "已配置" : "未配置"}`
            + `${change.updated ? "（本次已更新）" : ""}`
        };
      }
      const oldValue = change.oldValue === null || change.oldValue === undefined
        ? "空"
        : String(change.oldValue);
      const newValue = change.newValue === null || change.newValue === undefined
        ? "空"
        : String(change.newValue);
      return {
        text: `${section} ${change.field || "字段"}：${oldValue} → ${newValue}`
      };
    });
    return {
      _id: item._id || "",
      createdAt: item.createdAt || "",
      createdAtText: formatAdminDate(item.createdAt),
      source: item.source || "admin-save",
      sourceText: item.source === "system-auto-correct" ? "系统自动纠正" : "管理员保存",
      actorHash: item.actorHash || "system",
      configVersion: Number(item.configVersion) || 0,
      changeCount: Number(item.changeCount) || changes.length,
      changes,
      changeSummary: changes.length
        ? changes.map((change) => change.text).join("；")
        : "没有可展示的字段变化"
    };
  });
  return Object.assign(emptyConfigAuditLogs(), source, { logs });
}

function emptyAutoFaceFailureStats() {
  return {
    timeZone: "Asia/Shanghai",
    todayKey: "",
    today: 0,
    last7d: 0,
    total30d: 0,
    byType: [],
    probeSummary: {
      total: 0,
      ok: 0,
      failed: 0,
      pending: 0,
      notRun: 0,
      visionConfigured: 0,
      visionUnavailable: 0,
      versions: []
    },
    recent: [],
    daily: [],
    monthly: [],
    users: [],
    eventCount: 0,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function emptyAutoFaceProbe() {
  return {
    available: false,
    status: "not-run",
    statusText: "尚未检查",
    buildVersion: "",
    buildMarker: "",
    nodeVersion: "",
    cloudEnvConfigured: false,
    visionConfigured: false,
    provider: "",
    model: "",
    durationMs: 0,
    durationText: "未知",
    serverDurationMs: 0,
    serverDurationText: "未知",
    checkedAtText: "未知时间",
    errorCode: "",
    message: ""
  };
}

function emptyModelProbes() {
  return {
    available: false,
    status: "not-run",
    statusText: "尚未探测",
    buildVersion: "",
    buildMarker: "",
    checkedAtText: "未知时间",
    readyCount: 0,
    total: 4,
    results: [],
    message: ""
  };
}

function emptyAutoFaceProbeHistory() {
  return {
    history: [],
    retentionDays: 30,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function emptyUserStats() {
  return {
    total: 0,
    maleCount: 0,
    femaleCount: 0,
    maleRatio: 0,
    femaleRatio: 0,
    users: [],
    search: "",
    dateRange: "all",
    gender: "all",
    startDate: "",
    endDate: "",
    signupTrend: [],
    signupTrendTotal: 0,
    nextOffset: null,
    unavailable: false,
    message: ""
  };
}

function emptyAdminDiagnosticLogs() {
  return {
    retentionHours: 72,
    hours: 72,
    level: "all",
    category: "all",
    userHash: "",
    summary: {
      total: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      userCount: 0,
      categories: []
    },
    userOptions: [{ value: "", label: "全部用户" }],
    logs: [],
    nextOffset: null,
    eventCount: 0,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function emptyGenerationQueue() {
  return {
    snapshot: {
      total: 0,
      counts: {
        reserved: 0,
        queued: 0,
        processing: 0,
        succeeded: 0,
        failed: 0,
        refunding: 0,
        refunded: 0
      },
      kinds: { image: 0, video: 0 },
      queuedCount: 0,
      processingCount: 0,
      pendingRefundCount: 0,
      oldestQueuedAgeSeconds: 0,
      workerConcurrency: 1,
      alertThreshold: 5,
      alertCooldownMinutes: 10,
      alertActive: false,
      generatedAt: ""
    },
    tasks: [],
    visibleTasks: [],
    unavailable: false,
    message: "",
    tone: "normal",
    statusText: "队列正常",
    oldestQueuedText: "暂无排队",
    generatedAtText: "尚未更新"
  };
}

function emptyCostTrend() {
  return {
    days: [],
    totalCost: 0,
    hasCost: false
  };
}

function buildTodayFailureText(usageStats, moduleStates) {
  const state = moduleStates && moduleStates.usage;
  if (state && state.status === "loading") return "读取中";
  if (state && state.status === "failed") return "读取失败";
  const usage = usageStats || emptyUsageStats();
  const today = usage.today || emptyUsageCounter();
  return `${Number(today.failure) || 0} 个失败`;
}

const ADMIN_MODULE_KEYS = [
  "generationQueue",
  "usage",
  "imageProviderStats",
  "configAudit",
  "users",
  "diagnosticLogs",
  "autoFaceFailure",
  "probeHistory",
  "logs"
];

function moduleStateLabel(status) {
  if (status === "loading") return "读取中";
  if (status === "ready") return "已读取";
  if (status === "failed") return "读取失败";
  return "未读取";
}

function createModuleState(
  status = "idle",
  hasData = false,
  message = "",
  updatedAtText = "尚未更新"
) {
  return {
    status,
    label: moduleStateLabel(status),
    hasData: Boolean(hasData),
    message: message || "",
    updatedAtText: updatedAtText || "尚未更新"
  };
}

function emptyAdminModuleStates(status = "idle") {
  return ADMIN_MODULE_KEYS.reduce((result, key) => {
    result[key] = createModuleState(status);
    return result;
  }, {});
}

function loadingAdminModuleStates(previous = {}) {
  return ADMIN_MODULE_KEYS.reduce((result, key) => {
    const previousState = previous[key] || {};
    result[key] = createModuleState(
      "loading",
      Boolean(previousState.hasData),
      previousState.message || "",
      previousState.updatedAtText || "尚未更新"
    );
    return result;
  }, {});
}

function updateAdminModuleState(
  states,
  key,
  status,
  hasData,
  message = "",
  updatedAtText = ""
) {
  const previous = states && states[key] ? states[key] : createModuleState();
  return Object.assign({}, states || {}, {
    [key]: createModuleState(
      status,
      hasData === undefined ? previous.hasData : hasData,
      message,
      updatedAtText || previous.updatedAtText
    )
  });
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${label}超过${Math.round(timeoutMs / 1000)}秒未返回`);
      error.code = "ADMIN_LOAD_TIMEOUT";
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function formatAdminDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} `
    + `${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
}

function generationOperationStatusText(status) {
  const labels = {
    reserved: "已预留",
    queued: "排队中",
    processing: "处理中",
    succeeded: "已完成",
    failed: "失败",
    refunding: "退款中",
    refunded: "已退款"
  };
  return labels[String(status || "")] || "未知";
}

function generationOperationKindText(kind) {
  return String(kind || "") === "video" ? "视频" : "图片";
}

function formatQueueDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (!value) return "暂无排队";
  if (value < 60) return `${Math.floor(value)}秒`;
  if (value < 3600) return `${Math.floor(value / 60)}分钟`;
  return `${Math.floor(value / 3600)}小时${Math.floor((value % 3600) / 60)}分钟`;
}

function applyGenerationQueueFilters(queue, kind = "all", status = "all") {
  const source = queue || emptyGenerationQueue();
  return Object.assign({}, source, {
    visibleTasks: (Array.isArray(source.tasks) ? source.tasks : []).filter((item) => (
      (kind === "all" || item.kind === kind)
      && (status === "all" || item.status === status)
    ))
  });
}

function formatGenerationQueue(result) {
  const source = result || {};
  const snapshot = Object.assign(
    {},
    emptyGenerationQueue().snapshot,
    source.snapshot || {}
  );
  snapshot.counts = Object.assign(
    {},
    emptyGenerationQueue().snapshot.counts,
    snapshot.counts || {}
  );
  snapshot.kinds = Object.assign(
    {},
    emptyGenerationQueue().snapshot.kinds,
    snapshot.kinds || {}
  );
  const tasks = (Array.isArray(source.tasks) ? source.tasks : []).map((item) => ({
    operationId: item.operationId || "",
    requestId: item.requestId || "",
    userHash: item.userHash || "",
    kind: item.kind === "video" ? "video" : "image",
    kindText: generationOperationKindText(item.kind),
    status: item.status || "failed",
    statusText: generationOperationStatusText(item.status),
    stage: item.stage || item.status || "",
    progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
    attemptCount: Math.max(0, Number(item.attemptCount) || 0),
    errorCode: item.error && item.error.code || "",
    refundPending: Boolean(item.refundPending),
    cleanupPending: Boolean(item.cleanupPending),
    createdAtText: formatAdminDate(item.createdAt),
    updatedAtText: formatAdminDate(item.updatedAt),
    idleText: formatQueueDuration(item.idleSeconds)
  }));
  const warningThreshold = Math.max(1, Math.ceil(Number(snapshot.alertThreshold) * 0.7));
  const tone = snapshot.alertActive
    ? "danger"
    : Number(snapshot.queuedCount) >= warningThreshold
      ? "warning"
      : "normal";
  const queue = {
    snapshot,
    tasks,
    visibleTasks: tasks.slice(),
    unavailable: Boolean(source.unavailable),
    message: source.message || "",
    tone,
    statusText: snapshot.alertActive
      ? "队列已积压"
      : tone === "warning"
        ? "接近告警线"
        : "队列正常",
    oldestQueuedText: formatQueueDuration(snapshot.oldestQueuedAgeSeconds),
    generatedAtText: snapshot.generatedAt
      ? formatAdminDate(snapshot.generatedAt)
      : "尚未更新"
  };
  return queue;
}

function formatGenerationOperationHistory(result) {
  const source = result || {};
  const task = source.task || {};
  return {
    task: {
      requestId: task.requestId || "",
      kindText: generationOperationKindText(task.kind),
      statusText: generationOperationStatusText(task.status),
      stage: task.stage || "",
      progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
      attemptCount: Math.max(0, Number(task.attemptCount) || 0),
      errorCode: task.error && task.error.code || "",
      updatedAtText: formatAdminDate(task.updatedAt)
    },
    billing: source.billing || {},
    history: (Array.isArray(source.history) ? source.history : []).map((item) => ({
      atText: formatAdminDate(item.at),
      fromStatusText: item.fromStatus
        ? generationOperationStatusText(item.fromStatus)
        : "初始",
      statusText: generationOperationStatusText(item.status),
      stage: item.stage || "",
      progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
      attemptCount: Math.max(0, Number(item.attemptCount) || 0),
      actor: item.actor || "system",
      code: item.code || ""
    }))
  };
}

function formatAutoFaceFailureStats(result) {
  const source = result || {};
  const probeSource = source.probeSummary || {};
  const probeSummary = Object.assign(emptyAutoFaceFailureStats().probeSummary, {
    total: Number(probeSource.total) || 0,
    ok: Number(probeSource.ok) || 0,
    failed: Number(probeSource.failed) || 0,
    pending: Number(probeSource.pending) || 0,
    notRun: Number(probeSource.notRun) || 0,
    visionConfigured: Number(probeSource.visionConfigured) || 0,
    visionUnavailable: Number(probeSource.visionUnavailable) || 0,
    versions: (Array.isArray(probeSource.versions) ? probeSource.versions : []).map((item) => ({
      buildVersion: item.buildVersion || "未知版本",
      buildMarker: item.buildMarker || "",
      count: Number(item.count) || 0
    }))
  });
  probeSummary.versionText = probeSummary.versions.length
    ? probeSummary.versions
      .map((item) => `${item.buildVersion}${item.count > 1 ? ` (${item.count})` : ""}`)
      .join("、")
    : "暂无";
  return Object.assign(emptyAutoFaceFailureStats(), source, {
    today: Number(source.today) || 0,
    last7d: Number(source.last7d) || 0,
    total30d: Number(source.total30d) || 0,
    eventCount: Number(source.eventCount) || 0,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    probeSummary,
    byType: (Array.isArray(source.byType) ? source.byType : []).map((item) => ({
      type: item.type || "unknown",
      label: item.label || "其他失败",
      count: Number(item.count) || 0,
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    recent: (Array.isArray(source.recent) ? source.recent : []).map((item) => ({
      requestId: item.requestId || "",
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      failureType: item.failureType || "unknown",
      failureTypeLabel: item.failureTypeLabel || item.failureType || "其他失败",
      failureTypeTone: autoFaceFailureTypeTone(item.failureType),
      errorCode: item.errorCode || "unknown",
      message: item.message || "未提供错误摘要",
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable),
      stage: item.stage || "",
      durationMs: Number(item.durationMs) || 0,
      appVersion: item.appVersion || "unknown",
      probeStatus: item.probe && item.probe.status || "not-run",
      probeBuildVersion: item.probe && item.probe.buildVersion || "",
      probeBuildMarker: item.probe && item.probe.buildMarker || "",
      probeVisionConfigured: Boolean(item.probe && item.probe.visionConfigured),
      probeProvider: item.probe && item.probe.provider || "",
      probeModel: item.probe && item.probe.model || "",
      probeSummaryText: formatProbeSummaryText(item.probe),
      createdAtText: formatAdminDate(item.createdAt)
    })),
    details: (Array.isArray(source.details) ? source.details : []).map((item) => ({
      requestId: item.requestId || "",
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      failureType: item.failureType || "unknown",
      failureTypeLabel: item.failureTypeLabel || item.failureType || "其他失败",
      failureTypeTone: autoFaceFailureTypeTone(item.failureType),
      errorCode: item.errorCode || "unknown",
      message: item.message || "未提供错误摘要",
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable),
      stage: item.stage || "",
      durationMs: Number(item.durationMs) || 0,
      appVersion: item.appVersion || "unknown",
      probeStatus: item.probe && item.probe.status || "not-run",
      probeBuildVersion: item.probe && item.probe.buildVersion || "",
      probeBuildMarker: item.probe && item.probe.buildMarker || "",
      probeVisionConfigured: Boolean(item.probe && item.probe.visionConfigured),
      probeProvider: item.probe && item.probe.provider || "",
      probeModel: item.probe && item.probe.model || "",
      probeSummaryText: formatProbeSummaryText(item.probe),
      dateKey: item.dateKey || "",
      monthKey: item.monthKey || String(item.dateKey || "").slice(0, 7),
      createdAtText: formatAdminDate(item.createdAt)
    })),
    daily: (Array.isArray(source.daily) ? source.daily : []).map((item) => ({
      dateKey: item.dateKey || "",
      total: Number(item.total) || 0,
      userCount: Number(item.userCount) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType),
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    monthly: (Array.isArray(source.monthly) ? source.monthly : []).map((item) => ({
      monthKey: item.monthKey || "",
      total: Number(item.total) || 0,
      userCount: Number(item.userCount) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType),
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    users: (Array.isArray(source.users) ? source.users : []).map((item) => ({
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      total: Number(item.total) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    }))
  });
}

function autoFaceFailureTypeTone(type) {
  const value = String(type || "").toLowerCase();
  if (value === "timeout") return "warning";
  if (value === "network" || value === "upstream" || value === "cloud-unavailable") {
    return "danger";
  }
  if (value === "missing-api-key" || value === "empty-face-detection") return "violet";
  if (value === "missing-main-image" || value === "image-too-large") return "info";
  return "neutral";
}

function buildAutoFaceFailureView(stats, requestedMonth = "") {
  const source = stats || emptyAutoFaceFailureStats();
  const currentMonth = String(source.todayKey || "").slice(0, 7);
  const detailSource = Array.isArray(source.details) && source.details.length
    ? source.details
    : source.recent || [];
  const months = Array.from(new Set(
    [currentMonth].concat(
      (Array.isArray(source.monthly) ? source.monthly : []).map((item) => item.monthKey)
    )
  ))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left));
  const selectedMonth = months.includes(requestedMonth) ? requestedMonth : (months[0] || currentMonth);
  const details = detailSource
    .filter((item) => !selectedMonth || item.monthKey === selectedMonth)
    .map((item) => Object.assign({}, item, {
      failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(item.failureType)
    }));
  const daily = (Array.isArray(source.daily) ? source.daily : [])
    .filter((item) => !selectedMonth || String(item.dateKey || "").startsWith(selectedMonth))
    .map((item) => Object.assign({}, item, {
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType)
    }));
  const typeMap = {};
  const userMap = {};
  details.forEach((item) => {
    const type = item.failureType || "unknown";
    if (!typeMap[type]) {
      typeMap[type] = {
        type,
        label: item.failureTypeLabel || "其他失败",
        count: 0,
        lastSeenText: item.createdAtText || "暂无",
        failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(type)
      };
    }
    typeMap[type].count += 1;
    if (!userMap[item.userHash || "anonymous"]) {
      userMap[item.userHash || "anonymous"] = {
        userHash: item.userHash || "anonymous",
        userLabel: item.userLabel || "匿名用户",
        total: 0,
        topFailureType: type,
        topFailureTypeLabel: item.failureTypeLabel || "其他失败",
        failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(type),
        lastSeenText: item.createdAtText || "暂无"
      };
    }
    userMap[item.userHash || "anonymous"].total += 1;
  });
  const users = Object.values(userMap).sort((left, right) => {
    if (right.total !== left.total) return right.total - left.total;
    return left.userHash.localeCompare(right.userHash);
  });
  const byType = Object.values(typeMap).sort((left, right) => right.count - left.count);
  return {
    selectedMonth,
    monthOptions: months,
    monthOptionIndex: Math.max(0, months.indexOf(selectedMonth)),
    total: details.length,
    today: selectedMonth === currentMonth ? Number(source.today) || 0 : 0,
    last7d: selectedMonth === currentMonth ? Number(source.last7d) || 0 : 0,
    byType,
    daily,
    users,
    recent: details.slice(0, 20),
    details,
    monthly: Array.isArray(source.monthly) ? source.monthly : [],
    emptyText: selectedMonth ? `${selectedMonth} 没有自动贴脸失败记录。` : "没有自动贴脸失败记录。"
  };
}

function formatProbeSummaryText(probe = {}) {
  const source = probe || {};
  if (source.status === "ok") {
    const version = source.buildVersion || "未知版本";
    return `探针正常 · ${version} · 视觉配置${source.visionConfigured ? "已就绪" : "未就绪"}`;
  }
  if (source.status === "failed") {
    return `探针失败${source.errorCode ? ` · ${source.errorCode}` : ""}`;
  }
  if (source.status === "pending") return "探针当时仍在返回";
  return "探针未返回";
}

function formatAutoFaceProbe(result, error = null) {
  const source = result || {};
  const failed = Boolean(error) || source.ok === false;
  const vision = source.vision || {};
  const runtime = source.runtime || {};
  const hasClientDuration = Number.isFinite(Number(source.clientDurationMs));
  const hasServerDuration = Number.isFinite(Number(source.durationMs));
  const clientDurationMs = hasClientDuration
    ? Math.max(0, Number(source.clientDurationMs))
    : hasServerDuration
      ? Math.max(0, Number(source.durationMs))
      : 0;
  const serverDurationMs = hasServerDuration
    ? Math.max(0, Number(source.durationMs))
    : 0;
  const probe = Object.assign(emptyAutoFaceProbe(), {
    available: !failed,
    status: failed ? "failed" : "ok",
    statusText: failed
      ? `探针失败${error && error.code ? `：${error.code}` : ""}`
      : "探针正常",
    buildVersion: source.buildVersion || "",
    buildMarker: source.buildMarker || "",
    nodeVersion: runtime.nodeVersion || "",
    cloudEnvConfigured: Boolean(runtime.cloudEnvConfigured),
    visionConfigured: Boolean(vision.configured),
    provider: displayAdminProvider(vision.provider),
    model: displayModelName(vision.model),
    durationMs: clientDurationMs,
    durationText: failed && !hasClientDuration && !hasServerDuration
      ? "未知"
      : `${clientDurationMs} 毫秒`,
    serverDurationMs,
    serverDurationText: hasServerDuration ? `${serverDurationMs} 毫秒` : "未知",
    checkedAtText: source.checkedAt ? formatAdminDate(source.checkedAt) : formatAdminDate(new Date()),
    errorCode: error && (error.code || error.errCode) || "",
    message: error && error.message || ""
  });
  return probe;
}

function modelProbeRepairAdvice(status, httpStatus) {
  switch (String(status || "")) {
    case "not-configured":
      return "补齐 Provider、接口地址、API Key 和模型后再测试。";
    case "auth-failed":
      return "重新填写 API Key，并确认这个 Key 有读取模型的权限。";
    case "model-not-listed":
      return "点击“获取模型”，重新读取后选择列表里的模型。";
    case "endpoint-not-supported":
      return "把接口地址改成兼容接口根地址（通常以 /v1 结尾），不要填聊天完成地址。";
    case "upstream-error":
      return httpStatus
        ? `检查服务商状态，确认 HTTP ${httpStatus} 不是临时故障。`
        : "检查服务商状态和接口返回内容。";
    case "network-error":
      return "检查域名、接口地址、网络和服务是否在线。";
    default:
      return status ? "检查接口地址、API Key 和模型名称后重试。" : "";
  }
}

function emptyTencentFaceFusionStatus() {
  return {
    configured: false,
    readFailed: false,
    statusText: "未就绪",
    secretId: "未配置",
    secretKey: "未配置",
    region: "ap-guangzhou",
    endpoint: "https://facefusion.tencentcloudapi.com",
    model: "FuseFaceUltra",
    apiVersion: "2022-09-27",
    action: "FuseFaceUltra",
    swapModelType: 4,
    logoAdd: false,
    logoAddText: "关闭",
    timeoutMs: 75000,
    timeoutText: "75000 ms",
    maxImageBytes: 5 * 1024 * 1024,
    maxImageBytesText: "5 MB",
    lastCallStatus: "not-called",
    lastCallStatusText: "尚未调用",
    lastCallStage: "",
    lastCallStageText: "暂无",
    lastErrorCode: "",
    lastErrorMessage: "",
    lastRequestId: "",
    lastDurationMs: 0,
    lastDurationText: "暂无",
    lastTestType: "",
    lastCalledAt: "",
    lastCallTimestamp: 0,
    checkedAt: ""
  };
}

function tencentFaceFusionCallStatusText(value) {
  const status = String(value || "not-called").trim().toLowerCase();
  const labels = {
    "not-called": "尚未调用",
    processing: "调用中",
    succeeded: "调用成功",
    failed: "调用失败",
    unavailable: "读取失败",
    refunded: "失败并已退回额度"
  };
  return labels[status] || status || "尚未调用";
}

function tencentFaceFusionStageText(value) {
  const stage = String(value || "").trim().toLowerCase();
  const labels = {
    facefusion: "腾讯人脸融合",
    succeeded: "已完成",
    failed: "调用失败",
    processing: "处理中"
  };
  return labels[stage] || stage || "暂无";
}

function formatTencentImageBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "未配置";
  const megabytes = bytes / 1024 / 1024;
  const display = Number.isInteger(megabytes)
    ? String(megabytes)
    : megabytes.toFixed(2).replace(/\.00$/, "").replace(/0$/, "");
  return `${bytes} 字节（${display} MB）`;
}

function formatTencentAdminDate(value, fallback = "") {
  const text = String(value || "").trim();
  if (!text) return fallback;
  if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(text)) return text;
  return formatAdminDate(value);
}

function formatTencentFaceFusionStatus(result) {
  const source = result && typeof result === "object" ? result : {};
  const configured = Boolean(source.configured);
  const readFailed = Boolean(source.readFailed);
  const timeoutMs = Math.max(0, Number(source.timeoutMs) || 0);
  const maxImageBytes = Math.max(0, Number(source.maxImageBytes) || 0);
  const lastDurationMs = Math.max(0, Number(source.lastDurationMs) || 0);
  return Object.assign(emptyTencentFaceFusionStatus(), {
    configured,
    readFailed,
    statusText: readFailed ? "读取失败" : configured ? "正常" : "未就绪",
    secretId: String(source.secretId || "未配置"),
    secretKey: String(source.secretKey || "未配置"),
    region: String(source.region || "ap-guangzhou"),
    endpoint: String(source.endpoint || "https://facefusion.tencentcloudapi.com"),
    model: String(source.model || "FuseFaceUltra"),
    apiVersion: String(source.apiVersion || "2022-09-27"),
    action: String(source.action || "FuseFaceUltra"),
    swapModelType: Number(source.swapModelType) || 4,
    logoAdd: Boolean(source.logoAdd),
    logoAddText: source.logoAdd ? "开启" : "关闭",
    timeoutMs,
    timeoutText: timeoutMs ? `${timeoutMs} ms` : "未配置",
    maxImageBytes,
    maxImageBytesText: formatTencentImageBytes(maxImageBytes),
    lastCallStatus: String(source.lastCallStatus || "not-called"),
    lastCallStatusText: tencentFaceFusionCallStatusText(source.lastCallStatus),
    lastCallStage: String(source.lastCallStage || ""),
    lastCallStageText: tencentFaceFusionStageText(source.lastCallStage),
    lastErrorCode: String(source.lastErrorCode || ""),
    lastErrorMessage: String(source.lastErrorMessage || ""),
    lastRequestId: String(source.lastRequestId || ""),
    lastDurationMs,
    lastDurationText: lastDurationMs ? `${lastDurationMs} ms` : "暂无",
    lastTestType: String(source.lastTestType || ""),
    lastCalledAt: formatTencentAdminDate(source.lastCalledAt, "暂无调用"),
    lastCallTimestamp: Number(source.lastCallTimestamp)
      || (source.lastCalledAt ? Date.parse(source.lastCalledAt) : 0)
      || 0,
    checkedAt: formatTencentAdminDate(source.checkedAt)
  });
}

function readTencentFaceFusionLocalStatus() {
  try {
    const value = wx.getStorageSync(TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY);
    if (!value || typeof value !== "object") return null;
    return Object.assign(emptyTencentFaceFusionStatus(), value);
  } catch (error) {
    return null;
  }
}

function saveTencentFaceFusionLocalStatus(status) {
  try {
    const source = status && typeof status === "object" ? status : {};
    wx.setStorageSync(
      TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY,
      {
        lastCallStatus: String(source.lastCallStatus || "not-called"),
        lastCallStage: String(source.lastCallStage || ""),
        lastErrorCode: String(source.lastErrorCode || ""),
        lastErrorMessage: String(source.lastErrorMessage || ""),
        lastRequestId: String(source.lastRequestId || ""),
        lastDurationMs: Number(source.lastDurationMs) || 0,
        lastTestType: String(source.lastTestType || ""),
        lastCalledAt: String(source.lastCalledAt || ""),
        lastCallTimestamp: Number(source.lastCallTimestamp) || 0,
        checkedAt: new Date().toISOString()
      }
    );
  } catch (error) {
    diagnosticLog.warn(
      "admin",
      "tencent-facefusion-local-status-save-failed",
      "腾讯测试状态本地保存失败",
      { error }
    );
  }
}

function mergeTencentFaceFusionStatus(remoteStatus) {
  const remote = formatTencentFaceFusionStatus(remoteStatus);
  const local = formatTencentFaceFusionStatus(readTencentFaceFusionLocalStatus());
  if (!local || !local.lastCallTimestamp) return remote;
  if (
    !remote.lastCallTimestamp
    || local.lastCallTimestamp > remote.lastCallTimestamp
  ) {
    return Object.assign({}, local, {
      configured: remote.configured,
      readFailed: remote.readFailed,
      statusText: remote.statusText,
      secretId: remote.secretId,
      secretKey: remote.secretKey,
      region: remote.region,
      endpoint: remote.endpoint,
      model: remote.model,
      apiVersion: remote.apiVersion,
      action: remote.action,
      swapModelType: remote.swapModelType,
      logoAdd: remote.logoAdd,
      logoAddText: remote.logoAddText,
      timeoutMs: remote.timeoutMs,
      timeoutText: remote.timeoutText,
      maxImageBytes: remote.maxImageBytes,
      maxImageBytesText: remote.maxImageBytesText,
      checkedAt: remote.checkedAt
    });
  }
  return remote;
}

function buildTencentFaceFusionLocalStatus(result, requestId, status, errorMessage = "") {
  const now = Date.now();
  return Object.assign(emptyTencentFaceFusionStatus(), {
    configured: true,
    region: String(result && result.region || ""),
    model: String(result && result.model || "FuseFaceUltra"),
    lastCallStatus: status,
    lastCallStage: status === "succeeded" ? "succeeded" : "facefusion",
    lastErrorMessage: String(errorMessage || ""),
    lastRequestId: String(requestId || ""),
    lastDurationMs: Number(result && result.durationMs) || 0,
    lastTestType: "admin-real-call",
    lastCalledAt: new Date(now).toISOString(),
    lastCallTimestamp: now,
    checkedAt: new Date(now).toISOString()
  });
}

function emptyImageEditCapabilityProbe() {
  return {
    checked: false,
    ready: false,
    tone: "neutral",
    status: "not-run",
    statusText: "尚未检查",
    provider: "未配置",
    model: "未配置",
    editEndpoint: "未配置",
    endpointSource: "",
    requestFormat: "",
    requestFormatText: "未识别",
    mainField: "",
    maskField: "",
    referenceField: "",
    maskInvertText: "关闭",
    apiKeyStatusText: "未配置",
    liveVerified: false,
    liveVerifiedText: "未真实生图",
    billingRiskText: "不扣费",
    message: "点击后只核对配置，不会调用生图，也不能证明上游已经支持 mask 像素合成。",
    checkedAt: ""
  };
}

function formatImageEditCapabilityProbe(result) {
  const source = result && result.probe && typeof result.probe === "object"
    ? result.probe
    : result && typeof result === "object"
      ? result
      : {};
  const fields = source.fields && typeof source.fields === "object" ? source.fields : {};
  const ready = Boolean(source.configured);
  const status = String(source.status || (ready ? "config-ready" : "not-configured"));
  return Object.assign(emptyImageEditCapabilityProbe(), {
    checked: true,
    ready,
    tone: ready ? "ready" : "error",
    status,
    statusText: String(source.statusText || (ready ? "图片编辑配置完整" : "图片编辑配置不完整")),
    provider: displayAdminProvider(source.provider, "未配置"),
    model: String(source.model || "未配置"),
    editEndpoint: String(source.editEndpoint || "未配置"),
    endpointSource: String(source.endpointSource || ""),
    requestFormat: String(source.requestFormat || ""),
    requestFormatText: source.requestFormat === "lingyun-json"
      ? "凌云 JSON"
      : source.requestFormat === "multipart"
        ? "multipart/form-data"
        : "未识别",
    mainField: String(fields.mainImage || ""),
    maskField: String(fields.mask || ""),
    referenceField: String(fields.references || ""),
    maskInvertText: source.maskInvert ? "已开启" : "关闭",
    apiKeyStatusText: source.apiKeyConfigured ? "已配置（不显示内容）" : "未配置",
    liveVerified: Boolean(source.liveVerified),
    liveVerifiedText: source.liveVerified ? "已真实验证" : "未真实生图",
    billingRiskText: source.billingRisk ? "可能扣费" : "不扣费",
    message: String(
      source.message
      || "本次只核对配置，不代表上游已经实测支持图片编辑和 mask。"
    ),
    checkedAt: source.checkedAt ? formatAdminDate(source.checkedAt) : ""
  });
}

function emptyImageQualityProbe() {
  return {
    available: false,
    source: "custom",
    sourceText: "未识别",
    status: "unknown",
    statusText: "上游没有返回清晰度能力",
    safe: true,
    noGeneration: true,
    values: IMAGE_QUALITY_OPTIONS.map((item) => ({
      value: item.value,
      label: item.label,
      status: "unknown",
      statusText: "未识别"
    })),
    summaryText: "未识别"
  };
}

function formatImageQualityProbe(source = {}) {
  const raw = source && typeof source === "object" ? source : {};
  const sourceText = raw.source === "upstream"
    ? "上游能力"
    : raw.source === "known-model-rule"
      ? "已知模型规则"
      : "未识别";
  const rawValues = Array.isArray(raw.values) ? raw.values : [];
  const values = IMAGE_QUALITY_OPTIONS.map((option) => {
    const item = rawValues.find((entry) => (
      String(entry && entry.value || "").toUpperCase() === option.value
    )) || {};
    const status = ["supported", "unsupported", "unknown"].includes(item.status)
      ? item.status
      : "unknown";
    return {
      value: option.value,
      label: option.label,
      status,
      statusText: status === "supported"
        ? "支持"
        : status === "unsupported"
          ? "不支持"
          : "未识别"
    };
  });
  const supported = values
    .filter((item) => item.status === "supported")
    .map((item) => item.value);
  const status = raw.status === "ok" || raw.status === "partial"
    || raw.status === "unsupported" || raw.status === "unknown"
    ? raw.status
    : "unknown";
  return {
    available: Boolean(raw.source || raw.values),
    source: raw.source || "custom",
    sourceText,
    status,
    statusText: raw.statusText || (
      status === "ok"
        ? "1K、2K、4K 全部支持"
        : status === "partial"
          ? `支持：${supported.join("、")}`
          : status === "unsupported"
            ? "未发现可用清晰度"
            : "上游没有返回清晰度能力"
    ),
    safe: raw.safe !== false,
    noGeneration: raw.noGeneration !== false,
    values,
    summaryText: status === "ok"
      ? "1K、2K、4K 全部支持"
      : status === "partial"
        ? `支持：${supported.join("、")}`
        : status === "unsupported"
          ? "未发现可用清晰度"
          : "未识别"
  };
}

function formatModelProbes(result, error = null) {
  const source = result || {};
  const failed = Boolean(error) || source.ok === false && !Array.isArray(source.results);
  const results = (Array.isArray(source.results) ? source.results : []).map((item) => ({
    type: item.type || "",
    typeLabel: item.typeLabel || usageTypeLabel(item.type),
    provider: displayAdminProvider(item.provider, "未填写"),
    modelId: String(item.model || ""),
    model: displayModelName(item.model),
    configured: Boolean(item.configured),
    ready: Boolean(item.ready),
    reachable: Boolean(item.reachable),
    status: item.status || "network-error",
    statusText: item.statusText || (item.ready ? "正常" : "需要处理"),
    httpStatus: Number(item.httpStatus) || 0,
    durationMs: Number(item.durationMs) || 0,
    durationText: `${Number(item.durationMs) || 0} 毫秒`,
    endpoint: item.endpoint || "",
    capabilities: item.capabilities && typeof item.capabilities === "object"
      ? item.capabilities
      : { source: "custom", resolutions: [] },
    qualityProbe: item.type === "image"
      ? formatImageQualityProbe(item.qualityProbe)
      : null,
    message: item.message || "",
    repairAdvice: item.ready
      ? ""
      : modelProbeRepairAdvice(item.status, Number(item.httpStatus) || 0)
  }));
  const readyCount = Number(source.readyCount);
  const total = Number(source.total) || 4;
  const normalizedReadyCount = Number.isFinite(readyCount)
    ? readyCount
    : results.filter((item) => item.ready).length;
  return Object.assign(emptyModelProbes(), {
    available: !failed,
    status: failed ? "failed" : normalizedReadyCount === total ? "ok" : "warn",
    statusText: failed
      ? `探测失败${error && error.code ? `：${error.code}` : ""}`
      : `${normalizedReadyCount}/${total} 套正常`,
    buildVersion: source.buildVersion || "",
    buildMarker: source.buildMarker || "",
    checkedAtText: source.checkedAt ? formatAdminDate(source.checkedAt) : formatAdminDate(new Date()),
    readyCount: normalizedReadyCount,
    total,
    results,
    message: error && error.message || source.message || ""
  });
}

function mergeSingleModelProbe(current, incoming, modelType) {
  const previous = current || emptyModelProbes();
  const next = incoming || emptyModelProbes();
  const byType = {};
  (Array.isArray(previous.results) ? previous.results : []).forEach((item) => {
    if (item && item.type) byType[item.type] = item;
  });
  (Array.isArray(next.results) ? next.results : []).forEach((item) => {
    if (item && item.type) byType[item.type] = item;
  });
  const results = USAGE_TYPE_META
    .map((item) => byType[item.key])
    .filter(Boolean);
  const readyCount = results.filter((item) => item.ready).length;
  const target = byType[modelType] || next.results && next.results[0] || null;
  const total = results.length;
  return Object.assign(emptyModelProbes(), previous, next, {
    available: true,
    status: total > 0 && readyCount === total ? "ok" : "warn",
    statusText: target
      ? `${target.typeLabel}：${target.statusText}`
      : `${readyCount}/${total} 套正常`,
    readyCount,
    total,
    results
  });
}

function formatAutoFaceProbeHistory(result) {
  const source = result || {};
  const history = Array.isArray(source.history) ? source.history : [];
  return Object.assign(emptyAutoFaceProbeHistory(), {
    retentionDays: Number(source.retentionDays) || 30,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    message: source.message || "",
    history: history.map((item) => ({
      status: item.status === "ok" ? "ok" : "failed",
      statusText: item.status === "ok" ? "探针正常" : "探针失败",
      buildVersion: item.buildVersion || "未知版本",
      buildMarker: item.buildMarker || "",
      nodeVersion: item.nodeVersion || "",
      visionConfigured: Boolean(item.visionConfigured),
      provider: displayAdminProvider(item.provider, "未知"),
      model: displayModelName(item.model),
      durationMs: Number(item.durationMs) || 0,
      durationText: `云函数 ${Number(item.durationMs) || 0} 毫秒`,
      errorCode: item.errorCode || "",
      checkedAt: item.checkedAt || "",
      checkedAtText: item.checkedAt ? formatAdminDate(item.checkedAt) : "未知时间"
    }))
  });
}

function buildDashboardStatus(
  effective,
  autoFaceProbe,
  autoFaceProbeHistory
) {
  const face = effective && effective.face || {};
  const analysis = effective && effective.analysis || {};
  const image = effective && effective.image || {};
  const video = effective && effective.video || {};
  const configReady = Boolean(
    face.apiKeyConfigured
    && face.provider
    && face.model
    && analysis.apiKeyConfigured
    && analysis.provider
    && analysis.model
    && image.apiKeyConfigured
    && image.provider
    && image.model
    && video.apiKeyConfigured
    && video.provider
    && video.model
  );
  const currentProbe = autoFaceProbe || emptyAutoFaceProbe();
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestHistory = history[0] || null;
  const probeStatus = currentProbe.status && currentProbe.status !== "not-run"
    ? currentProbe.status
    : latestHistory
      ? latestHistory.status
      : "not-run";
  const probeDurationText = currentProbe.status && currentProbe.status !== "not-run"
    && currentProbe.durationText
    && currentProbe.durationText !== "未知"
    ? currentProbe.durationText
    : latestHistory && latestHistory.durationText
      ? latestHistory.durationText.replace(/^云函数\s*/, "")
      : "未检查";
  if (!configReady) {
    return {
      tone: "warn",
      title: "配置未完成",
      probeDurationText
    };
  }
  if (probeStatus === "failed") {
    return {
      tone: "warn",
      title: "探针异常",
      probeDurationText
    };
  }
  if (probeStatus === "ok") {
    return {
      tone: "ok",
      title: "全部正常",
      probeDurationText
    };
  }
  return {
    tone: "neutral",
    title: "配置已就绪",
    probeDurationText
  };
}

function buildFaceConfigSummary(
  effective,
  autoFaceProbe,
  autoFaceProbeHistory
) {
  const face = effective && effective.face || {};
  const currentProbe = autoFaceProbe || {};
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestHistory = history[0] || {};
  const provider = displayAdminProvider(face.provider
    || currentProbe.provider
    || latestHistory.provider
    || "未读取");
  const model = pickModelName(face.model, currentProbe.model, latestHistory.model);
  const ready = Boolean(
    face.apiKeyConfigured
    || currentProbe.visionConfigured
    || latestHistory.visionConfigured
  );
  return {
    provider,
    model,
    ready
  };
}

function emptyAnalysisConfigSummary() {
  return {
    provider: "未读取",
    model: "未配置",
    ready: false
  };
}

function buildAnalysisConfigSummary(effective) {
  const analysis = effective && effective.analysis || {};
  return {
    provider: displayAdminProvider(analysis.provider, "未读取"),
    model: displayModelName(analysis.model),
    ready: Boolean(
      analysis.apiKeyConfigured
      && analysis.provider
      && analysis.model
    )
  };
}

function formatUsageStats(result) {
  const source = result || {};
  const summary = source.summary || {};
  const models = Array.isArray(source.models) ? source.models : [];
  const cards = USAGE_TYPE_META.map((meta) => {
    const counter = formatUsageCounter(summary[meta.key]);
    const modelNames = models
      .filter((item) => item.usageType === meta.key)
      .map((item) => displayModelName(item.model))
      .filter((item, index, list) => list.indexOf(item) === index)
    const modelText = modelNames.join("、") || "未配置";
    const modelLines = modelNames.length ? modelNames : ["未配置"];
    return Object.assign({}, meta, counter, { modelText, modelLines });
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    image: formatUsageCounter(item.image),
    analysis: formatUsageCounter(item.analysis),
    face: formatUsageCounter(item.face),
    video: formatUsageCounter(item.video)
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    image: formatUsageCounter(item.image),
    analysis: formatUsageCounter(item.analysis),
    face: formatUsageCounter(item.face),
    video: formatUsageCounter(item.video)
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    byType: item.byType || {}
  }));
  const formattedModels = models.map((item) => Object.assign({}, item, {
    provider: displayAdminProvider(item.provider),
    modelDisplay: displayModelName(item.model),
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost)
  }));
  const failureSource = source.failureStats || {};
  const failureStats = Object.assign(emptyFailureStats(), {
    total: Number(failureSource.total) || 0,
    failureRate: Number(failureSource.failureRate) || 0,
    monthly: (Array.isArray(failureSource.monthly) ? failureSource.monthly : []).map((item) => ({
      monthKey: item.monthKey || "",
      total: Number(item.total) || 0,
      success: Number(item.success) || 0,
      failure: Number(item.failure) || 0,
      userCount: Number(item.userCount) || 0
    })),
    users: (Array.isArray(failureSource.users) ? failureSource.users : []).map((item) => ({
      userHash: item.userHash || "anonymous",
      total: Number(item.total) || 0,
      lastSeen: item.lastSeen || "",
      topFailureReason: item.topFailureReason || "未提供错误原因",
      topFailureCode: item.topFailureCode || "",
      topFailureStatus: Number(item.topFailureStatus) || 0
    })),
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
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
      provider: displayAdminProvider(item.provider),
      model: item.model || "",
      modelDisplay: displayModelName(item.model),
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable)
    })),
    failedModels: (Array.isArray(failureSource.failedModels)
      ? failureSource.failedModels
      : []
    ).map((item) => ({
      usageType: item.usageType || "",
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
      provider: displayAdminProvider(item.provider, "未知服务商"),
      model: item.model || "未知模型",
      modelDisplay: displayModelName(item.model),
      modelDisplayZh: displayModelNameZh(item.model, item.usageType),
      total: Number(item.total) || 0,
      failure: Number(item.failure) || 0,
      failureRate: Number(item.failureRate) || 0
    })),
    failureDetails: (Array.isArray(failureSource.failureDetails)
      ? failureSource.failureDetails
      : []
    ).map((item) => ({
      dateKey: item.dateKey || "",
      monthKey: item.monthKey || String(item.dateKey || "").slice(0, 7),
      createdAt: item.createdAt || "",
      createdAtText: formatAdminDate(item.createdAt || item.dateKey),
      userHash: item.userHash || "anonymous",
      usageType: item.usageType || "unknown",
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
      provider: displayAdminProvider(item.provider, "未知服务商"),
      model: item.model || "未知模型",
      modelDisplay: displayModelName(item.model),
      modelDisplayZh: displayModelNameZh(item.model, item.usageType),
      requestId: item.requestId || "",
      errorCode: item.errorCode || "unknown",
      errorCodeLabel: modelErrorCodeLabel(item.errorCode),
      errorMessage: String(item.errorMessage || "未提供错误摘要").slice(0, 500),
      errorMessageZh: modelErrorMessageLabel(item.errorMessage),
      errorStatus: Number(item.errorStatus) || 0,
      retryable: Boolean(item.retryable),
      attempt: Math.max(1, Number(item.attempt) || 1),
      durationMs: Math.max(0, Number(item.durationMs) || 0)
    }))
  });
  failureStats.details = failureStats.failureDetails;
  return Object.assign(emptyUsageStats(), source, {
    today: formatUsageCounter(source.today),
    last7d: formatUsageCounter(source.last7d),
    last30d: formatUsageCounter(source.last30d),
    cards,
    daily,
    monthly,
    users,
    models: formattedModels,
    failureStats
  });
}

function modelFailureReasonKey(item = {}) {
  if (item.errorCode) return `code:${item.errorCode}`;
  if (item.errorStatus) return `http:${item.errorStatus}`;
  if (item.errorMessage) return `message:${item.errorMessage}`;
  return "unknown";
}

function modelFailureReasonLabel(item = {}) {
  if (item.errorMessage && item.errorCode) {
    return `${modelErrorCodeLabel(item.errorCode)}：${modelErrorMessageLabel(item.errorMessage)}`;
  }
  if (item.errorMessage) return modelErrorMessageLabel(item.errorMessage);
  if (item.errorCode) return modelErrorCodeLabel(item.errorCode);
  if (item.errorStatus) return `状态码 ${item.errorStatus}`;
  return "未提供错误原因";
}

function modelFailureTone(item = {}) {
  const code = String(item.errorCode || "").toLowerCase();
  const message = String(item.errorMessage || "").toLowerCase();
  const status = Number(item.errorStatus) || 0;
  if (
    status === 408
    || status === 504
    || /timeout|timed-out|deadline|超时/.test(`${code} ${message}`)
  ) {
    return "warning";
  }
  if (
    status === 401
    || status === 403
    || /api.?key|auth|config|probe|missing|invalid|鉴权|配置|探针/.test(`${code} ${message}`)
  ) {
    return "violet";
  }
  if (
    status >= 500
    || status === 429
    || /network|upstream|provider|gateway|rate-limit|接口|网络|供应商/.test(`${code} ${message}`)
  ) {
    return "danger";
  }
  return "neutral";
}

function buildModelFailureView(stats, requestedMonth = "") {
  const source = Object.assign(emptyFailureStats(), stats || {});
  const detailSource = Array.isArray(source.details) && source.details.length
    ? source.details
    : (Array.isArray(source.failureDetails) ? source.failureDetails : []);
  const monthOptions = Array.from(new Set(
    (Array.isArray(source.monthly) ? source.monthly : [])
      .map((item) => String(item.monthKey || ""))
      .concat(detailSource.map((item) => String(
        item.monthKey || String(item.dateKey || "").slice(0, 7)
      )))
  ))
    .filter((item) => /^\d{4}-\d{2}$/.test(item))
    .sort((left, right) => right.localeCompare(left));
  const selectedMonth = monthOptions.includes(requestedMonth)
    ? requestedMonth
    : (monthOptions[0] || String(source.todayKey || "").slice(0, 7));
  const details = detailSource
    .filter((item) => {
      const monthKey = item.monthKey || String(item.dateKey || "").slice(0, 7);
      return !selectedMonth || monthKey === selectedMonth;
    })
    .map((item) => Object.assign({}, item, {
      userHash: item.userHash || "anonymous",
      modelDisplay: pickModelName(item.model, item.modelDisplay),
      modelDisplayZh: displayModelNameZh(item.model, item.usageType),
      errorCodeLabel: modelErrorCodeLabel(item.errorCode),
      errorMessageZh: modelErrorMessageLabel(item.errorMessage),
      failureTone: modelFailureTone(item),
      failureReasonLabel: modelFailureReasonLabel(item)
    }))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const reasonMap = {};
  const userMap = {};
  const modelMap = {};
  details.forEach((item) => {
    const reasonKey = modelFailureReasonKey(item);
    if (!reasonMap[reasonKey]) {
      reasonMap[reasonKey] = {
        key: reasonKey,
        code: item.errorCode || "",
        label: modelFailureReasonLabel(item),
        count: 0,
        lastSeen: item.createdAt || "",
        usageType: item.usageType || "",
        usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
         provider: displayAdminProvider(item.provider),
         model: item.model || "",
         modelDisplay: pickModelName(item.model, item.modelDisplay),
         modelDisplayZh: displayModelNameZh(item.model, item.usageType),
         status: Number(item.errorStatus) || 0,
        failureTone: modelFailureTone(item)
      };
    }
    reasonMap[reasonKey].count += 1;
    if (String(item.createdAt || "") > String(reasonMap[reasonKey].lastSeen || "")) {
      reasonMap[reasonKey].lastSeen = item.createdAt;
    }
    const userHash = item.userHash || "anonymous";
    if (!userMap[userHash]) {
      userMap[userHash] = {
        userHash,
        total: 0,
        lastSeen: item.createdAt || "",
        topFailureReason: modelFailureReasonLabel(item),
        topFailureCode: item.errorCode || "",
        topFailureStatus: Number(item.errorStatus) || 0,
        reasonMap: {}
      };
    }
    userMap[userHash].total += 1;
    if (String(item.createdAt || "") > String(userMap[userHash].lastSeen || "")) {
      userMap[userHash].lastSeen = item.createdAt;
    }
    userMap[userHash].reasonMap[reasonKey] = (userMap[userHash].reasonMap[reasonKey] || 0) + 1;
    const modelKey = [
      item.usageType || "unknown",
      item.provider || "未知 Provider",
      displayModelName(item.model)
    ].join("|");
    if (!modelMap[modelKey]) {
      modelMap[modelKey] = {
        usageType: item.usageType || "unknown",
        usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
         provider: displayAdminProvider(item.provider, "未知服务商"),
         model: item.model || "未知模型",
         modelDisplay: displayModelName(item.model),
         modelDisplayZh: displayModelNameZh(item.model, item.usageType),
         failure: 0
      };
    }
    modelMap[modelKey].failure += 1;
  });
  const selectedMonthMeta = (Array.isArray(source.monthly) ? source.monthly : [])
    .find((item) => item.monthKey === selectedMonth);
  const failureTotal = details.length;
  const total = Number(selectedMonthMeta && selectedMonthMeta.total) || failureTotal;
  const success = Math.max(0, total - failureTotal);
  const topFailureReasons = Object.values(reasonMap)
    .map((item) => Object.assign({}, item, {
      rate: failureTotal ? Number((item.count / failureTotal * 100).toFixed(2)) : 0,
      lastSeenText: formatAdminDate(item.lastSeen)
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
  const users = Object.values(userMap)
    .map((item) => {
      const topReasonKey = Object.entries(item.reasonMap)
        .sort((left, right) => right[1] - left[1])[0];
      const topReason = topReasonKey ? reasonMap[topReasonKey[0]] : null;
      return Object.assign({}, item, {
        topFailureReason: topReason ? topReason.label : item.topFailureReason,
        topFailureCode: topReason ? topReason.code : item.topFailureCode,
        topFailureStatus: topReason ? topReason.status : item.topFailureStatus,
        failureTone: topReason ? topReason.failureTone : "neutral",
        lastSeenText: formatAdminDate(item.lastSeen)
      });
    })
    .sort((left, right) => right.total - left.total);
  const failedModels = Object.values(modelMap)
    .sort((left, right) => right.failure - left.failure)
    .slice(0, 5);
  return {
    selectedMonth,
    monthOptions,
    monthIndex: Math.max(0, monthOptions.indexOf(selectedMonth)),
    total: failureTotal,
    totalCalls: total,
    success,
    successRate: total ? Number((success / total * 100).toFixed(2)) : 0,
    failureRate: total ? Number((failureTotal / total * 100).toFixed(2)) : 0,
    topFailureReasons,
    failedModels,
    users,
    details,
    emptyText: selectedMonth
      ? `${selectedMonth} 没有模型失败记录。`
      : "最近统计范围内没有失败记录。"
  };
}

function diagnosticLevelText(level) {
  if (level === "error") return "错误";
  if (level === "warn") return "提醒";
  return "正常";
}

function diagnosticDetailsText(value) {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000);
  } catch (_) {
    return String(value).slice(0, 2000);
  }
}

function formatAdminDiagnosticLogs(result, previousLogs = []) {
  const source = result || {};
  const previousExpanded = {};
  (Array.isArray(previousLogs) ? previousLogs : []).forEach((item) => {
    if (item && item.eventId) previousExpanded[item.eventId] = Boolean(item.expanded);
  });
  const summarySource = source.summary || {};
  return Object.assign(emptyAdminDiagnosticLogs(), source, {
    retentionHours: Number(source.retentionHours) || 72,
    hours: Number(source.hours) || 72,
    summary: {
      total: Number(summarySource.total) || 0,
      errorCount: Number(summarySource.errorCount) || 0,
      warnCount: Number(summarySource.warnCount) || 0,
      infoCount: Number(summarySource.infoCount) || 0,
      userCount: Number(summarySource.userCount) || 0,
      categories: Array.isArray(summarySource.categories) ? summarySource.categories : []
    },
    userOptions: [{ value: "", label: "全部用户" }].concat(
      (Array.isArray(source.userOptions) ? source.userOptions : []).map((item) => ({
        value: item.value || "",
        label: item.label || `用户 ${item.value || ""}`
      }))
    ),
    logs: (Array.isArray(source.logs) ? source.logs : []).map((item) => {
      const detailsText = diagnosticDetailsText(item.details);
      const errorText = diagnosticDetailsText(item.error);
      return {
        eventId: item.eventId || `${item.sessionId || "session"}-${item.sequence || 0}`,
        userHash: item.userHash || "anonymous",
        appVersion: item.appVersion || "未知",
        level: item.level || "info",
        levelText: diagnosticLevelText(item.level),
        category: item.category || "other",
        categoryLabel: item.categoryLabel || "其他",
        event: item.event || "",
        message: item.message || "未提供日志说明",
        route: item.route || "",
        step: item.step || "",
        requestId: item.requestId || "",
        code: item.code || "",
        durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null,
        durationText: Number.isFinite(Number(item.durationMs))
          ? `${Number(item.durationMs)} 毫秒`
          : "未记录",
        detailsText,
        errorText,
        hasDetails: Boolean(detailsText || errorText),
        expanded: Boolean(previousExpanded[item.eventId]),
        createdAt: item.createdAt || "",
        createdAtText: item.createdAt ? formatAdminDate(item.createdAt) : "未知时间"
      };
    }),
    nextOffset: source.nextOffset === null || source.nextOffset === undefined
      ? null
      : Math.max(0, Number(source.nextOffset) || 0),
    eventCount: Number(source.eventCount) || 0,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    message: source.message || ""
  });
}

function formatUserSignupTrend(items = []) {
  const days = (Array.isArray(items) ? items : []).map((item) => {
    const dateKey = String(item && item.dateKey || "");
    const dateParts = dateKey.slice(5).split("-");
    return {
      dateKey,
      label: dateParts.length === 2
        ? `${Number(dateParts[0])}/${Number(dateParts[1])}`
        : dateKey,
      count: Math.max(0, Number(item && item.count) || 0)
    };
  });
  let maxCount = 0;
  days.forEach((item) => {
    maxCount = Math.max(maxCount, item.count);
  });
  return days.map((item) => Object.assign({}, item, {
    barPercent: item.count && maxCount
      ? Math.max(14, Math.round(item.count / maxCount * 100))
      : 0
  }));
}

function formatUserStats(result, previousUsers = []) {
  const source = result || {};
  const incoming = (Array.isArray(source.users) ? source.users : []).map((item) => ({
    userHash: item.userHash || "anonymous",
    nickname: item.nickname || "未填写昵称",
    avatarUrl: item.avatarUrl || item.avatarFileID || "",
    gender: item.gender === "female" ? "female" : "male",
    genderText: item.gender === "female" ? "女" : "男",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    createdAtText: item.createdAt ? formatAdminDate(item.createdAt) : "未知时间",
    updatedAtText: item.updatedAt ? formatAdminDate(item.updatedAt) : "暂无修改记录"
  }));
  const users = Number(source.offset) > 0
    ? previousUsers.concat(incoming).filter((item, index, list) => (
      list.findIndex((candidate) => candidate.userHash === item.userHash) === index
    ))
    : incoming;
  const signupTrend = formatUserSignupTrend(source.signupTrend);
  return Object.assign(emptyUserStats(), {
    total: Number(source.total) || 0,
    maleCount: Number(source.maleCount) || 0,
    femaleCount: Number(source.femaleCount) || 0,
    maleRatio: Number(source.maleRatio) || 0,
    femaleRatio: Number(source.femaleRatio) || 0,
    users,
    search: String(source.search || ""),
    dateRange: String(source.dateRange || "all"),
    gender: String(source.gender || "all"),
    startDate: String(source.startDate || ""),
    endDate: String(source.endDate || ""),
    signupTrend,
    signupTrendTotal: signupTrend.reduce((total, item) => total + item.count, 0),
    nextOffset: source.nextOffset === null || source.nextOffset === undefined
      ? null
      : Math.max(0, Number(source.nextOffset) || 0)
  });
}

function dateKeyShift(dateKey, offset) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const source = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date();
  source.setUTCDate(source.getUTCDate() + Number(offset || 0));
  return source.toISOString().slice(0, 10);
}

function shanghaiTodayDateKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildUserStatsFilters(data = {}) {
  const custom = data.userDateRange === "custom";
  return {
    search: String(data.userSearch || ""),
    dateRange: String(data.userDateRange || "all"),
    gender: String(data.userGender || "all"),
    startDate: custom ? String(data.userCustomStartDate || "") : "",
    endDate: custom ? String(data.userCustomEndDate || "") : ""
  };
}

function buildCostTrend(usageStats) {
  const source = usageStats || emptyUsageStats();
  const todayKey = source.todayKey || new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const costByDate = {};
  (Array.isArray(source.daily) ? source.daily : []).forEach((item) => {
    costByDate[item.dateKey] = Math.max(0, Number(item.estimatedCost) || 0);
  });
  const days = [];
  for (let index = -6; index <= 0; index += 1) {
    const dateKey = dateKeyShift(todayKey, index);
    days.push({
      dateKey,
      label: dateKey.slice(5),
      cost: costByDate[dateKey] || 0,
      costDisplay: formatCostDisplay(costByDate[dateKey])
    });
  }
  let maxCost = 0;
  days.forEach((item) => {
    maxCost = Math.max(maxCost, item.cost);
  });
  const normalizedDays = days.map((item) => Object.assign({}, item, {
    barPercent: maxCost ? Math.round(item.cost / maxCost * 100) : 0
  }));
  const totalCost = normalizedDays.reduce((total, item) => total + item.cost, 0);
  return {
    days: normalizedDays,
    totalCost,
    totalCostDisplay: formatCostDisplay(totalCost),
    hasCost: totalCost > 0
  };
}

function buildEntryHealth(
  effective,
  usageStats,
  autoFaceProbe,
  autoFaceProbeHistory,
  autoFaceFailureStats,
  userStats,
  moduleStates
) {
  const configs = effective || {};
  const usage = usageStats || emptyUsageStats();
  const today = usage.today || emptyUsageCounter();
  const states = moduleStates || emptyAdminModuleStates("ready");
  const currentProbe = autoFaceProbe || emptyAutoFaceProbe();
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestProbeStatus = currentProbe.status && currentProbe.status !== "not-run"
    ? currentProbe.status
    : history[0] && history[0].status || "not-run";
  const configReady = (section) => {
    const value = configs[section] || {};
    return Boolean(value.apiKeyConfigured && value.provider && value.model);
  };
  const failureFor = (section) => Number(today[section] && today[section].failure) || 0;
  const stateLabel = (key, normalLabel = "正常") => {
    const state = states[key] || createModuleState("ready", true);
    if (state.status === "loading") return "读取中";
    if (state.status === "failed") return "读取失败";
    return normalLabel;
  };
  const faceAbnormal = !configReady("face")
    || latestProbeStatus === "failed"
    || failureFor("face") > 0
    || Number(autoFaceFailureStats && autoFaceFailureStats.today) > 0;
  return {
    face: {
      abnormal: faceAbnormal,
      label: faceAbnormal ? "异常" : "正常"
    },
    analysis: {
      abnormal: !configReady("analysis") || failureFor("analysis") > 0,
      label: !configReady("analysis") || failureFor("analysis") > 0 ? "异常" : "正常"
    },
    image: {
      abnormal: (
        !configReady("image")
        || !configReady("imageBackup")
        || failureFor("image") > 0
      ),
      label: (
        !configReady("image")
        || !configReady("imageBackup")
        || failureFor("image") > 0
      ) ? "异常" : "正常"
    },
    video: {
      abnormal: !configReady("video") || failureFor("video") > 0,
      label: !configReady("video") || failureFor("video") > 0 ? "异常" : "正常"
    },
    points: { abnormal: false, label: "正常" },
    costs: {
      abnormal: (states.usage && states.usage.status === "failed")
        || Boolean(usage.unavailable),
      label: stateLabel("usage")
    },
    users: {
      abnormal: (states.users && states.users.status === "failed")
        || Boolean(userStats && userStats.unavailable),
      label: stateLabel("users")
    },
    usage: {
      abnormal: (states.usage && states.usage.status === "failed")
        || Boolean(usage.unavailable),
      label: stateLabel("usage")
    }
  };
}

function formFromConfig(result) {
  const source = result && result.effective ? result.effective : {};
  const face = source.face || {};
  const analysis = source.analysis || {};
  const image = source.image || {};
  const imageBackup = source.imageBackup || {};
  const video = source.video || {};
  const points = source.points || {};
  const costs = source.costs || {};
  const faceCosts = costs.face || {};
  const analysisCosts = costs.analysis || faceCosts;
  const imageCosts = costs.image || {};
  const imageProviderCosts = imageCosts.providers || {};
  const xingjuImagePrices = imageProviderCosts.xingju
    && imageProviderCosts.xingju.perImage
    || (
      normalizeAdminImageCostProvider(image.provider) === "xingju"
        ? imageCosts.perImage
        : {}
    )
    || {};
  const lingyunImagePrices = imageProviderCosts.lingyun
    && imageProviderCosts.lingyun.perImage
    || (
      normalizeAdminImageCostProvider(image.provider) === "lingyun"
        ? imageCosts.perImage
        : {}
    )
    || {};
  const videoCosts = costs.video || {};
  const generationQueue = source.generationQueue || {};
  return {
    face: {
      provider: displayAdminProvider(face.provider),
      baseUrl: face.baseUrl || "",
      endpoint: face.endpoint || "",
      apiKey: face.apiKey || "",
      model: face.model || "",
      timeoutMs: String(face.timeoutMs || 30000)
    },
    analysis: {
      provider: displayAdminProvider(analysis.provider),
      baseUrl: analysis.baseUrl || "",
      endpoint: analysis.endpoint || "",
      apiKey: analysis.apiKey || "",
      model: analysis.model || "",
      timeoutMs: String(analysis.timeoutMs || 30000)
    },
    image: {
      provider: displayAdminImageProvider(image.provider),
      baseUrl: image.baseUrl || "",
      endpoint: image.endpoint || "",
      apiKey: image.apiKey || "",
      model: image.model || "",
      mode: image.mode || "edits",
      size: image.size || "1080x1440",
      resolution: normalizeAdminImageResolution(
        image.resolution || image.size,
        "1K"
      ),
      compatibilityMode: normalizeAdminBoolean(image.compatibilityMode, false),
      timeoutMs: String(image.timeoutMs || 150000),
      maxRetries: String(image.maxRetries || 0),
      retryEnabled: image.retryEnabled === undefined
        ? true
        : Boolean(image.retryEnabled),
      retryPreferenceVersion: 1
    },
    imageBackup: {
      provider: displayAdminImageProvider(imageBackup.provider, "凌云"),
      baseUrl: imageBackup.baseUrl || "https://api.lingyunapi.xyz/v1",
      endpoint: imageBackup.endpoint || "",
      apiKey: imageBackup.apiKey || "",
      model: imageBackup.model || "gpt-image-2",
      mode: imageBackup.mode || "edits",
      size: imageBackup.size || image.size || "1080x1440",
      resolution: normalizeAdminImageResolution(
        imageBackup.resolution || imageBackup.size || image.resolution || image.size,
        "1K"
      ),
      compatibilityMode: normalizeAdminBoolean(
        imageBackup.compatibilityMode,
        false
      ),
      timeoutMs: String(imageBackup.timeoutMs || 150000),
      maxRetries: "0",
      retryEnabled: false,
      retryPreferenceVersion: 1
    },
    video: {
      provider: displayAdminProvider(video.provider),
      baseUrl: video.baseUrl || "",
      endpoint: video.endpoint || "",
      queryEndpoint: video.queryEndpoint || "",
      apiKey: video.apiKey || "",
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
      analysisInputPerMillionTokens: String(
        analysisCosts.inputPerMillionTokens !== undefined
          ? analysisCosts.inputPerMillionTokens
          : faceCosts.inputPerMillionTokens || 0.15
      ),
      analysisOutputPerMillionTokens: String(
        analysisCosts.outputPerMillionTokens !== undefined
          ? analysisCosts.outputPerMillionTokens
          : faceCosts.outputPerMillionTokens || 1.5
      ),
      imageXingju1K: String(
        xingjuImagePrices["1K"] !== undefined
          ? xingjuImagePrices["1K"]
          : 0.07
      ),
      imageXingju2K: String(
        xingjuImagePrices["2K"] !== undefined
          ? xingjuImagePrices["2K"]
          : 0.07
      ),
      imageXingju4K: String(
        xingjuImagePrices["4K"] !== undefined
          ? xingjuImagePrices["4K"]
          : 0.07
      ),
      imageLingyun1K: String(
        lingyunImagePrices["1K"] !== undefined
          ? lingyunImagePrices["1K"]
          : 0.06
      ),
      imageLingyun2K: String(
        lingyunImagePrices["2K"] !== undefined
          ? lingyunImagePrices["2K"]
          : 0.1
      ),
      imageLingyun4K: String(
        lingyunImagePrices["4K"] !== undefined
          ? lingyunImagePrices["4K"]
          : 0.15
      ),
      video480p: String(
        videoCosts.perSecond && videoCosts.perSecond["480p"] !== undefined
          ? videoCosts.perSecond["480p"]
          : ""
      ),
      video720p: String(
        videoCosts.perSecond && videoCosts.perSecond["720p"] !== undefined
          ? videoCosts.perSecond["720p"]
          : ""
      ),
      video1080p: String(
        videoCosts.perSecond && videoCosts.perSecond["1080p"] !== undefined
          ? videoCosts.perSecond["1080p"]
          : ""
      ),
      videoDefaultDuration: String(videoCosts.defaultDurationSeconds || 3)
    },
    generationQueue: {
      workerConcurrency: String(generationQueue.workerConcurrency || 1),
      alertThreshold: String(generationQueue.alertThreshold || 5),
      alertCooldownMinutes: String(generationQueue.alertCooldownMinutes || 10)
    }
  };
}

function formToConfig(form) {
  const xingjuImagePrices = {
    "1K": adminCostText(form.costs.imageXingju1K),
    "2K": adminCostText(form.costs.imageXingju2K),
    "4K": adminCostText(form.costs.imageXingju4K)
  };
  const lingyunImagePrices = {
    "1K": adminCostText(form.costs.imageLingyun1K),
    "2K": adminCostText(form.costs.imageLingyun2K),
    "4K": adminCostText(form.costs.imageLingyun4K)
  };
  const primaryImagePrices = normalizeAdminImageCostProvider(form.image.provider) === "lingyun"
    ? lingyunImagePrices
    : xingjuImagePrices;
  return {
    face: {
      provider: normalizeAdminProviderInput(form.face.provider),
      baseUrl: String(form.face.baseUrl || "").trim(),
      endpoint: String(form.face.endpoint || "").trim(),
      apiKey: String(form.face.apiKey || "").trim(),
      model: String(form.face.model || "").trim(),
      timeoutMs: Number(form.face.timeoutMs || 0)
    },
    analysis: {
      provider: normalizeAdminProviderInput(form.analysis.provider),
      baseUrl: String(form.analysis.baseUrl || "").trim(),
      endpoint: String(form.analysis.endpoint || "").trim(),
      apiKey: String(form.analysis.apiKey || "").trim(),
      model: String(form.analysis.model || "").trim(),
      timeoutMs: Number(form.analysis.timeoutMs || 0)
    },
    image: {
      provider: normalizeAdminImageProviderInput(form.image.provider),
      baseUrl: String(form.image.baseUrl || "").trim(),
      endpoint: String(form.image.endpoint || "").trim(),
      apiKey: String(form.image.apiKey || "").trim(),
      model: String(form.image.model || "").trim(),
      mode: String(form.image.mode || "").trim().toLowerCase(),
      size: String(form.image.size || "").trim(),
      resolution: normalizeAdminImageResolution(
        form.image.resolution || form.image.size,
        "1K"
      ),
      compatibilityMode: Boolean(form.image.compatibilityMode),
      timeoutMs: Number(form.image.timeoutMs || 0),
      maxRetries: Number(form.image.maxRetries || 0),
      retryEnabled: Boolean(form.image.retryEnabled),
      retryPreferenceVersion: 1
    },
    imageBackup: {
      provider: normalizeAdminImageProviderInput(form.imageBackup.provider),
      baseUrl: String(form.imageBackup.baseUrl || "").trim(),
      endpoint: String(form.imageBackup.endpoint || "").trim(),
      apiKey: String(form.imageBackup.apiKey || "").trim(),
      model: String(form.imageBackup.model || "").trim(),
      mode: String(form.imageBackup.mode || "edits").trim().toLowerCase(),
      size: String(
        form.imageBackup.size
        || form.image.size
        || ""
      ).trim(),
      resolution: normalizeAdminImageResolution(
        form.imageBackup.resolution
        || form.imageBackup.size
        || form.image.resolution
        || form.image.size,
        "1K"
      ),
      compatibilityMode: Boolean(form.imageBackup.compatibilityMode),
      timeoutMs: Number(form.imageBackup.timeoutMs || 0),
      maxRetries: 0,
      retryEnabled: false,
      retryPreferenceVersion: 1
    },
    video: {
      provider: normalizeAdminProviderInput(form.video.provider),
      baseUrl: String(form.video.baseUrl || "").trim(),
      endpoint: String(form.video.endpoint || "").trim(),
      queryEndpoint: String(form.video.queryEndpoint || "").trim(),
      apiKey: String(form.video.apiKey || "").trim(),
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
        inputPerMillionTokens: adminCostText(form.costs.faceInputPerMillionTokens),
        outputPerMillionTokens: adminCostText(form.costs.faceOutputPerMillionTokens)
      },
      analysis: {
        inputPerMillionTokens: adminCostText(form.costs.analysisInputPerMillionTokens),
        outputPerMillionTokens: adminCostText(form.costs.analysisOutputPerMillionTokens)
      },
      image: {
        defaultResolution: "1K",
        // 旧版页面继续读取当前主模型价格。
        perImage: Object.assign({}, primaryImagePrices),
        providers: {
          xingju: {
            perImage: xingjuImagePrices
          },
          lingyun: {
            perImage: lingyunImagePrices
          }
        }
      },
      video: {
        defaultResolution: "720p",
        perSecond: {
          "480p": adminCostText(form.costs.video480p),
          "720p": adminCostText(form.costs.video720p),
          "1080p": adminCostText(form.costs.video1080p)
        },
        defaultDurationSeconds: adminCostText(form.costs.videoDefaultDuration)
      }
    },
    generationQueue: {
      workerConcurrency: Number(form.generationQueue.workerConcurrency || 1),
      alertThreshold: Number(form.generationQueue.alertThreshold || 5),
      alertCooldownMinutes: Number(form.generationQueue.alertCooldownMinutes || 10)
    }
  };
}

function emptyAdminImageApiKeys() {
  return {
    image: "",
    imageBackup: ""
  };
}

function normalizeAdminImageApiKeys(result) {
  const source = result && typeof result === "object" ? result : {};
  return {
    image: String(
      source.image
      && source.image.apiKey
      || ""
    ).trim(),
    imageBackup: String(
      source.imageBackup
      && source.imageBackup.apiKey
      || ""
    ).trim()
  };
}

function adminImageApiKeysFromForm(form) {
  const source = form && typeof form === "object" ? form : {};
  return {
    image: String(
      source.image
      && source.image.apiKey
      || ""
    ).trim(),
    imageBackup: String(
      source.imageBackup
      && source.imageBackup.apiKey
      || ""
    ).trim()
  };
}

function formWithAdminImageApiKeys(form, apiKeys) {
  const source = form && typeof form === "object" ? form : {};
  const keys = normalizeAdminImageApiKeys({
    image: { apiKey: apiKeys && apiKeys.image },
    imageBackup: { apiKey: apiKeys && apiKeys.imageBackup }
  });
  return Object.assign({}, source, {
    image: Object.assign({}, source.image || {}, {
      apiKey: keys.image
    }),
    imageBackup: Object.assign({}, source.imageBackup || {}, {
      apiKey: keys.imageBackup
    })
  });
}

function adminConfigSavePayload(form, baseline) {
  const configPayload = formToConfig(form);
  const currentKeys = adminImageApiKeysFromForm(form);
  const loadedKeys = Object.assign(
    emptyAdminImageApiKeys(),
    baseline && typeof baseline === "object" ? baseline : {}
  );
  ["image", "imageBackup"].forEach((section) => {
    const current = currentKeys[section];
    const loaded = String(loadedKeys[section] || "").trim();
    if (!current || current === loaded) {
      delete configPayload[section].apiKey;
    }
  });
  return configPayload;
}

function adminImageApiKeysAfterSave(form, baseline) {
  const currentKeys = adminImageApiKeysFromForm(form);
  const loadedKeys = Object.assign(
    emptyAdminImageApiKeys(),
    baseline && typeof baseline === "object" ? baseline : {}
  );
  return {
    image: currentKeys.image || String(loadedKeys.image || "").trim(),
    imageBackup: currentKeys.imageBackup
      || String(loadedKeys.imageBackup || "").trim()
  };
}

async function fetchAdminConfigBundle() {
  const apiKeyTask = withTimeout(
    cloud.getAdminImageApiKeys({ retryLimit: 0 }),
    10000,
    "生图完整 Key"
  )
    .then((result) => {
      if (!result || result.ok === false) {
        const error = new Error("完整 Key 专用接口返回失败");
        error.code = result && (result.errorCode || result.code) || "";
        throw error;
      }
      return {
        ok: true,
        apiKeys: normalizeAdminImageApiKeys(result),
        error: null
      };
    })
    .catch((error) => ({
      ok: false,
      apiKeys: emptyAdminImageApiKeys(),
      error
    }));
  const results = await Promise.all([
    withTimeout(
      cloud.getAdminConfig({ retryLimit: 1 }),
      10000,
      "管理员配置"
    ),
    apiKeyTask
  ]);
  return {
    config: results[0],
    apiKeyResult: results[1]
  };
}

function adminImageApiKeyFailureLog(error) {
  return {
    errorCode: String(
      error
      && (error.code || error.errorCode)
      || ""
    ).slice(0, 80)
  };
}

function modelConfigKeyForAction(form, modelType, requestedKey = "") {
  const key = String(requestedKey || modelType || "").trim();
  return form && form[key] ? key : modelType;
}

function modelConfigForAction(form, modelType, configKey = modelType) {
  const key = modelConfigKeyForAction(form, modelType, configKey);
  const source = form && form[key] ? form[key] : {};
  const provider = normalizeAdminProviderInput(source.provider);
  return {
    configTarget: key,
    provider,
    baseUrl: String(source.baseUrl || "").trim(),
    endpoint: String(source.endpoint || "").trim(),
    queryEndpoint: String(source.queryEndpoint || "").trim(),
    apiKey: String(source.apiKey || "").trim(),
    model: String(source.model || "").trim(),
    timeoutMs: Number(source.timeoutMs || 0)
  };
}

function compareModelNames(left, right) {
  const leftParts = String(left || "").toLowerCase().split(/(\d+)/);
  const rightParts = String(right || "").toLowerCase().split(/(\d+)/);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || "";
    const rightPart = rightParts[index] || "";
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart);
    const rightNumber = /^\d+$/.test(rightPart);
    if (leftNumber && rightNumber) {
      return Number(leftPart) - Number(rightPart);
    }
    return leftPart.localeCompare(rightPart, undefined, { sensitivity: "base" });
  }
  return String(left || "").localeCompare(String(right || ""), undefined, {
    sensitivity: "base"
  });
}

function normalizeModelOptions(result) {
  const source = result && Array.isArray(result.models) ? result.models : [];
  const values = Array.from(new Set(source
    .map((item) => typeof item === "string" ? item : item && (item.id || item.name || item.model))
    .map((item) => String(item || "").trim())
    .filter(Boolean)));
  values.sort(compareModelNames);
  return values
    .map((value) => ({ value, label: value }));
}

function filterModelOptions(options, search) {
  const source = Array.isArray(options) ? options : [];
  const keyword = String(search || "").trim().toLowerCase();
  if (!keyword) return source.slice();
  return source.filter((item) => String(item && (item.label || item.value) || "")
    .toLowerCase()
    .includes(keyword));
}

function formatModelConnectionFailure(typeLabel, result, error) {
  const payload = result && typeof result === "object"
    ? result
    : error && error.payload && typeof error.payload === "object"
      ? error.payload
      : {};
  const target = Array.isArray(payload.results) ? payload.results[0] : payload;
  const message = String(
    target && (target.message || target.error)
      || error && error.message
      || "连接测试未通过，请检查配置。"
  ).trim();
  const details = [];
  const statusText = String(target && target.statusText || "").trim();
  const httpStatus = Number(target && (target.httpStatus || target.status)) || 0;
  if (statusText && statusText !== "正常" && !message.includes(statusText)) {
    details.push(`状态：${statusText}`);
  }
  if (httpStatus && !message.includes(`HTTP ${httpStatus}`)) {
    details.push(`HTTP：${httpStatus}`);
  }
  const advice = modelProbeRepairAdvice(target && target.status, httpStatus);
  if (advice) details.push(`修复建议：${advice}`);
  const safeMessage = safeCopyValue(message, "连接测试未通过，请检查配置。");
  return [
    `${normalizeAdminModelLabel(typeLabel)}模型：${safeMessage}`
  ].concat(details).join("\n");
}

function displayLog(item) {
  const value = item || {};
  return Object.assign({}, value, {
    checkedAtText: value.checkedAt
      ? String(value.checkedAt).replace("T", " ").replace(/\.\d+Z$/, "")
      : "未知时间",
    statusText: value.ok ? "检查通过" : "需要处理",
    faceText: value.face && value.face.ready ? "人脸可用" : "人脸未就绪",
    analysisText: value.analysis && value.analysis.ready ? "图片分析可用" : "图片分析未就绪",
    imageText: value.image && value.image.ready ? "生图可用" : "生图未就绪",
    videoText: value.video && value.video.ready ? "视频可用" : "视频未就绪"
  });
}

function safeCopyValue(value, fallback = "无") {
  const text = String(value || "")
    .replace(/\bsk-[A-Za-z0-9._~-]+\b/gi, "[Key已隐藏]")
    .replace(/cloud:\/\/[^\s,;]+/gi, "[素材地址已隐藏]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users|private|data)\/)[^\s,;]+/g,
      "[路径已隐藏]"
    )
    .replace(/openid\s*[:=]\s*[^\s,;]+/gi, "OpenID=[已隐藏]")
    .slice(0, 500)
    .trim();
  return text || fallback;
}

function modelFailureCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `功能类型：${safeCopyValue(item.usageTypeLabel || usageTypeLabel(item.usageType))}`,
    `模型和服务商：${safeCopyValue(item.provider)} / ${safeCopyValue(item.model)}`,
    `错误码：${safeCopyValue(item.errorCode)}`,
    `接口状态：${item.errorStatus ? `HTTP ${item.errorStatus}` : "无"}`,
    `接口耗时：${Number(item.durationMs) || 0} 毫秒`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误原因：${safeCopyValue(item.errorMessage, "未提供错误摘要")}`
  ].join("\n");
}

function autoFaceFailureCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `模型和服务商：${safeCopyValue(item.probeProvider || "人脸识别")} / ${safeCopyValue(item.probeModel || "自动贴脸")}`,
    `错误码：${safeCopyValue(item.errorCode)}`,
    `接口状态：${item.status ? `HTTP ${item.status}` : "无"}`,
    `接口耗时：${Number(item.durationMs) || 0} 毫秒`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误原因：${safeCopyValue(item.message, "未提供错误摘要")}`
  ].join("\n");
}

function diagnosticLogCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `匿名用户：${safeCopyValue(item.userHash)}`,
    `分类：${safeCopyValue(item.categoryLabel)}`,
    `级别：${safeCopyValue(item.levelText)}`,
    `日志：${safeCopyValue(item.message, "未提供日志说明")}`,
    `页面：${safeCopyValue(item.route)}`,
    `步骤：${safeCopyValue(item.step)}`,
    `错误码：${safeCopyValue(item.code)}`,
    `接口耗时：${safeCopyValue(item.durationText)}`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误详情：${safeCopyValue(item.errorText)}`,
    `补充信息：${safeCopyValue(item.detailsText)}`
  ].join("\n");
}

Page({
  data: {
    appVersion: config.appVersion,
    loading: true,
    canRetry: false,
    saving: false,
    checking: false,
    modelProbing: false,
    modelProbingType: "",
    modelActionType: "",
    modelActionKind: "",
    modelActionTarget: "",
    modelPickerOpen: false,
    modelPickerType: "",
    modelPickerTarget: "",
    modelPickerTitle: "",
    modelPickerSearch: "",
    modelPickerAllOptions: [],
    modelPickerOptions: [],
    refreshingAll: false,
    isAdmin: false,
    form: emptyForm(),
    costFieldErrors: {},
    imageQualityOptions: buildAdminImageQualityOptions(
      emptyForm().costs,
      emptyForm().image.provider
    ),
    imageQualityIndex: 0,
    imageSizeOptions: IMAGE_SIZE_OPTIONS.slice(),
    imageSizeIndex: 0,
    imageBackupQualityOptions: buildAdminImageQualityOptions(
      emptyForm().costs,
      emptyForm().imageBackup.provider
    ),
    imageBackupQualityIndex: 0,
    imageBackupSizeOptions: IMAGE_SIZE_OPTIONS.slice(),
    imageBackupSizeIndex: 0,
    imagePricingNotice: buildAdminImagePricingNotice(
      emptyForm().costs,
      emptyForm().image.provider
    ),
    imageBackupPricingNotice: buildAdminImagePricingNotice(
      emptyForm().costs,
      emptyForm().imageBackup.provider
    ),
    videoQualityOptions: buildAdminVideoQualityOptions(emptyForm().costs),
    videoQualityIndex: 1,
    videoPricingNotice: buildAdminVideoPricingNotice(emptyForm().costs),
    imageCapabilitySource: "known-model-rule",
    videoCapabilitySource: "known-model-rule",
    imageCapabilityNotice: "生图清晰度由 1K、2K、4K 控制，尺寸只控制画面比例。",
    videoCapabilityNotice: "视频清晰度由上游模型能力决定。",
    imageProviderDisplayName: displayAdminImageProvider(emptyForm().image.provider),
    imageBackupProviderDisplayName: displayAdminImageProvider(
      emptyForm().imageBackup.provider
    ),
    imageQualityProbe: emptyImageQualityProbe(),
    modelCapabilityProfiles: {
      image: {},
      video: {}
    },
    currentConfigModels: emptyCurrentConfigModels(),
    defaults: null,
    effective: null,
    deployment: null,
    logs: [],
    message: "",
    usageLoading: false,
    usageExporting: false,
    usageStats: emptyUsageStats(),
    imageProviderStatsLoading: false,
    imageProviderStats: emptyImageProviderStats(),
    configAuditLoading: false,
    configAuditLogs: emptyConfigAuditLogs(),
    costTrend: emptyCostTrend(),
    userStatsLoading: false,
    userStatsExporting: false,
    userStats: emptyUserStats(),
    userSearchInput: "",
    userSearch: "",
    userDateRange: "all",
    userDateRanges: [
      { value: "all", label: "全部" },
      { value: "today", label: "今天" },
      { value: "7d", label: "近7天" },
      { value: "30d", label: "近30天" },
      { value: "custom", label: "自定义" }
    ],
    userGender: "all",
    userGenders: [
      { value: "all", label: "全部" },
      { value: "male", label: "男性" },
      { value: "female", label: "女性" }
    ],
    userTodayKey: shanghaiTodayDateKey(),
    userCustomStartDate: dateKeyShift(shanghaiTodayDateKey(), -6),
    userCustomEndDate: shanghaiTodayDateKey(),
    userDetailVisible: false,
    selectedUserDetail: null,
    diagnosticLogsLoading: false,
    diagnosticLogs: emptyAdminDiagnosticLogs(),
    generationQueueLoading: false,
    generationQueue: emptyGenerationQueue(),
    generationCleanupLoading: false,
    generationCleanupResult: null,
    generationQueueKind: "all",
    generationQueueStatus: "all",
    generationQueueKindOptions: [
      { value: "all", label: "全部任务" },
      { value: "image", label: "图片" },
      { value: "video", label: "视频" }
    ],
    generationQueueStatusOptions: [
      { value: "all", label: "全部状态" },
      { value: "queued", label: "排队中" },
      { value: "processing", label: "处理中" },
      { value: "failed", label: "失败" },
      { value: "refunding", label: "退款中" },
      { value: "refunded", label: "已退款" },
      { value: "succeeded", label: "已完成" }
    ],
    generationHistoryLoading: false,
    generationHistoryVisible: false,
    generationHistory: null,
    diagnosticHours: 72,
    diagnosticLevel: "all",
    diagnosticCategory: "all",
    diagnosticUserHash: "",
    diagnosticUserIndex: 0,
    diagnosticUserLabel: "全部用户",
    diagnosticTimeRanges: [
      { value: 1, label: "1小时" },
      { value: 6, label: "6小时" },
      { value: 24, label: "24小时" },
      { value: 72, label: "72小时" }
    ],
    diagnosticLevels: [
      { value: "all", label: "全部" },
      { value: "error", label: "错误" },
      { value: "warn", label: "提醒" },
      { value: "info", label: "正常" }
    ],
    diagnosticCategories: [
      { value: "all", label: "全部类型" },
      { value: "generation", label: "生图" },
      { value: "video", label: "视频" },
      { value: "analysis", label: "图片分析" },
      { value: "auto-face", label: "自动贴脸" },
      { value: "upload", label: "上传" },
      { value: "cloud", label: "云端" },
      { value: "navigation", label: "页面" },
      { value: "points", label: "积分" },
      { value: "records", label: "作品" },
      { value: "repair", label: "修正" },
      { value: "other", label: "其他" }
    ],
    autoFaceFailureLoading: false,
    autoFaceFailureExporting: false,
    autoFaceFailureStats: emptyAutoFaceFailureStats(),
    autoFaceFailureView: buildAutoFaceFailureView(emptyAutoFaceFailureStats()),
    autoFaceFailureSelectedMonth: "",
    autoFaceFailureDetailOpen: false,
    autoFaceFailureDetail: null,
    modelFailureExporting: false,
    modelFailureView: buildModelFailureView(emptyFailureStats()),
    modelFailureSelectedMonth: "",
    modelFailureDetailOpen: false,
    modelFailureDetail: null,
    autoFaceProbe: emptyAutoFaceProbe(),
    autoFaceProbeHistory: emptyAutoFaceProbeHistory(),
    modelProbes: emptyModelProbes(),
    moduleStates: emptyAdminModuleStates(),
    todayFailureText: "读取中",
    probeHistoryLoading: false,
    dashboardStatus: emptyDashboardStatus(),
    faceConfigSummary: emptyFaceConfigSummary(),
    analysisConfigSummary: emptyAnalysisConfigSummary(),
    tencentFaceFusionStatus: emptyTencentFaceFusionStatus(),
    tencentTestTemplate: null,
    tencentTestFace: null,
    tencentTestLoading: false,
    imageEditCapabilityLoading: false,
    imageEditCapabilityProbe: emptyImageEditCapabilityProbe(),
    imageBackupEditCapabilityLoading: false,
    imageBackupEditCapabilityProbe: emptyImageEditCapabilityProbe(),
    entryHealth: buildEntryHealth(),
    activeConfigSection: "",
    activeConfigTitle: "",
    monitorExpanded: true,
    usageExpanded: true,
    monitorSections: {
      generationQueue: true,
      autoFaceFailure: false,
      diagnosticLogs: false,
      deployment: false
    },
    usageSections: defaultUsageSections(),
    autoFaceFailureSections: defaultAutoFaceFailureSections(),
    deploymentSections: defaultDeploymentSections()
  },

  onLoad() {
    this._adminLoadToken = 0;
    this._imageApiKeyBaseline = emptyAdminImageApiKeys();
    this.restoreMonitorLayout();
    this.loadAdminPage();
    this.startModelFailureAutoRefresh();
    this.startAutoFaceFailureAutoRefresh();
  },

  onUnload() {
    this._adminLoadToken = (this._adminLoadToken || 0) + 1;
    this._imageApiKeyBaseline = emptyAdminImageApiKeys();
    this.stopModelFailureAutoRefresh();
    this.stopAutoFaceFailureAutoRefresh();
  },

  onPullDownRefresh() {
    this.loadAdminPage().finally(() => wx.stopPullDownRefresh());
  },

  isCurrentAdminLoad(token) {
    return token === this._adminLoadToken;
  },

  buildAdminDerivedPatch(overrides = {}, moduleStates = this.data.moduleStates) {
    const hasOwnValue = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const form = hasOwnValue("form") ? overrides.form : this.data.form;
    const effective = hasOwnValue("effective") ? overrides.effective : this.data.effective;
    const usageStats = hasOwnValue("usageStats") ? overrides.usageStats : this.data.usageStats;
    const autoFaceProbe = hasOwnValue("autoFaceProbe")
      ? overrides.autoFaceProbe
      : this.data.autoFaceProbe;
    const autoFaceProbeHistory = hasOwnValue("autoFaceProbeHistory")
      ? overrides.autoFaceProbeHistory
      : this.data.autoFaceProbeHistory;
    const autoFaceFailureStats = hasOwnValue("autoFaceFailureStats")
      ? overrides.autoFaceFailureStats
      : this.data.autoFaceFailureStats;
    const autoFaceFailureSelectedMonth = hasOwnValue("autoFaceFailureSelectedMonth")
      ? overrides.autoFaceFailureSelectedMonth
      : this.data.autoFaceFailureSelectedMonth;
    const modelFailureSelectedMonth = hasOwnValue("modelFailureSelectedMonth")
      ? overrides.modelFailureSelectedMonth
      : this.data.modelFailureSelectedMonth;
    const userStats = hasOwnValue("userStats") ? overrides.userStats : this.data.userStats;
    return Object.assign(
      {
        currentConfigModels: buildCurrentConfigModels(form),
        imageProviderDisplayName: displayAdminImageProvider(
          form && form.image && form.image.provider
        ),
        imageBackupProviderDisplayName: displayAdminImageProvider(
          form && form.imageBackup && form.imageBackup.provider
        )
      },
      {
        dashboardStatus: buildDashboardStatus(
          effective,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        faceConfigSummary: buildFaceConfigSummary(
          effective,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        analysisConfigSummary: buildAnalysisConfigSummary(effective),
        entryHealth: buildEntryHealth(
          effective,
          usageStats,
          autoFaceProbe,
          autoFaceProbeHistory,
          autoFaceFailureStats,
          userStats,
          moduleStates
        ),
        todayFailureText: buildTodayFailureText(usageStats, moduleStates),
        modelFailureView: buildModelFailureView(
          usageStats && usageStats.failureStats,
          modelFailureSelectedMonth
        ),
        autoFaceFailureView: buildAutoFaceFailureView(
          autoFaceFailureStats,
          autoFaceFailureSelectedMonth
        )
      }
    );
  },

  async loadAdminModule(
    token,
    key,
    task,
    formatter,
    applyResult,
    options = {}
  ) {
    if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
      return { ok: false, stale: true };
    }
    const currentStates = this.data.moduleStates || emptyAdminModuleStates();
    const loadingStates = updateAdminModuleState(
      currentStates,
      key,
        "loading",
        undefined,
        "",
        currentStates[key] && currentStates[key].updatedAtText || "尚未更新"
    );
    const loadingPatch = {
      moduleStates: loadingStates
    };
    if (options.loadingKey) loadingPatch[options.loadingKey] = true;
    this.setData(Object.assign(
      loadingPatch,
      this.buildAdminDerivedPatch({}, loadingStates)
    ));
    const label = options.label || key;
    const timeoutMs = Number(options.timeoutMs) || 12000;
    try {
      const rawResult = await withTimeout(task(), timeoutMs, label);
      if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
        return { ok: false, stale: true };
      }
      const formatted = formatter ? formatter(rawResult) : rawResult;
      const unavailable = Boolean(formatted && formatted.unavailable);
      const currentStates = this.data.moduleStates || emptyAdminModuleStates();
      const previousState = currentStates[key] || createModuleState("loading");
      const nextStates = updateAdminModuleState(
        currentStates,
        key,
        unavailable ? "failed" : "ready",
        unavailable ? previousState.hasData : true,
        formatted && formatted.message,
        formatAdminDate(new Date())
      );
      const patch = {};
      if (!unavailable || !previousState.hasData) {
        Object.assign(patch, applyResult(formatted));
      }
      if (options.loadingKey) patch[options.loadingKey] = false;
      patch.moduleStates = nextStates;
      if (unavailable && key === "usage") {
        patch.usageExpanded = true;
      } else if (unavailable && MONITOR_SECTION_KEYS.includes(key)) {
        patch.monitorExpanded = true;
        patch[`monitorSections.${key}`] = true;
      }
      Object.assign(patch, this.buildAdminDerivedPatch(patch, nextStates));
      this.setData(patch);
      if (unavailable) {
        diagnosticLog.warn("admin", "module-load-unavailable", `${label}返回不可用状态`, {
          error: formatted && formatted.message
        });
      } else {
        diagnosticLog.info("admin", "module-loaded", `${label}读取完成`, {});
      }
      return { ok: !unavailable, value: formatted, unavailable };
    } catch (error) {
      if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
        return { ok: false, stale: true, error };
      }
      const currentStates = this.data.moduleStates || emptyAdminModuleStates();
      const previousState = currentStates[key] || createModuleState("loading");
      const message = error && error.code === "ADMIN_LOAD_TIMEOUT"
        ? `${label}读取超时，请点击刷新。`
        : `${label}读取失败，请点击刷新。`;
      const nextStates = updateAdminModuleState(
        currentStates,
        key,
        "failed",
        previousState.hasData,
        message,
        formatAdminDate(new Date())
      );
      const patch = {
        moduleStates: nextStates
      };
      if (options.loadingKey) patch[options.loadingKey] = false;
      if (key === "usage") {
        patch.usageExpanded = true;
      } else if (MONITOR_SECTION_KEYS.includes(key)) {
        patch.monitorExpanded = true;
        patch[`monitorSections.${key}`] = true;
      }
      Object.assign(patch, this.buildAdminDerivedPatch({}, nextStates));
      this.setData(patch);
      diagnosticLog.warn("admin", "module-load-failed", `${label}读取失败`, { error });
      return { ok: false, error };
    }
  },

  loadAdminBackground(token) {
    return Promise.all([
      this.loadAdminModule(
        token,
        "generationQueue",
        () => cloud.getAdminGenerationQueue(20),
        formatGenerationQueue,
        (generationQueue) => ({
          generationQueue: applyGenerationQueueFilters(
            generationQueue,
            this.data.generationQueueKind,
            this.data.generationQueueStatus
          )
        }),
        {
          label: "生图队列",
          loadingKey: "generationQueueLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "usage",
        () => cloud.getModelUsageStats(30),
        formatUsageStats,
        (usageStats) => ({
          usageStats,
          costTrend: buildCostTrend(usageStats)
        }),
        {
          label: "模型用量和成本",
          loadingKey: "usageLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "imageProviderStats",
        () => cloud.getImageProviderFailoverStats(30),
        formatImageProviderStats,
        (imageProviderStats) => ({ imageProviderStats }),
        {
          label: "图片主备切换统计",
          loadingKey: "imageProviderStatsLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "configAudit",
        () => cloud.getAdminConfigAuditLogs(20),
        formatConfigAuditLogs,
        (configAuditLogs) => ({ configAuditLogs }),
        {
          label: "配置修改记录",
          loadingKey: "configAuditLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "users",
        () => cloud.getAdminUserStats(0, 20, buildUserStatsFilters(this.data)),
        formatUserStats,
        (userStats) => ({ userStats }),
        {
          label: "用户统计",
          loadingKey: "userStatsLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "diagnosticLogs",
        () => cloud.getAdminDiagnosticLogs({
          offset: 0,
          limit: 20,
          hours: this.data.diagnosticHours,
          level: this.data.diagnosticLevel,
          category: this.data.diagnosticCategory,
          userHash: this.data.diagnosticUserHash
        }),
        (result) => formatAdminDiagnosticLogs(result),
        (diagnosticLogs) => ({ diagnosticLogs }),
        {
          label: "用户端日志",
          loadingKey: "diagnosticLogsLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "autoFaceFailure",
        () => cloud.getAutoFaceFailureStats(),
        formatAutoFaceFailureStats,
        (autoFaceFailureStats) => ({ autoFaceFailureStats }),
        {
          label: "自动贴脸失败统计",
          loadingKey: "autoFaceFailureLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "probeHistory",
        () => cloud.getAutoFaceProbeHistory(),
        formatAutoFaceProbeHistory,
        (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
        {
          label: "探针历史",
          loadingKey: "probeHistoryLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "logs",
        () => cloud.listDeploymentLogs(),
        (result) => result || {},
        (result) => ({
          logs: (result.logs || []).map(displayLog)
        }),
        {
          label: "部署日志"
        }
      )
    ]);
  },

  async loadAdminPage() {
    const token = (this._adminLoadToken || 0) + 1;
    this._adminLoadToken = token;
    if (!cloud.isCloudReady()) {
      this.setData({
        loading: false,
        isAdmin: false,
        canRetry: true,
        moduleStates: emptyAdminModuleStates(),
        todayFailureText: "读取失败",
        message: "云端未连接，无法读取管理员配置。"
      });
      return;
    }
    this.setData({
      loading: true,
      isAdmin: false,
      canRetry: false,
      moduleStates: emptyAdminModuleStates(),
      generationQueueLoading: false,
      usageLoading: false,
      userStatsLoading: false,
      diagnosticLogsLoading: false,
      autoFaceFailureLoading: false,
      probeHistoryLoading: false,
      todayFailureText: "读取中",
      message: ""
    });
    try {
      const status = await withTimeout(
        cloud.getAdminStatus(),
        8000,
        "管理员权限"
      );
      if (!this.isCurrentAdminLoad(token)) return;
      if (!status || !status.isAdmin) {
        const identityHash = String(status && status.identityHash || "").trim();
        const message = identityHash
          ? `当前账号没有管理员权限。请把识别码 ${identityHash} 加入 ADMIN_OPENIDS，保存云函数环境变量后重新编译。`
          : "当前账号没有管理员权限。";
        this.setData({
          loading: false,
          isAdmin: false,
          canRetry: false,
          message
        });
        wx.showModal({
          title: "无权访问",
          content: identityHash
            ? `当前账号不在白名单中。\n识别码：${identityHash}\n请把识别码加入 ADMIN_OPENIDS 后重试。`
            : "当前微信账号不在管理员白名单中。",
          showCancel: false,
          success: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
        });
        return;
      }
      const bundle = await fetchAdminConfigBundle();
      if (!this.isCurrentAdminLoad(token)) return;
      const result = bundle.config;
      const apiKeyResult = bundle.apiKeyResult;
      const imageApiKeys = apiKeyResult.ok
        ? apiKeyResult.apiKeys
        : emptyAdminImageApiKeys();
      const effective = result && result.effective ? result.effective : null;
      const form = formWithAdminImageApiKeys(
        formFromConfig(result),
        imageApiKeys
      );
      this._imageApiKeyBaseline = imageApiKeys;
      const moduleStates = loadingAdminModuleStates(this.data.moduleStates);
      const basePatch = Object.assign({
        loading: false,
        isAdmin: true,
        canRetry: false,
        form,
        costFieldErrors: {},
        defaults: result.defaults || null,
        effective,
        moduleStates,
        message: apiKeyResult.ok
          ? ""
          : "普通配置已读取，但完整 Key 读取失败，请刷新。"
      }, buildQualityPickerState(form));
      Object.assign(basePatch, this.buildAdminDerivedPatch(basePatch, moduleStates));
      this.setData(basePatch);
      diagnosticLog.info("admin", "config-loaded", "管理员配置读取完成", {
        runtimeConfigVersion: result.version || 0
      });
      if (!apiKeyResult.ok) {
        diagnosticLog.warn(
          "admin",
          "image-api-key-load-failed",
          "管理员生图完整 Key 读取失败",
          adminImageApiKeyFailureLog(apiKeyResult.error)
        );
      }
      this.loadAdminBackground(token);
      this.loadTencentFaceFusionStatus(token);
    } catch (error) {
      if (!this.isCurrentAdminLoad(token)) return;
      const message = error && error.code === "ADMIN_LOAD_TIMEOUT"
        ? "管理员配置读取超时，请点击重新读取。"
        : "管理员配置读取失败，请检查云函数部署和白名单。";
      this.setData({
        loading: false,
        canRetry: true,
        message
      });
      diagnosticLog.error("admin", "config-load-failed", "管理员配置读取失败", { error });
    }
  },

  async refreshGenerationQueue(silent = false) {
    if (this.data.generationQueueLoading) return;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "generationQueue",
      () => cloud.getAdminGenerationQueue(20),
      formatGenerationQueue,
      (generationQueue) => ({
        generationQueue: applyGenerationQueueFilters(
          generationQueue,
          this.data.generationQueueKind,
          this.data.generationQueueStatus
        )
      }),
      {
        label: "生图队列",
        loadingKey: "generationQueueLoading"
      }
    );
    if (result && result.ok && !silent) {
      wx.showToast({ title: "队列已刷新", icon: "success" });
    } else if (result && !result.ok && !silent) {
      this.showError("队列刷新失败", result.error || new Error("队列读取失败"));
    }
  },

  selectGenerationQueueKind(event) {
    const kind = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.kind
        : "all"
    );
    if (!["all", "image", "video"].includes(kind)) return;
    this.setData({
      generationQueueKind: kind,
      generationQueue: applyGenerationQueueFilters(
        this.data.generationQueue,
        kind,
        this.data.generationQueueStatus
      )
    });
  },

  selectGenerationQueueStatus(event) {
    const status = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.status
        : "all"
    );
    const allowed = this.data.generationQueueStatusOptions.map((item) => item.value);
    if (!allowed.includes(status)) return;
    this.setData({
      generationQueueStatus: status,
      generationQueue: applyGenerationQueueFilters(
        this.data.generationQueue,
        this.data.generationQueueKind,
        status
      )
    });
  },

  async openGenerationOperationHistory(event) {
    if (this.data.generationHistoryLoading) return;
    const operationId = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.operationId
        : ""
    );
    if (!operationId) return;
    this.setData({
      generationHistoryLoading: true,
      generationHistoryVisible: true,
      generationHistory: null
    });
    try {
      const result = await cloud.getAdminGenerationOperationHistory(operationId);
      this.setData({
        generationHistoryLoading: false,
        generationHistory: formatGenerationOperationHistory(result)
      });
    } catch (error) {
      this.setData({
        generationHistoryLoading: false,
        generationHistoryVisible: false
      });
      this.showError("任务历史读取失败", error);
    }
  },

  closeGenerationOperationHistory() {
    this.setData({
      generationHistoryVisible: false,
      generationHistoryLoading: false,
      generationHistory: null
    });
  },

  async cleanupOldGenerationOperations() {
    if (this.data.generationCleanupLoading) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: "清理旧任务记录",
        content: "只删除90天前已完成或已退款、且没有待退款或待清理标记的后台任务记录。不会删除作品、云文件和积分流水。继续吗？",
        confirmText: "开始清理",
        success: (result) => resolve(Boolean(result && result.confirm)),
        fail: () => resolve(false)
      });
    });
    if (!confirmed) return;
    this.setData({
      generationCleanupLoading: true,
      generationCleanupResult: null
    });
    try {
      const result = await cloud.cleanupGenerationOperationHistory();
      const summary = {
        retentionDays: Math.max(30, Number(result.retentionDays) || 90),
        batchSize: Math.max(1, Number(result.batchSize) || 50),
        scanned: Math.max(0, Number(result.scanned) || 0),
        removed: Math.max(0, Number(result.removed) || 0),
        skipped: Math.max(0, Number(result.skipped) || 0),
        failed: Math.max(0, Number(result.failed) || 0),
        unavailable: Boolean(result.unavailable),
        message: result.message || ""
      };
      this.setData({
        generationCleanupLoading: false,
        generationCleanupResult: summary
      });
      wx.showToast({
        title: summary.unavailable
          ? "任务集合未初始化"
          : `已清理${summary.removed}条`,
        icon: summary.unavailable ? "none" : "success"
      });
      await this.refreshGenerationQueue(true);
    } catch (error) {
      this.setData({ generationCleanupLoading: false });
      this.showError("旧任务清理失败", error);
    }
  },

  async refreshModelUsage(options = {}) {
    if (this.data.usageLoading) return;
    const silent = Boolean(options && options.silent);
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "usage",
      () => cloud.getModelUsageStats(30),
      formatUsageStats,
      (usageStats) => ({
        usageStats,
        costTrend: buildCostTrend(usageStats)
      }),
      {
        label: "模型用量和成本",
        loadingKey: "usageLoading"
      }
    );
    await Promise.all([
      this.refreshImageProviderStats({ silent: true }),
      this.refreshConfigAudit({ silent: true })
    ]);
    if (result.stale) return;
    if (result.ok) {
      if (!silent) wx.showToast({ title: "统计已刷新", icon: "success" });
    } else {
      if (silent) {
        diagnosticLog.warn("admin", "model-failure-auto-refresh-failed", "模型失败统计自动刷新失败", {
          error: result.error
        });
      } else {
        this.showError("统计刷新失败", result.error || new Error("统计读取失败，请稍后重试。"));
      }
    }
  },

  async refreshImageProviderStats(options = {}) {
    if (this.data.imageProviderStatsLoading) return;
    const silent = Boolean(options && options.silent);
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "imageProviderStats",
      () => cloud.getImageProviderFailoverStats(30),
      formatImageProviderStats,
      (imageProviderStats) => ({ imageProviderStats }),
      {
        label: "图片主备切换统计",
        loadingKey: "imageProviderStatsLoading"
      }
    );
    if (!result.ok && !result.stale && !silent) {
      this.showError(
        "主备统计刷新失败",
        result.error || new Error("主备统计读取失败，请稍后重试。")
      );
    }
    return result;
  },

  async refreshConfigAudit(options = {}) {
    if (this.data.configAuditLoading) return;
    const silent = Boolean(options && options.silent);
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "configAudit",
      () => cloud.getAdminConfigAuditLogs(20),
      formatConfigAuditLogs,
      (configAuditLogs) => ({ configAuditLogs }),
      {
        label: "配置修改记录",
        loadingKey: "configAuditLoading"
      }
    );
    if (!result.ok && !result.stale && !silent) {
      this.showError(
        "配置记录刷新失败",
        result.error || new Error("配置修改记录读取失败，请稍后重试。")
      );
    }
    return result;
  },

  startModelFailureAutoRefresh() {
    this.stopModelFailureAutoRefresh();
    this._modelFailureRefreshTimer = setInterval(() => {
      if (
        !this.data.isAdmin
        || this.data.usageLoading
        || this.data.loading
      ) {
        return;
      }
      this.refreshModelUsage({ silent: true });
    }, MODEL_FAILURE_AUTO_REFRESH_MS);
  },

  stopModelFailureAutoRefresh() {
    if (this._modelFailureRefreshTimer) {
      clearInterval(this._modelFailureRefreshTimer);
      this._modelFailureRefreshTimer = null;
    }
  },

  selectModelFailureMonth(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.modelFailureView.monthOptions || [];
    const monthKey = options[index] || options[0] || "";
    this.setData({
      modelFailureSelectedMonth: monthKey
    }, () => {
      this.setData(this.buildAdminDerivedPatch({
        modelFailureSelectedMonth: monthKey
      }, this.data.moduleStates));
    });
  },

  openModelFailureUserDetail(event) {
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    const user = this.data.modelFailureView.users[index];
    if (!user) return;
    const details = this.data.modelFailureView.details
      .filter((item) => item.userHash === user.userHash);
    this.setData({
      modelFailureDetailOpen: true,
      modelFailureDetail: Object.assign({}, user, { details })
    });
  },

  closeModelFailureUserDetail() {
    this.setData({
      modelFailureDetailOpen: false,
      modelFailureDetail: null
    });
  },

  startAutoFaceFailureAutoRefresh() {
    this.stopAutoFaceFailureAutoRefresh();
    this._autoFaceFailureRefreshTimer = setInterval(() => {
      if (
        !this.data.isAdmin
        || this.data.autoFaceFailureLoading
        || this.data.loading
      ) {
        return;
      }
      this.refreshAutoFaceFailureStats({ silent: true });
    }, AUTO_FACE_FAILURE_AUTO_REFRESH_MS);
  },

  stopAutoFaceFailureAutoRefresh() {
    if (this._autoFaceFailureRefreshTimer) {
      clearInterval(this._autoFaceFailureRefreshTimer);
      this._autoFaceFailureRefreshTimer = null;
    }
  },

  async refreshAutoFaceFailureStats(options = {}) {
    if (this.data.autoFaceFailureLoading) return;
    const silent = Boolean(options && options.silent);
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "autoFaceFailure",
      () => cloud.getAutoFaceFailureStats(),
      formatAutoFaceFailureStats,
      (autoFaceFailureStats) => ({ autoFaceFailureStats }),
      {
        label: "自动贴脸失败统计",
        loadingKey: "autoFaceFailureLoading"
      }
    );
    if (result.stale) return;
    if (result.ok) {
      if (!silent) wx.showToast({ title: "失败统计已刷新", icon: "success" });
    } else {
      if (silent) {
        diagnosticLog.warn("admin", "auto-face-failure-auto-refresh-failed", "自动刷新失败统计失败", {
          error: result.error
        });
      } else {
        this.showError(
          "失败统计刷新失败",
          result.error || new Error("统计读取失败，请稍后重试。")
        );
      }
    }
  },

  selectAutoFaceFailureMonth(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.autoFaceFailureView.monthOptions || [];
    const monthKey = options[index] || options[0] || "";
    this.setData({
      autoFaceFailureSelectedMonth: monthKey
    }, () => {
      this.setData(this.buildAdminDerivedPatch({
        autoFaceFailureSelectedMonth: monthKey
      }, this.data.moduleStates));
    });
  },

  openAutoFaceFailureUserDetail(event) {
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    const user = this.data.autoFaceFailureView.users[index];
    if (!user) return;
    const details = this.data.autoFaceFailureView.details
      .filter((item) => item.userHash === user.userHash);
    this.setData({
      autoFaceFailureDetailOpen: true,
      autoFaceFailureDetail: Object.assign({}, user, { details })
    });
  },

  closeAutoFaceFailureUserDetail() {
    this.setData({
      autoFaceFailureDetailOpen: false,
      autoFaceFailureDetail: null
    });
  },

  noop() {},

  async refreshAutoFaceProbeHistory() {
    if (this.data.probeHistoryLoading) return;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "probeHistory",
      () => cloud.getAutoFaceProbeHistory(),
      formatAutoFaceProbeHistory,
      (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
      {
        label: "探针历史",
        loadingKey: "probeHistoryLoading"
      }
    );
    if (result.stale) return;
    if (result.ok) {
      wx.showToast({ title: "探针历史已刷新", icon: "success" });
    } else {
      this.showError(
        "探针历史刷新失败",
        result.error || new Error("探针历史读取失败，请稍后重试。")
      );
    }
  },

  onUserSearchInput(event) {
    this.setData({
      userSearchInput: String(event && event.detail && event.detail.value || "").slice(0, 32)
    });
  },

  applyUserSearch() {
    const search = String(this.data.userSearchInput || "").trim().slice(0, 32);
    this.setData({
      userSearchInput: search,
      userSearch: search
    }, () => this.refreshUserStats(true));
  },

  clearUserSearch() {
    if (!this.data.userSearchInput && !this.data.userSearch) return;
    this.setData({
      userSearchInput: "",
      userSearch: ""
    }, () => this.refreshUserStats(true));
  },

  selectUserDateRange(event) {
    if (this.data.userStatsLoading) return;
    const dateRange = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.range
        : ""
    );
    if (!["all", "today", "7d", "30d", "custom"].includes(dateRange)
      || dateRange === this.data.userDateRange) {
      return;
    }
    this.setData({ userDateRange: dateRange }, () => this.refreshUserStats(true));
  },

  selectUserGender(event) {
    if (this.data.userStatsLoading) return;
    const gender = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.gender
        : ""
    );
    if (!["all", "male", "female"].includes(gender)
      || gender === this.data.userGender) {
      return;
    }
    this.setData({ userGender: gender }, () => this.refreshUserStats(true));
  },

  onUserCustomStartChange(event) {
    if (this.data.userStatsLoading) return;
    const startDate = String(event && event.detail && event.detail.value || "");
    if (!startDate) return;
    const endDate = startDate > this.data.userCustomEndDate
      ? startDate
      : this.data.userCustomEndDate;
    this.setData({
      userDateRange: "custom",
      userCustomStartDate: startDate,
      userCustomEndDate: endDate
    }, () => this.refreshUserStats(true));
  },

  onUserCustomEndChange(event) {
    if (this.data.userStatsLoading) return;
    const endDate = String(event && event.detail && event.detail.value || "");
    if (!endDate) return;
    const startDate = endDate < this.data.userCustomStartDate
      ? endDate
      : this.data.userCustomStartDate;
    this.setData({
      userDateRange: "custom",
      userCustomStartDate: startDate,
      userCustomEndDate: endDate
    }, () => this.refreshUserStats(true));
  },

  openUserDetail(event) {
    const index = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.index
        : -1
    );
    const user = this.data.userStats.users[index];
    if (!user) return;
    this.setData({
      selectedUserDetail: user,
      userDetailVisible: true
    });
  },

  closeUserDetail() {
    this.setData({
      userDetailVisible: false,
      selectedUserDetail: null
    });
  },

  stopUserDetailTap() {},

  async refreshUserStats(reset = true) {
    if (this.data.userStatsLoading) return;
    const shouldReset = reset !== false;
    const offset = shouldReset ? 0 : this.data.userStats.nextOffset;
    if (!shouldReset && (offset === null || offset === undefined)) return;
    const previousUsers = shouldReset ? [] : this.data.userStats.users;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "users",
      () => cloud.getAdminUserStats(
        offset || 0,
        20,
        buildUserStatsFilters(this.data)
      ),
      (rawResult) => formatUserStats(rawResult, previousUsers),
      (userStats) => ({ userStats }),
      {
        label: "用户统计",
        loadingKey: "userStatsLoading"
      }
    );
    if (result.stale) return;
    if (result.ok && shouldReset) {
      wx.showToast({ title: "用户统计已刷新", icon: "success" });
    } else if (!result.ok) {
      this.showError(
        "用户统计刷新失败",
        result.error || new Error("用户统计读取失败，请稍后重试。")
      );
    }
  },

  loadMoreUsers() {
    this.refreshUserStats(false);
  },

  selectDiagnosticHours(event) {
    const hours = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.hours
        : 0
    );
    if (![1, 6, 24, 72].includes(hours) || hours === this.data.diagnosticHours) return;
    this.setData({ diagnosticHours: hours }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticLevel(event) {
    const level = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.level
        : ""
    );
    if (!["all", "error", "warn", "info"].includes(level)
      || level === this.data.diagnosticLevel) {
      return;
    }
    this.setData({ diagnosticLevel: level }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticCategory(event) {
    const category = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.category
        : ""
    );
    if (!category || category === this.data.diagnosticCategory) return;
    this.setData({ diagnosticCategory: category }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticUser(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.diagnosticLogs.userOptions[index] || { value: "" };
    this.setData({
      diagnosticUserIndex: index,
      diagnosticUserHash: option.value || "",
      diagnosticUserLabel: option.label || "全部用户"
    }, () => this.refreshDiagnosticLogs(true));
  },

  async refreshDiagnosticLogs(reset = true) {
    if (this.data.diagnosticLogsLoading) return;
    const shouldReset = reset !== false;
    const offset = shouldReset ? 0 : this.data.diagnosticLogs.nextOffset;
    if (!shouldReset && (offset === null || offset === undefined)) return;
    const previousLogs = shouldReset ? [] : this.data.diagnosticLogs.logs;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "diagnosticLogs",
      () => cloud.getAdminDiagnosticLogs({
        offset: offset || 0,
        limit: 20,
        hours: this.data.diagnosticHours,
        level: this.data.diagnosticLevel,
        category: this.data.diagnosticCategory,
        userHash: this.data.diagnosticUserHash
      }),
      (rawResult) => {
        const formatted = formatAdminDiagnosticLogs(rawResult, previousLogs);
        if (!shouldReset) formatted.logs = previousLogs.concat(formatted.logs);
        return formatted;
      },
      (diagnosticLogs) => ({
        diagnosticLogs,
        diagnosticUserIndex: Math.max(
          0,
          diagnosticLogs.userOptions.findIndex(
            (item) => item.value === this.data.diagnosticUserHash
          )
        ),
        diagnosticUserLabel: (
          diagnosticLogs.userOptions.find(
            (item) => item.value === this.data.diagnosticUserHash
          ) || { label: "全部用户" }
        ).label
      }),
      {
        label: "用户端日志",
        loadingKey: "diagnosticLogsLoading"
      }
    );
    if (result.stale) return;
    if (!result.ok) {
      this.showError(
        "用户端日志刷新失败",
        result.error || new Error("日志读取失败，请稍后重试。")
      );
    }
  },

  loadMoreDiagnosticLogs() {
    this.refreshDiagnosticLogs(false);
  },

  toggleDiagnosticLogDetail(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.diagnosticLogs.logs[index];
    if (!item || !item.hasDetails) return;
    this.setData({
      [`diagnosticLogs.logs[${index}].expanded`]: !item.expanded
    });
  },

  copyDiagnosticLog(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.diagnosticLogs.logs[index];
    if (!item) return;
    wx.setClipboardData({
      data: diagnosticLogCopyText(item),
      success: () => wx.showToast({ title: "日志已复制", icon: "success" })
    });
  },

  async exportUserStats() {
    if (this.data.userStatsExporting) return;
    this.setData({ userStatsExporting: true });
    try {
      const result = await cloud.exportAdminUserStats(buildUserStatsFilters(this.data));
      if (!result || !result.fileID) throw new Error("用户统计 Excel 生成失败。");
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
      this.setData({ userStatsExporting: false });
      wx.showToast({ title: "用户表已导出", icon: "success" });
    } catch (error) {
      this.setData({ userStatsExporting: false });
      diagnosticLog.error("admin", "user-stats-export-failed", "用户统计 Excel 导出失败", {
        error
      });
      this.showError("导出失败", error);
    }
  },

  async refreshAll() {
    if (this.data.refreshingAll) return;
    const token = (this._adminLoadToken || 0) + 1;
    this._adminLoadToken = token;
    const loadingStates = loadingAdminModuleStates(this.data.moduleStates);
    this.setData({
      refreshingAll: true,
      message: "正在刷新全部数据...",
      moduleStates: loadingStates,
      generationQueueLoading: true,
      usageLoading: true,
      userStatsLoading: true,
      diagnosticLogsLoading: true,
      autoFaceFailureLoading: true,
      probeHistoryLoading: true,
      todayFailureText: "读取中"
    });

    const configTask = (async () => {
      try {
        const bundle = await fetchAdminConfigBundle();
        if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
          return { ok: false, stale: true };
        }
        const result = bundle.config;
        const apiKeyResult = bundle.apiKeyResult;
        const imageApiKeys = apiKeyResult.ok
          ? apiKeyResult.apiKeys
          : emptyAdminImageApiKeys();
        const form = formWithAdminImageApiKeys(
          formFromConfig(result),
          imageApiKeys
        );
        this._imageApiKeyBaseline = imageApiKeys;
        const patch = Object.assign({
          form,
          costFieldErrors: {},
          defaults: result.defaults || null,
          effective: result.effective || null
        }, buildQualityPickerState(form));
        Object.assign(patch, this.buildAdminDerivedPatch(patch, this.data.moduleStates));
        this.setData(patch);
        if (!apiKeyResult.ok) {
          diagnosticLog.warn(
            "admin",
            "image-api-key-refresh-failed",
            "刷新管理员生图完整 Key 失败",
            adminImageApiKeyFailureLog(apiKeyResult.error)
          );
        }
        return {
          ok: true,
          imageApiKeysOk: apiKeyResult.ok
        };
      } catch (error) {
        diagnosticLog.warn("admin", "refresh-all-part-failed", "模型配置刷新失败", { error });
        return { ok: false, error };
      }
    })();

    const moduleTasks = [
      this.loadAdminModule(
        token,
        "generationQueue",
        () => cloud.getAdminGenerationQueue(20),
        formatGenerationQueue,
        (generationQueue) => ({
          generationQueue: applyGenerationQueueFilters(
            generationQueue,
            this.data.generationQueueKind,
            this.data.generationQueueStatus
          )
        }),
        { label: "生图队列", loadingKey: "generationQueueLoading" }
      ),
      this.loadAdminModule(
        token,
        "usage",
        () => cloud.getModelUsageStats(30),
        formatUsageStats,
        (usageStats) => ({ usageStats, costTrend: buildCostTrend(usageStats) }),
        { label: "模型用量和成本", loadingKey: "usageLoading" }
      ),
      this.loadAdminModule(
        token,
        "users",
        () => cloud.getAdminUserStats(0, 20, buildUserStatsFilters(this.data)),
        formatUserStats,
        (userStats) => ({ userStats }),
        { label: "用户统计", loadingKey: "userStatsLoading" }
      ),
      this.loadAdminModule(
        token,
        "diagnosticLogs",
        () => cloud.getAdminDiagnosticLogs({
          offset: 0,
          limit: 20,
          hours: this.data.diagnosticHours,
          level: this.data.diagnosticLevel,
          category: this.data.diagnosticCategory,
          userHash: this.data.diagnosticUserHash
        }),
        (result) => formatAdminDiagnosticLogs(result),
        (diagnosticLogs) => ({ diagnosticLogs }),
        { label: "用户端日志", loadingKey: "diagnosticLogsLoading" }
      ),
      this.loadAdminModule(
        token,
        "autoFaceFailure",
        () => cloud.getAutoFaceFailureStats(),
        formatAutoFaceFailureStats,
        (autoFaceFailureStats) => ({ autoFaceFailureStats }),
        { label: "自动贴脸失败统计", loadingKey: "autoFaceFailureLoading" }
      ),
      this.loadAdminModule(
        token,
        "probeHistory",
        () => cloud.getAutoFaceProbeHistory(),
        formatAutoFaceProbeHistory,
        (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
        { label: "探针历史", loadingKey: "probeHistoryLoading" }
      ),
      this.loadAdminModule(
        token,
        "logs",
        () => cloud.listDeploymentLogs(),
        (result) => result || {},
        (result) => ({ logs: (result.logs || []).map(displayLog) }),
        { label: "部署日志" }
      )
    ];
    const allTasks = moduleTasks.slice();
    allTasks.unshift(configTask);
    const results = await Promise.all(allTasks);
    const configResult = results[0];
    const parts = results.slice(1);
    if (
      !this.isCurrentAdminLoad(token)
      || configResult.stale
      || parts.some((part) => part && part.stale)
    ) {
      return;
    }
    const failed = [];
    if (!configResult.ok) failed.push("模型配置");
    if (configResult.ok && configResult.imageApiKeysOk === false) {
      failed.push("生图完整 Key");
    }
    parts.forEach((part, index) => {
      if (!part || part.ok) return;
      const labels = [
        "生图队列",
        "模型用量和成本",
        "用户统计",
        "用户端日志",
        "自动贴脸失败统计",
        "探针历史",
        "部署日志"
      ];
      failed.push(labels[index]);
    });
    this.setData({
      refreshingAll: false,
      message: failed.length
        ? `刷新完成；失败项：${failed.join("、")}`
        : "全部数据已刷新。"
    });
    wx.showToast({
      title: failed.length ? `${failed.length}项失败` : "全部已刷新",
      icon: failed.length ? "none" : "success"
    });
  },

  copyModelFailure(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.modelFailureView.details[index];
    if (!item) return;
    wx.setClipboardData({
      data: modelFailureCopyText(item),
      success: () => wx.showToast({ title: "错误已复制", icon: "success" })
    });
  },

  copyAutoFaceFailure(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.autoFaceFailureView.recent[index];
    if (!item) return;
    wx.setClipboardData({
      data: autoFaceFailureCopyText(item),
      success: () => wx.showToast({ title: "错误已复制", icon: "success" })
    });
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
    const inputValue = event.detail.value;
    const value = (
      ADMIN_PROVIDER_FORM_SECTIONS.includes(section)
      && key === "provider"
    )
      ? displayAdminProvider(inputValue)
      : inputValue;
    const patch = {
      [`form.${section}.${key}`]: value
    };
    if (section === "costs" && ADMIN_COST_KEYS.includes(key)) {
      patch[`costFieldErrors.${key}`] = validateAdminCostInput(value);
    }
    if (key === "model") {
      patch[`currentConfigModels.${section}`] = displayModelName(event.detail.value);
    }
    if (
      (section === "image" || section === "imageBackup" || section === "video")
      && (key === "model" || key === "provider")
    ) {
      const nextForm = Object.assign({}, this.data.form, {
        [section]: Object.assign({}, this.data.form[section], {
          [key]: value
        })
      });
      const profiles = this.data.modelCapabilityProfiles
        && this.data.modelCapabilityProfiles[section]
        ? this.data.modelCapabilityProfiles[section]
        : {};
      const profile = profiles[String(nextForm[section].model || "").trim()];
      const capabilityPayload = {};
      capabilityPayload[section] = profile || {};
      Object.assign(patch, buildQualityPickerState(nextForm, capabilityPayload));
    }
    if (
      section === "costs"
      && (IMAGE_COST_KEYS.includes(key) || VIDEO_COST_KEYS.includes(key))
    ) {
      const nextForm = Object.assign({}, this.data.form, {
        costs: Object.assign({}, this.data.form.costs, {
          [key]: event.detail.value
        })
      });
      const currentImageModel = String(nextForm.image && nextForm.image.model || "").trim();
      const currentVideoModel = String(nextForm.video && nextForm.video.model || "").trim();
      const profiles = this.data.modelCapabilityProfiles || {};
      Object.assign(patch, buildQualityPickerState(nextForm, {
        image: profiles.image && profiles.image[currentImageModel] || {},
        video: profiles.video && profiles.video[currentVideoModel] || {}
      }));
    }
    this.setData(patch);
  },

  async loadTencentFaceFusionStatus(token = this._adminLoadToken || 0) {
    if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) return;
    try {
      const result = await withTimeout(
        cloud.getTencentFaceFusionAdminStatus(),
        8000,
        "腾讯人脸融合状态"
      );
      if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) return;
      this.setData({
        tencentFaceFusionStatus: mergeTencentFaceFusionStatus(result)
      });
    } catch (error) {
      diagnosticLog.warn("admin", "tencent-facefusion-status-failed", "腾讯人脸融合状态读取失败", {
        error
      });
      if (this.isCurrentAdminLoad(token) && this.data.isAdmin) {
        this.setData({
          tencentFaceFusionStatus: formatTencentFaceFusionStatus({
            readFailed: true,
            lastCallStatus: "unavailable"
          })
        });
      }
    }
  },

  chooseTencentTestImage(event) {
    if (this.data.tencentTestLoading) return;
    const kind = event && event.currentTarget && event.currentTarget.dataset
      ? String(event.currentTarget.dataset.kind || "")
      : "";
    if (!["template", "face"].includes(kind)) return;
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (result) => {
        const file = result && result.tempFiles && result.tempFiles[0];
        if (!file || !file.tempFilePath) return;
        this.setData({
          [kind === "template" ? "tencentTestTemplate" : "tencentTestFace"]: {
            path: file.tempFilePath,
            fileID: "",
            size: Number(file.size) || 0
          }
        });
      },
      fail: (error) => {
        diagnosticLog.warn("admin", "tencent-test-image-choose-failed", "腾讯测试图片选择失败", {
          kind,
          error
        });
      }
    });
  },

  async runTencentRealTest() {
    if (this.data.tencentTestLoading) return;
    if (!this.data.tencentTestTemplate || !this.data.tencentTestFace) {
      wx.showToast({ title: "请先选择模板图和参考脸", icon: "none" });
      return;
    }
    if (!this.data.tencentFaceFusionStatus.configured) {
      wx.showToast({ title: "腾讯配置还没完成", icon: "none" });
      return;
    }
    const requestId = `admin-tencent-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.setData({
      tencentTestLoading: true,
      "tencentFaceFusionStatus.lastCallStatus": "processing",
      "tencentFaceFusionStatus.lastErrorMessage": ""
    });
    let templateFileID = "";
    let faceFileID = "";
    try {
      const template = await cloud.uploadFile(
        this.data.tencentTestTemplate.path,
        "tencent-facefusion/admin-test"
      );
      templateFileID = String(template && template.fileID || "");
      const face = await cloud.uploadFile(
        this.data.tencentTestFace.path,
        "tencent-facefusion/admin-test"
      );
      faceFileID = String(face && face.fileID || "");
      if (!templateFileID || !faceFileID) throw new Error("测试图片上传失败");
      const result = await cloud.testTencentFaceFusion({
        templateFileID,
        faceFileID,
        requestId
      }, { requestId });
      await this.loadTencentFaceFusionStatus(this._adminLoadToken || 0);
      const successStatus = buildTencentFaceFusionLocalStatus(
        result,
        requestId,
        "succeeded"
      );
      saveTencentFaceFusionLocalStatus(successStatus);
      this.setData({
        tencentFaceFusionStatus: mergeTencentFaceFusionStatus(
          this.data.tencentFaceFusionStatus
        )
      });
      wx.showToast({
        title: `真实测试成功 ${Number(result.durationMs) || 0}ms`,
        icon: "success"
      });
    } catch (error) {
      await this.loadTencentFaceFusionStatus(this._adminLoadToken || 0);
      const failureStatus = buildTencentFaceFusionLocalStatus(
        error,
        requestId,
        "failed",
        error && error.message
      );
      saveTencentFaceFusionLocalStatus(failureStatus);
      this.setData({
        tencentFaceFusionStatus: mergeTencentFaceFusionStatus(
          this.data.tencentFaceFusionStatus
        )
      });
      this.showError("腾讯真实测试失败", error);
    } finally {
      this.setData({
        tencentTestLoading: false,
        tencentTestTemplate: null,
        tencentTestFace: null
      });
    }
  },

  async runImageEditCapabilityProbeFor(
    configKey,
    loadingKey,
    probeKey,
    targetLabel
  ) {
    if (this.data[loadingKey]) return;
    this.setData({
      [loadingKey]: true,
      message: `正在检查${targetLabel}图片编辑配置；本次不会调用生图，也不会扣费。`
    });
    try {
      const result = await cloud.probeImageEditCapability(
        modelConfigForAction(this.data.form, "image", configKey)
      );
      const probe = formatImageEditCapabilityProbe(result);
      this.setData({
        [loadingKey]: false,
        [probeKey]: probe,
        message: `${targetLabel}${probe.statusText}。${probe.message}`
      });
      wx.showToast({
        title: probe.ready ? "配置检查完成" : "配置需要处理",
        icon: probe.ready ? "success" : "none"
      });
    } catch (error) {
      const probe = Object.assign(emptyImageEditCapabilityProbe(), {
        checked: true,
        tone: "error",
        status: "failed",
        statusText: "配置检查失败",
        message: String(error && error.message || "图片编辑配置检查失败")
      });
      this.setData({
        [loadingKey]: false,
        [probeKey]: probe,
        message: `${targetLabel}${probe.message}`
      });
      this.showError(`${targetLabel}图片编辑配置检查失败`, error);
    }
  },

  runImageEditCapabilityProbe() {
    return this.runImageEditCapabilityProbeFor(
      "image",
      "imageEditCapabilityLoading",
      "imageEditCapabilityProbe",
      "主模型"
    );
  },

  runImageBackupEditCapabilityProbe() {
    return this.runImageEditCapabilityProbeFor(
      "imageBackup",
      "imageBackupEditCapabilityLoading",
      "imageBackupEditCapabilityProbe",
      "备用模型"
    );
  },

  onImageQualityChange(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.imageQualityOptions[index] || IMAGE_QUALITY_OPTIONS[0];
    const nextForm = Object.assign({}, this.data.form, {
      image: Object.assign({}, this.data.form.image, {
        resolution: option.value
      })
    });
    this.setData(Object.assign({
      "form.image.resolution": option.value
    }, buildQualityPickerState(nextForm, {
      image: this.data.modelCapabilityProfiles.image
        && this.data.modelCapabilityProfiles.image[nextForm.image.model]
        || {}
    })));
  },

  onImageSizeChange(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.imageSizeOptions[index] || IMAGE_SIZE_OPTIONS[0];
    const nextForm = Object.assign({}, this.data.form, {
      image: Object.assign({}, this.data.form.image, {
        size: option.value
      })
    });
    this.setData(Object.assign({
      "form.image.size": option.value
    }, buildQualityPickerState(nextForm, {
      image: this.data.modelCapabilityProfiles.image
        && this.data.modelCapabilityProfiles.image[nextForm.image.model]
        || {}
      })));
  },

  onImageBackupQualityChange(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.imageBackupQualityOptions[index] || IMAGE_QUALITY_OPTIONS[0];
    const nextForm = Object.assign({}, this.data.form, {
      imageBackup: Object.assign({}, this.data.form.imageBackup, {
        resolution: option.value
      })
    });
    this.setData(Object.assign({
      "form.imageBackup.resolution": option.value
    }, buildQualityPickerState(nextForm)));
  },

  onImageBackupSizeChange(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.imageBackupSizeOptions[index] || IMAGE_SIZE_OPTIONS[0];
    const nextForm = Object.assign({}, this.data.form, {
      imageBackup: Object.assign({}, this.data.form.imageBackup, {
        size: option.value
      })
    });
    this.setData(Object.assign({
      "form.imageBackup.size": option.value
    }, buildQualityPickerState(nextForm)));
  },

  onVideoQualityChange(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 1);
    const option = this.data.videoQualityOptions[index] || VIDEO_QUALITY_OPTIONS[1];
    const nextForm = Object.assign({}, this.data.form, {
      video: Object.assign({}, this.data.form.video, {
        resolution: option.value
      })
    });
    this.setData(Object.assign({
      "form.video.resolution": option.value
    }, buildQualityPickerState(nextForm, {
      video: this.data.modelCapabilityProfiles.video
        && this.data.modelCapabilityProfiles.video[nextForm.video.model]
        || {}
    })));
  },

  onRetryChange(event) {
    this.setData({
      "form.image.retryEnabled": Array.isArray(event.detail.value)
        && event.detail.value.includes("enabled")
    });
  },

  onImageCompatibilityChange(event) {
    this.setData({
      "form.image.compatibilityMode": Array.isArray(event.detail.value)
        && event.detail.value.includes("enabled")
    });
  },

  copyFaceConfigToAnalysis() {
    const face = this.data.form && this.data.form.face
      ? this.data.form.face
      : emptyForm().face;
    this.setData({
      "form.analysis.provider": face.provider || "",
      "form.analysis.baseUrl": face.baseUrl || "",
      "form.analysis.endpoint": face.endpoint || "",
      "form.analysis.apiKey": face.apiKey || "",
      "form.analysis.model": face.model || "",
      "form.analysis.timeoutMs": String(face.timeoutMs || "30000"),
      message: "已复制人脸配置到图片分析；点击“保存全部配置”后才会生效。"
    });
    wx.showToast({ title: "已复制，记得保存", icon: "none" });
  },

  toggleConfigSection(event) {
    const section = event.currentTarget.dataset.section;
    if (!CONFIG_SECTION_TITLES[section]) return;
    const nextSection = section === "tencentImage" && this.data.activeConfigSection === section
      ? ""
      : section;
    this.setData({
      activeConfigSection: nextSection,
      activeConfigTitle: nextSection ? CONFIG_SECTION_TITLES[nextSection] : ""
    }, () => {
      this.persistMonitorLayout();
      if (nextSection === "users" && this.data.userStats.unavailable) {
        this.refreshUserStats(true);
      }
      if (nextSection && typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: configEditorSelector(nextSection),
          duration: 220
        });
      }
    });
  },

  closeConfigSection() {
    this.setData({
      activeConfigSection: "",
      activeConfigTitle: ""
    }, () => this.persistMonitorLayout());
  },

  toggleMonitor() {
    this.setData({
      monitorExpanded: !this.data.monitorExpanded
    }, () => this.persistMonitorLayout());
  },

  async exportModelFailureStats() {
    if (this.data.modelFailureExporting) return;
    const monthKey = this.data.modelFailureView.selectedMonth
      || this.data.usageStats.todayKey.slice(0, 7);
    this.setData({ modelFailureExporting: true });
    try {
      const result = await cloud.exportModelFailureStats(monthKey);
      if (!result || !result.fileID) throw new Error("失败统计 Excel 生成失败。");
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
      this.setData({ modelFailureExporting: false });
      wx.showToast({ title: "失败统计已导出", icon: "success" });
    } catch (error) {
      this.setData({ modelFailureExporting: false });
      diagnosticLog.error("admin", "model-failure-export-failed", "模型失败统计 Excel 导出失败", { error });
      this.showError("导出失败", error);
    }
  },

  toggleMonitorSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.section
        : ""
    );
    if (!MONITOR_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`monitorSections.${section}`]: !this.data.monitorSections[section]
    }, () => this.persistMonitorLayout());
  },

  setAllUsageSections(event) {
    const expanded = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.expanded
        : 0
    ) === 1;
    const patch = {
      usageExpanded: expanded
    };
    USAGE_SECTION_KEYS.forEach((section) => {
      patch[`usageSections.${section}`] = expanded;
    });
    this.setData(patch, () => this.persistMonitorLayout());
  },

  restoreMonitorLayout() {
    let stored = {};
    try {
      stored = wx.getStorageSync(MONITOR_LAYOUT_STORAGE_KEY) || {};
    } catch (error) {
      stored = {};
    }
    const storedMonitorSections = stored.monitorSections || {};
    const storedUsageSections = stored.usageSections || {};
    const storedAutoFaceFailureSections = stored.autoFaceFailureSections || {};
    const storedDeploymentSections = stored.deploymentSections || {};
    const storedActiveConfigSection = typeof stored.activeConfigSection === "string"
      && CONFIG_SECTION_TITLES[stored.activeConfigSection]
      ? stored.activeConfigSection
      : "";
    const usageExpanded = typeof stored.usageExpanded === "boolean"
      ? stored.usageExpanded
      : typeof storedMonitorSections.usage === "boolean"
        ? storedMonitorSections.usage
        : Boolean(this.data.usageExpanded);
    const monitorSections = {};
    MONITOR_SECTION_KEYS.forEach((section) => {
      monitorSections[section] = typeof storedMonitorSections[section] === "boolean"
        ? storedMonitorSections[section]
        : Boolean(this.data.monitorSections[section]);
    });
    const usageSections = {};
    USAGE_SECTION_KEYS.forEach((section) => {
      usageSections[section] = typeof storedUsageSections[section] === "boolean"
        ? storedUsageSections[section]
        : Boolean(this.data.usageSections[section]);
    });
    const autoFaceFailureSections = {};
    AUTO_FACE_FAILURE_SECTION_KEYS.forEach((section) => {
      autoFaceFailureSections[section] = typeof storedAutoFaceFailureSections[section] === "boolean"
        ? storedAutoFaceFailureSections[section]
        : Boolean(this.data.autoFaceFailureSections[section]);
    });
    const deploymentSections = {};
    DEPLOYMENT_SECTION_KEYS.forEach((section) => {
      deploymentSections[section] = typeof storedDeploymentSections[section] === "boolean"
        ? storedDeploymentSections[section]
        : Boolean(this.data.deploymentSections[section]);
    });
    this.setData({
      monitorExpanded: typeof stored.monitorExpanded === "boolean"
        ? stored.monitorExpanded
        : this.data.monitorExpanded,
      usageExpanded,
      monitorSections,
      usageSections,
      autoFaceFailureSections,
      deploymentSections,
      activeConfigSection: storedActiveConfigSection,
      activeConfigTitle: storedActiveConfigSection
        ? CONFIG_SECTION_TITLES[storedActiveConfigSection]
        : ""
    });
  },

  async exportAutoFaceFailureStats() {
    if (this.data.autoFaceFailureExporting) return;
    const monthKey = this.data.autoFaceFailureView.selectedMonth
      || this.data.autoFaceFailureStats.todayKey.slice(0, 7);
    this.setData({ autoFaceFailureExporting: true });
    try {
      const result = await cloud.exportAutoFaceFailureStats(monthKey);
      if (!result || !result.fileID) throw new Error("失败统计 Excel 生成失败。");
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
      this.setData({ autoFaceFailureExporting: false });
      wx.showToast({ title: "失败统计已导出", icon: "success" });
    } catch (error) {
      this.setData({ autoFaceFailureExporting: false });
      diagnosticLog.error("admin", "auto-face-failure-export-failed", "自动贴脸失败统计 Excel 导出失败", {
        error,
        monthKey
      });
      this.showError("导出失败", error);
    }
  },

  persistMonitorLayout() {
    try {
      wx.setStorageSync(MONITOR_LAYOUT_STORAGE_KEY, {
        version: 6,
        monitorExpanded: Boolean(this.data.monitorExpanded),
        usageExpanded: Boolean(this.data.usageExpanded),
        monitorSections: Object.assign({}, this.data.monitorSections),
        usageSections: Object.assign({}, this.data.usageSections),
        autoFaceFailureSections: Object.assign({}, this.data.autoFaceFailureSections),
        deploymentSections: Object.assign({}, this.data.deploymentSections),
        activeConfigSection: CONFIG_SECTION_TITLES[this.data.activeConfigSection]
          ? this.data.activeConfigSection
          : ""
      });
    } catch (error) {
      // 本地缓存不可用时不影响管理页继续使用。
    }
  },

  toggleUsageSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.usageSection
        : ""
    );
    if (!USAGE_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`usageSections.${section}`]: !this.data.usageSections[section]
    }, () => this.persistMonitorLayout());
  },

  toggleAutoFaceFailureSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.autoFaceFailureSection
        : ""
    );
    if (!AUTO_FACE_FAILURE_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`autoFaceFailureSections.${section}`]: !this.data.autoFaceFailureSections[section]
    }, () => this.persistMonitorLayout());
  },

  toggleUsageCard() {
    this.setData({
      usageExpanded: !this.data.usageExpanded
    }, () => this.persistMonitorLayout());
  },

  toggleDeploymentSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.deploymentSection
        : ""
    );
    if (!DEPLOYMENT_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`deploymentSections.${section}`]: !this.data.deploymentSections[section]
    }, () => this.persistMonitorLayout());
  },

  jumpToUsageSection() {
    this.setData({
      usageExpanded: true
    }, () => {
      this.persistMonitorLayout();
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: "#usage-section",
          duration: 220
        });
      }
    });
  },

  jumpToMonitorSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.section
        : ""
    );
    if (!MONITOR_SECTION_KEYS.includes(section)) return;
    this.setData({
      monitorExpanded: true,
      [`monitorSections.${section}`]: true
    }, () => {
      this.persistMonitorLayout();
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: `#monitor-section-${section}`,
          duration: 220
        });
      }
    });
  },

  jumpToProbeHistory() {
    this.setData({
      monitorExpanded: true,
      "monitorSections.deployment": true,
      "deploymentSections.probeHistory": true
    }, () => {
      this.persistMonitorLayout();
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: "#monitor-section-probeHistory",
          duration: 220
        });
      }
    });
  },

  async saveConfig() {
    if (this.data.saving) return;
    const costFieldErrors = validateAdminCostFields(this.data.form.costs);
    const invalidCostKeys = Object.keys(costFieldErrors);
    if (invalidCostKeys.length) {
      const firstKey = invalidCostKeys[0];
      this.setData({
        costFieldErrors,
        activeConfigSection: "costs",
        activeConfigTitle: CONFIG_SECTION_TITLES.costs,
        message: `成本配置有 ${invalidCostKeys.length} 项需要修改。`
      });
      wx.showModal({
        title: "成本价格填写有误",
        content: costFieldErrors[firstKey],
        showCancel: false
      });
      return;
    }
    this.setData({ saving: true, message: "" });
    try {
      const savedImageApiKeys = adminImageApiKeysAfterSave(
        this.data.form,
        this._imageApiKeyBaseline
      );
      const result = await cloud.saveAdminConfig(
        adminConfigSavePayload(
          this.data.form,
          this._imageApiKeyBaseline
        )
      );
      const effective = result.effective || null;
      const form = formWithAdminImageApiKeys(
        formFromConfig(result),
        savedImageApiKeys
      );
      this._imageApiKeyBaseline = savedImageApiKeys;
      const patch = Object.assign({
        form,
        costFieldErrors: {},
        effective,
        saving: false,
        message: `配置已保存，第 ${result.version || 0} 版；正在自动测试四套模型和生图三档清晰度...`
      }, buildQualityPickerState(form));
      Object.assign(patch, this.buildAdminDerivedPatch(patch, this.data.moduleStates));
      this.setData(patch);
      diagnosticLog.info("admin", "config-saved", "管理员配置保存完成", {
        version: result.version || 0
      });
      wx.showToast({ title: "已保存，正在测试", icon: "loading", duration: 1200 });
      await this.runModelProbe("");
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
      const probeStartedAt = Date.now();
      const deploymentResults = await Promise.all([
        cloud.checkDeployment(),
        cloud.probeAutoFace().catch((error) => ({ __probeError: error }))
      ]);
      const result = deploymentResults[0];
      const probeResult = deploymentResults[1];
      const probeError = probeResult && probeResult.__probeError;
      if (probeResult && !probeError) {
        probeResult.clientDurationMs = Math.max(0, Date.now() - probeStartedAt);
      }
      const deploymentLogResults = await Promise.all([
        cloud.listDeploymentLogs(),
        cloud.getAutoFaceProbeHistory().catch((error) => ({ __historyError: error }))
      ]);
      const logs = deploymentLogResults[0];
      const probeHistoryResult = deploymentLogResults[1];
      const historyError = probeHistoryResult && probeHistoryResult.__historyError;
      const historyUnavailable = Boolean(
        historyError
        || (probeResult && !probeError && probeResult.historyWritten === false)
      );
      const autoFaceProbe = formatAutoFaceProbe(
        probeError ? null : probeResult,
        probeError || null
      );
      const autoFaceProbeHistory = historyError
        ? Object.assign(emptyAutoFaceProbeHistory(), {
          unavailable: true,
          message: "探针结果已返回，但历史读取失败。"
        })
        : formatAutoFaceProbeHistory(probeHistoryResult);
      this.setData({
        deployment: result,
        logs: (logs.logs || []).map(displayLog),
        autoFaceProbe,
        autoFaceProbeHistory,
        dashboardStatus: buildDashboardStatus(
          this.data.effective,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        faceConfigSummary: buildFaceConfigSummary(
          this.data.effective,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        analysisConfigSummary: buildAnalysisConfigSummary(this.data.effective),
        entryHealth: buildEntryHealth(
          this.data.effective,
          this.data.usageStats,
          autoFaceProbe,
          autoFaceProbeHistory,
          this.data.autoFaceFailureStats,
          this.data.userStats
        ),
        monitorExpanded: true,
        checking: false,
        message: result.logWritten
          ? (
            probeError
              ? "线上部署完成，但自动贴脸探针失败。"
              : historyUnavailable
                ? "线上部署检查完成，但探针历史暂时没有写入。"
                : "线上部署检查完成，日志已写入。"
          )
          : "检查完成，但日志写入失败。"
      });
      diagnosticLog.info("admin", "deployment-checked", "线上部署检查完成", {
        buildVersion: result.buildVersion,
        buildMarker: result.buildMarker,
        probeStatus: probeError ? "failed" : "ok",
        probeBuildVersion: probeResult && probeResult.buildVersion || "",
        probeVisionConfigured: Boolean(
          probeResult && probeResult.vision && probeResult.vision.configured
        ),
        logWritten: result.logWritten
      });
    } catch (error) {
      this.setData({ checking: false });
      diagnosticLog.error("admin", "deployment-check-failed", "线上部署检查失败", { error });
      this.showError("检查失败", error);
    }
  },

  async testModelConnection(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset
      : {};
    const modelType = String(dataset.modelType || "").trim();
    const modelConfigKey = modelConfigKeyForAction(
      this.data.form,
      modelType,
      dataset.modelConfig
    );
    if (!USAGE_TYPE_META.some((item) => item.key === modelType)) return;
    if (this.data.modelActionType) return;
    const typeLabel = usageTypeLabel(modelType);
    const targetLabel = modelConfigKey === "imageBackup"
      ? "备用生图"
      : typeLabel;
    this.setData({
      modelActionType: modelType,
      modelActionKind: "test",
      modelActionTarget: modelConfigKey,
      message: `正在测试${targetLabel}连接...`
    });
    try {
      const result = await cloud.probeModels(
        modelType,
        modelConfigForAction(this.data.form, modelType, modelConfigKey)
      );
      const target = result && Array.isArray(result.results)
        ? result.results[0]
        : null;
      const ok = Boolean(target && target.status === "ok" && target.ready);
      const message = ok
        ? target && target.message
          ? target.message
          : "接口可访问，当前模型配置正常。"
        : formatModelConnectionFailure(typeLabel, result);
      this.setData({
        message: `${targetLabel}测试完成：${message}`
      });
      wx.showModal({
        title: ok ? "连接成功" : "连接未通过",
        content: message,
        showCancel: false
      });
    } catch (error) {
      diagnosticLog.error("admin", "model-connection-test-failed", `${typeLabel}连接测试失败`, {
        error,
        modelType
      });
      const message = formatModelConnectionFailure(typeLabel, null, error);
      this.setData({
        message: `${targetLabel}测试失败：${message}`
      });
      wx.showModal({
        title: "连接失败",
        content: message,
        showCancel: false
      });
    } finally {
      this.setData({
        modelActionType: "",
        modelActionKind: "",
        modelActionTarget: ""
      });
    }
  },

  async getModelOptions(event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset
      : {};
    const modelType = String(dataset.modelType || "").trim();
    const modelConfigKey = modelConfigKeyForAction(
      this.data.form,
      modelType,
      dataset.modelConfig
    );
    if (!USAGE_TYPE_META.some((item) => item.key === modelType)) return;
    if (this.data.modelActionType) return;
    const typeLabel = usageTypeLabel(modelType);
    const targetLabel = modelConfigKey === "imageBackup"
      ? "备用生图"
      : typeLabel;
    this.setData({
      modelActionType: modelType,
      modelActionKind: "list",
      modelActionTarget: modelConfigKey,
      message: `正在读取${targetLabel}模型列表...`
    });
    try {
      const result = await cloud.listModels(
        modelType,
        modelConfigForAction(this.data.form, modelType, modelConfigKey)
      );
      const options = normalizeModelOptions(result);
      if (!options.length) {
        const error = new Error(
          result && result.message
            ? result.message
            : "接口没有返回可用模型。"
        );
        error.payload = Object.assign({}, result, {
          modelTypeLabel: typeLabel
        });
        throw error;
      }
      const modelCapabilityProfiles = Object.assign(
        {},
        this.data.modelCapabilityProfiles || {},
        {
          [modelConfigKey]: result.modelCapabilities || {}
        }
      );
      const currentModel = String(
        this.data.form[modelConfigKey]
          && this.data.form[modelConfigKey].model
          || ""
      ).trim();
      const capabilityPayload = {};
      if (modelConfigKey === modelType) {
        capabilityPayload[modelType] = result.capabilities
          || modelCapabilityProfiles[modelConfigKey][currentModel]
          || {};
      }
      this.setData(Object.assign({
        modelPickerOpen: true,
        modelPickerType: modelType,
        modelPickerTarget: modelConfigKey,
        modelPickerTitle: `${targetLabel}模型列表`,
        modelPickerSearch: "",
        modelPickerAllOptions: options,
        modelPickerOptions: options,
        modelCapabilityProfiles,
        message: `已读取 ${options.length} 个${targetLabel}模型。`
      }, buildQualityPickerState(this.data.form, capabilityPayload)));
    } catch (error) {
      diagnosticLog.error("admin", "model-list-failed", `${typeLabel}模型列表读取失败`, {
        error,
        modelType
      });
      this.showError("获取模型失败", error);
    } finally {
      this.setData({
        modelActionType: "",
        modelActionKind: "",
        modelActionTarget: ""
      });
    }
  },

  closeModelPicker() {
    this.setData({
      modelPickerOpen: false,
      modelPickerType: "",
      modelPickerTarget: "",
      modelPickerTitle: "",
      modelPickerSearch: "",
      modelPickerAllOptions: [],
      modelPickerOptions: []
    });
  },

  onModelPickerSearchInput(event) {
    const search = String(event && event.detail && event.detail.value || "")
      .slice(0, 64);
    this.setData({
      modelPickerSearch: search,
      modelPickerOptions: filterModelOptions(this.data.modelPickerAllOptions, search)
    });
  },

  clearModelPickerSearch() {
    if (!this.data.modelPickerSearch) return;
    this.setData({
      modelPickerSearch: "",
      modelPickerOptions: filterModelOptions(this.data.modelPickerAllOptions, "")
    });
  },

  selectModelOption(event) {
    const type = String(
      this.data.modelPickerType
        || event && event.currentTarget && event.currentTarget.dataset && event.currentTarget.dataset.type
        || ""
    ).trim();
    const value = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.value
      : ""
    ).trim();
    if (!type || !value) return;
    const configKey = modelConfigKeyForAction(
      this.data.form,
      type,
      this.data.modelPickerTarget
    );
    const nextForm = Object.assign({}, this.data.form, {
      [configKey]: Object.assign({}, this.data.form[configKey], {
        model: value
      })
    });
    const profile = this.data.modelCapabilityProfiles
      && this.data.modelCapabilityProfiles[configKey]
      && this.data.modelCapabilityProfiles[configKey][value]
      || {};
    const capabilityPayload = {};
    if (configKey === type) {
      capabilityPayload[type] = profile;
    }
    const patch = {
      [`form.${configKey}.model`]: value,
      modelPickerOpen: false,
      modelPickerType: "",
      modelPickerTarget: "",
      modelPickerTitle: "",
      modelPickerSearch: "",
      modelPickerAllOptions: [],
      modelPickerOptions: [],
      message: `已选择${configKey === "imageBackup" ? "备用生图" : usageTypeLabel(type)}模型：${value}；点击“保存全部配置”后才会生效。`
    };
    if (configKey === type) {
      patch[`currentConfigModels.${type}`] = displayModelName(value);
    }
    this.setData(Object.assign(
      patch,
      buildQualityPickerState(nextForm, capabilityPayload)
    ));
    wx.showToast({ title: "模型已填入", icon: "success" });
  },

  probeModels() {
    return this.runModelProbe("");
  },

  refreshModelProbeResults() {
    if (this.data.modelProbing) return;
    return this.runModelProbe("");
  },

  probeSingleModel(event) {
    const modelType = String(
      event && event.currentTarget && event.currentTarget.dataset.modelType || ""
    ).trim();
    if (!modelType) return;
    return this.runModelProbe(modelType);
  },

  async runModelProbe(modelType = "") {
    if (this.data.modelProbing) return;
    const typeLabel = modelType ? usageTypeLabel(modelType) : "四套模型";
    this.setData({
      modelProbing: true,
      modelProbingType: modelType || "all",
      message: `正在探测${typeLabel}接口...`
    });
    try {
      const result = await cloud.probeModels(modelType);
      const formatted = formatModelProbes(result);
      const modelProbes = modelType
        ? mergeSingleModelProbe(this.data.modelProbes, formatted, modelType)
        : formatted;
      const target = modelType
        ? modelProbes.results.find((item) => item.type === modelType)
        : null;
      const modelCapabilityProfiles = Object.assign(
        {},
        this.data.modelCapabilityProfiles || {}
      );
      const capabilityPayload = {};
      modelProbes.results.forEach((item) => {
        if (!item || !item.type || !item.capabilities) return;
        const modelId = String(item.modelId || "").trim();
        const profiles = Object.assign(
          {},
          modelCapabilityProfiles[item.type] || {}
        );
        if (modelId) profiles[modelId] = item.capabilities;
        modelCapabilityProfiles[item.type] = profiles;
        if (item.type === "image") capabilityPayload.image = item.capabilities;
        if (item.type === "video") capabilityPayload.video = item.capabilities;
      });
      const imageProbe = modelProbes.results.find((item) => item.type === "image");
      const qualitySummary = imageProbe && imageProbe.qualityProbe
        ? ` 生图清晰度：${imageProbe.qualityProbe.summaryText}（只读能力，不实际生成图片）。`
        : "";
      const pickerPatch = Object.keys(capabilityPayload).length
        ? buildQualityPickerState(this.data.form, capabilityPayload)
        : {};
      this.setData(Object.assign({
        modelProbing: false,
        modelProbingType: "",
        modelProbes,
        modelCapabilityProfiles,
        imageQualityProbe: imageProbe && imageProbe.qualityProbe
          ? imageProbe.qualityProbe
          : this.data.imageQualityProbe,
        monitorExpanded: true,
        message: modelType && target
          ? `${target.typeLabel}探测完成：${target.statusText}。${
            target.ready
              ? ""
              : ` ${target.message || "连接测试未通过。"}${
                target.repairAdvice ? ` 修复建议：${target.repairAdvice}` : ""
                }`
          }${qualitySummary}`
          : modelProbes.readyCount === modelProbes.total
            ? `模型接口探测完成：${modelProbes.readyCount}/${modelProbes.total} 套正常。${qualitySummary}`
            : `模型接口探测完成：${modelProbes.readyCount}/${modelProbes.total} 套正常，失败项请按下方修复建议处理。${qualitySummary}`
      }, pickerPatch));
      wx.showToast({
        title: modelType && target
          ? `${target.typeLabel}${target.statusText}`
          : modelProbes.readyCount === modelProbes.total
            ? "四套模型均正常"
            : `${modelProbes.readyCount}/${modelProbes.total} 套正常`,
        icon: modelType
          ? target && target.ready ? "success" : "none"
          : modelProbes.readyCount === modelProbes.total ? "success" : "none"
      });
    } catch (error) {
      const formatted = formatModelProbes(error && error.payload, error);
      const modelProbes = modelType && formatted.results.length
        ? mergeSingleModelProbe(this.data.modelProbes, formatted, modelType)
        : this.data.modelProbes;
      this.setData({
        modelProbing: false,
        modelProbingType: "",
        modelProbes,
        monitorExpanded: true,
        message: `${typeLabel}接口探测失败，请查看结果说明。`
      });
      diagnosticLog.error(
        "admin",
        "model-probe-failed",
        `${typeLabel}接口探测失败`,
        { error, modelType }
      );
      this.showError("探测失败", error);
    }
  },

  backToWorkbench() {
    wx.reLaunch({ url: "/pages/workbench/workbench" });
  },

  showError(title, error) {
    const payload = error && error.payload;
    const originalMessage = (payload && (payload.message || payload.error))
      || (error && error.message)
      || "请稍后重试";
    const modelTypeLabel = payload && payload.modelTypeLabel
      ? normalizeAdminModelLabel(payload.modelTypeLabel)
      : "";
    const message = modelTypeLabel
      && !String(originalMessage).startsWith(`${modelTypeLabel}模型：`)
      ? `${modelTypeLabel}模型：${originalMessage}`
      : originalMessage;
    wx.showModal({
      title,
      content: String(message),
      showCancel: false
    });
  }
});
