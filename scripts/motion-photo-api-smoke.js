/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const motionPhoto = require("../cloudfunctions/api/lib/android-motion-photo");

process.env.WECHAT_MINIAPP_TEST = "1";
const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;
const cloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");
const db = helpers.getTestDatabase();

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function operationId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`operation:${openid}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
}

function buildMp4() {
  const output = Buffer.alloc(36);
  output.writeUInt32BE(24, 0);
  output.write("ftyp", 4, "ascii");
  output.write("isom", 8, "ascii");
  output.writeUInt32BE(0x200, 12);
  output.write("isom", 16, "ascii");
  output.write("mp42", 20, "ascii");
  output.writeUInt32BE(12, 24);
  output.write("mdat", 28, "ascii");
  output.writeUInt32BE(0x12345678, 32);
  return output;
}

function createStore() {
  const rows = new Map();
  const collection = (name) => ({
    doc(id) {
      const key = `${name}/${id}`;
      return {
        async get() {
          if (!rows.has(key)) {
            const error = new Error("document not exist");
            error.code = "DATABASE_DOCUMENT_NOT_EXIST";
            throw error;
          }
          return { data: clone(rows.get(key)) };
        },
        async set({ data }) {
          rows.set(key, clone(data));
          return { stats: { updated: 1 } };
        },
        async update({ data }) {
          const previous = rows.get(key) || {};
          rows.set(key, Object.assign({}, previous, clone(data)));
          return { stats: { updated: 1 } };
        }
      };
    }
  });
  return { rows, collection };
}

async function main() {
  const originalCollection = db.collection;
  const originalRunTransaction = db.runTransaction;
  const originalDownloadFile = cloud.downloadFile;
  const originalUploadFile = cloud.uploadFile;
  const store = createStore();
  const openid = "motion-owner";
  const requestId = "motion-request";
  const taskId = "motion-task";
  const sourceFileID = "cloud://motion/source.jpg";
  const videoFileID = "cloud://motion/video.mp4";

  const png = new PNG({ width: 4, height: 3 });
  png.data.fill(220);
  const jpeg = motionPhoto.normalizeSourceToJpeg(PNG.sync.write(png)).buffer;
  const mp4 = buildMp4();
  const operationKey = `generation_operations/${operationId(openid, requestId)}`;
  store.rows.set(operationKey, {
    openid,
    requestId,
    kind: "video",
    providerTaskId: taskId,
    status: "succeeded",
    sourceImageFileID: sourceFileID,
    result: {
      taskId,
      videoFileID
    }
  });

  let uploadCount = 0;
  let downloadCount = 0;
  let uploadedBuffer = null;
  db.collection = store.collection;
  db.runTransaction = async (callback) => callback({ collection: store.collection });
  cloud.downloadFile = async ({ fileID }) => {
    downloadCount += 1;
    if (fileID === sourceFileID) return { fileContent: jpeg };
    if (fileID === videoFileID) return { fileContent: mp4 };
    throw new Error(`unexpected fileID: ${fileID}`);
  };
  cloud.uploadFile = async ({ cloudPath, fileContent }) => {
    uploadCount += 1;
    uploadedBuffer = Buffer.from(fileContent);
    return { fileID: `cloud://motion-output/${cloudPath}` };
  };

  try {
    const first = await api.main({
      action: "buildAndroidMotionPhoto",
      requestId,
      taskId
    }, { OPENID: openid });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.format, "android-motion-photo");
    assert.ok(first.fileName.endsWith("-MP.jpg"));
    assert.strictEqual(first.videoLengthBytes, mp4.length);
    assert.strictEqual(uploadCount, 1);
    assert.strictEqual(downloadCount, 2);
    assert.ok(uploadedBuffer);
    assert.strictEqual(
      uploadedBuffer.subarray(uploadedBuffer.length - mp4.length).compare(mp4),
      0,
      "上传文件尾部 MP4 必须与原视频完全一致"
    );

    const second = await api.main({
      action: "buildAndroidMotionPhoto",
      requestId,
      taskId
    }, { OPENID: openid });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(second.motionPhotoFileID, first.motionPhotoFileID);
    assert.strictEqual(uploadCount, 1, "重复调用不能再次上传新文件");
    assert.strictEqual(downloadCount, 2, "重复调用不能再次下载源文件");

    const forbidden = await api.main({
      action: "buildAndroidMotionPhoto",
      requestId,
      taskId
    }, { OPENID: "another-owner" });
    assert.strictEqual(forbidden.ok, false);
    assert.strictEqual(forbidden.errorCode, "VIDEO_OPERATION_NOT_FOUND");
    assert.strictEqual(uploadCount, 1);
    assert.strictEqual(downloadCount, 2);

    console.log("motion-photo api smoke: OK (ownership/fixed-path/upload/idempotency)");
  } finally {
    db.collection = originalCollection;
    db.runTransaction = originalRunTransaction;
    cloud.downloadFile = originalDownloadFile;
    cloud.uploadFile = originalUploadFile;
  }
}

main().catch((error) => {
  console.error(`motion-photo api smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
