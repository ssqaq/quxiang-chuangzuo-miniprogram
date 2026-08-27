/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-openid-001, admin-openid-002";

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

assert.ok(test, "云函数没有暴露管理员测试接口");
assert.deepStrictEqual(test.adminOpenIds(), [
  "admin-openid-001",
  "admin-openid-002"
]);

const previousImageRetryEnabled = process.env.AI_IMAGE_RETRY_ENABLED;
delete process.env.AI_IMAGE_RETRY_ENABLED;
assert.strictEqual(
  test.resolveImageConfig().retryEnabled,
  true,
  "未配置 AI_IMAGE_RETRY_ENABLED 时，生图自动重试默认必须开启"
);
assert.strictEqual(
  test.resolveImageConfig({ image: { retryEnabled: false } }).retryEnabled,
  true,
  "没有新标记的旧管理员配置必须迁移为开启自动重试"
);
assert.strictEqual(
  test.resolveImageConfig({
    image: { retryEnabled: false, retryPreferenceVersion: 1 }
  }).retryEnabled,
  false,
  "新版管理员明确关闭自动重试后必须保持关闭"
);
assert.strictEqual(
  test.resolveImageConfig({
    image: { retryEnabled: true, retryPreferenceVersion: 1 }
  }).retryPreferenceVersion,
  1,
  "新版自动重试偏好标记必须保留"
);
process.env.AI_IMAGE_RETRY_ENABLED = "false";
assert.strictEqual(
  test.resolveImageConfig().retryEnabled,
  false,
  "显式关闭 AI_IMAGE_RETRY_ENABLED 后，生图自动重试必须关闭"
);
process.env.AI_IMAGE_RETRY_ENABLED = "true";
assert.strictEqual(
  test.resolveImageConfig().retryEnabled,
  true,
  "显式开启 AI_IMAGE_RETRY_ENABLED 后，生图自动重试必须开启"
);
if (previousImageRetryEnabled === undefined) {
  delete process.env.AI_IMAGE_RETRY_ENABLED;
} else {
  process.env.AI_IMAGE_RETRY_ENABLED = previousImageRetryEnabled;
}

assert.strictEqual(
  test.isAdminContext({ OPENID: "admin-openid-001" }),
  true
);
process.env.ADMIN_OPENIDS += `, ${test.usageUserHash("hash-admin-openid")}`;
assert.strictEqual(
  test.isAdminContext({ OPENID: "hash-admin-openid" }),
  true
);
assert.strictEqual(
  test.isAdminContext({ OPENID: "normal-openid" }),
  false
);
assert.strictEqual(
  test.isAdminContext({ OPENID: "anonymous" }),
  false
);

