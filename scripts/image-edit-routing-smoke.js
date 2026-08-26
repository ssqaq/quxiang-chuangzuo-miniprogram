/* eslint-disable no-console */

const assert = require("assert");
const http = require("http");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.AI_IMAGE_MODE = "generations";
process.env.AI_IMAGE_API_KEY = "smoke-image-key";
process.env.AI_IMAGE_RETRY_ENABLED = "false";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;
const wxCloud = require("../cloudfunctions/api/node_modules/wx-server-sdk");

function pngFixture(width = 100, height = 80) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 240;
    png.data[index + 1] = 240;
    png.data[index + 2] = 240;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function alphaAt(png, x, y) {
  return png.data[(y * png.width + x) * 4 + 3];
}

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

const maskMainFixture = pngFixture(100, 80);
assert.deepStrictEqual(
  test.readImageDimensions(maskMainFixture),
  { width: 100, height: 80, pixels: 8000, format: "png" }
);
const singleFaceMask = test.createFaceProtectionMask(maskMainFixture, [{
  x: 250,
  y: 200,
  width: 200,
  height: 300,
  confidence: 0.99
}]);
const decodedSingleFaceMask = PNG.sync.read(singleFaceMask.buffer);
assert.strictEqual(decodedSingleFaceMask.width, 100);
assert.strictEqual(decodedSingleFaceMask.height, 80);
assert.strictEqual(alphaAt(decodedSingleFaceMask, 0, 0), 0, "脸外必须透明，允许修改");
assert.strictEqual(alphaAt(decodedSingleFaceMask, 35, 30), 255, "脸部必须不透明保护");
assert.strictEqual(singleFaceMask.faceCount, 1);

const multiFaceMask = test.createFaceProtectionMask(maskMainFixture, [{
  x: -20,
  y: -20,
  width: 180,
  height: 180
}, {
  x: 800,
  y: 760,
  width: 260,
  height: 260
}]);
const decodedMultiFaceMask = PNG.sync.read(multiFaceMask.buffer);
assert.strictEqual(multiFaceMask.faceCount, 2);
assert.strictEqual(alphaAt(decodedMultiFaceMask, 0, 0), 255, "贴边人脸必须裁剪后保护");
assert.strictEqual(alphaAt(decodedMultiFaceMask, 99, 79), 255, "右下贴边人脸必须保护");
multiFaceMask.rects.forEach((rect) => {
  assert.ok(rect.x >= 0 && rect.y >= 0);
  assert.ok(rect.x + rect.width <= 100);
  assert.ok(rect.y + rect.height <= 80);
});

const marginRect = test.faceProtectionRects([{
  x: 100,
  y: 100,
  width: 200,
  height: 300
}], 1000, 500)[0];
assert.deepStrictEqual(
  marginRect,
  { x: 56, y: 17, width: 288, height: 216 },
  "人脸框四周必须按 22% 安全边距扩展"
);

const originalMaskInvert = process.env.AI_MASK_INVERT;
process.env.AI_MASK_INVERT = "true";
const invertedFaceMask = PNG.sync.read(test.invertMask(singleFaceMask.buffer, "mask-invert-smoke"));
assert.strictEqual(alphaAt(invertedFaceMask, 0, 0), 255, "开启反转后脸外必须不透明");
assert.strictEqual(alphaAt(invertedFaceMask, 35, 30), 0, "开启反转后脸部必须透明");
if (originalMaskInvert === undefined) delete process.env.AI_MASK_INVERT;
else process.env.AI_MASK_INVERT = originalMaskInvert;

assert.throws(
  () => test.createFaceProtectionMask(maskMainFixture, []),
  (error) => error && error.code === "TENCENT_PIPELINE_FACE_NOT_FOUND",
  "没有人脸时必须 fail-closed，不能生成无保护请求"
);

