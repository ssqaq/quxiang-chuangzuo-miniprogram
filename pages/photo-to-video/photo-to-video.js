const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const publishExport = require("../../utils/publish-export");
const diagnosticLog = require("../../utils/diagnostic-log");

const SCOPE_OPTIONS = [
  { value: "latest", label: "最新一张" },
  { value: "all", label: "全部记录" }
];

function normalizeRecord(record, index) {
  const item = record && typeof record === "object" ? record : {};
  return {
    id: item.id || item._id || `record-${index}-${Date.now()}`,
    fileID: item.fileID || "",
    projectName: item.projectName || "未命名项目",
    createdAt: item.createdAt || "刚刚生成",
    tempFileURL: item.tempFileURL || "",
    path: item.path || "",
    selected: false,
    status: item.status || "idle",
    statusText: item.statusText || "待处理",
    videoPath: item.videoPath || ""
  };
}

function uniqueRecords(records) {
  const seen = {};
  return (Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter((item) => {
      if (seen[item.id]) return false;
      seen[item.id] = true;
      return Boolean(item.tempFileURL || item.path || item.fileID);
    });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveImageToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.saveImageToPhotosAlbum !== "function") {
      reject(new Error("当前环境不支持保存照片到相册。"));
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath,
      success(result) {
        diagnosticLog.info("video", "save-image-success", "视频流程中的照片已保存到相册", {
          filePath
        });
        resolve(result);
      },
      fail(error) {
        diagnosticLog.error("video", "save-image-failed", "视频流程中的照片保存失败", {
          filePath,
          error
        });
        reject(error);
      }
    });
  });
}

function saveVideoToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.saveVideoToPhotosAlbum !== "function") {
      reject(new Error("当前环境不支持保存视频到相册。"));
      return;
    }
    wx.saveVideoToPhotosAlbum({
      filePath,
      success(result) {
        diagnosticLog.info("video", "save-video-success", "视频已保存到相册", {
          filePath
        });
        resolve(result);
      },
      fail(error) {
        diagnosticLog.error("video", "save-video-failed", "视频保存失败", {
          filePath,
          error
        });
        reject(error);
      }
    });
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    if (!url || typeof wx.downloadFile !== "function") {
      reject(new Error("当前环境不支持下载动态视频。"));
      return;
    }
    wx.downloadFile({
      url,
      success(result) {
        if (result && result.statusCode >= 400) {
          reject(new Error(`动态视频下载失败（${result.statusCode}）`));
          return;
        }
        if (!result || !result.tempFilePath) {
          reject(new Error("动态视频下载后没有得到临时路径。"));
          return;
        }
        resolve(result.tempFilePath);
      },
      fail: reject
    });
  });
}

