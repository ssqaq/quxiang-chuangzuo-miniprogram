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
  gentleSoften: false,
  gentleSharpen: true,
  cameraNoise: true,
  cameraNoiseStrength: 3,
  frequencyPerturb: true,
  frequencyStrength: 3,
  removeVisibleMarks: false,
  watermarkStrength: 1,
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
  return Number.isFinite(number) ? clamp(Math.round(number), 1, 5) : fallback;
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

