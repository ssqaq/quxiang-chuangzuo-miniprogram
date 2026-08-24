"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_LIVP_BYTES = 110 * 1024 * 1024;
const STILL_IMAGE_SAMPLE = Buffer.from([
  0x00, 0x00, 0x00, 0x09,
  0x00, 0x00, 0x00, 0x01,
  0x00
]);

// 该 448 字节轨道来自 Apple Live Photo 公共容器格式本身，不包含第三方程序代码。
// 运行时会动态改写轨道号、QuickTime 时间和 still-image-time 样本偏移。
const STILL_IMAGE_TRACK_TEMPLATE = Buffer.from(
  "000001c07472616b0000005c746b6864"
  + "00000007e5923008e592300900000003"
  + "00000000000003d40000000000000000"
  + "00000000000000000001000000000000"
  + "00000000000000000001000000000000"
  + "00000000000000004000000000000000"
  + "000000000000015c6d64696100000020"
  + "6d64686400000000e5923008e5923009"
  + "0006baa80000aff255c4000000000024"
  + "68646c7200000000000000006d657461"
  + "000000000000000000000000756e6400"
  + "000001106d696e660000000c6e6d6864"
  + "000000000000002464696e660000001c"
  + "6472656600000000000000010000000c"
  + "75726c2000000001000000d87374626c"
  + "00000070737473640000000000000001"
  + "000000606d6562780000000000000001"
  + "000000506b6579730000004800000001"
  + "000000306b6579646d647461636f6d2e"
  + "6170706c652e717569636b74696d652e"
  + "7374696c6c2d696d6167652d74696d65"
  + "00000010647479700000000000000041"
  + "00000018737474730000000000000001"
  + "000000010000aff20000001c73747363"
  + "00000000000000010000000100000001"
  + "00000001000000187374737a00000000"
  + "00000000000000010000000900000014"
  + "7374636f000000000000000100000000",
  "hex"
);

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function createError(message, code, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function assertBufferLimit(buffer, maxBytes, label, code) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw createError(`${label}为空。`, code);
  }
  if (buffer.length > maxBytes) {
    throw createError(`${label}超过大小限制。`, code);
  }
}

function normalizeContentIdentifier(value) {
  const text = String(value || "").trim().toUpperCase();
  if (
    !/^[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/.test(text)
  ) {
    throw createError("Apple Live Photo 配对编号无效。", "APPLE_CONTENT_IDENTIFIER_INVALID");
  }
  return text;
}

function createContentIdentifier() {
  return crypto.randomUUID().toUpperCase();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function isIsoBaseMedia(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.subarray(4, 8).toString("ascii") === "ftyp";
}

function buildAppleMakerNote(contentIdentifier) {
  const identifier = normalizeContentIdentifier(contentIdentifier);
  const makerNote = Buffer.alloc(70);
  makerNote.write("Apple iOS\0", 0, "ascii");
  makerNote.writeUInt16BE(1, 10);
  makerNote.write("MM", 12, "ascii");
  makerNote.writeUInt16BE(1, 14);
  makerNote.writeUInt16BE(0x0011, 16);
  makerNote.writeUInt16BE(2, 18);
  makerNote.writeUInt32BE(37, 20);
  makerNote.writeUInt32BE(32, 24);
  makerNote.writeUInt32BE(0, 28);
  makerNote.write(identifier, 32, "ascii");
  makerNote[68] = 0;
  makerNote[69] = 0;
  return makerNote;
}

function buildExifApp1(contentIdentifier) {
  const makerNote = buildAppleMakerNote(contentIdentifier);
  const tiff = Buffer.alloc(44 + makerNote.length);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4);

  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt32BE(0, 22);

  tiff.writeUInt16BE(1, 26);
  tiff.writeUInt16BE(0x927c, 28);
  tiff.writeUInt16BE(7, 30);
  tiff.writeUInt32BE(makerNote.length, 32);
  tiff.writeUInt32BE(44, 36);
  tiff.writeUInt32BE(0, 40);
  makerNote.copy(tiff, 44);

  const payload = Buffer.concat([
    Buffer.from("Exif\0\0", "binary"),
    tiff
  ]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([segment, payload]);
}

function attachAppleMakerNote(jpegBuffer, contentIdentifier) {
  assertBufferLimit(
    jpegBuffer,
    MAX_IMAGE_BYTES,
    "源图片",
    "APPLE_SOURCE_IMAGE_INVALID"
  );
  if (!isJpeg(jpegBuffer)) {
    throw createError("Apple Live Photo 封面必须是完整 JPEG。", "APPLE_SOURCE_IMAGE_NOT_JPEG");
  }
  const app1 = buildExifApp1(contentIdentifier);
  return Buffer.concat([
    jpegBuffer.subarray(0, 2),
    app1,
    jpegBuffer.subarray(2)
  ]);
}

function parseBoxes(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    let headerSize = 8;
    let size = size32;
    if (size32 === 1) {
      if (offset + 16 > end) {
        throw createError("MOV 扩展长度盒子损坏。", "APPLE_MOV_BOX_INVALID");
      }
      const size64 = buffer.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw createError("MOV 盒子过大。", "APPLE_MOV_BOX_TOO_LARGE");
      }
      size = Number(size64);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      throw createError(`MOV ${type || "未知"} 盒子长度损坏。`, "APPLE_MOV_BOX_INVALID");
    }
    boxes.push({
      type,
      offset,
      size,
      headerSize,
      end: offset + size,
      extended: size32 === 1
    });
    offset += size;
  }
  if (offset !== end) {
    throw createError("MOV 盒子末尾存在无法解析的数据。", "APPLE_MOV_BOX_INVALID");
  }
  return boxes;
}

