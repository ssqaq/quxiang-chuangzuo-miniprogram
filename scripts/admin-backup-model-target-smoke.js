/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";

const api = require("../cloudfunctions/api/index.js");

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

const videoConfigs = {
  video: {
    provider: "video-primary",
    baseUrl: "https://video-primary.example/v1",
    apiKey: "video-primary-secret",
    model: "video-primary-model",
    timeoutMs: 120000
  },
  videoBackup: {
    provider: "video-backup",
    baseUrl: "https://video-backup.example/v1",
    apiKey: "video-backup-secret",
    model: "video-backup-model",
    timeoutMs: 90000
  }
};

const videoBackup = api.__test.temporaryModelConfig(videoConfigs, "video", {
  configTarget: "videoBackup",
  provider: "video-backup-updated",
  model: "video-backup-model-updated",
  apiKey: ""
});

assert.strictEqual(videoBackup.provider, "video-backup-updated");
assert.strictEqual(videoBackup.model, "video-backup-model-updated");
assert.strictEqual(
  videoBackup.apiKey,
  videoConfigs.videoBackup.apiKey,
  "备用视频按钮留空密钥时必须沿用备用密钥，不能误用主视频密钥"
);
assert.notStrictEqual(videoBackup.apiKey, videoConfigs.video.apiKey);

const faceConfigs = {
  face: {
    provider: "face-primary",
    providerKey: "face-primary-key",
    endpoint: "https://face-primary.example/v1/chat/completions",
    apiKey: "face-primary-secret",
    model: "face-primary-model"
  },
  faceBackup: {
    enabled: true,
    configured: true,
    provider: "face-backup",
    providerKey: "face-backup-key",
    endpoint: "https://face-backup.example/v1/chat/completions",
    apiKey: "face-backup-secret",
    model: "face-backup-model"
  },
  analysis: {
    provider: "analysis-primary",
    providerKey: "analysis-primary-key",
    endpoint: "https://analysis-primary.example/v1/chat/completions",
    apiKey: "analysis-primary-secret",
    model: "analysis-primary-model"
  },
  analysisBackup: {
    enabled: true,
    configured: true,
    provider: "analysis-backup",
    providerKey: "analysis-backup-key",
    endpoint: "https://analysis-backup.example/v1/chat/completions",
    apiKey: "analysis-backup-secret",
    model: "analysis-backup-model"
  }
};

const faceCandidates = api.__test.visionConfigCandidatesForAction(
  "detectFaceCircle",
  faceConfigs
);
const analysisCandidates = api.__test.visionConfigCandidatesForAction(
  "analyze",
  faceConfigs
);
assert.deepStrictEqual(
  faceCandidates.map((item) => item.providerKey),
  ["face-primary-key", "face-backup-key"]
);
assert.deepStrictEqual(
  analysisCandidates.map((item) => item.providerKey),
  ["analysis-primary-key", "analysis-backup-key"]
);

(async () => {
  const attempted = [];
  const switched = await api.__test.runVisionProviderFailover(
    faceCandidates,
    async (candidate) => {
      attempted.push(candidate.providerKey);
      if (candidate.providerKey === "face-primary-key") {
        const error = new Error("primary unavailable");
        error.status = 503;
        throw error;
      }
      return { ok: true, provider: candidate.providerKey };
    },
    { requestId: "vision-backup-smoke", action: "detectFaceCircle" }
  );
  assert.deepStrictEqual(attempted, ["face-primary-key", "face-backup-key"]);
  assert.strictEqual(switched.config.providerKey, "face-backup-key");
  console.log("admin backup model target smoke: OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
