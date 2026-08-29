/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");

(async () => {

const configs = {
  image: {
    provider: "primary-provider",
    baseUrl: "https://primary.example/v1",
    apiKey: "primary-secret",
    model: "primary-model",
    timeoutMs: 150000
  },
  imageBackup: {
    provider: "backup-provider",
    baseUrl: "https://backup.example/v1",
    apiKey: "backup-secret",
    model: "backup-model",
    timeoutMs: 60000
  }
};

const backup = api.__test.temporaryModelConfig(configs, "image", {
  configTarget: "imageBackup",
  provider: "backup-provider-updated",
  model: "backup-model-updated",
  apiKey: ""
});

assert.strictEqual(backup.provider, "backup-provider-updated");
assert.strictEqual(backup.model, "backup-model-updated");
assert.strictEqual(
  backup.apiKey,
  configs.imageBackup.apiKey,
  "备用按钮留空密钥时必须沿用备用密钥，不能误用主模型密钥"
);
assert.notStrictEqual(backup.apiKey, configs.image.apiKey);

const primary = api.__test.temporaryModelConfig(configs, "image", {
  configTarget: "image",
  provider: "primary-provider-updated",
  apiKey: ""
});

assert.strictEqual(primary.provider, "primary-provider-updated");
assert.strictEqual(primary.apiKey, configs.image.apiKey);

// 视觉备用槽位复用目录档案，但必须保留独立的稳定 key、模型和 Key，
// 不能因为兼容投影再次掉回主槽位。
const primaryKey = "11111111-1111-5111-8111-111111111111";
const backupKey = "22222222-2222-5222-8222-222222222222";
const primaryRecord = api.__test.normalizeProviderRecord({
  providerKey: primaryKey,
  id: "vision-primary",
  name: "视觉主档案",
  baseUrl: "https://vision-primary.example/v1",
  apiKey: "vision-primary-key",
  overrides: {
    face: { model: "vision-primary-face" },
    analysis: { model: "vision-primary-analysis" },
    video: { model: "vision-primary-video", createPath: "/v1/videos", queryPath: "/v1/videos/{taskId}" }
  }
}, primaryKey, { includePreset: false });
const backupRecord = api.__test.normalizeProviderRecord({
  providerKey: backupKey,
  id: "vision-backup",
  name: "视觉备用档案",
  baseUrl: "https://vision-backup.example/v1",
  apiKey: "vision-backup-key",
  overrides: {
    face: { model: "vision-backup-face" },
    analysis: { model: "vision-backup-analysis" },
    video: { model: "vision-backup-video", createPath: "/v1/videos", queryPath: "/v1/videos/{taskId}" }
  }
}, backupKey, { includePreset: false });
const registry = api.__test.normalizeProviderRegistry({
  providers: { [primaryKey]: primaryRecord, [backupKey]: backupRecord }
}, { includeDefaults: false });
const runtime = {
  providerRegistry: registry,
  activeProviders: { face: primaryKey, analysis: primaryKey, video: primaryKey },
  activeBackups: { faceBackup: backupKey, analysisBackup: backupKey, videoBackup: backupKey },
  faceBackup: { enabled: true },
  analysisBackup: { enabled: true },
  videoBackup: { enabled: true }
};
const projected = api.__test.buildLegacyProjectionFromProviderRegistry(runtime);
const faceBackup = api.__test.resolveFaceBackupConfig(projected.faceBackup, runtime);
const analysisBackup = api.__test.resolveAnalysisBackupConfig(projected.analysisBackup, runtime);
assert.strictEqual(faceBackup.providerKey, backupKey);
assert.strictEqual(faceBackup.model, "vision-backup-face");
assert.strictEqual(faceBackup.apiKey, "vision-backup-key");
assert.strictEqual(analysisBackup.providerKey, backupKey);
assert.strictEqual(analysisBackup.model, "vision-backup-analysis");
assert.strictEqual(projected.videoBackup.providerKey, backupKey);

const candidates = api.__test.visionConfigCandidatesForAction("detectFaceCircle", {
  face: {
    provider: "vision-primary",
    providerKey: primaryKey,
    baseUrl: "https://vision-primary.example/v1",
    apiKey: "vision-primary-key",
    model: "vision-primary-face"
  },
  faceBackup
});
assert.strictEqual(candidates.length, 2, "人脸主备没有展开成两个调用候选");
assert.strictEqual(candidates[1].providerKey, backupKey);

let attempts = 0;
const failover = await api.__test.runVisionProviderFailover(
  candidates,
  async (candidate) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("temporary");
      error.status = 503;
      error.retryable = true;
      throw error;
    }
    return { provider: candidate.provider };
  },
  { action: "smoke" }
);
assert.strictEqual(attempts, 2);
assert.strictEqual(failover.config.providerKey, backupKey);

const noBackupProjection = api.__test.buildLegacyProjectionFromProviderRegistry({
  providerRegistry: registry,
  activeProviders: { face: primaryKey, analysis: primaryKey, video: primaryKey },
  activeBackups: {}
});
assert.strictEqual(noBackupProjection.faceBackup.enabled, false);
assert.strictEqual(noBackupProjection.analysisBackup.enabled, false);
assert.strictEqual(noBackupProjection.videoBackup.enabled, false);

console.log("admin backup model target smoke: OK");
})().catch((error) => {
  console.error(`admin backup model target smoke 失败：${error.stack || error.message || error}`);
  process.exitCode = 1;
});
