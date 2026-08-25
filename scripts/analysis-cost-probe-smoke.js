/* eslint-disable no-console */

const assert = require("assert");
const http = require("http");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "probe-admin";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露图片分析价格和模型探测测试接口");

const fallbackCosts = test.resolveCostConfig({
  face: {
    inputPerMillionTokens: 0.21,
    outputPerMillionTokens: 1.81
  }
});
assert.strictEqual(fallbackCosts.analysis.inputPerMillionTokens, 0.21);
assert.strictEqual(fallbackCosts.analysis.outputPerMillionTokens, 1.81);

const independentCosts = test.resolveCostConfig({
  face: {
    inputPerMillionTokens: 0.21,
    outputPerMillionTokens: 1.81
  },
  analysis: {
    inputPerMillionTokens: 0.42,
    outputPerMillionTokens: 2.58
  }
});
assert.strictEqual(independentCosts.analysis.inputPerMillionTokens, 0.42);
assert.strictEqual(independentCosts.analysis.outputPerMillionTokens, 2.58);

const usagePayload = {
  json: {
    usage: {
      prompt_tokens: 1000000,
      completion_tokens: 1000000,
      total_tokens: 2000000
    }
  }
};
const faceBilling = test.buildUsageBilling(
  { action: "detectFaceCircle" },
  usagePayload,
  independentCosts
);
const analysisBilling = test.buildUsageBilling(
  { action: "analyze" },
  usagePayload,
  independentCosts
);
assert.strictEqual(faceBilling.estimatedCost, 2.02);
assert.strictEqual(analysisBilling.estimatedCost, 3);

const normalizedPatch = test.normalizeRuntimePatch({
  costs: {
    analysis: {
      inputPerMillionTokens: 0.5,
      outputPerMillionTokens: 3.5
    }
  }
});
assert.deepStrictEqual(normalizedPatch.costs.analysis, {
  inputPerMillionTokens: 0.5,
  outputPerMillionTokens: 3.5
});
assert.deepStrictEqual(test.validateRuntimePatch(normalizedPatch), []);
assert.ok(test.validateRuntimePatch({
  costs: {
    analysis: {
      inputPerMillionTokens: -1
    }
  }
}).length > 0);

const analysisError = test.addModelErrorContext("analyze", {
  ok: false,
  message: "接口请求超时",
  errorCode: "timeout"
});
assert.strictEqual(analysisError.modelType, "analysis");
assert.strictEqual(analysisError.modelTypeLabel, "图片分析");
assert.strictEqual(analysisError.message, "图片分析模型：接口请求超时");
assert.strictEqual(
  test.modelErrorMessage("analysis", analysisError.message),
  analysisError.message
);
assert.strictEqual(
  test.addModelErrorContext("detectFaceCircle", {
    ok: false,
    message: "没有配置密钥"
  }).message,
  "人脸识别模型：没有配置密钥"
);
assert.strictEqual(test.normalizeModelProbeType("analysis"), "analysis");
assert.strictEqual(test.normalizeModelProbeType("unknown"), "");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const server = http.createServer((request, response) => {
    const authorization = String(request.headers.authorization || "");
    response.setHeader("Content-Type", "application/json");
    if (authorization === "Bearer bad-key") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (authorization === "Bearer unsupported-key") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({
      data: authorization === "Bearer missing-model-key"
        ? [{ id: "another-model" }]
        : [{ id: "target-model" }]
    }));
  });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    process.env.AI_VISION_PROVIDER = "openai-compatible";
    process.env.AI_VISION_BASE_URL = baseUrl;
    process.env.AI_VISION_MODEL = "target-model";
    process.env.AI_VISION_API_KEY = "good-key";
    assert.strictEqual(
      test.modelProbeUrl({
        endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`
      }),
      `${baseUrl}/models`
    );
    assert.deepStrictEqual(
      test.listedModelIds({ models: [{ name: "target-model" }] }),
      ["target-model"]
    );

    const common = {
      provider: "openai-compatible",
      baseUrl,
      model: "target-model",
      timeoutMs: 3000
    };
    const [ok, missingModel, badKey, unsupported] = await Promise.all([
      test.probeOneModel("face", Object.assign({}, common, { apiKey: "good-key" })),
      test.probeOneModel("analysis", Object.assign({}, common, {
        apiKey: "missing-model-key"
      })),
      test.probeOneModel("image", Object.assign({}, common, { apiKey: "bad-key" })),
      test.probeOneModel("video", Object.assign({}, common, {
        apiKey: "unsupported-key"
      }))
    ]);

    assert.strictEqual(ok.status, "ok");
    assert.strictEqual(ok.ready, true);
    assert.strictEqual(missingModel.status, "model-not-listed");
    assert.strictEqual(missingModel.ready, false);
    assert.strictEqual(badKey.status, "auth-failed");
    assert.strictEqual(unsupported.status, "endpoint-not-supported");
    assert.strictEqual(ok.endpoint, `${baseUrl}/models`);

    const singleResult = await api.main({
      action: "probeModels",
      requestId: "single-analysis-probe",
      modelType: "analysis",
      config: {
        provider: "openai-compatible",
        baseUrl,
        apiKey: "good-key",
        model: "target-model",
        timeoutMs: 3000
      }
    }, { OPENID: "probe-admin" });
    assert.strictEqual(singleResult.ok, true);
    assert.strictEqual(singleResult.scope, "single");
    assert.strictEqual(singleResult.requestedType, "analysis");
    assert.strictEqual(singleResult.total, 1);
    assert.strictEqual(singleResult.results[0].type, "analysis");
    assert.strictEqual(singleResult.results[0].status, "ok");

    const listResult = await api.main({
      action: "listModels",
      requestId: "list-analysis-models",
      modelType: "analysis",
      config: {
        provider: "openai-compatible",
        baseUrl,
        apiKey: "good-key",
        timeoutMs: 3000
      }
    }, { OPENID: "probe-admin" });
    assert.strictEqual(listResult.ok, true);
    assert.strictEqual(listResult.status, "ok");
    assert.deepStrictEqual(listResult.models, ["target-model"]);

    const invalidResult = await api.main({
      action: "probeModels",
      requestId: "invalid-model-probe",
      modelType: "unknown"
    }, { OPENID: "probe-admin" });
    assert.strictEqual(invalidResult.ok, false);
    assert.strictEqual(invalidResult.errorCode, "invalid-model-type");

    console.log("analysis cost and model probe smoke: OK");
    console.log(JSON.stringify({
      fallbackAnalysisCost: fallbackCosts.analysis,
      independentAnalysisCost: independentCosts.analysis,
      billing: {
        face: faceBilling.estimatedCost,
        analysis: analysisBilling.estimatedCost
      },
      probeStatuses: [
        ok.status,
        missingModel.status,
        badKey.status,
        unsupported.status
      ],
      singleProbeType: singleResult.results[0].type,
      listedModels: listResult.models
    }));
  } finally {
    await close(server);
  }
}

main().catch((error) => {
  console.error(`analysis cost and model probe smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
