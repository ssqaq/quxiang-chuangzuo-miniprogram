/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-provider-profiles-smoke";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

const SECTIONS = ["face", "analysis", "image", "imageBackup", "video"];
const PROVIDER_A = "provider-a";
const PROVIDER_B = "provider-b";
const PROVIDER_C = "provider-c";
const VIDEO_ENV_KEY = "video-env-key";
const PROVIDER_LABELS = {
  [PROVIDER_A]: "服务商甲",
  [PROVIDER_B]: "服务商乙",
  [PROVIDER_C]: "服务商丙"
};
const PICKER_STATE = {
  face: "faceProviderProfileOptions",
  analysis: "analysisProviderProfileOptions",
  image: "imageProviderProfileOptions",
  imageBackup: "imageBackupProviderProfileOptions",
  video: "videoProviderProfileOptions",
  videoBackup: "videoBackupProviderProfileOptions"
};

assert.ok(test, "云函数没有暴露测试接口");
[
  "normalizeAdminProviderProfiles",
  "mergeAdminProviderProfiles",
  "syncAdminTopLevelProviderProfiles",
  "redactAdminProviderProfiles",
  "migrateLegacyAdminProviderProfiles",
  "normalizeRuntimePatch",
  "dropBlankRuntimeApiKeys",
  "mergeRuntimeConfig",
  "validateRuntimePatch"
].forEach((name) => {
  assert.strictEqual(typeof test[name], "function", `缺少测试函数：${name}`);
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sectionProfile(section, providerId, marker, apiKey) {
  const common = {
    provider: providerId,
    baseUrl: `https://${marker}.${section.toLowerCase()}.example/v1`,
    endpoint: "",
    apiKey,
    model: `${marker}-${section.toLowerCase()}-model`
  };
  if (section === "face" || section === "analysis") {
    return Object.assign(common, {
      timeoutMs: 30000
    });
  }
  if (section === "image" || section === "imageBackup") {
    return Object.assign(common, {
      mode: "edits",
      size: "1080x1440",
      resolution: "1K",
      compatibilityMode: false,
      timeoutMs: 150000,
      maxRetries: section === "image" ? 1 : 0,
      retryEnabled: section === "image",
      retryPreferenceVersion: 1
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

function baseCosts() {
  return {
    currency: "CNY",
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
      perImage: {
        "1K": 0.07,
        "2K": 0.07,
        "4K": 0.07
      },
      providers: {
        xingju: {
          perImage: {
            "1K": 0.07,
            "2K": 0.07,
            "4K": 0.07
          }
        },
        lingyun: {
          perImage: {
            "1K": 0.06,
            "2K": 0.1,
            "4K": 0.15
          }
        }
      }
    },
    video: {
      defaultResolution: "720p",
      perSecond: {
        "480p": 0.2,
        "720p": 0.3,
        "1080p": 1.8
      },
      defaultDurationSeconds: 5
    }
  };
}

function initialRuntime() {
  const runtime = {
    providerLabels: clone(PROVIDER_LABELS),
    providerProfiles: {},
    points: {
      dailyFreeLimit: 3,
      imageCost: 10,
      videoCost: 10,
      checkinPoints: 5,
      streakBonus: 20,
      streakDays: 7,
      promoStartDate: "2026-08-23",
      promoEndDate: "2026-08-24",
      timeZone: "Asia/Shanghai"
    },
    costs: baseCosts(),
    generationQueue: {
      workerConcurrency: 1,
      alertThreshold: 5,
      alertCooldownMinutes: 10
    },
    version: 1
  };
  SECTIONS.forEach((section) => {
    const apiKey = section === "video" ? "" : `${section}-a-key`;
    runtime[section] = sectionProfile(section, PROVIDER_A, "a", apiKey);
    runtime.providerProfiles[section] = {
      [PROVIDER_A]: clone(runtime[section])
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
    providerLabels: clone(runtime.providerLabels || {}),
    providerProfiles: test.redactAdminProviderProfiles(
      runtime.providerProfiles || {}
    ),
    points: clone(runtime.points || {}),
    costs: clone(runtime.costs || {}),
    generationQueue: clone(runtime.generationQueue || {})
  };
  SECTIONS.forEach((section) => {
    effective[section] = redactedSection(runtime[section]);
  });
  return {
    ok: true,
    effective,
    defaults: {},
    version: Number(runtime.version) || 0
  };
}

function fullApiKeys(runtime) {
  const providerProfiles = {};
  SECTIONS.forEach((section) => {
    providerProfiles[section] = {};
    Object.keys(runtime.providerProfiles[section] || {}).forEach((providerId) => {
      providerProfiles[section][providerId] = {
        apiKey: String(
          runtime.providerProfiles[section][providerId].apiKey || ""
        )
      };
    });
  });
  const result = {
    ok: true,
    providerProfiles
  };
  SECTIONS.forEach((section) => {
    result[section] = {
      apiKey: section === "video"
        ? VIDEO_ENV_KEY
        : String(runtime[section] && runtime[section].apiKey || "")
    };
  });
  return result;
}

function createPageHarness(pageDefinition) {
  const page = {
    data: clone(pageDefinition.data),
    _adminLoadToken: 0,
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") {
            target[part] = {};
          }
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
      if (typeof callback === "function") callback();
    }
  };
  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === "function") {
      page[key] = pageDefinition[key].bind(page);
    }
  });
  page.loadAdminBackground = () => {};
  page.loadTencentFaceFusionStatus = () => {};
  page.runModelProbe = async () => {};
  return page;
}

function loadAdminPageDefinition(cloudMock) {
  let pageDefinition = null;
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
  const adminPagePath = require.resolve("../pages/admin/admin.js");
  delete require.cache[adminPagePath];
  try {
    require(adminPagePath);
  } finally {
    Module._load = originalLoad;
  }
  assert.ok(pageDefinition, "管理员页面没有注册成功");
  return pageDefinition;
}

function input(page, section, key, value) {
  page.onInput({
    currentTarget: {
      dataset: { section, key }
    },
    detail: { value }
  });
}

function switchProvider(page, section, providerId) {
  const options = page.data[PICKER_STATE[section]] || [];
  const index = options.findIndex((item) => item.value === providerId);
  assert.ok(index >= 0, `${section} 下拉框里找不到 ${providerId}`);
  page.onProviderProfileChange({
    currentTarget: {
      dataset: { section }
    },
    detail: {
      value: String(index)
    }
  });
}

function verifyBackendProfiles() {
  const legacyRaw = {
    providerLabels: clone(PROVIDER_LABELS)
  };
  SECTIONS.forEach((section) => {
    legacyRaw[section] = sectionProfile(
      section,
      PROVIDER_A,
      "legacy-a",
      `${section}-legacy-a-key`
    );
  });
  const normalizedLegacy = test.normalizeRuntimePatch(legacyRaw);
  const migrated = test.migrateLegacyAdminProviderProfiles(
    normalizedLegacy,
    legacyRaw
  );
  assert.strictEqual(migrated.migrated, true, "老配置必须生成服务商档案");
  SECTIONS.forEach((section) => {
    if (section === "video") {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
          migrated.value.providerProfiles[section][PROVIDER_A],
          "apiKey"
        ),
        false,
        "视频老配置的 Key 不能迁移到服务商档案"
      );
      return;
    }
    assert.strictEqual(
      migrated.value.providerProfiles[section][PROVIDER_A].apiKey,
      `${section}-legacy-a-key`,
      `${section} 老配置没有迁移到对应服务商档案`
    );
  });

  const providerBPatch = {};
  SECTIONS.forEach((section) => {
    providerBPatch[section] = {
      [PROVIDER_B]: sectionProfile(
        section,
        PROVIDER_B,
        "stored-b",
        `${section}-stored-b-key`
      )
    };
  });
  const existing = Object.assign({}, migrated.value, {
    providerProfiles: test.mergeAdminProviderProfiles(
      migrated.value.providerProfiles,
      providerBPatch
    )
  });
  const blankSwitchInput = {
    providerProfiles: {}
  };
  SECTIONS.forEach((section) => {
    blankSwitchInput[section] = sectionProfile(
      section,
      PROVIDER_B,
      "submitted-b",
      ""
    );
    blankSwitchInput.providerProfiles[section] = {
      [PROVIDER_B]: sectionProfile(
        section,
        PROVIDER_B,
        "submitted-b",
        ""
      )
    };
  });
  const blankSwitchPatch = test.dropBlankRuntimeApiKeys(
    test.normalizeRuntimePatch(blankSwitchInput)
  );
  const switched = test.mergeRuntimeConfig(existing, blankSwitchPatch);
  SECTIONS.forEach((section) => {
    if (section === "video") {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(switched.video, "apiKey"),
        false,
        "视频空 Key 切换后不能从动态配置继承旧 Key"
      );
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
          switched.providerProfiles[section][PROVIDER_B],
          "apiKey"
        ),
        false,
        "视频服务商档案不能保留旧 Key"
      );
      return;
    }
    assert.strictEqual(
      switched[section].apiKey,
      `${section}-stored-b-key`,
      `${section} 空 Key 只能继承同分组、同服务商的旧 Key`
    );
    assert.strictEqual(
      switched.providerProfiles[section][PROVIDER_B].apiKey,
      `${section}-stored-b-key`,
      `${section} 档案里的旧 Key 没有被保留`
    );
  });
  assert.notStrictEqual(
    switched.image.apiKey,
    switched.imageBackup.apiKey,
    "生图主备即使服务商相同也必须使用各自的 Key"
  );

  const newProviderPatch = test.dropBlankRuntimeApiKeys(
    test.normalizeRuntimePatch({
      face: {
        provider: PROVIDER_C,
        apiKey: ""
      },
      providerProfiles: {
        face: {
          [PROVIDER_C]: {
            provider: PROVIDER_C,
            apiKey: ""
          }
        }
      }
    })
  );
  const newProvider = test.mergeRuntimeConfig(switched, newProviderPatch);
  assert.strictEqual(newProvider.face.provider, PROVIDER_C);
  assert.strictEqual(newProvider.face.apiKey, undefined);
  assert.strictEqual(newProvider.face.baseUrl, undefined);
  assert.strictEqual(newProvider.face.model, undefined);

  const redacted = test.redactAdminProviderProfiles(
    existing.providerProfiles
  );
  SECTIONS.forEach((section) => {
    [PROVIDER_A, PROVIDER_B].forEach((providerId) => {
      assert.strictEqual(
        redacted[section][providerId].apiKey,
        "",
        `普通接口必须隐藏 ${section}/${providerId} 的 Key`
      );
      assert.strictEqual(
        redacted[section][providerId].apiKeyConfigured,
        section === "video" ? false : true,
        section === "video"
          ? `视频 ${section}/${providerId} 不应有动态 Key 配置状态`
          : `普通接口必须保留 ${section}/${providerId} 的已配置状态`
      );
    });
  });
  const redactedText = JSON.stringify(redacted);
  SECTIONS.forEach((section) => {
    assert.strictEqual(redactedText.includes(`${section}-legacy-a-key`), false);
    assert.strictEqual(redactedText.includes(`${section}-stored-b-key`), false);
  });
}

