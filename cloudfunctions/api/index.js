const API_BUILD_VERSION = "0.23.0";
const API_BUILD_MARKER = "API_BUILD_TAG_20260824_ADMIN_PROBE_HISTORY_V230";
console.log(`[api] build=${API_BUILD_VERSION} marker=${API_BUILD_MARKER}`);

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { PNG } = require("pngjs");
const XLSX = require("xlsx");

// CloudBase 某些部署实例会丢失自定义相对模块，入口必须可以单文件启动。
const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const ADMIN_RUNTIME_CONFIG_COLLECTION = "admin_runtime_config";
const ADMIN_RUNTIME_CONFIG_ID = "global";
const ADMIN_DEPLOYMENT_LOG_COLLECTION = "admin_deployment_logs";
const MODEL_USAGE_EVENT_COLLECTION = "model_usage_events";
const MODEL_USAGE_TIME_ZONE = "Asia/Shanghai";
const MODEL_USAGE_TYPES = ["image", "face", "video"];
const AUTO_FACE_FAILURE_LOG_COLLECTION = "auto_face_failure_logs";
const AUTO_FACE_FAILURE_TIME_ZONE = "Asia/Shanghai";
const AUTO_FACE_PROBE_LOG_COLLECTION = "auto_face_probe_logs";
const AUTO_FACE_PROBE_RETENTION_DAYS = 30;
const AUTO_FACE_PROBE_CLEANUP_BATCH_SIZE = 100;
const AUTO_FACE_FAILURE_TYPES = [
  "cloud-unavailable",
  "missing-api-key",
  "missing-main-image",
  "image-too-large",
  "empty-face-detection",
  "timeout",
  "upstream",
  "network",
  "unknown"
];
const AUTO_FACE_PROBE_STATUSES = ["ok", "failed", "pending", "not-run"];
const AUTO_FACE_FAILURE_TYPE_LABELS = {
  "cloud-unavailable": "云端未连接",
  "missing-api-key": "视觉服务未配置",
  "missing-main-image": "主图未上传",
  "image-too-large": "图片过大",
  "empty-face-detection": "未识别到清晰人脸",
  timeout: "识别超时",
  upstream: "上游服务异常",
  network: "网络异常",
  unknown: "其他失败"
};
const AUTO_FACE_FAILURE_RETENTION_DAYS = 90;
const AUTO_FACE_FAILURE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_FACE_FAILURE_CLEANUP_BATCH_SIZE = 100;
const PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION = "photo_to_video_temp_assets";
const PHOTO_TO_VIDEO_TEMP_ASSET_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE = 100;
const MODEL_COST_CONFIG_VERSION = "2026-08-23-v1";
const ADMIN_RUNTIME_CACHE_TTL_MS = 15000;
const POINTS_ACCOUNT_COLLECTION = "user_accounts";
const POINTS_LEDGER_COLLECTION = "point_ledger";
const USER_QUOTA_COLLECTION = "user_quotas";
const GENERATION_OPERATION_COLLECTION = "generation_operations";
const POINTS_TIME_ZONE = "Asia/Shanghai";
const GENERATION_OPERATION_STALE_MS = 10 * 60 * 1000;
const ASSET_UPLOAD_TICKET_COLLECTION = "asset_upload_tickets";
const USER_ASSET_COLLECTION = "user_assets";
const REPAIR_CHAIN_COLLECTION = "repair_chains";
const REPAIR_MAX_REVISIONS = 10;
const ASSET_TICKET_TTL_MS = 10 * 60 * 1000;
const REPAIR_ASSET_KINDS = new Set(["main", "mask", "face", "wardrobe"]);
let adminRuntimeCache = {
  value: null,
  expiresAt: 0
};

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "true" : "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function firstEnv(names, fallback = "") {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return fallback;
}

function resolveVisionConfig() {
  return {
    provider: firstEnv(["AI_VISION_PROVIDER", "AI_PROVIDER"], "dashscope"),
    baseUrl: firstEnv(
      ["AI_VISION_BASE_URL", "AI_BASE_URL"],
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ),
    apiKey: firstEnv(["AI_VISION_API_KEY", "AI_API_KEY"]),
    model: env("AI_VISION_MODEL", "qwen3-vl-flash"),
    faceModel: env("AI_FACE_MODEL", "qwen3-vl-flash"),
    endpoint: env("AI_VISION_ENDPOINT"),
    timeoutMs: Math.max(
      5000,
      Math.min(
        60000,
        Number(firstEnv(["AI_VISION_TIMEOUT_MS", "AI_TIMEOUT_MS"], "25000")) || 25000
      )
    ),
    maxImageBytes: Math.max(
      256 * 1024,
      Math.min(
        20 * 1024 * 1024,
        Number(env("AI_VISION_MAX_IMAGE_BYTES", String(5 * 1024 * 1024))) || 5 * 1024 * 1024
      )
    )
  };
}

function buildAutoFaceProbe() {
  const vision = resolveVisionConfig();
  return {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    runtime: {
      nodeVersion: process.version,
      cloudEnvConfigured: Boolean(env("CLOUDBASE_ENV_ID"))
    },
    vision: {
      configured: Boolean(
        vision.apiKey &&
        (vision.endpoint || vision.baseUrl) &&
        (vision.faceModel || vision.model)
      ),
      apiKeyConfigured: Boolean(vision.apiKey),
      endpointConfigured: Boolean(vision.endpoint || vision.baseUrl),
      provider: vision.provider || "",
      model: vision.faceModel || vision.model || ""
    },
    checkedAt: new Date().toISOString()
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function overrideString(overrides, key, fallback) {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key)) return fallback;
  const value = String(overrides[key] === null || overrides[key] === undefined ? "" : overrides[key]).trim();
  return value || fallback;
}

function overrideBoolean(overrides, key, fallback) {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key)) return fallback;
  return Boolean(overrides[key]);
}

function resolveImageConfig(overrides = {}) {
  const image = overrides && overrides.image ? overrides.image : overrides;
  const mode = overrideString(image, "mode", env("AI_IMAGE_MODE", "generations")).toLowerCase();
  return {
    provider: overrideString(
      image,
      "provider",
      firstEnv(["AI_IMAGE_PROVIDER", "AI_PROVIDER"], "openai-compatible")
    ),
    baseUrl: overrideString(image, "baseUrl", firstEnv(
      ["AI_IMAGE_BASE_URL", "AI_BASE_URL"],
      "https://api.openai.com/v1"
    )),
    endpoint: overrideString(image, "endpoint", env("AI_IMAGE_ENDPOINT")),
    apiKey: firstEnv(["AI_IMAGE_API_KEY", "AI_API_KEY"]),
    model: overrideString(image, "model", env("AI_IMAGE_MODEL", "gpt-image-2")),
    size: overrideString(image, "size", env("AI_IMAGE_SIZE", "1024x1024")),
    mode,
    timeoutMs: clampNumber(
      image && Object.prototype.hasOwnProperty.call(image, "timeoutMs")
        ? image.timeoutMs
        : firstEnv(["AI_IMAGE_TIMEOUT_MS", "AI_TIMEOUT_MS"], "90000"),
      90000,
      5000,
      120000
    ),
    maxRetries: clampNumber(
      image && Object.prototype.hasOwnProperty.call(image, "maxRetries")
        ? image.maxRetries
        : env("AI_MAX_RETRIES", "2"),
      2,
      0,
      5
    ),
    retryEnabled: overrideBoolean(image, "retryEnabled", imageRetryEnabled())
  };
}

function resolveVideoConfig(overrides = {}) {
  const video = overrides && overrides.video ? overrides.video : overrides;
  const provider = overrideString(video, "provider", firstEnv(["AI_VIDEO_PROVIDER"]));
  const baseUrl = overrideString(video, "baseUrl", firstEnv(["AI_VIDEO_BASE_URL"]));
  const endpointValue = overrideString(video, "endpoint", env("AI_VIDEO_ENDPOINT"));
  const apiKey = firstEnv(["AI_VIDEO_API_KEY", "AI_VIDEO_KEY"]);
  const model = overrideString(video, "model", env("AI_VIDEO_MODEL", "grok-imagine-video-1.5"));
  return {
    provider,
    baseUrl,
    endpoint: endpointValue,
    queryEndpoint: overrideString(video, "queryEndpoint", env("AI_VIDEO_QUERY_ENDPOINT")),
    apiKey,
    model,
    createPath: overrideString(video, "createPath", env("AI_VIDEO_CREATE_PATH", "/v1/videos/generations")),
    queryPath: overrideString(video, "queryPath", env("AI_VIDEO_QUERY_PATH", "/v1/videos/{taskId}")),
    resolution: overrideString(video, "resolution", env("AI_VIDEO_RESOLUTION", "720p")),
    aspectRatio: overrideString(video, "aspectRatio", env("AI_VIDEO_ASPECT_RATIO", "")),
    prompt: env(
      "AI_VIDEO_PROMPT",
      "让照片中的人物自然轻微运动，保持人物身份、脸部、发型、服装和背景不变，镜头稳定，动作连贯，不要新增人物，不要变形。"
    ),
    timeoutMs: Math.max(
      10000,
      Math.min(
        15 * 60 * 1000,
        Number(
          video && Object.prototype.hasOwnProperty.call(video, "timeoutMs")
            ? video.timeoutMs
            : env("AI_VIDEO_TIMEOUT_MS", "90000")
        ) || 90000
      )
    ),
    configured: Boolean(provider && (baseUrl || endpoint) && apiKey && model)
  };
}

function resolvePointsConfig(overrides = {}) {
  const points = overrides && overrides.points ? overrides.points : overrides;
  return {
    dailyFreeLimit: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "dailyFreeLimit")
        ? points.dailyFreeLimit
        : env("DAILY_FREE_LIMIT", "3"),
      3,
      0,
      100
    ),
    imageCost: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "imageCost")
        ? points.imageCost
        : env("POINTS_IMAGE_COST", "10"),
      10,
      0,
      100000
    ),
    videoCost: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "videoCost")
        ? points.videoCost
        : env("POINTS_VIDEO_COST", "10"),
      10,
      0,
      100000
    ),
    checkinPoints: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "checkinPoints")
        ? points.checkinPoints
        : env("POINTS_CHECKIN_POINTS", "5"),
      5,
      0,
      100000
    ),
    streakBonus: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "streakBonus")
        ? points.streakBonus
        : env("POINTS_STREAK_BONUS", "20"),
      20,
      0,
      100000
    ),
    streakDays: clampNumber(
      points && Object.prototype.hasOwnProperty.call(points, "streakDays")
        ? points.streakDays
        : env("POINTS_STREAK_DAYS", "7"),
      7,
      1,
      30
    ),
    promoStartDate: overrideString(
      points,
      "promoStartDate",
      env("PROMO_START_DATE", "2026-08-23")
    ),
    promoEndDate: overrideString(
      points,
      "promoEndDate",
      env("PROMO_END_DATE", "2026-08-24")
    ),
    timeZone: overrideString(points, "timeZone", POINTS_TIME_ZONE)
  };
}

function resolveCostConfig(overrides = {}) {
  const costs = overrides && overrides.costs ? overrides.costs : overrides;
  const face = costs && costs.face ? costs.face : {};
  const image = costs && costs.image ? costs.image : {};
  const video = costs && costs.video ? costs.video : {};
  const imagePrices = image.perImage && typeof image.perImage === "object"
    ? image.perImage
    : {};
  const videoPrices = video.perSecond && typeof video.perSecond === "object"
    ? video.perSecond
    : {};
  return {
    currency: "CNY",
    version: MODEL_COST_CONFIG_VERSION,
    face: {
      inputPerMillionTokens: clampNumber(
        face.inputPerMillionTokens,
        0.15,
        0,
        100000
      ),
      outputPerMillionTokens: clampNumber(
        face.outputPerMillionTokens,
        1.5,
        0,
        100000
      )
    },
    image: {
      defaultResolution: normalizeImageResolution(
        image.defaultResolution,
        "1K"
      ),
      perImage: {
        "1K": clampNumber(imagePrices["1K"], 0.015, 0, 100000),
        "2K": clampNumber(imagePrices["2K"], 0.025, 0, 100000),
        "4K": clampNumber(imagePrices["4K"], 0.035, 0, 100000)
      }
    },
    video: {
      defaultResolution: normalizeVideoResolution(
        video.defaultResolution,
        "720p"
      ),
      perSecond: {
        "480p": clampNumber(videoPrices["480p"], 0.2, 0, 100000),
        "720p": clampNumber(videoPrices["720p"], 0.3, 0, 100000),
        "1080p": clampNumber(videoPrices["1080p"], 1.8, 0, 100000)
      },
      defaultDurationSeconds: clampNumber(
        video.defaultDurationSeconds,
        3,
        0.1,
        3600
      )
    }
  };
}

function normalizeImageResolution(value, fallback = "1K") {
  const text = String(value || "").trim().toUpperCase();
  if (text === "1K" || text === "2K" || text === "4K") return text;
  const match = text.match(/(\d{3,5})\s*[X×]\s*(\d{3,5})/);
  if (match) {
    const longest = Math.max(Number(match[1]), Number(match[2]));
    if (longest <= 1536) return "1K";
    if (longest <= 3072) return "2K";
    return "4K";
  }
  if (text.includes("4K")) return "4K";
  if (text.includes("2K")) return "2K";
  if (text.includes("1K")) return "1K";
  if (fallback === "") return "";
  return ["1K", "2K", "4K"].includes(String(fallback)) ? String(fallback) : "1K";
}

function normalizeVideoResolution(value, fallback = "720p") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "480p" || text === "720p" || text === "1080p") return text;
  const match = text.match(/(480|720|1080)/);
  if (match) return `${match[1]}p`;
  if (fallback === "") return "";
  return ["480p", "720p", "1080p"].includes(String(fallback))
    ? String(fallback)
    : "720p";
}

function roundCost(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 1000000) / 1000000;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function extractModelUsage(payload = {}) {
  const candidates = [
    payload && payload.usage,
    payload && payload.data && payload.data.usage,
    payload && payload.output && payload.output.usage
  ].filter((item) => item && typeof item === "object");
  const usage = candidates[0] || {};
  const inputTokens = firstFiniteNumber([
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens
  ]);
  const outputTokens = firstFiniteNumber([
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens
  ]);
  const totalTokens = firstFiniteNumber([
    usage.total_tokens,
    usage.totalTokens
  ]);
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalTokens === null
      ? (inputTokens === null && outputTokens === null
        ? null
        : (inputTokens || 0) + (outputTokens || 0))
      : totalTokens
  };
}

function extractVideoDuration(payload = {}) {
  const data = payload && payload.data;
  const output = payload && payload.output;
  return firstFiniteNumber([
    payload.duration,
    payload.duration_seconds,
    payload.durationSeconds,
    data && data.duration,
    data && data.duration_seconds,
    data && data.durationSeconds,
    output && output.duration,
    output && output.duration_seconds,
    output && output.durationSeconds
  ]);
}

function buildUsageBilling(meta = {}, response = {}, costs = resolveCostConfig()) {
  const usageType = modelUsageTypeForAction(meta.action);
  const payload = response && response.json ? response.json : {};
  const base = {
    currency: costs.currency,
    billingSource: "unavailable",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    imageResolution: "",
    videoResolution: "",
    videoDurationSeconds: 0,
    unitPrice: 0,
    estimatedCost: 0,
    costBreakdown: {},
    costConfigVersion: costs.version
  };
  if (usageType === "face") {
    const usage = extractModelUsage(payload);
    if (usage.inputTokens === null || usage.outputTokens === null) return base;
    const inputCost = roundCost(
      usage.inputTokens / 1000000 * costs.face.inputPerMillionTokens
    );
    const outputCost = roundCost(
      usage.outputTokens / 1000000 * costs.face.outputPerMillionTokens
    );
    return Object.assign(base, {
      billingSource: "actual",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens || 0,
      estimatedCost: roundCost(inputCost + outputCost),
      costBreakdown: { inputCost, outputCost }
    });
  }
  if (usageType === "image") {
    const resolution = normalizeImageResolution(
      meta.imageResolution || meta.size,
      costs.image.defaultResolution
    );
    const unitPrice = costs.image.perImage[resolution];
    return Object.assign(base, {
      billingSource: "estimated",
      imageResolution: resolution,
      unitPrice,
      estimatedCost: roundCost(unitPrice),
      costBreakdown: {
        resolution,
        unitPrice,
        quantity: 1
      }
    });
  }
  if (usageType === "video") {
    const resolution = normalizeVideoResolution(
      meta.videoResolution,
      costs.video.defaultResolution
    );
    const upstreamDuration = extractVideoDuration(payload);
    const durationSeconds = upstreamDuration === null
      ? firstFiniteNumber([meta.videoDurationSeconds, costs.video.defaultDurationSeconds])
      : upstreamDuration;
    if (durationSeconds === null) return base;
    const unitPrice = costs.video.perSecond[resolution];
    return Object.assign(base, {
      billingSource: upstreamDuration === null ? "estimated" : "actual",
      videoResolution: resolution,
      videoDurationSeconds: durationSeconds,
      unitPrice,
      estimatedCost: roundCost(durationSeconds * unitPrice),
      costBreakdown: {
        resolution,
        unitPrice,
        durationSeconds
      }
    });
  }
  return base;
}

function visionRequestMeta(requestId, action, vision, costs) {
  return {
    requestId,
    action,
    provider: vision.provider || "",
    model: action === "detectFaceCircle"
      ? vision.faceModel || vision.model || ""
      : vision.model || "",
    allowRetry: true,
    maxAttempts: 2,
    retryStatuses: [429, 500, 502, 503, 504],
    timeoutMs: vision.timeoutMs,
    costs
  };
}

function assertVisionImageSize(image, vision) {
  const size = Buffer.isBuffer(image) ? image.length : 0;
  if (!size) {
    const error = new Error("云端主图内容为空。");
    error.code = "empty-main-image";
    error.retryable = false;
    throw error;
  }
  if (size > vision.maxImageBytes) {
    const error = new Error("主图文件过大，请重新选择压缩后的图片或改用手动圈选。");
    error.code = "image-too-large";
    error.retryable = false;
    error.imageBytes = size;
    throw error;
  }
  return size;
}

function retryAfterMs(headers) {
  const raw = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30000, seconds * 1000));
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(30000, timestamp - Date.now())) : 0;
}

function delayMs(attempt, retryAfter = 0) {
  if (retryAfter > 0) return retryAfter;
  const base = Math.min(10000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
  return base + Math.floor(Math.random() * 200);
}

function shouldRetryStatus(status) {
  return DEFAULT_RETRY_STATUSES.has(Number(status));
}

function maxRetries() {
  return Math.max(0, Math.min(5, Number(env("AI_MAX_RETRIES", "2")) || 0));
}

function imageRetryEnabled() {
  return boolEnv("AI_IMAGE_RETRY_ENABLED", false);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation(operation, options = {}) {
  const attemptsAllowed = Math.max(1, Number(options.maxAttempts) || maxRetries() + 1);
  const canRetry = options.allowRetry !== false;
  let attempt = 0;
  let lastError = null;
  while (attempt < attemptsAllowed) {
    attempt += 1;
    try {
      const value = await operation(attempt);
      return { value, attempt };
    } catch (error) {
      lastError = error;
      const status = Number(error && error.status) || 0;
      const retryable = error && error.retryable !== undefined
        ? Boolean(error.retryable)
        : shouldRetryStatus(status);
      if (!canRetry || !retryable || attempt >= attemptsAllowed) break;
      await sleep(delayMs(attempt, retryAfterMs(error && error.headers)));
    }
  }
  if (lastError) {
    lastError.attempts = attempt;
    if (attempt >= attemptsAllowed && attemptsAllowed > 1) lastError.code = "retry-exhausted";
    throw lastError;
  }
  throw new Error("重试操作没有返回结果。");
}

function createRequestId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
  } catch (_) {
    return "";
  }
}

function sanitize(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
      .slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    Object.keys(value).slice(0, 40).forEach((key) => {
      if (/key|secret|token|authorization|password/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = sanitize(value[key], depth + 1);
      }
    });
    return result;
  }
  return value;
}

function log(level, event, fields = {}) {
  const payload = Object.assign({
    component: "wechat-miniapp-api",
    event,
    time: new Date().toISOString()
  }, sanitize(fields));
  const line = JSON.stringify(payload);
  if (level === "error" && console.error) console.error(line);
  else if (level === "warn" && console.warn) console.warn(line);
  else if (console.info) console.info(line);
  else console.log(line);
}

