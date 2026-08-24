const assert = require("assert");
const config = require("../config");
const path = require("path");

const apiPath = path.resolve(__dirname, "..", "cloudfunctions", "api", "index.js");

function withEnv(patch, callback) {
  const previous = {};
  Object.keys(patch).forEach((name) => {
    previous[name] = process.env[name];
    const value = patch[name];
    if (value === null || value === undefined) delete process.env[name];
    else process.env[name] = String(value);
  });
  try {
    return callback();
  } finally {
    Object.keys(patch).forEach((name) => {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    });
  }
}

process.env.WECHAT_MINIAPP_TEST = "1";
delete require.cache[apiPath];
const api = require(apiPath);
const test = api.__test;

assert.ok(test, "云函数测试入口未导出");

withEnv({
  AI_VISION_PROVIDER: "dashscope",
  AI_VISION_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  AI_VISION_API_KEY: "vision-only-test-key",
  AI_VISION_MODEL: "qwen3-vl-plus",
  AI_FACE_MODEL: "qwen3-vl-flash",
  AI_VISION_TIMEOUT_MS: "25000",
  AI_PROVIDER: "legacy-provider",
  AI_BASE_URL: "https://legacy.invalid/v1",
  AI_API_KEY: "legacy-test-key"
}, () => {
  const visionConfig = test.resolveVisionConfig();
  assert.strictEqual(visionConfig.provider, "dashscope");
  assert.strictEqual(visionConfig.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.strictEqual(visionConfig.apiKey, "vision-only-test-key");
  assert.strictEqual(visionConfig.model, "qwen3-vl-plus");
  assert.strictEqual(visionConfig.faceModel, "qwen3-vl-flash");
  assert.strictEqual(visionConfig.timeoutMs, 25000);

  const probe = test.buildAutoFaceProbe();
  assert.strictEqual(probe.buildVersion, config.appVersion);
  assert.strictEqual(
    probe.buildMarker,
    test.buildAutoFaceProbe().buildMarker
  );
  assert.strictEqual(probe.vision.configured, true);
  assert.strictEqual(probe.vision.apiKeyConfigured, true);
  assert.strictEqual(probe.vision.provider, "dashscope");
  assert.strictEqual(probe.vision.model, "qwen3-vl-flash");
  assert.strictEqual(JSON.stringify(probe).includes("vision-only-test-key"), false);
});

withEnv({
  AI_VISION_PROVIDER: null,
  AI_VISION_BASE_URL: null,
  AI_VISION_API_KEY: null,
  AI_VISION_MODEL: null,
  AI_FACE_MODEL: null,
  AI_VISION_TIMEOUT_MS: null,
  AI_VISION_MAX_IMAGE_BYTES: null,
  AI_PROVIDER: null,
  AI_BASE_URL: null,
  AI_API_KEY: null
}, () => {
  const config = test.resolveVisionConfig();
  assert.strictEqual(config.provider, "dashscope");
  assert.strictEqual(config.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.strictEqual(config.apiKey, "");
  assert.strictEqual(config.model, "qwen3-vl-flash");
  assert.strictEqual(config.faceModel, "qwen3-vl-flash");
  assert.strictEqual(config.timeoutMs, 25000);
  assert.strictEqual(config.maxImageBytes, 5 * 1024 * 1024);
});

withEnv({
  AI_VISION_PROVIDER: null,
  AI_VISION_BASE_URL: null,
  AI_VISION_API_KEY: null,
  AI_VISION_MODEL: null,
  AI_FACE_MODEL: null,
  AI_PROVIDER: "legacy-provider",
  AI_BASE_URL: "https://legacy.invalid/v1",
  AI_API_KEY: "legacy-test-key"
}, () => {
  const config = test.resolveVisionConfig();
  assert.strictEqual(config.provider, "legacy-provider");
  assert.strictEqual(config.baseUrl, "https://legacy.invalid/v1");
  assert.strictEqual(config.apiKey, "legacy-test-key");
});

const faces = test.normalizeFaceDetections(null, JSON.stringify({
  faces: [
    { x_min: 100, y_min: 200, x_max: 420, y_max: 650, confidence: 0.91 },
    { cx: 0.5, cy: 0.5, width: 0.2, height: 0.3, score: 0.8 },
    { x: 980, y: 970, width: 100, height: 100, confidence: 0.7 }
  ]
}));

assert.strictEqual(faces.length, 3);
assert.deepStrictEqual(
  { x: faces[0].x, y: faces[0].y, width: faces[0].width, height: faces[0].height },
  { x: 100, y: 200, width: 320, height: 450 }
);
assert.deepStrictEqual(
  { x: faces[1].x, y: faces[1].y, width: faces[1].width, height: faces[1].height },
  { x: 400, y: 350, width: 200, height: 300 }
);
assert.deepStrictEqual(
  { x: faces[2].x, y: faces[2].y, width: faces[2].width, height: faces[2].height },
  { x: 980, y: 970, width: 20, height: 30 }
);

const vision = { maxImageBytes: 8 };
assert.strictEqual(test.assertVisionImageSize(Buffer.alloc(8), vision), 8);
assert.throws(
  () => test.assertVisionImageSize(Buffer.alloc(9), vision),
  (error) => error && error.code === "image-too-large"
);

console.log("cloud face smoke: OK");
console.log(JSON.stringify({
  visionEnvPriority: true,
  legacyFallback: true,
  normalizedBoxes: true,
  imageSizeGuard: true
}));
