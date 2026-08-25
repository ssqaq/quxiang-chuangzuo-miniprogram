const http = require("http");
const https = require("https");

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_URL: "INVALID_URL",
  UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  PROVIDER_FAILED: "PROVIDER_FAILED",
  CONTENT_TYPE_NOT_SUPPORTED: "CONTENT_TYPE_NOT_SUPPORTED",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  USER_NOT_AUTHORIZED: "USER_NOT_AUTHORIZED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  MEDIA_TOO_LARGE: "MEDIA_TOO_LARGE",
  MEDIA_TYPE_INVALID: "MEDIA_TYPE_INVALID",
  SAVE_FORBIDDEN: "SAVE_FORBIDDEN"
});

const MAX_INPUT_LENGTH = 4096;
const DEFAULT_ZHUCEKA_API_BASE = "https://api.zhuceka.cn/home/api";
const DEFAULT_PROVIDER_TIMEOUT_MS = 20000;
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

function createRequestId(value) {
  const candidate = String(value || "").trim();
  return candidate.slice(0, 80) || `media-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

function success(data) {
  return Object.assign({ ok: true }, data);
}

function failure(errorCode, message, requestId, extra = {}) {
  return Object.assign({
    ok: false,
    errorCode,
    message,
    requestId
  }, extra);
}

function normalizeText(value) {
  return String(value || "").trim().slice(0, MAX_INPUT_LENGTH);
}

function normalizeContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["live_photo", "live-photo", "livephoto"].includes(normalized)) {
    return "live_photo";
  }
  return normalized === "image" ? "image" : "video";
}

function normalizeProviderName(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "mock") return "mock";
  if (["zhuceka", "dsp", "register-card"].includes(provider)) return "zhuceka";
  return provider;
}

function resolveProviderName() {
  const explicit = normalizeProviderName(process.env.WATERMARK_PROVIDER);
  if (explicit) return explicit;
  if (String(process.env.WATERMARK_GATEWAY_MOCK || "").trim().toLowerCase() === "true") {
    return "mock";
  }
  return "zhuceka";
}

function buildDemoResult(requestId, contentType = "video") {
  const normalizedType = normalizeContentType(contentType);
  const isImage = normalizedType === "image";
  return success({
    provider: "mock",
    platform: "demo",
    contentType: normalizedType,
    title: isImage ? "演示图片" : "演示视频",
    author: "Mock Provider",
    coverUrl: "",
    primaryMedia: {
      type: normalizedType,
      url: "",
      mimeType: isImage ? "image/jpeg" : "video/mp4",
      size: 0
    },
    mediaItems: [],
    mediaUrl: "",
    mimeType: isImage ? "image/jpeg" : "video/mp4",
    size: 0,
    expiresAt: 0,
    demo: true,
    requestId
  });
}

function stripTrailingPunctuation(value) {
  return String(value || "").replace(/[)\]}>，。！？；：、"'”’]+$/u, "");
}

function extractFirstHttpUrl(text) {
  const match = normalizeText(text).match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return stripTrailingPunctuation(match[0]);
}

function isPrivateIpv4(hostname) {
  const match = String(hostname || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
  );
}

function validateSharedUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (_error) {
    return { ok: false, message: "没有识别到有效的分享链接" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, message: "分享链接只支持 http 或 https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "分享链接不能包含账号或密码" };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || isPrivateIpv4(hostname)
    || hostname === "::1"
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || hostname.startsWith("fe80:")
  ) {
    return { ok: false, message: "该链接地址不允许解析" };
  }
  return { ok: true, url: parsed.toString() };
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function resolveProviderRedirect(currentUrl, location, allowedOrigin) {
  let redirected;
  try {
    redirected = new URL(String(location || ""), currentUrl);
  } catch (_error) {
    const error = new Error("PROVIDER_REDIRECT_INVALID");
    error.code = "PROVIDER_REDIRECT_INVALID";
    throw error;
  }
  if (
    redirected.protocol !== "https:"
    || redirected.username
    || redirected.password
    || redirected.origin !== allowedOrigin
  ) {
    const error = new Error("PROVIDER_REDIRECT_FORBIDDEN");
    error.code = "PROVIDER_REDIRECT_FORBIDDEN";
    throw error;
  }
  return redirected;
}

function requestJson(targetUrl, options = {}) {
  const timeoutMs = clampNumber(
    options.timeoutMs,
    DEFAULT_PROVIDER_TIMEOUT_MS,
    3000,
    60000
  );
  const maxBytes = clampNumber(
    options.maxBytes,
    MAX_PROVIDER_RESPONSE_BYTES,
    1024,
    MAX_PROVIDER_RESPONSE_BYTES
  );
  const redirectCount = Number(options.redirectCount || 0);
  const parsed = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl || ""));
  const allowedOrigin = String(options.allowedOrigin || parsed.origin);
  if (parsed.protocol !== "https:" || parsed.origin !== allowedOrigin) {
    const error = new Error("PROVIDER_ORIGIN_FORBIDDEN");
    error.code = "PROVIDER_ORIGIN_FORBIDDEN";
    return Promise.reject(error);
  }
  const client = parsed.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    const request = client.request(parsed, {
      method: "GET",
      headers: {
        Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
        "User-Agent": "aips-watermark-gateway/1.0"
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (
        statusCode >= 300
        && statusCode < 400
        && response.headers.location
        && redirectCount < 2
      ) {
        response.resume();
        let redirected;
        try {
          redirected = resolveProviderRedirect(
            parsed,
            response.headers.location,
            allowedOrigin
          );
        } catch (error) {
          reject(error);
          return;
        }
        requestJson(redirected, {
          timeoutMs,
          maxBytes,
          redirectCount: redirectCount + 1,
          allowedOrigin
        }).then(resolve, reject);
        return;
      }

      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          const error = new Error("PROVIDER_RESPONSE_TOO_LARGE");
          error.code = "PROVIDER_RESPONSE_TOO_LARGE";
          response.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`PROVIDER_HTTP_${statusCode || "UNKNOWN"}`);
          error.code = "PROVIDER_HTTP_ERROR";
          error.statusCode = statusCode;
          reject(error);
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
        try {
          resolve(JSON.parse(body));
        } catch (_error) {
          const error = new Error("PROVIDER_RESPONSE_INVALID");
          error.code = "PROVIDER_RESPONSE_INVALID";
          reject(error);
        }
      });
      response.on("error", reject);
    });

    request.setTimeout(timeoutMs, () => {
      const error = new Error("PROVIDER_TIMEOUT");
      error.code = "PROVIDER_TIMEOUT";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end();
  });
}

function normalizeMediaUrl(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.url || value.src || value.download_url || "").trim();
}

function normalizeLivePhotoItem(value) {
  if (!value || typeof value !== "object") return null;
  const imageUrl = normalizeMediaUrl(
    value.image || value.imageUrl || value.photo || value.picture
  );
  const videoUrl = normalizeMediaUrl(
    value.video || value.videoUrl || value.motion || value.motionVideo
  );
  if (!imageUrl && !videoUrl) return null;
  return {
    imageUrl,
    videoUrl,
    imageMimeType: "image/jpeg",
    videoMimeType: "video/mp4"
  };
}

function detectPlatform(sharedUrl, data = {}) {
  const providerPlatform = String(
    data.platform || data.type || data.source || ""
  ).trim().toLowerCase();
  if (providerPlatform) return providerPlatform;

  let hostname = "";
  try {
    hostname = new URL(sharedUrl).hostname.toLowerCase();
  } catch (_error) {
    return "unknown";
  }
  if (hostname.includes("douyin")) return "douyin";
  if (hostname.includes("kuaishou") || hostname.includes("chenzhongtech")) return "kuaishou";
  if (hostname.includes("xiaohongshu") || hostname.includes("xhslink")) return "xiaohongshu";
  if (hostname.includes("weishi")) return "weishi";
  if (hostname.includes("bilibili") || hostname.includes("b23.tv")) return "bilibili";
  return "unknown";
}

function normalizeZhucekaFailure(payload, requestId) {
  const message = String(payload && payload.msg || "第三方解析服务返回失败").trim();
  if (/余额|次数|额度|欠费|充值|会员/i.test(message)) {
    return failure(ERROR_CODES.QUOTA_EXCEEDED, message, requestId, {
      provider: "zhuceka"
    });
  }
  if (/频繁|限流|稍后再试|请求过多/i.test(message)) {
    return failure(ERROR_CODES.RATE_LIMITED, message, requestId, {
      provider: "zhuceka"
    });
  }
  return failure(ERROR_CODES.PROVIDER_FAILED, message, requestId, {
    provider: "zhuceka"
  });
}

function normalizeZhucekaResponse(payload, requestId, sharedUrl) {
  if (!payload || typeof payload !== "object") {
    return failure(
      ERROR_CODES.PROVIDER_FAILED,
      "第三方解析服务返回了无效数据",
      requestId,
      { provider: "zhuceka" }
    );
  }
  if (Number(payload.code) !== 200) {
    return normalizeZhucekaFailure(payload, requestId);
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const videoUrl = normalizeMediaUrl(data.video);
  const imageUrls = Array.isArray(data.images)
    ? data.images.map(normalizeMediaUrl).filter(Boolean)
    : [];
  const livePhotoItems = Array.isArray(data.live_photo)
    ? data.live_photo.map(normalizeLivePhotoItem).filter(Boolean)
    : [];
  const platform = detectPlatform(sharedUrl, data);
  const title = String(data.title || "媒体解析结果").trim();
  const author = String(data.author || data.nickname || "").trim();
  const coverUrl = normalizeMediaUrl(data.cover);

  if (livePhotoItems.length) {
    const first = livePhotoItems[0];
    const firstImageUrl = first.imageUrl || "";
    return success({
      provider: "zhuceka",
      platform,
      contentType: "live_photo",
      title,
      author,
      coverUrl,
      primaryMedia: {
        type: "image",
        url: firstImageUrl,
        mimeType: first.imageMimeType,
        size: 0
      },
      mediaItems: livePhotoItems,
      livePhotoItems,
      mediaCount: livePhotoItems.length,
      mediaUrl: firstImageUrl,
      mimeType: first.imageMimeType,
      size: 0,
      expiresAt: 0,
      demo: false,
      requestId
    });
  }

  if (videoUrl) {
    return success({
      provider: "zhuceka",
      platform,
      contentType: "video",
      title,
      author,
      coverUrl,
      primaryMedia: {
        type: "video",
        url: videoUrl,
        mimeType: "video/mp4",
        size: 0
      },
      mediaItems: [],
      mediaCount: 1,
      mediaUrl: videoUrl,
      mimeType: "video/mp4",
      size: 0,
      expiresAt: 0,
      demo: false,
      requestId
    });
  }

  if (imageUrls.length) {
    const mediaItems = imageUrls.map((url) => ({
      type: "image",
      url,
      mimeType: "image/jpeg",
      size: 0
    }));
    return success({
      provider: "zhuceka",
      platform,
      contentType: "image",
      title,
      author,
      coverUrl,
      primaryMedia: {
        type: "image",
        url: mediaItems[0].url,
        mimeType: "image/jpeg",
        size: 0
      },
      mediaItems,
      mediaCount: mediaItems.length,
      mediaUrl: mediaItems[0].url,
      mimeType: "image/jpeg",
      size: 0,
      expiresAt: 0,
      demo: false,
      requestId
    });
  }

  return failure(
    ERROR_CODES.PROVIDER_FAILED,
    "解析成功，但服务商没有返回可用的视频或图片",
    requestId,
    { provider: "zhuceka", platform }
  );
}

async function parseWithZhuceka(text, requestId, dependencies = {}) {
  const uid = String(process.env.ZHUCEKA_UID || "").trim();
  const key = String(process.env.ZHUCEKA_KEY || "").trim();
  if (!uid || !key) {
    return failure(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      "真实解析服务的 UID 或 Key 尚未配置",
      requestId,
      { provider: "zhuceka" }
    );
  }

  const sharedUrl = extractFirstHttpUrl(text);
  const validation = validateSharedUrl(sharedUrl);
  if (!validation.ok) {
    return failure(ERROR_CODES.INVALID_URL, validation.message, requestId, {
      provider: "zhuceka"
    });
  }

  let endpoint;
  try {
    endpoint = new URL(
      String(process.env.ZHUCEKA_API_BASE || DEFAULT_ZHUCEKA_API_BASE).trim()
    );
  } catch (_error) {
    return failure(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      "真实解析服务地址配置错误",
      requestId,
      { provider: "zhuceka" }
    );
  }
  if (endpoint.protocol !== "https:") {
    return failure(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      "真实解析服务必须使用 HTTPS 地址",
      requestId,
      { provider: "zhuceka" }
    );
  }
  endpoint.searchParams.set("type", "dsp");
  endpoint.searchParams.set("uid", uid);
  endpoint.searchParams.set("key", key);
  endpoint.searchParams.set("url", validation.url);

  const requestJsonImpl = dependencies.requestJson || requestJson;
  try {
    const payload = await requestJsonImpl(endpoint, {
      timeoutMs: clampNumber(
        process.env.ZHUCEKA_TIMEOUT_MS,
        DEFAULT_PROVIDER_TIMEOUT_MS,
        3000,
        60000
      ),
      maxBytes: MAX_PROVIDER_RESPONSE_BYTES,
      allowedOrigin: endpoint.origin
    });
    return normalizeZhucekaResponse(payload, requestId, validation.url);
  } catch (error) {
    if (error && error.code === "PROVIDER_TIMEOUT") {
      return failure(
        ERROR_CODES.PROVIDER_TIMEOUT,
        "第三方解析服务响应超时，请稍后重试",
        requestId,
        { provider: "zhuceka" }
      );
    }
    return failure(
      ERROR_CODES.PROVIDER_FAILED,
      "第三方解析服务请求失败，请稍后重试",
      requestId,
      { provider: "zhuceka" }
    );
  }
}

async function main(event = {}, _context = {}, dependencies = {}) {
  const requestId = createRequestId(event.requestId);
  const action = String(event.action || "").trim();
  const provider = resolveProviderName();
  const providerConfigured = provider === "mock" || (
    provider === "zhuceka"
    && Boolean(String(process.env.ZHUCEKA_UID || "").trim())
    && Boolean(String(process.env.ZHUCEKA_KEY || "").trim())
  );

  if (action === "health") {
    return success({
      provider,
      mode: provider === "mock" ? "mock" : "real",
      configured: providerConfigured,
      supports: ["video", "image", "live_photo"],
      requestId
    });
  }
  if (action !== "parse") {
    return failure(ERROR_CODES.INVALID_INPUT, "不支持的媒体解析操作", requestId);
  }
  const text = normalizeText(event.text);
  if (!text) {
    return failure(ERROR_CODES.INVALID_INPUT, "请提交分享链接或分享文本", requestId);
  }
  if (provider === "mock") {
    return buildDemoResult(requestId, event.demoContentType);
  }
  if (provider === "zhuceka") {
    return parseWithZhuceka(text, requestId, dependencies);
  }
  return failure(
    ERROR_CODES.PROVIDER_NOT_CONFIGURED,
    "当前配置的真实解析服务不受支持",
    requestId,
    { provider }
  );
}

module.exports = {
  ERROR_CODES,
  main,
  normalizeText,
  normalizeContentType,
  normalizeProviderName,
  resolveProviderName,
  buildDemoResult,
  extractFirstHttpUrl,
  validateSharedUrl,
  resolveProviderRedirect,
  requestJson,
  normalizeZhucekaResponse,
  normalizeLivePhotoItem,
  parseWithZhuceka
};
