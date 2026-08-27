/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.ADMIN_OPENIDS = "admin-image-key-smoke";
process.env.AI_VISION_API_KEY = "smoke-vision-value";
process.env.AI_IMAGE_PRIMARY_API_KEY = "smoke-primary-value";
process.env.AI_IMAGE_BACKUP_API_KEY = "smoke-backup-value";
process.env.AI_VIDEO_API_KEY = "smoke-video-value";

const root = path.resolve(__dirname, "..");
const dependencyRoots = [
  path.join(root, "cloudfunctions", "api", "node_modules"),
  path.join(path.dirname(path.dirname(root)), "cloudfunctions", "api", "node_modules")
].filter((candidate, index, list) => (
  fs.existsSync(candidate) && list.indexOf(candidate) === index
));
if (dependencyRoots.length) {
  process.env.NODE_PATH = [
    ...dependencyRoots,
    process.env.NODE_PATH || ""
  ].filter(Boolean).join(path.delimiter);
  Module._initPaths();
}

const api = require("../cloudfunctions/api/index.js");

function redactedConfig() {
  return {
    ok: true,
    effective: {
      providerLabels: {
        xingju: "星炬",
        lingyun: "凌云",
        "face-provider": "人脸服务商",
        "analysis-provider": "分析服务商",
        "video-provider": "视频服务商"
      },
      face: {
        provider: "face-provider",
        model: "face-model",
        apiKey: "",
        apiKeyConfigured: true
      },
      analysis: {
        provider: "analysis-provider",
        model: "analysis-model",
        apiKey: "",
        apiKeyConfigured: true
      },
      image: {
        provider: "xingju",
        baseUrl: "https://image.example/v1",
        model: "image-model",
        mode: "edits",
        size: "1080x1440",
        resolution: "1K",
        timeoutMs: 150000,
        maxRetries: 1,
        retryEnabled: true,
        apiKey: "",
        apiKeyConfigured: true
      },
      imageBackup: {
        provider: "lingyun",
        baseUrl: "https://backup.example/v1",
        model: "backup-model",
        mode: "edits",
        size: "1080x1440",
        resolution: "1K",
        timeoutMs: 150000,
        maxRetries: 0,
        retryEnabled: false,
        apiKey: "",
        apiKeyConfigured: true
      },
      tencentFaceFusion: {
        region: "ap-guangzhou",
        endpoint: "https://facefusion.tencentcloudapi.com",
        apiVersion: "2022-09-27",
        action: "FuseFaceUltra",
        model: "FuseFaceUltra",
        swapModelType: 4,
        logoAdd: false,
        timeoutMs: 75000,
        maxImageBytes: 5 * 1024 * 1024
      },
      video: {
        provider: "video-provider",
        model: "video-model",
        apiKey: "",
        apiKeyConfigured: true,
        resolution: "720p"
      },
      points: {},
      costs: {
        face: {
          inputPerMillionTokens: 0.15,
          outputPerMillionTokens: 1.5
        },
        analysis: {
          inputPerMillionTokens: 0.15,
          outputPerMillionTokens: 1.5
        },
        image: {
          providers: {
            xingju: {
              perImage: { "1K": 0.07, "2K": 0.07, "4K": 0.07 }
            },
            lingyun: {
              perImage: { "1K": 0.06, "2K": 0.1, "4K": 0.15 }
            }
          }
        },
        video: {
          perSecond: { "480p": 0.2, "720p": 0.3, "1080p": 1.8 },
          defaultDurationSeconds: 5
        }
      },
      generationQueue: {}
    },
    defaults: {},
    version: 1
  };
}

function inputBySection(wxml) {
  const inputs = wxml.match(/<input[^>]*data-key="apiKey"[^>]*>/g) || [];
  return inputs.reduce((result, input) => {
    const match = input.match(/data-section="([^"]+)"/);
    if (match) result[match[1]] = input;
    return result;
  }, {});
}

