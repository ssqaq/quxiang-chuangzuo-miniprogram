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
  pandaConfig.compatibilityMode,
  false,
  "默认必须发送 quality=auto"
);
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

const compatibilityConfig = test.resolveImageConfig({
  image: {
    provider: "legacy-panda",
    model: "legacy-image-model",
    size: "1080x1440",
    resolution: "2K",
    compatibilityMode: "true"
  }
});
assert.strictEqual(compatibilityConfig.compatibilityMode, true);
assert.strictEqual(
  test.resolveImageConfig({ image: { compatibilityMode: "false" } }).compatibilityMode,
  false
);
assert.strictEqual(
  test.normalizeRuntimePatch({ image: { compatibilityMode: "false" } })
    .image.compatibilityMode,
  false
);
const compatibilityGenerationPayload = test.buildImageGenerationPayload(
  { prompt: "旧上游测试" },
  compatibilityConfig
);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(compatibilityGenerationPayload, "quality"),
  false,
  "兼容模式不能发送 quality"
);
const compatibilityEditFields = test.buildImageEditFields(
  { prompt: "旧上游编辑" },
  compatibilityConfig,
  []
);
assert.strictEqual(
  compatibilityEditFields.some((field) => field.name === "quality"),
  false,
  "兼容模式编辑请求不能发送 quality"
);

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

const pandaQualityProbe = test.buildImageQualityProbe(
  { model: "image2超分高质量1-4k" },
  test.modelCapabilities(
    "image",
    { provider: "panda", model: "image2超分高质量1-4k" }
  )
);
assert.strictEqual(pandaQualityProbe.safe, true);
assert.strictEqual(pandaQualityProbe.noGeneration, true);
assert.strictEqual(pandaQualityProbe.status, "ok");
assert.deepStrictEqual(
  pandaQualityProbe.values.map((item) => item.status),
  ["supported", "supported", "supported"]
);

const upstreamQualityProbe = test.buildImageQualityProbe(
  { model: "custom-image-model" },
  test.modelCapabilities(
    "image",
    { provider: "custom", model: "custom-image-model" },
    { capabilities: { resolutions: ["1K", "4K"] } }
  )
);
assert.strictEqual(upstreamQualityProbe.source, "upstream");
assert.strictEqual(upstreamQualityProbe.status, "partial");
assert.deepStrictEqual(
  upstreamQualityProbe.values.map((item) => item.status),
  ["supported", "unsupported", "supported"]
);

assert.deepStrictEqual(
  test.modelCapabilities(
    "image",
    { provider: "custom", model: "map-image-model" },
    { capabilities: { resolutions: { "1K": true, "2K": true, "4K": false } } }
  ),
  {
    source: "upstream",
    resolutions: ["1K", "2K"]
  }
);

const unknownQualityProbe = test.buildImageQualityProbe(
  { model: "unknown-image-model" },
  test.modelCapabilities(
    "image",
    { provider: "custom", model: "unknown-image-model" }
  )
);
assert.strictEqual(unknownQualityProbe.status, "unknown");
assert.ok(
  unknownQualityProbe.values.every((item) => item.status === "unknown")
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
  "image quality smoke: OK (1K/2K/4K 换算、旧配置兼容、compatibilityMode、质量能力探测、上游能力识别、成本档位)"
);
