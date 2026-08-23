const assert = require("assert");
const path = require("path");
const Module = require("module");

const root = path.resolve(__dirname, "..");
const pagePath = path.join(root, "pages", "index", "index.js");

let pageDefinition = null;
let scenario = null;
let cloudCalls = 0;
let uploadCalls = 0;
let toastLog = [];
let modalLog = [];
let clipboardLog = [];
let loadingCount = 0;
let hideLoadingCount = 0;

const storageMock = {
  saveProject() {},
  loadProject() {
    return null;
  },
  clearProject() {},
  loadRecords() {
    return [];
  },
  saveRecords() {}
};

const cloudMock = {
  isCloudReady() {
    return scenario.cloudReady;
  },
  async detectFaceCircle(payload) {
    cloudCalls += 1;
    assert.strictEqual(payload.mainFileID, "cloud://main.jpg");
    if (scenario.cloudError) throw scenario.cloudError;
    return scenario.cloudResult;
  },
  async uploadFile(filePath, folder) {
    uploadCalls += 1;
    assert.strictEqual(folder, "main");
    if (scenario.uploadDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, scenario.uploadDelayMs));
    }
    if (scenario.uploadError) throw scenario.uploadError;
    return {
      fileID: "cloud://main.jpg",
      filePath
    };
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (parent && path.resolve(parent.filename) === pagePath) {
    if (request === "../../services/cloud") return cloudMock;
    if (request === "../../utils/storage") return storageMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.getApp = () => ({ globalData: { cloudReady: true } });
global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  showToast(payload) {
    toastLog.push(payload);
  },
  showModal(payload) {
    modalLog.push(payload);
  },
  setClipboardData(payload) {
    clipboardLog.push(payload);
    if (payload && typeof payload.success === "function") payload.success();
  },
  showLoading() {
    loadingCount += 1;
  },
  hideLoading() {
    hideLoadingCount += 1;
  }
};

try {
  delete require.cache[pagePath];
  require(pagePath);
} finally {
  Module._load = originalLoad;
}

assert.ok(pageDefinition, "首页 Page 定义没有加载");

function resetLogs() {
  cloudCalls = 0;
  uploadCalls = 0;
  toastLog = [];
  modalLog = [];
  clipboardLog = [];
  loadingCount = 0;
  hideLoadingCount = 0;
}

function createPage() {
  const page = Object.assign({}, pageDefinition);
  page.data = JSON.parse(JSON.stringify(pageDefinition.data));
  page.data.project = {
    projectName: "自动贴脸回归",
    mainImage: {
      path: "main.jpg",
      width: 1000,
      height: 800,
      fileID: "cloud://main.jpg",
      compressionChecked: true
    },
    maskCircle: null,
    maskFileID: "",
    faceRefs: [],
    wardrobeRefs: [],
    results: []
  };
  page.data.imageWidth = 1000;
  page.data.imageHeight = 800;
  page.data.analysisAction = "";
  page._autoFaceLogs = [];
  page.drawCount = 0;
  page.setData = function setData(patch, callback) {
    Object.assign(this.data, patch || {});
    if (typeof callback === "function") callback();
  };
  page.drawCanvas = function drawCanvas() {
    this.drawCount += 1;
  };
  return page;
}

async function runCloudSuccess() {
  resetLogs();
  scenario = {
    cloudReady: true,
    cloudResult: {
      provider: "dashscope",
      model: "qwen3-vl-flash",
      faces: [{ x: 400, y: 200, width: 200, height: 200, confidence: 0.99 }],
      timing: { totalMs: 3210, visionRequestMs: 3000, imageEncodingMs: 4, imageBytes: 1234 }
    }
  };
  const page = createPage();
  await page.autoFaceCircle();

  assert.strictEqual(cloudCalls, 1, "纯云端模式应调用一次云端检测");
  assert.strictEqual(page.data.step, 1);
  assert.ok(page.data.project.maskCircle);
  assert.strictEqual(page.data.project.maskCircle.width, 240);
  assert.strictEqual(page.data.project.maskCircle.height, 184);
  assert.strictEqual(page.data.autoFaceStatus.state, "ready");
  assert.strictEqual(page.data.autoFaceStatus.stage, "detect-complete");
  assert.strictEqual(page.data.autoFaceStatus.source, "cloud");
  assert.strictEqual(page.data.autoFaceStatus.details.detectComplete, true);
  assert.ok(page.data.autoFaceStatus.details.clientTotalMs >= 0);
  assert.ok(page.data.autoFaceStatus.summary.includes("clientTotalMs"));
  assert.ok(page.data.autoFaceLogs.length >= 4);
  page.copyAutoFaceLogs();
  assert.strictEqual(clipboardLog.length, 1, "自动贴脸日志应支持复制");
  assert.ok(clipboardLog[0].data.includes('"logs"'));
  page.toggleAutoFaceLogPanel();
  assert.strictEqual(page.data.autoFaceLogExpanded, true);
  const cloudResultStatus = page._autoFaceLogs.find((item) => item.stage === "cloud-result");
  assert.strictEqual(cloudResultStatus.details.timing.totalMs, 3210);
  assert.strictEqual(loadingCount, 1);
  assert.strictEqual(hideLoadingCount, 1);
  assert.ok(toastLog.some((item) => item.title === "云端贴脸完成"));
  assert.strictEqual(modalLog.length, 0);
  assert.strictEqual(page.data.analysisAction, "");

  await page.autoFaceCircle();
  assert.strictEqual(cloudCalls, 1, "同一张主图重复点击应命中识别缓存");
  assert.strictEqual(page.data.autoFaceStatus.stage, "cache-hit");
  assert.strictEqual(page.data.autoFaceStatus.source, "cache");
  assert.ok(toastLog.some((item) => item.title === "已复用上次贴脸结果"));
}

