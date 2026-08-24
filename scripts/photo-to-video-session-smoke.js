const assert = require("assert");
const path = require("path");

const root = path.resolve(__dirname, "..");
const values = new Map();
const removedFiles = [];

global.getApp = () => ({
  globalData: {
    cloudReady: false
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
  getFileSystemManager() {
    return {
      unlink({ filePath, success }) {
        removedFiles.push(filePath);
        success();
      }
    };
  },
  getAccountInfoSync() {
    return { miniProgram: {} };
  },
  getSystemInfoSync() {
    return {};
  }
};

let pageDefinition = null;
global.Page = (definition) => {
  pageDefinition = definition;
};

require(path.join(root, "pages", "photo-to-video", "photo-to-video.js"));
const storage = require(path.join(root, "utils", "storage.js"));

assert.ok(pageDefinition, "照片转视频页面没有注册");

const page = Object.assign({
  data: {
    processing: false,
    archiveRecords: [],
    records: [],
    preview: {
      imagePath: "",
      videoPath: "",
      title: ""
    }
  },
  setData(patch, callback) {
    this.data = Object.assign({}, this.data, patch);
    if (callback) callback();
  },
  _destroyed: false,
  _pageVisible: true
}, pageDefinition);

storage.saveRecords([
  { id: "record-1", path: "wxfile://tmp/formal.jpg" },
  { id: "record-2", path: "wxfile://tmp/keep.jpg" }
]);
storage.saveProject({
  results: [
    { id: "record-1", path: "wxfile://tmp/formal.jpg" },
    { id: "record-2", path: "wxfile://tmp/keep.jpg" }
  ]
});

const sessionId = page.openPhotoToVideoCleanupSession();
assert.ok(sessionId.startsWith("photo-video-session-"));

page.enqueuePhotoToVideoCleanup("record-1", "record", {
  recordId: "record-1",
  localPaths: ["wxfile://tmp/formal.jpg", "wxfile://tmp/formal.mp4"],
  registerCloud: false
});
page.closePhotoToVideoCleanupSession();

const closedSession = storage.loadPhotoToVideoSession();
assert.strictEqual(closedSession.id, sessionId);
assert.ok(closedSession.closedAt > 0);
assert.strictEqual(
  closedSession.cleanupAfter - closedSession.closedAt,
  2 * 60 * 60 * 1000,
  "页面关闭后本地缓存必须进入 2 小时倒计时"
);

const queue = storage.loadPhotoToVideoCleanup();
assert.strictEqual(queue.length, 1);
assert.strictEqual(queue[0].recordId, "record-1");
assert.strictEqual(
  queue[0].cleanupAfter - queue[0].closedAt,
  2 * 60 * 60 * 1000
);

queue[0].cleanupAfter = Date.now() - 1;
storage.savePhotoToVideoCleanup(queue);

page.flushPhotoToVideoCleanup().then(() => {
  assert.deepStrictEqual(
    storage.loadRecords().map((item) => item.id),
    ["record-2"],
    "到期后必须删除对应的本地正式制作记录"
  );
  assert.deepStrictEqual(
    storage.loadProject().results.map((item) => item.id),
    ["record-2"],
    "到期后必须从当前项目结果缓存删除对应记录"
  );
  assert.deepStrictEqual(
    removedFiles.sort(),
    ["wxfile://tmp/formal.jpg", "wxfile://tmp/formal.mp4"].sort(),
    "到期后必须清理照片转视频的本地临时路径"
  );
  assert.deepStrictEqual(storage.loadPhotoToVideoCleanup(), []);
  console.log("photo-to-video session smoke: OK");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
