/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
const storage = {};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../services/cloud") return {};
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

console.log("admin layout state smoke: OK (展开/收起状态可恢复)");
