const assert = require("assert");
const http = require("http");
const { PNG } = require("pngjs");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.AI_IMAGE_RETRY_ENABLED = "false";
process.env.AI_MASK_INVERT = "false";

const api = require("../index.js");
const test = api.__test;

function pngFixture(width = 8, height = 8) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 80;
    png.data[index + 1] = 120;
    png.data[index + 2] = 160;
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

function providerConfig(endpoint) {
  return test.resolveImageConfig({
    image: {
      provider: "xingju",
      baseUrl: endpoint.replace(/\/images\/edits$/, ""),
      endpoint,
      model: "jw-wy-gpt-image-2",
      mode: "edits",
      compatibilityMode: true,
      timeoutMs: 5000,
      retryEnabled: false,
      retryPreferenceVersion: 1
    }
  });
}

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

async function expectCode(operation, code, messagePart) {
  await assert.rejects(
    operation,
    (error) => (
      error
      && error.code === code
      && error.status === 413
      && error.retryable === false
      && (!messagePart || String(error.message).includes(messagePart))
    ),
    `应返回不可重试的 ${code}`
  );
}

function testResolvedDefaults() {
  assert.deepStrictEqual(test.resolveImageEditSizeLimits({
    maxAssetBytes: 5 * 1024 * 1024,
    maxTotalAssetBytes: 20 * 1024 * 1024,
    maxRequestBytes: 28 * 1024 * 1024
  }), {
    maxAssetBytes: 5 * 1024 * 1024,
    maxTotalAssetBytes: 20 * 1024 * 1024,
    maxRequestBytes: 28 * 1024 * 1024
  });
}

function testAssetLimitHelpers() {
  const perAssetLimits = {
    maxAssetBytes: 10,
    maxTotalAssetBytes: 100,
    maxRequestBytes: 100
  };
  assert.throws(
    () => test.assertImageEditAssetLimits(
      test.imageEditAssetEntries(Buffer.alloc(11), Buffer.alloc(1)),
      perAssetLimits
    ),
    (error) => error && error.code === "IMAGE_ASSET_TOO_LARGE"
      && error.assetKind === "main"
      && String(error.message).includes("主图")
  );
  assert.throws(
    () => test.assertImageEditAssetLimits(
      test.imageEditAssetEntries(Buffer.alloc(1), Buffer.alloc(11)),
      perAssetLimits
    ),
    (error) => error && error.code === "IMAGE_ASSET_TOO_LARGE"
      && error.assetKind === "mask"
      && String(error.message).includes("mask")
  );
  assert.throws(
    () => test.assertImageEditAssetLimits(
      test.imageEditAssetEntries(
        Buffer.alloc(1),
        Buffer.alloc(1),
        [{
          reference: { role: "wardrobe", index: 0 },
          buffer: Buffer.alloc(11)
        }]
      ),
      perAssetLimits
    ),
    (error) => error && error.code === "IMAGE_ASSET_TOO_LARGE"
      && error.assetKind === "wardrobe"
      && String(error.message).includes("穿搭参考图")
  );

  assert.throws(
    () => test.assertImageEditAssetLimits(
      test.imageEditAssetEntries(
        Buffer.alloc(4),
        Buffer.alloc(4),
        [{
          reference: { role: "background", index: 0 },
          buffer: Buffer.alloc(4)
        }]
      ),
      {
        maxAssetBytes: 10,
        maxTotalAssetBytes: 10,
        maxRequestBytes: 100
      }
    ),
    (error) => error && error.code === "IMAGE_ASSET_TOTAL_TOO_LARGE"
      && error.totalAssetBytes === 12
  );

  const summary = test.assertImageEditAssetLimits(
    test.imageEditAssetEntries(Buffer.alloc(4), Buffer.alloc(3)),
    {
      maxAssetBytes: 10,
      maxTotalAssetBytes: 10,
      maxRequestBytes: 100
    }
  );
  assert.strictEqual(summary.totalBytes, 7);
  assert.strictEqual(summary.assetCount, 2);
}

