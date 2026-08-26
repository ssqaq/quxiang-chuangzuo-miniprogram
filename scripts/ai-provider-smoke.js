/* eslint-disable no-console */

/**
 * OpenAI-compatible AI 供应商回归脚本。
 *
 * 默认只做本地 retry/图片请求格式检查，不会产生费用。
 * 真实接口测试需要显式传 --real，并从环境变量读取密钥：
 *
 *   $env:AI_BASE_URL = "https://视觉服务/v1"
 *   $env:AI_IMAGE_PROVIDER = "lingyun"
 *   $env:AI_IMAGE_BASE_URL = "https://api.lingyunapi.xyz/v1"
 *   $env:AI_SMOKE_VISION_API_KEY = "只在当前终端临时设置，不写入文件"
 *   $env:AI_SMOKE_IMAGE_API_KEY = "只在当前终端临时设置，不写入文件"
 *   $env:AI_VISION_MODEL = "实际视觉模型"
 *   $env:AI_IMAGE_MODEL = "实际生图模型"
 *   $env:AI_SMOKE_IMAGE = "D:\\path\\main.jpg"
 *   node .\\scripts\\ai-provider-smoke.js --real
 *
 * 图片生成/编辑通常会扣费，必须额外传 --allow-paid。
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { createMultipart } = require("../cloudfunctions/api/lib/multipart");

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TIMEOUT_MS = 90000;

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function boolEnv(name, fallback = false) {
  const value = env(name, fallback ? "true" : "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function parseArgs(argv) {
  const flags = new Set();
  argv.slice(2).forEach((item) => {
    if (item.startsWith("--")) flags.add(item);
  });
  return {
    help: flags.has("--help") || flags.has("-h"),
    check: flags.has("--check"),
    mock: !flags.has("--no-mock"),
    real: flags.has("--real"),
    images: flags.has("--images") || flags.has("--all"),
    edits: flags.has("--edits") || flags.has("--all"),
    allowPaid: flags.has("--allow-paid")
  };
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
  } catch (_) {
    return "";
  }
}

function isLingyunImageProvider(config = {}) {
  const provider = String(config.imageProvider || "").trim().toLowerCase();
  if (provider === "lingyun" || provider === "凌云") return true;
  try {
    const hostname = new URL(String(config.imageBaseUrl || "")).hostname.toLowerCase();
    return hostname === "lingyunapi.xyz" || hostname.endsWith(".lingyunapi.xyz");
  } catch (_) {
    return false;
  }
}

function dataUrl(buffer, mime) {
  return `data:${mime || "image/png"};base64,${Buffer.from(buffer).toString("base64")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestOnce(url, options = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === "http:" ? http : https;
    const requestOptions = Object.assign({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers: {}
    }, options);
    const chunks = [];
    const request = transport.request(requestOptions, (response) => {
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = buffer.length ? JSON.parse(buffer.toString("utf8")) : null;
        } catch (_) {
          json = null;
        }
        resolve({
          status: Number(response.statusCode) || 0,
          headers: response.headers || {},
          buffer,
          json
        });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("请求超时"));
    });
    request.on("error", reject);
    if (body !== null && body !== undefined) request.write(body);
    request.end();
  });
}

function retryAfterMs(headers) {
  const value = headers && (headers["retry-after"] || headers["Retry-After"]);
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(30000, seconds * 1000)) : 0;
}

async function requestWithRetry(url, options, body, options2 = {}) {
  const maxRetries = Math.max(0, Math.min(5, Number(options2.maxRetries) || 0));
  const allowRetry = options2.allowRetry !== false;
  const maxAttempts = allowRetry ? maxRetries + 1 : 1;
  const attemptsLog = [];
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await requestOnce(
        url,
        options,
        body,
        Number(options2.timeoutMs) || DEFAULT_TIMEOUT_MS
      );
      attemptsLog.push(response.status);
      if (
        !RETRY_STATUSES.has(response.status) ||
        attempt >= maxAttempts
      ) {
        return Object.assign({}, response, { attempts: attempt, attemptsLog });
      }
      await sleep(retryAfterMs(response.headers) || Math.min(10000, 200 * Math.pow(2, attempt - 1)));
    } catch (error) {
      lastError = error;
      attemptsLog.push("network-error");
      if (!allowRetry || attempt >= maxAttempts) throw error;
      await sleep(Math.min(10000, 200 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError || new Error("请求没有返回结果。");
}

function jsonHeaders(apiKey, body) {
  return {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Authorization: `Bearer ${apiKey}`
  };
}

function endpoint(baseUrl, suffix, override) {
  return override || `${String(baseUrl).replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function assertSuccess(response, label) {
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(`${label} 返回 HTTP ${response.status}`);
    error.status = response.status;
    error.response = response;
    throw error;
  }
}

function detectMime(filePath, buffer) {
  if (buffer && buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer && buffer.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer && buffer.slice(0, 4).toString("ascii") === "RIFF") return "image/webp";
  const extension = String(filePath || "").toLowerCase().split(".").pop();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return "image/png";
}

function imageExtension(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "png";
}

function readRequiredFile(filePath, label) {
  if (!filePath) throw new Error(`真实 ${label} 测试缺少文件路径。`);
  if (!fs.existsSync(filePath)) throw new Error(`${label} 文件不存在：${filePath}`);
  return fs.readFileSync(filePath);
}

async function runRetryProbe() {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.statusCode = 429;
      response.setHeader("Retry-After", "0");
      response.end("rate limited");
      return;
    }
    if (attempts === 2) {
      response.statusCode = 503;
      response.end("busy");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await requestWithRetry(
      `http://127.0.0.1:${address.port}/retry`,
      { method: "GET", headers: {} },
      null,
      { maxRetries: 2, allowRetry: true, timeoutMs: 5000 }
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.attempts, 3);
    return { status: "ok", attempts: response.attempts, statuses: response.attemptsLog };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runImageNoRetryProbe() {
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    response.statusCode = 503;
    response.end("image request must not retry by default");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await requestWithRetry(
      `http://127.0.0.1:${address.port}/image`,
      { method: "POST", headers: {} },
      Buffer.from("image"),
      { maxRetries: 2, allowRetry: false, timeoutMs: 5000 }
    );
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.attempts, 1);
    assert.strictEqual(attempts, 1);
    return { status: "ok", attempts, statuses: response.attemptsLog };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runMultipartProbe() {
  const multipart = createMultipart(
    [{ name: "model", value: "demo-model" }, { name: "prompt", value: "只做兼容性检查" }],
    [{
      name: "image[]",
      filename: "reference.png",
      mime: "image/png",
      buffer: Buffer.from("reference")
    }]
  );
  const body = multipart.body.toString("utf8");
  assert.ok(body.includes('name="model"'));
  assert.ok(body.includes('name="prompt"'));
  assert.ok(body.includes('name="image[]"; filename="reference.png"'));
  return { status: "ok", bytes: multipart.body.length };
}

async function runMockChecks() {
  const retry = await runRetryProbe();
  const imageNoRetry = await runImageNoRetryProbe();
  const multipart = await runMultipartProbe();
  return { retry, imageNoRetry, multipart };
}

function getRealConfig() {
  const keyName = process.env.AI_SMOKE_API_KEY
    ? "AI_SMOKE_API_KEY"
    : (process.env.AI_IMAGE_API_KEY
      ? "AI_IMAGE_API_KEY"
      : (process.env.AI_API_KEY ? "AI_API_KEY" : ""));
  const sharedKey = process.env.AI_SMOKE_API_KEY || process.env.AI_API_KEY || "";
  return {
    keyName,
    apiKey: sharedKey,
    imageProvider: env("AI_IMAGE_PROVIDER", "openai-compatible"),
    visionApiKey: process.env.AI_SMOKE_VISION_API_KEY
      || process.env.AI_VISION_API_KEY
      || sharedKey,
    imageApiKey: process.env.AI_SMOKE_IMAGE_API_KEY
      || process.env.AI_IMAGE_API_KEY
      || sharedKey,
    baseUrl: env("AI_BASE_URL", DEFAULT_BASE_URL),
    imageBaseUrl: env("AI_IMAGE_BASE_URL", env("AI_BASE_URL", DEFAULT_BASE_URL)),
    visionEndpoint: env("AI_VISION_ENDPOINT", ""),
    imageEndpoint: env("AI_IMAGE_ENDPOINT", ""),
    editEndpoint: env("AI_IMAGE_EDIT_ENDPOINT", ""),
    visionModel: env("AI_VISION_MODEL", "gpt-4o-mini"),
    imageModel: env("AI_IMAGE_MODEL", "gpt-image-2"),
    size: env("AI_IMAGE_SIZE", "1024x1024"),
    maxRetries: Math.max(0, Math.min(5, Number(env("AI_MAX_RETRIES", "2")) || 0)),
    timeoutMs: Number(env("AI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS,
    imagePath: env("AI_SMOKE_IMAGE", ""),
    mainPath: env("AI_SMOKE_MAIN", env("AI_SMOKE_IMAGE", "")),
    maskPath: env("AI_SMOKE_MASK", ""),
    referencePaths: env("AI_SMOKE_REFERENCES", "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
}

function printConfig(config) {
  console.log(JSON.stringify({
    apiKey: config.apiKey ? "已设置（不显示内容）" : "未设置",
    visionApiKey: config.visionApiKey ? "已设置（不显示内容）" : "未设置",
    imageApiKey: config.imageApiKey ? "已设置（不显示内容）" : "未设置",
    apiKeyVariable: config.keyName || "无",
    baseUrl: safeUrl(config.baseUrl),
    imageProvider: config.imageProvider,
    imageBaseUrl: safeUrl(config.imageBaseUrl),
    visionEndpoint: safeUrl(config.visionEndpoint || endpoint(config.baseUrl, "chat/completions")),
    imageEndpoint: safeUrl(config.imageEndpoint || endpoint(config.imageBaseUrl, "images/generations")),
    editEndpoint: safeUrl(config.editEndpoint || endpoint(config.imageBaseUrl, "images/edits")),
    visionModel: config.visionModel,
    imageModel: config.imageModel,
    size: config.size,
    imagePath: config.imagePath ? "已设置" : "未设置",
    mainPath: config.mainPath ? "已设置" : "未设置",
    maskPath: config.maskPath ? "已设置" : "未设置",
    referenceCount: config.referencePaths.length
  }, null, 2));
}

async function runVision(config) {
  if (!config.visionApiKey) throw new Error("没有视觉接口密钥，不能运行视觉真实测试。");
  const image = readRequiredFile(config.imagePath, "视觉主图");
  const mime = detectMime(config.imagePath, image);
  const payload = {
    model: config.visionModel,
    temperature: 0.2,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请返回 JSON，只做接口连通性测试，字段 ping 为 true。" },
        {
          type: "image_url",
          image_url: {
            url: `data:${mime};base64,${image.toString("base64")}`
          }
        }
      ]
    }]
  };
  const body = JSON.stringify(payload);
  const response = await requestWithRetry(
    endpoint(config.baseUrl, "chat/completions", config.visionEndpoint),
    { method: "POST", headers: jsonHeaders(config.visionApiKey, body) },
    body,
    { maxRetries: config.maxRetries, allowRetry: true, timeoutMs: config.timeoutMs }
  );
  assertSuccess(response, "视觉接口");
  return {
    status: response.status,
    attempts: response.attempts,
    responseBytes: response.buffer.length
  };
}

async function runGeneration(config) {
  if (!config.imageApiKey) throw new Error("没有生图接口密钥，不能运行生图真实测试。");
  const payload = {
    model: config.imageModel,
    prompt: "只做接口连通性测试：生成一张简单的白色方形图。",
    size: config.size,
    n: 1
  };
  const body = JSON.stringify(payload);
  const response = await requestWithRetry(
    endpoint(config.imageBaseUrl, "images/generations", config.imageEndpoint),
    { method: "POST", headers: jsonHeaders(config.imageApiKey, body) },
    body,
    {
      maxRetries: config.maxRetries,
      allowRetry: boolEnv("AI_SMOKE_RETRY_IMAGES", false),
      timeoutMs: config.timeoutMs
    }
  );
  assertSuccess(response, "图片生成接口");
  return {
    status: response.status,
    attempts: response.attempts,
    responseBytes: response.buffer.length,
    dataItems: Array.isArray(response.json && response.json.data)
      ? response.json.data.length
      : null
  };
}

async function runEdits(config) {
  if (!config.imageApiKey) throw new Error("没有生图接口密钥，不能运行编辑真实测试。");
  const main = readRequiredFile(config.mainPath, "编辑主图");
  const mask = readRequiredFile(config.maskPath, "编辑 mask");
  const mainMime = detectMime(config.mainPath, main);
  const references = config.referencePaths.map((filePath, index) => {
    const buffer = readRequiredFile(filePath, `参考图 ${index + 1}`);
    return {
      buffer,
      mime: detectMime(filePath, buffer)
    };
  });
  const editUrl = endpoint(config.imageBaseUrl, "images/edits", config.editEndpoint);
  if (isLingyunImageProvider(config)) {
    const payload = {
      model: config.imageModel,
      prompt: "只做接口连通性测试：保持主图结构，仅验证 mask 局部编辑。",
      size: config.size,
      quality: "auto",
      n: 1,
      background: "auto",
      response_format: "url",
      output_format: "png",
      images: [{
        image_url: dataUrl(main, mainMime)
      }].concat(references.map((reference) => ({
        image_url: dataUrl(reference.buffer, reference.mime)
      }))),
      mask: {
        image_url: dataUrl(mask, "image/png")
      }
    };
    const body = JSON.stringify(payload);
    const response = await requestWithRetry(
      editUrl,
      {
        method: "POST",
        headers: jsonHeaders(config.imageApiKey, body)
      },
      body,
      {
        maxRetries: config.maxRetries,
        allowRetry: boolEnv("AI_SMOKE_RETRY_IMAGES", false),
        timeoutMs: config.timeoutMs
      }
    );
    assertSuccess(response, "图片编辑接口");
    return {
      status: response.status,
      attempts: response.attempts,
      protocol: "lingyun-json",
      requestBytes: Buffer.byteLength(body),
      responseBytes: response.buffer.length,
      referenceCount: references.length,
      hasMainImage: Boolean(payload.images[0] && payload.images[0].image_url),
      hasMask: Boolean(payload.mask && payload.mask.image_url)
    };
  }
  const files = [
    {
      name: env("AI_IMAGE_MAIN_FIELD", "image"),
      filename: `main.${imageExtension(mainMime)}`,
      mime: mainMime,
      buffer: main
    },
    {
      name: env("AI_IMAGE_MASK_FIELD", "mask"),
      filename: "mask.png",
      mime: "image/png",
      buffer: mask
    }
  ];
  const multipartReferences = references.map((reference, index) => ({
    name: env("AI_IMAGE_REFERENCE_FIELD", "image[]"),
    filename: `reference-${index + 1}.${imageExtension(reference.mime)}`,
    mime: reference.mime,
    buffer: reference.buffer
  }));
  const multipart = createMultipart([
    { name: "model", value: config.imageModel },
    { name: "prompt", value: "只做接口连通性测试：保持主图结构，仅验证编辑接口。" },
    { name: "size", value: config.size }
  ], files.concat(multipartReferences));
  const response = await requestWithRetry(
    editUrl,
    {
      method: "POST",
      headers: Object.assign({
        "Content-Type": multipart.contentType,
        "Content-Length": multipart.body.length,
        Authorization: `Bearer ${config.imageApiKey}`
      })
    },
    multipart.body,
    {
      maxRetries: config.maxRetries,
      allowRetry: boolEnv("AI_SMOKE_RETRY_IMAGES", false),
      timeoutMs: config.timeoutMs
    }
  );
  assertSuccess(response, "图片编辑接口");
  return {
    status: response.status,
    attempts: response.attempts,
    requestBytes: multipart.body.length,
    responseBytes: response.buffer.length,
    referenceCount: references.length
  };
}

async function runReal(config, args) {
  if (!config.visionApiKey && config.imagePath && !args.images && !args.edits) {
    const error = new Error("没有视觉接口密钥，不能运行视觉真实接口。");
    error.code = "missing-api-key";
    throw error;
  }
  if (!config.imageApiKey && (args.images || args.edits)) {
    const error = new Error("没有生图接口密钥，不能运行生图真实接口。");
    error.code = "missing-api-key";
    throw error;
  }
  if (!config.imagePath && !args.images && !args.edits) {
    throw new Error("视觉真实测试需要设置 AI_SMOKE_IMAGE。");
  }
  const result = {};
  if (config.imagePath && !args.images && !args.edits) {
    result.vision = await runVision(config);
  } else if (config.imagePath) {
    result.vision = await runVision(config);
  }
  if (args.images) result.generations = await runGeneration(config);
  if (args.edits) result.edits = await runEdits(config);
  return result;
}

function printHelp() {
  console.log([
    "用法：",
    "  node scripts/ai-provider-smoke.js --check",
    "  node scripts/ai-provider-smoke.js --real",
    "  node scripts/ai-provider-smoke.js --real --allow-paid --images",
    "  node scripts/ai-provider-smoke.js --real --allow-paid --edits",
    "",
    "默认只跑本地兼容性检查；--real 才访问供应商。",
    "真实测试所需环境变量见脚本顶部注释和 README。",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = getRealConfig();
  printConfig(config);

  if (args.check || !args.real) {
    const mock = await runMockChecks();
    console.log("本地兼容检查：通过");
    console.log(JSON.stringify({ mock }, null, 2));
  }

  if (!args.real) return;
  if ((args.images || args.edits) && !args.allowPaid) {
    throw new Error("图片生成/编辑可能扣费，请明确加 --allow-paid 后再运行。");
  }
  const real = await runReal(config, args);
  console.log("真实 AI 接口回归：通过");
  console.log(JSON.stringify({ real }, null, 2));
}

main().catch((error) => {
  console.error(`AI smoke 未完成：${error.message || error}`);
  if (error.code === "missing-api-key") {
    console.error("只缺真实密钥；本地兼容检查仍可用，未读取或输出任何密钥内容。");
  }
  process.exitCode = error.code === "missing-api-key" ? 2 : 1;
});