function quoteMultipart(value) {
  return String(value || "").replace(/[\r\n"]/g, "_");
}

function createMultipart(fields = [], files = []) {
  const boundary = `----wechat-miniapp-${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  const pushText = (value) => chunks.push(Buffer.from(String(value), "utf8"));
  const pushField = (name, value) => {
    pushText(`--${boundary}\r\n`);
    pushText(`Content-Disposition: form-data; name="${quoteMultipart(name)}"\r\n\r\n`);
    pushText(value);
    pushText("\r\n");
  };
  const pushFile = (file) => {
    pushText(`--${boundary}\r\n`);
    pushText(
      `Content-Disposition: form-data; name="${quoteMultipart(file.name)}"; filename="${quoteMultipart(file.filename)}"\r\n`
    );
    pushText(`Content-Type: ${file.mime || "application/octet-stream"}\r\n\r\n`);
    chunks.push(Buffer.from(file.buffer || Buffer.alloc(0)));
    pushText("\r\n");
  };
  fields.forEach((field) => pushField(field.name, field.value));
  files.forEach(pushFile);
  pushText(`--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// 这个小函数直接放在入口，绕过部分云函数运行时偶发的相对路径加载异常。
// 保留同样的校验规则，lib/web-pose.js 继续作为本地测试和源码备份。
const POSE_CATEGORIES = ["侧身", "回头", "手部", "肩颈", "坐姿", "全身", "其他"];

function compactWebPoseText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeWebPoseSuggestion(value) {
  if (!value || typeof value !== "object") return null;
  const id = Number(value.id);
  const title = compactWebPoseText(value.title, 40);
  const description = compactWebPoseText(value.description, 320);
  if (
    !Number.isInteger(id)
    || id < 1
    || id > 8
    || title.length < 2
    || description.length < 12
  ) {
    return null;
  }
  return {
    id,
    title,
    description,
    category: POSE_CATEGORIES.includes(value.category) ? value.category : "其他",
    tags: Array.isArray(value.tags)
      ? value.tags.map((item) => compactWebPoseText(item, 20)).filter(Boolean).slice(0, 5)
      : [],
    unsuitableReason: compactWebPoseText(value.unsuitableReason, 180),
    direction: "自然",
    intensity: "正常调整",
    platform: "社交平台照片"
  };
}

function normalizeWebPoseSuggestions(value) {
  const source = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.poses)
      ? value.poses
      : null;
  if (!source || source.length !== 8) return null;
  const suggestions = source.map(normalizeWebPoseSuggestion);
  if (
    suggestions.some((item) => !item)
    || new Set(suggestions.map((item) => item.id)).size !== 8
    || new Set(suggestions.map((item) => `${item.title}\n${item.description}`)).size !== 8
  ) {
    return null;
  }
  return suggestions.sort((left, right) => left.id - right.id);
}

const db = cloud.database();
const modelUsageTestEvents = [];
const autoFaceFailureTestEvents = [];
const autoFaceProbeTestEvents = [];
let autoFaceFailureCleanupLastRunAt = 0;
let autoFaceFailureCleanupPromise = null;

function modelUsageTypeForAction(action) {
  if (action === "generate") return "image";
  if (action === "detectFaceCircle") return "face";
  if (action === "video.create") return "video";
  return "";
}

function compactUsageText(value, maxLength = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeFailureMessage(value, maxLength = 180) {
  return compactUsageText(value, maxLength)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/https?:\/\/\S+/gi, "[地址已隐藏]")
    .replace(/((?:api[_-]?key|authorization|token)\s*[:=]\s*)\S+/gi, "$1[已隐藏]")
    .slice(0, maxLength);
}

function normalizeFailureCode(value, status = 0) {
  const code = compactUsageText(value, 80)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (code) return code;
  return Number(status) > 0 ? `http-${Number(status)}` : "model-request-failed";
}

function normalizeAutoFaceFailureType(value) {
  const type = compactUsageText(value, 40).toLowerCase();
  return AUTO_FACE_FAILURE_TYPES.includes(type) ? type : "unknown";
}

function normalizeAutoFaceProbeReport(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const rawStatus = compactUsageText(source.status, 20).toLowerCase();
  const status = AUTO_FACE_PROBE_STATUSES.includes(rawStatus)
    ? rawStatus
    : "not-run";
  const durationMs = Math.max(
    0,
    Math.min(60 * 1000, Math.round(Number(source.durationMs) || 0))
  );
  const requestId = compactUsageText(source.requestId, 100)
    .replace(/[^A-Za-z0-9._:-]+/g, "-");
  const errorCode = compactUsageText(source.errorCode || source.code, 80)
    .replace(/[^A-Za-z0-9._:-]+/g, "-");
  return {
    status,
    requestId,
    buildVersion: compactUsageText(source.buildVersion, 40),
    buildMarker: compactUsageText(source.buildMarker, 120),
    nodeVersion: compactUsageText(source.nodeVersion, 40),
    cloudEnvConfigured: Boolean(source.cloudEnvConfigured),
    visionConfigured: Boolean(source.visionConfigured),
    provider: compactUsageText(source.provider, 40),
    model: compactUsageText(source.model, 80),
    durationMs,
    errorCode
  };
}

function normalizeAutoFaceProbeHistoryReport(payload = {}, fallbackRequestId = "") {
  const source = payload && typeof payload === "object" ? payload : {};
  const status = compactUsageText(source.status, 20).toLowerCase() === "failed"
    ? "failed"
    : "ok";
  const durationMs = Math.max(
    0,
    Math.min(60 * 1000, Math.round(Number(source.durationMs) || 0))
  );
  const requestId = compactUsageText(source.requestId || fallbackRequestId, 100)
    .replace(/[^A-Za-z0-9._:-]+/g, "-");
  const checkedAt = source.checkedAt instanceof Date
    ? source.checkedAt
    : new Date(source.checkedAt || Date.now());
  return {
    status,
    requestId,
    buildVersion: compactUsageText(source.buildVersion, 40),
    buildMarker: compactUsageText(source.buildMarker, 120),
    nodeVersion: compactUsageText(source.nodeVersion, 40),
    cloudEnvConfigured: Boolean(source.cloudEnvConfigured),
    visionConfigured: Boolean(source.visionConfigured),
    provider: compactUsageText(source.provider, 40),
    model: compactUsageText(source.model, 80),
    durationMs,
    errorCode: compactUsageText(source.errorCode, 80)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    checkedAt: Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt,
    createdAt: source.createdAt instanceof Date ? source.createdAt : new Date()
  };
}

function autoFaceProbeHistoryDisplayEvent(event = {}) {
  const source = normalizeAutoFaceProbeHistoryReport(event, event.requestId);
  const checkedAt = source.checkedAt instanceof Date
    ? source.checkedAt
    : new Date(source.checkedAt || 0);
  return {
    status: source.status,
    statusText: source.status === "ok" ? "探针正常" : "探针失败",
    requestId: source.requestId,
    buildVersion: source.buildVersion,
    buildMarker: source.buildMarker,
    nodeVersion: source.nodeVersion,
    cloudEnvConfigured: source.cloudEnvConfigured,
    visionConfigured: source.visionConfigured,
    provider: source.provider,
    model: source.model,
    durationMs: source.durationMs,
    errorCode: source.errorCode,
    checkedAt: Number.isNaN(checkedAt.getTime()) ? "" : checkedAt.toISOString()
  };
}

function sanitizeAutoFaceFailureMessage(value) {
  return sanitizeFailureMessage(value, 240)
    .replace(
      /((?:prompt|file(?:id|path)|image(?:id|path|url)|api[_-]?key|authorization|token)\s*[:=]\s*)[^,;]+/gi,
      "$1[已隐藏]"
    )
    .replace(/\bsk-[A-Za-z0-9._~-]+\b/gi, "[Key已隐藏]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users|private|data)\/)[^\s,;]+/g,
      "[路径已隐藏]"
    )
    .slice(0, 240);
}

function normalizeAutoFaceFailureReport(payload = {}, fallbackRequestId = "") {
  const source = payload && typeof payload === "object" ? payload : {};
  const status = Math.max(0, Math.min(599, Math.round(Number(source.status) || 0)));
  const durationMs = Math.max(
    0,
    Math.min(10 * 60 * 1000, Math.round(Number(source.durationMs) || 0))
  );
  const requestId = compactUsageText(source.requestId || fallbackRequestId, 100)
    .replace(/[^A-Za-z0-9._:-]+/g, "-");
  const errorCodeSource = compactUsageText(source.errorCode || source.code, 80)
    .replace(/\bsk-[A-Za-z0-9._~-]+\b/gi, "redacted-key");
  return {
    requestId,
    failureType: normalizeAutoFaceFailureType(source.failureType),
    errorCode: normalizeFailureCode(errorCodeSource, status),
    message: sanitizeAutoFaceFailureMessage(source.message || source.errorMessage),
    status,
    retryable: Boolean(source.retryable),
    stage: compactUsageText(source.stage, 40) || "cloud-failed",
    durationMs,
    appVersion: compactUsageText(source.appVersion, 40) || "unknown",
    probe: normalizeAutoFaceProbeReport(source.probe),
    createdAt: new Date()
  };
}

function formatAutoFaceFailureType(type) {
  const normalized = normalizeAutoFaceFailureType(type);
  return AUTO_FACE_FAILURE_TYPE_LABELS[normalized] || AUTO_FACE_FAILURE_TYPE_LABELS.unknown;
}

function autoFaceFailureDisplayEvent(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  const createdAt = source.createdAt instanceof Date
    ? source.createdAt
    : new Date(source.createdAt || 0);
  const createdAtIso = Number.isNaN(createdAt.getTime()) ? "" : createdAt.toISOString();
  const normalized = normalizeAutoFaceFailureReport(source, source.requestId);
  return {
    requestId: normalized.requestId,
    failureType: normalized.failureType,
    failureTypeLabel: formatAutoFaceFailureType(normalized.failureType),
    errorCode: normalized.errorCode,
    message: normalized.message,
    status: normalized.status,
    retryable: normalized.retryable,
    stage: normalized.stage,
    durationMs: normalized.durationMs,
    appVersion: normalized.appVersion,
    probe: normalized.probe,
    createdAt: createdAtIso
  };
}

function buildAutoFaceFailureStats(events = [], baseDate = new Date()) {
  const todayKey = dateKeyForTimeZone(baseDate, AUTO_FACE_FAILURE_TIME_ZONE);
  const last7StartKey = shiftDateKey(todayKey, -6);
  const last30StartKey = shiftDateKey(todayKey, -29);
  const byType = {};
  const recent = [];
  const probeVersions = {};
  const probeSummary = {
    total: 0,
    ok: 0,
    failed: 0,
    pending: 0,
    notRun: 0,
    visionConfigured: 0,
    visionUnavailable: 0,
    versions: []
  };
  let today = 0;
  let last7d = 0;
  let total30d = 0;

  (Array.isArray(events) ? events : [])
    .map((event) => {
      const createdAt = event && event.createdAt instanceof Date
        ? event.createdAt
        : new Date(event && event.createdAt || 0);
      return {
        event,
        createdAt,
        dateKey: Number.isNaN(createdAt.getTime())
          ? ""
          : dateKeyForTimeZone(createdAt, AUTO_FACE_FAILURE_TIME_ZONE)
      };
    })
    .filter((item) => (
      item.dateKey
      && item.dateKey >= last30StartKey
      && item.dateKey <= todayKey
    ))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .forEach((item) => {
      total30d += 1;
      if (item.dateKey === todayKey) today += 1;
      if (item.dateKey >= last7StartKey) last7d += 1;
      const type = normalizeAutoFaceFailureType(item.event && item.event.failureType);
      const probe = normalizeAutoFaceProbeReport(item.event && item.event.probe);
      probeSummary.total += 1;
      if (probe.status === "ok") probeSummary.ok += 1;
      else if (probe.status === "failed") probeSummary.failed += 1;
      else if (probe.status === "pending") probeSummary.pending += 1;
      else probeSummary.notRun += 1;
      if (probe.visionConfigured) probeSummary.visionConfigured += 1;
      else probeSummary.visionUnavailable += 1;
      if (probe.buildVersion) {
        const versionKey = `${probe.buildVersion}|${probe.buildMarker}`;
        if (!probeVersions[versionKey]) {
          probeVersions[versionKey] = {
            buildVersion: probe.buildVersion,
            buildMarker: probe.buildMarker,
            count: 0
          };
        }
        probeVersions[versionKey].count += 1;
      }
      if (!byType[type]) {
        byType[type] = {
          type,
          label: formatAutoFaceFailureType(type),
          count: 0,
          lastSeen: ""
        };
      }
      byType[type].count += 1;
      if (!byType[type].lastSeen) {
        byType[type].lastSeen = item.createdAt.toISOString();
      }
      if (recent.length < 20) {
        recent.push(autoFaceFailureDisplayEvent(item.event));
      }
    });

  return {
    timeZone: AUTO_FACE_FAILURE_TIME_ZONE,
    todayKey,
    today,
    last7d,
    total30d,
    byType: Object.values(byType).sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.type.localeCompare(right.type);
    }),
    recent,
    probeSummary: Object.assign({}, probeSummary, {
      versions: Object.values(probeVersions).sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return left.buildVersion.localeCompare(right.buildVersion);
      })
    }),
    eventCount: total30d,
    unavailable: false,
    message: ""
  };
}

function autoFaceFailureCleanupCutoff(baseDate = new Date()) {
  return new Date(
    baseDate.getTime() - AUTO_FACE_FAILURE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
}

function shouldRunAutoFaceFailureCleanup(baseDate = new Date(), lastRunAt = 0) {
  return (
    !lastRunAt
    || baseDate.getTime() - Number(lastRunAt) >= AUTO_FACE_FAILURE_CLEANUP_INTERVAL_MS
  );
}

async function cleanupAutoFaceFailureLogs(baseDate = new Date()) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return { skipped: true, removed: 0, truncated: false };
  }
  if (
    !shouldRunAutoFaceFailureCleanup(baseDate, autoFaceFailureCleanupLastRunAt)
    && !autoFaceFailureCleanupPromise
  ) {
    return { skipped: true, removed: 0, truncated: false };
  }
  if (autoFaceFailureCleanupPromise) return autoFaceFailureCleanupPromise;

  autoFaceFailureCleanupLastRunAt = baseDate.getTime();
  autoFaceFailureCleanupPromise = (async () => {
    const cutoff = autoFaceFailureCleanupCutoff(baseDate);
    try {
      const result = await db
        .collection(AUTO_FACE_FAILURE_LOG_COLLECTION)
        .where({ createdAt: db.command.lt(cutoff) })
        .limit(AUTO_FACE_FAILURE_CLEANUP_BATCH_SIZE)
        .get();
      const rows = result && Array.isArray(result.data) ? result.data : [];
      const deletable = rows.filter((item) => item && item._id);
      await Promise.all(
        deletable.map((item) => (
          db.collection(AUTO_FACE_FAILURE_LOG_COLLECTION).doc(item._id).remove()
        ))
      );
      const summary = {
        skipped: false,
        removed: deletable.length,
        truncated: rows.length >= AUTO_FACE_FAILURE_CLEANUP_BATCH_SIZE
      };
      if (deletable.length) {
        log("info", "auto-face-failure.cleanup", {
          cutoff: cutoff.toISOString(),
          removed: deletable.length,
          truncated: summary.truncated
        });
      }
      return summary;
    } catch (error) {
      log("warn", "auto-face-failure.cleanup-failed", {
        cutoff: cutoff.toISOString(),
        error: error && error.message
      });
      return {
        skipped: false,
        removed: 0,
        truncated: false,
        unavailable: true
      };
    } finally {
      autoFaceFailureCleanupPromise = null;
    }
  })();
  return autoFaceFailureCleanupPromise;
}

function normalizePhotoToVideoTempKind(value) {
  const kind = compactUsageText(value, 20).toLowerCase();
  return ["source", "result"].includes(kind) ? kind : "";
}

function photoToVideoTempAssetDocumentId(fileID, kind) {
  return crypto
    .createHash("sha256")
    .update(`${normalizePhotoToVideoTempKind(kind)}:${String(fileID || "")}`)
    .digest("hex")
    .slice(0, 30);
}

function photoToVideoTempCleanupCutoff(baseDate = new Date()) {
  return new Date(baseDate.getTime() - PHOTO_TO_VIDEO_TEMP_ASSET_TTL_MS);
}

function isPhotoToVideoCleanupTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    source.Type === "Timer"
    || source.type === "timer"
    || source.triggerName === "photo-to-video-temp-cleanup"
    || source.action === "cleanupPhotoToVideoTempAssets"
  );
}

function normalizePhotoToVideoTempFileError(error) {
  return sanitizeFailureMessage(
    error && (error.errMsg || error.message) || error || "云文件清理失败",
    240
  );
}

function isPhotoToVideoTempFileMissing(error) {
  return /not.?found|不存在|不存在该文件|file.?not.?exist|no such file|404/i
    .test(normalizePhotoToVideoTempFileError(error));
}

async function deletePhotoToVideoTempFile(fileID) {
  const response = await cloud.deleteFile({ fileList: [fileID] });
  const item = response && Array.isArray(response.fileList)
    ? response.fileList.find((entry) => entry && entry.fileID === fileID)
    : null;
  if (item && Number(item.status) !== 0) {
    const error = new Error(item.errMsg || "云文件清理失败");
    error.code = "PHOTO_TO_VIDEO_TEMP_DELETE_FAILED";
    throw error;
  }
  return response;
}

async function registerPhotoToVideoTempAsset(event = {}, context) {
  const fileID = String(event.fileID || "").trim();
  const kind = normalizePhotoToVideoTempKind(event.kind);
  if (!/^cloud:\/\//i.test(fileID)) {
    return fail("照片转视频临时文件必须是 cloud:// fileID。", "PHOTO_TO_VIDEO_TEMP_FILE_ID_INVALID");
  }
  if (!kind) {
    return fail("照片转视频临时文件类型只能是 source 或 result。", "PHOTO_TO_VIDEO_TEMP_KIND_INVALID");
  }
  const now = new Date();
  const documentId = photoToVideoTempAssetDocumentId(fileID, kind);
  const data = {
    fileID,
    kind,
    ownerOpenId: getOpenId(context),
    createdAt: now,
    cleanupAfter: new Date(now.getTime() + PHOTO_TO_VIDEO_TEMP_ASSET_TTL_MS),
    status: "pending",
    attempts: 0,
    lastError: "",
    updatedAt: now
  };
  await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION)
    .doc(documentId)
    .set({ data });
  return jsonResponse(true, {
    accepted: true,
    fileID,
    kind,
    cleanupAfter: data.cleanupAfter.toISOString()
  });
}

async function cleanupPhotoToVideoTempAssets(baseDate = new Date()) {
  const cutoff = photoToVideoTempCleanupCutoff(baseDate);
  const result = await db
    .collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION)
    .where({ cleanupAfter: db.command.lte(cutoff) })
    .orderBy("cleanupAfter", "asc")
    .limit(PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE)
    .get();
  const rows = result && Array.isArray(result.data) ? result.data : [];
  let removed = 0;
  let retried = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row || !row._id || !row.fileID) continue;
    try {
      await deletePhotoToVideoTempFile(row.fileID);
      await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(row._id).remove();
      removed += 1;
    } catch (error) {
      if (isPhotoToVideoTempFileMissing(error)) {
        await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(row._id).remove();
        removed += 1;
        continue;
      }
      failed += 1;
      retried += 1;
      await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(row._id).update({
        data: {
          status: "failed",
          attempts: Math.max(0, Number(row.attempts) || 0) + 1,
          lastError: normalizePhotoToVideoTempFileError(error),
          updatedAt: new Date()
        }
      });
      log("warn", "photo-to-video-temp.cleanup-failed", {
        fileID: row.fileID,
        kind: row.kind,
        error: normalizePhotoToVideoTempFileError(error)
      });
    }
  }
  const summary = {
    skipped: false,
    cutoff: cutoff.toISOString(),
    scanned: rows.length,
    removed,
    retried,
    failed,
    truncated: rows.length >= PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE
  };
  log("info", "photo-to-video-temp.cleanup", summary);
  return jsonResponse(true, summary);
}

async function reportAutoFaceFailure(event = {}) {
  const report = normalizeAutoFaceFailureReport(
    event && event.payload,
    event && event.requestId
  );
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    autoFaceFailureTestEvents.push(report);
    return jsonResponse(true, {
      accepted: true,
      requestId: report.requestId
    });
  }
  try {
    await db.collection(AUTO_FACE_FAILURE_LOG_COLLECTION).add({ data: report });
    await cleanupAutoFaceFailureLogs(new Date());
    return jsonResponse(true, {
      accepted: true,
      requestId: report.requestId
    });
  } catch (error) {
    log("warn", "auto-face-failure.write-failed", {
      requestId: report.requestId,
      failureType: report.failureType,
      error: error && error.message
    });
    return jsonResponse(true, {
      accepted: false,
      unavailable: true,
      requestId: report.requestId,
      message: "失败日志暂时无法保存。"
    });
  }
}

async function loadAutoFaceFailureEvents(startDate) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return autoFaceFailureTestEvents.slice();
  }
  const command = db.command;
  const result = await db
    .collection(AUTO_FACE_FAILURE_LOG_COLLECTION)
    .where({ createdAt: command.gte(startDate) })
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function getAutoFaceFailureStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const baseDate = new Date();
  const todayKey = dateKeyForTimeZone(baseDate, AUTO_FACE_FAILURE_TIME_ZONE);
  const startKey = shiftDateKey(todayKey, -29);
  const startDate = new Date(`${startKey}T00:00:00+08:00`);
  try {
    await cleanupAutoFaceFailureLogs(baseDate);
    const events = await loadAutoFaceFailureEvents(startDate);
    const stats = buildAutoFaceFailureStats(events, baseDate);
    return jsonResponse(true, Object.assign(stats, {
      eventCount: stats.total30d,
      truncated: events.length >= 500
    }));
  } catch (error) {
    log("warn", "auto-face-failure.read-failed", {
      startKey,
      error: error && error.message
    });
    return jsonResponse(true, Object.assign(
      buildAutoFaceFailureStats([], baseDate),
      {
        eventCount: 0,
        truncated: false,
        unavailable: true,
        message: "自动贴脸失败统计暂时读取失败，请稍后刷新。"
      }
    ));
  }
}

function failureReasonKey(event = {}) {
  if (event.errorCode) return `code:${event.errorCode}`;
  if (event.errorStatus) return `http:${event.errorStatus}`;
  if (event.errorMessage) return `message:${event.errorMessage}`;
  return "unknown";
}

function failureReasonLabel(event = {}) {
  if (event.errorMessage && event.errorCode) {
    return `${event.errorCode}：${event.errorMessage}`;
  }
  if (event.errorMessage) return event.errorMessage;
  if (event.errorCode) return event.errorCode;
  if (event.errorStatus) return `HTTP ${event.errorStatus}`;
  return "未提供错误原因";
}

function failureDetailsFromResponse(response = {}, retryable = false) {
  const payload = response && response.json ? response.json : {};
  const nestedError = payload && payload.error;
  return {
    errorCode: normalizeFailureCode(
      (nestedError && (nestedError.code || nestedError.type))
        || (payload && (payload.code || payload.error_code)),
      response && response.status
    ),
    errorMessage: sanitizeFailureMessage(
      (nestedError && nestedError.message)
        || (payload && payload.message)
        || (response && response.raw)
        || ""
    ),
    errorStatus: Math.max(0, Number(response && response.status) || 0),
    retryable: Boolean(retryable),
    failedAt: new Date()
  };
}

function failureDetailsFromError(error = {}, retryable = false) {
  const payload = error && error.payload ? error.payload : {};
  const nestedError = payload && payload.error;
  return {
    errorCode: normalizeFailureCode(
      error && error.code
        || (nestedError && (nestedError.code || nestedError.type))
        || (payload && (payload.code || payload.error_code)),
      error && error.status
    ),
    errorMessage: sanitizeFailureMessage(
      error && error.message
        || (nestedError && nestedError.message)
        || (payload && payload.message)
        || ""
    ),
    errorStatus: Math.max(0, Number(error && error.status) || 0),
    retryable: Boolean(retryable),
    failedAt: new Date()
  };
}

function usageUserHash(openid) {
  const value = String(openid || "").trim();
  if (!value || value === "anonymous") return "anonymous";
  return crypto.createHash("sha256").update(`usage-user:${value}`).digest("hex").slice(0, 12);
}

function normalizeModelUsageEvent(value = {}) {
  const usageType = MODEL_USAGE_TYPES.includes(value.usageType)
    ? value.usageType
    : modelUsageTypeForAction(value.action);
  if (!usageType) return null;
  const createdAt = value.createdAt instanceof Date
    ? value.createdAt
    : new Date(value.createdAt || Date.now());
  const status = Math.max(0, Number(value.status) || 0);
  const billingSource = ["actual", "estimated", "unavailable"].includes(value.billingSource)
    ? value.billingSource
    : "unavailable";
  const inputTokens = Math.max(0, Number(value.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(value.outputTokens) || 0);
  const totalTokens = Math.max(
    0,
    Number(value.totalTokens) || inputTokens + outputTokens
  );
  const videoDurationSeconds = Math.max(0, Number(value.videoDurationSeconds) || 0);
  const estimatedCost = Math.max(0, Number(value.estimatedCost) || 0);
  const success = Boolean(value.success);
  return {
    requestId: compactUsageText(value.requestId, 100),
    userHash: compactUsageText(value.userHash, 40) || "anonymous",
    usageType,
    action: compactUsageText(value.action, 40),
    provider: compactUsageText(value.provider, 80),
    model: compactUsageText(value.model, 120),
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(String(value.dateKey || ""))
      ? String(value.dateKey)
      : dateKeyForTimeZone(createdAt, MODEL_USAGE_TIME_ZONE),
    success,
    status,
    durationMs: Math.max(0, Math.round(Number(value.durationMs) || 0)),
    attempt: Math.max(1, Math.round(Number(value.attempt) || 1)),
    errorCode: success ? "" : normalizeFailureCode(value.errorCode, value.errorStatus || status),
    errorMessage: success ? "" : sanitizeFailureMessage(value.errorMessage),
    errorStatus: success
      ? 0
      : Math.max(0, Number(value.errorStatus || status) || 0),
    retryable: !success && Boolean(value.retryable),
    failedAt: !success
      ? (value.failedAt instanceof Date ? value.failedAt : new Date(value.failedAt || createdAt))
      : null,
    billingSource,
    currency: compactUsageText(value.currency, 8) || "CNY",
    inputTokens,
    outputTokens,
    totalTokens,
    imageResolution: normalizeImageResolution(value.imageResolution, ""),
    videoResolution: value.videoResolution
      ? normalizeVideoResolution(value.videoResolution, "")
      : "",
    videoDurationSeconds,
    unitPrice: Math.max(0, Number(value.unitPrice) || 0),
    estimatedCost,
    costBreakdown: value.costBreakdown && typeof value.costBreakdown === "object"
      ? value.costBreakdown
      : {},
    costConfigVersion: compactUsageText(value.costConfigVersion, 40) || MODEL_COST_CONFIG_VERSION,
    createdAt
  };
}

async function recordModelUsageEvent(value = {}) {
  const event = normalizeModelUsageEvent(value);
  if (!event) return false;
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    modelUsageTestEvents.push(event);
    return true;
  }
  try {
    await db.collection(MODEL_USAGE_EVENT_COLLECTION).add({ data: event });
    return true;
  } catch (error) {
    log("warn", "model-usage.write-failed", {
      requestId: event.requestId,
      usageType: event.usageType,
      action: event.action,
      error: error && error.message
    });
    return false;
  }
}

