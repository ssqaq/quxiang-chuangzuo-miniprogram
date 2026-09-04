const assert = require("assert");
const path = require("path");

const root = path.resolve(__dirname, "..");
const configPath = require.resolve(path.join(root, "config.js"));
const config = require(configPath);
const appPath = require.resolve(path.join(root, "app.js"));
const diagnosticPath = require.resolve(path.join(root, "utils", "diagnostic-log.js"));
const cloudServicePath = require.resolve(path.join(root, "services", "cloud.js"));

const originalProfile = config.buildProfile;
const originalConfigExports = require.cache[configPath].exports;
const originalApp = global.App;
const originalWx = global.wx;
const originalDiagnostic = require.cache[diagnosticPath];
const originalCloudService = require.cache[cloudServicePath];
let appDefinition;
let allowedStorageKey = "";
let cloudGetterCalls = 0;
const networkCalls = {
  request: 0,
  requestPayment: 0,
  uploadFile: 0,
  downloadFile: 0,
  connectSocket: 0
};
const cloudCalls = {
  init: 0,
  callFunction: 0,
  uploadFile: 0,
  downloadFile: 0,
  getTempFileURL: 0,
  deleteFile: 0
};
const credentialCalls = {
  getAccountInfoSync: 0,
  getExtConfigSync: 0,
  login: 0,
  getSetting: 0,
  getUserInfo: 0,
  getUserProfile: 0
};
const secretConfigReads = [];
const storageReads = [];
const storageWrites = [];
const storage = new Map();

function countCall(bucket, name, result) {
  return () => {
    bucket[name] += 1;
    return result;
  };
}

try {
  config.buildProfile = "visual-test";
  require.cache[configPath].exports = new Proxy(config, {
    get(target, property, receiver) {
      if (/api.?key|secret|token|authorization|password|appsecret/i.test(String(property))) {
        secretConfigReads.push(String(property));
      }
      return Reflect.get(target, property, receiver);
    }
  });
  delete require.cache[diagnosticPath];
  delete require.cache[cloudServicePath];
  global.App = (definition) => { appDefinition = definition; };
  global.wx = {
    getStorageSync(key) {
      const normalized = String(key);
      assert.strictEqual(normalized, allowedStorageKey, "visual-test 启动阶段读取了非诊断本地存储");
      storageReads.push(normalized);
      return storage.get(normalized);
    },
    setStorageSync(key, value) {
      const normalized = String(key);
      assert.strictEqual(normalized, allowedStorageKey, "visual-test 启动阶段写入了非诊断本地存储");
      storageWrites.push(normalized);
      storage.set(normalized, value);
    },
    removeStorageSync() {
      throw new Error("visual-test 启动阶段不得删除本地存储");
    },
    clearStorageSync() {
      throw new Error("visual-test 启动阶段不得清空本地存储");
    }
  };
  Object.keys(networkCalls).forEach((name) => {
    global.wx[name] = countCall(networkCalls, name);
  });
  Object.keys(credentialCalls).forEach((name) => {
    global.wx[name] = countCall(credentialCalls, name, {});
  });
  const cloudSpy = {};
  Object.keys(cloudCalls).forEach((name) => {
    cloudSpy[name] = countCall(cloudCalls, name, {});
  });
  Object.defineProperty(global.wx, "cloud", {
    configurable: true,
    get() {
      cloudGetterCalls += 1;
      return cloudSpy;
    }
  });

  delete require.cache[appPath];
  require(appPath);
  const diagnosticLog = require(diagnosticPath);
  const cloudService = require(cloudServicePath);
  allowedStorageKey = diagnosticLog.STORAGE_KEY;
  assert.strictEqual(allowedStorageKey, "display-tool-diagnostic-session-v1");
  assert.strictEqual(typeof cloudService.callApi, "function", "services/cloud 未加载真实模块");
  assert.ok(appDefinition, "app.js 未注册 App");
  assert.strictEqual(appDefinition.globalData.cloudEnvId, "");
  appDefinition.onLaunch.call({ globalData: appDefinition.globalData });
  assert.strictEqual(appDefinition.globalData.cloudReady, false);
  assert.strictEqual(cloudGetterCalls, 0, "visual-test 启动阶段读取了 wx.cloud");
  Object.entries(networkCalls).forEach(([name, count]) => {
    assert.strictEqual(count, 0, `visual-test 启动阶段调用了 wx.${name}`);
  });
  Object.entries(cloudCalls).forEach(([name, count]) => {
    assert.strictEqual(count, 0, `visual-test 启动阶段调用了 wx.cloud.${name}`);
  });
  Object.entries(credentialCalls).forEach(([name, count]) => {
    assert.strictEqual(count, 0, `visual-test 启动阶段调用了 wx.${name}`);
  });
  assert.deepStrictEqual(secretConfigReads, [], "visual-test 启动阶段读取了密钥类配置");
  assert.deepStrictEqual(storageReads, [allowedStorageKey], "诊断本地存储读取次数已变化");
  assert.deepStrictEqual(
    storageWrites,
    [allowedStorageKey, allowedStorageKey, allowedStorageKey],
    "诊断本地存储写入次数已变化"
  );
  console.log("account demo app smoke: OK (真实模块、零云端/网络/支付/密钥访问，仅诊断本地存储 1 读 3 写)");
} finally {
  config.buildProfile = originalProfile;
  require.cache[configPath].exports = originalConfigExports;
  global.App = originalApp;
  global.wx = originalWx;
  if (originalDiagnostic) require.cache[diagnosticPath] = originalDiagnostic;
  else delete require.cache[diagnosticPath];
  if (originalCloudService) require.cache[cloudServicePath] = originalCloudService;
  else delete require.cache[cloudServicePath];
  delete require.cache[appPath];
}
