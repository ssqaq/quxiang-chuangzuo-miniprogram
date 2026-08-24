/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const jpeg = require("../cloudfunctions/api/node_modules/jpeg-js");
const livePhoto = require("../media-worker/lib/apple-live-photo");

const FFMPEG = process.env.FFMPEG_PATH
  || "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe";
const FFPROBE = process.env.FFPROBE_PATH
  || "C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffprobe.exe";
const IDENTIFIER = "12345678-1234-4ABC-9DEF-1234567890AB";

function run(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true
  });
  assert.strictEqual(
    result.status,
    0,
    `${label}失败：${result.stderr || result.stdout}`
  );
  return result.stdout;
}

function makeJpeg() {
  const width = 64;
  const height = 48;
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = 55;
    data[index * 4 + 1] = 120;
    data[index * 4 + 2] = 220;
    data[index * 4 + 3] = 255;
  }
  return jpeg.encode({ width, height, data }, 95).data;
}

function findEocd(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function parseStoredEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const crc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataOffset = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = buffer.subarray(dataOffset, dataOffset + compressedSize);
    entries.push({
      name,
      method,
      crc,
      size,
      compressedSize,
      dataOffset,
      data
    });
    offset = dataOffset + compressedSize;
  }
  return entries;
}

function parseComment(comment) {
  const decoded = Buffer.from(comment.toString("ascii"), "hex");
  assert.strictEqual(decoded.subarray(decoded.length - 8).toString("ascii"), "1000LIVP");
  const records = [];
  for (let offset = 0; offset < decoded.length - 8; offset += 10) {
    records.push({
      mediaType: decoded.readUInt16BE(offset),
      dataOffset: decoded.readUInt32BE(offset + 2),
      dataLength: decoded.readUInt32BE(offset + 6)
    });
  }
  return records;
}

async function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "livp-smoke-"));
  try {
    const inputVideo = path.join(workDir, "input.mp4");
    const outputLivp = path.join(workDir, "output.livp");
    run(FFMPEG, [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=64x48:r=25:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      inputVideo
    ], "生成测试 MP4");

    const sourceJpeg = makeJpeg();
    const sourceVideo = fs.readFileSync(inputVideo);
    const built = await livePhoto.buildAppleLivePhoto(sourceJpeg, sourceVideo, {
      workDir,
      ffmpegPath: FFMPEG,
      contentIdentifier: IDENTIFIER,
      baseName: "IMG_LIVP_SMOKE",
      date: new Date("2026-08-24T00:00:00Z")
    });
    fs.writeFileSync(outputLivp, built.buffer);

    assert.strictEqual(built.format, "apple-livp");
    assert.strictEqual(built.contentIdentifier, IDENTIFIER);
    assert.ok(built.fileName.endsWith(".livp"));
    assert.strictEqual(built.livpSha256, livePhoto.sha256(built.buffer));

    const entries = parseStoredEntries(built.buffer);
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map((entry) => entry.method), [0, 0]);
    assert.ok(entries[0].name.endsWith(".JPG.jpeg"));
    assert.ok(entries[1].name.endsWith(".JPG.mov"));
    assert.ok(entries[0].data.includes(Buffer.from("Apple iOS\0", "binary")));
    assert.ok(entries[0].data.includes(Buffer.from(IDENTIFIER, "ascii")));
    assert.ok(entries[1].data.includes(Buffer.from("mebx", "ascii")));
    assert.ok(entries[1].data.includes(Buffer.from(
      "com.apple.quicktime.still-image-time",
      "ascii"
    )));
    assert.ok(entries[1].data.includes(Buffer.from(IDENTIFIER, "ascii")));

    const eocdOffset = findEocd(built.buffer);
    assert.ok(eocdOffset > 0);
    const commentLength = built.buffer.readUInt16LE(eocdOffset + 20);
    const comment = built.buffer.subarray(
      eocdOffset + 22,
      eocdOffset + 22 + commentLength
    );
    const records = parseComment(comment);
    assert.deepStrictEqual(records, [
      {
        mediaType: 5,
        dataOffset: entries[0].dataOffset,
        dataLength: entries[0].size
      },
      {
        mediaType: 3,
        dataOffset: entries[1].dataOffset,
        dataLength: entries[1].size
      }
    ]);

    const movPath = path.join(workDir, "paired.mov");
    fs.writeFileSync(movPath, entries[1].data);
    const probe = JSON.parse(run(FFPROBE, [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_tag_string:format_tags",
      "-of", "json",
      movPath
    ], "检查 MOV 数据轨"));
    assert.ok(probe.streams.some((stream) => (
      stream.codec_type === "data" && stream.codec_tag_string === "mebx"
    )));
    assert.strictEqual(
      probe.format.tags["com.apple.quicktime.content.identifier"],
      IDENTIFIER
    );

    assert.throws(
      () => livePhoto.attachAppleMakerNote(Buffer.from("not-jpeg"), IDENTIFIER),
      /JPEG|源图片/
    );
    assert.throws(
      () => livePhoto.injectStillImageTimeTrack(Buffer.from("not-mov")),
      /MOV/
    );
    assert.throws(
      () => livePhoto.normalizeContentIdentifier("not-a-uuid"),
      /配对编号/
    );

    console.log(
      "livp smoke: OK (jpeg-maker-note/mov-mebx/still-image-time/zip-store/comment/hash)"
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`livp smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
