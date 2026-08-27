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

console.log("admin backup model target smoke: OK");
