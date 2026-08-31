/* eslint-disable no-console */

// V2 配置纯数据层专项 smoke。不连接云开发、不写数据库、不改页面。
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const v2 = require("../services/admin-config-v2");

function expectCode(fn, code) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, `应抛出 ${code}`);
  assert.strictEqual(caught.code, code, `错误码应为 ${code}`);
}

function legacyFixture() {
  return {
    version: 3,
    providerRegistry: {
      providers: {
        dashscope: {
          providerKey: "dashscope",
          id: "dashscope",
          name: "阿里云百炼",
          common: { baseUrl: "https://dash.example/v1", apiKey: "legacy-face-key" }
        },
        xingju: {
          providerKey: "xingju",
          id: "xingju",
          name: "星炬",
          common: { baseUrl: "https://xing.example/v1", apiKey: "legacy-image-key" }
        },
        lingyun: {
          providerKey: "lingyun",
          id: "lingyun",
          name: "凌云",
          common: { baseUrl: "https://ling.example/v1", apiKey: "legacy-backup-key" }
        }
      }
    },
    face: { provider: "dashscope", model: "face-v1", baseUrl: "https://dash.example/v1", apiKey: "face-key" },
    analysis: { provider: "dashscope", model: "vision-v1", baseUrl: "https://dash.example/v1", apiKey: "analysis-key" },
    image: { provider: "xingju", model: "image-v1", baseUrl: "https://xing.example/v1", apiKey: "image-key" },
    imageBackup: { provider: "lingyun", model: "image-backup", baseUrl: "https://ling.example/v1", apiKey: "backup-key" },
    video: { provider: "xingju", model: "old-video", baseUrl: "https://xing.example/v1", apiKey: "old-video-key" },
    advanced: {
      video: { provider: "xingju", model: "old-video", timeoutMs: 90000, apiKey: "old-video-key" },
      sharedVideo: { provider: "xingju", model: "shared-video", baseUrl: "https://xing.example/v1", apiKey: "shared-key" }
    }
  };
}

function testSchemaAndMigration() {
  assert.deepStrictEqual(v2.SLOTS, [
    "standard.face", "standard.imageAnalysis", "standard.styleAnalysis", "standard.imageGeneration",
    "tencent.face", "tencent.imageAnalysis", "tencent.styleAnalysis", "tencent.imageGeneration",
    "shared.video"
  ]);
  const source = legacyFixture();
  const migrated = v2.migrateLegacyToV2(source, { now: "2026-08-31T00:00:00.000Z" });
  assert.strictEqual(migrated.schemaVersion, 2);
  assert.strictEqual(migrated.bindings.filter((item) => item.role === "primary").length, 9);
  assert.strictEqual(migrated.bindings.find((item) => item.slot === "standard.imageAnalysis").modelId, "vision-v1");
  assert.strictEqual(migrated.bindings.find((item) => item.slot === "standard.styleAnalysis").status, "not-ready");
  assert.strictEqual(migrated.bindings.find((item) => item.slot === "tencent.face").status, "not-ready");
  assert.strictEqual(migrated.bindings.find((item) => item.slot === "shared.video").modelId, "shared-video");
  assert.strictEqual(migrated.legacyAliases.video.model, "old-video");
  assert.strictEqual(migrated.dependencies.tencentFaceFusion.protocol, "tencent-tc3");
  const serialized = JSON.stringify(migrated);
  assert.ok(!serialized.includes("legacy-face-key") && !serialized.includes("shared-key"), "迁移结果不能带明文 Key");
  const again = v2.migrateLegacyToV2(migrated, { now: "2026-08-31T00:00:00.000Z" });
  assert.deepStrictEqual(again, migrated, "V2 重复迁移必须幂等");
  assert.strictEqual(v2.validateV2Config(migrated).valid, true);
  const uuidKey = v2.migrateLegacyToV2({
    providerRegistry: {
      providers: {
        "immutable-provider-key": { providerKey: "immutable-provider-key", id: "dashscope", name: "百炼" }
      }
    },
    face: { provider: "dashscope", model: "face-v1", endpoint: "https://dash.example/v1" }
  }, { now: "2026-08-31T00:00:00.000Z" });
  assert.strictEqual(
    uuidKey.bindings.find((item) => item.slot === "standard.face").providerKey,
    "immutable-provider-key",
    "迁移必须把旧 provider id/name 解析为不可变 providerKey"
  );
  const nameKey = v2.migrateLegacyToV2({
    providerRegistry: {
      providers: {
        "immutable-provider-key": { providerKey: "immutable-provider-key", id: "dashscope", name: "百炼" }
      }
    },
    face: { provider: "百炼", model: "face-v1", endpoint: "https://dash.example/v1" }
  }, { now: "2026-08-31T00:00:00.000Z" });
  assert.strictEqual(
    nameKey.bindings.find((item) => item.slot === "standard.face").providerKey,
    "immutable-provider-key",
    "迁移也必须按供应商中文名解析不可变 providerKey"
  );
  return migrated;
}

