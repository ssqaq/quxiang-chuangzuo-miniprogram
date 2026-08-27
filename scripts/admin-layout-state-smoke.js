/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
const storage = {};
let tencentStatusResult = {};
let tencentStatusError = null;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") {
    return {
      async getTencentFaceFusionAdminStatus() {
        if (tencentStatusError) throw tencentStatusError;
        return tencentStatusResult;
      }
    };
  }
  if (request === "../../utils/diagnostic-log") {
    return { info() {}, warn() {}, error() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  getStorageSync(key) {
    return storage[key] || null;
  },
  setStorageSync(key, value) {
    storage[key] = value;
  },
  pageScrollTo() {}
};

require("../pages/admin/admin.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "管理员页面没有注册成功");

function createPageInstance() {
  const instance = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
    setData(patch, callback) {
      Object.keys(patch || {}).forEach((key) => {
        const parts = key.split(".");
        let target = this.data;
        parts.slice(0, -1).forEach((part) => {
          if (!target[part] || typeof target[part] !== "object") target[part] = {};
          target = target[part];
        });
        target[parts[parts.length - 1]] = patch[key];
      });
      if (typeof callback === "function") callback();
    }
  };
  Object.keys(pageDefinition).forEach((key) => {
    if (typeof pageDefinition[key] === "function") {
      instance[key] = pageDefinition[key].bind(instance);
    }
  });
  return instance;
}

const firstPage = createPageInstance();
assert.deepStrictEqual(
  firstPage.data.imageQualityOptions.map((item) => item.label),
  [
    "1K（价格读取中）",
    "2K（价格读取中）",
    "4K（价格读取中）"
  ],
  "云端成本尚未返回时，生图清晰度不得在客户端重复写默认价格"
);
assert.deepStrictEqual(
  firstPage.data.videoQualityOptions.map((item) => item.label),
  [
    "480p（价格读取中）",
    "720p（价格读取中）",
    "1080p（价格读取中）"
  ],
  "云端成本尚未返回时，视频清晰度不得在客户端重复写默认价格"
);
assert.deepStrictEqual(
  firstPage.data.imageBackupQualityOptions.map((item) => item.label),
  [
    "1K（价格读取中）",
    "2K（价格读取中）",
    "4K（价格读取中）"
  ],
  "备用模型清晰度选项必须单独显示"
);
assert.deepStrictEqual(
  firstPage.data.imageBackupSizeOptions.map((item) => item.value),
  ["1080x1440", "1242x1660", "1080x1920"],
  "备用模型尺寸比例选项必须单独显示"
);
firstPage.onInput({
  currentTarget: { dataset: { section: "costs", key: "imageXingju2K" } },
  detail: { value: "0.12" }
});
assert.strictEqual(
  firstPage.data.imageQualityOptions[1].label,
  "2K（¥0.12/张）",
  "修改生图成本后，下拉框价格必须同步"
);
[
  ["imageXingju1K", "0.07"],
  ["imageXingju4K", "0.07"],
  ["imageLingyun1K", "0.06"],
  ["imageLingyun2K", "0.1"],
  ["imageLingyun4K", "0.15"]
].forEach(([key, value]) => {
  firstPage.onInput({
    currentTarget: { dataset: { section: "costs", key } },
    detail: { value }
  });
});
assert.ok(
  firstPage.data.imageBackupPricingNotice.includes("1K ¥0.06/张")
    && firstPage.data.imageBackupPricingNotice.includes("2K ¥0.1/张")
    && firstPage.data.imageBackupPricingNotice.includes("4K ¥0.15/张"),
  "修改凌云成本后，备用模型价格说明必须同步"
);
firstPage.onInput({
  currentTarget: { dataset: { section: "imageBackup", key: "provider" } },
  detail: { value: "xingju" }
});
assert.ok(
  firstPage.data.imageBackupPricingNotice.includes("1K ¥0.07/张")
    && firstPage.data.imageBackupPricingNotice.includes("2K ¥0.12/张")
    && firstPage.data.imageBackupPricingNotice.includes("4K ¥0.07/张"),
  "切换备用服务商时，备用价格说明必须马上切换"
);
const primaryResolutionBeforeBackupChange = firstPage.data.form.image.resolution;
const primarySizeBeforeBackupChange = firstPage.data.form.image.size;
firstPage.onImageBackupQualityChange({ detail: { value: 2 } });
assert.strictEqual(
  firstPage.data.form.imageBackup.resolution,
  "4K",
  "备用模型清晰度必须独立保存"
);
assert.strictEqual(
  firstPage.data.form.image.resolution,
  primaryResolutionBeforeBackupChange,
  "修改备用清晰度不能改变主模型清晰度"
);
firstPage.onImageBackupSizeChange({ detail: { value: 1 } });
assert.strictEqual(
  firstPage.data.form.imageBackup.size,
  "1242x1660",
  "备用模型尺寸比例必须独立保存"
);
assert.strictEqual(
  firstPage.data.form.image.size,
  primarySizeBeforeBackupChange,
  "修改备用尺寸比例不能改变主模型尺寸比例"
);
firstPage.onInput({
  currentTarget: { dataset: { section: "image", key: "provider" } },
  detail: { value: "lingyun" }
});
assert.strictEqual(
  firstPage.data.imageQualityOptions[0].label,
  "1K（¥0.06/张）",
  "切换主服务商时，清晰度下拉框必须显示该服务商价格"
);
firstPage.onInput({
  currentTarget: { dataset: { section: "costs", key: "video480p" } },
  detail: { value: "0.2" }
});
firstPage.onInput({
  currentTarget: { dataset: { section: "costs", key: "video720p" } },
  detail: { value: "0.45" }
});
firstPage.onInput({
  currentTarget: { dataset: { section: "costs", key: "video1080p" } },
  detail: { value: "1.8" }
});
assert.strictEqual(
  firstPage.data.videoQualityOptions[1].label,
  "720p（¥0.45/秒）",
  "修改视频成本后，下拉框价格必须同步"
);
assert.ok(
  firstPage.data.videoPricingNotice.includes("720p ¥0.45/秒"),
  "视频价格提示必须与成本输入同步"
);
firstPage.toggleConfigSection({
  currentTarget: { dataset: { section: "image" } }
});
assert.strictEqual(firstPage.data.activeConfigSection, "image");
assert.strictEqual(firstPage.data.activeConfigTitle, "生图模型");
assert.strictEqual(firstPage.data.tencentImageTab, "image");
firstPage.switchTencentImageTab({
  currentTarget: { dataset: { tab: "fusion" } }
});
assert.strictEqual(firstPage.data.tencentImageTab, "fusion");
firstPage.onInput({
  currentTarget: { dataset: { section: "tencentFaceFusion", key: "endpoint" } },
  detail: { value: "https://example.com/tencent" }
});
assert.strictEqual(
  firstPage.data.form.tencentFaceFusion.endpoint,
  "https://example.com/tencent"
);
firstPage.toggleConfigSection({
  currentTarget: { dataset: { section: "image" } }
});
assert.strictEqual(firstPage.data.activeConfigSection, "", "生图模型再次点击必须收起");
firstPage.toggleConfigSection({
  currentTarget: { dataset: { section: "image" } }
});
assert.strictEqual(firstPage.data.tencentImageTab, "image", "生图模型重新打开必须回到图片模型页签");
storage["admin-monitor-layout-v3"] = {
  activeConfigSection: "tencentImage",
  tencentImageTab: "image"
};
const restoredTencentPage = createPageInstance();
restoredTencentPage.restoreMonitorLayout();
assert.strictEqual(
  restoredTencentPage.data.activeConfigSection,
  "image",
  "旧腾讯独立面板状态必须恢复到生图模型面板"
);
assert.strictEqual(
  restoredTencentPage.data.tencentImageTab,
  "fusion",
  "旧腾讯独立面板状态必须恢复到腾讯融合页签"
);
firstPage.toggleConfigSection({
  currentTarget: { dataset: { section: "users" } }
});
firstPage.toggleMonitor();
firstPage.toggleUsageCard();
firstPage.toggleUsageSection({
  currentTarget: { dataset: { usageSection: "failure" } }
});
firstPage.toggleDeploymentSection({
  currentTarget: { dataset: { deploymentSection: "logs" } }
});
firstPage.toggleMonitorSection({
  currentTarget: { dataset: { section: "diagnosticLogs" } }
});

const secondPage = createPageInstance();
secondPage.restoreMonitorLayout();

assert.strictEqual(secondPage.data.activeConfigSection, "users");
assert.strictEqual(secondPage.data.activeConfigTitle, "用户统计");
assert.strictEqual(secondPage.data.monitorExpanded, false);
assert.strictEqual(secondPage.data.usageExpanded, false);
assert.strictEqual(secondPage.data.usageSections.failure, true);
assert.strictEqual(secondPage.data.deploymentSections.logs, true);
assert.strictEqual(secondPage.data.monitorSections.diagnosticLogs, true);

async function verifyTencentAdminStatusDisplay() {
  const configuredPage = createPageInstance();
  configuredPage._adminLoadToken = 1;
  configuredPage.data.isAdmin = true;
  tencentStatusResult = {
    configured: true,
    secretId: "visible-secret-id",
    secretKey: "visible-secret-key",
    region: "ap-guangzhou",
    endpoint: "https://facefusion.tencentcloudapi.com",
    apiVersion: "2022-09-27",
    action: "FuseFaceUltra",
    model: "FuseFaceUltra",
    swapModelType: 4,
    logoAdd: false,
    timeoutMs: 75000,
    maxImageBytes: 5 * 1024 * 1024,
    lastCallStatus: "succeeded",
    lastCallStage: "succeeded",
    lastDurationMs: 1234,
    lastCalledAt: "2026-08-27T04:30:00.000Z"
  };
  await configuredPage.loadTencentFaceFusionStatus(1);
  assert.strictEqual(configuredPage.data.tencentFaceFusionStatus.statusText, "正常");
  assert.strictEqual(configuredPage.data.tencentFaceFusionStatus.secretId, "visible-secret-id");
  assert.strictEqual(configuredPage.data.tencentFaceFusionStatus.secretKey, "visible-secret-key");
  assert.strictEqual(configuredPage.data.form.tencentFaceFusion.secretId, "visible-secret-id");
  assert.strictEqual(configuredPage.data.form.tencentFaceFusion.secretKey, "visible-secret-key");
  assert.strictEqual(configuredPage.data.form.tencentFaceFusion.endpoint, "https://facefusion.tencentcloudapi.com");
  assert.strictEqual(configuredPage.data.tencentFaceFusionStatus.lastCallStatusText, "调用成功");
  assert.strictEqual(configuredPage.data.tencentFaceFusionStatus.lastCalledAt, "2026-08-27 12:30");

  const unconfiguredPage = createPageInstance();
  unconfiguredPage._adminLoadToken = 2;
  unconfiguredPage.data.isAdmin = true;
  tencentStatusResult = {
    configured: false,
    region: "ap-guangzhou",
    model: "FuseFaceUltra"
  };
  await unconfiguredPage.loadTencentFaceFusionStatus(2);
  assert.strictEqual(unconfiguredPage.data.tencentFaceFusionStatus.statusText, "未就绪");
  assert.strictEqual(unconfiguredPage.data.tencentFaceFusionStatus.secretId, "未配置");
  assert.strictEqual(unconfiguredPage.data.tencentFaceFusionStatus.secretKey, "未配置");

  const failedPage = createPageInstance();
  failedPage._adminLoadToken = 3;
  failedPage.data.isAdmin = true;
  tencentStatusError = new Error("status unavailable");
  await failedPage.loadTencentFaceFusionStatus(3);
  tencentStatusError = null;
  assert.strictEqual(failedPage.data.tencentFaceFusionStatus.statusText, "读取失败");
  assert.strictEqual(failedPage.data.tencentFaceFusionStatus.readFailed, true);

  console.log("admin layout state smoke: OK (主备/页签切换、重新打开重置、腾讯参数状态可显示)");
}

verifyTencentAdminStatusDisplay().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