function emptyUsageCounters() {
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

function createUsageTypeMap() {
  return {
    image: emptyUsageCounters(),
    face: emptyUsageCounters(),
    video: emptyUsageCounters()
  };
}

function addUsageCount(target, event) {
  if (!target || !event) return;
  target.total += 1;
  if (event.success) target.success += 1;
  else target.failure += 1;
}

function addUsageCost(target, event) {
  if (!target || !event) return;
  const cost = Math.max(0, Number(event.estimatedCost) || 0);
  target.estimatedCost = roundCost(target.estimatedCost + cost);
  if (event.billingSource === "unavailable") target.unavailableCostCount += 1;
  else target.pricedCost = roundCost(target.pricedCost + cost);
  target.inputTokens += Math.max(0, Number(event.inputTokens) || 0);
  target.outputTokens += Math.max(0, Number(event.outputTokens) || 0);
  target.totalTokens += Math.max(0, Number(event.totalTokens) || 0);
  target.videoDurationSeconds = roundCost(
    target.videoDurationSeconds + Math.max(0, Number(event.videoDurationSeconds) || 0)
  );
  if (event.imageResolution && target.imageResolutions[event.imageResolution]) {
    target.imageResolutions[event.imageResolution].count += 1;
    target.imageResolutions[event.imageResolution].cost = roundCost(
      target.imageResolutions[event.imageResolution].cost + cost
    );
  }
  if (event.videoResolution && target.videoResolutions[event.videoResolution]) {
    target.videoResolutions[event.videoResolution].seconds = roundCost(
      target.videoResolutions[event.videoResolution].seconds
      + Math.max(0, Number(event.videoDurationSeconds) || 0)
    );
    target.videoResolutions[event.videoResolution].cost = roundCost(
      target.videoResolutions[event.videoResolution].cost + cost
    );
  }
}

function addUsageEvent(target, event) {
  addUsageCount(target, event);
  addUsageCost(target, event);
}

function failureDetailFromEvent(event = {}) {
  return {
    dateKey: event.dateKey || "",
    createdAt: event.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : String(event.createdAt || ""),
    usageType: event.usageType || "",
    provider: event.provider || "",
    model: event.model || "",
    requestId: event.requestId || "",
    errorCode: event.errorCode || "",
    errorMessage: event.errorMessage || "",
    errorStatus: Number(event.errorStatus) || 0,
    retryable: Boolean(event.retryable),
    attempt: Math.max(1, Number(event.attempt) || 1),
    durationMs: Math.max(0, Number(event.durationMs) || 0)
  };
}

function buildFailureStats(reasonMap, modelMap, details, total, failure) {
  const failureCount = Math.max(0, Number(failure) || 0);
  const totalCount = Math.max(0, Number(total) || 0);
  const reasons = Object.values(reasonMap || {})
    .map((item) => Object.assign({}, item, {
      rate: failureCount ? Number((item.count / failureCount * 100).toFixed(2)) : 0
    }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return String(right.lastSeen || "").localeCompare(String(left.lastSeen || ""));
    });
  const failedModels = Object.values(modelMap || {})
    .map((item) => Object.assign({}, item, {
      failureRate: item.total
        ? Number((item.failure / item.total * 100).toFixed(2))
        : 0
    }))
    .filter((item) => item.failure > 0)
    .sort((left, right) => {
      if (right.failure !== left.failure) return right.failure - left.failure;
      return right.total - left.total;
    })
    .slice(0, 20);
  return {
    total: failureCount,
    failureRate: totalCount ? Number((failureCount / totalCount * 100).toFixed(2)) : 0,
    topFailureReasons: reasons.slice(0, 5),
    failedModels,
    failureDetails: (Array.isArray(details) ? details : [])
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  };
}

function monthKeyFromDateKey(dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))
    ? String(dateKey).slice(0, 7)
    : "";
}

function shiftMonthKey(monthKey, months) {
  const match = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + Number(months || 0), 1));
  return date.toISOString().slice(0, 7);
}

function aggregateModelUsageEvents(events = [], days = 30, now = new Date()) {
  const rangeDays = Math.max(1, Math.min(90, Number(days) || 30));
  const todayKey = dateKeyForTimeZone(now, MODEL_USAGE_TIME_ZONE);
  const rangeStartKey = shiftDateKey(todayKey, -(rangeDays - 1));
  const monthlyStartKey = shiftDateKey(todayKey, -364);
  const last7StartKey = shiftDateKey(todayKey, -6);
  const last30StartKey = shiftDateKey(todayKey, -29);
  const summary = createUsageTypeMap();
  const today = emptyUsageCounters();
  const last7d = emptyUsageCounters();
  const last30d = emptyUsageCounters();
  const dailyMap = {};
  const monthlyMap = {};
  const modelMap = {};
  const userMap = {};
  const failureReasonMap = {};
  const failureDetails = [];

  for (let offset = 0; offset < rangeDays; offset += 1) {
    const dateKey = shiftDateKey(todayKey, -offset);
    dailyMap[dateKey] = Object.assign(emptyUsageCounters(), {
      dateKey,
      total: 0,
      success: 0,
      failure: 0
    }, createUsageTypeMap());
  }
  const currentMonthKey = monthKeyFromDateKey(todayKey);
  for (let offset = 0; offset < 12; offset += 1) {
    const monthKey = shiftMonthKey(currentMonthKey, -offset);
    monthlyMap[monthKey] = Object.assign(emptyUsageCounters(), {
      monthKey,
      total: 0,
      success: 0,
      failure: 0
    }, createUsageTypeMap());
  }

  (Array.isArray(events) ? events : []).forEach((source) => {
    const event = normalizeModelUsageEvent(source);
    if (!event || event.dateKey < monthlyStartKey || event.dateKey > todayKey) return;
    const daily = dailyMap[event.dateKey];
    const inDailyRange = event.dateKey >= rangeStartKey;
    if (inDailyRange) {
      const typeCounter = summary[event.usageType];
      addUsageEvent(typeCounter, event);
    }
    if (daily) {
      addUsageEvent(daily, event);
      addUsageEvent(daily[event.usageType], event);
    }
    const month = monthlyMap[monthKeyFromDateKey(event.dateKey)];
    if (month) {
      addUsageEvent(month, event);
      addUsageEvent(month[event.usageType], event);
    }
    if (event.dateKey === todayKey) addUsageEvent(today, event);
    if (event.dateKey >= last7StartKey) addUsageEvent(last7d, event);
    if (event.dateKey >= last30StartKey) addUsageEvent(last30d, event);

    if (inDailyRange) {
      const modelKey = [
        event.usageType,
        event.provider || "未填写",
        event.model || "未填写"
      ].join("|");
      if (!modelMap[modelKey]) {
        modelMap[modelKey] = Object.assign(emptyUsageCounters(), {
          usageType: event.usageType,
          provider: event.provider || "",
          model: event.model || ""
        });
      }
      addUsageEvent(modelMap[modelKey], event);
      const userKey = event.userHash || "anonymous";
      if (!userMap[userKey]) {
        userMap[userKey] = Object.assign(emptyUsageCounters(), {
          userHash: userKey,
          byType: createUsageTypeMap()
        });
      }
      addUsageEvent(userMap[userKey], event);
      addUsageEvent(userMap[userKey].byType[event.usageType], event);
      if (!event.success) {
        const reasonKey = failureReasonKey(event);
        if (!failureReasonMap[reasonKey]) {
          failureReasonMap[reasonKey] = {
            key: reasonKey,
            code: event.errorCode || "",
            label: failureReasonLabel(event),
            count: 0,
            lastSeen: "",
            usageType: event.usageType || "",
            provider: event.provider || "",
            model: event.model || "",
            status: Number(event.errorStatus) || 0,
            retryable: Boolean(event.retryable)
          };
        }
        const reason = failureReasonMap[reasonKey];
        reason.count += 1;
        reason.lastSeen = event.createdAt instanceof Date
          ? event.createdAt.toISOString()
          : String(event.createdAt || "");
        if (!reason.label || reason.label === "未提供错误原因") {
          reason.label = failureReasonLabel(event);
        }
        failureDetails.push(failureDetailFromEvent(event));
      }
    }
  });

  const models = Object.values(modelMap).sort((left, right) => right.total - left.total);
  const rangeTotal = Object.values(summary)
    .reduce((total, counter) => total + counter.total, 0);
  const rangeFailure = Object.values(summary)
    .reduce((total, counter) => total + counter.failure, 0);
  return {
    timeZone: MODEL_USAGE_TIME_ZONE,
    days: rangeDays,
    todayKey,
    today,
    last7d,
    last30d,
    summary,
    monthly: Object.keys(monthlyMap)
      .sort((left, right) => right.localeCompare(left))
      .map((monthKey) => monthlyMap[monthKey]),
    users: Object.values(userMap)
      .sort((left, right) => {
        if (right.estimatedCost !== left.estimatedCost) {
          return right.estimatedCost - left.estimatedCost;
        }
        return right.total - left.total;
      })
      .slice(0, 100),
    daily: Object.keys(dailyMap)
      .sort((left, right) => right.localeCompare(left))
      .map((dateKey) => dailyMap[dateKey]),
    models,
    failureStats: buildFailureStats(
      failureReasonMap,
      modelMap,
      failureDetails,
      rangeTotal,
      rangeFailure
    )
  };
}

function jsonResponse(ok, value) {
  return ok ? Object.assign({ ok: true }, value || {}) : Object.assign({ ok: false }, value || {});
}

function fail(message, errorCode = "server-error", extra = {}) {
  return jsonResponse(false, Object.assign({
    errorCode,
    message: String(message || "服务端处理失败"),
    retryable: false
  }, extra));
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function endpoint(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error("未配置 AI_BASE_URL");
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}/${String(path).replace(/^\/+/, "")}`;
}

function requestOnce(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      const invalid = new Error(`接口地址无效：${url}`);
      invalid.retryable = false;
      reject(invalid);
      return;
    }
    const transport = parsed.protocol === "http:" ? http : https;
    const timeoutMs = Math.max(
      1000,
      Number(options.timeoutMs || env("AI_TIMEOUT_MS", "90000")) || 90000
    );
    const requestOptions = Object.assign({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers: {}
    }, options);
    delete requestOptions.timeoutMs;
    const chunks = [];
    const req = transport.request(requestOptions, (res) => {
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 20 * 1024 * 1024) chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (_) {
          json = null;
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          buffer: Buffer.concat(chunks),
          raw,
          json
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("上游接口请求超时"));
    });
    req.on("error", reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

async function requestWithRetry(url, options = {}, body = null, meta = {}) {
  const imageGeneration = Boolean(meta.imageGeneration);
  const allowRetry = meta.allowRetry !== false && (!imageGeneration || imageRetryEnabled());
  const maxAttempts = allowRetry
    ? Math.max(1, Number(meta.maxAttempts) || maxRetries() + 1)
    : 1;
  const retryStatuses = Array.isArray(meta.retryStatuses)
    ? new Set(meta.retryStatuses.map((status) => Number(status)))
    : null;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const startedAt = Date.now();
    try {
      const response = await requestOnce(
        url,
        Object.assign({}, options, { timeoutMs: meta.timeoutMs }),
        body
      );
      const durationMs = Date.now() - startedAt;
      const retryable = retryStatuses
        ? retryStatuses.has(Number(response.status))
        : shouldRetryStatus(response.status);
      const success = response.status >= 200 && response.status < 300;
      const shouldRetry = !success && retryable && attempt < maxAttempts;
      if (!shouldRetry) {
        const billing = buildUsageBilling(
          meta,
          response,
          meta.costs || resolveCostConfig()
        );
        await recordModelUsageEvent({
          requestId: meta.requestId,
          userHash: meta.userHash,
          action: meta.action,
          provider: meta.provider,
          model: meta.model,
          success,
          status: response.status,
          durationMs,
          attempt,
          ...(success ? {} : failureDetailsFromResponse(response, retryable)),
          ...billing
        });
      }
      log("info", "upstream.response", {
        requestId: meta.requestId,
        action: meta.action,
        attempt,
        status: response.status,
        durationMs,
        endpoint: safeUrl(url),
        retryable,
        imageGeneration
      });
      if (!retryable || attempt >= maxAttempts) {
        if (retryable && attempt > 1) response.retryExhausted = true;
        return response;
      }
      const waitMs = Math.min(30000, Math.max(0, retryAfterMs(response.headers) || 0)) ||
        Math.min(10000, 500 * Math.pow(2, attempt - 1));
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      const durationMs = Date.now() - startedAt;
      const retryable = error && error.retryable !== undefined
        ? Boolean(error.retryable)
        : true;
      const shouldRetry = allowRetry && retryable && attempt < maxAttempts;
      if (!shouldRetry) {
        const billing = buildUsageBilling(
          meta,
          { json: error && error.payload },
          meta.costs || resolveCostConfig()
        );
        await recordModelUsageEvent({
          requestId: meta.requestId,
          userHash: meta.userHash,
          action: meta.action,
          provider: meta.provider,
          model: meta.model,
          success: false,
          status: error && error.status,
          durationMs,
          attempt,
          ...failureDetailsFromError(error, retryable),
          ...billing
        });
      }
      log("warn", "upstream.error", {
        requestId: meta.requestId,
        action: meta.action,
        attempt,
        durationMs,
        endpoint: safeUrl(url),
        error: error && error.message,
        retryable,
        imageGeneration
      });
      if (!allowRetry || !retryable || attempt >= maxAttempts) break;
      await sleep(Math.min(10000, 500 * Math.pow(2, attempt - 1)));
    }
  }

  if (lastError) {
    lastError.attempts = attempt;
    if (attempt > 1) lastError.code = "retry-exhausted";
    throw lastError;
  }
  return {
    status: 599,
    headers: {},
    buffer: Buffer.alloc(0),
    raw: "",
    json: null
  };
}

function upstreamError(response, fallback = "上游接口请求失败") {
  const message = response.json && response.json.error
    ? (response.json.error.message || JSON.stringify(response.json.error))
    : (response.json && response.json.message) || response.raw || `${fallback}：HTTP ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  error.payload = response.json;
  error.headers = response.headers;
  error.retryable = shouldRetryStatus(response.status);
  if (response.retryExhausted) error.code = "retry-exhausted";
  return error;
}

async function requestJson(url, payload, apiKey, extraHeaders = {}, meta = {}) {
  const body = JSON.stringify(payload);
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: Object.assign({
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Authorization: `Bearer ${apiKey}`
    }, extraHeaders)
  }, body, meta);
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response);
  }
  return response.json || {};
}

async function requestJsonMethod(
  url,
  payload,
  apiKey,
  method = "POST",
  extraHeaders = {},
  meta = {}
) {
  const hasBody = payload !== null && payload !== undefined;
  const body = hasBody ? JSON.stringify(payload) : null;
  const headers = Object.assign({
    Authorization: `Bearer ${apiKey}`
  }, extraHeaders);
  if (hasBody) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const response = await requestWithRetry(url, {
    method,
    headers
  }, body, meta);
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response);
  }
  return response.json || {};
}

async function downloadCloudFile(fileID, meta = {}) {
  if (!fileID) throw new Error("缺少云文件 ID");
  const startedAt = Date.now();
  let result;
  try {
    result = await retryOperation(async (attempt) => {
      try {
        log("info", "cloud.download.start", {
          requestId: meta.requestId,
          action: meta.action,
          attempt,
          fileType: meta.fileType || "asset"
        });
        return await cloud.downloadFile({ fileID });
      } catch (error) {
        error.retryable = true;
        throw error;
      }
    }, {
      allowRetry: true,
      maxAttempts: maxRetries() + 1
    });
  } catch (error) {
    log("warn", "cloud.download.failed", {
      requestId: meta.requestId,
      action: meta.action,
      fileType: meta.fileType || "asset",
      durationMs: Date.now() - startedAt,
      attempts: error && error.attempts,
      error: error && error.message
    });
    throw error;
  }
  const content = result && result.value;
  const fileContent = content && content.fileContent;
  if (!fileContent) throw new Error("云文件下载为空");
  log("info", "cloud.download.finish", {
    requestId: meta.requestId,
    action: meta.action,
    fileType: meta.fileType || "asset",
    durationMs: Date.now() - startedAt,
    attempts: result.attempt,
    imageBytes: Buffer.isBuffer(fileContent) ? fileContent.length : 0
  });
  return fileContent;
}

async function downloadUrl(url, meta = {}) {
  const response = await requestWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "image/*"
    }
  }, null, Object.assign({}, meta, { allowRetry: true }));
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response, "生成图片下载失败");
  }
  return response.buffer;
}

function detectMime(buffer) {
  if (!buffer || buffer.length < 4) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return "image/webp";
  return "image/png";
}

function toDataUrl(buffer, mime) {
  return `data:${mime || detectMime(buffer)};base64,${Buffer.from(buffer).toString("base64")}`;
}

function extractText(payload) {
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const content = message && message.content;
  if (Array.isArray(content)) {
    return content.map((item) => item && (item.text || item.content || "")).join("\n").trim();
  }
  if (typeof content === "string") return content.trim();
  if (typeof payload.output_text === "string") return payload.output_text.trim();
  return "";
}

function parseLooseJson(text) {
  const value = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(value);
  } catch (_) {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}

function firstText(value, fallback = "") {
  if (Array.isArray(value)) return String(value[0] || fallback);
  return String(value || fallback);
}

function normalizeAnalysis(payload, rawText) {
  const parsed = parseLooseJson(rawText) || payload || {};
  return {
    sceneDescription: firstText(
      parsed.sceneDescription || parsed.scene || parsed.scenery || parsed["场景"],
      rawText
    ),
    poseDescription: firstText(
      parsed.poseDescription || parsed.pose || parsed["姿态"],
      "沿用主图人物的身体方向、肩颈关系、手部位置和镜头距离。"
    ),
    faceDirectionDescription: firstText(
      parsed.faceDirectionDescription || parsed.faceDirection || parsed.face || parsed["面部朝向"],
      "匹配红圈内人物的头部角度、视线和表情。"
    ),
    lightingMakeupDescription: firstText(
      parsed.lightingMakeupDescription || parsed.lighting || parsed.makeup || parsed["光影妆容"],
      "匹配原图光源方向、阴影、高光、肤色反射和真实皮肤质感。"
    ),
    precisionNotes: firstText(parsed.precisionNotes || parsed.notes || parsed["注意事项"], "")
  };
}

function normalizeFaceDetections(payload, rawText) {
  const parsed = parseLooseJson(rawText) || payload || {};
  const source = Array.isArray(parsed)
    ? parsed
    : parsed.faces || parsed.faceBoxes || parsed.boxes || parsed.detections || [];
  const items = Array.isArray(source) ? source : [source];
  return items.map((item) => {
    const rawValue = item && item.box ? item.box : item || {};
    const value = Array.isArray(rawValue.bbox_2d)
      ? {
        x: rawValue.bbox_2d[0],
        y: rawValue.bbox_2d[1],
        right: rawValue.bbox_2d[2],
        bottom: rawValue.bbox_2d[3],
        confidence: rawValue.confidence ?? rawValue.score
      }
      : Array.isArray(rawValue.bbox2d)
        ? {
          x: rawValue.bbox2d[0],
          y: rawValue.bbox2d[1],
          right: rawValue.bbox2d[2],
          bottom: rawValue.bbox2d[3],
          confidence: rawValue.confidence ?? rawValue.score
        }
        : rawValue;
    let x = Number(value.x ?? value.left ?? value.x_min ?? value.xmin);
    let y = Number(value.y ?? value.top ?? value.y_min ?? value.ymin);
    let width = Number(value.width ?? value.w);
    let height = Number(value.height ?? value.h);
    const right = Number(value.right ?? value.x_max ?? value.xmax);
    const bottom = Number(value.bottom ?? value.y_max ?? value.ymax);
    const centerX = Number(value.cx ?? value.centerX ?? value.center_x);
    const centerY = Number(value.cy ?? value.centerY ?? value.center_y);
    if (!Number.isFinite(width) && Number.isFinite(x) && Number.isFinite(right)) {
      width = right - x;
    }
    if (!Number.isFinite(height) && Number.isFinite(y) && Number.isFinite(bottom)) {
      height = bottom - y;
    }
    if (!Number.isFinite(x) && Number.isFinite(centerX) && Number.isFinite(width)) {
      x = centerX - width / 2;
    }
    if (!Number.isFinite(y) && Number.isFinite(centerY) && Number.isFinite(height)) {
      y = centerY - height / 2;
    }
    const confidence = Number(value.confidence ?? value.score ?? 0);
    if (![x, y, width, height].every(Number.isFinite)) return null;
    const looksNormalized = [x, y, width, height].every((number) => Math.abs(number) <= 1.5);
    if (looksNormalized) {
      x *= 1000;
      y *= 1000;
      width *= 1000;
      height *= 1000;
    }
    const normalizedX = Math.max(0, Math.min(999, x));
    const normalizedY = Math.max(0, Math.min(999, y));
    return {
      x: normalizedX,
      y: normalizedY,
      width: Math.max(1, Math.min(1000 - normalizedX, width)),
      height: Math.max(1, Math.min(1000 - normalizedY, height)),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
    };
  }).filter((item) => item && item.width > 1 && item.height > 1);
}

function getOpenId(context) {
  return (context && (context.OPENID || context.openid)) || "anonymous";
}

