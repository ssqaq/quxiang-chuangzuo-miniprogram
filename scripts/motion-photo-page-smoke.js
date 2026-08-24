/* eslint-disable no-console */

const assert = require("assert");
const path = require("path");

const root = path.resolve(__dirname, "..");
const values = new Map();
const albumCalls = [];
const shareCalls = [];
const clipboardCalls = [];
let failNextMotionPhotoSave = false;
let failNextAppleShare = false;

global.getApp = () => ({
  globalData: {
    cloudReady: true
  }
});

global.wx = {
  cloud: {},
  getStorageSync(key) {
    return values.has(key) ? values.get(key) : "";
  },
  setStorageSync(key, value) {
    values.set(key, value);
  },
  removeStorageSync(key) {
    values.delete(key);
  },
  getAccountInfoSync() {
    return { miniProgram: {} };
  },
  getSystemInfoSync() {
    return { platform: "android", system: "Android 15" };
  },
  saveImageToPhotosAlbum({ filePath, success, fail }) {
    albumCalls.push({ type: "image", filePath });
    if (failNextMotionPhotoSave && filePath === "wxfile://motion-photo.jpg") {
      failNextMotionPhotoSave = false;
      fail(new Error("save image failed"));
      return;
    }
    success({});
  },
  saveVideoToPhotosAlbum({ filePath, success }) {
    albumCalls.push({ type: "video", filePath });
    success({});
  },
  shareFileMessage({ filePath, fileName, success, fail }) {
    shareCalls.push({ filePath, fileName });
    if (failNextAppleShare) {
      failNextAppleShare = false;
      fail(new Error("share failed"));
      return;
    }
    success({});
  },
  setClipboardData({ data, success }) {
    clipboardCalls.push(data);
    success({});
  },
  showToast() {},
  showModal() {}
};

let pageDefinition = null;
global.Page = (definition) => {
  pageDefinition = definition;
};

require(path.join(root, "pages", "photo-to-video", "photo-to-video.js"));
const cloud = require(path.join(root, "services", "cloud.js"));
const publishExport = require(path.join(root, "utils", "publish-export.js"));

assert.ok(pageDefinition, "照片转实况页面没有注册");

function createPage(platform) {
  const record = {
    id: "device-smoke",
    projectName: "页面流程测试",
    path: "wxfile://source.png",
    selected: true,
    status: "idle",
    statusText: "待处理"
  };
  const page = Object.assign({}, pageDefinition, {
    data: Object.assign({}, pageDefinition.data, {
      records: [record],
      preview: {
        imagePath: "",
        videoPath: "",
        title: "",
        livePhotoPath: "",
        livePhotoFileName: "",
        livePhotoTempURL: ""
      },
      isAndroidDevice: platform === "android",
      isIOSDevice: platform === "ios"
    }),
    setData(patch, callback) {
      this.data = Object.assign({}, this.data, patch);
      if (callback) callback();
    },
    _destroyed: false,
    _pageVisible: true,
    enqueuePhotoToVideoCleanup() {}
  });
  page.enqueuePhotoToVideoCleanup = () => {};
  const run = {
    id: `run-${platform}`,
    cancelled: false,
    polls: new Set()
  };
  page._activeRun = run;
  page.pollVideoTask = async () => ({
    status: "succeeded",
    requestId: "request-smoke",
    videoURL: "https://video.invalid/smoke.mp4"
  });
  page.resolveVideoPath = async () => "wxfile://result.mp4";
  return { page, record, run };
}

