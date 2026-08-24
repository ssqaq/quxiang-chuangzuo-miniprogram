const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const publishExport = require("../../utils/publish-export");
const diagnosticLog = require("../../utils/diagnostic-log");

const SCOPE_OPTIONS = [
  { value: "latest", label: "最新一张" },
  { value: "all", label: "全部记录" }
];

function firstRecordValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim()) || "";
}

function isCloudFileId(value) {
  return /^cloud:\/\//i.test(String(value || ""));
}

function normalizeRecord(record, index) {
  const item = record && typeof record === "object" ? record : {};
  const sourceCandidate = firstRecordValue(item.sourcePath, item.path);
  const sourceFileID = firstRecordValue(
    item.sourceFileID,
    item.fileID,
    isCloudFileId(sourceCandidate) ? sourceCandidate : "",
    isCloudFileId(item.tempFileURL) ? item.tempFileURL : ""
  );
  const sourcePath = isCloudFileId(sourceCandidate) ? "" : sourceCandidate;
  const displayCandidate = firstRecordValue(item.displayURL, item.tempFileURL, sourcePath);
  const displayURL = isCloudFileId(displayCandidate) ? "" : displayCandidate;
  const resultPath = firstRecordValue(item.resultPath, item.videoPath);
  const resultFileID = firstRecordValue(item.resultFileID, item.videoFileID);
  return {
    id: item.id || item._id || `record-${index}-${Date.now()}`,
    fileID: sourceFileID,
    sourceFileID,
    resultFileID,
    projectName: item.projectName || "未命名项目",
    createdAt: item.createdAt || "刚刚生成",
    displayURL,
    tempFileURL: firstRecordValue(item.tempFileURL, displayURL),
    sourcePath,
    path: sourcePath,
    selected: false,
    status: item.status || "idle",
    statusText: item.statusText || "待处理",
    resultPath,
    videoPath: resultPath
  };
}