async function verifyPageSwitchAndReload() {
  let runtime = initialRuntime();
  const savePayloads = [];
  const cloudMock = {
    isCloudReady: () => true,
    getAdminStatus: async () => ({ isAdmin: true }),
    getAdminConfig: async () => configView(runtime),
    getAdminImageApiKeys: async () => fullApiKeys(runtime),
    saveAdminConfig: async (config) => {
      savePayloads.push(clone(config));
      const normalized = test.dropBlankRuntimeApiKeys(
        test.normalizeRuntimePatch(config)
      );
      assert.deepStrictEqual(
        test.validateRuntimePatch(normalized),
        [],
        "页面生成的保存参数没有通过后端校验"
      );
      const version = (Number(runtime.version) || 0) + 1;
      runtime = Object.assign(
        {},
        test.mergeRuntimeConfig(runtime, normalized),
        { version }
      );
      return configView(runtime);
    }
  };
  const pageDefinition = loadAdminPageDefinition(cloudMock);
  const page = createPageHarness(pageDefinition);
  await page.loadAdminPage();

  SECTIONS.forEach((section) => {
    assert.strictEqual(
      page.data.form[section].apiKey,
      section === "video" ? VIDEO_ENV_KEY : `${section}-a-key`,
      `${section} 没有读到服务商甲的完整 Key`
    );
  });
  assert.notStrictEqual(
    page.data.form.image.apiKey,
    page.data.form.imageBackup.apiKey,
    "页面加载后生图主备 Key 不应串用"
  );

  input(page, "face", "baseUrl", "https://draft-a.face.example/v1");
  input(page, "face", "model", "draft-a-face-model");
  input(page, "face", "apiKey", "face-a-draft-key");

  const bKeys = {};
  SECTIONS.forEach((section) => {
    switchProvider(page, section, PROVIDER_B);
    assert.strictEqual(
      page.data.form[section].apiKey,
      section === "video" ? VIDEO_ENV_KEY : "",
      `${section} 新服务商错误复制了当前 Key`
    );
    assert.strictEqual(
      page.data.form[section].baseUrl,
      "",
      `${section} 新服务商错误复制了当前地址`
    );
    assert.strictEqual(
      page.data.form[section].model,
      "",
      `${section} 新服务商错误复制了当前模型`
    );
    bKeys[section] = `${section}-b-draft-key`;
    input(
      page,
      section,
      "baseUrl",
      `https://draft-b.${section.toLowerCase()}.example/v1`
    );
    input(page, section, "model", `draft-b-${section.toLowerCase()}-model`);
    if (section !== "video") {
      input(page, section, "apiKey", bKeys[section]);
    } else {
      bKeys[section] = VIDEO_ENV_KEY;
    }

    switchProvider(page, section, PROVIDER_A);
    assert.strictEqual(
      page.data.form[section].apiKey,
      section === "video"
        ? VIDEO_ENV_KEY
        : section === "face"
          ? "face-a-draft-key"
          : `${section}-a-key`,
      `${section} 从乙切回甲后没有恢复甲的 Key`
    );
    assert.strictEqual(
      page.data.form[section].model,
      section === "face"
        ? "draft-a-face-model"
        : `a-${section.toLowerCase()}-model`,
      `${section} 从乙切回甲后没有恢复甲的模型`
    );

    switchProvider(page, section, PROVIDER_B);
    assert.strictEqual(
      page.data.form[section].apiKey,
      section === "video" ? VIDEO_ENV_KEY : bKeys[section],
      `${section} 再次选择乙后没有恢复乙的 Key`
    );
    assert.strictEqual(
      page.data.form[section].model,
      `draft-b-${section.toLowerCase()}-model`,
      `${section} 再次选择乙后没有恢复乙的模型`
    );
  });

  SECTIONS.forEach((section) => {
    if (section === "video") {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
          page.data.form.providerProfiles[section][PROVIDER_B],
          "apiKey"
        ),
        false,
        "视频服务商档案不能保存云函数环境变量 Key"
      );
    } else {
      assert.strictEqual(
        page.data.form.providerProfiles[section][PROVIDER_B].apiKey,
        bKeys[section],
        `${section} 的乙服务商草稿没有写入独立档案`
      );
    }
  });
  assert.notStrictEqual(
    page.data.form.providerProfiles.image[PROVIDER_B].apiKey,
    page.data.form.providerProfiles.imageBackup[PROVIDER_B].apiKey,
    "同一服务商下的生图主备草稿 Key 必须独立"
  );

  await page.saveConfig();
  assert.strictEqual(savePayloads.length, 1, "保存按钮没有提交配置");
  SECTIONS.forEach((section) => {
    assert.strictEqual(
      savePayloads[0][section].provider,
      PROVIDER_B,
      `${section} 保存时没有使用当前选中的乙服务商`
    );
    if (section === "video") {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(savePayloads[0][section], "apiKey"),
        false,
        "视频 Key 只能来自云函数环境变量，不能提交到动态配置"
      );
      return;
    }
    assert.strictEqual(
      savePayloads[0][section].apiKey,
      bKeys[section],
      `${section} 新填写的乙服务商 Key 没有提交`
    );
  });
  assert.strictEqual(
    savePayloads[0].providerProfiles.face[PROVIDER_A].apiKey,
    "face-a-draft-key",
    "未激活的甲服务商草稿修改也必须一起保存"
  );

  const reloaded = createPageHarness(pageDefinition);
  await reloaded.loadAdminPage();
  SECTIONS.forEach((section) => {
    assert.strictEqual(
      reloaded.data.form[section].apiKey,
      section === "video" ? VIDEO_ENV_KEY : bKeys[section],
      `${section} 保存后重新打开没有恢复乙服务商 Key`
    );
    assert.strictEqual(
      reloaded.data.form[section].model,
      `draft-b-${section.toLowerCase()}-model`,
      `${section} 保存后重新打开没有恢复乙服务商模型`
    );
    switchProvider(reloaded, section, PROVIDER_A);
    assert.strictEqual(
      reloaded.data.form[section].apiKey,
      section === "video"
        ? VIDEO_ENV_KEY
        : section === "face"
          ? "face-a-draft-key"
          : `${section}-a-key`,
      `${section} 保存重载后切回甲没有恢复原参数`
    );
  });
  assert.notStrictEqual(
    reloaded.data.form.image.apiKey,
    reloaded.data.form.imageBackup.apiKey,
    "保存重载后生图主备 Key 仍必须独立"
  );
}

