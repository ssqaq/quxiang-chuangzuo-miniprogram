/* eslint-disable no-console */

const assert = require("assert");
const Module = require("module");

let pageDefinition = null;
let pipelineCalls = 0;
let statusCalls = 0;
let savedRecords = [];
const events = [];

const cloudMock = {
  isCloudReady: () => true,
  getAdminStatus: async () => ({ isAdmin: true }),
  uploadAsset: async (_path, kind) => ({
    fileID: `cloud://${kind}-file`
  }),
  tencentFaceFusionPipeline: async () => {
    pipelineCalls += 1;
    const error = new Error("cloud.callFunction timeout");
    error.code = "timeout";
    throw error;
  },
  getTencentFaceFusionPipelineStatus: async (requestId) => {
    statusCalls += 1;
    if (statusCalls === 1) {
      return {
        requestId,
        stage: "face-detection",
        progress: 20,
        stageText: "正在检测主图中的人脸"
      };
    }
    return {
      requestId,
      stage: "succeeded",
      progress: 100,
      result: {
        requestId,
        recordId: "record-timeout-recovered",
        fileID: "cloud://result-timeout-recovered",
        tempFileURL: "https://example.invalid/result.png",
        createdAt: "2026-08-26T08:00:00.000Z",
        record: {
          id: "record-timeout-recovered",
          projectName: "腾讯版自动换脸",
          fileID: "cloud://result-timeout-recovered",
          tempFileURL: "https://example.invalid/result.png",
          createdAt: "2026-08-26T08:00:00.000Z"
        }
      }
    };
  }
};

const storageMock = {
  loadRecords: () => savedRecords,
  saveRecords: (records) => {
    savedRecords = records;
  }
};

const diagnosticLogMock = {
  info() {},
  warn() {},
  error() {}
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../../config") return { appVersion: "0.42.4", imageCompression: {} };
  if (request === "../../services/cloud") return cloudMock;
  if (request === "../../utils/storage") return storageMock;
  if (request === "../../utils/diagnostic-log") return diagnosticLogMock;
  if (request === "../../utils/image") {
    return {
      prepareImageAsset: async (file) => ({
        path: file.tempFilePath,
        type: "image/png",
        compressedSize: file.size || 1,
        width: 100,
        height: 100
      })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.Page = (definition) => {
  pageDefinition = definition;
};
global.wx = {
  showToast(options) {
    events.push({ type: "toast", options });
  },
  showModal(options) {
    events.push({ type: "modal", options });
    if (options && options.success) options.success();
  },
  navigateBack(options) {
    events.push({ type: "navigateBack", options });
  },
  navigateTo(options) {
    events.push({ type: "navigateTo", options });
  },
  reLaunch(options) {
    events.push({ type: "reLaunch", options });
  }
};

require("../pages/tencent-face-fusion/tencent-face-fusion.js");
Module._load = originalLoad;

assert.ok(pageDefinition, "腾讯版页面没有注册成功");

function createPageInstance() {
  const instance = {
    data: JSON.parse(JSON.stringify(pageDefinition.data)),
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
      instance[key] = pageDefinition[key].bind(instance);
    }
  });
  return instance;
}

async function main() {
  const page = createPageInstance();
  await page.onLoad();
  assert.strictEqual(page.data.adminAccessState, "granted");
  assert.strictEqual(page.data.adminAccessGranted, true);
  page.setData({
    mainImage: {
      path: "main.png",
      name: "main.png",
      type: "image/png",
      fileID: ""
    },
    faceImage: {
      path: "face.png",
      name: "face.png",
      type: "image/png",
      fileID: ""
    },
    prompt: "换衣服和背景"
  });

  await page.startPipeline();
  assert.strictEqual(pipelineCalls, 1, "首次只能提交一次腾讯流水线");
  assert.strictEqual(page.data.timedOut, true, "调用超时后必须进入等待超时状态");
  assert.ok(page.data.requestId, "超时后必须保留 requestId");
  assert.ok(page.data.timeoutHint.includes(page.data.requestId));
  const originalRequestId = page.data.requestId;

  await page.startPipeline();
  assert.strictEqual(pipelineCalls, 1, "超时后再次点击不能重新提交，避免重复扣费");
  assert.strictEqual(page.data.requestId, originalRequestId);

  await page.continueStatusQuery();
  assert.strictEqual(pipelineCalls, 1, "继续查询只能查状态，不能重新提交流水线");
  assert.ok(statusCalls >= 2, "继续查询必须调用状态接口");
  assert.strictEqual(page.data.timedOut, false);
  assert.strictEqual(page.data.stage, "succeeded");
  assert.strictEqual(page.data.resultRecordId, "record-timeout-recovered");
  assert.strictEqual(savedRecords[0].id, "record-timeout-recovered");
  assert.strictEqual(page.data.requestId, originalRequestId);

  page.onUnload();

  cloudMock.getAdminStatus = async () => ({ isAdmin: false });
  const deniedPage = createPageInstance();
  await deniedPage.onLoad();
  assert.strictEqual(deniedPage.data.adminAccessState, "denied");
  assert.strictEqual(deniedPage.data.adminAccessGranted, false);
  assert.ok(events.some((item) => (
    item.type === "modal"
    && item.options.content === "该功能正在测试中，仅管理员可用。"
  )));
  cloudMock.getAdminStatus = async () => ({ isAdmin: true });

  console.log("tencent face fusion page smoke: OK");
  console.log(JSON.stringify({
    pipelineCalls,
    statusCalls,
    requestIdPreserved: page.data.requestId === originalRequestId,
    recoveredFromStatusQuery: page.data.stage === "succeeded",
    ordinaryUserDenied: deniedPage.data.adminAccessGranted === false
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