function adminOpenIds() {
  return env("ADMIN_OPENIDS")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminContext(context) {
  const openid = getOpenId(context);
  return openid !== "anonymous" && adminOpenIds().includes(openid);
}

function adminForbidden() {
  return fail("没有管理员权限。", "ADMIN_FORBIDDEN");
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function normalizeRuntimePatch(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const imageSource = source.image && typeof source.image === "object" ? source.image : {};
  const videoSource = source.video && typeof source.video === "object" ? source.video : {};
  const pointsSource = source.points && typeof source.points === "object" ? source.points : {};
  const costsSource = source.costs && typeof source.costs === "object" ? source.costs : {};
  const faceCostSource = costsSource.face && typeof costsSource.face === "object"
    ? costsSource.face
    : {};
  const imageCostSource = costsSource.image && typeof costsSource.image === "object"
    ? costsSource.image
    : {};
  const videoCostSource = costsSource.video && typeof costsSource.video === "object"
    ? costsSource.video
    : {};
  const imageKeys = [
    "provider",
    "baseUrl",
    "endpoint",
    "model",
    "mode",
    "size",
    "timeoutMs",
    "maxRetries",
    "retryEnabled"
  ];
  const videoKeys = [
    "provider",
    "baseUrl",
    "endpoint",
    "queryEndpoint",
    "model",
    "createPath",
    "queryPath",
    "resolution",
    "aspectRatio",
    "timeoutMs"
  ];
  const pointsKeys = [
    "dailyFreeLimit",
    "imageCost",
    "videoCost",
    "checkinPoints",
    "streakBonus",
    "streakDays",
    "promoStartDate",
    "promoEndDate",
    "timeZone"
  ];
  const costKeys = [
    "currency"
  ];
  const faceCostKeys = [
    "inputPerMillionTokens",
    "outputPerMillionTokens"
  ];
  const imageCostKeys = [
    "defaultResolution"
  ];
  const videoCostKeys = [
    "defaultResolution",
    "defaultDurationSeconds"
  ];
  const image = {};
  const video = {};
  const points = {};
  const costs = {};
  const face = {};
  const imagePricing = {};
  const videoPricing = {};
  imageKeys.forEach((key) => {
    if (hasOwn(imageSource, key)) image[key] = imageSource[key];
  });
  videoKeys.forEach((key) => {
    if (hasOwn(videoSource, key)) video[key] = videoSource[key];
  });
  pointsKeys.forEach((key) => {
    if (hasOwn(pointsSource, key)) points[key] = pointsSource[key];
  });
  costKeys.forEach((key) => {
    if (hasOwn(costsSource, key)) costs[key] = costsSource[key];
  });
  faceCostKeys.forEach((key) => {
    if (hasOwn(faceCostSource, key)) face[key] = faceCostSource[key];
  });
  imageCostKeys.forEach((key) => {
    if (hasOwn(imageCostSource, key)) imagePricing[key] = imageCostSource[key];
  });
  videoCostKeys.forEach((key) => {
    if (hasOwn(videoCostSource, key)) videoPricing[key] = videoCostSource[key];
  });
  ["1K", "2K", "4K"].forEach((key) => {
    if (hasOwn(imageCostSource.perImage, key)) {
      imagePricing.perImage = Object.assign({}, imagePricing.perImage, {
        [key]: imageCostSource.perImage[key]
      });
    }
  });
  ["480p", "720p", "1080p"].forEach((key) => {
    if (hasOwn(videoCostSource.perSecond, key)) {
      videoPricing.perSecond = Object.assign({}, videoPricing.perSecond, {
        [key]: videoCostSource.perSecond[key]
      });
    }
  });
  if (Object.keys(face).length) costs.face = face;
  if (Object.keys(imagePricing).length) costs.image = imagePricing;
  if (Object.keys(videoPricing).length) costs.video = videoPricing;
  return { image, video, points, costs };
}

function isValidHttpUrl(value) {
  if (!value) return true;
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function isValidEndpointOrPath(value) {
  if (!value) return true;
  if (String(value).startsWith("/")) return true;
  return isValidHttpUrl(value);
}

function validateRuntimePatch(patch) {
  const errors = [];
  const image = patch.image || {};
  const video = patch.video || {};
  const points = patch.points || {};
  const costs = patch.costs || {};
  const faceCosts = costs.face || {};
  const imageCosts = costs.image || {};
  const videoCosts = costs.video || {};
  [
    ["image.baseUrl", image.baseUrl],
    ["image.endpoint", image.endpoint],
    ["video.baseUrl", video.baseUrl],
    ["video.endpoint", video.endpoint],
    ["video.queryEndpoint", video.queryEndpoint]
  ].forEach(([field, value]) => {
    if (value !== undefined && !isValidHttpUrl(value)) errors.push(`${field} 必须是 http/https 地址`);
  });
  [
    ["video.createPath", video.createPath],
    ["video.queryPath", video.queryPath]
  ].forEach(([field, value]) => {
    if (value !== undefined && !isValidEndpointOrPath(value)) {
      errors.push(`${field} 必须是 / 开头的路径或 http/https 地址`);
    }
  });
  if (image.mode !== undefined && image.mode !== "" && !["generations", "edits"].includes(String(image.mode).toLowerCase())) {
    errors.push("image.mode 只能是 generations 或 edits");
  }
  if (image.timeoutMs !== undefined && (!Number.isFinite(Number(image.timeoutMs)) || Number(image.timeoutMs) < 5000 || Number(image.timeoutMs) > 120000)) {
    errors.push("image.timeoutMs 必须在 5000～120000 之间");
  }
  if (image.maxRetries !== undefined && (!Number.isFinite(Number(image.maxRetries)) || Number(image.maxRetries) < 0 || Number(image.maxRetries) > 5)) {
    errors.push("image.maxRetries 必须在 0～5 之间");
  }
  if (video.timeoutMs !== undefined && (!Number.isFinite(Number(video.timeoutMs)) || Number(video.timeoutMs) < 10000 || Number(video.timeoutMs) > 900000)) {
    errors.push("video.timeoutMs 必须在 10000～900000 之间");
  }
  [
    ["image.provider", image.provider],
    ["image.model", image.model],
    ["image.size", image.size],
    ["video.provider", video.provider],
    ["video.model", video.model],
    ["video.resolution", video.resolution],
    ["video.aspectRatio", video.aspectRatio]
  ].forEach(([field, value]) => {
    if (value !== undefined && String(value).length > 120) errors.push(`${field} 长度不能超过 120`);
  });
  [
    ["points.dailyFreeLimit", points.dailyFreeLimit, 0, 100],
    ["points.imageCost", points.imageCost, 0, 100000],
    ["points.videoCost", points.videoCost, 0, 100000],
    ["points.checkinPoints", points.checkinPoints, 0, 100000],
    ["points.streakBonus", points.streakBonus, 0, 100000],
    ["points.streakDays", points.streakDays, 1, 30]
  ].forEach(([field, value, minimum, maximum]) => {
    if (
      value !== undefined
      && (!Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum)
    ) {
      errors.push(`${field} 必须在 ${minimum}～${maximum} 之间`);
    }
  });
  [
    ["points.promoStartDate", points.promoStartDate],
    ["points.promoEndDate", points.promoEndDate]
  ].forEach(([field, value]) => {
    if (value !== undefined && value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      errors.push(`${field} 必须是 YYYY-MM-DD 日期`);
    }
  });
  if (
    points.promoStartDate !== undefined
    && points.promoEndDate !== undefined
    && points.promoStartDate
    && points.promoEndDate
    && String(points.promoStartDate) > String(points.promoEndDate)
  ) {
    errors.push("积分活动开始日期不能晚于结束日期");
  }
  [
    ["costs.face.inputPerMillionTokens", faceCosts.inputPerMillionTokens],
    ["costs.face.outputPerMillionTokens", faceCosts.outputPerMillionTokens],
    ["costs.image.perImage.1K", imageCosts.perImage && imageCosts.perImage["1K"]],
    ["costs.image.perImage.2K", imageCosts.perImage && imageCosts.perImage["2K"]],
    ["costs.image.perImage.4K", imageCosts.perImage && imageCosts.perImage["4K"]],
    ["costs.video.perSecond.480p", videoCosts.perSecond && videoCosts.perSecond["480p"]],
    ["costs.video.perSecond.720p", videoCosts.perSecond && videoCosts.perSecond["720p"]],
    ["costs.video.perSecond.1080p", videoCosts.perSecond && videoCosts.perSecond["1080p"]],
    ["costs.video.defaultDurationSeconds", videoCosts.defaultDurationSeconds]
  ].forEach(([field, value]) => {
    if (
      value !== undefined
      && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100000)
    ) {
      errors.push(`${field} 必须在 0～100000 之间`);
    }
  });
  if (
    costs.currency !== undefined
    && String(costs.currency).trim().toUpperCase() !== "CNY"
  ) {
    errors.push("costs.currency 目前只能使用 CNY（人民币）");
  }
  if (
    imageCosts.defaultResolution !== undefined
    && !["1K", "2K", "4K"].includes(normalizeImageResolution(imageCosts.defaultResolution))
  ) {
    errors.push("costs.image.defaultResolution 只能是 1K、2K 或 4K");
  }
  if (
    videoCosts.defaultResolution !== undefined
    && !["480p", "720p", "1080p"].includes(normalizeVideoResolution(videoCosts.defaultResolution))
  ) {
    errors.push("costs.video.defaultResolution 只能是 480p、720p 或 1080p");
  }
  return errors;
}

function mergeRuntimeConfig(current, patch) {
  const existing = current && typeof current === "object" ? current : {};
  const existingCosts = existing.costs || {};
  const patchCosts = patch.costs || {};
  return {
    image: Object.assign({}, existing.image || {}, patch.image || {}),
    video: Object.assign({}, existing.video || {}, patch.video || {}),
    points: Object.assign({}, existing.points || {}, patch.points || {}),
    costs: Object.assign({}, existingCosts, patchCosts, {
      face: Object.assign({}, existingCosts.face || {}, patchCosts.face || {}),
      image: Object.assign({}, existingCosts.image || {}, patchCosts.image || {}, {
        perImage: Object.assign(
          {},
          existingCosts.image && existingCosts.image.perImage || {},
          patchCosts.image && patchCosts.image.perImage || {}
        )
      }),
      video: Object.assign({}, existingCosts.video || {}, patchCosts.video || {}, {
        perSecond: Object.assign(
          {},
          existingCosts.video && existingCosts.video.perSecond || {},
          patchCosts.video && patchCosts.video.perSecond || {}
        )
      })
    })
  };
}

function redactConfig(config, defaults) {
  const image = config.image || {};
  const video = config.video || {};
  const points = config.points || {};
  const costs = resolveCostConfig(config.costs || {});
  return {
    image: {
      provider: image.provider || "",
      baseUrl: image.baseUrl || "",
      endpoint: image.endpoint || "",
      model: image.model || "",
      mode: image.mode || "",
      size: image.size || "",
      timeoutMs: Number(image.timeoutMs || 0),
      maxRetries: Number(image.maxRetries || 0),
      retryEnabled: Boolean(image.retryEnabled),
      apiKeyConfigured: Boolean(defaults.image.apiKey)
    },
    video: {
      provider: video.provider || "",
      baseUrl: video.baseUrl || "",
      endpoint: video.endpoint || "",
      queryEndpoint: video.queryEndpoint || "",
      model: video.model || "",
      createPath: video.createPath || "",
      queryPath: video.queryPath || "",
      resolution: video.resolution || "",
      aspectRatio: video.aspectRatio || "",
      timeoutMs: Number(video.timeoutMs || 0),
      apiKeyConfigured: Boolean(defaults.video.apiKey)
    },
    points: {
      dailyFreeLimit: Number(points.dailyFreeLimit || 0),
      imageCost: Number(points.imageCost || 0),
      videoCost: Number(points.videoCost || 0),
      checkinPoints: Number(points.checkinPoints || 0),
      streakBonus: Number(points.streakBonus || 0),
      streakDays: Number(points.streakDays || 0),
      promoStartDate: points.promoStartDate || "",
      promoEndDate: points.promoEndDate || "",
      timeZone: points.timeZone || POINTS_TIME_ZONE
    },
    costs: {
      currency: costs.currency,
      version: costs.version,
      face: Object.assign({}, costs.face),
      image: {
        defaultResolution: costs.image.defaultResolution,
        perImage: Object.assign({}, costs.image.perImage)
      },
      video: {
        defaultResolution: costs.video.defaultResolution,
        perSecond: Object.assign({}, costs.video.perSecond),
        defaultDurationSeconds: costs.video.defaultDurationSeconds
      }
    }
  };
}

async function loadAdminRuntimeConfig(force = false) {
  if (
    process.env.WECHAT_MINIAPP_TEST === "1"
    && process.env.ADMIN_RUNTIME_CONFIG_SMOKE !== "1"
  ) {
    return null;
  }
  if (!force && adminRuntimeCache.expiresAt > Date.now()) return adminRuntimeCache.value;
  try {
    const result = await db
      .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
      .doc(ADMIN_RUNTIME_CONFIG_ID)
      .get();
    const value = result && result.data
      ? Object.assign(normalizeRuntimePatch(result.data), {
          version: Number(result.data.version) || 0,
          updatedAt: result.data.updatedAt || "",
          updatedBy: result.data.updatedBy || ""
        })
      : null;
    adminRuntimeCache = {
      value,
      expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
    };
    return value;
  } catch (error) {
    adminRuntimeCache = {
      value: null,
      expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
    };
    log("warn", "admin.runtime-config.read-failed", {
      error: error && error.message
    });
    return null;
  }
}

async function resolveEffectiveConfigs() {
  const runtime = await loadAdminRuntimeConfig();
  return {
    runtime: runtime || { image: {}, video: {}, points: {}, costs: {} },
    image: resolveImageConfig(runtime && runtime.image),
    video: resolveVideoConfig(runtime && runtime.video),
    points: resolvePointsConfig(runtime && runtime.points),
    costs: resolveCostConfig(runtime && runtime.costs)
  };
}

function adminConfigView(configs, runtime, metadata = {}) {
  const imageDefaults = resolveImageConfig();
  const videoDefaults = resolveVideoConfig();
  const pointDefaults = resolvePointsConfig();
  const costDefaults = resolveCostConfig();
  const overrides = runtime || { image: {}, video: {}, points: {}, costs: {} };
  return {
    defaults: redactConfig({
      image: imageDefaults,
      video: videoDefaults,
      points: pointDefaults,
      costs: costDefaults
    }, {
      image: imageDefaults,
      video: videoDefaults,
      points: pointDefaults,
      costs: costDefaults
    }),
    overrides: redactConfig(overrides, {
      image: imageDefaults,
      video: videoDefaults,
      points: pointDefaults,
      costs: costDefaults
    }),
    effective: redactConfig({
      image: configs.image,
      video: configs.video,
      points: configs.points,
      costs: configs.costs
    }, {
      image: configs.image,
      video: configs.video,
      points: configs.points,
      costs: configs.costs
    }),
    updatedAt: metadata.updatedAt || "",
    version: Number(metadata.version || 0),
    admin: true
  };
}

async function getAdminStatus(context) {
  return jsonResponse(true, {
    isAdmin: isAdminContext(context),
    openidConfigured: getOpenId(context) !== "anonymous"
  });
}

async function getAdminConfig(context) {
  if (!isAdminContext(context)) return adminForbidden();
  const runtime = await loadAdminRuntimeConfig();
  const configs = await resolveEffectiveConfigs();
  let metadata = runtime || {};
  if (process.env.WECHAT_MINIAPP_TEST !== "1") {
    try {
      const result = await db
        .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
        .doc(ADMIN_RUNTIME_CONFIG_ID)
        .get();
      metadata = result && result.data ? result.data : {};
    } catch (_) {
      metadata = runtime || {};
    }
  }
  return jsonResponse(true, adminConfigView(configs, runtime, metadata));
}

async function saveAdminConfig(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const patch = normalizeRuntimePatch(event && event.config);
  const errors = validateRuntimePatch(patch);
  if (errors.length) return fail(errors.join("；"), "ADMIN_CONFIG_INVALID", { fields: errors });
  const current = await loadAdminRuntimeConfig(true);
  const next = mergeRuntimeConfig(current, patch);
  const previousVersion = Number(current && current.version) || 0;
  const data = {
    _id: ADMIN_RUNTIME_CONFIG_ID,
    image: next.image,
    video: next.video,
    points: next.points,
    costs: next.costs,
    version: previousVersion + 1,
    updatedAt: new Date(),
    updatedBy: getOpenId(context)
  };
  await db.collection(ADMIN_RUNTIME_CONFIG_COLLECTION).doc(ADMIN_RUNTIME_CONFIG_ID).set({ data });
  adminRuntimeCache = {
    value: { image: next.image, video: next.video, points: next.points, costs: next.costs },
    expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
  };
  log("info", "admin.runtime-config.saved", {
    updatedBy: getOpenId(context),
    version: data.version,
    imageFields: Object.keys(patch.image),
    videoFields: Object.keys(patch.video),
    pointsFields: Object.keys(patch.points),
    costFields: Object.keys(patch.costs)
  });
  const configs = await resolveEffectiveConfigs();
  return jsonResponse(true, adminConfigView(configs, next, data));
}

async function writeDeploymentLog(entry) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") return true;
  try {
    await db.collection(ADMIN_DEPLOYMENT_LOG_COLLECTION).add({
      data: Object.assign({}, entry, {
        checkedAt: entry.checkedAt || new Date()
      })
    });
    return true;
  } catch (error) {
    log("warn", "admin.deployment-log.write-failed", {
      error: error && error.message
    });
    return false;
  }
}

async function checkDeployment(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const configs = await resolveEffectiveConfigs();
  const runtime = await loadAdminRuntimeConfig();
  const imageReady = Boolean(
    configs.image.apiKey &&
    (configs.image.baseUrl || configs.image.endpoint) &&
    configs.image.model
  );
  const videoReady = Boolean(configs.video.configured);
  const result = {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    environment: env("CLOUDBASE_ENV_ID", ""),
    image: {
      ready: imageReady,
      provider: configs.image.provider || "",
      model: configs.image.model || "",
      apiKeyConfigured: Boolean(configs.image.apiKey)
    },
    video: {
      ready: videoReady,
      provider: configs.video.provider || "",
      model: configs.video.model || "",
      apiKeyConfigured: Boolean(configs.video.apiKey)
    },
    runtimeConfigVersion: Number(runtime && runtime.version) || 0,
    runtimeConfigUpdatedAt: runtime && runtime.updatedAt
      ? new Date(runtime.updatedAt).toISOString()
      : "",
    checkedAt: new Date().toISOString()
  };
  const logWritten = await writeDeploymentLog(Object.assign({}, result, {
    requestId: event.requestId,
    ok: imageReady || videoReady,
    checkedBy: getOpenId(context)
  }));
  return jsonResponse(true, Object.assign(result, {
    ok: true,
    logWritten
  }));
}

async function listDeploymentLogs(context) {
  if (!isAdminContext(context)) return adminForbidden();
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return jsonResponse(true, { logs: [] });
  }
  try {
    const result = await db
      .collection(ADMIN_DEPLOYMENT_LOG_COLLECTION)
      .orderBy("checkedAt", "desc")
      .limit(20)
      .get();
    return jsonResponse(true, {
      logs: (result && result.data ? result.data : []).map((item) => sanitize(item))
    });
  } catch (error) {
    log("warn", "admin.deployment-log.read-failed", {
      error: error && error.message
    });
    return jsonResponse(true, {
      logs: [],
      message: "暂时没有部署检查日志。"
    });
  }
}

async function loadModelUsageEvents(startKey) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return modelUsageTestEvents.slice();
  }
  const events = [];
  const pageSize = 100;
  const maxEvents = 5000;
  let offset = 0;
  const command = db.command;
  while (offset < maxEvents) {
    const result = await db
      .collection(MODEL_USAGE_EVENT_COLLECTION)
      .where({ dateKey: command.gte(startKey) })
      .skip(offset)
      .limit(Math.min(pageSize, maxEvents - offset))
      .get();
    const rows = result && Array.isArray(result.data) ? result.data : [];
    events.push(...rows);
    if (rows.length < pageSize) break;
    offset += rows.length;
  }
  return events;
}

async function getModelUsageStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const days = Math.max(1, Math.min(90, Number(event && event.days) || 30));
  const todayKey = dateKeyForTimeZone(new Date(), MODEL_USAGE_TIME_ZONE);
  const startKey = shiftDateKey(todayKey, -(days - 1));
  const monthlyStartKey = shiftDateKey(todayKey, -364);
  try {
    const events = await loadModelUsageEvents(monthlyStartKey);
    const stats = aggregateModelUsageEvents(events, days);
    return jsonResponse(true, Object.assign(stats, {
      eventCount: events.length,
      truncated: events.length >= 5000,
      message: events.length >= 5000
        ? "统计记录较多，本次最多读取 5000 条。"
        : ""
    }));
  } catch (error) {
    log("warn", "model-usage.read-failed", {
      startKey,
      days,
      error: error && error.message
    });
    return jsonResponse(true, Object.assign(
      aggregateModelUsageEvents([], days),
      {
        eventCount: 0,
        truncated: false,
        unavailable: true,
        message: "统计数据暂时读取失败，请稍后刷新。"
      }
    ));
  }
}

