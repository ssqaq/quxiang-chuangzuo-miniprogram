/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-openid-001";

const apiModule = require("../cloudfunctions/api/index.js");
const test = apiModule.__test;

assert.ok(test, "云函数没有暴露测试接口");
assert.strictEqual(typeof test.buildAdminConfigAuditChanges, "function");
assert.strictEqual(typeof test.writeAdminConfigAuditLog, "function");
assert.strictEqual(typeof test.getAdminConfigAuditLogs, "function");
assert.ok(
  test.requiredDatabaseCollections.includes("admin_config_audit_logs"),
  "配置审计集合没有加入初始化清单"
);

const oldPrimaryKey = "old-lingyun-key-for-smoke";
const existingBackupKey = "existing-lingyun-backup-key";
const nestedSecret = "nested-secret-for-smoke";
const arraySecret = "array-secret-for-smoke";
const previous = {
  version: 7,
  image: {
    provider: "lingyun",
    baseUrl: "https://api.lingyunapi.xyz/v1",
    model: "gpt-image-2",
    apiKey: oldPrimaryKey,
    mode: "edits",
  },
  imageBackup: {
    provider: "lingyun",
    baseUrl: "https://api.lingyunapi.xyz/v1",
    model: "gpt-image-2",
    apiKey: existingBackupKey,
    mode: "edits",
  },
  generationQueue: {
    metadata: {
      token: nestedSecret,
      notes: [{
        apiKey: arraySecret,
        label: "safe-label",
      }],
    },
  },
};

const migrated = test.migrateLegacyImageProviderConfig(
  test.normalizeRuntimePatch(previous),
  previous
);
assert.strictEqual(
  migrated.migrated,
  true,
  "即使已经存在备用配置，旧凌云主配置也必须被纠正"
);
assert.strictEqual(migrated.value.image.provider, "xingju");
assert.strictEqual(migrated.value.image.model, "jw-wy-gpt-image-2");
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(migrated.value.image, "apiKey"),
  false,
  "旧凌云 Key 不能被放进星炬主配置"
);
assert.strictEqual(
  migrated.value.imageBackup.apiKey,
  existingBackupKey,
  "已有凌云备用 Key 必须保留"
);
assert.strictEqual(migrated.value.imageBackup.provider, "lingyun");
assert.strictEqual(migrated.value.imageBackup.model, "gpt-image-2");
assert.strictEqual(migrated.value.imageBackup.timeoutMs, 150000);
assert.strictEqual(migrated.value.imageBackup.maxRetries, 0);

const secondPass = test.migrateLegacyImageProviderConfig(
  test.normalizeRuntimePatch(migrated.value),
  migrated.value
);
assert.strictEqual(secondPass.migrated, false, "配置迁移必须幂等");

const existingXingjuKey = "existing-xingju-primary-key";
const submittedLingyunKey = "submitted-lingyun-primary-key";
const currentXingjuConfig = {
  image: {
    provider: "xingju",
    baseUrl: "https://newapi.akiyo.fun/v1",
    model: "jw-wy-gpt-image-2",
    apiKey: existingXingjuKey,
    mode: "edits",
    timeoutMs: 150000,
    maxRetries: 1,
    retryEnabled: true,
    retryPreferenceVersion: 1,
  },
  imageBackup: {
    provider: "lingyun",
    baseUrl: "https://api.lingyunapi.xyz/v1",
    model: "gpt-image-2",
    apiKey: existingBackupKey,
    mode: "edits",
    timeoutMs: 150000,
    maxRetries: 0,
  },
};
const blankKeyRollbackPatch = test.dropBlankRuntimeApiKeys(
  test.normalizeRuntimePatch({
    image: {
      provider: "lingyun",
      baseUrl: "https://api.lingyunapi.xyz/v1",
      model: "gpt-image-2",
      apiKey: "",
    },
  })
);
const blankKeyRollbackMerged = test.mergeRuntimeConfig(
  currentXingjuConfig,
  blankKeyRollbackPatch
);
const blankKeyRollbackGuard = test.guardAdminImageProviderConfig(
  currentXingjuConfig,
  blankKeyRollbackMerged,
  blankKeyRollbackPatch
);
assert.strictEqual(blankKeyRollbackGuard.corrected, true);
assert.strictEqual(blankKeyRollbackGuard.value.image.provider, "xingju");
assert.strictEqual(blankKeyRollbackGuard.value.image.model, "jw-wy-gpt-image-2");
assert.strictEqual(
  blankKeyRollbackGuard.value.image.apiKey,
  existingXingjuKey,
  "管理员留空 Key 保存旧凌云主配置时，必须保住原星炬主 Key"
);
assert.strictEqual(
  blankKeyRollbackGuard.value.imageBackup.apiKey,
  existingBackupKey,
  "管理员留空 Key 保存旧凌云主配置时，不能把星炬 Key 串到凌云备用"
);

