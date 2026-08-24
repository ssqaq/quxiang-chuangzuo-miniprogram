/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function operationId(openid, requestId) {
  return crypto.createHash("sha256")
    .update(`operation:${openid}:${requestId}`)
    .digest("hex")
    .slice(0, 32);
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
          rows.set(key, Object.assign({}, rows.get(key) || {}, clone(data)));
          return { stats: { updated: 1 } };
        }
      };
    }
  });
  return { rows, collection };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function main() {
  const workerBodies = [];
  const livp = Buffer.concat([
    Buffer.from("PK\u0003\u0004", "binary"),
    Buffer.alloc(96, 0x41),
    Buffer.from("1000LIVP", "ascii")
  ]);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      workerBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": livp.length,
        "X-Live-Photo-Validation": "ok",
        "X-Live-Photo-Content-Identifier": workerBodies.at(-1).contentIdentifier,
        "X-Live-Photo-Photo-Sha256": "A".repeat(64),
        "X-Live-Photo-Video-Sha256": "B".repeat(64),
        "X-Live-Photo-Livp-Sha256": "C".repeat(64)
      });
      res.end(livp);
    });
  });
  const port = await listen(server);

  process.env.WECHAT_MINIAPP_TEST = "1";
  process.env.APPLE_LIVE_PHOTO_WORKER_URL = `http://127.0.0.1:${port}/v1/apple-live-photo`;
  process.env.APPLE_LIVE_PHOTO_WORKER_TOKEN = "livp-smoke-token";
  const api = require("../cloudfunctions/api/index.js");
  const helpers = api.__test;
  const cloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");
  const db = helpers.getTestDatabase();

  const originalCollection = db.collection;
  const originalRunTransaction = db.runTransaction;
  const originalGetTempFileURL = cloud.getTempFileURL;
  const originalUploadFile = cloud.uploadFile;
  const store = createStore();
  const openid = "apple-owner";
  const requestId = "apple-request";
  const taskId = "apple-task";
  const sourceFileID = "cloud://apple/source.jpg";
  const videoFileID = "cloud://apple/video.mp4";
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
  let uploadedPath = "";
  let uploadedBuffer = null;
  let tempUrlCount = 0;
  db.collection = store.collection;
  db.runTransaction = async (callback) => callback({ collection: store.collection });
  cloud.getTempFileURL = async ({ fileList }) => {
    tempUrlCount += 1;
    return {
      fileList: fileList.map((fileID) => ({
        fileID,
        status: 0,
        tempFileURL: `https://temp.invalid/${encodeURIComponent(fileID)}`
      }))
    };
  };
  cloud.uploadFile = async ({ cloudPath, fileContent }) => {
    uploadCount += 1;
    uploadedPath = cloudPath;
    uploadedBuffer = Buffer.from(fileContent);
    return { fileID: `cloud://apple-output/${cloudPath}` };
  };

  try {
    const first = await api.main({
      action: "buildAppleLivePhoto",
      requestId,
      taskId
    }, { OPENID: openid });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.format, "apple-livp");
    assert.ok(first.fileName.endsWith(".livp"));
    assert.ok(first.livePhotoFileID.startsWith("cloud://apple-output/"));
    assert.ok(first.tempFileURL.startsWith("https://temp.invalid/"));
    assert.strictEqual(uploadCount, 1);
    assert.strictEqual(workerBodies.length, 1);
    assert.strictEqual(tempUrlCount, 3);
    assert.strictEqual(uploadedBuffer.compare(livp), 0);
    assert.match(
      uploadedPath,
      /^photo-to-video-live-photos\/[a-f0-9]{24}\/[a-f0-9]{32}\.livp$/
    );
    assert.strictEqual(workerBodies[0].imageUrl.includes(encodeURIComponent(sourceFileID)), true);
    assert.strictEqual(workerBodies[0].videoUrl.includes(encodeURIComponent(videoFileID)), true);
    assert.match(
      workerBodies[0].contentIdentifier,
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/
    );

    const second = await api.main({
      action: "buildAppleLivePhoto",
      requestId,
      taskId
    }, { OPENID: openid });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(second.livePhotoFileID, first.livePhotoFileID);
    assert.strictEqual(uploadCount, 1);
    assert.strictEqual(workerBodies.length, 1);
    assert.strictEqual(tempUrlCount, 4);

    const forbidden = await api.main({
      action: "buildAppleLivePhoto",
      requestId,
      taskId
    }, { OPENID: "another-owner" });
    assert.strictEqual(forbidden.ok, false);
    assert.strictEqual(forbidden.errorCode, "VIDEO_OPERATION_NOT_FOUND");

    delete process.env.APPLE_LIVE_PHOTO_WORKER_URL;
    delete process.env.APPLE_LIVE_PHOTO_WORKER_TOKEN;
    const unconfiguredRequestId = "apple-unconfigured";
    const unconfiguredOperation = Object.assign({}, store.rows.get(operationKey), {
      requestId: unconfiguredRequestId
    });
    delete unconfiguredOperation.appleLivePhoto;
    store.rows.set(
      `generation_operations/${operationId(openid, unconfiguredRequestId)}`,
      unconfiguredOperation
    );
    const unconfigured = await api.main({
      action: "buildAppleLivePhoto",
      requestId: unconfiguredRequestId,
      taskId
    }, { OPENID: openid });
    assert.strictEqual(unconfigured.ok, false);
    assert.strictEqual(
      unconfigured.errorCode,
      "APPLE_LIVE_PHOTO_WORKER_NOT_CONFIGURED"
    );

    console.log(
      "livp api smoke: OK (ownership/worker/fixed-path/upload/temp-link/idempotency)"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.collection = originalCollection;
    db.runTransaction = originalRunTransaction;
    cloud.getTempFileURL = originalGetTempFileURL;
    cloud.uploadFile = originalUploadFile;
  }
}

main().catch((error) => {
  console.error(`livp api smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