function formatExportNumber(value, digits = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

function buildModelUsageExportWorkbook(stats = {}) {
  const workbook = XLSX.utils.book_new();
  const dailyRows = [[
    "日期",
    "总调用次数",
    "成功",
    "失败",
    "预计成本（元）",
    "人脸成本（元）",
    "生图成本（元）",
    "视频成本（元）",
    "输入Token",
    "输出Token",
    "总Token",
    "视频秒数",
    "1K张数",
    "2K张数",
    "4K张数",
    "480p秒数",
    "720p秒数",
    "1080p秒数",
    "未计算次数"
  ]];
  (Array.isArray(stats.daily) ? stats.daily : []).forEach((item) => {
    const image = item.image || {};
    const face = item.face || {};
    const video = item.video || {};
    const imageResolutions = item.imageResolutions || image.imageResolutions || {};
    const videoResolutions = item.videoResolutions || video.videoResolutions || {};
    dailyRows.push([
      item.dateKey || "",
      Number(item.total) || 0,
      Number(item.success) || 0,
      Number(item.failure) || 0,
      formatExportNumber(item.estimatedCost),
      formatExportNumber(face.estimatedCost),
      formatExportNumber(image.estimatedCost),
      formatExportNumber(video.estimatedCost),
      Number(item.inputTokens) || 0,
      Number(item.outputTokens) || 0,
      Number(item.totalTokens) || 0,
      formatExportNumber(item.videoDurationSeconds, 3),
      Number(imageResolutions["1K"] && imageResolutions["1K"].count) || 0,
      Number(imageResolutions["2K"] && imageResolutions["2K"].count) || 0,
      Number(imageResolutions["4K"] && imageResolutions["4K"].count) || 0,
      formatExportNumber(videoResolutions["480p"] && videoResolutions["480p"].seconds, 3),
      formatExportNumber(videoResolutions["720p"] && videoResolutions["720p"].seconds, 3),
      formatExportNumber(videoResolutions["1080p"] && videoResolutions["1080p"].seconds, 3),
      Number(item.unavailableCostCount) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(dailyRows), "每日明细");

  const userRows = [[
    "用户标识",
    "调用次数",
    "成功",
    "失败",
    "预计成本（元）",
    "输入Token",
    "输出Token",
    "总Token",
    "视频秒数",
    "未计算次数"
  ]];
  (Array.isArray(stats.users) ? stats.users : []).forEach((item) => {
    userRows.push([
      item.userHash || "anonymous",
      Number(item.total) || 0,
      Number(item.success) || 0,
      Number(item.failure) || 0,
      formatExportNumber(item.estimatedCost),
      Number(item.inputTokens) || 0,
      Number(item.outputTokens) || 0,
      Number(item.totalTokens) || 0,
      formatExportNumber(item.videoDurationSeconds, 3),
      Number(item.unavailableCostCount) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(userRows), "按用户");

  const modelRows = [[
    "功能",
    "Provider",
    "模型",
    "调用次数",
    "成功",
    "失败",
    "预计成本（元）",
    "输入Token",
    "输出Token",
    "总Token",
    "视频秒数",
    "未计算次数"
  ]];
  (Array.isArray(stats.models) ? stats.models : []).forEach((item) => {
    modelRows.push([
      item.usageType || "",
      item.provider || "",
      item.model || "",
      Number(item.total) || 0,
      Number(item.success) || 0,
      Number(item.failure) || 0,
      formatExportNumber(item.estimatedCost),
      Number(item.inputTokens) || 0,
      Number(item.outputTokens) || 0,
      Number(item.totalTokens) || 0,
      formatExportNumber(item.videoDurationSeconds, 3),
      Number(item.unavailableCostCount) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(modelRows), "按模型");

  const monthlyRows = [[
    "月份",
    "总调用次数",
    "成功",
    "失败",
    "预计成本（元）",
    "人脸成本（元）",
    "生图成本（元）",
    "视频成本（元）",
    "总Token",
    "视频秒数",
    "未计算次数"
  ]];
  (Array.isArray(stats.monthly) ? stats.monthly : []).forEach((item) => {
    monthlyRows.push([
      item.monthKey || "",
      Number(item.total) || 0,
      Number(item.success) || 0,
      Number(item.failure) || 0,
      formatExportNumber(item.estimatedCost),
      formatExportNumber(item.face && item.face.estimatedCost),
      formatExportNumber(item.image && item.image.estimatedCost),
      formatExportNumber(item.video && item.video.estimatedCost),
      Number(item.totalTokens) || 0,
      formatExportNumber(item.videoDurationSeconds, 3),
      Number(item.unavailableCostCount) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(monthlyRows), "按月份");

  const failureRows = [[
    "日期",
    "时间",
    "功能",
    "Provider",
    "模型",
    "请求编号",
    "错误代码",
    "失败原因",
    "HTTP状态码",
    "是否可重试",
    "尝试次数",
    "耗时（毫秒）"
  ]];
  (Array.isArray(stats.failureStats && stats.failureStats.failureDetails)
    ? stats.failureStats.failureDetails
    : []
  ).forEach((item) => {
    failureRows.push([
      item.dateKey || "",
      item.createdAt || "",
      item.usageType || "",
      item.provider || "",
      item.model || "",
      item.requestId || "",
      item.errorCode || "",
      item.errorMessage || "未提供错误原因",
      Number(item.errorStatus) || 0,
      item.retryable ? "是" : "否",
      Math.max(1, Number(item.attempt) || 1),
      Math.max(0, Number(item.durationMs) || 0)
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(failureRows), "失败明细");

  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer"
  });
}

async function exportModelUsageStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const days = Math.max(1, Math.min(90, Number(event && event.days) || 30));
  const stats = await getModelUsageStats({ days }, context);
  if (!stats || stats.ok === false) return stats;
  const buffer = buildModelUsageExportWorkbook(stats);
  const dateKey = dateKeyForTimeZone(new Date(), MODEL_USAGE_TIME_ZONE);
  const fileName = `模型用量统计-${dateKey}.xlsx`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `exports/model-usage/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.xlsx`,
    fileContent: buffer
  });
  return jsonResponse(true, {
    fileID: uploaded && uploaded.fileID ? uploaded.fileID : "",
    fileName,
    sizeBytes: buffer.length,
    days,
    message: "Excel 文件已生成，可以下载。"
  });
}

async function analyze(event) {
  const payload = event.payload || {};
  const vision = resolveVisionConfig();
  if (!vision.apiKey) {
    return fail(
      "云函数还没有配置 AI_VISION_API_KEY（兼容 AI_API_KEY）。",
      "missing-api-key"
    );
  }
  if (!payload.mainFileID) return fail("缺少主图文件。", "missing-main-image");

  const image = await downloadCloudFile(payload.mainFileID, {
    requestId: event.requestId,
    action: "analyze",
    fileType: "main"
  });
  assertVisionImageSize(image, vision);
  const url = vision.endpoint || endpoint(vision.baseUrl, "chat/completions");
  const model = vision.model;
  const instruction = payload.instruction || "请分析图片并返回场景、姿态、面部朝向、光影妆容四项。";
  const requestPayload = {
    model,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `${instruction}\n只返回 JSON，字段名使用 sceneDescription、poseDescription、faceDirectionDescription、lightingMakeupDescription、precisionNotes。` },
        { type: "image_url", image_url: { url: toDataUrl(image, "image/jpeg") } }
      ]
    }]
  };
  let response;
  try {
    response = await requestJson(url, Object.assign({}, requestPayload, {
      response_format: { type: "json_object" }
    }), vision.apiKey, {}, visionRequestMeta(event.requestId, "analyze", vision));
  } catch (error) {
    if (error.status !== 400) throw error;
    response = await requestJson(
      url,
      requestPayload,
      vision.apiKey,
      {},
      visionRequestMeta(event.requestId, "analyze", vision)
    );
  }
  const rawText = extractText(response);
  if (!rawText) return fail("视觉模型没有返回可用分析文本。", "empty-analysis");
  return jsonResponse(true, {
    provider: vision.provider,
    model,
    analysis: normalizeAnalysis(null, rawText)
  });
}

async function detectFaceCircle(event, context) {
  const detectionStartedAt = Date.now();
  const payload = event.payload || {};
  const vision = resolveVisionConfig();
  const configs = await resolveEffectiveConfigs();
  const costs = configs.costs;
  if (!vision.apiKey) {
    return fail(
      "云函数还没有配置 AI_VISION_API_KEY（兼容 AI_API_KEY）。",
      "missing-api-key"
    );
  }
  if (!payload.mainFileID) return fail("缺少主图文件。", "missing-main-image");

  const image = await downloadCloudFile(payload.mainFileID, {
    requestId: event.requestId,
    action: "detectFaceCircle",
    fileType: "main"
  });
  const downloadMs = Date.now() - detectionStartedAt;
  const imageBytes = assertVisionImageSize(image, vision);
  log("info", "vision.image.ready", {
    requestId: event.requestId,
    action: "detectFaceCircle",
    imageBytes
  });
  const url = vision.endpoint || endpoint(vision.baseUrl, "chat/completions");
  const model = vision.faceModel || vision.model;
  const instruction = [
    "你是人脸位置检测器，只分析这张原图中清晰可见的人脸。",
    "请找出所有可识别的人脸，忽略海报、头像小图、屏幕反光和动物脸。",
    "每张脸返回一个外接矩形，使用 bbox_2d 数组表示 [左,上,右,下]，四个数都必须是 0 到 1000 的归一化坐标。",
    "bbox_2d 必须紧贴脸部外接框，不要返回整个人、衣服或背景。",
    "必须返回图片里的全部人脸，不能只返回最明显的一张。",
    "只返回 JSON，不要 Markdown、解释、示例数字或其他文字。",
    'JSON 结构固定为 {"faces":[{"bbox_2d":[左,上,右,下],"confidence":置信度}]}。',
    "如果没有清晰人脸，返回 {\"faces\":[]}。"
  ].join("\n");
  const imageEncodingStartedAt = Date.now();
  const imageDataUrl = toDataUrl(image, detectMime(image));
  const imageEncodingMs = Date.now() - imageEncodingStartedAt;
  const requestPayload = {
    model,
    temperature: 0,
    top_p: 0.01,
    seed: 42,
    max_tokens: 128,
    enable_thinking: false,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: imageDataUrl } }
      ]
    }]
  };
  let response;
  const visionRequestStartedAt = Date.now();
  try {
    try {
        response = await requestJson(url, Object.assign({}, requestPayload, {
          response_format: { type: "json_object" }
        }), vision.apiKey, {}, Object.assign(
          visionRequestMeta(event.requestId, "detectFaceCircle", vision, costs),
          { userHash: usageUserHash(getOpenId(context)) }
        ));
    } catch (error) {
      if (error.status !== 400) throw error;
      response = await requestJson(
        url,
        requestPayload,
        vision.apiKey,
        {},
        Object.assign(
          visionRequestMeta(event.requestId, "detectFaceCircle", vision, costs),
          { userHash: usageUserHash(getOpenId(context)) }
        )
      );
    }
  } catch (error) {
    log("warn", "face-detection.failed", {
      requestId: event.requestId,
      action: "detectFaceCircle",
      durationMs: Date.now() - detectionStartedAt,
      imageBytes,
      imageEncodingMs,
      visionRequestMs: Date.now() - visionRequestStartedAt,
      model,
      error: error && error.message
    });
    throw error;
  }
  const visionRequestMs = Date.now() - visionRequestStartedAt;
  const rawText = extractText(response);
  if (!rawText) return fail("视觉模型没有返回人脸位置。", "empty-face-detection");
  const faces = normalizeFaceDetections(null, rawText);
  const timing = {
    totalMs: Date.now() - detectionStartedAt,
    downloadMs,
    visionRequestMs,
    imageEncodingMs,
    imageBytes
  };
  log("info", "face-detection.finish", {
    requestId: event.requestId,
    action: "detectFaceCircle",
    durationMs: timing.totalMs,
    downloadMs,
    visionRequestMs,
    imageEncodingMs,
    imageBytes,
    faceCount: faces.length,
    model
  });
  return jsonResponse(true, {
    provider: vision.provider,
    model,
    coordinateSystem: "normalized-1000",
    detectionStatus: faces.length ? "face-detected" : "no-face-detected",
    faceCount: faces.length,
    faces,
    timing
  });
}

function autoFaceProbeHistoryCutoff(baseDate = new Date()) {
  return new Date(
    baseDate.getTime() - AUTO_FACE_PROBE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
}

async function cleanupAutoFaceProbeHistory(baseDate = new Date()) {
  const cutoff = autoFaceProbeHistoryCutoff(baseDate);
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    let removed = 0;
    for (let index = autoFaceProbeTestEvents.length - 1; index >= 0; index -= 1) {
      const createdAt = new Date(autoFaceProbeTestEvents[index].createdAt || 0);
      if (!Number.isNaN(createdAt.getTime()) && createdAt < cutoff) {
        autoFaceProbeTestEvents.splice(index, 1);
        removed += 1;
      }
    }
    return { removed, truncated: false };
  }
  try {
    const command = db.command;
    const result = await db
      .collection(AUTO_FACE_PROBE_LOG_COLLECTION)
      .where({ createdAt: command.lt(cutoff) })
      .limit(AUTO_FACE_PROBE_CLEANUP_BATCH_SIZE)
      .get();
    const rows = result && Array.isArray(result.data) ? result.data : [];
    let removed = 0;
    for (const row of rows) {
      if (!row || !row._id) continue;
      await db.collection(AUTO_FACE_PROBE_LOG_COLLECTION).doc(row._id).remove();
      removed += 1;
    }
    return {
      removed,
      truncated: rows.length >= AUTO_FACE_PROBE_CLEANUP_BATCH_SIZE
    };
  } catch (error) {
    log("warn", "auto-face-probe.cleanup-failed", {
      error: error && error.message
    });
    return { removed: 0, truncated: false, failed: true };
  }
}

async function writeAutoFaceProbeHistory(entry) {
  const report = normalizeAutoFaceProbeHistoryReport(entry, entry && entry.requestId);
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    autoFaceProbeTestEvents.push(report);
    return true;
  }
  try {
    await db.collection(AUTO_FACE_PROBE_LOG_COLLECTION).add({ data: report });
    await cleanupAutoFaceProbeHistory(new Date());
    return true;
  } catch (error) {
    log("warn", "auto-face-probe.write-failed", {
      error: error && error.message
    });
    return false;
  }
}

async function loadAutoFaceProbeHistory(startDate) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return autoFaceProbeTestEvents.slice();
  }
  const command = db.command;
  const result = await db
    .collection(AUTO_FACE_PROBE_LOG_COLLECTION)
    .where({ createdAt: command.gte(startDate) })
    .orderBy("checkedAt", "desc")
    .limit(20)
    .get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function getAutoFaceProbeHistory(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const baseDate = new Date();
  const startDate = autoFaceProbeHistoryCutoff(baseDate);
  try {
    await cleanupAutoFaceProbeHistory(baseDate);
    const rows = await loadAutoFaceProbeHistory(startDate);
    return jsonResponse(true, {
      history: rows
        .map(autoFaceProbeHistoryDisplayEvent)
        .sort((left, right) => (
          new Date(right.checkedAt || 0).getTime()
          - new Date(left.checkedAt || 0).getTime()
        ))
        .slice(0, 20),
      retentionDays: AUTO_FACE_PROBE_RETENTION_DAYS,
      truncated: rows.length >= 20,
      unavailable: false,
      message: ""
    });
  } catch (error) {
    log("warn", "auto-face-probe.read-failed", {
      error: error && error.message
    });
    return jsonResponse(true, {
      history: [],
      retentionDays: AUTO_FACE_PROBE_RETENTION_DAYS,
      truncated: false,
      unavailable: true,
      message: "探针历史暂时读取失败，请先创建 auto_face_probe_logs 集合。"
    });
  }
}

async function probeAutoFace(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const startedAt = Date.now();
  const probe = buildAutoFaceProbe();
  const durationMs = Math.max(0, Math.min(60 * 1000, Date.now() - startedAt));
  const historyWritten = await writeAutoFaceProbeHistory({
    status: "ok",
    requestId: event.requestId,
    buildVersion: probe.buildVersion,
    buildMarker: probe.buildMarker,
    nodeVersion: probe.runtime.nodeVersion,
    cloudEnvConfigured: probe.runtime.cloudEnvConfigured,
    visionConfigured: probe.vision.configured,
    provider: probe.vision.provider,
    model: probe.vision.model,
    durationMs,
    checkedAt: probe.checkedAt
  });
  return jsonResponse(true, Object.assign({
    action: "probeAutoFace",
    requestId: event.requestId,
    durationMs,
    historyWritten
  }, probe));
}

async function analyzeWebPoses(event) {
  const payload = event.payload || {};
  const vision = resolveVisionConfig();
  if (!vision.apiKey) {
    return fail(
      "云函数还没有配置 AI_VISION_API_KEY（兼容 AI_API_KEY）。",
      "missing-api-key"
    );
  }
  if (!payload.mainFileID) return fail("缺少主图文件。", "missing-main-image");

  const image = await downloadCloudFile(payload.mainFileID, {
    requestId: event.requestId,
    action: "analyzeWebPoses",
    fileType: "main"
  });
  assertVisionImageSize(image, vision);
  const url = vision.endpoint || endpoint(vision.baseUrl, "chat/completions");
  const model = vision.model;
  const instruction = [
    "你是人像摄影姿势指导。当前目标平台是“社交平台照片”，分析方向是“自然”，调整幅度是“正常调整”。",
    "只根据这张原图中真实可见的人物、构图、机位、身体空间和遮挡情况，给出 8 个可实际执行、自然上镜的姿势方案。",
    "不要改变人物身份、服装、背景、场景或镜头位置。建议要具体到身体朝向、头部、肩膀、眼神和手部动作，8 条不能只是换说法。",
    "如果原图身体范围或手部不可见，必须给出不依赖看不见部位的替代动作，并在 unsuitableReason 里说明原因。",
    "只返回一个 JSON 对象，不要 Markdown、代码块、解释或过渡文字。",
    "格式必须严格为：",
    "{\"poses\":[{\"id\":1,\"title\":\"短标题\",\"description\":\"具体姿势说明\",\"category\":\"侧身\",\"tags\":[\"肩颈\"],\"unsuitableReason\":\"\"}]}",
    "poses 必须正好有 8 条；id 必须恰好为 1 到 8 且不重复；category 只能是侧身、回头、手部、肩颈、坐姿、全身或其他；title 使用 2 到 12 个中文字符；description 每条至少 20 个中文字符。"
  ].join("\n");
  const requestPayload = {
    model,
    temperature: 0.35,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image_url", image_url: { url: toDataUrl(image, detectMime(image)) } }
      ]
    }]
  };
  let response;
  try {
    response = await requestJson(url, Object.assign({}, requestPayload, {
      response_format: { type: "json_object" }
    }), vision.apiKey, {}, visionRequestMeta(event.requestId, "analyzeWebPoses", vision));
  } catch (error) {
    if (error.status !== 400) throw error;
    response = await requestJson(
      url,
      requestPayload,
      vision.apiKey,
      {},
      visionRequestMeta(event.requestId, "analyzeWebPoses", vision)
    );
  }
  const rawText = extractText(response);
  if (!rawText) return fail("视觉模型没有返回网感姿势建议。", "empty-web-pose-analysis");
  const suggestions = normalizeWebPoseSuggestions(parseLooseJson(rawText));
  if (!suggestions) {
    return fail(
      "视觉模型没有返回完整且合规的 8 条网感姿势建议，请重新分析。",
      "invalid-web-pose-analysis"
    );
  }
  return jsonResponse(true, {
    provider: vision.provider,
    model,
    analyzedAt: new Date().toISOString(),
    suggestions
  });
}

function extractImageItem(payload) {
  const item = payload && payload.data && payload.data[0] ? payload.data[0] : payload;
  if (!item) return null;
  if (item.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), mime: "image/png" };
  if (item.base64) return { buffer: Buffer.from(item.base64, "base64"), mime: "image/png" };
  if (item.url) return { url: item.url };
  return null;
}

function imageExtension(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function invertMask(buffer, requestId) {
  if (!boolEnv("AI_MASK_INVERT", false)) return buffer;
  try {
    const png = PNG.sync.read(Buffer.from(buffer));
    for (let index = 3; index < png.data.length; index += 4) {
      png.data[index] = 255 - png.data[index];
    }
    return PNG.sync.write(png);
  } catch (error) {
    log("error", "mask.invert.failed", {
      requestId,
      error: error && error.message
    });
    throw new Error("mask 反转失败，请确认上传的是 PNG mask。");
  }
}

async function requestImageEdits(
  payload,
  apiKey,
  requestId,
  imageConfig = resolveImageConfig(),
  costs = resolveCostConfig(),
  userHash = "anonymous"
) {
  if (!payload.mainFileID || !payload.maskFileID) {
    const error = new Error("编辑模式需要主图和 mask 文件。");
    error.code = "missing-edit-asset";
    throw error;
  }
  const mainBuffer = await downloadCloudFile(payload.mainFileID, {
    requestId,
    action: "generate",
    fileType: "main"
  });
  const maskBuffer = invertMask(
    await downloadCloudFile(payload.maskFileID, {
      requestId,
      action: "generate",
      fileType: "mask"
    }),
    requestId
  );

  const references = []
    .concat(payload.identityFileID ? [{
      fileID: payload.identityFileID,
      role: "identity",
      index: 0
    }] : [])
    .concat((payload.faceFileIDs || []).filter(Boolean).slice(0, 6).map((fileID, index) => ({
      fileID,
      role: "face",
      index
    })))
    .concat((payload.wardrobeFileIDs || []).filter(Boolean).slice(0, 12).map((fileID, index) => ({
      fileID,
      role: "wardrobe",
      index
    })));
  const referenceBuffers = await Promise.all(references.map(async (reference) => ({
    reference,
    buffer: await downloadCloudFile(reference.fileID, {
      requestId,
      action: "generate",
      fileType: reference.role
    })
  })));

  const mainMime = detectMime(mainBuffer);
  const maskMime = detectMime(maskBuffer);
  const referenceField = env("AI_IMAGE_REFERENCE_FIELD", "image[]");
  const fields = [
    { name: "model", value: imageConfig.model },
    { name: "prompt", value: String(payload.prompt || "").trim() },
    { name: "size", value: imageConfig.size || payload.size },
    {
      name: "reference_manifest",
      value: JSON.stringify(references.map((item) => ({
        role: item.role,
        index: item.index
      })))
    }
  ];
  if (payload.n) fields.push({ name: "n", value: String(payload.n) });

  const files = [
    {
      name: env("AI_IMAGE_MAIN_FIELD", "image"),
      filename: `main.${imageExtension(mainMime)}`,
      mime: mainMime,
      buffer: mainBuffer
    },
    {
      name: env("AI_IMAGE_MASK_FIELD", "mask"),
      filename: "mask.png",
      mime: maskMime,
      buffer: maskBuffer
    }
  ];
  referenceBuffers.forEach(({ reference, buffer }) => {
    const mime = detectMime(buffer);
    files.push({
      name: referenceField,
      filename: `${reference.role}-${reference.index + 1}.${imageExtension(mime)}`,
      mime,
      buffer
    });
  });

  const multipart = createMultipart(fields, files);
  const url = env("AI_IMAGE_EDIT_ENDPOINT") || endpoint(imageConfig.baseUrl, "images/edits");
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": multipart.contentType,
      "Content-Length": multipart.body.length,
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": requestId
    }
  }, multipart.body, {
    requestId,
    action: payload.__action || "repairImage",
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    imageGeneration: true,
    allowRetry: imageConfig.retryEnabled,
    maxAttempts: imageConfig.retryEnabled ? imageConfig.maxRetries + 1 : 1,
    timeoutMs: imageConfig.timeoutMs,
    costs,
    userHash,
    imageResolution: imageConfig.size || payload.size
  });
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response, "图片编辑接口请求失败");
  }
  return response.json || {};
}

function dateKeyForTimeZone(date = new Date(), timeZone = POINTS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = {};
  parts.forEach((part) => {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return "";
  const value = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  return value.toISOString().slice(0, 10);
}

function isPromoDate(dateKey, points) {
  const start = String(points && points.promoStartDate || "");
  const end = String(points && points.promoEndDate || "");
  return Boolean(start && end && dateKey >= start && dateKey <= end);
}

function calculateNextStreak(lastCheckinDate, currentStreak, dateKey) {
  const streak = Math.max(0, Number(currentStreak) || 0);
  if (!lastCheckinDate) return 1;
  if (String(lastCheckinDate) === String(dateKey)) return streak || 1;
  return String(lastCheckinDate) === shiftDateKey(dateKey, -1) ? streak + 1 : 1;
}

function pointsAccountId(openid) {
  return crypto.createHash("sha256").update(`points:${openid}`).digest("hex").slice(0, 32);
}

function pointsLedgerId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`ledger:${openid}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
}

function generationOperationId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`operation:${openid}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
}

function repairRecordId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`repair-record:${openid}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
}

function repairChainId(openid, rootRecordId) {
  return crypto.createHash("sha256")
    .update(`repair-chain:${openid}:${rootRecordId}`)
    .digest("hex")
    .slice(0, 32);
}

function assetTicketId(openid, ticketId) {
  return crypto.createHash("sha256")
    .update(`asset-ticket:${openid}:${ticketId}`)
    .digest("hex")
    .slice(0, 32);
}

function userAssetId(openid, fileID) {
  return crypto.createHash("sha256")
    .update(`user-asset:${openid}:${fileID}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeAssetKind(kind) {
  const value = String(kind || "").trim().toLowerCase();
  return REPAIR_ASSET_KINDS.has(value) ? value : "";
}

function normalizeCloudPath(fileID) {
  return String(fileID || "")
    .replace(/^cloud:\/\/[^/]+\/?/, "")
    .replace(/^\/+/, "");
}

function safeAssetName(value) {
  const name = String(value || "image.jpg").split(/[\\/]/).pop();
  return name.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_").slice(-120) || "image.jpg";
}

function assetPathMatches(fileID, cloudPath) {
  const actual = normalizeCloudPath(fileID);
  const expected = String(cloudPath || "").replace(/^\/+/, "");
  return Boolean(actual && expected && (actual === expected || actual.endsWith(`/${expected}`)));
}

function defaultPointsAccount(openid) {
  return {
    _id: pointsAccountId(openid),
    openid,
    pointsBalance: 0,
    totalEarned: 0,
    totalSpent: 0,
    currentStreak: 0,
    lastCheckinDate: "",
    boundAt: new Date(),
    updatedAt: new Date()
  };
}

function isDocumentNotFoundError(error) {
  const code = String(error && (error.code || error.errCode) || "").toUpperCase();
  const message = String(error && (error.message || error.errMsg) || "");
  return [
    "DATABASE_DOCUMENT_NOT_EXIST",
    "DOCUMENT_NOT_FOUND",
    "NOT_FOUND"
  ].includes(code)
    || /document.*(?:not exist|not found)|文档不存在/i.test(message);
}

async function readDocument(ref) {
  try {
    const result = await ref.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isDocumentNotFoundError(error)) return null;
    throw error;
  }
}

