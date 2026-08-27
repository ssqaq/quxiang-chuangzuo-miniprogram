/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
let usageResolve = null;
let probeFailure = false;
let probeCallCount = 0;
let lastProbeModelConfig = null;
let lastImageEditProbeConfig = null;
let savedConfigPayload = null;
const probeModelCalls = [];
const listModelCalls = [];
const imageEditProbeCalls = [];

const baseConfig = {
  effective: {
    face: {
      provider: "dashscope",
      model: "face-model",
      apiKey: "face-key",
      apiKeyConfigured: true
    },
    analysis: {
      provider: "dashscope",
      model: "analysis-model",
      apiKey: "analysis-key",
      apiKeyConfigured: true
    },
    image: {
      provider: "xingju",
      model: "jw-gpt-image-2",
      apiKey: "image-key",
      apiKeyConfigured: true,
      size: "1024x1024"
    },
    imageBackup: {
      provider: "lingyun",
      baseUrl: "https://backup.example/v1",
      endpoint: "https://backup.example/v1/images/edits",
      model: "gpt-image-2",
      apiKey: "image-backup-key",
      apiKeyConfigured: true,
      mode: "edits",
      size: "1080x1440",
      resolution: "2K",
      timeoutMs: 65000
    },
    video: {
      provider: "lingyun",
      model: "video-model",
      apiKey: "video-key",
      apiKeyConfigured: true,
      resolution: "720p"
    },
    points: {},
    costs: {
      face: {
        inputPerMillionTokens: 0.15,
        outputPerMillionTokens: 1.5
      },
      analysis: {
        inputPerMillionTokens: 0.15,
        outputPerMillionTokens: 1.5
      },
      image: {
        providers: {
          xingju: { perImage: { "1K": 0.07, "2K": 0.07, "4K": 0.07 } },
          lingyun: { perImage: { "1K": 0.06, "2K": 0.1, "4K": 0.15 } }
        }
      },
      video: {
        perSecond: { "480p": 0.2, "720p": 0.3, "1080p": 1.8 },
        defaultDuration: 5
      }
    }
  },
  defaults: {},
  version: 1
};

const delayedUsage = new Promise((resolve) => {
  usageResolve = resolve;
});

const cloudMock = {
  isCloudReady: () => true,
  getAdminStatus: async () => ({ isAdmin: true }),
  getAdminConfig: async () => baseConfig,
  getAdminImageApiKeys: async () => ({
    image: { apiKey: "image-key" },
    imageBackup: { apiKey: "image-backup-key" }
  }),
  saveAdminConfig: async (payload) => {
    savedConfigPayload = payload;
    return {
      ok: true,
      effective: baseConfig.effective,
      version: 2
    };
  },
  getModelUsageStats: () => delayedUsage,
  getAdminUserStats: async () => ({
    total: 1,
    maleCount: 1,
    femaleCount: 0,
    maleRatio: 100,
    femaleRatio: 0,
    users: [],
    nextOffset: null
  }),
  getAdminDiagnosticLogs: async () => ({
    retentionHours: 72,
    summary: {
      total: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      userCount: 0,
      categories: []
    },
    userOptions: [],
    logs: [],
    nextOffset: null
  }),
  getAutoFaceFailureStats: async () => ({
    today: 0,
    last7d: 0,
    total30d: 0,
    byType: [],
    recent: []
  }),
  getAutoFaceProbeHistory: async () => ({
    history: [],
    retentionDays: 30
  }),
  listDeploymentLogs: async () => ({ logs: [] }),
  probeModels: async (modelType, modelConfig) => {
    probeCallCount += 1;
    if (modelConfig) lastProbeModelConfig = modelConfig;
    probeModelCalls.push({
      modelType,
      modelConfig: JSON.parse(JSON.stringify(modelConfig || null))
    });
    const types = modelType
      ? [modelType]
      : ["face", "analysis", "image", "video"];
    const labels = {
      face: "人脸识别",
      analysis: "图片分析",
      image: "生图",
      video: "视频"
    };
    return {
      ok: true,
      readyCount: probeFailure ? 0 : types.length,
      total: types.length,
      results: types.map((type) => ({
        type,
        typeLabel: labels[type] || type,
        provider: modelConfig && modelConfig.provider || `${type}-provider`,
        model: modelConfig && modelConfig.model || `${type}-model`,
        ready: !probeFailure,
        reachable: true,
        status: probeFailure ? "auth-failed" : "ok",
        statusText: probeFailure ? "密钥异常" : "正常",
        httpStatus: probeFailure ? 401 : 200,
        message: probeFailure
          ? "接口地址可访问，但 API Key 无效或没有权限。"
          : "接口可访问，当前模型配置正常。"
      }))
    };
  },
  probeImageEditCapability: async (modelConfig) => {
    lastImageEditProbeConfig = modelConfig;
    imageEditProbeCalls.push(JSON.parse(JSON.stringify(modelConfig || null)));
    return {
      ok: true,
      probe: {
      status: "config-ready",
      statusText: "图片编辑配置完整",
      configured: true,
      provider: modelConfig && modelConfig.provider || "image-provider",
      model: modelConfig && modelConfig.model || "image-model",
      editEndpoint: "https://image.example/v1/images/edits",
      endpointSource: "AI_IMAGE_EDIT_ENDPOINT",
      requestFormat: "multipart",
      fields: {
        mainImage: "image",
        mask: "mask",
        references: "image[]"
      },
      maskInvert: false,
      apiKeyConfigured: true,
      liveVerified: false,
      billingRisk: false,
      message: "本次只核对配置，不调用生图、不扣费；不代表上游已经实测支持 mask。",
      checkedAt: "2026-08-26T08:00:00.000Z"
      }
    };
  },
  listModels: async (modelType, modelConfig) => {
    listModelCalls.push({
      modelType,
      modelConfig: JSON.parse(JSON.stringify(modelConfig || null))
    });
    return {
      ok: true,
      status: "ok",
      models: ["model-10", "model-2", "model-a", "model-b"],
      message: "接口可访问，已读取 4 个模型。"
    };
  }
};

