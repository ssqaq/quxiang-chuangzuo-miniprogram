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
assert.strictEqual(
  test.classifyImageEditResponse({
    status: 400,
    json: {
      error: {
        code: "INVALID_IMAGE_EDIT",
        message: "mask compositing is disabled because the VPS does not process image pixels"
      }
    }
  }).code,
  "image-edit-unsupported",
  "mask compositing disabled 必须归类为上游能力不支持"
);
assert.strictEqual(
  test.classifyImageEditResponse({
    status: 404,
    json: { error: { message: "images/edits endpoint not found" } }
  }).code,
  "image-edit-endpoint-invalid",
  "编辑路径不存在必须归类为 endpoint 错误"
);
assert.strictEqual(
  test.classifyImageEditResponse({
    status: 400,
    json: { error: { message: "model gpt-image-2 does not support image edits" } }
  }).code,
  "image-edit-model-unsupported",
  "模型不支持 edits 必须单独归类"
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

  assert.strictEqual(
    test.isLingyunImageProvider({ provider: "lingyun" }),
    true,
    "凌云 provider 必须走 JSON 图片编辑协议"
  );
  assert.strictEqual(
    test.isLingyunImageProvider({ baseUrl: "https://api.lingyunapi.xyz/v1" }),
    true,
    "凌云域名必须自动识别为 JSON 图片编辑协议"
  );
  assert.strictEqual(
    test.isLingyunImageProvider({ provider: "openai-compatible" }),
    false,
    "其他 OpenAI-compatible provider 必须保留 multipart 协议"
  );

  const lingyunRequests = [];
  const originalLingyunEditEndpoint = process.env.AI_IMAGE_EDIT_ENDPOINT;
  const pngFixture = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l9F2TQAAAABJRU5ErkJggg==",
    "base64"
  );
  wxCloud.downloadFile = async () => ({
    fileContent: pngFixture
  });
  try {
    await withServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        lingyunRequests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          data: [{ b64_json: Buffer.from("lingyun-result").toString("base64") }]
        }));
      });
    }, async (url) => {
      process.env.AI_IMAGE_EDIT_ENDPOINT = url;
      const imageConfig = test.resolveImageConfig({
        image: {
          provider: "lingyun",
          mode: "edits",
          baseUrl: "https://api.lingyunapi.xyz/v1",
          model: "gpt-image-2",
          compatibilityMode: false,
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
          prompt: "只修改衣服",
          size: "1024x1024"
        },
        "smoke-image-key",
        "smoke-routing-lingyun-json",
        imageConfig,
        {},
        "smoke-user"
      );
      assert.ok(result.data && result.data[0] && result.data[0].b64_json);

      const pipelineResult = await test.requestTencentPipelineImageEdit(
        pngFixture,
        {
          prompt: "换衣服和背景",
          negativePrompt: "不要改脸",
          size: "1024x1024"
        },
        Object.assign({}, imageConfig, { apiKey: "smoke-image-key" }),
        {},
        "smoke-routing-lingyun-tencent-pipeline",
        "smoke-user"
      );
      assert.ok(
        pipelineResult.data
          && pipelineResult.data[0]
          && pipelineResult.data[0].b64_json
      );
    });
  } finally {
    wxCloud.downloadFile = originalDownloadFile;
    if (originalLingyunEditEndpoint === undefined) {
      delete process.env.AI_IMAGE_EDIT_ENDPOINT;
    } else {
      process.env.AI_IMAGE_EDIT_ENDPOINT = originalLingyunEditEndpoint;
    }
  }

  assert.strictEqual(lingyunRequests.length, 2, "凌云普通编辑和腾讯前置编辑各请求一次");
  lingyunRequests.forEach((request) => {
    assert.strictEqual(request.method, "POST");
    assert.ok(!String(request.path).includes("generations"));
    assert.ok(
      String(request.headers["content-type"] || "").includes("application/json"),
      "凌云图片编辑必须发送 application/json"
    );
  });
  const lingyunEditBody = JSON.parse(lingyunRequests[0].body);
  assert.strictEqual(lingyunEditBody.model, "gpt-image-2");
  assert.strictEqual(lingyunEditBody.images.length, 2);
  assert.ok(lingyunEditBody.images[0].image_url.startsWith("data:image/png;base64,"));
  assert.ok(lingyunEditBody.images[1].image_url.startsWith("data:image/png;base64,"));
  assert.ok(lingyunEditBody.mask.image_url.startsWith("data:image/png;base64,"));
  assert.strictEqual(lingyunEditBody.response_format, "url");
  assert.strictEqual(lingyunEditBody.output_format, "png");

  const lingyunPipelineBody = JSON.parse(lingyunRequests[1].body);
  assert.strictEqual(lingyunPipelineBody.model, "gpt-image-2");
  assert.strictEqual(lingyunPipelineBody.images.length, 1);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(lingyunPipelineBody, "mask"),
    false,
    "腾讯流程第一阶段没有 mask 时不能伪造 mask"
  );
  assert.ok(lingyunPipelineBody.prompt.includes("第一阶段只修改衣服、背景和整体光影"));

  const capabilityRequests = [];
  const originalEditEndpointAfterSuccess = process.env.AI_IMAGE_EDIT_ENDPOINT;
  wxCloud.downloadFile = async ({ fileID }) => ({
    fileContent: Buffer.from(`asset:${fileID}`)
  });
  try {
    await withServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        capabilityRequests.push({
          method: request.method,
          path: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          error: {
            code: "INVALID_IMAGE_EDIT",
            message: "mask compositing is disabled because the VPS does not process image pixels"
          }
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
          retryEnabled: true,
          maxRetries: 2,
          retryPreferenceVersion: 1
        }
      });
      let failure = null;
      try {
        await test.requestImageEdits(
          {
            mainFileID: "main-file",
            maskFileID: "mask-file",
            faceFileIDs: ["face-file"],
            prompt: "只改红圈",
            size: "1024x1024"
          },
          "smoke-image-key",
          "smoke-routing-capability-error",
          imageConfig,
          {},
          "smoke-user"
        );
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, "上游 mask 能力错误必须向上抛出");
      assert.strictEqual(failure.code, "image-edit-unsupported");
      assert.strictEqual(failure.retryable, false);
      assert.ok(String(failure.message).includes("不支持 mask 合成"));
    });
  } finally {
    wxCloud.downloadFile = originalDownloadFile;
    if (originalEditEndpointAfterSuccess === undefined) {
      delete process.env.AI_IMAGE_EDIT_ENDPOINT;
    } else {
      process.env.AI_IMAGE_EDIT_ENDPOINT = originalEditEndpointAfterSuccess;
    }
  }
  assert.strictEqual(capabilityRequests.length, 1, "能力不支持错误不能重试");
  assert.strictEqual(capabilityRequests[0].method, "POST");
  assert.ok(!String(capabilityRequests[0].path).includes("generations"));
  assert.ok(capabilityRequests[0].body.includes('name="image"; filename="main.png"'));
  assert.ok(capabilityRequests[0].body.includes('name="mask"; filename="mask.png"'));
  assert.ok(capabilityRequests[0].body.includes('name="image[]"; filename="face-1.png"'));

  console.log("image edit routing smoke: OK");
  console.log(JSON.stringify({
    forcedMode: test.resolveGenerationMode(
      { mode: "generations", mainFileID: "main-file" },
      { mode: "generations" }
    ),
    missingCode: missing.errorCode,
    multipartRequests: requests.length,
    lingyunJsonRequests: lingyunRequests.length,
    capabilityErrorCode: "image-edit-unsupported",
    capabilityRequests: capabilityRequests.length
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
