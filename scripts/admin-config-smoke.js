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
    apiKey: "must-be-dropped"
  },
  video: {
    model: "smoke-video-model",
    apiKey: "must-be-dropped"
  },
  analysis: {
    provider: "smoke-analysis-provider",
    model: "smoke-analysis-model",
    timeoutMs: 18000,
    apiKey: "must-be-dropped"
  },
  apiKey: "must-be-dropped"
});
assert.deepStrictEqual(patch.image, { model: "smoke-image-model" });
assert.deepStrictEqual(patch.video, { model: "smoke-video-model" });
assert.deepStrictEqual(patch.analysis, {
  provider: "smoke-analysis-provider",
  model: "smoke-analysis-model",
  timeoutMs: 18000
});
assert.deepStrictEqual(test.validateRuntimePatch(patch), []);
assert.ok(test.validateRuntimePatch({
  image: { mode: "not-supported" }
}).length > 0);
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
  assert.match(result.identityHash, /^[0-9a-f]{12}$/);
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
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.effective.face, "apiKey"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.effective.analysis, "apiKey"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.effective.image, "apiKey"),
    false
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(result.effective.video, "apiKey"),
    false
  );
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