const submittedKeyRollbackPatch = test.normalizeRuntimePatch({
  image: {
    provider: "lingyun",
    baseUrl: "https://api.lingyunapi.xyz/v1",
    model: "gpt-image-2",
    apiKey: submittedLingyunKey,
  },
  imageBackup: {
    apiKey: "",
  },
});
const submittedKeyRollbackMerged = test.mergeRuntimeConfig(
  {
    image: currentXingjuConfig.image,
    imageBackup: Object.assign({}, currentXingjuConfig.imageBackup, {
      apiKey: "",
    }),
  },
  submittedKeyRollbackPatch
);
const submittedKeyRollbackGuard = test.guardAdminImageProviderConfig(
  {
    image: currentXingjuConfig.image,
    imageBackup: Object.assign({}, currentXingjuConfig.imageBackup, {
      apiKey: "",
    }),
  },
  submittedKeyRollbackMerged,
  submittedKeyRollbackPatch
);
assert.strictEqual(submittedKeyRollbackGuard.corrected, true);
assert.strictEqual(
  submittedKeyRollbackGuard.value.image.apiKey,
  existingXingjuKey,
  "误填凌云主 Key 时，原星炬主 Key 必须继续保留"
);
assert.strictEqual(
  submittedKeyRollbackGuard.value.imageBackup.apiKey,
  submittedLingyunKey,
  "误填到主模型栏的凌云 Key 应安全转入凌云备用配置"
);

test.resetAdminConfigAuditTestRows();
const changes = test.buildAdminConfigAuditChanges(
  previous,
  migrated.value,
  {
    image: migrated.value.image,
    imageBackup: migrated.value.imageBackup,
  }
);
const changeText = JSON.stringify(changes);
assert.ok(!changeText.includes(oldPrimaryKey), "审计记录泄露旧主 Key");
assert.ok(!changeText.includes(existingBackupKey), "审计记录泄露备用 Key");
assert.ok(!changeText.includes(nestedSecret), "审计记录泄露嵌套 token");
assert.ok(!changeText.includes(arraySecret), "审计记录泄露数组中的 API Key");
assert.ok(
  changes.some((item) => item.section === "image" && item.field === "provider"),
  "审计记录缺少主模型服务商变化"
);
assert.ok(
  changes.some((item) => item.section === "image" && item.secret),
  "审计记录缺少主 Key 配置状态变化"
);

const providerLabelChanges = test.buildAdminConfigAuditChanges(
  {
    providerLabels: { lingyun: "凌云" },
    image: { apiKey: oldPrimaryKey }
  },
  {
    providerLabels: { lingyun: "凌云官方" },
    image: { apiKey: oldPrimaryKey }
  },
  {
    providerLabels: { lingyun: "凌云官方" }
  }
);
assert.ok(
  providerLabelChanges.some((item) => (
    item.section === "providerLabels"
    && item.field === "lingyun"
    && item.oldValue === "凌云"
    && item.newValue === "凌云官方"
  )),
  "审计记录缺少服务商中文名称变化"
);
assert.ok(
  !JSON.stringify(providerLabelChanges).includes(oldPrimaryKey),
  "服务商名称审计不能泄露同一配置中的 API Key"
);

async function main() {
  const written = await test.writeAdminConfigAuditLog({
    source: "system-auto-correct",
    actorHash: "system",
    configVersion: 8,
    previous,
    next: migrated.value,
    patch: {
      image: migrated.value.image,
      imageBackup: migrated.value.imageBackup,
    },
  });
  assert.strictEqual(written, true);
  const rows = test.getAdminConfigAuditTestRows();
  assert.strictEqual(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(oldPrimaryKey));
  assert.ok(!JSON.stringify(rows).includes(existingBackupKey));
  assert.ok(!JSON.stringify(rows).includes(nestedSecret));
  assert.ok(!JSON.stringify(rows).includes(arraySecret));

  const result = await apiModule.main(
    {
      action: "getAdminConfigAuditLogs",
      requestId: "audit-action-smoke",
      limit: 20,
    },
    { OPENID: "admin-openid-001" }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.logs.length, 1);
  assert.strictEqual(result.logs[0].source, "system-auto-correct");
  assert.ok(!JSON.stringify(result).includes(oldPrimaryKey));
  assert.ok(!JSON.stringify(result).includes(existingBackupKey));
  assert.ok(!JSON.stringify(result).includes(nestedSecret));
  assert.ok(!JSON.stringify(result).includes(arraySecret));

  const forbidden = await apiModule.main(
    {
      action: "getAdminConfigAuditLogs",
      requestId: "audit-forbidden-smoke",
    },
    { OPENID: "normal-openid" }
  );
  assert.strictEqual(forbidden.ok, false);
  assert.strictEqual(forbidden.errorCode, "ADMIN_FORBIDDEN");
  console.log("admin config audit smoke: OK");
}

main().catch((error) => {
  console.error(`admin config audit smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
