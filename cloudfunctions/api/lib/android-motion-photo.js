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