async function testRequestIntegration() {
  const main = pngFixture(8, 8);
  const mask = pngFixture(8, 8);
  const wardrobe = pngFixture(4, 4);
  let requestCount = 0;

  await withServer((request, response) => {
    requestCount += 1;
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        data: [{ b64_json: Buffer.from("size-limit-result").toString("base64") }]
      }));
    });
  }, async (baseUrl) => {
    const endpoint = `${baseUrl}/v1/images/edits`;
    const config = providerConfig(endpoint);
    const payload = {
      mainFileID: "main-file",
      maskFileID: "mask-file",
      wardrobeFileIDs: ["wardrobe-file"],
      prompt: "只修改圈内衣服",
      size: "1024x1024"
    };
    const preparedAssets = {
      mainBuffer: main,
      maskBuffer: mask,
      referenceBuffers: [{
        reference: { fileID: "wardrobe-file", role: "wardrobe", index: 0 },
        buffer: wardrobe
      }]
    };

    await expectCode(
      () => test.requestImageEdits(
        payload,
        "test-key",
        "size-limit-main",
        config,
        {},
        "test-user",
        Object.assign({}, preparedAssets, { mainBuffer: Buffer.alloc(33) }),
        {
          sizeLimits: {
            maxAssetBytes: 32,
            maxTotalAssetBytes: 1024,
            maxRequestBytes: 4096
          }
        }
      ),
      "IMAGE_ASSET_TOO_LARGE",
      "主图"
    );
    assert.strictEqual(requestCount, 0, "主图超限时不能请求上游");

    await expectCode(
      () => test.requestImageEdits(
        payload,
        "test-key",
        "size-limit-request-body",
        config,
        {},
        "test-user",
        preparedAssets,
        {
          sizeLimits: {
            maxAssetBytes: 1024 * 1024,
            maxTotalAssetBytes: 2 * 1024 * 1024,
            maxRequestBytes: 128
          }
        }
      ),
      "IMAGE_REQUEST_TOO_LARGE",
      "请求上限"
    );
    assert.strictEqual(requestCount, 0, "Base64 请求体超限时不能请求上游");

    let failoverCalls = 0;
    await expectCode(
      () => test.runImageEditProviderFailover({
        requestId: "size-limit-no-fallback",
        primaryConfig: config,
        backupConfig: Object.assign({}, config, {
          provider: "lingyun",
          model: "gpt-image-2"
        }),
        executeAttempt: async (attempt) => {
          failoverCalls += 1;
          return test.requestImageEdits(
            payload,
            "test-key",
            `size-limit-${attempt.role}-${attempt.attempt}`,
            attempt.config,
            {},
            "test-user",
            Object.assign({}, preparedAssets, { mainBuffer: Buffer.alloc(33) }),
            {
              sizeLimits: {
                maxAssetBytes: 32,
                maxTotalAssetBytes: 1024,
                maxRequestBytes: 4096
              }
            }
          );
        }
      }),
      "IMAGE_ASSET_TOO_LARGE",
      "主图"
    );
    assert.strictEqual(failoverCalls, 1, "素材超限不能重试星炬，也不能切换凌云");
    assert.strictEqual(requestCount, 0, "主备编排遇到素材超限也不能请求上游");

    await expectCode(
      () => test.requestTencentPipelineImageEdit(
        Buffer.alloc(33),
        { prompt: "腾讯前置流程大小限制" },
        Object.assign({}, config, { apiKey: "test-key" }),
        {},
        "size-limit-tencent-assets",
        "test-user",
        mask,
        {
          sizeLimits: {
            maxAssetBytes: 32,
            maxTotalAssetBytes: 1024,
            maxRequestBytes: 4096
          }
        }
      ),
      "IMAGE_ASSET_TOO_LARGE",
      "主图"
    );
    assert.strictEqual(requestCount, 0, "腾讯前置流程素材超限时不能请求上游");

    await expectCode(
      () => test.requestTencentPipelineImageEdit(
        main,
        { prompt: "腾讯前置流程请求体限制" },
        Object.assign({}, config, { apiKey: "test-key" }),
        {},
        "size-limit-tencent-request",
        "test-user",
        mask,
        {
          sizeLimits: {
            maxAssetBytes: 1024 * 1024,
            maxTotalAssetBytes: 2 * 1024 * 1024,
            maxRequestBytes: 128
          }
        }
      ),
      "IMAGE_REQUEST_TOO_LARGE",
      "请求上限"
    );
    assert.strictEqual(requestCount, 0, "腾讯前置流程请求体超限时不能请求上游");

    const result = await test.requestImageEdits(
      payload,
      "test-key",
      "size-limit-normal",
      config,
      {},
      "test-user",
      preparedAssets,
      {
        sizeLimits: {
          maxAssetBytes: 1024 * 1024,
          maxTotalAssetBytes: 2 * 1024 * 1024,
          maxRequestBytes: 4 * 1024 * 1024
        }
      }
    );
    assert.ok(result.data && result.data[0] && result.data[0].b64_json);
    assert.strictEqual(requestCount, 1, "正常素材必须只请求上游一次");
  });
}

async function main() {
  assert.ok(test, "云函数没有暴露图片大小限制测试接口");
  testResolvedDefaults();
  testAssetLimitHelpers();
  await testRequestIntegration();
  console.log("图片编辑大小限制测试通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