async function prepareAssetUpload(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") return fail("请先完成微信授权后再上传素材。", "wechat-binding-required");
  const kind = normalizeAssetKind(event.kind);
  if (!kind) return fail("不支持的素材类型。", "invalid-asset-kind");
  const ticketId = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
  const ownerHash = crypto.createHash("sha256").update(openid).digest("hex").slice(0, 24);
  const fileName = safeAssetName(event.fileName);
  const cloudPath = `assets/${ownerHash}/${kind}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${fileName}`;
  const expiresAt = new Date(Date.now() + ASSET_TICKET_TTL_MS);
  const data = {
    _id: assetTicketId(openid, ticketId),
    ticketId,
    openid,
    kind,
    cloudPath,
    contentType: String(event.contentType || "image/jpeg").slice(0, 80),
    createdAt: new Date(),
    expiresAt,
    used: false
  };
  await db.collection(ASSET_UPLOAD_TICKET_COLLECTION).doc(data._id).set({ data });
  return jsonResponse(true, {
    ticketId,
    kind,
    cloudPath,
    expiresAt: expiresAt.toISOString()
  });
}

async function registerAsset(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") return fail("请先完成微信授权后再登记素材。", "wechat-binding-required");
  const ticketId = String(event.ticketId || "").trim();
  const fileID = String(event.fileID || "").trim();
  const kind = normalizeAssetKind(event.kind);
  if (!ticketId || !fileID || !kind) return fail("素材登记参数不完整。", "invalid-asset-registration");
  const ticketDocId = assetTicketId(openid, ticketId);
  const asset = await db.runTransaction(async (transaction) => {
    const ticketRef = transaction.collection(ASSET_UPLOAD_TICKET_COLLECTION).doc(ticketDocId);
    const ticket = await readDocument(ticketRef);
    if (!ticket || ticket.openid !== openid) {
      const error = new Error("素材上传票据不存在或已失效。");
      error.code = "asset-ticket-invalid";
      throw error;
    }
    if (ticket.used) {
      const error = new Error("素材上传票据已经使用过。");
      error.code = "asset-ticket-used";
      throw error;
    }
    if (ticket.expiresAt && new Date(ticket.expiresAt).getTime() < Date.now()) {
      const error = new Error("素材上传票据已过期，请重新选择图片。");
      error.code = "asset-ticket-expired";
      throw error;
    }
    if (ticket.kind !== kind || !assetPathMatches(fileID, ticket.cloudPath)) {
      const error = new Error("上传文件与素材票据不匹配。");
      error.code = "asset-file-mismatch";
      throw error;
    }
    const assetId = userAssetId(openid, fileID);
    const assetRef = transaction.collection(USER_ASSET_COLLECTION).doc(assetId);
    const existing = await readDocument(assetRef);
    const next = Object.assign({}, existing || {}, {
      _id: assetId,
      openid,
      fileID,
      kind,
      cloudPath: ticket.cloudPath,
      refCount: Math.max(0, Number(existing && existing.refCount) || 0),
      temporary: false,
      createdAt: existing && existing.createdAt || new Date(),
      updatedAt: new Date()
    });
    await assetRef.set({ data: next });
    await ticketRef.update({
      data: {
        used: true,
        fileID,
        assetId,
        registeredAt: new Date()
      }
    });
    return next;
  }, 5);
  return jsonResponse(true, { asset });
}

async function findUserAsset(openid, fileID, kind, store = db) {
  const normalizedKind = normalizeAssetKind(kind);
  const asset = await readDocument(
    store.collection(USER_ASSET_COLLECTION).doc(userAssetId(openid, fileID))
  );
  if (
    !asset
    || asset.openid !== openid
    || asset.fileID !== fileID
    || (normalizedKind && asset.kind !== normalizedKind)
  ) {
    const error = new Error("参考素材尚未完成云端登记，请重新选择后再试。");
    error.code = "asset-not-registered";
    throw error;
  }
  return asset;
}

async function retainUserAssets(openid, fileIDs, kind, store = db) {
  const ids = Array.from(new Set((Array.isArray(fileIDs) ? fileIDs : []).filter(Boolean)));
  for (const fileID of ids) {
    const asset = await findUserAsset(openid, fileID, kind, store);
    const ref = store.collection(USER_ASSET_COLLECTION).doc(asset._id);
    await ref.update({
      data: {
        refCount: Math.max(0, Number(asset.refCount) || 0) + 1,
        updatedAt: new Date()
      }
    });
  }
}

async function validateGenerationAssets(openid, payload) {
  if (Number(payload && payload.assetRegistrationVersion) < 1) return;
  const mainFileID = String(payload.mainFileID || "").trim();
  const maskFileID = String(payload.maskFileID || "").trim();
  if (mainFileID) await findUserAsset(openid, mainFileID, "main");
  if (maskFileID) await findUserAsset(openid, maskFileID, "mask");
  await Promise.all(
    (Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs : [])
      .filter(Boolean)
      .slice(0, 6)
      .map((fileID) => findUserAsset(openid, fileID, "face"))
  );
  await Promise.all(
    (Array.isArray(payload.wardrobeFileIDs) ? payload.wardrobeFileIDs : [])
      .filter(Boolean)
      .slice(0, 12)
      .map((fileID) => findUserAsset(openid, fileID, "wardrobe"))
  );
}

async function releaseUserAssets(openid, references, store = db) {
  const unique = new Map();
  (Array.isArray(references) ? references : []).forEach((item) => {
    const fileID = String(item && item.fileID || "").trim();
    const kind = normalizeAssetKind(item && item.kind);
    if (fileID && kind) unique.set(`${kind}:${fileID}`, { fileID, kind });
  });
  for (const item of unique.values()) {
    const asset = await readDocument(
      store.collection(USER_ASSET_COLLECTION).doc(userAssetId(openid, item.fileID))
    );
    if (!asset || asset.openid !== openid || asset.kind !== item.kind) continue;
    await store.collection(USER_ASSET_COLLECTION).doc(asset._id).update({
      data: {
        refCount: Math.max(0, (Number(asset.refCount) || 0) - 1),
        updatedAt: new Date()
      }
    });
  }
}

async function readPointsAccount(openid, store = db) {
  return readDocument(
    store.collection(POINTS_ACCOUNT_COLLECTION).doc(pointsAccountId(openid))
  );
}

async function ensurePointsAccount(openid, store = db) {
  const ref = store.collection(POINTS_ACCOUNT_COLLECTION).doc(pointsAccountId(openid));
  const existing = await readDocument(ref);
  if (existing) return existing;
  const data = defaultPointsAccount(openid);
  await ref.set({ data });
  return data;
}

async function readDailyQuota(openid, dateKey, dailyFreeLimit, store = db) {
  const quotaId = crypto.createHash("sha256")
    .update(`quota:${openid}:${dateKey}`)
    .digest("hex")
    .slice(0, 32);
  const ref = store.collection(USER_QUOTA_COLLECTION).doc(quotaId);
  const existing = await readDocument(ref);
  return {
    ref,
    data: Object.assign({
      _id: quotaId,
      openid,
      dateKey,
      used: 0,
      freeUsed: 0,
      promoFree: 0,
      freeLimit: dailyFreeLimit,
      dailyLimit: dailyFreeLimit,
      updatedAt: new Date()
    }, existing || {})
  };
}

async function findPointLedger(openid, requestId, store = db) {
  if (!openid || !requestId) return null;
  const id = pointsLedgerId(openid, requestId);
  return readDocument(store.collection(POINTS_LEDGER_COLLECTION).doc(id));
}

async function savePointLedger(openid, requestId, data, store = db) {
  const ledgerId = pointsLedgerId(openid, requestId);
  const ref = store.collection(POINTS_LEDGER_COLLECTION).doc(ledgerId);
  const record = Object.assign({
    _id: ledgerId,
    openid,
    requestId,
    createdAt: new Date()
  }, data);
  await ref.set({ data: record });
  return record;
}

async function findGenerationOperation(openid, requestId, store = db) {
  if (!openid || !requestId) return null;
  return readDocument(
    store
      .collection(GENERATION_OPERATION_COLLECTION)
      .doc(generationOperationId(openid, requestId))
  );
}

async function saveGenerationOperation(openid, requestId, data, store = db) {
  const operationId = generationOperationId(openid, requestId);
  const ref = store.collection(GENERATION_OPERATION_COLLECTION).doc(operationId);
  const existing = await readDocument(ref);
  const now = new Date();
  const record = Object.assign({
    _id: operationId,
    openid,
    requestId,
    status: "reserved",
    createdAt: now
  }, existing || {}, data, {
    _id: operationId,
    openid,
    requestId,
    updatedAt: now
  });
  await ref.set({ data: record });
  return record;
}

function operationStateError(operation, message) {
  const status = String(operation && operation.status || "");
  const error = new Error(message || (
    status === "refunded"
      ? "本次请求已退款，请重新发起并使用新的请求编号。"
      : status === "refunding"
        ? "本次请求正在退款，请稍后查看积分明细。"
        : "本次请求正在处理中，请稍后重试。"
  ));
  error.code = status === "refunded"
    ? "request-refunded"
    : status === "refunding"
      ? "request-refunding"
      : "request-processing";
  error.operationStatus = status;
  error.retryable = status === "processing";
  return error;
}

function operationUpdatedAtMs(operation) {
  const value = operation && (
    operation.processingAt
    || operation.updatedAt
    || operation.createdAt
  );
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function claimGenerationOperation(openid, requestId, kind) {
  return db.runTransaction(async (transaction) => {
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (!operation) {
      const error = new Error("生成请求尚未完成额度预留，请重新发起。");
      error.code = "generation-not-reserved";
      throw error;
    }
    if (operation.kind && operation.kind !== kind) {
      const error = new Error("同一请求编号不能用于不同类型的生成任务。");
      error.code = "request-kind-conflict";
      throw error;
    }
    const status = String(operation.status || "reserved");
    if (["refunding", "refunded"].includes(status)) {
      throw operationStateError(operation);
    }
    if (status === "succeeded") {
      return { claimed: false, operation, completed: true };
    }
    if (status === "processing") {
      const stale = Date.now() - operationUpdatedAtMs(operation) >= GENERATION_OPERATION_STALE_MS;
      if (!stale || operation.providerTaskId) {
        return { claimed: false, operation, completed: false };
      }
    } else if (!["reserved", "failed"].includes(status)) {
      throw operationStateError(operation);
    }
    const claimed = await saveGenerationOperation(openid, requestId, {
      kind,
      status: "processing",
      processingAt: new Date(),
      attemptCount: (Number(operation.attemptCount) || 0) + 1,
      lastError: null
    }, transaction);
    return { claimed: true, operation: claimed, completed: false };
  }, 5);
}

async function updateGenerationOperation(openid, requestId, patch, options = {}) {
  return db.runTransaction(async (transaction) => {
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (!operation) return null;
    const status = String(operation.status || "");
    if (status === "refunded") return operation;
    if (
      Array.isArray(options.allowedStatuses)
      && options.allowedStatuses.length
      && !options.allowedStatuses.includes(status)
    ) {
      return operation;
    }
    return saveGenerationOperation(openid, requestId, patch, transaction);
  }, 5);
}

async function completeGenerationOperation(openid, requestId, result) {
  return updateGenerationOperation(openid, requestId, {
    status: "succeeded",
    result,
    succeededAt: new Date(),
    lastError: null
  }, {
    allowedStatuses: ["processing", "succeeded"]
  });
}

async function failGenerationOperation(openid, requestId, error) {
  return updateGenerationOperation(openid, requestId, {
    status: "failed",
    failedAt: new Date(),
    lastError: {
      code: String(error && error.code || "generation-failed"),
      message: String(error && error.message || "生成失败"),
      retryable: Boolean(error && error.retryable)
    }
  }, {
    allowedStatuses: ["processing", "failed"]
  });
}

function pointsSummary(account, quota, points, dateKey) {
  const value = account || defaultPointsAccount("anonymous");
  const quotaData = quota && quota.data ? quota.data : {};
  const freeLimit = Math.max(0, Number(points.dailyFreeLimit) || 0);
  const freeUsed = Math.max(0, Number(quotaData.freeUsed !== undefined ? quotaData.freeUsed : quotaData.used) || 0);
  const promoActive = isPromoDate(dateKey, points);
  const checkedInToday = value.lastCheckinDate === dateKey;
  const nextStreak = checkedInToday
    ? Math.max(0, Number(value.currentStreak) || 0)
    : calculateNextStreak(value.lastCheckinDate, value.currentStreak, dateKey);
  const nextCheckinReward = checkedInToday
    ? 0
    : (Number(points.checkinPoints) || 0)
      + (nextStreak > 0 && nextStreak % Number(points.streakDays) === 0
        ? Number(points.streakBonus) || 0
        : 0);
  return {
    pointsBalance: Math.max(0, Number(value.pointsBalance) || 0),
    totalEarned: Math.max(0, Number(value.totalEarned) || 0),
    totalSpent: Math.max(0, Number(value.totalSpent) || 0),
    currentStreak: Math.max(0, Number(value.currentStreak) || 0),
    lastCheckinDate: value.lastCheckinDate || "",
    checkedInToday,
    nextCheckinReward,
    freeUsed,
    freeLimit,
    freeRemaining: Math.max(0, freeLimit - freeUsed),
    promoActive,
    promoStartDate: points.promoStartDate,
    promoEndDate: points.promoEndDate,
    imageCost: Number(points.imageCost) || 0,
    videoCost: Number(points.videoCost) || 0,
    checkinPoints: Number(points.checkinPoints) || 0,
    streakBonus: Number(points.streakBonus) || 0,
    streakDays: Number(points.streakDays) || 7,
    billingMode: promoActive
      ? "promo-free"
      : freeUsed < freeLimit
        ? "daily-free"
        : "points"
  };
}

async function reserveUsage(openid, requestId, kind) {
  const configs = await resolveEffectiveConfigs();
  const points = configs.points;
  const dateKey = dateKeyForTimeZone(new Date(), points.timeZone);
  if (openid === "anonymous" && process.env.WECHAT_MINIAPP_TEST === "1") {
    return {
      requestId,
      dateKey,
      kind,
      source: "test-free",
      pointsCharged: 0,
      cost: 0,
      quota: {
        freeUsed: 0,
        freeLimit: points.dailyFreeLimit,
        freeRemaining: points.dailyFreeLimit,
        billingMode: "test-free"
      },
      alreadyReserved: false,
      untracked: true
    };
  }
  const cost = kind === "video" ? Number(points.videoCost) || 0 : Number(points.imageCost) || 0;
  return db.runTransaction(async (transaction) => {
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (operation) {
      if (["refunding", "refunded"].includes(String(operation.status || ""))) {
        throw operationStateError(operation);
      }
      const account = await readPointsAccount(openid, transaction);
      const quota = await readDailyQuota(openid, dateKey, points.dailyFreeLimit, transaction);
      const billing = operation.billing || {};
      return Object.assign({
        requestId,
        dateKey: billing.dateKey || dateKey,
        kind: operation.kind || kind,
        alreadyReserved: true,
        operation
      }, billing, {
        pointsCharged: Math.max(0, Number(billing.pointsCharged) || 0),
        quota: pointsSummary(account, quota, points, dateKey)
      });
    }

    const existingLedger = await findPointLedger(openid, requestId, transaction);
    const existingRefund = existingLedger
      ? await findPointLedger(openid, `refund:${requestId}`, transaction)
      : null;
    if (existingRefund) {
      throw operationStateError({ status: "refunded" });
    }

    const quota = await readDailyQuota(openid, dateKey, points.dailyFreeLimit, transaction);
    let account = await readPointsAccount(openid, transaction);

    if (existingLedger) {
      const legacyBilling = Object.assign({}, existingLedger.billing || {}, {
        pointsCharged: Math.max(
          0,
          Number(existingLedger.amount) < 0 ? -Number(existingLedger.amount) : 0
        )
      });
      const legacyOperation = await saveGenerationOperation(openid, requestId, {
        kind: existingLedger.kind || kind,
        status: "reserved",
        billing: legacyBilling,
        ledgerId: existingLedger._id,
        legacyRecovered: true
      }, transaction);
      return Object.assign({
        requestId,
        dateKey,
        kind,
        alreadyReserved: true,
        operation: legacyOperation
      }, legacyBilling, {
        quota: pointsSummary(account, quota, points, dateKey)
      });
    }

    let source = "points";
    let pointsCharged = cost;
    if (isPromoDate(dateKey, points)) {
      source = "promo-free";
      pointsCharged = 0;
      quota.data.promoFree = (Number(quota.data.promoFree) || 0) + 1;
    } else if (
      (Number(quota.data.freeUsed) || Number(quota.data.used) || 0)
      < Number(points.dailyFreeLimit)
    ) {
      source = "daily-free";
      pointsCharged = 0;
      quota.data.freeUsed = (
        Number(quota.data.freeUsed) || Number(quota.data.used) || 0
      ) + 1;
      quota.data.used = quota.data.freeUsed;
    } else {
      const balance = Math.max(0, Number(account && account.pointsBalance) || 0);
      if (balance < cost) {
        const error = new Error(`积分不足，本次需要 ${cost} 积分，请先签到。`);
        error.code = "points-insufficient";
        error.pointsRequired = cost;
        error.pointsBalance = balance;
        throw error;
      }
      account.pointsBalance = balance - cost;
      account.totalSpent = (Number(account.totalSpent) || 0) + cost;
      account.updatedAt = new Date();
      await transaction
        .collection(POINTS_ACCOUNT_COLLECTION)
        .doc(account._id)
        .set({ data: account });
    }

    quota.data.freeLimit = Number(points.dailyFreeLimit) || 0;
    quota.data.dailyLimit = quota.data.freeLimit;
    quota.data.updatedAt = new Date();
    await quota.ref.set({ data: quota.data });
    const billing = {
      source,
      kind,
      cost,
      pointsCharged,
      dateKey
    };
    const ledger = await savePointLedger(openid, requestId, {
      type: source === "points" ? "spend" : source,
      kind,
      amount: source === "points" ? -cost : 0,
      balanceAfter: Math.max(0, Number(account && account.pointsBalance) || 0),
      dateKey,
      description: source === "promo-free"
        ? "活动期间免费使用"
        : source === "daily-free"
          ? "每日免费次数"
          : `${kind === "video" ? "照片转视频" : "生图"}扣除积分`,
      billing
    }, transaction);
    const newOperation = await saveGenerationOperation(openid, requestId, {
      kind,
      status: "reserved",
      billing,
      ledgerId: ledger._id
    }, transaction);
    return {
      requestId,
      dateKey,
      kind,
      source,
      pointsCharged,
      cost,
      quota: pointsSummary(account, quota, points, dateKey),
      ledgerId: ledger._id,
      operation: newOperation,
      alreadyReserved: false
    };
  }, 5);
}

async function refundUsage(openid, requestId, reason) {
  const configs = await resolveEffectiveConfigs();
  const points = configs.points;
  return db.runTransaction(async (transaction) => {
    const original = await findPointLedger(openid, requestId, transaction);
    if (!original) return null;
    const refundRequestId = `refund:${requestId}`;
    const existingRefund = await findPointLedger(openid, refundRequestId, transaction);
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (existingRefund || (operation && operation.status === "refunded")) {
      return {
        duplicate: true,
        ledger: existingRefund,
        operation
      };
    }
    if (operation && operation.status === "succeeded") {
      return {
        skipped: true,
        reason: "operation-succeeded",
        operation
      };
    }

    const dateKey = String(
      original.dateKey || dateKeyForTimeZone(new Date(), points.timeZone)
    );
    let account = await readPointsAccount(openid, transaction);
    const quota = await readDailyQuota(
      openid,
      dateKey,
      points.dailyFreeLimit,
      transaction
    );
    let amount = 0;
    if (original.type === "spend" && Number(original.amount) < 0) {
      account = account || defaultPointsAccount(openid);
      amount = -Number(original.amount);
      account.pointsBalance = (Number(account.pointsBalance) || 0) + amount;
      account.totalSpent = Math.max(0, (Number(account.totalSpent) || 0) - amount);
      account.updatedAt = new Date();
      await transaction
        .collection(POINTS_ACCOUNT_COLLECTION)
        .doc(account._id)
        .set({ data: account });
    } else if (original.type === "daily-free") {
      quota.data.freeUsed = Math.max(0, (Number(quota.data.freeUsed) || 0) - 1);
      quota.data.used = quota.data.freeUsed;
      quota.data.updatedAt = new Date();
      await quota.ref.set({ data: quota.data });
    } else if (original.type === "promo-free") {
      quota.data.promoFree = Math.max(0, (Number(quota.data.promoFree) || 0) - 1);
      quota.data.updatedAt = new Date();
      await quota.ref.set({ data: quota.data });
    }

    const refundLedger = await savePointLedger(openid, refundRequestId, {
      type: "refund",
      kind: original.kind || "",
      amount,
      balanceAfter: Math.max(0, Number(account && account.pointsBalance) || 0),
      dateKey,
      description: reason || (
        amount > 0 ? "生成失败，积分已退回" : "生成失败，免费次数已退回"
      ),
      billing: {
        source: "refund",
        originalRequestId: requestId,
        originalLedgerId: original._id
      }
    }, transaction);
    const refundedOperation = operation
      ? await saveGenerationOperation(openid, requestId, {
          status: "refunded",
          refundLedgerId: refundLedger._id,
          refundReason: reason || "",
          refundedAt: new Date()
        }, transaction)
      : null;
    return {
      duplicate: false,
      account,
      quota: quota.data,
      ledger: refundLedger,
      operation: refundedOperation
    };
  }, 5);
}

async function getUserPoints(context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return jsonResponse(true, Object.assign({
      accountBound: false,
      boundMessage: "点击签到后绑定微信身份"
    }, pointsSummary(defaultPointsAccount("anonymous"), { data: {} }, resolvePointsConfig(), dateKeyForTimeZone())));
  }
  const configs = await resolveEffectiveConfigs();
  const dateKey = dateKeyForTimeZone(new Date(), configs.points.timeZone);
  const account = await readPointsAccount(openid);
  const quota = await readDailyQuota(openid, dateKey, configs.points.dailyFreeLimit);
  return jsonResponse(true, Object.assign({
    accountBound: Boolean(account),
    boundMessage: account ? "已绑定当前微信" : "点击签到后绑定微信身份"
  }, pointsSummary(
    account || defaultPointsAccount("anonymous"),
    quota,
    configs.points,
    dateKey
  )));
}

