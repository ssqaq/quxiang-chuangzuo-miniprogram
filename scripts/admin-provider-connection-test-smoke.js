/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const Module = require("module");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_RUNTIME_CONFIG_SMOKE = "1";
process.env.ADMIN_OPENIDS = "admin-provider-connection-smoke";
process.env.AI_VIDEO_API_KEY = "video-saved-key";

const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;
const db = helpers.getTestDatabase();

const ADMIN_OPENID = "admin-provider-connection-smoke";
const PROVIDER_ID = "saved-provider";
const SECTIONS = ["face", "analysis", "image", "imageBackup", "video"];
const MODELS = {
  face: "saved-face-model",
  analysis: "saved-analysis-model",
  image: "saved-image-model",
  imageBackup: "saved-backup-model",
  video: "saved-video-model"
};
const API_KEYS = {
  face: "face-saved-key",
  analysis: "analysis-saved-key",
  image: "image-saved-key",
  imageBackup: "image-backup-saved-key",
  video: "video-saved-key"
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sectionProfile(section, baseUrl, apiKey) {
  const common = {
    provider: PROVIDER_ID,
    baseUrl,
    endpoint: "",
    model: MODELS[section]
  };
  if (section === "face" || section === "analysis") {
    return Object.assign(common, {
      apiKey,
      timeoutMs: 30000
    });
  }
  if (section === "image" || section === "imageBackup") {
    return Object.assign(common, {
      apiKey,
      mode: "edits",
      size: "1080x1440",
      resolution: "1K",
      compatibilityMode: false,
      timeoutMs: 150000
    });
  }
  return Object.assign(common, {
    queryEndpoint: "",
    createPath: "/v1/videos/generations",
    queryPath: "/v1/videos/{taskId}",
    resolution: "720p",
    aspectRatio: "",
    timeoutMs: 90000
  });
}

function buildRuntime(baseUrl) {
  const runtime = {
    providerLabels: {
      [PROVIDER_ID]: "测试服务商"
    },
    providerProfiles: {},
    costs: {},
    points: {},
    generationQueue: {},
    version: 7
  };
  SECTIONS.forEach((section) => {
    const profile = sectionProfile(section, baseUrl, API_KEYS[section]);
    runtime[section] = clone(profile);
    runtime.providerProfiles[section] = {
      [PROVIDER_ID]: clone(profile)
    };
  });
  return runtime;
}

function redactedSection(value) {
  const source = clone(value || {});
  source.apiKeyConfigured = Boolean(String(source.apiKey || "").trim());
  source.apiKey = "";
  return source;
}

function configView(runtime) {
  const effective = {
    providerLabels: clone(runtime.providerLabels),
    providerProfiles: helpers.redactAdminProviderProfiles(runtime.providerProfiles),
    costs: clone(runtime.costs),
    points: clone(runtime.points),
    generationQueue: clone(runtime.generationQueue)
  };
  SECTIONS.forEach((section) => {
    effective[section] = redactedSection(runtime[section]);
  });
  return {
    ok: true,
    effective,
    defaults: {},
    version: runtime.version
  };
}

function fullApiKeys(runtime) {
  const providerProfiles = {};
  SECTIONS.forEach((section) => {
    providerProfiles[section] = {
      [PROVIDER_ID]: {
        apiKey: String(
          runtime.providerProfiles[section]
          && runtime.providerProfiles[section][PROVIDER_ID]
          && runtime.providerProfiles[section][PROVIDER_ID].apiKey
          || ""
        )
      }
    };
  });
  return {
    ok: true,
    providerProfiles,
    face: { apiKey: API_KEYS.face },
    analysis: { apiKey: API_KEYS.analysis },
    image: { apiKey: API_KEYS.image },
    imageBackup: { apiKey: API_KEYS.imageBackup },
    video: { apiKey: API_KEYS.video }
  };
}

function createConfigCollection(runtimeRef) {
  return {
    doc() {
      return {
        async get() {
          return { data: runtimeRef.current };
        }
      };
    }
  };
}

async function withRuntime(runtime, callback) {
  const originalCollection = db.collection;
  const runtimeRef = { current: runtime };
  db.collection = (name) => {
    if (name === "admin_runtime_config") {
      return createConfigCollection(runtimeRef);
    }
    return originalCollection.call(db, name);
  };
  try {
    return await callback(runtimeRef);
  } finally {
    db.collection = originalCollection;
    helpers.getAdminRuntimeCache().value = null;
    helpers.getAdminRuntimeCache().expiresAt = 0;
  }
}

async function withModelServer(callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      path: request.url,
      authorization: request.headers.authorization || "",
      apiKey: request.headers["x-api-key"] || ""
    });
    if (request.url !== "/v1/models") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "not found" }));
      return;
    }
    if (request.headers.authorization === "Bearer bad-saved-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { code: "invalid_api_key", message: "API Key 无效" }
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: Object.values(MODELS).map((id) => ({ id }))
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    return await callback(baseUrl, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function loadAdminPageDefinition(cloudMock, wxState) {
  let definition = null;
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
  global.Page = (page) => {
    definition = page;
  };
  global.wx = {
    showModal(options) {
      wxState.modals.push(options || {});
    },
    showToast(options) {
      wxState.toasts.push(options || {});
    },
    reLaunch() {},
    stopPullDownRefresh() {}
  };
  const pagePath = require.resolve("../pages/admin/admin.js");
  delete require.cache[pagePath];
  try {
    require(pagePath);
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(definition, "管理员页面没有注册成功");
  return definition;
}

function createPageHarness(definition) {
  const page = {
    data: clone(definition.data),
    _adminLoadToken: 0,
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") target[part] = {};
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
      if (typeof callback === "function") callback();
    }
  };
  Object.keys(definition).forEach((key) => {
    if (typeof definition[key] === "function") page[key] = definition[key].bind(page);
  });
  page.loadAdminBackground = () => {};
  page.loadTencentFaceFusionStatus = () => {};
  page.runModelProbe = async () => {};
  return page;
}

function pageConfigMock(runtime, saveError, connectionCalls) {
  return {
    isCloudReady: () => true,
    getAdminStatus: async () => ({ isAdmin: true }),
    getAdminConfig: async () => configView(runtime),
    getAdminImageApiKeys: async () => fullApiKeys(runtime),
    saveAdminConfig: async () => {
      if (saveError) throw saveError;
      return configView(runtime);
    },
    testAdminProviderConnection: async (section, providerId, options) => {
      connectionCalls.push({
        section,
        providerId,
        options: clone(options || {})
      });
      return {
        ok: true,
        section,
        providerId,
        provider: PROVIDER_ID,
        model: MODELS[section],
        ready: true,
        status: "ok",
        statusText: "正常",
        httpStatus: 200,
        durationMs: 31,
        message: "接口可访问，当前模型配置正常。"
      };
    }
  };
}

async function verifyBackend() {
  await withModelServer(async (baseUrl, requests) => {
    let runtime = buildRuntime(baseUrl);
    await withRuntime(runtime, async (runtimeRef) => {
      const beforeUsage = helpers.getModelUsageTestEvents().length;
      const successful = [];
      for (const section of SECTIONS) {
        const result = await api.main(
          {
            action: "testAdminProviderConnection",
            section,
            providerId: PROVIDER_ID,
            requestId: `connection-${section}`
          },
          { OPENID: ADMIN_OPENID }
        );
        assert.strictEqual(result.ok, true, `${section} 真实连接测试应该成功`);
        assert.strictEqual(result.section, section);
        assert.strictEqual(result.providerId, PROVIDER_ID);
        assert.strictEqual(result.model, MODELS[section]);
        assert.strictEqual(result.status, "ok");
        assert.ok(result.durationMs >= 0);
        successful.push(result);
      }
      assert.strictEqual(successful.length, 5);
      assert.strictEqual(
        requests.length,
        5,
        "五个配置区域都应该只发出一次上游模型探测"
      );
      SECTIONS.forEach((section) => {
        const request = requests.find((item) => (
          item.authorization === `Bearer ${API_KEYS[section]}`
        ));
        assert.ok(request, `${section} 没有使用已保存的 Key 调用上游`);
        assert.strictEqual(request.path, "/v1/models");
      });
      assert.strictEqual(
        helpers.getModelUsageTestEvents().length,
        beforeUsage,
        "管理员连接测试不能产生模型用量记录"
      );

      runtime = clone(runtimeRef.current);
      runtime.providerProfiles.face.bad = Object.assign(
        {},
        runtime.providerProfiles.face[PROVIDER_ID],
        {
          provider: "bad",
          apiKey: "bad-saved-key",
          model: MODELS.face
        }
      );
      runtime.providerLabels.bad = "坏服务商";
      runtime.face = runtime.providerProfiles.face.bad;
      runtimeRef.current = runtime;
      const failed = await api.main(
        {
          action: "testAdminProviderConnection",
          section: "face",
          providerId: "bad",
          requestId: "connection-face-bad"
        },
        { OPENID: ADMIN_OPENID }
      );
      assert.strictEqual(failed.ok, false, "上游鉴权失败应该返回失败结果");
      assert.strictEqual(failed.errorCode, "ADMIN_PROVIDER_CONNECTION_AUTH_FAILED");
      assert.strictEqual(failed.httpStatus, 401);
      assert.ok(String(failed.message).includes("HTTP 401"));
      assert.strictEqual(
        JSON.stringify(failed).includes("bad-saved-key"),
        false,
        "失败响应不能带出 API Key"
      );

      const beforeMissing = requests.length;
      const missing = await api.main(
        {
          action: "testAdminProviderConnection",
          section: "face",
          providerId: "not-saved",
          requestId: "connection-missing"
        },
        { OPENID: ADMIN_OPENID }
      );
      assert.strictEqual(missing.ok, false);
      assert.strictEqual(missing.errorCode, "ADMIN_PROVIDER_PROFILE_NOT_FOUND");
      assert.strictEqual(requests.length, beforeMissing);

      const denied = await api.main(
        {
          action: "testAdminProviderConnection",
          section: "face",
          providerId: PROVIDER_ID,
          requestId: "connection-denied"
        },
        { OPENID: "not-admin" }
      );
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.errorCode, "ADMIN_FORBIDDEN");
    });
  });
}

async function verifyPage() {
  const runtime = {
    providerLabels: { [PROVIDER_ID]: "测试服务商" },
    providerProfiles: {},
    face: sectionProfile("face", "https://saved.example/v1", API_KEYS.face),
    analysis: sectionProfile("analysis", "https://saved.example/v1", API_KEYS.analysis),
    image: sectionProfile("image", "https://saved.example/v1", API_KEYS.image),
    imageBackup: sectionProfile(
      "imageBackup",
      "https://saved.example/v1",
      API_KEYS.imageBackup
    ),
    video: sectionProfile("video", "https://saved.example/v1", API_KEYS.video),
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
        defaultResolution: "1K",
        perImage: { "1K": 0.07, "2K": 0.07, "4K": 0.07 },
        providers: {
          xingju: { perImage: { "1K": 0.07, "2K": 0.07, "4K": 0.07 } },
          lingyun: { perImage: { "1K": 0.06, "2K": 0.1, "4K": 0.15 } }
        }
      },
      video: {
        defaultResolution: "720p",
        perSecond: { "480p": 0.2, "720p": 0.3, "1080p": 1.8 },
        defaultDurationSeconds: 5
      }
    },
    points: {},
    generationQueue: {},
    version: 8
  };
  SECTIONS.forEach((section) => {
    runtime.providerProfiles[section] = {
      [PROVIDER_ID]: clone(runtime[section])
    };
  });

  const connectionCalls = [];
  const wxState = { toasts: [], modals: [] };
  const pageDefinition = loadAdminPageDefinition(
    pageConfigMock(runtime, null, connectionCalls),
    wxState
  );
  const page = createPageHarness(pageDefinition);
  await page.loadAdminPage();
  await page.testModelConnection({
    currentTarget: {
      dataset: { modelType: "image", modelConfig: "imageBackup" }
    }
  });
  assert.deepStrictEqual(connectionCalls[0].section, "imageBackup");
  assert.strictEqual(connectionCalls[0].providerId, PROVIDER_ID);
  assert.ok(connectionCalls[0].options.requestId);
  assert.strictEqual(
    JSON.stringify(connectionCalls).includes("apiKey"),
    false,
    "页面连接测试请求不能包含 API Key"
  );

  const saveToastCount = wxState.toasts.length;
  await page.saveConfig();
  assert.ok(
    wxState.toasts.slice(saveToastCount).some((item) => item.title === "配置保存成功"),
    "保存成功必须立即弹出成功提示"
  );
  assert.ok(page.data.message.includes("配置保存成功"));

  const failureState = { toasts: [], modals: [] };
  const failurePageDefinition = loadAdminPageDefinition(
    pageConfigMock(runtime, new Error("模拟保存失败"), []),
    failureState
  );
  const failurePage = createPageHarness(failurePageDefinition);
  await failurePage.loadAdminPage();
  const before = failurePage.data.form.face.model;
  failurePage.onInput({
    currentTarget: { dataset: { section: "face", key: "model" } },
    detail: { value: "draft-face-model" }
  });
  await failurePage.saveConfig();
  assert.strictEqual(failurePage.data.form.face.model, "draft-face-model");
  assert.ok(failureState.modals.some((item) => item.title === "保存失败"));
  assert.notStrictEqual(before, failurePage.data.form.face.model);
}

