/* eslint-disable no-console */

const assert = require("assert");
const {
  XINGJU_VIDEO_DEFAULTS,
  isXingjuProvider,
  applyAdminVideoProviderDefaults
} = require("../services/admin-video-config");

assert.strictEqual(isXingjuProvider("xingju"), true);
assert.strictEqual(isXingjuProvider("星炬"), true);
assert.strictEqual(isXingjuProvider("lingyun"), false);

const blank = {
  video: {
    provider: "星炬",
    baseUrl: "",
    model: "",
    createPath: "",
    queryPath: "",
    resolution: "",
    aspectRatio: "",
    timeoutMs: ""
  }
};
const filled = applyAdminVideoProviderDefaults(blank);
assert.deepStrictEqual(filled.video, Object.assign({}, blank.video, XINGJU_VIDEO_DEFAULTS));
assert.notStrictEqual(filled, blank, "补齐配置不能直接修改原对象");
assert.strictEqual(blank.video.model, "", "不能修改原始表单对象");

const manual = applyAdminVideoProviderDefaults({
  video: {
    provider: "xingju",
    model: "my-video-model",
    createPath: "/custom/create",
    queryPath: "/custom/query/{taskId}",
    resolution: "1080p",
    timeoutMs: "120000"
  }
});
assert.strictEqual(manual.video.model, "my-video-model");
assert.strictEqual(manual.video.createPath, "/custom/create");
assert.strictEqual(manual.video.queryPath, "/custom/query/{taskId}");
assert.strictEqual(manual.video.resolution, "1080p");
assert.strictEqual(manual.video.timeoutMs, "120000");

const invalidTimeout = applyAdminVideoProviderDefaults({
  video: { provider: "xingju", timeoutMs: "bad" }
});
assert.strictEqual(invalidTimeout.video.timeoutMs, "90000");

const otherProvider = {
  video: { provider: "凌云", model: "", timeoutMs: "" }
};
assert.strictEqual(
  applyAdminVideoProviderDefaults(otherProvider),
  otherProvider,
  "其他服务商不能套用星炬默认参数"
);

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-video-smoke";
process.env.AI_VIDEO_PROVIDER = "xingju";
const fakeVideoKey = "video-key-for-admin-smoke";
process.env.AI_VIDEO_API_KEY = fakeVideoKey;
const api = require("../cloudfunctions/api/index.js");
const apiTest = api.__test;
assert.ok(apiTest, "云函数没有暴露测试接口");

const strippedVideoKey = apiTest.dropBlankRuntimeApiKeys(
  apiTest.normalizeRuntimePatch({
    video: {
      apiKey: fakeVideoKey,
      model: XINGJU_VIDEO_DEFAULTS.model
    }
  })
);
assert.strictEqual(
  Object.prototype.hasOwnProperty.call(strippedVideoKey.video, "apiKey"),
  false,
  "管理员保存配置时不能把视频 Key 写进动态配置"
);

api.main({
  action: "getAdminImageApiKeys",
  requestId: "admin-video-key-smoke"
}, { OPENID: "admin-video-smoke" }).then((result) => {
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.video.apiKey, fakeVideoKey);
  console.log("admin-video-xingju-defaults smoke: OK");
}).catch((error) => {
  console.error(`admin-video-xingju-defaults smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
