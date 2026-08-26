/* eslint-disable no-console */

const assert = require("assert");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
const api = require(path.join(
  __dirname,
  "..",
  "cloudfunctions",
  "api",
  "index.js"
));

const result = api.__test.checkRuntimeDependencies();
assert.deepStrictEqual(result, {
  healthy: true,
  verified: [
    "jpeg-js",
    "pngjs",
    "wx-server-sdk",
    "xlsx",
    "local-modules",
  ],
  failed: [],
});
const serialized = JSON.stringify(result);
assert.ok(!serialized.includes(__dirname));
assert.ok(!serialized.includes("node_modules"));
assert.ok(!serialized.includes("SECRET"));

console.log("runtime dependency health smoke: OK");
