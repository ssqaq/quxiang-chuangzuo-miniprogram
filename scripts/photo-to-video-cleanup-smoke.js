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
  config.photoToVideo.cleanup.idlePeriodMs === 2 * 60 * 60 * 1000,
  "关闭照片转视频页面后的闲置清理时间必须是 2 小时"
);
assert.ok(
  triggerConfig.triggers.some((item) => (
    item.name === "photo-to-video-idle-cleanup"
    && item.type === "timer"
    && item.config === "0 */15 * * * * *"
  )),
  "必须配置每 15 分钟检查一次的照片转视频闲置清理定时器"
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
assert.strictEqual(
  test.photoToVideoIdleCleanupCutoff(baseDate).getTime(),
  baseDate.getTime() - 2 * 60 * 60 * 1000,
  "云端闲置清理截止时间必须按 2 小时计算"
);
assert.strictEqual(test.normalizePhotoToVideoTempKind("SOURCE"), "source");
assert.strictEqual(test.normalizePhotoToVideoTempKind("RESULT"), "result");
assert.strictEqual(test.normalizePhotoToVideoTempKind("RECORD"), "record");
assert.strictEqual(test.normalizePhotoToVideoTempKind("formal"), "");
assert.strictEqual(
  test.isPhotoToVideoCleanupTrigger({ Type: "Timer" }),
  false,
  "泛化 Timer 事件不能再误进照片转视频清理"
);
assert.ok(test.isPhotoToVideoCleanupTrigger({
  triggerName: "photo-to-video-temp-cleanup"
}));
assert.ok(test.isPhotoToVideoCleanupTrigger({
  triggerName: "photo-to-video-idle-cleanup"
}));
assert.ok(test.isPhotoToVideoCleanupTrigger({
  action: "cleanupPhotoToVideoTempAssets"
}));
assert.ok(test.isGenerationQueueWorkerTrigger({
  triggerName: "generation-queue-worker"
}));
assert.ok(test.isGenerationReconcileTrigger({
  triggerName: "generation-operation-reconcile"
}));
assert.strictEqual(
  test.isPhotoToVideoCleanupTrigger({
    triggerName: "generation-queue-worker",
    Type: "Timer"
  }),
  false,
  "生图 worker 不能被照片转视频清理抢走"
);
assert.strictEqual(
  test.photoToVideoTempAssetDocumentId("cloud://tmp/a.jpg", "source"),
  test.photoToVideoTempAssetDocumentId("cloud://tmp/a.jpg", "source"),
  "同一个临时文件登记必须幂等"
);
assert.strictEqual(
  test.photoToVideoTempAssetDocumentId("record-1", "record"),
  test.photoToVideoTempAssetDocumentId("record-1", "record"),
  "同一条正式制作记录登记必须幂等"
);

assert.deepStrictEqual(
  test.photoToVideoCleanupState({
    cleanupAfter: "2026-08-27T12:00:00.000Z",
    idleCleanupAfter: "2026-08-24T11:59:00.000Z",
    lastActiveAt: "2026-08-24T09:00:00.000Z"
  }, baseDate),
  {
    ttlDue: false,
    idleDue: true,
    recentlyActive: false,
    due: true
  },
  "关闭满 2 小时的目标必须进入清理"
);
assert.strictEqual(
  test.photoToVideoCleanupState({
    cleanupAfter: "2026-08-27T12:00:00.000Z",
    idleCleanupAfter: "2026-08-24T11:59:00.000Z",
    lastActiveAt: "2026-08-24T11:30:00.000Z"
  }, baseDate).due,
  false,
  "用户重新使用后的目标不能被 2 小时规则误删"
);
assert.strictEqual(
  test.photoToVideoCleanupState({
    cleanupAfter: "2026-08-24T11:59:00.000Z",
    idleCleanupAfter: null,
    lastActiveAt: "2026-08-24T11:30:00.000Z"
  }, baseDate).due,
  true,
  "超过 72 小时最终期限时必须清理"
);

console.log("photo-to-video cleanup smoke: OK");
