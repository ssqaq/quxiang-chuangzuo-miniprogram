/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.AI_IMAGE_RETRY_ENABLED = "false";

const root = path.resolve(__dirname, "..");
const appJson = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const workbenchWxml = fs.readFileSync(
  path.join(root, "pages/workbench/workbench.wxml"),
  "utf8"
);
const tencentPageJs = fs.readFileSync(
  path.join(root, "pages/tencent-face-fusion/tencent-face-fusion.js"),
  "utf8"
);
const tencentPageWxml = fs.readFileSync(
  path.join(root, "pages/tencent-face-fusion/tencent-face-fusion.wxml"),
  "utf8"
);
const serviceJs = fs.readFileSync(path.join(root, "services/cloud.js"), "utf8");
const apiJs = fs.readFileSync(
  path.join(root, "cloudfunctions/api/index.js"),
  "utf8"
);
const apiConfig = JSON.parse(fs.readFileSync(
  path.join(root, "cloudfunctions/api/config.json"),
  "utf8"
));

assert.ok(
  appJson.pages.includes("pages/tencent-face-fusion/tencent-face-fusion"),
  "腾讯版页面必须注册到 app.json"
);
assert.ok(
  workbenchWxml.indexOf("开始新创作-腾讯版")
    < workbenchWxml.indexOf("制作记录"),
  "腾讯版入口必须位于制作记录上方"
);
assert.ok(tencentPageWxml.includes("原始主图"));
assert.ok(tencentPageWxml.includes("参考脸"));
assert.ok(tencentPageWxml.includes("正在修改衣服、背景和光影"));
assert.ok(tencentPageWxml.includes("正在融合参考人脸"));
assert.ok(tencentPageWxml.includes("GPT Image 2 → 腾讯人脸融合专业版"));
assert.ok(tencentPageJs.includes("retryTencentOnly"));
assert.ok(serviceJs.includes('action: "tencentFaceFusionPipeline"'));
assert.ok(serviceJs.includes('action: "getTencentFaceFusionPipelineStatus"'));
assert.ok(serviceJs.includes('action: "testTencentFaceFusion"'));
assert.ok(apiJs.includes("FuseFaceUltra"));
assert.ok(apiJs.includes("reserveUsage(openid, requestId, \"image\")"));
assert.ok(apiJs.includes("refundUsage(openid, requestId"));
assert.ok(apiJs.includes("TENCENT_FACEFUSION_SECRET_ID"));
assert.ok(apiJs.includes("cleanupTencentFaceFusionIntermediateAssets"));
assert.ok(
  apiConfig.triggers.some((trigger) => trigger.name === "tencent-facefusion-intermediate-cleanup"),
  "腾讯中间图必须配置定时清理触发器"
);
assert.ok(!tencentPageJs.includes("TENCENT_FACEFUSION_SECRET_KEY"));

const api = require("../cloudfunctions/api/index.js");
const test = api.__test;
assert.ok(test && typeof test.requestTencentFaceFusion === "function");
assert.ok(test && typeof test.testTencentFaceFusion === "function");
assert.ok(test && typeof test.cleanupTencentFaceFusionIntermediateAssets === "function");

function withServer(handler, callback) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      try {
        const address = server.address();
        resolve(await callback(`http://127.0.0.1:${address.port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

async function main() {
  let requestBody = "";
  let requestHeaders = null;
  await withServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("utf8");
      requestHeaders = request.headers;
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        Response: {
          RequestId: "smoke-tencent-request",
          ResultImage: Buffer.from("final-image").toString("base64")
        }
      }));
    });
  }, async (url) => {
    const result = await test.requestTencentFaceFusion(
      Buffer.from("template-image"),
      Buffer.from("face-image"),
      {
        endpoint: url,
        action: "FuseFaceUltra",
        apiVersion: "2022-09-27",
        region: "ap-guangzhou",
        secretId: "smoke-secret-id",
        secretKey: "smoke-secret-key",
        swapModelType: 4,
        logoAdd: false,
        timeoutMs: 5000,
        maxImageBytes: 1024 * 1024,
        model: "FuseFaceUltra"
      },
      "smoke-tencent-request"
    );
    assert.strictEqual(result.toString("utf8"), "final-image");
  });

  const parsed = JSON.parse(requestBody);
  assert.strictEqual(parsed.RspImgType, "base64");
  assert.strictEqual(parsed.SwapModelType, 4);
  assert.ok(parsed.ModelImage);
  assert.ok(parsed.MergeInfos && parsed.MergeInfos[0] && parsed.MergeInfos[0].Image);
  assert.ok(String(requestHeaders.authorization || "").startsWith("TC3-HMAC-SHA256"));
  assert.strictEqual(requestHeaders["x-tc-action"], "FuseFaceUltra");
  assert.strictEqual(requestHeaders["x-tc-version"], "2022-09-27");

  console.log("tencent face fusion smoke: OK");
  console.log(JSON.stringify({
    routeRegistered: true,
    entryBeforeRecords: true,
    tc3Signed: true,
    requestAction: requestHeaders["x-tc-action"],
    pipelineVersion: "gpt-image-2-tencent-facefusion-v1"
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
