/* eslint-disable no-console */

const assert = require("assert");
const http = require("http");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.AI_IMAGE_MODE = "generations";
process.env.AI_IMAGE_API_KEY = "smoke-image-key";
process.env.AI_IMAGE_RETRY_ENABLED = "false";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;
const wxCloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");

assert.ok(test, "云函数没有暴露生图分流测试接口");
assert.strictEqual(test.defaultImageMode, "edits");
assert.strictEqual(
  test.hasImageEditAssets({ mainFileID: "main-file" }),
  true,
  "主图必须被识别为编辑素材"
);
assert.strictEqual(
  test.hasImageEditAssets({ faceFileIDs: ["", "face-file"] }),
  true,
  "参考人脸必须被识别为编辑素材"
);
assert.strictEqual(
  test.hasImageEditAssets({ prompt: "纯文字测试" }),
  false,
  "纯文字请求不能误判为编辑素材"
);

assert.strictEqual(
  test.resolveGenerationMode(
    {
      mode: "generations",
      mainFileID: "main-file",
      maskFileID: "mask-file",
      faceFileIDs: ["face-file"]
    },
    { mode: "generations" }
  ),
  "edits",
  "带素材时不能被显式 generations 覆盖"
);
assert.strictEqual(
  test.resolveGenerationMode(
    { mode: "generations" },
    { mode: "generations" }
  ),
  "generations",
  "纯文字请求仍允许走 generations"
);

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
  const missing = await api.main(
    {
      action: "generate",
      requestId: "smoke-routing-missing-mask",
      payload: {
        mode: "generations",
        prompt: "人脸替换测试",
        mainFileID: "main-file"
      }
    },
    { OPENID: "smoke-openid" }
  );
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.errorCode, "missing-edit-asset");
  assert.ok(
    String(missing.message || "").includes("主图和 mask"),
    "素材缺失时必须返回可读提示"
  );

  const originalDownloadFile = wxCloud.downloadFile;
  const originalEditEndpoint = process.env.AI_IMAGE_EDIT_ENDPOINT;
  const requests = [];
  wxCloud.downloadFile = async ({ fileID }) => ({
    fileContent: Buffer.from(`asset:${fileID}`)
  });

  try {
    await withServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          data: [{ b64_json: Buffer.from("smoke-result").toString("base64") }]
        }));
      });
    }, async (url) => {
      process.env.AI_IMAGE_EDIT_ENDPOINT = url;
      const imageConfig = test.resolveImageConfig({
        image: {
          mode: "edits",
          baseUrl: url,
          model: "smoke-edit-model",
          compatibilityMode: true,
          timeoutMs: 5000,
          retryEnabled: false,
          retryPreferenceVersion: 1
        }
      });
      const result = await test.requestImageEdits(
        {
          mainFileID: "main-file",
          maskFileID: "mask-file",
          faceFileIDs: ["face-file"],
          prompt: "只改红圈",
          size: "1024x1024"
        },
        "smoke-image-key",
        "smoke-routing-multipart",
        imageConfig,
        {},
        "smoke-user"
      );
      assert.ok(result.data && result.data[0] && result.data[0].b64_json);
    });
  } finally {
    wxCloud.downloadFile = originalDownloadFile;
    if (originalEditEndpoint === undefined) {
      delete process.env.AI_IMAGE_EDIT_ENDPOINT;
    } else {
      process.env.AI_IMAGE_EDIT_ENDPOINT = originalEditEndpoint;
    }
  }

  assert.strictEqual(requests.length, 1, "编辑请求只能发送一次");
  assert.strictEqual(requests[0].method, "POST");
  assert.ok(
    String(requests[0].headers["content-type"] || "").includes("multipart/form-data"),
    "编辑请求必须是 multipart/form-data"
  );
  assert.ok(requests[0].body.includes('name="image"; filename="main.png"'));
  assert.ok(requests[0].body.includes('name="mask"; filename="mask.png"'));
  assert.ok(requests[0].body.includes('name="image[]"; filename="face-1.png"'));

  console.log("image edit routing smoke: OK");
  console.log(JSON.stringify({
    forcedMode: test.resolveGenerationMode(
      { mode: "generations", mainFileID: "main-file" },
      { mode: "generations" }
    ),
    missingCode: missing.errorCode,
    multipartRequests: requests.length
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
