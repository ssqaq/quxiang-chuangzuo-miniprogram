const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");

const DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 4 * 1024 * 1024;

function imagePixelError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function detectImageFormat(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (source.length >= 2 && source[0] === 0xff && source[1] === 0xd8) {
    return "jpeg";
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
    return "png";
  }
  if (
    source.length >= 12
    && source.subarray(0, 4).toString("ascii") === "RIFF"
    && source.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return "unknown";
}

function readJpegOrientation(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (detectImageFormat(source) !== "jpeg") return 1;
  let offset = 2;
  try {
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
        if (tiff + 8 > source.length) return 1;
        const byteOrder = source.toString("ascii", tiff, tiff + 2);
        if (byteOrder !== "II" && byteOrder !== "MM") return 1;
        const littleEndian = byteOrder === "II";
        const read16 = (position) => {
          if (position < 0 || position + 2 > source.length) throw new RangeError("EXIF uint16 越界");
          return littleEndian
            ? source.readUInt16LE(position)
            : source.readUInt16BE(position);
        };
        const read32 = (position) => {
          if (position < 0 || position + 4 > source.length) throw new RangeError("EXIF uint32 越界");
          return littleEndian
            ? source.readUInt32LE(position)
            : source.readUInt32BE(position);
        };
        if (read16(tiff + 2) !== 42) return 1;
        const ifd = tiff + read32(tiff + 4);
        if (ifd < tiff || ifd + 2 > source.length) return 1;
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
  } catch (_) {
    return 1;
  }
  return 1;
}

function orientRgba(data, width, height, orientation) {
  const source = Buffer.from(data || []);
  const value = Math.max(1, Math.min(8, Number(orientation) || 1));
  if (source.length !== width * height * 4) {
    throw imagePixelError("图片 RGBA 数据长度不正确。", "PIXEL_IMAGE_RGBA_INVALID");
  }
  if (value === 1) {
    return {
      data: Buffer.from(source),
      width,
      height
    };
  }
  const swapped = value >= 5;
  const outputWidth = swapped ? height : width;
  const outputHeight = swapped ? width : height;
  const output = Buffer.alloc(outputWidth * outputHeight * 4);
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
      source.copy(output, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
  return {
    data: output,
    width: outputWidth,
    height: outputHeight
  };
}

function assertDecodedImage(image, options = {}) {
  const label = String(options.label || "图片");
  const width = Number(image && image.width);
  const height = Number(image && image.height);
  const pixels = width * height;
  const maxPixels = Math.max(1, Number(options.maxPixels) || DEFAULT_MAX_PIXELS);
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || !Number.isSafeInteger(pixels)
  ) {
    throw imagePixelError(`${label}尺寸无效。`, "PIXEL_IMAGE_DIMENSIONS_INVALID");
  }
  if (pixels > maxPixels) {
    throw imagePixelError(
      `${label}像素过大，最多支持 ${maxPixels} 像素。`,
      "PIXEL_IMAGE_TOO_LARGE"
    );
  }
  if (!image.data || image.data.length !== pixels * 4) {
    throw imagePixelError(`${label}解码后的 RGBA 数据不完整。`, "PIXEL_IMAGE_RGBA_INVALID");
  }
  return image;
}

function decodeImage(buffer, options = {}) {
  const label = String(options.label || "图片");
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_INPUT_BYTES);
  if (!source.length) {
    throw imagePixelError(`${label}内容为空。`, "PIXEL_IMAGE_EMPTY");
  }
  if (source.length > maxBytes) {
    throw imagePixelError(`${label}文件过大，无法安全处理。`, "PIXEL_IMAGE_FILE_TOO_LARGE");
  }
  const format = detectImageFormat(source);
  if (format === "webp") {
    throw imagePixelError(
      `${label}暂时不支持 WebP，请改用 JPG 或 PNG。`,
      "PIXEL_IMAGE_WEBP_UNSUPPORTED"
    );
  }
  const allowedFormats = Array.isArray(options.allowedFormats)
    ? options.allowedFormats.map((item) => String(item || "").toLowerCase())
    : ["jpeg", "png"];
  if (!allowedFormats.includes(format)) {
    throw imagePixelError(
      `${label}格式不支持，请使用 JPG 或 PNG。`,
      "PIXEL_IMAGE_FORMAT_UNSUPPORTED"
    );
  }
  try {
    if (format === "jpeg") {
      const decoded = jpeg.decode(source, {
        useTArray: true,
        formatAsRGBA: true,
        maxResolutionInMP: Math.ceil(
          (Math.max(1, Number(options.maxPixels) || DEFAULT_MAX_PIXELS)) / 1000000
        ),
        maxMemoryUsageInMB: 256
      });
      const orientation = readJpegOrientation(source);
      const oriented = orientRgba(
        decoded.data,
        Number(decoded.width),
        Number(decoded.height),
        orientation
      );
      return assertDecodedImage({
        data: oriented.data,
        width: oriented.width,
        height: oriented.height,
        format,
        mime: "image/jpeg",
        orientation,
        sourceWidth: Number(decoded.width),
        sourceHeight: Number(decoded.height)
      }, Object.assign({}, options, { label }));
    }
    const decoded = PNG.sync.read(source, { checkCRC: true });
    return assertDecodedImage({
      data: Buffer.from(decoded.data),
      width: Number(decoded.width),
      height: Number(decoded.height),
      format,
      mime: "image/png",
      orientation: 1,
      sourceWidth: Number(decoded.width),
      sourceHeight: Number(decoded.height)
    }, Object.assign({}, options, { label }));
  } catch (error) {
    if (error && error.code) throw error;
    throw imagePixelError(
      `${label}解码失败：${error && error.message ? error.message : "图片已损坏"}`,
      "PIXEL_IMAGE_DECODE_FAILED"
    );
  }
}