function childBoxes(buffer, parent) {
  return parseBoxes(
    buffer,
    parent.offset + parent.headerSize,
    parent.end
  );
}

function readTrackId(buffer, track) {
  const tkhd = childBoxes(buffer, track).find((box) => box.type === "tkhd");
  if (!tkhd) return 0;
  const version = buffer[tkhd.offset + tkhd.headerSize];
  const relative = version === 1 ? 20 : 12;
  return buffer.readUInt32BE(tkhd.offset + tkhd.headerSize + relative);
}

function quickTimeTimestamp(date = new Date()) {
  const secondsSinceUnixEpoch = Math.floor(date.getTime() / 1000);
  return (secondsSinceUnixEpoch + 2082844800) >>> 0;
}

function buildStillImageTrack(trackId, sampleOffset, date = new Date()) {
  if (!Number.isInteger(trackId) || trackId < 1 || trackId > 0xffffffff) {
    throw createError("MOV 数据轨编号无效。", "APPLE_MOV_TRACK_ID_INVALID");
  }
  if (!Number.isInteger(sampleOffset) || sampleOffset < 0 || sampleOffset > 0xffffffff) {
    throw createError("MOV still-image-time 样本偏移超出 32 位范围。", "APPLE_MOV_OFFSET_TOO_LARGE");
  }
  const track = Buffer.from(STILL_IMAGE_TRACK_TEMPLATE);
  const timestamp = quickTimeTimestamp(date);
  track.writeUInt32BE(timestamp, 20);
  track.writeUInt32BE((timestamp + 1) >>> 0, 24);
  track.writeUInt32BE(trackId >>> 0, 28);
  track.writeUInt32BE(timestamp, 120);
  track.writeUInt32BE((timestamp + 1) >>> 0, 124);
  track.writeUInt32BE(sampleOffset >>> 0, track.length - 4);
  return track;
}