async function verifyBuiltInProviderPresets() {
  let runtime = initialRuntime();
  runtime.providerLabels = {};
  runtime.providerProfiles = {};
  runtime.face = Object.assign({}, runtime.face, {
    provider: "dashscope",
    baseUrl: "",
    endpoint: "",
    apiKey: "",
    model: "",
    timeoutMs: "30000"
  });
  runtime.analysis = Object.assign({}, runtime.analysis, runtime.face);
  runtime.image = Object.assign({}, runtime.image, {
    provider: "xingju",
    baseUrl: "",
    endpoint: "",
    apiKey: "",
    model: "",
    mode: "",
    size: "",
    resolution: "",
    timeoutMs: "150000"
  });
  runtime.imageBackup = Object.assign({}, runtime.imageBackup, {
    provider: "lingyun",
    baseUrl: "",
    endpoint: "",
    apiKey: "",
    model: "",
    mode: "",
    size: "",
    resolution: "",
    timeoutMs: "150000"
  });
  runtime.video = Object.assign({}, runtime.video, {
    provider: "xingju",
    baseUrl: "",
    endpoint: "",
    queryEndpoint: "",
    apiKey: "",
    model: "",
    createPath: "",
    queryPath: "",
    resolution: "",
    aspectRatio: "",
    timeoutMs: "90000"
  });
  const cloudMock = {
    isCloudReady: () => true,
    getAdminStatus: async () => ({ isAdmin: true }),
    getAdminConfig: async () => configView(runtime),
    getAdminImageApiKeys: async () => fullApiKeys(runtime)
  };
  const page = createPageHarness(loadAdminPageDefinition(cloudMock));
  await page.loadAdminPage();

  ["dashscope", "xingju", "lingyun", "laoli", "panda"].forEach((providerId) => {
    ["face", "analysis", "image", "imageBackup", "video"].forEach((section) => {
      assert.ok(
        (page.data[PICKER_STATE[section]] || []).some((item) => item.value === providerId),
        `${section} 下拉框缺少内置服务商 ${providerId}`
      );
    });
  });
  const faceOptions = page.data.faceProviderProfileOptions;
  assert.ok(
    faceOptions.find((item) => item.value === "dashscope").label.includes("已有参数"),
    "阿里云百炼视觉预设没有显示已有参数"
  );
  ["xingju", "lingyun", "laoli", "panda"].forEach((providerId) => {
    assert.ok(
      page.data.imageProviderProfileOptions.find((item) => item.value === providerId).label.includes("已有参数"),
      `图片服务商 ${providerId} 没有显示已有参数`
    );
  });
  assert.ok(
    page.data.videoProviderProfileOptions.find((item) => item.value === "xingju").label.includes("已有参数"),
    "星炬视频预设没有显示已有参数"
  );

  switchProvider(page, "face", "dashscope");
  assert.strictEqual(page.data.form.face.model, "qwen3-vl-flash");
  assert.strictEqual(page.data.form.face.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.strictEqual(String(page.data.form.face.timeoutMs), "30000");
  assert.strictEqual(page.data.form.face.endpoint, "");
  switchProvider(page, "analysis", "dashscope");
  assert.strictEqual(page.data.form.analysis.model, "qwen3-vl-flash");
  assert.strictEqual(String(page.data.form.analysis.timeoutMs), "30000");

  switchProvider(page, "image", "xingju");
  assert.strictEqual(page.data.form.image.model, "jw-wy-gpt-image-2");
  assert.strictEqual(page.data.form.image.mode, "edits");
  assert.strictEqual(page.data.form.image.size, "1080x1440");
  assert.strictEqual(page.data.form.image.resolution, "1K");
  assert.strictEqual(String(page.data.form.image.timeoutMs), "150000");
  switchProvider(page, "image", "lingyun");
  assert.strictEqual(page.data.form.image.endpoint, "https://api.lingyunapi.xyz/v1/images/edits");
  switchProvider(page, "image", "laoli");
  assert.strictEqual(page.data.form.image.endpoint, "https://api.laoliimage2.win/v1/images/edits");
  switchProvider(page, "image", "panda");
  assert.strictEqual(page.data.form.image.baseUrl, "https://api.pandatk.com");
  assert.strictEqual(page.data.form.image.model, "gpt-image-2");
  switchProvider(page, "imageBackup", "xingju");
  assert.strictEqual(page.data.form.imageBackup.model, "jw-wy-gpt-image-2");

  switchProvider(page, "video", "xingju");
  assert.strictEqual(page.data.form.video.enabled, true);
  assert.strictEqual(page.data.form.video.model, "grok-imagine-video-1.5");
  assert.strictEqual(page.data.form.video.createPath, "/v1/videos/generations");
  assert.strictEqual(page.data.form.video.queryPath, "/v1/videos/{taskId}");
  assert.strictEqual(page.data.form.video.resolution, "720p");
  assert.strictEqual(String(page.data.form.video.timeoutMs), "90000");
  switchProvider(page, "videoBackup", "xingju");
  assert.strictEqual(page.data.form.videoBackup.enabled, true);
  assert.strictEqual(page.data.form.videoBackup.model, "grok-imagine-video-1.5");
  assert.strictEqual(page.data.form.videoBackup.queryPath, "/v1/videos/{taskId}");
  page.onVideoBackupEnabledChange({ detail: { value: false } });
  assert.strictEqual(page.data.form.videoBackup.enabled, false);
  page.onVideoBackupEnabledChange({ detail: { value: true } });
  assert.strictEqual(page.data.form.videoBackup.enabled, true);
}

function verifyMarkup() {
  const root = path.resolve(__dirname, "..");
  const wxml = fs.readFileSync(
    path.join(root, "pages/admin/admin.wxml"),
    "utf8"
  );
  const pageJs = fs.readFileSync(
    path.join(root, "pages/admin/admin.js"),
    "utf8"
  );
  assert.strictEqual(
    (wxml.match(/bindchange="onProviderProfileChange"/g) || []).length,
    12,
    "图片主备、腾讯版主备和视频主备都必须使用服务商档案下拉框"
  );
  Object.keys(PICKER_STATE).forEach((section) => {
    assert.ok(
      wxml.includes(`range="{{${PICKER_STATE[section]}}}"`),
      `${section} 缺少服务商档案选项`
    );
    assert.strictEqual(
      new RegExp(
        `<input[^>]*data-section="${section}"[^>]*data-key="provider"`,
        "m"
      ).test(wxml),
      false,
      `${section} 仍在使用可随意输入的服务商文本框`
    );
    assert.ok(
      wxml.includes(`form.${section}.apiKeyConfigured`),
      `${section} 的 Key 状态没有跟随当前草稿`
    );
    assert.strictEqual(
      wxml.includes(`effective.${section}.apiKeyConfigured`),
      false,
      `${section} 仍在显示旧云端 Key 状态`
    );
  });
  assert.ok(
    wxml.includes("切换服务商只修改当前页面草稿"),
    "页面没有说明切换服务商与保存云端的区别"
  );
  [
    'data-section="face" data-key="endpoint"',
    'data-section="analysis" data-key="endpoint"',
    'data-section="image" data-key="mode"',
    'data-section="video" data-key="endpoint"',
    'data-section="video" data-key="queryEndpoint"',
    'data-section="videoBackup" data-key="endpoint"',
    'data-section="videoBackup" data-key="queryEndpoint"'
  ].forEach((field) => {
    assert.ok(wxml.includes(field), `管理员页面缺少可编辑字段 ${field}`);
  });
  [
    "buildAdminProviderProfileOptions",
    "buildAdminProviderProfilePickerState",
    "captureAdminProviderProfile",
    "switchAdminProviderProfile",
    "onProviderProfileChange(event)"
  ].forEach((name) => {
    assert.ok(pageJs.includes(name), `管理员页面缺少 ${name}`);
  });
  assert.ok(
    wxml.includes("视频服务商设置")
      && wxml.includes("videoWizardStep")
      && wxml.includes('bindchange="onVideoBackupEnabledChange"')
      && wxml.includes("启用备用视频模型")
      && wxml.includes("onVideoWizardNext")
      && wxml.includes("onVideoWizardPrev")
      && wxml.includes("toggleVideoAdvancedSettings")
      && pageJs.includes("validateVideoWizardStep")
      && pageJs.includes("videoWizardAdvancedOpen"),
    "视频主备四步向导或备用开关缺失"
  );
  assert.ok(
    wxml.includes('data-section="tencentFaceFusion"')
      && wxml.includes('id="config-editor-tencentFaceFusion"')
      && wxml.includes("开始新创作-腾讯版")
      && wxml.includes("tencentPipelineWizardStep")
      && wxml.includes("第 1 步：选择主生图模型")
      && wxml.includes("第 2 步：要不要启用备用生图")
      && wxml.includes("第 3 步：配置腾讯融合")
      && wxml.includes("第 4 步：测试并保存")
      && wxml.includes('bindtap="onTencentWizardNext"')
      && wxml.includes('bindtap="onTencentWizardPrev"')
      && !wxml.includes("tencentImageTab ===")
      && !wxml.includes("tencent-fusion-tab-panel"),
    "独立腾讯版四步向导缺失，或普通生图仍残留旧腾讯页签"
  );
  [
    "secretId",
    "secretKey",
    "region",
    "endpoint",
    "apiVersion",
    "action",
    "model",
    "swapModelType",
    "logoAdd",
    "timeoutMs",
    "maxImageBytes"
  ].forEach((field) => {
    assert.ok(
      wxml.includes(`form.tencentFaceFusion.${field}`),
      `腾讯版缺少配置字段 ${field}`
    );
  });
  assert.ok(
    pageJs.includes('tencentFaceFusion: "开始新创作-腾讯版"')
      && pageJs.includes('rawSection === "tencentImage"')
      && pageJs.includes('? "tencentFaceFusion" : rawSection')
      && pageJs.includes("tencentPipelineWizardStep"),
    "腾讯版独立 section 或旧布局迁移逻辑缺失"
  );
}

async function main() {
  verifyBackendProfiles();
  await verifyPageSwitchAndReload();
  await verifyBuiltInProviderPresets();
  verifyMarkup();
  console.log("admin provider profiles smoke: OK");
}

main().catch((error) => {
  console.error(`admin provider profiles smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
