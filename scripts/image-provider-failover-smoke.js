/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.TENCENT_FACEFUSION_TIMEOUT_MS = "75000";

const root = path.resolve(__dirname, "..");
const apiSource = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);
const indexPageSource = fs.readFileSync(
  path.join(root, "pages/index/index.js"),
  "utf8"
);
const tencentPageSource = fs.readFileSync(
  path.join(root, "pages/tencent-face-fusion/tencent-face-fusion.js"),
  "utf8"
);
const adminSource = fs.readFileSync(
  path.join(root, "pages/admin/admin.js"),
  "utf8"
);
const adminWxml = fs.readFileSync(
  path.join(root, "pages/admin/admin.wxml"),
  "utf8"
);

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

function pngFixture(width = 16, height = 16) {
  const png = new PNG({ width, height });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 210;
    png.data[offset + 1] = 190;
    png.data[offset + 2] = 170;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
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

async function main() {
  assert.ok(test, "云函数没有暴露测试接口");
  assert.strictEqual(typeof test.resolveImageBackupConfig, "function");
  assert.strictEqual(typeof test.runImageEditProviderFailover, "function");
  assert.strictEqual(typeof test.requestImageEdits, "function");

  const primaryDefaults = test.resolveImageConfig({
    provider: "xingju",
    baseUrl: "https://newapi.akiyo.fun/v1",
    model: "jw-wy-gpt-image-2",
    mode: "edits",
    timeoutMs: 150000,
    maxRetries: 1,
    retryEnabled: true,
    retryPreferenceVersion: 1
  });
  const backupDefaults = test.resolveImageBackupConfig({
    provider: "lingyun",
    baseUrl: "https://api.lingyunapi.xyz/v1",
    model: "gpt-image-2",
    mode: "edits",
    timeoutMs: 150000
  });
  assert.strictEqual(primaryDefaults.provider, "xingju");
  assert.strictEqual(primaryDefaults.model, "jw-wy-gpt-image-2");
  assert.strictEqual(primaryDefaults.timeoutMs, 150000);
  assert.strictEqual(primaryDefaults.maxRetries, 1);
  assert.strictEqual(backupDefaults.provider, "lingyun");
  assert.strictEqual(backupDefaults.model, "gpt-image-2");
  assert.strictEqual(backupDefaults.timeoutMs, 150000);
  assert.strictEqual(backupDefaults.maxRetries, 0);
  assert.strictEqual(test.resolveTencentFaceFusionConfig().timeoutMs, 75000);

  const previousBackupApiKey = process.env.AI_IMAGE_BACKUP_API_KEY;
  const previousPrimaryApiKey = process.env.AI_IMAGE_PRIMARY_API_KEY;
  process.env.AI_IMAGE_PRIMARY_API_KEY = "primary-only-test-key";
  delete process.env.AI_IMAGE_BACKUP_API_KEY;
  assert.strictEqual(
    test.resolveImageBackupConfig().apiKey,
    "",
    "备用模型不能误读主模型 API Key"
  );
  process.env.AI_IMAGE_BACKUP_API_KEY = "backup-only-test-key";
  assert.strictEqual(
    test.resolveImageBackupConfig().apiKey,
    "backup-only-test-key",
    "备用模型必须读取 AI_IMAGE_BACKUP_API_KEY"
  );
  if (previousBackupApiKey === undefined) {
    delete process.env.AI_IMAGE_BACKUP_API_KEY;
  } else {
    process.env.AI_IMAGE_BACKUP_API_KEY = previousBackupApiKey;
  }
  if (previousPrimaryApiKey === undefined) {
    delete process.env.AI_IMAGE_PRIMARY_API_KEY;
  } else {
    process.env.AI_IMAGE_PRIMARY_API_KEY = previousPrimaryApiKey;
  }

  const meta = test.buildImageRequestMeta(
    {
      requestId: "failover-meta",
      openid: "smoke-user",
      payload: { prompt: "测试", mode: "generations" }
    },
    primaryDefaults,
    {}
  );
  assert.strictEqual(meta.maxAttempts, 2);

  const migrated = test.migrateLegacyImageProviderConfig(
    test.normalizeRuntimePatch({
      image: {
        provider: "lingyun",
        baseUrl: "https://api.lingyunapi.xyz/v1",
        model: "gpt-image-2",
        apiKey: "test-token"
      }
    }),
    {
      image: {
        provider: "lingyun",
        baseUrl: "https://api.lingyunapi.xyz/v1",
        model: "gpt-image-2",
        apiKey: "test-token"
      }
    }
  );
  assert.strictEqual(migrated.migrated, true);
  assert.strictEqual(migrated.value.image.provider, "xingju");
  assert.strictEqual(migrated.value.image.model, "jw-wy-gpt-image-2");
  assert.strictEqual(migrated.value.imageBackup.provider, "lingyun");
  assert.strictEqual(migrated.value.imageBackup.model, "gpt-image-2");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(migrated.value.image, "apiKey"),
    false,
    "旧凌云密钥不能被搬到星炬主配置"
  );

  const requests = [];
  const fixture = pngFixture();
  const costs = test.resolveCostConfig();
  test.resetModelUsageTestEvents();
  await withServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        headers: request.headers,
        body
      });
      response.setHeader("Content-Type", "application/json");
      if (requests.length <= 2) {
        response.statusCode = 503;
        response.end(JSON.stringify({
          error: {
            code: "temporarily_unavailable",
            message: "temporary upstream error"
          }
        }));
        return;
      }
      response.statusCode = 200;
      response.end(JSON.stringify({
        data: [{ b64_json: fixture.toString("base64") }]
      }));
    });
  }, async (url) => {
    const primary = test.resolveImageConfig({
      provider: "xingju",
      baseUrl: `${url}/v1`,
      endpoint: `${url}/v1/images/edits`,
      apiKey: "test-token",
      model: "jw-wy-gpt-image-2",
      mode: "edits",
      timeoutMs: 5000,
      maxRetries: 1,
      retryEnabled: true,
      retryPreferenceVersion: 1
    });
    const backup = test.resolveImageBackupConfig({
      provider: "lingyun",
      baseUrl: `${url}/v1`,
      endpoint: `${url}/v1/images/edits`,
      apiKey: "test-token",
      model: "gpt-image-2",
      mode: "edits",
      timeoutMs: 5000
    });
    const result = await test.runImageEditProviderFailover({
      requestId: "failover-network-smoke",
      primaryConfig: primary,
      backupConfig: backup,
      executeAttempt: (attempt) => test.requestImageEdits(
        {
          mainFileID: "main-file",
          maskFileID: "mask-file",
          prompt: "一次修改衣服、背景和光影",
          size: "1024x1024",
          __action: "generate"
        },
        attempt.config.apiKey,
        "failover-network-smoke",
        attempt.config,
        costs,
        "smoke-user",
        {
          mainBuffer: fixture,
          maskBuffer: fixture,
          referenceBuffers: []
        },
        {
          allowRetry: false,
          maxAttempts: 1,
          idempotencyKey: attempt.idempotencyKey,
          usageRequestId: attempt.idempotencyKey
        }
      )
    });
    assert.strictEqual(result.providerRole, "backup");
    assert.strictEqual(result.providerAttempt, 1);
    assert.strictEqual(result.provider, "lingyun");
    assert.strictEqual(result.model, "gpt-image-2");
    assert.strictEqual(result.attempts.length, 3);
  });

  assert.strictEqual(
    requests.length,
    3,
    "主备编排必须严格只发星炬两次、凌云一次，底层不能再套重试"
  );
  requests.forEach((request) => {
    assert.ok(
      String(request.headers["content-type"] || "").includes("application/json"),
      "星炬和凌云图片编辑都必须发送 application/json"
    );
    assert.ok(
      !String(request.headers["content-type"] || "").includes("multipart/form-data"),
      "星炬不得再走 multipart"
    );
  });
  const primaryBodies = requests.slice(0, 2).map(
    (request) => JSON.parse(request.body.toString("utf8"))
  );
  primaryBodies.forEach((body) => {
    assert.strictEqual(body.model, "jw-wy-gpt-image-2");
    assert.strictEqual(body.images.length, 1);
    assert.ok(body.images[0].image_url.startsWith("data:image/png;base64,"));
    assert.ok(body.mask.image_url.startsWith("data:image/png;base64,"));
    assert.strictEqual(body.response_format, "b64_json");
    assert.strictEqual(body.output_format, "png");
  });
  const backupBody = JSON.parse(requests[2].body.toString("utf8"));
  assert.strictEqual(backupBody.model, "gpt-image-2");
  assert.strictEqual(backupBody.response_format, "b64_json");
  assert.deepStrictEqual(
    requests.map((item) => item.headers["idempotency-key"]),
    [
      "failover-network-smoke:primary:1",
      "failover-network-smoke:primary:2",
      "failover-network-smoke:backup:1"
    ]
  );
  const failoverUsage = test.getModelUsageTestEvents()
    .filter((item) => String(item.requestId || "").startsWith("failover-network-smoke:"));
  assert.strictEqual(failoverUsage.length, 3, "三次上游尝试都必须保留成本明细");
  assert.deepStrictEqual(
    failoverUsage.map((item) => item.provider),
    ["xingju", "xingju", "lingyun"]
  );
  assert.deepStrictEqual(
    failoverUsage.map((item) => item.estimatedCost),
    [0, 0, 0.06],
    "星炬失败尝试成本必须为 0，凌云成功只累计一次 ¥0.06"
  );
  assert.strictEqual(
    failoverUsage.reduce((sum, item) => sum + Number(item.estimatedCost || 0), 0),
    0.06,
    "主备切换不能重复累计图片成本"
  );

  assert.ok(apiSource.includes("imageBackupConfig: configs.imageBackup"));
  assert.ok(apiSource.includes("retryTencentOnly"));
  assert.ok(apiSource.includes("imageEditIntermediate"));
  assert.ok(apiSource.includes("maxAttempts: 2"));
  assert.ok(indexPageSource.includes('"image-edit-primary-retry"'));
  assert.ok(indexPageSource.includes('"image-edit-backup"'));
  assert.ok(tencentPageSource.includes('"image-edit-primary-retry"'));
  assert.ok(tencentPageSource.includes('"image-edit-backup"'));
  assert.ok(adminSource.includes("imageBackup"));
  assert.ok(adminWxml.includes("主模型：{{form.image.provider || '未配置'}} {{form.image.model || '未配置'}}"));
  assert.ok(adminWxml.includes("备用模型：{{form.imageBackup.provider || '未配置'}} {{form.imageBackup.model || '未配置'}}"));

  const pipelineStart = apiSource.indexOf(
    "async function tencentFaceFusionPipeline"
  );
  const pipelineEnd = apiSource.indexOf(
    "function buildImageRequestFromOperation",
    pipelineStart
  );
  const pipelineSource = apiSource.slice(pipelineStart, pipelineEnd);
  assert.strictEqual(
    (pipelineSource.match(/runImageEditProviderFailover\(/g) || []).length,
    1,
    "腾讯第一阶段只能接一处图片主备编排"
  );
  assert.ok(
    pipelineSource.indexOf("if (!retryTencentOnly)") <
      pipelineSource.indexOf("runImageEditProviderFailover("),
    "图片主备编排必须只存在于非腾讯重试分支"
  );

  console.log("image provider failover smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
