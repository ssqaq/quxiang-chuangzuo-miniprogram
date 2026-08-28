/* eslint-disable no-console */

// 服务商目录专项 smoke：纯函数、云函数事务和管理员页静态联动都在这里做最小回归。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "provider-smoke-admin";

const providerUi = require("../services/admin-provider-registry");
const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;

assert.ok(helpers, "云函数没有暴露 provider 管理测试接口");

const CUSTOM_KEY = "11111111-1111-5111-8111-111111111111";
const CUSTOM_ID = "a-provider";
const RENAMED_ID = "a-provider-renamed";
const ADMIN_CONTEXT = { OPENID: "provider-smoke-admin" };

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).reduce((output, key) => {
    output[key] = clone(value[key]);
    return output;
  }, {});
}

function createMemoryStore() {
  const records = new Map();
  const collection = (name) => ({
    doc(id) {
      const key = `${name}/${id}`;
      return {
        async get() {
          if (!records.has(key)) {
            const error = new Error("document not exist");
            error.code = "DATABASE_DOCUMENT_NOT_EXIST";
            throw error;
          }
          return { data: clone(records.get(key)) };
        },
        async set({ data }) {
          records.set(key, clone(data));
          return { stats: { updated: 1 } };
        }
      };
    },
    async add({ data }) {
      records.set(`${name}/audit-${records.size}`, clone(data));
      return { _id: `audit-${records.size}` };
    }
  });
  return { records, collection };
}

function providerRecord(overrides = {}) {
  return Object.assign({
    providerKey: CUSTOM_KEY,
    id: CUSTOM_ID,
    name: "A 服务商",
    common: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "custom-secret"
    },
    capabilities: {
      face: {
        enabled: true,
        overrideEnabled: false,
        overrides: { model: "face-model", timeoutMs: 25000 }
      },
      analysis: { enabled: false, overrideEnabled: false, overrides: {} },
      image: { enabled: false, overrideEnabled: false, overrides: {} },
      imageBackup: { enabled: false, overrideEnabled: false, overrides: {} },
      video: { enabled: false, overrideEnabled: false, overrides: {} }
    }
  }, overrides);
}

function legacyRuntime() {
  return {
    version: 0,
    face: {
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-vl-flash",
      apiKey: "fallback-face-key"
    },
    analysis: {
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen3-vl-flash",
      apiKey: "fallback-face-key"
    },
    image: {
      provider: "xingju",
      baseUrl: "https://newapi.akiyo.fun/v1",
      model: "jw-gpt-image-2",
      apiKey: "fallback-image-key"
    },
    imageBackup: {
      provider: "lingyun",
      baseUrl: "https://api.lingyunapi.xyz/v1",
      model: "gpt-image-2",
      apiKey: "fallback-backup-key"
    },
    video: {
      provider: "xingju",
      baseUrl: "https://newapi.akiyo.fun/v1",
      model: "jwy-v1",
      apiKey: "fallback-video-key"
    },
    providerLabels: { dashscope: "阿里云百炼" }
  };
}