const diagnosticLogMock = {
  info() {},
  warn() {},
  error() {}
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") return cloudMock;
  if (request === "../../utils/diagnostic-log") return diagnosticLogMock;
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  showModal() {},
  showToast() {},
  reLaunch() {},
  stopPullDownRefresh() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "管理员页面没有注册成功");

function createPageInstance() {
  const instance = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    _adminLoadToken: 0,
    setData(patch) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") target[part] = {};
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
    }
  };
  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === "function") {
      instance[key] = pageDefinition[key].bind(instance);
    }
  });
  return instance;
}

async function main() {
  const page = createPageInstance();
  await page.loadAdminPage();

  assert.strictEqual(page.data.loading, false);
  assert.strictEqual(page.data.isAdmin, true);
  assert.strictEqual(page.data.moduleStates.usage.status, "loading");
  assert.strictEqual(page.data.todayFailureText, "读取中");
  assert.strictEqual(page.data.usageStats.today.total, 0);

  usageResolve({
    todayKey: "2026-08-24",
    today: {
      total: 3,
      success: 3,
      failure: 0,
      estimatedCost: 0.000785,
      pricedCost: 0.000785
    },
    last7d: { total: 3, success: 3, failure: 0, estimatedCost: 0.000785 },
    last30d: { total: 3, success: 3, failure: 0, estimatedCost: 0.000785 },
    summary: {},
    daily: [{
      dateKey: "2026-08-24",
      total: 3,
      success: 3,
      failure: 0,
      estimatedCost: 0.000785
    }],
    monthly: [{
      monthKey: "2026-08",
      total: 3,
      estimatedCost: 0.000785,
      analysis: { estimatedCost: 0.000785 }
    }],
    users: [{
      userHash: "user-cost",
      total: 3,
      estimatedCost: 0.000785
    }],
    models: [{
      usageType: "analysis",
      provider: "test",
      model: "cost-model",
      total: 3,
      estimatedCost: 0.000785
    }],
    failureStats: {}
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.strictEqual(page.data.moduleStates.usage.status, "ready");
  assert.strictEqual(page.data.usageStats.today.total, 3);
  assert.strictEqual(page.data.todayFailureText, "0 个失败");
  assert.strictEqual(page.data.usageStats.today.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.today.pricedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.last7d.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.last30d.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.monthly[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.monthly[0].analysis.estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.users[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.usageStats.models[0].estimatedCostDisplay, "0.0007");
  assert.strictEqual(page.data.costTrend.days[6].costDisplay, "0.0007");
  assert.strictEqual(page.data.costTrend.totalCostDisplay, "0.0007");
  assert.strictEqual(page.data.form.face.apiKey, "face-key");
  assert.strictEqual(page.data.form.face.provider, "阿里云百炼");
  assert.strictEqual(page.data.form.analysis.provider, "阿里云百炼");
  assert.strictEqual(page.data.form.image.provider, "星炬");
  assert.strictEqual(page.data.form.imageBackup.provider, "凌云");
  assert.strictEqual(page.data.form.imageBackup.model, "gpt-image-2");
  assert.strictEqual(page.data.form.video.provider, "凌云");

  page.onInput({
    currentTarget: { dataset: { section: "image", key: "provider" } },
    detail: { value: "xingju" }
  });
  assert.strictEqual(page.data.form.image.provider, "星炬");

  page.onInput({
    currentTarget: { dataset: { section: "video", key: "provider" } },
    detail: { value: "lingyun" }
  });
  assert.strictEqual(page.data.form.video.provider, "凌云");

  page.onInput({
    currentTarget: { dataset: { section: "face", key: "provider" } },
    detail: { value: "custom-face-provider" }
  });
  assert.strictEqual(page.data.form.face.provider, "custom-face-provider");
  page.onInput({
    currentTarget: { dataset: { section: "face", key: "provider" } },
    detail: { value: "dashscope" }
  });
  assert.strictEqual(page.data.form.face.provider, "阿里云百炼");

  await page.runImageEditCapabilityProbe();
  assert.strictEqual(page.data.imageEditCapabilityLoading, false);
  assert.strictEqual(page.data.imageEditCapabilityProbe.ready, true);
  assert.strictEqual(page.data.imageEditCapabilityProbe.liveVerified, false);
  assert.strictEqual(page.data.imageEditCapabilityProbe.billingRiskText, "不扣费");
  assert.strictEqual(page.data.imageEditCapabilityProbe.maskField, "mask");
  assert.ok(page.data.imageEditCapabilityProbe.message.includes("不代表上游"));
  assert.strictEqual(lastImageEditProbeConfig.provider, "xingju");
  assert.strictEqual(imageEditProbeCalls[0].provider, "xingju");
  assert.strictEqual(imageEditProbeCalls[0].configTarget, "image");
  const primaryImageProbeBeforeBackup = JSON.stringify(
    page.data.imageEditCapabilityProbe
  );

  await page.runImageBackupEditCapabilityProbe();
  assert.strictEqual(page.data.imageBackupEditCapabilityLoading, false);
  assert.strictEqual(page.data.imageBackupEditCapabilityProbe.ready, true);
  assert.strictEqual(
    page.data.imageBackupEditCapabilityProbe.provider,
    "凌云"
  );
  assert.strictEqual(
    page.data.imageBackupEditCapabilityProbe.model,
    "gpt-image-2"
  );
  assert.strictEqual(imageEditProbeCalls[1].provider, "lingyun");
  assert.strictEqual(imageEditProbeCalls[1].model, "gpt-image-2");
  assert.strictEqual(imageEditProbeCalls[1].configTarget, "imageBackup");
  assert.strictEqual(
    JSON.stringify(page.data.imageEditCapabilityProbe),
    primaryImageProbeBeforeBackup,
    "备用图片编辑检查不能覆盖主模型检查结果"
  );

  const probesBeforeSave = probeCallCount;
  await page.saveConfig();
  assert.strictEqual(page.data.saving, false);
  assert.strictEqual(savedConfigPayload.image.provider, "xingju");
  assert.strictEqual(savedConfigPayload.imageBackup.provider, "lingyun");
  assert.strictEqual(savedConfigPayload.face.provider, "dashscope");
  assert.strictEqual(savedConfigPayload.analysis.provider, "dashscope");
  assert.strictEqual(savedConfigPayload.video.provider, "lingyun");
  assert.ok(probeCallCount > probesBeforeSave);
  assert.strictEqual(page.data.modelProbes.readyCount, 4);
  assert.strictEqual(page.data.modelProbes.total, 4);
  assert.ok(page.data.message.includes("4/4"));

  await page.testModelConnection({
    currentTarget: { dataset: { modelType: "image" } }
  });
  assert.strictEqual(page.data.modelActionType, "");
  assert.ok(page.data.message.includes("测试完成"));
  assert.strictEqual(lastProbeModelConfig.provider, "xingju");

  await page.testModelConnection({
    currentTarget: {
      dataset: {
        modelType: "image",
        modelConfig: "imageBackup"
      }
    }
  });
  assert.strictEqual(page.data.modelActionType, "");
  assert.strictEqual(page.data.modelActionTarget, "");
  assert.strictEqual(
    probeModelCalls[probeModelCalls.length - 1].modelConfig.provider,
    "lingyun"
  );
  assert.strictEqual(
    probeModelCalls[probeModelCalls.length - 1].modelConfig.model,
    "gpt-image-2"
  );
  assert.strictEqual(
    probeModelCalls[probeModelCalls.length - 1].modelConfig.configTarget,
    "imageBackup"
  );
  assert.ok(page.data.message.includes("备用生图测试完成"));

  const primaryImageModelBeforeBackupSelection = page.data.form.image.model;
  await page.getModelOptions({
    currentTarget: {
      dataset: {
        modelType: "image",
        modelConfig: "imageBackup"
      }
    }
  });
  assert.strictEqual(page.data.modelPickerOpen, true);
  assert.strictEqual(page.data.modelPickerType, "image");
  assert.strictEqual(page.data.modelPickerTarget, "imageBackup");
  assert.strictEqual(
    listModelCalls[listModelCalls.length - 1].modelConfig.provider,
    "lingyun"
  );
  assert.strictEqual(
    listModelCalls[listModelCalls.length - 1].modelConfig.configTarget,
    "imageBackup"
  );
  page.selectModelOption({
    currentTarget: {
      dataset: {
        value: "model-10"
      }
    }
  });
  assert.strictEqual(page.data.form.imageBackup.model, "model-10");
  assert.strictEqual(
    page.data.form.image.model,
    primaryImageModelBeforeBackupSelection,
    "选择备用模型不能覆盖主模型"
  );
  assert.strictEqual(page.data.modelPickerTarget, "");

  await page.testModelConnection({
    currentTarget: { dataset: { modelType: "video" } }
  });
  assert.strictEqual(lastProbeModelConfig.provider, "lingyun");

  await page.getModelOptions({
    currentTarget: { dataset: { modelType: "video" } }
  });
  assert.strictEqual(
    listModelCalls[listModelCalls.length - 1].modelConfig.provider,
    "lingyun"
  );
  assert.strictEqual(
    listModelCalls[listModelCalls.length - 1].modelConfig.configTarget,
    "video"
  );

  await page.getModelOptions({
    currentTarget: { dataset: { modelType: "face" } }
  });
  assert.strictEqual(page.data.modelPickerOpen, true);
  assert.deepStrictEqual(page.data.modelPickerOptions.map((item) => item.value), [
    "model-2",
    "model-10",
    "model-a",
    "model-b"
  ]);
  page.onModelPickerSearchInput({
    detail: { value: "MODEL-B" }
  });
  assert.deepStrictEqual(page.data.modelPickerOptions.map((item) => item.value), [
    "model-b"
  ]);
  assert.strictEqual(page.data.modelPickerSearch, "MODEL-B");
  page.clearModelPickerSearch();
  assert.deepStrictEqual(page.data.modelPickerOptions.map((item) => item.value), [
    "model-2",
    "model-10",
    "model-a",
    "model-b"
  ]);
  probeFailure = true;
  await page.testModelConnection({
    currentTarget: { dataset: { modelType: "face" } }
  });
  assert.ok(page.data.message.includes("API Key 无效"));
  assert.ok(page.data.message.includes("HTTP：401"));
  probeFailure = false;
  page.selectModelOption({
    currentTarget: {
      dataset: {
        value: "model-b"
      }
    }
  });
  assert.strictEqual(page.data.form.face.model, "model-b");
  assert.strictEqual(page.data.modelPickerOpen, false);

  await page.refreshAll();
  assert.strictEqual(page.data.refreshingAll, false);
  assert.strictEqual(page.data.moduleStates.usage.status, "ready");
  assert.strictEqual(page.data.moduleStates.users.status, "ready");
  assert.strictEqual(page.data.moduleStates.diagnosticLogs.status, "ready");
  assert.strictEqual(page.data.moduleStates.autoFaceFailure.status, "ready");
  assert.strictEqual(page.data.moduleStates.probeHistory.status, "ready");
  assert.strictEqual(page.data.moduleStates.logs.status, "ready");
  console.log("admin loading smoke: OK (首屏不等待慢统计)");
}

main().catch((error) => {
  console.error(`admin loading smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
