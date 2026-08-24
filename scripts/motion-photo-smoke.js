/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const motionPhoto = require("../cloudfunctions/api/lib/android-motion-photo");

process.env.WECHAT_MINIAPP_TEST = "1";
const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function buildTestPng(width = 1600, height = 900) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      png.data[offset] = x % 256;
      png.data[offset + 1] = y % 256;
      png.data[offset + 2] = 160;
      png.data[offset + 3] = x < width / 2 ? 180 : 255;
    }
  }
  return PNG.sync.write(png);
}

function buildTestMp4() {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write("ftyp", 4, "ascii");
  ftyp.write("isom", 8, "ascii");
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write("isom", 16, "ascii");
  ftyp.write("mp42", 20, "ascii");
  const mdatPayload = Buffer.from("motion-photo-smoke-video-payload");
  const mdat = Buffer.alloc(8 + mdatPayload.length);
  mdat.writeUInt32BE(mdat.length, 0);
  mdat.write("mdat", 4, "ascii");
  mdatPayload.copy(mdat, 8);
  return Buffer.concat([ftyp, mdat]);
}

function main() {
  const normalized = motionPhoto.normalizeSourceToJpeg(buildTestPng());
  assert.strictEqual(normalized.width, 1280);
  assert.strictEqual(normalized.height, 720);
  assert.strictEqual(normalized.quality, 95);
  assert.strictEqual(normalized.buffer[0], 0xff);
  assert.strictEqual(normalized.buffer[1], 0xd8);
  assert.strictEqual(normalized.buffer[normalized.buffer.length - 2], 0xff);
  assert.strictEqual(normalized.buffer[normalized.buffer.length - 1], 0xd9);

  const video = buildTestMp4();
  const videoHash = sha256(video);
  const built = motionPhoto.buildAndroidMotionPhoto(
    normalized.buffer,
    video,
    { presentationTimestampUs: 33008 }
  );
  assert.strictEqual(built.format, "android-motion-photo");
  assert.strictEqual(built.videoLengthBytes, video.length);
  assert.strictEqual(built.sourceJpegLengthBytes, normalized.buffer.length);
  assert.strictEqual(built.buffer[0], 0xff);
  assert.strictEqual(built.buffer[1], 0xd8);
  assert.strictEqual(built.buffer[built.jpegLengthBytes - 2], 0xff);
  assert.strictEqual(built.buffer[built.jpegLengthBytes - 1], 0xd9);
  assert.strictEqual(
    built.buffer.subarray(built.jpegLengthBytes + 4, built.jpegLengthBytes + 8)
      .toString("ascii"),
    "ftyp"
  );
  const extractedVideo = built.buffer.subarray(built.jpegLengthBytes);
  assert.strictEqual(sha256(extractedVideo), videoHash);

  const stillText = built.buffer.subarray(0, built.jpegLengthBytes).toString("utf8");
  [
    'GCamera:MotionPhoto="1"',
    'GCamera:MotionPhotoVersion="1"',
    'GCamera:MicroVideo="1"',
    'GCamera:MicroVideoVersion="1"',
    `GCamera:MicroVideoOffset="${video.length}"`,
    'GCamera:MotionPhotoPresentationTimestampUs="33008"',
    `Item:Semantic="Primary" Item:Length="${normalized.buffer.length}"`,
    `Item:Semantic="MotionPhoto" Item:Length="${video.length}"`
  ].forEach((value) => {
    assert.ok(stillText.includes(value), `缺少 XMP 字段：${value}`);
  });

  assert.throws(
    () => motionPhoto.buildAndroidMotionPhoto(Buffer.from("not-jpeg"), video),
    (error) => error && error.code === "MOTION_PHOTO_JPEG_INVALID"
  );
  assert.throws(
    () => motionPhoto.buildAndroidMotionPhoto(normalized.buffer, Buffer.from("not-mp4")),
    (error) => error && error.code === "MOTION_PHOTO_MP4_INVALID"
  );
  assert.throws(
    () => motionPhoto.normalizeSourceToJpeg(Buffer.alloc(
      motionPhoto.MAX_SOURCE_BYTES + 1
    )),
    (error) => error && error.code === "MOTION_PHOTO_SOURCE_TOO_LARGE"
  );
  const fakeWebp = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary");
  assert.throws(
    () => motionPhoto.normalizeSourceToJpeg(fakeWebp),
    (error) => error && error.code === "MOTION_PHOTO_WEBP_UNSUPPORTED"
  );

  const operation = {
    openid: "owner-a",
    requestId: "request-a",
    kind: "video",
    providerTaskId: "task-a",
    status: "succeeded"
  };
  assert.strictEqual(
    helpers.requireOwnedVideoOperation(
      operation,
      "owner-a",
      "request-a",
      "task-a"
    ),
    operation
  );
  assert.throws(
    () => helpers.requireOwnedVideoOperation(
      operation,
      "owner-b",
      "request-a",
      "task-a"
    ),
    (error) => error && error.code === "VIDEO_OPERATION_NOT_FOUND"
  );
  assert.throws(
    () => helpers.requireOwnedVideoOperation(
      operation,
      "owner-a",
      "request-a",
      "task-b"
    ),
    (error) => error && error.code === "VIDEO_TASK_OWNERSHIP_MISMATCH"
  );
  assert.strictEqual(
    helpers.androidMotionPhotoFileName("request-a", "task-a"),
    helpers.androidMotionPhotoFileName("request-a", "task-a")
  );
  assert.notStrictEqual(
    helpers.androidMotionPhotoFileName("request-a", "task-a"),
    helpers.androidMotionPhotoFileName("request-a", "task-b")
  );

  console.log("motion-photo smoke: OK (normalize/xmp/mp4/hash/limits/ownership/idempotency)");
}

main();