function assertUiPureFunctions() {
  const result = {
    providerRegistry: {
      version: 4,
      providers: {
        [CUSTOM_KEY]: {
          providerKey: CUSTOM_KEY,
          id: CUSTOM_ID,
          name: "A 服务商",
          aliases: ["old-provider"],
          common: {
            baseUrl: "https://api.example.com/v1",
            apiKeyConfigured: true
          },
          overrides: {
            face: { model: "face-model", enabled: true },
            image: {
              model: "primary-image",
              baseUrl: "https://image.example.com/v1",
              enabled: true
            },
            imageBackup: {
              model: "backup-image",
              enabled: true
            }
          }
        }
      }
    },
    activeProviders: {
      face: CUSTOM_KEY,
      analysis: "",
      image: CUSTOM_KEY,
      imageBackup: CUSTOM_KEY,
      video: ""
    }
  };
  const registry = providerUi.registryFromResult(result);
  const record = providerUi.providerRecord(registry, CUSTOM_KEY);
  assert.ok(record, "目录档案读取失败");
  assert.strictEqual(record.common.baseUrl, "https://api.example.com/v1");
  assert.strictEqual(record.capabilities.face.baseUrl, record.common.baseUrl, "公共地址没有继承到人脸能力");
  assert.strictEqual(record.capabilities.image.baseUrl, "https://image.example.com/v1", "能力覆盖地址没有生效");
  assert.strictEqual(record.capabilities.image.model, "primary-image");
  assert.strictEqual(record.capabilities.imageBackup.model, "backup-image", "主备模型不能共用同一个字段");
  assert.strictEqual(providerUi.capabilityComplete(record, "face"), true);
  assert.strictEqual(providerUi.capabilityComplete(record, "analysis"), false);

  const active = providerUi.normalizeActiveProviders(result.activeProviders, registry, result.effective || {});
  const rows = providerUi.buildProviderRows(registry, active);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].usedText.includes("人脸") && rows[0].usedText.includes("生图主"));
  const imageOptions = providerUi.buildProviderOptions(registry, active, "image");
  assert.ok(imageOptions.some((item) => item.value === CUSTOM_KEY && item.status === "ready"));

  const draft = providerUi.draftFromRecord(record, {
    secrets: {
      common: { apiKey: "custom-secret", apiKeyConfigured: true },
      slots: { face: { apiKey: "custom-secret", configured: true } }
    }
  });
  const responseShapedDraft = providerUi.draftFromRecord(record, {
    providerKey: CUSTOM_KEY,
    secrets: {
      [CUSTOM_KEY]: {
        apiKey: "wrong-directory-shape",
        slots: { face: { apiKey: "wrong-directory-shape", configured: true } }
      }
    },
    common: { apiKey: "custom-secret", apiKeyConfigured: true },
    capabilities: { face: { apiKey: "custom-secret", apiKeyConfigured: true } }
  });
  assert.strictEqual(
    responseShapedDraft.common.apiKey,
    "custom-secret",
    "选中档案响应没有正确回填公共 Key"
  );
  assert.strictEqual(
    responseShapedDraft.capabilities.face.apiKey,
    "custom-secret",
    "选中档案响应没有正确回填能力 Key"
  );
  draft.id = RENAMED_ID;
  draft.aliasesText = "old-provider, a-provider";
  draft.common.apiKey = "";
  const payload = providerUi.draftToProvider(draft);
  assert.strictEqual(payload.providerKey, CUSTOM_KEY, "改外部 ID 时内部 key 必须保持不变");
  assert.strictEqual(payload.id, RENAMED_ID);
  assert.ok(payload.aliases.includes("a-provider"), "改 ID 没有保留历史别名");
  assert.strictEqual(payload.common.apiKey, "", "空 Key 应交给后端执行保留语义");
}