function uniqueRecords(records) {
  const seen = {};
  return (Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter((item) => {
      if (seen[item.id]) return false;
      seen[item.id] = true;
      return Boolean(item.displayURL || item.sourcePath || item.sourceFileID);
    });
}

function createCancelledError() {
  const error = new Error("页面已离开，已停止当前处理。");
  error.code = "PHOTO_TO_VIDEO_CANCELLED";
  error.cancelled = true;
  return error;
}

function isCancelledError(error) {
  return Boolean(error && (error.cancelled || error.code === "PHOTO_TO_VIDEO_CANCELLED"));
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
    this._pageVisible = true;
    if (this.data.processing && !this._activeRun) {
      this.setData({
        processing: false,
        progressValue: 0,
        progressText: ""
      });
    }
    diagnosticLog.info("video", "page-show", "打开照片转动态视频页面");
    this.flushPhotoToVideoCleanup();
    this.loadLocalRecords();
    this.refreshCloudRecords();
    this.checkVideoProvider();
  },

  onHide() {
    this._pageVisible = false;
    this.cancelActiveRun();
    this.clearFinishTimer();
    this.stopPreview();
  },

  onUnload() {
    this._destroyed = true;
    this._pageVisible = false;
    this.cancelActiveRun();
    this.clearFinishTimer();
    this.stopPreview();
  },

  isPageActive() {
    return !this._destroyed && this._pageVisible !== false;
  },

  isRunActive(run) {
    return this.isPageActive() && run && !run.cancelled && this._activeRun === run;
  },

  setDataIfActive(data, callback) {
    if (!this.isPageActive()) return false;
    this.setData(data, callback);
    return true;
  },

  beginRun() {
    this.cancelActiveRun();
    const run = {
      id: `photo-to-video-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cancelled: false,
      polls: new Set()
    };
    this._activeRun = run;
    return run;
  },

  cancelActiveRun() {
    const run = this._activeRun;
    if (run) {
      run.cancelled = true;
      run.polls.forEach((poll) => {
        clearTimeout(poll.timer);
        poll.reject(createCancelledError());
      });
      run.polls.clear();
    }
    this._activeRun = null;
  },

  finishRun(run) {
    if (this._activeRun === run) this._activeRun = null;
  },

  clearFinishTimer() {
    if (this._finishTimer) {
      clearTimeout(this._finishTimer);
      this._finishTimer = null;
    }
  },

  getCleanupConfig() {
    const cleanup = config.photoToVideo && config.photoToVideo.cleanup;
    return {
      enabled: cleanup ? cleanup.enabled !== false : true,
      gracePeriodMs: Math.max(
        60 * 60 * 1000,
        Number(cleanup && cleanup.gracePeriodMs) || 24 * 60 * 60 * 1000
      ),
      maxQueueItems: Math.max(
        1,
        Number(cleanup && cleanup.maxQueueItems) || 100
      )
    };
  },

  enqueuePhotoToVideoCleanup(fileID, kind) {
    const cleanupConfig = this.getCleanupConfig();
    if (!cleanupConfig.enabled || !fileID || !cloud.isCloudReady()) return;
    const now = Date.now();
    const queue = Array.isArray(storage.loadPhotoToVideoCleanup())
      ? storage.loadPhotoToVideoCleanup()
      : [];
    const key = `${kind || "file"}:${fileID}`;
    const existing = queue.find((item) => item.key === key);
    if (existing) {
      existing.cleanupAfter = Math.min(
        Number(existing.cleanupAfter) || now + cleanupConfig.gracePeriodMs,
        now + cleanupConfig.gracePeriodMs
      );
      existing.updatedAt = now;
    } else {
      queue.push({
        key,
        fileID,
        kind: kind || "file",
        createdAt: now,
        updatedAt: now,
        cleanupAfter: now + cleanupConfig.gracePeriodMs,
        attempts: 0,
        lastError: ""
      });
    }
    storage.savePhotoToVideoCleanup(queue);
    if (typeof cloud.registerPhotoToVideoTempAsset === "function") {
      cloud.registerPhotoToVideoTempAsset(fileID, kind || "file").catch((error) => {
        diagnosticLog.warn("video", "cleanup-register-failed", "照片转视频临时云文件登记失败，保留本地清理队列", {
          fileID,
          kind,
          error
        });
      });
    }
  },

  isCleanupNotFoundError(error) {
    return /not.?found|不存在|不存在该文件|file.?not.?exist|no such file/i
      .test(String(error && (error.errMsg || error.message) || error || ""));
  },

  async flushPhotoToVideoCleanup() {
    const cleanupConfig = this.getCleanupConfig();
    if (
      !cleanupConfig.enabled
      || !cloud.isCloudReady()
      || this._cleanupPromise
    ) {
      return this._cleanupPromise || null;
    }
    this._cleanupPromise = (async () => {
      const now = Date.now();
      const queue = Array.isArray(storage.loadPhotoToVideoCleanup())
        ? storage.loadPhotoToVideoCleanup()
        : [];
      const due = queue
        .filter((item) => item && item.fileID && Number(item.cleanupAfter) <= now)
        .slice(0, cleanupConfig.maxQueueItems);
      if (!due.length) return;
      const dueKeys = new Set(due.map((item) => item.key));
      const retained = queue.filter((item) => !dueKeys.has(item.key));
      for (const item of due) {
        try {
          await cloud.deleteFile(item.fileID);
          diagnosticLog.info("video", "cleanup-success", "照片转视频临时云文件已清理", {
            fileID: item.fileID,
            kind: item.kind
          });
        } catch (error) {
          if (this.isCleanupNotFoundError(error)) {
            diagnosticLog.info("video", "cleanup-already-gone", "照片转视频临时云文件已不存在", {
              fileID: item.fileID,
              kind: item.kind
            });
            continue;
          }
          retained.push(Object.assign({}, item, {
            attempts: (Number(item.attempts) || 0) + 1,
            updatedAt: Date.now(),
            lastError: this.formatError(error)
          }));
          diagnosticLog.warn("video", "cleanup-failed", "照片转视频临时云文件清理失败，将稍后重试", {
            fileID: item.fileID,
            kind: item.kind,
            error
          });
        }
      }
      storage.savePhotoToVideoCleanup(retained);
    })().finally(() => {
      this._cleanupPromise = null;
    });
    return this._cleanupPromise;
  },

  assertRunActive(run) {
    if (!this.isRunActive(run)) throw createCancelledError();
  },

  loadLocalRecords() {
    const records = uniqueRecords(storage.loadRecords() || []);
    this.setDataIfActive({ archiveRecords: records }, () => this.refreshVisibleRecords());
  },

  async refreshCloudRecords() {
    if (!this.isPageActive() || !cloud.isCloudReady() || this.data.processing) return;
    try {
      const result = await cloud.listRecords();
      if (!this.isPageActive()) return;
      const records = uniqueRecords((result && result.records) || []);
      if (records.length) {
        storage.saveRecords(records);
        this.setDataIfActive({ archiveRecords: records }, () => this.refreshVisibleRecords());
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
      this.setDataIfActive({
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
      this.setDataIfActive({
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
      this.setDataIfActive({
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
    this.setDataIfActive({
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
    this.setDataIfActive({ scope, usingDevicePhotos: false }, () => this.refreshVisibleRecords());
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
              resultPath: "",
              videoPath: ""
            }
          : null;
      }).filter(Boolean);
      if (!deviceRecords.length) {
        wx.showToast({ title: "没有拿到照片", icon: "none" });
        return;
      }
      this.setDataIfActive({
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
    this.setDataIfActive({
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
    const item = normalizeRecord(record, 0);
    const previewToken = (this._previewToken || 0) + 1;
    this._previewToken = previewToken;
    this._previewFallbackToken = 0;
    this._previewRecord = item;
    const imageCandidate = item.displayURL || item.sourcePath || "";
    const imagePath = isCloudFileId(imageCandidate) ? "" : imageCandidate;
    const resultPath = isCloudFileId(item.resultPath) ? "" : item.resultPath;
    this.stopPreview();
    this.setDataIfActive({
      preview: {
        imagePath,
        videoPath: resultPath,
        title: item.projectName || "预览照片"
      }
    });
    if (!imagePath && item.sourceFileID) {
      this.resolvePreviewSource(item, previewToken);
    }
    if (!resultPath && item.resultFileID) {
      this.resolvePreviewVideo(item, previewToken);
    }
  },

  async resolvePreviewSource(record, previewToken) {
    try {
      const imagePath = await publishExport.resolveImageSource(record);
      if (
        this._previewToken !== previewToken
        || !this.isPageActive()
      ) return;
      this.setDataIfActive({
        preview: Object.assign({}, this.data.preview, { imagePath })
      });
    } catch (error) {
      diagnosticLog.warn("video", "preview-source-failed", "预览照片路径失效且无法重新读取", {
        error
      });
    }
  },

  async resolvePreviewVideo(record, previewToken) {
    try {
      const videoPath = await this.resolveVideoPath(record);
      if (
        this._previewToken !== previewToken
        || !this.isPageActive()
      ) return;
      this.setDataIfActive({
        preview: Object.assign({}, this.data.preview, { videoPath })
      });
    } catch (error) {
      diagnosticLog.warn("video", "preview-result-failed", "预览视频路径失效且无法重新读取", {
        error
      });
    }
  },

  onPreviewImageError() {
    const record = this._previewRecord;
    if (
      !record
      || !record.sourceFileID
      || this._previewFallbackLoading
      || this._previewFallbackToken === this._previewToken
    ) return;
    this._previewFallbackToken = this._previewToken;
    this._previewFallbackLoading = true;
    const previewToken = this._previewToken;
    publishExport.resolveImageSource(Object.assign({}, record, {
      sourcePath: "",
      path: "",
      displayURL: "",
      tempFileURL: ""
    }))
      .then((imagePath) => {
        if (this._previewToken === previewToken && this.isPageActive()) {
          this.setDataIfActive({
            preview: Object.assign({}, this.data.preview, { imagePath })
          });
        }
      })
      .catch((error) => {
        diagnosticLog.warn("video", "preview-image-fallback-failed", "预览照片临时路径已失效，云端回退也失败", {
          error
        });
      })
      .finally(() => {
        this._previewFallbackLoading = false;
      });
  },

  onPreviewTouchStart() {
    if (!this.data.preview.videoPath || this.data.processing) return;
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => {
      if (this._destroyed) return;
      this.setDataIfActive({ isPressed: true });
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
    if (this.data.isPressed) this.setDataIfActive({ isPressed: false });
  },

  waitForPoll(ms, run) {
    this.assertRunActive(run);
    return new Promise((resolve, reject) => {
      const poll = {
        timer: null,
        reject
      };
      run.polls.add(poll);
      poll.timer = setTimeout(() => {
        run.polls.delete(poll);
        try {
          this.assertRunActive(run);
          resolve();
        } catch (error) {
          reject(error);
        }
      }, ms);
    });
  },

  updateRecord(id, patch, run) {
    if (run && !this.isRunActive(run)) return false;
    const records = this.data.records.map((item) => item.id === id
      ? Object.assign({}, item, patch)
      : item);
    return this.setDataIfActive({ records });
  },

  async pollVideoTask(taskId, run, requestId) {
    const maxPolls = Number(config.photoToVideo.maxPolls) || 120;
    const interval = Number(config.photoToVideo.pollIntervalMs) || 2500;
    for (let count = 0; count < maxPolls; count += 1) {
      this.assertRunActive(run);
      if (count === 0) {
        diagnosticLog.info("video", "poll-start", "开始轮询视频任务", {
          taskId,
          requestId,
          maxPolls,
          interval
        });
      }
      const result = await cloud.queryVideoTask(taskId, { requestId });
      this.assertRunActive(run);
      const status = String(result && result.status || "").toLowerCase();
      if (["succeeded", "success", "completed"].includes(status)) {
        diagnosticLog.info("video", "poll-success", "视频任务完成", {
          taskId,
          requestId: result && result.requestId || requestId,
          pollCount: count + 1,
          status
        });
        return result;
      }
      if (["failed", "error", "cancelled"].includes(status)) {
        diagnosticLog.error("video", "poll-failed", "视频任务返回失败状态", {
          taskId,
          requestId: result && result.requestId || requestId,
          pollCount: count + 1,
          status,
          result
        });
        throw new Error(result.error || result.message || "动态视频生成失败");
      }
      if (count < maxPolls - 1) await this.waitForPoll(interval, run);
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
    if (result && result.resultPath && !isCloudFileId(result.resultPath)) {
      return result.resultPath;
    }
    if (result && result.videoPath && !isCloudFileId(result.videoPath)) {
      return result.videoPath;
    }
    if (result && result.resultFileID) return cloud.downloadFile(result.resultFileID);
    if (result && result.videoFileID) return cloud.downloadFile(result.videoFileID);
    if (result && result.resultURL) return downloadUrl(result.resultURL);
    if (result && result.videoURL) return downloadUrl(result.videoURL);
    throw new Error("视频服务没有返回可下载的视频。");
  },

  async convertOne(record, run) {
    this.assertRunActive(run);
    const startedAt = Date.now();
    const requestId = `video-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
    const videoConfig = config.photoToVideo || {};
    const prompt = String(
      videoConfig.prompt
      || "让照片中的人物自然轻微运动，保持人物身份、脸部、发型、服装和背景不变，镜头稳定，动作连贯，不要新增人物，不要变形。"
    ).trim();
    const resolution = String(videoConfig.resolution || "720p").trim();
    diagnosticLog.info("video", "convert-start", "开始处理一张照片转动态视频", {
      recordId: record.id,
      projectName: record.projectName,
      requestId,
      prompt,
      resolution
    });
    const sourcePath = await publishExport.resolveImageSource(record);
    this.assertRunActive(run);
    const upload = await cloud.uploadFile(sourcePath, "photo-to-video-input");
    this.enqueuePhotoToVideoCleanup(upload.fileID, "source");
    this.assertRunActive(run);
    const created = await cloud.createVideoTask({
      imageFileID: upload.fileID,
      durationSeconds: config.photoToVideo.durationSeconds,
      prompt,
      resolution,
      mute: true,
      outputFormat: "mp4"
    }, { requestId });
    if (!created || !created.taskId) {
      throw new Error("视频服务没有返回任务编号。");
    }
    diagnosticLog.info("video", "task-created", "视频任务已创建", {
      recordId: record.id,
      taskId: created.taskId,
      requestId: created.requestId || requestId,
      durationMs: Date.now() - startedAt
    });
    const result = await this.pollVideoTask(
      created.taskId,
      run,
      created.requestId || requestId
    );
    const resultFileID = result && (result.resultFileID || result.videoFileID || "");
    if (resultFileID) {
      this.enqueuePhotoToVideoCleanup(resultFileID, "result");
    }
    const resultPath = await this.resolveVideoPath(result);
    this.assertRunActive(run);
    await saveImageToAlbum(sourcePath);
    this.assertRunActive(run);
    await saveVideoToAlbum(resultPath);
    this.assertRunActive(run);
    this.updateRecord(record.id, {
      status: "success",
      statusText: "已保存照片和视频",
      resultPath,
      videoPath: resultPath,
      sourcePath,
      sourceFileID: upload.fileID,
      resultFileID
    }, run);
    this.setDataIfActive({
      preview: {
        imagePath: sourcePath,
        videoPath: resultPath,
        title: record.projectName
      }
    });
    diagnosticLog.info("video", "convert-success", "照片转动态视频完成", {
      recordId: record.id,
      taskId: created.taskId,
      requestId: result && result.requestId || created.requestId || requestId,
      durationMs: Date.now() - startedAt
    });
    return { resultPath };
  },

  async runBatch(records, run) {
    let successCount = 0;
    const failures = [];
    let nextIndex = 0;
    let completedCount = 0;
    const concurrency = Math.max(
      1,
      Math.min(Number(config.photoToVideo.maxConcurrent) || 1, records.length)
    );
    const worker = async () => {
      while (true) {
        this.assertRunActive(run);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= records.length) return;
        const record = records[index];
        this.updateRecord(record.id, {
          status: "running",
          statusText: "正在准备"
        }, run);
        this.setDataIfActive({
          progressValue: Math.round((completedCount / records.length) * 100),
          progressText: `正在处理：${record.projectName}（已完成 ${completedCount} / ${records.length}）`
        });
        try {
          await this.convertOne(record, run);
          successCount += 1;
        } catch (error) {
          if (isCancelledError(error)) throw error;
          diagnosticLog.error("video", "convert-failed", "单张照片转动态视频失败", {
            recordId: record.id,
            projectName: record.projectName,
            error
          });
          const message = this.formatError(error);
          this.updateRecord(record.id, {
            status: "failed",
            statusText: message
          }, run);
          failures.push({
            id: record.id,
            name: record.projectName,
            message
          });
        } finally {
          completedCount += 1;
          this.setDataIfActive({
            progressValue: Math.round((completedCount / records.length) * 100),
            progressText: `已完成 ${completedCount} / ${records.length} 张`
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.setDataIfActive({ failures });
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
    const run = this.beginRun();
    this.setDataIfActive({
      processing: true,
      progressValue: 0,
      progressText: `准备处理 ${records.length} 张照片...`,
      failures: []
    });
    try {
      const result = await this.runBatch(records, run);
      if (!this.isRunActive(run)) return;
      this.setDataIfActive({
        progressValue: 100,
        progressText: `处理完成：成功 ${result.successCount} 张${result.failures.length ? `，失败 ${result.failures.length} 张` : ""}`
      });
      this.showBatchResult(result.successCount, result.failures);
      diagnosticLog.info("video", "batch-finish", "批量动态视频处理完成", {
        successCount: result.successCount,
        failureCount: result.failures.length
      });
    } catch (error) {
      if (!isCancelledError(error) && this.isRunActive(run)) {
        wx.showToast({ title: this.formatError(error), icon: "none" });
      }
    } finally {
      this.finishRun(run);
      this.clearFinishTimer();
      this._finishTimer = setTimeout(() => {
        this._finishTimer = null;
        if (this.isPageActive()) {
          this.setDataIfActive({
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
    const run = this.beginRun();
    this.setDataIfActive({
      processing: true,
      progressValue: 0,
      progressText: `正在重试：${record.projectName}`,
      failures: this.data.failures.filter((item) => item.id !== id)
    });
    try {
      const result = await this.runBatch([record], run);
      if (!this.isRunActive(run)) return;
      this.showBatchResult(result.successCount, result.failures);
    } catch (error) {
      if (!isCancelledError(error) && this.isRunActive(run)) {
        wx.showToast({ title: this.formatError(error), icon: "none" });
      }
    } finally {
      this.finishRun(run);
      this.clearFinishTimer();
      this._finishTimer = setTimeout(() => {
        this._finishTimer = null;
        if (this.isPageActive()) {
          this.setDataIfActive({
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
