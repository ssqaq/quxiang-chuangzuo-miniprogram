/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const api = require("../cloudfunctions/api/index.js");
const test = api.__test;

const adminWxml = read("pages/admin/admin.wxml");
const adminJs = read("pages/admin/admin.js");
const tencentJs = read("pages/tencent-face-fusion/tencent-face-fusion.js");
const tencentWxml = read("pages/tencent-face-fusion/tencent-face-fusion.wxml");
const apiJs = read("cloudfunctions/api/index.js");
const apiConfig = JSON.parse(read("cloudfunctions/api/config.json"));

assert.ok(adminWxml.includes("真实测试腾讯接口"), "管理员页面必须有真实测试按钮");
assert.ok(adminWxml.includes("模板图"), "管理员页面必须能选择模板图");
assert.ok(adminWxml.includes("参考脸"), "管理员页面必须能选择参考脸");
assert.ok(adminJs.includes("testTencentFaceFusion"), "管理员页面必须调用腾讯真实测试接口");
assert.ok(adminJs.includes("TENCENT_FACEFUSION_LAST_TEST_STORAGE_KEY"), "真实测试成功后必须保留本地状态");
assert.ok(adminJs.includes("mergeTencentFaceFusionStatus"), "管理员状态读取必须避免旧请求覆盖新结果");
assert.ok(adminJs.includes("lastCallTimestamp"), "腾讯测试状态必须带时间戳避免回退");
assert.ok(tencentJs.includes("progressText"), "腾讯版页面必须维护进度文案");
assert.ok(tencentWxml.includes("progress-fill"), "腾讯版页面必须显示进度条");
assert.ok(apiJs.includes("testTencentFaceFusion"), "云函数必须注册腾讯真实测试动作");
assert.ok(apiJs.includes("TENCENT_FACEFUSION_INTERMEDIATE_COLLECTION"));
assert.ok(
  apiConfig.triggers.some((trigger) => (
    trigger.name === "tencent-facefusion-intermediate-cleanup"
    && trigger.type === "timer"
  )),
  "腾讯中间图必须配置定时清理触发器"
);
assert.ok(test && typeof test.cleanupTencentFaceFusionIntermediateAssets === "function");

const removed = [];
const updated = [];
const rows = [
  { _id: "expired-1", fileID: "cloud://expired-1" },
  { _id: "expired-missing", fileID: "cloud://missing" }
];
const fakeDb = {
  command: {
    lte(value) {
      return { operator: "lte", value };
    }
  },
  collection() {
    const query = {
      where() {
        return query;
      },
      limit() {
        return query;
      },
      async get() {
        return { data: rows };
      },
      doc(id) {
        return {
          async remove() {
            removed.push(id);
          },
          async update({ data }) {
            updated.push({ id, data });
          }
        };
      }
    };
    return query;
  }
};
const fakeCloud = {
  async deleteFile({ fileList }) {
    const fileID = fileList[0];
    if (fileID === "cloud://missing") {
      throw new Error("file not found");
    }
    return { fileList: [{ fileID, status: 0 }] };
  }
};

test.cleanupTencentFaceFusionIntermediateAssets(
  new Date("2026-08-26T04:00:00.000Z"),
  { db: fakeDb, cloud: fakeCloud }
).then((summary) => {
  assert.strictEqual(summary.scanned, 2);
  assert.strictEqual(summary.removed, 2);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(updated.length, 0);
  assert.strictEqual(removed.length, 2);
  console.log("tencent face fusion optimization smoke: OK");
  console.log(JSON.stringify({
    adminRealCall: true,
    progressDisplay: true,
    intermediateCleanup: true,
    cleanupRemoved: summary.removed
  }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