function assertBackendPureFunctions() {
  // 旧版“服务商中文名”配置不再单独占一个筛选面板，但 providerLabels 仍是
  // 迁移输入和兼容投影；这里保留回归断言，避免目录改造把历史名称弄丢。
  const normalizedLabels = helpers.normalizeAdminProviderLabels({
    dashscope: "百炼旧名称",
    custom: "自定义服务商"
  }, { includeDefaults: true });
  assert.strictEqual(normalizedLabels.dashscope, "百炼旧名称");
  assert.strictEqual(normalizedLabels.custom, "自定义服务商");
  const mergedLabels = helpers.mergeAdminProviderLabels(
    { custom: "旧自定义名称", dashscope: "旧百炼名称" },
    { custom: "新自定义名称" }
  );
  assert.strictEqual(mergedLabels.custom, "新自定义名称");
  assert.strictEqual(mergedLabels.dashscope, "旧百炼名称");

  const legacy = legacyRuntime();
  const migrated = helpers.migrateLegacyProviderRegistry(
    helpers.normalizeRuntimePatch(legacy),
    legacy
  );
  assert.strictEqual(migrated.migrated, true, "旧顶层配置没有触发幂等迁移");
  assert.ok(migrated.value.providerRegistry.providers.dashscope);
  assert.ok(migrated.value.providerRegistry.providers.xingju);
  assert.ok(migrated.value.providerRegistry.providers.lingyun);
  assert.strictEqual(migrated.value.activeProviders.face, "dashscope");
  assert.strictEqual(migrated.value.activeProviders.image, "xingju");
  assert.strictEqual(migrated.value.activeProviders.imageBackup, "lingyun");
  assert.strictEqual(
    migrated.value.providerRegistry.providers.dashscope.name,
    "阿里云百炼",
    "迁移时内置服务商中文名不应丢失"
  );

  const labelLegacy = {
    providerLabels: { legacy: "旧版服务商" },
    face: {
      provider: "legacy",
      baseUrl: "https://legacy.example/v1",
      model: "legacy-face",
      apiKey: "legacy-key"
    }
  };
  const labelMigration = helpers.migrateLegacyProviderRegistry(
    helpers.normalizeRuntimePatch(labelLegacy),
    labelLegacy
  );
  const labelProvider = Object.values(labelMigration.value.providerRegistry.providers)
    .find((record) => record && record.id === "legacy");
  assert.ok(labelProvider && labelProvider.name === "旧版服务商", "旧 providerLabels 没有迁移到目录名称");
  assert.strictEqual(labelMigration.value.activeProviders.face, labelProvider.providerKey);

  const custom = helpers.normalizeProviderRecord(providerRecord(), CUSTOM_KEY, { includePreset: false });
  assert.ok(custom);
  const generated = helpers.normalizeProviderRecord({
    id: "generated-provider",
    name: "自动键服务商",
    baseUrl: "https://api.example.com/v1",
    apiKey: "generated-key",
    overrides: { face: { model: "generated-face" } }
  }, "", { includePreset: false });
  assert.ok(
    generated && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generated.providerKey),
    "新服务商没有生成固定 UUID providerKey"
  );
  assert.strictEqual(helpers.providerConfigComplete(custom, "face"), true);
  const preservedBlankKey = helpers.mergeProviderRecord(custom, {
    providerKey: CUSTOM_KEY,
    id: CUSTOM_ID,
    name: "A 服务商",
    common: { baseUrl: "https://api.example.com/v1", apiKey: "" },
    overrides: { face: { enabled: true, overrideEnabled: false, model: "face-model" } }
  });
  assert.strictEqual(preservedBlankKey.apiKey, "custom-secret", "留空 Key 没有保留旧值");
  const explicitlyCleared = helpers.mergeProviderRecord(custom, {
    providerKey: CUSTOM_KEY,
    id: CUSTOM_ID,
    name: "A 服务商",
    common: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      clearApiKey: true
    },
    overrides: { face: { enabled: true, clearApiKey: true, model: "face-model" } }
  });
  assert.strictEqual(explicitlyCleared.apiKey, "", "显式清除 Key 没有生效");
  const redacted = helpers.redactProviderRegistry({
    version: 1,
    providers: { [CUSTOM_KEY]: custom }
  });
  const redactedText = JSON.stringify(redacted);
  assert.ok(!redactedText.includes("custom-secret"), "脱敏目录泄露了 API Key");
  assert.strictEqual(redacted.providers[CUSTOM_KEY].apiKeyConfigured, true);

  const validRegistry = {
    providers: { [CUSTOM_KEY]: custom }
  };
  assert.deepStrictEqual(helpers.validateProviderRegistry(validRegistry, {}), []);
  // normalizeProviderRegistry 会按 ID 合并历史档案，真正的重复检查在写事务里做；
  // CRUD 流程下面会用不同内部 key 覆盖这个分支。
  const invalid = helpers.normalizeProviderRecord(
    providerRecord({ id: "bad id", name: "非法服务商" }),
    "33333333-3333-5333-8333-333333333333",
    { includePreset: false }
  );
  assert.ok(helpers.validateProviderRegistry({
    providers: { "33333333-3333-5333-8333-333333333333": invalid }
  }, {}).some((message) => /id 不合法/.test(message)), "非法 ID 没有被拒绝");
  const incomplete = helpers.normalizeProviderRecord({
    providerKey: "44444444-4444-5444-8444-444444444444",
    id: "half-provider",
    name: "半成品",
    baseUrl: "https://api.example.com/v1"
  }, "44444444-4444-5444-8444-444444444444", { includePreset: false });
  assert.ok(helpers.validateProviderRegistry({
    providers: { [incomplete.providerKey]: incomplete }
  }, {}).some((message) => /至少要配置一项能力/.test(message)), "半成品服务商没有被拒绝");

  const fallbackRegistry = helpers.normalizeProviderRegistry({
    providers: { [CUSTOM_KEY]: custom }
  }, { includeDefaults: false });
  assert.strictEqual(
    helpers.providerActiveFallback("face", CUSTOM_KEY, fallbackRegistry, { face: CUSTOM_KEY }),
    "",
    "没有候选档案时删除回退必须置空"
  );
  const previousVisionKey = process.env.AI_VISION_API_KEY;
  try {
    process.env.AI_VISION_API_KEY = "env-dashscope-key";
    const envRegistry = helpers.normalizeProviderRegistry({}, { includeDefaults: true });
    assert.strictEqual(
      helpers.providerConfigComplete(envRegistry.providers.dashscope, "face"),
      true,
      "人脸预设没有兼容现有 AI_VISION_API_KEY"
    );
    assert.strictEqual(
      helpers.providerActiveFallback("face", CUSTOM_KEY, envRegistry, { face: CUSTOM_KEY }),
      "dashscope",
      "人脸删除回退没有优先使用可用的 dashscope 环境 Key"
    );
  } finally {
    if (previousVisionKey === undefined) delete process.env.AI_VISION_API_KEY;
    else process.env.AI_VISION_API_KEY = previousVisionKey;
  }
  const previousVideoEnv = {
    provider: process.env.AI_VIDEO_PROVIDER,
    baseUrl: process.env.AI_VIDEO_BASE_URL,
    apiKey: process.env.AI_VIDEO_API_KEY,
    model: process.env.AI_VIDEO_MODEL
  };
  try {
    process.env.AI_VIDEO_PROVIDER = "env-video";
    process.env.AI_VIDEO_BASE_URL = "https://video.example.com";
    process.env.AI_VIDEO_API_KEY = "env-video-key";
    process.env.AI_VIDEO_MODEL = "env-video-model";
    const envVideoRegistry = helpers.normalizeProviderRegistry({}, { includeDefaults: true });
    const envVideoKey = helpers.providerActiveFallback(
      "video",
      CUSTOM_KEY,
      envVideoRegistry,
      { video: CUSTOM_KEY }
    );
    assert.ok(envVideoKey && envVideoRegistry.providers[envVideoKey], "视频环境变量没有生成可用回退档案");
    assert.strictEqual(envVideoRegistry.providers[envVideoKey].id, "env-video");
  } finally {
    [
      ["AI_VIDEO_PROVIDER", previousVideoEnv.provider],
      ["AI_VIDEO_BASE_URL", previousVideoEnv.baseUrl],
      ["AI_VIDEO_API_KEY", previousVideoEnv.apiKey],
      ["AI_VIDEO_MODEL", previousVideoEnv.model]
    ].forEach(([name, value]) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
  const rebound = helpers.providerAdminPayload(
    { providerRegistry: fallbackRegistry, activeProviders: { face: "" } },
    { face: { from: CUSTOM_KEY, to: "" } },
    { version: 3 }
  );
  assert.ok(
    Array.isArray(rebound.autoRebound)
      && rebound.autoRebound.length
      && (
        rebound.autoRebound[0].slot === "face"
        || /人脸|face/.test(String(rebound.autoRebound[0]))
      ),
    "autoRebound 响应没有列出人脸槽位"
  );
  assert.ok(!JSON.stringify(rebound).includes("custom-secret"));
}

async function assertBackendCrud() {
  const db = helpers.getTestDatabase();
  const store = createMemoryStore();
  const originalCollection = db.collection;
  const originalRunTransaction = db.runTransaction;
  const previousRuntimeSmoke = process.env.ADMIN_RUNTIME_CONFIG_SMOKE;
  const cache = helpers.getAdminRuntimeCache();
  const originalCacheValue = cache.value;
  const originalCacheExpiry = cache.expiresAt;
  process.env.ADMIN_RUNTIME_CONFIG_SMOKE = "1";
  db.collection = store.collection;
  db.runTransaction = async (callback) => callback({ collection: store.collection });
  store.records.set("admin_runtime_config/global", legacyRuntime());
  try {
    const first = await helpers.saveAdminProvider({
      operation: "upsert",
      expectedVersion: 0,
      provider: providerRecord()
    }, ADMIN_CONTEXT);
    assert.strictEqual(first.ok, true, `新增服务商失败：${first.message || "未知错误"}`);
    assert.strictEqual(first.activeProviders.face, "dashscope", "新增服务商不应自动替换当前绑定");
    assert.ok(first.providerRegistry.providers[CUSTOM_KEY]);

    // 模拟历史数据仍以外部 ID 为键；改名事务必须同步搬迁成本、展示标签和 profile。
    const seededRuntime = store.records.get("admin_runtime_config/global");
    seededRuntime.costs = {
      image: {
        providers: {
          [CUSTOM_ID]: {
            perImage: { "1K": 1.23, "2K": 2.34, "4K": 3.45 }
          }
        }
      }
    };
    seededRuntime.providerLabels = {
      [CUSTOM_ID]: "旧 A 名称"
    };
    seededRuntime.providerProfiles = {
      face: {
        [CUSTOM_ID]: {
          provider: CUSTOM_ID,
          model: "face-model",
          baseUrl: "https://api.example.com/v1",
          apiKey: "custom-secret"
        }
      },
      analysis: {},
      image: {},
      imageBackup: {},
      video: {}
    };
    store.records.set("admin_runtime_config/global", seededRuntime);

    const conflict = await helpers.saveAdminProvider({
      operation: "upsert",
      expectedVersion: 0,
      provider: providerRecord({ name: "冲突写入" })
    }, ADMIN_CONTEXT);
    assert.strictEqual(conflict.ok, false);
    assert.strictEqual(conflict.errorCode, "ADMIN_CONFIG_CONFLICT", "版本冲突错误码不统一");

    const duplicate = await helpers.saveAdminProvider({
      operation: "upsert",
      expectedVersion: first.version,
      provider: providerRecord({
        providerKey: "22222222-2222-5222-8222-222222222222",
        id: CUSTOM_ID,
        name: "重复 ID 服务商"
      })
    }, ADMIN_CONTEXT);
    assert.strictEqual(duplicate.ok, false);
    assert.strictEqual(duplicate.errorCode, "PROVIDER_DUPLICATE_ID", "重复 ID 没有被拒绝");

    const renamed = await helpers.saveAdminProvider({
      operation: "upsert",
      expectedVersion: first.version,
      activeProviders: { face: CUSTOM_KEY },
      provider: providerRecord({
        id: RENAMED_ID,
        aliases: [CUSTOM_ID],
        common: { baseUrl: "https://api.example.com/v1", apiKey: "" }
      })
    }, ADMIN_CONTEXT);
    assert.strictEqual(renamed.ok, true, `改名服务商失败：${renamed.message || "未知错误"}`);
    assert.strictEqual(renamed.activeProviders.face, CUSTOM_KEY);
    assert.strictEqual(renamed.provider.providerKey, CUSTOM_KEY);
    assert.ok(renamed.provider.aliases.includes(CUSTOM_ID));
    const renamedRuntime = store.records.get("admin_runtime_config/global");
    const renamedProviderCosts = renamedRuntime.costs
      && renamedRuntime.costs.image
      && renamedRuntime.costs.image.providers
      || {};
    assert.ok(renamedProviderCosts[RENAMED_ID], "改 ID 没有迁移 image provider 成本键");
    assert.strictEqual(renamedProviderCosts[RENAMED_ID].perImage["2K"], 2.34);
    assert.ok(!renamedProviderCosts[CUSTOM_ID], "旧 image provider 成本键仍残留");
    assert.ok(
      renamedRuntime.providerLabels[RENAMED_ID],
      "改 ID 后展示标签没有迁移到新键"
    );
    assert.ok(!renamedRuntime.providerLabels[CUSTOM_ID], "旧 providerLabels 键仍残留");
    assert.ok(
      renamedRuntime.providerProfiles.face
        && renamedRuntime.providerProfiles.face[RENAMED_ID],
      "改 ID 没有迁移 providerProfiles 键"
    );
    assert.ok(!renamedRuntime.providerProfiles.face[CUSTOM_ID], "旧 providerProfiles 键仍残留");
    assert.ok(
      renamedRuntime.providerProfiles.face[RENAMED_ID].apiKey === "custom-secret"
        || renamedRuntime.providerProfiles.face[RENAMED_ID].apiKeyConfigured === true,
      "迁移后的 providerProfiles 没有保留配置状态"
    );

  const secrets = await helpers.getAdminProviderSecrets({ providerKey: CUSTOM_KEY }, ADMIN_CONTEXT);
  assert.strictEqual(secrets.ok, true);
  assert.strictEqual(secrets.common.apiKey, "custom-secret", "管理员秘密接口没有回显完整 Key");
  assert.strictEqual(secrets.capabilities.face.apiKey, "custom-secret");
  const missingSecrets = await helpers.getAdminProviderSecrets({}, ADMIN_CONTEXT);
  assert.strictEqual(missingSecrets.ok, false, "密钥接口不能在省略 providerKey 时返回整个目录");
  assert.strictEqual(missingSecrets.errorCode, "PROVIDER_INVALID");
  const unknownSecrets = await helpers.getAdminProviderSecrets({ providerKey: "missing-provider" }, ADMIN_CONTEXT);
  assert.strictEqual(unknownSecrets.ok, false, "未知 providerKey 不应返回空的成功响应");
  assert.strictEqual(unknownSecrets.errorCode, "PROVIDER_NOT_FOUND");
    const auditRows = helpers.getAdminConfigAuditTestRows
      ? helpers.getAdminConfigAuditTestRows()
      : [];
    assert.ok(
      auditRows.every((row) => !JSON.stringify(row).includes("custom-secret")),
      "管理员审计记录不能写入明文 API Key"
    );

    const bound = await helpers.saveAdminConfig({
    expectedVersion: renamed.version,
      config: {
        // 管理页保存功能卡时只提交 active 绑定，目录档案从事务当前值读取。
        activeProviders: { face: CUSTOM_KEY },
        activeOverrides: { face: { model: "bound-face" } }
      }
    }, ADMIN_CONTEXT);
    assert.strictEqual(bound.ok, true, `saveAdminConfig 绑定自定义服务商失败：${bound.message || "未知错误"}`);
    assert.strictEqual(bound.activeProviders.face, CUSTOM_KEY);
    assert.strictEqual(bound.effective.face.provider, RENAMED_ID);
    assert.strictEqual(bound.effective.face.model, "bound-face");

    const effective = await helpers.resolveEffectiveConfigs({ force: true, cache: false });
    assert.strictEqual(effective.face.provider, RENAMED_ID, "四功能 resolver 没有展开当前服务商档案");
    assert.strictEqual(effective.face.model, "bound-face");

    const deleted = await helpers.saveAdminProvider({
      operation: "delete",
      providerKey: CUSTOM_KEY,
      expectedVersion: bound.version
    }, ADMIN_CONTEXT);
    assert.strictEqual(deleted.ok, true, `删除服务商失败：${deleted.message || "未知错误"}`);
    assert.ok(Array.isArray(deleted.autoRebound));
    assert.strictEqual(deleted.activeProviders.face, "dashscope", "删除后人脸没有按预设回退");
    assert.ok(!deleted.providerRegistry.providers[CUSTOM_KEY]);

    const builtInDelete = await helpers.saveAdminProvider({
      operation: "delete",
      providerKey: "dashscope",
      expectedVersion: deleted.version
    }, ADMIN_CONTEXT);
    assert.strictEqual(builtInDelete.ok, false);
    assert.strictEqual(builtInDelete.errorCode, "PROVIDER_BUILTIN_PROTECTED");
  } finally {
    db.collection = originalCollection;
    db.runTransaction = originalRunTransaction;
    if (previousRuntimeSmoke === undefined) delete process.env.ADMIN_RUNTIME_CONFIG_SMOKE;
    else process.env.ADMIN_RUNTIME_CONFIG_SMOKE = previousRuntimeSmoke;
    // 不让 smoke 的缓存影响同一进程里其他脚本。
    cache.value = originalCacheValue;
    cache.expiresAt = originalCacheExpiry;
  }
}

function assertAdminPageWiring() {
  const pageRoot = path.join(__dirname, "..", "pages", "admin");
  const js = fs.readFileSync(path.join(pageRoot, "admin.js"), "utf8");
  const wxml = fs.readFileSync(path.join(pageRoot, "admin.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(pageRoot, "admin.wxss"), "utf8");
  assert.ok(wxml.includes('data-section="providers"') && wxml.includes("quick-providers"));
  assert.ok(wxml.includes("provider-manager-list") && wxml.includes("provider-manager-form"));
  ["Face", "Analysis", "Image", "ImageBackup", "Video"].forEach((suffix) => {
    assert.ok(wxml.includes(`providerPickerOptions${suffix}`), `${suffix} picker 缺失`);
    assert.ok(js.includes(`providerPickerOptions${suffix}`), `${suffix} picker 状态缺失`);
  });
  ["startAddProvider", "saveProviderDraft", "deleteProviderDraft", "onProviderTabChange", "confirmDiscardProviderDraft"]
    .forEach((method) => assert.ok(js.includes(`${method}(`), `${method} 方法缺失`));
  assert.ok(js.includes("cloud.getAdminProviderSecrets") && js.includes("cloud.saveAdminProvider"));
  assert.ok(wxml.includes("providerDraft.capabilities.image.model"));
  assert.ok(wxml.includes("providerDraft.capabilities.imageBackup.model"), "生图页没有独立备用模型字段");
  assert.ok(!js.includes('{ value: "imageBackup", label: "备用" }'), "顶部页签不应把备用模型拆成第五页");
  assert.ok(js.includes('{ value: "face", label: "人脸" }'));
  assert.ok(js.includes('{ value: "analysis", label: "分析" }'));
  assert.ok(js.includes('{ value: "image", label: "生图" }'));
  assert.ok(js.includes('{ value: "video", label: "视频" }'));
  assert.ok(wxml.includes("未配置") && wxml.includes("自动切换"));
  // B 方案用 picker 替代旧的“按服务商筛选”面板；保留兼容投影断言，
  // 但不要求已经移除的 providerFilter UI/函数重新出现。
  assert.ok(!wxml.includes('class="provider-filter-panel"'), "旧筛选面板不应和目录 picker 并存");
  assert.ok(js.includes("aliasesText") || js.includes("providerRegistry"), "页面仍需保留历史名称兼容字段");
  assert.ok(/backToWorkbench\(\)\s*\{[\s\S]*confirmDiscardProviderDraft/.test(js), "返回工作台前没有保护服务商草稿");
  assert.ok(/onPullDownRefresh\(\)\s*\{[\s\S]*providerDraftHasChanges[\s\S]*confirmDiscardProviderDraft/.test(js), "下拉刷新没有保护服务商草稿");
  assert.ok(/async refreshAll\(\)\s*\{[\s\S]*confirmDiscardProviderDraft[\s\S]*refreshAllNow/.test(js), "刷新全部没有保护服务商草稿");
  assert.ok(js.includes("_providerDraftRequestSeq"), "服务商 Key 请求缺少乱序保护");
  assert.ok(wxss.includes(".provider-manager-layout") && wxss.includes(".provider-list-row"));
  assert.ok(/@media\s*\(max-width:\s*760px\)/.test(wxss));
  assert.ok(/\.provider-manager-layout\s*\{[\s\S]*?min-width:\s*0/.test(wxss));
  assert.ok(/\.provider-manager-editor\s*\{[\s\S]*?overflow:\s*hidden/.test(wxss), "服务商编辑器没有阻止窄屏横向溢出");
  assert.ok(js.includes("provider-save-failed") && js.includes("showError"));
}

async function runOptionalUpstreamSmoke() {
  if (process.env.ADMIN_PROVIDER_UPSTREAM_SMOKE !== "1") return;
  const id = String(process.env.ADMIN_PROVIDER_UPSTREAM_ID || "").trim();
  const capability = String(process.env.ADMIN_PROVIDER_UPSTREAM_CAPABILITY || "").trim().toLowerCase();
  assert.ok(id && /^(face|analysis|image|video)$/.test(capability),
    "上游 smoke 需要 ADMIN_PROVIDER_UPSTREAM_ID 和合法 CAPABILITY");
  // 只读 listModels 探测，不生成媒体、不保存配置、不扣费。
  const result = await api.main({
    action: "listModels",
    modelType: capability,
    provider: id,
    requestId: "admin-provider-upstream-smoke"
  }, ADMIN_CONTEXT);
  assert.ok(result && (result.ok === true || result.errorCode), "上游只读探测没有返回可解析结果");
}

async function main() {
  assertUiPureFunctions();
  assertBackendPureFunctions();
  assertAdminPageWiring();
  await assertBackendCrud();
  await runOptionalUpstreamSmoke();
  console.log("admin-provider-management smoke: OK (migration/inheritance/CRUD/picker/fallback/redaction/responsive)");
}

main().catch((error) => {
  console.error(`admin-provider-management smoke 失败：${error.stack || error.message || error}`);
  process.exitCode = 1;
});
