const assert = require("assert");

const RECORDS_KEY = "display-tool-miniapp-records-v1";
const storage = {};
let page = null;
let listCalls = 0;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
  page._pageUnloaded = false;
  page._recordTempUrlInflight = new Map();
  page._recordsRefreshToken = 0;
  cloud.isCloudReady = () => true;
  let tempUrlCalls = 0;
  storage[RECORDS_KEY] = [{
    id: "file-only",
    fileID: "cloud://file-only",
    projectName: "只有云文件 ID",
    createdAt: "刚刚"
  }];
  cloud.getTempUrl = (fileID) => {
    tempUrlCalls += 1;
    return Promise.resolve(`https://fresh.example/${fileID.split("//")[1]}.jpg`);
  };
  cloud.listRecords = () => Promise.resolve({ records: [] });
  page.refreshWorkbench();
  await flush();
  await flush();
  assert.strictEqual(tempUrlCalls, 1, "只有 fileID 的本地记录应主动获取临时地址");
  assert.strictEqual(
    page.data.records[0].imagePath,
    "https://fresh.example/file-only.jpg",
    "fileID 解析成功后应立即填充工作台缩略图"
  );
  assert.strictEqual(
    storage[RECORDS_KEY][0].tempFileURL,
    "https://fresh.example/file-only.jpg",
    "临时地址应写回本地记录缓存"
  );

  page._recordTempUrlInflight = new Map();
  page._recordsRefreshToken = 1;
  storage[RECORDS_KEY] = [{
    id: "remote-empty",
    fileID: "cloud://remote-empty",
    projectName: "远端缺地址"
  }];
  tempUrlCalls = 0;
  cloud.getTempUrl = () => {
    tempUrlCalls += 1;
    return Promise.resolve("https://fresh.example/remote-empty.jpg");
  };
  cloud.listRecords = () => Promise.resolve({
    records: [{
      id: "remote-empty",
      fileID: "cloud://remote-empty",
      projectName: "远端缺地址"
    }]
  });
  page.refreshWorkbench();
  await flush();
  await flush();
  assert.strictEqual(tempUrlCalls, 1, "远端只有 fileID 时也应主动获取临时地址");
  assert.strictEqual(
    page.data.records[0].imagePath,
    "https://fresh.example/remote-empty.jpg"
  );
  assert.strictEqual(
    storage[RECORDS_KEY][0].tempFileURL,
    "https://fresh.example/remote-empty.jpg"
  );

  page._recordTempUrlInflight = new Map();
  page._recordsRefreshToken = 2;
  storage[RECORDS_KEY] = [{
    id: "cached-url",
    fileID: "cloud://cached-url",
    tempFileURL: "https://cached.example/cached-url.jpg"
  }];
  tempUrlCalls = 0;
  cloud.getTempUrl = () => {
    tempUrlCalls += 1;
    return Promise.resolve("");
  };
  cloud.listRecords = () => Promise.resolve({
    records: [{ id: "cached-url", fileID: "cloud://cached-url" }]
  });
  page.refreshWorkbench();
  await flush();
  await flush();
  assert.strictEqual(tempUrlCalls, 0, "已有可用缓存地址时不应重复请求云文件");
  assert.strictEqual(
    storage[RECORDS_KEY][0].tempFileURL,
    "https://cached.example/cached-url.jpg",
    "远端缺地址时不能覆盖本地已有缩略图地址"
  );

  page._recordTempUrlInflight = new Map();
  let resolveInflight;
  tempUrlCalls = 0;
  cloud.getTempUrl = () => {
    tempUrlCalls += 1;
    return new Promise((resolve) => {
      resolveInflight = resolve;
    });
  };
  const firstInflight = page.resolveRecordTempUrl("cloud://same");
  const secondInflight = page.resolveRecordTempUrl("cloud://same");
  assert.strictEqual(firstInflight, secondInflight, "同一 fileID 的并发请求应复用同一个 Promise");
  assert.strictEqual(tempUrlCalls, 1, "并发解析同一 fileID 只能调用一次云接口");
  resolveInflight("https://fresh.example/same.jpg");
  assert.strictEqual(await firstInflight, "https://fresh.example/same.jpg");
  await flush();
  cloud.getTempUrl = () => {
    tempUrlCalls += 1;
    return Promise.resolve("https://fresh.example/same-2.jpg");
  };
  assert.strictEqual(
    await page.resolveRecordTempUrl("cloud://same"),
    "https://fresh.example/same-2.jpg",
    "临时地址过期后应允许下一次重新获取"
  );
  assert.strictEqual(tempUrlCalls, 2);

  page.data = {
    records: [{ id: "stale", fileID: "cloud://stale", imagePath: "" }]
  };
  storage[RECORDS_KEY] = [{ id: "stale", fileID: "cloud://stale" }];
  page._recordsRefreshToken = 10;
  page._recordTempUrlInflight = new Map();
  let resolveStale;
  cloud.getTempUrl = () => new Promise((resolve) => {
    resolveStale = resolve;
  });
  const staleHydration = page.hydrateRecordImages(
    [{ id: "stale", fileID: "cloud://stale", imagePath: "" }],
    9
  );
  resolveStale("https://fresh.example/stale.jpg");
  await staleHydration;
  assert.strictEqual(page.data.records[0].imagePath, "");
  assert.strictEqual(storage[RECORDS_KEY][0].tempFileURL, undefined);

  page._pageUnloaded = false;
  page._recordsRefreshToken = 11;
  page._recordTempUrlInflight = new Map();
  let resolveUnloaded;
  cloud.getTempUrl = () => new Promise((resolve) => {
    resolveUnloaded = resolve;
  });
  const unloadedHydration = page.hydrateRecordImages(
    [{ id: "unloaded", fileID: "cloud://unloaded", imagePath: "" }],
    11
  );
  page._pageUnloaded = true;
  resolveUnloaded("https://fresh.example/unloaded.jpg");
  await unloadedHydration;
  assert.strictEqual(page.data.records[0].imagePath, "");
  page._pageUnloaded = false;

  page._recordTempUrlInflight = new Map();
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