function verifySourceContracts() {
  const root = path.resolve(__dirname, "..");
  const pageSource = fs.readFileSync(
    path.join(root, "pages/admin/admin.js"),
    "utf8"
  );
  const cloudSource = fs.readFileSync(
    path.join(root, "services/cloud.js"),
    "utf8"
  );
  const wxml = fs.readFileSync(
    path.join(root, "pages/admin/admin.wxml"),
    "utf8"
  );
  const testStart = pageSource.indexOf("async testModelConnection(event)");
  const testEnd = pageSource.indexOf("async getModelOptions(event)", testStart);
  const testBlock = pageSource.slice(testStart, testEnd);
  assert.ok(testBlock.includes("cloud.testAdminProviderConnection"));
  assert.strictEqual(testBlock.includes("modelConfigForAction("), false);
  assert.ok(cloudSource.includes('action: "testAdminProviderConnection"'));
  assert.strictEqual(
    (wxml.match(/aria-label="测试[^"]+模型连接"/g) || []).length,
    5,
    "五个配置区域必须保留连接测试入口"
  );
  assert.strictEqual(
    (wxml.match(/测试使用当前已保存的/g) || []).length,
    5,
    "五个配置区域都要说明测试使用已保存配置"
  );
}

async function main() {
  await verifyBackend();
  await verifyPage();
  verifySourceContracts();
  console.log("admin provider connection test smoke: OK");
}

main().catch((error) => {
  console.error(`admin provider connection test smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