async function verifyCloudAction() {
  const denied = await api.main({
    action: "getAdminImageApiKeys",
    requestId: "admin-image-key-denied"
  }, { OPENID: "normal-user" });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.errorCode, "ADMIN_FORBIDDEN");

  const allowed = await api.main({
    action: "getAdminImageApiKeys",
    requestId: "admin-image-key-allowed"
  }, { OPENID: "admin-image-key-smoke" });
  assert.strictEqual(allowed.ok, true);
  assert.deepStrictEqual(Object.keys(allowed).sort(), [
    "analysis",
    "face",
    "image",
    "imageBackup",
    "ok",
    "providerProfiles",
    "requestId",
    "video"
  ]);
  assert.strictEqual(allowed.face.apiKey, "smoke-vision-value");
  assert.strictEqual(allowed.analysis.apiKey, "smoke-vision-value");
  assert.strictEqual(allowed.image.apiKey, "smoke-primary-value");
  assert.strictEqual(allowed.imageBackup.apiKey, "smoke-backup-value");
  assert.strictEqual(allowed.video.apiKey, "smoke-video-value");
  ["face", "analysis", "image", "imageBackup", "video"].forEach((section) => {
    assert.ok(
      allowed.providerProfiles[section]
      && typeof allowed.providerProfiles[section] === "object",
      `专用接口必须返回 ${section} 的服务商 Key 档案`
    );
  });
  ["tencent", "secretId", "secretKey"].forEach((key) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(allowed, key),
      false,
      `专用接口不应返回 ${key}`
    );
  });

  const ordinary = await api.main({
    action: "getAdminConfig",
    requestId: "admin-image-key-redacted"
  }, { OPENID: "admin-image-key-smoke" });
  assert.strictEqual(ordinary.ok, true);
  ["face", "analysis", "image", "imageBackup", "video"].forEach((section) => {
    assert.strictEqual(
      ordinary.effective[section].apiKey,
      "",
      `普通配置接口必须继续隐藏 ${section} Key`
    );
  });
}

async function verifyAdminPage() {
  let pageDefinition = null;
  let keyReadFailure = false;
  const savePayloads = [];
  const liveKeys = {
    face: "page-face-value",
    analysis: "page-analysis-value",
    image: "page-primary-value",
    imageBackup: "page-backup-value",
    video: "page-video-value"
  };
  const cloudMock = {
    isCloudReady: () => true,
    getAdminStatus: async () => ({ isAdmin: true }),
    getAdminConfig: async () => redactedConfig(),
    getAdminImageApiKeys: async () => {
      if (keyReadFailure) throw new Error("专用接口暂时不可用");
      return {
        face: { apiKey: liveKeys.face },
        analysis: { apiKey: liveKeys.analysis },
        image: { apiKey: liveKeys.image },
        imageBackup: { apiKey: liveKeys.imageBackup },
        video: { apiKey: liveKeys.video },
        providerProfiles: {
          face: {},
          analysis: {},
          image: {},
          imageBackup: {},
          video: {}
        }
      };
    },
    saveAdminConfig: async (config) => {
      savePayloads.push(JSON.parse(JSON.stringify(config)));
      if (config.image && config.image.apiKey) {
        liveKeys.image = config.image.apiKey;
      }
      if (config.imageBackup && config.imageBackup.apiKey) {
        liveKeys.imageBackup = config.imageBackup.apiKey;
      }
      const result = redactedConfig();
      result.version = savePayloads.length + 1;
      return result;
    }
  };
  const diagnosticLogMock = {
    info() {},
    warn() {},
    error() {}
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "../../services/cloud") return cloudMock;
    if (request === "../../utils/diagnostic-log") return diagnosticLogMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  global.Page = (definition) => {
    pageDefinition = definition;
  };
  global.wx = {
    showModal() {},
    showToast() {},
    reLaunch() {},
    stopPullDownRefresh() {}
  };
  const adminPagePath = require.resolve("../pages/admin/admin.js");
  delete require.cache[adminPagePath];
  require(adminPagePath);
  Module._load = originalLoad;
  assert.ok(pageDefinition, "管理员页面没有注册成功");

  const page = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    _adminLoadToken: 0,
    setData(patch) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") target[part] = {};
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
    }
  };
  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === "function") {
      page[key] = pageDefinition[key].bind(page);
    }
  });
  page.loadAdminBackground = () => {};
  page.loadTencentFaceFusionStatus = () => {};
  page.runModelProbe = async () => {};

  await page.loadAdminPage();
  assert.strictEqual(page.data.form.face.apiKey, liveKeys.face);
  assert.strictEqual(page.data.form.analysis.apiKey, liveKeys.analysis);
  assert.strictEqual(page.data.form.image.apiKey, liveKeys.image);
  assert.strictEqual(page.data.form.imageBackup.apiKey, liveKeys.imageBackup);
  assert.strictEqual(page.data.form.video.apiKey, liveKeys.video);

  await page.saveConfig();
  ["face", "analysis", "image", "imageBackup", "video"].forEach((section) => {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(savePayloads[0][section], "apiKey"),
      false,
      `${section} Key 未修改时不应提交`
    );
  });
  assert.strictEqual(page.data.form.image.apiKey, liveKeys.image);
  assert.strictEqual(page.data.form.imageBackup.apiKey, liveKeys.imageBackup);

  page.setData({ "form.image.apiKey": "page-primary-updated" });
  await page.saveConfig();
  assert.strictEqual(
    savePayloads[1].image.apiKey,
    "page-primary-updated"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(savePayloads[1].imageBackup, "apiKey"),
    false,
    "只改主用 Key 时不应重复提交备用 Key"
  );
  assert.strictEqual(page.data.form.image.apiKey, "page-primary-updated");
  assert.strictEqual(page.data.form.imageBackup.apiKey, liveKeys.imageBackup);

  page.setData({ "form.imageBackup.apiKey": "" });
  await page.saveConfig();
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(savePayloads[2].imageBackup, "apiKey"),
    false,
    "清空备用输入框时必须保留云端旧 Key"
  );
  assert.strictEqual(
    page.data.form.imageBackup.apiKey,
    liveKeys.imageBackup,
    "保存后备用完整 Key 不应消失"
  );

  liveKeys.imageBackup = "page-backup-refreshed";
  await page.loadAdminPage();
  assert.strictEqual(page.data.form.image.apiKey, liveKeys.image);
  assert.strictEqual(page.data.form.imageBackup.apiKey, "page-backup-refreshed");

  keyReadFailure = true;
  await page.loadAdminPage();
  ["face", "analysis", "image", "imageBackup", "video"].forEach((section) => {
    assert.strictEqual(page.data.form[section].apiKey, "");
  });
  assert.ok(page.data.message.includes("完整 Key 读取失败"));

  keyReadFailure = false;
  page.setData({
    "form.imageBackup.mode": "edits",
    "form.imageBackup.size": "1242x1660",
    "form.imageBackup.resolution": "4K",
    "form.imageBackup.timeoutMs": "60000"
  });
  await page.saveConfig();
  assert.strictEqual(savePayloads[3].imageBackup.mode, "edits");
  assert.strictEqual(savePayloads[3].imageBackup.size, "1242x1660");
  assert.strictEqual(savePayloads[3].imageBackup.resolution, "4K");
  assert.strictEqual(savePayloads[3].imageBackup.timeoutMs, 60000);
  assert.strictEqual(savePayloads[3].image.size, "1080x1440");
  assert.strictEqual(savePayloads[3].image.resolution, "1K");
}

