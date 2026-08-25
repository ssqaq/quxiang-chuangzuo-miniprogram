/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.deepStrictEqual(test.validateTransferMediaUrl("https://cdn.example.com/a.mp4"), {
  ok: true,
  url: "https://cdn.example.com/a.mp4"
});
assert.strictEqual(test.validateTransferMediaUrl("http://cdn.example.com/a.mp4").ok, false);
assert.strictEqual(test.validateTransferMediaUrl("https://localhost/a.mp4").ok, false);
assert.strictEqual(test.validateTransferMediaUrl("https://192.168.1.2/a.mp4").ok, false);
assert.strictEqual(test.validateTransferMediaUrl("https://user:pass@cdn.example.com/a.mp4").ok, false);

assert.deepStrictEqual(
  test.transferMediaTypeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  { kind: "image", mimeType: "image/jpeg", extension: "jpg" }
);
assert.deepStrictEqual(
  test.transferMediaTypeFromBuffer(Buffer.from("00000018667479706D703432", "hex")),
  { kind: "video", mimeType: "video/mp4", extension: "mp4" }
);
assert.strictEqual(test.normalizeWatermarkTransferKind("IMAGE"), "image");
assert.strictEqual(test.normalizeWatermarkTransferKind("audio"), "");
assert.ok(test.isWatermarkTransferCleanupTrigger({
  triggerName: "watermark-transfer-temp-cleanup"
}));

function createStore() {
  const rows = new Map();
  const command = {
    lte(value) {
      return { operator: "lte", value };
    }
  };
  function ref(id) {
    return {
      async get() {
        const row = rows.get(id);
        if (!row) {
          const error = new Error("document not found");
          error.code = "DOCUMENT_NOT_FOUND";
          throw error;
        }
        return { data: { ...row } };
      },
      async set({ data }) {
        rows.set(id, { _id: id, ...data });
      },
      async update({ data }) {
        const row = rows.get(id);
        if (!row) throw new Error("document not found");
        rows.set(id, { ...row, ...data });
      },
      async remove() {
        rows.delete(id);
      }
    };
  }
  return {
    command,
    rows,
    collection() {
      return {
        doc: ref,
        where(filter) {
          return {
            limit(limit) {
              return {
                async get() {
                  const cutoff = filter.cleanupAfter && filter.cleanupAfter.value;
                  const data = Array.from(rows.values())
                    .filter((row) => !cutoff || new Date(row.cleanupAfter).getTime() <= cutoff.getTime())
                    .slice(0, limit);
                  return { data };
                }
              };
            }
          };
        }
      };
    }
  };
}

