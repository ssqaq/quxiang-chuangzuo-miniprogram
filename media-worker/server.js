"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  buildAppleLivePhoto
} = require("./lib/apple-live-photo");

const PORT = Math.max(1, Number(process.env.PORT) || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const WORKER_TOKEN = String(process.env.APPLE_LIVE_PHOTO_WORKER_TOKEN || "").trim();
const REQUEST_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.APPLE_LIVE_PHOTO_REQUEST_TIMEOUT_MS) || 180000
);
const BODY_LIMIT_BYTES = 128 * 1024;

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function safeError(error) {
  return {
    ok: false,
    code: String(error && error.code || "APPLE_LIVE_PHOTO_WORKER_FAILED"),
    message: String(error && error.message || "Apple Live Photo 生成失败").slice(0, 2000),
    retryable: Boolean(error && error.retryable)
  };
}

function authorized(req) {
  if (!WORKER_TOKEN) return process.env.ALLOW_INSECURE_WORKER === "1";
  return String(req.headers.authorization || "") === `Bearer ${WORKER_TOKEN}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        const error = new Error("请求正文过大。");
        error.code = "REQUEST_BODY_TOO_LARGE";
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (_) {
        const error = new Error("请求正文不是有效 JSON。");
        error.code = "REQUEST_JSON_INVALID";
        reject(error);
      }
    });
    req.once("error", reject);
  });
}

function remoteUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (_) {
    const error = new Error(`${label}地址无效。`);
    error.code = "REMOTE_MEDIA_URL_INVALID";
    throw error;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error(`${label}只允许 HTTP/HTTPS。`);
    error.code = "REMOTE_MEDIA_URL_INVALID";
    throw error;
  }
  return parsed.toString();
}

async function download(url, maxBytes, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(remoteUrl(url, label), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "application/octet-stream,image/jpeg,video/mp4,video/quicktime"
      }
    });
    if (!response.ok) {
      const error = new Error(`${label}下载失败：HTTP ${response.status}`);
      error.code = "REMOTE_MEDIA_DOWNLOAD_FAILED";
      error.retryable = response.status >= 500 || response.status === 429;
      throw error;
    }
    const declared = Number(response.headers.get("content-length")) || 0;
    if (declared > maxBytes) {
      const error = new Error(`${label}超过大小限制。`);
      error.code = "REMOTE_MEDIA_TOO_LARGE";
      throw error;
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error(`${label}超过大小限制。`);
        error.code = "REMOTE_MEDIA_TOO_LARGE";
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(`${label}下载超时。`);
      timeoutError.code = "REMOTE_MEDIA_DOWNLOAD_TIMEOUT";
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function handleBuild(req, res) {
  const payload = await readJsonBody(req);
  const [imageBuffer, videoBuffer] = await Promise.all([
    download(payload.imageUrl, MAX_IMAGE_BYTES, "源图片"),
    download(payload.videoUrl, MAX_VIDEO_BYTES, "源视频")
  ]);
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "apple-live-photo-"));
  try {
    const built = await buildAppleLivePhoto(imageBuffer, videoBuffer, {
      workDir,
      contentIdentifier: payload.contentIdentifier,
      baseName: payload.baseName,
      timeoutMs: REQUEST_TIMEOUT_MS,
      ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg"
    });
    const dispositionName = built.fileName.replace(/["\\\r\n]/g, "_");
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": built.buffer.length,
      "Content-Disposition": `attachment; filename="${dispositionName}"`,
      "Cache-Control": "no-store",
      "X-Live-Photo-Format": built.format,
      "X-Live-Photo-Content-Identifier": built.contentIdentifier,
      "X-Live-Photo-Photo-Sha256": built.photoSha256,
      "X-Live-Photo-Video-Sha256": built.videoSha256,
      "X-Live-Photo-Livp-Sha256": built.livpSha256,
      "X-Live-Photo-Validation": "ok"
    });
    res.end(built.buffer);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      ok: true,
      service: "apple-live-photo-worker",
      protected: Boolean(WORKER_TOKEN)
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/apple-live-photo") {
    json(res, 404, { ok: false, code: "NOT_FOUND", message: "接口不存在。" });
    return;
  }
  if (!authorized(req)) {
    json(res, 401, { ok: false, code: "UNAUTHORIZED", message: "媒体 worker 鉴权失败。" });
    return;
  }
  try {
    await handleBuild(req, res);
  } catch (error) {
    if (!res.headersSent) {
      json(res, 500, safeError(error));
    } else {
      res.destroy(error);
    }
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS + 10000;
server.headersTimeout = 15000;
server.listen(PORT, HOST, () => {
  process.stdout.write(`apple-live-photo-worker listening on ${HOST}:${PORT}\n`);
});
