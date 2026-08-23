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
assert.strictEqual(
  test.isAdminContext({ OPENID: "admin-openid-001" }),
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
    apiKey: "must-be-dropped"
  },
  video: {
    model: "smoke-video-model",
    apiKey: "must-be-dropped"
  },
  apiKey: "must-be-dropped"
});
assert.deepStrictEqual(patch.image, { model: "smoke-image-model" });
assert.deepStrictEqual(patch.video, { model: "smoke-video-model" });
assert.deepStrictEqual(test.validateRuntimePatch(patch), []);
assert.ok(test.validateRuntimePatch({
  image: { mode: "not-supported" }
}).length > 0);
assert.ok(test.validateRuntimePatch({
  video: { baseUrl: "javascript:alert(1)" }
}).length > 0);

const merged = test.mergeRuntimeConfig(
  { image: { model: "old-image" }, video: { resolution: "480p" } },
  { image: { model: "new-image" }, video: { timeoutMs: 120000 } }
);
assert.strictEqual(merged.image.model, "new-image");
assert.strictEqual(merged.video.resolution, "480p");
assert.strictEqual(merged.video.timeoutMs, 120000);

api.main({
  action: "getAdminStatus",
  requestId: "admin-smoke-status"
}, { OPENID: "admin-openid-001" }).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.isAdmin, true);
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