async function main() {
  const store = createStore();
  const uploaded = [];
  const deleted = [];
  let deleteMode = "ok";
  const fakeCloud = {
    async uploadFile(options) {
      uploaded.push(options);
      return { fileID: `cloud://${options.cloudPath}` };
    },
    async deleteFile({ fileList }) {
      if (deleteMode === "failed") {
        throw new Error("CloudBase delete temporarily failed");
      }
      if (deleteMode === "missing") {
        throw new Error("file not found");
      }
      fileList.forEach((fileID) => deleted.push(fileID));
      return {
        fileList: fileList.map((fileID) => ({ fileID, status: 0 }))
      };
    }
  };
  const image = await test.transferMedia({
    action: "transferMedia",
    url: "https://cdn.example.com/a.jpg",
    kind: "image",
    requestId: "transfer-image-smoke"
  }, { OPENID: "smoke-user" }, {
    db: store,
    cloud: fakeCloud,
    requestTransferMedia: async () => ({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      contentType: "image/jpeg"
    })
  });
  assert.strictEqual(image.ok, true);
  assert.strictEqual(image.kind, "image");
  assert.strictEqual(image.mimeType, "image/jpeg");
  assert.strictEqual(uploaded.length, 1);
  const imageRow = Array.from(store.rows.values())[0];
  assert.strictEqual(imageRow.fileID, image.fileID);
  assert.strictEqual(imageRow.ownerOpenId, "smoke-user");
  assert.strictEqual(imageRow.status, "pending");

  const forbidden = await test.releaseTransferMedia({
    transferId: image.transferId,
    fileID: image.fileID
  }, { OPENID: "other-user" }, { db: store, cloud: fakeCloud });
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "WATERMARK_TRANSFER_RELEASE_FORBIDDEN");

  const released = await test.releaseTransferMedia({
    transferId: image.transferId,
    fileID: image.fileID
  }, { OPENID: "smoke-user" }, { db: store, cloud: fakeCloud });
  assert.strictEqual(released.ok, true);
  assert.strictEqual(released.released, true);
  assert.strictEqual(store.rows.size, 0);
  assert.deepStrictEqual(deleted, [image.fileID]);

  const video = await test.transferMedia({
    action: "transferMedia",
    url: "https://cdn.example.com/a.mp4",
    kind: "video",
    fileName: "demo.mp4",
    mimeType: "video/mp4",
    requestId: "transfer-video-smoke"
  }, { OPENID: "smoke-user" }, {
    db: store,
    cloud: fakeCloud,
    requestTransferMedia: async () => ({
      buffer: Buffer.from("00000018667479706D703432", "hex"),
      contentType: "video/mp4"
    })
  });
  assert.strictEqual(video.ok, true);
  assert.strictEqual(video.kind, "video");
  assert.strictEqual(video.mimeType, "video/mp4");
  assert.strictEqual(video.sizeBytes, 12);
  assert.ok(video.fileID.endsWith(".mp4"));

  deleteMode = "failed";
  const releasePending = await test.releaseTransferMedia({
    transferId: video.transferId,
    fileID: video.fileID
  }, { OPENID: "smoke-user" }, { db: store, cloud: fakeCloud });
  assert.strictEqual(releasePending.ok, true);
  assert.strictEqual(releasePending.released, false);
  assert.strictEqual(releasePending.pendingCleanup, true);
  const videoRow = Array.from(store.rows.values()).find(
    (row) => row.transferId === video.transferId
  );
  assert.strictEqual(videoRow.status, "failed");
  assert.strictEqual(videoRow.attempts, 1);
  deleteMode = "ok";
  const releaseVideo = await test.releaseTransferMedia({
    transferId: video.transferId,
    fileID: video.fileID
  }, { OPENID: "smoke-user" }, { db: store, cloud: fakeCloud });
  assert.strictEqual(releaseVideo.released, true);

  const mismatch = await test.transferMedia({
    action: "transferMedia",
    url: "https://cdn.example.com/a.mp4",
    kind: "video",
    requestId: "transfer-mismatch-smoke"
  }, { OPENID: "smoke-user" }, {
    db: store,
    cloud: fakeCloud,
    requestTransferMedia: async () => ({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      contentType: "image/jpeg"
    })
  });
  assert.strictEqual(mismatch.ok, false);
  assert.strictEqual(mismatch.errorCode, "WATERMARK_TRANSFER_MEDIA_TYPE_INVALID");

  const invalidUrl = await test.transferMedia({
    action: "transferMedia",
    url: "http://cdn.example.com/a.mp4",
    kind: "video",
    requestId: "transfer-invalid-url-smoke"
  }, { OPENID: "smoke-user" }, { db: store, cloud: fakeCloud });
  assert.strictEqual(invalidUrl.ok, false);
  assert.strictEqual(invalidUrl.errorCode, "WATERMARK_TRANSFER_URL_INVALID");

  const tooLarge = await test.transferMedia({
    action: "transferMedia",
    url: "https://cdn.example.com/large.mp4",
    kind: "video",
    requestId: "transfer-too-large-smoke"
  }, { OPENID: "smoke-user" }, {
    db: store,
    cloud: fakeCloud,
    requestTransferMedia: async () => {
      const error = new Error("视频文件超过大小限制。");
      error.code = "WATERMARK_TRANSFER_TOO_LARGE";
      error.retryable = false;
      throw error;
    }
  });
  assert.strictEqual(tooLarge.ok, false);
  assert.strictEqual(tooLarge.errorCode, "WATERMARK_TRANSFER_TOO_LARGE");

  const expiredID = "expired-transfer-doc";
  const expiredFileID = "cloud://watermark-transfer/expired.mp4";
  store.rows.set(expiredID, {
    _id: expiredID,
    transferId: "expired-transfer",
    fileID: expiredFileID,
    ownerOpenId: "smoke-user",
    cleanupAfter: new Date("2026-08-25T08:00:00.000Z"),
    attempts: 0,
    status: "pending"
  });
  const cleanup = await test.cleanupWatermarkTransferTempAssets(
    new Date("2026-08-25T10:00:00.000Z"),
    { db: store, cloud: fakeCloud }
  );
  assert.strictEqual(cleanup.ok, true);
  assert.strictEqual(cleanup.removed, 1);
  assert.strictEqual(store.rows.has(expiredID), false);
  assert.ok(deleted.includes(expiredFileID));

  const missingID = "missing-transfer-doc";
  const missingFileID = "cloud://watermark-transfer/missing.mp4";
  store.rows.set(missingID, {
    _id: missingID,
    transferId: "missing-transfer",
    fileID: missingFileID,
    ownerOpenId: "smoke-user",
    cleanupAfter: new Date("2026-08-25T08:00:00.000Z"),
    attempts: 2,
    status: "failed"
  });
  deleteMode = "missing";
  const missingCleanup = await test.cleanupWatermarkTransferTempAssets(
    new Date("2026-08-25T10:00:00.000Z"),
    { db: store, cloud: fakeCloud }
  );
  assert.strictEqual(missingCleanup.ok, true);
  assert.strictEqual(missingCleanup.removed, 1);
  assert.strictEqual(store.rows.has(missingID), false);

  console.log("watermark transfer smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