Page({
  data: {
    scopeOptions: SCOPE_OPTIONS,
    scope: "latest",
    usingDevicePhotos: false,
    archiveRecords: [],
    deviceRecords: [],
    records: [],
    selectedCount: 0,
    providerReady: false,
    providerMessage: "正在检查视频服务配置...",
    processing: false,
    progressValue: 0,
    progressText: "",
    failures: [],
    preview: {
      imagePath: "",
      videoPath: "",
      title: ""
    },
    isPressed: false
  },

  onShow() {
    this._destroyed = false;
    diagnosticLog.info("video", "page-show", "打开照片转动态视频页面");
    this.loadLocalRecords();
    this.refreshCloudRecords();
    this.checkVideoProvider();
  },

  onHide() {
    this.stopPreview();
    this.clearPollTimer();
  },

  onUnload() {
    this._destroyed = true;
    this.stopPreview();
    this.clearPollTimer();
  },

  loadLocalRecords() {
    const records = uniqueRecords(storage.loadRecords() || []);
    this.setData({ archiveRecords: records }, () => this.refreshVisibleRecords());
  },

  async refreshCloudRecords() {
    if (!cloud.isCloudReady() || this.data.processing) return;
    try {
      const result = await cloud.listRecords();
      const records = uniqueRecords((result && result.records) || []);
      if (records.length) {
        storage.saveRecords(records);
        this.setData({ archiveRecords: records }, () => this.refreshVisibleRecords());
      }
      diagnosticLog.info("video", "records-refresh-success", "视频页读取制作记录完成", {
        recordCount: records.length
      });
    } catch (error) {
      console.warn("[photo-to-video] 云端记录刷新失败，继续使用本地记录", error);
      diagnosticLog.warn("video", "records-refresh-failed", "视频页读取云端记录失败", {
        error
      });
    }
  },

  async checkVideoProvider() {
    if (!cloud.isCloudReady()) {
      this.setData({
        providerReady: false,
        providerMessage: "当前是本地预览模式，视频服务未连接。"
      });
      diagnosticLog.warn("video", "provider-unavailable", "视频页处于本地预览模式", {
        cloudReady: false
      });
      return;
    }
    try {
      const result = await cloud.getVideoProviderStatus();
      this.setData({
        providerReady: Boolean(result && result.ready),
        providerMessage: result && result.message
          ? result.message
          : "视频服务状态未知。"
      });
      diagnosticLog.info("video", "provider-status", "视频服务状态读取完成", {
        ready: Boolean(result && result.ready),
        message: result && result.message
      });
    } catch (error) {
      this.setData({
        providerReady: false,
        providerMessage: "视频服务状态读取失败，生成时会给出具体原因。"
      });
      diagnosticLog.error("video", "provider-status-failed", "视频服务状态读取失败", {
        error
      });
    }
  },

  refreshVisibleRecords() {
    const sourceRecords = this.data.usingDevicePhotos
      ? this.data.deviceRecords
      : this.data.archiveRecords;
    const safeRecords = Array.isArray(sourceRecords) ? sourceRecords : [];
    const selectedRecords = this.data.scope === "all" || this.data.usingDevicePhotos
      ? safeRecords.map((item) => Object.assign({}, item, { selected: true }))
      : safeRecords.map((item, index) => Object.assign({}, item, { selected: index === 0 }));
    this.setData({
      records: selectedRecords,
      selectedCount: selectedRecords.filter((item) => item.selected).length
    }, () => {
      if (selectedRecords[0] && !this.data.preview.imagePath) {
        this.selectPreviewRecord(selectedRecords[0]);
      }
    });
  },

  changeScope(event = {}) {
    const scope = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.scope;
    if (!scope) return;
    this.setData({ scope, usingDevicePhotos: false }, () => this.refreshVisibleRecords());
  },

  chooseDevicePhotos() {
    if (this.data.processing) return;
    wx.showActionSheet({
      itemList: ["从相册选择", "拍照"],
      success: (response) => {
        this.pickDevicePhotos(response.tapIndex === 1 ? "camera" : "album");
      }
    });
  },

  pickDevicePhotos(sourceType) {
    const count = sourceType === "camera"
      ? 1
      : Math.min(config.photoToVideo.maxBatch, 9);
    const success = (result = {}) => {
      const files = Array.isArray(result.tempFiles)
        ? result.tempFiles
        : (Array.isArray(result.tempFilePaths)
          ? result.tempFilePaths.map((path) => ({ tempFilePath: path }))
          : []);
      const deviceRecords = files.map((file, index) => {
        const path = file.tempFilePath || file.path || "";
        return path
          ? {
              id: `device-${Date.now()}-${index}`,
              projectName: `导入照片 ${index + 1}`,
              createdAt: "刚选择",
              path,
              selected: true,
              status: "idle",
              statusText: "待处理",
              videoPath: ""
            }
          : null;
      }).filter(Boolean);
      if (!deviceRecords.length) {
        wx.showToast({ title: "没有拿到照片", icon: "none" });
        return;
      }
      this.setData({
        deviceRecords,
        usingDevicePhotos: true,
        records: deviceRecords,
        selectedCount: deviceRecords.length,
        scope: "all"
      }, () => this.selectPreviewRecord(deviceRecords[0]));
    };
    const fail = (error = {}) => {
      if (/cancel/i.test(String(error.errMsg || ""))) return;
      wx.showToast({ title: "选择照片失败", icon: "none" });
    };

    if (typeof wx.chooseMedia === "function") {
      wx.chooseMedia({
        count,
        mediaType: ["image"],
        sourceType: [sourceType],
        sizeType: ["original"],
        success,
        fail
      });
      return;
    }
    wx.chooseImage({
      count,
      sizeType: ["original"],
      sourceType: [sourceType],
      success,
      fail
    });
  },

  toggleRecord(event = {}) {
    const id = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.id;
    if (!id || this.data.usingDevicePhotos) return;
    const records = this.data.records.map((item) => item.id === id
      ? Object.assign({}, item, { selected: !item.selected })
      : item);
    this.setData({
      records,
      selectedCount: records.filter((item) => item.selected).length
    });
  },

  previewRecord(event = {}) {
    const id = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.id;
    const record = this.data.records.find((item) => item.id === id);
    if (record) this.selectPreviewRecord(record);
  },

  selectPreviewRecord(record) {
    const imagePath = record.tempFileURL || record.path || "";
    if (!imagePath) return;
    this.stopPreview();
    this.setData({
      preview: {
        imagePath,
        videoPath: record.videoPath || "",
        title: record.projectName || "预览照片"
      }
    });
  },

  onPreviewTouchStart() {
    if (!this.data.preview.videoPath || this.data.processing) return;
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setData({ isPressed: true });
      const context = wx.createVideoContext("photo-to-video-preview", this);
      context.seek(0);
      context.play();
    }, 360);
  },

  onPreviewTouchEnd() {
    clearTimeout(this._previewTimer);
    this._previewTimer = null;
    if (!this.data.isPressed) return;
    this.stopPreview();
  },

  onPreviewTouchCancel() {
    this.onPreviewTouchEnd();
  },

  onPreviewVideoEnded() {
    if (!this.data.isPressed) return;
    const context = wx.createVideoContext("photo-to-video-preview", this);
    context.seek(0);
    context.play();
  },

  stopPreview() {
    clearTimeout(this._previewTimer);
    this._previewTimer = null;
    if (this.data.isPressed) {
      try {
        wx.createVideoContext("photo-to-video-preview", this).pause();
      } catch (error) {
        console.warn("[photo-to-video] 停止预览失败", error);
      }
    }
    if (this.data.isPressed) this.setData({ isPressed: false });
  },

  clearPollTimer() {
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },

  updateRecord(id, patch) {
    const records = this.data.records.map((item) => item.id === id
      ? Object.assign({}, item, patch)
      : item);
    this.setData({ records });
  },

  async pollVideoTask(taskId) {
    this.clearPollTimer();
    const maxPolls = Number(config.photoToVideo.maxPolls) || 120;
    const interval = Number(config.photoToVideo.pollIntervalMs) || 2500;
    for (let count = 0; count < maxPolls; count += 1) {
      if (count === 0) {
        diagnosticLog.info("video", "poll-start", "开始轮询视频任务", {
          taskId,
          maxPolls,
          interval
        });
      }
      const result = await cloud.queryVideoTask(taskId);
      const status = String(result && result.status || "").toLowerCase();
      if (["succeeded", "success", "completed"].includes(status)) {
        diagnosticLog.info("video", "poll-success", "视频任务完成", {
          taskId,
          pollCount: count + 1,
          status
        });
        return result;
      }
      if (["failed", "error", "cancelled"].includes(status)) {
        diagnosticLog.error("video", "poll-failed", "视频任务返回失败状态", {
          taskId,
          pollCount: count + 1,
          status,
          result
        });
        throw new Error(result.error || result.message || "动态视频生成失败");
      }
      if (count < maxPolls - 1) await wait(interval);
    }
    const error = new Error("动态视频生成超时，请稍后重试。");
    diagnosticLog.error("video", "poll-timeout", "视频任务轮询超时", {
      taskId,
      maxPolls,
      error
    });
    throw error;
  },

  async resolveVideoPath(result) {
    if (result && result.resultFileID) return cloud.downloadFile(result.resultFileID);
    if (result && result.videoFileID) return cloud.downloadFile(result.videoFileID);
    if (result && result.resultURL) return downloadUrl(result.resultURL);
    if (result && result.videoURL) return downloadUrl(result.videoURL);
    throw new Error("视频服务没有返回可下载的视频。");
  },

  async convertOne(record) {
    const startedAt = Date.now();
    diagnosticLog.info("video", "convert-start", "开始处理一张照片转动态视频", {
      recordId: record.id,
      projectName: record.projectName
    });
    const sourcePath = await publishExport.resolveImageSource(record);
    const upload = await cloud.uploadFile(sourcePath, "photo-to-video-input");
    const created = await cloud.createVideoTask({
      imageFileID: upload.fileID,
      durationSeconds: config.photoToVideo.durationSeconds,
      mute: true,
      outputFormat: "mp4"
    });
    if (!created || !created.taskId) {
      throw new Error("视频服务没有返回任务编号。");
    }
    diagnosticLog.info("video", "task-created", "视频任务已创建", {
      recordId: record.id,
      taskId: created.taskId,
      durationMs: Date.now() - startedAt
    });
    const result = await this.pollVideoTask(created.taskId);
    const videoPath = await this.resolveVideoPath(result);
    await saveImageToAlbum(sourcePath);
    await saveVideoToAlbum(videoPath);
    this.updateRecord(record.id, {
      status: "success",
      statusText: "已保存照片和视频",
      videoPath
    });
    this.setData({
      preview: {
        imagePath: sourcePath,
        videoPath,
        title: record.projectName
      }
    });
    diagnosticLog.info("video", "convert-success", "照片转动态视频完成", {
      recordId: record.id,
      taskId: created.taskId,
      durationMs: Date.now() - startedAt
    });
    return { videoPath };
  },

  async runBatch(records) {
    let successCount = 0;
    const failures = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      this.updateRecord(record.id, {
        status: "running",
        statusText: "正在准备"
      });
      this.setData({
        progressValue: Math.round((index / records.length) * 100),
        progressText: `正在处理第 ${index + 1} / ${records.length} 张：${record.projectName}`
      });
      try {
        await this.convertOne(record);
        successCount += 1;
      } catch (error) {
        diagnosticLog.error("video", "convert-failed", "单张照片转动态视频失败", {
          recordId: record.id,
          projectName: record.projectName,
          error
        });
        const message = this.formatError(error);
        this.updateRecord(record.id, {
          status: "failed",
          statusText: message
        });
        failures.push({
          id: record.id,
          name: record.projectName,
          message
        });
      }
    }
    this.setData({ failures });
    return { successCount, failures };
  },

  async startConvert() {
    if (this.data.processing) return;
    const records = this.data.records.filter((item) => item.selected);
    if (!records.length) {
      wx.showToast({ title: "先选择要处理的照片", icon: "none" });
      return;
    }
    diagnosticLog.info("video", "batch-start", "开始批量生成动态视频", {
      recordCount: records.length
    });
    this.setData({
      processing: true,
      progressValue: 0,
      progressText: `准备处理 ${records.length} 张照片...`,
      failures: []
    });
    try {
      const result = await this.runBatch(records);
      this.setData({
        progressValue: 100,
        progressText: `处理完成：成功 ${result.successCount} 张${result.failures.length ? `，失败 ${result.failures.length} 张` : ""}`
      });
      this.showBatchResult(result.successCount, result.failures);
      diagnosticLog.info("video", "batch-finish", "批量动态视频处理完成", {
        successCount: result.successCount,
        failureCount: result.failures.length
      });
    } finally {
      setTimeout(() => {
        if (!this._destroyed) {
          this.setData({
            processing: false,
            progressValue: 0,
            progressText: ""
          });
        }
      }, 700);
    }
  },

  async retryOne(event = {}) {
    if (this.data.processing) return;
    const id = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.id;
    const record = this.data.records.find((item) => item.id === id);
    if (!record) return;
    diagnosticLog.info("video", "retry-start", "开始重试单张动态视频", {
      recordId: record.id,
      projectName: record.projectName
    });
    this.setData({
      processing: true,
      progressValue: 0,
      progressText: `正在重试：${record.projectName}`,
      failures: this.data.failures.filter((item) => item.id !== id)
    });
    try {
      const result = await this.runBatch([record]);
      this.showBatchResult(result.successCount, result.failures);
    } finally {
      setTimeout(() => {
        if (!this._destroyed) {
          this.setData({
            processing: false,
            progressValue: 0,
            progressText: ""
          });
        }
      }, 700);
    }
  },

  formatError(error) {
    const raw = error && (error.errMsg || error.message);
    const message = String(raw || "动态视频生成失败");
    if (/VIDEO_PROVIDER_NOT_CONFIGURED/i.test(message)) {
      return "视频服务未配置，请联系管理员";
    }
    if (/VIDEO_PROVIDER_PROTOCOL_PENDING/i.test(message)) {
      return "视频服务协议还没接入，暂不能生成";
    }
    if (/auth deny|authorize|permission/i.test(message)) {
      return "没有相册权限，请在设置里允许保存照片和视频";
    }
    return message.length > 54 ? `${message.slice(0, 54)}…` : message;
  },

  showBatchResult(successCount, failures) {
    if (successCount && !failures.length) {
      wx.showToast({
        title: `已保存 ${successCount} 组`,
        icon: "success"
      });
      return;
    }
    const detail = failures.slice(0, 3)
      .map((item) => `${item.name}：${item.message}`)
      .join("\n");
    if (successCount) {
      wx.showModal({
        title: `已保存 ${successCount} 组`,
        content: `还有 ${failures.length} 张没有完成：\n${detail}`,
        showCancel: false
      });
      return;
    }
    wx.showModal({
      title: "动态视频没有生成",
      content: detail || "没有照片完成处理，请稍后重试。",
      showCancel: false
    });
  },

  goToCreate() {
    wx.navigateTo({ url: "/pages/index/index?new=1" });
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  }
});
