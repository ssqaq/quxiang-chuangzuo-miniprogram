/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";

const root = path.resolve(__dirname, "..");
const api = require("../cloudfunctions/api/index.js");
const test = api.__test;
const cloudJs = fs.readFileSync(
  path.join(root, "services/cloud.js"),
  "utf8"
);
const apiJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);
const cloudCoreJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/lib/publish-export-core.js"),
  "utf8"
);

assert.ok(test, "云函数没有暴露测试接口。");
assert.ok(test.publishExportCore, "云函数没有接入统一导出算法。");
assert.strictEqual(
  test.publishExportCore.normalizeOptions({ maxLongEdge: 4096 }).maxLongEdge,
  4096
);
assert.strictEqual(
  test.publishExportCore.normalizeOptions({ format: "webp" }).format,
  "jpg"
);
const firstJobId = test.publishExportJobId(
  "openid-smoke",
  "cloud://input",
  "record-smoke",
  { maxLongEdge: 2048 }
);
const secondJobId = test.publishExportJobId(
  "openid-smoke",
  "cloud://input",
  "record-smoke",
  { maxLongEdge: 2048 }
);
assert.ok(/^[a-f0-9]{32}$/.test(firstJobId), "云端任务 ID 生成失败。");
assert.strictEqual(firstJobId, secondJobId, "云端幂等任务 ID 不稳定。");

assert.ok(cloudJs.includes('action: "publishExport"'), "客户端没有调用 publishExport。");
assert.ok(cloudJs.includes("temporaryInput"), "客户端没有标记临时输入文件。");
assert.ok(apiJs.includes('action === "publishExport"'), "云函数没有接入 publishExport action。");
assert.ok(apiJs.includes("PUBLISH_EXPORT_JOB_COLLECTION"), "云函数没有使用导出任务集合。");
assert.ok(apiJs.includes("jpeg-js"), "云端没有接入 JPEG 解码。");
assert.ok(apiJs.includes("PNG.sync.read"), "云端没有接入 PNG 解码。");
assert.ok(cloudCoreJs.includes("function processRgba"), "云端算法文件缺少 processRgba。");
assert.ok(cloudCoreJs.includes("function resizeRgba"), "云端算法文件缺少 resizeRgba。");

console.log("publish-export cloud smoke: OK");
