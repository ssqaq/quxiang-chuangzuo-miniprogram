const API_BUILD_VERSION = "0.16.0";
const API_BUILD_MARKER = "API_BUILD_TAG_20260823_64";
console.log(`[api] build=${API_BUILD_VERSION} marker=${API_BUILD_MARKER}`);

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { PNG } = require("pngjs");

// CloudBase 某些部署实例会丢失自定义相对模块，入口必须可以单文件启动。
const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const ADMIN_RUNTIME_CONFIG_COLLECTION = "admin_runtime_config";
const ADMIN_RUNTIME_CONFIG_ID = "global";
const ADMIN_DEPLOYMENT_LOG_COLLECTION = "admin_deployment_logs";
const ADMIN_RUNTIME_CACHE_TTL_MS = 15000;
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

function visionRequestMeta(requestId, action, vision) {
  return {
    requestId,
    action,
    allowRetry: true,
    maxAttempts: 2,
    retryStatuses: [429, 500, 502, 503, 504],
    timeoutMs: vision.timeoutMs
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
      const retryable = retryStatuses
        ? retryStatuses.has(Number(response.status))
        : shouldRetryStatus(response.status);
      log("info", "upstream.response", {
        requestId: meta.requestId,
        action: meta.action,
        attempt,
        status: response.status,
        durationMs: Date.now() - startedAt,
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
      const retryable = error && error.retryable !== undefined
        ? Boolean(error.retryable)
        : true;
      log("warn", "upstream.error", {
        requestId: meta.requestId,
        action: meta.action,
        attempt,
        durationMs: Date.now() - startedAt,
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
  const image = {};
  const video = {};
  imageKeys.forEach((key) => {
    if (hasOwn(imageSource, key)) image[key] = imageSource[key];
  });
  videoKeys.forEach((key) => {
    if (hasOwn(videoSource, key)) video[key] = videoSource[key];
  });
  return { image, video };
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
  return errors;
}

function mergeRuntimeConfig(current, patch) {
  const existing = current && typeof current === "object" ? current : {};
  return {
    image: Object.assign({}, existing.image || {}, patch.image || {}),
    video: Object.assign({}, existing.video || {}, patch.video || {})
  };
}

function redactConfig(config, defaults) {
  const image = config.image || {};
  const video = config.video || {};
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
    runtime: runtime || { image: {}, video: {} },
    image: resolveImageConfig(runtime && runtime.image),
    video: resolveVideoConfig(runtime && runtime.video)
  };
}

function adminConfigView(configs, runtime, metadata = {}) {
  const imageDefaults = resolveImageConfig();
  const videoDefaults = resolveVideoConfig();
  const overrides = runtime || { image: {}, video: {} };
  return {
    defaults: redactConfig({
      image: imageDefaults,
      video: videoDefaults
    }, {
      image: imageDefaults,
      video: videoDefaults
    }),
    overrides: redactConfig(overrides, {
      image: imageDefaults,
      video: videoDefaults
    }),
    effective: redactConfig({
      image: configs.image,
      video: configs.video
    }, {
      image: configs.image,
      video: configs.video
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
    version: previousVersion + 1,
    updatedAt: new Date(),
    updatedBy: getOpenId(context)
  };
  await db.collection(ADMIN_RUNTIME_CONFIG_COLLECTION).doc(ADMIN_RUNTIME_CONFIG_ID).set({ data });
  adminRuntimeCache = {
    value: { image: next.image, video: next.video },
    expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
  };
  log("info", "admin.runtime-config.saved", {
    updatedBy: getOpenId(context),
    version: data.version,
    imageFields: Object.keys(patch.image),
    videoFields: Object.keys(patch.video)
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

async function detectFaceCircle(event) {
  const detectionStartedAt = Date.now();
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
      }), vision.apiKey, {}, visionRequestMeta(event.requestId, "detectFaceCircle", vision));
    } catch (error) {
      if (error.status !== 400) throw error;
      response = await requestJson(
        url,
        requestPayload,
        vision.apiKey,
        {},
        visionRequestMeta(event.requestId, "detectFaceCircle", vision)
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

async function requestImageEdits(payload, apiKey, requestId, imageConfig = resolveImageConfig()) {
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
      Authorization: `Bearer ${apiKey}`
    }
  }, multipart.body, {
    requestId,
    action: "generate",
    imageGeneration: true,
    allowRetry: imageConfig.retryEnabled,
    maxAttempts: imageConfig.retryEnabled ? imageConfig.maxRetries + 1 : 1,
    timeoutMs: imageConfig.timeoutMs
  });
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response, "图片编辑接口请求失败");
  }
  return response.json || {};
}

async function consumeQuota(openid) {
  const dailyLimit = Math.max(1, Number(env("DAILY_GENERATION_LIMIT", "5")));
  const dateKey = new Date().toISOString().slice(0, 10);
  const quotaId = crypto.createHash("sha256").update(`${openid}:${dateKey}`).digest("hex").slice(0, 32);
  const ref = db.collection("user_quotas").doc(quotaId);
  let existing = null;
  try {
    const result = await ref.get();
    existing = result && result.data;
  } catch (_) {
    existing = null;
  }
  const used = Number(existing && existing.used) || 0;
  if (used >= dailyLimit) {
    const error = new Error(`今日生成次数已用完（${dailyLimit} 次）。`);
    error.code = "quota-exceeded";
    throw error;
  }
  const data = {
    _id: quotaId,
    openid,
    dateKey,
    used: used + 1,
    dailyLimit,
    updatedAt: new Date()
  };
  await ref.set({ data });
  return { used: used + 1, dailyLimit };
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

async function generate(event, context) {
  const payload = event.payload || {};
  const openid = getOpenId(context);
  if (!payload.prompt || !String(payload.prompt).trim()) return fail("提示词不能为空。", "empty-prompt");
  const configs = await resolveEffectiveConfigs();
  const imageConfig = configs.image;
  const apiKey = imageConfig.apiKey;
  if (!apiKey) return fail(
    "云函数还没有配置 AI_IMAGE_API_KEY（兼容旧配置 AI_API_KEY）。",
    "missing-api-key"
  );

  const mode = imageConfig.mode.trim().toLowerCase();
  if (!["generations", "edits"].includes(mode)) {
    return fail(`不支持的图片模式：${mode}`, "unsupported-image-mode");
  }
  if (mode === "edits" && (!payload.mainFileID || !payload.maskFileID)) {
    return fail("编辑模式需要主图和 mask 文件，请重新圈选后再提交。", "missing-edit-asset");
  }

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
  log("info", "generation.start", {
    requestId,
    action: "generate",
    mode,
    model,
    size,
    faceRefs: Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs.length : 0,
    wardrobeRefs: Array.isArray(payload.wardrobeFileIDs) ? payload.wardrobeFileIDs.length : 0
  });

  const quota = await consumeQuota(openid);
  let response;
  if (mode === "edits") {
    response = await requestImageEdits(
      Object.assign({}, payload, { prompt }),
      apiKey,
      requestId,
      imageConfig
    );
  } else {
    const url = imageConfig.endpoint || endpoint(imageConfig.baseUrl, "images/generations");
    const body = {
      model,
      prompt,
      size,
      n: 1
    };
    response = await requestJson(url, body, apiKey, {}, {
      requestId,
      action: "generate",
      imageGeneration: true,
      allowRetry: imageConfig.retryEnabled,
      maxAttempts: imageConfig.retryEnabled ? imageConfig.maxRetries + 1 : 1,
      timeoutMs: imageConfig.timeoutMs
    });
  }
  const image = extractImageItem(response);
  if (!image) return fail("图片接口没有返回图片。", "empty-image-result");
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
    quotaUsed: quota.used,
    dailyLimit: quota.dailyLimit
  };
  const saved = await db.collection("generation_records").add({ data: recordData });
  return jsonResponse(true, {
    recordId: saved._id,
    fileID: fileID.fileID,
    tempFileURL: tempFileURL || "",
    createdAt: createdAt.toISOString(),
    record: Object.assign({}, recordData, {
      id: saved._id,
      createdAt: createdAt.toISOString()
    }),
    quota
  });
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
  await db.collection("generation_records").doc(recordId).remove();
  return jsonResponse(true, { recordId });
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

function videoRequestMeta(requestId, action, video, allowRetry) {
  return {
    requestId,
    action,
    allowRetry,
    maxAttempts: allowRetry ? Math.max(2, maxRetries() + 1) : 1,
    retryStatuses: [408, 425, 429, 500, 502, 503, 504],
    timeoutMs: video.timeoutMs
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

async function createVideoTask(event) {
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
  const imageBuffer = await downloadCloudFile(payload.imageFileID, {
    requestId,
    action: "video.create",
    fileType: "video-source"
  });
  const requestPayload = buildVideoGenerationPayload(payload, Buffer.from(imageBuffer), video);
  log("info", "video.create.start", {
    requestId,
    provider: video.provider,
    model: requestPayload.model,
    resolution: requestPayload.resolution || "",
    duration: requestPayload.duration || null,
    imageBytes: Buffer.from(imageBuffer).length,
    prompt: requestPayload.prompt
  });
  const response = await requestJsonMethod(
    videoCreateUrl(video),
    requestPayload,
    video.apiKey,
    "POST",
    {},
    videoRequestMeta(requestId, "video.create", video, false)
  );
  const normalized = normalizeVideoCreateResponse(response);
  log("info", "video.create.finish", {
    requestId,
    provider: video.provider,
    taskId: normalized.taskId,
    providerStatus: normalized.providerStatus,
    durationMs: null
  });
  return jsonResponse(true, Object.assign({}, normalized, {
    requestId,
    provider: video.provider,
    model: requestPayload.model,
    resolution: requestPayload.resolution || ""
  }));
}

async function queryVideoTask(event) {
  const configs = await resolveEffectiveConfigs();
  const video = configs.video;
  if (!video.configured) {
    return fail(
      "视频服务未配置，无法查询动态视频任务。",
      "VIDEO_PROVIDER_NOT_CONFIGURED"
    );
  }
  const taskId = String(event.taskId || "").trim();
  if (!taskId) {
    return fail("缺少视频任务编号。", "VIDEO_TASK_ID_MISSING");
  }
  const response = await requestJsonMethod(
    videoQueryUrl(video, taskId),
    null,
    video.apiKey,
    "GET",
    {},
    videoRequestMeta(event.requestId, "video.query", video, true)
  );
  const normalized = normalizeVideoQueryResponse(response);
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
    requestId: event.requestId,
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
    if (action === "analyze") result = await analyze(requestEvent, context);
    else if (action === "detectFaceCircle") result = await detectFaceCircle(requestEvent, context);
    else if (action === "analyzeWebPoses") result = await analyzeWebPoses(requestEvent, context);
    else if (action === "generate") result = await generate(requestEvent, context);
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
    videoProviderStatus,
    buildVideoGenerationPayload,
    normalizeVideoCreateResponse,
    normalizeVideoQueryResponse,
    videoCreateUrl,
    videoQueryUrl
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
  };
}

