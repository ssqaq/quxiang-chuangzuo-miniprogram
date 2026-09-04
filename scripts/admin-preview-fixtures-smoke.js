/* eslint-disable no-console */

const assert = require("assert");
const fixtures = require("../services/admin-preview-fixtures");

assert.strictEqual(fixtures.resolveFixtureId({ fixture: fixtures.REFERENCE_FIXTURE_ID }), fixtures.REFERENCE_FIXTURE_ID);
assert.strictEqual(fixtures.resolveFixtureId({ fixture: "unknown-fixture" }), fixtures.REFERENCE_FIXTURE_ID, "未知 fixture 必须回退到定稿 fixture");
assert.deepStrictEqual(fixtures.fixtureContract(), {
  fixtureId: fixtures.REFERENCE_FIXTURE_ID,
  fontProfile: fixtures.FONT_PROFILE,
  viewport: { width: 390, height: 844 },
  state: "collapsed-default-v1",
  states: ["collapsed-default-v1", "expanded-v1", "backup-disabled-v1", "video-mode-v1"],
  pages: ["dashboard", "operations", "config", "provider"]
});
assert.strictEqual(fixtures.resolveVisualState({ visualState: "video-mode-v1" }).group, "shared");
assert.strictEqual(fixtures.resolveVisualState({ visualState: "unknown" }).id, "collapsed-default-v1");

assert.strictEqual(fixtures.isEnabled({ demo: "1" }), true, "demo=1 应打开演示模式");
assert.strictEqual(fixtures.isEnabled({ demo: "true" }), true, "demo=true 应打开演示模式");
assert.strictEqual(fixtures.isEnabled({ demo: "0" }), false, "demo=0 应关闭演示模式");
assert.strictEqual(fixtures.isEnabled({ demo: "false" }), false, "demo=false 应关闭演示模式");
assert.strictEqual(fixtures.isEnabled({ demo: "unknown" }), false, "未知开关值应保持默认关闭");
const savedWx = global.wx;
global.wx = { getDeviceInfo() { return { platform: "devtools" }; } };
assert.strictEqual(fixtures.isDevToolsRuntime(), true, "开发者工具运行时必须可识别，供刷新失败回退演示数据");
global.wx = savedWx;
assert.strictEqual(fixtures.isControlVisible({}), false, "默认不应显示演示控件以保持定稿顶栏");
assert.strictEqual(fixtures.isControlVisible({ demoControl: "1" }), true, "demoControl=1 应显示演示控件");
assert.strictEqual(fixtures.isControlVisible({ demoControl: "0" }), false, "demoControl=0 应隐藏演示控件");

const config = fixtures.adminConfig();
assert.strictEqual(config.fixtureId, fixtures.REFERENCE_FIXTURE_ID, "配置 fixture 必须带固定 ID");
assert.strictEqual(config.source, "demo");
assert.strictEqual(config.suppliers.length, 10, "演示供应商目录应覆盖十个视觉档案");
assert.deepStrictEqual(config.suppliers.slice(0, 5).map(item => item.providerKey), ["dashscope", "xingju", "lingyun", "laoli", "panda"], "供应商目录顺序必须跟右图一致");
assert.ok(config.bindings.some(item => item.slot === "tencent.face" && item.status === "not-ready"), "腾讯换脸演示状态必须待配置");
assert.ok(config.bindings.some(item => item.slot === "shared.video" && item.role === "backup"), "演示配置必须包含共享视频备用模型");
const backupDisabled = fixtures.adminConfig({ visualState: "backup-disabled-v1" });
const disabledBackup = backupDisabled.bindings.find(item => item.slot === "standard.face" && item.role === "backup");
assert.strictEqual(disabledBackup.status, "not-ready", "备用关闭状态必须使用真实 schema 的 not-ready");
assert.strictEqual(disabledBackup.providerKey, "lingyun", "备用关闭状态必须保留供应商和模型");
assert.strictEqual(disabledBackup.modelId, "vision-pro", "备用关闭状态必须保留供应商和模型");
assert.ok(config.bindings.some(item => item.metadata && item.metadata.advanced && item.metadata.advanced.mode === "edits"), "生图演示配置必须包含 mode/size");
const serialized = JSON.stringify(config);
assert.ok(!serialized.includes("apiKey") || !serialized.match(/apiKey\\"\\s*:\\s*\\"[^\\"]+\\"/), "演示 fixture 不得携带真实 API Key");

const usage = fixtures.operations("usage");
assert.strictEqual(usage.fixtureId, fixtures.REFERENCE_FIXTURE_ID, "统计 fixture 必须带固定 ID");
assert.strictEqual(usage.today.total, 128);
assert.strictEqual(usage.eventCount, 3842);
assert.strictEqual(usage.errorLogCount, 199);
assert.strictEqual(usage.failureStats.total, 7);
assert.strictEqual(fixtures.operations("cost").last30d.estimatedCost, 68.42);
assert.strictEqual(fixtures.operations("users").total, 1286);
assert.strictEqual(fixtures.operations("points").effective.points.dailyFreeLimit, 3);

const copy = fixtures.adminConfig();
copy.suppliers[0].name = "changed";
assert.notStrictEqual(fixtures.adminConfig().suppliers[0].name, "changed", "每次读取 fixture 必须返回独立副本");

console.log("admin-preview-fixtures-smoke: PASS (query/config switch, four-page data, secret-free clone)");