function readyFixture() {
  let config = v2.emptyV2Config();
  config = v2.applySupplierMutation(config, {
    action: "create",
    supplier: {
      providerKey: "provider-a",
      id: "provider-a",
      name: "供应商 A",
      endpoint: "https://a.example/v1",
      auth: { protocol: "openai", credentialRef: "cred-a" }
    }
  }, { expectedVersion: 1 });
  config = v2.confirmModels(config, [
    { providerKey: "provider-a", modelId: "model-main", capabilities: ["face"] },
    { providerKey: "provider-a", modelId: "model-backup", capabilities: ["face"] }
  ], { expectedVersion: config.version, now: "2026-08-31T00:00:00.000Z", confirmedBy: "smoke" });
  config = v2.transitionBinding(config, {
    slot: "standard.face", role: "primary", providerKey: "provider-a", modelId: "model-main",
    status: "ready", confirmed: true
  }, { expectedVersion: config.version, now: "2026-08-31T00:00:00.000Z" });
  config = v2.transitionBinding(config, {
    slot: "standard.face", role: "backup", providerKey: "provider-a", modelId: "model-backup",
    status: "ready", confirmed: true
  }, { expectedVersion: config.version, now: "2026-08-31T00:00:00.000Z" });
  return config;
}

function testConfirmationAndFailover() {
  const config = readyFixture();
  const primary = v2.resolveBinding(config, "standard.face", "primary");
  assert.strictEqual(primary.usable, true);
  assert.strictEqual(primary.modelId, "model-main");
  const first = v2.resolveFailover(config, "standard.face", { primaryFailed: true });
  assert.strictEqual(first.switched, true);
  assert.strictEqual(first.role, "backup");
  assert.strictEqual(first.selected.modelId, "model-backup");
  const second = v2.resolveFailover(config, "standard.face", { primaryFailed: true, fallbackUsed: true });
  assert.strictEqual(second.switched, false);
  assert.strictEqual(second.exhausted, true);
  assert.strictEqual(v2.resolveFailover(config, "standard.imageAnalysis", { primaryFailed: true }).selected, null);
  let unconfirmed = v2.emptyV2Config();
  unconfirmed = v2.applySupplierMutation(unconfirmed, {
    action: "create", supplier: { providerKey: "p", name: "P", endpoint: "https://p.example" }
  }, { expectedVersion: 1 });
  unconfirmed = v2.normalizeV2Config(Object.assign({}, unconfirmed, {
    supplierModels: [{ providerKey: "p", modelId: "m", confirmed: false }]
  }));
  expectCode(() => v2.transitionBinding(unconfirmed, {
    slot: "standard.face", role: "primary", providerKey: "p", modelId: "m", status: "ready"
  }, { expectedVersion: unconfirmed.version }), "BINDING_NOT_READY");
}

