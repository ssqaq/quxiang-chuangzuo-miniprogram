const assert = require("assert");
const http = require("http");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.AI_MAX_RETRIES = "1";
process.env.AI_IMAGE_RETRY_ENABLED = "false";

const { getProtectionRects, normalizeCircle } = require("../utils/mask");
const { createMultipart } = require("../cloudfunctions/api/lib/multipart");
const cloud = require("../cloudfunctions/api/index.js");
const wxCloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const rawCircle = { x: 50, y: 40, width: 20, height: 16 };
  const circle = normalizeCircle(rawCircle, 100, 80);
  const rects = getProtectionRects(rawCircle, 100, 80);
  assert.deepStrictEqual(circle, {
    left: 40,
    top: 32,
    right: 60,
    bottom: 48,
    width: 20,
    height: 16
  });
  assert.strictEqual(rects.length, 4);

  const faces = cloud.__test.normalizeFaceDetections(null, JSON.stringify({
    faces: [
      { x: 0.32, y: 0.18, width: 0.26, height: 0.30, confidence: 0.96 },
      { x: 640, y: 220, width: 120, height: 160, confidence: 0.71 }
    ]
  }));
  assert.strictEqual(faces.length, 2);
  assert.strictEqual(faces[0].x, 320);
  assert.strictEqual(faces[0].width, 260);
  assert.strictEqual(faces[1].x, 640);

  const multipart = createMultipart(
    [{ name: "model", value: "demo" }],
    [{
      name: "image[]",
      filename: "main.png",
      mime: "image/png",
      buffer: Buffer.from("demo")
    }]
  );
  const multipartText = multipart.body.toString("utf8");
  assert.ok(multipartText.includes('name="model"'));
  assert.ok(multipartText.includes('name="image[]"; filename="main.png"'));
  assert.ok(multipartText.includes("demo"));

  const sourceMask = new PNG({ width: 1, height: 1 });
  sourceMask.data[3] = 0;
  process.env.AI_MASK_INVERT = "true";
  const invertedMask = cloud.__test.invertMask(
    PNG.sync.write(sourceMask),
    "smoke-mask"
  );
  process.env.AI_MASK_INVERT = "false";
  assert.strictEqual(PNG.sync.read(invertedMask).data[3], 255);

  let attempts = 0;
  await withServer((request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.statusCode = 503;
      response.end("busy");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  }, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "GET", headers: {} },
      null,
      { requestId: "smoke-retry", action: "smoke" }
    );
    assert.strictEqual(response.status, 200);
  });
  assert.strictEqual(attempts, 2);

  let imageAttempts = 0;
  await withServer((request, response) => {
    imageAttempts += 1;
    response.statusCode = 503;
    response.end("do not retry image");
  }, async (url) => {
    const response = await cloud.__test.requestWithRetry(
      url,
      { method: "POST", headers: {} },
      Buffer.from("image"),
      { requestId: "smoke-image", action: "generate", imageGeneration: true }
    );
    assert.strictEqual(response.status, 503);
  });
  assert.strictEqual(imageAttempts, 1);

  const originalDownloadFile = wxCloud.downloadFile;
  const editRequests = [];
  wxCloud.downloadFile = async ({ fileID }) => ({
    fileContent: Buffer.from(`asset:${fileID}`)
  });
  try {
    await withServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        editRequests.push({
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          data: [{ b64_json: Buffer.from("result-image").toString("base64") }]
        }));
      });
    }, async (url) => {
      const result = await cloud.__test.requestImageEdits({
        mainFileID: "main-file",
        maskFileID: "mask-file",
        faceFileIDs: ["face-file"],
        wardrobeFileIDs: ["wardrobe-file"],
        prompt: "只改红圈",
        size: "1024x1024"
      }, "test-key", "smoke-edits", {
        provider: "lingyun",
        model: "gpt-image-2",
        endpoint: `${url}/v1/images/edits`,
        timeoutMs: 30000,
        maxRetries: 0,
        retryEnabled: false,
        mode: "edits"
      });
      assert.ok(result.data && result.data[0] && result.data[0].b64_json);
    });
  } finally {
    wxCloud.downloadFile = originalDownloadFile;
  }
  assert.strictEqual(editRequests.length, 1);
  assert.ok(
    editRequests[0].headers["content-type"].includes("application/json")
  );
  const editBody = JSON.parse(editRequests[0].body);
  assert.strictEqual(editBody.model, "gpt-image-2");
  assert.strictEqual(editBody.images.length, 3);
  assert.ok(editBody.mask && editBody.mask.image_url);
  assert.strictEqual(editBody.output_format, "png");
  assert.ok(
    editBody.images.every((item) => (
      item && typeof item.image_url === "string"
      && item.image_url.startsWith("data:")
    ))
  );

  const unknown = await cloud.main({ action: "unknown" }, {});
  assert.strictEqual(unknown.errorCode, "unsupported-action");
  assert.ok(unknown.requestId);

  console.log("compat smoke: OK");
  console.log(JSON.stringify({
    maskRects: rects.length,
    jsonBytes: editRequests[0].body.length,
    safeRetryAttempts: attempts,
    imageRetryAttempts: imageAttempts,
    editRequests: editRequests.length,
    faceDetections: faces.length,
    requestId: unknown.requestId
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