const safeCapabilityProbe = test.buildImageEditCapabilityProbe({
  provider: "lingyun",
  baseUrl: "https://api.lingyunapi.xyz/v1",
  model: "gpt-image-2",
  apiKey: "must-not-be-returned"
});
assert.strictEqual(safeCapabilityProbe.configured, true);
assert.strictEqual(safeCapabilityProbe.requestFormat, "lingyun-json");
assert.strictEqual(safeCapabilityProbe.fields.mask, "mask.image_url");
assert.strictEqual(safeCapabilityProbe.liveVerified, false);
assert.strictEqual(safeCapabilityProbe.billingRisk, false);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(safeCapabilityProbe, "apiKey"),
  false,
  "管理员图片编辑检查不能返回 API Key"
);
assert.ok(safeCapabilityProbe.message.includes("不代表上游"));

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
      process.env.AI_IMAGE_EDIT_ENDPOINT = `${url}/v1/images/edits`;
      const imageConfig = test.resolveImageConfig({
        image: {
          mode: "edits",
          provider: "lingyun",
          baseUrl: `${url}/v1`,
          endpoint: `${url}/v1/images/edits`,
          model: "gpt-image-2",
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

      const pipelineResult = await test.requestTencentPipelineImageEdit(
        maskMainFixture,
        {
          prompt: "换衣服和背景",
          negativePrompt: "不要改脸",
          size: "1024x1024"
        },
        Object.assign({}, imageConfig, { apiKey: "smoke-image-key" }),
        {},
        "smoke-routing-multipart-tencent-pipeline",
        "smoke-user",
        singleFaceMask.buffer
      );
      assert.ok(pipelineResult.data && pipelineResult.data[0].b64_json);
    });
  } finally {
    wxCloud.downloadFile = originalDownloadFile;
    if (originalEditEndpoint === undefined) {
      delete process.env.AI_IMAGE_EDIT_ENDPOINT;
    } else {
      process.env.AI_IMAGE_EDIT_ENDPOINT = originalEditEndpoint;
    }
  }

  assert.strictEqual(requests.length, 2, "普通编辑和腾讯前置编辑必须各发送一次");
  assert.strictEqual(requests[0].method, "POST");
  assert.ok(
    String(requests[0].headers["content-type"] || "").includes("application/json"),
    "凌云编辑请求必须是 application/json"
  );
  const firstEditBody = JSON.parse(requests[0].body);
  assert.strictEqual(firstEditBody.model, "gpt-image-2");
  assert.strictEqual(firstEditBody.images.length, 2);
  assert.ok(firstEditBody.mask && firstEditBody.mask.image_url);
  assert.strictEqual(firstEditBody.output_format, "png");
  const firstTencentEditBody = JSON.parse(requests[1].body);
  assert.strictEqual(firstTencentEditBody.model, "gpt-image-2");
  assert.strictEqual(firstTencentEditBody.images.length, 1);
  assert.ok(firstTencentEditBody.mask && firstTencentEditBody.mask.image_url);
  assert.strictEqual(firstTencentEditBody.output_format, "png");
  assert.ok(!requests[1].body.includes("images/generations"));

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
  const lingyunPngFixture = pngFixture(32, 32);
  wxCloud.downloadFile = async () => ({
    fileContent: lingyunPngFixture
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
      process.env.AI_IMAGE_EDIT_ENDPOINT = `${url}/v1/images/edits`;
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
        lingyunPngFixture,
        {
          prompt: "换衣服和背景",
          negativePrompt: "不要改脸",
          size: "1024x1024"
        },
        Object.assign({}, imageConfig, { apiKey: "smoke-image-key" }),
        {},
        "smoke-routing-lingyun-tencent-pipeline",
        "smoke-user",
        test.createFaceProtectionMask(lingyunPngFixture, [{
          x: 200,
          y: 200,
          width: 300,
          height: 300
        }]).buffer
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
  assert.strictEqual(
    lingyunEditBody.response_format,
    "b64_json",
    "凌云默认必须直接返回 Base64，避免云函数二次下载临时 URL"
  );
  assert.strictEqual(lingyunEditBody.output_format, "png");

  const lingyunPipelineBody = JSON.parse(lingyunRequests[1].body);
  assert.strictEqual(lingyunPipelineBody.model, "gpt-image-2");
  assert.strictEqual(lingyunPipelineBody.images.length, 1);
  assert.ok(lingyunPipelineBody.mask.image_url.startsWith("data:image/png;base64,"));
  assert.ok(lingyunPipelineBody.prompt.includes("第一阶段只修改衣服、背景和整体光影"));
  assert.ok(lingyunPipelineBody.prompt.includes("脸部区域已经由 mask 保护"));

  await assert.rejects(
    () => test.requestTencentPipelineImageEdit(
      lingyunPngFixture,
      { prompt: "不带 mask 的错误请求" },
      {
        provider: "lingyun",
        model: "gpt-image-2",
        apiKey: "smoke-image-key",
        timeoutMs: 5000,
        retryEnabled: false
      },
      {},
      "smoke-routing-missing-protection-mask",
      "smoke-user",
      null
    ),
    (error) => error && error.code === "TENCENT_PIPELINE_MASK_REQUIRED",
    "腾讯前置编辑缺少真实保护 mask 时必须直接停止"
  );

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
      process.env.AI_IMAGE_EDIT_ENDPOINT = `${url}/v1/images/edits`;
      const imageConfig = test.resolveImageConfig({
        image: {
          mode: "edits",
          provider: "lingyun",
          baseUrl: `${url}/v1`,
          endpoint: `${url}/v1/images/edits`,
          model: "gpt-image-2",
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
  const capabilityBody = JSON.parse(capabilityRequests[0].body);
  assert.strictEqual(capabilityBody.model, "gpt-image-2");
  assert.strictEqual(capabilityBody.images.length, 2);
  assert.ok(capabilityBody.mask && capabilityBody.mask.image_url);
  assert.strictEqual(capabilityBody.output_format, "png");

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
