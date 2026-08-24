/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "";
process.env.AI_VISION_PROVIDER = "vision-provider";
process.env.AI_VISION_BASE_URL = "https://vision.example.test/v1";
process.env.AI_VISION_MODEL = "analysis-default-model";
process.env.AI_FACE_MODEL = "face-default-model";
process.env.AI_VISION_TIMEOUT_MS = "24000";
process.env.AI_VISION_API_KEY = "test-key";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;
const source = fs.readFileSync(
  path.join(__dirname, "../cloudfunctions/api/index.js"),
  "utf8"
);

assert.ok(test, "云函数没有暴露图片分析模型测试接口");

const defaultAnalysis = test.resolveAnalysisConfig();
const defaultFace = test.resolveFaceConfig();
assert.strictEqual(defaultAnalysis.model, "analysis-default-model");
assert.strictEqual(defaultFace.model, "face-default-model");
assert.strictEqual(defaultAnalysis.provider, defaultFace.provider);
assert.strictEqual(defaultAnalysis.baseUrl, defaultFace.baseUrl);

const customConfigs = {
  face: {
    provider: "face-provider",
    baseUrl: "https://face.example.test/v1",
    endpoint: "",
    model: "face-config-model",
    apiKey: "face-key",
    timeoutMs: 12000
  },
  analysis: {
    provider: "analysis-provider",
    baseUrl: "https://analysis.example.test/v1",
    endpoint: "",
    model: "analysis-config-model",
    apiKey: "analysis-key",
    timeoutMs: 18000
  }
};
assert.strictEqual(
  test.visionConfigForAction("analyze", customConfigs).model,
  "analysis-config-model"
);
assert.strictEqual(
  test.visionConfigForAction("analyzeWebPoses", customConfigs).model,
  "analysis-config-model"
);
assert.strictEqual(
  test.visionConfigForAction("detectFaceCircle", customConfigs).model,
  "face-config-model"
);
assert.strictEqual(
  test.modelUsageTypeForAction("analyze"),
  "analysis"
);
assert.strictEqual(
  test.modelUsageTypeForAction("analyzeWebPoses"),
  "analysis"
);
assert.strictEqual(
  test.modelUsageTypeForAction("detectFaceCircle"),
  "face"
);

const analyzeStart = source.indexOf("async function analyze(event, context)");
const analyzeEnd = source.indexOf("async function detectFaceCircle", analyzeStart);
const detectStart = source.indexOf("async function detectFaceCircle(event, context)");
const detectEnd = source.indexOf("function autoFaceProbeHistoryCutoff", detectStart);
const webPoseStart = source.indexOf("async function analyzeWebPoses(event, context)");
const webPoseEnd = source.indexOf("function extractImageItem", webPoseStart);
assert.ok(analyzeStart >= 0 && analyzeEnd > analyzeStart);
assert.ok(detectStart >= 0 && detectEnd > detectStart);
assert.ok(webPoseStart >= 0 && webPoseEnd > webPoseStart);
assert.match(source.slice(analyzeStart, analyzeEnd), /visionConfigForAction\("analyze", configs\)/);
assert.match(
  source.slice(detectStart, detectEnd),
  /visionConfigForAction\("detectFaceCircle", configs\)/
);
assert.match(
  source.slice(webPoseStart, webPoseEnd),
  /visionConfigForAction\("analyzeWebPoses", configs\)/
);

const analysisBilling = test.buildUsageBilling(
  { action: "analyze" },
  {
    json: {
      usage: {
        prompt_tokens: 1000000,
        completion_tokens: 1000000,
        total_tokens: 2000000
      }
    }
  },
  test.resolveCostConfig({})
);
assert.strictEqual(analysisBilling.billingSource, "actual");
assert.strictEqual(analysisBilling.estimatedCost, 1.65);

console.log("analysis model smoke: OK");
console.log(JSON.stringify({
  defaultAnalysisModel: defaultAnalysis.model,
  faceModel: defaultFace.model,
  switchedAnalysisModel: test.visionConfigForAction("analyze", customConfigs).model,
  switchedFaceModel: test.visionConfigForAction("detectFaceCircle", customConfigs).model,
  usageType: test.modelUsageTypeForAction("analyze"),
  analysisCost: analysisBilling.estimatedCost
}));
