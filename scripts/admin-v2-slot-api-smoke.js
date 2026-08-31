/* eslint-disable no-console */

// V2 slot 原子保存和凭证逐字段合并专项 smoke。不连接云开发、不写数据库。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
const api = require("../cloudfunctions/api/index");
const test = api.__test;

function testSecretPatchContract() {
  const patch = test.v2SecretPatch({
    providerKey: "provider-a",
    credentials: {
      apiKey: "",
      secretId: " next-id ",
      secretKey: "stale-key",
      clearApiKey: true,
      clearSecretKey: true
    },
    credentialsDirty: {
      apiKey: true,
      secretId: true,
      secretKey: false
    }
  }, "provider-a");
  assert.strictEqual(patch.key, "provider-a");
  assert.deepStrictEqual(patch.secret, { secretId: "next-id" }, "空串和未标 dirty 的字段必须 omit");
  assert.deepStrictEqual(patch.clear, {
    clearCredentials: false,
    fields: { apiKey: true, secretKey: true }
  });
  assert.strictEqual(patch.hasMutation, true);

  const empty = test.v2SecretPatch({
    providerKey: "provider-a",
    credentials: { apiKey: "", secretId: "", secretKey: "" }
  }, "provider-a");
  assert.deepStrictEqual(empty.secret, {});
  assert.strictEqual(empty.hasMutation, false, "空 secret 不能被解释为清除或覆盖");
}

function testSecretMergeContract() {
  const current = {
    "provider-a": { apiKey: "old-key", secretId: "old-id", secretKey: "old-secret" },
    "provider-b": { apiKey: "keep-other-provider" }
  };
  const fieldClear = test.v2MergeSecrets(
    current,
    { apiKey: "new-key", secretId: "new-id" },
    "provider-a",
    { clearCredentials: false, fields: { apiKey: true, secretKey: true } }
  );
  assert.deepStrictEqual(fieldClear["provider-a"], { secretId: "new-id" }, "显式 clear 必须优先于同请求里的旧字段值");
  assert.strictEqual(fieldClear["provider-b"].apiKey, "keep-other-provider");
  assert.strictEqual(Array.isArray(fieldClear), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(fieldClear, "secrets"), false, "providerSecretsV2 必须保持 providerKey 对象映射");

  const omittedEmpty = test.v2MergeSecrets(current, { apiKey: "" }, "provider-a", {});
  assert.deepStrictEqual(omittedEmpty["provider-a"], current["provider-a"], "空字符串必须保留旧凭证");
  const clearAll = test.v2MergeSecrets(current, {}, "provider-a", { clearCredentials: true, fields: {} });
  assert.strictEqual(clearAll["provider-a"], undefined);
  assert.strictEqual(clearAll["provider-b"].apiKey, "keep-other-provider");
}

function testAtomicEndpointShape() {
  const source = test.saveAdminSlotV2.toString();
  assert.strictEqual((source.match(/db\.runTransaction/g) || []).length, 1, "slot action 只能开启一个事务");
  assert.strictEqual((source.match(/ref\.set/g) || []).length, 1, "slot action 只能写一次根文档");
  assert.ok(source.includes("expected === null"), "slot action 必须要求 expectedVersion");
  assert.ok(source.includes('["primary", "backup"]'), "slot action 必须校验最终主备两条 binding");
  const cloudSource = fs.readFileSync(path.join(__dirname, "..", "services", "cloud.js"), "utf8");
  assert.ok(cloudSource.includes('action: "saveAdminSlotV2"'));
  ["clearApiKey", "clearSecretId", "clearSecretKey", "clearCredentials"].forEach((field) => {
    assert.ok(cloudSource.includes(`${field}: source.${field}`), `cloud wrapper 必须转发 ${field}`);
  });
  const apiSource = fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "api", "index.js"), "utf8");
  assert.ok(apiSource.includes('action === "saveAdminSlotV2"'), "router 必须注册 saveAdminSlotV2");
}

function testV2AuditContract() {
  const before = {
    providerConfigV2: { version: 7, bindings: [{ slot: "image.generate", status: "not-ready" }] },
    providerSecretsV2: { "provider-a": { apiKey: "old-key", secretId: "keep-id" } }
  };
  const after = {
    providerConfigV2: { version: 8, bindings: [{ slot: "image.generate", status: "ready" }] },
    providerSecretsV2: { "provider-a": { apiKey: "new-key", secretId: "keep-id" } }
  };
  const changes = test.buildAdminConfigAuditChanges(before, after, {});
  assert.ok(changes.some((item) => item.section === "providerConfigV2"), "V2 配置变化必须进入审计");
  const secretChange = changes.find((item) => (
    item.section === "providerSecretsV2"
    && item.field === "apiKey"
  ));
  assert.deepStrictEqual(secretChange, {
    section: "providerSecretsV2",
    field: "apiKey",
    secret: true,
    configuredBefore: true,
    configuredAfter: true,
    updated: true
  }, "Key 轮换必须只记录状态变化，不得遗漏或写入明文");
  const serialized = JSON.stringify(changes);
  assert.strictEqual(serialized.includes("old-key"), false);
  assert.strictEqual(serialized.includes("new-key"), false);

  const row = test.normalizeAdminConfigAuditRow({
    source: "admin-slot-v2",
    changes
  });
  assert.strictEqual(row.source, "admin-slot-v2", "V2 审计来源不能被压成 admin-save");
}

testSecretPatchContract();
testSecretMergeContract();
testAtomicEndpointShape();
testV2AuditContract();
console.log("admin-v2-slot-api-smoke: PASS (atomic-slot/secret-dirty/field-clear/object-map/router/audit)");
