const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";

const root = path.resolve(__dirname, "..");
const config = require(path.join(root, "config.js"));
const triggerConfig = JSON.parse(
  fs.readFileSync(path.join(root, "cloudfunctions", "api", "config.json"), "utf8")
);
const api = require(path.join(root, "cloudfunctions", "api", "index.js"));
const test = api.__test;

assert.strictEqual(
  config.photoToVideo.cleanup.gracePeriodMs,
  3 * 24 * 60 * 60 * 1000,
  "本地清理保留期必须是 3×24 小时"
);
assert.ok(
  triggerConfig.triggers.some((item) => (
    item.name === "photo-to-video-temp-cleanup"
    && item.type === "timer"
    && item.config === "0 0 3 * * * *"
  )),
  "必须配置每天凌晨 3 点的照片转视频临时文件清理定时器"
);

const baseDate = new Date("2026-08-24T12:00:00.000Z");
assert.strictEqual(
  test.photoToVideoTempCleanupCutoff(baseDate).getTime(),
  baseDate.getTime() - 3 * 24 * 60 * 60 * 1000,
  "云端清理截止时间必须按 3×24 小时计算"
);
assert.strictEqual(test.normalizePhotoToVideoTempKind("SOURCE"), "source");
assert.strictEqual(test.normalizePhotoToVideoTempKind("RESULT"), "result");
assert.strictEqual(test.normalizePhotoToVideoTempKind("formal"), "");
assert.ok(test.isPhotoToVideoCleanupTrigger({ Type: "Timer" }));
assert.ok(test.isPhotoToVideoCleanupTrigger({
  triggerName: "photo-to-video-temp-cleanup"
}));
assert.ok(test.isPhotoToVideoCleanupTrigger({
  action: "cleanupPhotoToVideoTempAssets"
}));
assert.strictEqual(
  test.photoToVideoTempAssetDocumentId("cloud://tmp/a.jpg", "source"),
  test.photoToVideoTempAssetDocumentId("cloud://tmp/a.jpg", "source"),
  "同一个临时文件登记必须幂等"
);

console.log("photo-to-video cleanup smoke: OK");