async function checkIn(context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") return fail("请先完成微信授权后再签到。", "wechat-binding-required");
  const configs = await resolveEffectiveConfigs();
  const points = configs.points;
  const dateKey = dateKeyForTimeZone(new Date(), points.timeZone);
  const requestId = `checkin:${dateKey}`;
  const checkin = await db.runTransaction(async (transaction) => {
    const existingLedger = await findPointLedger(openid, requestId, transaction);
    let account = await readPointsAccount(openid, transaction);
    if (existingLedger) {
      return {
        duplicate: true,
        earned: 0,
        bonus: 0,
        account: account || defaultPointsAccount(openid)
      };
    }
    account = account || defaultPointsAccount(openid);
    const nextStreak = calculateNextStreak(
      account.lastCheckinDate,
      account.currentStreak,
      dateKey
    );
    const bonus = nextStreak > 0 && nextStreak % Number(points.streakDays) === 0
      ? Number(points.streakBonus) || 0
      : 0;
    const earned = (Number(points.checkinPoints) || 0) + bonus;
    account.pointsBalance = (Number(account.pointsBalance) || 0) + earned;
    account.totalEarned = (Number(account.totalEarned) || 0) + earned;
    account.currentStreak = nextStreak;
    account.lastCheckinDate = dateKey;
    account.boundAt = account.boundAt || new Date();
    account.updatedAt = new Date();
    await transaction
      .collection(POINTS_ACCOUNT_COLLECTION)
      .doc(account._id)
      .set({ data: account });
    await savePointLedger(openid, requestId, {
      type: "checkin",
      kind: "checkin",
      amount: earned,
      balanceAfter: account.pointsBalance,
      dateKey,
      description: bonus
        ? `连续签到 ${points.streakDays} 天奖励`
        : "每日签到奖励",
      billing: { base: points.checkinPoints, bonus }
    }, transaction);
    return {
      duplicate: false,
      earned,
      bonus,
      account
    };
  }, 5);
  const quota = await readDailyQuota(openid, dateKey, points.dailyFreeLimit);
  return jsonResponse(true, Object.assign({
    accountBound: true,
    duplicate: checkin.duplicate,
    earnedToday: checkin.earned,
    streakBonus: checkin.bonus
  }, pointsSummary(checkin.account, quota, points, dateKey)));
}

async function getPointLedger(context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") return jsonResponse(true, { records: [] });
  const result = await db.collection(POINTS_LEDGER_COLLECTION)
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  return jsonResponse(true, {
    records: (result && result.data ? result.data : []).map((item) => Object.assign({}, item, {
      id: item._id,
      createdAt: item.createdAt instanceof Date
        ? item.createdAt.toISOString()
        : String(item.createdAt || "")
    }))
  });
}

async function findGenerationRecord(openid, requestId) {
  if (!openid || !requestId) return null;
  try {
    const result = await db.collection("generation_records")
      .where({ openid, requestId })
      .limit(1)
      .get();
    return result && Array.isArray(result.data) && result.data.length
      ? result.data[0]
      : null;
  } catch (error) {
    log("warn", "generation.idempotency_lookup_failed", {
      requestId,
      message: error && error.message ? error.message : String(error)
    });
    return null;
  }
}

async function readGenerationRecord(recordId, store = db) {
  if (!recordId) return null;
  return readDocument(store.collection("generation_records").doc(String(recordId)));
}

function revisionConflictError(message = "这条结果已经被其他修正任务更新，请刷新后从最新结果继续。") {
  const error = new Error(message);
  error.code = "REVISION_CONFLICT";
  error.retryable = false;
  return error;
}

async function claimRepairChain(openid, parentRecord, requestId) {
  const parentId = String(parentRecord && (parentRecord._id || parentRecord.id) || "");
  const parentRevision = Math.max(0, Number(parentRecord && parentRecord.revisionNumber) || 0);
  const rootRecordId = parentRecord && parentRecord.generationType === "repair"
    ? String(parentRecord.rootRecordId || parentRecord.parentRecordId || parentId)
    : parentId;
  const chainId = repairChainId(openid, rootRecordId);
  const revisionNumber = parentRevision + 1;
  if (revisionNumber > REPAIR_MAX_REVISIONS) {
    const error = new Error(`单条修正链最多支持 ${REPAIR_MAX_REVISIONS} 次修正。`);
    error.code = "repair-limit-reached";
    throw error;
  }
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(REPAIR_CHAIN_COLLECTION).doc(chainId);
    const existing = await readDocument(ref);
    const chain = Object.assign({
      _id: chainId,
      openid,
      rootRecordId,
      tailRecordId: parentId,
      tailRevision: parentRevision,
      pendingRequestId: "",
      pendingParentId: "",
      pendingRevision: 0,
      createdAt: new Date()
    }, existing || {});
    if (chain.pendingRequestId && chain.pendingRequestId !== requestId) {
      throw revisionConflictError("这条结果正在被其他修正任务处理，请稍后刷新。");
    }
    if (
      chain.tailRecordId !== parentId
      || Number(chain.tailRevision) !== parentRevision
    ) {
      throw revisionConflictError();
    }
    const next = Object.assign({}, chain, {
      rootRecordId,
      pendingRequestId: requestId,
      pendingParentId: parentId,
      pendingRevision: revisionNumber,
      updatedAt: new Date()
    });
    await ref.set({ data: next });
    return {
      chainId,
      rootRecordId,
      parentRecordId: parentId,
      revisionNumber,
      requestId
    };
  }, 5);
}

async function completeRepairChain(slot, recordId) {
  if (!slot || !slot.chainId) return;
  await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(REPAIR_CHAIN_COLLECTION).doc(slot.chainId);
    const chain = await readDocument(ref);
    if (!chain) return;
    if (chain.pendingRequestId && chain.pendingRequestId !== slot.requestId) {
      throw revisionConflictError("修正链状态已被其他请求占用。");
    }
    await ref.set({
      data: Object.assign({}, chain, {
        tailRecordId: recordId,
        tailRevision: slot.revisionNumber,
        pendingRequestId: "",
        pendingParentId: "",
        pendingRevision: 0,
        updatedAt: new Date()
      })
    });
  }, 5);
}

async function releaseRepairChain(slot) {
  if (!slot || !slot.chainId) return;
  try {
    await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(REPAIR_CHAIN_COLLECTION).doc(slot.chainId);
      const chain = await readDocument(ref);
      if (!chain || chain.pendingRequestId !== slot.requestId) return;
      await ref.set({
        data: Object.assign({}, chain, {
          pendingRequestId: "",
          pendingParentId: "",
          pendingRevision: 0,
          updatedAt: new Date()
        })
      });
    }, 5);
  } catch (error) {
    log("warn", "repair.chain_release_failed", {
      requestId: slot.requestId,
      chainId: slot.chainId,
      message: error && error.message
    });
  }
}

async function generate(event, context) {
  const payload = event.payload || {};
  const openid = getOpenId(context);
  if (!payload.prompt || !String(payload.prompt).trim()) return fail("提示词不能为空。", "empty-prompt");
  if (payload.generationType === "repair" || payload.mode === "edits") {
    return fail("普通生图接口不接受局部修正请求，请改用 repairImage。", "repair-action-required");
  }
  const configs = await resolveEffectiveConfigs();
  const imageConfig = configs.image;
  const costs = configs.costs;
  const apiKey = imageConfig.apiKey;
  if (!apiKey) return fail(
    "云函数还没有配置 AI_IMAGE_API_KEY（兼容旧配置 AI_API_KEY）。",
    "missing-api-key"
  );

  const mode = "generations";

  const requestId = event.requestId;
  const model = imageConfig.model;
  const size = imageConfig.size || payload.size;
  const prompt = `${String(payload.prompt).trim()}${
    payload.negativePrompt ? `\n\n负面约束：${String(payload.negativePrompt).trim()}` : ""
  }`;
  const existingRecord = await findGenerationRecord(openid, requestId);
  if (existingRecord) {
    log("info", "generation.idempotent_hit", {
      requestId,
      recordId: existingRecord._id || existingRecord.id
    });
    return jsonResponse(true, {
      recordId: existingRecord._id || existingRecord.id,
      fileID: existingRecord.fileID || "",
      tempFileURL: existingRecord.tempFileURL || "",
      createdAt: existingRecord.createdAt instanceof Date
        ? existingRecord.createdAt.toISOString()
        : String(existingRecord.createdAt || ""),
      record: Object.assign({}, existingRecord, {
        id: existingRecord._id || existingRecord.id
      }),
      deduplicated: true
    });
  }
  await validateGenerationAssets(openid, payload);
  log("info", "generation.start", {
    requestId,
    action: "generate",
    mode,
    model,
    size,
    faceRefs: Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs.length : 0,
    wardrobeRefs: Array.isArray(payload.wardrobeFileIDs) ? payload.wardrobeFileIDs.length : 0
  });

  let billing = null;
  let claimed = false;
  let resultPersisted = false;
  try {
    billing = await reserveUsage(openid, requestId, "image");
    const claim = billing.untracked
      ? { claimed: true, operation: null, completed: false }
      : await claimGenerationOperation(openid, requestId, "image");
    if (claim.completed && claim.operation && claim.operation.result) {
      return jsonResponse(true, Object.assign({}, claim.operation.result, {
        deduplicated: true,
        billing
      }));
    }
    if (!claim.claimed) {
      throw operationStateError(claim.operation);
    }
    claimed = true;
    let response;
    const url = imageConfig.endpoint || endpoint(imageConfig.baseUrl, "images/generations");
    const body = {
      model,
      prompt,
      size,
      n: 1
    };
    response = await requestJson(url, body, apiKey, {
      "Idempotency-Key": requestId
    }, {
      requestId,
      action: "generate",
      provider: imageConfig.provider || "",
      model,
      imageGeneration: true,
      allowRetry: imageConfig.retryEnabled,
      maxAttempts: imageConfig.retryEnabled ? imageConfig.maxRetries + 1 : 1,
      timeoutMs: imageConfig.timeoutMs,
      costs,
      userHash: usageUserHash(openid),
      imageResolution: size
    });
    const image = extractImageItem(response);
    if (!image) {
      const error = new Error("图片接口没有返回图片。");
      error.code = "empty-image-result";
      throw error;
    }
    const buffer = image.buffer || await downloadUrl(image.url, {
      requestId,
      action: "generate-result"
    });
    const extension = imageExtension(image.mime);
    const fileID = await cloud.uploadFile({
      cloudPath: `results/${openid}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`,
      fileContent: buffer
    });
    const tempResult = await cloud.getTempFileURL({ fileList: [fileID.fileID] });
    const tempFileURL = tempResult.fileList && tempResult.fileList[0] && tempResult.fileList[0].tempFileURL;
    const createdAt = new Date();
    const recordData = {
      openid,
      projectName: payload.projectName || "未命名项目",
      prompt: String(payload.prompt),
      negativePrompt: String(payload.negativePrompt || ""),
      fileID: fileID.fileID,
      tempFileURL: tempFileURL || "",
      model,
      createdAt,
      size,
      imageMode: mode,
      requestId,
      quotaUsed: billing.quota.freeUsed,
      dailyLimit: billing.quota.freeLimit,
      billingSource: billing.source,
      pointsCharged: billing.pointsCharged,
      generationType: "normal",
      revisionNumber: 0,
      repairContext: {
        sourceFileID: fileID.fileID,
        originalMainFileID: String(payload.mainFileID || ""),
        mainInputFileID: String(payload.mainFileID || ""),
        maskFileID: String(payload.maskFileID || ""),
        maskGeometry: payload.maskGeometry && typeof payload.maskGeometry === "object"
          ? payload.maskGeometry
          : {},
        assetRegistrationVersion: Number(payload.assetRegistrationVersion) || 0,
        faceFileIDs: Array.isArray(payload.faceFileIDs)
          ? payload.faceFileIDs.filter(Boolean).slice(0, 6)
          : [],
        wardrobeFileIDs: Array.isArray(payload.wardrobeFileIDs)
          ? payload.wardrobeFileIDs.filter(Boolean).slice(0, 12)
          : []
      }
    };
    const saved = await db.collection("generation_records").add({ data: recordData });
    resultPersisted = true;
    if (Number(payload.assetRegistrationVersion) >= 1) {
      try {
        await db.runTransaction(async (transaction) => {
          await retainUserAssets(openid, [payload.mainFileID], "main", transaction);
          await retainUserAssets(openid, [payload.maskFileID], "mask", transaction);
          await retainUserAssets(openid, payload.faceFileIDs, "face", transaction);
          await retainUserAssets(openid, payload.wardrobeFileIDs, "wardrobe", transaction);
        }, 5);
      } catch (error) {
        log("warn", "generation.asset_retain_failed", {
          requestId,
          recordId: saved._id,
          message: error && error.message
        });
      }
    }
    const result = {
      recordId: saved._id,
      fileID: fileID.fileID,
      tempFileURL: tempFileURL || "",
      createdAt: createdAt.toISOString(),
      record: Object.assign({}, recordData, {
        id: saved._id,
        createdAt: createdAt.toISOString()
      }),
      quota: billing.quota,
      billing
    };
    if (!billing.untracked) {
      await completeGenerationOperation(openid, requestId, result);
    }
    return jsonResponse(true, result);
  } catch (error) {
    if (claimed) {
      if (!billing || !billing.untracked) {
        if (!resultPersisted) {
          await failGenerationOperation(openid, requestId, error);
          await refundUsage(openid, requestId, "生图失败，已退回本次使用额度");
        }
      }
    }
    throw error;
  }
}

async function repairImage(event, context) {
  const payload = event.payload || {};
  const openid = getOpenId(context);
  if (payload.generationType !== "repair" || payload.mode !== "edits") {
    return fail("局部修正请求必须使用 generationType=repair 和 mode=edits。", "invalid-repair-request");
  }
  const repairPrompt = String(payload.prompt || "").trim();
  if (!repairPrompt) return fail("修正指令不能为空。", "empty-repair-prompt");
  const parentRecordId = String(payload.parentRecordId || "").trim();
  const sourceFileID = String(payload.sourceFileID || "").trim();
  const mainFileID = String(payload.mainFileID || sourceFileID).trim();
  const maskFileID = String(payload.maskFileID || "").trim();
  if (!parentRecordId || !sourceFileID || !mainFileID || !maskFileID) {
    return fail("局部修正需要父记录、当前结果图和重新确认的 mask。", "missing-edit-asset");
  }
  const configs = await resolveEffectiveConfigs();
  const imageConfig = Object.assign({}, configs.image, {
    mode: "edits",
    endpoint: env("AI_IMAGE_EDIT_ENDPOINT") || configs.image.endpoint
  });
  const costs = configs.costs;
  if (!imageConfig.apiKey) {
    return fail(
      "云函数还没有配置 AI_IMAGE_API_KEY（兼容旧配置 AI_API_KEY）。",
      "missing-api-key"
    );
  }

  const requestId = event.requestId;
  const existingRecord = await findGenerationRecord(openid, requestId);
  if (existingRecord) {
    return jsonResponse(true, {
      recordId: existingRecord._id || existingRecord.id,
      fileID: existingRecord.fileID || "",
      tempFileURL: existingRecord.tempFileURL || "",
      createdAt: existingRecord.createdAt instanceof Date
        ? existingRecord.createdAt.toISOString()
        : String(existingRecord.createdAt || ""),
      record: Object.assign({}, existingRecord, {
        id: existingRecord._id || existingRecord.id
      }),
      deduplicated: true
    });
  }

  const parentRecord = await readGenerationRecord(parentRecordId);
  if (!parentRecord || parentRecord.openid !== openid) {
    return fail("找不到可修正的父记录。", "parent-record-not-found");
  }
  if (parentRecord.isTombstone || !parentRecord.fileID) {
    return fail("父记录的结果图已被删除，无法继续修正。", "parent-result-deleted");
  }
  if (String(parentRecord.fileID) !== sourceFileID) {
    const error = revisionConflictError("当前结果不是这条修正链的最新结果，请刷新后重试。");
    return fail(error.message, error.code);
  }
  const rootRecordId = String(parentRecord.rootRecordId || parentRecordId);
  const rootRecord = rootRecordId === parentRecordId
    ? parentRecord
    : await readGenerationRecord(rootRecordId);
  const rootRepairContext = rootRecord && rootRecord.repairContext || {};
  const originalMainFileID = String(
    rootRepairContext.originalMainFileID
      || rootRepairContext.mainInputFileID
      || payload.originalMainFileID
      || mainFileID
  ).trim();
  if (mainFileID !== sourceFileID) {
    await findUserAsset(openid, mainFileID, "main");
  }
  if (originalMainFileID) {
    await findUserAsset(openid, originalMainFileID, "main");
  }

  const faceFileIDs = Array.from(new Set(
    (Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs : [])
      .filter(Boolean)
      .slice(0, 6)
  ));
  const wardrobeFileIDs = Array.from(new Set(
    (Array.isArray(payload.wardrobeFileIDs) ? payload.wardrobeFileIDs : [])
      .filter(Boolean)
      .slice(0, 12)
  ));
  await findUserAsset(openid, maskFileID, "mask");
  for (const fileID of faceFileIDs) await findUserAsset(openid, fileID, "face");
  for (const fileID of wardrobeFileIDs) await findUserAsset(openid, fileID, "wardrobe");

  let billing = null;
  let claimed = false;
  let chainSlot = null;
  let resultPersisted = false;
  try {
    billing = await reserveUsage(openid, requestId, "image");
    const claim = billing.untracked
      ? { claimed: true, operation: null, completed: false }
      : await claimGenerationOperation(openid, requestId, "image");
    if (claim.completed && claim.operation && claim.operation.result) {
      return jsonResponse(true, Object.assign({}, claim.operation.result, {
        deduplicated: true,
        billing
      }));
    }
    if (!claim.claimed) throw operationStateError(claim.operation);
    claimed = true;
    chainSlot = await claimRepairChain(openid, parentRecord, requestId);

    const negativePrompt = String(
      payload.negativePrompt || parentRecord.negativePrompt || ""
    ).trim();
    const actualPrompt = `${repairPrompt}${
      negativePrompt ? `\n\n负面约束：${negativePrompt}` : ""
    }`;
    log("info", "repair.start", {
      requestId,
      parentRecordId,
      revisionNumber: chainSlot.revisionNumber,
      faceRefs: faceFileIDs.length,
      wardrobeRefs: wardrobeFileIDs.length
    });
    const response = await requestImageEdits(
      {
        mainFileID,
        identityFileID: originalMainFileID,
        maskFileID,
        faceFileIDs,
        wardrobeFileIDs,
        prompt: actualPrompt,
        size: imageConfig.size || payload.size,
        __action: "repairImage"
      },
      imageConfig.apiKey,
      requestId,
      imageConfig,
      costs,
      usageUserHash(openid)
    );
    const image = extractImageItem(response);
    if (!image) {
      const error = new Error("图片编辑接口没有返回修正版图片。");
      error.code = "empty-repair-result";
      throw error;
    }
    const buffer = image.buffer || await downloadUrl(image.url, {
      requestId,
      action: "repair-result"
    });
    const extension = imageExtension(image.mime);
    const uploaded = await cloud.uploadFile({
      cloudPath: `results/${openid}/repair-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`,
      fileContent: buffer
    });
    const tempResult = await cloud.getTempFileURL({ fileList: [uploaded.fileID] });
    const tempFileURL = tempResult.fileList
      && tempResult.fileList[0]
      && tempResult.fileList[0].tempFileURL;
    const createdAt = new Date();
    const recordId = repairRecordId(openid, requestId);
    const recordData = {
      _id: recordId,
      openid,
      projectName: parentRecord.projectName || "未命名项目",
      prompt: actualPrompt,
      repairPrompt,
      negativePrompt,
      fileID: uploaded.fileID,
      tempFileURL: tempFileURL || "",
      model: imageConfig.model,
      createdAt,
      size: imageConfig.size || payload.size || "1024x1024",
      imageMode: "edits",
      generationType: "repair",
      parentRecordId,
      rootRecordId: chainSlot.rootRecordId,
      revisionNumber: chainSlot.revisionNumber,
      repairIssues: Array.isArray(payload.repairIssues)
        ? payload.repairIssues.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 30)
        : [],
      repairContext: {
        sourceFileID: uploaded.fileID,
        originalMainFileID,
        mainInputFileID: mainFileID,
        maskFileID,
        maskGeometry: payload.maskGeometry && typeof payload.maskGeometry === "object"
          ? payload.maskGeometry
          : {},
        assetRegistrationVersion: 1,
        faceFileIDs,
        wardrobeFileIDs
      },
      requestId,
      quotaUsed: billing.quota.freeUsed,
      dailyLimit: billing.quota.freeLimit,
      billingSource: billing.source,
      pointsCharged: billing.pointsCharged
    };

    await db.runTransaction(async (transaction) => {
      const chainRef = transaction.collection(REPAIR_CHAIN_COLLECTION).doc(chainSlot.chainId);
      const chain = await readDocument(chainRef);
      if (!chain || chain.pendingRequestId !== requestId) {
        throw revisionConflictError("修正链状态已变化，请刷新后从最新结果继续。");
      }
      const currentParent = await readGenerationRecord(parentRecordId, transaction);
      if (!currentParent || currentParent.fileID !== sourceFileID) {
        throw revisionConflictError();
      }
      await transaction.collection("generation_records").doc(recordId).set({
        data: recordData
      });
      await transaction.collection("generation_records").doc(parentRecordId).update({
        data: {
          hasChildren: true,
          updatedAt: new Date()
        }
      });
      await chainRef.set({
        data: Object.assign({}, chain, {
          tailRecordId: recordId,
          tailRevision: chainSlot.revisionNumber,
          pendingRequestId: "",
          pendingParentId: "",
          pendingRevision: 0,
          updatedAt: new Date()
        })
      });
      const referenced = Array.from(new Set(
        [maskFileID]
          .concat(mainFileID !== sourceFileID ? [mainFileID] : [])
          .concat(originalMainFileID ? [originalMainFileID] : [])
          .concat(faceFileIDs, wardrobeFileIDs)
          .filter(Boolean)
      ));
      for (const fileID of referenced) {
        const asset = await findUserAsset(
          openid,
          fileID,
          fileID === maskFileID
            ? "mask"
            : fileID === mainFileID && mainFileID !== sourceFileID
              ? "main"
              : fileID === originalMainFileID
                ? "main"
              : faceFileIDs.includes(fileID)
                ? "face"
                : "wardrobe",
          transaction
        );
        await transaction.collection(USER_ASSET_COLLECTION).doc(asset._id).update({
          data: {
            refCount: Math.max(0, Number(asset.refCount) || 0) + 1,
            updatedAt: new Date()
          }
        });
      }
    }, 5);
    resultPersisted = true;
    const result = {
      recordId,
      fileID: uploaded.fileID,
      tempFileURL: tempFileURL || "",
      createdAt: createdAt.toISOString(),
      record: Object.assign({}, recordData, {
        id: recordId,
        createdAt: createdAt.toISOString()
      }),
      quota: billing.quota,
      billing
    };
    if (!billing.untracked) await completeGenerationOperation(openid, requestId, result);
    return jsonResponse(true, result);
  } catch (error) {
    if (chainSlot && !resultPersisted) await releaseRepairChain(chainSlot);
    if (claimed && billing && !billing.untracked && !resultPersisted) {
      await failGenerationOperation(openid, requestId, error);
      await refundUsage(openid, requestId, "局部修正失败，已退回本次使用额度");
    }
    throw error;
  }
}