function injectStillImageTimeTrack(movBuffer, options = {}) {
  assertBufferLimit(
    movBuffer,
    MAX_VIDEO_BYTES,
    "MOV 视频",
    "APPLE_MOV_INVALID"
  );
  if (!isIsoBaseMedia(movBuffer)) {
    throw createError("FFmpeg 输出不是有效 MOV。", "APPLE_MOV_FTYP_INVALID");
  }
  if (movBuffer.includes(Buffer.from("mebx", "ascii"))) {
    throw createError("MOV 已包含 mebx 数据轨，拒绝重复写入。", "APPLE_MOV_MEBX_EXISTS");
  }

  const topLevel = parseBoxes(movBuffer);
  const mdat = topLevel.find((box) => box.type === "mdat");
  const moov = topLevel.find((box) => box.type === "moov");
  if (!mdat || !moov) {
    throw createError("MOV 缺少 mdat 或 moov。", "APPLE_MOV_REQUIRED_BOX_MISSING");
  }
  if (mdat.extended || moov.extended) {
    throw createError("暂不支持超大 MOV 扩展长度盒子。", "APPLE_MOV_EXTENDED_BOX_UNSUPPORTED");
  }
  if (moov.offset < mdat.end) {
    throw createError(
      "媒体 worker 只接受自身生成的尾置 moov MOV。",
      "APPLE_MOV_LAYOUT_UNSUPPORTED"
    );
  }
  if (mdat.size + STILL_IMAGE_SAMPLE.length > 0xffffffff) {
    throw createError("MOV mdat 超过 32 位大小限制。", "APPLE_MOV_TOO_LARGE");
  }

  const moovChildren = childBoxes(movBuffer, moov);
  const trackIds = moovChildren
    .filter((box) => box.type === "trak")
    .map((track) => readTrackId(movBuffer, track))
    .filter((trackId) => trackId > 0);
  const nextTrackId = Math.max(0, ...trackIds) + 1;
  const sampleOffset = mdat.end;
  const metadataTrack = buildStillImageTrack(
    nextTrackId,
    sampleOffset,
    options.date || new Date()
  );

  const prefix = Buffer.from(movBuffer.subarray(0, mdat.end));
  prefix.writeUInt32BE(mdat.size + STILL_IMAGE_SAMPLE.length, mdat.offset);

  const patchedMoov = Buffer.concat([
    movBuffer.subarray(moov.offset, moov.end),
    metadataTrack
  ]);
  patchedMoov.writeUInt32BE(patchedMoov.length, 0);
  const patchedMoovBox = {
    offset: 0,
    size: patchedMoov.length,
    headerSize: moov.headerSize,
    end: patchedMoov.length
  };
  const mvhd = childBoxes(patchedMoov, patchedMoovBox)
    .find((box) => box.type === "mvhd");
  if (!mvhd || mvhd.size < 12) {
    throw createError("MOV 缺少有效 mvhd。", "APPLE_MOV_MVHD_INVALID");
  }
  patchedMoov.writeUInt32BE((nextTrackId + 1) >>> 0, mvhd.end - 4);

  const result = Buffer.concat([
    prefix,
    STILL_IMAGE_SAMPLE,
    movBuffer.subarray(mdat.end, moov.offset),
    patchedMoov,
    movBuffer.subarray(moov.end)
  ]);
  if (result.length > MAX_VIDEO_BYTES) {
    throw createError("写入 Apple 元数据后的 MOV 超过大小限制。", "APPLE_MOV_TOO_LARGE");
  }
  return {
    buffer: result,
    trackId: nextTrackId,
    sampleOffset,
    sampleLength: STILL_IMAGE_SAMPLE.length
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc = CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = ((year - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate();
  const dosTime = (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

function livpComment(records) {
  const descriptor = Buffer.alloc(records.length * 10 + 8);
  records.forEach((record, index) => {
    const offset = index * 10;
    descriptor.writeUInt16BE(record.mediaType, offset);
    descriptor.writeUInt32BE(record.dataOffset >>> 0, offset + 2);
    descriptor.writeUInt32BE(record.dataLength >>> 0, offset + 6);
  });
  descriptor.write("1000LIVP", records.length * 10, "ascii");
  return Buffer.from(descriptor.toString("hex").toUpperCase(), "ascii");
}

function buildStoredZip(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length !== 2) {
    throw createError("LIVP 必须正好包含 JPEG 和 MOV 两个成员。", "APPLE_LIVP_MEMBER_COUNT_INVALID");
  }
  const dateTime = dosDateTime(options.date || new Date());
  const localParts = [];
  const centralParts = [];
  const records = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name || ""), "utf8");
    const data = Buffer.from(entry.data || []);
    if (!name.length || name.length > 0xffff) {
      throw createError("LIVP 成员文件名无效。", "APPLE_LIVP_MEMBER_NAME_INVALID");
    }
    if (!data.length || data.length > 0xffffffff) {
      throw createError("LIVP 成员大小无效。", "APPLE_LIVP_MEMBER_SIZE_INVALID");
    }
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dateTime.dosTime, 10);
    localHeader.writeUInt16LE(dateTime.dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const dataOffset = offset + localHeader.length + name.length;
    records.push({
      mediaType: Number(entry.mediaType),
      dataOffset,
      dataLength: data.length
    });
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dateTime.dosTime, 12);
    centralHeader.writeUInt16LE(dateTime.dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const comment = livpComment(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  const buffer = Buffer.concat([
    ...localParts,
    centralDirectory,
    end,
    comment
  ]);
  if (buffer.length > MAX_LIVP_BYTES) {
    throw createError("LIVP 输出超过大小限制。", "APPLE_LIVP_TOO_LARGE");
  }
  return { buffer, records, comment };
}

function sanitizeBaseName(value, contentIdentifier) {
  const cleaned = String(value || "")
    .replace(/\.[^.]+$/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || `IMG_${contentIdentifier.replace(/-/g, "").slice(0, 12)}`;
}

function buildLivpBuffer(jpegBuffer, movBuffer, options = {}) {
  const contentIdentifier = normalizeContentIdentifier(options.contentIdentifier);
  assertBufferLimit(
    jpegBuffer,
    MAX_IMAGE_BYTES + 2048,
    "Apple JPEG",
    "APPLE_JPEG_INVALID"
  );
  assertBufferLimit(
    movBuffer,
    MAX_VIDEO_BYTES,
    "Apple MOV",
    "APPLE_MOV_INVALID"
  );
  if (!isJpeg(jpegBuffer)) {
    throw createError("Apple LIVP 的图片成员不是 JPEG。", "APPLE_JPEG_INVALID");
  }
  if (!isIsoBaseMedia(movBuffer)) {
    throw createError("Apple LIVP 的视频成员不是 MOV。", "APPLE_MOV_INVALID");
  }
  const identifierBytes = Buffer.from(contentIdentifier, "ascii");
  if (
    !jpegBuffer.includes(Buffer.from("Apple iOS\0", "binary"))
    || !jpegBuffer.includes(identifierBytes)
  ) {
    throw createError("JPEG 缺少 Apple ContentIdentifier。", "APPLE_JPEG_IDENTIFIER_MISSING");
  }
  if (
    !movBuffer.includes(Buffer.from("com.apple.quicktime.content.identifier", "ascii"))
    || !movBuffer.includes(Buffer.from("com.apple.quicktime.still-image-time", "ascii"))
    || !movBuffer.includes(Buffer.from("mebx", "ascii"))
    || !movBuffer.includes(identifierBytes)
  ) {
    throw createError("MOV 缺少 Apple Live Photo 配对元数据。", "APPLE_MOV_METADATA_MISSING");
  }

  const baseName = sanitizeBaseName(options.baseName, contentIdentifier);
  const built = buildStoredZip([
    {
      name: `${baseName}.JPG.jpeg`,
      data: jpegBuffer,
      mediaType: 5
    },
    {
      name: `${baseName}.JPG.mov`,
      data: movBuffer,
      mediaType: 3
    }
  ], options);
  return {
    buffer: built.buffer,
    fileName: `${baseName}.livp`,
    contentIdentifier,
    photoName: `${baseName}.JPG.jpeg`,
    videoName: `${baseName}.JPG.mov`,
    photoSha256: sha256(jpegBuffer),
    videoSha256: sha256(movBuffer),
    livpSha256: sha256(built.buffer),
    records: built.records,
    comment: built.comment.toString("ascii")
  };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr = [];
    let stderrBytes = 0;
    const stderrLimit = 128 * 1024;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      if (stderrBytes >= stderrLimit) return;
      const value = Buffer.from(chunk);
      stderr.push(value.subarray(0, stderrLimit - stderrBytes));
      stderrBytes += value.length;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(createError(
        `无法启动 FFmpeg：${error.message}`,
        "APPLE_FFMPEG_START_FAILED",
        true
      ));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-2000);
      reject(createError(
        `FFmpeg 转 MOV 失败${signal ? `（${signal}）` : ""}：${detail || `退出码 ${code}`}`,
        signal ? "APPLE_FFMPEG_TIMEOUT" : "APPLE_FFMPEG_FAILED",
        Boolean(signal)
      ));
    });
  });
}

