const API_BUILD_VERSION = "0.57.40";
const API_BUILD_MARKER = "API_BUILD_TAG_AUTO_VERSION_V05740";
const DEFAULT_IMAGE_MODE = "edits";
// 图片和视频默认成本只在云函数入口维护；管理员页读取云端有效配置，
// 避免前后端各写一份价格。入口保持单文件可启动，兼容 CloudBase 部署。
const MODEL_COST_CONFIG_VERSION = "2026-08-26-v3";
const IMAGE_COST_RESOLUTIONS = Object.freeze(["1K", "2K", "4K"]);
const XINGJU_IMAGE_PRICES_CNY = Object.freeze({
  "1K": 0.07,
  "2K": 0.07,
  "4K": 0.07
});
const LINGYUN_IMAGE_PRICES_CNY = Object.freeze({
  "1K": 0.06,
  "2K": 0.1,
  "4K": 0.15
});
const LINGYUN_VIDEO_PRICES_CNY = Object.freeze({
  "480p": 0.2,
  "720p": 0.3,
  "1080p": 1.8
});
const LEGACY_LINGYUN_IMAGE_PRICES_CNY = Object.freeze({
  "1K": 0.015,
  "2K": 0.025,
  "4K": 0.035
});
const IMAGE_EDIT_ERROR_CODES = Object.freeze([
  "image-edit-unsupported",
  "image-edit-endpoint-invalid",
  "image-edit-model-unsupported",
  "image-edit-upstream-error",
  "PIXEL_IMAGE_ASPECT_MISMATCH",
  "PIXEL_IMAGE_SCALE_OUT_OF_RANGE",
  "PIXEL_IMAGE_RESIZE_FAILED",
  "PIXEL_IMAGE_SIZE_MISMATCH",
  "PIXEL_IMAGE_EDGE_TOO_LARGE",
  "PIXEL_IMAGE_TOO_LARGE",
  "PIXEL_IMAGE_RESIZE_TARGET_INVALID",
  "PIXEL_IMAGE_RGBA_INVALID",
  "PIXEL_IMAGE_DECODE_FAILED",
  "PIXEL_PNG_TOO_LARGE",
  "PIXEL_PNG_ROUNDTRIP_MISMATCH"
]);
const IMAGE_EDIT_DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024;
const IMAGE_EDIT_DEFAULT_MAX_TOTAL_ASSET_BYTES = 20 * 1024 * 1024;
const IMAGE_EDIT_DEFAULT_MAX_REQUEST_BYTES = 28 * 1024 * 1024;
const TENCENT_FACE_PROTECTION_MARGIN_RATIO = 0.22;
const TENCENT_FACE_PROTECTION_MAX_PIXELS = 20000000;
console.log(`[api] build=${API_BUILD_VERSION} marker=${API_BUILD_MARKER}`);

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const https = require("https");
const http = require("http");
const crypto = require("crypto");
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");
const pixelCodec = require("./lib/image-pixel-codec");
const pixelComposite = require("./lib/image-composite");
const pixelAcceptance = require("./lib/pixel-acceptance");
const pixelProtectionFlow = require("./lib/pixel-protection-flow");
const { ACCESS, createActionRegistry } = require("./lib/action-registry");
const generationStateMachine = require("./lib/generation-state-machine");
const generationQueueMonitor = require("./lib/generation-queue-monitor");
const generationOperationRetention = require(
  "./lib/generation-operation-retention"
);
const {
  createGenerationExecutionKernel
} = require("./lib/generation-execution-kernel");
const imageProviderFailover = require("./lib/image-provider-failover");
const {
  createVideoExecutionKernel
} = require("./lib/video-execution-kernel");
const XLSX = require("xlsx");
const RUNTIME_DEPENDENCY_PROBES = Object.freeze([
  {
    name: "jpeg-js",
    verify: () => require("jpeg-js")
  },
  {
    name: "pngjs",
    verify: () => require("pngjs")
  },
  {
    name: "wx-server-sdk",
    verify: () => require("wx-server-sdk")
  },
  {
    name: "xlsx",
    verify: () => require("xlsx")
  },
  {
    name: "local-modules",
    verify: () => [
      "./lib/action-registry",
      "./lib/generation-execution-kernel",
      "./lib/generation-operation-retention",
      "./lib/generation-queue-monitor",
      "./lib/generation-state-machine",
      "./lib/image-composite",
      "./lib/image-pixel-codec",
      "./lib/image-provider-failover",
      "./lib/pixel-acceptance",
      "./lib/pixel-protection-flow",
      "./lib/video-execution-kernel"
    ].forEach((specifier) => require.resolve(specifier))
  }
]);

function checkRuntimeDependencies() {
  const verified = [];
  const failed = [];
  RUNTIME_DEPENDENCY_PROBES.forEach((probe) => {
    try {
      probe.verify();
      verified.push(probe.name);
    } catch (_error) {
      failed.push(probe.name);
    }
  });
  return {
    healthy: failed.length === 0,
    verified,
    failed
  };
}

function checkRuntimeHealth(_event, _context) {
  const dependencies = checkRuntimeDependencies();
  const payload = {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    active: true,
    readOnly: true,
    dependencies,
    checkedAt: new Date().toISOString()
  };
  if (!dependencies.healthy) {
    return fail(
      "云函数运行依赖异常。",
      "RUNTIME_DEPENDENCY_UNHEALTHY",
      payload
    );
  }
  return jsonResponse(true, payload);
}

const publishExportCore = (() => {
  const module = { exports: {} };
  const LOCAL_LIMITS = Object.freeze({
    workerMaxEdge: 2048,
    mainThreadMaxEdge: 1536,
    maxPixels: 4194304,
    fftProxyMaxEdge: 1024
  });
  
  const DEFAULT_OPTIONS = Object.freeze({
    format: "jpg",
    quality: 88,
    maxLongEdge: 2048,
    colorOptimize: true,
    gentleSoften: true,
    gentleSharpen: true,
    cameraNoise: true,
    cameraNoiseStrength: 3,
    frequencyPerturb: true,
    frequencyStrength: 3,
    removeVisibleMarks: true,
    watermarkStrength: 3,
    resamplePerturb: true
  });
  
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  
  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }
  
  function clampStrength(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? clamp(Math.round(number * 10) / 10, 1, 5)
      : fallback;
  }
  
  function boolValue(value, fallback) {
    return value === undefined || value === null ? fallback : Boolean(value);
  }
  
  function normalizeFormat(value) {
    return String(value || "").toLowerCase() === "png" ? "png" : "jpg";
  }
  
  function normalizeMaxLongEdge(value) {
    const number = Number(value);
    if (number === 4096) return 4096;
    if (number === 1536) return 1536;
    return 2048;
  }
  
  function normalizeOptions(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const quality = Number(source.quality);
    return {
      format: normalizeFormat(source.format || DEFAULT_OPTIONS.format),
      quality: clamp(
        Number.isFinite(quality) ? Math.round(quality) : DEFAULT_OPTIONS.quality,
        60,
        100
      ),
      maxLongEdge: normalizeMaxLongEdge(
        source.maxLongEdge === undefined ? source.maxEdge : source.maxLongEdge
      ),
      colorOptimize: boolValue(
        source.colorOptimize === undefined ? source.colorCorrect : source.colorOptimize,
        DEFAULT_OPTIONS.colorOptimize
      ),
      gentleSoften: boolValue(
        source.gentleSoften === undefined ? source.denoise : source.gentleSoften,
        DEFAULT_OPTIONS.gentleSoften
      ),
      gentleSharpen: boolValue(
        source.gentleSharpen === undefined ? source.sharpen : source.gentleSharpen,
        DEFAULT_OPTIONS.gentleSharpen
      ),
      cameraNoise: boolValue(source.cameraNoise, DEFAULT_OPTIONS.cameraNoise),
      cameraNoiseStrength: clampStrength(
        source.cameraNoiseStrength,
        DEFAULT_OPTIONS.cameraNoiseStrength
      ),
      frequencyPerturb: boolValue(
        source.frequencyPerturb,
        DEFAULT_OPTIONS.frequencyPerturb
      ),
      frequencyStrength: clampStrength(
        source.frequencyStrength,
        DEFAULT_OPTIONS.frequencyStrength
      ),
      removeVisibleMarks: boolValue(
        source.removeVisibleMarks,
        DEFAULT_OPTIONS.removeVisibleMarks
      ),
      watermarkStrength: clampStrength(
        source.watermarkStrength,
        DEFAULT_OPTIONS.watermarkStrength
      ),
      resamplePerturb: boolValue(
        source.resamplePerturb,
        DEFAULT_OPTIONS.resamplePerturb
      )
    };
  }
  
  function getOutputSize(width, height, maxLongEdge) {
    const sourceWidth = Math.max(1, Number(width) || 1);
    const sourceHeight = Math.max(1, Number(height) || 1);
    const limit = Math.max(256, Number(maxLongEdge) || DEFAULT_OPTIONS.maxLongEdge);
    const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    return {
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale))
    };
  }
  
  function chooseLocalMode(width, height, options = {}, workerAvailable = true) {
    const normalized = normalizeOptions(options);
    const output = getOutputSize(width, height, normalized.maxLongEdge);
    const maxEdge = Math.max(output.width, output.height);
    const pixels = output.width * output.height;
    if (normalized.maxLongEdge >= 4096) {
      return {
        mode: "cloud",
        reason: "4096px 图片交给云端处理，避免普通手机内存不足。",
        output
      };
    }
    if (pixels > LOCAL_LIMITS.maxPixels) {
      return {
        mode: "cloud",
        reason: "图片像素过大，交给云端处理。",
        output
      };
    }
    if (workerAvailable && maxEdge <= LOCAL_LIMITS.workerMaxEdge) {
      return { mode: "local-worker", reason: "", output };
    }
    if (maxEdge <= LOCAL_LIMITS.mainThreadMaxEdge) {
      return { mode: "local-main", reason: "", output };
    }
    return {
      mode: "cloud",
      reason: "当前手机本地处理能力不够，交给云端处理。",
      output
    };
  }
  
  function hashString(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }
  
  function randomAt(seed, index) {
    let value = (hashString(seed) ^ Math.imul(index + 1, 2654435761)) >>> 0;
    value += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }
  
  function luma(r, g, b) {
    return r * 0.299 + g * 0.587 + b * 0.114;
  }
  
  function applyColorCorrection(data) {
    for (let index = 0; index < data.length; index += 4) {
      const oldLuma = luma(data[index], data[index + 1], data[index + 2]);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[index + channel];
        const centered = (value - 128) * 1.035 + 128;
        data[index + channel] = clampByte(
          oldLuma + (centered - oldLuma) * 1.035
        );
      }
    }
  }
  
  function applyBoxSoften(data, width, height) {
    const source = new Uint8ClampedArray(data);
    const offsets = [-1, 0, 1];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const target = (y * width + x) * 4;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        offsets.forEach((dy) => {
          const sampleY = clamp(y + dy, 0, height - 1);
          offsets.forEach((dx) => {
            const sampleX = clamp(x + dx, 0, width - 1);
            const sourceIndex = (sampleY * width + sampleX) * 4;
            red += source[sourceIndex];
            green += source[sourceIndex + 1];
            blue += source[sourceIndex + 2];
            count += 1;
          });
        });
        data[target] = clampByte(red / count);
        data[target + 1] = clampByte(green / count);
        data[target + 2] = clampByte(blue / count);
        data[target + 3] = source[target + 3];
      }
    }
  }
  
  function applyUnsharp(data, width, height) {
    const source = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const target = (y * width + x) * 4;
        const center = [
          source[target],
          source[target + 1],
          source[target + 2]
        ];
        const neighbours = [0, 0, 0];
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const sampleX = clamp(x + dx, 0, width - 1);
            const sampleY = clamp(y + dy, 0, height - 1);
            const sourceIndex = (sampleY * width + sampleX) * 4;
            neighbours[0] += source[sourceIndex];
            neighbours[1] += source[sourceIndex + 1];
            neighbours[2] += source[sourceIndex + 2];
            count += 1;
          }
        }
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = center[channel] - neighbours[channel] / count;
          data[target + channel] = clampByte(center[channel] + difference * 0.22);
        }
        data[target + 3] = source[target + 3];
      }
    }
  }
  
  function applyCameraNoise(data, strength, seed) {
    const amount = 0.9 + clampStrength(strength, 3) * 0.72;
    for (let index = 0; index < data.length; index += 4) {
      const noise = (randomAt(seed, index / 4) - 0.5) * amount;
      data[index] = clampByte(data[index] + noise);
      data[index + 1] = clampByte(data[index + 1] + noise);
      data[index + 2] = clampByte(data[index + 2] + noise);
    }
  }
  
  function edgeDensity(source, width, height, x, y) {
    let count = 0;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const sampleX = clamp(x + dx, 0, width - 1);
        const sampleY = clamp(y + dy, 0, height - 1);
        const index = (sampleY * width + sampleX) * 4;
        const left = (sampleY * width + clamp(sampleX - 1, 0, width - 1)) * 4;
        const top = (clamp(sampleY - 1, 0, height - 1) * width + sampleX) * 4;
        const gradient = Math.abs(
          luma(source[index], source[index + 1], source[index + 2])
          - luma(source[left], source[left + 1], source[left + 2])
        ) + Math.abs(
          luma(source[index], source[index + 1], source[index + 2])
          - luma(source[top], source[top + 1], source[top + 2])
        );
        if (gradient > 55) count += 1;
      }
    }
    return count;
  }
  
  function applyVisibleMarkFade(data, width, height, strength) {
    const source = new Uint8ClampedArray(data);
    const amount = 0.06 + clampStrength(strength, 1) * 0.025;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = (y * width + x) * 4;
        const left = index - 4;
        const right = index + 4;
        const top = index - width * 4;
        const bottom = index + width * 4;
        const current = luma(source[index], source[index + 1], source[index + 2]);
        const horizontal = Math.abs(
          luma(source[right], source[right + 1], source[right + 2])
          - luma(source[left], source[left + 1], source[left + 2])
        );
        const vertical = Math.abs(
          luma(source[bottom], source[bottom + 1], source[bottom + 2])
          - luma(source[top], source[top + 1], source[top + 2])
        );
        const gradient = Math.sqrt(horizontal * horizontal + vertical * vertical);
        const density = edgeDensity(source, width, height, x, y);
        if (gradient < 70 || gradient > 230 || density < 2 || density > 16) continue;
        const neighbour = [
          source[left],
          source[left + 1],
          source[left + 2]
        ];
        const rightWeight = [
          source[right],
          source[right + 1],
          source[right + 2]
        ];
        for (let channel = 0; channel < 3; channel += 1) {
          const average = (neighbour[channel] + rightWeight[channel]) / 2;
          data[index + channel] = clampByte(
            source[index + channel] * (1 - amount) + average * amount
          );
        }
        data[index + 3] = source[index + 3];
        void current;
      }
    }
  }
  
  function nextPowerOfTwo(value) {
    let result = 1;
    while (result < value) result *= 2;
    return result;
  }
  
  function mirrorIndex(index, size) {
    if (size <= 1) return 0;
    const period = size * 2 - 2;
    let value = index % period;
    if (value < 0) value += period;
    return value < size ? value : period - value;
  }
  
  function resizeLuma(data, width, height, targetWidth, targetHeight) {
    const result = new Float64Array(targetWidth * targetHeight);
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = targetHeight === 1
        ? 0
        : (y / (targetHeight - 1)) * (height - 1);
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(height - 1, y0 + 1);
      const yWeight = sourceY - y0;
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = targetWidth === 1
          ? 0
          : (x / (targetWidth - 1)) * (width - 1);
        const x0 = Math.floor(sourceX);
        const x1 = Math.min(width - 1, x0 + 1);
        const xWeight = sourceX - x0;
        const i00 = (y0 * width + x0) * 4;
        const i10 = (y0 * width + x1) * 4;
        const i01 = (y1 * width + x0) * 4;
        const i11 = (y1 * width + x1) * 4;
        const top = luma(data[i00], data[i00 + 1], data[i00 + 2]) * (1 - xWeight)
          + luma(data[i10], data[i10 + 1], data[i10 + 2]) * xWeight;
        const bottom = luma(data[i01], data[i01 + 1], data[i01 + 2]) * (1 - xWeight)
          + luma(data[i11], data[i11 + 1], data[i11 + 2]) * xWeight;
        result[y * targetWidth + x] = top * (1 - yWeight) + bottom * yWeight;
      }
    }
    return result;
  }
  
  function fft1d(real, imaginary, offset, stride, size, inverse) {
    for (let index = 1, bit = 0; index < size; index += 1) {
      let mask = size >> 1;
      for (; bit & mask; mask >>= 1) bit ^= mask;
      bit ^= mask;
      if (index < bit) {
        const a = offset + index * stride;
        const b = offset + bit * stride;
        let temp = real[a];
        real[a] = real[b];
        real[b] = temp;
        temp = imaginary[a];
        imaginary[a] = imaginary[b];
        imaginary[b] = temp;
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / length;
      const stepReal = Math.cos(angle);
      const stepImaginary = Math.sin(angle);
      for (let start = 0; start < size; start += length) {
        let currentReal = 1;
        let currentImaginary = 0;
        const half = length >> 1;
        for (let index = 0; index < half; index += 1) {
          const even = offset + (start + index) * stride;
          const odd = offset + (start + index + half) * stride;
          const productReal = currentReal * real[odd] - currentImaginary * imaginary[odd];
          const productImaginary = currentReal * imaginary[odd]
            + currentImaginary * real[odd];
          const evenReal = real[even];
          const evenImaginary = imaginary[even];
          real[even] = evenReal + productReal;
          imaginary[even] = evenImaginary + productImaginary;
          real[odd] = evenReal - productReal;
          imaginary[odd] = evenImaginary - productImaginary;
          const nextReal = currentReal * stepReal - currentImaginary * stepImaginary;
          currentImaginary = currentReal * stepImaginary
            + currentImaginary * stepReal;
          currentReal = nextReal;
        }
      }
    }
    if (inverse) {
      for (let index = 0; index < size; index += 1) {
        const position = offset + index * stride;
        real[position] /= size;
        imaginary[position] /= size;
      }
    }
  }
  
  function fft2d(real, imaginary, width, height, inverse) {
    for (let y = 0; y < height; y += 1) {
      fft1d(real, imaginary, y * width, 1, width, inverse);
    }
    for (let x = 0; x < width; x += 1) {
      fft1d(real, imaginary, x, width, height, inverse);
    }
  }
  
  function applyFrequencyPerturb(data, width, height, strength, seed) {
    const scale = Math.min(
      1,
      LOCAL_LIMITS.fftProxyMaxEdge / Math.max(width, height)
    );
    const proxyWidth = Math.max(2, Math.round(width * scale));
    const proxyHeight = Math.max(2, Math.round(height * scale));
    const paddedWidth = nextPowerOfTwo(proxyWidth);
    const paddedHeight = nextPowerOfTwo(proxyHeight);
    const real = new Float64Array(paddedWidth * paddedHeight);
    const imaginary = new Float64Array(real.length);
    const proxy = resizeLuma(data, width, height, proxyWidth, proxyHeight);
    for (let y = 0; y < paddedHeight; y += 1) {
      for (let x = 0; x < paddedWidth; x += 1) {
        real[y * paddedWidth + x] = proxy[
          mirrorIndex(y, proxyHeight) * proxyWidth + mirrorIndex(x, proxyWidth)
        ];
      }
    }
    fft2d(real, imaginary, paddedWidth, paddedHeight, false);
    const safeStrength = clampStrength(strength, 3);
    for (let y = 0; y < paddedHeight; y += 1) {
      for (let x = 0; x < paddedWidth; x += 1) {
        const mirrorX = (paddedWidth - x) % paddedWidth;
        const mirrorY = (paddedHeight - y) % paddedHeight;
        const pairIndex = Math.min(
          y * paddedWidth + x,
          mirrorY * paddedWidth + mirrorX
        );
        const normalizedX = Math.min(x, paddedWidth - x) / (paddedWidth / 2);
        const normalizedY = Math.min(y, paddedHeight - y) / (paddedHeight / 2);
        const radius = Math.sqrt(
          normalizedX * normalizedX + normalizedY * normalizedY
        );
        if (radius < 0.35 || (x === 0 && y === 0)) continue;
        const factor = 1 + (randomAt(`${seed}:fft`, pairIndex) - 0.5)
          * (0.018 + safeStrength * 0.006);
        const index = y * paddedWidth + x;
        real[index] *= factor;
        imaginary[index] *= factor;
      }
    }
    fft2d(real, imaginary, paddedWidth, paddedHeight, true);
    const maxDelta = [6, 8, 12, 16, 20][safeStrength - 1];
    for (let y = 0; y < height; y += 1) {
      const sourceY = height === 1 ? 0 : (y / (height - 1)) * (proxyHeight - 1);
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(proxyHeight - 1, y0 + 1);
      const yWeight = sourceY - y0;
      for (let x = 0; x < width; x += 1) {
        const sourceX = width === 1 ? 0 : (x / (width - 1)) * (proxyWidth - 1);
        const x0 = Math.floor(sourceX);
        const x1 = Math.min(proxyWidth - 1, x0 + 1);
        const xWeight = sourceX - x0;
        const sourceIndex = (y * width + x) * 4;
        const p00 = real[y0 * paddedWidth + x0] - proxy[y0 * proxyWidth + x0];
        const p10 = real[y0 * paddedWidth + x1] - proxy[y0 * proxyWidth + x1];
        const p01 = real[y1 * paddedWidth + x0] - proxy[y1 * proxyWidth + x0];
        const p11 = real[y1 * paddedWidth + x1] - proxy[y1 * proxyWidth + x1];
        const top = p00 * (1 - xWeight) + p10 * xWeight;
        const bottom = p01 * (1 - xWeight) + p11 * xWeight;
        const delta = clamp(
          (top * (1 - yWeight) + bottom * yWeight) * 1.6,
          -maxDelta,
          maxDelta
        );
        data[sourceIndex] = clampByte(data[sourceIndex] + delta);
        data[sourceIndex + 1] = clampByte(data[sourceIndex + 1] + delta);
        data[sourceIndex + 2] = clampByte(data[sourceIndex + 2] + delta);
      }
    }
  }
  
  function resizeRgba(data, width, height, targetWidth, targetHeight) {
    const source = data instanceof Uint8ClampedArray
      ? data
      : new Uint8ClampedArray(data);
    if (width === targetWidth && height === targetHeight) {
      return new Uint8ClampedArray(source);
    }
    const result = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    for (let y = 0; y < targetHeight; y += 1) {
      const sourceY = targetHeight === 1
        ? 0
        : (y / (targetHeight - 1)) * (height - 1);
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(height - 1, y0 + 1);
      const yWeight = sourceY - y0;
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceX = targetWidth === 1
          ? 0
          : (x / (targetWidth - 1)) * (width - 1);
        const x0 = Math.floor(sourceX);
        const x1 = Math.min(width - 1, x0 + 1);
        const xWeight = sourceX - x0;
        const target = (y * targetWidth + x) * 4;
        const i00 = (y0 * width + x0) * 4;
        const i10 = (y0 * width + x1) * 4;
        const i01 = (y1 * width + x0) * 4;
        const i11 = (y1 * width + x1) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const top = source[i00 + channel] * (1 - xWeight)
            + source[i10 + channel] * xWeight;
          const bottom = source[i01 + channel] * (1 - xWeight)
            + source[i11 + channel] * xWeight;
          result[target + channel] = clampByte(
            top * (1 - yWeight) + bottom * yWeight
          );
        }
        result[target + 3] = source[i00 + 3];
      }
    }
    return result;
  }
  
  function processRgba(input = {}) {
    const width = Math.max(1, Number(input.width) || 1);
    const height = Math.max(1, Number(input.height) || 1);
    const options = normalizeOptions(input.options);
    const data = input.data instanceof Uint8ClampedArray
      ? new Uint8ClampedArray(input.data)
      : new Uint8ClampedArray(input.data || width * height * 4);
    const seed = String(input.seed || "publish-export");
    if (options.colorOptimize) applyColorCorrection(data);
    if (options.gentleSoften) applyBoxSoften(data, width, height);
    if (options.gentleSharpen) applyUnsharp(data, width, height);
    if (options.cameraNoise) {
      applyCameraNoise(data, options.cameraNoiseStrength, `${seed}:grain`);
    }
    if (options.removeVisibleMarks) {
      applyVisibleMarkFade(data, width, height, options.watermarkStrength);
    }
    if (options.frequencyPerturb) {
      applyFrequencyPerturb(
        data,
        width,
        height,
        options.frequencyStrength,
        `${seed}:frequency`
      );
    }
    if (options.resamplePerturb && width > 16 && height > 16) {
      const ratio = 1 - (0.004 + options.frequencyStrength * 0.001);
      const smallWidth = Math.max(8, Math.round(width * ratio));
      const smallHeight = Math.max(8, Math.round(height * ratio));
      const resampled = resizeRgba(data, width, height, smallWidth, smallHeight);
      const restored = resizeRgba(resampled, smallWidth, smallHeight, width, height);
      for (let index = 0; index < data.length; index += 4) {
        data[index] = restored[index];
        data[index + 1] = restored[index + 1];
        data[index + 2] = restored[index + 2];
        data[index + 3] = input.data && input.data[index + 3] !== undefined
          ? input.data[index + 3]
          : data[index + 3];
      }
    }
    return data;
  }
  
  function optionsHashPayload(options = {}) {
    const normalized = normalizeOptions(options);
    return JSON.stringify(normalized);
  }
  
  module.exports = {
    DEFAULT_OPTIONS,
    LOCAL_LIMITS,
    clampByte,
    getOutputSize,
    chooseLocalMode,
    normalizeOptions,
    optionsHashPayload,
    resizeRgba,
    processRgba,
    fft1d,
    fft2d
  };
  
  return module.exports;
})();
const {
  buildAndroidMotionPhoto: buildAndroidMotionPhotoBuffer,
  normalizeSourceToJpeg
} = (() => {
  const module = { exports: {} };
  "use strict";
  
  const jpeg = require("jpeg-js");
  const { PNG } = require("pngjs");
  
  const XMP_HEADER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
  const DEFAULT_MAX_EDGE = 1280;
  const DEFAULT_JPEG_QUALITY = 95;
  const DEFAULT_PRESENTATION_TIMESTAMP_US = 33333;
  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
  const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
  
  function motionPhotoError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.retryable = false;
    return error;
  }
  
  function assertBufferWithinLimit(buffer, limit, emptyMessage, largeMessage, codePrefix) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      throw motionPhotoError(emptyMessage, `${codePrefix}_EMPTY`);
    }
    if (buffer.length > limit) {
      throw motionPhotoError(largeMessage, `${codePrefix}_TOO_LARGE`);
    }
  }
  
  function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
    if (
      buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a
    ) return "png";
    if (
      buffer.subarray(0, 4).toString("ascii") === "RIFF"
      && buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) return "webp";
    return "";
  }
  
  function readExifOrientation(buffer) {
    if (detectImageType(buffer) !== "jpeg") return 1;
    let offset = 2;
    while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
      if (
        marker === 0xe1
        && segmentLength >= 16
        && buffer.subarray(offset + 4, offset + 10).toString("binary") === "Exif\0\0"
      ) {
        const tiff = offset + 10;
        const byteOrder = buffer.subarray(tiff, tiff + 2).toString("ascii");
        const littleEndian = byteOrder === "II";
        if (!littleEndian && byteOrder !== "MM") return 1;
        const readUInt16 = (position) => (
          littleEndian ? buffer.readUInt16LE(position) : buffer.readUInt16BE(position)
        );
        const readUInt32 = (position) => (
          littleEndian ? buffer.readUInt32LE(position) : buffer.readUInt32BE(position)
        );
        if (readUInt16(tiff + 2) !== 42) return 1;
        const ifdOffset = readUInt32(tiff + 4);
        const ifd = tiff + ifdOffset;
        if (ifd < tiff || ifd + 2 > offset + 2 + segmentLength) return 1;
        const count = readUInt16(ifd);
        for (let index = 0; index < count; index += 1) {
          const entry = ifd + 2 + index * 12;
          if (entry + 12 > offset + 2 + segmentLength) break;
          if (readUInt16(entry) !== 0x0112) continue;
          const orientation = readUInt16(entry + 8);
          return orientation >= 1 && orientation <= 8 ? orientation : 1;
        }
        return 1;
      }
      offset += 2 + segmentLength;
    }
    return 1;
  }
  
  function applyExifOrientation(image, orientation) {
    const sourceWidth = Number(image && image.width) || 0;
    const sourceHeight = Number(image && image.height) || 0;
    const source = image && image.data;
    if (!sourceWidth || !sourceHeight || !source || orientation === 1) {
      return image;
    }
    const swapsAxes = orientation >= 5 && orientation <= 8;
    const width = swapsAxes ? sourceHeight : sourceWidth;
    const height = swapsAxes ? sourceWidth : sourceHeight;
    const output = Buffer.allocUnsafe(width * height * 4);
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        let targetX = x;
        let targetY = y;
        if (orientation === 2) {
          targetX = sourceWidth - 1 - x;
        } else if (orientation === 3) {
          targetX = sourceWidth - 1 - x;
          targetY = sourceHeight - 1 - y;
        } else if (orientation === 4) {
          targetY = sourceHeight - 1 - y;
        } else if (orientation === 5) {
          targetX = y;
          targetY = x;
        } else if (orientation === 6) {
          targetX = sourceHeight - 1 - y;
          targetY = x;
        } else if (orientation === 7) {
          targetX = sourceHeight - 1 - y;
          targetY = sourceWidth - 1 - x;
        } else if (orientation === 8) {
          targetX = y;
          targetY = sourceWidth - 1 - x;
        }
        const sourceOffset = (y * sourceWidth + x) * 4;
        const targetOffset = (targetY * width + targetX) * 4;
        output[targetOffset] = source[sourceOffset];
        output[targetOffset + 1] = source[sourceOffset + 1];
        output[targetOffset + 2] = source[sourceOffset + 2];
        output[targetOffset + 3] = source[sourceOffset + 3];
      }
    }
    return { width, height, data: output };
  }
  
  function compositeAlphaOnWhite(image) {
    const output = Buffer.from(image.data);
    for (let offset = 0; offset + 3 < output.length; offset += 4) {
      const alpha = output[offset + 3];
      if (alpha < 255) {
        output[offset] = Math.round((output[offset] * alpha + 255 * (255 - alpha)) / 255);
        output[offset + 1] = Math.round(
          (output[offset + 1] * alpha + 255 * (255 - alpha)) / 255
        );
        output[offset + 2] = Math.round(
          (output[offset + 2] * alpha + 255 * (255 - alpha)) / 255
        );
        output[offset + 3] = 255;
      }
    }
    return {
      width: image.width,
      height: image.height,
      data: output
    };
  }
  
  function resizeRgba(image, maxEdge) {
    const sourceWidth = image.width;
    const sourceHeight = image.height;
    const longest = Math.max(sourceWidth, sourceHeight);
    if (longest <= maxEdge) return image;
    const scale = maxEdge / longest;
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const output = Buffer.allocUnsafe(width * height * 4);
    for (let targetY = 0; targetY < height; targetY += 1) {
      const sourceY = (targetY + 0.5) / scale - 0.5;
      const y0 = Math.max(0, Math.min(sourceHeight - 1, Math.floor(sourceY)));
      const y1 = Math.max(0, Math.min(sourceHeight - 1, y0 + 1));
      const yWeight = Math.max(0, Math.min(1, sourceY - y0));
      for (let targetX = 0; targetX < width; targetX += 1) {
        const sourceX = (targetX + 0.5) / scale - 0.5;
        const x0 = Math.max(0, Math.min(sourceWidth - 1, Math.floor(sourceX)));
        const x1 = Math.max(0, Math.min(sourceWidth - 1, x0 + 1));
        const xWeight = Math.max(0, Math.min(1, sourceX - x0));
        const targetOffset = (targetY * width + targetX) * 4;
        const topLeft = (y0 * sourceWidth + x0) * 4;
        const topRight = (y0 * sourceWidth + x1) * 4;
        const bottomLeft = (y1 * sourceWidth + x0) * 4;
        const bottomRight = (y1 * sourceWidth + x1) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          const top = image.data[topLeft + channel] * (1 - xWeight)
            + image.data[topRight + channel] * xWeight;
          const bottom = image.data[bottomLeft + channel] * (1 - xWeight)
            + image.data[bottomRight + channel] * xWeight;
          output[targetOffset + channel] = Math.round(
            top * (1 - yWeight) + bottom * yWeight
          );
        }
      }
    }
    return { width, height, data: output };
  }
  
  function decodeSourceImage(buffer) {
    const type = detectImageType(buffer);
    if (type === "webp") {
      throw motionPhotoError(
        "安卓实况首版暂不支持 WebP，请换成 JPG 或 PNG；普通视频仍可保存。",
        "MOTION_PHOTO_WEBP_UNSUPPORTED"
      );
    }
    if (type === "jpeg") {
      let decoded;
      try {
        decoded = jpeg.decode(buffer, {
          useTArray: true,
          formatAsRGBA: true,
          tolerantDecoding: false,
          maxResolutionInMP: 50,
          maxMemoryUsageInMB: 256
        });
      } catch (error) {
        throw motionPhotoError(
          `JPG 读取失败：${error && error.message ? error.message : "文件已损坏"}`,
          "MOTION_PHOTO_JPEG_INVALID"
        );
      }
      return applyExifOrientation(decoded, readExifOrientation(buffer));
    }
    if (type === "png") {
      try {
        return PNG.sync.read(buffer, {
          checkCRC: true,
          skipRescale: false
        });
      } catch (error) {
        throw motionPhotoError(
          `PNG 读取失败：${error && error.message ? error.message : "文件已损坏"}`,
          "MOTION_PHOTO_PNG_INVALID"
        );
      }
    }
    throw motionPhotoError(
      "安卓实况只支持 JPG 或 PNG 源照片。",
      "MOTION_PHOTO_IMAGE_UNSUPPORTED"
    );
  }
  
  function normalizeSourceToJpeg(buffer, options = {}) {
    assertBufferWithinLimit(
      buffer,
      Number(options.maxSourceBytes) || MAX_SOURCE_BYTES,
      "源照片为空。",
      "源照片过大，最大支持 20MB。",
      "MOTION_PHOTO_SOURCE"
    );
    const maxEdge = Math.max(
      64,
      Math.min(4096, Number(options.maxEdge) || DEFAULT_MAX_EDGE)
    );
    const quality = Math.max(
      50,
      Math.min(100, Number(options.quality) || DEFAULT_JPEG_QUALITY)
    );
    const decoded = compositeAlphaOnWhite(decodeSourceImage(buffer));
    const resized = resizeRgba(decoded, maxEdge);
    const encoded = jpeg.encode({
      width: resized.width,
      height: resized.height,
      data: resized.data
    }, quality);
    const jpegBuffer = Buffer.from(encoded && encoded.data || []);
    if (
      jpegBuffer.length < 4
      || jpegBuffer[0] !== 0xff
      || jpegBuffer[1] !== 0xd8
      || jpegBuffer[jpegBuffer.length - 2] !== 0xff
      || jpegBuffer[jpegBuffer.length - 1] !== 0xd9
    ) {
      throw motionPhotoError(
        "源照片转换成 JPG 失败。",
        "MOTION_PHOTO_JPEG_ENCODE_FAILED"
      );
    }
    return {
      buffer: jpegBuffer,
      width: resized.width,
      height: resized.height,
      quality,
      maxEdge
    };
  }
  
  function assertJpegBuffer(buffer) {
    assertBufferWithinLimit(
      buffer,
      MAX_SOURCE_BYTES,
      "实况封面 JPG 为空。",
      "实况封面 JPG 过大。",
      "MOTION_PHOTO_JPEG"
    );
    if (
      buffer[0] !== 0xff
      || buffer[1] !== 0xd8
      || buffer[buffer.length - 2] !== 0xff
      || buffer[buffer.length - 1] !== 0xd9
    ) {
      throw motionPhotoError(
        "实况封面必须是完整 JPG，且不能已经带视频尾部。",
        "MOTION_PHOTO_JPEG_INVALID"
      );
    }
  }
  
  function assertMp4Buffer(buffer) {
    assertBufferWithinLimit(
      buffer,
      MAX_VIDEO_BYTES,
      "动态视频为空。",
      "动态视频过大，最大支持 80MB。",
      "MOTION_PHOTO_VIDEO"
    );
    if (
      buffer.length < 12
      || buffer.subarray(4, 8).toString("ascii") !== "ftyp"
    ) {
      throw motionPhotoError(
        "动态视频不是有效的 MP4 文件。",
        "MOTION_PHOTO_MP4_INVALID"
      );
    }
    const firstBoxLength = buffer.readUInt32BE(0);
    if (firstBoxLength !== 0 && (firstBoxLength < 8 || firstBoxLength > buffer.length)) {
      throw motionPhotoError(
        "动态视频的 MP4 文件头已损坏。",
        "MOTION_PHOTO_MP4_INVALID"
      );
    }
  }
  
  function buildMotionPhotoXmp(imageLengthBytes, videoLengthBytes, presentationTimestampUs) {
    return [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '    <rdf:Description xmlns:GCamera="http://ns.google.com/photos/1.0/camera/"',
      '      xmlns:Container="http://ns.google.com/photos/1.0/container/"',
      '      xmlns:Item="http://ns.google.com/photos/1.0/container/item/"',
      '      GCamera:MicroVideo="1"',
      '      GCamera:MicroVideoVersion="1"',
      `      GCamera:MicroVideoOffset="${videoLengthBytes}"`,
      `      GCamera:MicroVideoPresentationTimestampUs="${presentationTimestampUs}"`,
      '      GCamera:MotionPhoto="1"',
      '      GCamera:MotionPhotoVersion="1"',
      `      GCamera:MotionPhotoPresentationTimestampUs="${presentationTimestampUs}">`,
      '      <Container:Directory>',
      '        <rdf:Seq>',
      '          <rdf:li rdf:parseType="Resource">',
      `            <Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="${imageLengthBytes}" Item:Padding="0"/>`,
      '          </rdf:li>',
      '          <rdf:li rdf:parseType="Resource">',
      `            <Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${videoLengthBytes}" Item:Padding="0"/>`,
      '          </rdf:li>',
      '        </rdf:Seq>',
      '      </Container:Directory>',
      '    </rdf:Description>',
      '  </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>'
    ].join("\n");
  }
  
  function buildXmpApp1Segment(imageLengthBytes, videoLengthBytes, presentationTimestampUs) {
    const xml = Buffer.from(buildMotionPhotoXmp(
      imageLengthBytes,
      videoLengthBytes,
      presentationTimestampUs
    ), "utf8");
    const payload = Buffer.concat([XMP_HEADER, xml]);
    if (payload.length + 2 > 0xffff) {
      throw motionPhotoError(
        "Motion Photo XMP 元数据过大。",
        "MOTION_PHOTO_XMP_TOO_LARGE"
      );
    }
    const segment = Buffer.allocUnsafe(payload.length + 4);
    segment[0] = 0xff;
    segment[1] = 0xe1;
    segment.writeUInt16BE(payload.length + 2, 2);
    payload.copy(segment, 4);
    return segment;
  }
  
  function jpegXmpInsertionOffset(jpegBuffer) {
    let offset = 2;
    if (
      jpegBuffer.length >= 6
      && jpegBuffer[offset] === 0xff
      && jpegBuffer[offset + 1] === 0xe0
    ) {
      const length = jpegBuffer.readUInt16BE(offset + 2);
      if (length >= 2 && offset + 2 + length <= jpegBuffer.length) {
        offset += 2 + length;
      }
    }
    return offset;
  }
  
  function buildAndroidMotionPhoto(jpegBuffer, mp4Buffer, options = {}) {
    assertJpegBuffer(jpegBuffer);
    assertMp4Buffer(mp4Buffer);
    const presentationTimestampUs = Math.max(
      0,
      Math.round(
        Number(options.presentationTimestampUs) || DEFAULT_PRESENTATION_TIMESTAMP_US
      )
    );
    const xmpSegment = buildXmpApp1Segment(
      jpegBuffer.length,
      mp4Buffer.length,
      presentationTimestampUs
    );
    const insertionOffset = jpegXmpInsertionOffset(jpegBuffer);
    const stillImage = Buffer.concat([
      jpegBuffer.subarray(0, insertionOffset),
      xmpSegment,
      jpegBuffer.subarray(insertionOffset)
    ]);
    const output = Buffer.concat([stillImage, mp4Buffer]);
    if (output.length > MAX_OUTPUT_BYTES) {
      throw motionPhotoError(
        "安卓实况文件过大，最大支持 100MB。",
        "MOTION_PHOTO_OUTPUT_TOO_LARGE"
      );
    }
    return {
      buffer: output,
      jpegLengthBytes: stillImage.length,
      sourceJpegLengthBytes: jpegBuffer.length,
      videoLengthBytes: mp4Buffer.length,
      presentationTimestampUs,
      format: "android-motion-photo"
    };
  }
  
  module.exports = {
    DEFAULT_JPEG_QUALITY,
    DEFAULT_MAX_EDGE,
    DEFAULT_PRESENTATION_TIMESTAMP_US,
    MAX_OUTPUT_BYTES,
    MAX_SOURCE_BYTES,
    MAX_VIDEO_BYTES,
    applyExifOrientation,
    assertJpegBuffer,
    assertMp4Buffer,
    buildAndroidMotionPhoto,
    buildMotionPhotoXmp,
    buildXmpApp1Segment,
    detectImageType,
    jpegXmpInsertionOffset,
    normalizeSourceToJpeg,
    readExifOrientation,
    resizeRgba
  };
  
  return module.exports;
})();

// CloudBase 某些部署实例会丢失自定义相对模块，入口必须可以单文件启动。
const DEFAULT_RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const ADMIN_RUNTIME_CONFIG_COLLECTION = "admin_runtime_config";
const ADMIN_RUNTIME_CONFIG_ID = "global";
const IMAGE_RETRY_PREFERENCE_VERSION = 1;
const DEFAULT_ADMIN_PROVIDER_LABELS = Object.freeze({
  dashscope: "阿里云百炼",
  lingyun: "凌云",
  xingju: "星炬",
  laoli: "老李",
  panda: "熊猫"
});
const FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor"
]);
const ADMIN_PROVIDER_CONFIG_SECTIONS = Object.freeze([
  "face",
  "analysis",
  "image",
  "imageBackup",
  "video",
  "videoBackup"
]);
const ADMIN_CONFIG_AUDIT_LOG_COLLECTION = "admin_config_audit_logs";
const ADMIN_CONFIG_AUDIT_MAX_READ = 200;
// 服务商目录是管理员配置的唯一规范来源。旧版五个顶层 section、
// providerLabels/providerProfiles 仍保留为兼容投影，业务调用链不直接依赖目录形状。
const PROVIDER_REGISTRY_VERSION = 1;
const PROVIDER_CAPABILITY_SLOTS = Object.freeze([
  "face",
  "analysis",
  "image",
  "imageBackup",
  "video"
]);
// 备用视觉/视频模型不改变既有五槽位目录契约；它们通过独立的
// activeBackups 引用同一份服务商档案，避免旧迁移和目录遍历被破坏。
const PROVIDER_BACKUP_SLOTS = Object.freeze([
  "faceBackup",
  "analysisBackup",
  "videoBackup"
]);
const PROVIDER_BACKUP_BASE_SLOTS = Object.freeze({
  faceBackup: "face",
  analysisBackup: "analysis",
  videoBackup: "video"
});
const BUILTIN_PROVIDER_KEYS = Object.freeze(["dashscope", "xingju", "lingyun"]);
const BUILTIN_PROVIDER_IDS = Object.freeze({
  dashscope: "dashscope",
  xingju: "xingju",
  lingyun: "lingyun"
});
const PROVIDER_ID_FALLBACKS = Object.freeze({
  face: "dashscope",
  analysis: "dashscope",
  image: "xingju",
  imageBackup: "lingyun"
});
const PROVIDER_COMMON_KEYS = Object.freeze([
  "baseUrl",
  "apiKey",
  "timeoutMs",
  "enabled",
  "metadata"
]);
const PROVIDER_SLOT_KEYS = Object.freeze({
  face: ["provider", "providerKey", "enabled", "overrideEnabled", "baseUrl", "endpoint", "apiKey", "model", "faceModel", "timeoutMs", "maxImageBytes"],
  analysis: ["provider", "providerKey", "enabled", "overrideEnabled", "baseUrl", "endpoint", "apiKey", "model", "timeoutMs", "maxImageBytes"],
  image: ["provider", "providerKey", "enabled", "overrideEnabled", "baseUrl", "endpoint", "apiKey", "model", "mode", "size", "resolution", "compatibilityMode", "timeoutMs", "maxRetries", "retryEnabled", "retryPreferenceVersion"],
  imageBackup: ["provider", "providerKey", "enabled", "overrideEnabled", "baseUrl", "endpoint", "apiKey", "model", "mode", "size", "resolution", "compatibilityMode", "timeoutMs", "maxRetries", "retryEnabled", "retryPreferenceVersion"],
  video: ["provider", "providerKey", "enabled", "overrideEnabled", "baseUrl", "endpoint", "queryEndpoint", "apiKey", "model", "createPath", "queryPath", "resolution", "aspectRatio", "timeoutMs", "prompt"]
});
const IMAGE_QUALITY_LONG_EDGES = Object.freeze({
  "1K": 1024,
  "2K": 2048,
  "4K": 4096
});
const IMAGE_SIZE_PRESETS = Object.freeze([
  "1080x1440",
  "1242x1660",
  "1080x1920"
]);
const ADMIN_DEPLOYMENT_LOG_COLLECTION = "admin_deployment_logs";
const MODEL_USAGE_EVENT_COLLECTION = "model_usage_events";
const IMAGE_PROVIDER_ATTEMPT_EVENT_COLLECTION = "image_provider_attempt_events";
const IMAGE_PROVIDER_ATTEMPT_MAX_READ = 5000;
const IMAGE_PROVIDER_ATTEMPT_TIME_ZONE = "Asia/Shanghai";
const MODEL_USAGE_TIME_ZONE = "Asia/Shanghai";
const MODEL_USAGE_TYPES = ["image", "analysis", "face", "video"];
const MODEL_PROBE_TYPES = ["face", "analysis", "image", "video"];
const MODEL_USAGE_TYPE_LABELS = {
  image: "生图",
  analysis: "图片分析",
  face: "人脸识别",
  video: "视频"
};
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
const PHOTO_TO_VIDEO_IDLE_CLEANUP_MS = 2 * 60 * 60 * 1000;
const PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE = 100;
const WATERMARK_TRANSFER_TEMP_COLLECTION = "watermark_transfer_temp_assets";
const WATERMARK_TRANSFER_TTL_MS = 2 * 60 * 60 * 1000;
const WATERMARK_TRANSFER_CLEANUP_BATCH_SIZE = 100;
const WATERMARK_TRANSFER_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const WATERMARK_TRANSFER_MAX_VIDEO_BYTES = 110 * 1024 * 1024;
const WATERMARK_TRANSFER_TIMEOUT_MS = 90000;
const WATERMARK_TRANSFER_MAX_REDIRECTS = 3;
const ADMIN_RUNTIME_CACHE_TTL_MS = 15000;
const POINTS_ACCOUNT_COLLECTION = "user_accounts";
const USER_PROFILE_COLLECTION = "user_profiles";
const USER_DIAGNOSTIC_LOG_COLLECTION = "user_diagnostic_logs";
const USER_DIAGNOSTIC_LOG_RETENTION_HOURS = 72;
const USER_DIAGNOSTIC_LOG_RETENTION_MS = (
  USER_DIAGNOSTIC_LOG_RETENTION_HOURS * 60 * 60 * 1000
);
const USER_DIAGNOSTIC_LOG_BATCH_SIZE = 20;
const USER_DIAGNOSTIC_LOG_CLEANUP_BATCH_SIZE = 100;
const USER_DIAGNOSTIC_LOG_MAX_READ = 5000;
const USER_DIAGNOSTIC_LEVELS = new Set(["info", "warn", "error"]);
const PUBLISH_EXPORT_JOB_COLLECTION = "publish_export_jobs";
const PUBLISH_EXPORT_PROCESSING_TIMEOUT_MS = 90 * 1000;
const PUBLISH_EXPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLISH_EXPORT_CLEANUP_BATCH_SIZE = 50;
const PUBLISH_EXPORT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const PUBLISH_EXPORT_MAX_SOURCE_PIXELS = 100 * 1000 * 1000;
const USER_DIAGNOSTIC_CATEGORY_LABELS = Object.freeze({
  app: "应用启动",
  navigation: "页面操作",
  cloud: "云端服务",
  upload: "文件上传",
  "cloud-file": "云文件",
  generation: "生图",
  analysis: "图片分析",
  "auto-face": "自动贴脸",
  video: "视频生成",
  repair: "局部修正",
  records: "作品记录",
  points: "积分签到",
  admin: "管理员",
  diagnostic: "诊断工具",
  export: "导出",
  other: "其他"
});
const ADMIN_USER_DATE_RANGES = new Set(["all", "today", "7d", "30d", "custom"]);
const ADMIN_USER_DATE_RANGE_LABELS = {
  all: "全部",
  today: "今天",
  "7d": "近7天",
  "30d": "近30天",
  custom: "自定义"
};
const ADMIN_USER_GENDERS = new Set(["all", "male", "female"]);
const ADMIN_USER_GENDER_LABELS = {
  all: "全部",
  male: "男性",
  female: "女性"
};
const ADMIN_USER_TREND_DAYS = 7;
const POINTS_LEDGER_COLLECTION = "point_ledger";
const POINTS_RESET_LEDGER_BATCH_SIZE = 100;
const USER_QUOTA_COLLECTION = "user_quotas";
const GENERATION_OPERATION_COLLECTION = "generation_operations";
const POINTS_TIME_ZONE = "Asia/Shanghai";
const GENERATION_OPERATION_STALE_MS = 10 * 60 * 1000;
const GENERATION_QUEUE_BATCH_SIZE = 1;
const GENERATION_QUEUE_STALE_MS = 5 * 60 * 1000;
const GENERATION_PROCESSING_STALE_MS = 10 * 60 * 1000;
const GENERATION_MAX_RECOVERY_ATTEMPTS = 2;
const GENERATION_RECONCILE_BATCH_SIZE = 20;
const GENERATION_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const GENERATION_OPERATION_STATUSES = Object.freeze([
  "reserved",
  "queued",
  "processing",
  "succeeded",
  "failed",
  "refunding",
  "refunded"
]);
const ASSET_UPLOAD_TICKET_COLLECTION = "asset_upload_tickets";
const USER_ASSET_COLLECTION = "user_assets";
const TENCENT_FACEFUSION_STATUS_COLLECTION = "tencent_facefusion_status";
const TENCENT_FACEFUSION_STATUS_ID = "latest";
const TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION = "tencent_facefusion_intermediate_assets";
const TENCENT_FACEFUSION_INTERMEDIATE_TTL_MS = 2 * 60 * 60 * 1000;
const TENCENT_FACEFUSION_INTERMEDIATE_CLEANUP_BATCH_SIZE = 50;
const REPAIR_CHAIN_COLLECTION = "repair_chains";
const REPAIR_MAX_REVISIONS = 10;
const ASSET_TICKET_TTL_MS = 10 * 60 * 1000;
const REPAIR_ASSET_KINDS = new Set(["main", "mask", "face", "wardrobe", "background", "avatar"]);
const REQUIRED_DATABASE_COLLECTIONS = Object.freeze([
  ADMIN_DEPLOYMENT_LOG_COLLECTION,
  ADMIN_CONFIG_AUDIT_LOG_COLLECTION,
  ADMIN_RUNTIME_CONFIG_COLLECTION,
  ASSET_UPLOAD_TICKET_COLLECTION,
  AUTO_FACE_FAILURE_LOG_COLLECTION,
  AUTO_FACE_PROBE_LOG_COLLECTION,
  GENERATION_OPERATION_COLLECTION,
  "generation_records",
  MODEL_USAGE_EVENT_COLLECTION,
  IMAGE_PROVIDER_ATTEMPT_EVENT_COLLECTION,
  PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION,
  WATERMARK_TRANSFER_TEMP_COLLECTION,
  POINTS_LEDGER_COLLECTION,
  PUBLISH_EXPORT_JOB_COLLECTION,
  REPAIR_CHAIN_COLLECTION,
  POINTS_ACCOUNT_COLLECTION,
  USER_PROFILE_COLLECTION,
  USER_DIAGNOSTIC_LOG_COLLECTION,
  USER_ASSET_COLLECTION,
  TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION,
  TENCENT_FACEFUSION_STATUS_COLLECTION,
  USER_QUOTA_COLLECTION
].sort());
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

function resolveFaceConfig(overrides = {}) {
  const source = overrides && overrides.face ? overrides.face : overrides;
  const vision = resolveVisionConfig();
  const model = overrideString(
    source,
    "model",
    vision.faceModel || vision.model || "qwen3-vl-flash"
  );
  return {
    provider: overrideString(source, "provider", vision.provider),
    providerKey: normalizeProviderKey(
      overrideString(source, "providerKey", providerBuiltinKey(vision.provider) || providerStableKey(vision.provider)),
      providerBuiltinKey(vision.provider) || providerStableKey(vision.provider)
    ),
    baseUrl: overrideString(source, "baseUrl", vision.baseUrl),
    endpoint: overrideString(source, "endpoint", vision.endpoint),
    apiKey: normalizeApiKey(overrideString(source, "apiKey", vision.apiKey)),
    model,
    faceModel: model,
    timeoutMs: clampNumber(
      hasOwn(source, "timeoutMs") ? source.timeoutMs : vision.timeoutMs,
      vision.timeoutMs,
      5000,
      60000
    ),
    maxImageBytes: vision.maxImageBytes
  };
}

function resolveAnalysisConfig(overrides = {}) {
  const source = overrides && overrides.analysis ? overrides.analysis : overrides;
  const vision = resolveVisionConfig();
  return {
    provider: overrideString(source, "provider", vision.provider),
    providerKey: normalizeProviderKey(
      overrideString(source, "providerKey", providerBuiltinKey(vision.provider) || providerStableKey(vision.provider)),
      providerBuiltinKey(vision.provider) || providerStableKey(vision.provider)
    ),
    baseUrl: overrideString(source, "baseUrl", vision.baseUrl),
    endpoint: overrideString(source, "endpoint", vision.endpoint),
    apiKey: normalizeApiKey(overrideString(source, "apiKey", vision.apiKey)),
    model: overrideString(source, "model", vision.model || "qwen3-vl-flash"),
    timeoutMs: clampNumber(
      hasOwn(source, "timeoutMs") ? source.timeoutMs : vision.timeoutMs,
      vision.timeoutMs,
      5000,
      60000
    ),
    maxImageBytes: vision.maxImageBytes
  };
}

function providerBackupSource(overrides, section) {
  if (overrides && overrides[section] && typeof overrides[section] === "object") {
    return overrides[section];
  }
  return overrides && typeof overrides === "object" ? overrides : {};
}

function resolveVisionBackupConfig(overrides = {}, runtime, baseSlot = "face") {
  const section = baseSlot === "analysis" ? "analysisBackup" : "faceBackup";
  const source = providerBackupSource(overrides, section);
  const runtimeActive = runtime && runtime.activeBackups
    && runtime.activeBackups[section];
  const sourceWithRuntimeActive = (
    !hasOwn(source, "provider")
    && !hasOwn(source, "providerKey")
    && runtimeActive
  )
    ? Object.assign({}, source, { providerKey: runtimeActive })
    : source;
  const inherited = typeof providerSlotConfigFromRuntime === "function"
    ? providerSlotConfigFromRuntime(
      runtime,
      sourceWithRuntimeActive.providerKey || sourceWithRuntimeActive.provider,
      baseSlot
    )
    : {};
  const envPrefix = baseSlot === "analysis" ? "ANALYSIS" : "FACE";
  const provider = overrideString(
    sourceWithRuntimeActive,
    "provider",
    inherited.provider || firstEnv([`AI_${envPrefix}_BACKUP_PROVIDER`, "AI_VISION_BACKUP_PROVIDER"])
  );
  const providerKey = normalizeProviderKey(
    overrideString(sourceWithRuntimeActive, "providerKey", inherited.providerKey || providerBuiltinKey(provider) || providerStableKey(provider)),
    inherited.providerKey || providerBuiltinKey(provider) || providerStableKey(provider)
  );
  // 目录中的自定义档案不能因为没有自身 Key 就偷偷继承全局视觉备用
  // 环境变量；否则选中一个半成品档案时会误把另一套凭据发给它。
  // 无法解析到 canonical 档案时仍保留旧版直配配置的环境变量兼容。
  const runtimeRegistry = runtime && isProviderObject(runtime.providerRegistry)
    ? normalizeProviderRegistry(runtime.providerRegistry, { includeDefaults: true })
    : null;
  const selectedRecord = runtimeRegistry && providerKey
    ? runtimeRegistry.providers[providerRecordKeyFor(providerKey, runtimeRegistry)]
    : null;
  const customDirectoryRecord = Boolean(
    selectedRecord
    && !selectedRecord.builtIn
    && !providerBuiltinKey(selectedRecord.providerKey || selectedRecord.id)
  );
  const backupEnvApiKey = customDirectoryRecord
    ? ""
    : firstEnv([`AI_${envPrefix}_BACKUP_API_KEY`, "AI_VISION_BACKUP_API_KEY"]);
  const baseUrl = overrideString(
    sourceWithRuntimeActive,
    "baseUrl",
    inherited.baseUrl || firstEnv([`AI_${envPrefix}_BACKUP_BASE_URL`, "AI_VISION_BACKUP_BASE_URL"])
  );
  const endpointValue = overrideString(
    sourceWithRuntimeActive,
    "endpoint",
    inherited.endpoint || firstEnv([`AI_${envPrefix}_BACKUP_ENDPOINT`, "AI_VISION_BACKUP_ENDPOINT"])
  );
  const apiKey = normalizeApiKey(
    overrideString(
      sourceWithRuntimeActive,
      "apiKey",
      inherited.apiKey || backupEnvApiKey
    )
  );
  const model = overrideString(
    sourceWithRuntimeActive,
    "model",
    inherited.model || env(`AI_${envPrefix}_BACKUP_MODEL`, env("AI_VISION_BACKUP_MODEL", ""))
  );
  const timeoutMs = clampNumber(
    hasOwn(sourceWithRuntimeActive, "timeoutMs")
      ? sourceWithRuntimeActive.timeoutMs
      : inherited.timeoutMs || firstEnv([`AI_${envPrefix}_BACKUP_TIMEOUT_MS`, "AI_VISION_BACKUP_TIMEOUT_MS"], "25000"),
    25000,
    5000,
    60000
  );
  const enabled = hasOwn(sourceWithRuntimeActive, "enabled")
    ? overrideBoolean(sourceWithRuntimeActive, "enabled", false)
    : Boolean(provider && model && (baseUrl || endpointValue) && apiKey);
  return {
    enabled,
    provider,
    providerKey,
    baseUrl,
    endpoint: endpointValue,
    apiKey,
    model,
    faceModel: baseSlot === "face" ? model : undefined,
    timeoutMs,
    maxImageBytes: inherited.maxImageBytes || resolveVisionConfig().maxImageBytes,
    configured: Boolean(enabled && provider && (baseUrl || endpointValue) && apiKey && model)
  };
}

function resolveFaceBackupConfig(overrides = {}, runtime) {
  return resolveVisionBackupConfig(overrides, runtime, "face");
}

function resolveAnalysisBackupConfig(overrides = {}, runtime) {
  return resolveVisionBackupConfig(overrides, runtime, "analysis");
}

function visionConfigCandidatesForAction(action, configs = {}) {
  const primary = visionConfigForAction(action, configs);
  const backup = action === "detectFaceCircle"
    ? (configs.faceBackup || resolveFaceBackupConfig({}, configs.runtime))
    : (configs.analysisBackup || resolveAnalysisBackupConfig({}, configs.runtime));
  const candidates = [primary];
  if (
    backup
    && backup.enabled
    && backup.configured
    && backup.providerKey !== primary.providerKey
  ) {
    candidates.push(backup);
  }
  return candidates;
}

function isVisionFallbackError(error) {
  if (!error) return false;
  if (error.retryable !== undefined) return Boolean(error.retryable);
  return DEFAULT_RETRY_STATUSES.has(Number(error.status) || 0);
}

async function runVisionProviderFailover(candidates, request, options = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) throw new Error("没有可用的视觉服务商配置。");
  let lastError = null;
  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index];
    try {
      const response = await request(candidate, index);
      return { response, config: candidate, index };
    } catch (error) {
      lastError = error;
      if (index >= list.length - 1 || !isVisionFallbackError(error)) throw error;
      log("warn", "vision.provider-fallback", {
        requestId: options.requestId || "",
        action: options.action || "",
        fromProvider: candidate.provider || "",
        toProvider: list[index + 1].provider || "",
        fromModel: candidate.model || "",
        toModel: list[index + 1].model || "",
        status: Number(error.status) || 0
      });
    }
  }
  throw lastError || new Error("视觉备用服务商调用失败。");
}

function visionConfigForAction(action, configs = {}) {
  if (action === "analyze" || action === "analyzeWebPoses") {
    return configs.analysis || resolveAnalysisConfig();
  }
  if (action === "detectFaceCircle") {
    return configs.face || resolveFaceConfig();
  }
  return configs.vision || resolveVisionConfig();
}

function buildAutoFaceProbe(faceConfig) {
  const vision = faceConfig || resolveFaceConfig();
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
        vision.model
      ),
      apiKeyConfigured: Boolean(vision.apiKey),
      endpointConfigured: Boolean(vision.endpoint || vision.baseUrl),
      provider: vision.provider || "",
      model: vision.model || ""
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

function normalizeApiKey(value) {
  let normalized = String(value === null || value === undefined ? "" : value).trim();
  for (let index = 0; index < 2; index += 1) {
    if (
      normalized.length >= 2
      && (
        normalized.startsWith('"') && normalized.endsWith('"')
        || normalized.startsWith("'") && normalized.endsWith("'")
      )
    ) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  normalized = normalized
    .replace(/^api[-_\s]?key\s*[:=]\s*/i, "")
    .replace(/^x-api-key\s*[:=]\s*/i, "")
    .replace(/^bearer\s+/i, "")
    .trim();
  return normalized;
}

function apiKeyHeaders(apiKey) {
  const normalized = normalizeApiKey(apiKey);
  if (!normalized) return {};
  return {
    Authorization: `Bearer ${normalized}`,
    "x-api-key": normalized
  };
}

function isGeminiCompatibleVision(meta = {}) {
  const provider = String(meta.provider || "").trim().toLowerCase();
  if (
    provider === "gemini"
    || provider === "google"
    || provider === "google-gemini"
    || provider === "google-ai"
    || provider === "google ai"
  ) {
    return true;
  }
  return [
    meta.baseUrl,
    meta.endpoint,
    meta.url
  ].some((value) => /generativelanguage\.googleapis\.com/i.test(String(value || "")));
}

function sanitizeVisionRequestPayload(payload, meta = {}) {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !isGeminiCompatibleVision(meta)
  ) {
    return payload;
  }
  const sanitized = Object.assign({}, payload);
  // Gemini 的 OpenAI-compatible 接口不接受 DashScope 专用字段。
  delete sanitized.seed;
  delete sanitized.enable_thinking;
  return sanitized;
}

function overrideBoolean(overrides, key, fallback) {
  if (!overrides || !Object.prototype.hasOwnProperty.call(overrides, key)) return fallback;
  const value = overrides[key];
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function imageRetryPreferenceVersion(image) {
  return Number(image && image.retryPreferenceVersion) === IMAGE_RETRY_PREFERENCE_VERSION
    ? IMAGE_RETRY_PREFERENCE_VERSION
    : 0;
}

function resolveImageRetryEnabled(image) {
  if (
    image
    && Object.prototype.hasOwnProperty.call(image, "retryEnabled")
    && imageRetryPreferenceVersion(image) === 0
  ) {
    // 旧版本曾经把默认值写成 false。没有新版本标记的记录一律按新默认值开启，
    // 新版管理员保存后会写入 retryPreferenceVersion，用户手动关闭才能保持 false。
    return true;
  }
  return overrideBoolean(image, "retryEnabled", imageRetryEnabled());
}

function resolveImageConfig(overrides = {}) {
  const image = overrides && overrides.image ? overrides.image : overrides;
  const mode = overrideString(
    image,
    "mode",
    firstEnv(["AI_IMAGE_PRIMARY_MODE", "AI_IMAGE_MODE"], DEFAULT_IMAGE_MODE)
  ).toLowerCase();
  const size = overrideString(image, "size", env("AI_IMAGE_SIZE", "1024x1024"));
  const resolution = hasOwn(image, "resolution")
    ? normalizeImageResolution(image.resolution, normalizeImageResolution(size, "1K"))
    : normalizeImageResolution(size, "1K");
  return {
    provider: overrideString(
      image,
      "provider",
      firstEnv(["AI_IMAGE_PRIMARY_PROVIDER"], "xingju")
    ),
    providerKey: normalizeProviderKey(
      overrideString(image, "providerKey", providerBuiltinKey(image && image.provider) || providerStableKey(image && image.provider || "xingju")),
      providerBuiltinKey(image && image.provider) || providerStableKey(image && image.provider || "xingju")
    ),
    baseUrl: overrideString(image, "baseUrl", firstEnv(
      ["AI_IMAGE_PRIMARY_BASE_URL"],
      "https://newapi.akiyo.fun/v1"
    )),
    endpoint: overrideString(image, "endpoint", firstEnv([
      "AI_IMAGE_PRIMARY_ENDPOINT"
    ])),
    apiKey: normalizeApiKey(
      overrideString(image, "apiKey", firstEnv(["AI_IMAGE_PRIMARY_API_KEY"]))
    ),
    model: overrideString(
      image,
      "model",
      firstEnv(["AI_IMAGE_PRIMARY_MODEL"], "jw-wy-gpt-image-2")
    ),
    size,
    resolution,
    legacySizeOnly: !hasOwn(image, "resolution"),
    compatibilityMode: overrideBoolean(image, "compatibilityMode", false),
    mode,
    timeoutMs: clampNumber(
      image && Object.prototype.hasOwnProperty.call(image, "timeoutMs")
        ? image.timeoutMs
        : firstEnv(["AI_IMAGE_PRIMARY_TIMEOUT_MS"], "150000"),
      150000,
      5000,
      180000
    ),
    maxRetries: clampNumber(
      image && Object.prototype.hasOwnProperty.call(image, "maxRetries")
        ? image.maxRetries
        : firstEnv(["AI_IMAGE_PRIMARY_MAX_RETRIES"], "1"),
      1,
      0,
      5
    ),
    retryEnabled: resolveImageRetryEnabled(image),
    retryPreferenceVersion: imageRetryPreferenceVersion(image)
  };
}

function resolveImageBackupConfig(overrides = {}) {
  const image = overrides && overrides.imageBackup
    ? overrides.imageBackup
    : overrides && overrides.image
      ? overrides.image
      : overrides;
  const mode = overrideString(
    image,
    "mode",
    firstEnv(["AI_IMAGE_BACKUP_MODE", "AI_IMAGE_MODE"], DEFAULT_IMAGE_MODE)
  ).toLowerCase();
  const size = overrideString(image, "size", env("AI_IMAGE_SIZE", "1024x1024"));
  const resolution = hasOwn(image, "resolution")
    ? normalizeImageResolution(image.resolution, normalizeImageResolution(size, "1K"))
    : normalizeImageResolution(size, "1K");
  const provider = overrideString(
    image,
    "provider",
    firstEnv(
      ["AI_IMAGE_BACKUP_PROVIDER", "AI_IMAGE_PROVIDER", "AI_PROVIDER"],
      "lingyun"
    )
  );
  const baseUrl = overrideString(image, "baseUrl", firstEnv(
    ["AI_IMAGE_BACKUP_BASE_URL", "AI_IMAGE_BASE_URL", "AI_BASE_URL"],
    "https://api.lingyunapi.xyz/v1"
  ));
  const endpoint = overrideString(image, "endpoint", firstEnv([
    "AI_IMAGE_BACKUP_ENDPOINT",
    "AI_IMAGE_EDIT_ENDPOINT",
    "AI_IMAGE_ENDPOINT"
  ]));
  const apiKey = normalizeApiKey(
    overrideString(image, "apiKey", firstEnv(["AI_IMAGE_BACKUP_API_KEY"]))
  );
  const model = overrideString(
    image,
    "model",
    firstEnv(["AI_IMAGE_BACKUP_MODEL", "AI_IMAGE_MODEL"], "gpt-image-2")
  );
  const enabled = hasOwn(image, "enabled")
    ? overrideBoolean(image, "enabled", false)
    : Boolean(apiKey && provider && model && (baseUrl || endpoint));
  return {
    enabled,
    provider,
    providerKey: normalizeProviderKey(
      overrideString(
        image,
        "providerKey",
        providerBuiltinKey(provider) || providerStableKey(provider || "lingyun")
      ),
      providerBuiltinKey(provider) || providerStableKey(provider || "lingyun")
    ),
    baseUrl,
    endpoint,
    apiKey,
    model,
    size,
    resolution,
    legacySizeOnly: !hasOwn(image, "resolution"),
    compatibilityMode: overrideBoolean(image, "compatibilityMode", false),
    mode,
    timeoutMs: clampNumber(
      image && Object.prototype.hasOwnProperty.call(image, "timeoutMs")
        ? image.timeoutMs
        : firstEnv(["AI_IMAGE_BACKUP_TIMEOUT_MS", "AI_IMAGE_TIMEOUT_MS"], "150000"),
      150000,
      5000,
      180000
    ),
    maxRetries: 0,
    retryEnabled: false,
    retryPreferenceVersion: IMAGE_RETRY_PREFERENCE_VERSION
  };
}

function resolveTencentFaceFusionConfig(overrides = {}) {
  const source = overrides && overrides.tencentFaceFusion
    ? overrides.tencentFaceFusion
    : overrides;
  const swapModelType = clampNumber(
    hasOwn(source, "swapModelType")
      ? source.swapModelType
      : env("TENCENT_FACEFUSION_SWAP_MODEL_TYPE", "4"),
    4,
    1,
    9
  );
  return {
    secretId: overrideString(
      source,
      "secretId",
      firstEnv(["TENCENT_FACEFUSION_SECRET_ID"])
    ),
    secretKey: overrideString(
      source,
      "secretKey",
      firstEnv(["TENCENT_FACEFUSION_SECRET_KEY"])
    ),
    region: overrideString(
      source,
      "region",
      env("TENCENT_FACEFUSION_REGION", "ap-guangzhou")
    ),
    swapModelType: Math.round(swapModelType),
    logoAdd: overrideBoolean(
      source,
      "logoAdd",
      boolEnv("TENCENT_FACEFUSION_LOGO_ADD", false)
    ),
    timeoutMs: clampNumber(
      hasOwn(source, "timeoutMs")
        ? source.timeoutMs
        : env("TENCENT_FACEFUSION_TIMEOUT_MS", "75000"),
      75000,
      5000,
      120000
    ),
    maxImageBytes: clampNumber(
      hasOwn(source, "maxImageBytes")
        ? source.maxImageBytes
        : env(
          "TENCENT_FACEFUSION_MAX_IMAGE_BYTES",
          String(5 * 1024 * 1024)
        ),
      5 * 1024 * 1024,
      256 * 1024,
      8 * 1024 * 1024
    ),
    endpoint: overrideString(
      source,
      "endpoint",
      env(
        "TENCENT_FACEFUSION_ENDPOINT",
        "https://facefusion.tencentcloudapi.com"
      )
    ),
    apiVersion: overrideString(
      source,
      "apiVersion",
      env("TENCENT_FACEFUSION_API_VERSION", "2022-09-27")
    ),
    action: overrideString(
      source,
      "action",
      env("TENCENT_FACEFUSION_ACTION", "FuseFaceUltra")
    ),
    model: overrideString(
      source,
      "model",
      env("TENCENT_FACEFUSION_MODEL", "FuseFaceUltra")
    ),
    configured: Boolean(
      overrideString(
        source,
        "secretId",
        firstEnv(["TENCENT_FACEFUSION_SECRET_ID"])
      )
      && overrideString(
        source,
        "secretKey",
        firstEnv(["TENCENT_FACEFUSION_SECRET_KEY"])
      )
    )
  };
}

function resolveVideoConfig(overrides = {}) {
  const video = overrides && overrides.video ? overrides.video : overrides;
  const provider = overrideString(video, "provider", firstEnv(["AI_VIDEO_PROVIDER"]));
  const baseUrl = overrideString(video, "baseUrl", firstEnv(["AI_VIDEO_BASE_URL"]));
  const endpointValue = overrideString(video, "endpoint", env("AI_VIDEO_ENDPOINT"));
  const apiKey = normalizeApiKey(
    overrideString(video, "apiKey", firstEnv(["AI_VIDEO_API_KEY", "AI_VIDEO_KEY"]))
  );
  const model = overrideString(video, "model", env("AI_VIDEO_MODEL", "grok-imagine-video-1.5"));
  return {
    provider,
    providerKey: normalizeProviderKey(
      overrideString(video, "providerKey", providerBuiltinKey(provider) || providerStableKey(provider)),
      providerBuiltinKey(provider) || providerStableKey(provider)
    ),
    baseUrl,
    endpoint: endpointValue,
    queryEndpoint: overrideString(video, "queryEndpoint", env("AI_VIDEO_QUERY_ENDPOINT")),
    apiKey,
    model,
    createPath: overrideString(video, "createPath", env("AI_VIDEO_CREATE_PATH", "/v1/videos/generations")),
    queryPath: overrideString(video, "queryPath", env("AI_VIDEO_QUERY_PATH", "/v1/videos/{taskId}")),
    resolution: normalizeVideoResolution(
      overrideString(video, "resolution", env("AI_VIDEO_RESOLUTION", "720p")),
      "720p"
    ),
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
    configured: Boolean(provider && (baseUrl || endpointValue) && apiKey && model)
  };
}

function resolveVideoBackupConfig(overrides = {}) {
  const video = overrides && overrides.videoBackup
    ? overrides.videoBackup
    : overrides;
  const provider = overrideString(
    video,
    "provider",
    firstEnv(["AI_VIDEO_BACKUP_PROVIDER"])
  );
  const baseUrl = overrideString(
    video,
    "baseUrl",
    firstEnv(["AI_VIDEO_BACKUP_BASE_URL"])
  );
  const endpointValue = overrideString(
    video,
    "endpoint",
    env("AI_VIDEO_BACKUP_ENDPOINT")
  );
  const apiKey = normalizeApiKey(
    overrideString(
      video,
      "apiKey",
      firstEnv(["AI_VIDEO_BACKUP_API_KEY"])
    )
  );
  const model = overrideString(
    video,
    "model",
    env("AI_VIDEO_BACKUP_MODEL", "")
  );
  const enabled = hasOwn(video, "enabled")
    ? overrideBoolean(video, "enabled", false)
    : Boolean(provider || firstEnv(["AI_VIDEO_BACKUP_PROVIDER"]));
  return {
    enabled,
    provider,
    // 备用视频同样属于目录档案引用；保留稳定 providerKey，避免外部
    // ID 改名后管理页和执行内核只能靠字符串猜测当前档案。
    providerKey: normalizeProviderKey(
      overrideString(
        video,
        "providerKey",
        providerBuiltinKey(provider) || providerStableKey(provider)
      ),
      providerBuiltinKey(provider) || providerStableKey(provider)
    ),
    baseUrl,
    endpoint: endpointValue,
    queryEndpoint: overrideString(
      video,
      "queryEndpoint",
      env("AI_VIDEO_BACKUP_QUERY_ENDPOINT")
    ),
    apiKey,
    model,
    createPath: overrideString(
      video,
      "createPath",
      env("AI_VIDEO_BACKUP_CREATE_PATH", "/v1/videos/generations")
    ),
    queryPath: overrideString(
      video,
      "queryPath",
      env("AI_VIDEO_BACKUP_QUERY_PATH", "/v1/videos/{taskId}")
    ),
    resolution: normalizeVideoResolution(
      overrideString(video, "resolution", env("AI_VIDEO_BACKUP_RESOLUTION", "720p")),
      "720p"
    ),
    aspectRatio: overrideString(
      video,
      "aspectRatio",
      env("AI_VIDEO_BACKUP_ASPECT_RATIO", "")
    ),
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
            : env("AI_VIDEO_BACKUP_TIMEOUT_MS", "90000")
        ) || 90000
      )
    ),
    configured: Boolean(
      enabled
      && provider
      && (baseUrl || endpointValue)
      && apiKey
      && model
    )
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
      env("PROMO_START_DATE", "2026-08-24")
    ),
    promoEndDate: overrideString(
      points,
      "promoEndDate",
      env("PROMO_END_DATE", "2026-08-25")
    ),
    timeZone: overrideString(points, "timeZone", POINTS_TIME_ZONE)
  };
}

function normalizeImageCostProvider(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (
    text === "xingju"
    || text === "星炬"
    || text.includes("akiyo.fun")
  ) {
    return "xingju";
  }
  if (
    text === "lingyun"
    || text === "凌云"
    || text.includes("lingyunapi")
  ) {
    return "lingyun";
  }
  return text;
}

function resolveImagePriceTable(source, defaults) {
  const values = source && typeof source === "object" ? source : {};
  return IMAGE_COST_RESOLUTIONS.reduce((result, resolution) => {
    result[resolution] = clampNumber(
      values[resolution],
      defaults[resolution],
      0,
      100000
    );
    return result;
  }, {});
}

function imageProviderPriceTable(costs, provider) {
  const image = costs && costs.image && typeof costs.image === "object"
    ? costs.image
    : {};
  const providerKey = normalizeImageCostProvider(provider);
  const providers = image.providers && typeof image.providers === "object"
    ? image.providers
    : {};
  const matchedProviderKey = Object.keys(providers).find((key) => (
    String(key).toLowerCase() === String(providerKey).toLowerCase()
      || normalizeImageCostProvider(key) === providerKey
  ));
  const providerCosts = matchedProviderKey && providers[matchedProviderKey]
    && typeof providers[matchedProviderKey] === "object"
    ? providers[matchedProviderKey]
    : {};
  const providerPrices = providerCosts.perImage && typeof providerCosts.perImage === "object"
    ? providerCosts.perImage
    : null;
  return {
    provider: providerKey,
    perImage: providerPrices || image.perImage || {}
  };
}

function resolveCostConfig(overrides = {}, options = {}) {
  const costs = overrides && overrides.costs ? overrides.costs : overrides;
  const face = costs && costs.face ? costs.face : {};
  const analysis = costs && costs.analysis ? costs.analysis : {};
  const image = costs && costs.image ? costs.image : {};
  const video = costs && costs.video ? costs.video : {};
  const legacyImagePrices = image.perImage && typeof image.perImage === "object"
    ? image.perImage
    : {};
  const imageProviders = image.providers && typeof image.providers === "object"
    ? image.providers
    : {};
  const hasProviderPricing = Object.keys(imageProviders).length > 0;
  const xingjuSource = imageProviders.xingju && typeof imageProviders.xingju === "object"
    ? imageProviders.xingju
    : {};
  const lingyunSource = imageProviders.lingyun && typeof imageProviders.lingyun === "object"
    ? imageProviders.lingyun
    : {};
  const xingjuPrices = resolveImagePriceTable(
    xingjuSource.perImage,
    XINGJU_IMAGE_PRICES_CNY
  );
  const lingyunPrices = resolveImagePriceTable(
    lingyunSource.perImage || (
      hasProviderPricing
        ? null
        : legacyImagePrices
    ),
    LINGYUN_IMAGE_PRICES_CNY
  );
  const primaryImageProvider = normalizeImageCostProvider(
    options.imageProvider || image.primaryProvider || "xingju"
  ) || "xingju";
  const primaryImagePrices = primaryImageProvider === "lingyun"
    ? lingyunPrices
    : primaryImageProvider === "xingju"
      ? xingjuPrices
      : resolveImagePriceTable(legacyImagePrices, xingjuPrices);
  // 自定义服务商成本按外部 ID 原样保留；旧管理页只认识星炬/凌云，
  // 但通用计费链需要能够按当前 provider 读取这些额外价格表。
  const customImageProviders = {};
  Object.keys(imageProviders).forEach((providerId) => {
    const normalizedProviderId = normalizeImageCostProvider(providerId);
    if (!normalizedProviderId || ["xingju", "lingyun"].includes(normalizedProviderId)) return;
    const source = imageProviders[providerId] && typeof imageProviders[providerId] === "object"
      ? imageProviders[providerId]
      : {};
    customImageProviders[providerId] = {
      perImage: resolveImagePriceTable(
        source.perImage,
        primaryImagePrices
      )
    };
  });
  const videoPrices = video.perSecond && typeof video.perSecond === "object"
    ? video.perSecond
    : {};
  const faceInputPerMillionTokens = clampNumber(
    face.inputPerMillionTokens,
    0.15,
    0,
    100000
  );
  const faceOutputPerMillionTokens = clampNumber(
    face.outputPerMillionTokens,
    1.5,
    0,
    100000
  );
  return {
    currency: "CNY",
    version: MODEL_COST_CONFIG_VERSION,
    face: {
      inputPerMillionTokens: faceInputPerMillionTokens,
      outputPerMillionTokens: faceOutputPerMillionTokens
    },
    analysis: {
      inputPerMillionTokens: clampNumber(
        analysis.inputPerMillionTokens,
        faceInputPerMillionTokens,
        0,
        100000
      ),
      outputPerMillionTokens: clampNumber(
        analysis.outputPerMillionTokens,
        faceOutputPerMillionTokens,
        0,
        100000
      )
    },
    image: {
      defaultResolution: normalizeImageResolution(
        image.defaultResolution,
        "1K"
      ),
      primaryProvider: primaryImageProvider,
      // 兼容旧版管理页：始终返回当前主模型的价格。
      perImage: Object.assign({}, primaryImagePrices),
      providers: {
        xingju: {
          perImage: Object.assign({}, xingjuPrices)
        },
        lingyun: {
          perImage: Object.assign({}, lingyunPrices)
        },
        ...customImageProviders
      }
    },
    video: {
      defaultResolution: normalizeVideoResolution(
        video.defaultResolution,
        "720p"
      ),
      perSecond: {
        "480p": clampNumber(
          videoPrices["480p"],
          LINGYUN_VIDEO_PRICES_CNY["480p"],
          0,
          100000
        ),
        "720p": clampNumber(
          videoPrices["720p"],
          LINGYUN_VIDEO_PRICES_CNY["720p"],
          0,
          100000
        ),
        "1080p": clampNumber(
          videoPrices["1080p"],
          LINGYUN_VIDEO_PRICES_CNY["1080p"],
          0,
          100000
        )
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

function parseImageSize(value) {
  const match = String(value || "")
    .trim()
    .toLowerCase()
    .match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    return null;
  }
  return { width, height };
}

function imageSizePreset(value) {
  const dimensions = parseImageSize(value);
  if (!dimensions) return "";
  const normalized = `${dimensions.width}x${dimensions.height}`;
  return IMAGE_SIZE_PRESETS.includes(normalized)
    ? normalized
    : "";
}

function normalizeImageSizePreset(value, fallback = IMAGE_SIZE_PRESETS[0]) {
  const direct = imageSizePreset(value);
  if (direct) return direct;
  const dimensions = parseImageSize(value);
  if (!dimensions) return imageSizePreset(fallback) || IMAGE_SIZE_PRESETS[0];
  const sourceRatio = dimensions.width / dimensions.height;
  let best = IMAGE_SIZE_PRESETS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  IMAGE_SIZE_PRESETS.forEach((preset) => {
    const presetDimensions = parseImageSize(preset);
    const distance = Math.abs(sourceRatio - presetDimensions.width / presetDimensions.height);
    if (distance < bestDistance) {
      best = preset;
      bestDistance = distance;
    }
  });
  return best;
}

function buildImageOutputSize(resolution, sizePreset) {
  const normalizedResolution = normalizeImageResolution(resolution, "1K");
  const preset = normalizeImageSizePreset(sizePreset);
  const dimensions = parseImageSize(preset);
  const longEdge = IMAGE_QUALITY_LONG_EDGES[normalizedResolution]
    || IMAGE_QUALITY_LONG_EDGES["1K"];
  const sourceLongEdge = Math.max(dimensions.width, dimensions.height);
  const scale = longEdge / sourceLongEdge;
  const roundEven = (value) => Math.max(2, Math.round(value / 2) * 2);
  return `${roundEven(dimensions.width * scale)}x${roundEven(dimensions.height * scale)}`;
}

function resolveImageOutputSize(imageConfig = {}, requestedSize = "") {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const rawSize = String(config.size || requestedSize || "").trim();
  const dimensions = parseImageSize(rawSize);
  if (!dimensions) {
    return rawSize || buildImageOutputSize(config.resolution, IMAGE_SIZE_PRESETS[0]);
  }
  if (config.legacySizeOnly || !imageSizePreset(rawSize)) {
    return `${dimensions.width}x${dimensions.height}`;
  }
  return buildImageOutputSize(config.resolution, rawSize);
}

function buildImageGenerationPayload(payload = {}, imageConfig = resolveImageConfig()) {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const prompt = `${String(payload.prompt || "").trim()}${
    payload.negativePrompt ? `\n\n负面约束：${String(payload.negativePrompt).trim()}` : ""
  }`;
  const result = {
    model: String(config.model || payload.model || "").trim(),
    prompt,
    size: resolveImageOutputSize(config, payload.size),
    n: 1
  };
  if (!config.compatibilityMode) result.quality = "auto";
  return result;
}

function buildImageEditFields(payload = {}, imageConfig = resolveImageConfig(), references = []) {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const prompt = `${String(payload.prompt || "").trim()}${
    payload.negativePrompt ? `\n\n负面约束：${String(payload.negativePrompt).trim()}` : ""
  }`;
  const fields = [
    { name: "model", value: String(config.model || "").trim() },
    { name: "prompt", value: prompt },
    {
      name: "size",
      value: resolveImageOutputSize(config, payload.size)
    },
    {
      name: "reference_manifest",
      value: JSON.stringify((Array.isArray(references) ? references : []).map((item) => ({
        role: item.role,
        index: item.index
      })))
    }
  ];
  if (!config.compatibilityMode) {
    fields.splice(3, 0, { name: "quality", value: "auto" });
  }
  if (payload.n) fields.push({ name: "n", value: String(payload.n) });
  return fields;
}

function isLingyunImageProvider(imageConfig = {}, requestUrl = "") {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const provider = String(config.provider || "").trim().toLowerCase();
  if (provider === "lingyun" || provider === "凌云") return true;
  return [requestUrl, config.baseUrl, config.endpoint].some((value) => {
    try {
      const hostname = new URL(String(value || "")).hostname.toLowerCase();
      return hostname === "lingyunapi.xyz" || hostname.endsWith(".lingyunapi.xyz");
    } catch (_) {
      return false;
    }
  });
}

function isXingjuImageProvider(imageConfig = {}, requestUrl = "") {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const provider = pixelProtectionFlow.normalizedProvider(config.provider);
  if (provider === "xingju" || provider === "星炬") return true;
  return [requestUrl, config.baseUrl, config.endpoint].some((value) => {
    try {
      const hostname = new URL(String(value || "")).hostname.toLowerCase();
      return hostname === "newapi.akiyo.fun" || hostname.endsWith(".akiyo.fun");
    } catch (_) {
      return false;
    }
  });
}

function imageEditJsonRequestFormat(imageConfig = {}, requestUrl = "") {
  if (isXingjuImageProvider(imageConfig, requestUrl)) return "xingju-json";
  if (isLingyunImageProvider(imageConfig, requestUrl)) return "lingyun-json";
  return "";
}

function resolveLingyunImageResponseFormat() {
  const configured = env("AI_LINGYUN_RESPONSE_FORMAT", "b64_json")
    .trim()
    .toLowerCase();
  return configured === "url" ? "url" : "b64_json";
}

function resolveImageEditJsonResponseFormat(imageConfig = {}, requestUrl = "") {
  return isXingjuImageProvider(imageConfig, requestUrl)
    ? "b64_json"
    : resolveLingyunImageResponseFormat();
}

function buildImageEditJsonPayload(
  payload = {},
  imageConfig = resolveImageConfig(),
  mainBuffer,
  maskBuffer = null,
  referenceBuffers = [],
  requestUrl = ""
) {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  const prompt = `${String(payload.prompt || "").trim()}${
    payload.negativePrompt ? `\n\n负面约束：${String(payload.negativePrompt).trim()}` : ""
  }`;
  const images = [mainBuffer]
    .concat((Array.isArray(referenceBuffers) ? referenceBuffers : []).map(
      (item) => item && item.buffer ? item.buffer : item
    ))
    .filter((buffer) => Buffer.isBuffer(buffer) && buffer.length)
    .map((buffer) => ({
      image_url: toDataUrl(buffer, detectMime(buffer))
    }));
  const result = {
    model: String(config.model || payload.model || "").trim(),
    prompt,
    size: resolveImageOutputSize(config, payload.size),
    quality: "auto",
    n: Math.max(1, Number(payload.n) || 1),
    background: "auto",
    response_format: resolveImageEditJsonResponseFormat(config, requestUrl),
    output_format: "png",
    images
  };
  if (Buffer.isBuffer(maskBuffer) && maskBuffer.length) {
    result.mask = {
      image_url: toDataUrl(maskBuffer, detectMime(maskBuffer))
    };
  }
  return result;
}

function buildLingyunImageEditPayload(
  payload = {},
  imageConfig = resolveImageConfig(),
  mainBuffer,
  maskBuffer = null,
  referenceBuffers = []
) {
  return buildImageEditJsonPayload(
    payload,
    imageConfig,
    mainBuffer,
    maskBuffer,
    referenceBuffers
  );
}

function imageEditJsonSummary(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const images = Array.isArray(source.images) ? source.images : [];
  const hasMask = Boolean(source.mask && source.mask.image_url);
  return {
    textFields: [
      "model",
      "prompt",
      "size",
      "quality",
      "n",
      "background",
      "response_format",
      "output_format"
    ],
    fileFields: [
      ...(images.length ? ["images[].image_url"] : []),
      ...(hasMask ? ["mask.image_url"] : [])
    ],
    hasMainImage: Boolean(images[0] && images[0].image_url),
    hasMask,
    referenceCount: Math.max(0, images.length - 1)
  };
}

function hasFileID(value) {
  return Boolean(String(value || "").trim());
}

function hasFileIDList(value) {
  return Array.isArray(value) && value.some((item) => hasFileID(item));
}

function hasImageEditAssets(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  return Boolean(
    hasFileID(source.mainFileID)
    || hasFileID(source.maskFileID)
    || hasFileID(source.identityFileID)
    || hasFileIDList(source.faceFileIDs)
    || hasFileIDList(source.wardrobeFileIDs)
    || hasFileIDList(source.backgroundFileIDs)
  );
}

function resolveGenerationMode(payload = {}, imageConfig = {}) {
  // 主图、mask 或任意参考素材一旦出现，就只能走多图编辑。
  // 不能让旧客户端或管理员的 generations 配置把素材静默丢掉。
  if (hasImageEditAssets(payload)) return "edits";
  const requested = String(payload.mode || "").trim().toLowerCase();
  if (requested === "generations" || requested === "edits") return requested;
  const configured = String(imageConfig.mode || "").trim().toLowerCase();
  return configured === "edits" ? "edits" : "generations";
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

function normalizeCapabilityValues(type, values) {
  const source = Array.isArray(values) ? values : [values];
  const normalized = [];
  source.forEach((value) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      normalized.push(...normalizeCapabilityValues(type, value));
      return;
    }
    if (typeof value === "object") {
      Object.keys(value).forEach((key) => {
        const flag = value[key];
        if (typeof flag === "boolean") {
          if (flag) normalized.push(...normalizeCapabilityValues(type, key));
          return;
        }
        normalized.push(...normalizeCapabilityValues(type, flag));
      });
      return;
    }
    const text = String(value);
    if (type === "image") {
      const matches = text.match(/(?:1|2|4)\s*K\b|\b\d{3,5}\s*[x×]\s*\d{3,5}\b/ig) || [];
      matches.forEach((item) => {
        const resolution = normalizeImageResolution(item, "");
        if (resolution) normalized.push(resolution);
      });
    } else if (type === "video") {
      const matches = text.match(/\b(?:480|720|1080)\s*p?\b/ig) || [];
      matches.forEach((item) => {
        const resolution = normalizeVideoResolution(item, "");
        if (resolution) normalized.push(resolution);
      });
    }
  });
  const order = type === "image" ? ["1K", "2K", "4K"] : ["480p", "720p", "1080p"];
  return order.filter((item) => normalized.includes(item));
}

function upstreamCapabilityValues(type, payload, modelEntry) {
  const keys = [
    "capabilities",
    "supported_capabilities",
    "resolutions",
    "resolution",
    "qualities",
    "quality",
    "supported_resolutions",
    "supported_qualities",
    "supported_sizes",
    "sizes",
    "size"
  ];
  const candidates = [];
  [modelEntry, payload].forEach((source) => {
    if (!source || typeof source !== "object") return;
    keys.forEach((key) => {
      if (hasOwn(source, key)) candidates.push(source[key]);
    });
  });
  return normalizeCapabilityValues(type, candidates);
}

function knownModelCapabilityValues(type, modelConfig = {}) {
  const model = String(modelConfig.model || "").trim().toLowerCase();
  const provider = String(modelConfig.provider || "").trim().toLowerCase();
  if (type === "image" && (
    model === "image2超分高质量1-4k".toLowerCase()
    || /image2.*(?:1-4k|超分)/i.test(model)
    || provider === "pandatk"
    || provider === "panda"
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

function modelCapabilities(type, modelConfig = {}, payload = {}, modelEntry = null) {
  const upstream = upstreamCapabilityValues(type, payload, modelEntry);
  if (upstream.length) {
    return {
      source: "upstream",
      resolutions: upstream
    };
  }
  const known = knownModelCapabilityValues(type, modelConfig);
  if (known.length) {
    return {
      source: "known-model-rule",
      resolutions: known
    };
  }
  return {
    source: "custom",
    resolutions: []
  };
}

function buildImageQualityProbe(modelConfig = {}, capabilities = {}) {
  const source = capabilities && capabilities.source
    ? String(capabilities.source)
    : "custom";
  const resolutions = Array.isArray(capabilities && capabilities.resolutions)
    ? capabilities.resolutions
    : [];
  const supported = new Set(resolutions.map((item) => normalizeImageResolution(item, "")));
  const known = source === "upstream" || source === "known-model-rule";
  const values = ["1K", "2K", "4K"].map((value) => {
    const isSupported = supported.has(value);
    return {
      value,
      status: known ? (isSupported ? "supported" : "unsupported") : "unknown",
      supported: known ? isSupported : null,
      statusText: known ? (isSupported ? "支持" : "不支持") : "未识别"
    };
  });
  const supportedValues = values
    .filter((item) => item.supported === true)
    .map((item) => item.value);
  const status = !known
    ? "unknown"
    : supportedValues.length === values.length
      ? "ok"
      : supportedValues.length
        ? "partial"
        : "unsupported";
  return {
    type: "image-quality",
    method: "model-metadata",
    safe: true,
    noGeneration: true,
    source,
    status,
    statusText: status === "ok"
      ? "1K、2K、4K 全部支持"
      : status === "partial"
        ? `支持：${supportedValues.join("、")}`
        : status === "unsupported"
          ? "未发现可用清晰度"
          : "上游没有返回清晰度能力",
    model: String(modelConfig.model || ""),
    checkedAt: new Date().toISOString(),
    values
  };
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
  if (usageType === "face" || usageType === "analysis") {
    const usage = extractModelUsage(payload);
    if (usage.inputTokens === null || usage.outputTokens === null) return base;
    const tokenCosts = usageType === "analysis" ? costs.analysis : costs.face;
    const inputCost = roundCost(
      usage.inputTokens / 1000000 * tokenCosts.inputPerMillionTokens
    );
    const outputCost = roundCost(
      usage.outputTokens / 1000000 * tokenCosts.outputPerMillionTokens
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
    const providerPricing = imageProviderPriceTable(costs, meta.provider);
    if (meta.success === false) {
      return Object.assign(base, {
        imageResolution: resolution,
        costBreakdown: {
          provider: providerPricing.provider,
          resolution,
          unitPrice: 0,
          quantity: 0
        }
      });
    }
    const unitPrice = providerPricing.perImage[resolution];
    return Object.assign(base, {
      billingSource: "estimated",
      imageResolution: resolution,
      unitPrice,
      estimatedCost: roundCost(unitPrice),
      costBreakdown: {
        provider: providerPricing.provider,
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
    baseUrl: vision.baseUrl || "",
    endpoint: vision.endpoint || "",
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
  return boolEnv("AI_IMAGE_RETRY_ENABLED", true);
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

function resolveImageEditEndpoint(imageConfig = {}) {
  const configured = String(imageConfig && imageConfig.endpoint || "").trim();
  if (configured) {
    return {
      url: configured,
      source: "imageConfig.endpoint",
      configured: true
    };
  }
  const baseUrl = String(imageConfig && imageConfig.baseUrl || "").trim();
  if (!baseUrl) {
    const error = new Error("未配置图片编辑 endpoint 或 AI_IMAGE_BASE_URL。");
    error.code = "image-edit-endpoint-invalid";
    error.retryable = false;
    throw error;
  }
  try {
    return {
      url: endpoint(baseUrl, "images/edits"),
      source: "AI_IMAGE_BASE_URL/images/edits",
      configured: false
    };
  } catch (error) {
    error.code = "image-edit-endpoint-invalid";
    error.retryable = false;
    throw error;
  }
}

function safeEndpointUrl(baseUrl, configured, path) {
  try {
    return safeUrl(configured || endpoint(baseUrl, path));
  } catch (_) {
    return "";
  }
}

function imageEditResponseDetails(response = {}) {
  const payload = response && response.json && typeof response.json === "object"
    ? response.json
    : {};
  const nestedError = payload && payload.error && typeof payload.error === "object"
    ? payload.error
    : {};
  const upstreamCode = String(
    nestedError.code
      || nestedError.type
      || payload.code
      || payload.error_code
      || ""
  ).trim();
  const message = String(
    nestedError.message
      || payload.message
      || (response && response.raw)
      || ""
  ).trim();
  return {
    status: Math.max(0, Number(response && response.status) || 0),
    upstreamCode,
    message,
    searchText: `${upstreamCode} ${message}`.toLowerCase()
  };
}

function classifyImageEditResponse(response = {}) {
  const details = imageEditResponseDetails(response);
  const text = details.searchText;
  const endpointInvalid = (
    details.status === 404
    || details.status === 405
    || /(?:endpoint|route|path).*(?:not found|invalid|unsupported|不存在|无效|不支持)/i.test(text)
    || /(?:not found|不存在).*(?:images?\/edits|edit(?:s|ing)?)/i.test(text)
    || /(?:images?\/edits|edit(?:s|ing)?).*(?:not found|不存在)/i.test(text)
    || /method\s+not\s+allowed|unknown\s+endpoint|invalid_endpoint|endpoint_not_found/i.test(text)
  );
  const modelUnsupported = (
    /(?:unsupported|invalid|unknown|not found|unavailable|does not support|不支持|无效|未知|不存在).*(?:model|模型)/i.test(text)
    || /(?:model|模型).*(?:unsupported|invalid|unknown|not found|unavailable|does not support|不支持|无效|未知|不存在)/i.test(text)
    || /model[_-]?(?:not[_-]?found|unsupported|unavailable)/i.test(text)
  );
  const imageCapabilityUnsupported = (
    /mask\s+compositing\s+is\s+disabled/i.test(text)
    || /does\s+not\s+process\s+image(?:\s+pixels?)?/i.test(text)
    || /image\s*(?:edit(?:ing)?|pixel(?:s)?|compositing).*(?:disabled|unsupported|not\s+supported)/i.test(text)
    || /(?:mask|蒙版|遮罩).*(?:compositing|合成).*(?:disabled|unsupported|not\s+supported|不支持|关闭)/i.test(text)
    || /(?:not\s+supported|unsupported|不支持).*(?:mask|蒙版|遮罩|image\s*edit|图片编辑)/i.test(text)
  );
  let code = "image-edit-upstream-error";
  if (endpointInvalid) code = "image-edit-endpoint-invalid";
  else if (modelUnsupported) code = "image-edit-model-unsupported";
  else if (imageCapabilityUnsupported) code = "image-edit-unsupported";
  const retryable = code === "image-edit-upstream-error"
    ? shouldRetryStatus(details.status)
    : false;
  return {
    code,
    retryable,
    status: details.status,
    upstreamCode: details.upstreamCode
      ? normalizeFailureCode(details.upstreamCode, details.status)
      : "",
    upstreamMessage: sanitizeFailureMessage(details.message || "未提供上游错误"),
    message: sanitizeFailureMessage(details.message || "未提供上游错误")
  };
}

function imageEditErrorMessage(classification) {
  const item = classification && typeof classification === "object"
    ? classification
    : {};
  const upstream = item.upstreamMessage
    ? `上游返回：${item.upstreamMessage}`
    : "";
  const prefix = item.code === "image-edit-unsupported"
    ? "当前图片编辑服务不支持 mask 合成，请更换支持图片编辑和 mask 的 VPS/模型。"
    : item.code === "image-edit-endpoint-invalid"
      ? "图片编辑 endpoint 配置无效，请检查 AI_IMAGE_EDIT_ENDPOINT 或 AI_IMAGE_BASE_URL。"
      : item.code === "image-edit-model-unsupported"
        ? "当前图片编辑模型不支持 edits，请更换支持图片编辑的模型。"
        : "图片编辑上游服务返回错误，请检查 provider、endpoint 和 model。";
  return upstream ? `${prefix}${upstream}` : prefix;
}

function imageEditMultipartSummary(fields = [], files = [], mainField = "image", maskField = "mask") {
  const fileItems = Array.isArray(files) ? files : [];
  const fieldItems = Array.isArray(fields) ? fields : [];
  return {
    textFields: fieldItems.map((field) => String(field && field.name || "")).filter(Boolean),
    fileFields: fileItems.map((file) => String(file && file.name || "")).filter(Boolean),
    hasMainImage: fileItems.some((file) => String(file && file.name || "") === mainField),
    hasMask: fileItems.some((file) => String(file && file.name || "") === maskField),
    referenceCount: Math.max(
      0,
      fileItems.filter((file) => String(file && file.name || "") !== mainField
        && String(file && file.name || "") !== maskField).length
    )
  };
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

function webPoseArrayFromValue(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 3) return null;
  const keys = ["poses", "suggestions", "items", "results", "list", "data"];
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = webPoseArrayFromValue(candidate, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function normalizeWebPoseSuggestion(value, fallbackId) {
  if (!value || typeof value !== "object") return null;
  const id = Number(
    value.id
      ?? value.index
      ?? value.no
      ?? value.number
      ?? fallbackId
  );
  const title = compactWebPoseText(
    value.title ?? value.name ?? value.label ?? value.heading,
    40
  );
  const description = compactWebPoseText(
    value.description
      ?? value.desc
      ?? value.text
      ?? value.instruction
      ?? value.action
      ?? value.pose,
    320
  );
  const category = value.category ?? value.type ?? value.kind;
  const tags = value.tags ?? value.keywords;
  const unsuitableReason = value.unsuitableReason
    ?? value.reason
    ?? value.limitations;
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
    category: POSE_CATEGORIES.includes(category) ? category : "其他",
    tags: Array.isArray(tags)
      ? tags.map((item) => compactWebPoseText(item, 20)).filter(Boolean).slice(0, 5)
      : [],
    unsuitableReason: compactWebPoseText(unsuitableReason, 180),
    direction: "自然",
    intensity: "正常调整",
    platform: "社交平台照片"
  };
}

function normalizeWebPoseSuggestions(value) {
  const source = webPoseArrayFromValue(value);
  if (!source || source.length !== 8) return null;
  const suggestions = source.map((item, index) => normalizeWebPoseSuggestion(item, index + 1));
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
const imageProviderAttemptTestEvents = [];
const adminConfigAuditTestRows = [];
const autoFaceFailureTestEvents = [];
const autoFaceProbeTestEvents = [];
const userProfileTestRows = [];
const userDiagnosticLogTestRows = [];
let autoFaceFailureCleanupLastRunAt = 0;
let autoFaceFailureCleanupPromise = null;

function modelUsageTypeForAction(action) {
  if (action === "generate") return "image";
  if (action === "analyze" || action === "analyzeWebPoses") return "analysis";
  if (action === "detectFaceCircle") return "face";
  if (action === "video.create") return "video";
  return "";
}

function modelUsageTypeLabel(usageType) {
  return MODEL_USAGE_TYPE_LABELS[usageType] || "模型";
}

function modelErrorMessage(usageType, message) {
  const originalMessage = String(message || "模型请求失败");
  if (!usageType) return originalMessage;
  const label = modelUsageTypeLabel(usageType);
  return originalMessage.startsWith(`${label}模型：`)
    ? originalMessage
    : `${label}模型：${originalMessage}`;
}

function modelErrorTypeForAction(action) {
  const usageType = modelUsageTypeForAction(action);
  if (usageType) return usageType;
  if (action === "probeAutoFace") return "face";
  if (action === "repairImage") return "image";
  if ([
    "videoProviderStatus",
    "createVideoTask",
    "queryVideoTask",
    "buildAndroidMotionPhoto",
    "buildAppleLivePhoto"
  ].includes(action)) {
    return "video";
  }
  return "";
}

function addModelErrorContext(action, result) {
  if (!result || result.ok !== false) return result;
  const usageType = modelErrorTypeForAction(action);
  if (!usageType) return result;
  const label = modelUsageTypeLabel(usageType);
  const message = modelErrorMessage(
    usageType,
    result.message || result.error || "模型请求失败"
  );
  return Object.assign({}, result, {
    message,
    modelType: usageType,
    modelTypeLabel: label
  });
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
  const userHash = compactUsageText(source.userHash, 40) || "anonymous";
  const dateKey = Number.isNaN(createdAt.getTime())
    ? ""
    : dateKeyForTimeZone(createdAt, AUTO_FACE_FAILURE_TIME_ZONE);
  return {
    requestId: normalized.requestId,
    userHash,
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
    createdAt: createdAtIso,
    dateKey,
    monthKey: dateKey ? monthKeyFromDateKey(dateKey) : ""
  };
}

function buildAutoFaceFailureStats(events = [], baseDate = new Date()) {
  const todayKey = dateKeyForTimeZone(baseDate, AUTO_FACE_FAILURE_TIME_ZONE);
  const last7StartKey = shiftDateKey(todayKey, -6);
  const last30StartKey = shiftDateKey(todayKey, -29);
  const retentionStartKey = shiftDateKey(
    todayKey,
    -(AUTO_FACE_FAILURE_RETENTION_DAYS - 1)
  );
  const byType = {};
  const recent = [];
  const details = [];
  const probeVersions = {};
  const dailyMap = {};
  const monthlyMap = {};
  const userMap = {};
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
      && item.dateKey >= retentionStartKey
      && item.dateKey <= todayKey
    ))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .forEach((item) => {
      const inLast30d = item.dateKey >= last30StartKey;
      const monthKey = monthKeyFromDateKey(item.dateKey);
      const userHash = compactUsageText(item.event && item.event.userHash, 40) || "anonymous";
      if (!dailyMap[item.dateKey]) {
        dailyMap[item.dateKey] = {
          dateKey: item.dateKey,
          total: 0,
          userSet: {},
          typeMap: {},
          lastSeen: ""
        };
      }
      dailyMap[item.dateKey].total += 1;
      dailyMap[item.dateKey].userSet[userHash] = true;
      dailyMap[item.dateKey].typeMap[
        normalizeAutoFaceFailureType(item.event && item.event.failureType)
      ] = (
        dailyMap[item.dateKey].typeMap[
          normalizeAutoFaceFailureType(item.event && item.event.failureType)
        ] || 0
      ) + 1;
      if (!dailyMap[item.dateKey].lastSeen) {
        dailyMap[item.dateKey].lastSeen = item.createdAt.toISOString();
      }
      if (monthKey) {
        if (!monthlyMap[monthKey]) {
          monthlyMap[monthKey] = {
            monthKey,
            total: 0,
            userSet: {},
            typeMap: {},
            lastSeen: ""
          };
        }
        monthlyMap[monthKey].total += 1;
        monthlyMap[monthKey].userSet[userHash] = true;
        monthlyMap[monthKey].typeMap[
          normalizeAutoFaceFailureType(item.event && item.event.failureType)
        ] = (
          monthlyMap[monthKey].typeMap[
            normalizeAutoFaceFailureType(item.event && item.event.failureType)
          ] || 0
        ) + 1;
        if (!monthlyMap[monthKey].lastSeen) {
          monthlyMap[monthKey].lastSeen = item.createdAt.toISOString();
        }
      }
      if (!userMap[userHash]) {
        userMap[userHash] = {
          userHash,
          total: 0,
          typeMap: {},
          lastSeen: ""
        };
      }
      userMap[userHash].total += 1;
      userMap[userHash].typeMap[
        normalizeAutoFaceFailureType(item.event && item.event.failureType)
      ] = (
        userMap[userHash].typeMap[
          normalizeAutoFaceFailureType(item.event && item.event.failureType)
        ] || 0
      ) + 1;
      if (!userMap[userHash].lastSeen) {
        userMap[userHash].lastSeen = item.createdAt.toISOString();
      }

      details.push(autoFaceFailureDisplayEvent(item.event));
      if (!inLast30d) return;
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
    details,
    probeSummary: Object.assign({}, probeSummary, {
      versions: Object.values(probeVersions).sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return left.buildVersion.localeCompare(right.buildVersion);
      })
    }),
    daily: Object.values(dailyMap)
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey))
      .map((item) => {
        const topType = Object.entries(item.typeMap)
          .sort((left, right) => right[1] - left[1])[0];
        return {
          dateKey: item.dateKey,
          total: item.total,
          userCount: Object.keys(item.userSet).length,
          topFailureType: topType ? topType[0] : "unknown",
          topFailureTypeLabel: formatAutoFaceFailureType(topType ? topType[0] : "unknown"),
          lastSeen: item.lastSeen
        };
      })
      .filter((item) => item.dateKey >= last30StartKey),
    monthly: Object.values(monthlyMap)
      .sort((left, right) => right.monthKey.localeCompare(left.monthKey))
      .map((item) => {
        const topType = Object.entries(item.typeMap)
          .sort((left, right) => right[1] - left[1])[0];
        return {
          monthKey: item.monthKey,
          total: item.total,
          userCount: Object.keys(item.userSet).length,
          topFailureType: topType ? topType[0] : "unknown",
          topFailureTypeLabel: formatAutoFaceFailureType(topType ? topType[0] : "unknown"),
          lastSeen: item.lastSeen
        };
      }),
    users: Object.values(userMap)
      .sort((left, right) => {
        if (right.total !== left.total) return right.total - left.total;
        return left.userHash.localeCompare(right.userHash);
      })
      .map((item) => {
        const topType = Object.entries(item.typeMap)
          .sort((left, right) => right[1] - left[1])[0];
        return {
          userHash: item.userHash,
          total: item.total,
          topFailureType: topType ? topType[0] : "unknown",
          topFailureTypeLabel: formatAutoFaceFailureType(topType ? topType[0] : "unknown"),
          lastSeen: item.lastSeen
        };
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
  return ["source", "result", "record"].includes(kind) ? kind : "";
}

function photoToVideoTempAssetDocumentId(targetID, kind) {
  return crypto
    .createHash("sha256")
    .update(`${normalizePhotoToVideoTempKind(kind)}:${String(targetID || "")}`)
    .digest("hex")
    .slice(0, 30);
}

function photoToVideoTempCleanupCutoff(baseDate = new Date()) {
  return new Date(baseDate.getTime() - PHOTO_TO_VIDEO_TEMP_ASSET_TTL_MS);
}

function photoToVideoIdleCleanupCutoff(baseDate = new Date()) {
  return new Date(baseDate.getTime() - PHOTO_TO_VIDEO_IDLE_CLEANUP_MS);
}

function photoToVideoCleanupState(row = {}, baseDate = new Date()) {
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const idleCutoff = photoToVideoIdleCleanupCutoff(now);
  const cleanupAfter = row.cleanupAfter ? new Date(row.cleanupAfter) : null;
  const idleCleanupAfter = row.idleCleanupAfter ? new Date(row.idleCleanupAfter) : null;
  const lastActiveAt = row.lastActiveAt ? new Date(row.lastActiveAt) : null;
  const ttlDue = Boolean(
    cleanupAfter
    && Number.isFinite(cleanupAfter.getTime())
    && cleanupAfter.getTime() <= now.getTime()
  );
  const idleDue = Boolean(
    idleCleanupAfter
    && Number.isFinite(idleCleanupAfter.getTime())
    && idleCleanupAfter.getTime() <= now.getTime()
  );
  const recentlyActive = Boolean(
    lastActiveAt
    && Number.isFinite(lastActiveAt.getTime())
    && lastActiveAt.getTime() > idleCutoff.getTime()
  );
  return {
    ttlDue,
    idleDue,
    recentlyActive,
    due: ttlDue || (idleDue && !recentlyActive)
  };
}

function timerTriggerName(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return String(
    source.triggerName
    || source.TriggerName
    || source.name
    || ""
  ).trim();
}

function isPhotoToVideoCleanupTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  const triggerName = timerTriggerName(source);
  return (
    triggerName === "photo-to-video-temp-cleanup"
    || triggerName === "photo-to-video-idle-cleanup"
    || source.action === "cleanupPhotoToVideoTempAssets"
  );
}

function isGenerationQueueWorkerTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    timerTriggerName(source) === "generation-queue-worker"
    || source.action === "processGenerationQueue"
  );
}

function isGenerationReconcileTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    timerTriggerName(source) === "generation-operation-reconcile"
    || source.action === "reconcileGenerationOperations"
  );
}

function isWatermarkTransferCleanupTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    timerTriggerName(source) === "watermark-transfer-temp-cleanup"
    || source.action === "cleanupWatermarkTransferTempAssets"
  );
}

function isTencentFaceFusionCleanupTrigger(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  return (
    timerTriggerName(source) === "tencent-facefusion-intermediate-cleanup"
    || source.action === "cleanupTencentFaceFusionIntermediateAssets"
  );
}

function isTencentFaceFusionFileMissing(error) {
  return /not.?found|不存在|file.?not.?exist|no such file|404/i
    .test(sanitizeFailureMessage(error && (error.errMsg || error.message) || error || "", 240));
}

async function registerTencentFaceFusionIntermediateAsset(fileID, openid, requestId) {
  const normalizedFileID = String(fileID || "").trim();
  if (!normalizedFileID) return null;
  const now = new Date();
  const row = {
    fileID: normalizedFileID,
    ownerOpenId: String(openid || ""),
    requestId: String(requestId || ""),
    cleanupAfter: new Date(now.getTime() + TENCENT_FACEFUSION_INTERMEDIATE_TTL_MS),
    status: "active",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  const result = await db.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION).add({
    data: row
  });
  return Object.assign({}, row, { _id: result && result._id || "" });
}

async function removeTencentFaceFusionIntermediateAsset(fileID, requestId = "") {
  const where = requestId
    ? { fileID: String(fileID || ""), requestId: String(requestId || "") }
    : { fileID: String(fileID || "") };
  const result = await db.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION)
    .where(where)
    .limit(20)
    .get();
  const rows = result && Array.isArray(result.data) ? result.data : [];
  await Promise.all(rows.filter((row) => row && row._id).map((row) => (
    db.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION).doc(row._id).remove()
  )));
  return rows.length;
}

async function cleanupTencentFaceFusionIntermediateAssets(baseDate = new Date(), dependencies = {}) {
  const database = dependencies.db || db;
  const cloudClient = dependencies.cloud || cloud;
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const result = await database.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION)
    .where({ cleanupAfter: database.command.lte(now) })
    .limit(TENCENT_FACEFUSION_INTERMEDIATE_CLEANUP_BATCH_SIZE)
    .get();
  const rows = result && Array.isArray(result.data) ? result.data : [];
  let removed = 0;
  let retried = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row || !row._id) continue;
    try {
      if (row.fileID) {
        const response = await cloudClient.deleteFile({ fileList: [row.fileID] });
        const item = response && Array.isArray(response.fileList)
          ? response.fileList.find((entry) => entry && entry.fileID === row.fileID)
          : null;
        if (item && Number(item.status) !== 0) {
          const error = new Error(item.errMsg || "腾讯中间图删除失败");
          error.code = "TENCENT_FACEFUSION_INTERMEDIATE_DELETE_FAILED";
          throw error;
        }
      }
      await database.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION).doc(row._id).remove();
      removed += 1;
    } catch (error) {
      if (isTencentFaceFusionFileMissing(error)) {
        await database.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION).doc(row._id).remove();
        removed += 1;
        continue;
      }
      failed += 1;
      retried += 1;
      await database.collection(TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION).doc(row._id).update({
        data: {
          status: "failed",
          attempts: Math.max(0, Number(row.attempts) || 0) + 1,
          lastError: sanitizeFailureMessage(error && error.message || error, 240),
          updatedAt: new Date()
        }
      });
      log("warn", "tencent.facefusion.intermediate-cleanup-failed", {
        fileID: row.fileID,
        requestId: row.requestId,
        error: sanitizeFailureMessage(error && error.message || error, 240)
      });
    }
  }
  const summary = {
    skipped: false,
    scanned: rows.length,
    removed,
    retried,
    failed,
    truncated: rows.length >= TENCENT_FACEFUSION_INTERMEDIATE_CLEANUP_BATCH_SIZE,
    cutoff: now.toISOString()
  };
  log("info", "tencent.facefusion.intermediate-cleanup", summary);
  return summary;
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
  const kind = normalizePhotoToVideoTempKind(event.kind);
  const ownerOpenId = getOpenId(context);
  const sessionId = compactUsageText(event.sessionId, 100);
  let fileID = String(event.fileID || "").trim();
  let recordId = String(event.recordId || "").trim();
  if (!kind) {
    return fail(
      "照片转视频清理目标类型只能是 source、result 或 record。",
      "PHOTO_TO_VIDEO_TEMP_KIND_INVALID"
    );
  }
  if (kind === "record") {
    if (!recordId) {
      return fail("缺少照片转视频正式制作记录 ID。", "PHOTO_TO_VIDEO_RECORD_ID_INVALID");
    }
    const record = await readDocument(db.collection("generation_records").doc(recordId));
    if (!record || record.openid !== ownerOpenId) {
      return fail("无权登记这条照片转视频正式制作记录。", "forbidden");
    }
    fileID = String(record.fileID || "").trim();
  } else if (!/^cloud:\/\//i.test(fileID)) {
    return fail(
      "照片转视频临时文件必须是 cloud:// fileID。",
      "PHOTO_TO_VIDEO_TEMP_FILE_ID_INVALID"
    );
  }
  const now = new Date();
  const targetID = kind === "record" ? recordId : fileID;
  const documentId = photoToVideoTempAssetDocumentId(targetID, kind);
  const ref = db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(documentId);
  const previous = await readDocument(ref);
  const defaultCleanupAfter = new Date(now.getTime() + PHOTO_TO_VIDEO_TEMP_ASSET_TTL_MS);
  const previousCleanupAfter = previous && previous.cleanupAfter
    ? new Date(previous.cleanupAfter)
    : null;
  const cleanupAfter = previousCleanupAfter
    && Number.isFinite(previousCleanupAfter.getTime())
    && previousCleanupAfter.getTime() < defaultCleanupAfter.getTime()
    ? previousCleanupAfter
    : defaultCleanupAfter;
  const data = {
    fileID,
    recordId,
    kind,
    targetType: kind === "record" ? "record" : "file",
    ownerOpenId,
    sessionId,
    createdAt: previous && previous.createdAt || now,
    cleanupAfter,
    lastActiveAt: now,
    closedAt: null,
    idleCleanupAfter: null,
    status: "pending",
    attempts: 0,
    lastError: "",
    updatedAt: now
  };
  await ref.set({ data: stripDocumentId(data) });
  return jsonResponse(true, {
    accepted: true,
    fileID,
    recordId,
    kind,
    sessionId,
    cleanupAfter: data.cleanupAfter.toISOString()
  });
}

async function updatePhotoToVideoSession(event = {}, context, mode = "active") {
  const ownerOpenId = getOpenId(context);
  const sessionId = compactUsageText(event.sessionId, 100);
  if (!sessionId) {
    return fail("缺少照片转视频会话 ID。", "PHOTO_TO_VIDEO_SESSION_ID_INVALID");
  }
  const result = await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION)
    .where({ sessionId })
    .limit(PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE)
    .get();
  const rows = result && Array.isArray(result.data)
    ? result.data.filter((row) => row && row.ownerOpenId === ownerOpenId)
    : [];
  const now = new Date();
  const closing = mode === "close";
  for (const row of rows) {
    if (!row || !row._id) continue;
    await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(row._id).update({
      data: closing
        ? {
          closedAt: now,
          idleCleanupAfter: new Date(now.getTime() + PHOTO_TO_VIDEO_IDLE_CLEANUP_MS),
          lastActiveAt: row.lastActiveAt || now,
          updatedAt: now,
          status: "pending"
        }
        : {
          closedAt: null,
          idleCleanupAfter: null,
          lastActiveAt: now,
          updatedAt: now,
          status: "pending"
        }
    });
  }
  return jsonResponse(true, {
    accepted: true,
    sessionId,
    mode: closing ? "close" : "active",
    matched: rows.length
  });
}

async function cleanupPhotoToVideoFormalRecord(row) {
  if (row.fileID) {
    try {
      await deletePhotoToVideoTempFile(row.fileID);
    } catch (error) {
      if (!isPhotoToVideoTempFileMissing(error)) throw error;
    }
  }
  const result = await removeGenerationRecord(
    String(row.recordId || ""),
    String(row.ownerOpenId || "anonymous"),
    { allowMissing: true, skipFileDelete: true }
  );
  if (!result || result.ok === false) {
    throw new Error(result && result.message || "正式制作记录清理失败");
  }
  return result;
}

async function cleanupPhotoToVideoTempAssets(baseDate = new Date()) {
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const cutoff = photoToVideoTempCleanupCutoff(now);
  const idleCutoff = photoToVideoIdleCleanupCutoff(now);
  const [idleResult, ttlResult] = await Promise.all([
    db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION)
      .where({ idleCleanupAfter: db.command.lte(now) })
      .limit(PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE)
      .get(),
    db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION)
      .where({ cleanupAfter: db.command.lte(now) })
      .limit(PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE)
      .get()
  ]);
  const rowsById = new Map();
  [idleResult, ttlResult].forEach((result) => {
    const rows = result && Array.isArray(result.data) ? result.data : [];
    rows.forEach((row) => {
      if (row && row._id) rowsById.set(row._id, row);
    });
  });
  const rows = Array.from(rowsById.values());
  let removed = 0;
  let retried = 0;
  let failed = 0;
  let skippedActive = 0;
  for (const row of rows) {
    const state = photoToVideoCleanupState(row, now);
    if (!state.due) {
      skippedActive += 1;
      continue;
    }
    try {
      if (row.kind === "record") {
        await cleanupPhotoToVideoFormalRecord(row);
      } else if (row.fileID) {
        await deletePhotoToVideoTempFile(row.fileID);
      } else {
        throw new Error("照片转视频清理目标缺少 fileID 或 recordId");
      }
      await db.collection(PHOTO_TO_VIDEO_TEMP_ASSET_COLLECTION).doc(row._id).remove();
      removed += 1;
    } catch (error) {
      if (row.kind !== "record" && isPhotoToVideoTempFileMissing(error)) {
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
        recordId: row.recordId,
        kind: row.kind,
        error: normalizePhotoToVideoTempFileError(error)
      });
    }
  }
  const summary = {
    skipped: false,
    cutoff: cutoff.toISOString(),
    idleCutoff: idleCutoff.toISOString(),
    scanned: rows.length,
    removed,
    retried,
    failed,
    skippedActive,
    truncated: rows.length >= PHOTO_TO_VIDEO_TEMP_ASSET_CLEANUP_BATCH_SIZE
  };
  log("info", "photo-to-video-temp.cleanup", summary);
  return jsonResponse(true, summary);
}

async function reportAutoFaceFailure(event = {}, context = {}) {
  const report = normalizeAutoFaceFailureReport(
    event && event.payload,
    event && event.requestId
  );
  report.userHash = usageUserHash(context && context.OPENID);
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
  const startKey = shiftDateKey(todayKey, -(AUTO_FACE_FAILURE_RETENTION_DAYS - 1));
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
  const imageEdit = response && response.imageEditClassification;
  return {
    errorCode: normalizeFailureCode(
      (imageEdit && imageEdit.code)
        || (nestedError && (nestedError.code || nestedError.type))
        || (payload && (payload.code || payload.error_code)),
      response && response.status
    ),
    errorMessage: sanitizeFailureMessage(
      (imageEdit && imageEdit.message)
        || (nestedError && nestedError.message)
        || (payload && payload.message)
        || (response && response.raw)
        || ""
    ),
    errorStatus: Math.max(0, Number(response && response.status) || 0),
    retryable: imageEdit
      ? Boolean(imageEdit.retryable)
      : Boolean(retryable),
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

function diagnosticLogCutoff(baseDate = new Date(), hours = USER_DIAGNOSTIC_LOG_RETENTION_HOURS) {
  const normalizedHours = Math.max(
    1,
    Math.min(USER_DIAGNOSTIC_LOG_RETENTION_HOURS, Number(hours) || USER_DIAGNOSTIC_LOG_RETENTION_HOURS)
  );
  return new Date(baseDate.getTime() - normalizedHours * 60 * 60 * 1000);
}

function normalizeDiagnosticLevel(value) {
  const level = compactUsageText(value, 16).toLowerCase();
  return USER_DIAGNOSTIC_LEVELS.has(level) ? level : "info";
}

function normalizeDiagnosticCategory(value) {
  const category = compactUsageText(value, 40)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return Object.prototype.hasOwnProperty.call(USER_DIAGNOSTIC_CATEGORY_LABELS, category)
    ? category
    : "other";
}

function diagnosticCategoryLabel(category) {
  return USER_DIAGNOSTIC_CATEGORY_LABELS[normalizeDiagnosticCategory(category)] || "其他";
}

function sanitizeDiagnosticText(value, maxLength = 500) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[A-Za-z0-9._~-]{12,}\b/gi, "[Key已隐藏]")
    .replace(/cloud:\/\/[^\s,;]+/gi, "[素材地址已隐藏]")
    .replace(/https?:\/\/[^\s,;]+/gi, "[地址已隐藏]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users|private|data)\/)[^\s,;]+/g,
      "[路径已隐藏]"
    )
    .replace(/openid\s*[:=]\s*[^\s,;]+/gi, "OpenID=[已隐藏]")
    .replace(
      /((?:api[_-]?key|appsecret|secret|authorization|password|token)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[已隐藏]"
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeDiagnosticValue(value, key = "", depth = 0) {
  if (depth > 4) return "[内容已截断]";
  if (value === null || value === undefined) return value;
  const normalizedKey = String(key || "");
  if (/api.?key|appsecret|secret|authorization|password|token|openid/i.test(normalizedKey)) {
    return "[已隐藏]";
  }
  if (/base64|binary|buffer|fileContent|imageData|videoData/i.test(normalizedKey)) {
    return "[内容已省略]";
  }
  if (/prompt|negativePrompt|userContent/i.test(normalizedKey)) {
    return "[用户内容已省略]";
  }
  if (
    /^(fileID|fileId|filePath|tempFilePath|localPath|imagePath|imageUrl|videoPath|videoUrl|avatarUrl|url)$/i
      .test(normalizedKey)
  ) {
    return "[地址已隐藏]";
  }
  if (typeof value === "string") return sanitizeDiagnosticText(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeDiagnosticValue(item, normalizedKey, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    Object.keys(value).slice(0, 50).forEach((childKey) => {
      result[childKey] = sanitizeDiagnosticValue(value[childKey], childKey, depth + 1);
    });
    return result;
  }
  return sanitizeDiagnosticText(value, 500);
}

function diagnosticLogDocumentId(openid, eventId) {
  return crypto.createHash("sha256")
    .update(`diagnostic-log:${openid}:${eventId}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeDiagnosticEvent(value = {}, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const nowDate = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const rawTime = new Date(source.time || nowDate);
  let occurredAt = Number.isNaN(rawTime.getTime()) ? nowDate : rawTime;
  if (occurredAt.getTime() > nowDate.getTime() + 5 * 60 * 1000) occurredAt = nowDate;
  if (occurredAt.getTime() <= diagnosticLogCutoff(nowDate).getTime()) return null;
  const eventId = compactUsageText(source.eventId, 120)
    .replace(/[^A-Za-z0-9._:-]+/g, "-");
  if (!eventId) return null;
  const openid = String(options.openid || "anonymous");
  const createdAt = new Date(occurredAt);
  return {
    _id: diagnosticLogDocumentId(openid, eventId),
    eventId,
    userHash: usageUserHash(openid),
    sessionId: compactUsageText(source.sessionId || options.sessionId, 120)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    appVersion: compactUsageText(options.appVersion, 40),
    sequence: Math.max(0, Math.round(Number(source.sequence) || 0)),
    level: normalizeDiagnosticLevel(source.level),
    category: normalizeDiagnosticCategory(source.category),
    event: compactUsageText(source.event, 80)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    message: sanitizeDiagnosticText(source.message, 240),
    route: compactUsageText(source.route, 160)
      .replace(/[^A-Za-z0-9_./-]+/g, ""),
    step: compactUsageText(source.step, 80)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    requestId: compactUsageText(source.requestId, 120)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    code: compactUsageText(source.code, 80)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    durationMs: Number.isFinite(Number(source.durationMs))
      ? Math.max(0, Math.min(10 * 60 * 1000, Math.round(Number(source.durationMs))))
      : null,
    error: sanitizeDiagnosticValue(source.error, "error"),
    details: sanitizeDiagnosticValue(source.details, "details"),
    createdAt,
    receivedAt: new Date(nowDate),
    expiresAt: new Date(createdAt.getTime() + USER_DIAGNOSTIC_LOG_RETENTION_MS)
  };
}

function diagnosticDisplayEvent(value = {}) {
  const createdAt = value.createdAt instanceof Date
    ? value.createdAt
    : new Date(value.createdAt || 0);
  return {
    eventId: compactUsageText(value.eventId, 120),
    userHash: compactUsageText(value.userHash, 40) || "anonymous",
    sessionId: compactUsageText(value.sessionId, 120),
    appVersion: compactUsageText(value.appVersion, 40),
    sequence: Math.max(0, Number(value.sequence) || 0),
    level: normalizeDiagnosticLevel(value.level),
    category: normalizeDiagnosticCategory(value.category),
    categoryLabel: diagnosticCategoryLabel(value.category),
    event: compactUsageText(value.event, 80),
    message: sanitizeDiagnosticText(value.message, 240),
    route: compactUsageText(value.route, 160),
    step: compactUsageText(value.step, 80),
    requestId: compactUsageText(value.requestId, 120),
    code: compactUsageText(value.code, 80),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : null,
    error: sanitizeDiagnosticValue(value.error, "error"),
    details: sanitizeDiagnosticValue(value.details, "details"),
    createdAt: Number.isNaN(createdAt.getTime()) ? "" : createdAt.toISOString()
  };
}

function buildAdminDiagnosticStats(rows = []) {
  const stats = {
    total: rows.length,
    errorCount: 0,
    warnCount: 0,
    infoCount: 0,
    userCount: 0,
    categories: []
  };
  const users = new Set();
  const categories = {};
  rows.forEach((item) => {
    const level = normalizeDiagnosticLevel(item.level);
    if (level === "error") stats.errorCount += 1;
    else if (level === "warn") stats.warnCount += 1;
    else stats.infoCount += 1;
    const userHash = compactUsageText(item.userHash, 40);
    if (userHash) users.add(userHash);
    const category = normalizeDiagnosticCategory(item.category);
    categories[category] = (categories[category] || 0) + 1;
  });
  stats.userCount = users.size;
  stats.categories = Object.keys(categories)
    .map((category) => ({
      category,
      label: diagnosticCategoryLabel(category),
      count: categories[category]
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
  return stats;
}

async function cleanupDiagnosticLogs(baseDate = new Date()) {
  const cutoff = new Date(baseDate);
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    let removed = 0;
    for (let index = userDiagnosticLogTestRows.length - 1; index >= 0; index -= 1) {
      const row = userDiagnosticLogTestRows[index];
      const expiresAt = row.expiresAt
        ? new Date(row.expiresAt)
        : new Date(new Date(row.createdAt || 0).getTime() + USER_DIAGNOSTIC_LOG_RETENTION_MS);
      if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= cutoff.getTime()) {
        userDiagnosticLogTestRows.splice(index, 1);
        removed += 1;
      }
    }
    return {
      removed,
      truncated: false,
      retentionHours: USER_DIAGNOSTIC_LOG_RETENTION_HOURS,
      cutoff: cutoff.toISOString()
    };
  }

  let removed = 0;
  let truncated = false;
  for (let batch = 0; batch < 20; batch += 1) {
    const result = await db
      .collection(USER_DIAGNOSTIC_LOG_COLLECTION)
      .where({ expiresAt: db.command.lte(cutoff) })
      .limit(USER_DIAGNOSTIC_LOG_CLEANUP_BATCH_SIZE)
      .get();
    const rows = result && Array.isArray(result.data)
      ? result.data.filter((item) => item && item._id)
      : [];
    if (!rows.length) {
      truncated = false;
      break;
    }
    await Promise.all(rows.map((item) => (
      db.collection(USER_DIAGNOSTIC_LOG_COLLECTION).doc(item._id).remove()
    )));
    removed += rows.length;
    truncated = rows.length >= USER_DIAGNOSTIC_LOG_CLEANUP_BATCH_SIZE;
    if (!truncated) break;
  }
  if (removed) {
    log("info", "diagnostic-log.cleanup", {
      removed,
      retentionHours: USER_DIAGNOSTIC_LOG_RETENTION_HOURS,
      truncated
    });
  }
  return {
    removed,
    truncated,
    retentionHours: USER_DIAGNOSTIC_LOG_RETENTION_HOURS,
    cutoff: cutoff.toISOString()
  };
}

async function reportDiagnosticLogs(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail("无法确认当前用户身份，日志没有上传。", "DIAGNOSTIC_IDENTITY_MISSING");
  }
  const payload = event && event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
  const rawEvents = Array.isArray(payload.events)
    ? payload.events.slice(0, USER_DIAGNOSTIC_LOG_BATCH_SIZE)
    : [];
  const nowDate = new Date();
  const normalized = rawEvents
    .map((item) => normalizeDiagnosticEvent(item, {
      openid,
      now: nowDate,
      sessionId: payload.session && payload.session.id,
      appVersion: payload.appVersion
    }))
    .filter(Boolean);
  await cleanupDiagnosticLogs(nowDate);
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    normalized.forEach((item) => {
      const index = userDiagnosticLogTestRows.findIndex((row) => row._id === item._id);
      if (index >= 0) userDiagnosticLogTestRows.splice(index, 1, item);
      else userDiagnosticLogTestRows.push(item);
    });
  } else {
    await Promise.all(normalized.map((item) => (
      db.collection(USER_DIAGNOSTIC_LOG_COLLECTION).doc(item._id).set({
        data: stripDocumentId(item)
      })
    )));
  }
  return jsonResponse(true, {
    accepted: normalized.length,
    ignored: rawEvents.length - normalized.length,
    retentionHours: USER_DIAGNOSTIC_LOG_RETENTION_HOURS
  });
}

async function loadDiagnosticLogRows(cutoff) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return userDiagnosticLogTestRows
      .filter((item) => new Date(item.createdAt || 0).getTime() >= cutoff.getTime())
      .slice();
  }
  const rows = [];
  let offset = 0;
  while (offset < USER_DIAGNOSTIC_LOG_MAX_READ) {
    const result = await db
      .collection(USER_DIAGNOSTIC_LOG_COLLECTION)
      .where({ createdAt: db.command.gte(cutoff) })
      .skip(offset)
      .limit(Math.min(100, USER_DIAGNOSTIC_LOG_MAX_READ - offset))
      .get();
    const page = result && Array.isArray(result.data) ? result.data : [];
    rows.push(...page);
    if (page.length < 100) break;
    offset += page.length;
  }
  return rows;
}

async function getAdminDiagnosticLogs(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const hours = Math.max(
    1,
    Math.min(USER_DIAGNOSTIC_LOG_RETENTION_HOURS, Number(event && event.hours) || 72)
  );
  const levelValue = compactUsageText(event && event.level, 16).toLowerCase();
  const level = levelValue === "abnormal"
    ? "abnormal"
    : USER_DIAGNOSTIC_LEVELS.has(levelValue)
      ? levelValue
      : "all";
  const categoryValue = compactUsageText(event && event.category, 40).toLowerCase();
  const category = categoryValue && categoryValue !== "all"
    ? normalizeDiagnosticCategory(categoryValue)
    : "all";
  const userHash = compactUsageText(event && event.userHash, 40);
  const offset = Math.max(0, Number(event && event.offset) || 0);
  const limit = Math.max(1, Math.min(50, Number(event && event.limit) || 20));
  const nowDate = new Date();
  const cleanup = await cleanupDiagnosticLogs(nowDate);
  const cutoff = diagnosticLogCutoff(nowDate, hours);
  const loaded = await loadDiagnosticLogRows(cutoff);
  const timeRows = loaded
    .filter((item) => {
      const createdAt = new Date(item && item.createdAt || 0);
      return !Number.isNaN(createdAt.getTime()) && createdAt.getTime() >= cutoff.getTime();
    })
    .sort((left, right) => (
      new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime()
    ));
  const userOptions = Array.from(new Set(
    timeRows.map((item) => compactUsageText(item.userHash, 40)).filter(Boolean)
  )).sort().map((value) => ({
    value,
    label: `用户 ${value}`
  }));
  const filtered = timeRows.filter((item) => (
    (
      level === "all"
      || (level === "abnormal" && ["error", "warn"].includes(normalizeDiagnosticLevel(item.level)))
      || normalizeDiagnosticLevel(item.level) === level
    )
    && (category === "all" || normalizeDiagnosticCategory(item.category) === category)
    && (!userHash || compactUsageText(item.userHash, 40) === userHash)
  ));
  const logs = filtered.slice(offset, offset + limit).map(diagnosticDisplayEvent);
  return jsonResponse(true, {
    retentionHours: USER_DIAGNOSTIC_LOG_RETENTION_HOURS,
    hours,
    level,
    category,
    userHash,
    summary: buildAdminDiagnosticStats(filtered),
    userOptions,
    logs,
    nextOffset: offset + logs.length < filtered.length ? offset + logs.length : null,
    eventCount: loaded.length,
    truncated: loaded.length >= USER_DIAGNOSTIC_LOG_MAX_READ,
    cleanup,
    message: loaded.length >= USER_DIAGNOSTIC_LOG_MAX_READ
      ? "日志较多，本次最多读取5000条。"
      : ""
  });
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

function modelUsageDetailFromEvent(value = {}) {
  const event = normalizeModelUsageEvent(value);
  if (!event) return null;
  return {
    dateKey: event.dateKey,
    createdAt: event.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : String(event.createdAt || ""),
    userHash: event.userHash,
    requestId: event.requestId,
    usageType: event.usageType,
    provider: event.provider,
    model: event.model,
    imageResolution: event.imageResolution,
    videoResolution: event.videoResolution,
    unitPrice: event.unitPrice,
    quantity: event.usageType === "image"
      ? 1
      : event.usageType === "video"
        ? event.videoDurationSeconds
        : event.totalTokens,
    estimatedCost: event.estimatedCost,
    billingSource: event.billingSource,
    status: event.status,
    success: event.success,
    durationMs: event.durationMs,
    costConfigVersion: event.costConfigVersion
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
    analysis: emptyUsageCounters(),
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
  const dateKey = event.dateKey || "";
  return {
    dateKey,
    monthKey: monthKeyFromDateKey(dateKey),
    createdAt: event.createdAt instanceof Date
      ? event.createdAt.toISOString()
      : String(event.createdAt || ""),
    userHash: event.userHash || "anonymous",
    usageType: event.usageType || "",
    usageTypeLabel: modelUsageTypeLabel(event.usageType),
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

function buildFailureStats(
  reasonMap,
  modelMap,
  details,
  historyDetails,
  monthlyMap,
  total,
  failure
) {
  const failureCount = Math.max(0, Number(failure) || 0);
  const totalCount = Math.max(0, Number(total) || 0);
  const normalizedDetails = (
    Array.isArray(historyDetails) && historyDetails.length
      ? historyDetails
      : (Array.isArray(details) ? details : [])
  )
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const normalizedRecentDetails = (Array.isArray(details) ? details : [])
    .slice()
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
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
  const monthUsers = {};
  const userMap = {};
  normalizedDetails.forEach((item) => {
    const monthKey = item.monthKey || monthKeyFromDateKey(item.dateKey);
    const userHash = item.userHash || "anonymous";
    if (monthKey) {
      if (!monthUsers[monthKey]) monthUsers[monthKey] = {};
      monthUsers[monthKey][userHash] = true;
    }
    if (!userMap[userHash]) {
      userMap[userHash] = {
        userHash,
        total: 0,
        lastSeen: "",
        reasonMap: {}
      };
    }
    userMap[userHash].total += 1;
    if (!userMap[userHash].lastSeen) userMap[userHash].lastSeen = item.createdAt;
    const reasonKey = failureReasonKey(item);
    if (!userMap[userHash].reasonMap[reasonKey]) {
      userMap[userHash].reasonMap[reasonKey] = {
        code: item.errorCode || "",
        label: failureReasonLabel(item),
        count: 0,
        status: Number(item.errorStatus) || 0
      };
    }
    userMap[userHash].reasonMap[reasonKey].count += 1;
  });
  const monthly = Object.values(monthlyMap || {})
    .sort((left, right) => String(right.monthKey).localeCompare(String(left.monthKey)))
    .map((item) => ({
      monthKey: item.monthKey || "",
      total: Number(item.total) || 0,
      success: Number(item.success) || 0,
      failure: Number(item.failure) || 0,
      userCount: Object.keys(monthUsers[item.monthKey] || {}).length
    }));
  return {
    total: failureCount,
    failureRate: totalCount ? Number((failureCount / totalCount * 100).toFixed(2)) : 0,
    topFailureReasons: reasons.slice(0, 5),
    failedModels,
    monthly,
    users: Object.values(userMap)
      .map((item) => {
        const topReason = Object.values(item.reasonMap)
          .sort((left, right) => right.count - left.count)[0];
        return {
          userHash: item.userHash,
          total: item.total,
          lastSeen: item.lastSeen,
          topFailureReason: topReason ? topReason.label : "未提供错误原因",
          topFailureCode: topReason ? topReason.code : "",
          topFailureStatus: topReason ? topReason.status : 0
        };
      })
      .sort((left, right) => {
        if (right.total !== left.total) return right.total - left.total;
        return String(left.userHash).localeCompare(String(right.userHash));
      }),
    failureDetails: normalizedRecentDetails,
    details: normalizedDetails
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
  const failureHistoryDetails = [];
  const usageDetails = [];

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
      const usageDetail = modelUsageDetailFromEvent(event);
      if (usageDetail) usageDetails.push(usageDetail);
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
          usageTypeLabel: modelUsageTypeLabel(event.usageType),
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
            usageTypeLabel: modelUsageTypeLabel(event.usageType),
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
        const detail = failureDetailFromEvent(event);
        failureDetails.push(detail);
        failureHistoryDetails.push(detail);
      }
    }
    if (!event.success && event.dateKey >= monthlyStartKey && !inDailyRange) {
      failureHistoryDetails.push(failureDetailFromEvent(event));
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
    details: usageDetails.sort((left, right) => (
      String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    )),
    failureStats: buildFailureStats(
      failureReasonMap,
      modelMap,
      failureDetails,
      failureHistoryDetails,
      monthlyMap,
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
    const maxResponseBytes = Math.max(
      1024,
      Number(options.maxResponseBytes) || 20 * 1024 * 1024
    );
    const requestOptions = Object.assign({
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers: {}
    }, options);
    delete requestOptions.timeoutMs;
    delete requestOptions.maxResponseBytes;
    const chunks = [];
    const req = transport.request(requestOptions, (res) => {
      let size = 0;
      let responseTooLarge = false;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size <= maxResponseBytes) {
          chunks.push(chunk);
        } else {
          responseTooLarge = true;
        }
      });
      res.on("end", () => {
        if (responseTooLarge) {
          const error = new Error("上游接口响应超过大小限制");
          error.code = "UPSTREAM_RESPONSE_TOO_LARGE";
          error.retryable = false;
          reject(error);
          return;
        }
        const buffer = Buffer.concat(chunks);
        const contentType = String(res.headers && res.headers["content-type"] || "");
        const raw = (
          /json|text|xml|javascript/i.test(contentType)
          || buffer.length <= 2 * 1024 * 1024
        )
          ? buffer.toString("utf8")
          : "";
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch (_) {
          json = null;
        }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          buffer,
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
      const success = response.status >= 200 && response.status < 300;
      const imageEditClassification = !success && meta.imageEdit
        ? classifyImageEditResponse(response)
        : null;
      if (imageEditClassification) {
        response.imageEditClassification = imageEditClassification;
      }
      const retryable = imageEditClassification
        ? imageEditClassification.retryable
        : (retryStatuses
          ? retryStatuses.has(Number(response.status))
          : shouldRetryStatus(response.status));
      const shouldRetry = !success && retryable && attempt < maxAttempts;
      if (!shouldRetry) {
        const billing = buildUsageBilling(
          Object.assign({}, meta, { success }),
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
        imageGeneration,
        ...(imageEditClassification
          ? {
              imageEditErrorCode: imageEditClassification.code,
              upstreamErrorCode: imageEditClassification.upstreamCode,
              upstreamErrorMessage: imageEditClassification.upstreamMessage
            }
          : {})
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
          Object.assign({}, meta, { success: false }),
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

function imageUpstreamError(response, fallback = "生图接口请求失败", options = {}) {
  const error = upstreamError(response, fallback);
  if (options && options.imageEdit) {
    const classification = response && response.imageEditClassification
      ? response.imageEditClassification
      : classifyImageEditResponse(response);
    error.code = classification.code;
    error.retryable = Boolean(classification.retryable);
    error.imageEditClassification = classification;
    error.message = imageEditErrorMessage(classification);
    return error;
  }
  const raw = [
    error.message,
    response && response.raw,
    response && response.json ? JSON.stringify(response.json) : ""
  ].join(" ");
  const mentionsUnsupported = /(?:unsupported|not\s+support(?:ed)?|invalid|unknown|不支持|无效|未知)/i.test(raw);
  const parameter = /quality|清晰度/i.test(raw)
    ? "quality=auto"
    : /(?:^|[^a-z])(size|resolution)|尺寸|分辨率/i.test(raw)
      ? "size"
      : "";
  if (error.status >= 400 && error.status < 500 && mentionsUnsupported && parameter) {
    error.code = "IMAGE_PARAMETER_UNSUPPORTED";
    error.retryable = false;
    error.message = `当前生图上游不支持 ${parameter} 参数，请切换兼容模型或检查上游接口文档。上游返回：${error.message}`;
  }
  return error;
}

async function requestJson(url, payload, apiKey, extraHeaders = {}, meta = {}) {
  const body = JSON.stringify(sanitizeVisionRequestPayload(payload, Object.assign({}, meta, { url })));
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: Object.assign(
      {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      apiKeyHeaders(apiKey),
      extraHeaders
    )
  }, body, meta);
  if (response.status < 200 || response.status >= 300) {
    throw meta.imageGeneration
      ? imageUpstreamError(response)
      : upstreamError(response);
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
  const headers = Object.assign(apiKeyHeaders(apiKey), extraHeaders);
  if (hasBody) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const response = await requestWithRetry(url, {
    method,
    headers
  }, body, meta);
  if (response.status < 200 || response.status >= 300) {
    throw meta.imageGeneration
      ? imageUpstreamError(response)
      : upstreamError(response);
  }
  return response.json || {};
}

function isPrivateTransferIpv4(hostname) {
  const match = String(hostname || "").match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return (
    first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224
  );
}

function isPrivateTransferHostname(hostname) {
  const normalized = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (
    !normalized
    || normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
  ) {
    return true;
  }
  return isPrivateTransferIpv4(normalized);
}

function validateTransferMediaUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch (_error) {
    return { ok: false, message: "媒体地址无效。" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, message: "媒体地址只支持 HTTPS。" };
  }
  if (
    parsed.username
    || parsed.password
    || isPrivateTransferHostname(parsed.hostname)
  ) {
    return { ok: false, message: "媒体地址不允许访问内网或私有地址。" };
  }
  return { ok: true, url: parsed.toString() };
}

function transferMediaTypeFromBuffer(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (source.length >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    source.length >= 8
    && source[0] === 0x89
    && source[1] === 0x50
    && source[2] === 0x4e
    && source[3] === 0x47
    && source[4] === 0x0d
    && source[5] === 0x0a
    && source[6] === 0x1a
    && source[7] === 0x0a
  ) {
    return { kind: "image", mimeType: "image/png", extension: "png" };
  }
  if (
    source.length >= 12
    && source.subarray(0, 4).toString("ascii") === "RIFF"
    && source.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "image", mimeType: "image/webp", extension: "webp" };
  }
  if (source.length >= 6 && ["GIF87a", "GIF89a"].includes(source.subarray(0, 6).toString("ascii"))) {
    return { kind: "image", mimeType: "image/gif", extension: "gif" };
  }
  if (source.length >= 12 && source.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = source.subarray(8, 12).toString("ascii").toLowerCase();
    const isQuickTime = brand === "qt  ";
    return {
      kind: "video",
      mimeType: isQuickTime ? "video/quicktime" : "video/mp4",
      extension: isQuickTime ? "mov" : "mp4"
    };
  }
  if (
    source.length >= 4
    && source[0] === 0x1a
    && source[1] === 0x45
    && source[2] === 0xdf
    && source[3] === 0xa3
  ) {
    return { kind: "video", mimeType: "video/webm", extension: "webm" };
  }
  return null;
}

function transferMediaLimit(kind) {
  return kind === "image"
    ? WATERMARK_TRANSFER_MAX_IMAGE_BYTES
    : WATERMARK_TRANSFER_MAX_VIDEO_BYTES;
}

function requestTransferMedia(url, options = {}) {
  const kind = String(options.kind || "").trim().toLowerCase();
  const maxBytes = transferMediaLimit(kind);
  const redirectCount = Math.max(0, Number(options.redirectCount) || 0);
  const validation = validateTransferMediaUrl(url);
  if (!validation.ok) {
    const error = new Error(validation.message);
    error.code = "WATERMARK_TRANSFER_URL_INVALID";
    error.retryable = false;
    return Promise.reject(error);
  }
  if (redirectCount > WATERMARK_TRANSFER_MAX_REDIRECTS) {
    const error = new Error("媒体地址重定向次数过多。");
    error.code = "WATERMARK_TRANSFER_REDIRECT_LIMIT";
    error.retryable = false;
    return Promise.reject(error);
  }

  const parsed = new URL(validation.url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request({
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname || "/"}${parsed.search || ""}`,
      headers: {
        Accept: kind === "image"
          ? "image/*,application/octet-stream;q=0.8"
          : "video/*,application/octet-stream;q=0.8",
        "User-Agent": "aips-watermark-transfer/1.0"
      }
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if (
        statusCode >= 300
        && statusCode < 400
        && response.headers
        && response.headers.location
      ) {
        response.resume();
        if (redirectCount >= WATERMARK_TRANSFER_MAX_REDIRECTS) {
          const error = new Error("媒体地址重定向次数过多。");
          error.code = "WATERMARK_TRANSFER_REDIRECT_LIMIT";
          error.retryable = false;
          reject(error);
          return;
        }
        let nextUrl;
        try {
          nextUrl = new URL(response.headers.location, validation.url).toString();
        } catch (_error) {
          const error = new Error("媒体地址重定向无效。");
          error.code = "WATERMARK_TRANSFER_REDIRECT_INVALID";
          error.retryable = false;
          reject(error);
          return;
        }
        requestTransferMedia(nextUrl, {
          kind,
          redirectCount: redirectCount + 1,
          requestId: options.requestId
        }).then(resolve, reject);
        return;
      }
      const contentLength = Number(response.headers && response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.resume();
        const error = new Error(
          `${kind === "image" ? "图片" : "视频"}文件超过大小限制。`
        );
        error.code = "WATERMARK_TRANSFER_TOO_LARGE";
        error.retryable = false;
        reject(error);
        return;
      }
      const chunks = [];
      let received = 0;
      let tooLarge = false;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          tooLarge = true;
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (tooLarge) {
          const error = new Error(
            `${kind === "image" ? "图片" : "视频"}文件超过大小限制。`
          );
          error.code = "WATERMARK_TRANSFER_TOO_LARGE";
          error.retryable = false;
          reject(error);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`媒体源返回 HTTP ${statusCode || "未知状态"}。`);
          error.code = "WATERMARK_TRANSFER_SOURCE_FAILED";
          error.status = statusCode;
          error.retryable = statusCode >= 500;
          reject(error);
          return;
        }
        if (!chunks.length) {
          const error = new Error("媒体源返回空文件。");
          error.code = "WATERMARK_TRANSFER_EMPTY";
          error.retryable = false;
          reject(error);
          return;
        }
        if (!settled) {
          settled = true;
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: String(response.headers && response.headers["content-type"] || "")
              .split(";")[0]
              .trim()
              .toLowerCase(),
            finalUrl: validation.url
          });
        }
      });
      response.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    request.setTimeout(
      Math.max(5000, Number(options.timeoutMs) || WATERMARK_TRANSFER_TIMEOUT_MS),
      () => {
        const error = new Error("媒体下载超时。");
        error.code = "WATERMARK_TRANSFER_TIMEOUT";
        error.retryable = true;
        request.destroy(error);
      }
    );
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    request.end();
  });
}

function normalizeWatermarkTransferKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  return ["image", "video"].includes(kind) ? kind : "";
}

function watermarkTransferDocumentId(transferId) {
  return crypto
    .createHash("sha256")
    .update(String(transferId || ""))
    .digest("hex")
    .slice(0, 30);
}

function watermarkTransferOwnerHash(openid) {
  return crypto
    .createHash("sha256")
    .update(String(openid || "anonymous"))
    .digest("hex")
    .slice(0, 24);
}

function isWatermarkTransferFileMissing(error) {
  return /not.?found|不存在|file.?not.?exist|no such file|404/i
    .test(sanitizeFailureMessage(error && (error.errMsg || error.message) || error, 240));
}

async function deleteWatermarkTransferFile(fileID, cloudClient = cloud) {
  const response = await cloudClient.deleteFile({ fileList: [fileID] });
  const item = response && Array.isArray(response.fileList)
    ? response.fileList.find((entry) => entry && entry.fileID === fileID)
    : null;
  if (item && Number(item.status) !== 0) {
    const error = new Error(item.errMsg || "临时媒体删除失败。");
    error.code = "WATERMARK_TRANSFER_DELETE_FAILED";
    throw error;
  }
  return response;
}

function watermarkTransferFilePath(ownerOpenId, transferId, extension) {
  return [
    "watermark-transfer",
    watermarkTransferOwnerHash(ownerOpenId),
    `${watermarkTransferDocumentId(transferId)}.${extension}`
  ].join("/");
}

async function transferMedia(event = {}, context = {}, dependencies = {}) {
  const cloudClient = dependencies.cloud || cloud;
  const database = dependencies.db || db;
  const requestMedia = dependencies.requestTransferMedia || requestTransferMedia;
  const deleteFile = dependencies.deleteFile
    || ((fileID) => deleteWatermarkTransferFile(fileID, cloudClient));
  const kind = normalizeWatermarkTransferKind(event.kind);
  const requestId = String(event.requestId || createRequestId("transfer")).trim();
  if (!kind) return fail("媒体类型只能是图片或视频。", "WATERMARK_TRANSFER_KIND_INVALID");
  const validation = validateTransferMediaUrl(event.url);
  if (!validation.ok) return fail(validation.message, "WATERMARK_TRANSFER_URL_INVALID");
  const ownerOpenId = getOpenId(context);
  // 转存编号必须由服务端生成，不能接受客户端传入，避免覆盖其他用户的临时记录。
  const transferId = createRequestId("transfer");
  const documentId = watermarkTransferDocumentId(transferId);
  let downloaded;
  try {
    downloaded = await requestMedia(validation.url, {
      kind,
      requestId
    });
  } catch (error) {
    const errorCode = error && error.code === "WATERMARK_TRANSFER_TOO_LARGE"
      ? error.code
      : error && error.code === "WATERMARK_TRANSFER_URL_INVALID"
        ? error.code
        : error && error.code === "WATERMARK_TRANSFER_REDIRECT_LIMIT"
          ? error.code
          : "WATERMARK_TRANSFER_DOWNLOAD_FAILED";
    return fail(
      error && error.message || "第三方媒体下载失败。",
      errorCode,
      { retryable: Boolean(error && error.retryable) }
    );
  }
  const detected = transferMediaTypeFromBuffer(downloaded.buffer);
  if (!detected || detected.kind !== kind) {
    return fail(
      `第三方返回的文件不是有效的${kind === "image" ? "图片" : "视频"}。`,
      "WATERMARK_TRANSFER_MEDIA_TYPE_INVALID"
    );
  }
  const now = new Date();
  const cleanupAfter = new Date(now.getTime() + WATERMARK_TRANSFER_TTL_MS);
  const cloudPath = watermarkTransferFilePath(ownerOpenId, transferId, detected.extension);
  let fileID = "";
  try {
    const uploaded = await cloudClient.uploadFile({
      cloudPath,
      fileContent: downloaded.buffer
    });
    fileID = String(uploaded && uploaded.fileID || "").trim();
    if (!fileID) throw new Error("CloudBase 上传没有返回 fileID。");
    await database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION).doc(documentId).set({
      data: {
        transferId,
        fileID,
        ownerOpenId,
        kind,
        mimeType: detected.mimeType,
        sizeBytes: downloaded.buffer.length,
        createdAt: now,
        cleanupAfter,
        status: "pending",
        attempts: 0,
        lastError: "",
        updatedAt: now
      }
    });
  } catch (error) {
    if (fileID) {
      try {
        await deleteFile(fileID);
      } catch (cleanupError) {
        log("warn", "watermark-transfer.orphan-cleanup-failed", {
          requestId,
          fileID,
          error: sanitizeFailureMessage(cleanupError)
        });
      }
    }
    return fail(
      "媒体转存到 CloudBase 失败，请稍后重试。",
      "WATERMARK_TRANSFER_UPLOAD_FAILED",
      { retryable: true }
    );
  }
  log("info", "watermark-transfer.success", {
    requestId,
    transferId,
    kind,
    sizeBytes: downloaded.buffer.length,
    mimeType: detected.mimeType,
    fileID
  });
  return jsonResponse(true, {
    requestId,
    transferId,
    fileID,
    kind,
    mimeType: detected.mimeType,
    sizeBytes: downloaded.buffer.length,
    cleanupAfter: cleanupAfter.toISOString()
  });
}

async function releaseTransferMedia(event = {}, context = {}, dependencies = {}) {
  const database = dependencies.db || db;
  const deleteFile = dependencies.deleteFile
    || ((fileID) => deleteWatermarkTransferFile(fileID, dependencies.cloud || cloud));
  const transferId = compactUsageText(event.transferId, 100);
  const fileID = String(event.fileID || "").trim();
  if (!transferId || !fileID) {
    return fail("缺少临时媒体清理参数。", "WATERMARK_TRANSFER_RELEASE_INVALID");
  }
  const ownerOpenId = getOpenId(context);
  const ref = database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION)
    .doc(watermarkTransferDocumentId(transferId));
  const row = await readDocument(ref);
  if (!row) {
    return jsonResponse(true, {
      transferId,
      fileID,
      released: true,
      alreadyGone: true
    });
  }
  if (
    String(row.transferId || "") !== transferId
    || String(row.fileID || "") !== fileID
    || String(row.ownerOpenId || "anonymous") !== ownerOpenId
  ) {
    return fail("无权清理这份临时媒体。", "WATERMARK_TRANSFER_RELEASE_FORBIDDEN");
  }
  try {
    await deleteFile(fileID);
    await ref.remove();
    return jsonResponse(true, {
      transferId,
      fileID,
      released: true
    });
  } catch (error) {
    if (isWatermarkTransferFileMissing(error)) {
      await ref.remove();
      return jsonResponse(true, {
        transferId,
        fileID,
        released: true,
        alreadyGone: true
      });
    }
    await ref.update({
      data: {
        status: "failed",
        attempts: Math.max(0, Number(row.attempts) || 0) + 1,
        lastError: sanitizeFailureMessage(error),
        updatedAt: new Date()
      }
    });
    return jsonResponse(true, {
      transferId,
      fileID,
      released: false,
      pendingCleanup: true
    });
  }
}

async function cleanupWatermarkTransferTempAssets(baseDate = new Date(), dependencies = {}) {
  const database = dependencies.db || db;
  const deleteFile = dependencies.deleteFile
    || ((fileID) => deleteWatermarkTransferFile(fileID, dependencies.cloud || cloud));
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  const result = await database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION)
    .where({ cleanupAfter: database.command.lte(now) })
    .limit(WATERMARK_TRANSFER_CLEANUP_BATCH_SIZE)
    .get();
  const rows = result && Array.isArray(result.data) ? result.data : [];
  let removed = 0;
  let failed = 0;
  let retried = 0;
  for (const row of rows) {
    if (!row || !row._id || !row.fileID) continue;
    try {
      await deleteFile(row.fileID);
      await database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION).doc(row._id).remove();
      removed += 1;
    } catch (error) {
      if (isWatermarkTransferFileMissing(error)) {
        await database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION).doc(row._id).remove();
        removed += 1;
        continue;
      }
      failed += 1;
      retried += 1;
      await database.collection(WATERMARK_TRANSFER_TEMP_COLLECTION).doc(row._id).update({
        data: {
          status: "failed",
          attempts: Math.max(0, Number(row.attempts) || 0) + 1,
          lastError: sanitizeFailureMessage(error),
          updatedAt: new Date()
        }
      });
      log("warn", "watermark-transfer.cleanup-failed", {
        transferId: row.transferId,
        fileID: row.fileID,
        error: sanitizeFailureMessage(error)
      });
    }
  }
  const summary = {
    skipped: false,
    cutoff: now.toISOString(),
    scanned: rows.length,
    removed,
    retried,
    failed,
    truncated: rows.length >= WATERMARK_TRANSFER_CLEANUP_BATCH_SIZE
  };
  log("info", "watermark-transfer.cleanup", summary);
  return jsonResponse(true, summary);
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
    backgroundDescription: firstText(
      parsed.backgroundDescription || parsed.background || parsed["背景"],
      "沿用主图现有背景环境、空间层次、材质、色调和光线氛围。"
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

function getOpenId(context, wxContextProvider) {
  const directOpenId = context && (context.OPENID || context.openid);
  if (directOpenId) return String(directOpenId);

  const resolveWxContext = typeof wxContextProvider === "function"
    ? wxContextProvider
    : cloud && typeof cloud.getWXContext === "function"
      ? () => cloud.getWXContext()
      : null;
  if (resolveWxContext) {
    try {
      const wxContext = resolveWxContext() || {};
      const sdkOpenId = wxContext.OPENID || wxContext.openid;
      if (sdkOpenId) return String(sdkOpenId);
    } catch (error) {
      log("warn", "auth.context-failed", {
        message: error && error.message ? error.message : String(error)
      });
    }
  }

  return "anonymous";
}

function adminOpenIds() {
  return env("ADMIN_OPENIDS")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAdminContext(context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") return false;
  const configured = adminOpenIds();
  return configured.includes(openid) || configured.includes(usageUserHash(openid));
}

function adminForbidden() {
  return fail("没有管理员权限。", "ADMIN_FORBIDDEN");
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function canonicalAdminProviderId(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return hasOwn(DEFAULT_ADMIN_PROVIDER_LABELS, lower) ? lower : raw;
}

function sortAdminProviderLabels(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.keys(source)
    .sort((left, right) => left.localeCompare(right, undefined, {
      sensitivity: "base"
    }))
    .reduce((output, key) => Object.assign(output, {
      [key]: source[key]
    }), {});
}

function normalizeAdminProviderLabels(input, options = {}) {
  const output = Object.create(null);
  if (options.includeDefaults) {
    Object.keys(DEFAULT_ADMIN_PROVIDER_LABELS).forEach((key) => {
      output[key] = DEFAULT_ADMIN_PROVIDER_LABELS[key];
    });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return sortAdminProviderLabels(output);
  }
  Object.getOwnPropertyNames(input).forEach((rawKey) => {
    const key = canonicalAdminProviderId(rawKey);
    const forbiddenKey = String(key || "").toLowerCase();
    const label = String(input[rawKey] === undefined || input[rawKey] === null
      ? ""
      : input[rawKey]).trim();
    if (
      !key
      || key.length > 120
      || FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(forbiddenKey)
      || !label
      || label.length > 20
    ) {
      return;
    }
    output[key] = label;
  });
  return sortAdminProviderLabels(output);
}

function mergeAdminProviderLabels(current, patch) {
  return sortAdminProviderLabels(Object.assign(
    {},
    normalizeAdminProviderLabels(current),
    normalizeAdminProviderLabels(patch)
  ));
}

// 主视频和备用视频共用同一套服务商档案，备用项额外保存显式开关。
const ADMIN_PROVIDER_PROFILE_SECTIONS = Object.freeze([
  "face",
  "analysis",
  "image",
  "imageBackup",
  "video"
]);
const ADMIN_PROVIDER_PROFILE_KEYS = Object.freeze({
  face: Object.freeze([
    "provider",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "timeoutMs"
  ]),
  analysis: Object.freeze([
    "provider",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "timeoutMs"
  ]),
  image: Object.freeze([
    "provider",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "mode",
    "size",
    "resolution",
    "compatibilityMode",
    "timeoutMs",
    "maxRetries",
    "retryEnabled",
    "retryPreferenceVersion"
  ]),
  imageBackup: Object.freeze([
    "enabled",
    "provider",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "mode",
    "size",
    "resolution",
    "compatibilityMode",
    "timeoutMs",
    "maxRetries",
    "retryEnabled",
    "retryPreferenceVersion"
  ]),
  video: Object.freeze([
    "enabled",
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
  ]),
});

function isAdminProviderObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeAdminProviderId(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return "";
  const canonical = canonicalAdminProviderId(raw);
  if (hasOwn(DEFAULT_ADMIN_PROVIDER_LABELS, canonical)) return canonical;
  const builtInFromLabel = Object.keys(DEFAULT_ADMIN_PROVIDER_LABELS).find(
    (providerId) => DEFAULT_ADMIN_PROVIDER_LABELS[providerId] === raw
  );
  return builtInFromLabel || canonical;
}

function isDangerousAdminProviderId(value) {
  return FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(
    String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  );
}

function sortAdminProviderObject(value) {
  const source = isAdminProviderObject(value) ? value : {};
  return Object.keys(source)
    .sort((left, right) => left.localeCompare(right, "zh-CN", {
      numeric: true,
      sensitivity: "base"
    }))
    .reduce((result, key) => {
      result[key] = source[key];
      return result;
    }, {});
}

function normalizeAdminProviderProfileValue(section, value, providerId) {
  const source = isAdminProviderObject(value) ? value : {};
  const normalizedProviderId = normalizeAdminProviderId(
    providerId || source.provider
  );
  const result = {};
  (ADMIN_PROVIDER_PROFILE_KEYS[section] || []).forEach((key) => {
    if (!hasOwn(source, key)) return;
    if (key === "provider") return;
    if (key === "apiKey") {
      result.apiKey = normalizeApiKey(source.apiKey);
      return;
    }
    if (key === "compatibilityMode" || key === "retryEnabled" || key === "enabled") {
      result[key] = overrideBoolean(source, key, false);
      return;
    }
    result[key] = source[key];
  });
  if (normalizedProviderId) result.provider = normalizedProviderId;
  return result;
}

function normalizeAdminProviderProfiles(value) {
  const source = isAdminProviderObject(value) ? value : {};
  const result = {};
  ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
    const rawSection = isAdminProviderObject(source[section])
      ? source[section]
      : {};
    const profiles = {};
    Object.keys(rawSection).forEach((rawProviderId) => {
      const providerId = normalizeAdminProviderId(rawProviderId);
      if (!providerId || isDangerousAdminProviderId(providerId)) return;
      const rawProfile = rawSection[rawProviderId];
      if (!isAdminProviderObject(rawProfile)) return;
      profiles[providerId] = normalizeAdminProviderProfileValue(
        section,
        rawProfile,
        providerId
      );
    });
    result[section] = sortAdminProviderObject(profiles);
  });
  return result;
}

function mergeAdminProviderProfiles(current, patch) {
  const existing = normalizeAdminProviderProfiles(current);
  const submitted = normalizeAdminProviderProfiles(patch);
  const result = {};
  ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
    const profiles = {};
    const providerIds = new Set([
      ...Object.keys(existing[section] || {}),
      ...Object.keys(submitted[section] || {})
    ]);
    Array.from(providerIds).forEach((providerId) => {
      const submittedProfile = Object.assign(
        {},
        submitted[section] && submitted[section][providerId] || {}
      );
      if (hasOwn(submittedProfile, "apiKey") && !normalizeApiKey(submittedProfile.apiKey)) {
        delete submittedProfile.apiKey;
      }
      profiles[providerId] = Object.assign(
        {},
        existing[section] && existing[section][providerId] || {},
        submittedProfile,
        { provider: providerId }
      );
    });
    result[section] = sortAdminProviderObject(profiles);
  });
  return result;
}

function syncAdminTopLevelProviderProfiles(config, baseProfiles) {
  const source = isAdminProviderObject(config) ? config : {};
  const profiles = mergeAdminProviderProfiles(
    baseProfiles || source.providerProfiles,
    {}
  );
  ADMIN_PROVIDER_CONFIG_SECTIONS.forEach((section) => {
    const topLevel = isAdminProviderObject(source[section]) ? source[section] : {};
    const providerId = normalizeAdminProviderId(topLevel.provider);
    if (!providerId || isDangerousAdminProviderId(providerId)) return;
    const profileSection = section === "videoBackup" ? "video" : section;
    if (
      section === "videoBackup"
      && normalizeAdminProviderId(source.video && source.video.provider) === providerId
    ) {
      return;
    }
    profiles[profileSection][providerId] = Object.assign(
      {},
      profiles[profileSection][providerId] || {},
      normalizeAdminProviderProfileValue(profileSection, topLevel, providerId),
      { provider: providerId }
    );
    profiles[profileSection] = sortAdminProviderObject(profiles[profileSection]);
  });
  return profiles;
}

function configuredAdminProviderIds(config) {
  const source = isAdminProviderObject(config) ? config : {};
  const result = new Set();
  ADMIN_PROVIDER_CONFIG_SECTIONS.forEach((section) => {
    const providerId = normalizeAdminProviderId(
      source[section] && source[section].provider
    );
    if (providerId && !isDangerousAdminProviderId(providerId)) result.add(providerId);
  });
  const profiles = normalizeAdminProviderProfiles(source.providerProfiles);
  ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
    Object.keys(profiles[section] || {}).forEach((providerId) => result.add(providerId));
  });
  return Array.from(result).sort((left, right) => left.localeCompare(right, "zh-CN", {
    numeric: true,
    sensitivity: "base"
  }));
}

function adminProviderLabelFor(labels, providerId) {
  const source = labels && typeof labels === "object" ? labels : {};
  const id = canonicalAdminProviderId(providerId);
  if (!id) return "";
  if (hasOwn(source, id)) return String(source[id] || "").trim();
  const matchedKey = Object.keys(source).find((key) => (
    String(key).toLowerCase() === id.toLowerCase()
  ));
  return matchedKey ? String(source[matchedKey] || "").trim() : "";
}

function validateAdminProviderLabels(labels, config) {
  const errors = [];
  if (
    labels !== undefined
    && (
      !labels
      || typeof labels !== "object"
      || Array.isArray(labels)
    )
  ) {
    return ["providerLabels 必须是对象"];
  }
  const raw = labels && typeof labels === "object" ? labels : {};
  Object.getOwnPropertyNames(raw).forEach((rawKey) => {
    const key = canonicalAdminProviderId(rawKey);
    const forbiddenKey = String(key || "").toLowerCase();
    const label = String(raw[rawKey] === undefined || raw[rawKey] === null
      ? ""
      : raw[rawKey]).trim();
    if (
      !key
      || key.length > 120
      || FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(forbiddenKey)
    ) {
      errors.push(`服务商标识 ${String(rawKey || "未填写").slice(0, 120)} 不合法`);
      return;
    }
    if (!label || label.length > 20 || !/[\u3400-\u9fff]/.test(label)) {
      errors.push(`服务商 ${key} 还没有合格的中文名称`);
    }
  });
  const normalized = normalizeAdminProviderLabels(raw, { includeDefaults: true });
  configuredAdminProviderIds(config).forEach((providerId) => {
    const label = adminProviderLabelFor(normalized, providerId);
    if (!label || !/[\u3400-\u9fff]/.test(label)) {
      errors.push(`服务商 ${providerId} 还没有中文名称，请先填写`);
    }
  });
  return Array.from(new Set(errors));
}

function mergeAdminRuntimeProviderSection(
  section,
  existingSection,
  patchSection,
  profiles,
  profileSection = section
) {
  const existingValue = isAdminProviderObject(existingSection) ? existingSection : {};
  const submittedValue = isAdminProviderObject(patchSection) ? patchSection : {};
  if (!Object.keys(submittedValue).length) return Object.assign({}, existingValue);
  const existingProviderId = normalizeAdminProviderId(existingValue.provider);
  const providerId = hasOwn(submittedValue, "provider")
    ? normalizeAdminProviderId(submittedValue.provider)
    : existingProviderId;
  const storedProfile = providerId
    && profiles[profileSection]
    && profiles[profileSection][providerId]
    ? profiles[profileSection][providerId]
    : {};
  const sameExistingProvider = providerId === existingProviderId
    ? existingValue
    : {};
  return Object.assign(
    {},
    sameExistingProvider,
    storedProfile,
    submittedValue,
    providerId ? { provider: providerId } : {}
  );
}

function normalizeLegacyRuntimePatch(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const providerLabels = hasOwn(source, "providerLabels")
    ? normalizeAdminProviderLabels(source.providerLabels)
    : {};
  const faceSource = source.face && typeof source.face === "object" ? source.face : {};
  const faceBackupSource = source.faceBackup && typeof source.faceBackup === "object"
    ? source.faceBackup
    : {};
  const analysisSource = source.analysis && typeof source.analysis === "object"
    ? source.analysis
    : {};
  const analysisBackupSource = source.analysisBackup && typeof source.analysisBackup === "object"
    ? source.analysisBackup
    : {};
  const imageSource = source.image && typeof source.image === "object" ? source.image : {};
  const imageBackupSource = source.imageBackup && typeof source.imageBackup === "object"
    ? source.imageBackup
    : {};
  const tencentFaceFusionSource = source.tencentFaceFusion
    && typeof source.tencentFaceFusion === "object"
    ? source.tencentFaceFusion
    : {};
  const videoSource = source.video && typeof source.video === "object" ? source.video : {};
  const videoBackupSource = source.videoBackup && typeof source.videoBackup === "object"
    ? source.videoBackup
    : {};
  const pointsSource = source.points && typeof source.points === "object" ? source.points : {};
  const costsSource = source.costs && typeof source.costs === "object" ? source.costs : {};
  const generationQueueSource = source.generationQueue
    && typeof source.generationQueue === "object"
    ? source.generationQueue
    : {};
  const faceCostSource = costsSource.face && typeof costsSource.face === "object"
    ? costsSource.face
    : {};
  const analysisCostSource = costsSource.analysis && typeof costsSource.analysis === "object"
    ? costsSource.analysis
    : {};
  const imageCostSource = costsSource.image && typeof costsSource.image === "object"
    ? costsSource.image
    : {};
  const imageProviderCostSource = imageCostSource.providers
    && typeof imageCostSource.providers === "object"
    ? imageCostSource.providers
    : {};
  const videoCostSource = costsSource.video && typeof costsSource.video === "object"
    ? costsSource.video
    : {};
  const faceKeys = [
    "provider",
    "providerKey",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "timeoutMs"
  ];
  const imageKeys = [
    "enabled",
    "provider",
    "providerKey",
    "baseUrl",
    "endpoint",
    "apiKey",
    "model",
    "mode",
    "size",
    "resolution",
    "compatibilityMode",
    "timeoutMs",
    "maxRetries",
    "retryEnabled",
    "retryPreferenceVersion"
  ];
  const tencentFaceFusionKeys = [
    "secretId",
    "secretKey",
    "region",
    "endpoint",
    "apiVersion",
    "action",
    "model",
    "swapModelType",
    "logoAdd",
    "timeoutMs",
    "maxImageBytes"
  ];
  const videoKeys = [
    "provider",
    "providerKey",
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
  const generationQueueKeys = [
    "workerConcurrency",
    "alertThreshold",
    "alertCooldownMinutes"
  ];
  const faceConfig = {};
  const faceBackup = {};
  const analysis = {};
  const analysisBackup = {};
  const image = {};
  const imageBackup = {};
  const tencentFaceFusion = {};
  const video = {};
  const videoBackup = {};
  const points = {};
  const costs = {};
  const face = {};
  const analysisPricing = {};
  const imagePricing = {};
  const imageProviderPricing = {};
  const videoPricing = {};
  const generationQueue = {};
  faceKeys.forEach((key) => {
    if (hasOwn(faceSource, key)) {
      faceConfig[key] = key === "apiKey"
        ? normalizeApiKey(faceSource[key])
        : faceSource[key];
    }
  });
  faceKeys.concat(["enabled"]).forEach((key) => {
    if (!hasOwn(faceBackupSource, key)) return;
    faceBackup[key] = key === "apiKey"
      ? normalizeApiKey(faceBackupSource[key])
      : key === "enabled"
        ? overrideBoolean(faceBackupSource, key, false)
        : faceBackupSource[key];
  });
  faceKeys.forEach((key) => {
    if (hasOwn(analysisSource, key)) {
      analysis[key] = key === "apiKey"
        ? normalizeApiKey(analysisSource[key])
        : analysisSource[key];
    }
  });
  faceKeys.concat(["enabled"]).forEach((key) => {
    if (!hasOwn(analysisBackupSource, key)) return;
    analysisBackup[key] = key === "apiKey"
      ? normalizeApiKey(analysisBackupSource[key])
      : key === "enabled"
        ? overrideBoolean(analysisBackupSource, key, false)
        : analysisBackupSource[key];
  });
  imageKeys.forEach((key) => {
    if (hasOwn(imageSource, key)) {
      image[key] = key === "apiKey"
        ? normalizeApiKey(imageSource[key])
        : key === "compatibilityMode" || key === "enabled"
          ? overrideBoolean(imageSource, key, false)
        : imageSource[key];
    }
  });
  imageKeys.forEach((key) => {
    if (hasOwn(imageBackupSource, key)) {
      imageBackup[key] = key === "apiKey"
        ? normalizeApiKey(imageBackupSource[key])
        : key === "compatibilityMode" || key === "enabled"
          ? overrideBoolean(imageBackupSource, key, false)
        : imageBackupSource[key];
    }
  });
  tencentFaceFusionKeys.forEach((key) => {
    if (!hasOwn(tencentFaceFusionSource, key)) return;
    if (
      [
        "secretId",
        "secretKey",
        "region",
        "endpoint",
        "apiVersion",
        "action",
        "model"
      ].includes(key)
    ) {
      tencentFaceFusion[key] = String(
        tencentFaceFusionSource[key] === undefined
          || tencentFaceFusionSource[key] === null
          ? ""
          : tencentFaceFusionSource[key]
      ).trim();
    } else if (key === "logoAdd") {
      tencentFaceFusion[key] = overrideBoolean(
        tencentFaceFusionSource,
        key,
        false
      );
    } else {
      tencentFaceFusion[key] = tencentFaceFusionSource[key];
    }
  });
  videoKeys.forEach((key) => {
    if (hasOwn(videoSource, key)) {
      video[key] = key === "apiKey"
        ? normalizeApiKey(videoSource[key])
        : videoSource[key];
    }
  });
  if (hasOwn(videoBackupSource, "enabled")) {
    videoBackup.enabled = overrideBoolean(videoBackupSource, "enabled", false);
  }
  videoKeys.forEach((key) => {
    if (hasOwn(videoBackupSource, key)) {
      videoBackup[key] = key === "apiKey"
        ? normalizeApiKey(videoBackupSource[key])
        : videoBackupSource[key];
    }
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
  faceCostKeys.forEach((key) => {
    if (hasOwn(analysisCostSource, key)) analysisPricing[key] = analysisCostSource[key];
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
  Object.keys(imageProviderCostSource).forEach((provider) => {
    // 自定义服务商成本键使用外部 ID，保留旧版星炬/凌云结构并允许动态扩展。
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(provider))) return;
    const providerSource = imageProviderCostSource[provider]
      && typeof imageProviderCostSource[provider] === "object"
      ? imageProviderCostSource[provider]
      : {};
    ["1K", "2K", "4K"].forEach((key) => {
      if (!hasOwn(providerSource.perImage, key)) return;
      imageProviderPricing[provider] = Object.assign(
        {},
        imageProviderPricing[provider],
        {
          perImage: Object.assign(
            {},
            imageProviderPricing[provider] && imageProviderPricing[provider].perImage,
            { [key]: providerSource.perImage[key] }
          )
        }
      );
    });
  });
  if (Object.keys(imageProviderPricing).length) {
    imagePricing.providers = imageProviderPricing;
  }
  ["480p", "720p", "1080p"].forEach((key) => {
    if (hasOwn(videoCostSource.perSecond, key)) {
      videoPricing.perSecond = Object.assign({}, videoPricing.perSecond, {
        [key]: videoCostSource.perSecond[key]
      });
    }
  });
  generationQueueKeys.forEach((key) => {
    if (hasOwn(generationQueueSource, key)) {
      generationQueue[key] = generationQueueSource[key];
    }
  });
  if (Object.keys(face).length) costs.face = face;
  if (Object.keys(analysisPricing).length) costs.analysis = analysisPricing;
  if (Object.keys(imagePricing).length) costs.image = imagePricing;
  if (Object.keys(videoPricing).length) costs.video = videoPricing;
  const result = {
    face: faceConfig,
    faceBackup,
    analysis,
    analysisBackup,
    image,
    imageBackup,
    tencentFaceFusion,
    video,
    videoBackup,
    points,
    costs,
    generationQueue
  };
  if (hasOwn(source, "activeBackups")) {
    result.activeBackups = normalizeActiveBackups(
      source.activeBackups,
      normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true })
    );
  }
  if (hasOwn(source, "providerLabels")) {
    result.providerLabels = isAdminProviderObject(source.providerLabels)
      ? normalizeAdminProviderLabels(source.providerLabels)
      : source.providerLabels;
  }
  if (hasOwn(source, "providerProfiles")) {
    result.providerProfiles = isAdminProviderObject(source.providerProfiles)
      ? normalizeAdminProviderProfiles(source.providerProfiles)
      : source.providerProfiles;
  }
  return result;
}

function isProviderObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function providerText(value, maximum = 240) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .slice(0, maximum);
}

function providerBuiltinKey(value) {
  const text = providerText(value, 160).toLowerCase();
  if (!text) return "";
  if (["dashscope", "aliyun", "ali", "阿里云", "阿里云百炼", "百炼"].includes(text)) {
    return "dashscope";
  }
  if (["xingju", "星炬", "星炬官方"].includes(text)) return "xingju";
  if (["lingyun", "凌云", "凌云官方"].includes(text)) return "lingyun";
  return "";
}

function providerStableKey(value) {
  const text = providerText(value, 240).toLowerCase();
  if (!text) return "";
  const builtin = providerBuiltinKey(text);
  if (builtin) return builtin;
  const hex = crypto.createHash("sha256").update(text).digest("hex").slice(0, 32).split("");
  // 用稳定的 UUID v5 形态生成内部键；外部 ID 改名时该键不变。
  hex[12] = "5";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return [
    hex.slice(0, 8).join(""),
    hex.slice(8, 12).join(""),
    hex.slice(12, 16).join(""),
    hex.slice(16, 20).join(""),
    hex.slice(20, 32).join("")
  ].join("-");
}

function isProviderUuidKey(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    providerText(value, 128)
  );
}

function normalizeProviderKey(value, fallback = "") {
  const raw = providerText(value, 128);
  if (!raw) {
    const fallbackText = providerText(fallback, 128);
    if (!fallbackText) return "";
    const fallbackBuiltin = providerBuiltinKey(fallbackText);
    return fallbackBuiltin
      || (isProviderUuidKey(fallbackText)
        ? fallbackText.toLowerCase()
        : providerStableKey(fallbackText));
  }
  const builtin = providerBuiltinKey(raw);
  if (builtin) return builtin;
  if (/^(?:__proto__|prototype|constructor)$/i.test(raw)) return "";
  // 自定义服务商的内部键只能是稳定 UUID。旧版本可能把外部 ID 或
  // provider-<hash> 当作键，这里按旧键重新计算 UUID，确保改名后仍可沿用。
  return isProviderUuidKey(raw) ? raw.toLowerCase() : providerStableKey(raw);
}

function normalizeProviderId(value, fallback = "") {
  const raw = providerText(value, 120);
  if (!raw) return fallback || "";
  return providerBuiltinKey(raw) || raw;
}

function providerDefaultName(id) {
  const key = providerBuiltinKey(id) || providerText(id, 120).toLowerCase();
  const known = {
    dashscope: "阿里云百炼",
    xingju: "星炬",
    lingyun: "凌云"
  }[key];
  if (known) return known;
  // 迁移时没有外部名称的档案可能只有内部 UUID；不要把 UUID 当成
  // 超过目录约束的显示名称，管理员仍可在编辑器里改成真实中文名。
  if (isProviderUuidKey(id)) return "未命名服务商";
  return providerText(id, 20) || "未命名服务商";
}

function normalizeAdminProviderLabels(value, options = {}) {
  const result = {};
  if (options.includeDefaults === true) Object.assign(result, DEFAULT_ADMIN_PROVIDER_LABELS);
  if (!isProviderObject(value)) return result;
  Object.getOwnPropertyNames(value).forEach((rawKey) => {
    // 内置别名统一为 canonical key；自定义 id 保留外部大小写，避免改名时 UI 标签被悄悄改写。
    const key = providerBuiltinKey(rawKey) || providerText(rawKey, 120);
    const label = providerText(value[rawKey], 80);
    if (!key || FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(key) || key.length > 120) return;
    if (!label || label.length > 20) return;
    result[key] = label;
  });
  return Object.keys(result).sort().reduce((out, key) => {
    out[key] = result[key];
    return out;
  }, {});
}

function mergeAdminProviderLabels(current, patch) {
  return normalizeAdminProviderLabels(
    Object.assign({}, normalizeAdminProviderLabels(current, { includeDefaults: false }), normalizeAdminProviderLabels(patch, { includeDefaults: false })),
    { includeDefaults: false }
  );
}

function normalizeAdminProviderProfileValue(section, value, providerId) {
  const normalized = normalizeProviderOverride(
    section,
    value,
    normalizeProviderId(providerId || value && value.provider)
  );
  // 视频 Key 继续只由 video 顶层/环境变量和专用 secrets 接口管理；
  // 兼容 profile 不能把历史顶层明文复制到可展示配置里。目录档案
  // (providerRegistry) 仍保留自己的能力 Key，不受此旧投影限制。
  if (section === "video") delete normalized.apiKey;
  return normalized;
}

function normalizeAdminProviderProfiles(value) {
  const source = isProviderObject(value) ? value : {};
  const result = {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const rows = isProviderObject(source[slot]) ? source[slot] : {};
    result[slot] = {};
    Object.keys(rows).forEach((rawId) => {
      if (!isProviderObject(rows[rawId])) return;
      const id = normalizeProviderId(rawId);
      if (!id || FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(id.toLowerCase())) return;
      result[slot][id] = normalizeAdminProviderProfileValue(slot, rows[rawId], id);
    });
  });
  return result;
}

function mergeAdminProviderProfiles(current, patch) {
  const left = normalizeAdminProviderProfiles(current);
  const right = normalizeAdminProviderProfiles(patch);
  const result = {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    result[slot] = {};
    const ids = new Set(Object.keys(left[slot] || {}).concat(Object.keys(right[slot] || {})));
    ids.forEach((id) => {
      const before = left[slot][id] || {};
      const after = Object.assign({}, right[slot][id] || {});
      if (hasOwn(after, "apiKey") && !normalizeApiKey(after.apiKey)) delete after.apiKey;
      result[slot][id] = Object.assign({}, before, after, { provider: id });
    });
  });
  return result;
}

function syncAdminTopLevelProviderProfiles(config, baseProfiles) {
  const source = isProviderObject(config) ? config : {};
  const result = mergeAdminProviderProfiles(baseProfiles || source.providerProfiles, {});
  // canonical 目录内部使用稳定 providerKey，兼容 profile/标签仍应使用
  // 可编辑的外部 id。旧实现直接把 providerKey 写进 profile，导致保存
  // 仅 activeProviders 的 patch 时校验器误认为 UUID 是新的服务商且要求
  // 中文名称。先建立 key -> id 映射，只有无法解析时才回退原值。
  const registry = source.providerRegistry
    ? normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true })
    : null;
  const externalProviderId = (section) => {
    if (!isAdminProviderObject(section)) return "";
    const explicitId = normalizeProviderId(section.provider);
    if (explicitId) return explicitId;
    const reference = section.providerKey;
    if (registry && reference) {
      const key = providerRecordKeyFor(reference, registry);
      const record = registry.providers[key];
      if (record && record.id) return normalizeProviderId(record.id);
    }
    return normalizeProviderId(reference);
  };
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const section = isProviderObject(source[slot]) ? source[slot] : {};
    const id = externalProviderId(section);
    if (!id) return;
    result[slot][id] = Object.assign({}, result[slot][id] || {}, normalizeAdminProviderProfileValue(slot, section, id), { provider: id });
  });
  return result;
}

function configuredAdminProviderIds(config) {
  const source = isProviderObject(config) ? config : {};
  const registry = source.providerRegistry
    ? normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true })
    : null;
  const externalProviderId = (reference) => {
    const raw = providerText(reference, 160);
    if (!raw) return "";
    if (registry) {
      const key = providerRecordKeyFor(raw, registry);
      const record = registry.providers[key];
      if (record && record.id) return normalizeProviderId(record.id);
    }
    return normalizeProviderId(raw);
  };
  const ids = new Set();
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const section = source[slot];
    const id = externalProviderId(
      section && (section.provider || section.providerKey)
    );
    if (id) ids.add(id);
  });
  const profiles = normalizeAdminProviderProfiles(source.providerProfiles);
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => Object.keys(profiles[slot] || {}).forEach((id) => {
    ids.add(externalProviderId(id));
  }));
  return Array.from(ids).sort();
}

function validateAdminProviderLabels(labels, config) {
  const errors = [];
  if (labels !== undefined && !isProviderObject(labels)) return ["providerLabels 必须是对象"];
  const normalized = normalizeAdminProviderLabels(labels, { includeDefaults: true });
  const sourceConfig = isProviderObject(config) ? config : {};
  const registry = sourceConfig.providerRegistry
    ? normalizeProviderRegistry(sourceConfig.providerRegistry, { includeDefaults: true })
    : null;
  Object.keys(isProviderObject(labels) ? labels : {}).forEach((rawKey) => {
    const rawKeyText = providerText(rawKey, 240);
    const key = rawKeyText.slice(0, 120).toLowerCase();
    const label = providerText(labels[rawKey], 80);
    const record = registry && key
      ? registry.providers[providerRecordKeyFor(rawKey, registry)]
      : null;
    // normalizeRuntimePatch 的兼容投影会为迁移占位档案生成外部 ID
    // 截断名（例如 smoke-analysis-provi），这不是管理员新填的标签；
    // 受保护/迁移档案允许暂时保留该值，避免普通旧配置保存被拦截。
    if (
      record
      && (record.protected || record.migrated)
      && key
      && !FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(key)
      && label
      && label.length <= 20
    ) return;
    if (rawKeyText.length > 120) {
      errors.push(`服务商标识 ${rawKeyText.slice(0, 120)} 不合法`);
      return;
    }
    if (FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(key)) {
      errors.push(`服务商标识 ${rawKeyText} 不允许使用`);
      return;
    }
    if (!key || FORBIDDEN_ADMIN_PROVIDER_LABEL_KEYS.has(key) || key.length > 120 || !label || label.length > 20 || !/[\u3400-\u9fff]/.test(label)) {
      errors.push(`服务商 ${rawKey || "未填写"} 还没有合格的中文名称`);
    }
  });
  configuredAdminProviderIds(config).forEach((id) => {
    const label = normalized[id];
    // 旧顶层/providerProfiles 迁移出的受保护占位档案可能只有外部 ID，
    // 没有中文展示名；它们用于兼容历史配置，不应阻断普通 partial save。
    // 新建 canonical 档案（非 protected/migrated）仍必须提供合格名称。
    if (registry) {
      const key = providerRecordKeyFor(id, registry);
      const record = registry.providers[key];
      if (
        record
        && (record.protected || record.migrated)
        && label
        && label.length <= 20
      ) return;
    }
    if (!label || !/[\u3400-\u9fff]/.test(label)) errors.push(`服务商 ${id} 还没有中文名称，请先填写`);
  });
  return Array.from(new Set(errors));
}

function providerClone(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => providerClone(item));
  const result = {};
  Object.keys(value).forEach((key) => {
    result[key] = providerClone(value[key]);
  });
  return result;
}

function redactProviderMetadata(value) {
  if (Array.isArray(value)) return value.map((item) => redactProviderMetadata(item));
  if (!isProviderObject(value)) return value;
  const result = {};
  Object.keys(value).forEach((key) => {
    const normalizedKey = String(key).replace(/[-_]/g, "").toLowerCase();
    if (/(?:apikey|secret|token|authorization|credential|password)/i.test(normalizedKey)) {
      result[key] = "";
    } else {
      result[key] = redactProviderMetadata(value[key]);
    }
  });
  return result;
}

function providerPresetConfig(value) {
  const result = providerClone(value || {});
  delete result.apiKey;
  delete result.apiKeyConfigured;
  delete result.providerKey;
  return result;
}

function defaultProviderRecord(providerKey) {
  const key = normalizeProviderKey(providerKey);
  const record = {
    providerKey: key,
    id: key,
    name: providerDefaultName(key),
    builtIn: BUILTIN_PROVIDER_KEYS.includes(key),
    protected: BUILTIN_PROVIDER_KEYS.includes(key),
    aliases: [],
    baseUrl: "",
    apiKey: "",
    overrides: {}
  };
  if (key === "dashscope") {
    const face = providerPresetConfig(resolveFaceConfig({ provider: "dashscope" }));
    const analysis = providerPresetConfig(resolveAnalysisConfig({ provider: "dashscope" }));
    face.provider = "dashscope";
    analysis.provider = "dashscope";
    record.baseUrl = face.baseUrl || analysis.baseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    record.overrides.face = face;
    record.overrides.analysis = analysis;
  } else if (key === "xingju") {
    const image = providerPresetConfig(resolveImageConfig({ provider: "xingju" }));
    const video = providerPresetConfig(resolveVideoConfig({ provider: "xingju" }));
    image.provider = "xingju";
    video.provider = "xingju";
    record.baseUrl = image.baseUrl || "https://newapi.akiyo.fun/v1";
    record.overrides.image = image;
    record.overrides.video = video;
  } else if (key === "lingyun") {
    const image = providerPresetConfig(resolveImageBackupConfig({ provider: "lingyun" }));
    image.provider = "lingyun";
    record.baseUrl = image.baseUrl || "https://api.lingyunapi.xyz/v1";
    record.overrides.image = providerClone(image);
    record.overrides.imageBackup = image;
  }
  return record;
}

function normalizeProviderOverride(slot, value, providerId) {
  if (!isProviderObject(value)) return {};
  // 编辑器提交的能力档案可能是 { enabled, overrideEnabled, overrides: {...} }。
  // 把嵌套 overrides 展开后再按槽位白名单归一化，兼容旧的扁平写法。
  const nested = isProviderObject(value.overrides) ? value.overrides : {};
  const source = Object.assign({}, value, nested);
  const allowed = PROVIDER_SLOT_KEYS[slot] || [];
  const result = {};
  allowed.forEach((key) => {
    if (!hasOwn(source, key) || key === "provider" || key === "providerKey") return;
    if (key === "apiKey") {
      result[key] = normalizeApiKey(source[key]);
    } else if (["compatibilityMode", "retryEnabled", "enabled", "overrideEnabled"].includes(key)) {
      result[key] = overrideBoolean(source, key, false);
    } else {
      result[key] = source[key];
    }
  });
  if (hasOwn(source, "clearApiKey")) {
    result.clearApiKey = overrideBoolean(source, "clearApiKey", false);
  }
  if (providerId) result.provider = providerId;
  return result;
}

function normalizeProviderRecord(value, keyHint = "", options = {}) {
  const source = isProviderObject(value) ? value : {};
  const common = isProviderObject(source.common) ? source.common : {};
  const explicitKey = source.providerKey || source.key || source.internalKey
    || (/^(?:provider-[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9-]{27,})$/i.test(String(keyHint || "")) ? keyHint : "");
  const idHint = source.id || source.providerId || source.provider || source.slug || keyHint;
  const builtin = providerBuiltinKey(explicitKey) || providerBuiltinKey(idHint);
  const providerKey = normalizeProviderKey(
    explicitKey,
    builtin || providerStableKey(idHint || source.name)
  );
  if (!providerKey) return null;
  const id = normalizeProviderId(
    source.id || source.providerId || source.provider || (builtin || keyHint),
    builtin || providerKey
  );
  const aliasesInput = []
    .concat(source.aliases || [])
    .concat(source.alias === undefined ? [] : [source.alias])
    .concat(source.displayId === undefined ? [] : [source.displayId]);
  const aliases = [];
  aliasesInput.forEach((item) => {
    const alias = providerText(item, 120);
    if (!alias || alias.toLowerCase() === id.toLowerCase()) return;
    if (!aliases.some((existing) => existing.toLowerCase() === alias.toLowerCase())) {
      aliases.push(alias);
    }
  });
  // 旧版本可能把外部 ID 或 provider-<hash> 直接当作目录键。归一化为
  // UUID 后保留旧键别名，确保 activeProviders 和旧调用方仍能解析到同一记录。
  const keyHintText = providerText(keyHint, 128);
  const legacyKeyCandidates = [
    keyHintText,
    providerText(source.key, 128),
    providerText(source.internalKey, 128),
    providerText(source.providerKey, 128)
  ];
  legacyKeyCandidates.forEach((legacyKey) => {
    // UUID 是规范内部键，不需要把它暴露成外部别名；旧的文本键要保留，
    // 这样历史 activeProviders/编辑请求仍可定位到同一条记录。
    if (
      !legacyKey
      || isProviderUuidKey(legacyKey)
      || legacyKey.toLowerCase() === id.toLowerCase()
      || legacyKey.toLowerCase() === providerKey.toLowerCase()
      || aliases.some((item) => item.toLowerCase() === legacyKey.toLowerCase())
    ) return;
    aliases.push(legacyKey);
  });
  const rawOverrides = isProviderObject(source.overrides)
    ? source.overrides
    : isProviderObject(source.capabilities)
      ? source.capabilities
      : isProviderObject(source.slots)
        ? source.slots
        : {};
  const overrides = {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const direct = isProviderObject(source[slot]) ? source[slot] : {};
    const nested = isProviderObject(rawOverrides[slot]) ? rawOverrides[slot] : {};
    const normalized = normalizeProviderOverride(
      slot,
      Object.assign({}, direct, nested),
      id
    );
    if (Object.keys(normalized).length > 1 || hasOwn(normalized, "enabled")) {
      overrides[slot] = normalized;
    }
  });
  let baseUrl = providerText(
    source.baseUrl || source.url || common.baseUrl,
    500
  );
  let apiKey = normalizeApiKey(
    source.apiKey || source.secret || common.apiKey || ""
  );
  const clearApiKey = Boolean(source.clearApiKey || common.clearApiKey);
  // 能力专属覆盖不能反向提升为公共地址/Key；否则只给人脸配置的
  // 独立 Key 会意外被分析、生图和视频继承。
  if (options.includePreset !== false && BUILTIN_PROVIDER_KEYS.includes(providerKey)) {
    const preset = defaultProviderRecord(providerKey);
    baseUrl = baseUrl || preset.baseUrl;
    const mergedOverrides = {};
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      if (preset.overrides[slot] || overrides[slot]) {
        mergedOverrides[slot] = Object.assign({}, preset.overrides[slot] || {}, overrides[slot] || {});
      }
    });
    Object.assign(overrides, mergedOverrides);
  }
  const result = {
    providerKey,
    id,
    name: providerText(
      source.name || source.label || source.displayName || source.providerName,
      20
    ) || providerDefaultName(id),
    builtIn: Boolean(source.builtIn) || BUILTIN_PROVIDER_KEYS.includes(providerKey),
    protected: Boolean(source.protected || source.deleteProtected || source.migrated || source.legacy)
      || Boolean(source.builtIn)
      || BUILTIN_PROVIDER_KEYS.includes(providerKey),
    aliases,
    baseUrl,
    apiKey,
    clearApiKey,
    overrides
  };
  if (hasOwn(source, "enabled")) result.enabled = overrideBoolean(source, "enabled", true);
  if (isProviderObject(source.metadata)) result.metadata = providerClone(source.metadata);
  result.apiKeyConfigured = Boolean(apiKey);
  return result;
}

function mergeProviderRecord(current, patch) {
  const existing = normalizeProviderRecord(current, current && current.providerKey, { includePreset: true }) || {};
  const submitted = normalizeProviderRecord(
    patch,
    patch && patch.providerKey || existing.providerKey,
    { includePreset: false }
  ) || {};
  // provider 编辑器也会只提交 providerKey 和某个能力的局部字段；
  // 这类 patch 没有外部 id/name 时，normalizeProviderRecord 的 keyHint
  // 只是内部 UUID，不能拿它覆盖已有的可编辑身份。
  const patchObject = isProviderObject(patch) ? patch : {};
  const hasExplicitId = ["id", "providerId", "provider", "slug"].some((field) => (
    hasOwn(patchObject, field) && providerText(patchObject[field], 120)
  ));
  const hasExplicitName = ["name", "label", "displayName", "providerName"].some((field) => (
    hasOwn(patchObject, field) && providerText(patchObject[field], 40)
  ));
  if (!hasExplicitId && existing.id) submitted.id = existing.id;
  if (!hasExplicitName && existing.name) submitted.name = existing.name;
  const result = Object.assign({}, existing, submitted, {
    providerKey: existing.providerKey || submitted.providerKey,
    builtIn: Boolean(existing.builtIn || submitted.builtIn),
    protected: Boolean(
      existing.protected
      || submitted.protected
      || existing.builtIn
      || submitted.builtIn
    ),
    aliases: []
  });
  const aliases = [].concat(existing.aliases || [], submitted.aliases || []);
  aliases.forEach((alias) => {
    const value = providerText(alias, 120);
    if (!value || value.toLowerCase() === String(result.id || "").toLowerCase()) return;
    if (!result.aliases.some((item) => item.toLowerCase() === value.toLowerCase())) result.aliases.push(value);
  });
  if (submitted.clearApiKey) {
    result.apiKey = "";
  } else if (!normalizeApiKey(submitted.apiKey) && normalizeApiKey(existing.apiKey)) {
    result.apiKey = existing.apiKey;
  }
  // provider 编辑器通常只提交改动字段；空的归一化 baseUrl 不能覆盖
  // 已保存的公共地址，否则只改名称/能力开关就会让档案失去可用端点。
  if (!providerText(submitted.baseUrl, 500) && providerText(existing.baseUrl, 500)) {
    result.baseUrl = existing.baseUrl;
  }
  result.overrides = {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const before = existing.overrides && existing.overrides[slot] || {};
    const after = submitted.overrides && submitted.overrides[slot] || {};
    if (Object.keys(before).length || Object.keys(after).length) {
      // 局部 patch 省略 overrideEnabled 时沿用旧开关；若旧档案已经关闭
      // 覆盖，也要清理历史残留的独立地址/Key，不能让它们继续落到投影。
      const overrideDisabled = after.overrideEnabled === false
        || (after.overrideEnabled === undefined && before.overrideEnabled === false);
      result.overrides[slot] = overrideDisabled
        ? Object.assign({}, before, after, {
          provider: result.id,
          overrideEnabled: false
        })
        : Object.assign({}, before, after, {
          provider: result.id
        });
      if (overrideDisabled) {
        // 关闭能力覆盖时只删除公共地址/Key 的独立值；模型、路径、超时等
        // 仍是该能力自己的参数，不能因为关闭继承开关而丢失。
        ["baseUrl", "apiKey", "clearApiKey"].forEach((field) => {
          delete result.overrides[slot][field];
        });
      }
      if (!overrideDisabled && after.clearApiKey) {
        result.overrides[slot].apiKey = "";
        result.overrides[slot].clearApiKey = true;
      } else if (!overrideDisabled && !normalizeApiKey(after.apiKey) && normalizeApiKey(before.apiKey)) {
        result.overrides[slot].apiKey = before.apiKey;
      }
    }
  });
  result.clearApiKey = false;
  result.apiKeyConfigured = Boolean(normalizeApiKey(result.apiKey));
  return result;
}

function providerRegistryProviders(value) {
  if (!value) return {};
  if (isProviderObject(value.providers)) return value.providers;
  if (Array.isArray(value)) {
    return value.reduce((output, item) => {
      const record = normalizeProviderRecord(item);
      if (record) output[record.providerKey] = record;
      return output;
    }, {});
  }
  if (!isProviderObject(value)) return {};
  const result = {};
  Object.keys(value).forEach((key) => {
    if (["version", "updatedAt", "updatedBy", "providerRegistry", "activeProviders", "activeBackups"].includes(key)) return;
    if (!isProviderObject(value[key])) return;
    result[key] = value[key];
  });
  return result;
}

function normalizeProviderRegistry(value, options = {}) {
  const source = value && value.providerRegistry ? value.providerRegistry : value;
  const includeDefaults = options.includeDefaults !== false;
  const result = {
    version: Number(source && source.version) || PROVIDER_REGISTRY_VERSION,
    providers: {}
  };
  if (includeDefaults) {
    BUILTIN_PROVIDER_KEYS.forEach((key) => {
      result.providers[key] = defaultProviderRecord(key);
    });
  }
  const rawProviders = providerRegistryProviders(source);
  Object.keys(rawProviders).forEach((keyHint) => {
    const record = normalizeProviderRecord(rawProviders[keyHint], keyHint, {
      includePreset: includeDefaults
    });
    if (!record) return;
    const existingKey = result.providers[record.providerKey]
      ? record.providerKey
      : Object.keys(result.providers).find((key) => (
        String(result.providers[key].id || "").toLowerCase() === String(record.id || "").toLowerCase()
        || (result.providers[key].aliases || []).some((alias) => (
          String(alias).toLowerCase() === String(record.id || "").toLowerCase()
        ))
      ));
    const targetKey = existingKey || record.providerKey;
    result.providers[targetKey] = result.providers[targetKey]
      ? mergeProviderRecord(result.providers[targetKey], record)
      : record;
    result.providers[targetKey].providerKey = targetKey;
  });
  result.version = Number(source && source.version)
    || result.version
    || PROVIDER_REGISTRY_VERSION;
  return result;
}

function providerRecordKeyFor(value, registry) {
  const text = providerText(
    isProviderObject(value) ? value.providerKey || value.id || value.provider || value.alias : value,
    160
  );
  if (!text) return "";
  const providers = providerRegistryProviders(registry);
  if (hasOwn(providers, text)) return text;
  const builtin = providerBuiltinKey(text);
  if (builtin && hasOwn(providers, builtin)) return builtin;
  const lower = text.toLowerCase();
  const matched = Object.keys(providers).find((key) => {
    const record = providers[key] || {};
    return String(key).toLowerCase() === lower
      || String(record.id || "").toLowerCase() === lower
      || String(record.name || "").toLowerCase() === lower
      || (record.aliases || []).some((alias) => String(alias).toLowerCase() === lower);
  });
  return matched || text;
}

function providerSlotConfigFromRuntime(runtime, reference, slot) {
  const source = isProviderObject(runtime) ? runtime : {};
  const registry = normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true });
  const key = providerRecordKeyFor(reference, registry);
  const record = key && registry.providers[key];
  if (!record) return {};
  const override = record.overrides && record.overrides[slot] || {};
  const ownConnection = override.overrideEnabled !== false;
  const apiKey = ownConnection && override.clearApiKey
    ? ""
    : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey)
      || providerEnvironmentApiKey(record, slot);
  const result = Object.assign({}, override, {
    provider: record.id,
    providerKey: key,
    baseUrl: (ownConnection && override.baseUrl) || record.baseUrl || "",
    endpoint: override.endpoint || "",
    apiKey,
    model: override.model || "",
    timeoutMs: override.timeoutMs || 0
  });
  if (slot === "face") result.faceModel = result.model;
  return result;
}

function normalizeActiveBackups(value, registry, options = {}) {
  const source = value && value.activeBackups ? value.activeBackups : value;
  const result = {};
  PROVIDER_BACKUP_SLOTS.forEach((slot) => {
    if (!source || !hasOwn(source, slot)) {
      if (options.includeEmpty !== false) result[slot] = "";
      return;
    }
    result[slot] = providerRecordKeyFor(source[slot], registry);
  });
  return result;
}

function normalizeActiveProviders(value, registry, options = {}) {
  const source = value && value.activeProviders ? value.activeProviders : value;
  const result = {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    if (!source || !hasOwn(source, slot)) {
      if (options.includeEmpty !== false) result[slot] = "";
      return;
    }
    result[slot] = providerRecordKeyFor(source[slot], registry);
  });
  return result;
}

function providerHasCapability(record, slot) {
  const value = record && record.overrides && record.overrides[slot];
  if (!isProviderObject(value) || value.enabled === false) return false;
  const ownConnection = !(value.overrideEnabled === false);
  const meaningfulKeys = new Set([
    "baseUrl",
    "endpoint",
    "queryEndpoint",
    "apiKey",
    "model",
    "faceModel",
    "createPath",
    "queryPath",
    "resolution",
    "aspectRatio",
    "mode",
    "size",
    "timeoutMs",
    "maxRetries",
    "prompt"
  ]);
  return Object.keys(value).some((key) => {
    if (!meaningfulKeys.has(key)) return false;
    if (!ownConnection && ["baseUrl", "apiKey"].includes(key)) return false;
    const item = value[key];
    return item !== undefined
      && item !== null
      && (typeof item !== "string" || item.trim() !== "");
  });
}

function providerEnvironmentApiKey(record, slot) {
  const provider = providerBuiltinKey(
    record && (record.providerKey || record.id || record.provider || record.name)
  );
  if ((slot === "face" || slot === "analysis") && provider === "dashscope") {
    return normalizeApiKey(firstEnv(["AI_VISION_API_KEY", "AI_API_KEY"]));
  }
  if (slot === "image") {
    if (provider === "xingju") {
      return normalizeApiKey(firstEnv([
        "AI_IMAGE_PRIMARY_API_KEY",
        "AI_IMAGE_API_KEY",
        "AI_API_KEY"
      ]));
    }
    if (provider === "lingyun") {
      return normalizeApiKey(firstEnv([
        "AI_IMAGE_BACKUP_API_KEY",
        "AI_IMAGE_API_KEY",
        "AI_API_KEY"
      ]));
    }
  }
  if (slot === "imageBackup" && provider === "lingyun") {
    return normalizeApiKey(firstEnv([
      "AI_IMAGE_BACKUP_API_KEY",
      "AI_IMAGE_API_KEY",
      "AI_API_KEY"
    ]));
  }
  if (slot === "video") {
    return normalizeApiKey(firstEnv(["AI_VIDEO_API_KEY", "AI_VIDEO_KEY"]));
  }
  return "";
}

function providerConfigComplete(record, slot, options = {}) {
  if (record && record.overrides && record.overrides[slot]
    && record.overrides[slot].enabled === false) return false;
  if (!providerHasCapability(record, slot)) return false;
  const override = record.overrides[slot] || {};
  const ownConnection = override.overrideEnabled !== false;
  const baseUrl = (ownConnection && override.baseUrl) || record.baseUrl || override.endpoint || "";
  const model = override.model || "";
  const apiKey = ownConnection && override.clearApiKey
    ? ""
    : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey)
    || providerEnvironmentApiKey(record, slot);
  // 目录 Key 之外，已知能力也兼容现有环境变量；没有目录 Key、也没有
  // 环境 Key 时不能被当成“完整”档案参与自动回退。
  const keyReady = Boolean(apiKey)
    || (slot === "video" && options.allowMissingKey === true
      && Boolean(normalizeApiKey(firstEnv(["AI_VIDEO_API_KEY", "AI_VIDEO_KEY"]))));
  return Boolean((baseUrl || override.endpoint) && model && keyReady);
}

function providerEnsureRecord(registry, reference, options = {}) {
  const normalized = normalizeProviderRegistry(registry, { includeDefaults: true });
  const providers = normalized.providers;
  const referenceObject = isProviderObject(reference) ? reference : { id: reference };
  let key = providerRecordKeyFor(referenceObject, normalized);
  if (!hasOwn(providers, key)) {
    const candidate = normalizeProviderRecord(
      referenceObject,
      referenceObject.providerKey || referenceObject.id || key,
      { includePreset: true }
    );
    if (!candidate) return { registry: normalized, providerKey: "", record: null };
    key = candidate.providerKey || providerStableKey(candidate.id);
    providers[key] = candidate;
  }
  if (options.patch) providers[key] = mergeProviderRecord(providers[key], options.patch);
  providers[key].providerKey = key;
  return { registry: normalized, providerKey: key, record: providers[key] };
}

function buildLegacyProjectionFromProviderRegistry(runtime = {}) {
  const source = isProviderObject(runtime) ? providerClone(runtime) : {};
  const registry = normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true });
  const active = normalizeActiveProviders(source.activeProviders, registry);
  const hasActiveBackups = hasOwn(source, "activeBackups");
  const activeBackups = normalizeActiveBackups(
    source.activeBackups,
    registry,
    { includeEmpty: false }
  );
  const providers = registry.providers;
  const labels = normalizeAdminProviderLabels(source.providerLabels, { includeDefaults: true });
  const profiles = normalizeAdminProviderProfiles(source.providerProfiles);
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const key = active[slot];
    const record = key && providers[key];
    if (!record) {
      // 删除服务商后不能继续沿用旧顶层地址、模型或 Key。
      source[slot] = Object.assign({}, source[slot] || {}, {
        provider: "",
        providerKey: "",
        baseUrl: "",
        endpoint: "",
        queryEndpoint: "",
        apiKey: "",
        model: ""
      });
      return;
    }
    const override = record.overrides && record.overrides[slot] || {};
    const previous = isProviderObject(source[slot]) ? source[slot] : {};
    const previousKey = providerRecordKeyFor(
      previous.providerKey || previous.provider,
      registry
    );
    // 切换 active provider 时不能把旧服务商的 model/endpoint/Key 带过去；
    // 同一 provider 的 partial patch 才允许继承旧顶层字段。
    const inherited = previousKey && previousKey === key ? previous : {};
    const ownConnection = override.overrideEnabled !== false;
    const effectiveApiKey = ownConnection && override.clearApiKey
      ? ""
      : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey || inherited.apiKey);
    const section = Object.assign({}, inherited, override, {
      provider: record.id,
      providerKey: key,
      baseUrl: (ownConnection && override.baseUrl) || record.baseUrl || inherited.baseUrl || "",
      apiKey: effectiveApiKey
    });
    // 兼容顶层配置不保存空 Key；保留“无此字段”语义，避免空值被
    // 误当成从旧主配置继承了凭据。存在真实 Key 时仍照常投影。
    // 显式 clearApiKey 仍保留空字段，交给解析器阻断环境/旧值继承。
    if (!effectiveApiKey && !override.clearApiKey && !record.clearApiKey) {
      delete section.apiKey;
    }
    // 仅切换到一个尚未配置能力的历史/新档案时，不要凭空写入一堆空
    // 字段；旧 mergeRuntimeConfig 约定这类 partial 结果的字段为 undefined，
    // 也便于后续编辑器判断“尚未配置”而不是“显式清空”。
    if (!providerHasCapability(record, slot)) {
      [
        "baseUrl", "endpoint", "queryEndpoint", "apiKey", "model", "faceModel",
        "createPath", "queryPath", "resolution", "aspectRatio", "mode", "size"
      ].forEach((field) => {
        if (!section[field]) delete section[field];
      });
    }
    source[slot] = section;
  });
  if (hasActiveBackups) {
    PROVIDER_BACKUP_SLOTS.forEach((slot) => {
      const key = activeBackups[slot];
      const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
      const record = key && providers[key];
      const previous = isProviderObject(source[slot]) ? source[slot] : {};
      if (!record) {
        source[slot] = Object.assign({}, previous, {
          enabled: false,
          provider: "",
          providerKey: "",
          baseUrl: "",
          endpoint: "",
          queryEndpoint: "",
          apiKey: "",
          model: ""
        });
        return;
      }
      const inherited = providerSlotConfigFromRuntime(source, key, baseSlot);
      const override = record.overrides && record.overrides[baseSlot] || {};
      const ownConnection = override.overrideEnabled !== false;
      // providerSlotConfigFromRuntime 会为主槽位补环境变量 Key。备用槽位
      // 不能把主环境 Key 误投影过来，否则 AI_*_BACKUP_API_KEY 永远不会
      // 生效；只有目录中明确保存的档案 Key 才应优先于备用环境变量。
      const explicitRecordApiKey = ownConnection && !override.clearApiKey
        ? normalizeApiKey(override.apiKey || record.apiKey)
        : "";
      const previousKey = providerRecordKeyFor(
        previous.providerKey || previous.provider,
        registry
      );
      const sameProviderPrevious = previousKey && previousKey === key ? previous : {};
      const projectedBackup = Object.assign({}, inherited, sameProviderPrevious, {
        provider: record.id,
        providerKey: key
      });
      if (!providerText(sameProviderPrevious.baseUrl, 500)) {
        projectedBackup.baseUrl = inherited.baseUrl || record.baseUrl || "";
      }
      if (!hasOwn(sameProviderPrevious, "apiKey")) {
        projectedBackup.apiKey = explicitRecordApiKey || "";
      }
      if (!providerText(sameProviderPrevious.model, 240)) projectedBackup.model = inherited.model || "";
      // activeBackups 只保存档案引用，备用开关仍由顶层 section 保存。
      // 切换到新档案时若没有显式开关，只有完整能力才允许默认启用；
      // 明确关闭的草稿必须跨投影/重载保持关闭。
      const explicitlyDisabled = hasOwn(sameProviderPrevious, "enabled")
        && overrideBoolean(sameProviderPrevious, "enabled", false) === false;
      projectedBackup.enabled = explicitlyDisabled
        ? false
        : Boolean(providerConfigComplete(record, baseSlot));
      source[slot] = projectedBackup;
    });
  } else if (hasOwn(source, "providerRegistry")) {
    // canonical 目录没有备用引用时，旧顶层 section 不能继续伪装成
    // 已启用的备用模型；清空连接字段并显式标记 disabled，避免重载后
    // resolver 因残留 provider/model 自动启用。
    PROVIDER_BACKUP_SLOTS.forEach((slot) => {
      source[slot] = Object.assign({}, source[slot] || {}, {
        enabled: false,
        provider: "",
        providerKey: "",
        baseUrl: "",
        endpoint: "",
        queryEndpoint: "",
        apiKey: "",
        model: ""
      });
    });
  }
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    profiles[slot] = isProviderObject(profiles[slot]) ? profiles[slot] : {};
  });
  Object.keys(providers).forEach((key) => {
    const record = providers[key];
    const id = record.id || key;
    if (record.name) labels[id] = record.name;
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      if (!providerHasCapability(record, slot)) return;
      const override = record.overrides[slot] || {};
      const ownConnection = override.overrideEnabled !== false;
      profiles[slot][id] = Object.assign({}, profiles[slot][id] || {}, override, {
        provider: id,
        providerKey: key,
        baseUrl: (ownConnection && override.baseUrl) || record.baseUrl || "",
        apiKey: ownConnection && override.clearApiKey
          ? ""
          : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey)
      });
    });
  });
  return Object.assign(source, {
    providerRegistry: registry,
    activeProviders: active,
    ...(hasActiveBackups ? { activeBackups } : {}),
    providerLabels: normalizeAdminProviderLabels(labels, { includeDefaults: true }),
    providerProfiles: normalizeAdminProviderProfiles(profiles)
  });
}

function migrateLegacyProviderRegistry(runtime, rawConfig) {
  const raw = isProviderObject(rawConfig) ? rawConfig : (isProviderObject(runtime) ? runtime : {});
  const normalized = isProviderObject(runtime)
    ? providerClone(runtime)
    : normalizeLegacyRuntimePatch(raw);
  // 只有原始配置明确带 providerRegistry 才算 canonical。旧版本偶尔会
  // 先写 activeProviders，但它仍然依赖顶层 section/labels/profiles，必须
  // 继续走完整迁移并把新建档案标记为 protected。
  const hasCanonical = Boolean(raw && hasOwn(raw, "providerRegistry"));
  const hasExplicitActive = Boolean(raw && hasOwn(raw, "activeProviders"));
  // 一旦已有 canonical providerRegistry，目录就是唯一事实来源。旧的
  // providerLabels/providerProfiles/顶层 section 只是兼容投影，不能在每次
  // 读取时反向覆盖刚刚改过的档案（尤其是改 ID 后的别名档案）。
  const hasCanonicalRegistry = Boolean(raw && hasOwn(raw, "providerRegistry"));
  let registry = normalizeProviderRegistry(
    normalized.providerRegistry || raw.providerRegistry,
    { includeDefaults: true }
  );
  let active = normalizeActiveProviders(
    normalized.activeProviders || raw.activeProviders,
    registry
  );
  let activeBackups = normalizeActiveBackups(
    normalized.activeBackups || raw.activeBackups,
    registry,
    { includeEmpty: false }
  );
  const providers = registry.providers;
  // 迁移输入优先读取 rawConfig 中用户真正保存的 labels/profiles。一次
  // 迁移后的兼容投影会自动补齐内置 labels；若反过来使用 normalized
  // 的投影，就会把仅用于展示的 laoli/panda 等默认标签误建成空档案，
  // 后续保存还会因“至少一项能力”校验失败。只有 raw 没有对应字段时，
  // 才回退到 runtime 中的值（兼容直接传已归一化对象的调用方）。
  const labelsSource = isProviderObject(raw && raw.providerLabels)
    ? raw.providerLabels
    : normalized.providerLabels;
  const profilesSource = isProviderObject(raw && raw.providerProfiles)
    ? raw.providerProfiles
    : normalized.providerProfiles;
  const labels = isProviderObject(labelsSource) ? labelsSource : {};
  const profiles = isProviderObject(profilesSource) ? profilesSource : {};
  // 旧顶层/providerLabels/providerProfiles 生成的记录要保留为受保护档案，
  // 避免管理员误删后导致历史配置无法回溯；canonical 目录中的自定义项不套用该标记。
  const markLegacyRecord = (record) => {
    if (record) {
      record.protected = true;
      record.migrated = true;
    }
    return record;
  };
  const ensure = (reference, name) => {
    const referenceValue = isProviderObject(reference)
      ? reference
      : { id: reference, name };
    let key = providerRecordKeyFor(referenceValue, registry);
    if (!hasOwn(providers, key)) {
      const candidate = normalizeProviderRecord(
        referenceValue,
        referenceValue.providerKey || referenceValue.id || key,
        { includePreset: true }
      );
      if (!candidate) return "";
      key = candidate.providerKey;
      providers[key] = markLegacyRecord(candidate);
    }
    // 只有通过 labels/profiles/旧顶层 section 新建的记录才会走到这里；
    // 已存在的 canonical 记录保持原有 builtIn/protected 属性。
    if (name && !providers[key].name) providers[key].name = providerText(name, 80);
    return key;
  };
  if (!hasCanonicalRegistry) {
    Object.keys(labels || {}).forEach((rawId) => {
      const key = ensure(rawId, labels[rawId]);
      if (key && labels[rawId]) providers[key].name = providerText(labels[rawId], 80);
    });
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      const sectionProfiles = isProviderObject(profiles[slot]) ? profiles[slot] : {};
      Object.keys(sectionProfiles).forEach((rawId) => {
        const profile = sectionProfiles[rawId];
        if (!isProviderObject(profile)) return;
        const key = ensure(profile.providerKey || rawId, labels[rawId]);
        if (!key) return;
        const current = providers[key];
        // 旧版 providerProfiles 是按能力分开的配置，每个能力可能有
        // 不同的地址/Key。迁移到目录时不能把某一能力的连接信息提升成
        // 公共字段，否则后面遍历其它能力会互相覆盖（例如视频误用
        // imageBackup 的 Key）。公共字段只来自 canonical providerRegistry；
        // 旧 profile 的连接信息统一留在当前能力的 overrides 中。
        const profileRecordInput = Object.assign({}, profile, {
            providerKey: key,
            id: profile.id || profile.provider || rawId,
            name: labels[rawId] || profile.name
        });
        delete profileRecordInput.baseUrl;
        delete profileRecordInput.url;
        delete profileRecordInput.apiKey;
        delete profileRecordInput.secret;
        if (isProviderObject(profileRecordInput.common)) {
          profileRecordInput.common = Object.assign({}, profileRecordInput.common);
          delete profileRecordInput.common.baseUrl;
          delete profileRecordInput.common.url;
          delete profileRecordInput.common.apiKey;
          delete profileRecordInput.common.secret;
        }
        const profileRecord = normalizeProviderRecord(
          profileRecordInput,
           key,
           { includePreset: false }
         );
        if (profileRecord) providers[key] = mergeProviderRecord(current, profileRecord);
        if (providers[key] && !hasCanonical) markLegacyRecord(providers[key]);
        const profileOverride = normalizeProviderOverride(slot, profile, providers[key].id);
        providers[key].overrides[slot] = Object.assign(
          {},
          providers[key].overrides[slot] || {},
          profileOverride,
          { provider: providers[key].id }
        );
        // profileOverride 已经保留当前能力自己的 baseUrl/apiKey；这里不再
        // 写入 record.baseUrl/apiKey，避免后续能力继承到错误的连接信息。
        providers[key].apiKeyConfigured = Boolean(
          normalizeApiKey(providers[key].apiKey)
          || Object.keys(providers[key].overrides || {}).some((overrideSlot) => (
            providers[key].overrides[overrideSlot]
            && providers[key].overrides[overrideSlot].overrideEnabled !== false
            && normalizeApiKey(providers[key].overrides[overrideSlot].apiKey)
          ))
        );
      });
    });
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      const section = isProviderObject(normalized[slot] || raw[slot])
        ? (normalized[slot] || raw[slot])
        : {};
      const reference = section.providerKey || section.provider || "";
      const hasProviderFields = [
        "baseUrl", "endpoint", "queryEndpoint", "apiKey", "model", "createPath", "queryPath"
      ].some((field) => providerText(section[field], 500));
      if (!reference && !hasProviderFields) return;
      const key = ensure(reference || providerStableKey(`${slot}:${section.model || section.baseUrl || ""}`), section.provider);
      if (!key) return;
      const current = providers[key];
      const override = normalizeProviderOverride(slot, section, current.id);
      if (!hasCanonical || !providerHasCapability(current, slot)) {
        current.overrides[slot] = Object.assign({}, current.overrides[slot] || {}, override, {
          provider: current.id
        });
      } else {
        current.overrides[slot] = Object.assign({}, override, current.overrides[slot] || {}, {
          provider: current.id
        });
      }
      if (!hasCanonical) markLegacyRecord(current);
      current.apiKeyConfigured = Boolean(
        normalizeApiKey(current.apiKey)
        || Object.keys(current.overrides || {}).some((overrideSlot) => (
          current.overrides[overrideSlot]
          && current.overrides[overrideSlot].overrideEnabled !== false
          && normalizeApiKey(current.overrides[overrideSlot].apiKey)
        ))
      );
      if (!hasCanonical || !active[slot]) active[slot] = key;
    });
    PROVIDER_BACKUP_SLOTS.forEach((slot) => {
      const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
      const section = isProviderObject(normalized[slot] || raw[slot])
        ? (normalized[slot] || raw[slot])
        : {};
      const reference = section.providerKey || section.provider || "";
      const hasProviderFields = [
        "baseUrl", "endpoint", "apiKey", "model", "timeoutMs"
      ].some((field) => providerText(section[field], 500));
      if (!reference && !hasProviderFields) return;
      const key = ensure(
        reference || providerStableKey(`${slot}:${section.model || section.baseUrl || ""}`),
        section.provider
      );
      if (!key) return;
      const current = providers[key];
      const override = normalizeProviderOverride(baseSlot, section, current.id);
      current.overrides[baseSlot] = Object.assign(
        {},
        current.overrides[baseSlot] || {},
        override,
        { provider: current.id }
      );
      if (!hasCanonical) markLegacyRecord(current);
      if (!activeBackups[slot]) activeBackups[slot] = key;
    });
  }
  // canonical 目录已经存在时，旧顶层备用配置仍需恢复到稳定的
  // activeBackups 引用；配置对象本身由兼容投影保留，避免主/备模型混用。
  PROVIDER_BACKUP_SLOTS.forEach((slot) => {
    if (activeBackups[slot]) return;
    const section = isProviderObject(normalized[slot] || raw[slot])
      ? (normalized[slot] || raw[slot])
      : {};
    const reference = section.providerKey || section.provider || "";
    if (!reference) return;
    const key = providerRecordKeyFor(reference, registry);
    if (key && hasOwn(providers, key)) activeBackups[slot] = key;
  });
  // 旧配置没有 activeProviders 时，根据原有 provider 或稳定默认值补齐；视频没有可用项时保持空。
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    if (active[slot]) {
      if (hasOwn(providers, active[slot])) return;
      // activeProviders 是新目录的显式引用时，先保留未知 key。
      // 事务合并会用当前目录解析它；这里提前换成默认服务商会把
      // 管理页刚选的自定义 UUID 静默改回旧绑定。
      if (hasCanonical || hasExplicitActive) return;
    }
    const fallbackId = slot === "video"
      ? firstEnv(["AI_VIDEO_PROVIDER"])
      : PROVIDER_ID_FALLBACKS[slot];
    const fallbackKey = providerRecordKeyFor(fallbackId, registry);
    if (fallbackKey && hasOwn(providers, fallbackKey)
        && (slot !== "video" || providerHasCapability(providers[fallbackKey], slot))) {
      active[slot] = fallbackKey;
    } else if (!hasCanonical && slot === "video") {
      active[slot] = "";
    }
  });
  const value = buildLegacyProjectionFromProviderRegistry(Object.assign({}, normalized, {
    providerRegistry: registry,
    activeProviders: active,
    ...(Object.keys(activeBackups).length ? { activeBackups } : {}),
    providerLabels: labels,
    providerProfiles: profiles
  }));
  const rawRegistry = raw && raw.providerRegistry;
  const rawActive = raw && raw.activeProviders;
  const rawActiveBackups = raw && raw.activeBackups;
  const migrated = JSON.stringify(rawRegistry || null) !== JSON.stringify(value.providerRegistry)
    || JSON.stringify(rawActive || null) !== JSON.stringify(value.activeProviders)
    || JSON.stringify(rawActiveBackups || null) !== JSON.stringify(value.activeBackups || null)
    || !hasOwn(raw, "providerRegistry")
    || !hasOwn(raw, "activeProviders");
  return { value, migrated };
}

function mergeProviderRegistry(current, patch) {
  const existing = normalizeProviderRegistry(current, { includeDefaults: true });
  const submitted = normalizeProviderRegistry(patch, { includeDefaults: false });
  const providers = existing.providers;
  Object.keys(submitted.providers).forEach((submittedKey) => {
    const submittedRecord = submitted.providers[submittedKey];
    const targetKey = hasOwn(providers, submittedKey)
      ? submittedKey
      : Object.keys(providers).find((key) => (
        String(providers[key].id || "").toLowerCase() === String(submittedRecord.id || "").toLowerCase()
        || (providers[key].aliases || []).some((alias) => String(alias).toLowerCase() === String(submittedRecord.id || "").toLowerCase())
      )) || submittedKey;
    providers[targetKey] = hasOwn(providers, targetKey)
      ? mergeProviderRecord(providers[targetKey], submittedRecord)
      : submittedRecord;
    providers[targetKey].providerKey = targetKey;
  });
  const active = Object.assign(
    {},
    normalizeActiveProviders(current && current.activeProviders, existing, { includeEmpty: false }),
    normalizeActiveProviders(patch && patch.activeProviders, existing, { includeEmpty: false })
  );
  const activeBackups = Object.assign(
    {},
    normalizeActiveBackups(current && current.activeBackups, existing, { includeEmpty: false }),
    normalizeActiveBackups(patch && patch.activeBackups, existing, { includeEmpty: false })
  );
  return {
    providerRegistry: existing,
    activeProviders: active,
    activeBackups
  };
}

// 外部 ID 可编辑，但成本、展示标签和兼容 profile 仍可能以旧 ID 为键。
// 改名时统一搬迁这些引用，内部 providerKey 不变；若新键已经存在，保留
// 新键值并只补齐旧键中没有的字段，避免覆盖管理员刚填的新价格/名称。
function migrateProviderExternalIdReferences(runtime, previousId, nextId) {
  const source = isProviderObject(runtime) ? providerClone(runtime) : {};
  const oldText = providerText(previousId, 120);
  const newText = providerText(nextId, 120);
  if (!oldText || !newText || oldText.toLowerCase() === newText.toLowerCase()) return source;
  const renameMapKey = (map) => {
    if (!isProviderObject(map)) return;
    const oldKey = Object.keys(map).find((key) => String(key).toLowerCase() === oldText.toLowerCase());
    if (!oldKey) return;
    const oldValue = map[oldKey];
    const newKey = Object.keys(map).find((key) => String(key).toLowerCase() === newText.toLowerCase()) || newText;
    if (newKey === oldKey) return;
    if (!hasOwn(map, newKey)) {
      map[newKey] = oldValue;
    } else if (isProviderObject(oldValue) && isProviderObject(map[newKey])) {
      map[newKey] = Object.assign({}, oldValue, map[newKey]);
      Object.keys(oldValue).forEach((key) => {
        if (!hasOwn(map[newKey], key)) map[newKey][key] = oldValue[key];
      });
    }
    delete map[oldKey];
  };
  const costs = isProviderObject(source.costs) ? source.costs : {};
  const imageCosts = isProviderObject(costs.image) ? costs.image : {};
  renameMapKey(imageCosts.providers);
  if (isProviderObject(source.providerLabels)) renameMapKey(source.providerLabels);
  if (isProviderObject(source.providerProfiles)) {
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      if (isProviderObject(source.providerProfiles[slot])) renameMapKey(source.providerProfiles[slot]);
    });
  }
  return source;
}

// 删除档案时清理所有仍以外部 ID/历史别名/稳定 key 保存的兼容引用。
// 目录投影会重建当前槽位，但旧 profile、标签和动态成本键不会自动消失，
// 必须在同一事务里先清掉，避免删除后下一次迁移又把档案“复活”。
function removeProviderExternalIdReferences(runtime, record, options = {}) {
  const source = isProviderObject(runtime) ? providerClone(runtime) : {};
  const target = isProviderObject(record) ? record : { id: record };
  const references = [
    target.providerKey,
    target.id,
    ...(Array.isArray(target.aliases) ? target.aliases : [])
  ]
    .map((value) => providerText(value, 160).toLowerCase())
    .filter(Boolean);
  const referenceSet = new Set(references);
  if (!referenceSet.size) return source;
  const matches = (rawKey, value) => {
    const key = providerText(rawKey, 160).toLowerCase();
    if (key && referenceSet.has(key)) return true;
    if (!isProviderObject(value)) return false;
    return [value.providerKey, value.provider, value.id]
      .map((item) => providerText(item, 160).toLowerCase())
      .some((item) => item && referenceSet.has(item));
  };
  const removeMatchingKeys = (map) => {
    if (!isProviderObject(map)) return;
    Object.keys(map).forEach((key) => {
      if (matches(key, map[key])) delete map[key];
    });
  };
  removeMatchingKeys(source.providerLabels);
  if (isProviderObject(source.providerProfiles)) {
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      removeMatchingKeys(source.providerProfiles[slot]);
    });
  }
  const costs = isProviderObject(source.costs) ? source.costs : {};
  const imageCosts = isProviderObject(costs.image) ? costs.image : {};
  removeMatchingKeys(imageCosts.providers);
  if (matches(imageCosts.primaryProvider, null)) {
    const replacement = providerText(options.replacementImageProvider, 120);
    if (replacement) imageCosts.primaryProvider = replacement;
    else delete imageCosts.primaryProvider;
  }
  return source;
}

function mergeActiveProviderOverrides(registryValue, activeValue, overridesValue) {
  const registry = normalizeProviderRegistry(registryValue, { includeDefaults: true });
  const active = normalizeActiveProviders(activeValue, registry);
  const overrides = isProviderObject(overridesValue) ? overridesValue : {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const key = active[slot];
    if (!key || !hasOwn(registry.providers, key) || !isProviderObject(overrides[slot])) return;
    const existing = registry.providers[key].overrides && registry.providers[key].overrides[slot] || {};
    const incoming = normalizeProviderOverride(slot, overrides[slot], registry.providers[key].id);
    const mergedSlot = Object.assign({}, existing, incoming);
    // 兼容旧顶层 section 时，空地址/Key 表示“没有改这个字段”，不能
    // 把已保存的连接信息误清掉；显式 clearApiKey 仍然优先。
    if (
      mergedSlot.overrideEnabled !== false
      && !incoming.clearApiKey
      && hasOwn(incoming, "apiKey")
      && !normalizeApiKey(incoming.apiKey)
      && normalizeApiKey(existing.apiKey)
    ) {
      mergedSlot.apiKey = existing.apiKey;
    }
    if (
      mergedSlot.overrideEnabled !== false
      && !providerText(incoming.baseUrl, 500)
      && providerText(existing.baseUrl, 500)
    ) {
      mergedSlot.baseUrl = existing.baseUrl;
    }
    const merged = Object.assign(
      {},
      registry.providers[key].overrides || {},
      { [slot]: mergedSlot }
    );
    // activeOverrides 是功能卡保存时的兼容入口。关闭覆盖必须和档案编辑器
    // 采用同一语义：删除独立地址/Key，保留模型、路径、超时等能力参数，
    // 让解析器回到公共连接配置。
    if (merged[slot] && merged[slot].overrideEnabled === false) {
      ["baseUrl", "apiKey", "clearApiKey"].forEach((field) => {
        delete merged[slot][field];
      });
    }
    registry.providers[key].overrides = merged;
  });
  return registry;
}

// 备用视觉/视频配置在兼容接口中仍以 faceBackup/analysisBackup/videoBackup
// 顶层 section 传入，但目录里复用对应能力档案的 override。这里把备用
// section 的模型、路径和连接参数写回被选中的档案，保证目录是唯一事实
// 来源；备用开关 enabled 不写入主能力，避免关闭备用误伤同一档案的主模型。
function mergeActiveBackupOverrides(registryValue, activeValue, sectionsValue) {
  const registry = normalizeProviderRegistry(registryValue, { includeDefaults: true });
  const active = normalizeActiveBackups(activeValue, registry, { includeEmpty: false });
  const sections = isProviderObject(sectionsValue) ? sectionsValue : {};
  PROVIDER_BACKUP_SLOTS.forEach((slot) => {
    const key = active[slot];
    const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
    const section = sections[slot];
    const record = key && registry.providers[key];
    if (!record || !isProviderObject(section)) return;
    const existing = record.overrides && record.overrides[baseSlot] || {};
    const incoming = normalizeProviderOverride(baseSlot, section, record.id);
    // 备用 enabled 只属于备用引用，不应把档案的主能力一起禁用。
    delete incoming.enabled;
    const merged = Object.assign({}, existing, incoming, { provider: record.id });
    if (
      merged.overrideEnabled !== false
      && !incoming.clearApiKey
      && hasOwn(incoming, "apiKey")
      && !normalizeApiKey(incoming.apiKey)
      && normalizeApiKey(existing.apiKey)
    ) {
      merged.apiKey = existing.apiKey;
    }
    if (
      merged.overrideEnabled !== false
      && !providerText(incoming.baseUrl, 500)
      && providerText(existing.baseUrl, 500)
    ) {
      merged.baseUrl = existing.baseUrl;
    }
    if (merged.overrideEnabled === false) {
      ["baseUrl", "apiKey", "clearApiKey"].forEach((field) => delete merged[field]);
    }
    record.overrides = Object.assign({}, record.overrides || {}, {
      [baseSlot]: merged
    });
  });
  return registry;
}

// 兼容旧 providerProfiles/顶层 section 向 canonical 目录补齐档案。管理页
// 仍有一批调用方只保存 profile（例如切换到一个历史 provider-b），这时
// submittedDirectory 可能只有空 Key；若不把已保存 profile 的连接参数带入
// 目录，随后 buildLegacyProjection 会把旧 Key 丢掉。只填充目录中缺失的
// 档案/字段，不让兼容投影覆盖管理员已经明确清空的 canonical 值；视频
// profile 本身不携带 Key，由环境变量或专用 secrets 接口负责。
function mergeLegacyProviderProfilesIntoRegistry(registryValue, profilesValue) {
  const registry = normalizeProviderRegistry(registryValue, { includeDefaults: true });
  const profiles = normalizeAdminProviderProfiles(profilesValue);
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const rows = isProviderObject(profiles[slot]) ? profiles[slot] : {};
    Object.keys(rows).forEach((rawId) => {
      const profile = rows[rawId];
      if (!isProviderObject(profile)) return;
      const reference = profile.providerKey || profile.provider || rawId;
      let key = providerRecordKeyFor(reference, registry);
      if (!hasOwn(registry.providers, key)) {
        const candidate = normalizeProviderRecord({
          providerKey: isProviderUuidKey(reference) ? reference : key,
          id: profile.provider || rawId,
          name: providerDefaultName(profile.provider || rawId),
          baseUrl: profile.baseUrl || "",
          overrides: { [slot]: profile }
        }, key, { includePreset: false });
        if (!candidate) return;
        candidate.protected = true;
        candidate.migrated = true;
        key = candidate.providerKey;
        registry.providers[key] = candidate;
      } else {
        const existing = registry.providers[key];
        const existingOverride = existing.overrides && existing.overrides[slot] || {};
        const incomingOverride = normalizeProviderOverride(slot, profile, existing.id);
        // canonical 档案/activeOverrides 是新事实来源；legacy profile 只
        // 用来补齐缺失连接参数，不能把刚提交的模型（例如 bound-face）
        // 又覆盖回旧投影。空值也不参与补齐，避免误清除已有配置。
        const missingOverride = {};
        Object.keys(incomingOverride).forEach((field) => {
          if (field === "provider" || field === "providerKey") return;
          if (field === "apiKey" && !normalizeApiKey(incomingOverride[field])) return;
          if (!hasOwn(existingOverride, field)
              || (field === "apiKey" && !normalizeApiKey(existingOverride[field]))) {
            missingOverride[field] = incomingOverride[field];
          }
        });
        registry.providers[key] = mergeProviderRecord(existing, {
          providerKey: key,
          id: existing.id || profile.provider || rawId,
          name: existing.name || providerDefaultName(existing.id || rawId),
          baseUrl: existing.baseUrl || profile.baseUrl || "",
          overrides: Object.keys(missingOverride).length
            ? { [slot]: missingOverride }
            : {}
        });
        registry.providers[key].providerKey = key;
      }
      if (slot === "video" && registry.providers[key].overrides
          && registry.providers[key].overrides[slot]) {
        delete registry.providers[key].overrides[slot].apiKey;
      }
    });
  });
  return registry;
}

function redactProviderRegistry(value) {
  const registry = normalizeProviderRegistry(value, { includeDefaults: true });
  const providers = {};
  Object.keys(registry.providers).forEach((key) => {
    const record = providerClone(registry.providers[key]);
    if (record.metadata) record.metadata = redactProviderMetadata(record.metadata);
    record.apiKey = "";
    record.apiKeyConfigured = Boolean(
      normalizeApiKey(registry.providers[key].apiKey)
      || Object.keys(registry.providers[key].overrides || {}).some((slot) => (
        registry.providers[key].overrides[slot]
        && registry.providers[key].overrides[slot].overrideEnabled !== false
        && normalizeApiKey(registry.providers[key].overrides[slot].apiKey)
      ))
      || PROVIDER_CAPABILITY_SLOTS.some((slot) => providerEnvironmentApiKey(registry.providers[key], slot))
    );
    Object.keys(record.overrides || {}).forEach((slot) => {
      if (!record.overrides[slot]) return;
      record.overrides[slot] = Object.assign({}, record.overrides[slot], { apiKey: "" });
      delete record.overrides[slot].apiKeyConfigured;
    });
    providers[key] = record;
  });
  return {
    version: Number(registry.version) || PROVIDER_REGISTRY_VERSION,
    providers
  };
}

function providerRegistryList(value, redact = false) {
  const registry = redact ? redactProviderRegistry(value) : normalizeProviderRegistry(value, { includeDefaults: true });
  return Object.keys(registry.providers).sort().map((key) => (
    Object.assign({}, providerClone(registry.providers[key]), { providerKey: key })
  ));
}

function validateProviderRegistry(registryValue, activeValue, options = {}) {
  const errors = [];
  if (registryValue !== undefined && !isProviderObject(registryValue) && !Array.isArray(registryValue)) {
    return ["providerRegistry 必须是对象或数组"];
  }
  const registry = normalizeProviderRegistry(registryValue, { includeDefaults: false });
  const providers = registry.providers;
  const identities = {};
  Object.keys(providers).forEach((key) => {
    const record = providers[key] || {};
    const providerKey = providerText(record.providerKey || key, 128);
    const id = providerText(record.id, 64);
    const name = providerText(record.name, 20);
    if (!providerKey || /^(?:__proto__|prototype|constructor)$/i.test(providerKey)) {
      errors.push(`服务商 ${key || "未填写"} 的 providerKey 不合法`);
    }
    if (!id || id.length > 64 || !/^[A-Za-z0-9._-]+$/.test(id)) errors.push(`服务商 ${providerKey || key} 的 id 不合法`);
    if (!name || name.length > 20) errors.push(`服务商 ${id || providerKey || key} 的名称不合法`);
    const values = [id].concat(record.aliases || []);
    values.forEach((value) => {
      const identity = providerText(value, 64).toLowerCase();
      if (!identity) return;
      if (identities[identity] && identities[identity] !== key) {
        errors.push(`服务商标识 ${value} 与 ${identities[identity]} 重复`);
      } else {
        identities[identity] = key;
      }
    });
    // 迁移自旧 labels/profile 的受保护占位档案可能暂时没有完整能力；
    // 它们只用于兼容历史引用，不能按新建自定义档案的“至少一项能力”
    // 规则拦截整个配置保存。新建/可删除自定义档案仍严格校验。
    if (
      !record.builtIn
      && !record.protected
      && !record.migrated
      && !PROVIDER_CAPABILITY_SLOTS.some((slot) => providerHasCapability(record, slot))
    ) {
      errors.push(`服务商 ${id || providerKey || key} 至少要配置一项能力`);
    }
    if (record.baseUrl && !isValidHttpUrl(record.baseUrl)) {
      errors.push(`服务商 ${id || providerKey || key} 的 baseUrl 必须是 http/https 地址`);
    }
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      const override = record.overrides && record.overrides[slot];
      if (!override) return;
      if (override.baseUrl && !isValidHttpUrl(override.baseUrl)) {
        errors.push(`服务商 ${id || providerKey || key}.${slot}.baseUrl 必须是 http/https 地址`);
      }
      if (override.endpoint && !isValidEndpointOrPath(override.endpoint)) {
        errors.push(`服务商 ${id || providerKey || key}.${slot}.endpoint 地址不合法`);
      }
    });
  });
  const active = activeValue === undefined
    ? {}
    : normalizeActiveProviders(activeValue, registry, { includeEmpty: false });
  Object.keys(active).forEach((slot) => {
    if (!PROVIDER_CAPABILITY_SLOTS.includes(slot)) return;
    const key = active[slot];
    if (key && !hasOwn(providers, key)) errors.push(`activeProviders.${slot} 指向不存在的服务商`);
  });
  if (options.requireBuiltIns) {
    BUILTIN_PROVIDER_KEYS.forEach((key) => {
      if (!hasOwn(providers, key)) errors.push(`内置服务商 ${key} 不可删除`);
    });
  }
  return Array.from(new Set(errors));
}

// 兼容外部 smoke / 管理页命名。
const validateProviderDirectory = validateProviderRegistry;
const normalizeProviderDirectory = normalizeProviderRegistry;
const mergeProviderDirectory = mergeProviderRegistry;

function normalizeRuntimePatch(input = {}) {
  const normalized = normalizeLegacyRuntimePatch(input);
  const source = isProviderObject(input) ? input : {};
  if (hasOwn(source, "providerRegistry")) {
    normalized.providerRegistry = normalizeProviderRegistry(source.providerRegistry, { includeDefaults: false });
  }
  if (hasOwn(source, "activeProviders")) {
    normalized.activeProviders = normalizeActiveProviders(
      source.activeProviders,
      normalized.providerRegistry || normalizeProviderRegistry({}, { includeDefaults: true }),
      { includeEmpty: false }
    );
  }
  if (hasOwn(source, "activeBackups")) {
    normalized.activeBackups = normalizeActiveBackups(
      source.activeBackups,
      normalized.providerRegistry || normalizeProviderRegistry({}, { includeDefaults: true }),
      { includeEmpty: false }
    );
  }
  if (hasOwn(source, "activeOverrides") && isProviderObject(source.activeOverrides)) {
    normalized.activeOverrides = {};
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      if (!isProviderObject(source.activeOverrides[slot])) return;
      normalized.activeOverrides[slot] = normalizeProviderOverride(
        slot,
        source.activeOverrides[slot],
        ""
      );
    });
  }
  if (hasOwn(source, "providerLabels") && isProviderObject(source.providerLabels)) {
    normalized.providerLabels = normalizeAdminProviderLabels(source.providerLabels, {
      includeDefaults: false
    });
  }
  if (hasOwn(source, "providerProfiles") && isProviderObject(source.providerProfiles)) {
    normalized.providerProfiles = normalizeAdminProviderProfiles(source.providerProfiles);
  }
  // 只有明确提交目录、active 绑定，或某个旧 section 的服务商身份时才做
  // 目录迁移。普通的 partial section（例如只改 image.model）必须保持旧
  // mergeRuntimeConfig 语义，不能凭空造一个空 Key 的 UUID 档案并切换 active。
  const hasProviderSelectionPatch = PROVIDER_CAPABILITY_SLOTS.some((slot) => {
    const section = source[slot];
    return isProviderObject(section)
      && (hasOwn(section, "provider") || hasOwn(section, "providerKey"));
  }) || PROVIDER_BACKUP_SLOTS.some((slot) => {
    const section = source[slot];
    return isProviderObject(section)
      && (hasOwn(section, "provider") || hasOwn(section, "providerKey"));
  });
  if (hasOwn(source, "providerRegistry") || hasProviderSelectionPatch) {
    const migrated = migrateLegacyProviderRegistry(normalized, source);
    normalized.providerRegistry = migrated.value.providerRegistry;
    normalized.activeProviders = migrated.value.activeProviders;
    // 没有备用槽位的旧 partial patch 不要挂一个值为 undefined 的
    // activeBackups 属性；否则旧校验会把它误判成“必须是对象”。
    if (isProviderObject(migrated.value.activeBackups)) {
      normalized.activeBackups = migrated.value.activeBackups;
    } else {
      delete normalized.activeBackups;
    }
    normalized.providerLabels = migrated.value.providerLabels;
    normalized.providerProfiles = migrated.value.providerProfiles;
  }
  return normalized;
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

function validateCostNumber(value, field) {
  const label = String(field || "成本");
  if (value === undefined || value === null || String(value).trim() === "") {
    return `${label} 不能为空`;
  }
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) {
    return `${label} 必须是非负数字，最多 4 位小数`;
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100000) {
    return `${label} 必须在 0～100000 之间`;
  }
  return "";
}

function validateRuntimePatch(patch, options = {}) {
  const errors = [];
  if (patch && hasOwn(patch, "activeBackups") && !isProviderObject(patch.activeBackups)) {
    errors.push("activeBackups 必须是对象");
  }
  if (patch && hasOwn(patch, "providerRegistry")) {
    errors.push(...validateProviderRegistry(
      patch.providerRegistry,
      patch.activeProviders
    ));
    if (hasOwn(patch, "activeBackups")) {
      const backupRegistry = normalizeProviderRegistry(patch.providerRegistry, {
        includeDefaults: true
      });
      const activeBackups = normalizeActiveBackups(
        patch.activeBackups,
        backupRegistry,
        { includeEmpty: false }
      );
      Object.keys(activeBackups).forEach((slot) => {
        const key = activeBackups[slot];
        if (key && !hasOwn(backupRegistry.providers, key)) {
          errors.push(`activeBackups.${slot} 指向不存在的服务商`);
        }
      });
    }
  }
  if (
    patch
    && hasOwn(patch, "activeBackups")
    && isProviderObject(patch.activeBackups)
  ) {
    PROVIDER_BACKUP_SLOTS.forEach((slot) => {
      const value = patch.activeBackups[slot];
      if (value === undefined || value === null || value === "") return;
      const text = providerText(
        isProviderObject(value) ? value.providerKey || value.id || value.provider : value,
        160
      );
      if (!text) errors.push(`activeBackups.${slot} 引用不能为空`);
    });
  }
  const face = patch.face || {};
  const faceBackup = patch.faceBackup || {};
  const analysis = patch.analysis || {};
  const analysisBackup = patch.analysisBackup || {};
  const image = patch.image || {};
  const imageBackup = patch.imageBackup || {};
  const tencentFaceFusion = patch.tencentFaceFusion || {};
  const video = patch.video || {};
  const videoBackup = patch.videoBackup || {};
  const points = patch.points || {};
  const costs = patch.costs || {};
  const faceCosts = costs.face || {};
  const analysisCosts = costs.analysis || {};
  const imageCosts = costs.image || {};
  const imageProviderCosts = imageCosts.providers || {};
  const videoCosts = costs.video || {};
  const generationQueue = patch.generationQueue || {};
  [
    ["face.baseUrl", face.baseUrl],
    ["face.endpoint", face.endpoint],
    ["faceBackup.baseUrl", faceBackup.baseUrl],
    ["faceBackup.endpoint", faceBackup.endpoint],
    ["analysis.baseUrl", analysis.baseUrl],
    ["analysis.endpoint", analysis.endpoint],
    ["analysisBackup.baseUrl", analysisBackup.baseUrl],
    ["analysisBackup.endpoint", analysisBackup.endpoint],
    ["image.baseUrl", image.baseUrl],
    ["image.endpoint", image.endpoint],
    ["imageBackup.baseUrl", imageBackup.baseUrl],
    ["imageBackup.endpoint", imageBackup.endpoint],
    ["video.baseUrl", video.baseUrl],
    ["video.endpoint", video.endpoint],
    ["video.queryEndpoint", video.queryEndpoint],
    ["videoBackup.baseUrl", videoBackup.baseUrl],
    ["videoBackup.endpoint", videoBackup.endpoint],
    ["videoBackup.queryEndpoint", videoBackup.queryEndpoint]
  ].forEach(([field, value]) => {
    if (value !== undefined && !isValidHttpUrl(value)) errors.push(`${field} 必须是 http/https 地址`);
  });
  [
    ["video.createPath", video.createPath],
    ["video.queryPath", video.queryPath],
    ["videoBackup.createPath", videoBackup.createPath],
    ["videoBackup.queryPath", videoBackup.queryPath]
  ].forEach(([field, value]) => {
    if (value !== undefined && !isValidEndpointOrPath(value)) {
      errors.push(`${field} 必须是 / 开头的路径或 http/https 地址`);
    }
  });
  if (image.mode !== undefined && image.mode !== "" && !["generations", "edits"].includes(String(image.mode).toLowerCase())) {
    errors.push("image.mode 只能是 generations 或 edits");
  }
  if (
    imageBackup.mode !== undefined
    && imageBackup.mode !== ""
    && !["generations", "edits"].includes(String(imageBackup.mode).toLowerCase())
  ) {
    errors.push("imageBackup.mode 只能是 generations 或 edits");
  }
  [
    ["faceBackup.enabled", faceBackup.enabled],
    ["analysisBackup.enabled", analysisBackup.enabled]
  ].forEach(([field, value]) => {
    if (value !== undefined && typeof value !== "boolean") {
      errors.push(`${field} 必须是布尔值`);
    }
  });
  [
    ["faceBackup.timeoutMs", faceBackup.timeoutMs],
    ["analysisBackup.timeoutMs", analysisBackup.timeoutMs]
  ].forEach(([field, value]) => {
    if (
      value !== undefined
      && (
        !Number.isFinite(Number(value))
        || Number(value) < 5000
        || Number(value) > 60000
      )
    ) {
      errors.push(`${field} 必须在 5000～60000 之间`);
    }
  });
  if (
    tencentFaceFusion.endpoint !== undefined
    && (
      !isValidHttpUrl(tencentFaceFusion.endpoint)
      || !/^https:\/\//i.test(String(tencentFaceFusion.endpoint).trim())
    )
  ) {
    errors.push("tencentFaceFusion.endpoint 必须是 HTTPS 地址");
  }
  if (
    tencentFaceFusion.apiVersion !== undefined
    && !/^\d{4}-\d{2}-\d{2}$/.test(String(tencentFaceFusion.apiVersion).trim())
  ) {
    errors.push("tencentFaceFusion.apiVersion 必须是 YYYY-MM-DD 格式");
  }
  [
    ["tencentFaceFusion.secretId", tencentFaceFusion.secretId],
    ["tencentFaceFusion.secretKey", tencentFaceFusion.secretKey],
    ["tencentFaceFusion.region", tencentFaceFusion.region],
    ["tencentFaceFusion.endpoint", tencentFaceFusion.endpoint],
    ["tencentFaceFusion.apiVersion", tencentFaceFusion.apiVersion],
    ["tencentFaceFusion.action", tencentFaceFusion.action],
    ["tencentFaceFusion.model", tencentFaceFusion.model]
  ].forEach(([field, value]) => {
    if (value !== undefined && String(value).length > 256) {
      errors.push(`${field} 长度不能超过 256`);
    }
  });
  if (
    tencentFaceFusion.swapModelType !== undefined
    && (
      !Number.isFinite(Number(tencentFaceFusion.swapModelType))
      || Math.round(Number(tencentFaceFusion.swapModelType))
        !== Number(tencentFaceFusion.swapModelType)
      || Number(tencentFaceFusion.swapModelType) < 1
      || Number(tencentFaceFusion.swapModelType) > 9
    )
  ) {
    errors.push("tencentFaceFusion.swapModelType 必须是 1～9 的整数");
  }
  if (
    tencentFaceFusion.timeoutMs !== undefined
    && (
      !Number.isFinite(Number(tencentFaceFusion.timeoutMs))
      || Number(tencentFaceFusion.timeoutMs) < 5000
      || Number(tencentFaceFusion.timeoutMs) > 120000
    )
  ) {
    errors.push("tencentFaceFusion.timeoutMs 必须在 5000～120000 之间");
  }
  if (
    tencentFaceFusion.maxImageBytes !== undefined
    && (
      !Number.isFinite(Number(tencentFaceFusion.maxImageBytes))
      || Number(tencentFaceFusion.maxImageBytes) < 256 * 1024
      || Number(tencentFaceFusion.maxImageBytes) > 8 * 1024 * 1024
    )
  ) {
    errors.push("tencentFaceFusion.maxImageBytes 必须在 262144～8388608 之间");
  }
  if (
    face.timeoutMs !== undefined
    && (!Number.isFinite(Number(face.timeoutMs))
      || Number(face.timeoutMs) < 5000
      || Number(face.timeoutMs) > 60000)
  ) {
    errors.push("face.timeoutMs 必须在 5000～60000 之间");
  }
  if (
    analysis.timeoutMs !== undefined
    && (!Number.isFinite(Number(analysis.timeoutMs))
      || Number(analysis.timeoutMs) < 5000
      || Number(analysis.timeoutMs) > 60000)
  ) {
    errors.push("analysis.timeoutMs 必须在 5000～60000 之间");
  }
  if (image.timeoutMs !== undefined && (!Number.isFinite(Number(image.timeoutMs)) || Number(image.timeoutMs) < 5000 || Number(image.timeoutMs) > 180000)) {
    errors.push("image.timeoutMs 必须在 5000～180000 之间");
  }
  if (image.maxRetries !== undefined && (!Number.isFinite(Number(image.maxRetries)) || Number(image.maxRetries) < 0 || Number(image.maxRetries) > 5)) {
    errors.push("image.maxRetries 必须在 0～5 之间");
  }
  if (
    imageBackup.timeoutMs !== undefined
    && (
      !Number.isFinite(Number(imageBackup.timeoutMs))
      || Number(imageBackup.timeoutMs) < 5000
      || Number(imageBackup.timeoutMs) > 180000
    )
  ) {
    errors.push("imageBackup.timeoutMs 必须在 5000～180000 之间");
  }
  if (
    imageBackup.maxRetries !== undefined
    && (
      !Number.isFinite(Number(imageBackup.maxRetries))
      || Number(imageBackup.maxRetries) < 0
      || Number(imageBackup.maxRetries) > 5
    )
  ) {
    errors.push("imageBackup.maxRetries 必须在 0～5 之间");
  }
  if (video.timeoutMs !== undefined && (!Number.isFinite(Number(video.timeoutMs)) || Number(video.timeoutMs) < 10000 || Number(video.timeoutMs) > 900000)) {
    errors.push("video.timeoutMs 必须在 10000～900000 之间");
  }
  if (
    videoBackup.timeoutMs !== undefined
    && (
      !Number.isFinite(Number(videoBackup.timeoutMs))
      || Number(videoBackup.timeoutMs) < 10000
      || Number(videoBackup.timeoutMs) > 900000
    )
  ) {
    errors.push("videoBackup.timeoutMs 必须在 10000～900000 之间");
  }
  if (
    overrideBoolean(videoBackup, "enabled", false)
    && normalizeAdminProviderId(video.provider)
    && normalizeAdminProviderId(video.provider)
      === normalizeAdminProviderId(videoBackup.provider)
  ) {
    errors.push("videoBackup.provider 不能和 video.provider 相同，请选择另一家备用服务商");
  }
  if (
    overrideBoolean(faceBackup, "enabled", false)
    && faceBackup.provider
    && normalizeAdminProviderId(face.provider)
      === normalizeAdminProviderId(faceBackup.provider)
  ) {
    errors.push("faceBackup.provider 不能和 face.provider 相同，请选择另一家备用服务商");
  }
  if (
    overrideBoolean(analysisBackup, "enabled", false)
    && analysisBackup.provider
    && normalizeAdminProviderId(analysis.provider)
      === normalizeAdminProviderId(analysisBackup.provider)
  ) {
    errors.push("analysisBackup.provider 不能和 analysis.provider 相同，请选择另一家备用服务商");
  }
  [
    ["face.provider", face.provider],
    ["face.model", face.model],
    ["faceBackup.provider", faceBackup.provider],
    ["faceBackup.model", faceBackup.model],
    ["analysis.provider", analysis.provider],
    ["analysis.model", analysis.model],
    ["analysisBackup.provider", analysisBackup.provider],
    ["analysisBackup.model", analysisBackup.model],
    ["image.provider", image.provider],
    ["image.model", image.model],
    ["image.size", image.size],
    ["image.resolution", image.resolution],
    ["imageBackup.provider", imageBackup.provider],
    ["imageBackup.model", imageBackup.model],
    ["imageBackup.size", imageBackup.size],
    ["imageBackup.resolution", imageBackup.resolution],
    ["video.provider", video.provider],
    ["video.model", video.model],
    ["video.resolution", video.resolution],
    ["video.aspectRatio", video.aspectRatio],
    ["videoBackup.provider", videoBackup.provider],
    ["videoBackup.model", videoBackup.model],
    ["videoBackup.resolution", videoBackup.resolution],
    ["videoBackup.aspectRatio", videoBackup.aspectRatio]
  ].forEach(([field, value]) => {
    if (value !== undefined && String(value).length > 120) errors.push(`${field} 长度不能超过 120`);
  });
  if (
    image.resolution !== undefined
    && image.resolution !== ""
    && !["1K", "2K", "4K"].includes(normalizeImageResolution(image.resolution, ""))
  ) {
    errors.push("image.resolution 只能是 1K、2K 或 4K");
  }
  if (
    imageBackup.resolution !== undefined
    && imageBackup.resolution !== ""
    && !["1K", "2K", "4K"].includes(normalizeImageResolution(imageBackup.resolution, ""))
  ) {
    errors.push("imageBackup.resolution 只能是 1K、2K 或 4K");
  }
  if (
    imageBackup.enabled !== undefined
    && typeof imageBackup.enabled !== "boolean"
  ) {
    errors.push("imageBackup.enabled 必须是布尔值");
  }
  if (
    videoBackup.enabled !== undefined
    && typeof videoBackup.enabled !== "boolean"
  ) {
    errors.push("videoBackup.enabled 必须是布尔值");
  }
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
  const costEntries = [
    ["costs.face.inputPerMillionTokens", faceCosts.inputPerMillionTokens],
    ["costs.face.outputPerMillionTokens", faceCosts.outputPerMillionTokens],
    ["costs.analysis.inputPerMillionTokens", analysisCosts.inputPerMillionTokens],
    ["costs.analysis.outputPerMillionTokens", analysisCosts.outputPerMillionTokens],
    ["costs.image.perImage.1K", imageCosts.perImage && imageCosts.perImage["1K"]],
    ["costs.image.perImage.2K", imageCosts.perImage && imageCosts.perImage["2K"]],
    ["costs.image.perImage.4K", imageCosts.perImage && imageCosts.perImage["4K"]],
    [
      "costs.image.providers.xingju.perImage.1K",
      imageProviderCosts.xingju
        && imageProviderCosts.xingju.perImage
        && imageProviderCosts.xingju.perImage["1K"]
    ],
    [
      "costs.image.providers.xingju.perImage.2K",
      imageProviderCosts.xingju
        && imageProviderCosts.xingju.perImage
        && imageProviderCosts.xingju.perImage["2K"]
    ],
    [
      "costs.image.providers.xingju.perImage.4K",
      imageProviderCosts.xingju
        && imageProviderCosts.xingju.perImage
        && imageProviderCosts.xingju.perImage["4K"]
    ],
    [
      "costs.image.providers.lingyun.perImage.1K",
      imageProviderCosts.lingyun
        && imageProviderCosts.lingyun.perImage
        && imageProviderCosts.lingyun.perImage["1K"]
    ],
    [
      "costs.image.providers.lingyun.perImage.2K",
      imageProviderCosts.lingyun
        && imageProviderCosts.lingyun.perImage
        && imageProviderCosts.lingyun.perImage["2K"]
    ],
    [
      "costs.image.providers.lingyun.perImage.4K",
      imageProviderCosts.lingyun
        && imageProviderCosts.lingyun.perImage
        && imageProviderCosts.lingyun.perImage["4K"]
    ],
    ["costs.video.perSecond.480p", videoCosts.perSecond && videoCosts.perSecond["480p"]],
    ["costs.video.perSecond.720p", videoCosts.perSecond && videoCosts.perSecond["720p"]],
    ["costs.video.perSecond.1080p", videoCosts.perSecond && videoCosts.perSecond["1080p"]],
    ["costs.video.defaultDurationSeconds", videoCosts.defaultDurationSeconds]
  ];
  Object.keys(imageProviderCosts).forEach((provider) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(provider))) return;
    ["1K", "2K", "4K"].forEach((resolution) => {
      costEntries.push([
        `costs.image.providers.${provider}.perImage.${resolution}`,
        imageProviderCosts[provider]
          && imageProviderCosts[provider].perImage
          && imageProviderCosts[provider].perImage[resolution]
      ]);
    });
  });
  costEntries.push(
    ["costs.video.perSecond.480p", videoCosts.perSecond && videoCosts.perSecond["480p"]],
    ["costs.video.perSecond.720p", videoCosts.perSecond && videoCosts.perSecond["720p"]],
    ["costs.video.perSecond.1080p", videoCosts.perSecond && videoCosts.perSecond["1080p"]],
    ["costs.video.defaultDurationSeconds", videoCosts.defaultDurationSeconds]
  );
  costEntries.forEach(([field, value]) => {
    if (value === undefined) return;
    const error = validateCostNumber(value, field);
    if (error) errors.push(error);
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
  [
    ["generationQueue.workerConcurrency", generationQueue.workerConcurrency, 1, 4],
    ["generationQueue.alertThreshold", generationQueue.alertThreshold, 1, 100],
    ["generationQueue.alertCooldownMinutes", generationQueue.alertCooldownMinutes, 1, 60]
  ].forEach(([field, value, minimum, maximum]) => {
    if (
      value !== undefined
      && (
        !Number.isFinite(Number(value))
        || Math.round(Number(value)) !== Number(value)
        || Number(value) < minimum
        || Number(value) > maximum
      )
    ) {
      errors.push(`${field} 必须是 ${minimum}～${maximum} 的整数`);
    }
  });
  if (options.skipProviderMetadata !== true) {
    if (hasOwn(patch, "providerLabels")) {
      errors.push(...validateAdminProviderLabels(patch.providerLabels, patch));
    }
    if (
      hasOwn(patch, "providerProfiles")
      && !isAdminProviderObject(patch.providerProfiles)
    ) {
      errors.push("providerProfiles 必须是对象");
    } else if (hasOwn(patch, "providerProfiles")) {
      const profiles = normalizeAdminProviderProfiles(patch.providerProfiles);
      ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
        Object.keys(profiles[section] || {}).forEach((providerId) => {
          const profileErrors = validateRuntimePatch({
            [section]: profiles[section][providerId]
          }, {
            skipProviderMetadata: true
          });
          profileErrors.forEach((message) => {
            const sectionPrefix = `${section}.`;
            errors.push(
              message.startsWith(sectionPrefix)
                ? `providerProfiles.${section}.${providerId}.${message.slice(sectionPrefix.length)}`
                : `providerProfiles.${section}.${providerId}：${message}`
            );
          });
        });
      });
    }
  }
  return errors;
}

function mergeLegacyRuntimeConfig(current, patch) {
  const existing = current && typeof current === "object" ? current : {};
  const submitted = patch && typeof patch === "object" ? patch : {};
  const existingProfiles = syncAdminTopLevelProviderProfiles(
    existing,
    existing.providerProfiles
  );
  let providerProfiles = mergeAdminProviderProfiles(
    existingProfiles,
    submitted.providerProfiles
  );
  const faceConfig = mergeAdminRuntimeProviderSection(
    "face",
    existing.face,
    submitted.face,
    providerProfiles
  );
  const faceBackupConfig = mergeAdminRuntimeProviderSection(
    "faceBackup",
    existing.faceBackup,
    submitted.faceBackup,
    providerProfiles,
    "face"
  );
  const analysisConfig = mergeAdminRuntimeProviderSection(
    "analysis",
    existing.analysis,
    submitted.analysis,
    providerProfiles
  );
  const analysisBackupConfig = mergeAdminRuntimeProviderSection(
    "analysisBackup",
    existing.analysisBackup,
    submitted.analysisBackup,
    providerProfiles,
    "analysis"
  );
  const imageConfig = mergeAdminRuntimeProviderSection(
    "image",
    existing.image,
    submitted.image,
    providerProfiles
  );
  const imageBackupConfig = mergeAdminRuntimeProviderSection(
    "imageBackup",
    existing.imageBackup,
    submitted.imageBackup,
    providerProfiles
  );
  const videoConfig = mergeAdminRuntimeProviderSection(
    "video",
    existing.video,
    submitted.video,
    providerProfiles
  );
  const videoBackupConfig = mergeAdminRuntimeProviderSection(
    "videoBackup",
    existing.videoBackup,
    submitted.videoBackup,
    providerProfiles,
    "video"
  );
  providerProfiles = syncAdminTopLevelProviderProfiles({
    face: faceConfig,
    analysis: analysisConfig,
    image: imageConfig,
    imageBackup: imageBackupConfig,
    video: videoConfig,
    videoBackup: videoBackupConfig
  }, providerProfiles);
  const existingCosts = existing.costs || {};
  const patchCosts = submitted.costs || {};
  const existingImageCosts = existingCosts.image || {};
  const patchImageCosts = patchCosts.image || {};
  const existingImageProviders = existingImageCosts.providers || {};
  const patchImageProviders = patchImageCosts.providers || {};
  const mergedImageProviders = {};
  Array.from(new Set(Object.keys(existingImageProviders).concat(Object.keys(patchImageProviders)))).forEach((provider) => {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(provider))) return;
    const existingProvider = existingImageProviders[provider] || {};
    const patchProvider = patchImageProviders[provider] || {};
    if (!Object.keys(existingProvider).length && !Object.keys(patchProvider).length) return;
    mergedImageProviders[provider] = Object.assign(
      {},
      existingProvider,
      patchProvider,
      {
        perImage: Object.assign(
          {},
          existingProvider.perImage || {},
          patchProvider.perImage || {}
        )
      }
    );
  });
  const result = {
    providerLabels: mergeAdminProviderLabels(
      existing.providerLabels,
      submitted.providerLabels
    ),
    providerProfiles,
    face: faceConfig,
    faceBackup: faceBackupConfig,
    analysis: analysisConfig,
    analysisBackup: analysisBackupConfig,
    image: imageConfig,
    imageBackup: imageBackupConfig,
    tencentFaceFusion: Object.assign(
      {},
      existing.tencentFaceFusion || {},
      submitted.tencentFaceFusion || {}
    ),
    video: videoConfig,
    videoBackup: videoBackupConfig,
    points: Object.assign({}, existing.points || {}, submitted.points || {}),
    generationQueue: generationQueueMonitor.normalizeQueueSettings(
      Object.assign(
        {},
        existing.generationQueue || {},
        submitted.generationQueue || {}
      )
    ),
    costs: Object.assign({}, existingCosts, patchCosts, {
      face: Object.assign({}, existingCosts.face || {}, patchCosts.face || {}),
      analysis: Object.assign({}, existingCosts.analysis || {}, patchCosts.analysis || {}),
      image: Object.assign({}, existingImageCosts, patchImageCosts, {
        perImage: Object.assign(
          {},
          existingImageCosts.perImage || {},
          patchImageCosts.perImage || {}
        ),
        providers: mergedImageProviders
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
  if (hasOwn(existing, "activeBackups") || hasOwn(submitted, "activeBackups")) {
    result.activeBackups = Object.assign(
      {},
      normalizeActiveBackups(existing.activeBackups, undefined, { includeEmpty: false }),
      normalizeActiveBackups(submitted.activeBackups, undefined, { includeEmpty: false })
    );
  }
  return result;
}

function mergeRuntimeConfig(current, patch) {
  const existing = current && typeof current === "object" ? current : {};
  const submitted = patch && typeof patch === "object" ? patch : {};
  const legacy = mergeLegacyRuntimeConfig(existing, submitted);
  const hasDirectorySignal = (value) => {
    if (!isProviderObject(value)) return false;
    if (
      hasOwn(value, "providerRegistry")
      || hasOwn(value, "activeProviders")
      || hasOwn(value, "activeBackups")
    ) return true;
    if (hasOwn(value, "providerLabels") || hasOwn(value, "providerProfiles")) return true;
    return PROVIDER_CAPABILITY_SLOTS.concat(PROVIDER_BACKUP_SLOTS).some((slot) => {
      const section = value[slot];
      return isProviderObject(section)
        && (hasOwn(section, "provider") || hasOwn(section, "providerKey"));
    });
  };
  const existingHasDirectory = hasDirectorySignal(existing);
  const submittedHasDirectory = hasDirectorySignal(submitted);
  // 两边都是普通旧顶层 partial patch 时，目录不参与合并，避免默认档案
  // 抢走旧 section 的 model/Key。完整运行时在读写入口会先完成迁移。
  if (!existingHasDirectory && !submittedHasDirectory) return legacy;
  // mergeProviderRegistry 同时合并目录和 active 绑定；不能只传 registry
  // 对象，否则函数看不到两侧的 activeProviders，明确切换会被旧绑定覆盖。
  const existingDirectory = existing.providerRegistry
    ? {
        providerRegistry: existing.providerRegistry,
        activeProviders: existing.activeProviders,
        activeBackups: existing.activeBackups
      }
    : migrateLegacyProviderRegistry(existing, existing).value;
  const submittedDirectory = submittedHasDirectory && submitted.providerRegistry
    ? {
        providerRegistry: submitted.providerRegistry,
        activeProviders: submitted.activeProviders,
        activeBackups: submitted.activeBackups
      }
    : submittedHasDirectory
      ? (hasOwn(submitted, "activeProviders") || hasOwn(submitted, "activeBackups"))
        // 管理页保存功能卡时只提交 activeProviders/activeOverrides，
        // 目录档案仍以事务中读取的 existingDirectory 为准；不能把未知的
        // 自定义 UUID 交给“旧 section 迁移”后又被默认服务商覆盖。
        ? {
            providerRegistry: {},
            activeProviders: submitted.activeProviders,
            activeBackups: submitted.activeBackups
          }
        : migrateLegacyProviderRegistry(submitted, submitted).value
      : { providerRegistry: {}, activeProviders: {}, activeBackups: {} };
  const registryMerge = mergeProviderRegistry(
    existingDirectory,
    submittedDirectory
  );
  // 旧调用方可能只提交 image/face 等顶层 section。目录已经是规范来源时，
  // 把这种没有显式 provider 的 partial patch 视为当前 active 档案的能力
  // 覆盖，保留旧 mergeRuntimeConfig 的可编辑语义；显式目录/服务商 patch
  // 仍由 providerRegistry + activeOverrides 处理，避免旧 section 抢写新绑定。
  const compatibilityActiveOverrides = isProviderObject(submitted.activeOverrides)
    ? providerClone(submitted.activeOverrides)
    : {};
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    const section = submitted[slot];
    if (!isProviderObject(section)
      || hasOwn(section, "provider")
      || hasOwn(section, "providerKey")
      || isProviderObject(compatibilityActiveOverrides[slot])) return;
    compatibilityActiveOverrides[slot] = Object.assign({}, section);
  });
  const registryWithActiveOverrides = mergeActiveProviderOverrides(
    registryMerge.providerRegistry,
    registryMerge.activeProviders,
    compatibilityActiveOverrides
  );
  const registryWithBackupOverrides = mergeActiveBackupOverrides(
    registryWithActiveOverrides,
    registryMerge.activeBackups,
    submitted
  );
  const registryWithLegacyProfiles = mergeLegacyProviderProfilesIntoRegistry(
    registryWithBackupOverrides,
    legacy.providerProfiles
  );
  const activeFromLegacy = migrateLegacyProviderRegistry(
    Object.assign({}, legacy, {
      providerRegistry: registryWithLegacyProfiles,
      activeProviders: Object.assign({}, registryMerge.activeProviders),
      ...(hasOwn(existing, "activeBackups") || hasOwn(submitted, "activeBackups")
        ? { activeBackups: Object.assign({}, registryMerge.activeBackups || {}) }
        : {})
    }),
    Object.assign({}, existing, submitted)
  ).value;
  const result = Object.assign({}, legacy, activeFromLegacy, {
      providerRegistry: registryWithLegacyProfiles,
      activeProviders: Object.assign(
        {},
        activeFromLegacy.activeProviders || {},
        registryMerge.activeProviders || {}
      )
  });
  if (hasOwn(existing, "activeBackups") || hasOwn(submitted, "activeBackups")) {
    result.activeBackups = Object.assign(
      {},
      activeFromLegacy.activeBackups || {},
      registryMerge.activeBackups || {}
    );
  }
  const projected = buildLegacyProjectionFromProviderRegistry(result);
  // 兼容旧 helper：仅提交 providerLabels 时不凭空增加内置标签；
  // canonical registry 本身仍保留内置记录，管理页读取时再显式补默认标签。
  if (hasOwn(existing, "providerLabels") || hasOwn(submitted, "providerLabels")) {
    projected.providerLabels = mergeAdminProviderLabels(
      existing.providerLabels,
      submitted.providerLabels
    );
  }
  return projected;
}

function migrateLegacyImageRetryConfig(runtime, rawConfig) {
  const normalized = runtime && typeof runtime === "object"
    ? runtime
    : normalizeRuntimePatch(rawConfig);
  const rawImage = rawConfig && rawConfig.image && typeof rawConfig.image === "object"
    ? rawConfig.image
    : null;
  if (!rawImage || imageRetryPreferenceVersion(rawImage) === IMAGE_RETRY_PREFERENCE_VERSION) {
    return {
      value: normalized,
      migrated: false
    };
  }
  return {
    value: Object.assign({}, normalized, {
      image: Object.assign({}, normalized.image || {}, {
        retryEnabled: true,
        retryPreferenceVersion: IMAGE_RETRY_PREFERENCE_VERSION
      })
    }),
    migrated: true
  };
}

function isLegacyLingyunImageConfig(value) {
  const image = value && typeof value === "object" ? value : {};
  const provider = pixelProtectionFlow.normalizedProvider(image.provider);
  const model = String(image.model || "").trim();
  let lingyunHost = false;
  try {
    const host = new URL(String(image.baseUrl || image.endpoint || "")).hostname.toLowerCase();
    lingyunHost = host === "lingyunapi.xyz" || host.endsWith(".lingyunapi.xyz");
  } catch (_) {
    lingyunHost = false;
  }
  return (
    (provider === "lingyun" || provider === "凌云" || lingyunHost)
    && (!model || model === "gpt-image-2")
  );
}

const ADMIN_CONFIG_AUDIT_SECTIONS = Object.freeze([
  "providerLabels",
  "providerProfiles",
  "providerRegistry",
  "activeProviders",
  "activeBackups",
  "face",
  "faceBackup",
  "analysis",
  "analysisBackup",
  "image",
  "imageBackup",
  "tencentFaceFusion",
  "video",
  "videoBackup",
  "points",
  "costs",
  "generationQueue"
]);

function isSensitiveAdminAuditKey(key) {
  return /(?:api[_-]?key|secret|token|authorization|password|credential)/i
    .test(String(key || ""));
}

function sanitizeAdminAuditStructuredValue(value, depth = 0) {
  if (depth > 5) return "[内容已省略]";
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
      .replace(
        /((?:api[_-]?key|secret|token|authorization|password|credential)\s*[:=]\s*)\S+/gi,
        "$1[已隐藏]"
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeAdminAuditStructuredValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    Object.keys(value).slice(0, 40).forEach((key) => {
      result[key] = isSensitiveAdminAuditKey(key)
        ? "[已隐藏]"
        : sanitizeAdminAuditStructuredValue(value[key], depth + 1);
    });
    return result;
  }
  return String(value).slice(0, 180);
}

function auditSafeValue(value) {
  const safe = sanitizeAdminAuditStructuredValue(value);
  if (safe && typeof safe === "object") {
    return JSON.stringify(safe).slice(0, 180);
  }
  return safe;
}

function flattenAdminAuditValues(value, prefix, output) {
  const source = value && typeof value === "object" ? value : {};
  Object.keys(source).forEach((key) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const item = source[key];
    if (isSensitiveAdminAuditKey(key)) {
      output[path] = {
        secret: true,
        configured: Boolean(normalizeApiKey(item))
      };
      return;
    }
    if (item instanceof Date) {
      output[path] = auditSafeValue(item);
      return;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      flattenAdminAuditValues(item, path, output);
      return;
    }
    output[path] = auditSafeValue(item);
  });
  return output;
}

function adminAuditPathValue(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => (
      value && typeof value === "object" ? value[key] : undefined
    ), source);
}

function auditValuesEqual(left, right) {
  return JSON.stringify(left === undefined ? null : left)
    === JSON.stringify(right === undefined ? null : right);
}

function buildAdminConfigAuditChanges(previous = {}, next = {}, patch = {}) {
  const before = previous && typeof previous === "object" ? previous : {};
  const after = next && typeof next === "object" ? next : {};
  const submitted = patch && typeof patch === "object" ? patch : {};
  const changes = [];
  ADMIN_CONFIG_AUDIT_SECTIONS.forEach((section) => {
    const oldValues = flattenAdminAuditValues(before[section], "", {});
    const newValues = flattenAdminAuditValues(after[section], "", {});
    const patchSection = submitted[section] && typeof submitted[section] === "object"
      ? submitted[section]
      : {};
    const paths = new Set([
      ...Object.keys(oldValues),
      ...Object.keys(newValues)
    ]);
    if (
      hasOwn(patchSection, "apiKey")
      || hasOwn(oldValues, "apiKey")
      || hasOwn(newValues, "apiKey")
    ) {
      paths.add("apiKey");
    }
    [...paths].sort().forEach((field) => {
      const oldValue = oldValues[field];
      const newValue = newValues[field];
      const fieldKey = field.split(".").pop();
      const secretField = isSensitiveAdminAuditKey(fieldKey)
        || Boolean(oldValue && oldValue.secret)
        || Boolean(newValue && newValue.secret);
      if (secretField) {
        const configuredBefore = Boolean(
          oldValue && oldValue.secret && oldValue.configured
        );
        const configuredAfter = Boolean(
          newValue && newValue.secret && newValue.configured
        );
        const submittedRaw = adminAuditPathValue(patchSection, field);
        const submittedKey = submittedRaw === undefined
          ? ""
          : normalizeApiKey(submittedRaw);
        const previousKey = normalizeApiKey(
          adminAuditPathValue(before[section], field)
        );
        const updated = Boolean(
          submittedKey
          && submittedKey !== previousKey
        );
        if (
          configuredBefore !== configuredAfter
          || updated
        ) {
          changes.push({
            section,
            field: String(fieldKey || "secret"),
            secret: true,
            configuredBefore,
            configuredAfter,
            updated
          });
        }
        return;
      }
      if (!auditValuesEqual(oldValue, newValue)) {
        changes.push({
          section,
          field,
          oldValue: oldValue === undefined ? null : oldValue,
          newValue: newValue === undefined ? null : newValue
        });
      }
    });
  });
  return changes;
}

function adminConfigAuditIdentity(openid) {
  const value = String(openid || "").trim();
  if (!value || value === "anonymous" || value === "system") return "system";
  return usageUserHash(`admin-audit:${value}`);
}

function normalizeAdminConfigAuditRow(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const createdAt = source.createdAt instanceof Date
    ? source.createdAt
    : new Date(source.createdAt || Date.now());
  const changes = Array.isArray(source.changes)
    ? source.changes.map((item) => {
        const change = item && typeof item === "object" ? item : {};
        const fieldKey = String(change.field || "").split(".").pop();
        if (change.secret || isSensitiveAdminAuditKey(fieldKey)) {
          return {
            section: compactUsageText(change.section, 40),
            field: compactUsageText(fieldKey, 40) || "secret",
            secret: true,
            configuredBefore: Boolean(change.configuredBefore),
            configuredAfter: Boolean(change.configuredAfter),
            updated: Boolean(change.updated)
          };
        }
        return {
          section: compactUsageText(change.section, 40),
          field: compactUsageText(change.field, 120),
          oldValue: auditSafeValue(change.oldValue),
          newValue: auditSafeValue(change.newValue)
        };
      })
      .filter((item) => item.section && item.field)
      .slice(0, 100)
    : [];
  return {
    _id: compactUsageText(source._id, 80),
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
    source: ["system-auto-correct", "admin-provider-save", "admin-provider-delete", "admin-save"].includes(source.source)
      ? source.source
      : "admin-save",
    actorHash: compactUsageText(source.actorHash, 80) || "system",
    configVersion: Math.max(0, Number(source.configVersion) || 0),
    changeCount: changes.length,
    changedSections: Array.from(new Set(
      changes.map((item) => item.section).filter(Boolean)
    )).slice(0, 20),
    changes
  };
}

async function writeAdminConfigAuditLog(options = {}) {
  const changes = buildAdminConfigAuditChanges(
    options.previous,
    options.next,
    options.patch
  );
  if (!changes.length) return false;
  const row = normalizeAdminConfigAuditRow({
    source: options.source,
    actorHash: options.actorHash || adminConfigAuditIdentity(options.openid),
    configVersion: options.configVersion,
    changes,
    createdAt: options.createdAt || new Date()
  });
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    adminConfigAuditTestRows.push(row);
    return true;
  }
  try {
    await db.collection(ADMIN_CONFIG_AUDIT_LOG_COLLECTION).add({
      data: stripDocumentId(row)
    });
    return true;
  } catch (error) {
    log("warn", "admin.config-audit.write-failed", {
      source: row.source,
      configVersion: row.configVersion,
      changeCount: row.changeCount,
      error: error && error.message
    });
    return false;
  }
}

function migrateLegacyImageProviderConfig(runtime, rawConfig) {
  const normalized = runtime && typeof runtime === "object"
    ? runtime
    : normalizeRuntimePatch(rawConfig);
  const rawImage = rawConfig && rawConfig.image && typeof rawConfig.image === "object"
    ? rawConfig.image
    : null;
  const rawBackup = rawConfig
    && rawConfig.imageBackup
    && typeof rawConfig.imageBackup === "object"
    ? rawConfig.imageBackup
    : null;
  if (!rawImage || !isLegacyLingyunImageConfig(rawImage)) {
    return {
      value: normalized,
      migrated: false
    };
  }

  const hasExistingBackup = Boolean(
    rawBackup && Object.keys(rawBackup).length
  );
  const legacyImage = normalized.image && typeof normalized.image === "object"
    ? normalized.image
    : {};
  const existingBackup = normalized.imageBackup
    && typeof normalized.imageBackup === "object"
    ? normalized.imageBackup
    : {};
  const legacyApiKey = normalizeApiKey(
    rawImage.apiKey || legacyImage.apiKey
  );
  const legacyBackup = Object.assign(
    {},
    hasExistingBackup ? existingBackup : legacyImage
  );
  if (!legacyBackup.provider) legacyBackup.provider = "lingyun";
  if (!legacyBackup.model) legacyBackup.model = "gpt-image-2";
  if (!legacyBackup.baseUrl) legacyBackup.baseUrl = "https://api.lingyunapi.xyz/v1";
  if (!legacyBackup.mode) legacyBackup.mode = "edits";
  if (!legacyBackup.size) legacyBackup.size = env("AI_IMAGE_SIZE", "1024x1024");
  if (!legacyBackup.resolution) {
    legacyBackup.resolution = normalizeImageResolution(legacyBackup.size, "1K");
  }
  if (
    !normalizeApiKey(legacyBackup.apiKey)
    && legacyApiKey
    && (!hasExistingBackup || isLegacyLingyunImageConfig(legacyBackup))
  ) {
    legacyBackup.apiKey = legacyApiKey;
  }
  if (!hasOwn(legacyBackup, "enabled")) {
    legacyBackup.enabled = Boolean(
      normalizeApiKey(legacyBackup.apiKey)
      && legacyBackup.provider
      && legacyBackup.model
      && (legacyBackup.baseUrl || legacyBackup.endpoint)
    );
  }
  legacyBackup.timeoutMs = 150000;
  legacyBackup.maxRetries = 0;
  legacyBackup.retryEnabled = false;
  legacyBackup.retryPreferenceVersion = IMAGE_RETRY_PREFERENCE_VERSION;
  const primaryDefaults = resolveImageConfig({
    provider: "xingju",
    mode: "edits",
    size: legacyBackup.size || env("AI_IMAGE_SIZE", "1024x1024"),
    resolution: legacyBackup.resolution
      || normalizeImageResolution(legacyBackup.size, "1K"),
    compatibilityMode: Boolean(legacyBackup.compatibilityMode),
    timeoutMs: 150000,
    maxRetries: 1,
    retryEnabled: true,
    retryPreferenceVersion: IMAGE_RETRY_PREFERENCE_VERSION
  });
  const primary = Object.assign({}, primaryDefaults, {
    provider: "xingju",
    model: "jw-wy-gpt-image-2",
    timeoutMs: 150000,
    maxRetries: 1,
    retryEnabled: true,
    retryPreferenceVersion: IMAGE_RETRY_PREFERENCE_VERSION
  });
  delete primary.apiKey;

  return {
    value: Object.assign({}, normalized, {
      image: primary,
      imageBackup: legacyBackup
    }),
    migrated: true
  };
}

function guardAdminImageProviderConfig(current, merged, patch) {
  const existing = current && typeof current === "object" ? current : {};
  const next = merged && typeof merged === "object" ? merged : {};
  const submitted = patch && typeof patch === "object" ? patch : {};
  const nextImage = next.image && typeof next.image === "object"
    ? next.image
    : {};
  if (!isLegacyLingyunImageConfig(nextImage)) {
    return {
      value: next,
      corrected: false
    };
  }

  const existingImage = existing.image && typeof existing.image === "object"
    ? existing.image
    : {};
  const submittedImage = submitted.image && typeof submitted.image === "object"
    ? submitted.image
    : {};
  const guardInput = Object.assign({}, next, {
    image: Object.assign({}, nextImage),
    imageBackup: Object.assign({}, next.imageBackup || {})
  });
  const submittedLingyunKey = hasOwn(submittedImage, "apiKey")
    ? normalizeApiKey(submittedImage.apiKey)
    : "";

  // 管理员只改了服务商/模型且主 Key 留空时，merge 后会带着旧星炬 Key。
  // 这里先移除，避免旧星炬 Key 被误搬到凌云备用配置。
  if (
    !submittedLingyunKey
    && !isLegacyLingyunImageConfig(existingImage)
  ) {
    delete guardInput.image.apiKey;
  }

  const migrated = migrateLegacyImageProviderConfig(guardInput, guardInput);
  const existingPrimaryKey = (
    isXingjuImageProvider(existingImage)
    && !isLegacyLingyunImageConfig(existingImage)
  )
    ? normalizeApiKey(existingImage.apiKey)
    : "";
  if (existingPrimaryKey) {
    migrated.value.image = Object.assign({}, migrated.value.image, {
      apiKey: existingPrimaryKey
    });
  }

  return {
    value: migrated.value,
    corrected: Boolean(migrated.migrated)
  };
}

function redactAdminProviderProfiles(value, defaultsValue = {}) {
  const profiles = normalizeAdminProviderProfiles(value);
  const defaults = normalizeAdminProviderProfiles(defaultsValue);
  const result = {};
  ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
    const rows = {};
    Object.keys(profiles[section] || {}).forEach((providerId) => {
      const profile = Object.assign({}, profiles[section][providerId]);
      const defaultProfile = defaults[section] && defaults[section][providerId] || {};
      const apiKeyConfigured = Boolean(
        normalizeApiKey(profile.apiKey)
        || normalizeApiKey(defaultProfile.apiKey)
      );
      profile.apiKey = "";
      profile.apiKeyConfigured = apiKeyConfigured;
      rows[providerId] = profile;
    });
    result[section] = sortAdminProviderObject(rows);
  });
  return result;
}

function redactConfig(config, defaults) {
  const face = config.face || {};
  const faceBackup = config.faceBackup || {};
  const analysis = config.analysis || {};
  const analysisBackup = config.analysisBackup || {};
  const image = config.image || {};
  const imageBackup = config.imageBackup || {};
  const providerLabels = normalizeAdminProviderLabels(
    config.providerLabels,
    { includeDefaults: true }
  );
  const tencentFaceFusion = config.tencentFaceFusion || {};
  const video = config.video || {};
  const videoBackup = config.videoBackup || {};
  const points = config.points || {};
  const costs = resolveCostConfig(config.costs || {}, {
    imageProvider: image.provider || defaults.image && defaults.image.provider
  });
  const generationQueue = generationQueueMonitor.normalizeQueueSettings(
    config.generationQueue
  );
  const providerProfiles = syncAdminTopLevelProviderProfiles(
    config,
    config.providerProfiles
  );
  const defaultProviderProfiles = syncAdminTopLevelProviderProfiles(
    defaults,
    defaults.providerProfiles
  );
  const redactedImageProviders = {};
  const imageProviderCosts = costs.image && costs.image.providers
    && typeof costs.image.providers === "object"
    ? costs.image.providers
    : {};
  Object.keys(imageProviderCosts).forEach((provider) => {
    const source = imageProviderCosts[provider] || {};
    redactedImageProviders[provider] = {
      perImage: Object.assign({}, source.perImage || {})
    };
  });
  ["xingju", "lingyun"].forEach((provider) => {
    if (!hasOwn(redactedImageProviders, provider)) {
      redactedImageProviders[provider] = { perImage: {} };
    }
  });
  return {
    providerLabels,
    providerProfiles: redactAdminProviderProfiles(
      providerProfiles,
      defaultProviderProfiles
    ),
    face: {
      provider: face.provider || "",
      providerKey: face.providerKey || providerStableKey(face.provider),
      baseUrl: face.baseUrl || "",
      endpoint: face.endpoint || "",
      apiKey: "",
      model: face.faceModel || face.model || "",
      timeoutMs: Number(face.timeoutMs || 0),
      apiKeyConfigured: Boolean(
        normalizeApiKey(face.apiKey)
        || normalizeApiKey(defaults.face && defaults.face.apiKey)
      )
    },
    faceBackup: {
      enabled: Boolean(faceBackup.enabled),
      provider: faceBackup.provider || "",
      providerKey: faceBackup.providerKey || providerStableKey(faceBackup.provider),
      baseUrl: faceBackup.baseUrl || "",
      endpoint: faceBackup.endpoint || "",
      apiKey: "",
      model: faceBackup.faceModel || faceBackup.model || "",
      timeoutMs: Number(faceBackup.timeoutMs || 0),
      configured: Boolean(faceBackup.configured),
      apiKeyConfigured: Boolean(
        normalizeApiKey(faceBackup.apiKey)
        || normalizeApiKey(defaults.faceBackup && defaults.faceBackup.apiKey)
      )
    },
    analysis: {
      provider: analysis.provider || "",
      providerKey: analysis.providerKey || providerStableKey(analysis.provider),
      baseUrl: analysis.baseUrl || "",
      endpoint: analysis.endpoint || "",
      apiKey: "",
      model: analysis.model || "",
      timeoutMs: Number(analysis.timeoutMs || 0),
      apiKeyConfigured: Boolean(
        normalizeApiKey(analysis.apiKey)
        || normalizeApiKey(defaults.analysis && defaults.analysis.apiKey)
      )
    },
    analysisBackup: {
      enabled: Boolean(analysisBackup.enabled),
      provider: analysisBackup.provider || "",
      providerKey: analysisBackup.providerKey || providerStableKey(analysisBackup.provider),
      baseUrl: analysisBackup.baseUrl || "",
      endpoint: analysisBackup.endpoint || "",
      apiKey: "",
      model: analysisBackup.model || "",
      timeoutMs: Number(analysisBackup.timeoutMs || 0),
      configured: Boolean(analysisBackup.configured),
      apiKeyConfigured: Boolean(
        normalizeApiKey(analysisBackup.apiKey)
        || normalizeApiKey(defaults.analysisBackup && defaults.analysisBackup.apiKey)
      )
    },
    image: {
      provider: image.provider || "",
      providerKey: image.providerKey || providerStableKey(image.provider),
      baseUrl: image.baseUrl || "",
      endpoint: image.endpoint || "",
      apiKey: "",
      model: image.model || "",
      mode: image.mode || "",
      size: image.size || "",
      resolution: normalizeImageResolution(
        image.resolution || image.size,
        "1K"
      ),
      compatibilityMode: overrideBoolean(image, "compatibilityMode", false),
      timeoutMs: Number(image.timeoutMs || 0),
      maxRetries: Number(image.maxRetries || 0),
      retryEnabled: Boolean(image.retryEnabled),
      retryPreferenceVersion: imageRetryPreferenceVersion(image),
      apiKeyConfigured: Boolean(
        normalizeApiKey(image.apiKey)
        || normalizeApiKey(defaults.image && defaults.image.apiKey)
      )
    },
    imageBackup: {
      enabled: Boolean(imageBackup.enabled),
      provider: imageBackup.provider || "",
      providerKey: imageBackup.providerKey || providerStableKey(imageBackup.provider),
      baseUrl: imageBackup.baseUrl || "",
      endpoint: imageBackup.endpoint || "",
      apiKey: "",
      model: imageBackup.model || "",
      mode: imageBackup.mode || "",
      size: imageBackup.size || "",
      resolution: normalizeImageResolution(
        imageBackup.resolution || imageBackup.size,
        "1K"
      ),
      compatibilityMode: overrideBoolean(
        imageBackup,
        "compatibilityMode",
        false
      ),
      timeoutMs: Number(imageBackup.timeoutMs || 0),
      maxRetries: Number(imageBackup.maxRetries || 0),
      retryEnabled: Boolean(imageBackup.retryEnabled),
      retryPreferenceVersion: imageRetryPreferenceVersion(imageBackup),
      apiKeyConfigured: Boolean(
        normalizeApiKey(imageBackup.apiKey)
        || normalizeApiKey(defaults.imageBackup && defaults.imageBackup.apiKey)
      )
    },
    tencentFaceFusion: {
      secretId: "",
      secretKey: "",
      region: tencentFaceFusion.region || "ap-guangzhou",
      endpoint: tencentFaceFusion.endpoint
        || "https://facefusion.tencentcloudapi.com",
      apiVersion: tencentFaceFusion.apiVersion || "2022-09-27",
      action: tencentFaceFusion.action || "FuseFaceUltra",
      model: tencentFaceFusion.model || "FuseFaceUltra",
      swapModelType: Number(tencentFaceFusion.swapModelType) || 4,
      logoAdd: Boolean(tencentFaceFusion.logoAdd),
      timeoutMs: Number(tencentFaceFusion.timeoutMs) || 75000,
      maxImageBytes: Number(tencentFaceFusion.maxImageBytes) || 5 * 1024 * 1024,
      configured: Boolean(
        tencentFaceFusion.secretId
        && tencentFaceFusion.secretKey
      )
    },
    video: {
      provider: video.provider || "",
      providerKey: video.providerKey || providerStableKey(video.provider),
      baseUrl: video.baseUrl || "",
      endpoint: video.endpoint || "",
      queryEndpoint: video.queryEndpoint || "",
      apiKey: "",
      model: video.model || "",
      createPath: video.createPath || "",
      queryPath: video.queryPath || "",
      resolution: video.resolution || "",
      aspectRatio: video.aspectRatio || "",
      timeoutMs: Number(video.timeoutMs || 0),
      apiKeyConfigured: Boolean(
        normalizeApiKey(video.apiKey)
        || normalizeApiKey(defaults.video && defaults.video.apiKey)
      )
    },
    videoBackup: {
      enabled: Boolean(videoBackup.enabled),
      provider: videoBackup.provider || "",
      providerKey: videoBackup.providerKey || providerStableKey(videoBackup.provider),
      baseUrl: videoBackup.baseUrl || "",
      endpoint: videoBackup.endpoint || "",
      queryEndpoint: videoBackup.queryEndpoint || "",
      apiKey: "",
      model: videoBackup.model || "",
      createPath: videoBackup.createPath || "",
      queryPath: videoBackup.queryPath || "",
      resolution: videoBackup.resolution || "",
      aspectRatio: videoBackup.aspectRatio || "",
      timeoutMs: Number(videoBackup.timeoutMs || 0),
      configured: Boolean(videoBackup.configured),
      apiKeyConfigured: Boolean(
        normalizeApiKey(videoBackup.apiKey)
        || normalizeApiKey(defaults.videoBackup && defaults.videoBackup.apiKey)
      )
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
      analysis: Object.assign({}, costs.analysis),
      image: {
        defaultResolution: costs.image.defaultResolution,
        primaryProvider: costs.image.primaryProvider,
        perImage: Object.assign({}, costs.image.perImage),
        providers: redactedImageProviders
      },
      video: {
        defaultResolution: costs.video.defaultResolution,
        perSecond: Object.assign({}, costs.video.perSecond),
        defaultDurationSeconds: costs.video.defaultDurationSeconds
      }
    },
    generationQueue
  };
}

function modelPriceTableMatches(actual, expected) {
  const source = actual && typeof actual === "object" ? actual : {};
  return Object.keys(expected).every((key) => (
    hasOwn(source, key)
    && Number.isFinite(Number(source[key]))
    && Math.abs(Number(source[key]) - Number(expected[key])) < 1e-9
  ));
}

function migrateLegacyModelCostConfig(runtime, rawConfig) {
  const normalized = runtime && typeof runtime === "object"
    ? runtime
    : normalizeRuntimePatch(rawConfig);
  const rawCosts = rawConfig && rawConfig.costs && typeof rawConfig.costs === "object"
    ? rawConfig.costs
    : {};
  const rawImageCosts = rawCosts.image && typeof rawCosts.image === "object"
    ? rawCosts.image
    : {};
  const normalizedCosts = normalized && normalized.costs
    ? normalized.costs
    : {};
  const normalizedImageCosts = normalizedCosts.image || {};
  const normalizedProviders = normalizedImageCosts.providers || {};
  const normalizedXingju = normalizedProviders.xingju || {};
  const normalizedLingyun = normalizedProviders.lingyun || {};
  const rawProviders = rawImageCosts.providers && typeof rawImageCosts.providers === "object"
    ? rawImageCosts.providers
    : {};
  const rawXingju = rawProviders.xingju && typeof rawProviders.xingju === "object"
    ? rawProviders.xingju
    : {};
  const rawLingyun = rawProviders.lingyun && typeof rawProviders.lingyun === "object"
    ? rawProviders.lingyun
    : {};
  const hasProviderPricing = Object.keys(rawProviders).length > 0;
  const legacyLingyunSource = modelPriceTableMatches(
    rawImageCosts.perImage,
    LEGACY_LINGYUN_IMAGE_PRICES_CNY
  )
    ? LINGYUN_IMAGE_PRICES_CNY
    : hasProviderPricing
      ? LINGYUN_IMAGE_PRICES_CNY
      : normalizedImageCosts.perImage || rawImageCosts.perImage;
  const xingjuPrices = resolveImagePriceTable(
    normalizedXingju.perImage,
    XINGJU_IMAGE_PRICES_CNY
  );
  const lingyunPrices = resolveImagePriceTable(
    normalizedLingyun.perImage || legacyLingyunSource,
    LINGYUN_IMAGE_PRICES_CNY
  );
  const primaryProvider = normalizeImageCostProvider(
    normalized.image && normalized.image.provider
      || rawConfig && rawConfig.image && rawConfig.image.provider
      || "xingju"
  ) || "xingju";
  const primaryPrices = primaryProvider === "lingyun"
    ? lingyunPrices
    : xingjuPrices;
  const customProviderSources = {};
  const providerSourceKeys = Array.from(new Set(
    Object.keys(rawProviders).concat(Object.keys(normalizedProviders))
  ));
  providerSourceKeys.forEach((providerId) => {
    const normalizedProviderId = normalizeImageCostProvider(providerId);
    if (!normalizedProviderId || ["xingju", "lingyun"].includes(normalizedProviderId)) return;
    const source = normalizedProviders[providerId] || rawProviders[providerId] || {};
    if (!source || typeof source !== "object") return;
    customProviderSources[providerId] = Object.assign({}, source, {
      perImage: resolveImagePriceTable(source.perImage, primaryPrices)
    });
  });
  const migrated = !modelPriceTableMatches(rawXingju.perImage, xingjuPrices)
    || !modelPriceTableMatches(rawLingyun.perImage, lingyunPrices)
    || !modelPriceTableMatches(rawImageCosts.perImage, primaryPrices)
    || providerSourceKeys.some((providerId) => (
      !["xingju", "lingyun"].includes(normalizeImageCostProvider(providerId))
      && !modelPriceTableMatches(
        (normalizedProviders[providerId] || rawProviders[providerId] || {}).perImage,
        customProviderSources[providerId] && customProviderSources[providerId].perImage || primaryPrices
      )
    ));
  if (!migrated) {
    return {
      value: normalized,
      migrated: false
    };
  }
  return {
    value: Object.assign({}, normalized, {
      costs: Object.assign({}, normalizedCosts, {
        image: Object.assign({}, normalizedImageCosts, {
          perImage: Object.assign({}, primaryPrices),
          providers: {
            xingju: Object.assign({}, normalizedXingju, {
              perImage: Object.assign({}, xingjuPrices)
            }),
            lingyun: Object.assign({}, normalizedLingyun, {
              perImage: Object.assign({}, lingyunPrices)
            }),
            ...customProviderSources
          }
        })
      })
    }),
    migrated: true
  };
}

function migrateLegacyAdminProviderProfiles(runtime, rawConfig) {
  const normalized = runtime && typeof runtime === "object"
    ? runtime
    : normalizeRuntimePatch(rawConfig);
  const providerLabels = normalizeAdminProviderLabels(
    normalized && normalized.providerLabels,
    { includeDefaults: true }
  );
  const providerProfiles = syncAdminTopLevelProviderProfiles(
    normalized,
    normalized && normalized.providerProfiles
  );
  const rawLabels = normalizeAdminProviderLabels(
    rawConfig && rawConfig.providerLabels
  );
  const rawProfiles = normalizeAdminProviderProfiles(
    rawConfig && rawConfig.providerProfiles
  );
  const migrated = JSON.stringify(providerLabels) !== JSON.stringify(rawLabels)
    || JSON.stringify(providerProfiles) !== JSON.stringify(rawProfiles);
  return {
    value: Object.assign({}, normalized, {
      providerLabels,
      providerProfiles
    }),
    migrated
  };
}

async function loadAdminRuntimeConfig(force = false, options = {}) {
  const allowMigrations = options.allowMigrations !== false;
  const useCache = options.cache !== false;
  if (
    process.env.WECHAT_MINIAPP_TEST === "1"
    && process.env.ADMIN_RUNTIME_CONFIG_SMOKE !== "1"
  ) {
    return null;
  }
  if (
    useCache
    && !force
    && adminRuntimeCache.expiresAt > Date.now()
  ) {
    return adminRuntimeCache.value;
  }
  try {
    const result = await db
      .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
      .doc(ADMIN_RUNTIME_CONFIG_ID)
      .get();
    const rawConfig = result && result.data ? result.data : null;
    const normalized = rawConfig
      ? migrateLegacyProviderRegistry(normalizeRuntimePatch(rawConfig), rawConfig).value
      : null;
    const retryMigration = migrateLegacyImageRetryConfig(normalized, rawConfig);
    const providerMigration = migrateLegacyImageProviderConfig(
      retryMigration.value,
      rawConfig
    );
    const costMigration = migrateLegacyModelCostConfig(
      providerMigration.value,
      rawConfig
    );
    const profileMigration = migrateLegacyAdminProviderProfiles(
      costMigration.value,
      rawConfig
    );
    const registryMigration = migrateLegacyProviderRegistry(
      profileMigration.value,
      rawConfig
    );
    let migrationApplied = false;
    let migrationVersion = Number(rawConfig && rawConfig.version) || 0;
    let migrationUpdatedAt = rawConfig && rawConfig.updatedAt
      ? rawConfig.updatedAt
      : "";
    let migrationUpdatedBy = rawConfig && rawConfig.updatedBy
      ? rawConfig.updatedBy
      : "";
    if (
      (
        retryMigration.migrated
        || providerMigration.migrated
        || costMigration.migrated
        || profileMigration.migrated
        || registryMigration.migrated
      )
      && allowMigrations
      && process.env.WECHAT_MINIAPP_TEST !== "1"
    ) {
      try {
        const migrationData = {};
        if (providerMigration.migrated) {
          migrationData.image = costMigration.value.image;
          migrationData.imageBackup = costMigration.value.imageBackup;
        } else if (retryMigration.migrated) {
          migrationData.image = costMigration.value.image;
        }
        if (costMigration.migrated) {
          migrationData.costs = profileMigration.value.costs;
        }
        if (profileMigration.migrated) {
          migrationData.providerLabels = profileMigration.value.providerLabels;
          migrationData.providerProfiles = profileMigration.value.providerProfiles;
        }
        if (registryMigration.migrated) {
          migrationData.providerRegistry = registryMigration.value.providerRegistry;
          migrationData.activeProviders = registryMigration.value.activeProviders;
          migrationData.providerLabels = registryMigration.value.providerLabels;
          migrationData.providerProfiles = registryMigration.value.providerProfiles;
          migrationData.activeBackups = registryMigration.value.activeBackups;
          ["face", "faceBackup", "analysis", "analysisBackup", "image", "imageBackup", "video", "videoBackup"].forEach((slot) => {
            if (registryMigration.value[slot]) migrationData[slot] = registryMigration.value[slot];
          });
        }
        migrationVersion += 1;
        migrationUpdatedAt = new Date();
        migrationUpdatedBy = "system:auto-correct";
        migrationData.version = migrationVersion;
        migrationData.updatedAt = migrationUpdatedAt;
        migrationData.updatedBy = migrationUpdatedBy;
        await db
          .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
          .doc(ADMIN_RUNTIME_CONFIG_ID)
          .update({
            data: migrationData
          });
        migrationApplied = true;
        await writeAdminConfigAuditLog({
          source: "system-auto-correct",
          actorHash: "system",
          configVersion: migrationVersion,
          previous: rawConfig,
          next: Object.assign({}, rawConfig, migrationData),
          patch: migrationData
        });
        log("info", "admin.runtime-config.defaults-migrated", {
          version: migrationVersion,
          retryMigrated: retryMigration.migrated,
          imageProviderMigrated: providerMigration.migrated,
          modelCostsMigrated: costMigration.migrated,
          providerProfilesMigrated: profileMigration.migrated,
          costConfigVersion: MODEL_COST_CONFIG_VERSION
          ,providerRegistryMigrated: registryMigration.migrated
        });
      } catch (migrationError) {
        // 当前请求仍使用迁移后的值，写回失败时下一次冷启动还会幂等重试。
        log("warn", "admin.runtime-config.defaults-migration-failed", {
          error: migrationError && migrationError.message
        });
      }
    }
    const value = rawConfig
      ? Object.assign(registryMigration.value, {
          generationQueue: generationQueueMonitor.normalizeQueueSettings(
            profileMigration.value && profileMigration.value.generationQueue
          ),
          generationQueueAlertState: rawConfig.generationQueueAlertState
            && typeof rawConfig.generationQueueAlertState === "object"
            ? Object.assign({}, rawConfig.generationQueueAlertState)
           : {},
          version: migrationApplied
            ? migrationVersion
            : Number(rawConfig.version) || 0,
          updatedAt: migrationApplied
            ? migrationUpdatedAt
            : rawConfig.updatedAt || "",
          updatedBy: migrationApplied
            ? migrationUpdatedBy
            : rawConfig.updatedBy || ""
        })
      : null;
    if (useCache) {
      adminRuntimeCache = {
        value,
        expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
      };
    }
    return value;
  } catch (error) {
    if (useCache) {
      adminRuntimeCache = {
        value: null,
        expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
      };
    }
    log("warn", "admin.runtime-config.read-failed", {
      error: error && error.message
    });
    return null;
  }
}

async function resolveEffectiveConfigs(options = {}) {
  const loadedRuntime = await loadAdminRuntimeConfig(
    Boolean(options.force),
    options
  );
  const runtime = loadedRuntime
    ? migrateLegacyProviderRegistry(loadedRuntime, loadedRuntime).value
    : null;
  const projected = runtime
    ? buildLegacyProjectionFromProviderRegistry(runtime)
      : {
        face: {},
        faceBackup: {},
        analysis: {},
        analysisBackup: {},
        image: {},
        imageBackup: {},
        video: {},
        videoBackup: {},
        points: {},
        costs: {},
        generationQueue: {}
      };
  const image = resolveImageConfig(projected.image);
  const face = resolveFaceConfig(projected.face);
  const faceBackup = resolveFaceBackupConfig(projected.faceBackup, runtime);
  const analysis = resolveAnalysisConfig(projected.analysis);
  const analysisBackup = resolveAnalysisBackupConfig(projected.analysisBackup, runtime);
  const imageBackup = resolveImageBackupConfig(projected.imageBackup);
  const video = resolveVideoConfig(projected.video);
  return {
    runtime: runtime || {
      providerRegistry: normalizeProviderRegistry({}, { includeDefaults: true }),
      activeProviders: normalizeActiveProviders(
        {},
        normalizeProviderRegistry({}, { includeDefaults: true })
      ),
      activeBackups: normalizeActiveBackups(
        {},
        normalizeProviderRegistry({}, { includeDefaults: true })
      ),
      providerLabels: normalizeAdminProviderLabels({}, { includeDefaults: true }),
      providerProfiles: normalizeAdminProviderProfiles({}),
      face: {},
      faceBackup: {},
      analysis: {},
      analysisBackup: {},
      image: {},
      imageBackup: {},
      tencentFaceFusion: {},
      video: {},
      videoBackup: {},
      points: {},
      costs: {},
      generationQueue: generationQueueMonitor.normalizeQueueSettings()
    },
    providerRegistry: normalizeProviderRegistry(
      (runtime || projected).providerRegistry,
      { includeDefaults: true }
    ),
    activeProviders: normalizeActiveProviders(
      (runtime || projected).activeProviders,
      (runtime || projected).providerRegistry
    ),
    activeBackups: normalizeActiveBackups(
      (runtime || projected).activeBackups,
      (runtime || projected).providerRegistry
    ),
    providerLabels: normalizeAdminProviderLabels(
      (runtime || projected).providerLabels,
      { includeDefaults: true }
    ),
    providerProfiles: normalizeAdminProviderProfiles(
      (runtime || projected).providerProfiles
    ),
    face,
    faceBackup,
    analysis,
    analysisBackup,
    image,
    imageBackup,
    tencentFaceFusion: resolveTencentFaceFusionConfig(
      runtime && runtime.tencentFaceFusion
    ),
    video,
    videoBackup: resolveVideoBackupConfig(
      runtime && runtime.videoBackup
    ),
    points: resolvePointsConfig(projected.points),
    costs: resolveCostConfig(projected.costs, {
      imageProvider: image.provider
    }),
    generationQueue: generationQueueMonitor.normalizeQueueSettings(
      runtime && runtime.generationQueue
    )
  };
}

function adminConfigView(configs, runtime, metadata = {}) {
  const faceDefaults = resolveFaceConfig();
  const faceBackupDefaults = resolveFaceBackupConfig();
  const analysisDefaults = resolveAnalysisConfig();
  const analysisBackupDefaults = resolveAnalysisBackupConfig();
  const imageDefaults = resolveImageConfig();
  const imageBackupDefaults = resolveImageBackupConfig();
  const tencentFaceFusionDefaults = resolveTencentFaceFusionConfig();
  const videoDefaults = resolveVideoConfig();
  const videoBackupDefaults = resolveVideoBackupConfig();
  const pointDefaults = resolvePointsConfig();
  const costDefaults = resolveCostConfig({}, {
    imageProvider: imageDefaults.provider
  });
  const generationQueueDefaults = generationQueueMonitor.normalizeQueueSettings();
  const overrides = runtime || {
    providerLabels: {},
    face: {},
    faceBackup: {},
    analysis: {},
    analysisBackup: {},
    image: {},
    imageBackup: {},
    tencentFaceFusion: {},
    video: {},
    videoBackup: {},
    points: {},
    costs: {},
    generationQueue: generationQueueDefaults
  };
  const providerRegistry = redactProviderRegistry(
    configs && configs.providerRegistry
      || runtime && runtime.providerRegistry
      || {}
  );
  const activeProviders = normalizeActiveProviders(
    configs && configs.activeProviders
      || runtime && runtime.activeProviders,
    providerRegistry
  );
  const activeBackups = normalizeActiveBackups(
    configs && configs.activeBackups
      || runtime && runtime.activeBackups,
    providerRegistry
  );
  return {
    defaults: redactConfig({
      providerLabels: DEFAULT_ADMIN_PROVIDER_LABELS,
      face: faceDefaults,
      faceBackup: faceBackupDefaults,
      analysis: analysisDefaults,
      analysisBackup: analysisBackupDefaults,
      image: imageDefaults,
      imageBackup: imageBackupDefaults,
      tencentFaceFusion: tencentFaceFusionDefaults,
      video: videoDefaults,
      videoBackup: videoBackupDefaults,
      points: pointDefaults,
      costs: costDefaults,
      generationQueue: generationQueueDefaults
    }, {
      providerLabels: DEFAULT_ADMIN_PROVIDER_LABELS,
      face: faceDefaults,
      faceBackup: faceBackupDefaults,
      analysis: analysisDefaults,
      analysisBackup: analysisBackupDefaults,
      image: imageDefaults,
      imageBackup: imageBackupDefaults,
      tencentFaceFusion: tencentFaceFusionDefaults,
      video: videoDefaults,
      videoBackup: videoBackupDefaults,
      points: pointDefaults,
      costs: costDefaults,
      generationQueue: generationQueueDefaults
    }),
    overrides: redactConfig(overrides, {
      providerLabels: DEFAULT_ADMIN_PROVIDER_LABELS,
      face: faceDefaults,
      faceBackup: faceBackupDefaults,
      analysis: analysisDefaults,
      analysisBackup: analysisBackupDefaults,
      image: imageDefaults,
      imageBackup: imageBackupDefaults,
      tencentFaceFusion: tencentFaceFusionDefaults,
      video: videoDefaults,
      videoBackup: videoBackupDefaults,
      points: pointDefaults,
      costs: costDefaults
    }),
    effective: redactConfig({
      providerLabels: configs.providerLabels,
      providerProfiles: overrides.providerProfiles,
      face: configs.face,
      faceBackup: configs.faceBackup,
      analysis: configs.analysis,
      analysisBackup: configs.analysisBackup,
      image: configs.image,
      imageBackup: configs.imageBackup,
      tencentFaceFusion: configs.tencentFaceFusion,
      video: configs.video,
      videoBackup: configs.videoBackup,
      points: configs.points,
      costs: configs.costs,
      generationQueue: configs.generationQueue
    }, {
      providerLabels: configs.providerLabels,
      face: configs.face,
      faceBackup: configs.faceBackup,
      analysis: configs.analysis,
      analysisBackup: configs.analysisBackup,
      image: configs.image,
      imageBackup: configs.imageBackup,
      tencentFaceFusion: configs.tencentFaceFusion,
      video: configs.video,
      videoBackup: configs.videoBackup,
      points: configs.points,
      costs: configs.costs,
      generationQueue: configs.generationQueue
    }),
    providerRegistry,
    activeProviders,
    activeBackups,
    // effective 是兼容旧顶层配置；目录消费者优先使用 providerRegistry。
    effectiveProviderRegistry: providerRegistry,
    effectiveActiveProviders: activeProviders,
    effectiveActiveBackups: activeBackups,
    updatedAt: metadata.updatedAt || "",
    version: Number(metadata.version || 0),
    admin: true
  };
}

async function getAdminStatus(context) {
  const openid = getOpenId(context);
  const isAdmin = isAdminContext(context);
  log("info", "admin.status", {
    isAdmin
  });
  return jsonResponse(true, {
    isAdmin,
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    // 不返回原始 OpenID，只返回可用于白名单匹配的不可逆识别码。
    identityHash: openid === "anonymous" ? "" : usageUserHash(openid)
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

async function getAdminImageApiKeys(context) {
  if (!isAdminContext(context)) return adminForbidden();
  const configs = await resolveEffectiveConfigs();
  const providerProfiles = syncAdminTopLevelProviderProfiles(
    configs,
    configs.runtime && configs.runtime.providerProfiles
  );
  const providerProfileKeys = {};
  ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
    const rows = {};
    Object.keys(providerProfiles[section] || {}).forEach((providerId) => {
      rows[providerId] = {
        apiKey: normalizeApiKey(
          providerProfiles[section][providerId]
          && providerProfiles[section][providerId].apiKey
        )
      };
    });
    providerProfileKeys[section] = sortAdminProviderObject(rows);
  });
  return jsonResponse(true, {
    face: {
      apiKey: String(configs.face && configs.face.apiKey || "")
    },
    faceBackup: {
      apiKey: String(configs.faceBackup && configs.faceBackup.apiKey || "")
    },
    analysis: {
      apiKey: String(configs.analysis && configs.analysis.apiKey || "")
    },
    analysisBackup: {
      apiKey: String(
        configs.analysisBackup
        && configs.analysisBackup.apiKey
        || ""
      )
    },
    image: {
      apiKey: String(configs.image && configs.image.apiKey || "")
    },
    imageBackup: {
      apiKey: String(
        configs.imageBackup
        && configs.imageBackup.apiKey
        || ""
      )
    },
    video: {
      apiKey: String(configs.video && configs.video.apiKey || "")
    },
    videoBackup: {
      apiKey: String(
        configs.videoBackup
        && configs.videoBackup.apiKey
        || ""
      )
    },
    providerProfiles: providerProfileKeys
  });
}

function providerMutationInput(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  const payload = isProviderObject(source.payload) ? source.payload : {};
  const raw = isProviderObject(source.provider)
    ? source.provider
    : isProviderObject(source.record)
      ? source.record
      : isProviderObject(source.providerConfig)
        ? source.providerConfig
        : isProviderObject(payload.provider)
          ? payload.provider
          : isProviderObject(source.config)
            ? source.config
            : source;
  const common = isProviderObject(raw.common)
    ? raw.common
    : isProviderObject(raw.commonConfig)
      ? raw.commonConfig
      : isProviderObject(payload.common)
        ? payload.common
        : {};
  const capabilitySource = isProviderObject(raw.capabilities)
    ? raw.capabilities
    : isProviderObject(raw.overrides)
      ? raw.overrides
      : {};
  const record = Object.assign({}, raw, common, {
    providerKey: raw.providerKey || source.providerKey || payload.providerKey,
    id: raw.id || raw.providerId || source.id || source.providerId || payload.id || payload.providerId,
    name: raw.name || raw.label || source.name || payload.name
  });
  record.overrides = Object.assign({}, capabilitySource);
  PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
    if (isProviderObject(raw[slot])) record.overrides[slot] = Object.assign({}, record.overrides[slot] || {}, raw[slot]);
    if (isProviderObject(payload[slot])) record.overrides[slot] = Object.assign({}, record.overrides[slot] || {}, payload[slot]);
  });
  // 编辑器也可能把能力作为槽位名数组提交；空能力不算已配置。
  if (Array.isArray(raw.capabilities)) {
    raw.capabilities.forEach((slot) => {
      if (PROVIDER_CAPABILITY_SLOTS.includes(slot) && !record.overrides[slot]) record.overrides[slot] = {};
    });
  }
  const operation = String(
    source.operation || source.mode || source.op || payload.operation || payload.mode || "upsert"
  ).trim().toLowerCase();
  const actionText = String(source.action || "").trim().toLowerCase();
  const deleting = ["delete", "remove", "del", "删除"].includes(operation)
    || actionText === "deleteadminprovider"
    || actionText === "removeadminprovider"
    || source.delete === true
    || source.remove === true
    || payload.delete === true
    || payload.remove === true;
  const activePatch = source.activeProviders || source.active || payload.activeProviders || payload.active;
  const activeBackupPatch = source.activeBackups || payload.activeBackups;
  return {
    record,
    operation: deleting ? "delete" : "upsert",
    expectedVersion: source.expectedVersion !== undefined
      ? source.expectedVersion
      : payload.expectedVersion !== undefined
        ? payload.expectedVersion
        : source.version,
    activeProviders: activePatch,
    activeBackups: activeBackupPatch,
    activeSlot: source.activeSlot || source.slot || payload.activeSlot || payload.slot,
    setActive: source.setActive !== undefined ? source.setActive : payload.setActive
  };
}

function providerError(message, code = "PROVIDER_INVALID") {
  const error = new Error(String(message || "服务商配置无效"));
  error.code = code;
  error.retryable = false;
  return error;
}

function validateProviderMutationRecord(value = {}) {
  const source = isProviderObject(value) ? value : {};
  const rawId = String(source.id || source.providerId || source.provider || "").trim();
  const rawName = String(source.name || source.label || source.displayName || "").trim();
  const id = providerText(rawId, 80);
  const name = providerText(rawName, 40);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) {
    throw providerError(
      "服务商 ID 只能包含字母、数字、点、下划线和短横线，长度不超过 64。",
      "PROVIDER_INVALID_ID"
    );
  }
  if (!name || name.length > 20) {
    throw providerError("服务商中文名必须是 1～20 个字符。", "PROVIDER_INVALID_NAME");
  }
  const aliases = Array.isArray(source.aliases) ? source.aliases : [];
  if (aliases.some((alias) => {
    const rawAlias = String(alias === undefined || alias === null ? "" : alias).trim();
    return rawAlias.length > 64 || !/^[A-Za-z0-9._-]{1,64}$/.test(rawAlias);
  })) {
    throw providerError("历史服务商 ID 格式不合法。", "PROVIDER_INVALID_ALIAS");
  }
  return { id, name };
}

function providerVersionConflict(expected, actual) {
  return providerError(
    `服务商配置版本冲突，请刷新后重试（期望 ${expected}，当前 ${actual}）。`,
    "ADMIN_CONFIG_CONFLICT"
  );
}

function providerRuntimeVersion(value) {
  const raw = value && typeof value === "object" ? value.version : value;
  return Math.max(0, Number(raw) || 0);
}

function providerActiveFallback(slot, deletedKey, registry, active) {
  const providers = registry.providers;
  // 备用槽位回退时 active[slot] 是仍在使用的主槽位档案；不能把
  // 备用重新指向同一档案，否则 resolver 会去重，实际不会发生备用调用。
  // 主槽位自身被删除时 active[slot] 通常等于 deletedKey，不额外排除。
  const activeKey = active && providerText(active[slot], 160);
  const excludedActiveKey = activeKey && activeKey !== deletedKey ? activeKey : "";
  const isExcluded = (key) => key === deletedKey || key === excludedActiveKey;
  const fallbackKey = PROVIDER_ID_FALLBACKS[slot];
  if (slot !== "video" && fallbackKey && !isExcluded(fallbackKey) && hasOwn(providers, fallbackKey)
      && providerConfigComplete(providers[fallbackKey], slot)) {
    return fallbackKey;
  }
  if (slot === "video") {
    const envVideo = resolveVideoConfig();
    const envProvider = providerText(envVideo.provider, 120);
    const envKey = providerRecordKeyFor(envProvider, registry);
    if (envVideo.configured && envKey && !isExcluded(envKey) && hasOwn(providers, envKey)
        && providerConfigComplete(providers[envKey], slot)) {
      return envKey;
    }
    if (envVideo.configured && envProvider && !isExcluded(envKey || envProvider)) {
      const envRecord = normalizeProviderRecord({
        providerKey: envKey || providerStableKey(envProvider),
        id: envProvider,
        name: providerDefaultName(envProvider),
        baseUrl: envVideo.baseUrl,
        apiKey: envVideo.apiKey,
        overrides: { video: Object.assign({}, envVideo, { enabled: true }) }
      }, envKey || envProvider, { includePreset: false });
      if (envRecord) {
        if (envKey && hasOwn(providers, envKey)) {
          providers[envKey] = mergeProviderRecord(providers[envKey], envRecord);
          providers[envKey].providerKey = envKey;
        } else {
          providers[envRecord.providerKey] = envRecord;
        }
        return envRecord.providerKey;
      }
    }
  }
  const complete = Object.keys(providers).find((key) => (
    !isExcluded(key)
    && providerConfigComplete(providers[key], slot)
  ));
  return complete || "";
}

function applyProviderActivePatch(active, patch, registry) {
  const result = Object.assign({}, active || {});
  if (isProviderObject(patch)) {
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      if (!hasOwn(patch, slot)) return;
      const key = providerRecordKeyFor(patch[slot], registry);
      result[slot] = key;
    });
  }
  return normalizeActiveProviders(result, registry);
}

function providerAdminPayload(runtime, autoRebound = {}, metadata = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  const registry = normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true });
  const activeProviders = normalizeActiveProviders(source.activeProviders, registry);
  const activeBackups = normalizeActiveBackups(source.activeBackups, registry);
  const projected = buildLegacyProjectionFromProviderRegistry(Object.assign({}, source, {
    providerRegistry: registry,
    activeProviders,
    activeBackups
  }));
  const configs = {
    face: resolveFaceConfig(projected.face),
    faceBackup: resolveFaceBackupConfig(projected.faceBackup, projected),
    analysis: resolveAnalysisConfig(projected.analysis),
    analysisBackup: resolveAnalysisBackupConfig(projected.analysisBackup, projected),
    image: resolveImageConfig(projected.image),
    imageBackup: resolveImageBackupConfig(projected.imageBackup),
    video: resolveVideoConfig(projected.video),
    videoBackup: resolveVideoBackupConfig(projected.videoBackup),
    points: resolvePointsConfig(projected.points),
    costs: resolveCostConfig(projected.costs, { imageProvider: projected.image && projected.image.provider }),
    generationQueue: generationQueueMonitor.normalizeQueueSettings(projected.generationQueue)
  };
  const view = adminConfigView(
    Object.assign({}, configs, {
      providerRegistry: registry,
      activeProviders,
      activeBackups,
      providerLabels: projected.providerLabels,
      providerProfiles: projected.providerProfiles
    }),
    projected,
    metadata
  );
  const reboundDetails = Array.isArray(autoRebound)
    ? autoRebound.reduce((output, item) => {
       if (!isProviderObject(item)
         || (!PROVIDER_CAPABILITY_SLOTS.includes(item.slot)
           && !PROVIDER_BACKUP_SLOTS.includes(item.slot))) return output;
      output[item.slot] = item;
      return output;
    }, {})
    : (isProviderObject(autoRebound) ? autoRebound : {});
  const reboundLabels = {
    face: "人脸识别",
    faceBackup: "人脸备用模型",
    analysis: "图片分析",
    analysisBackup: "分析备用模型",
    image: "生图主模型",
    imageBackup: "生图备用模型",
    video: "视频"
  };
  const reboundList = Object.keys(reboundDetails)
     .filter((slot) => PROVIDER_CAPABILITY_SLOTS.includes(slot)
       || PROVIDER_BACKUP_SLOTS.includes(slot))
    .map((slot) => {
      const item = isProviderObject(reboundDetails[slot]) ? reboundDetails[slot] : {};
      const from = providerText(item.from, 128);
      const to = providerText(item.to, 128);
      return {
        slot,
        from,
        to,
        label: `${reboundLabels[slot] || slot}：${from || "未配置"} → ${to || "未配置"}`
      };
    });
  const selectedKey = providerText(
    metadata.providerKey || metadata.deletedProviderKey || metadata.targetProviderKey,
    128
  );
  let provider = null;
  if (selectedKey && registry.providers[selectedKey]) {
    const redacted = providerClone(registry.providers[selectedKey]);
    if (redacted.metadata) redacted.metadata = redactProviderMetadata(redacted.metadata);
    redacted.apiKey = "";
    const selectedRecord = registry.providers[selectedKey];
    const selectedOverrides = selectedRecord.overrides || {};
    const selectedBuiltinRecord = Boolean(
      selectedRecord.builtIn
      || providerBuiltinKey(selectedRecord.providerKey || selectedRecord.id || selectedRecord.provider)
    );
    const selectedBackupOverrideHasKey = PROVIDER_BACKUP_SLOTS.some((slot) => {
      const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
      const override = selectedOverrides[slot] || selectedOverrides[baseSlot];
      return Boolean(
        override
        && override.overrideEnabled !== false
        && normalizeApiKey(override.apiKey)
      );
    });
    const selectedBackupEnvironmentHasKey = selectedBuiltinRecord
      && PROVIDER_BACKUP_SLOTS.some((slot) => {
        const envNames = slot === "faceBackup"
          ? ["AI_FACE_BACKUP_API_KEY", "AI_VISION_BACKUP_API_KEY"]
          : slot === "analysisBackup"
            ? ["AI_ANALYSIS_BACKUP_API_KEY", "AI_VISION_BACKUP_API_KEY"]
            : ["AI_VIDEO_BACKUP_API_KEY", "AI_VIDEO_API_KEY", "AI_VIDEO_KEY"];
        return Boolean(normalizeApiKey(firstEnv(envNames)));
      });
    redacted.apiKeyConfigured = Boolean(
      normalizeApiKey(selectedRecord.apiKey)
      || Object.keys(selectedOverrides).some((slot) => (
        selectedOverrides[slot]
        && selectedOverrides[slot].overrideEnabled !== false
        && normalizeApiKey(selectedOverrides[slot].apiKey)
      ))
      || selectedBackupOverrideHasKey
      || selectedBackupEnvironmentHasKey
      || PROVIDER_CAPABILITY_SLOTS.some((slot) => providerEnvironmentApiKey(selectedRecord, slot))
    );
    Object.keys(redacted.overrides || {}).forEach((slot) => {
      if (redacted.overrides[slot]) redacted.overrides[slot].apiKey = "";
    });
    provider = redacted;
  }
  return {
    providerRegistry: redactProviderRegistry(registry),
    activeProviders,
    activeBackups,
    effective: view.effective,
    version: providerRuntimeVersion(
      metadata.version !== undefined && metadata.version !== null
        ? metadata.version
        : source.version
    ),
    providerKey: selectedKey,
    provider,
    autoRebound: reboundList,
    autoReboundDetails: reboundDetails,
    effectiveProviderRegistry: view.effectiveProviderRegistry,
    effectiveActiveProviders: view.effectiveActiveProviders,
    effectiveActiveBackups: view.effectiveActiveBackups
  };
}

function providerSecretView(runtime, requested) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  const registry = normalizeProviderRegistry(source.providerRegistry, { includeDefaults: true });
  const keys = requested
    ? [providerRecordKeyFor(requested, registry)]
    : Object.keys(registry.providers);
  const result = {};
  keys.forEach((key) => {
    const record = registry.providers[key];
    if (!record) return;
    const slots = {};
    PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
      const override = record.overrides && record.overrides[slot] || {};
      const ownConnection = override.overrideEnabled !== false;
      const apiKey = ownConnection && override.clearApiKey
        ? ""
        : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey)
          || providerEnvironmentApiKey(record, slot);
      slots[slot] = { apiKey, configured: Boolean(apiKey) };
    });
    // 视觉/视频备用引用复用对应能力档案，但管理员密钥页需要显式
    // 展示备用槽位，且优先读取专用备用环境变量，避免把主 Key 状态误报。
    PROVIDER_BACKUP_SLOTS.forEach((slot) => {
      const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
      const override = record.overrides && record.overrides[baseSlot] || {};
      const ownConnection = override.overrideEnabled !== false;
      const dedicatedEnvNames = slot === "faceBackup"
        ? ["AI_FACE_BACKUP_API_KEY", "AI_VISION_BACKUP_API_KEY"]
        : slot === "analysisBackup"
          ? ["AI_ANALYSIS_BACKUP_API_KEY", "AI_VISION_BACKUP_API_KEY"]
          : ["AI_VIDEO_BACKUP_API_KEY", "AI_VIDEO_API_KEY", "AI_VIDEO_KEY"];
      const builtinRecord = Boolean(
        record.builtIn
        || providerBuiltinKey(record.providerKey || record.id || record.provider)
      );
      const apiKey = ownConnection && override.clearApiKey
        ? ""
        : normalizeApiKey((ownConnection && override.apiKey) || record.apiKey)
          || (builtinRecord ? normalizeApiKey(firstEnv(dedicatedEnvNames)) : "")
          || slots[baseSlot] && slots[baseSlot].apiKey
          || "";
      slots[slot] = { apiKey, configured: Boolean(apiKey), baseSlot };
    });
    const preferredSlots = PROVIDER_CAPABILITY_SLOTS.filter((slot) => (
      providerHasCapability(record, slot)
    ));
    const allSecretSlots = PROVIDER_CAPABILITY_SLOTS.concat(PROVIDER_BACKUP_SLOTS);
    const commonApiKey = normalizeApiKey(record.apiKey)
      // 公共 Key 为空时，能力覆盖中的真实 Key 也要回显到管理员明文面板；
      // backup 别名复用对应主槽位，但仍纳入遍历，避免只配备用能力时显示空。
      || allSecretSlots
        .map((slot) => slots[slot] && slots[slot].apiKey)
        .map((value) => normalizeApiKey(value))
        .find(Boolean)
      || preferredSlots
        .concat(PROVIDER_CAPABILITY_SLOTS.filter((slot) => !preferredSlots.includes(slot)))
        .map((slot) => providerEnvironmentApiKey(record, slot))
        .find(Boolean)
      || "";
    result[key] = {
      providerKey: key,
      id: record.id,
      name: record.name,
      apiKey: commonApiKey,
      apiKeyConfigured: Boolean(commonApiKey),
      slots
    };
  });
  return result;
}

async function saveAdminProvider(event = {}, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const mutation = providerMutationInput(event);
  const rawRecord = mutation.record || {};
  if (mutation.operation === "upsert") {
    try {
      validateProviderMutationRecord(rawRecord);
    } catch (error) {
      return fail(error.message, error.code || "PROVIDER_INVALID");
    }
  }
  const normalizedRecord = normalizeProviderRecord(rawRecord, rawRecord.providerKey || rawRecord.id, {
    includePreset: false
  });
  if (mutation.operation === "upsert" && !normalizedRecord) {
    return fail("服务商标识不能为空。", "PROVIDER_INVALID");
  }
  let outcome;
  try {
    outcome = await db.runTransaction(async (transaction) => {
      const ref = transaction
        .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
        .doc(ADMIN_RUNTIME_CONFIG_ID);
      const rawCurrent = await readDocument(ref);
      const migrated = migrateLegacyProviderRegistry(
        rawCurrent ? normalizeRuntimePatch(rawCurrent) : {},
        rawCurrent || {}
      );
      const current = migrated.value || {};
      const currentVersion = providerRuntimeVersion(rawCurrent || current);
      const expected = mutation.expectedVersion === undefined
        || mutation.expectedVersion === null
        || mutation.expectedVersion === ""
        ? null
        : Number(mutation.expectedVersion);
      if (expected !== null && Number.isFinite(expected) && expected !== currentVersion) {
        const conflict = providerVersionConflict(expected, currentVersion);
        conflict.currentVersion = currentVersion;
        throw conflict;
      }
      const registry = normalizeProviderRegistry(current.providerRegistry, { includeDefaults: true });
      let active = normalizeActiveProviders(current.activeProviders, registry);
      let activeBackups = normalizeActiveBackups(current.activeBackups, registry);
      const autoRebound = {};
      let changedProviderKey = "";
      let renamedFromId = "";
      let deletedProviderRecord = null;
      if (mutation.operation === "delete") {
        const targetKey = providerRecordKeyFor(
          rawRecord.providerKey || rawRecord.id || rawRecord.provider || event.providerKey || event.id,
          registry
        );
        const target = registry.providers[targetKey];
        if (!target) throw providerError("找不到要删除的服务商。", "PROVIDER_NOT_FOUND");
        if (
          target.builtIn
          || target.protected
          || target.migrated
          || BUILTIN_PROVIDER_KEYS.includes(targetKey)
        ) {
          throw providerError("内置服务商不能删除。", "PROVIDER_BUILTIN_PROTECTED");
        }
        deletedProviderRecord = providerClone(target);
        changedProviderKey = targetKey;
        delete registry.providers[targetKey];
        PROVIDER_CAPABILITY_SLOTS.forEach((slot) => {
          if (active[slot] !== targetKey) return;
          const rebound = providerActiveFallback(slot, targetKey, registry, active);
          autoRebound[slot] = { from: targetKey, to: rebound };
          active[slot] = rebound;
        });
        PROVIDER_BACKUP_SLOTS.forEach((slot) => {
          if (activeBackups[slot] !== targetKey) return;
          const baseSlot = PROVIDER_BACKUP_BASE_SLOTS[slot];
          const rebound = providerActiveFallback(baseSlot, targetKey, registry, active);
          autoRebound[slot] = { from: targetKey, to: rebound };
          activeBackups[slot] = rebound;
        });
      } else {
        let targetKey = providerRecordKeyFor(
          normalizedRecord.providerKey || normalizedRecord.id,
          registry
        );
        const duplicateKey = Object.keys(registry.providers).find((key) => (
          key !== targetKey
          && String(registry.providers[key].id || "").toLowerCase() === String(normalizedRecord.id || "").toLowerCase()
        ));
        if (duplicateKey) {
          throw providerError("服务商 ID 已存在（不区分大小写）。", "PROVIDER_DUPLICATE_ID");
        }
        const matchedById = Object.keys(registry.providers).find((key) => (
          String(registry.providers[key].id || "").toLowerCase() === String(normalizedRecord.id || "").toLowerCase()
          || (registry.providers[key].aliases || []).some((alias) => String(alias).toLowerCase() === String(normalizedRecord.id || "").toLowerCase())
        ));
        if (!hasOwn(registry.providers, targetKey) && matchedById) targetKey = matchedById;
        if (hasOwn(registry.providers, targetKey)) {
          const existing = registry.providers[targetKey];
          const merged = mergeProviderRecord(existing, normalizedRecord);
          if (existing.id && String(existing.id).toLowerCase() !== String(merged.id).toLowerCase()) {
            renamedFromId = existing.id;
            merged.aliases = Array.from(new Set([].concat(merged.aliases || [], existing.id)));
          }
          merged.providerKey = targetKey;
          merged.builtIn = Boolean(existing.builtIn || BUILTIN_PROVIDER_KEYS.includes(targetKey));
          registry.providers[targetKey] = merged;
        } else {
          targetKey = normalizedRecord.providerKey || providerStableKey(normalizedRecord.id);
          normalizedRecord.providerKey = targetKey;
          if (!normalizedRecord.builtIn && !PROVIDER_CAPABILITY_SLOTS.some((slot) => providerHasCapability(normalizedRecord, slot))) {
            throw providerError("自定义服务商至少要配置一项能力。", "PROVIDER_CAPABILITY_REQUIRED");
          }
          registry.providers[targetKey] = normalizedRecord;
        }
        changedProviderKey = targetKey;
        const savedRecord = registry.providers[targetKey];
        if (!savedRecord || !PROVIDER_CAPABILITY_SLOTS.some((slot) => (
          providerConfigComplete(savedRecord, slot)
        ))) {
          throw providerError("服务商至少要配置一项完整能力（地址、模型和 Key）。", "PROVIDER_CAPABILITY_REQUIRED");
        }
        if (mutation.activeProviders) active = applyProviderActivePatch(active, mutation.activeProviders, registry);
        if (mutation.activeBackups) {
          activeBackups = Object.assign(
            {},
            activeBackups,
            normalizeActiveBackups(mutation.activeBackups, registry, { includeEmpty: false })
          );
        }
        if (mutation.activeSlot && mutation.setActive !== false) {
          const slot = String(mutation.activeSlot);
          if (PROVIDER_CAPABILITY_SLOTS.includes(slot)) active[slot] = targetKey;
        }
      }
      let projectionInput = Object.assign({}, current, {
        providerRegistry: registry,
        activeProviders: active,
        activeBackups
      });
      if (deletedProviderRecord) {
        const reboundImageKey = autoRebound.image && autoRebound.image.to;
        const reboundImage = reboundImageKey && registry.providers[reboundImageKey];
        projectionInput = removeProviderExternalIdReferences(
          projectionInput,
          deletedProviderRecord,
          { replacementImageProvider: reboundImage && reboundImage.id }
        );
      }
      const projected = buildLegacyProjectionFromProviderRegistry(projectionInput);
      if (renamedFromId && changedProviderKey && registry.providers[changedProviderKey]) {
        const renamed = migrateProviderExternalIdReferences(
          projected,
          renamedFromId,
          registry.providers[changedProviderKey].id
        );
        Object.assign(projected, renamed);
      }
      const nextVersion = currentVersion + 1;
      registry.version = nextVersion;
      projected.providerRegistry = registry;
      projected.activeProviders = active;
      projected.activeBackups = activeBackups;
      projected.version = nextVersion;
      projected.updatedAt = new Date();
      projected.updatedBy = getOpenId(context);
      await ref.set({ data: stripDocumentId(projected) });
      return {
        previous: current,
        runtime: projected,
        autoRebound,
        version: nextVersion,
        providerKey: changedProviderKey
      };
    }, 5);
  } catch (error) {
    if (["PROVIDER_VERSION_CONFLICT", "ADMIN_CONFIG_CONFLICT"].includes(String(error && error.code || ""))) {
      return fail(error.message, "ADMIN_CONFIG_CONFLICT", {
        versionConflict: true,
        currentVersion: error && error.currentVersion
      });
    }
    if (String(error && error.code || "").startsWith("PROVIDER_")) {
      return fail(error.message, error.code);
    }
    throw error;
  }
  adminRuntimeCache = { value: outcome.runtime, expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS };
  await writeAdminConfigAuditLog({
    source: mutation.operation === "delete" ? "admin-provider-delete" : "admin-provider-save",
    openid: getOpenId(context),
    configVersion: outcome.version,
    previous: outcome.previous || {},
    next: outcome.runtime,
    patch: {
      providerKey: outcome.providerKey,
      operation: mutation.operation,
      provider: normalizedRecord || rawRecord,
      autoRebound: outcome.autoRebound
    }
  });
  const payload = providerAdminPayload(outcome.runtime, outcome.autoRebound, {
    version: outcome.version,
    providerKey: outcome.providerKey,
    deletedProviderKey: mutation.operation === "delete" ? outcome.providerKey : "",
    updatedAt: outcome.runtime.updatedAt
  });
  return jsonResponse(true, payload);
}

async function getAdminProviderSecrets(event = {}, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const runtime = await loadAdminRuntimeConfig(true, { cache: false });
  const migrated = migrateLegacyProviderRegistry(runtime || {}, runtime || {});
  const registry = normalizeProviderRegistry(migrated.value && migrated.value.providerRegistry, { includeDefaults: true });
  const requested = event && (event.providerKey || event.id || event.provider);
  // 密钥接口只服务于当前管理员编辑器，必须明确指定单个档案；
  // 不允许通过省略参数一次性拉取整个目录的明文 Key。
  if (!requested) return fail("请选择要编辑的服务商档案。", "PROVIDER_INVALID");
  const requestedKey = providerRecordKeyFor(requested, registry);
  if (!requestedKey || !hasOwn(registry.providers, requestedKey)) {
    return fail("找不到要读取的服务商档案。", "PROVIDER_NOT_FOUND");
  }
  const secrets = providerSecretView(migrated.value, requested);
  const firstKey = Object.keys(secrets)[0] || "";
  const selected = firstKey ? secrets[firstKey] : null;
  const capabilities = {};
  if (selected) {
      PROVIDER_CAPABILITY_SLOTS.concat(PROVIDER_BACKUP_SLOTS).forEach((slot) => {
        const item = selected.slots && selected.slots[slot] || {};
        capabilities[slot] = {
        apiKey: String(item.apiKey || ""),
        apiKeyConfigured: Boolean(item.configured)
      };
    });
  }
  return jsonResponse(true, {
    providerKey: firstKey,
    secrets,
    providers: secrets,
    providerSecrets: secrets,
    common: selected ? {
      apiKey: String(selected.apiKey || ""),
      apiKeyConfigured: Boolean(selected.apiKeyConfigured)
    } : {},
    capabilities,
    apiKey: selected ? String(selected.apiKey || "") : "",
    apiKeyConfigured: Boolean(selected && selected.apiKeyConfigured),
    version: providerRuntimeVersion(runtime)
  });
}

function adminConfigAuditDisplay(value) {
  const row = normalizeAdminConfigAuditRow(value);
  return {
    _id: row._id,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : String(row.createdAt || ""),
    source: row.source,
    actorHash: row.actorHash,
    configVersion: row.configVersion,
    changeCount: row.changeCount,
    changedSections: row.changedSections,
    changes: row.changes
  };
}

async function getAdminConfigAuditLogs(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const limit = Math.max(
    1,
    Math.min(
      ADMIN_CONFIG_AUDIT_MAX_READ,
      Number(event && event.limit) || 20
    )
  );
  try {
    const rows = process.env.WECHAT_MINIAPP_TEST === "1"
      ? adminConfigAuditTestRows
          .slice()
          .sort((left, right) => (
            new Date(right.createdAt || 0).getTime()
            - new Date(left.createdAt || 0).getTime()
          ))
          .slice(0, limit)
      : (
        await db
          .collection(ADMIN_CONFIG_AUDIT_LOG_COLLECTION)
          .orderBy("createdAt", "desc")
          .limit(limit)
          .get()
      ).data || [];
    return jsonResponse(true, {
      logs: rows.map(adminConfigAuditDisplay),
      limit,
      unavailable: false,
      message: ""
    });
  } catch (error) {
    log("warn", "admin.config-audit.read-failed", {
      error: error && error.message
    });
    return jsonResponse(true, {
      logs: [],
      limit,
      unavailable: true,
      message: "配置修改记录暂时读取失败。"
    });
  }
}

function operationRows(result) {
  return result && Array.isArray(result.data) ? result.data : [];
}

async function countGenerationOperations(where = {}, store = db) {
  let query = store.collection(GENERATION_OPERATION_COLLECTION);
  if (where && Object.keys(where).length) query = query.where(where);
  if (typeof query.count === "function") {
    const result = await query.count();
    return Math.max(0, Number(result && result.total) || 0);
  }
  const result = await query.limit(100).get();
  return operationRows(result).length;
}

async function loadRecentGenerationOperations(limit = 20, store = db) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  try {
    const result = await store
      .collection(GENERATION_OPERATION_COLLECTION)
      .orderBy("updatedAt", "desc")
      .limit(safeLimit)
      .get();
    return operationRows(result);
  } catch (error) {
    if (isCollectionMissingError(error)) throw error;
    const batches = await Promise.all(
      GENERATION_OPERATION_STATUSES.map(async (status) => {
        try {
          const result = await store
            .collection(GENERATION_OPERATION_COLLECTION)
            .where({ status })
            .limit(safeLimit)
            .get();
          return operationRows(result);
        } catch (queryError) {
          if (isCollectionMissingError(queryError)) throw queryError;
          return [];
        }
      })
    );
    const unique = new Map();
    batches.flat().forEach((operation) => {
      if (!operation) return;
      unique.set(
        String(operation._id || `${operation.openid || ""}:${operation.requestId || ""}`),
        operation
      );
    });
    return [...unique.values()]
      .sort((left, right) => operationUpdatedAtMs(right) - operationUpdatedAtMs(left))
      .slice(0, safeLimit);
  }
}

async function loadGenerationOperationCleanupCandidates(options = {}) {
  const store = options.store || db;
  const cutoff = options.cutoff instanceof Date
    ? options.cutoff
    : generationOperationRetention.retentionCutoff(
        options.now,
        options
      );
  const settings = generationOperationRetention.normalizeRetentionSettings(
    options
  );
  const command = store.command || db.command;
  const statuses = generationOperationRetention.TERMINAL_STATUSES;
  const queryLimit = Math.max(
    settings.batchSize,
    Math.min(100, settings.batchSize * 2)
  );

  const batches = await Promise.all(statuses.map(async (status) => {
    const collection = store.collection(GENERATION_OPERATION_COLLECTION);
    try {
      const result = await collection
        .where({
          status,
          updatedAt: command.lte(cutoff)
        })
        .orderBy("updatedAt", "asc")
        .limit(queryLimit)
        .get();
      return operationRows(result);
    } catch (error) {
      if (isCollectionMissingError(error)) throw error;
      const fallback = await collection
        .where({ status })
        .limit(queryLimit)
        .get();
      return operationRows(fallback).filter((operation) => (
        generationOperationRetention.operationRetentionDecision(operation, {
          cutoff,
          settings
        }).eligible
      ));
    }
  }));

  const unique = new Map();
  batches.flat().forEach((operation) => {
    if (!operation) return;
    const id = String(operation._id || operation.id || "");
    if (id && !unique.has(id)) unique.set(id, operation);
  });
  return [...unique.values()]
    .sort((left, right) => (
      operationUpdatedAtMs(left) - operationUpdatedAtMs(right)
    ))
    .slice(0, settings.batchSize);
}

async function readGenerationOperationForCleanup(operationId, store = db) {
  const id = String(operationId || "").trim().slice(0, 180);
  if (!id) return null;
  return readDocument(
    store.collection(GENERATION_OPERATION_COLLECTION).doc(id)
  );
}

async function removeGenerationOperationForCleanup(operationId, store = db) {
  const id = String(operationId || "").trim().slice(0, 180);
  if (!id) {
    const error = new Error("旧任务清理缺少任务记录编号。");
    error.code = "generation-history-cleanup-id-missing";
    throw error;
  }
  return store.collection(GENERATION_OPERATION_COLLECTION).doc(id).remove();
}

async function loadOldestQueuedGenerationOperation(store = db) {
  const collection = store.collection(GENERATION_OPERATION_COLLECTION);
  try {
    const result = await collection
      .where({ status: "queued" })
      .orderBy("queuedAt", "asc")
      .limit(1)
      .get();
    return operationRows(result)[0] || null;
  } catch (error) {
    if (isCollectionMissingError(error)) throw error;
    try {
      const result = await collection
        .where({ status: "queued" })
        .orderBy("createdAt", "asc")
        .limit(1)
        .get();
      return operationRows(result)[0] || null;
    } catch (fallbackError) {
      if (isCollectionMissingError(fallbackError)) throw fallbackError;
      const result = await collection
        .where({ status: "queued" })
        .limit(50)
        .get();
      return operationRows(result)
        .sort((left, right) => operationUpdatedAtMs(left) - operationUpdatedAtMs(right))[0]
        || null;
    }
  }
}

async function loadGenerationQueueOverview(options = {}) {
  const store = options.store || db;
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now());
  const settings = generationQueueMonitor.normalizeQueueSettings(
    options.settings
    || (await resolveEffectiveConfigs()).generationQueue
  );
  const includeTasks = options.includeTasks !== false;
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  try {
    const [statusCounts, imageCount, videoCount, oldestQueued, recent] = await Promise.all([
      Promise.all(GENERATION_OPERATION_STATUSES.map(
        (status) => countGenerationOperations({ status }, store)
      )),
      countGenerationOperations({ kind: "image" }, store),
      countGenerationOperations({ kind: "video" }, store),
      loadOldestQueuedGenerationOperation(store),
      includeTasks ? loadRecentGenerationOperations(limit, store) : Promise.resolve([])
    ]);
    const counts = {};
    GENERATION_OPERATION_STATUSES.forEach((status, index) => {
      counts[status] = Math.max(0, Number(statusCounts[index]) || 0);
    });
    const queuedCount = counts.queued;
    const oldestQueuedAtMs = operationUpdatedAtMs(
      oldestQueued && Object.assign({}, oldestQueued, {
        lastHeartbeatAt: oldestQueued.queuedAt
          || oldestQueued.createdAt
          || oldestQueued.updatedAt
      })
    );
    const snapshot = Object.assign(
      generationQueueMonitor.buildQueueSnapshot([], { now, settings }),
      {
        total: GENERATION_OPERATION_STATUSES.reduce(
          (total, status) => total + counts[status],
          0
        ),
        counts,
        kinds: {
          image: Math.max(0, Number(imageCount) || 0),
          video: Math.max(0, Number(videoCount) || 0)
        },
        queuedCount,
        processingCount: counts.processing,
        pendingRefundCount: counts.failed + counts.refunding,
        oldestQueuedAt: oldestQueuedAtMs
          ? new Date(oldestQueuedAtMs).toISOString()
          : "",
        oldestQueuedAgeSeconds: oldestQueuedAtMs
          ? Math.max(0, Math.floor((now.getTime() - oldestQueuedAtMs) / 1000))
          : 0,
        alertActive: queuedCount >= settings.alertThreshold
      }
    );
    return {
      snapshot,
      tasks: recent.map((operation) => generationQueueMonitor.buildAdminOperationSummary(
        Object.assign({}, operation, {
          userHash: operation.openid ? usageUserHash(operation.openid) : ""
        }),
        { now }
      )),
      unavailable: false,
      message: ""
    };
  } catch (error) {
    if (!isCollectionMissingError(error)) throw error;
    return {
      snapshot: generationQueueMonitor.buildQueueSnapshot([], { now, settings }),
      tasks: [],
      unavailable: true,
      message: "任务集合还没有初始化，部署后先执行数据库初始化。"
    };
  }
}

async function findAdminGenerationOperation(event = {}, store = db) {
  const operationId = String(
    event.operationId
    || event.id
    || event.payload && event.payload.operationId
    || ""
  ).trim().slice(0, 180);
  if (operationId) {
    return readDocument(
      store.collection(GENERATION_OPERATION_COLLECTION).doc(operationId)
    );
  }
  const requestId = String(
    event.requestId
    || event.payload && event.payload.requestId
    || ""
  ).trim().slice(0, 120);
  if (!requestId) return null;
  const result = await store
    .collection(GENERATION_OPERATION_COLLECTION)
    .where({ requestId })
    .limit(2)
    .get();
  return operationRows(result)[0] || null;
}

async function getAdminGenerationQueue(event = {}, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const overview = await loadGenerationQueueOverview({
    limit: event.limit
  });
  return jsonResponse(true, overview);
}

const generationOperationRetentionService = (
  generationOperationRetention.createGenerationOperationRetentionService({
    listCandidates: (options) => (
      loadGenerationOperationCleanupCandidates(Object.assign({}, options, {
        store: db
      }))
    ),
    readOperation: (operationId) => (
      readGenerationOperationForCleanup(operationId, db)
    ),
    removeOperation: (operationId) => (
      removeGenerationOperationForCleanup(operationId, db)
    ),
    log,
    now: () => new Date()
  })
);

async function cleanupGenerationOperationHistory(event = {}, context = {}) {
  const triggerName = timerTriggerName(event);
  const timerCall = triggerName === "generation-operation-history-cleanup";
  if (!timerCall && !isAdminContext(context)) return adminForbidden();
  const settings = generationOperationRetention.normalizeRetentionSettings({
    retentionDays: event.retentionDays,
    batchSize: event.batchSize
  });
  try {
    const result = await generationOperationRetentionService.cleanup({
      source: timerCall ? "timer" : "admin",
      retentionDays: settings.retentionDays,
      batchSize: settings.batchSize
    });
    return jsonResponse(true, result);
  } catch (error) {
    if (!isCollectionMissingError(error)) throw error;
    return jsonResponse(true, generationOperationRetention.sanitizeCleanupSummary({
      source: timerCall ? "timer" : "admin",
      retentionDays: settings.retentionDays,
      batchSize: settings.batchSize,
      cutoffAt: generationOperationRetention.retentionCutoff(
        new Date(),
        settings
      ),
      unavailable: true,
      message: "任务集合还没有初始化，本次没有清理记录。"
    }));
  }
}

async function getAdminGenerationOperationHistory(event = {}, context) {
  if (!isAdminContext(context)) return adminForbidden();
  try {
    const operation = await findAdminGenerationOperation(event);
    if (!operation) {
      return fail("没有找到这个任务。", "GENERATION_OPERATION_NOT_FOUND");
    }
    return jsonResponse(
      true,
      generationQueueMonitor.buildAdminOperationHistory(
        Object.assign({}, operation, {
          userHash: operation.openid ? usageUserHash(operation.openid) : ""
        }),
        { now: new Date() }
      )
    );
  } catch (error) {
    if (isCollectionMissingError(error)) {
      return fail(
        "任务集合还没有初始化。",
        "GENERATION_OPERATION_COLLECTION_MISSING"
      );
    }
    throw error;
  }
}

async function persistGenerationQueueAlertState(state) {
  const safeState = state && typeof state === "object"
    ? {
        active: Boolean(state.active),
        signature: String(state.signature || "").slice(0, 160),
        lastAlertAt: state.lastAlertAt || "",
        lastRecoveredAt: state.lastRecoveredAt || ""
      }
    : {};
  await db
    .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
    .doc(ADMIN_RUNTIME_CONFIG_ID)
    .update({
      data: {
        generationQueueAlertState: safeState
      }
    });
  if (adminRuntimeCache.value) {
    adminRuntimeCache = {
      value: Object.assign({}, adminRuntimeCache.value, {
        generationQueueAlertState: safeState
      }),
      expiresAt: adminRuntimeCache.expiresAt
    };
  }
  return safeState;
}

async function observeGenerationQueue(options = {}) {
  try {
    const runtime = await loadAdminRuntimeConfig();
    const settings = generationQueueMonitor.normalizeQueueSettings(
      options.settings || runtime && runtime.generationQueue
    );
    const overview = await loadGenerationQueueOverview({
      includeTasks: false,
      settings,
      now: options.now
    });
    if (overview.unavailable) return overview;
    const decision = generationQueueMonitor.decideQueueAlert(
      overview.snapshot,
      runtime && runtime.generationQueueAlertState,
      { now: options.now }
    );
    if (decision.shouldLog) {
      const eventName = decision.action === "recovered"
        ? "generation.queue-backlog-recovered"
        : "generation.queue-backlog-alert";
      log(decision.action === "recovered" ? "info" : "warn", eventName, {
        queuedCount: overview.snapshot.queuedCount,
        processingCount: overview.snapshot.processingCount,
        oldestQueuedAgeSeconds: overview.snapshot.oldestQueuedAgeSeconds,
        workerConcurrency: overview.snapshot.workerConcurrency,
        alertThreshold: overview.snapshot.alertThreshold
      });
      try {
        await persistGenerationQueueAlertState(decision.nextState);
      } catch (stateError) {
        log("warn", "generation.queue-alert-state-write-failed", {
          action: decision.action,
          error: sanitizeFailureMessage(stateError && stateError.message)
        });
      }
    }
    return Object.assign({}, overview, {
      alertDecision: decision.action
    });
  } catch (error) {
    log("warn", "generation.queue-observe-failed", {
      error: sanitizeFailureMessage(error && error.message)
    });
    return {
      unavailable: true,
      message: "队列状态读取失败。",
      errorCode: String(error && error.code || "generation-queue-observe-failed")
    };
  }
}

function isCollectionMissingError(error) {
  const code = String(
    error && (
      error.code
      || error.errCode
      || error.errorCode
    ) || ""
  );
  const message = String(
    error && (
      error.message
      || error.errMsg
    ) || error || ""
  );
  return code === "-502005"
    || /DATABASE_COLLECTION_NOT_EXIST|TCB_DB_COLLECTION_NOT_EXISTS/i.test(code)
    || /database collection not exists?|collection not exists?/i.test(message);
}

async function probeDatabaseCollection(store, collectionName) {
  await store.collection(collectionName).limit(1).get();
}

async function ensureDatabaseCollection(store, collectionName) {
  try {
    await probeDatabaseCollection(store, collectionName);
    return { collection: collectionName, status: "existing" };
  } catch (error) {
    if (!isCollectionMissingError(error)) throw error;
  }

  try {
    const result = await store.createCollection(collectionName);
    return {
      collection: collectionName,
      status: "created",
      requestId: result && result.requestId ? String(result.requestId) : ""
    };
  } catch (createError) {
    // 两个初始化请求撞在一起时，另一个请求可能已经创建完成。
    try {
      await probeDatabaseCollection(store, collectionName);
      return { collection: collectionName, status: "existing" };
    } catch (_) {
      throw createError;
    }
  }
}

async function initializeDatabaseCollections(
  store = db,
  collectionNames = REQUIRED_DATABASE_COLLECTIONS
) {
  const results = await Promise.all(collectionNames.map(async (collectionName) => {
    try {
      return await ensureDatabaseCollection(store, collectionName);
    } catch (error) {
      return {
        collection: collectionName,
        status: "failed",
        errorCode: String(
          error && (
            error.code
            || error.errCode
            || error.errorCode
          ) || "DATABASE_COLLECTION_INIT_FAILED"
        ),
        message: String(
          error && (
            error.message
            || error.errMsg
          ) || error || "集合初始化失败"
        )
      };
    }
  }));
  const created = results.filter((item) => item.status === "created").length;
  const existing = results.filter((item) => item.status === "existing").length;
  const failed = results.filter((item) => item.status === "failed").length;
  return {
    total: results.length,
    created,
    existing,
    failed,
    results
  };
}

async function initializeDatabase(context) {
  if (!isAdminContext(context)) return adminForbidden();
  const summary = await initializeDatabaseCollections(db);
  const payload = Object.assign({
    environment: env("CLOUDBASE_ENV_ID", ""),
    buildVersion: API_BUILD_VERSION
  }, summary);
  log(summary.failed ? "error" : "info", "admin.database.initialize", {
    initializedBy: getOpenId(context),
    total: summary.total,
    created: summary.created,
    existing: summary.existing,
    failed: summary.failed
  });
  if (summary.failed) {
    return fail(
      `有 ${summary.failed} 个数据库集合初始化失败。`,
      "DATABASE_INIT_FAILED",
      payload
    );
  }
  return jsonResponse(true, payload);
}

function dropBlankRuntimeApiKeys(patch = {}) {
  ["face", "faceBackup", "analysis", "analysisBackup", "image", "imageBackup", "video", "videoBackup"].forEach((section) => {
    if (
      patch[section]
      && hasOwn(patch[section], "apiKey")
      && !normalizeApiKey(patch[section].apiKey)
    ) {
      delete patch[section].apiKey;
    }
  });
  if (patch.tencentFaceFusion && typeof patch.tencentFaceFusion === "object") {
    ["secretId", "secretKey"].forEach((key) => {
      if (
        hasOwn(patch.tencentFaceFusion, key)
        && !String(patch.tencentFaceFusion[key] || "").trim()
      ) {
        delete patch.tencentFaceFusion[key];
      }
    });
  }
  if (isAdminProviderObject(patch.providerProfiles)) {
    ADMIN_PROVIDER_PROFILE_SECTIONS.forEach((section) => {
      const profiles = patch.providerProfiles[section];
      if (!isAdminProviderObject(profiles)) return;
      Object.keys(profiles).forEach((providerId) => {
        const profile = profiles[providerId];
        if (
          isAdminProviderObject(profile)
          && hasOwn(profile, "apiKey")
        ) {
          if (
            section === "video"
            || !normalizeApiKey(profile.apiKey)
          ) {
            delete profile.apiKey;
          }
        }
      });
    });
  }
  if (patch.video && hasOwn(patch.video, "apiKey")) {
    delete patch.video.apiKey;
  }
  if (patch.videoBackup && hasOwn(patch.videoBackup, "apiKey")) {
    delete patch.videoBackup.apiKey;
  }
  return patch;
}

async function saveAdminConfig(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const requestConfig = event && event.config && typeof event.config === "object"
    ? event.config
    : {};
  const rawConfig = requestConfig;
  const expectedVersionRaw = event && event.expectedVersion !== undefined
    ? event.expectedVersion
    : requestConfig.expectedVersion;
  const rawProviderLabelErrors = hasOwn(rawConfig, "providerLabels")
    ? validateAdminProviderLabels(rawConfig.providerLabels, {})
    : [];
  if (rawProviderLabelErrors.length) {
    return fail(
      rawProviderLabelErrors.join("；"),
      "ADMIN_PROVIDER_LABEL_REQUIRED",
      { fields: rawProviderLabelErrors }
    );
  }
  const patch = dropBlankRuntimeApiKeys(
    normalizeRuntimePatch(rawConfig)
  );
  if (hasOwn(patch.image, "retryEnabled")) {
    patch.image.retryPreferenceVersion = IMAGE_RETRY_PREFERENCE_VERSION;
  }
  if (hasOwn(patch.imageBackup, "retryEnabled")) {
    patch.imageBackup.retryPreferenceVersion = IMAGE_RETRY_PREFERENCE_VERSION;
  }
  ["image", "imageBackup"].forEach((section) => {
    const profiles = patch.providerProfiles && patch.providerProfiles[section];
    if (!isAdminProviderObject(profiles)) return;
    Object.keys(profiles).forEach((providerId) => {
      if (hasOwn(profiles[providerId], "retryEnabled")) {
        profiles[providerId].retryPreferenceVersion = IMAGE_RETRY_PREFERENCE_VERSION;
      }
    });
  });
  const errors = validateRuntimePatch(patch);
  if (errors.length) return fail(errors.join("；"), "ADMIN_CONFIG_INVALID", { fields: errors });
  const expectedVersion = expectedVersionRaw === undefined
    || expectedVersionRaw === null
    || expectedVersionRaw === ""
    ? null
    : Number(expectedVersionRaw);
  let current = null;
  let next = null;
  let providerGuard = { corrected: false };
  let data = null;
  try {
    data = await db.runTransaction(async (transaction) => {
      const ref = transaction
        .collection(ADMIN_RUNTIME_CONFIG_COLLECTION)
        .doc(ADMIN_RUNTIME_CONFIG_ID);
      const rawCurrent = await readDocument(ref);
      current = rawCurrent
        ? migrateLegacyProviderRegistry(normalizeRuntimePatch(rawCurrent), rawCurrent).value
        : null;
      const previousVersion = Number(rawCurrent && rawCurrent.version) || 0;
      if (expectedVersion !== null && Number.isFinite(expectedVersion)
          && expectedVersion !== previousVersion) {
        const conflict = providerVersionConflict(expectedVersion, previousVersion);
        conflict.currentVersion = previousVersion;
        throw conflict;
      }
      next = mergeRuntimeConfig(current, patch);
      providerGuard = guardAdminImageProviderConfig(current, next, patch);
      next = providerGuard.value;
      next.providerLabels = normalizeAdminProviderLabels(
        next.providerLabels,
        { includeDefaults: true }
      );
      next.providerProfiles = syncAdminTopLevelProviderProfiles(
        next,
        next.providerProfiles
      );
      const providerLabelErrors = validateAdminProviderLabels(
        next.providerLabels,
        next
      );
      if (providerLabelErrors.length) {
        const error = providerError(
          providerLabelErrors.join("；"),
          "ADMIN_PROVIDER_LABEL_REQUIRED"
        );
        error.fields = providerLabelErrors;
        throw error;
      }
      const mergedErrors = validateRuntimePatch(next);
      if (mergedErrors.length) {
        const error = providerError(
          mergedErrors.join("；"),
          "ADMIN_CONFIG_INVALID"
        );
        error.fields = mergedErrors;
        throw error;
      }
      const canonicalRegistry = normalizeProviderRegistry(
        next.providerRegistry,
        { includeDefaults: true }
      );
      data = {
        _id: ADMIN_RUNTIME_CONFIG_ID,
        providerRegistry: canonicalRegistry,
        activeProviders: normalizeActiveProviders(next.activeProviders, canonicalRegistry),
        activeBackups: normalizeActiveBackups(next.activeBackups, canonicalRegistry),
        providerLabels: next.providerLabels || {},
        providerProfiles: next.providerProfiles || {},
        face: next.face,
        faceBackup: next.faceBackup,
        analysis: next.analysis,
        analysisBackup: next.analysisBackup,
        image: next.image,
        imageBackup: next.imageBackup,
        tencentFaceFusion: next.tencentFaceFusion,
        video: next.video,
        videoBackup: next.videoBackup,
        points: next.points,
        costs: next.costs,
        generationQueue: next.generationQueue,
        generationQueueAlertState: rawCurrent
          && rawCurrent.generationQueueAlertState
          && typeof rawCurrent.generationQueueAlertState === "object"
          ? rawCurrent.generationQueueAlertState
          : {},
        version: previousVersion + 1,
        updatedAt: new Date(),
        updatedBy: getOpenId(context)
      };
      await ref.set({ data: stripDocumentId(data) });
      return data;
    }, 5);
  } catch (error) {
    if (["ADMIN_CONFIG_CONFLICT", "PROVIDER_VERSION_CONFLICT"].includes(String(error && error.code || ""))) {
      return fail(error.message, "ADMIN_CONFIG_CONFLICT", {
        versionConflict: true,
        currentVersion: error && error.currentVersion
      });
    }
    if (["ADMIN_PROVIDER_LABEL_REQUIRED", "ADMIN_CONFIG_INVALID"].includes(String(error && error.code || ""))) {
      return fail(error.message, error.code, { fields: error.fields || [] });
    }
    throw error;
  }
  if (!data) return fail("管理员配置保存失败。", "ADMIN_CONFIG_SAVE_FAILED");
  current = current || {};
  next = next || data;
  await writeAdminConfigAuditLog({
    source: "admin-save",
    openid: getOpenId(context),
    configVersion: data.version,
    previous: current || {},
    next: data,
    patch
  });
  adminRuntimeCache = {
    value: {
      providerRegistry: data.providerRegistry,
      activeProviders: data.activeProviders,
      activeBackups: data.activeBackups,
      providerLabels: data.providerLabels,
      providerProfiles: data.providerProfiles,
      face: next.face,
      faceBackup: next.faceBackup,
      analysis: next.analysis,
      analysisBackup: next.analysisBackup,
      image: next.image,
      imageBackup: next.imageBackup,
      tencentFaceFusion: next.tencentFaceFusion,
      video: next.video,
      videoBackup: next.videoBackup,
      points: next.points,
      costs: next.costs,
      generationQueue: next.generationQueue,
      generationQueueAlertState: data.generationQueueAlertState,
      version: data.version,
      updatedAt: data.updatedAt,
      updatedBy: data.updatedBy
    },
    expiresAt: Date.now() + ADMIN_RUNTIME_CACHE_TTL_MS
  };
  log("info", "admin.runtime-config.saved", {
    updatedBy: getOpenId(context),
    version: data.version,
    imageProviderAutoCorrected: providerGuard.corrected,
    providerLabelFields: Object.keys(patch.providerLabels || {}),
    faceFields: Object.keys(patch.face),
    analysisFields: Object.keys(patch.analysis),
    imageFields: Object.keys(patch.image),
    imageBackupFields: Object.keys(patch.imageBackup),
    tencentFaceFusionFields: Object.keys(patch.tencentFaceFusion),
    videoFields: Object.keys(patch.video),
      videoBackupFields: Object.keys(patch.videoBackup),
     faceBackupFields: Object.keys(patch.faceBackup),
     analysisBackupFields: Object.keys(patch.analysisBackup),
    pointsFields: Object.keys(patch.points),
    costFields: Object.keys(patch.costs),
    generationQueueFields: Object.keys(patch.generationQueue)
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
  const readOnly = Boolean(event && event.readOnly);
  const runtimeDependencies = checkRuntimeDependencies();
  const configs = await resolveEffectiveConfigs({
    allowMigrations: !readOnly,
    cache: !readOnly
  });
  const runtime = configs.runtime;
  const tencentFaceFusion = configs.tencentFaceFusion;
  let imageEditEndpoint = {
    url: "",
    source: "invalid",
    configured: false
  };
  let imageBackupEditEndpoint = {
    url: "",
    source: "invalid",
    configured: false
  };
  try {
    imageEditEndpoint = resolveImageEditEndpoint(configs.image);
  } catch (error) {
    log("warn", "admin.deployment.image-edit-endpoint-invalid", {
      requestId: event && event.requestId,
      errorCode: error && error.code,
      message: error && error.message
    });
  }
  try {
    imageBackupEditEndpoint = resolveImageEditEndpoint(configs.imageBackup);
  } catch (error) {
    log("warn", "admin.deployment.image-backup-edit-endpoint-invalid", {
      requestId: event && event.requestId,
      errorCode: error && error.code,
      message: error && error.message
    });
  }
  const faceReady = Boolean(
    configs.face.apiKey
    && (configs.face.baseUrl || configs.face.endpoint)
    && configs.face.model
  );
  const imageReady = Boolean(
    configs.image.apiKey &&
    (configs.image.baseUrl || configs.image.endpoint) &&
    configs.image.model
  );
  const imageBackupReady = Boolean(
    configs.imageBackup.enabled
    &&
    configs.imageBackup.apiKey
    && (configs.imageBackup.baseUrl || configs.imageBackup.endpoint)
    && configs.imageBackup.model
  );
  const analysisReady = Boolean(
    configs.analysis.apiKey
    && (configs.analysis.baseUrl || configs.analysis.endpoint)
    && configs.analysis.model
  );
  const videoReady = Boolean(configs.video.configured);
  const result = {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    environment: env("CLOUDBASE_ENV_ID", ""),
    face: {
      ready: faceReady,
      provider: configs.face.provider || "",
      model: configs.face.model || "",
      apiKeyConfigured: Boolean(configs.face.apiKey)
    },
    analysis: {
      ready: analysisReady,
      provider: configs.analysis.provider || "",
      model: configs.analysis.model || "",
      apiKeyConfigured: Boolean(configs.analysis.apiKey)
    },
    image: {
      ready: imageReady,
      provider: configs.image.provider || "",
      model: configs.image.model || "",
      mode: configs.image.mode || DEFAULT_IMAGE_MODE,
      timeoutMs: Number(configs.image.timeoutMs) || 0,
      maxRetries: Number(configs.image.maxRetries) || 0,
      generationEndpoint: safeEndpointUrl(
        configs.image.baseUrl,
        configs.image.endpoint,
        "images/generations"
      ),
      editEndpoint: safeUrl(imageEditEndpoint.url),
      editEndpointSource: imageEditEndpoint.source,
      apiKeyConfigured: Boolean(configs.image.apiKey)
    },
    imageBackup: {
      enabled: Boolean(configs.imageBackup.enabled),
      ready: imageBackupReady,
      provider: configs.imageBackup.provider || "",
      model: configs.imageBackup.model || "",
      mode: configs.imageBackup.mode || DEFAULT_IMAGE_MODE,
      timeoutMs: Number(configs.imageBackup.timeoutMs) || 0,
      maxRetries: Number(configs.imageBackup.maxRetries) || 0,
      editEndpoint: safeUrl(imageBackupEditEndpoint.url),
      editEndpointSource: imageBackupEditEndpoint.source,
      apiKeyConfigured: Boolean(configs.imageBackup.apiKey)
    },
    tencentFaceFusion: {
      ready: Boolean(tencentFaceFusion.configured),
      provider: "tencent",
      model: tencentFaceFusion.model || "FuseFaceUltra",
      timeoutMs: Number(tencentFaceFusion.timeoutMs) || 0,
      credentialsConfigured: Boolean(tencentFaceFusion.configured)
    },
    flows: {
      normal: {
        imageEditSteps: 1,
        faceFusionSteps: 0,
        totalSteps: 1
      },
      tencent: {
        imageEditSteps: 1,
        faceFusionSteps: 1,
        totalSteps: 2
      }
    },
    runtimeDependencies,
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
  const logWritten = readOnly
    ? false
    : await writeDeploymentLog(Object.assign({}, result, {
        requestId: event.requestId,
        ok: faceReady || analysisReady || imageReady || imageBackupReady || videoReady,
        checkedBy: getOpenId(context)
      }));
  return jsonResponse(true, Object.assign(result, {
    ok: true,
    readOnly,
    logWritten
  }));
}

function buildImageEditCapabilityProbe(imageConfig = {}) {
  const config = imageConfig && typeof imageConfig === "object" ? imageConfig : {};
  let endpointInfo = {
    url: "",
    source: "invalid",
    configured: false
  };
  let endpointError = null;
  try {
    endpointInfo = resolveImageEditEndpoint(config);
  } catch (error) {
    endpointError = error;
  }
  const requestFormat = imageEditJsonRequestFormat(config, endpointInfo.url)
    || "multipart";
  const fields = requestFormat !== "multipart"
    ? {
        mainImage: "images[0].image_url",
        mask: "mask.image_url",
        references: "images[1...].image_url"
      }
    : {
        mainImage: env("AI_IMAGE_MAIN_FIELD", "image"),
        mask: env("AI_IMAGE_MASK_FIELD", "mask"),
        references: env("AI_IMAGE_REFERENCE_FIELD", "image[]")
      };
  const configured = Boolean(
    config.apiKey
    && String(config.provider || "").trim()
    && String(config.model || "").trim()
    && endpointInfo.url
    && !endpointError
  );
  const status = endpointError
    ? "endpoint-invalid"
    : configured
      ? "config-ready"
      : "not-configured";
  const missing = [];
  if (!String(config.provider || "").trim()) missing.push("provider");
  if (!String(config.model || "").trim()) missing.push("model");
  if (!config.apiKey) missing.push("apiKey");
  if (!endpointInfo.url) missing.push("editEndpoint");
  return {
    status,
    statusText: status === "config-ready"
      ? "图片编辑配置完整"
      : status === "endpoint-invalid"
        ? "图片编辑 endpoint 无效"
        : "图片编辑配置不完整",
    configured,
    provider: String(config.provider || ""),
    model: String(config.model || ""),
    mode: "edits",
    editEndpoint: safeUrl(endpointInfo.url),
    endpointSource: endpointInfo.source,
    requestFormat,
    fields,
    maskInvert: boolEnv("AI_MASK_INVERT", false),
    apiKeyConfigured: Boolean(config.apiKey),
    missing,
    httpStatus: 0,
    mainImageSent: false,
    maskSent: false,
    liveVerified: false,
    billingRisk: false,
    requiresLiveTest: true,
    supportsImageEdit: null,
    supportsMaskCompositing: null,
    errorClassification: endpointError
      ? String(endpointError.code || "image-edit-endpoint-invalid")
      : "",
    message: configured
      ? "本次只核对配置，不调用生图、不扣费；不代表上游已经实测支持图片编辑和 mask 像素合成。"
      : endpointError
        ? sanitizeFailureMessage(endpointError.message)
        : `缺少配置：${missing.join("、") || "未知"}。本次没有调用上游。`,
    checkedAt: new Date().toISOString()
  };
}

async function probeImageEditCapability(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const configs = await resolveEffectiveConfigs();
  const imageConfig = event && event.config
    ? temporaryModelConfig(configs, "image", event.config)
    : configs.image;
  const probe = buildImageEditCapabilityProbe(imageConfig);
  log(probe.configured ? "info" : "warn", "admin.image-edit-capability-probe", {
    requestId: event && event.requestId,
    status: probe.status,
    provider: probe.provider,
    model: probe.model,
    editEndpoint: probe.editEndpoint,
    endpointSource: probe.endpointSource,
    requestFormat: probe.requestFormat,
    apiKeyConfigured: probe.apiKeyConfigured,
    liveVerified: false,
    billingRisk: false,
    missing: probe.missing
  });
  return jsonResponse(true, {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    probe
  });
}

function modelProbeStatusText(status) {
  return {
    ok: "正常",
    "not-configured": "未配置",
    "auth-failed": "密钥异常",
    "model-not-listed": "模型未列出",
    "endpoint-not-supported": "接口需确认",
    "upstream-error": "上游异常",
    "network-error": "网络异常"
  }[status] || "需要处理";
}

function modelProbeUpstreamDetail(response) {
  const payload = response && response.json && typeof response.json === "object"
    ? response.json
    : {};
  const error = payload.error;
  const code = typeof error === "object" && error
    ? error.code
    : payload.code;
  const message = typeof error === "object" && error
    ? error.message
    : typeof error === "string"
      ? error
      : payload.message;
  return sanitizeFailureMessage(
    [code, message]
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join("："),
    160
  );
}

function modelProbeUpstreamMessage(response, fallback) {
  const status = Number(response && response.status) || 0;
  const detail = modelProbeUpstreamDetail(response);
  if (status && detail) return `${fallback}（HTTP ${status}：${detail}）`;
  if (status) return `${fallback}（HTTP ${status}）`;
  return fallback;
}

function modelProbeUrl(modelConfig) {
  if (modelConfig && modelConfig.baseUrl) {
    return endpoint(modelConfig.baseUrl, "models");
  }
  const configuredEndpoint = modelConfig && (
    modelConfig.endpoint
    || modelConfig.queryEndpoint
  );
  if (!configuredEndpoint) return "";
  try {
    const parsed = new URL(configuredEndpoint);
    const versionIndex = parsed.pathname.toLowerCase().lastIndexOf("/v1/");
    if (versionIndex >= 0) {
      parsed.pathname = `${parsed.pathname.slice(0, versionIndex + 3)}/models`;
    } else if (!/\/models\/?$/i.test(parsed.pathname)) {
      parsed.pathname = "/v1/models";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return configuredEndpoint;
  }
}

function listedModelIds(payload) {
  const data = payload && Array.isArray(payload.data)
    ? payload.data
    : payload && Array.isArray(payload.models)
      ? payload.models
      : payload && payload.result && Array.isArray(payload.result.data)
        ? payload.result.data
        : null;
  if (!data) return null;
  return data
    .map((item) => typeof item === "string"
      ? item
      : item && (item.id || item.model || item.name))
    .filter(Boolean)
    .map((item) => String(item));
}

function listedModelEntries(payload) {
  const data = payload && Array.isArray(payload.data)
    ? payload.data
    : payload && Array.isArray(payload.models)
      ? payload.models
      : payload && payload.result && Array.isArray(payload.result.data)
        ? payload.result.data
        : null;
  if (!data) return null;
  return data
    .map((item) => {
      if (typeof item === "string") {
        return { id: String(item) };
      }
      if (!item || typeof item !== "object") return null;
      const id = item.id || item.model || item.name;
      if (!id) return null;
      const entry = { id: String(id) };
      [
        "name",
        "model",
        "capabilities",
        "supported_capabilities",
        "resolutions",
        "resolution",
        "qualities",
        "quality",
        "supported_resolutions",
        "supported_qualities",
        "supported_sizes",
        "sizes",
        "size"
      ].forEach((key) => {
        if (hasOwn(item, key)) entry[key] = item[key];
      });
      return entry;
    })
    .filter(Boolean);
}

function modelCapabilityMap(type, modelConfig, entries) {
  const map = {};
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = String(entry && entry.id || "").trim();
    if (!id) return;
    map[id] = modelCapabilities(type, Object.assign({}, modelConfig, { model: id }), {}, entry);
  });
  return map;
}

async function probeOneModel(type, modelConfig, options = {}) {
  const startedAt = Date.now();
  const label = modelUsageTypeLabel(type);
  const config = modelConfig || {};
  const provider = config.provider || "";
  const model = config.model || "";
  const requireModel = options.requireModel !== false;
  const configured = Boolean(
    config.apiKey
    && provider
    && (config.baseUrl || config.endpoint)
    && (!requireModel || model)
  );
  const initialCapabilities = modelCapabilities(type, config);
  const base = {
    type,
    typeLabel: label,
    provider,
    model,
    configured,
    ready: false,
    reachable: false,
    status: configured ? "network-error" : "not-configured",
    statusText: configured ? "检查中" : modelProbeStatusText("not-configured"),
    httpStatus: 0,
    durationMs: 0,
    checkedAt: new Date().toISOString(),
    endpoint: "",
    models: [],
    modelCapabilities: {},
    capabilities: initialCapabilities,
    qualityProbe: type === "image"
      ? buildImageQualityProbe(config, initialCapabilities)
      : null,
    message: configured
      ? ""
      : requireModel
        ? "请先填写 Provider、地址、模型，并确认管理员配置里有 API Key。"
        : "请先填写 Provider、地址，并确认管理员配置里有 API Key。"
  };
  if (!configured) return base;

  const url = modelProbeUrl(config);
  base.endpoint = safeUrl(url);
  if (!url) {
    return Object.assign(base, {
      status: "not-configured",
      statusText: modelProbeStatusText("not-configured"),
      message: "没有可探测的接口地址。"
    });
  }
  try {
    const response = await requestOnce(url, {
      method: "GET",
      headers: Object.assign(
        { Accept: "application/json" },
        apiKeyHeaders(config.apiKey)
      ),
      timeoutMs: Math.min(
        15000,
        Math.max(3000, Number(config.timeoutMs) || 10000)
      )
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const status = Number(response.status) || 0;
    const reachable = status > 0;
    if (status >= 200 && status < 300) {
      const entries = listedModelEntries(response.json);
      const ids = entries ? entries.map((item) => item.id) : null;
      if (!entries) {
        return Object.assign(base, {
          reachable: true,
          status: "endpoint-not-supported",
          statusText: modelProbeStatusText("endpoint-not-supported"),
          httpStatus: status,
          durationMs,
          message: "接口可以访问，但返回内容不是标准模型列表，请人工确认兼容方式。"
        });
      }
      const selectedEntry = entries.find((item) => (
        String(item.id || "").trim().toLowerCase() === String(model || "").trim().toLowerCase()
      ));
      const capabilities = modelCapabilities(type, config, response.json, selectedEntry);
      const capabilitiesByModel = modelCapabilityMap(type, config, entries);
      const qualityProbe = type === "image"
        ? buildImageQualityProbe(config, capabilities)
        : null;
      if (!requireModel) {
        return Object.assign(base, {
          ready: true,
          reachable: true,
          status: "ok",
          statusText: modelProbeStatusText("ok"),
          httpStatus: status,
          durationMs,
          models: ids,
          modelCapabilities: capabilitiesByModel,
          capabilities,
          qualityProbe,
          message: `接口可访问，已读取 ${ids.length} 个模型。`
        });
      }
      const normalizedModel = String(model).trim().toLowerCase();
      const modelListed = ids.some((item) => (
        String(item).trim().toLowerCase() === normalizedModel
      ));
      return Object.assign(base, {
        ready: modelListed,
        reachable: true,
        status: modelListed ? "ok" : "model-not-listed",
        statusText: modelProbeStatusText(modelListed ? "ok" : "model-not-listed"),
        httpStatus: status,
        durationMs,
        modelCapabilities: capabilitiesByModel,
        capabilities,
        qualityProbe,
        message: modelListed
          ? "接口可访问，当前模型配置正常。"
          : `接口可访问，但模型列表里没有 ${model}。`
      });
    }
    if (status === 401 || status === 403) {
      return Object.assign(base, {
        reachable,
        status: "auth-failed",
        statusText: modelProbeStatusText("auth-failed"),
        httpStatus: status,
        durationMs,
        message: modelProbeUpstreamMessage(
          response,
          "接口地址可访问，但 API Key 无效或没有权限"
        )
      });
    }
    if (status === 404 || status === 405) {
      return Object.assign(base, {
        reachable,
        status: "endpoint-not-supported",
        statusText: modelProbeStatusText("endpoint-not-supported"),
        httpStatus: status,
        durationMs,
        message: modelProbeUpstreamMessage(
          response,
          "服务地址可访问，但没有提供 GET /models；请确认地址是否为兼容接口根地址"
        )
      });
    }
    return Object.assign(base, {
      reachable,
      status: "upstream-error",
      statusText: modelProbeStatusText("upstream-error"),
      httpStatus: status,
      durationMs,
      message: modelProbeUpstreamMessage(
        response,
        "接口返回异常，请检查服务状态"
      )
    });
  } catch (error) {
    return Object.assign(base, {
      status: "network-error",
      statusText: modelProbeStatusText("network-error"),
      durationMs: Math.max(0, Date.now() - startedAt),
      message: sanitizeFailureMessage(error && error.message) || "接口连接失败。"
    });
  }
}

function normalizeModelProbeType(value) {
  const type = String(value || "").trim().toLowerCase();
  return MODEL_PROBE_TYPES.includes(type) ? type : "";
}

function temporaryModelConfig(configs, type, input) {
  const requestedTarget = String(
    input && input.configTarget || type
  ).trim();
  const configTarget = (
    type === "image" && requestedTarget === "imageBackup"
    || type === "video" && requestedTarget === "videoBackup"
  ) ? requestedTarget : type;
  const current = configs && configs[configTarget] ? configs[configTarget] : {};
  const patch = normalizeRuntimePatch({
    [configTarget]: input && typeof input === "object" ? input : {}
  })[configTarget] || {};
  return Object.assign({}, current, patch, {
    // 空字符串表示沿用后台已有密钥，避免无意中把可用密钥覆盖掉。
    apiKey: String(patch.apiKey || "").trim() || current.apiKey || ""
  });
}

async function probeModels(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const requestedValue = String(event && event.modelType || "").trim();
  const requestedType = normalizeModelProbeType(requestedValue);
  if (requestedValue && !requestedType) {
    return fail(
      `不支持探测的模型类型：${requestedValue}`,
      "invalid-model-type"
    );
  }
  const configs = await resolveEffectiveConfigs();
  const types = requestedType ? [requestedType] : MODEL_PROBE_TYPES;
  const results = await Promise.all(types.map((type) => (
    probeOneModel(
      type,
      requestedType && event && event.config
        ? temporaryModelConfig(configs, type, event.config)
        : configs[type]
    )
  )));
  const readyCount = results.filter((item) => item.ready).length;
  return jsonResponse(true, {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    checkedAt: new Date().toISOString(),
    scope: requestedType ? "single" : "all",
    requestedType,
    allReady: readyCount === results.length,
    readyCount,
    total: results.length,
    results
  });
}

function adminProviderConnectionConfig(section, profile) {
  const value = profile && typeof profile === "object" ? profile : {};
  if (section === "face") return resolveFaceConfig({ face: value });
  if (section === "analysis") return resolveAnalysisConfig({ analysis: value });
  if (section === "image") return resolveImageConfig({ image: value });
  if (section === "imageBackup") {
    return resolveImageBackupConfig({ imageBackup: value });
  }
  if (section === "videoBackup") {
    return resolveVideoBackupConfig({ videoBackup: value });
  }
  return resolveVideoConfig({ video: value });
}

function adminProviderConnectionErrorCode(status) {
  const suffix = String(status || "failed")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "FAILED";
  return `ADMIN_PROVIDER_CONNECTION_${suffix}`;
}

async function testAdminProviderConnection(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const section = String(event && event.section || "").trim();
  if (!ADMIN_PROVIDER_CONFIG_SECTIONS.includes(section)) {
    return fail(
      `不支持测试的配置区域：${section || "未指定"}`,
      "ADMIN_PROVIDER_SECTION_INVALID"
    );
  }
  const rawProviderId = String(event && event.providerId || "").trim();
  const providerId = normalizeAdminProviderId(rawProviderId);
  if (
    !providerId
    || providerId.length > 120
    || isDangerousAdminProviderId(providerId)
  ) {
    return fail("服务商编号无效，请重新选择服务商。", "ADMIN_PROVIDER_ID_INVALID");
  }

  const configs = await resolveEffectiveConfigs({ force: true });
  const runtime = configs && configs.runtime && typeof configs.runtime === "object"
    ? configs.runtime
    : {};
  const providerProfiles = syncAdminTopLevelProviderProfiles(
    runtime,
    runtime.providerProfiles
  );
  const profileSection = section === "videoBackup" ? "video" : section;
  const profile = providerProfiles[profileSection]
    && providerProfiles[profileSection][providerId]
    || null;
  const activeConfig = configs && configs[section] && typeof configs[section] === "object"
    ? configs[section]
    : {};
  const activeProviderId = normalizeAdminProviderId(activeConfig.provider);
  const selectedProfile = activeProviderId === providerId
    ? Object.assign({}, profile || {}, activeConfig)
    : profile;
  if (!selectedProfile) {
    return fail(
      `没有找到“${providerId}”在${section}区域的已保存配置，请先保存后再测试。`,
      "ADMIN_PROVIDER_PROFILE_NOT_FOUND",
      {
        section,
        providerId
      }
    );
  }

  const probeType = section === "imageBackup"
    ? "image"
    : section === "videoBackup"
      ? "video"
      : section;
  const config = adminProviderConnectionConfig(section, selectedProfile);
  const result = await probeOneModel(probeType, config);
  const response = {
    section,
    providerId,
    provider: String(result.provider || providerId).trim(),
    model: String(result.model || "").trim(),
    ready: Boolean(result.ready),
    reachable: Boolean(result.reachable),
    status: String(result.status || "network-error"),
    statusText: String(result.statusText || modelProbeStatusText(result.status)),
    httpStatus: Number(result.httpStatus) || 0,
    durationMs: Number(result.durationMs) || 0,
    checkedAt: result.checkedAt || new Date().toISOString(),
    message: sanitizeFailureMessage(
      result.message || "连接测试未通过，请检查已保存的服务商配置。",
      200
    )
  };
  log(
    response.ready ? "info" : "warn",
    "admin.provider-connection-tested",
    {
      requestId: String(event && event.requestId || ""),
      section,
      providerId,
      provider: response.provider,
      model: response.model,
      status: response.status,
      httpStatus: response.httpStatus,
      durationMs: response.durationMs,
      ready: response.ready
    }
  );
  if (!response.ready) {
    return fail(
      response.message,
      adminProviderConnectionErrorCode(response.status),
      response
    );
  }
  return jsonResponse(true, response);
}

async function listModels(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const requestedValue = String(event && event.modelType || "").trim();
  const requestedType = normalizeModelProbeType(requestedValue);
  if (!requestedType) {
    return fail(
      `不支持读取的模型类型：${requestedValue || "未指定"}`,
      "invalid-model-type"
    );
  }
  const configs = await resolveEffectiveConfigs();
  const config = event && event.config
    ? temporaryModelConfig(configs, requestedType, event.config)
    : configs[requestedType];
  const result = await probeOneModel(requestedType, config, { requireModel: false });
  return jsonResponse(true, {
    buildVersion: API_BUILD_VERSION,
    buildMarker: API_BUILD_MARKER,
    checkedAt: new Date().toISOString(),
    type: requestedType,
    typeLabel: result.typeLabel,
    status: result.status,
    statusText: result.statusText,
    ready: result.ready,
    reachable: result.reachable,
    httpStatus: result.httpStatus,
    durationMs: result.durationMs,
    endpoint: result.endpoint,
    models: result.models || [],
    modelCapabilities: result.modelCapabilities || {},
    capabilities: result.capabilities || {
      source: "custom",
      resolutions: []
    },
    qualityProbe: result.qualityProbe || null,
    message: result.message || ""
  });
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

function safeExportText(value, maxLength = 200) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function formatExportDateTime(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: MODEL_USAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function buildModelUsageDetailRows(events = []) {
  const rows = [[
    "日期",
    "时间",
    "脱敏用户编号",
    "请求编号",
    "功能",
    "Provider",
    "模型",
    "图片清晰度",
    "视频清晰度",
    "单价",
    "数量/时长",
    "成本",
    "成本来源",
    "HTTP状态",
    "是否成功",
    "耗时毫秒",
    "成本配置版本"
  ]];
  (Array.isArray(events) ? events : [])
    .map((item) => modelUsageDetailFromEvent(item))
    .filter(Boolean)
    .sort((left, right) => (
      String(right.createdAt || "").localeCompare(String(left.createdAt || ""))
    ))
    .forEach((item) => {
      const priced = item.billingSource !== "unavailable";
      rows.push([
        safeExportText(item.dateKey, 10),
        formatExportDateTime(item.createdAt),
        safeExportText(item.userHash || "anonymous", 40),
        safeExportText(item.requestId, 80),
        safeExportText(modelUsageTypeLabel(item.usageType), 20),
        safeExportText(item.provider, 80),
        safeExportText(item.model, 120),
        safeExportText(item.imageResolution, 10),
        safeExportText(item.videoResolution, 10),
        priced ? formatExportNumber(item.unitPrice) : "未计价",
        formatExportNumber(item.quantity, 3),
        priced ? formatExportNumber(item.estimatedCost) : "未计价",
        safeExportText(item.billingSource || "unavailable", 20),
        Number(item.status) || 0,
        item.success ? "是" : "否",
        Math.max(0, Number(item.durationMs) || 0),
        safeExportText(item.costConfigVersion, 40)
      ]);
    });
  return rows;
}

function buildModelUsageExportWorkbook(stats = {}) {
  const workbook = XLSX.utils.book_new();
  const dailyRows = [[
    "日期",
    "总调用次数",
    "成功",
    "失败",
    "预计成本（元）",
    "图片分析成本（元）",
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
    const analysis = item.analysis || {};
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
      formatExportNumber(analysis.estimatedCost),
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
    "图片分析成本（元）",
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
      formatExportNumber(item.analysis && item.analysis.estimatedCost),
      formatExportNumber(item.face && item.face.estimatedCost),
      formatExportNumber(item.image && item.image.estimatedCost),
      formatExportNumber(item.video && item.video.estimatedCost),
      Number(item.totalTokens) || 0,
      formatExportNumber(item.videoDurationSeconds, 3),
      Number(item.unavailableCostCount) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(monthlyRows), "按月份");

  const detailRows = buildModelUsageDetailRows(
    Array.isArray(stats.details) ? stats.details : []
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(detailRows),
    "成本调用明细"
  );

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

function buildModelFailureExportWorkbook(stats = {}, monthKey = "") {
  const usageStats = stats || {};
  const failureStats = usageStats.failureStats || {};
  const normalizedMonth = /^\d{4}-\d{2}$/.test(String(monthKey || ""))
    ? String(monthKey)
    : monthKeyFromDateKey(
      usageStats.todayKey || dateKeyForTimeZone(new Date(), MODEL_USAGE_TIME_ZONE)
    );
  const details = (
    Array.isArray(failureStats.details) && failureStats.details.length
      ? failureStats.details
      : (Array.isArray(failureStats.failureDetails) ? failureStats.failureDetails : [])
  ).filter((item) => {
    const itemMonth = item.monthKey || String(item.dateKey || "").slice(0, 7);
    return itemMonth === normalizedMonth;
  });
  const daily = (Array.isArray(usageStats.daily) ? usageStats.daily : [])
    .filter((item) => String(item.dateKey || "").startsWith(normalizedMonth));
  const users = {};
  const types = {};
  details.forEach((item) => {
    const userHash = safeExportText(item.userHash || "anonymous", 40);
    users[userHash] = (users[userHash] || 0) + 1;
    const type = item.errorCode || (item.errorStatus ? `HTTP ${item.errorStatus}` : "未提供错误原因");
    types[type] = (types[type] || 0) + 1;
  });
  const workbook = XLSX.utils.book_new();
  const selectedMonthly = (Array.isArray(failureStats.monthly) ? failureStats.monthly : [])
    .find((item) => item.monthKey === normalizedMonth);
  const summaryRows = [
    ["统计项目", "数值"],
    ["统计月份", normalizedMonth],
    ["失败总数", details.length],
    ["调用总数", Number(selectedMonthly && selectedMonthly.total) || details.length],
    ["失败率", selectedMonthly && selectedMonthly.total
      ? `${Number((details.length / selectedMonthly.total * 100).toFixed(2))}%`
      : "0%"],
    ["用户数", Object.keys(users).length],
    ["最近更新时间", formatExportDateTime(new Date())]
  ];
  Object.entries(types)
    .sort((left, right) => right[1] - left[1])
    .forEach(([label, count]) => summaryRows.push([`失败类型：${label}`, count]));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "统计摘要");

  const dailyRows = [["日期", "失败次数", "用户数", "成功次数", "调用总数"]];
  daily.forEach((item) => {
    const dayDetails = details.filter((detail) => detail.dateKey === item.dateKey);
    const dayUsers = new Set(dayDetails.map((detail) => detail.userHash || "anonymous"));
    dailyRows.push([
      item.dateKey || "",
      dayDetails.length,
      dayUsers.size,
      Number(item.success) || 0,
      Number(item.total) || 0
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(dailyRows), "每日明细");

  const userRows = [["脱敏用户编号", "失败次数"]];
  Object.entries(users)
    .sort((left, right) => right[1] - left[1])
    .forEach(([userHash, count]) => userRows.push([userHash, count]));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(userRows), "按用户");

  const detailRows = [[
    "日期",
    "时间",
    "脱敏用户编号",
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
  details.forEach((item) => {
    detailRows.push([
      safeExportText(item.dateKey),
      formatExportDateTime(item.createdAt),
      safeExportText(item.userHash || "anonymous", 40),
      safeExportText(item.usageTypeLabel || item.usageType),
      safeExportText(item.provider),
      safeExportText(item.model),
      safeExportText(item.requestId),
      safeExportText(item.errorCode),
      safeExportText(item.errorMessage || "未提供错误原因"),
      Number(item.errorStatus) || 0,
      item.retryable ? "是" : "否",
      Math.max(1, Number(item.attempt) || 1),
      Math.max(0, Number(item.durationMs) || 0)
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(detailRows), "失败明细");
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

async function exportModelFailureStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const stats = await getModelUsageStats({ days: 90 }, context);
  if (!stats || stats.ok === false) return stats;
  const monthKey = /^\d{4}-\d{2}$/.test(String(event && event.monthKey || ""))
    ? String(event.monthKey)
    : monthKeyFromDateKey(
      stats.todayKey || dateKeyForTimeZone(new Date(), MODEL_USAGE_TIME_ZONE)
    );
  const buffer = buildModelFailureExportWorkbook(stats, monthKey);
  const fileName = `模型失败统计-${monthKey}.xlsx`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `exports/model-failure/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.xlsx`,
    fileContent: buffer
  });
  return jsonResponse(true, {
    fileID: uploaded && uploaded.fileID ? uploaded.fileID : "",
    fileName,
    sizeBytes: buffer.length,
    monthKey,
    message: "失败统计 Excel 已生成，可以下载。"
  });
}

function buildAutoFaceFailureExportWorkbook(stats = {}, monthKey = "") {
  const normalizedMonth = /^\d{4}-\d{2}$/.test(String(monthKey || ""))
    ? String(monthKey)
    : monthKeyFromDateKey(stats.todayKey || dateKeyForTimeZone(new Date(), AUTO_FACE_FAILURE_TIME_ZONE));
  const details = (Array.isArray(stats.details) ? stats.details : [])
    .filter((item) => item && item.monthKey === normalizedMonth);
  const daily = (Array.isArray(stats.daily) ? stats.daily : [])
    .filter((item) => item && String(item.dateKey || "").startsWith(normalizedMonth));
  const byType = {};
  const byUser = {};
  details.forEach((item) => {
    const type = normalizeAutoFaceFailureType(item.failureType);
    byType[type] = (byType[type] || 0) + 1;
    const userHash = compactUsageText(item.userHash, 40) || "anonymous";
    if (!byUser[userHash]) byUser[userHash] = 0;
    byUser[userHash] += 1;
  });
  const workbook = XLSX.utils.book_new();
  const selectedMonthly = (Array.isArray(stats.monthly) ? stats.monthly : [])
    .find((item) => item && item.monthKey === normalizedMonth);
  const summaryRows = [
    ["统计项目", "数值"],
    ["统计月份", normalizedMonth],
    ["失败总数", details.length],
    ["用户数", Object.keys(byUser).length],
    ["主要失败类型", selectedMonthly ? selectedMonthly.topFailureTypeLabel : "暂无"],
    ["最近更新时间", new Date().toISOString()]
  ];
  Object.entries(byType)
    .sort((left, right) => right[1] - left[1])
    .forEach(([type, count]) => {
      summaryRows.push([`失败类型：${formatAutoFaceFailureType(type)}`, count]);
    });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "统计摘要");

  const dailyRows = [["日期", "失败次数", "用户数", "主要失败类型", "最近失败时间"]];
  daily.forEach((item) => {
    dailyRows.push([
      item.dateKey || "",
      Number(item.total) || 0,
      Number(item.userCount) || 0,
      item.topFailureTypeLabel || "其他失败",
      item.lastSeen || ""
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(dailyRows), "每日明细");

  const userRows = [["脱敏用户编号", "失败次数"]];
  Object.entries(byUser)
    .sort((left, right) => right[1] - left[1])
    .forEach(([userHash, count]) => userRows.push([userHash, count]));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(userRows), "按用户");

  const detailRows = [[
    "日期",
    "时间",
    "脱敏用户编号",
    "失败类型",
    "错误码",
    "HTTP 状态",
    "错误原因",
    "请求编号",
    "阶段",
    "耗时毫秒",
    "小程序版本"
  ]];
  details.forEach((item) => {
    const createdAt = item.createdAt ? new Date(item.createdAt) : null;
    detailRows.push([
      item.dateKey || "",
      createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : "",
      item.userHash || "anonymous",
      item.failureTypeLabel || "其他失败",
      item.errorCode || "",
      Number(item.status) || 0,
      item.message || "",
      item.requestId || "",
      item.stage || "",
      Number(item.durationMs) || 0,
      item.appVersion || ""
    ]);
  });
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(detailRows), "失败明细");
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

async function exportAutoFaceFailureStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const stats = await getAutoFaceFailureStats({}, context);
  if (!stats || stats.ok === false) return stats;
  const monthKey = /^\d{4}-\d{2}$/.test(String(event && event.monthKey || ""))
    ? String(event.monthKey)
    : monthKeyFromDateKey(stats.todayKey || dateKeyForTimeZone(new Date(), AUTO_FACE_FAILURE_TIME_ZONE));
  const buffer = buildAutoFaceFailureExportWorkbook(stats, monthKey);
  const fileName = `自动贴脸失败统计-${monthKey}.xlsx`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `exports/auto-face-failure/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.xlsx`,
    fileContent: buffer
  });
  return jsonResponse(true, {
    fileID: uploaded && uploaded.fileID ? uploaded.fileID : "",
    fileName,
    sizeBytes: buffer.length,
    monthKey,
    message: "失败统计 Excel 已生成，可以下载。"
  });
}

async function analyze(event, context) {
  const payload = event.payload || {};
  const configs = await resolveEffectiveConfigs();
  const visionCandidates = visionConfigCandidatesForAction("analyze", configs)
    .filter((candidate) => candidate && candidate.apiKey && candidate.model
      && (candidate.endpoint || candidate.baseUrl));
  const costs = configs.costs;
  if (!visionCandidates.length) {
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
  assertVisionImageSize(image, visionCandidates[0]);
  const instruction = payload.instruction || "请分析图片并返回场景、背景、姿态、面部朝向、光影妆容五项。";
  const imageDataUrl = toDataUrl(image, "image/jpeg");
  const result = await runVisionProviderFailover(
    visionCandidates,
    async (candidate) => {
      const url = candidate.endpoint || endpoint(candidate.baseUrl, "chat/completions");
      const requestPayload = {
        model: candidate.model,
        temperature: 0.2,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `${instruction}\n只返回 JSON，字段名使用 sceneDescription、backgroundDescription、poseDescription、faceDirectionDescription、lightingMakeupDescription、precisionNotes。` },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ]
        }]
      };
      const requestMeta = Object.assign(
        visionRequestMeta(event.requestId, "analyze", candidate, costs),
        { userHash: usageUserHash(getOpenId(context)) }
      );
      try {
        return await requestJson(
          url,
          Object.assign({}, requestPayload, {
            response_format: { type: "json_object" }
          }),
          candidate.apiKey,
          {},
          requestMeta
        );
      } catch (error) {
        if (error.status !== 400) throw error;
        return requestJson(url, requestPayload, candidate.apiKey, {}, requestMeta);
      }
    },
    { requestId: event.requestId, action: "analyze" }
  );
  const vision = result.config;
  const response = result.response;
  const model = vision.model;
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
  const configs = await resolveEffectiveConfigs();
  const visionCandidates = visionConfigCandidatesForAction("detectFaceCircle", configs)
    .filter((candidate) => candidate && candidate.apiKey && candidate.model
      && (candidate.endpoint || candidate.baseUrl));
  const costs = configs.costs;
  if (!visionCandidates.length) {
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
  const imageBytes = assertVisionImageSize(image, visionCandidates[0]);
  log("info", "vision.image.ready", {
    requestId: event.requestId,
    action: "detectFaceCircle",
    imageBytes
  });
  const instruction = [
    "你是人脸位置检测器，只分析这张原图中清晰可见的人脸。",
    "请找出所有可识别的人脸，忽略海报、头像小图、屏幕反光和动物脸。",
    "每张脸返回一个外接矩形，必须使用 x_min、y_min、x_max、y_max 四个命名字段，四个值都必须是 0 到 1000 的归一化坐标。",
    "x_min 是左边界，y_min 是上边界，x_max 是右边界，y_max 是下边界；不要使用 bbox_2d 数组。",
    "人脸框必须紧贴脸部外接框，不要返回整个人、衣服或背景。",
    "必须返回图片里的全部人脸，不能只返回最明显的一张。",
    "只返回 JSON，不要 Markdown、解释、示例数字或其他文字。",
    'JSON 结构固定为 {"faces":[{"x_min":左,"y_min":上,"x_max":右,"y_max":下,"confidence":置信度}]}。',
    "如果没有清晰人脸，返回 {\"faces\":[]}。"
  ].join("\n");
  const imageEncodingStartedAt = Date.now();
  const imageDataUrl = toDataUrl(image, detectMime(image));
  const imageEncodingMs = Date.now() - imageEncodingStartedAt;
  let response;
  let vision = visionCandidates[0];
  let model = vision.model;
  const visionRequestStartedAt = Date.now();
  try {
    const result = await runVisionProviderFailover(
      visionCandidates,
      async (candidate) => {
        const url = candidate.endpoint || endpoint(candidate.baseUrl, "chat/completions");
        const requestPayload = sanitizeVisionRequestPayload({
          model: candidate.model,
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
        }, candidate);
        const requestMeta = Object.assign(
          visionRequestMeta(event.requestId, "detectFaceCircle", candidate, costs),
          { userHash: usageUserHash(getOpenId(context)) }
        );
        try {
          return await requestJson(
            url,
            Object.assign({}, requestPayload, {
              response_format: { type: "json_object" }
            }),
            candidate.apiKey,
            {},
            requestMeta
          );
        } catch (error) {
          if (error.status !== 400) throw error;
          return requestJson(
            url,
            sanitizeVisionRequestPayload(requestPayload, candidate),
            candidate.apiKey,
            {},
            requestMeta
          );
        }
      },
      { requestId: event.requestId, action: "detectFaceCircle" }
    );
    response = result.response;
    vision = result.config;
    model = vision.model;
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
  const configs = await resolveEffectiveConfigs();
  const probe = buildAutoFaceProbe(configs.face);
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

async function analyzeWebPoses(event, context) {
  const payload = event.payload || {};
  const configs = await resolveEffectiveConfigs();
  const visionCandidates = visionConfigCandidatesForAction("analyzeWebPoses", configs)
    .filter((candidate) => candidate && candidate.apiKey && candidate.model
      && (candidate.endpoint || candidate.baseUrl));
  const costs = configs.costs;
  if (!visionCandidates.length) {
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
  assertVisionImageSize(image, visionCandidates[0]);
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
  const imageDataUrl = toDataUrl(image, detectMime(image));
  let vision = visionCandidates[0];
  let model = vision.model;
  const requestWebPose = async (candidate, prompt, temperature) => {
    const url = candidate.endpoint || endpoint(candidate.baseUrl, "chat/completions");
    const requestPayload = sanitizeVisionRequestPayload({
      model: candidate.model,
      temperature,
      top_p: 0.2,
      max_tokens: 2400,
      enable_thinking: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }]
    }, candidate);
    const requestMeta = Object.assign(
      visionRequestMeta(event.requestId, "analyzeWebPoses", candidate, costs),
      { userHash: usageUserHash(getOpenId(context)) }
    );
    try {
      return await requestJson(
        url,
        Object.assign({}, requestPayload, {
          response_format: { type: "json_object" }
        }),
        candidate.apiKey,
        {},
        requestMeta
      );
    } catch (error) {
      if (error.status !== 400) throw error;
      // 部分 OpenAI-compatible 中转不接受 response_format 或 enable_thinking，降级后再发一次。
      const fallbackPayload = sanitizeVisionRequestPayload(requestPayload, requestMeta);
      delete fallbackPayload.enable_thinking;
      delete fallbackPayload.seed;
      return requestJson(url, fallbackPayload, candidate.apiKey, {}, requestMeta);
    }
  };
  const repairInstruction = [
    "请重新输出上一条任务的结果。只返回一个合法 JSON 对象，不要 Markdown、代码块、思考过程或解释文字。",
    "顶层必须使用 poses 字段，poses 必须正好包含 8 个对象；每个对象必须有 id、title、description、category、tags、unsuitableReason。",
    "id 必须是 1 到 8 且不重复；title 至少 2 个中文字符；description 至少 20 个中文字符。",
    "如果某些身体部位在图片中看不见，就写不依赖该部位的替代动作，不要减少条数。",
    "JSON 结构示例：{\"poses\":[{\"id\":1,\"title\":\"短标题\",\"description\":\"具体动作说明\",\"category\":\"其他\",\"tags\":[],\"unsuitableReason\":\"\"}]}"
  ].join("\n");
  let responseResult = await runVisionProviderFailover(
    visionCandidates,
    (candidate) => requestWebPose(candidate, instruction, 0.2),
    { requestId: event.requestId, action: "analyzeWebPoses" }
  );
  vision = responseResult.config;
  model = vision.model;
  let response = responseResult.response;
  let rawText = extractText(response);
  let suggestions = normalizeWebPoseSuggestions(parseLooseJson(rawText));
  if (!suggestions) {
    log("warn", "vision.web-pose.invalid-output", {
      requestId: event.requestId,
      provider: vision.provider,
      model,
      rawTextLength: rawText.length,
      retry: true
    });
    response = await requestWebPose(vision, repairInstruction, 0);
    rawText = extractText(response);
    suggestions = normalizeWebPoseSuggestions(parseLooseJson(rawText));
  }
  if (!suggestions) {
    log("warn", "vision.web-pose.invalid-output", {
      requestId: event.requestId,
      provider: vision.provider,
      model,
      rawTextLength: rawText.length,
      retry: false
    });
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

function tencentPipelineMaskError(message, code = "TENCENT_PIPELINE_MASK_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  error.pipelineStage = "preparing";
  return error;
}

function readJpegDimensions(buffer) {
  let offset = 2;
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ]);
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
        format: "jpeg"
      };
    }
    offset += segmentLength;
  }
  return null;
}

function readWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunkType = buffer.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X") {
    return {
      width: buffer.readUIntLE(24, 3) + 1,
      height: buffer.readUIntLE(27, 3) + 1,
      format: "webp"
    };
  }
  if (chunkType === "VP8L" && buffer[20] === 0x2f) {
    const b1 = buffer[21];
    const b2 = buffer[22];
    const b3 = buffer[23];
    const b4 = buffer[24];
    return {
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      format: "webp"
    };
  }
  if (
    chunkType === "VP8 "
    && buffer[23] === 0x9d
    && buffer[24] === 0x01
    && buffer[25] === 0x2a
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
      format: "webp"
    };
  }
  return null;
}

function readImageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw tencentPipelineMaskError("主图内容为空，无法生成人脸保护 mask。");
  }
  let dimensions = null;
  if (
    buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    dimensions = {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      format: "png"
    };
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    dimensions = readJpegDimensions(buffer);
  } else if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    dimensions = readWebpDimensions(buffer);
  }
  const width = Number(dimensions && dimensions.width);
  const height = Number(dimensions && dimensions.height);
  const pixels = width * height;
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || !Number.isSafeInteger(pixels)
    || pixels > TENCENT_FACE_PROTECTION_MAX_PIXELS
  ) {
    throw tencentPipelineMaskError(
      pixels > TENCENT_FACE_PROTECTION_MAX_PIXELS
        ? "主图像素过大，无法安全生成人脸保护 mask，请压缩后重试。"
        : "无法读取主图尺寸，暂时不能生成人脸保护 mask。"
    );
  }
  return {
    width,
    height,
    pixels,
    format: String(dimensions.format || "")
  };
}

function faceProtectionRects(
  faces,
  imageWidth,
  imageHeight,
  marginRatio = TENCENT_FACE_PROTECTION_MARGIN_RATIO
) {
  const width = Math.max(1, Number(imageWidth) || 1);
  const height = Math.max(1, Number(imageHeight) || 1);
  const margin = Math.max(0, Math.min(1, Number(marginRatio) || 0));
  return (Array.isArray(faces) ? faces : []).map((face) => {
    const x = Number(face && face.x);
    const y = Number(face && face.y);
    const faceWidth = Number(face && face.width);
    const faceHeight = Number(face && face.height);
    if (![x, y, faceWidth, faceHeight].every(Number.isFinite)) return null;
    if (faceWidth <= 1 || faceHeight <= 1) return null;
    const leftNormalized = Math.max(0, x - faceWidth * margin);
    const topNormalized = Math.max(0, y - faceHeight * margin);
    const rightNormalized = Math.min(1000, x + faceWidth * (1 + margin));
    const bottomNormalized = Math.min(1000, y + faceHeight * (1 + margin));
    const left = Math.max(0, Math.min(width - 1, Math.floor(leftNormalized / 1000 * width)));
    const top = Math.max(0, Math.min(height - 1, Math.floor(topNormalized / 1000 * height)));
    const right = Math.max(left + 1, Math.min(width, Math.ceil(rightNormalized / 1000 * width)));
    const bottom = Math.max(top + 1, Math.min(height, Math.ceil(bottomNormalized / 1000 * height)));
    return {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top
    };
  }).filter(Boolean);
}

function createFaceProtectionMask(mainBuffer, faces) {
  const dimensions = readImageDimensions(mainBuffer);
  const rects = faceProtectionRects(faces, dimensions.width, dimensions.height);
  if (!rects.length) {
    throw tencentPipelineMaskError(
      "主图里没有检测到可保护的人脸，已停止图片编辑，避免把脸改掉。",
      "TENCENT_PIPELINE_FACE_NOT_FOUND"
    );
  }
  const png = new PNG({
    width: dimensions.width,
    height: dimensions.height,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true
  });
  png.data.fill(0);
  rects.forEach((rect) => {
    const startX = Math.max(0, rect.x);
    const endX = Math.min(dimensions.width, rect.x + rect.width);
    const startY = Math.max(0, rect.y);
    const endY = Math.min(dimensions.height, rect.y + rect.height);
    for (let y = startY; y < endY; y += 1) {
      const start = (y * dimensions.width + startX) * 4;
      const end = (y * dimensions.width + endX) * 4;
      png.data.fill(255, start, end);
    }
  });
  return {
    buffer: PNG.sync.write(png),
    width: dimensions.width,
    height: dimensions.height,
    sourceFormat: dimensions.format,
    faceCount: rects.length,
    rects
  };
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

function imageEditReferences(payload = {}) {
  return []
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
    })))
    .concat((payload.backgroundFileIDs || []).filter(Boolean).slice(0, 3).map((fileID, index) => ({
      fileID,
      role: "background",
      index
    })));
}

function imageEditByteLimit(overrides, key, envName, fallback) {
  const raw = hasOwn(overrides, key)
    ? overrides[key]
    : env(envName, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(512 * 1024 * 1024, Math.floor(value)));
}

function resolveImageEditSizeLimits(overrides = {}) {
  const source = overrides && typeof overrides === "object" ? overrides : {};
  return {
    maxAssetBytes: imageEditByteLimit(
      source,
      "maxAssetBytes",
      "AI_IMAGE_EDIT_MAX_ASSET_BYTES",
      IMAGE_EDIT_DEFAULT_MAX_ASSET_BYTES
    ),
    maxTotalAssetBytes: imageEditByteLimit(
      source,
      "maxTotalAssetBytes",
      "AI_IMAGE_EDIT_MAX_TOTAL_ASSET_BYTES",
      IMAGE_EDIT_DEFAULT_MAX_TOTAL_ASSET_BYTES
    ),
    maxRequestBytes: imageEditByteLimit(
      source,
      "maxRequestBytes",
      "AI_IMAGE_EDIT_MAX_REQUEST_BYTES",
      IMAGE_EDIT_DEFAULT_MAX_REQUEST_BYTES
    )
  };
}

function imageEditReferenceLabel(reference = {}) {
  const index = Math.max(0, Number(reference.index) || 0) + 1;
  const labels = {
    identity: "身份参考图",
    face: `人脸参考图第 ${index} 张`,
    wardrobe: `穿搭参考图第 ${index} 张`,
    background: `背景参考图第 ${index} 张`
  };
  return labels[reference.role] || `参考图第 ${index} 张`;
}

function imageEditAssetEntries(mainBuffer, maskBuffer, referenceBuffers = []) {
  return [{
    kind: "main",
    label: "主图",
    buffer: mainBuffer
  }, {
    kind: "mask",
    label: "mask 图片",
    buffer: maskBuffer
  }].concat(
    (Array.isArray(referenceBuffers) ? referenceBuffers : []).map((item, index) => {
      const reference = item && item.reference && typeof item.reference === "object"
        ? item.reference
        : { role: "reference", index };
      return {
        kind: String(reference.role || "reference"),
        label: imageEditReferenceLabel(reference),
        buffer: item && item.buffer
      };
    })
  );
}

function formatImageEditBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) {
    const mib = bytes / 1024 / 1024;
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    const kib = bytes / 1024;
    return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function imageEditSizeLimitError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = 413;
  error.retryable = false;
  Object.assign(error, details);
  return error;
}

function assertImageEditAssetLimits(entries, limits = resolveImageEditSizeLimits()) {
  const normalizedLimits = resolveImageEditSizeLimits(limits);
  const summaries = (Array.isArray(entries) ? entries : []).map((entry) => ({
    kind: String(entry && entry.kind || "image"),
    label: String(entry && entry.label || "图片"),
    bytes: Buffer.isBuffer(entry && entry.buffer) ? entry.buffer.length : 0
  }));
  for (const item of summaries) {
    if (item.bytes > normalizedLimits.maxAssetBytes) {
      throw imageEditSizeLimitError(
        "IMAGE_ASSET_TOO_LARGE",
        `${item.label}太大（${formatImageEditBytes(item.bytes)}），`
          + `单张最多支持 ${formatImageEditBytes(normalizedLimits.maxAssetBytes)}。`
          + "请先压缩图片再重试。",
        {
          assetKind: item.kind,
          assetLabel: item.label,
          imageBytes: item.bytes,
          maxAssetBytes: normalizedLimits.maxAssetBytes
        }
      );
    }
  }
  const totalBytes = summaries.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > normalizedLimits.maxTotalAssetBytes) {
    throw imageEditSizeLimitError(
      "IMAGE_ASSET_TOTAL_TOO_LARGE",
      `这次选择的全部图片加起来有 ${formatImageEditBytes(totalBytes)}，`
        + `最多支持 ${formatImageEditBytes(normalizedLimits.maxTotalAssetBytes)}。`
        + "请减少参考图或先压缩图片。",
      {
        totalAssetBytes: totalBytes,
        maxTotalAssetBytes: normalizedLimits.maxTotalAssetBytes,
        assetCount: summaries.length
      }
    );
  }
  return {
    totalBytes,
    assetCount: summaries.length,
    assets: summaries,
    limits: normalizedLimits
  };
}

function assertImageEditRequestBodySize(body, limits = resolveImageEditSizeLimits()) {
  const normalizedLimits = resolveImageEditSizeLimits(limits);
  const requestBytes = Buffer.isBuffer(body)
    ? body.length
    : Buffer.byteLength(String(body === null || body === undefined ? "" : body));
  if (requestBytes > normalizedLimits.maxRequestBytes) {
    throw imageEditSizeLimitError(
      "IMAGE_REQUEST_TOO_LARGE",
      `图片转成上传数据后有 ${formatImageEditBytes(requestBytes)}，`
        + `超过 ${formatImageEditBytes(normalizedLimits.maxRequestBytes)} 的请求上限。`
        + "请压缩图片或减少参考图后重试。",
      {
        requestBytes,
        maxRequestBytes: normalizedLimits.maxRequestBytes
      }
    );
  }
  return requestBytes;
}

async function requestImageEdits(
  payload,
  apiKey,
  requestId,
  imageConfig = resolveImageConfig(),
  costs = resolveCostConfig(),
  userHash = "anonymous",
  preparedAssets = null,
  requestOptions = {}
) {
  if (!payload.mainFileID || !payload.maskFileID) {
    const error = new Error("编辑模式需要主图和 mask 文件。");
    error.code = "missing-edit-asset";
    throw error;
  }
  const references = imageEditReferences(payload);
  const [mainBuffer, rawMaskBuffer, referenceBuffers] = await Promise.all([
    preparedAssets && Buffer.isBuffer(preparedAssets.mainBuffer)
      ? Promise.resolve(preparedAssets.mainBuffer)
      : downloadCloudFile(payload.mainFileID, {
        requestId,
        action: "generate",
        fileType: "main"
      }),
    preparedAssets && Buffer.isBuffer(preparedAssets.maskBuffer)
      ? Promise.resolve(preparedAssets.maskBuffer)
      : downloadCloudFile(payload.maskFileID, {
        requestId,
        action: "generate",
        fileType: "mask"
      }),
    preparedAssets && Array.isArray(preparedAssets.referenceBuffers)
      ? Promise.resolve(preparedAssets.referenceBuffers)
      : Promise.all(references.map(async (reference) => ({
          reference,
          buffer: await downloadCloudFile(reference.fileID, {
            requestId,
            action: "generate",
            fileType: reference.role
          })
        })))
  ]);
  const sizeLimits = resolveImageEditSizeLimits(requestOptions.sizeLimits);
  assertImageEditAssetLimits(
    imageEditAssetEntries(mainBuffer, rawMaskBuffer, referenceBuffers),
    sizeLimits
  );
  const maskBuffer = invertMask(rawMaskBuffer, requestId);
  const assetSummary = assertImageEditAssetLimits(
    imageEditAssetEntries(mainBuffer, maskBuffer, referenceBuffers),
    sizeLimits
  );

  const mainMime = detectMime(mainBuffer);
  const maskMime = detectMime(maskBuffer);
  const referenceField = env("AI_IMAGE_REFERENCE_FIELD", "image[]");
  const mainField = env("AI_IMAGE_MAIN_FIELD", "image");
  const maskField = env("AI_IMAGE_MASK_FIELD", "mask");
  const fields = buildImageEditFields(payload, imageConfig, references);
  const endpointInfo = resolveImageEditEndpoint(imageConfig);
  const url = endpointInfo.url;
  pixelProtectionFlow.assertSupportedImageEditFlow(imageConfig, url);
  const jsonRequestFormat = imageEditJsonRequestFormat(imageConfig, url);
  const useJsonImageEdit = Boolean(jsonRequestFormat);

  const files = [
    {
      name: mainField,
      filename: `main.${imageExtension(mainMime)}`,
      mime: mainMime,
      buffer: mainBuffer
    },
    {
      name: maskField,
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

  let requestBody;
  let requestHeaders;
  let requestFormat;
  let requestSummary;
  if (useJsonImageEdit) {
    const jsonPayload = buildImageEditJsonPayload(
      payload,
      imageConfig,
      mainBuffer,
      maskBuffer,
      referenceBuffers,
      url
    );
    requestBody = Buffer.from(JSON.stringify(jsonPayload), "utf8");
    requestHeaders = {
      "Content-Type": "application/json",
      "Content-Length": requestBody.length
    };
    requestFormat = jsonRequestFormat;
    requestSummary = imageEditJsonSummary(jsonPayload);
  } else {
    const multipart = createMultipart(fields, files);
    requestBody = multipart.body;
    requestHeaders = {
      "Content-Type": multipart.contentType,
      "Content-Length": multipart.body.length
    };
    requestFormat = "multipart";
    requestSummary = imageEditMultipartSummary(
      fields,
      files,
      mainField,
      maskField
    );
  }
  const requestBytes = assertImageEditRequestBodySize(requestBody, sizeLimits);
  const requestLogFields = useJsonImageEdit
    ? { json: requestSummary }
    : { multipart: requestSummary };
  log("info", "image-edit.request", {
    requestId,
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    endpoint: safeUrl(url),
    endpointSource: endpointInfo.source,
    requestFormat,
    generationEndpoint: safeEndpointUrl(
      imageConfig.baseUrl,
      imageConfig.endpoint,
      "images/generations"
    ),
    ...requestLogFields,
    mainImagePresent: Boolean(mainBuffer && mainBuffer.length),
    maskPresent: Boolean(maskBuffer && maskBuffer.length),
    referenceCount: referenceBuffers.length,
    assetBytes: assetSummary.totalBytes,
    requestBytes,
    maxAssetBytes: sizeLimits.maxAssetBytes,
    maxTotalAssetBytes: sizeLimits.maxTotalAssetBytes,
    maxRequestBytes: sizeLimits.maxRequestBytes
  });
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: {
      ...requestHeaders,
      ...apiKeyHeaders(apiKey),
      "Idempotency-Key": requestOptions.idempotencyKey || requestId
    }
  }, requestBody, {
    requestId: requestOptions.usageRequestId || requestId,
    action: payload.__action || "repairImage",
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    imageGeneration: true,
    imageEdit: true,
    allowRetry: hasOwn(requestOptions, "allowRetry")
      ? Boolean(requestOptions.allowRetry)
      : imageConfig.retryEnabled,
    maxAttempts: hasOwn(requestOptions, "maxAttempts")
      ? Math.max(1, Number(requestOptions.maxAttempts) || 1)
      : imageConfig.retryEnabled
        ? imageConfig.maxRetries + 1
        : 1,
    timeoutMs: imageConfig.timeoutMs,
    costs,
    userHash,
    imageResolution: imageConfig.resolution || payload.size
  });
  if (response.status < 200 || response.status >= 300) {
    const classification = response.imageEditClassification
      || classifyImageEditResponse(response);
    log("error", "image-edit.upstream-error", {
      requestId,
      provider: imageConfig.provider || "",
      model: imageConfig.model || "",
      endpoint: safeUrl(url),
      status: response.status,
      classification: classification.code,
      upstreamCode: classification.upstreamCode,
      upstreamMessage: classification.upstreamMessage,
      retryable: classification.retryable,
      requestFormat,
      ...requestLogFields
    });
    throw imageUpstreamError(response, "图片编辑接口请求失败", {
      imageEdit: true
    });
  }
  log("info", "image-edit.success", {
    requestId,
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    endpoint: safeUrl(url),
    status: response.status,
    requestFormat,
    ...requestLogFields
  });
  return response.json || {};
}

function tencentTc3Date(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest("hex");
}

function buildTencentTc3Headers(config, payload) {
  const host = "facefusion.tencentcloudapi.com";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = tencentTc3Date(timestamp);
  const canonicalHeaders = [
    "content-type:application/json; charset=utf-8",
    `host:${host}`,
    `x-tc-action:${config.action.toLowerCase()}`
  ].join("\n") + "\n";
  const signedHeaders = "content-type;host;x-tc-action";
  const hashedPayload = crypto.createHash("sha256").update(payload).digest("hex");
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join("\n");
  const credentialScope = `${date}/${"facefusion"}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");
  const secretDate = crypto.createHmac("sha256", `TC3${config.secretKey}`)
    .update(date)
    .digest();
  const secretService = crypto.createHmac("sha256", secretDate)
    .update("facefusion")
    .digest();
  const secretSigning = crypto.createHmac("sha256", secretService)
    .update("tc3_request")
    .digest();
  const signature = crypto.createHmac("sha256", secretSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": config.action,
    "X-TC-Version": config.apiVersion,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Region": config.region,
    Authorization: [
      "TC3-HMAC-SHA256",
      `Credential=${config.secretId}/${credentialScope}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signature}`
    ].join(" ")
  };
}

function tencentFaceFusionError(response) {
  const result = response && response.json && response.json.Response
    ? response.json.Response
    : response && response.json || {};
  const detail = result.Error || result.error || {};
  const message = detail.Message || detail.message || result.Message
    || response && response.raw
    || `腾讯人脸融合请求失败：HTTP ${response && response.status || 0}`;
  const error = new Error(String(message));
  error.code = detail.Code || detail.code || "TENCENT_FACEFUSION_FAILED";
  error.status = Number(response && response.status) || 0;
  error.retryable = shouldRetryStatus(error.status) || /timeout|限流|频繁|busy/i.test(error.message);
  error.payload = response && response.json;
  return error;
}

async function requestTencentFaceFusion(modelBuffer, faceBuffer, config, requestId) {
  pixelProtectionFlow.assertTencentFaceFusionFlow(config);
  if (!Buffer.isBuffer(modelBuffer) || !modelBuffer.length) {
    const error = new Error("腾讯换脸模板图为空。");
    error.code = "TENCENT_TEMPLATE_IMAGE_EMPTY";
    throw error;
  }
  if (!Buffer.isBuffer(faceBuffer) || !faceBuffer.length) {
    const error = new Error("腾讯换脸参考脸为空。");
    error.code = "TENCENT_FACE_IMAGE_EMPTY";
    throw error;
  }
  if (modelBuffer.length > config.maxImageBytes || faceBuffer.length > config.maxImageBytes) {
    const error = new Error(
      `腾讯人脸融合要求图片较小，模板图和参考脸都不能超过 ${Math.round(config.maxImageBytes / 1024 / 1024)}MB。`
    );
    error.code = "TENCENT_FACEFUSION_IMAGE_TOO_LARGE";
    throw error;
  }
  const body = JSON.stringify({
    RspImgType: "base64",
    ModelImage: modelBuffer.toString("base64"),
    MergeInfos: [{
      Image: faceBuffer.toString("base64")
    }],
    SwapModelType: config.swapModelType,
    LogoAdd: config.logoAdd ? 1 : 0
  });
  const response = await requestWithRetry(
    config.endpoint,
    {
      method: "POST",
      headers: Object.assign(
        { "Content-Length": Buffer.byteLength(body) },
        buildTencentTc3Headers(config, body)
      )
    },
    body,
    {
      requestId,
      action: "tencent.facefusion",
      provider: "tencent",
      model: config.model,
      timeoutMs: config.timeoutMs,
      allowRetry: true,
      maxAttempts: 2
    }
  );
  const responseRoot = response && response.json && response.json.Response
    ? response.json.Response
    : response && response.json || {};
  if (
    response.status < 200
    || response.status >= 300
    || responseRoot.Error
    || responseRoot.error
  ) {
    throw tencentFaceFusionError(response);
  }
  // FuseFaceUltra 的官方返回字段是 FusedImage。保留旧字段兼容，
  // 防止不同版本/模拟接口返回 ResultImage 或 URL 时再次误判为空。
  const resultImage = responseRoot.FusedImage
    || responseRoot.fusedImage
    || responseRoot.ResultImage
    || responseRoot.Result
    || responseRoot.resultImage
    || responseRoot.ResultUrl
    || responseRoot.ResultURL;
  if (!resultImage) {
    const returnedKeys = responseRoot && typeof responseRoot === "object"
      ? Object.keys(responseRoot).slice(0, 20).join(", ")
      : "";
    log("warn", "tencent.facefusion.empty-result", {
      requestId,
      returnedKeys
    });
    const error = new Error(
      returnedKeys
        ? `腾讯人脸融合返回成功，但没有识别到图片字段（返回字段：${returnedKeys}）。`
        : "腾讯人脸融合没有返回最终图片。"
    );
    error.code = "TENCENT_FACEFUSION_EMPTY_RESULT";
    throw error;
  }
  const resultText = String(resultImage).trim();
  if (/^https?:\/\//i.test(resultText)) {
    return downloadUrl(resultText, {
      requestId,
      action: "tencent.facefusion-result"
    });
  }
  const base64 = resultText
    .replace(/^data:image\/[^;]+;base64,/i, "")
    .replace(/\s/g, "");
  const resultBuffer = Buffer.from(base64, "base64");
  if (!resultBuffer.length) {
    const error = new Error("腾讯人脸融合返回了空图片内容。");
    error.code = "TENCENT_FACEFUSION_EMPTY_IMAGE";
    throw error;
  }
  return resultBuffer;
}

async function requestTencentPipelineImageEdit(
  mainBuffer,
  payload,
  imageConfig,
  costs,
  requestId,
  userHash,
  maskBuffer,
  requestOptions = {}
) {
  if (!Buffer.isBuffer(maskBuffer) || !maskBuffer.length) {
    throw tencentPipelineMaskError(
      "腾讯版第一阶段缺少真实脸部保护 mask，已停止图片编辑。",
      "TENCENT_PIPELINE_MASK_REQUIRED"
    );
  }
  const sizeLimits = resolveImageEditSizeLimits(requestOptions.sizeLimits);
  assertImageEditAssetLimits(
    imageEditAssetEntries(mainBuffer, maskBuffer),
    sizeLimits
  );
  const preparedMaskBuffer = invertMask(maskBuffer, requestId);
  const assetSummary = assertImageEditAssetLimits(
    imageEditAssetEntries(mainBuffer, preparedMaskBuffer),
    sizeLimits
  );
  const mainDimensions = readImageDimensions(mainBuffer);
  let maskDimensions;
  try {
    maskDimensions = readImageDimensions(preparedMaskBuffer);
  } catch (_) {
    throw tencentPipelineMaskError("脸部保护 mask 不是有效图片，已停止图片编辑。");
  }
  if (
    mainDimensions.width !== maskDimensions.width
    || mainDimensions.height !== maskDimensions.height
  ) {
    throw tencentPipelineMaskError(
      `脸部保护 mask 尺寸 ${maskDimensions.width}x${maskDimensions.height}`
      + ` 与主图 ${mainDimensions.width}x${mainDimensions.height} 不一致。`
    );
  }
  const pipelinePayload = Object.assign({}, payload, {
    prompt: [
      String(payload.prompt || "").trim(),
      "第一阶段只修改衣服、背景和整体光影。",
      "脸部区域已经由 mask 保护，严禁重绘脸部、五官、发型和肤色。",
      "保留人物身份、姿态、构图和画面比例，先不要换脸，最后一步会由腾讯云完成换脸。"
    ].filter(Boolean).join("\n")
  });
  const fields = buildImageEditFields(pipelinePayload, imageConfig, []);
  const mainMime = detectMime(mainBuffer);
  const maskMime = detectMime(preparedMaskBuffer);
  const mainField = env("AI_IMAGE_MAIN_FIELD", "image");
  const maskField = env("AI_IMAGE_MASK_FIELD", "mask");
  const endpointInfo = resolveImageEditEndpoint(imageConfig);
  pixelProtectionFlow.assertSupportedImageEditFlow(imageConfig, endpointInfo.url);
  const jsonRequestFormat = imageEditJsonRequestFormat(
    imageConfig,
    endpointInfo.url
  );
  const useJsonImageEdit = Boolean(jsonRequestFormat);
  let requestBody;
  let requestHeaders;
  let requestFormat;
  let requestSummary;
  if (useJsonImageEdit) {
    const jsonPayload = buildImageEditJsonPayload(
      pipelinePayload,
      imageConfig,
      mainBuffer,
      preparedMaskBuffer,
      [],
      endpointInfo.url
    );
    requestBody = Buffer.from(JSON.stringify(jsonPayload), "utf8");
    requestHeaders = {
      "Content-Type": "application/json",
      "Content-Length": requestBody.length
    };
    requestFormat = jsonRequestFormat;
    requestSummary = imageEditJsonSummary(jsonPayload);
  } else {
    const files = [{
      name: mainField,
      filename: `main.${imageExtension(mainMime)}`,
      mime: mainMime,
      buffer: mainBuffer
    }, {
      name: maskField,
      filename: "mask.png",
      mime: maskMime,
      buffer: preparedMaskBuffer
    }];
    const multipart = createMultipart(fields, files);
    requestBody = multipart.body;
    requestHeaders = {
      "Content-Type": multipart.contentType,
      "Content-Length": multipart.body.length
    };
    requestFormat = "multipart";
    requestSummary = imageEditMultipartSummary(fields, files, mainField, maskField);
  }
  const requestBytes = assertImageEditRequestBodySize(requestBody, sizeLimits);
  const requestLogFields = useJsonImageEdit
    ? { json: requestSummary }
    : { multipart: requestSummary };
  log("info", "tencent.pipeline.image-edit.request", {
    requestId,
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    endpoint: safeUrl(endpointInfo.url),
    endpointSource: endpointInfo.source,
    requestFormat,
    ...requestLogFields,
    mainImagePresent: true,
    maskPresent: true,
    mainSize: `${mainDimensions.width}x${mainDimensions.height}`,
    maskSize: `${maskDimensions.width}x${maskDimensions.height}`,
    maskSha256: crypto.createHash("sha256").update(preparedMaskBuffer).digest("hex").slice(0, 16),
    assetBytes: assetSummary.totalBytes,
    requestBytes,
    maxAssetBytes: sizeLimits.maxAssetBytes,
    maxTotalAssetBytes: sizeLimits.maxTotalAssetBytes,
    maxRequestBytes: sizeLimits.maxRequestBytes
  });
  const response = await requestWithRetry(
    endpointInfo.url,
    {
      method: "POST",
      headers: {
        ...requestHeaders,
        ...apiKeyHeaders(imageConfig.apiKey),
        "Idempotency-Key": requestOptions.idempotencyKey || requestId
      }
    },
    requestBody,
    {
      requestId: requestOptions.usageRequestId || requestId,
      action: "tencent.pipeline.image-edit",
      provider: imageConfig.provider || "",
      model: imageConfig.model || "",
      imageGeneration: true,
      imageEdit: true,
      allowRetry: hasOwn(requestOptions, "allowRetry")
        ? Boolean(requestOptions.allowRetry)
        : imageConfig.retryEnabled,
      maxAttempts: hasOwn(requestOptions, "maxAttempts")
        ? Math.max(1, Number(requestOptions.maxAttempts) || 1)
        : imageConfig.retryEnabled
          ? imageConfig.maxRetries + 1
          : 1,
      timeoutMs: imageConfig.timeoutMs,
      costs,
      userHash,
      imageResolution: imageConfig.resolution || payload.size
    }
  );
  if (response.status < 200 || response.status >= 300) {
    const classification = response.imageEditClassification
      || classifyImageEditResponse(response);
    log("error", "tencent.pipeline.image-edit.upstream-error", {
      requestId,
      provider: imageConfig.provider || "",
      model: imageConfig.model || "",
      endpoint: safeUrl(endpointInfo.url),
      status: response.status,
      classification: classification.code,
      upstreamCode: classification.upstreamCode,
      upstreamMessage: classification.upstreamMessage,
      retryable: classification.retryable,
      requestFormat,
      ...requestLogFields
    });
    throw imageUpstreamError(response, "GPT Image 2 图片修改失败", { imageEdit: true });
  }
  log("info", "tencent.pipeline.image-edit.success", {
    requestId,
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    endpoint: safeUrl(endpointInfo.url),
    status: response.status,
    requestFormat,
    ...requestLogFields
  });
  return response.json || {};
}

function imageProviderAttemptStage(attempt = {}) {
  if (attempt.role === "backup") return "image-edit-backup";
  return Number(attempt.attempt) > 1
    ? "image-edit-primary-retry"
    : "image-edit-primary";
}

function imageProviderAttemptProgress(attempt = {}) {
  if (attempt.role === "backup") return 52;
  return Number(attempt.attempt) > 1 ? 44 : 35;
}

async function updateImageProviderAttemptOperation(
  openid,
  requestId,
  patch,
  eventName
) {
  if (!openid || !requestId) return null;
  try {
    return await updateGenerationOperation(openid, requestId, patch, {
      allowedStatuses: ["processing"]
    });
  } catch (error) {
    log("warn", eventName || "image-provider.operation-update-failed", {
      requestId,
      error: sanitizeFailureMessage(error && error.message)
    });
    return null;
  }
}

async function runImageEditProviderFailover(options = {}) {
  const requestId = String(options.requestId || "").trim();
  const openid = String(options.openid || "").trim();
  const attemptSummaries = [];
  return imageProviderFailover.runImageProviderFailover({
    requestId,
    primaryConfig: options.primaryConfig,
    backupConfig: options.backupConfig,
    onAttemptStart: async (attempt) => {
      const stage = imageProviderAttemptStage(attempt);
      await updateImageProviderAttemptOperation(openid, requestId, {
        pipelineStage: stage,
        progress: imageProviderAttemptProgress(attempt),
        activeImageProvider: attempt.config.provider || "",
        activeImageModel: attempt.config.model || "",
        imageProviderRole: attempt.role,
        imageProviderAttempt: attempt.attempt,
        imageProviderAttempts: attemptSummaries.slice(),
        lastHeartbeatAt: new Date()
      }, "image-provider.attempt-start-update-failed");
      log("info", "image-provider.attempt-start", {
        requestId,
        role: attempt.role,
        attempt: attempt.attempt,
        provider: attempt.config.provider || "",
        model: attempt.config.model || "",
        timeoutMs: Number(attempt.config.timeoutMs) || 0
      });
      if (typeof options.onAttemptStart === "function") {
        await options.onAttemptStart(attempt);
      }
    },
    onAttemptFinish: async (summary, attempt) => {
      attemptSummaries.push(summary);
      await updateImageProviderAttemptOperation(openid, requestId, {
        pipelineStage: imageProviderAttemptStage(attempt),
        progress: imageProviderAttemptProgress(attempt),
        activeImageProvider: attempt.config.provider || "",
        activeImageModel: attempt.config.model || "",
        imageProviderRole: attempt.role,
        imageProviderAttempt: attempt.attempt,
        imageProviderAttempts: attemptSummaries.slice(),
        lastProviderError: summary.success
          ? null
          : {
              code: summary.code,
              message: summary.message,
              status: summary.status,
              retryable: summary.retryable
            },
        lastHeartbeatAt: new Date()
      }, "image-provider.attempt-finish-update-failed");
      log(summary.success ? "info" : "warn", "image-provider.attempt-finish", {
        requestId,
        role: summary.role,
        attempt: summary.attempt,
        provider: summary.provider,
        model: summary.model,
        success: summary.success,
        status: summary.status,
        code: summary.code,
        retryable: summary.retryable,
        durationMs: summary.durationMs
      });
      await recordImageProviderAttemptEvent({
        requestId,
        openid,
        action: options.action || "generate",
        pipeline: options.pipeline || "image-edit",
        role: summary.role,
        attempt: summary.attempt,
        provider: summary.provider,
        model: summary.model,
        success: summary.success,
        status: summary.status,
        code: summary.code,
        category: summary.category,
        retryable: summary.retryable,
        durationMs: summary.durationMs,
        errorMessage: summary.message
      });
      if (typeof options.onAttemptFinish === "function") {
        await options.onAttemptFinish(summary, attempt);
      }
    },
    executeAttempt: options.executeAttempt
  });
}

function normalizeImageProviderAttemptEvent(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const createdAt = source.createdAt instanceof Date
    ? source.createdAt
    : new Date(source.createdAt || Date.now());
  const safeCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
  const role = source.role === "backup" ? "backup" : "primary";
  const success = Boolean(source.success);
  return {
    requestId: compactUsageText(source.requestId, 120)
      .replace(/[^A-Za-z0-9._:-]+/g, "-"),
    userHash: compactUsageText(source.userHash, 40)
      || usageUserHash(source.openid),
    action: compactUsageText(source.action, 40) || "generate",
    pipeline: compactUsageText(source.pipeline, 60) || "image-edit",
    role,
    attempt: Math.max(1, Math.round(Number(source.attempt) || 1)),
    provider: compactUsageText(source.provider, 80),
    model: compactUsageText(source.model, 120),
    success,
    status: Math.max(0, Number(source.status) || 0),
    code: success
      ? ""
      : normalizeFailureCode(source.code, source.status),
    category: success ? "" : compactUsageText(source.category, 40),
    retryable: !success && Boolean(source.retryable),
    durationMs: Math.max(
      0,
      Math.min(900000, Math.round(Number(source.durationMs) || 0))
    ),
    errorMessage: success
      ? ""
      : sanitizeFailureMessage(source.errorMessage || source.message),
    switchedToBackup: role === "backup",
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(String(source.dateKey || ""))
      ? String(source.dateKey)
      : dateKeyForTimeZone(safeCreatedAt, IMAGE_PROVIDER_ATTEMPT_TIME_ZONE),
    createdAt: safeCreatedAt
  };
}

async function recordImageProviderAttemptEvent(value = {}) {
  const event = normalizeImageProviderAttemptEvent(value);
  if (!event) return false;
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    imageProviderAttemptTestEvents.push(event);
    return true;
  }
  try {
    await db.collection(IMAGE_PROVIDER_ATTEMPT_EVENT_COLLECTION).add({
      data: event
    });
    return true;
  } catch (error) {
    // 统计写入失败不能让图片生成失败。
    log("warn", "image-provider-attempt.write-failed", {
      requestId: event.requestId,
      role: event.role,
      provider: event.provider,
      model: event.model,
      error: error && error.message
    });
    return false;
  }
}

function emptyImageProviderAttemptCounter() {
  return {
    calls: 0,
    success: 0,
    failure: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    averageDurationText: "0 秒",
    provider: "",
    model: ""
  };
}

function addImageProviderAttemptCounter(counter, event) {
  if (!counter || !event) return;
  counter.calls += 1;
  if (event.success) counter.success += 1;
  else counter.failure += 1;
  counter.totalDurationMs += Math.max(0, Number(event.durationMs) || 0);
  if (!counter.provider && event.provider) counter.provider = event.provider;
  if (!counter.model && event.model) counter.model = event.model;
}

function finalizeImageProviderAttemptCounter(counter) {
  const value = Object.assign(
    emptyImageProviderAttemptCounter(),
    counter || {}
  );
  value.calls = Math.max(0, Number(value.calls) || 0);
  value.success = Math.max(0, Number(value.success) || 0);
  value.failure = Math.max(0, Number(value.failure) || 0);
  value.totalDurationMs = Math.max(0, Number(value.totalDurationMs) || 0);
  value.averageDurationMs = value.calls
    ? Math.round(value.totalDurationMs / value.calls)
    : 0;
  value.averageDurationText = `${(value.averageDurationMs / 1000).toFixed(1)} 秒`;
  return value;
}

function loadImageProviderAttemptEvents(startKey) {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return Promise.resolve(imageProviderAttemptTestEvents.slice());
  }
  return (async () => {
    const events = [];
    const pageSize = 100;
    let offset = 0;
    const command = db.command;
    while (offset < IMAGE_PROVIDER_ATTEMPT_MAX_READ) {
      const result = await db
        .collection(IMAGE_PROVIDER_ATTEMPT_EVENT_COLLECTION)
        .where({ dateKey: command.gte(startKey) })
        .skip(offset)
        .limit(Math.min(pageSize, IMAGE_PROVIDER_ATTEMPT_MAX_READ - offset))
        .get();
      const rows = result && Array.isArray(result.data) ? result.data : [];
      events.push(...rows);
      if (rows.length < pageSize) break;
      offset += rows.length;
    }
    return events;
  })();
}

function aggregateImageProviderAttemptEvents(
  events = [],
  days = 30,
  now = new Date()
) {
  const rangeDays = Math.max(1, Math.min(90, Number(days) || 30));
  const todayKey = dateKeyForTimeZone(now, IMAGE_PROVIDER_ATTEMPT_TIME_ZONE);
  const startKey = shiftDateKey(todayKey, -(rangeDays - 1));
  const dailyMap = {};
  for (let offset = 0; offset < rangeDays; offset += 1) {
    const dateKey = shiftDateKey(todayKey, -offset);
    dailyMap[dateKey] = {
      dateKey,
      totalAttempts: 0,
      primaryCalls: 0,
      primarySuccess: 0,
      primaryFailure: 0,
      backupCalls: 0,
      backupSuccess: 0,
      backupFailure: 0,
      switchCount: 0
    };
  }
  const primary = emptyImageProviderAttemptCounter();
  const backup = emptyImageProviderAttemptCounter();
  const requestMap = new Map();
  const recentFailures = [];
  (Array.isArray(events) ? events : []).forEach((source, index) => {
    const event = normalizeImageProviderAttemptEvent(source);
    if (
      !event
      || event.dateKey < startKey
      || event.dateKey > todayKey
    ) {
      return;
    }
    const requestKey = event.requestId
      || `${event.dateKey}:${event.userHash}:${index}`;
    if (!requestMap.has(requestKey)) {
      requestMap.set(requestKey, []);
    }
    requestMap.get(requestKey).push(event);
    if (event.role === "backup") addImageProviderAttemptCounter(backup, event);
    else addImageProviderAttemptCounter(primary, event);
    const daily = dailyMap[event.dateKey];
    if (daily) {
      daily.totalAttempts += 1;
      if (event.role === "backup") {
        daily.backupCalls += 1;
        if (event.success) daily.backupSuccess += 1;
        else daily.backupFailure += 1;
      } else {
        daily.primaryCalls += 1;
        if (event.success) daily.primarySuccess += 1;
        else daily.primaryFailure += 1;
      }
    }
    if (!event.success) {
      recentFailures.push({
        dateKey: event.dateKey,
        createdAt: event.createdAt instanceof Date
          ? event.createdAt.toISOString()
          : String(event.createdAt || ""),
        role: event.role,
        attempt: event.attempt,
        provider: event.provider,
        model: event.model,
        code: event.code,
        category: event.category,
        message: event.errorMessage || "未提供错误原因",
        status: event.status,
        retryable: event.retryable,
        durationMs: event.durationMs
      });
    }
  });

  let switchCount = 0;
  let finalBackupSuccessCount = 0;
  requestMap.forEach((attempts) => {
    const ordered = attempts.slice().sort((left, right) => {
      const timeDiff = new Date(left.createdAt || 0).getTime()
        - new Date(right.createdAt || 0).getTime();
      return timeDiff || left.attempt - right.attempt;
    });
    const backupAttempt = ordered.find((item) => item.role === "backup");
    if (backupAttempt) {
      switchCount += 1;
      const daily = dailyMap[backupAttempt.dateKey];
      if (daily) daily.switchCount += 1;
    }
    const last = ordered[ordered.length - 1];
    if (last && last.role === "backup" && last.success) {
      finalBackupSuccessCount += 1;
    }
  });

  const totalRequests = requestMap.size;
  const switchRate = totalRequests
    ? Number((switchCount / totalRequests * 100).toFixed(2))
    : 0;
  return {
    timeZone: IMAGE_PROVIDER_ATTEMPT_TIME_ZONE,
    days: rangeDays,
    todayKey,
    totalRequests,
    totalAttempts: primary.calls + backup.calls,
    primary: finalizeImageProviderAttemptCounter(primary),
    backup: finalizeImageProviderAttemptCounter(backup),
    switchCount,
    switchRate,
    switchRateText: `${switchRate}%`,
    finalBackupSuccessCount,
    recentFailures: recentFailures
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, 20),
    daily: Object.values(dailyMap)
      .sort((left, right) => right.dateKey.localeCompare(left.dateKey)),
    eventCount: primary.calls + backup.calls,
    truncated: Array.isArray(events) && events.length >= IMAGE_PROVIDER_ATTEMPT_MAX_READ,
    unavailable: false,
    message: ""
  };
}

async function getImageProviderFailoverStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const days = Math.max(1, Math.min(90, Number(event && event.days) || 30));
  const todayKey = dateKeyForTimeZone(new Date(), IMAGE_PROVIDER_ATTEMPT_TIME_ZONE);
  const startKey = shiftDateKey(todayKey, -(days - 1));
  try {
    const events = await loadImageProviderAttemptEvents(startKey);
    return jsonResponse(true, aggregateImageProviderAttemptEvents(events, days));
  } catch (error) {
    log("warn", "image-provider-attempt.read-failed", {
      startKey,
      days,
      error: error && error.message
    });
    const empty = aggregateImageProviderAttemptEvents([], days);
    return jsonResponse(true, Object.assign(empty, {
      unavailable: true,
      message: "主备切换统计暂时读取失败，请稍后刷新。"
    }));
  }
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

function normalGenerationRecordId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`generation-record:${openid}:${requestId}`)
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

function userProfileId(openid) {
  return crypto.createHash("sha256")
    .update(`user-profile:${openid}`)
    .digest("hex")
    .slice(0, 32);
}

function normalizeUserGender(value) {
  const gender = String(value || "").trim().toLowerCase();
  return gender === "male" || gender === "female" ? gender : "";
}

function normalizeUserNickname(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

function normalizeAdminUserSearch(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .toLowerCase();
}

function normalizeAdminUserDateRange(value) {
  const dateRange = String(value || "").trim().toLowerCase();
  return ADMIN_USER_DATE_RANGES.has(dateRange) ? dateRange : "all";
}

function normalizeAdminUserGenderFilter(value) {
  const gender = String(value || "").trim().toLowerCase();
  return ADMIN_USER_GENDERS.has(gender) ? gender : "all";
}

function normalizeAdminUserDateKey(value) {
  const dateKey = String(value || "").trim();
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const normalized = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  ));
  return Number.isNaN(normalized.getTime())
    || normalized.toISOString().slice(0, 10) !== dateKey
    ? ""
    : dateKey;
}

function adminUserHash(source = {}) {
  return compactUsageText(source.userHash, 40) || usageUserHash(source.openid);
}

function adminUserCreatedDateKey(source = {}) {
  const createdAt = source.createdAt instanceof Date
    ? source.createdAt
    : new Date(source.createdAt || 0);
  return Number.isNaN(createdAt.getTime())
    ? ""
    : dateKeyForTimeZone(createdAt, POINTS_TIME_ZONE);
}

function adminUserDateRangeStart(dateRange, todayKey) {
  if (dateRange === "today") return todayKey;
  if (dateRange === "7d") return shiftDateKey(todayKey, -6);
  if (dateRange === "30d") return shiftDateKey(todayKey, -29);
  return "";
}

function filterAdminUserProfiles(rows = [], options = {}, baseDate = new Date()) {
  const search = normalizeAdminUserSearch(options.search);
  const dateRange = normalizeAdminUserDateRange(options.dateRange);
  const gender = normalizeAdminUserGenderFilter(options.gender);
  const normalizedBaseDate = baseDate instanceof Date ? baseDate : new Date(baseDate || Date.now());
  const todayKey = dateKeyForTimeZone(
    Number.isNaN(normalizedBaseDate.getTime()) ? new Date() : normalizedBaseDate,
    POINTS_TIME_ZONE
  );
  let startKey = adminUserDateRangeStart(dateRange, todayKey);
  let endKey = startKey ? todayKey : "";
  if (dateRange === "custom") {
    const rawStart = normalizeAdminUserDateKey(options.startDate) || shiftDateKey(todayKey, -6);
    const rawEnd = normalizeAdminUserDateKey(options.endDate) || todayKey;
    const limitedStart = rawStart > todayKey ? todayKey : rawStart;
    const limitedEnd = rawEnd > todayKey ? todayKey : rawEnd;
    startKey = limitedStart <= limitedEnd ? limitedStart : limitedEnd;
    endKey = limitedStart <= limitedEnd ? limitedEnd : limitedStart;
  }
  const filteredRows = normalizeAdminUserProfileRows(rows).filter((item) => {
    if (startKey) {
      const createdDateKey = adminUserCreatedDateKey(item);
      if (!createdDateKey || createdDateKey < startKey || createdDateKey > endKey) {
        return false;
      }
    }
    if (gender !== "all" && item.gender !== gender) return false;
    if (!search) return true;
    const nickname = normalizeUserNickname(item.nickname).toLowerCase();
    return nickname.includes(search) || adminUserHash(item).toLowerCase().includes(search);
  });
  return {
    rows: filteredRows,
    search,
    dateRange,
    gender,
    startDate: dateRange === "custom" ? startKey : "",
    endDate: dateRange === "custom" ? endKey : "",
    todayKey
  };
}

function buildAdminUserSignupTrend(rows = [], baseDate = new Date(), days = ADMIN_USER_TREND_DAYS) {
  const safeDays = Math.max(1, Math.min(30, Number(days) || ADMIN_USER_TREND_DAYS));
  const normalizedBaseDate = baseDate instanceof Date ? baseDate : new Date(baseDate || Date.now());
  const todayKey = dateKeyForTimeZone(
    Number.isNaN(normalizedBaseDate.getTime()) ? new Date() : normalizedBaseDate,
    POINTS_TIME_ZONE
  );
  const firstKey = shiftDateKey(todayKey, -(safeDays - 1));
  const counts = {};
  normalizeAdminUserProfileRows(rows).forEach((item) => {
    const dateKey = adminUserCreatedDateKey(item);
    if (dateKey && dateKey >= firstKey && dateKey <= todayKey) {
      counts[dateKey] = (counts[dateKey] || 0) + 1;
    }
  });
  const trend = [];
  for (let index = -(safeDays - 1); index <= 0; index += 1) {
    const dateKey = shiftDateKey(todayKey, index);
    trend.push({
      dateKey,
      count: counts[dateKey] || 0
    });
  }
  return trend;
}

function userProfileView(source = {}) {
  const gender = normalizeUserGender(source.gender);
  return {
    userHash: adminUserHash(source),
    nickname: normalizeUserNickname(source.nickname),
    avatarFileID: compactUsageText(source.avatarFileID, 500),
    avatarUrl: compactUsageText(source.avatarFileID, 500),
    gender,
    genderText: gender === "male" ? "男" : gender === "female" ? "女" : "",
    createdAt: source.createdAt ? new Date(source.createdAt).toISOString() : "",
    updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : ""
  };
}

function buildAdminUserStats(rows = [], offset = 0, limit = 20, options = {}) {
  const baseDate = options.baseDate instanceof Date
    ? options.baseDate
    : new Date(options.baseDate || Date.now());
  const filtered = filterAdminUserProfiles(rows, options, baseDate);
  const valid = filtered.rows;
  const maleCount = valid.filter((item) => item.gender === "male").length;
  const femaleCount = valid.filter((item) => item.gender === "female").length;
  const total = maleCount + femaleCount;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const maleRatio = total ? Math.round(maleCount / total * 1000) / 10 : 0;
  const femaleRatio = total ? Math.round((100 - maleRatio) * 10) / 10 : 0;
  const users = valid
    .slice(safeOffset, safeOffset + safeLimit)
    .map(userProfileView);
  return {
    total,
    maleCount,
    femaleCount,
    maleRatio,
    femaleRatio,
    users,
    offset: safeOffset,
    limit: safeLimit,
    search: filtered.search,
    dateRange: filtered.dateRange,
    gender: filtered.gender,
    startDate: filtered.startDate,
    endDate: filtered.endDate,
    signupTrend: buildAdminUserSignupTrend(rows, baseDate),
    nextOffset: safeOffset + users.length < total
      ? safeOffset + users.length
      : null
  };
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

function stripDocumentId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = Object.assign({}, value);
  delete result._id;
  return result;
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
  await db
    .collection(ASSET_UPLOAD_TICKET_COLLECTION)
    .doc(data._id)
    .set({ data: stripDocumentId(data) });
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
      temporary: Boolean(event.temporary),
      createdAt: existing && existing.createdAt || new Date(),
      updatedAt: new Date()
    });
    await assetRef.set({ data: stripDocumentId(next) });
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

function publishExportJobId(openid, fileID, recordId, options) {
  return crypto.createHash("sha256")
    .update([
      "publish-export",
      String(openid || ""),
      String(fileID || ""),
      String(recordId || ""),
      publishExportCore.optionsHashPayload(options)
    ].join(":"))
    .digest("hex")
    .slice(0, 32);
}

function publishExportDate(value, fallback = null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : fallback;
}

function publishExportError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (retryable) error.status = 409;
  return error;
}

async function resolvePublishExportSource(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    throw publishExportError("请先完成微信授权后再导出图片。", "wechat-binding-required");
  }
  const recordId = String(event && event.recordId || "").trim();
  let fileID = String(event && event.fileID || "").trim();
  let record = null;

  if (recordId) {
    record = await readGenerationRecord(recordId);
    if (!record || record.openid !== openid) {
      throw publishExportError("找不到这条制作记录，或记录不属于当前用户。", "publish-export-record-forbidden");
    }
    if (record.isTombstone) {
      throw publishExportError("这条制作记录已经删除，不能继续导出。", "publish-export-record-deleted");
    }
    const recordFileID = String(record.fileID || "").trim();
    if (!recordFileID) {
      throw publishExportError("这条制作记录没有可导出的原图。", "publish-export-source-missing");
    }
    if (fileID && fileID !== recordFileID) {
      throw publishExportError("导出文件与制作记录不匹配。", "publish-export-file-mismatch");
    }
    fileID = recordFileID;
  } else {
    if (!/^cloud:\/\//i.test(fileID)) {
      throw publishExportError("临时导出文件必须是 cloud:// fileID。", "publish-export-file-invalid");
    }
    await findUserAsset(openid, fileID, "");
  }

  if (!/^cloud:\/\//i.test(fileID)) {
    throw publishExportError("导出源文件不是有效的云文件。", "publish-export-file-invalid");
  }
  if (event && event.temporaryInput && recordId) {
    throw publishExportError("制作记录不能标记为临时上传文件。", "publish-export-temporary-mismatch");
  }
  return {
    openid,
    recordId,
    fileID,
    record,
    temporaryInput: Boolean(event && event.temporaryInput) && !recordId
  };
}

function readJpegOrientation(buffer) {
  const source = Buffer.from(buffer || []);
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= source.length) {
    if (source[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = source[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = source.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > source.length) break;
    if (marker === 0xe1 && length >= 8) {
      const exifStart = offset + 4;
      if (source.toString("ascii", exifStart, exifStart + 6) !== "Exif\u0000\u0000") {
        offset += 2 + length;
        continue;
      }
      const tiff = exifStart + 6;
      const littleEndian = source.toString("ascii", tiff, tiff + 2) === "II";
      const read16 = (position) => littleEndian
        ? source.readUInt16LE(position)
        : source.readUInt16BE(position);
      const read32 = (position) => littleEndian
        ? source.readUInt32LE(position)
        : source.readUInt32BE(position);
      if (read16(tiff + 2) !== 42) return 1;
      const ifdOffset = read32(tiff + 4);
      const ifd = tiff + ifdOffset;
      if (ifd + 2 > source.length) return 1;
      const count = Math.min(read16(ifd), 256);
      for (let index = 0; index < count; index += 1) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > source.length) break;
        if (read16(entry) !== 0x0112) continue;
        const type = read16(entry + 2);
        const items = read32(entry + 4);
        if (type === 3 && items >= 1) {
          return Math.max(1, Math.min(8, read16(entry + 8)));
        }
        if (type === 4 && items >= 1) {
          return Math.max(1, Math.min(8, read32(entry + 8)));
        }
      }
    }
    offset += 2 + length;
  }
  return 1;
}

function orientPublishRgba(data, width, height, orientation) {
  const value = Math.max(1, Math.min(8, Number(orientation) || 1));
  if (value === 1) {
    return {
      data: data instanceof Uint8ClampedArray
        ? new Uint8ClampedArray(data)
        : new Uint8ClampedArray(data || []),
      width,
      height
    };
  }
  const swapped = value >= 5;
  const outputWidth = swapped ? height : width;
  const outputHeight = swapped ? width : height;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      let sourceX = x;
      let sourceY = y;
      if (value === 2) {
        sourceX = width - 1 - x;
      } else if (value === 3) {
        sourceX = width - 1 - x;
        sourceY = height - 1 - y;
      } else if (value === 4) {
        sourceY = height - 1 - y;
      } else if (value === 5) {
        sourceX = y;
        sourceY = x;
      } else if (value === 6) {
        sourceX = y;
        sourceY = height - 1 - x;
      } else if (value === 7) {
        sourceX = width - 1 - y;
        sourceY = height - 1 - x;
      } else if (value === 8) {
        sourceX = width - 1 - y;
        sourceY = x;
      }
      const sourceIndex = (sourceY * width + sourceX) * 4;
      const targetIndex = (y * outputWidth + x) * 4;
      output[targetIndex] = data[sourceIndex];
      output[targetIndex + 1] = data[sourceIndex + 1];
      output[targetIndex + 2] = data[sourceIndex + 2];
      output[targetIndex + 3] = data[sourceIndex + 3];
    }
  }
  return {
    data: output,
    width: outputWidth,
    height: outputHeight
  };
}

function decodePublishExport(buffer) {
  const source = Buffer.from(buffer || []);
  if (!source.length) {
    throw publishExportError("云端下载到的原图为空。", "publish-export-source-empty");
  }
  if (source.length > PUBLISH_EXPORT_MAX_INPUT_BYTES) {
    throw publishExportError("原图文件过大，暂时无法云端处理。", "publish-export-source-too-large");
  }
  if (source[0] === 0xff && source[1] === 0xd8) {
    const decoded = jpeg.decode(source, {
      useTArray: true,
      formatAsRGBA: true
    });
    const oriented = orientPublishRgba(
      new Uint8ClampedArray(decoded.data),
      Number(decoded.width) || 1,
      Number(decoded.height) || 1,
      readJpegOrientation(source)
    );
    if (oriented.width * oriented.height > PUBLISH_EXPORT_MAX_SOURCE_PIXELS) {
      throw publishExportError("原图像素过大，暂时无法云端处理。", "publish-export-source-too-large");
    }
    return Object.assign(oriented, { mime: "image/jpeg" });
  }
  if (
    source.length >= 8
    && source[0] === 0x89
    && source[1] === 0x50
    && source[2] === 0x4e
    && source[3] === 0x47
  ) {
    const decoded = PNG.sync.read(source);
    const oriented = orientPublishRgba(
      new Uint8ClampedArray(decoded.data),
      Number(decoded.width) || 1,
      Number(decoded.height) || 1,
      1
    );
    if (oriented.width * oriented.height > PUBLISH_EXPORT_MAX_SOURCE_PIXELS) {
      throw publishExportError("原图像素过大，暂时无法云端处理。", "publish-export-source-too-large");
    }
    return Object.assign(oriented, { mime: "image/png" });
  }
  throw publishExportError(
    "云端暂时只支持 JPG 或 PNG 原图。",
    "publish-export-format-unsupported"
  );
}

function encodePublishExport(data, width, height, options) {
  const normalized = publishExportCore.normalizeOptions(options);
  if (normalized.format === "png") {
    const png = new PNG({ width, height });
    png.data = Buffer.from(data);
    return {
      buffer: PNG.sync.write(png),
      mime: "image/png",
      extension: "png"
    };
  }
  const encoded = jpeg.encode({
    data: Buffer.from(data),
    width,
    height
  }, normalized.quality);
  return {
    buffer: Buffer.from(encoded.data),
    mime: "image/jpeg",
    extension: "jpg"
  };
}

async function claimPublishExportJob(openid, jobId, source, options, requestId) {
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PUBLISH_EXPORT_JOB_COLLECTION).doc(jobId);
    const previous = await readDocument(ref);
    const previousUpdatedAt = publishExportDate(previous && previous.updatedAt, null);
    if (previous && previous.status === "done" && previous.outputFileID) {
      return { state: "done", job: previous };
    }
    if (
      previous
      && previous.status === "processing"
      && previousUpdatedAt
      && now.getTime() - previousUpdatedAt.getTime() < PUBLISH_EXPORT_PROCESSING_TIMEOUT_MS
    ) {
      return { state: "processing", job: previous };
    }
    const next = Object.assign({}, previous || {}, {
      _id: jobId,
      openid,
      inputFileID: source.fileID,
      recordId: source.recordId,
      temporaryInput: source.temporaryInput,
      options,
      status: "processing",
      attempt: Math.max(0, Number(previous && previous.attempt) || 0) + 1,
      requestId,
      createdAt: previous && previous.createdAt || now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + PUBLISH_EXPORT_JOB_TTL_MS),
      outputFileID: "",
      outputMime: "",
      outputWidth: 0,
      outputHeight: 0,
      processingInfo: null,
      lastError: ""
    });
    await ref.set({ data: stripDocumentId(next) });
    return { state: "claimed", job: next };
  }, 5);
}

async function updatePublishExportJob(jobId, patch) {
  await db.collection(PUBLISH_EXPORT_JOB_COLLECTION).doc(jobId).update({
    data: Object.assign({}, patch, { updatedAt: new Date() })
  });
}

async function deleteCloudFileQuiet(fileID, requestId, reason) {
  if (!fileID) return;
  try {
    await cloud.deleteFile({ fileList: [fileID] });
  } catch (error) {
    log("warn", "publish-export.file-cleanup-failed", {
      requestId,
      fileID,
      reason,
      message: error && error.message ? error.message : String(error)
    });
  }
}

async function deleteTemporaryPublishExportAsset(openid, fileID, requestId) {
  if (!openid || !fileID) return;
  try {
    const ref = db.collection(USER_ASSET_COLLECTION).doc(userAssetId(openid, fileID));
    const asset = await readDocument(ref);
    if (asset && asset.openid === openid && asset.fileID === fileID && asset.temporary) {
      await ref.remove();
    }
  } catch (error) {
    log("warn", "publish-export.asset-cleanup-failed", {
      requestId,
      fileID,
      message: error && error.message ? error.message : String(error)
    });
  }
}

async function publishExport(event, context) {
  const source = await resolvePublishExportSource(event, context);
  const options = publishExportCore.normalizeOptions(event && event.options);
  const jobId = publishExportJobId(
    source.openid,
    source.fileID,
    source.recordId,
    options
  );
  const requestId = String(event && event.requestId || createRequestId("publish-export"));
  const claim = await claimPublishExportJob(
    source.openid,
    jobId,
    source,
    options,
    requestId
  );
  if (claim.state === "done") {
    return jsonResponse(true, {
      jobId,
      fileID: claim.job.outputFileID,
      width: claim.job.outputWidth,
      height: claim.job.outputHeight,
      format: options.format,
      processingInfo: claim.job.processingInfo || {},
      deduplicated: true
    });
  }
  if (claim.state === "processing") {
    throw publishExportError("这张图片正在云端处理，请稍后重试。", "PUBLISH_EXPORT_PROCESSING", true);
  }

  let outputFileID = "";
  try {
    const inputBuffer = await downloadCloudFile(source.fileID, {
      requestId,
      action: "publishExport",
      fileType: "publish-export-source"
    });
    const decoded = decodePublishExport(inputBuffer);
    const outputSize = publishExportCore.getOutputSize(
      decoded.width,
      decoded.height,
      options.maxLongEdge
    );
    const resized = decoded.width === outputSize.width && decoded.height === outputSize.height
      ? decoded.data
      : publishExportCore.resizeRgba(
        decoded.data,
        decoded.width,
        decoded.height,
        outputSize.width,
        outputSize.height
      );
    const processed = publishExportCore.processRgba({
      data: resized,
      width: outputSize.width,
      height: outputSize.height,
      options,
      seed: `${jobId}:${options.format}`
    });
    const encoded = encodePublishExport(
      processed,
      outputSize.width,
      outputSize.height,
      options
    );
    const uploaded = await cloud.uploadFile({
      cloudPath: `publish-exports/${usageUserHash(source.openid)}/${jobId}.${encoded.extension}`,
      fileContent: encoded.buffer
    });
    outputFileID = uploaded && uploaded.fileID || "";
    if (!outputFileID) {
      throw new Error("云端编码完成但没有返回结果文件。");
    }
    const processingInfo = {
      algorithm: "publish-export-core",
      sourceMime: decoded.mime,
      outputMime: encoded.mime,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      alphaPreserved: options.format === "png",
      options
    };
    await updatePublishExportJob(jobId, {
      status: "done",
      outputFileID,
      outputMime: encoded.mime,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height,
      processingInfo,
      finishedAt: new Date(),
      lastError: ""
    });
    if (source.temporaryInput) {
      await deleteCloudFileQuiet(source.fileID, requestId, "temporary-input-success");
      await deleteTemporaryPublishExportAsset(source.openid, source.fileID, requestId);
    }
    log("info", "publish-export.finish", {
      requestId,
      jobId,
      inputFileID: source.fileID,
      outputFileID,
      width: outputSize.width,
      height: outputSize.height,
      format: options.format
    });
    return jsonResponse(true, {
      jobId,
      fileID: outputFileID,
      width: outputSize.width,
      height: outputSize.height,
      format: options.format,
      processingInfo
    });
  } catch (error) {
    if (outputFileID) {
      await deleteCloudFileQuiet(outputFileID, requestId, "publish-export-failed");
    }
    try {
      await updatePublishExportJob(jobId, {
        status: "failed",
        lastError: String(error && error.message || error),
        failedAt: new Date()
      });
    } catch (updateError) {
      log("warn", "publish-export.job-update-failed", {
        requestId,
        jobId,
        message: updateError && updateError.message
      });
    }
    if (source.temporaryInput) {
      await deleteCloudFileQuiet(source.fileID, requestId, "temporary-input-failed");
      await deleteTemporaryPublishExportAsset(source.openid, source.fileID, requestId);
    }
    throw error;
  }
}

async function cleanupPublishExportResult(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail("请先完成微信授权后再清理导出结果。", "wechat-binding-required");
  }
  const jobId = String(event && event.jobId || "").trim();
  const fileID = String(event && event.fileID || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(jobId) || !/^cloud:\/\//i.test(fileID)) {
    return fail("导出结果清理参数不完整。", "publish-export-cleanup-invalid");
  }
  const ref = db.collection(PUBLISH_EXPORT_JOB_COLLECTION).doc(jobId);
  const job = await readDocument(ref);
  if (
    !job
    || job.openid !== openid
    || job.status !== "done"
    || job.outputFileID !== fileID
  ) {
    return fail("找不到可清理的导出结果，或结果不属于当前用户。", "publish-export-cleanup-forbidden");
  }
  try {
    const response = await cloud.deleteFile({ fileList: [fileID] });
    const failed = response && Array.isArray(response.fileList)
      ? response.fileList.find((item) => item && item.fileID === fileID && Number(item.status) !== 0)
      : null;
    if (failed) {
      const error = new Error(failed.errMsg || "导出结果文件清理失败。");
      error.code = "publish-export-cleanup-file-failed";
      throw error;
    }
  } catch (error) {
    if (!isPhotoToVideoTempFileMissing(error)) throw error;
  }
  await ref.remove();
  return jsonResponse(true, {
    jobId,
    fileID,
    removed: true
  });
}

async function cleanupPublishExportJobs(baseDate = new Date()) {
  const now = baseDate instanceof Date ? baseDate : new Date(baseDate);
  try {
    const result = await db.collection(PUBLISH_EXPORT_JOB_COLLECTION)
      .where({ expiresAt: db.command.lte(now) })
      .limit(PUBLISH_EXPORT_CLEANUP_BATCH_SIZE)
      .get();
    const rows = result && Array.isArray(result.data) ? result.data : [];
    let removed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (row.outputFileID) {
          await deleteCloudFileQuiet(row.outputFileID, "", "publish-export-job-expired");
        }
        if (row.temporaryInput && row.inputFileID) {
          await deleteCloudFileQuiet(row.inputFileID, "", "publish-export-input-expired");
          await deleteTemporaryPublishExportAsset(row.openid, row.inputFileID, "");
        }
        if (row._id) {
          await db.collection(PUBLISH_EXPORT_JOB_COLLECTION).doc(row._id).remove();
        }
        removed += 1;
      } catch (error) {
        failed += 1;
        log("warn", "publish-export.cleanup-failed", {
          jobId: row && row._id,
          message: error && error.message
        });
      }
    }
    return {
      scanned: rows.length,
      removed,
      failed,
      truncated: rows.length >= PUBLISH_EXPORT_CLEANUP_BATCH_SIZE
    };
  } catch (error) {
    if (isCollectionMissingError(error)) {
      return { scanned: 0, removed: 0, failed: 0, skipped: true };
    }
    throw error;
  }
}

async function getMyUserProfile(context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail("请使用微信身份打开小程序。", "wechat-binding-required");
  }
  let profile = null;
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    profile = userProfileTestRows.find((item) => item.openid === openid) || null;
  } else {
    profile = await readDocument(
      db.collection(USER_PROFILE_COLLECTION).doc(userProfileId(openid))
    );
  }
  return jsonResponse(true, {
    completed: Boolean(
      profile
      && normalizeUserNickname(profile.nickname)
      && profile.avatarFileID
      && normalizeUserGender(profile.gender)
    ),
    profile: profile ? userProfileView(profile) : null
  });
}

async function saveMyUserProfile(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail("请使用微信身份打开小程序。", "wechat-binding-required");
  }
  const source = event && event.profile && typeof event.profile === "object"
    ? event.profile
    : {};
  const nickname = normalizeUserNickname(source.nickname);
  const avatarFileID = String(source.avatarFileID || "").trim();
  const gender = normalizeUserGender(source.gender);
  const errors = [];
  if (!nickname) errors.push("请填写微信昵称");
  if (!avatarFileID || !/^cloud:\/\//i.test(avatarFileID)) errors.push("请选择并上传微信头像");
  if (!gender) errors.push("请选择男性或女性");
  if (errors.length) {
    return fail(errors.join("；"), "USER_PROFILE_INVALID", { fields: errors });
  }
  const now = new Date();
  const id = userProfileId(openid);
  const userHash = usageUserHash(openid);

  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    const index = userProfileTestRows.findIndex((item) => item.openid === openid);
    const existing = index >= 0 ? userProfileTestRows[index] : null;
    const next = {
      _id: id,
      openid,
      userHash,
      nickname,
      avatarFileID,
      gender,
      privacyConsentVersion: "2026-08-24-v1",
      consentedAt: existing && existing.consentedAt || now,
      createdAt: existing && existing.createdAt || now,
      updatedAt: now
    };
    if (index >= 0) userProfileTestRows.splice(index, 1, next);
    else userProfileTestRows.push(next);
    return jsonResponse(true, {
      completed: true,
      profile: userProfileView(next)
    });
  }

  const existing = await readDocument(
    db.collection(USER_PROFILE_COLLECTION).doc(id)
  );
  await findUserAsset(openid, avatarFileID, "avatar");
  const next = {
    _id: id,
    openid,
    userHash,
    nickname,
    avatarFileID,
    gender,
    privacyConsentVersion: "2026-08-24-v1",
    consentedAt: existing && existing.consentedAt || now,
    createdAt: existing && existing.createdAt || now,
    updatedAt: now
  };
  await db.runTransaction(async (transaction) => {
    const profileRef = transaction.collection(USER_PROFILE_COLLECTION).doc(id);
    const avatar = await findUserAsset(openid, avatarFileID, "avatar", transaction);
    await transaction.collection(USER_ASSET_COLLECTION).doc(avatar._id).update({
      data: {
        refCount: 1,
        updatedAt: now
      }
    });
    await profileRef.set({ data: stripDocumentId(next) });
  }, 5);

  const previousAvatar = String(existing && existing.avatarFileID || "");
  if (previousAvatar && previousAvatar !== avatarFileID) {
    try {
      await cloud.deleteFile({ fileList: [previousAvatar] });
      await db
        .collection(USER_ASSET_COLLECTION)
        .doc(userAssetId(openid, previousAvatar))
        .remove();
    } catch (error) {
      log("warn", "user-profile.avatar-cleanup-failed", {
        userHash,
        error: error && error.message
      });
    }
  }
  return jsonResponse(true, {
    completed: true,
    profile: userProfileView(next)
  });
}

async function getAdminUserStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const offset = Math.max(0, Number(event && event.offset) || 0);
  const limit = Math.max(1, Math.min(50, Number(event && event.limit) || 20));
  const options = {
    search: event && event.search,
    dateRange: event && event.dateRange,
    gender: event && event.gender,
    startDate: event && event.startDate,
    endDate: event && event.endDate
  };
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return jsonResponse(true, buildAdminUserStats(userProfileTestRows, offset, limit, options));
  }
  const loaded = await loadAllAdminUserProfiles();
  return jsonResponse(true, Object.assign(
    buildAdminUserStats(loaded.rows, offset, limit, options),
    {
      sourceTotal: loaded.total,
      truncated: loaded.truncated
    }
  ));
}

function normalizeAdminUserProfileRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((item) => Object.assign({}, item, {
      gender: normalizeUserGender(item && item.gender),
      nickname: normalizeUserNickname(item && item.nickname)
    }))
    .filter((item) => item.gender && item.nickname)
    .sort((left, right) => (
      new Date(right.createdAt || 0).getTime()
      - new Date(left.createdAt || 0).getTime()
    ));
}

function buildAdminUserExportWorkbook(rows = [], exportedAt = new Date(), options = {}) {
  const filtered = filterAdminUserProfiles(rows, options, exportedAt);
  const users = filtered.rows;
  const maleCount = users.filter((item) => item.gender === "male").length;
  const femaleCount = users.filter((item) => item.gender === "female").length;
  const total = maleCount + femaleCount;
  const maleRatio = total ? Math.round(maleCount / total * 1000) / 10 : 0;
  const femaleRatio = total ? Math.round((100 - maleRatio) * 10) / 10 : 0;
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["统计项目", "数值"],
    ["总用户数", total],
    ["男性数量", maleCount],
    ["男性比例", `${maleRatio}%`],
    ["女性数量", femaleCount],
    ["女性比例", `${femaleRatio}%`],
    [
      "日期范围",
      filtered.dateRange === "custom"
        ? `${filtered.startDate} 至 ${filtered.endDate}`
        : ADMIN_USER_DATE_RANGE_LABELS[filtered.dateRange]
    ],
    ["性别范围", ADMIN_USER_GENDER_LABELS[filtered.gender]],
    ["搜索条件", filtered.search || "无"],
    ["导出时间", formatExportDateTime(exportedAt)]
  ]);
  summarySheet["!cols"] = [{ wch: 18 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(workbook, summarySheet, "统计摘要");

  const detailRows = [[
    "匿名用户编号",
    "昵称",
    "性别",
    "首次使用时间",
    "最近修改时间"
  ]];
  users.forEach((item) => {
    detailRows.push([
      safeExportText(item.userHash || usageUserHash(item.openid), 40),
      safeExportText(item.nickname, 32),
      item.gender === "male" ? "男" : "女",
      formatExportDateTime(item.createdAt),
      formatExportDateTime(item.updatedAt)
    ]);
  });
  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
  detailSheet["!cols"] = [
    { wch: 18 },
    { wch: 24 },
    { wch: 10 },
    { wch: 24 },
    { wch: 24 }
  ];
  XLSX.utils.book_append_sheet(workbook, detailSheet, "用户明细");
  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer"
  });
}

async function loadAllAdminUserProfiles() {
  if (process.env.WECHAT_MINIAPP_TEST === "1") {
    return {
      rows: userProfileTestRows.slice(),
      total: userProfileTestRows.length,
      truncated: false
    };
  }
  const collection = db.collection(USER_PROFILE_COLLECTION);
  const countResult = await collection.count();
  const total = Math.max(0, Number(countResult && countResult.total) || 0);
  const maxRows = 10000;
  const targetCount = Math.min(total, maxRows);
  const batchSize = 100;
  const rows = [];
  while (rows.length < targetCount) {
    const result = await collection
      .orderBy("createdAt", "desc")
      .skip(rows.length)
      .limit(Math.min(batchSize, targetCount - rows.length))
      .get();
    const batch = result && Array.isArray(result.data) ? result.data : [];
    rows.push(...batch);
    if (batch.length < batchSize) break;
  }
  return {
    rows,
    total,
    truncated: total > maxRows
  };
}

async function exportAdminUserStats(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const loaded = await loadAllAdminUserProfiles();
  const options = {
    search: event && event.search,
    dateRange: event && event.dateRange,
    gender: event && event.gender,
    startDate: event && event.startDate,
    endDate: event && event.endDate
  };
  const filtered = filterAdminUserProfiles(loaded.rows, options);
  const buffer = buildAdminUserExportWorkbook(loaded.rows, new Date(), options);
  const dateKey = dateKeyForTimeZone(new Date(), MODEL_USAGE_TIME_ZONE);
  const fileName = `用户统计-${dateKey}.xlsx`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `exports/user-stats/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.xlsx`,
    fileContent: buffer
  });
  return jsonResponse(true, {
    fileID: uploaded && uploaded.fileID ? uploaded.fileID : "",
    fileName,
    sizeBytes: buffer.length,
    exportedCount: filtered.rows.length,
    total: filtered.rows.length,
    sourceTotal: loaded.total,
    search: filtered.search,
    dateRange: filtered.dateRange,
    gender: filtered.gender,
    startDate: filtered.startDate,
    endDate: filtered.endDate,
    truncated: loaded.truncated,
    message: loaded.truncated
      ? "Excel 已生成；用户超过 10000 人，本次导出前 10000 人。"
      : "用户统计 Excel 已生成，可以下载。"
  });
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
  const faceFileIDs = (Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs : [])
    .filter(Boolean)
    .slice(0, 6);
  const wardrobeFileIDs = (Array.isArray(payload.wardrobeFileIDs) ? payload.wardrobeFileIDs : [])
    .filter(Boolean)
    .slice(0, 12);
  const backgroundFileIDs = (Array.isArray(payload.backgroundFileIDs)
    ? payload.backgroundFileIDs
    : []
  ).filter(Boolean).slice(0, 3);
  const checks = [];
  if (mainFileID) checks.push(findUserAsset(openid, mainFileID, "main"));
  if (maskFileID) checks.push(findUserAsset(openid, maskFileID, "mask"));
  checks.push(...faceFileIDs.map((fileID) => findUserAsset(openid, fileID, "face")));
  checks.push(...wardrobeFileIDs.map((fileID) => findUserAsset(openid, fileID, "wardrobe")));
  checks.push(...backgroundFileIDs.map((fileID) => findUserAsset(openid, fileID, "background")));
  if (checks.length) await Promise.all(checks);
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
  await ref.set({ data: stripDocumentId(data) });
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
  await ref.set({ data: stripDocumentId(record) });
  return record;
}

async function removePointLedgerForUser(openid) {
  let removed = 0;
  while (true) {
    const result = await db
      .collection(POINTS_LEDGER_COLLECTION)
      .where({ openid })
      .limit(POINTS_RESET_LEDGER_BATCH_SIZE)
      .get();
    const rows = result && Array.isArray(result.data)
      ? result.data.filter((item) => item && item._id)
      : [];
    if (!rows.length) break;
    await Promise.all(
      rows.map((item) => (
        db.collection(POINTS_LEDGER_COLLECTION).doc(item._id).remove()
      ))
    );
    removed += rows.length;
    if (rows.length < POINTS_RESET_LEDGER_BATCH_SIZE) break;
  }
  return removed;
}

function sanitizeGenerationPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const list = (value, limit) => (
    Array.isArray(value)
      ? value
        .filter(Boolean)
        .slice(0, limit)
        .map((item) => String(item).trim().slice(0, 512))
        .filter(Boolean)
      : []
  );
  const geometrySource = source.maskGeometry && typeof source.maskGeometry === "object"
    ? source.maskGeometry
    : {};
  const maskGeometry = {};
  [
    "x",
    "y",
    "width",
    "height",
    "left",
    "top",
    "right",
    "bottom",
    "centerX",
    "centerY",
    "radius",
    "scale",
    "rotation",
    "coordinateSystem"
  ].forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(geometrySource, key)) return;
    const value = geometrySource[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      maskGeometry[key] = Math.max(-100000, Math.min(100000, value));
    } else if (typeof value === "string") {
      maskGeometry[key] = value.trim().slice(0, 64);
    }
  });
  return {
    generationType: "normal",
    mode: String(source.mode || "").trim().slice(0, 16),
    projectName: String(source.projectName || "未命名项目").trim().slice(0, 80),
    prompt: String(source.prompt || "").slice(0, 8000),
    negativePrompt: String(source.negativePrompt || "").slice(0, 4000),
    mainFileID: String(source.mainFileID || "").trim().slice(0, 512),
    maskFileID: String(source.maskFileID || "").trim().slice(0, 512),
    identityFileID: String(source.identityFileID || "").trim().slice(0, 512),
    maskGeometry,
    assetRegistrationVersion: Number(source.assetRegistrationVersion) || 0,
    faceFileIDs: list(source.faceFileIDs, 6),
    wardrobeFileIDs: list(source.wardrobeFileIDs, 12),
    backgroundFileIDs: list(source.backgroundFileIDs, 3),
    size: String(source.size || "").trim().slice(0, 32),
    n: Math.max(1, Math.min(4, Math.round(Number(source.n) || 1)))
  };
}

function normalizeGenerationStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return GENERATION_OPERATION_STATUSES.includes(status) ? status : "failed";
}

function statusMessageForGenerationOperation(status, stage) {
  if (status === "queued") return "生图任务已提交，正在排队。";
  if (status === "processing") {
    if (stage === "validate") return "正在检查生图素材。";
    if (stage === "image-edit-primary") return "正在使用主模型生成图片。";
    if (stage === "image-edit-primary-retry") {
      return "主模型暂时失败，正在重试。";
    }
    if (stage === "image-edit-backup") {
      return "主模型不可用，正在切换备用模型。";
    }
    if (stage === "download") return "正在接收生成结果。";
    if (stage === "upload") return "正在保存生成图片。";
    if (stage === "record") return "正在保存制作记录。";
    return "AI 正在生成图片。";
  }
  if (status === "succeeded") return "图片生成完成。";
  if (status === "refunding") return "生成失败，正在退回使用额度。";
  if (status === "refunded") return "生成失败，使用额度已退回。";
  if (status === "failed") return "图片生成失败。";
  return "任务状态未知。";
}

function serializeGenerationDate(value) {
  if (!value) return "";
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value.toDate === "function") {
      const date = value.toDate();
      return date instanceof Date ? date.toISOString() : new Date(date).toISOString();
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  } catch (_) {
    return "";
  }
}

function sanitizeImageProviderAttempts(value) {
  return (Array.isArray(value) ? value : []).slice(0, 3).map((item) => ({
    role: item && item.role === "backup" ? "backup" : "primary",
    attempt: Math.max(1, Number(item && item.attempt) || 1),
    provider: String(item && item.provider || "").slice(0, 80),
    model: String(item && item.model || "").slice(0, 120),
    timeoutMs: Math.max(0, Number(item && item.timeoutMs) || 0),
    success: Boolean(item && item.success),
    status: Math.max(0, Number(item && item.status) || 0),
    code: String(item && item.code || "").slice(0, 80),
    category: String(item && item.category || "").slice(0, 40),
    retryable: Boolean(item && item.retryable),
    durationMs: Math.max(0, Number(item && item.durationMs) || 0),
    message: sanitizeFailureMessage(item && item.message || "", 240)
  }));
}

function sanitizeGenerationResult(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const safe = {};
  [
    "requestId",
    "recordId",
    "fileID",
    "tempFileURL",
    "createdAt",
    "provider",
    "model",
    "providerRole",
    "size",
    "resolution",
    "pipelineStage"
  ].forEach((key) => {
    if (source[key] === undefined || source[key] === null) return;
    safe[key] = key === "createdAt"
      ? serializeGenerationDate(source[key])
      : String(source[key]).slice(0, key === "tempFileURL" ? 4096 : 512);
  });
  if (source.providerAttempt !== undefined) {
    safe.providerAttempt = Math.max(1, Number(source.providerAttempt) || 1);
  }
  if (Array.isArray(source.providerAttempts)) {
    safe.providerAttempts = sanitizeImageProviderAttempts(source.providerAttempts);
  }
  if (source.quota && typeof source.quota === "object") {
    safe.quota = {
      freeUsed: Math.max(0, Number(source.quota.freeUsed) || 0),
      freeLimit: Math.max(0, Number(source.quota.freeLimit) || 0),
      freeRemaining: Math.max(0, Number(source.quota.freeRemaining) || 0),
      billingMode: String(source.quota.billingMode || "").slice(0, 32)
    };
  }
  if (source.billing && typeof source.billing === "object") {
    safe.billing = {
      source: String(source.billing.source || "").slice(0, 32),
      kind: String(source.billing.kind || "").slice(0, 32),
      pointsCharged: Math.max(0, Number(source.billing.pointsCharged) || 0),
      cost: Math.max(0, Number(source.billing.cost) || 0),
      dateKey: String(source.billing.dateKey || "").slice(0, 16)
    };
  }
  if (source.record && typeof source.record === "object") {
    const record = Object.assign({}, source.record);
    [
      "_id",
      "openid",
      "payload",
      "ledgerId",
      "refundLedgerId",
      "headers",
      "apiKey",
      "authorization"
    ].forEach((key) => delete record[key]);
    safe.record = record;
  }
  return safe;
}

function buildPublicGenerationBilling(billing) {
  if (!billing || typeof billing !== "object") return null;
  return {
    source: String(billing.source || "").slice(0, 32),
    kind: String(billing.kind || "").slice(0, 32),
    pointsCharged: Math.max(0, Number(billing.pointsCharged) || 0),
    cost: Math.max(0, Number(billing.cost) || 0),
    dateKey: String(billing.dateKey || "").slice(0, 16),
    quota: billing.quota && typeof billing.quota === "object"
      ? {
          freeUsed: Math.max(0, Number(billing.quota.freeUsed) || 0),
          freeLimit: Math.max(0, Number(billing.quota.freeLimit) || 0),
          freeRemaining: Math.max(0, Number(billing.quota.freeRemaining) || 0),
          billingMode: String(billing.quota.billingMode || "").slice(0, 32)
        }
      : null
  };
}

function buildGenerationStatusResult(operation = {}) {
  const status = normalizeGenerationStatus(operation.status);
  const stage = String(operation.pipelineStage || status).trim() || status;
  const progress = status === "queued"
    ? 0
    : status === "processing"
      ? Math.max(5, Math.min(95, Number(operation.progress) || 10))
      : status === "succeeded"
        ? 100
        : 0;
  const result = status === "succeeded"
    ? sanitizeGenerationResult(operation.result || {
        requestId: operation.requestId,
        recordId: operation.recordId,
        fileID: operation.resultFileID,
        tempFileURL: operation.tempFileURL,
        createdAt: operation.succeededAt,
        model: operation.model,
        resolution: operation.resolution
      })
    : null;
  const rawError = operation.lastError && typeof operation.lastError === "object"
    ? operation.lastError
    : null;
  const error = status === "failed" && rawError
    ? {
        code: String(rawError.code || "generation-failed").slice(0, 80),
        message: sanitizeFailureMessage(rawError.message || "生成失败", 240),
        retryable: Boolean(rawError.retryable)
      }
    : null;
  return {
    taskId: String(operation.requestId || ""),
    requestId: String(operation.requestId || ""),
    status,
    stage,
    progress,
    message: statusMessageForGenerationOperation(status, stage),
    result,
    error,
    queuedAt: serializeGenerationDate(operation.queuedAt),
    processingAt: serializeGenerationDate(operation.processingAt),
    updatedAt: serializeGenerationDate(operation.updatedAt)
  };
}

async function findGenerationOperation(openid, requestId, store = db) {
  if (!openid || !requestId) return null;
  return readDocument(
    store
      .collection(GENERATION_OPERATION_COLLECTION)
      .doc(generationOperationId(openid, requestId))
  );
}

async function saveGenerationOperation(
  openid,
  requestId,
  data,
  store = db,
  options = {}
) {
  const operationId = generationOperationId(openid, requestId);
  const ref = store.collection(GENERATION_OPERATION_COLLECTION).doc(operationId);
  const existing = await readDocument(ref);
  const now = new Date();
  const operationKind = String(
    data && data.kind
    || existing && existing.kind
    || ""
  );
  const enforceState = options.enforceState === undefined
    ? ["image", "video"].includes(operationKind)
    : Boolean(options.enforceState);
  const patch = enforceState
    ? generationStateMachine.applyTransition(existing || {}, data, {
        actor: options.actor || "system",
        stage: options.historyStage,
        code: options.historyCode,
        at: now
      })
    : data;
  const record = Object.assign({
    _id: operationId,
    openid,
    requestId,
    status: "reserved",
    createdAt: now
  }, existing || {}, patch, {
    _id: operationId,
    openid,
    requestId,
    updatedAt: now
  });
  await ref.set({ data: stripDocumentId(record) });
  return record;
}

async function enqueueGenerationOperation(
  openid,
  requestId,
  payload,
  billing,
  metadata = {}
) {
  return db.runTransaction(async (transaction) => {
    const existing = await findGenerationOperation(openid, requestId, transaction);
    const existingStatus = normalizeGenerationStatus(existing && existing.status);
    if (
      existing
      && ["queued", "processing", "succeeded", "refunding", "refunded"].includes(existingStatus)
    ) {
      return existing;
    }
    const now = new Date();
    return saveGenerationOperation(openid, requestId, {
      kind: "image",
      workflow: "image-generation-v1",
      status: "queued",
      payload: sanitizeGenerationPayload(payload),
      pipelineStage: "queued",
      progress: 0,
      queuedAt: existing && existing.queuedAt ? existing.queuedAt : now,
      lastHeartbeatAt: now,
      attemptCount: Math.max(0, Number(existing && existing.attemptCount) || 0),
      billing: billing || (existing && existing.billing) || {},
      model: String(metadata.model || (existing && existing.model) || "").slice(0, 160),
      resolution: String(metadata.resolution || (existing && existing.resolution) || "").slice(0, 16),
      size: String(metadata.size || (existing && existing.size) || "").slice(0, 32),
      expiresAt: new Date(now.getTime() + GENERATION_RESULT_TTL_MS),
      lastError: null
    }, transaction, {
      enforceState: true,
      actor: "client"
    });
  }, 5);
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
    operation.lastHeartbeatAt
    || operation.updatedAt
    || operation.processingAt
    || operation.queuedAt
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
    }, transaction, {
      enforceState: ["image", "video"].includes(kind),
      actor: "worker",
      historyStage: "processing"
    });
    return { claimed: true, operation: claimed, completed: false };
  }, 5);
}

async function updateGenerationOperation(openid, requestId, patch, options = {}) {
  return db.runTransaction(async (transaction) => {
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (!operation) return null;
    const status = String(operation.status || "");
    if (status === "refunded" && !options.allowRefunded) return operation;
    if (
      Array.isArray(options.allowedStatuses)
      && options.allowedStatuses.length
      && !options.allowedStatuses.includes(status)
    ) {
      return operation;
    }
    return saveGenerationOperation(openid, requestId, patch, transaction, {
      enforceState: options.enforceState === undefined
        ? ["image", "video"].includes(operation.kind)
        : Boolean(options.enforceState),
      actor: options.actor,
      historyStage: options.historyStage,
      historyCode: options.historyCode
    });
  }, 5);
}

async function touchGenerationOperation(openid, requestId, stage, progress) {
  const safeStage = String(stage || "processing").trim().slice(0, 40) || "processing";
  const numericProgress = Number(progress);
  const safeProgress = Number.isFinite(numericProgress)
    ? Math.max(0, Math.min(99, Math.round(numericProgress)))
    : 10;
  return updateGenerationOperation(openid, requestId, {
    pipelineStage: safeStage,
    progress: safeProgress,
    lastHeartbeatAt: new Date()
  }, {
    allowedStatuses: ["queued", "processing"],
    enforceState: true,
    actor: "worker"
  });
}

async function completeGenerationOperation(openid, requestId, result, options = {}) {
  const safeResult = sanitizeGenerationResult(result);
  return updateGenerationOperation(openid, requestId, {
    status: "succeeded",
    pipelineStage: "succeeded",
    progress: 100,
    result: safeResult,
    recordId: safeResult.recordId || "",
    resultFileID: safeResult.fileID || "",
    tempFileURL: safeResult.tempFileURL || "",
    succeededAt: new Date(),
    lastHeartbeatAt: new Date(),
    reconcilePending: false,
    refundPending: false,
    cleanupPending: false,
    lastError: null
  }, {
    allowedStatuses: ["processing", "failed", "succeeded"],
    enforceState: options.enforceState !== false,
    actor: options.actor || "worker"
  });
}

async function failGenerationOperation(openid, requestId, error, options = {}) {
  return updateGenerationOperation(openid, requestId, {
    status: "failed",
    pipelineStage: String(error && error.pipelineStage || "failed").slice(0, 40),
    progress: 0,
    failedAt: new Date(),
    lastHeartbeatAt: new Date(),
    lastError: {
      code: String(error && error.code || "generation-failed"),
      message: sanitizeFailureMessage(error && error.message || "生成失败", 240),
      retryable: Boolean(error && error.retryable)
    }
  }, {
    allowedStatuses: ["reserved", "queued", "processing", "failed"],
    enforceState: options.enforceState !== false,
    actor: options.actor || "worker",
    historyCode: String(error && error.code || "generation-failed")
  });
}

async function getGenerationStatus(event, context) {
  return generationExecutionKernel.getGenerationStatus(event, context);
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
      }, transaction, {
        enforceState: true,
        actor: "worker"
      });
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
        .set({ data: stripDocumentId(account) });
    }

    quota.data.freeLimit = Number(points.dailyFreeLimit) || 0;
    quota.data.dailyLimit = quota.data.freeLimit;
    quota.data.updatedAt = new Date();
    await quota.ref.set({ data: stripDocumentId(quota.data) });
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
    }, transaction, {
      enforceState: ["image", "video"].includes(kind),
      actor: "billing",
      historyStage: "reserved"
    });
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
        .set({ data: stripDocumentId(account) });
    } else if (original.type === "daily-free") {
      quota.data.freeUsed = Math.max(0, (Number(quota.data.freeUsed) || 0) - 1);
      quota.data.used = quota.data.freeUsed;
      quota.data.updatedAt = new Date();
      await quota.ref.set({ data: stripDocumentId(quota.data) });
    } else if (original.type === "promo-free") {
      quota.data.promoFree = Math.max(0, (Number(quota.data.promoFree) || 0) - 1);
      quota.data.updatedAt = new Date();
      await quota.ref.set({ data: stripDocumentId(quota.data) });
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
          refundedAt: new Date(),
          refundPending: false,
          refundLastError: ""
        }, transaction, {
          enforceState: ["image", "video"].includes(operation.kind),
          actor: "billing",
          historyStage: "refunded",
          historyCode: "refund-ledger-created"
        })
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
      .set({ data: stripDocumentId(account) });
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
    await ref.set({ data: stripDocumentId(next) });
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
      data: stripDocumentId(Object.assign({}, chain, {
        tailRecordId: recordId,
        tailRevision: slot.revisionNumber,
        pendingRequestId: "",
        pendingParentId: "",
        pendingRevision: 0,
        updatedAt: new Date()
      }))
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
        data: stripDocumentId(Object.assign({}, chain, {
          pendingRequestId: "",
          pendingParentId: "",
          pendingRevision: 0,
          updatedAt: new Date()
        }))
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

async function writeTencentFaceFusionStatus(patch = {}) {
  try {
    const ref = db
      .collection(TENCENT_FACEFUSION_STATUS_COLLECTION)
      .doc(TENCENT_FACEFUSION_STATUS_ID);
    const existing = await readDocument(ref);
    await ref.set({
      data: stripDocumentId(Object.assign({}, existing || {}, patch, {
        _id: TENCENT_FACEFUSION_STATUS_ID,
        updatedAt: new Date()
      }))
    });
  } catch (error) {
    log("warn", "tencent.facefusion.status-write-failed", {
      error: error && error.message
    });
  }
}

async function claimTencentPipelineResume(openid, requestId) {
  return db.runTransaction(async (transaction) => {
    const operation = await findGenerationOperation(openid, requestId, transaction);
    if (!operation) {
      const error = new Error("没有找到可重试的腾讯换脸任务。");
      error.code = "TENCENT_RETRY_OPERATION_MISSING";
      throw error;
    }
    if (operation.status === "succeeded" && operation.result) {
      return { claimed: false, completed: true, operation };
    }
    if (operation.status === "processing") {
      return { claimed: false, completed: false, operation };
    }
    if (
      operation.status !== "refunded"
      || !String(operation.intermediateFileID || "").trim()
    ) {
      const error = new Error("这次任务没有可用的中间图，请重新开始制作。");
      error.code = "TENCENT_RETRY_INTERMEDIATE_MISSING";
      throw error;
    }
    if (
      !operation.pixelProtection
      || Number(operation.pixelProtection.version)
        !== pixelProtectionFlow.PIXEL_PROTECTION_VERSION
      || !Array.isArray(operation.pixelProtection.faceProtectionRects)
      || !operation.pixelProtection.faceProtectionRects.length
      || !operation.pixelProtectionMetrics
      || !(
        operation.pixelProtectionMetrics.imageEditIntermediate
        || operation.pixelProtectionMetrics.lingyunIntermediate
      )
    ) {
      const error = new Error("这次任务缺少已验收的人脸保护数据，不能安全重试腾讯换脸。");
      error.code = "TENCENT_RETRY_PIXEL_PROTECTION_MISSING";
      error.retryable = false;
      throw error;
    }
    const next = await saveGenerationOperation(openid, requestId, {
      status: "processing",
      pipelineStage: "facefusion",
      retryTencentOnly: true,
      processingAt: new Date(),
      lastError: null
    }, transaction);
    return { claimed: true, completed: false, operation: next, resumed: true };
  }, 5);
}

function tencentPipelineOperationResult(operation) {
  const result = operation && operation.result && typeof operation.result === "object"
    ? operation.result
    : {};
  return Object.assign({}, result, {
    requestId: result.requestId || operation && operation.requestId || "",
    pipelineStage: operation && operation.pipelineStage || result.pipelineStage || "",
    intermediateAvailable: Boolean(operation && operation.intermediateFileID)
  });
}

async function getTencentFaceFusionPipelineStatus(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const openid = getOpenId(context);
  if (openid === "anonymous") return jsonResponse(true, { stage: "pending" });
  const requestId = String(event && event.requestId || "").trim();
  if (!requestId) return jsonResponse(true, { stage: "pending" });
  const operation = await findGenerationOperation(openid, requestId);
  if (!operation) return jsonResponse(true, {
    requestId,
    stage: "pending",
    intermediateAvailable: false,
    canRetryTencent: false
  });
  const stage = operation.status === "succeeded"
    ? "succeeded"
    : operation.status === "refunded"
      ? "failed"
      : operation.pipelineStage || "preparing";
  const progressByStage = {
    preparing: 10,
    "face-detection": 20,
    "mask-ready": 35,
    "image-edit": 55,
    "image-edit-primary": 35,
    "image-edit-primary-retry": 44,
    "image-edit-backup": 52,
    facefusion: 85
  };
  const stageTextByStage = {
    preparing: "正在准备主图和参考脸",
    "face-detection": "正在检测主图中的人脸",
    "mask-ready": "正在生成脸部保护 mask",
    "image-edit": "正在修改衣服、背景和光影",
    "image-edit-primary": "正在使用主模型修改衣服、背景和光影",
    "image-edit-primary-retry": "主模型暂时失败，正在重试图片编辑",
    "image-edit-backup": "主模型不可用，正在切换备用模型修改图片",
    facefusion: "正在融合参考人脸"
  };
  const canRetryTencent = operation.status === "refunded"
    && Boolean(operation.intermediateFileID)
    && operation.pixelProtection
    && Number(operation.pixelProtection.version)
      === pixelProtectionFlow.PIXEL_PROTECTION_VERSION
    && Array.isArray(operation.pixelProtection.faceProtectionRects)
    && operation.pixelProtection.faceProtectionRects.length > 0
    && operation.pixelProtectionMetrics
    && (
      operation.pixelProtectionMetrics.imageEditIntermediate
      || operation.pixelProtectionMetrics.lingyunIntermediate
    );
  return jsonResponse(true, Object.assign({
    requestId,
    stage,
    progress: operation.status === "succeeded"
      ? 100
      : operation.status === "refunded"
        ? 0
        : progressByStage[operation.pipelineStage] || 10,
    stageText: operation.status === "succeeded"
      ? "制作完成，最终图片已保存"
      : operation.status === "refunded"
        ? "本次制作没有完成"
        : stageTextByStage[operation.pipelineStage] || "正在准备图片",
    status: operation.status || "",
    intermediateAvailable: Boolean(operation.intermediateFileID),
    canRetryTencent: Boolean(canRetryTencent)
  }, operation.status === "succeeded" ? {
    result: operation.result || {}
  } : {}));
}

async function getTencentFaceFusionAdminStatus(context, dependencies = {}) {
  if (!isAdminContext(context)) return adminForbidden();
  const effectiveConfigs = await resolveEffectiveConfigs({ force: true });
  const config = effectiveConfigs.tencentFaceFusion;
  const statusDb = dependencies.db || db;
  let latest = null;
  try {
    latest = await readDocument(
      statusDb.collection(TENCENT_FACEFUSION_STATUS_COLLECTION).doc(TENCENT_FACEFUSION_STATUS_ID)
    );
  } catch (error) {
    log("warn", "tencent.facefusion.status-read-failed", {
      error: error && error.message
    });
  }
  return jsonResponse(true, {
    configured: config.configured,
    secretId: config.secretId,
    secretKey: config.secretKey,
    region: config.region,
    endpoint: config.endpoint,
    model: config.model,
    apiVersion: config.apiVersion,
    action: config.action,
    swapModelType: config.swapModelType,
    logoAdd: config.logoAdd,
    timeoutMs: config.timeoutMs,
    maxImageBytes: config.maxImageBytes,
    lastCallStatus: latest && latest.status || "not-called",
    lastCallStage: latest && latest.stage || "",
    lastErrorCode: latest && latest.errorCode || "",
    lastErrorMessage: latest && latest.errorMessage || "",
    lastRequestId: latest && latest.requestId || "",
    lastDurationMs: Number(latest && latest.durationMs) || 0,
    lastTestType: latest && latest.testType || "",
    lastCalledAt: latest && latest.calledAt
      ? new Date(latest.calledAt).toISOString()
      : "",
    checkedAt: new Date().toISOString()
  });
}

async function testTencentFaceFusion(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const payload = event && event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
  const templateFileID = String(payload.templateFileID || "").trim();
  const faceFileID = String(payload.faceFileID || "").trim();
  const requestId = String(
    event && event.requestId || payload.requestId || `admin-tencent-test-${Date.now()}`
  ).trim();
  if (!templateFileID || !faceFileID) {
    return fail("请先上传模板图和参考脸。", "TENCENT_FACEFUSION_TEST_ASSET_MISSING");
  }
  const effectiveConfigs = await resolveEffectiveConfigs({ force: true });
  const config = resolveTencentFaceFusionConfig(
    Object.assign(
      {},
      effectiveConfigs.tencentFaceFusion || {},
      payload.tencentFaceFusion || {}
    )
  );
  if (!config.configured) {
    return fail(
      "腾讯人脸融合还没有配置，请先填写云函数环境变量。",
      "TENCENT_FACEFUSION_NOT_CONFIGURED"
    );
  }
  const startedAt = Date.now();
  let statusPatch = {
    requestId,
    testType: "admin-real-call",
    status: "processing",
    stage: "facefusion",
    errorCode: "",
    errorMessage: "",
    calledAt: new Date(),
    region: config.region,
    model: config.model,
    durationMs: 0
  };
  await writeTencentFaceFusionStatus(statusPatch);
  try {
    const [templateBuffer, faceBuffer] = await Promise.all([
      downloadCloudFile(templateFileID, {
        requestId,
        action: "tencent.admin-test",
        fileType: "template"
      }),
      downloadCloudFile(faceFileID, {
        requestId,
        action: "tencent.admin-test",
        fileType: "face"
      })
    ]);
    const result = await requestTencentFaceFusion(
      templateBuffer,
      faceBuffer,
      config,
      requestId
    );
    const durationMs = Date.now() - startedAt;
    await writeTencentFaceFusionStatus(Object.assign({}, statusPatch, {
      status: "succeeded",
      stage: "succeeded",
      durationMs,
      completedAt: new Date()
    }));
    return jsonResponse(true, {
      requestId,
      tested: true,
      success: true,
      durationMs,
      resultBytes: result.length,
      model: config.model,
      region: config.region
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await writeTencentFaceFusionStatus(Object.assign({}, statusPatch, {
      status: "failed",
      stage: "facefusion",
      errorCode: String(error && error.code || "TENCENT_FACEFUSION_TEST_FAILED"),
      errorMessage: sanitizeFailureMessage(error && error.message || "腾讯真实测试失败"),
      durationMs,
      completedAt: new Date()
    }));
    return fail(
      error && error.message || "腾讯真实测试失败，请检查两张图片和腾讯配置。",
      String(error && error.code || "TENCENT_FACEFUSION_TEST_FAILED"),
      { requestId, durationMs, tested: true }
    );
  } finally {
    await Promise.all([templateFileID, faceFileID].map(async (fileID) => {
      try {
        await cloud.deleteFile({ fileList: [fileID] });
      } catch (error) {
        log("warn", "tencent.facefusion.admin-test-cleanup-failed", {
          requestId,
          fileID,
          error: error && error.message
        });
      }
    }));
  }
}

async function detectTencentPipelineFaces(mainFileID, requestId, context) {
  let result;
  try {
    result = await detectFaceCircle({
      requestId,
      payload: { mainFileID }
    }, context);
  } catch (error) {
    const wrapped = new Error(
      `腾讯版在修改衣服和背景前无法识别人脸：${
        error && error.message ? error.message : "人脸检测服务异常"
      }`
    );
    wrapped.code = "TENCENT_PIPELINE_FACE_DETECTION_FAILED";
    wrapped.retryable = Boolean(error && error.retryable);
    wrapped.pipelineStage = "preparing";
    throw wrapped;
  }
  if (!result || result.ok === false) {
    const error = new Error(
      `腾讯版在修改衣服和背景前无法识别人脸：${
        result && result.message ? result.message : "人脸检测没有返回结果"
      }`
    );
    error.code = result && result.errorCode === "empty-face-detection"
      ? "TENCENT_PIPELINE_FACE_NOT_FOUND"
      : "TENCENT_PIPELINE_FACE_DETECTION_FAILED";
    error.retryable = Boolean(result && result.retryable);
    error.pipelineStage = "preparing";
    throw error;
  }
  const faces = Array.isArray(result.faces) ? result.faces : [];
  if (!faces.length) {
    throw tencentPipelineMaskError(
      "主图里没有检测到清晰人脸，已停止图片编辑，避免把脸改掉。",
      "TENCENT_PIPELINE_FACE_NOT_FOUND"
    );
  }
  return faces;
}

async function tencentFaceFusionPipeline(event, context) {
  if (!isAdminContext(context)) return adminForbidden();
  const payload = event && event.payload && typeof event.payload === "object"
    ? event.payload
    : {};
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail("请先完成微信授权后再使用腾讯版制作。", "wechat-binding-required");
  }
  const requestId = String(event && event.requestId || payload.requestId || "").trim();
  const mainFileID = String(payload.mainFileID || "").trim();
  const faceFileID = String(payload.faceFileID || "").trim();
  const prompt = String(payload.prompt || "").trim();
  const negativePrompt = String(payload.negativePrompt || "").trim();
  const pipelineVersion = String(
    payload.pipelineVersion || "gpt-image-2-tencent-facefusion-v1"
  ).trim();
  const retryTencentOnly = Boolean(payload.retryTencentOnly);
  if (!requestId) return fail("缺少腾讯版制作请求编号。", "TENCENT_REQUEST_ID_MISSING");
  if (!mainFileID || !faceFileID) {
    return fail("请先上传原始主图和参考脸。", "TENCENT_PIPELINE_ASSET_MISSING");
  }
  if (!retryTencentOnly && !prompt) {
    return fail("修改说明不能为空。", "TENCENT_PIPELINE_PROMPT_EMPTY");
  }
  const configs = await resolveEffectiveConfigs();
  const imageConfig = Object.assign({}, configs.image, {
    mode: "edits"
  });
  const imageBackupConfig = Object.assign({}, configs.imageBackup, {
    mode: "edits"
  });
  const tencent = configs.tencentFaceFusion;
  pixelProtectionFlow.assertTencentFaceFusionFlow(tencent);
  const imageBackupUsable = Boolean(
    imageBackupConfig.enabled
    && imageBackupConfig.apiKey
    && (imageBackupConfig.baseUrl || imageBackupConfig.endpoint)
    && imageBackupConfig.model
  );
  if (!retryTencentOnly && !imageConfig.apiKey && !imageBackupUsable) {
    return fail(
      "图片主模型和备用模型都还没有配置密钥，暂时不能执行第一阶段。",
      "TENCENT_PIPELINE_IMAGE_PROVIDER_NOT_CONFIGURED"
    );
  }
  if (!tencent.configured) {
    return fail(
      "腾讯人脸融合还没有配置，请让管理员填写云函数环境变量。",
      "TENCENT_FACEFUSION_NOT_CONFIGURED",
      { configHint: "TENCENT_FACEFUSION_SECRET_ID / TENCENT_FACEFUSION_SECRET_KEY" }
    );
  }
  const existingRecord = await findGenerationRecord(openid, requestId);
  if (existingRecord) {
    return jsonResponse(true, {
      requestId,
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
  await findUserAsset(openid, mainFileID, "main");
  await findUserAsset(openid, faceFileID, "face");

  let preparedMainBuffer = null;
  let preparedFaceBuffer = null;
  let mainPixelImage = null;
  let facePixelImage = null;
  let faceProtectionRects = null;
  let tencentPixelProtection = null;
  if (!retryTencentOnly) {
    [preparedMainBuffer, preparedFaceBuffer] = await Promise.all([
      downloadCloudFile(mainFileID, {
        requestId,
        action: "tencent.pipeline.preflight",
        fileType: "main"
      }),
      downloadCloudFile(faceFileID, {
        requestId,
        action: "tencent.pipeline.preflight",
        fileType: "face"
      })
    ]);
    const preflight = pixelProtectionFlow.preflightTencentAssets(
      preparedMainBuffer,
      preparedFaceBuffer,
      {
        maxPixels: pixelCodec.DEFAULT_MAX_PIXELS,
        maxTencentBytes: tencent.maxImageBytes
      }
    );
    mainPixelImage = preflight.mainImage;
    facePixelImage = preflight.faceImage;
  }

  let billing = null;
  let claim = null;
  let claimed = false;
  let resultPersisted = false;
  let operation = await findGenerationOperation(openid, requestId);
  let intermediateFileID = String(operation && operation.intermediateFileID || "").trim();
  let successfulImageProvider = String(
    operation && (operation.activeImageProvider || operation.provider)
    || imageConfig.provider
    || ""
  );
  let successfulImageModel = String(
    operation && (operation.activeImageModel || operation.model)
    || imageConfig.model
    || ""
  );
  let successfulProviderRole = String(
    operation && (operation.imageProviderRole || operation.providerRole)
    || "primary"
  );
  let successfulProviderAttempt = Math.max(
    1,
    Number(
      operation && (operation.imageProviderAttempt || operation.providerAttempt)
    ) || 1
  );
  let successfulProviderAttempts = Array.isArray(
    operation && (operation.imageProviderAttempts || operation.providerAttempts)
  )
    ? (operation.imageProviderAttempts || operation.providerAttempts)
    : [];
  try {
    if (retryTencentOnly) {
      claim = await claimTencentPipelineResume(openid, requestId);
      operation = claim.operation || operation;
      if (claim.completed && operation && operation.result) {
        return jsonResponse(true, Object.assign({}, operation.result, {
          requestId,
          deduplicated: true
        }));
      }
      if (!claim.claimed) throw operationStateError(operation);
      claimed = true;
      intermediateFileID = String(operation.intermediateFileID || "").trim();
      successfulImageProvider = String(
        operation.activeImageProvider
        || operation.provider
        || successfulImageProvider
      );
      successfulImageModel = String(
        operation.activeImageModel
        || operation.model
        || successfulImageModel
      );
      successfulProviderRole = String(
        operation.imageProviderRole
        || operation.providerRole
        || successfulProviderRole
      );
      successfulProviderAttempt = Math.max(
        1,
        Number(
          operation.imageProviderAttempt
          || operation.providerAttempt
          || successfulProviderAttempt
        ) || 1
      );
      successfulProviderAttempts = Array.isArray(
        operation.imageProviderAttempts || operation.providerAttempts
      )
        ? (operation.imageProviderAttempts || operation.providerAttempts)
        : successfulProviderAttempts;
    } else {
      billing = await reserveUsage(openid, requestId, "image");
      claim = billing.untracked
        ? { claimed: true, completed: false, operation: null }
        : await claimGenerationOperation(openid, requestId, "image");
      if (claim.completed && claim.operation && claim.operation.result) {
        return jsonResponse(true, Object.assign({}, claim.operation.result, {
          requestId,
          deduplicated: true,
          billing
        }));
      }
      if (!claim.claimed) throw operationStateError(claim.operation);
      claimed = true;
      operation = claim.operation || operation;
    }

    if (!retryTencentOnly) {
      await writeTencentFaceFusionStatus({
        requestId,
        status: "processing",
        stage: "preparing",
        progress: 15,
        errorCode: "",
        errorMessage: "",
        calledAt: new Date(),
        region: tencent.region,
        model: tencent.model
      });
      if (!billing || !billing.untracked) {
        await updateGenerationOperation(openid, requestId, {
          pipelineVersion,
          pipelineStage: "face-detection",
          mainFileID,
          faceFileID,
          retryTencentOnly: false
        }, { allowedStatuses: ["processing"] });
      }
      const detectedFaces = await detectTencentPipelineFaces(
        mainFileID,
        requestId,
        context
      );
      const mainBuffer = preparedMainBuffer || await downloadCloudFile(mainFileID, {
        requestId,
        action: "tencent.pipeline.image-edit",
        fileType: "main"
      });
      if (!mainPixelImage) {
        mainPixelImage = pixelCodec.decodeImage(mainBuffer, {
          label: "腾讯版主图",
          maxPixels: pixelCodec.DEFAULT_MAX_PIXELS
        });
      }
      const faceProtectionMask = createFaceProtectionMask(mainBuffer, detectedFaces);
      faceProtectionRects = faceProtectionMask.rects;
      log("info", "tencent.pipeline.face-protection-ready", {
        requestId,
        faceCount: faceProtectionMask.faceCount,
        imageSize: `${faceProtectionMask.width}x${faceProtectionMask.height}`,
        sourceFormat: faceProtectionMask.sourceFormat,
        marginRatio: TENCENT_FACE_PROTECTION_MARGIN_RATIO,
        maskBytes: faceProtectionMask.buffer.length
      });
      if (!billing || !billing.untracked) {
        await updateGenerationOperation(openid, requestId, {
          pipelineStage: "image-edit",
          detectedFaceCount: faceProtectionMask.faceCount,
          faceProtectionMaskReady: true
        }, { allowedStatuses: ["processing"] });
      }
      const imageProviderResult = await runImageEditProviderFailover({
        requestId,
        openid,
        primaryConfig: imageConfig,
        backupConfig: imageBackupConfig,
        executeAttempt: async (attempt) => {
          const config = attempt.config || {};
          if (!config.apiKey) {
            const error = new Error(
              `${attempt.role === "backup" ? "备用" : "主"}图片模型还没有配置密钥。`
            );
            error.code = "missing-api-key";
            error.retryable = false;
            throw error;
          }
          const response = await requestTencentPipelineImageEdit(
            mainBuffer,
            { prompt, negativePrompt, size: config.size },
            config,
            configs.costs,
            requestId,
            usageUserHash(openid),
            faceProtectionMask.buffer,
            {
              allowRetry: false,
              maxAttempts: 1,
              idempotencyKey: attempt.idempotencyKey,
              usageRequestId: attempt.idempotencyKey
            }
          );
          const attemptedImage = extractImageItem(response);
          if (!attemptedImage) {
            const error = new Error("图片模型没有返回中间图片。");
            error.code = "TENCENT_PIPELINE_IMAGE_EMPTY";
            error.retryable = true;
            throw error;
          }
          const attemptedBuffer = attemptedImage.buffer || await downloadUrl(
            attemptedImage.url,
            {
              requestId: attempt.idempotencyKey,
              action: "tencent.pipeline.image-result"
            }
          );
          const protectedIntermediate = pixelProtectionFlow.protectTencentIntermediate(
            mainPixelImage,
            attemptedBuffer,
            faceProtectionMask.rects,
            {
              maxPixels: pixelCodec.DEFAULT_MAX_PIXELS,
              maxTencentBytes: tencent.maxImageBytes
            }
          );
          const dimensionNormalization =
            protectedIntermediate.protection.dimensionNormalization;
          if (dimensionNormalization && dimensionNormalization.resized) {
            log("info", "image-edit.dimension-normalized", {
              requestId: attempt.idempotencyKey,
              provider: config.provider || "",
              model: config.model || "",
              pipeline: "tencent-first-stage",
              ...dimensionNormalization
            });
          }
          return {
            response,
            image: attemptedImage,
            protectedIntermediate
          };
        }
      });
      const successfulImageConfig = imageProviderResult.providerRole === "backup"
        ? imageBackupConfig
        : imageConfig;
      successfulImageProvider = String(successfulImageConfig.provider || "");
      successfulImageModel = String(successfulImageConfig.model || "");
      successfulProviderRole = imageProviderResult.providerRole;
      successfulProviderAttempt = imageProviderResult.providerAttempt;
      successfulProviderAttempts = imageProviderResult.attempts;
      const protectedIntermediate = imageProviderResult.value.protectedIntermediate;
      tencentPixelProtection = protectedIntermediate;
      const intermediate = await cloud.uploadFile({
        cloudPath: `tencent-facefusion/intermediate/${openid}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
        fileContent: protectedIntermediate.buffer
      });
      intermediateFileID = intermediate.fileID;
      await registerTencentFaceFusionIntermediateAsset(
        intermediateFileID,
        openid,
        requestId
      );
      if (!billing || !billing.untracked) {
        await updateGenerationOperation(openid, requestId, {
          pipelineStage: "facefusion",
          intermediateFileID,
          intermediateExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
          provider: successfulImageConfig.provider || "",
          model: successfulImageConfig.model || "",
          providerRole: imageProviderResult.providerRole,
          providerAttempt: imageProviderResult.providerAttempt,
          providerAttempts: imageProviderResult.attempts,
          activeImageProvider: successfulImageConfig.provider || "",
          activeImageModel: successfulImageConfig.model || "",
          imageProviderRole: imageProviderResult.providerRole,
          imageProviderAttempt: imageProviderResult.providerAttempt,
          imageProviderAttempts: imageProviderResult.attempts,
          pixelProtection: {
            version: protectedIntermediate.protection.version,
            width: protectedIntermediate.protection.width,
            height: protectedIntermediate.protection.height,
            faceProtectionRects: protectedIntermediate.protection.rects,
            featherPixels: protectedIntermediate.protection.featherPixels,
            dimensionNormalization:
              protectedIntermediate.protection.dimensionNormalization
          },
          pixelProtectionMetrics: {
            imageEditIntermediate: protectedIntermediate.metrics
          }
        }, { allowedStatuses: ["processing"] });
      }
    } else {
      await writeTencentFaceFusionStatus({
        requestId,
        status: "processing",
        stage: "facefusion",
        progress: 85,
        errorCode: "",
        errorMessage: "",
        calledAt: new Date(),
        region: tencent.region,
        model: tencent.model
      });
    }

    if (!intermediateFileID) {
      const error = new Error("没有找到 GPT Image 2 的中间图，无法进行腾讯换脸。");
      error.code = "TENCENT_PIPELINE_INTERMEDIATE_MISSING";
      throw error;
    }
    const faceBuffer = preparedFaceBuffer || await downloadCloudFile(faceFileID, {
      requestId,
      action: "tencent.facefusion",
      fileType: "face"
    });
    const intermediateBuffer = await downloadCloudFile(intermediateFileID, {
      requestId,
      action: "tencent.facefusion",
      fileType: "intermediate"
    });
    const intermediateImage = pixelCodec.decodeImage(intermediateBuffer, {
      label: "腾讯版已验收中间图",
      maxPixels: pixelCodec.DEFAULT_MAX_PIXELS
    });
    if (retryTencentOnly) {
      const restored = pixelProtectionFlow.restoreTencentProtectionState(
        operation,
        intermediateImage
      );
      faceProtectionRects = restored.rects;
      tencentPixelProtection = {
        metrics: restored.metrics.imageEditIntermediate,
        protection: {
          version: restored.version,
          rects: restored.rects,
          width: restored.width,
          height: restored.height,
          featherPixels: Number(
            operation
            && operation.pixelProtection
            && operation.pixelProtection.featherPixels
          ) || 0
        }
      };
    }
    if (!Array.isArray(faceProtectionRects) || !faceProtectionRects.length) {
      throw new Error("腾讯版缺少已验收的人脸保护矩形。");
    }
    if (!mainPixelImage) {
      const originalBuffer = await downloadCloudFile(mainFileID, {
        requestId,
        action: "tencent.facefusion-metrics",
        fileType: "main"
      });
      mainPixelImage = pixelCodec.decodeImage(originalBuffer, {
        label: "腾讯版原始主图",
        maxPixels: pixelCodec.DEFAULT_MAX_PIXELS
      });
    }
    if (!facePixelImage) {
      facePixelImage = pixelCodec.decodeImage(faceBuffer, {
        label: "腾讯版参考脸",
        maxPixels: pixelCodec.DEFAULT_MAX_PIXELS
      });
    }
    if (!billing || !billing.untracked) {
      await updateGenerationOperation(openid, requestId, {
        pipelineStage: "facefusion"
      }, { allowedStatuses: ["processing"] });
    }
    const rawFinalBuffer = await requestTencentFaceFusion(
      intermediateBuffer,
      faceBuffer,
      tencent,
      requestId
    );
    const protectedFinal = pixelProtectionFlow.protectTencentFinal(
      intermediateImage,
      rawFinalBuffer,
      faceProtectionRects,
      {
        originalImage: mainPixelImage,
        maxPixels: pixelCodec.DEFAULT_MAX_PIXELS
      }
    );
    const finalUploaded = await cloud.uploadFile({
      cloudPath: `results/${openid}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.png`,
      fileContent: protectedFinal.buffer
    });
    const tempResult = await cloud.getTempFileURL({
      fileList: [finalUploaded.fileID]
    });
    const tempFileURL = tempResult.fileList
      && tempResult.fileList[0]
      && tempResult.fileList[0].tempFileURL
      || "";
    const createdAt = new Date();
    const recordData = {
      openid,
      projectName: String(payload.projectName || "腾讯版自动换脸"),
      prompt,
      negativePrompt,
      fileID: finalUploaded.fileID,
      tempFileURL,
      provider: successfulImageProvider,
      model: successfulImageModel,
      providerRole: successfulProviderRole,
      providerAttempt: successfulProviderAttempt,
      providerAttempts: successfulProviderAttempts,
      tencentModel: tencent.model,
      tencentRegion: tencent.region,
      pixelProtection: {
        version: pixelProtectionFlow.PIXEL_PROTECTION_VERSION,
        mode: "tencent-rect-before-and-after",
        rects: faceProtectionRects,
        metrics: {
          imageEditIntermediate: tencentPixelProtection
            ? tencentPixelProtection.metrics
            : null,
          tencentFinalRelativeIntermediate: protectedFinal.addedMetrics,
          tencentFinalRelativeOriginal: protectedFinal.originalMetrics
        }
      },
      imageMode: "tencent-face-fusion",
      generationType: "tencent-face-fusion",
      pipelineVersion,
      requestId,
      createdAt,
      quotaUsed: billing && billing.quota ? billing.quota.freeUsed : 0,
      dailyLimit: billing && billing.quota ? billing.quota.freeLimit : 0,
      billingSource: billing && billing.source || "retry-after-refund",
      pointsCharged: billing && billing.pointsCharged || 0,
      repairContext: {
        sourceFileID: finalUploaded.fileID,
        originalMainFileID: mainFileID,
        mainInputFileID: mainFileID,
        faceFileIDs: [faceFileID],
        assetRegistrationVersion: 1
      }
    };
    const saved = await db.collection("generation_records").add({ data: recordData });
    resultPersisted = true;
    const result = {
      requestId,
      recordId: saved._id,
      fileID: finalUploaded.fileID,
      tempFileURL,
      createdAt: createdAt.toISOString(),
      provider: successfulImageProvider,
      model: successfulImageModel,
      providerRole: successfulProviderRole,
      providerAttempt: successfulProviderAttempt,
      providerAttempts: successfulProviderAttempts,
      record: Object.assign({}, recordData, {
        id: saved._id,
        createdAt: createdAt.toISOString()
      }),
      pipelineStage: "succeeded",
      quota: billing && billing.quota || null,
      billing: billing || (operation && operation.billing) || null
    };
    if (!billing || !billing.untracked) {
      await updateGenerationOperation(openid, requestId, {
        intermediateFileID: ""
      }, { allowedStatuses: ["processing"] });
      await completeGenerationOperation(openid, requestId, result);
    }
    await writeTencentFaceFusionStatus({
      requestId,
      status: "succeeded",
      stage: "succeeded",
      progress: 100,
      errorCode: "",
      errorMessage: "",
      completedAt: new Date(),
      region: tencent.region,
      model: tencent.model
    });
    try {
      await cloud.deleteFile({ fileList: [intermediateFileID] });
      await removeTencentFaceFusionIntermediateAsset(intermediateFileID, requestId);
    } catch (error) {
      log("warn", "tencent.facefusion.intermediate-cleanup-failed", {
        requestId,
        error: error && error.message
      });
    }
    return jsonResponse(true, result);
  } catch (error) {
    const pipelineStage = String(
      error && error.pipelineStage
      || operation && operation.pipelineStage
      || (intermediateFileID ? "facefusion" : "preparing")
    );
    const canRetryTencent = Boolean(
      intermediateFileID
      && pipelineStage === "facefusion"
      && !resultPersisted
    );
    if (claimed && !resultPersisted && (!billing || !billing.untracked)) {
      try {
        await failGenerationOperation(openid, requestId, error);
        if (billing && !billing.untracked) {
          await refundUsage(openid, requestId, "腾讯版制作失败，已退回本次使用额度");
        } else if (retryTencentOnly) {
          await updateGenerationOperation(openid, requestId, {
            status: "refunded",
            intermediateFileID,
            pipelineStage: "facefusion",
            refundReason: "腾讯换脸重试失败，保留中间图",
            refundedAt: new Date()
          }, { allowedStatuses: ["failed", "processing"] });
        }
      } catch (billingError) {
        log("error", "tencent.facefusion.refund-failed", {
          requestId,
          error: billingError && billingError.message
        });
      }
    }
    await writeTencentFaceFusionStatus({
      requestId,
      status: "failed",
      stage: pipelineStage,
      progress: pipelineStage === "facefusion" ? 85 : 35,
      errorCode: String(error && error.code || "TENCENT_PIPELINE_FAILED"),
      errorMessage: sanitizeFailureMessage(error && error.message || "腾讯版制作失败"),
      completedAt: new Date(),
      region: tencent.region,
      model: tencent.model
    });
    return fail(
      error && error.message || "腾讯版制作失败，请稍后重试。",
      String(error && error.code || "TENCENT_PIPELINE_FAILED"),
      {
        requestId,
        pipelineStage,
        progress: pipelineStage === "facefusion" ? 85 : 35,
        canRetryTencent,
        intermediateAvailable: canRetryTencent,
        refunded: Boolean(billing && !billing.untracked),
        retryable: Boolean(error && error.retryable)
      }
    );
  }
}

function buildImageRequestFromOperation(operation, imageConfig = resolveImageConfig()) {
  const payload = operation && operation.payload && typeof operation.payload === "object"
    ? operation.payload
    : {};
  const mode = resolveGenerationMode(payload, imageConfig);
  if (mode !== "edits") return buildImageGenerationPayload(payload, imageConfig);
  return {
    model: String(imageConfig.model || payload.model || "").trim(),
    prompt: `${String(payload.prompt || "").trim()}${
      payload.negativePrompt
        ? `\n\n负面约束：${String(payload.negativePrompt).trim()}`
        : ""
    }`,
    size: resolveImageOutputSize(imageConfig, payload.size),
    quality: imageConfig.compatibilityMode ? "" : "auto",
    n: 1
  };
}

function buildImageRequestMeta(
  operation,
  imageConfig = resolveImageConfig(),
  costs = resolveCostConfig(),
  requestOptions = {}
) {
  const request = buildImageRequestFromOperation(operation, imageConfig);
  return {
    requestId: String(operation && operation.requestId || ""),
    action: "generate",
    provider: imageConfig.provider || "",
    model: imageConfig.model || "",
    imageGeneration: true,
    allowRetry: hasOwn(requestOptions, "allowRetry")
      ? Boolean(requestOptions.allowRetry)
      : imageConfig.retryEnabled,
    maxAttempts: hasOwn(requestOptions, "maxAttempts")
      ? Math.max(1, Number(requestOptions.maxAttempts) || 1)
      : imageConfig.retryEnabled
        ? imageConfig.maxRetries + 1
        : 1,
    timeoutMs: imageConfig.timeoutMs,
    costs,
    userHash: usageUserHash(operation && operation.openid || "anonymous"),
    imageResolution: imageConfig.resolution
      || normalizeImageResolution(request.size, "1K")
  };
}

function buildGenerationRecordData(openid, operation, result, billing = {}) {
  const payload = operation && operation.payload && typeof operation.payload === "object"
    ? operation.payload
    : {};
  const createdAtValue = result && result.createdAt ? new Date(result.createdAt) : new Date();
  const createdAt = Number.isNaN(createdAtValue.getTime()) ? new Date() : createdAtValue;
  const mode = String(
    result && result.imageMode
    || operation && operation.imageMode
    || payload.mode
    || "generations"
  );
  const fileID = String(result && result.fileID || operation && operation.resultFileID || "");
  const quota = billing && billing.quota && typeof billing.quota === "object"
    ? billing.quota
    : {};
  return {
    openid,
    projectName: payload.projectName || "未命名项目",
    prompt: String(payload.prompt || ""),
    negativePrompt: String(payload.negativePrompt || ""),
    fileID,
    tempFileURL: String(result && result.tempFileURL || operation && operation.tempFileURL || ""),
    provider: String(result && result.provider || operation && operation.provider || ""),
    model: String(result && result.model || operation && operation.model || ""),
    providerRole: String(
      result && result.providerRole
      || operation && operation.providerRole
      || ""
    ),
    providerAttempt: Math.max(
      1,
      Number(
        result && result.providerAttempt
        || operation && operation.providerAttempt
      ) || 1
    ),
    providerAttempts: sanitizeImageProviderAttempts(
      result && result.providerAttempts
      || operation && operation.providerAttempts
    ),
    createdAt,
    size: String(result && result.size || operation && operation.size || ""),
    resolution: String(result && result.resolution || operation && operation.resolution || ""),
    quality: String(result && result.quality || operation && operation.quality || ""),
    compatibilityMode: Boolean(
      result && result.compatibilityMode !== undefined
        ? result.compatibilityMode
        : operation && operation.compatibilityMode
    ),
    imageMode: mode,
    pixelProtection: result && result.pixelProtection
      || operation && operation.pixelProtection
      || null,
    requestId: String(operation && operation.requestId || ""),
    quotaUsed: Math.max(0, Number(quota.freeUsed) || 0),
    dailyLimit: Math.max(0, Number(quota.freeLimit) || 0),
    billingSource: String(billing.source || ""),
    pointsCharged: Math.max(0, Number(billing.pointsCharged) || 0),
    generationType: "normal",
    revisionNumber: 0,
    repairContext: {
      sourceFileID: fileID,
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
        : [],
      backgroundFileIDs: Array.isArray(payload.backgroundFileIDs)
        ? payload.backgroundFileIDs.filter(Boolean).slice(0, 3)
        : []
    }
  };
}

async function persistGenerationResult(openid, operation, result, billing = {}) {
  const requestId = String(operation && operation.requestId || "");
  const existing = await findGenerationRecord(openid, requestId);
  if (existing) {
    return {
      created: false,
      recordId: existing._id || existing.id || "",
      fileID: existing.fileID || result && result.fileID || "",
      tempFileURL: existing.tempFileURL || result && result.tempFileURL || "",
      createdAt: serializeGenerationDate(existing.createdAt || result && result.createdAt),
      record: Object.assign({}, existing, {
        id: existing._id || existing.id || "",
        createdAt: serializeGenerationDate(existing.createdAt)
      })
    };
  }
  const recordData = buildGenerationRecordData(openid, operation, result, billing);
  const recordId = normalGenerationRecordId(openid, requestId);
  await db.collection("generation_records").doc(recordId).set({
    data: stripDocumentId(recordData)
  });
  if (Number(operation && operation.payload && operation.payload.assetRegistrationVersion) >= 1) {
    try {
      const latest = await findGenerationOperation(openid, requestId);
      if (!latest || !latest.assetsRetainedAt) {
        const payload = operation.payload || {};
        await db.runTransaction(async (transaction) => {
          await retainUserAssets(openid, [payload.mainFileID], "main", transaction);
          await retainUserAssets(openid, [payload.maskFileID], "mask", transaction);
          await retainUserAssets(openid, payload.faceFileIDs, "face", transaction);
          await retainUserAssets(openid, payload.wardrobeFileIDs, "wardrobe", transaction);
          await retainUserAssets(openid, payload.backgroundFileIDs, "background", transaction);
        }, 5);
        await updateGenerationOperation(openid, requestId, {
          assetsRetainedAt: new Date()
        }, {
          allowedStatuses: ["processing", "failed", "succeeded"]
        });
      }
    } catch (error) {
      log("warn", "generation.asset_retain_failed", {
        requestId,
        recordId,
        message: sanitizeFailureMessage(error && error.message)
      });
    }
  }
  return {
    created: true,
    recordId,
    fileID: recordData.fileID,
    tempFileURL: recordData.tempFileURL,
    createdAt: recordData.createdAt.toISOString(),
    record: Object.assign({}, recordData, {
      id: recordId,
      createdAt: recordData.createdAt.toISOString()
    })
  };
}

async function generationTempFileUrl(fileID, requestId) {
  if (!fileID) return "";
  try {
    const tempResult = await cloud.getTempFileURL({ fileList: [fileID] });
    return tempResult
      && Array.isArray(tempResult.fileList)
      && tempResult.fileList[0]
      && tempResult.fileList[0].tempFileURL
      || "";
  } catch (error) {
    log("warn", "generation.temp-url-failed", {
      requestId,
      fileID,
      error: sanitizeFailureMessage(error && error.message)
    });
    return "";
  }
}

async function executeImageGeneration(operation, context = {}) {
  const payload = operation && operation.payload && typeof operation.payload === "object"
    ? operation.payload
    : {};
  const requestId = String(operation && operation.requestId || "");
  const openid = String(operation && operation.openid || "");
  const imageConfig = context.imageConfig || resolveImageConfig();
  const imageBackupConfig = context.imageBackupConfig || resolveImageBackupConfig();
  const costs = context.costs || resolveCostConfig();
  const touchOperation = context.touchOperation || touchGenerationOperation;
  const validateAssets = context.validateAssets || validateGenerationAssets;
  const downloadInputFile = context.downloadInputFile || downloadCloudFile;
  const requestEdits = context.requestEdits || requestImageEdits;
  const requestGeneration = context.requestGeneration || (
    (url, body, apiKey, headers, requestMeta) => requestJson(
      url,
      body,
      apiKey,
      headers,
      requestMeta
    )
  );
  const downloadResult = context.downloadResult || downloadUrl;
  const uploadResult = context.uploadResult || (
    ({ cloudPath, fileContent }) => cloud.uploadFile({ cloudPath, fileContent })
  );
  const updateOperation = context.updateOperation || updateGenerationOperation;
  const tempFileUrl = context.tempFileUrl || generationTempFileUrl;
  const currentTime = context.now || (() => new Date());
  const randomSuffix = context.randomSuffix || (
    () => crypto.randomBytes(4).toString("hex")
  );
  const mode = resolveGenerationMode(payload, imageConfig);
  const imageBackupUsable = Boolean(
    imageBackupConfig.enabled
    && imageBackupConfig.apiKey
    && (imageBackupConfig.baseUrl || imageBackupConfig.endpoint)
    && imageBackupConfig.model
  );
  if (
    mode === "edits"
      ? !imageConfig.apiKey && !imageBackupUsable
      : !imageConfig.apiKey
  ) {
    const error = new Error("云函数还没有配置图片服务密钥。");
    error.code = "missing-api-key";
    error.retryable = false;
    throw error;
  }
  await touchOperation(openid, requestId, "validate", 5);
  await validateAssets(openid, payload);
  let imageRequest = buildImageRequestFromOperation(operation, imageConfig);
  let normalPixelPreflight = null;
  let preparedAssets = null;
  if (mode === "edits") {
    const references = imageEditReferences(payload);
    const [mainBuffer, maskBuffer, referenceBuffers] = await Promise.all([
      downloadInputFile(payload.mainFileID, {
        requestId,
        action: "generate.preflight",
        fileType: "main"
      }),
      downloadInputFile(payload.maskFileID, {
        requestId,
        action: "generate.preflight",
        fileType: "mask"
      }),
      Promise.all(references.map(async (reference) => ({
        reference,
        buffer: await downloadInputFile(reference.fileID, {
          requestId,
          action: "generate.preflight",
          fileType: reference.role
        })
      })))
    ]);
    normalPixelPreflight = pixelProtectionFlow.preflightNormalAssets(
      mainBuffer,
      maskBuffer,
      payload.maskGeometry,
      { maxPixels: pixelCodec.DEFAULT_MAX_PIXELS }
    );
    preparedAssets = {
      mainBuffer,
      maskBuffer,
      referenceBuffers
    };
  }
  await touchOperation(openid, requestId, "upstream", 35);
  let effectiveImageConfig = imageConfig;
  let providerRole = "primary";
  let providerAttempt = 1;
  let providerAttempts = [];
  let upstream;
  let image;
  let rawBuffer;
  let protectedNormal = null;
  if (mode === "edits") {
    const providerResult = await runImageEditProviderFailover({
      requestId,
      openid,
      primaryConfig: imageConfig,
      backupConfig: imageBackupConfig,
      executeAttempt: async (attempt) => {
        const config = attempt.config || {};
        if (!config.apiKey) {
          const error = new Error(
            `${attempt.role === "backup" ? "备用" : "主"}图片模型还没有配置密钥。`
          );
          error.code = "missing-api-key";
          error.retryable = false;
          throw error;
        }
        const response = await requestEdits(
          Object.assign({}, payload, { __action: "generate" }),
          config.apiKey,
          requestId,
          config,
          costs,
          usageUserHash(openid),
          preparedAssets,
          {
            allowRetry: false,
            maxAttempts: 1,
            idempotencyKey: attempt.idempotencyKey,
            usageRequestId: attempt.idempotencyKey
          }
        );
        const attemptedImage = extractImageItem(response);
        if (!attemptedImage) {
          const error = new Error("图片接口没有返回图片。");
          error.code = "empty-image-result";
          error.retryable = false;
          throw error;
        }
        const attemptedRawBuffer = attemptedImage.buffer || await downloadResult(
          attemptedImage.url,
          {
            requestId: attempt.idempotencyKey,
            action: "generate-result"
          }
        );
        const attemptedProtected = pixelProtectionFlow.protectNormalResult(
          normalPixelPreflight,
          attemptedRawBuffer,
          { maxPixels: pixelCodec.DEFAULT_MAX_PIXELS }
        );
        const dimensionNormalization =
          attemptedProtected.protection.dimensionNormalization;
        if (dimensionNormalization && dimensionNormalization.resized) {
          log("info", "image-edit.dimension-normalized", {
            requestId: attempt.idempotencyKey,
            provider: config.provider || "",
            model: config.model || "",
            pipeline: "normal",
            ...dimensionNormalization
          });
        }
        return {
          upstream: response,
          image: attemptedImage,
          rawBuffer: attemptedRawBuffer,
          protectedNormal: attemptedProtected
        };
      }
    });
    effectiveImageConfig = providerResult.providerRole === "backup"
      ? imageBackupConfig
      : imageConfig;
    providerRole = providerResult.providerRole;
    providerAttempt = providerResult.providerAttempt;
    providerAttempts = providerResult.attempts;
    upstream = providerResult.value.upstream;
    image = providerResult.value.image;
    rawBuffer = providerResult.value.rawBuffer;
    protectedNormal = providerResult.value.protectedNormal;
    imageRequest = buildImageRequestFromOperation(operation, effectiveImageConfig);
  } else {
    upstream = await requestGeneration(
      imageConfig.endpoint || endpoint(imageConfig.baseUrl, "images/generations"),
      imageRequest,
      imageConfig.apiKey,
      { "Idempotency-Key": requestId },
      buildImageRequestMeta(operation, imageConfig, costs)
    );
  }
  await touchOperation(openid, requestId, "download", 70);
  image = image || extractImageItem(upstream);
  if (!image) {
    const error = new Error("图片接口没有返回图片。");
    error.code = "empty-image-result";
    error.retryable = false;
    throw error;
  }
  rawBuffer = rawBuffer || image.buffer || await downloadResult(image.url, {
    requestId,
    action: "generate-result"
  });
  protectedNormal = protectedNormal || (normalPixelPreflight
    ? pixelProtectionFlow.protectNormalResult(
        normalPixelPreflight,
        rawBuffer,
        { maxPixels: pixelCodec.DEFAULT_MAX_PIXELS }
      )
    : null);
  const buffer = protectedNormal ? protectedNormal.buffer : rawBuffer;
  const mime = protectedNormal ? "image/png" : image.mime || detectMime(buffer);
  const pixelProtection = protectedNormal
    ? {
        version: protectedNormal.protection.version,
        mode: protectedNormal.protection.mode,
        geometry: protectedNormal.protection.geometry,
        featherPixels: protectedNormal.protection.featherPixels,
        dimensionNormalization:
          protectedNormal.protection.dimensionNormalization,
        metrics: protectedNormal.metrics,
        outputBytes: protectedNormal.protection.outputBytes
      }
    : null;
  await touchOperation(openid, requestId, "upload", 85);
  const createdAt = currentTime();
  const uploaded = await uploadResult({
    cloudPath: `results/${openid}/${createdAt.getTime()}-${randomSuffix()}.${imageExtension(mime)}`,
    fileContent: buffer
  });
  const fileID = String(uploaded && uploaded.fileID || "");
  if (!fileID) {
    const error = new Error("生成图片上传失败。");
    error.code = "result-upload-failed";
    error.retryable = true;
    throw error;
  }
  const resolution = effectiveImageConfig.resolution
    || normalizeImageResolution(imageRequest.size, "1K");
  await updateOperation(openid, requestId, {
    pipelineStage: "upload",
    progress: 90,
    resultFileID: fileID,
    resultCreatedAt: createdAt,
    provider: effectiveImageConfig.provider || "",
    model: effectiveImageConfig.model || "",
    providerRole,
    providerAttempt,
    providerAttempts,
    activeImageProvider: effectiveImageConfig.provider || "",
    activeImageModel: effectiveImageConfig.model || "",
    imageProviderRole: providerRole,
    imageProviderAttempt: providerAttempt,
    imageProviderAttempts: providerAttempts,
    size: imageRequest.size || "",
    resolution,
    quality: imageRequest.quality || "",
    compatibilityMode: Boolean(effectiveImageConfig.compatibilityMode),
    imageMode: mode,
    pixelProtection,
    lastHeartbeatAt: currentTime()
  }, {
    allowedStatuses: ["processing"]
  });
  const tempFileURL = await tempFileUrl(fileID, requestId);
  return {
    requestId,
    fileID,
    tempFileURL,
    createdAt: createdAt.toISOString(),
    provider: effectiveImageConfig.provider || "",
    model: effectiveImageConfig.model || "",
    providerRole,
    providerAttempt,
    providerAttempts,
    size: imageRequest.size || "",
    resolution,
    quality: imageRequest.quality || "",
    compatibilityMode: Boolean(effectiveImageConfig.compatibilityMode),
    imageMode: mode,
    pixelProtection
  };
}

async function claimNextQueuedGenerationOperation(dependencies = {}) {
  const store = dependencies.store || db;
  const findOperation = dependencies.findOperation || findGenerationOperation;
  const saveOperation = dependencies.saveOperation || saveGenerationOperation;
  const currentTime = dependencies.now || (() => new Date());
  const result = await store.collection(GENERATION_OPERATION_COLLECTION)
    .where({ status: "queued" })
    .limit(Math.max(5, GENERATION_QUEUE_BATCH_SIZE * 5))
    .get();
  const rows = (result && Array.isArray(result.data) ? result.data : [])
    .filter((item) => item && item.kind === "image" && item.openid && item.requestId)
    .sort((left, right) => (
      operationUpdatedAtMs(left) - operationUpdatedAtMs(right)
  ));
  for (const candidate of rows) {
    const claimed = await store.runTransaction(async (transaction) => {
      const current = await findOperation(
        candidate.openid,
        candidate.requestId,
        transaction
      );
      if (!current || current.kind !== "image" || current.status !== "queued") return null;
      return saveOperation(current.openid, current.requestId, {
        status: "processing",
        pipelineStage: "validate",
        progress: 5,
        processingAt: currentTime(),
        lastHeartbeatAt: currentTime(),
        attemptCount: (Number(current.attemptCount) || 0) + 1,
        lastError: null,
        reconcilePending: false
      }, transaction, {
        enforceState: true,
        actor: "worker",
        historyStage: "validate"
      });
    }, 5);
    if (claimed) return claimed;
  }
  return null;
}

async function processQueuedGenerationOperation(operation, dependencies = {}) {
  const openid = String(operation && operation.openid || "");
  const requestId = String(operation && operation.requestId || "");
  const resolveConfigs = dependencies.resolveConfigs || resolveEffectiveConfigs;
  const execute = dependencies.execute || executeImageGeneration;
  const touchOperation = dependencies.touchOperation || touchGenerationOperation;
  const persistResult = dependencies.persistResult || persistGenerationResult;
  const completeOperation = dependencies.completeOperation || completeGenerationOperation;
  const findOperation = dependencies.findOperation || findGenerationOperation;
  const updateOperation = dependencies.updateOperation || updateGenerationOperation;
  const failOperation = dependencies.failOperation || failGenerationOperation;
  const refund = dependencies.refund || refundUsage;
  const writeLog = dependencies.log || log;
  if (!openid || !requestId) {
    return { ok: false, errorCode: "generation-operation-invalid" };
  }
  try {
    let current = operation;
    if (current.status === "queued") {
      current = await updateOperation(openid, requestId, {
        status: "processing",
        pipelineStage: "validate",
        progress: 5,
        processingAt: new Date(),
        lastHeartbeatAt: new Date(),
        attemptCount: (Number(current.attemptCount) || 0) + 1
      }, {
        allowedStatuses: ["queued"],
        enforceState: true,
        actor: "worker",
        historyStage: "validate"
      }) || current;
    }
    const configs = await resolveConfigs();
    const result = await execute(current, {
      imageConfig: configs.image,
      imageBackupConfig: configs.imageBackup,
      costs: configs.costs
    });
    await touchOperation(openid, requestId, "record", 95);
    const saved = await persistResult(
      openid,
      current,
      result,
      current.billing || {}
    );
    const completedResult = Object.assign({}, result, {
      recordId: saved.recordId,
      fileID: saved.fileID || result.fileID,
      tempFileURL: saved.tempFileURL || result.tempFileURL,
      createdAt: saved.createdAt || result.createdAt,
      record: saved.record,
      quota: current.billing && current.billing.quota || null,
      billing: buildPublicGenerationBilling(current.billing),
      pipelineStage: "succeeded"
    });
    await completeOperation(openid, requestId, completedResult);
    return {
      ok: true,
      requestId,
      recordId: saved.recordId,
      fileID: saved.fileID || result.fileID
    };
  } catch (error) {
    const latest = await findOperation(openid, requestId);
    if (latest && latest.resultFileID) {
      await updateOperation(openid, requestId, {
        status: "processing",
        pipelineStage: "record",
        progress: 95,
        reconcilePending: true,
        reconcileAttemptCount: Math.max(0, Number(latest.reconcileAttemptCount) || 0),
        lastHeartbeatAt: new Date(),
        lastError: {
          code: String(error && error.code || "generation-record-pending").slice(0, 80),
          message: sanitizeFailureMessage(error && error.message || "生成结果等待补记录", 240),
          retryable: true
        }
      }, {
        allowedStatuses: ["processing", "failed"]
      });
      return {
        ok: false,
        requestId,
        pendingRepair: true,
        errorCode: String(error && error.code || "generation-record-pending")
      };
    }
    await failOperation(openid, requestId, error);
    try {
      await refund(openid, requestId, "生图失败，已退回本次使用额度");
    } catch (refundError) {
      await updateOperation(openid, requestId, {
        refundPending: true,
        refundLastError: sanitizeFailureMessage(refundError && refundError.message, 240)
      }, {
        allowedStatuses: ["failed", "refunding"]
      });
      writeLog("error", "generation.refund-failed", {
        requestId,
        error: sanitizeFailureMessage(refundError && refundError.message)
      });
    }
    return {
      ok: false,
      requestId,
      errorCode: String(error && error.code || "generation-failed"),
      error: sanitizeFailureMessage(error && error.message || "生图失败")
    };
  }
}

async function processGenerationQueue(event = {}, context = {}) {
  return generationExecutionKernel.processGenerationQueue(event, context);
}

function generationDateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : new Date(date).getTime();
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function generationReconcileError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  error.pipelineStage = "reconcile";
  return error;
}

async function deleteGenerationResultFile(operation, dependencies = {}) {
  const openid = String(operation && operation.openid || "");
  const requestId = String(operation && operation.requestId || "");
  const resultFileID = String(
    operation && operation.resultFileID
    || operation && operation.result && operation.result.fileID
    || ""
  ).trim();
  const updateOperation = dependencies.updateOperation || (
    (owner, id, patch, updateOptions = {}) => updateGenerationOperation(
      owner,
      id,
      patch,
      Object.assign({}, updateOptions, {
        enforceState: true,
        actor: "reconcile",
        historyStage: updateOptions.historyStage || "cleanup"
      })
    )
  );
  const deleteFile = dependencies.deleteFile || (async (fileID) => (
    cloud.deleteFile({ fileList: [fileID] })
  ));
  if (!resultFileID) {
    await updateOperation(openid, requestId, {
      cleanupPending: false,
      cleanupLastError: "",
      cleanupCompletedAt: new Date()
    }, {
      allowedStatuses: GENERATION_OPERATION_STATUSES,
      allowRefunded: true
    });
    return { cleaned: true, skipped: true, fileID: "" };
  }
  try {
    const response = await deleteFile(resultFileID, operation);
    const failed = response && Array.isArray(response.fileList)
      ? response.fileList.find((item) => (
        item
        && item.fileID === resultFileID
        && Number(item.status) !== 0
      ))
      : null;
    if (failed) {
      const error = generationReconcileError(
        "generation-orphan-delete-failed",
        failed.errMsg || "孤儿结果图删除失败。",
        true
      );
      throw error;
    }
    await updateOperation(openid, requestId, {
      resultFileID: "",
      tempFileURL: "",
      cleanupPending: false,
      cleanupLastError: "",
      cleanupCompletedAt: new Date()
    }, {
      allowedStatuses: GENERATION_OPERATION_STATUSES,
      allowRefunded: true
    });
    return { cleaned: true, skipped: false, fileID: resultFileID };
  } catch (error) {
    if (isPhotoToVideoTempFileMissing(error)) {
      await updateOperation(openid, requestId, {
        resultFileID: "",
        tempFileURL: "",
        cleanupPending: false,
        cleanupLastError: "",
        cleanupCompletedAt: new Date()
      }, {
        allowedStatuses: GENERATION_OPERATION_STATUSES,
        allowRefunded: true
      });
      return {
        cleaned: true,
        skipped: false,
        missing: true,
        fileID: resultFileID
      };
    }
    await updateOperation(openid, requestId, {
      cleanupPending: true,
      cleanupAttemptCount: (Number(operation && operation.cleanupAttemptCount) || 0) + 1,
      cleanupLastError: sanitizeFailureMessage(error && error.message, 240),
      cleanupLastAttemptAt: new Date()
    }, {
      allowedStatuses: GENERATION_OPERATION_STATUSES,
      allowRefunded: true
    });
    return {
      cleaned: false,
      pending: true,
      fileID: resultFileID,
      errorCode: String(error && error.code || "generation-orphan-delete-failed"),
      error: sanitizeFailureMessage(error && error.message || "孤儿结果图删除失败。")
    };
  }
}

async function rebuildResultFromOperation(operation, dependencies = {}) {
  const requestId = String(operation && operation.requestId || "");
  const resultFileID = String(
    operation && operation.resultFileID
    || operation && operation.result && operation.result.fileID
    || ""
  ).trim();
  if (!resultFileID) {
    throw generationReconcileError(
      "generation-result-file-missing",
      "任务没有可补写记录的结果文件。"
    );
  }
  const tempFileUrl = dependencies.tempFileUrl || generationTempFileUrl;
  const currentResult = operation && operation.result && typeof operation.result === "object"
    ? operation.result
    : {};
  const currentTempFileURL = String(
    operation && operation.tempFileURL
    || operation && operation.resultTempFileURL
    || currentResult.tempFileURL
    || ""
  );
  const tempFileURL = currentTempFileURL
    || await tempFileUrl(resultFileID, requestId);
  return Object.assign({}, currentResult, {
    requestId,
    fileID: resultFileID,
    tempFileURL,
    createdAt: serializeGenerationDate(
      operation && operation.resultCreatedAt
      || currentResult.createdAt
      || operation && operation.updatedAt
      || new Date()
    ),
    model: String(operation && operation.model || currentResult.model || ""),
    size: String(operation && operation.size || currentResult.size || ""),
    resolution: String(operation && operation.resolution || currentResult.resolution || ""),
    quality: String(operation && operation.quality || currentResult.quality || ""),
    compatibilityMode: Boolean(
      operation && operation.compatibilityMode !== undefined
        ? operation.compatibilityMode
        : currentResult.compatibilityMode
    ),
    imageMode: String(operation && operation.imageMode || currentResult.imageMode || ""),
    pixelProtection: operation && operation.pixelProtection
      || currentResult.pixelProtection
      || null,
    pipelineStage: "succeeded"
  });
}

async function refundGenerationOperation(operation, error, dependencies = {}) {
  const openid = String(operation && operation.openid || "");
  const requestId = String(operation && operation.requestId || "");
  const status = normalizeGenerationStatus(operation && operation.status);
  const failOperation = dependencies.failOperation || (
    (owner, id, failure) => failGenerationOperation(
      owner,
      id,
      failure,
      { enforceState: true, actor: "reconcile" }
    )
  );
  const updateOperation = dependencies.updateOperation || (
    (owner, id, patch, updateOptions = {}) => updateGenerationOperation(
      owner,
      id,
      patch,
      Object.assign({}, updateOptions, {
        enforceState: true,
        actor: "reconcile",
        historyStage: updateOptions.historyStage || patch.pipelineStage,
        historyCode: updateOptions.historyCode || patch.refundLastError
      })
    )
  );
  const refund = dependencies.refund || refundUsage;
  if (status === "refunded") {
    return { refunded: true, duplicate: true };
  }
  if (!["failed", "refunding"].includes(status)) {
    await failOperation(openid, requestId, error);
  }
  await updateOperation(openid, requestId, {
    status: "refunding",
    refundPending: true,
    refundLastError: "",
    refundRequestedAt: new Date()
  }, {
    allowedStatuses: ["reserved", "queued", "processing", "failed", "refunding"]
  });
  try {
    const result = await refund(
      openid,
      requestId,
      error && error.message
        ? `生图任务回收：${sanitizeFailureMessage(error.message, 120)}`
        : "生图任务失败，已退回本次使用额度"
    );
    return {
      refunded: Boolean(result),
      duplicate: Boolean(result && result.duplicate),
      skipped: Boolean(result && result.skipped)
    };
  } catch (refundError) {
    await updateOperation(openid, requestId, {
      status: "refunding",
      refundPending: true,
      refundLastError: sanitizeFailureMessage(refundError && refundError.message, 240),
      refundLastAttemptAt: new Date()
    }, {
      allowedStatuses: ["failed", "refunding"]
    });
    return {
      refunded: false,
      pending: true,
      errorCode: String(refundError && refundError.code || "generation-refund-failed"),
      error: sanitizeFailureMessage(refundError && refundError.message || "退款失败。")
    };
  }
}

async function reconcileGenerationOperation(operation, options = {}) {
  const source = operation && typeof operation === "object" ? operation : {};
  const openid = String(source.openid || "");
  const requestId = String(source.requestId || "");
  if (!openid || !requestId || source.kind !== "image") {
    return { action: "skip-invalid", requestId };
  }
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || Date.now());
  const status = normalizeGenerationStatus(source.status);
  const updateOperation = options.updateOperation || (
    (owner, id, patch, updateOptions = {}) => updateGenerationOperation(
      owner,
      id,
      patch,
      Object.assign({}, updateOptions, {
        enforceState: true,
        actor: "reconcile",
        historyStage: updateOptions.historyStage || patch.pipelineStage,
        historyCode: updateOptions.historyCode
      })
    )
  );
  const persistResult = options.persistResult || persistGenerationResult;
  const completeOperation = options.completeOperation || (
    (owner, id, result) => completeGenerationOperation(
      owner,
      id,
      result,
      { enforceState: true, actor: "reconcile" }
    )
  );
  const resultFileID = String(
    source.resultFileID
    || source.result && source.result.fileID
    || ""
  ).trim();
  const recordId = String(
    source.recordId
    || source.result && source.result.recordId
    || ""
  ).trim();

  if (
    source.cleanupPending
    || (resultFileID && ["refunding", "refunded"].includes(status))
  ) {
    const cleanup = await deleteGenerationResultFile(source, options);
    if (status === "refunded") {
      return {
        action: cleanup.cleaned ? "cleanup-completed" : "cleanup-pending",
        requestId,
        cleanup
      };
    }
  }

  if (
    resultFileID
    && !recordId
    && !["refunding", "refunded"].includes(status)
  ) {
    try {
      const rebuilt = await rebuildResultFromOperation(source, options);
      const saved = await persistResult(
        openid,
        source,
        rebuilt,
        source.billing || {}
      );
      const completedResult = Object.assign({}, rebuilt, {
        recordId: saved.recordId,
        fileID: saved.fileID || rebuilt.fileID,
        tempFileURL: saved.tempFileURL || rebuilt.tempFileURL,
        createdAt: saved.createdAt || rebuilt.createdAt,
        record: saved.record,
        quota: source.billing && source.billing.quota || null,
        billing: buildPublicGenerationBilling(source.billing),
        pipelineStage: "succeeded"
      });
      await completeOperation(openid, requestId, completedResult);
      return {
        action: "record-rebuilt",
        requestId,
        recordId: saved.recordId,
        fileID: saved.fileID || rebuilt.fileID
      };
    } catch (error) {
      const nextAttempt = (Number(source.reconcileAttemptCount) || 0) + 1;
      if (nextAttempt < GENERATION_MAX_RECOVERY_ATTEMPTS) {
        await updateOperation(openid, requestId, {
          status: "processing",
          pipelineStage: "record",
          progress: 95,
          reconcilePending: true,
          reconcileAttemptCount: nextAttempt,
          reconcileLastAttemptAt: now,
          lastHeartbeatAt: now,
          lastError: {
            code: String(error && error.code || "generation-record-rebuild-failed").slice(0, 80),
            message: sanitizeFailureMessage(error && error.message || "补写生成记录失败。", 240),
            retryable: true
          }
        }, {
          allowedStatuses: ["processing", "failed", "succeeded"]
        });
        return {
          action: "record-retry-pending",
          requestId,
          attemptCount: nextAttempt,
          errorCode: String(error && error.code || "generation-record-rebuild-failed")
        };
      }
      const cleanup = await deleteGenerationResultFile(
        Object.assign({}, source, {
          cleanupPending: true,
          cleanupAttemptCount: Number(source.cleanupAttemptCount) || 0
        }),
        options
      );
      const failure = generationReconcileError(
        "generation-record-rebuild-exhausted",
        "生成结果多次补记录失败，任务已停止并退款。"
      );
      const refund = await refundGenerationOperation(source, failure, options);
      return {
        action: cleanup.cleaned ? "orphan-cleaned-refund" : "orphan-cleanup-pending-refund",
        requestId,
        cleanup,
        refund
      };
    }
  }

  if (status === "succeeded") {
    return { action: "skip-succeeded", requestId };
  }

  if (status === "failed" || status === "refunding" || source.refundPending) {
    const failure = generationReconcileError(
      source.lastError && source.lastError.code || "generation-failed-pending-refund",
      source.lastError && source.lastError.message || "生图任务失败，继续退款。"
    );
    return {
      action: "refund-retried",
      requestId,
      refund: await refundGenerationOperation(source, failure, options)
    };
  }

  const updatedAt = operationUpdatedAtMs(source);
  const ageMs = Math.max(0, now.getTime() - updatedAt);
  const expiresAt = generationDateMs(source.expiresAt);
  const expired = expiresAt > 0 && expiresAt <= now.getTime();
  if (
    status === "reserved"
    && (ageMs >= GENERATION_QUEUE_STALE_MS || expired)
  ) {
    const failure = generationReconcileError(
      "generation-reservation-stale",
      "生图任务预留后没有成功入队，已自动退款。"
    );
    return {
      action: "reserved-refund",
      requestId,
      refund: await refundGenerationOperation(source, failure, options)
    };
  }
  if (
    status === "queued"
    && (ageMs >= GENERATION_QUEUE_STALE_MS || expired)
  ) {
    const failure = generationReconcileError(
      "generation-queue-timeout",
      "生图任务排队超时，已自动退款。"
    );
    return {
      action: "queued-refund",
      requestId,
      refund: await refundGenerationOperation(source, failure, options)
    };
  }
  if (
    status === "processing"
    && (ageMs >= GENERATION_PROCESSING_STALE_MS || expired)
  ) {
    const recoveryAttemptCount = Math.max(
      0,
      Number(source.recoveryAttemptCount) || 0
    );
    if (recoveryAttemptCount < GENERATION_MAX_RECOVERY_ATTEMPTS) {
      if (source.providerTaskId) {
        await updateOperation(openid, requestId, {
          reconcilePending: true,
          recoveryAttemptCount: recoveryAttemptCount + 1,
          reconcileLastAttemptAt: now,
          lastHeartbeatAt: now,
          lastError: {
            code: "generation-provider-status-pending",
            message: "上游任务状态暂时无法确认，稍后继续回收。",
            retryable: true
          }
        }, {
          allowedStatuses: ["processing"]
        });
        return {
          action: "provider-status-pending",
          requestId,
          recoveryAttemptCount: recoveryAttemptCount + 1
        };
      }
      await updateOperation(openid, requestId, {
        status: "queued",
        pipelineStage: "queued",
        progress: 0,
        queuedAt: now,
        processingAt: null,
        lastHeartbeatAt: now,
        recoveryAttemptCount: recoveryAttemptCount + 1,
        reconcilePending: false,
        lastError: {
          code: "generation-processing-requeued",
          message: "后台处理超时，任务已重新排队。",
          retryable: true
        }
      }, {
        allowedStatuses: ["processing"]
      });
      return {
        action: "processing-requeued",
        requestId,
        recoveryAttemptCount: recoveryAttemptCount + 1
      };
    }
    const failure = generationReconcileError(
      "generation-processing-timeout",
      "生图后台处理多次超时，已停止并退款。"
    );
    return {
      action: "processing-refund",
      requestId,
      refund: await refundGenerationOperation(source, failure, options)
    };
  }
  return { action: "skip-fresh", requestId };
}

async function reconcileGenerationOperationForTest(operation, now, hooks = {}) {
  return reconcileGenerationOperation(operation, Object.assign({}, hooks, { now }));
}

async function loadGenerationReconcileCandidates(dependencies = {}) {
  const store = dependencies.store || db;
  const writeLog = dependencies.log || log;
  const descriptors = [
    { status: "reserved" },
    { status: "queued" },
    { status: "processing" },
    { status: "failed" },
    { status: "refunding" },
    { status: "refunded" },
    { reconcilePending: true },
    { cleanupPending: true },
    { refundPending: true }
  ];
  const batches = await Promise.all(descriptors.map(async (where) => {
    try {
      const result = await store.collection(GENERATION_OPERATION_COLLECTION)
        .where(where)
        .limit(GENERATION_RECONCILE_BATCH_SIZE)
        .get();
      return result && Array.isArray(result.data) ? result.data : [];
    } catch (error) {
      if (!isCollectionMissingError(error)) {
        writeLog("warn", "generation.reconcile-query-failed", {
          where,
          error: sanitizeFailureMessage(error && error.message)
        });
      }
      return [];
    }
  }));
  const unique = new Map();
  batches.flat().forEach((item) => {
    if (
      !item
      || !["image", "video"].includes(item.kind)
      || !item.openid
      || !item.requestId
    ) return;
    const key = String(item._id || `${item.openid}:${item.requestId}`);
    unique.set(key, item);
  });
  return [...unique.values()]
    .sort((left, right) => operationUpdatedAtMs(left) - operationUpdatedAtMs(right))
    .slice(0, GENERATION_RECONCILE_BATCH_SIZE);
}

async function reconcileGenerationOperations(event = {}, context = {}) {
  return generationExecutionKernel.reconcileGenerationOperations(event, context);
}

async function generate(event, context) {
  return generationExecutionKernel.generate(event, context);
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
  const backgroundFileIDs = Array.from(new Set(
    (Array.isArray(payload.backgroundFileIDs) ? payload.backgroundFileIDs : [])
      .filter(Boolean)
      .slice(0, 3)
  ));
  await findUserAsset(openid, maskFileID, "mask");
  for (const fileID of faceFileIDs) await findUserAsset(openid, fileID, "face");
  for (const fileID of wardrobeFileIDs) await findUserAsset(openid, fileID, "wardrobe");
  for (const fileID of backgroundFileIDs) await findUserAsset(openid, fileID, "background");

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
    const repairSize = resolveImageOutputSize(imageConfig, payload.size);
    const repairResolution = imageConfig.resolution
      || normalizeImageResolution(repairSize, "1K");
    log("info", "repair.start", {
      requestId,
      parentRecordId,
      revisionNumber: chainSlot.revisionNumber,
      size: repairSize,
      resolution: repairResolution,
      faceRefs: faceFileIDs.length,
      wardrobeRefs: wardrobeFileIDs.length,
      backgroundRefs: backgroundFileIDs.length
    });
    const response = await requestImageEdits(
      {
        mainFileID,
        identityFileID: originalMainFileID,
        maskFileID,
        faceFileIDs,
        wardrobeFileIDs,
        backgroundFileIDs,
        prompt: actualPrompt,
        size: repairSize,
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
      size: repairSize,
      resolution: repairResolution,
      quality: imageConfig.compatibilityMode ? "" : "auto",
      compatibilityMode: Boolean(imageConfig.compatibilityMode),
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
        wardrobeFileIDs,
        backgroundFileIDs
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
        data: stripDocumentId(recordData)
      });
      await transaction.collection("generation_records").doc(parentRecordId).update({
        data: {
          hasChildren: true,
          updatedAt: new Date()
        }
      });
      await chainRef.set({
        data: stripDocumentId(Object.assign({}, chain, {
          tailRecordId: recordId,
          tailRevision: chainSlot.revisionNumber,
          pendingRequestId: "",
          pendingParentId: "",
          pendingRevision: 0,
          updatedAt: new Date()
        }))
      });
      const referenced = Array.from(new Set(
        [maskFileID]
          .concat(mainFileID !== sourceFileID ? [mainFileID] : [])
          .concat(originalMainFileID ? [originalMainFileID] : [])
          .concat(faceFileIDs, wardrobeFileIDs, backgroundFileIDs)
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
                : wardrobeFileIDs.includes(fileID)
                  ? "wardrobe"
                  : "background",
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
  const records = (result.data || []).filter((item) => !item.isTombstone);
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

async function removeGenerationRecord(recordId, openid, options = {}) {
  const safeOpenid = String(openid || "anonymous");
  const safeRecordId = String(recordId || "");
  if (!safeRecordId) return fail("缺少记录 ID。", "missing-record-id");
  const recordData = await readDocument(
    db.collection("generation_records").doc(safeRecordId)
  );
  if (!recordData) {
    return options.allowMissing
      ? jsonResponse(true, { recordId: safeRecordId, missing: true })
      : fail("无权删除这条记录。", "forbidden");
  }
  if (recordData.openid !== safeOpenid) return fail("无权删除这条记录。", "forbidden");
  if (recordData.fileID && !options.skipFileDelete) {
    try {
      await cloud.deleteFile({ fileList: [recordData.fileID] });
    } catch (_) {
      // 文件已经不存在时，仍然允许清理数据库记录。
    }
  }
  const repairContext = recordData.repairContext || {};
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
      : []),
    ...(Array.isArray(repairContext.backgroundFileIDs)
      ? repairContext.backgroundFileIDs.map((fileID) => ({ fileID, kind: "background" }))
      : [])
  ];
  const children = await db.collection("generation_records")
    .where({ openid: safeOpenid, parentRecordId: safeRecordId })
    .limit(1)
    .get();
  if (children && Array.isArray(children.data) && children.data.length) {
    await db.collection("generation_records").doc(safeRecordId).update({
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
        (transaction) => releaseUserAssets(safeOpenid, assetReferences, transaction),
        5
      );
    } catch (error) {
      log("warn", "records.asset_release_failed", {
        recordId: safeRecordId,
        message: error && error.message
      });
    }
    return jsonResponse(true, { recordId: safeRecordId, tombstone: true });
  }
  await db.collection("generation_records").doc(safeRecordId).remove();
  try {
    await db.runTransaction(
      (transaction) => releaseUserAssets(safeOpenid, assetReferences, transaction),
      5
    );
  } catch (error) {
    log("warn", "records.asset_release_failed", {
      recordId: safeRecordId,
      message: error && error.message
    });
  }
  return jsonResponse(true, { recordId: safeRecordId, removed: true });
}

async function deleteRecord(event, context) {
  return removeGenerationRecord(
    String(event && event.recordId || ""),
    getOpenId(context)
  );
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
    image: {
      url: toDataUrl(imageBuffer, detectMime(imageBuffer))
    }
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

function motionPhotoArtifactHash(...parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => String(part || "")).join(":"))
    .digest("hex")
    .slice(0, 32);
}

function motionPhotoOwnerHash(openid) {
  return crypto
    .createHash("sha256")
    .update(String(openid || "anonymous"))
    .digest("hex")
    .slice(0, 24);
}

function normalizedVideoSourceCloudPath(openid, requestId) {
  return [
    "photo-to-video-sources",
    motionPhotoOwnerHash(openid),
    `${motionPhotoArtifactHash(openid, requestId, "source")}.jpg`
  ].join("/");
}

function normalizedVideoResultCloudPath(openid, requestId, taskId) {
  return [
    "photo-to-video-results",
    motionPhotoOwnerHash(openid),
    `${motionPhotoArtifactHash(openid, requestId, taskId, "result")}.mp4`
  ].join("/");
}

function androidMotionPhotoFileName(requestId, taskId) {
  return `${motionPhotoArtifactHash(requestId, taskId, "android-motion-photo")}-MP.jpg`;
}

function androidMotionPhotoCloudPath(openid, requestId, taskId) {
  return [
    "photo-to-video-motion-photos",
    motionPhotoOwnerHash(openid),
    androidMotionPhotoFileName(requestId, taskId)
  ].join("/");
}

function appleLivePhotoFileName(requestId, taskId) {
  return `${motionPhotoArtifactHash(requestId, taskId, "apple-live-photo")}.livp`;
}

function appleLivePhotoCloudPath(openid, requestId, taskId) {
  return [
    "photo-to-video-live-photos",
    motionPhotoOwnerHash(openid),
    appleLivePhotoFileName(requestId, taskId)
  ].join("/");
}

function deterministicAppleContentIdentifier(openid, requestId, taskId) {
  const bytes = crypto
    .createHash("sha256")
    .update(`${openid}:${requestId}:${taskId}:apple-live-photo`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex").toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

function normalizeAppleLivePhotoWorkerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/v1/apple-live-photo";
    }
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function resolveAppleLivePhotoWorkerConfig() {
  const url = normalizeAppleLivePhotoWorkerUrl(
    env("APPLE_LIVE_PHOTO_WORKER_URL")
  );
  const token = env("APPLE_LIVE_PHOTO_WORKER_TOKEN").trim();
  return {
    url,
    token,
    configured: Boolean(url && token),
    timeoutMs: Math.max(
      30000,
      Math.min(
        300000,
        Number(env("APPLE_LIVE_PHOTO_WORKER_TIMEOUT_MS", "180000")) || 180000
      )
    ),
    maxResponseBytes: Math.max(
      20 * 1024 * 1024,
      Math.min(
        110 * 1024 * 1024,
        Number(env("APPLE_LIVE_PHOTO_MAX_BYTES", String(110 * 1024 * 1024)))
          || 110 * 1024 * 1024
      )
    )
  };
}

async function cloudTempFileUrl(fileID) {
  if (!fileID) return "";
  const result = await cloud.getTempFileURL({ fileList: [fileID] });
  const item = result && Array.isArray(result.fileList)
    ? result.fileList[0]
    : null;
  if (
    item
    && item.status !== undefined
    && item.status !== null
    && Number(item.status) !== 0
  ) {
    const error = new Error(item.errMsg || "获取云文件临时地址失败。");
    error.code = "CLOUD_TEMP_URL_FAILED";
    error.retryable = true;
    throw error;
  }
  return String(item && item.tempFileURL || "").trim();
}

function appleLivePhotoResultView(value = {}) {
  return {
    livePhotoFileID: String(value.livePhotoFileID || value.fileID || ""),
    tempFileURL: String(value.tempFileURL || ""),
    fileName: String(value.fileName || ""),
    sizeBytes: Math.max(0, Number(value.sizeBytes) || 0),
    contentIdentifier: String(value.contentIdentifier || ""),
    photoSha256: String(value.photoSha256 || ""),
    videoSha256: String(value.videoSha256 || ""),
    livpSha256: String(value.livpSha256 || ""),
    validation: value.validation && typeof value.validation === "object"
      ? value.validation
      : {},
    format: "apple-livp"
  };
}

async function callAppleLivePhotoWorker(payload, config, meta = {}) {
  const body = JSON.stringify(payload || {});
  const response = await requestWithRetry(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Accept: "application/octet-stream"
    },
    maxResponseBytes: config.maxResponseBytes
  }, body, {
    requestId: meta.requestId,
    action: "motion-photo.apple.worker",
    provider: "apple-live-photo-worker",
    allowRetry: true,
    maxAttempts: 2,
    retryStatuses: [408, 425, 429, 500, 502, 503, 504],
    timeoutMs: config.timeoutMs
  });
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response, "Apple Live Photo 媒体服务失败");
  }
  if (
    !response.buffer
    || response.buffer.length < 64
    || response.buffer.subarray(0, 4).toString("binary") !== "PK\u0003\u0004"
    || (
      !response.buffer.includes(Buffer.from("1000LIVP", "ascii"))
      && !response.buffer.includes(Buffer.from("313030304C495650", "ascii"))
    )
  ) {
    const error = new Error("Apple Live Photo 媒体服务返回的 LIVP 无效。");
    error.code = "APPLE_LIVE_PHOTO_WORKER_RESULT_INVALID";
    error.retryable = false;
    throw error;
  }
  const headers = response.headers || {};
  if (String(headers["x-live-photo-validation"] || "") !== "ok") {
    const error = new Error("Apple Live Photo 媒体服务未通过结构校验。");
    error.code = "APPLE_LIVE_PHOTO_WORKER_VALIDATION_FAILED";
    error.retryable = false;
    throw error;
  }
  return {
    buffer: response.buffer,
    contentIdentifier: String(
      headers["x-live-photo-content-identifier"]
      || payload.contentIdentifier
      || ""
    ),
    photoSha256: String(headers["x-live-photo-photo-sha256"] || ""),
    videoSha256: String(headers["x-live-photo-video-sha256"] || ""),
    livpSha256: String(headers["x-live-photo-livp-sha256"] || ""),
    validation: {
      zipStored: true,
      matchingContentIdentifier: true,
      movHasMebx: true,
      movHasStillImageTime: true,
      worker: "ok"
    }
  };
}

async function uploadCloudBuffer(cloudPath, fileContent) {
  const uploaded = await cloud.uploadFile({
    cloudPath,
    fileContent
  });
  const fileID = uploaded && uploaded.fileID;
  if (!fileID) {
    const error = new Error("云文件上传完成，但没有返回 fileID。");
    error.code = "MOTION_PHOTO_UPLOAD_RESULT_INVALID";
    error.retryable = true;
    throw error;
  }
  return fileID;
}

async function downloadRemoteVideo(url, meta = {}) {
  const response = await requestWithRetry(url, {
    method: "GET",
    headers: {
      Accept: "video/mp4,video/*;q=0.9,application/octet-stream;q=0.8"
    }
  }, null, Object.assign({}, meta, { allowRetry: true }));
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response, "动态视频下载失败");
  }
  return response.buffer;
}

async function materializeVideoResult(openid, requestId, taskId, videoURL, meta = {}) {
  const videoBuffer = await downloadRemoteVideo(videoURL, Object.assign({}, meta, {
    action: "video.result-download",
    fileType: "video-result"
  }));
  const cloudPath = normalizedVideoResultCloudPath(openid, requestId, taskId);
  const videoFileID = await uploadCloudBuffer(cloudPath, videoBuffer);
  return {
    videoFileID,
    videoCloudPath: cloudPath,
    videoBytes: Buffer.from(videoBuffer).length
  };
}

function sanitizeVideoOperationResult(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const safe = {};
  [
    ["requestId", 120],
    ["taskId", 160],
    ["status", 40],
    ["providerStatus", 80],
    ["provider", 80],
    ["model", 160],
    ["resolution", 32],
    ["videoURL", 4096],
    ["videoFileID", 512],
    ["videoCloudPath", 1024],
    ["sourceImageFileID", 512]
  ].forEach(([key, maxLength]) => {
    if (source[key] === undefined || source[key] === null) return;
    safe[key] = String(source[key]).trim().slice(0, maxLength);
  });
  [
    "sourceImageWidth",
    "sourceImageHeight",
    "sourceImageBytes",
    "videoBytes"
  ].forEach((key) => {
    if (source[key] === undefined || source[key] === null) return;
    safe[key] = Math.max(0, Number(source[key]) || 0);
  });
  if (source.error) {
    safe.error = sanitizeFailureMessage(source.error, 240);
  }
  return safe;
}

async function prepareVideoSource(imageFileID, meta = {}) {
  const originalImageBuffer = await downloadCloudFile(imageFileID, {
    requestId: meta.requestId,
    action: meta.action || "video.create",
    fileType: "video-source"
  });
  const standardized = normalizeSourceToJpeg(Buffer.from(originalImageBuffer), {
    maxEdge: 1280,
    quality: 95
  });
  const sourceCloudPath = normalizedVideoSourceCloudPath(
    meta.openid,
    meta.requestId
  );
  const sourceImageFileID = await uploadCloudBuffer(
    sourceCloudPath,
    standardized.buffer
  );
  return {
    buffer: standardized.buffer,
    sourceOriginalFileID: String(imageFileID || ""),
    sourceImageFileID,
    sourceCloudPath,
    width: standardized.width,
    height: standardized.height,
    bytes: standardized.buffer.length
  };
}

async function createVideoProviderTaskAdapter({
  openid,
  requestId,
  configs,
  video,
  requestPayload
}) {
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
  return Object.assign(
    normalizeVideoCreateResponse(response),
    { videoURL: extractVideoUrl(response) }
  );
}

async function queryVideoProviderTaskAdapter({
  requestId,
  taskId,
  video
}) {
  const response = await requestJsonMethod(
    videoQueryUrl(video, taskId),
    null,
    video.apiKey,
    "GET",
    {},
    videoRequestMeta(requestId, "video.query", video, true)
  );
  return normalizeVideoQueryResponse(response);
}

async function completeVideoGenerationOperation(
  openid,
  requestId,
  result,
  options = {}
) {
  const safeResult = sanitizeVideoOperationResult(result);
  return updateGenerationOperation(openid, requestId, {
    status: "succeeded",
    pipelineStage: "succeeded",
    progress: 100,
    providerTaskId: safeResult.taskId || "",
    providerStatus: safeResult.providerStatus || "succeeded",
    provider: safeResult.provider || "",
    model: safeResult.model || "",
    resolution: safeResult.resolution || "",
    videoURL: safeResult.videoURL || "",
    videoFileID: safeResult.videoFileID || "",
    resultFileID: safeResult.videoFileID || "",
    videoCloudPath: safeResult.videoCloudPath || "",
    videoBytes: safeResult.videoBytes || 0,
    sourceImageFileID: safeResult.sourceImageFileID || "",
    result: safeResult,
    succeededAt: new Date(),
    lastHeartbeatAt: new Date(),
    reconcilePending: false,
    refundPending: false,
    cleanupPending: false,
    lastError: null
  }, {
    allowedStatuses: ["processing", "failed", "succeeded"],
    enforceState: options.enforceState !== false,
    actor: options.actor || "worker",
    historyStage: "succeeded",
    historyCode: "video-result-recorded"
  });
}

async function failVideoGenerationOperation(
  openid,
  requestId,
  error,
  patch = {},
  options = {}
) {
  const safeResult = patch.result && typeof patch.result === "object"
    ? sanitizeVideoOperationResult(patch.result)
    : undefined;
  return updateGenerationOperation(openid, requestId, Object.assign({}, patch, {
    status: "failed",
    pipelineStage: String(
      options.historyStage
      || error && error.pipelineStage
      || "failed"
    ).slice(0, 40),
    progress: 0,
    providerTaskId: String(patch.providerTaskId || "").slice(0, 160),
    providerStatus: String(patch.providerStatus || "").slice(0, 80),
    ...(safeResult ? { result: safeResult } : {}),
    failedAt: new Date(),
    lastHeartbeatAt: new Date(),
    lastError: {
      code: String(error && error.code || "video-failed").slice(0, 80),
      message: sanitizeFailureMessage(error && error.message || "视频任务失败", 240),
      retryable: Boolean(error && error.retryable)
    }
  }), {
    allowedStatuses: ["reserved", "processing", "failed"],
    enforceState: options.enforceState !== false,
    actor: options.actor || "worker",
    historyStage: options.historyStage || "failed",
    historyCode: options.historyCode
      || String(error && error.code || "video-failed")
  });
}

async function deleteVideoOperationFile(fileID) {
  try {
    return await deletePhotoToVideoTempFile(fileID);
  } catch (error) {
    if (isPhotoToVideoTempFileMissing(error)) {
      return { fileList: [{ fileID, status: 0, alreadyMissing: true }] };
    }
    throw error;
  }
}

async function createVideoTask(event, context) {
  return videoExecutionKernel.createVideoTask(event, context);
}

async function queryVideoTask(event, context) {
  return videoExecutionKernel.queryVideoTask(event, context);
}

function requireOwnedVideoOperation(operation, openid, requestId, taskId) {
  if (!operation || operation.openid !== openid || operation.requestId !== requestId) {
    const error = new Error("找不到当前用户的这次视频生成任务。");
    error.code = "VIDEO_OPERATION_NOT_FOUND";
    error.retryable = false;
    throw error;
  }
  if (String(operation.kind || "") !== "video") {
    const error = new Error("这次请求不是照片转视频任务。");
    error.code = "VIDEO_OPERATION_KIND_MISMATCH";
    error.retryable = false;
    throw error;
  }
  if (
    !operation.providerTaskId
    || String(operation.providerTaskId) !== String(taskId)
  ) {
    const error = new Error("视频任务编号与当前用户的原请求不匹配。");
    error.code = "VIDEO_TASK_OWNERSHIP_MISMATCH";
    error.retryable = false;
    throw error;
  }
  if (String(operation.status || "") !== "succeeded") {
    const error = new Error("动态视频还没有生成完成，暂时不能封装实况照片。");
    error.code = "VIDEO_TASK_NOT_SUCCEEDED";
    error.retryable = true;
    throw error;
  }
  return operation;
}

function androidMotionPhotoResultView(value = {}) {
  return {
    motionPhotoFileID: String(value.motionPhotoFileID || value.fileID || ""),
    fileName: String(value.fileName || ""),
    sizeBytes: Math.max(0, Number(value.sizeBytes) || 0),
    jpegLengthBytes: Math.max(0, Number(value.jpegLengthBytes) || 0),
    sourceJpegLengthBytes: Math.max(0, Number(value.sourceJpegLengthBytes) || 0),
    videoLengthBytes: Math.max(0, Number(value.videoLengthBytes) || 0),
    presentationTimestampUs: Math.max(
      0,
      Number(value.presentationTimestampUs) || 0
    ),
    format: "android-motion-photo"
  };
}

async function buildAndroidMotionPhoto(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail(
      "无法确认当前微信用户，不能封装安卓实况照片。",
      "MOTION_PHOTO_IDENTITY_MISSING"
    );
  }
  const requestId = String(event.requestId || "").trim();
  const taskId = String(event.taskId || "").trim();
  if (!requestId || !taskId) {
    return fail(
      "缺少视频请求编号或任务编号。",
      "MOTION_PHOTO_TASK_ARGUMENTS_MISSING"
    );
  }
  const operation = requireOwnedVideoOperation(
    await findGenerationOperation(openid, requestId),
    openid,
    requestId,
    taskId
  );
  if (
    operation.androidMotionPhoto
    && operation.androidMotionPhoto.motionPhotoFileID
  ) {
    return jsonResponse(true, Object.assign(
      androidMotionPhotoResultView(operation.androidMotionPhoto),
      { deduplicated: true, taskId, requestId }
    ));
  }
  const result = operation.result && typeof operation.result === "object"
    ? operation.result
    : {};
  const sourceImageFileID = String(
    operation.sourceImageFileID || result.sourceImageFileID || ""
  ).trim();
  if (!sourceImageFileID) {
    return fail(
      "视频任务没有保存标准 JPG 封面，请重新生成视频。",
      "MOTION_PHOTO_SOURCE_NOT_RECORDED"
    );
  }
  const videoFileID = String(
    operation.videoFileID
    || result.resultFileID
    || result.videoFileID
    || ""
  ).trim();
  const videoURL = String(
    operation.videoURL
    || result.videoURL
    || result.resultURL
    || ""
  ).trim();
  if (!videoFileID && !videoURL) {
    return fail(
      "视频任务没有可下载的 MP4 结果。",
      "MOTION_PHOTO_VIDEO_NOT_RECORDED"
    );
  }
  log("info", "motion-photo.android.build-start", {
    requestId,
    taskId,
    hasVideoFileID: Boolean(videoFileID),
    hasVideoURL: Boolean(videoURL)
  });
  const [sourceBuffer, videoBuffer] = await Promise.all([
    downloadCloudFile(sourceImageFileID, {
      requestId,
      action: "motion-photo.android",
      fileType: "motion-photo-source"
    }),
    videoFileID
      ? downloadCloudFile(videoFileID, {
        requestId,
        action: "motion-photo.android",
        fileType: "motion-photo-video"
      })
      : downloadRemoteVideo(videoURL, {
        requestId,
        action: "motion-photo.android.video",
        retryStatuses: [408, 425, 429, 500, 502, 503, 504],
        timeoutMs: Math.max(30000, Number(env("AI_VIDEO_TIMEOUT_MS", "120000")) || 120000)
      })
  ]);
  const built = buildAndroidMotionPhotoBuffer(
    Buffer.from(sourceBuffer),
    Buffer.from(videoBuffer),
    { presentationTimestampUs: 33333 }
  );
  const fileName = androidMotionPhotoFileName(requestId, taskId);
  const cloudPath = androidMotionPhotoCloudPath(
    openid,
    requestId,
    taskId
  );
  const motionPhotoFileID = await uploadCloudBuffer(cloudPath, built.buffer);
  const artifact = androidMotionPhotoResultView({
    motionPhotoFileID,
    fileName,
    sizeBytes: built.buffer.length,
    jpegLengthBytes: built.jpegLengthBytes,
    sourceJpegLengthBytes: built.sourceJpegLengthBytes,
    videoLengthBytes: built.videoLengthBytes,
    presentationTimestampUs: built.presentationTimestampUs
  });
  await updateGenerationOperation(openid, requestId, {
    androidMotionPhoto: Object.assign({}, artifact, {
      cloudPath,
      createdAt: new Date()
    })
  }, {
    allowedStatuses: ["succeeded"]
  });
  log("info", "motion-photo.android.build-finish", {
    requestId,
    taskId,
    motionPhotoFileID,
    sizeBytes: artifact.sizeBytes,
    videoLengthBytes: artifact.videoLengthBytes
  });
  return jsonResponse(true, Object.assign({}, artifact, {
    requestId,
    taskId,
    sourceImageFileID
  }));
}

async function buildAppleLivePhoto(event, context) {
  const openid = getOpenId(context);
  if (openid === "anonymous") {
    return fail(
      "无法确认当前微信用户，不能生成苹果实况文件。",
      "APPLE_LIVE_PHOTO_IDENTITY_MISSING"
    );
  }
  const requestId = String(event.requestId || "").trim();
  const taskId = String(event.taskId || "").trim();
  if (!requestId || !taskId) {
    return fail(
      "缺少视频请求编号或任务编号。",
      "APPLE_LIVE_PHOTO_TASK_ARGUMENTS_MISSING"
    );
  }
  const operation = requireOwnedVideoOperation(
    await findGenerationOperation(openid, requestId),
    openid,
    requestId,
    taskId
  );
  if (operation.appleLivePhoto && operation.appleLivePhoto.livePhotoFileID) {
    const cached = appleLivePhotoResultView(operation.appleLivePhoto);
    try {
      cached.tempFileURL = await cloudTempFileUrl(cached.livePhotoFileID);
    } catch (_) {
      // 临时地址刷新失败时仍返回原文件 ID，让客户端继续走云文件下载。
    }
    return jsonResponse(true, Object.assign(
      cached,
      { deduplicated: true, taskId, requestId }
    ));
  }
  const worker = resolveAppleLivePhotoWorkerConfig();
  if (!worker.configured) {
    return fail(
      "苹果实况媒体服务尚未配置，请配置 APPLE_LIVE_PHOTO_WORKER_URL 和 APPLE_LIVE_PHOTO_WORKER_TOKEN。",
      "APPLE_LIVE_PHOTO_WORKER_NOT_CONFIGURED"
    );
  }
  const result = operation.result && typeof operation.result === "object"
    ? operation.result
    : {};
  const sourceImageFileID = String(
    operation.sourceImageFileID || result.sourceImageFileID || ""
  ).trim();
  if (!sourceImageFileID) {
    return fail(
      "视频任务没有保存标准 JPG 封面，请重新生成视频。",
      "APPLE_LIVE_PHOTO_SOURCE_NOT_RECORDED"
    );
  }
  const videoFileID = String(
    operation.videoFileID
    || result.resultFileID
    || result.videoFileID
    || ""
  ).trim();
  const providerVideoURL = String(
    operation.videoURL
    || result.videoURL
    || result.resultURL
    || ""
  ).trim();
  if (!videoFileID && !providerVideoURL) {
    return fail(
      "视频任务没有可下载的 MP4 结果。",
      "APPLE_LIVE_PHOTO_VIDEO_NOT_RECORDED"
    );
  }
  const [imageUrl, cloudVideoUrl] = await Promise.all([
    cloudTempFileUrl(sourceImageFileID),
    videoFileID ? cloudTempFileUrl(videoFileID) : Promise.resolve("")
  ]);
  const videoUrl = cloudVideoUrl || providerVideoURL;
  if (!imageUrl || !videoUrl) {
    return fail(
      "无法取得生成苹果实况所需的临时媒体地址。",
      "APPLE_LIVE_PHOTO_MEDIA_URL_MISSING",
      { retryable: true }
    );
  }
  const contentIdentifier = deterministicAppleContentIdentifier(
    openid,
    requestId,
    taskId
  );
  const fileName = appleLivePhotoFileName(requestId, taskId);
  const baseName = fileName.replace(/\.livp$/i, "");
  log("info", "motion-photo.apple.build-start", {
    requestId,
    taskId,
    hasVideoFileID: Boolean(videoFileID),
    contentIdentifier
  });
  const built = await callAppleLivePhotoWorker({
    requestId,
    taskId,
    imageUrl,
    videoUrl,
    contentIdentifier,
    baseName
  }, worker, { requestId });
  const cloudPath = appleLivePhotoCloudPath(openid, requestId, taskId);
  const livePhotoFileID = await uploadCloudBuffer(cloudPath, built.buffer);
  const tempFileURL = await cloudTempFileUrl(livePhotoFileID);
  const artifact = appleLivePhotoResultView({
    livePhotoFileID,
    tempFileURL,
    fileName,
    sizeBytes: built.buffer.length,
    contentIdentifier: built.contentIdentifier,
    photoSha256: built.photoSha256,
    videoSha256: built.videoSha256,
    livpSha256: built.livpSha256,
    validation: built.validation
  });
  await updateGenerationOperation(openid, requestId, {
    appleLivePhoto: Object.assign({}, artifact, {
      cloudPath,
      createdAt: new Date()
    })
  }, {
    allowedStatuses: ["succeeded"]
  });
  log("info", "motion-photo.apple.build-finish", {
    requestId,
    taskId,
    livePhotoFileID,
    sizeBytes: artifact.sizeBytes,
    contentIdentifier: artifact.contentIdentifier
  });
  return jsonResponse(true, Object.assign({}, artifact, {
    requestId,
    taskId,
    sourceImageFileID
  }));
}

function mapActionErrorResult(action, error, requestId) {
  const status = Number(error && error.status) || null;
  const message = error && error.message ? error.message : String(error);
  let errorCode = error && error.code ? error.code : "server-error";
  const preserveSpecificCode = IMAGE_EDIT_ERROR_CODES.includes(errorCode);
  if (errorCode !== "retry-exhausted" && !preserveSpecificCode) {
    if (status === 401 || status === 403) errorCode = "authentication-failed";
    else if (status === 429) errorCode = "rate-limited";
    else if (status >= 500) errorCode = "upstream-unavailable";
    else if (/超时|timeout/i.test(message)) errorCode = "timeout";
    else if (/额度|次数已用完|quota/i.test(message)) errorCode = "quota-exceeded";
  }
  const modelType = modelErrorTypeForAction(action);
  const modelTypeLabel = modelType ? modelUsageTypeLabel(modelType) : "";
  const contextualMessage = modelErrorMessage(modelType, message);
  return fail(contextualMessage, errorCode, {
    requestId,
    status,
    retryable: Boolean(error && error.retryable)
      || ["timeout", "rate-limited", "upstream-unavailable", "retry-exhausted"].includes(errorCode),
    ...(modelType ? { modelType, modelTypeLabel } : {})
  });
}

function createVideoKernel() {
  return createVideoExecutionKernel({
    identity: {
      getOpenId
    },
    config: {
      resolve: resolveEffectiveConfigs
    },
    billing: {
      reserve: reserveUsage,
      refund: refundUsage,
      publicView: (value) => value || null
    },
    operations: {
      find: findGenerationOperation,
      claim: claimGenerationOperation,
      update: updateGenerationOperation,
      complete: completeVideoGenerationOperation,
      fail: failVideoGenerationOperation,
      stateError: operationStateError
    },
    source: {
      prepare: prepareVideoSource
    },
    provider: {
      buildPayload: buildVideoGenerationPayload,
      create: createVideoProviderTaskAdapter,
      query: queryVideoProviderTaskAdapter
    },
    files: {
      materialize: ({
        openid,
        requestId,
        taskId,
        videoURL
      }) => materializeVideoResult(
        openid,
        requestId,
        taskId,
        videoURL,
        { requestId, action: "video.query" }
      ),
      delete: deleteVideoOperationFile
    },
    response: {
      ok: (data) => jsonResponse(true, data),
      fail
    },
    serialization: {
      sanitizeError: sanitizeFailureMessage
    },
    recovery: {
      reservedStaleMs: GENERATION_QUEUE_STALE_MS,
      processingStaleMs: GENERATION_PROCESSING_STALE_MS,
      maxAttempts: GENERATION_MAX_RECOVERY_ATTEMPTS
    },
    log,
    now: () => new Date()
  });
}

const videoExecutionKernel = createVideoKernel();

function createGenerationKernel() {
  return createGenerationExecutionKernel({
    access: {
      isAdmin: isAdminContext,
      forbidden: adminForbidden
    },
    identity: {
      getOpenId
    },
    config: {
      resolve: resolveEffectiveConfigs
    },
    image: {
      hasEditAssets: hasImageEditAssets,
      resolveMode: resolveGenerationMode,
      hasFileID,
      resolveEditEndpoint: resolveImageEditEndpoint,
      assertEditFlow: pixelProtectionFlow.assertLingyunImageEditFlow,
      buildRequest: buildImageGenerationPayload,
      resolveOutputSize: resolveImageOutputSize,
      normalizeResolution: normalizeImageResolution
    },
    records: {
      findGenerationRecord
    },
    assets: {
      validate: validateGenerationAssets
    },
    billing: {
      reserve: reserveUsage,
      refund: refundUsage,
      publicView: buildPublicGenerationBilling
    },
    operations: {
      find: findGenerationOperation,
      enqueue: enqueueGenerationOperation,
      fail: failGenerationOperation,
      claimNext: () => claimNextQueuedGenerationOperation({
        store: db,
        findOperation: findGenerationOperation,
        saveOperation: saveGenerationOperation,
        now: () => new Date()
      }),
      processQueued: (operation) => processQueuedGenerationOperation(
        operation,
        {
          resolveConfigs: resolveEffectiveConfigs,
          execute: (current, runtime) => executeImageGeneration(
            current,
            Object.assign({}, runtime, {
              touchOperation: touchGenerationOperation,
              validateAssets: validateGenerationAssets,
              downloadInputFile: downloadCloudFile,
              requestEdits: requestImageEdits,
              requestGeneration: requestJson,
              downloadResult: downloadUrl,
              uploadResult: ({ cloudPath, fileContent }) => cloud.uploadFile({
                cloudPath,
                fileContent
              }),
              updateOperation: updateGenerationOperation,
              tempFileUrl: generationTempFileUrl,
              now: () => new Date(),
              randomSuffix: () => crypto.randomBytes(4).toString("hex")
            })
          ),
          touchOperation: touchGenerationOperation,
          persistResult: persistGenerationResult,
          completeOperation: completeGenerationOperation,
          findOperation: findGenerationOperation,
          updateOperation: updateGenerationOperation,
          failOperation: failGenerationOperation,
          refund: refundUsage,
          log
        }
      ),
      loadReconcileCandidates: () => loadGenerationReconcileCandidates({
        store: db,
        log
      }),
      reconcile: (operation, options) => (
        operation && operation.kind === "video"
          ? videoExecutionKernel.reconcileVideoOperation(operation, {
              now: options && options.now
            })
          : reconcileGenerationOperation(operation, options)
      ),
      update: updateGenerationOperation,
      complete: completeGenerationOperation
    },
    queue: {
      settings: async () => (
        await resolveEffectiveConfigs()
      ).generationQueue,
      observe: observeGenerationQueue
    },
    results: {
      persist: persistGenerationResult
    },
    files: {
      delete: async (fileID) => cloud.deleteFile({ fileList: [fileID] }),
      tempFileUrl: generationTempFileUrl
    },
    response: {
      ok: (data) => jsonResponse(true, data),
      fail,
      buildStatus: buildGenerationStatusResult,
      statusMessage: statusMessageForGenerationOperation,
      normalizeStatus: normalizeGenerationStatus
    },
    serialization: {
      date: serializeGenerationDate,
      sanitizeError: sanitizeFailureMessage
    },
    log,
    now: () => new Date()
  });
}

const generationExecutionKernel = createGenerationKernel();

function createGenerationActionRegistry() {
  const registry = createActionRegistry({
    log,
    isAdmin: isAdminContext,
    forbidden: adminForbidden,
    getTriggerName: timerTriggerName,
    mapError: (error, fields) => mapActionErrorResult(
      fields.action,
      error,
      fields.requestId
    )
  });
  registry.register({
    name: "generate",
    access: ACCESS.USER,
    metadata: { workflow: "image-generation-v1" },
    handler: ({ event, context }) => generate(event, context)
  });
  registry.register({
    name: "getGenerationStatus",
    access: ACCESS.USER,
    metadata: { workflow: "image-generation-v1" },
    handler: ({ event, context }) => getGenerationStatus(event, context)
  });
  registry.register({
    name: "createVideoTask",
    access: ACCESS.USER,
    metadata: { workflow: "video-generation-v1" },
    handler: ({ event, context }) => createVideoTask(event, context)
  });
  registry.register({
    name: "queryVideoTask",
    access: ACCESS.USER,
    metadata: { workflow: "video-generation-v1" },
    handler: ({ event, context }) => queryVideoTask(event, context)
  });
  registry.register({
    name: "processGenerationQueue",
    triggerName: "generation-queue-worker",
    access: ACCESS.TIMER_OR_ADMIN,
    metadata: { workflow: "image-generation-v1" },
    handler: ({ event, context }) => processGenerationQueue(event, context)
  });
  registry.register({
    name: "reconcileGenerationOperations",
    triggerName: "generation-operation-reconcile",
    access: ACCESS.TIMER_OR_ADMIN,
    metadata: { workflow: "image-generation-v1" },
    handler: ({ event, context }) => reconcileGenerationOperations(event, context)
  });
  registry.register({
    name: "getAdminGenerationQueue",
    access: ACCESS.ADMIN,
    metadata: { workflow: "generation-admin-v1" },
    handler: ({ event, context }) => getAdminGenerationQueue(event, context)
  });
  registry.register({
    name: "getAdminGenerationOperationHistory",
    access: ACCESS.ADMIN,
    metadata: { workflow: "generation-admin-v1" },
    handler: ({ event, context }) => getAdminGenerationOperationHistory(event, context)
  });
  registry.register({
    name: "cleanupGenerationOperationHistory",
    triggerName: "generation-operation-history-cleanup",
    access: ACCESS.TIMER_OR_ADMIN,
    metadata: { workflow: "generation-retention-v1" },
    handler: ({ event, context }) => cleanupGenerationOperationHistory(event, context)
  });
  return registry;
}

const generationActionRegistry = createGenerationActionRegistry();

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
    const registryDispatch = await generationActionRegistry.dispatch(
      requestEvent,
      context,
      { requestId }
    );
    if (registryDispatch.handled) {
      result = registryDispatch.result;
    } else if (isPhotoToVideoCleanupTrigger(requestEvent)) {
      const cleanupDate = new Date();
      const [
        photoToVideo,
        diagnosticLogs,
        publishExportJobs,
        watermarkTransfer,
        tencentFaceFusion
      ] = await Promise.all([
        cleanupPhotoToVideoTempAssets(cleanupDate),
        cleanupDiagnosticLogs(cleanupDate),
        cleanupPublishExportJobs(cleanupDate),
        cleanupWatermarkTransferTempAssets(cleanupDate),
        cleanupTencentFaceFusionIntermediateAssets(cleanupDate)
      ]);
      result = jsonResponse(true, {
        photoToVideo,
        diagnosticLogs,
        publishExportJobs,
        watermarkTransfer,
        tencentFaceFusion
      });
    } else if (isWatermarkTransferCleanupTrigger(requestEvent)) {
      result = jsonResponse(true, {
        watermarkTransfer: await cleanupWatermarkTransferTempAssets(new Date())
      });
    } else if (isTencentFaceFusionCleanupTrigger(requestEvent)) {
      result = jsonResponse(true, {
        tencentFaceFusion: await cleanupTencentFaceFusionIntermediateAssets(new Date())
      });
    } else if (action === "analyze") result = await analyze(requestEvent, context);
    else if (action === "detectFaceCircle") result = await detectFaceCircle(requestEvent, context);
    else if (action === "probeAutoFace") result = await probeAutoFace(requestEvent, context);
    else if (action === "getAutoFaceProbeHistory") {
      result = await getAutoFaceProbeHistory(requestEvent, context);
    }
    else if (action === "analyzeWebPoses") result = await analyzeWebPoses(requestEvent, context);
    else if (action === "prepareAssetUpload") result = await prepareAssetUpload(requestEvent, context);
    else if (action === "registerAsset") result = await registerAsset(requestEvent, context);
    else if (action === "publishExport") result = await publishExport(requestEvent, context);
    else if (action === "cleanupPublishExportResult") {
      result = await cleanupPublishExportResult(requestEvent, context);
    }
    else if (action === "generate") result = await generate(requestEvent, context);
    else if (action === "getGenerationStatus") {
      result = await getGenerationStatus(requestEvent, context);
    }
    else if (action === "tencentFaceFusionPipeline") {
      result = await tencentFaceFusionPipeline(requestEvent, context);
    }
    else if (action === "getTencentFaceFusionPipelineStatus") {
      result = await getTencentFaceFusionPipelineStatus(requestEvent, context);
    }
    else if (action === "testTencentFaceFusion") {
      result = await testTencentFaceFusion(requestEvent, context);
    }
    else if (action === "repairImage") result = await repairImage(requestEvent, context);
    else if (action === "getMyUserProfile") result = await getMyUserProfile(context);
    else if (action === "saveMyUserProfile") result = await saveMyUserProfile(requestEvent, context);
    else if (action === "getUserPoints") result = await getUserPoints(context);
    else if (action === "checkIn") result = await checkIn(context);
    else if (action === "getPointLedger") result = await getPointLedger(context);
    else if (action === "listRecords") result = await listRecords(context);
    else if (action === "deleteRecord") result = await deleteRecord(requestEvent, context);
    else if (action === "videoProviderStatus") result = await videoProviderStatus();
    else if (action === "createVideoTask") result = await createVideoTask(requestEvent, context);
    else if (action === "queryVideoTask") result = await queryVideoTask(requestEvent, context);
    else if (action === "buildAndroidMotionPhoto") {
      result = await buildAndroidMotionPhoto(requestEvent, context);
    }
    else if (action === "buildAppleLivePhoto") {
      result = await buildAppleLivePhoto(requestEvent, context);
    }
    else if (action === "transferMedia") {
      result = await transferMedia(requestEvent, context);
    }
    else if (action === "releaseTransferMedia") {
      result = await releaseTransferMedia(requestEvent, context);
    }
    else if (action === "getAdminStatus") result = await getAdminStatus(context);
    else if (action === "getTencentFaceFusionAdminStatus") {
      result = await getTencentFaceFusionAdminStatus(context);
    }
    else if (action === "reportDiagnosticLogs") result = await reportDiagnosticLogs(requestEvent, context);
    else if (action === "getAdminDiagnosticLogs") {
      result = await getAdminDiagnosticLogs(requestEvent, context);
    }
    else if (action === "getAdminConfig") result = await getAdminConfig(context);
    else if (action === "getAdminProviderSecrets") {
      result = await getAdminProviderSecrets(requestEvent, context);
    }
    else if (action === "saveAdminProvider") {
      result = await saveAdminProvider(requestEvent, context);
    }
    else if (action === "getAdminImageApiKeys") {
      result = await getAdminImageApiKeys(context);
    }
    else if (action === "getAdminUserStats") result = await getAdminUserStats(requestEvent, context);
    else if (action === "exportAdminUserStats") result = await exportAdminUserStats(requestEvent, context);
    else if (action === "initializeDatabase") result = await initializeDatabase(context);
    else if (action === "saveAdminConfig") result = await saveAdminConfig(requestEvent, context);
    else if (action === "getAdminConfigAuditLogs") {
      result = await getAdminConfigAuditLogs(requestEvent, context);
    }
    else if (action === "checkRuntimeHealth") {
      result = checkRuntimeHealth(requestEvent, context);
    }
    else if (action === "checkDeployment") result = await checkDeployment(requestEvent, context);
    else if (action === "probeImageEditCapability") {
      result = await probeImageEditCapability(requestEvent, context);
    }
    else if (action === "testAdminProviderConnection") {
      result = await testAdminProviderConnection(requestEvent, context);
    }
    else if (action === "probeModels") result = await probeModels(requestEvent, context);
    else if (action === "listModels") result = await listModels(requestEvent, context);
    else if (action === "listDeploymentLogs") result = await listDeploymentLogs(context);
    else if (action === "getModelUsageStats") result = await getModelUsageStats(requestEvent, context);
    else if (action === "getImageProviderFailoverStats") {
      result = await getImageProviderFailoverStats(requestEvent, context);
    }
    else if (action === "exportModelUsageStats") result = await exportModelUsageStats(requestEvent, context);
    else if (action === "exportModelFailureStats") result = await exportModelFailureStats(requestEvent, context);
    else if (action === "reportAutoFaceFailure") {
      result = await reportAutoFaceFailure(requestEvent, context);
    }
    else if (action === "getAutoFaceFailureStats") result = await getAutoFaceFailureStats(requestEvent, context);
    else if (action === "exportAutoFaceFailureStats") {
      result = await exportAutoFaceFailureStats(requestEvent, context);
    }
    else if (action === "registerPhotoToVideoTempAsset") {
      result = await registerPhotoToVideoTempAsset(requestEvent, context);
    }
    else if (action === "markPhotoToVideoSessionActive") {
      result = await updatePhotoToVideoSession(requestEvent, context, "active");
    }
    else if (action === "closePhotoToVideoSession") {
      result = await updatePhotoToVideoSession(requestEvent, context, "close");
    }
    else result = fail(`不支持的操作：${action || "空"}`, "unsupported-action");
    result = addModelErrorContext(action, result);
    log("info", "function.finish", {
      requestId,
      action,
      ok: result && result.ok !== false,
      durationMs: Date.now() - functionStartedAt
    });
    return Object.assign({ requestId }, result || {});
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const mappedError = mapActionErrorResult(action, error, requestId);
    const status = mappedError.status;
    const errorCode = mappedError.errorCode;
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
    return mappedError;
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
    publishExportJobId,
    decodePublishExport,
    encodePublishExport,
    orientPublishRgba,
    readJpegOrientation,
    publishExportCore,
    cleanupPublishExportJobs,
    publishExport,
    cleanupPublishExportResult,
    extractImageItem,
    detectMime,
    invertMask,
    resolveTencentFaceFusionConfig,
    buildTencentTc3Headers,
    requestTencentFaceFusion,
    requestTencentPipelineImageEdit,
    readImageDimensions,
    faceProtectionRects,
    createFaceProtectionMask,
    pixelCodec,
    pixelComposite,
    pixelAcceptance,
    pixelProtectionFlow,
    detectTencentPipelineFaces,
    tencentFaceFusionPipeline,
    testTencentFaceFusion,
    getTencentFaceFusionAdminStatus,
    getTencentFaceFusionPipelineStatus,
    registerTencentFaceFusionIntermediateAsset,
    cleanupTencentFaceFusionIntermediateAssets,
    resolveVisionConfig,
    resolveFaceConfig,
    resolveAnalysisConfig,
    resolveFaceBackupConfig,
    resolveAnalysisBackupConfig,
    visionConfigCandidatesForAction,
    runVisionProviderFailover,
    normalizeApiKey,
    apiKeyHeaders,
    mapActionErrorResult,
    isGeminiCompatibleVision,
    sanitizeVisionRequestPayload,
    resolveImageEditEndpoint,
    resolveImageEditSizeLimits,
    imageEditAssetEntries,
    assertImageEditAssetLimits,
    assertImageEditRequestBodySize,
    classifyImageEditResponse,
    imageEditErrorMessage,
    imageEditMultipartSummary,
    imageUpstreamError,
    visionConfigForAction,
    resolveImageConfig,
    resolveImageBackupConfig,
    resolveEffectiveConfigs,
    runImageEditProviderFailover,
    imageProviderFailover,
    imageProviderAttemptStage,
    imageProviderAttemptProgress,
    migrateLegacyImageProviderConfig,
    guardAdminImageProviderConfig,
    isLegacyLingyunImageConfig,
    assertVisionImageSize,
    normalizeFaceDetections,
    normalizeWebPoseSuggestions,
    resolveVideoConfig,
    resolvePointsConfig,
    resolveCostConfig,
    normalizeImageCostProvider,
    imageProviderPriceTable,
    normalizeImageResolution,
    buildImageOutputSize,
    resolveImageOutputSize,
    buildImageGenerationPayload,
    buildImageRequestMeta,
    executeImageGeneration,
    buildImageEditFields,
    isXingjuImageProvider,
    isLingyunImageProvider,
    imageEditJsonRequestFormat,
    buildImageEditJsonPayload,
    buildLingyunImageEditPayload,
    imageEditJsonSummary,
    buildImageEditCapabilityProbe,
    probeImageEditCapability,
    hasImageEditAssets,
    resolveGenerationMode,
    defaultImageMode: DEFAULT_IMAGE_MODE,
    normalizeVideoResolution,
    modelCapabilities,
    buildImageQualityProbe,
    normalizeAdminProviderLabels,
    mergeAdminProviderLabels,
    validateAdminProviderLabels,
    configuredAdminProviderIds,
    normalizeAdminProviderProfiles,
    mergeAdminProviderProfiles,
    syncAdminTopLevelProviderProfiles,
    redactAdminProviderProfiles,
    migrateLegacyAdminProviderProfiles,
    normalizeRuntimePatch,
    normalizeLegacyRuntimePatch,
    providerStableKey,
    isProviderUuidKey,
    normalizeProviderKey,
    normalizeProviderId,
    normalizeAdminProviderLabels,
    mergeAdminProviderLabels,
    validateAdminProviderLabels,
    normalizeAdminProviderProfileValue,
    normalizeAdminProviderProfiles,
    mergeAdminProviderProfiles,
    syncAdminTopLevelProviderProfiles,
    configuredAdminProviderIds,
    normalizeProviderRecord,
    mergeProviderRecord,
    normalizeProviderRegistry,
    normalizeProviderDirectory,
    mergeProviderRegistry,
    mergeProviderDirectory,
    mergeActiveProviderOverrides,
    mergeActiveBackupOverrides,
    normalizeActiveProviders,
    normalizeActiveBackups,
    buildLegacyProjectionFromProviderRegistry,
    migrateLegacyProviderRegistry,
    migrateProviderExternalIdReferences,
    removeProviderExternalIdReferences,
    redactProviderMetadata,
    redactProviderRegistry,
    providerRegistryList,
    validateProviderRegistry,
    validateProviderDirectory,
    providerConfigComplete,
    providerEnvironmentApiKey,
    providerActiveFallback,
    providerMutationInput,
    providerSecretView,
    providerAdminPayload,
    dropBlankRuntimeApiKeys,
    extractModelUsage,
    extractVideoDuration,
    buildUsageBilling,
    diagnosticLogCutoff,
    normalizeDiagnosticLevel,
    normalizeDiagnosticCategory,
    diagnosticCategoryLabel,
    sanitizeDiagnosticText,
    sanitizeDiagnosticValue,
    normalizeDiagnosticEvent,
    diagnosticDisplayEvent,
    buildAdminDiagnosticStats,
    cleanupDiagnosticLogs,
    reportDiagnosticLogs,
    getAdminDiagnosticLogs,
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
    photoToVideoIdleCleanupCutoff,
    photoToVideoCleanupState,
    isPhotoToVideoCleanupTrigger,
    isGenerationQueueWorkerTrigger,
    isGenerationReconcileTrigger,
    isWatermarkTransferCleanupTrigger,
    isTencentFaceFusionCleanupTrigger,
    registerPhotoToVideoTempAsset,
    updatePhotoToVideoSession,
    cleanupPhotoToVideoFormalRecord,
    cleanupPhotoToVideoTempAssets,
    validateTransferMediaUrl,
    transferMediaTypeFromBuffer,
    normalizeWatermarkTransferKind,
    watermarkTransferDocumentId,
    transferMedia,
    releaseTransferMedia,
    cleanupWatermarkTransferTempAssets,
    dateKeyForTimeZone,
    shiftDateKey,
    shiftMonthKey,
    modelUsageTypeForAction,
    modelUsageTypeLabel,
    modelErrorTypeForAction,
    modelErrorMessage,
    addModelErrorContext,
    normalizeModelUsageEvent,
    aggregateModelUsageEvents,
    modelUsageDetailFromEvent,
    buildModelUsageDetailRows,
    buildModelUsageExportWorkbook,
    buildModelFailureExportWorkbook,
    recordModelUsageEvent,
    normalizeImageProviderAttemptEvent,
    aggregateImageProviderAttemptEvents,
    recordImageProviderAttemptEvent,
    getImageProviderFailoverStats,
    getModelUsageTestEvents: () => modelUsageTestEvents.slice(),
    resetModelUsageTestEvents: () => {
      modelUsageTestEvents.splice(0, modelUsageTestEvents.length);
    },
    getImageProviderAttemptTestEvents: () => imageProviderAttemptTestEvents.slice(),
    resetImageProviderAttemptTestEvents: () => {
      imageProviderAttemptTestEvents.splice(0, imageProviderAttemptTestEvents.length);
    },
    buildAdminConfigAuditChanges,
    normalizeAdminConfigAuditRow,
    writeAdminConfigAuditLog,
    getAdminConfigAuditLogs,
    getAdminConfigAuditTestRows: () => adminConfigAuditTestRows.slice(),
    resetAdminConfigAuditTestRows: () => {
      adminConfigAuditTestRows.splice(0, adminConfigAuditTestRows.length);
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
    getOpenId,
    stripDocumentId,
    videoProviderStatus,
    buildVideoGenerationPayload,
    normalizeVideoCreateResponse,
    normalizeVideoQueryResponse,
    videoCreateUrl,
    videoQueryUrl,
    motionPhotoArtifactHash,
    normalizedVideoSourceCloudPath,
    normalizedVideoResultCloudPath,
    materializeVideoResult,
    androidMotionPhotoFileName,
    androidMotionPhotoCloudPath,
    appleLivePhotoFileName,
    appleLivePhotoCloudPath,
    deterministicAppleContentIdentifier,
    resolveAppleLivePhotoWorkerConfig,
    cloudTempFileUrl,
    appleLivePhotoResultView,
    callAppleLivePhotoWorker,
    requireOwnedVideoOperation,
    androidMotionPhotoResultView,
    buildAndroidMotionPhoto,
    buildAppleLivePhoto,
    normalizeSourceToJpeg,
    buildAndroidMotionPhotoBuffer,
    buildAutoFaceProbe
    ,
    processQueuedGenerationOperation,
    adminOpenIds,
    isAdminContext,
    usageUserHash,
    normalizeRuntimePatch,
    imageRetryPreferenceVersion,
    resolveImageRetryEnabled,
    migrateLegacyImageRetryConfig,
    migrateLegacyModelCostConfig,
    validateCostNumber,
    validateRuntimePatch,
    mergeRuntimeConfig,
    getAdminStatus,
    getAdminConfig,
    getAdminImageApiKeys,
    normalizeUserGender,
    normalizeUserNickname,
    normalizeAdminUserSearch,
    normalizeAdminUserDateRange,
    normalizeAdminUserGenderFilter,
    normalizeAdminUserDateKey,
    filterAdminUserProfiles,
    buildAdminUserSignupTrend,
    userProfileView,
    buildAdminUserStats,
    getMyUserProfile,
    saveMyUserProfile,
    getAdminUserStats,
    normalizeAdminUserProfileRows,
    buildAdminUserExportWorkbook,
    loadAllAdminUserProfiles,
    exportAdminUserStats,
    getUserProfileTestRows: () => userProfileTestRows.slice(),
    resetUserProfileTestRows: () => {
      userProfileTestRows.splice(0, userProfileTestRows.length);
    },
    getUserDiagnosticLogTestRows: () => userDiagnosticLogTestRows.slice(),
    pushUserDiagnosticLogTestRow: (row) => {
      userDiagnosticLogTestRows.push(row);
    },
    resetUserDiagnosticLogTestRows: () => {
      userDiagnosticLogTestRows.splice(0, userDiagnosticLogTestRows.length);
    },
    isCollectionMissingError,
    ensureDatabaseCollection,
    initializeDatabaseCollections,
    initializeDatabase,
    requiredDatabaseCollections: REQUIRED_DATABASE_COLLECTIONS.slice(),
    saveAdminConfig,
    saveAdminProvider,
    getAdminProviderSecrets,
    getAdminConfigAuditLogs,
    checkRuntimeDependencies,
    checkRuntimeHealth,
    checkDeployment,
    modelProbeUrl,
    listedModelIds,
    probeOneModel,
    normalizeModelProbeType,
    temporaryModelConfig,
    adminProviderConnectionConfig,
    adminProviderConnectionErrorCode,
    testAdminProviderConnection,
    probeModels,
    listModels,
    listDeploymentLogs
    ,
    exportModelUsageStats,
    exportModelFailureStats,
    exportAutoFaceFailureStats,
    pointsSummary,
    reserveUsage,
    sanitizeGenerationPayload,
    normalizeGenerationStatus,
    statusMessageForGenerationOperation,
    serializeGenerationDate,
    buildGenerationStatusResult,
    buildPublicGenerationBilling,
    enqueueGenerationOperation,
    touchGenerationOperation,
    getGenerationStatus,
    generationOperationRetention,
    generationOperationRetentionService,
    loadGenerationOperationCleanupCandidates,
    readGenerationOperationForCleanup,
    removeGenerationOperationForCleanup,
    cleanupGenerationOperationHistory,
    rebuildResultFromOperation,
    deleteGenerationResultFile,
    reconcileGenerationOperation,
    reconcileGenerationOperationForTest,
    reconcileGenerationOperations,
    processGenerationQueue,
    generationActionRegistry,
    generationExecutionKernel,
    videoExecutionKernel,
    generationStateMachine,
    sanitizeVideoOperationResult,
    completeVideoGenerationOperation,
    failVideoGenerationOperation,
    refundUsage,
    claimGenerationOperation,
    completeGenerationOperation,
    failGenerationOperation,
    checkIn,
    getTestDatabase: () => db,
    getAdminRuntimeCache: () => adminRuntimeCache
  };
}