async function listRecords(context) {
  const openid = getOpenId(context);
  const result = await db.collection("generation_records")
    .where({ openid })
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  const records = result.data || [];
  const ids = records.map((item) => item.fileID).filter(Boolean);
  let urls = {};
  if (ids.length) {
    const temp = await cloud.getTempFileURL({ fileList: ids });
    (temp.fileList || []).forEach((item) => {
      urls[item.fileID] = item.tempFileURL || "";
    });
  }
  return jsonResponse(true, {
    records: records.map((item) => Object.assign({}, item, {
      id: item._id,
      createdAt: item.createdAt instanceof Date ? item.createdAt.toISOString() : item.createdAt,
      tempFileURL: urls[item.fileID] || item.tempFileURL || ""
    }))
  });
}

async function deleteRecord(event, context) {
  const openid = getOpenId(context);
  const recordId = String(event.recordId || "");
  if (!recordId) return fail("缺少记录 ID。", "missing-record-id");
  const record = await db.collection("generation_records").doc(recordId).get();
  if (!record.data || record.data.openid !== openid) return fail("无权删除这条记录。", "forbidden");
  if (record.data.fileID) {
    try {
      await cloud.deleteFile({ fileList: [record.data.fileID] });
    } catch (_) {
      // 文件已经不存在时，仍然允许清理数据库记录。
    }
  }
  const repairContext = record.data.repairContext || {};
  const assetReferences = [
    { fileID: repairContext.mainInputFileID, kind: "main" },
    {
      fileID: repairContext.originalMainFileID
        && repairContext.originalMainFileID !== repairContext.mainInputFileID
        ? repairContext.originalMainFileID
        : "",
      kind: "main"
    },
    { fileID: repairContext.maskFileID, kind: "mask" },
    ...(Array.isArray(repairContext.faceFileIDs)
      ? repairContext.faceFileIDs.map((fileID) => ({ fileID, kind: "face" }))
      : []),
    ...(Array.isArray(repairContext.wardrobeFileIDs)
      ? repairContext.wardrobeFileIDs.map((fileID) => ({ fileID, kind: "wardrobe" }))
      : [])
  ];
  const children = await db.collection("generation_records")
    .where({ openid, parentRecordId: recordId })
    .limit(1)
    .get();
  if (children && Array.isArray(children.data) && children.data.length) {
    await db.collection("generation_records").doc(recordId).update({
      data: {
        fileID: "",
        tempFileURL: "",
        isTombstone: true,
        deletedAt: new Date(),
        updatedAt: new Date()
      }
    });
    try {
      await db.runTransaction(
        (transaction) => releaseUserAssets(openid, assetReferences, transaction),
        5
      );
    } catch (error) {
      log("warn", "records.asset_release_failed", {
        recordId,
        message: error && error.message
      });
    }
    return jsonResponse(true, { recordId, tombstone: true });
  }
  await db.collection("generation_records").doc(recordId).remove();
  try {
    await db.runTransaction(
      (transaction) => releaseUserAssets(openid, assetReferences, transaction),
      5
    );
  } catch (error) {
    log("warn", "records.asset_release_failed", {
      recordId,
      message: error && error.message
    });
  }
  return jsonResponse(true, { recordId, removed: true });
}

function replaceVideoTaskId(path, taskId) {
  return String(path || "")
    .replace(/\{taskId\}/g, encodeURIComponent(String(taskId || "")))
    .replace(/\{requestId\}/g, encodeURIComponent(String(taskId || "")));
}

function videoCreateUrl(video) {
  return video.endpoint || endpoint(video.baseUrl, video.createPath);
}

function videoQueryUrl(video, taskId) {
  const path = replaceVideoTaskId(video.queryPath, taskId);
  return video.queryEndpoint || endpoint(video.baseUrl, path);
}

function buildVideoGenerationPayload(payload = {}, imageBuffer, video = resolveVideoConfig()) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    const error = new Error("视频任务的源图片为空。");
    error.code = "VIDEO_SOURCE_IMAGE_EMPTY";
    error.retryable = false;
    throw error;
  }
  const prompt = String(payload.prompt || video.prompt || "").trim();
  if (!prompt) {
    const error = new Error("视频提示词不能为空。");
    error.code = "VIDEO_PROMPT_EMPTY";
    error.retryable = false;
    throw error;
  }
  const result = {
    model: String(video.model || payload.model),
    prompt,
    image: toDataUrl(imageBuffer, detectMime(imageBuffer))
  };
  const duration = Number(payload.durationSeconds || payload.duration);
  if (Number.isFinite(duration) && duration > 0) {
    result.duration = duration;
  }
  const resolution = String(video.resolution || payload.resolution || "").trim();
  if (resolution) result.resolution = resolution;
  const aspectRatio = String(video.aspectRatio || payload.aspectRatio || "").trim();
  if (aspectRatio) result.aspect_ratio = aspectRatio;
  return result;
}

function firstVideoValue(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeVideoCreateResponse(payload = {}) {
  const data = payload && payload.data;
  const output = payload && payload.output;
  const taskId = firstVideoValue([
    payload.request_id,
    payload.requestId,
    payload.task_id,
    payload.taskId,
    payload.id,
    data && data.request_id,
    data && data.requestId,
    data && data.task_id,
    data && data.taskId,
    data && data.id,
    output && output.request_id,
    output && output.requestId,
    output && output.task_id,
    output && output.taskId,
    output && output.id
  ]);
  if (!taskId) {
    const error = new Error("视频创建接口没有返回任务编号。");
    error.code = "VIDEO_CREATE_RESPONSE_INVALID";
    error.retryable = false;
    throw error;
  }
  const rawStatus = String(firstVideoValue([
    payload.status,
    payload.state,
    data && data.status,
    data && data.state,
    output && output.status,
    output && output.state,
    "queued"
  ]) || "queued").toLowerCase();
  return {
    taskId: String(taskId),
    status: rawStatus === "done" ? "succeeded" : "processing",
    providerStatus: rawStatus
  };
}

function extractVideoUrl(payload = {}) {
  const data = payload && payload.data;
  const output = payload && payload.output;
  const video = payload && payload.video;
  const dataVideo = data && data.video;
  const outputVideo = output && output.video;
  const value = firstVideoValue([
    typeof video === "string" ? video : "",
    video && video.url,
    payload.video_url,
    payload.videoURL,
    payload.url,
    dataVideo && (typeof dataVideo === "string" ? dataVideo : dataVideo.url),
    data && data.video_url,
    data && data.videoURL,
    data && data.url,
    outputVideo && (typeof outputVideo === "string" ? outputVideo : outputVideo.url),
    output && output.video_url,
    output && output.videoURL,
    output && output.url
  ]);
  return value ? String(value) : "";
}

function normalizeVideoQueryResponse(payload = {}) {
  const data = payload && payload.data;
  const output = payload && payload.output;
  const rawStatus = String(firstVideoValue([
    payload.status,
    payload.state,
    data && data.status,
    data && data.state,
    output && output.status,
    output && output.state,
    "processing"
  ]) || "processing").toLowerCase();
  const status = ["done", "succeeded", "success", "completed", "complete"].includes(rawStatus)
    ? "succeeded"
    : ["failed", "error", "cancelled", "canceled"].includes(rawStatus)
      ? rawStatus === "cancelled" || rawStatus === "canceled" ? "cancelled" : "failed"
      : "processing";
  const errorValue = firstVideoValue([
    payload.error && (payload.error.message || payload.error.code),
    typeof payload.error === "string" ? payload.error : "",
    payload.message,
    data && data.error && (data.error.message || data.error.code),
    output && output.error && (output.error.message || output.error.code)
  ]);
  return {
    status,
    providerStatus: rawStatus,
    videoURL: extractVideoUrl(payload),
    error: errorValue ? String(errorValue) : ""
  };
}

function videoRequestMeta(requestId, action, video, allowRetry, options = {}) {
  return {
    requestId,
    action,
    provider: video.provider || "",
    model: video.model || "",
    allowRetry,
    maxAttempts: allowRetry ? Math.max(2, maxRetries() + 1) : 1,
    retryStatuses: [408, 425, 429, 500, 502, 503, 504],
    timeoutMs: video.timeoutMs,
    costs: options.costs,
    userHash: options.userHash,
    videoResolution: options.videoResolution,
    videoDurationSeconds: options.videoDurationSeconds
  };
}

async function videoProviderStatus() {
  const configs = await resolveEffectiveConfigs();
  const video = configs.video;
  if (!video.configured) {
    return jsonResponse(true, {
      configured: false,
      ready: false,
      provider: video.provider || "",
      model: video.model,
      resolution: video.resolution,
      message: "视频服务尚未配置，当前只能浏览页面和选择照片。"
    });
  }
  return jsonResponse(true, {
    configured: true,
    ready: true,
    provider: video.provider,
    model: video.model,
    resolution: video.resolution,
    message: `视频服务已连接，默认${video.resolution}，可以开始生成动态视频。`
  });
}

async function createVideoTask(event, context) {
  const configs = await resolveEffectiveConfigs();
  const video = configs.video;
  if (!video.configured) {
    return fail(
      "视频服务未配置，请联系管理员配置 AI_VIDEO_PROVIDER、AI_VIDEO_BASE_URL、AI_VIDEO_MODEL 和 AI_VIDEO_API_KEY。",
      "VIDEO_PROVIDER_NOT_CONFIGURED"
    );
  }
  const payload = event.payload || {};
  if (!payload.imageFileID) {
    return fail("缺少视频源图片，请重新选择照片。", "VIDEO_SOURCE_IMAGE_MISSING");
  }
  const requestId = event.requestId;
  const openid = getOpenId(context);
  let billing = null;
  let claimed = false;
  let providerAccepted = false;
  try {
    const imageBuffer = await downloadCloudFile(payload.imageFileID, {
      requestId,
      action: "video.create",
      fileType: "video-source"
    });
    const requestPayload = buildVideoGenerationPayload(payload, Buffer.from(imageBuffer), video);
    billing = await reserveUsage(openid, requestId, "video");
    const claim = billing.untracked
      ? { claimed: true, operation: null, completed: false }
      : await claimGenerationOperation(openid, requestId, "video");
    if (claim.completed && claim.operation && claim.operation.result) {
      return jsonResponse(true, Object.assign({}, claim.operation.result, {
        deduplicated: true,
        billing
      }));
    }
    if (!claim.claimed) {
      if (claim.operation && claim.operation.providerTaskId) {
        return jsonResponse(true, Object.assign({}, claim.operation.result || {
          taskId: claim.operation.providerTaskId,
          status: "processing",
          providerStatus: "processing"
        }, {
          requestId,
          provider: video.provider,
          deduplicated: true,
          billing
        }));
      }
      throw operationStateError(claim.operation);
    }
    claimed = true;
    log("info", "video.create.start", {
      requestId,
      provider: video.provider,
      model: requestPayload.model,
      resolution: requestPayload.resolution || "",
      duration: requestPayload.duration || null,
      imageBytes: Buffer.from(imageBuffer).length,
      prompt: requestPayload.prompt,
      billingSource: billing.source,
      pointsCharged: billing.pointsCharged
    });
    const response = await requestJsonMethod(
      videoCreateUrl(video),
      requestPayload,
      video.apiKey,
      "POST",
      { "Idempotency-Key": requestId },
      videoRequestMeta(requestId, "video.create", video, false, {
        costs: configs.costs,
        userHash: usageUserHash(openid),
        videoResolution: requestPayload.resolution,
        videoDurationSeconds: requestPayload.duration
      })
    );
    const normalized = normalizeVideoCreateResponse(response);
    providerAccepted = true;
    log("info", "video.create.finish", {
      requestId,
      provider: video.provider,
      taskId: normalized.taskId,
      providerStatus: normalized.providerStatus,
      durationMs: null
    });
    const result = Object.assign({}, normalized, {
      requestId,
      provider: video.provider,
      model: requestPayload.model,
      resolution: requestPayload.resolution || "",
      billing
    });
    if (!billing.untracked) {
      await updateGenerationOperation(openid, requestId, {
        status: normalized.status === "succeeded" ? "succeeded" : "processing",
        providerTaskId: normalized.taskId,
        providerStatus: normalized.providerStatus,
        result: Object.assign({}, result, { billing: null }),
        providerCreatedAt: new Date()
      }, {
        allowedStatuses: ["processing"]
      });
    }
    return jsonResponse(true, result);
  } catch (error) {
    if (claimed && billing && !billing.untracked && !providerAccepted) {
      await failGenerationOperation(openid, requestId, error);
      await refundUsage(openid, requestId, "视频任务创建失败，已退回本次使用额度");
    }
    throw error;
  }
}

async function queryVideoTask(event, context) {
  const configs = await resolveEffectiveConfigs();
  const video = configs.video;
  if (!video.configured) {
    return fail(
      "视频服务未配置，无法查询动态视频任务。",
      "VIDEO_PROVIDER_NOT_CONFIGURED"
    );
  }
  const openid = getOpenId(context);
  const taskId = String(event.taskId || "").trim();
  if (!taskId) {
    return fail("缺少视频任务编号。", "VIDEO_TASK_ID_MISSING");
  }
  const requestId = String(event.requestId || "").trim();
  const operation = openid !== "anonymous" && requestId
    ? await findGenerationOperation(openid, requestId)
    : null;
  if (operation) {
    if (["refunding", "refunded"].includes(String(operation.status || ""))) {
      throw operationStateError(operation);
    }
    if (operation.providerTaskId && String(operation.providerTaskId) !== taskId) {
      return fail("视频任务编号与原请求不匹配。", "VIDEO_TASK_OWNERSHIP_MISMATCH");
    }
  } else if (openid !== "anonymous" && requestId) {
    return fail("找不到这次视频生成请求。", "VIDEO_OPERATION_NOT_FOUND");
  }
  const response = await requestJsonMethod(
    videoQueryUrl(video, taskId),
    null,
    video.apiKey,
    "GET",
    {},
    videoRequestMeta(requestId, "video.query", video, true)
  );
  const normalized = normalizeVideoQueryResponse(response);
  if (
    ["failed", "cancelled"].includes(normalized.status)
    && openid !== "anonymous"
  ) {
    if (operation) {
      await updateGenerationOperation(openid, requestId, {
        status: "failed",
        providerStatus: normalized.providerStatus,
        result: normalized,
        failedAt: new Date(),
        lastError: normalized.error || "视频任务失败"
      }, {
        allowedStatuses: ["processing", "failed"]
      });
      await refundUsage(openid, requestId, "视频任务失败，已退回本次使用额度");
    }
  }
  if (normalized.status === "succeeded" && operation) {
    await completeGenerationOperation(openid, requestId, Object.assign({}, normalized, {
      taskId,
      requestId,
      provider: video.provider
    }));
  }
  if (normalized.status === "succeeded" && !normalized.videoURL) {
    return fail(
      "视频任务已完成，但服务没有返回视频地址。",
      "VIDEO_RESULT_URL_MISSING",
      {
        taskId,
        provider: video.provider,
        providerStatus: normalized.providerStatus,
        retryable: false
      }
    );
  }
  return jsonResponse(true, Object.assign({}, normalized, {
    requestId,
    taskId,
    provider: video.provider
  }));
}

exports.main = async (event = {}, context) => {
  const requestId = event.requestId
    || (event.payload && event.payload.requestId)
    || createRequestId();
  const requestEvent = Object.assign({}, event, { requestId });
  const action = requestEvent.action;
  const functionStartedAt = Date.now();
  log("info", "function.start", {
    requestId,
    action
  });
  try {
    let result;
    if (isPhotoToVideoCleanupTrigger(requestEvent)) {
      result = await cleanupPhotoToVideoTempAssets(new Date());
    } else if (action === "analyze") result = await analyze(requestEvent, context);
    else if (action === "detectFaceCircle") result = await detectFaceCircle(requestEvent, context);
    else if (action === "probeAutoFace") result = await probeAutoFace(requestEvent, context);
    else if (action === "getAutoFaceProbeHistory") {
      result = await getAutoFaceProbeHistory(requestEvent, context);
    }
    else if (action === "analyzeWebPoses") result = await analyzeWebPoses(requestEvent, context);
    else if (action === "prepareAssetUpload") result = await prepareAssetUpload(requestEvent, context);
    else if (action === "registerAsset") result = await registerAsset(requestEvent, context);
    else if (action === "generate") result = await generate(requestEvent, context);
    else if (action === "repairImage") result = await repairImage(requestEvent, context);
    else if (action === "getUserPoints") result = await getUserPoints(context);
    else if (action === "checkIn") result = await checkIn(context);
    else if (action === "getPointLedger") result = await getPointLedger(context);
    else if (action === "listRecords") result = await listRecords(context);
    else if (action === "deleteRecord") result = await deleteRecord(requestEvent, context);
    else if (action === "videoProviderStatus") result = await videoProviderStatus();
    else if (action === "createVideoTask") result = await createVideoTask(requestEvent, context);
    else if (action === "queryVideoTask") result = await queryVideoTask(requestEvent, context);
    else if (action === "getAdminStatus") result = await getAdminStatus(context);
    else if (action === "getAdminConfig") result = await getAdminConfig(context);
    else if (action === "saveAdminConfig") result = await saveAdminConfig(requestEvent, context);
    else if (action === "checkDeployment") result = await checkDeployment(requestEvent, context);
    else if (action === "listDeploymentLogs") result = await listDeploymentLogs(context);
    else if (action === "getModelUsageStats") result = await getModelUsageStats(requestEvent, context);
    else if (action === "exportModelUsageStats") result = await exportModelUsageStats(requestEvent, context);
    else if (action === "reportAutoFaceFailure") result = await reportAutoFaceFailure(requestEvent);
    else if (action === "getAutoFaceFailureStats") result = await getAutoFaceFailureStats(requestEvent, context);
    else if (action === "registerPhotoToVideoTempAsset") {
      result = await registerPhotoToVideoTempAsset(requestEvent, context);
    }
    else result = fail(`不支持的操作：${action || "空"}`, "unsupported-action");
    log("info", "function.finish", {
      requestId,
      action,
      ok: result && result.ok !== false,
      durationMs: Date.now() - functionStartedAt
    });
    return Object.assign({ requestId }, result || {});
  } catch (error) {
    const status = Number(error && error.status) || null;
    const message = error && error.message ? error.message : String(error);
    let errorCode = error && error.code ? error.code : "server-error";
    if (errorCode !== "retry-exhausted") {
      if (status === 401 || status === 403) errorCode = "authentication-failed";
      else if (status === 429) errorCode = "rate-limited";
      else if (status >= 500) errorCode = "upstream-unavailable";
      else if (/超时|timeout/i.test(message)) errorCode = "timeout";
      else if (/额度|次数已用完|quota/i.test(message)) errorCode = "quota-exceeded";
    }
    if (action === "probeAutoFace" && isAdminContext(context)) {
      await writeAutoFaceProbeHistory({
        status: "failed",
        requestId,
        errorCode,
        durationMs: Date.now() - functionStartedAt,
        checkedAt: new Date()
      });
    }
    log("error", "function.error", {
      requestId,
      action,
      durationMs: Date.now() - functionStartedAt,
      status,
      errorCode,
      message,
      attempts: error && error.attempts
    });
    return fail(message, errorCode, {
      requestId,
      status,
      retryable: ["timeout", "rate-limited", "upstream-unavailable", "retry-exhausted"].includes(errorCode)
    });
  }
};

if (process.env.WECHAT_MINIAPP_TEST === "1") {
  exports.__test = {
    requestWithRetry,
    requestImageEdits,
    buildRepairRecordId: repairRecordId,
    buildRepairChainId: repairChainId,
    normalizeAssetKind,
    assetPathMatches,
    extractImageItem,
    detectMime,
    invertMask,
    resolveVisionConfig,
    resolveImageConfig,
    resolveEffectiveConfigs,
    assertVisionImageSize,
    normalizeFaceDetections,
    normalizeWebPoseSuggestions,
    resolveVideoConfig,
    resolvePointsConfig,
    resolveCostConfig,
    normalizeImageResolution,
    normalizeVideoResolution,
    extractModelUsage,
    extractVideoDuration,
    buildUsageBilling,
    normalizeAutoFaceFailureType,
    sanitizeAutoFaceFailureMessage,
    normalizeAutoFaceFailureReport,
    formatAutoFaceFailureType,
    autoFaceFailureDisplayEvent,
    buildAutoFaceFailureStats,
    normalizeAutoFaceProbeReport,
    normalizeAutoFaceProbeHistoryReport,
    autoFaceProbeHistoryDisplayEvent,
    autoFaceProbeHistoryCutoff,
    cleanupAutoFaceProbeHistory,
    writeAutoFaceProbeHistory,
    getAutoFaceProbeHistory,
    autoFaceFailureCleanupCutoff,
    shouldRunAutoFaceFailureCleanup,
    normalizePhotoToVideoTempKind,
    photoToVideoTempAssetDocumentId,
    photoToVideoTempCleanupCutoff,
    isPhotoToVideoCleanupTrigger,
    registerPhotoToVideoTempAsset,
    cleanupPhotoToVideoTempAssets,
    dateKeyForTimeZone,
    shiftDateKey,
    shiftMonthKey,
    modelUsageTypeForAction,
    normalizeModelUsageEvent,
    aggregateModelUsageEvents,
    buildModelUsageExportWorkbook,
    recordModelUsageEvent,
    getModelUsageTestEvents: () => modelUsageTestEvents.slice(),
    resetModelUsageTestEvents: () => {
      modelUsageTestEvents.splice(0, modelUsageTestEvents.length);
    },
    getAutoFaceFailureTestEvents: () => autoFaceFailureTestEvents.slice(),
    resetAutoFaceFailureTestEvents: () => {
      autoFaceFailureTestEvents.splice(0, autoFaceFailureTestEvents.length);
    },
    getAutoFaceProbeTestEvents: () => autoFaceProbeTestEvents.slice(),
    resetAutoFaceProbeTestEvents: () => {
      autoFaceProbeTestEvents.splice(0, autoFaceProbeTestEvents.length);
    },
    isPromoDate,
    calculateNextStreak,
    videoProviderStatus,
    buildVideoGenerationPayload,
    normalizeVideoCreateResponse,
    normalizeVideoQueryResponse,
    videoCreateUrl,
    videoQueryUrl,
    buildAutoFaceProbe
    ,
    adminOpenIds,
    isAdminContext,
    normalizeRuntimePatch,
    validateRuntimePatch,
    mergeRuntimeConfig,
    getAdminStatus,
    getAdminConfig,
    saveAdminConfig,
    checkDeployment,
    listDeploymentLogs
    ,
    exportModelUsageStats,
    pointsSummary,
    reserveUsage,
    refundUsage,
    claimGenerationOperation,
    completeGenerationOperation,
    failGenerationOperation,
    checkIn,
    getTestDatabase: () => db,
    getAdminRuntimeCache: () => adminRuntimeCache
  };
}