async function runCase(platform, options = {}) {
  albumCalls.splice(0, albumCalls.length);
  shareCalls.splice(0, shareCalls.length);
  clipboardCalls.splice(0, clipboardCalls.length);
  failNextMotionPhotoSave = Boolean(options.failMotionSave);
  failNextAppleShare = Boolean(options.failAppleShare);
  const { page, record, run } = createPage(platform);
  publishExport.resolveImageSource = async () => "wxfile://source.png";
  cloud.uploadFile = async () => ({ fileID: "cloud://source-original" });
  cloud.createVideoTask = async () => ({
    taskId: "task-smoke",
    requestId: "request-smoke",
    sourceImageFileID: "cloud://source-standardized"
  });
  let buildCalls = 0;
  let appleBuildCalls = 0;
  cloud.buildAndroidMotionPhoto = async () => {
    buildCalls += 1;
    if (options.failBuild) throw new Error("build failed");
    return {
      motionPhotoFileID: "cloud://motion-photo",
      sizeBytes: 2048,
      videoLengthBytes: 512
    };
  };
  cloud.buildAppleLivePhoto = async () => {
    appleBuildCalls += 1;
    if (options.failAppleBuild) throw new Error("apple build failed");
    return {
      livePhotoFileID: "cloud://apple-live-photo",
      fileName: "smoke.livp",
      tempFileURL: "https://temp.invalid/smoke.livp",
      sizeBytes: 4096
    };
  };
  cloud.downloadFile = async (fileID) => {
    if (fileID === "cloud://motion-photo") return "wxfile://motion-photo.jpg";
    if (fileID === "cloud://apple-live-photo") return "wxfile://smoke.livp";
    throw new Error(`unexpected fileID: ${fileID}`);
  };
  const result = await page.convertOne(record, run);
  return {
    result,
    page,
    buildCalls,
    appleBuildCalls,
    albumCalls: albumCalls.slice(),
    shareCalls: shareCalls.slice(),
    clipboardCalls: clipboardCalls.slice()
  };
}

async function main() {
  const android = await runCase("android");
  assert.strictEqual(android.buildCalls, 1);
  assert.strictEqual(android.result.deliveryMode, "android-motion-photo");
  assert.deepStrictEqual(android.albumCalls, [{
    type: "image",
    filePath: "wxfile://motion-photo.jpg"
  }]);

  const buildFallback = await runCase("android", { failBuild: true });
  assert.strictEqual(buildFallback.buildCalls, 1);
  assert.strictEqual(buildFallback.result.deliveryMode, "ordinary-video-fallback");
  assert.deepStrictEqual(buildFallback.albumCalls, [{
    type: "video",
    filePath: "wxfile://result.mp4"
  }]);

  const saveFallback = await runCase("android", { failMotionSave: true });
  assert.strictEqual(saveFallback.result.deliveryMode, "ordinary-video-fallback");
  assert.deepStrictEqual(saveFallback.albumCalls, [
    { type: "image", filePath: "wxfile://motion-photo.jpg" },
    { type: "video", filePath: "wxfile://result.mp4" }
  ]);

  const ios = await runCase("ios");
  assert.strictEqual(ios.buildCalls, 0);
  assert.strictEqual(ios.appleBuildCalls, 1);
  assert.strictEqual(ios.result.deliveryMode, "apple-livp-shared");
  assert.deepStrictEqual(ios.albumCalls, []);
  assert.deepStrictEqual(ios.shareCalls, [{
    filePath: "wxfile://smoke.livp",
    fileName: "smoke.livp"
  }]);

  const iosLink = await runCase("ios", { failAppleShare: true });
  assert.strictEqual(iosLink.result.deliveryMode, "apple-livp-link");
  assert.deepStrictEqual(iosLink.albumCalls, []);
  assert.deepStrictEqual(iosLink.clipboardCalls, [
    "https://temp.invalid/smoke.livp"
  ]);

  const iosFallback = await runCase("ios", { failAppleBuild: true });
  assert.strictEqual(iosFallback.result.deliveryMode, "ordinary-video-fallback");
  assert.deepStrictEqual(iosFallback.albumCalls, [{
    type: "video",
    filePath: "wxfile://result.mp4"
  }]);

  const unknown = await runCase("unknown");
  assert.strictEqual(unknown.buildCalls, 0);
  assert.strictEqual(unknown.appleBuildCalls, 0);
  assert.strictEqual(unknown.result.deliveryMode, "ordinary-video");
  assert.deepStrictEqual(unknown.albumCalls, [{
    type: "video",
    filePath: "wxfile://result.mp4"
  }]);

  console.log(
    "motion-photo page smoke: OK (android/apple-share/apple-link/fallback/platform)"
  );
}

main().catch((error) => {
  console.error(`motion-photo page smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