function testCrudCasAndGuards() {
  const config = readyFixture();
  const cleared = v2.transitionBinding(config, {
    slot: "standard.face",
    role: "backup",
    providerKey: "",
    modelId: "",
    status: "not-ready",
    confirmed: true
  }, { expectedVersion: config.version });
  const clearedBackup = cleared.bindings.find(item => item.slot === "standard.face" && item.role === "backup");
  assert.strictEqual(clearedBackup.providerKey, "", "显式停用备用模型时不能回填旧供应商");
  assert.strictEqual(clearedBackup.modelId, "", "显式停用备用模型时不能回填旧模型");
  assert.strictEqual(clearedBackup.status, "not-ready");
  const guard = v2.canDeleteSupplier(config, "provider-a");
  assert.strictEqual(guard.allowed, false);
  assert.strictEqual(guard.reason, "PROVIDER_REFERENCED");
  expectCode(() => v2.applySupplierMutation(config, { action: "delete", providerKey: "provider-a", expectedVersion: config.version }), "PROVIDER_REFERENCED");
  expectCode(() => v2.applySupplierMutation(config, {
    action: "update", providerKey: "provider-a", supplier: { providerKey: "provider-b", name: "改 key" }, expectedVersion: config.version
  }), "PROVIDER_KEY_IMMUTABLE");
  expectCode(() => v2.confirmModels(config, { providerKey: "provider-a", modelId: "x" }, { expectedVersion: 999 }), "VERSION_CONFLICT");
  const emptyModelRef = v2.normalizeV2Config(Object.assign({}, config, {
    bindings: config.bindings.concat([{
      slot: "standard.imageAnalysis", role: "primary", providerKey: "provider-a", modelId: "", status: "not-ready"
    }])
  }));
  assert.strictEqual(v2.canDeleteSupplier(emptyModelRef, "provider-a").allowed, false, "空模型绑定也必须阻断删除供应商");
  let free = v2.emptyV2Config();
  free = v2.applySupplierMutation(free, { action: "create", supplier: { providerKey: "free", name: "Free" } }, { expectedVersion: 1 });
  assert.strictEqual(v2.canDeleteSupplier(free, "free").allowed, true);
  free = v2.applySupplierMutation(free, { action: "delete", providerKey: "free", expectedVersion: free.version });
  assert.strictEqual(free.suppliers.length, 0);
}

function testAtomicSlotTransition() {
  const config = readyFixture();
  const previousPrimary = config.bindings.find((item) => item.slot === "standard.face" && item.role === "primary");
  previousPrimary.metadata = {
    preserved: { nested: true },
    advanced: { mode: "legacy-mode", customFlag: "keep-me" }
  };
  previousPrimary.futureBindingField = { nested: "keep-future-shape" };
  const previousBackup = config.bindings.find((item) => item.slot === "standard.face" && item.role === "backup");
  const next = v2.transitionSlot(config, {
    slot: "standard.face",
    primaryPatch: {
      providerKey: "provider-a",
      modelId: "model-main",
      status: "ready",
      confirmed: true,
      metadata: { path: "/v1/faces", preserved: { added: true } }
    },
    backupPatch: {
      providerKey: "provider-a",
      modelId: "model-backup",
      status: "not-ready",
      confirmed: true
    },
    advancedPatch: { mode: "edits", size: "1080x1440", apiKey: "must-not-persist" }
  }, {
    expectedVersion: config.version,
    now: "2026-08-31T00:00:00.000Z",
    confirmedBy: "smoke"
  });
  assert.strictEqual(next.version, config.version + 1, "一次 slot mutation 只能增加一次根版本");
  const primary = next.bindings.find((item) => item.slot === "standard.face" && item.role === "primary");
  const backup = next.bindings.find((item) => item.slot === "standard.face" && item.role === "backup");
  assert.strictEqual(primary.version, previousPrimary.version + 1);
  assert.deepStrictEqual(primary.futureBindingField, { nested: "keep-future-shape" }, "未知 binding 字段必须保留");
  assert.strictEqual(backup.version, previousBackup.version + 1);
  assert.deepStrictEqual(primary.metadata.preserved, { nested: true, added: true }, "metadata 未提交字段必须保留");
  assert.deepStrictEqual(primary.metadata.advanced, {
    mode: "edits",
    customFlag: "keep-me",
    size: "1080x1440"
  }, "advanced 必须深合并到 primary metadata");
  assert.strictEqual(JSON.stringify(primary.metadata).includes("must-not-persist"), false, "advanced 不能持久化明文 Key");
  assert.strictEqual(backup.status, "not-ready");
  assert.strictEqual(backup.providerKey, "provider-a", "关闭备用必须保留供应商");
  assert.strictEqual(backup.modelId, "model-backup", "关闭备用必须保留模型");
  assert.deepStrictEqual(backup.metadata, previousBackup.metadata, "advanced 不能写入 backup metadata");

  const advancedOnly = v2.transitionSlot(next, {
    slot: "standard.face",
    advancedPatch: { size: "1440x1080" }
  }, { expectedVersion: next.version });
  const advancedPrimary = advancedOnly.bindings.find((item) => item.slot === "standard.face" && item.role === "primary");
  assert.strictEqual(advancedOnly.version, next.version + 1);
  assert.strictEqual(advancedPrimary.metadata.advanced.mode, "edits");
  assert.strictEqual(advancedPrimary.metadata.advanced.customFlag, "keep-me");
  assert.strictEqual(advancedPrimary.metadata.advanced.size, "1440x1080");
  expectCode(() => v2.transitionSlot(next, {
    slot: "standard.face",
    backupPatch: { status: "disabled" }
  }, { expectedVersion: next.version }), "BINDING_STATUS_INVALID");
  expectCode(() => v2.transitionSlot(next, {
    slot: "standard.face",
    primaryPatch: { status: "not-ready" }
  }, { expectedVersion: 999 }), "VERSION_CONFLICT");
  assert.strictEqual(v2.validateV2Config(next).valid, true);
}