async function runMainImageUploadReuse() {
  resetLogs();
  scenario = {
    cloudReady: true,
    uploadDelayMs: 20,
    cloudResult: {
      provider: "dashscope",
      model: "qwen3-vl-flash",
      faces: [{ x: 400, y: 200, width: 200, height: 200, confidence: 0.99 }],
      timing: { totalMs: 3210, visionRequestMs: 3000, imageEncodingMs: 4, imageBytes: 1234 }
    }
  };
  const page = createPage();
  page.data.project.mainImage.fileID = "";
  const backgroundUpload = page.preloadMainImageUpload(page.data.project.mainImage);
  await page.autoFaceCircle();
  await backgroundUpload;

  assert.strictEqual(uploadCalls, 1, "后台预上传和自动贴脸不能重复上传主图");
  assert.strictEqual(cloudCalls, 1);
  assert.strictEqual(page.data.project.mainImage.fileID, "cloud://main.jpg");
  assert.strictEqual(page.data.autoFaceStatus.state, "ready");
}

async function runCloudFailureManualFallback() {
  resetLogs();
  const cloudError = new Error("云端自动贴脸失败");
  cloudError.payload = {
    errorCode: "vision-upstream-failed",
    message: "视觉服务暂时不可用",
    requestId: "req-smoke-face"
  };
  scenario = {
    cloudReady: true,
    cloudError
  };
  const page = createPage();
  await page.autoFaceCircle();

  assert.strictEqual(cloudCalls, 1);
  assert.strictEqual(page.data.step, 1, "云端失败后必须进入手动圈选步骤");
  assert.strictEqual(page.data.project.maskCircle, null);
  assert.strictEqual(page.data.autoFaceStatus.state, "manual-required");
  assert.strictEqual(page.data.autoFaceStatus.stage, "cloud-failed");
  assert.strictEqual(page.data.autoFaceStatus.source, "manual");
  assert.strictEqual(
    page.data.autoFaceStatus.details.cloudError.requestId,
    "req-smoke-face"
  );
  assert.ok(modalLog.some((item) => (
    item.title === "请手动圈选"
    && item.content.includes("请求编号：req-smoke-face")
  )));
  assert.strictEqual(loadingCount, 1);
  assert.strictEqual(hideLoadingCount, 1);
  assert.strictEqual(page.data.analysisAction, "");
}

async function runCloudUnavailableManualFallback() {
  resetLogs();
  scenario = { cloudReady: false };
  const page = createPage();
  await page.autoFaceCircle();

  assert.strictEqual(cloudCalls, 0, "云端未连接时不能发起云函数调用");
  assert.strictEqual(page.data.step, 1);
  assert.strictEqual(page.data.project.maskCircle, null);
  assert.strictEqual(page.data.autoFaceStatus.state, "manual-required");
  assert.strictEqual(page.data.autoFaceStatus.stage, "cloud-unavailable");
  assert.strictEqual(page.data.autoFaceStatus.source, "manual");
  assert.ok(modalLog.some((item) => item.content.includes("当前没有连接云端")));
  assert.strictEqual(loadingCount, 0);
  assert.strictEqual(hideLoadingCount, 0);
  assert.strictEqual(page.data.analysisAction, "");
}

async function main() {
  await runCloudSuccess();
  await runMainImageUploadReuse();
  await runCloudFailureManualFallback();
  await runCloudUnavailableManualFallback();
  console.log("auto face cloud-only smoke: OK");
  console.log(JSON.stringify({
    cloudSuccess: true,
    mainImageUploadReuse: true,
    cloudFailureManualFallback: true,
    cloudUnavailableManualFallback: true
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