function assertSameDimensions(left, right, options = {}) {
  const leftLabel = String(options.leftLabel || "基准图");
  const rightLabel = String(options.rightLabel || "结果图");
  if (
    !left
    || !right
    || Number(left.width) !== Number(right.width)
    || Number(left.height) !== Number(right.height)
  ) {
    throw imagePixelError(
      `${rightLabel}尺寸 ${right && right.width || 0}x${right && right.height || 0}`
      + ` 与${leftLabel} ${left && left.width || 0}x${left && left.height || 0} 不一致。`,
      "PIXEL_IMAGE_SIZE_MISMATCH"
    );
  }
}

function encodePngCandidate(image, compression) {
  const png = new PNG({
    width: image.width,
    height: image.height,
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true
  });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png, {
    colorType: 6,
    inputColorType: 6,
    inputHasAlpha: true,
    deflateLevel: compression.deflateLevel,
    deflateStrategy: compression.deflateStrategy
  });
}

function encodePngRoundTrip(image, options = {}) {
  const label = String(options.label || "最终图片");
  assertDecodedImage(image, Object.assign({}, options, { label }));
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 0;
  const candidates = [
    { deflateLevel: 9, deflateStrategy: 3 },
    { deflateLevel: 9, deflateStrategy: 0 },
    { deflateLevel: 9, deflateStrategy: 1 },
    { deflateLevel: 6, deflateStrategy: 3 }
  ];
  let selected = null;
  for (const compression of candidates) {
    let buffer;
    try {
      buffer = encodePngCandidate(image, compression);
    } catch (error) {
      throw imagePixelError(
        `${label}无损 PNG 编码失败：${error && error.message ? error.message : "未知错误"}`,
        "PIXEL_PNG_ENCODE_FAILED"
      );
    }
    if (!selected || buffer.length < selected.buffer.length) {
      selected = { buffer, compression };
    }
    if (!maxBytes || buffer.length <= maxBytes) break;
  }
  if (!selected || !selected.buffer.length) {
    throw imagePixelError(`${label}无损 PNG 编码结果为空。`, "PIXEL_PNG_ENCODE_FAILED");
  }
  if (maxBytes && selected.buffer.length > maxBytes) {
    throw imagePixelError(
      `${label}无损 PNG 为 ${(selected.buffer.length / 1024 / 1024).toFixed(2)}MB，`
      + `超过 ${(maxBytes / 1024 / 1024).toFixed(2)}MB 限制。`,
      "PIXEL_PNG_TOO_LARGE"
    );
  }
  const delivered = decodeImage(selected.buffer, {
    label: `${label}编码后文件`,
    allowedFormats: ["png"],
    maxBytes: Math.max(DEFAULT_MAX_INPUT_BYTES, maxBytes || 0, selected.buffer.length),
    maxPixels: options.maxPixels
  });
  assertSameDimensions(image, delivered, {
    leftLabel: `${label}编码前`,
    rightLabel: `${label}编码后`
  });
  if (!Buffer.from(image.data).equals(Buffer.from(delivered.data))) {
    throw imagePixelError(
      `${label}无损 PNG 编码后像素发生变化。`,
      "PIXEL_PNG_ROUNDTRIP_MISMATCH"
    );
  }
  return {
    buffer: selected.buffer,
    delivered,
    bytes: selected.buffer.length,
    compression: selected.compression
  };
}

module.exports = {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_PIXELS,
  imagePixelError,
  detectImageFormat,
  readJpegOrientation,
  orientRgba,
  decodeImage,
  assertDecodedImage,
  assertSameDimensions,
  encodePngRoundTrip
};