function testTc3AndPixelPolicy() {
  const config = v2.normalizeV2Config({
    schemaVersion: 2,
    suppliers: [{
      providerKey: "tencent", id: "tencent", name: "腾讯", endpoint: "https://tencent.example",
      auth: { protocol: "tencent-tc3", credentialRef: "tc3-ref", extra: {
        secretIdRef: "sid-ref", secretKeyRef: "skey-ref", region: "ap-guangzhou", action: "DetectFace", version: "2023-03-01"
      } },
      apiKey: "must-not-copy"
    }],
    supplierModels: [{ providerKey: "tencent", modelId: "face", confirmed: true }],
    bindings: [],
    safetyProbes: [{ providerKey: "tencent", modelId: "face", path: "/safe", result: "pass", serverVerified: true, allowed: true }]
  });
  const supplierText = JSON.stringify(config.suppliers[0]);
  assert.ok(!supplierText.includes("apiKey") && !supplierText.includes("must-not-copy"));
  assert.strictEqual(config.suppliers[0].auth.protocol, "tencent-tc3");
  const denied = v2.computePixelPolicy({ providerKey: "tencent", modelId: "face", path: "/other", allowed: true }, config.safetyProbes);
  assert.strictEqual(denied.allowed, false, "客户端 allowed 不能直接放行");
  const accepted = v2.computePixelPolicy({ providerKey: "tencent", modelId: "face", path: "/safe" }, config.safetyProbes);
  assert.strictEqual(accepted.allowed, true);
  assert.strictEqual(v2.validateV2Config(config).valid, true);
}

function testEncodingAndCloudCopy() {
  const local = path.join(__dirname, "..", "services", "admin-config-v2.js");
  const cloud = path.join(__dirname, "..", "cloudfunctions", "api", "lib", "admin-config-v2.js");
  assert.ok(fs.readFileSync(local).includes("人脸识别"), "主模块必须是 UTF-8 中文");
  assert.strictEqual(fs.readFileSync(local, "utf8"), fs.readFileSync(cloud, "utf8"), "云函数副本必须与主模块一致");
}

testSchemaAndMigration();
testConfirmationAndFailover();
testCrudCasAndGuards();
testAtomicSlotTransition();
testTc3AndPixelPolicy();
testEncodingAndCloudCopy();
console.log("admin-config-v2-smoke: PASS (schema/migration/confirm/failover/atomic-slot/CAS/guard/TC3/pixel/encoding)");
