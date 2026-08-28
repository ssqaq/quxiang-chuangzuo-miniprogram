const assert = require("assert");

const RECORDS_KEY = "display-tool-miniapp-records-v1";
const storage = {};
let page = null;
let listCalls = 0;

global.getApp = () => ({ globalData: {} });
global.wx = {
  cloud: {},
  getAccountInfoSync() {
    return { miniProgram: { envVersion: "develop" } };
  },
  getStorageSync(key) {
    return storage[key];
  },
  setStorageSync(key, value) {
    storage[key] = value;
  },
  removeStorageSync(key) {
    delete storage[key];
  }
};
global.Page = (definition) => {
  page = definition;
};

const cloud = require("../services/cloud");
require("../pages/workbench/workbench.js");

page.setData = (next) => {
  page.data = Object.assign({}, page.data, next);
};

async function main() {
  storage[RECORDS_KEY] = [{
    id: "record-1",
    fileID: "cloud://record-1",
    tempFileURL: "https://stale.example/record-1.jpg",
    projectName: "旧缓存项目",
    createdAt: "昨天"
  }];
  cloud.isCloudReady = () => true;
  cloud.listRecords = () => {
    listCalls += 1;
    return Promise.resolve({
      records: [{
        id: "record-1",
        fileID: "cloud://record-1",
        tempFileURL: "https://fresh.example/record-1.jpg",
        projectName: "云端项目",
        createdAt: "刚刚"
      }]
    });
  };

  page.refreshWorkbench();
  assert.strictEqual(
    page.data.records[0].imagePath,
    "https://stale.example/record-1.jpg",
    "云端刷新前应先显示本地缓存"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(listCalls, 1);
  assert.strictEqual(
    page.data.records[0].imagePath,
    "https://fresh.example/record-1.jpg",
    "工作台应使用云端返回的新临时地址"
  );
  assert.strictEqual(storage[RECORDS_KEY][0].tempFileURL, "https://fresh.example/record-1.jpg");
  assert.strictEqual(page.data.records[0].fileID, "cloud://record-1");

  page.setData({
    records: [{
      id: "record-1",
      fileID: "cloud://record-1",
      tempFileURL: "https://stale.example/record-1.jpg",
      imagePath: "https://stale.example/record-1.jpg"
    }]
  });
  cloud.getTempUrl = () => Promise.resolve("https://retry.example/record-1.jpg");
  await page.onRecordImageError({
    currentTarget: { dataset: { id: "record-1" } }
  });
  assert.strictEqual(
    page.data.records[0].imagePath,
    "https://retry.example/record-1.jpg",
    "缩略图加载失败后应按 fileID 重试"
  );
  assert.strictEqual(storage[RECORDS_KEY][0].tempFileURL, "https://retry.example/record-1.jpg");

  console.log("workbench record thumbnail smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