async function convertMp4ToMov(inputPath, outputPath, contentIdentifier, options = {}) {
  const identifier = normalizeContentIdentifier(contentIdentifier);
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-i", inputPath,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "libx264",
    "-preset", options.preset || "medium",
    "-crf", String(Number(options.crf) || 18),
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-movflags", "use_metadata_tags",
    "-metadata", `com.apple.quicktime.content.identifier=${identifier}`,
    outputPath
  ];
  await runProcess(ffmpegPath, args, {
    timeoutMs: options.timeoutMs || 120000,
    cwd: path.dirname(outputPath)
  });
}

async function buildAppleLivePhoto(imageBuffer, videoBuffer, options = {}) {
  assertBufferLimit(
    imageBuffer,
    MAX_IMAGE_BYTES,
    "源图片",
    "APPLE_SOURCE_IMAGE_INVALID"
  );
  assertBufferLimit(
    videoBuffer,
    MAX_VIDEO_BYTES,
    "源视频",
    "APPLE_SOURCE_VIDEO_INVALID"
  );
  if (!isJpeg(imageBuffer)) {
    throw createError("源图片必须先统一为 JPEG。", "APPLE_SOURCE_IMAGE_NOT_JPEG");
  }
  if (!isIsoBaseMedia(videoBuffer)) {
    throw createError("源视频不是有效 MP4。", "APPLE_SOURCE_VIDEO_NOT_MP4");
  }
  const contentIdentifier = options.contentIdentifier
    ? normalizeContentIdentifier(options.contentIdentifier)
    : createContentIdentifier();
  const workDir = String(options.workDir || "").trim();
  if (!workDir) {
    throw createError("缺少媒体 worker 临时目录。", "APPLE_WORK_DIR_MISSING");
  }
  await fs.promises.mkdir(workDir, { recursive: true });
  const inputPath = path.join(workDir, "input.mp4");
  const cleanMovPath = path.join(workDir, "clean.mov");
  await fs.promises.writeFile(inputPath, videoBuffer);
  await convertMp4ToMov(
    inputPath,
    cleanMovPath,
    contentIdentifier,
    options
  );
  const cleanMov = await fs.promises.readFile(cleanMovPath);
  const pairedJpeg = attachAppleMakerNote(imageBuffer, contentIdentifier);
  const patchedMov = injectStillImageTimeTrack(cleanMov, options);
  const livp = buildLivpBuffer(pairedJpeg, patchedMov.buffer, {
    contentIdentifier,
    baseName: options.baseName,
    date: options.date
  });
  return Object.assign({}, livp, {
    photoBytes: pairedJpeg.length,
    videoBytes: patchedMov.buffer.length,
    livpBytes: livp.buffer.length,
    metadataTrackId: patchedMov.trackId,
    stillImageSampleOffset: patchedMov.sampleOffset,
    stillImageSampleLength: patchedMov.sampleLength,
    format: "apple-livp",
    validation: {
      zipStored: true,
      matchingContentIdentifier: true,
      movHasMebx: true,
      movHasStillImageTime: true
    }
  });
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_LIVP_BYTES,
  STILL_IMAGE_SAMPLE,
  STILL_IMAGE_TRACK_TEMPLATE,
  createContentIdentifier,
  normalizeContentIdentifier,
  sha256,
  isJpeg,
  isIsoBaseMedia,
  buildAppleMakerNote,
  buildExifApp1,
  attachAppleMakerNote,
  parseBoxes,
  injectStillImageTimeTrack,
  crc32,
  livpComment,
  buildStoredZip,
  buildLivpBuffer,
  convertMp4ToMov,
  buildAppleLivePhoto
};