function verifyMarkupAndStaticBoundaries() {
  const root = path.resolve(__dirname, "..");
  const wxml = fs.readFileSync(
    path.join(root, "pages/admin/admin.wxml"),
    "utf8"
  );
  const pageJs = fs.readFileSync(
    path.join(root, "pages/admin/admin.js"),
    "utf8"
  );
  const serviceJs = fs.readFileSync(
    path.join(root, "services/cloud.js"),
    "utf8"
  );
  const inputs = inputBySection(wxml);
  assert.strictEqual(Object.keys(inputs).length, 5);
  ["image", "imageBackup"].forEach((section) => {
    assert.ok(inputs[section]);
    assert.strictEqual(/\bpassword\b/.test(inputs[section]), false);
  });
  ["face", "analysis", "video"].forEach((section) => {
    assert.ok(inputs[section]);
    assert.strictEqual(/\bpassword\b/.test(inputs[section]), true);
  });
  assert.ok(wxml.includes("已显示完整 Key"));
  assert.ok(serviceJs.includes('action: "getAdminImageApiKeys"'));
  assert.ok(pageJs.includes("_imageApiKeyBaseline"));
  assert.strictEqual(
    /setStorageSync\([^)]*imageApiKey/i.test(pageJs),
    false,
    "完整 Key 不得写入本地 Storage"
  );
}

async function main() {
  await verifyCloudAction();
  await verifyAdminPage();
  verifyMarkupAndStaticBoundaries();
  console.log("admin image API Key display smoke: OK");
}

main().catch((error) => {
  console.error(`admin image API Key display smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
