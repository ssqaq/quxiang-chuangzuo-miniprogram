/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露清晰度测试接口");

assert.strictEqual(
  test.buildImageOutputSize("1K", "1080x1440"),
  "768x1024"
);
assert.strictEqual(
  test.buildImageOutputSize("2K", "1242x1660"),
  "1532x2048"
);
assert.strictEqual(
  test.buildImageOutputSize("4K", "1080x1920"),
  "2304x4096"
);

const legacyConfig = test.resolveImageConfig({
  image: { size: "2048x2048" }
});
assert.strictEqual(legacyConfig.legacySizeOnly, true);
assert.strictEqual(
  test.resolveImageOutputSize(legacyConfig),
  "2048x2048",
  "只有旧 size 的配置不能被新清晰度逻辑改写"
);

const pandaConfig = test.resolveImageConfig({
  image: {
    provider: "panda",
    model: "image2超分高质量1-4k",
    size: "1080x1440",
    resolution: "4K"
  }
});
assert.strictEqual(
  test.resolveImageOutputSize(pandaConfig),
  "3072x4096"
);

const generationPayload = test.buildImageGenerationPayload(
  {
    prompt: "一张测试图",
    negativePrompt: "不要文字"
  },
  pandaConfig
);
assert.deepStrictEqual(generationPayload, {
  model: "image2超分高质量1-4k",
  prompt: "一张测试图\n\n负面约束：不要文字",
  size: "3072x4096",
  quality: "auto",
  n: 1
});

const editFields = test.buildImageEditFields(
  { prompt: "修正人物手部", n: 2 },
  pandaConfig,
  [
    { role: "identity", index: 0 },
    { role: "face", index: 1 }
  ]
);
const fieldValues = Object.fromEntries(
  editFields.map((field) => [field.name, field.value])
);
assert.strictEqual(fieldValues.size, "3072x4096");
assert.strictEqual(fieldValues.quality, "auto");
assert.strictEqual(fieldValues.n, "2");
assert.ok(fieldValues.reference_manifest.includes("identity"));

assert.deepStrictEqual(
  test.modelCapabilities(
    "video",
    { provider: "lingyun", model: "grok-imagine-video-1.5" },
    { capabilities: { resolutions: ["480p", "720p", "1080p"] } }
  ),
  {
    source: "upstream",
    resolutions: ["480p", "720p", "1080p"]
  }
);
assert.deepStrictEqual(
  test.modelCapabilities(
    "video",
    { provider: "lingyun", model: "grok-imagine-video-1.5" }
  ),
  {
    source: "known-model-rule",
    resolutions: ["480p", "720p", "1080p"]
  }
);

const billing = test.buildUsageBilling(
  { action: "generate", imageResolution: "4K" },
  {},
  test.resolveCostConfig({
    image: {
      perImage: {
        "1K": 1,
        "2K": 2,
        "4K": 4
      }
    }
  })
);
assert.strictEqual(billing.imageResolution, "4K");
assert.strictEqual(billing.unitPrice, 4);
assert.strictEqual(billing.estimatedCost, 4);

const unsupportedError = test.imageUpstreamError({
  status: 422,
  raw: "",
  json: { error: { message: "quality is not supported by this model" } },
  retryExhausted: false
});
assert.strictEqual(unsupportedError.code, "IMAGE_PARAMETER_UNSUPPORTED");
assert.ok(unsupportedError.message.includes("quality=auto"));

console.log(
  "image quality smoke: OK (1K/2K/4K 换算、旧配置兼容、quality=auto、上游能力识别、成本档位)"
);