const patch = test.normalizeRuntimePatch({
  image: {
    model: "smoke-image-model",
    apiKey: "smoke-image-key"
  },
  video: {
    model: "smoke-video-model",
    apiKey: "smoke-video-key"
  },
  analysis: {
    provider: "smoke-analysis-provider",
    model: "smoke-analysis-model",
    timeoutMs: 18000,
    apiKey: "smoke-analysis-key"
  },
  face: {
    apiKey: "smoke-face-key"
  },
  apiKey: "must-be-dropped"
});
assert.deepStrictEqual(patch.image, {
  model: "smoke-image-model",
  apiKey: "smoke-image-key"
});
assert.deepStrictEqual(
  test.normalizeRuntimePatch({
    image: {
      retryEnabled: false,
      retryPreferenceVersion: 0
    }
  }).image,
  {
    retryEnabled: false,
    retryPreferenceVersion: 0
  },
  "配置规范化必须保留重试偏好字段，交给保存入口统一升级标记"
);
const retryPatch = test.normalizeRuntimePatch({
  image: {
    retryEnabled: false
  }
});
retryPatch.image.retryPreferenceVersion = 1;
assert.strictEqual(
  test.resolveImageConfig({ image: retryPatch.image }).retryEnabled,
  false,
  "管理员保存后的 false + 版本标记必须被后端尊重"
);
const migrated = test.migrateLegacyImageRetryConfig(
  test.normalizeRuntimePatch({
    image: { retryEnabled: false }
  }),
  { image: { retryEnabled: false } }
);
assert.strictEqual(migrated.migrated, true);
assert.strictEqual(migrated.value.image.retryEnabled, true);
assert.strictEqual(migrated.value.image.retryPreferenceVersion, 1);
const alreadyConfigured = test.migrateLegacyImageRetryConfig(
  test.normalizeRuntimePatch({
    image: { retryEnabled: false, retryPreferenceVersion: 1 }
  }),
  { image: { retryEnabled: false, retryPreferenceVersion: 1 } }
);
assert.strictEqual(alreadyConfigured.migrated, false);
assert.strictEqual(alreadyConfigured.value.image.retryEnabled, false);
assert.deepStrictEqual(patch.video, {
  model: "smoke-video-model",
  apiKey: "smoke-video-key"
});
assert.deepStrictEqual(patch.analysis, {
  provider: "smoke-analysis-provider",
  model: "smoke-analysis-model",
  timeoutMs: 18000,
  apiKey: "smoke-analysis-key"
});
assert.deepStrictEqual(patch.face, { apiKey: "smoke-face-key" });
assert.deepStrictEqual(test.validateRuntimePatch(patch), []);
assert.deepStrictEqual(
  test.normalizeRuntimePatch({
    providerLabels: {
      lingyun: "凌云官方",
      "custom-provider": "自定义服务商"
    }
  }).providerLabels,
  {
    "custom-provider": "自定义服务商",
    lingyun: "凌云官方"
  }
);
assert.ok(
  test.validateRuntimePatch({
    providerLabels: {
      "custom-provider": "custom provider"
    }
  }).some((item) => item.includes("custom-provider")),
  "管理员配置校验必须拒绝没有中文名称的服务商"
);
const blankKeyPatch = test.dropBlankRuntimeApiKeys(
  test.normalizeRuntimePatch({
    image: {
      apiKey: "",
      model: "new-image"
    },
    imageBackup: {
      apiKey: "   ",
      model: "new-backup-image"
    }
  })
);
const blankKeyMerged = test.mergeRuntimeConfig(
  {
    image: {
      apiKey: "existing-primary-key",
      model: "old-image"
    },
    imageBackup: {
      apiKey: "existing-backup-key",
      model: "old-backup-image"
    }
  },
  blankKeyPatch
);
assert.strictEqual(
  blankKeyMerged.image.apiKey,
  "existing-primary-key",
  "主模型 API Key 留空保存时必须继续使用原密钥"
);
assert.strictEqual(
  blankKeyMerged.imageBackup.apiKey,
  "existing-backup-key",
  "备用模型 API Key 留空保存时必须继续使用原密钥"
);
assert.strictEqual(blankKeyMerged.image.model, "new-image");
assert.strictEqual(blankKeyMerged.imageBackup.model, "new-backup-image");
assert.ok(test.validateRuntimePatch({
  image: { mode: "not-supported" }
}).length > 0);
const independentBackupConfig = test.resolveImageBackupConfig({
  image: {
    provider: "xingju",
    model: "primary-image-model",
    size: "1080x1440",
    resolution: "1K",
    mode: "edits",
    timeoutMs: 150000
  },
  imageBackup: {
    provider: "lingyun",
    model: "backup-image-model",
    size: "1242x1660",
    resolution: "4K",
    mode: "edits",
    timeoutMs: 60000
  }
});
assert.strictEqual(independentBackupConfig.size, "1242x1660");
assert.strictEqual(independentBackupConfig.resolution, "4K");
assert.strictEqual(independentBackupConfig.timeoutMs, 60000);
assert.strictEqual(independentBackupConfig.model, "backup-image-model");
assert.ok(test.validateRuntimePatch({
  video: { baseUrl: "javascript:alert(1)" }
}).length > 0);
assert.ok(test.validateRuntimePatch({
  analysis: { timeoutMs: 4999 }
}).length > 0);
assert.ok(test.validateRuntimePatch({
  analysis: { endpoint: "javascript:alert(1)" }
}).length > 0);

const merged = test.mergeRuntimeConfig(
  {
    face: { model: "face-model" },
    analysis: { model: "old-analysis" },
    image: { model: "old-image" },
    video: { resolution: "480p" }
  },
  {
    analysis: { model: "new-analysis" },
    image: { model: "new-image" },
    video: { timeoutMs: 120000 }
  }
);
assert.strictEqual(merged.image.model, "new-image");
assert.strictEqual(merged.face.model, "face-model");
assert.strictEqual(merged.analysis.model, "new-analysis");
assert.strictEqual(merged.video.resolution, "480p");
assert.strictEqual(merged.video.timeoutMs, 120000);

api.main({
  action: "getAdminStatus",
  requestId: "admin-smoke-status"
}, { OPENID: "admin-openid-001" }).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isAdmin, true);
  assert.ok(result.buildVersion);
  assert.ok(result.buildMarker);
  assert.strictEqual(result.identityHash, test.usageUserHash("admin-openid-001"));
  return api.main({
    action: "getAdminConfig",
    requestId: "admin-smoke-config"
  }, { OPENID: "admin-openid-001" });
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.admin, true);
  assert.ok(result.effective.face.model);
  assert.ok(result.effective.analysis.model);
  assert.ok(result.effective.image.model);
  assert.ok(result.effective.video.model);
  assert.deepStrictEqual(result.effective.providerLabels, {
    dashscope: "阿里云百炼",
    lingyun: "凌云",
    xingju: "星炬"
  });
  ["face", "analysis", "image", "imageBackup", "video"].forEach((type) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(result.effective[type], "apiKey"),
      true
    );
  });
  return api.main({
    action: "checkDeployment",
    requestId: "admin-smoke-deployment"
  }, { OPENID: "admin-openid-001" });
}).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.ok(result.buildVersion);
  assert.ok(result.buildMarker);
  assert.strictEqual(result.logWritten, true);
  return api.main({
    action: "getAdminConfig",
    requestId: "admin-smoke-forbidden"
  }, { OPENID: "normal-openid" });
}).then((result) => {
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorCode, "ADMIN_FORBIDDEN");
  console.log("admin-config smoke: OK (allowlist/validation/secret-filter/forbidden)");
}).catch((error) => {
  console.error(`admin-config smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
