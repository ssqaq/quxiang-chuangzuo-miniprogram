const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const publishExport = require("../../utils/publish-export");
const publishExportCore = require("../../utils/publish-export-core");
const diagnosticLog = require("../../utils/diagnostic-log");

const SCOPE_OPTIONS = [
  { value: "latest", label: "最新一张" },
  { value: "all", label: "全部记录" }
];

const FORMAT_OPTIONS = [
  { value: "jpg", label: "JPG" },
  { value: "png", label: "PNG" }
];

function normalizeRecord(record, index) {
  const item = record && typeof record === "object" ? record : {};
  return {
    id: item.id || `record-${index}-${Date.now()}`,
    fileID: item.fileID || "",
    projectName: item.projectName || "未命名项目",
    createdAt: item.createdAt || "刚刚生成",
    tempFileURL: item.tempFileURL || "",
    path: item.path || "",
    prompt: item.prompt || "",
    source: item.source || "archive",
    sourceLabel: item.sourceLabel || "制作记录",
    selected: false
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

function waitForViewUpdate(page) {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, 60);
    if (page && typeof wx.nextTick === "function") {
      wx.nextTick(done);
    } else {
      done();
    }
  });
}

Page({
  data: {
    scopeOptions: SCOPE_OPTIONS,
    formatOptions: FORMAT_OPTIONS,
    scope: "latest",
    usingDevicePhotos: false,
    format: "jpg",
    quality: publishExport.DEFAULT_QUALITY,
    colorCorrect: true,
    denoise: true,
    sharpen: true,
    cameraNoise: true,
    cameraNoiseStrength: 3,
    cameraNoiseStrengthPreview: 3,
    frequencyPerturb: true,
    frequencyStrength: 3,
    frequencyStrengthPreview: 3,
    removeVisibleMarks: true,
    watermarkStrength: 3,
    watermarkStrengthPreview: 3,
    resamplePerturb: true,
    archiveRecords: [],
    deviceRecords: [],
    records: [],
    selectedCount: 0,
    loading: false,
    refreshing: false,
    processing: false,
    progressValue: 0,
    progressText: "",
    canvasWidth: 1,
    canvasHeight: 1,
    cloudConfirming: false
  },

  onShow() {
    this.cloudConsentGranted = false;
    diagnosticLog.info("export", "page-show", "打开图片导出页面");
    this.loadLocalRecords();
    this.refreshCloudRecords();
  },

  loadLocalRecords() {
    const records = uniqueRecords(storage.loadRecords() || []);
    this.setData({ archiveRecords: records }, () => this.refreshVisibleRecords());
  },

  async refreshCloudRecords() {
    if (!cloud.isCloudReady() || this.data.processing) return;
    this.setData({ refreshing: true });
    try {
      const result = await cloud.listRecords();
      const records = uniqueRecords((result && result.records) || []);
      if (records.length) {
        storage.saveRecords(records);
        this.setData(
          { archiveRecords: records },
          () => this.refreshVisibleRecords()
        );
      }
    } catch (error) {
      console.warn("[publish-export] 云端记录刷新失败，继续使用本地记录", error);
      diagnosticLog.warn("export", "records-refresh-failed", "导出页读取云端记录失败", {
        error
      });
    } finally {
      this.setData({ refreshing: false });
    }
  },

  refreshVisibleRecords() {
    const sourceRecords = this.data.usingDevicePhotos
      ? this.data.deviceRecords
      : this.data.archiveRecords;
    const safeRecords = Array.isArray(sourceRecords) ? sourceRecords : [];
    const selectedRecords = this.data.scope === "all"
      || this.data.usingDevicePhotos
      ? safeRecords.map((item) => Object.assign({}, item, { selected: true }))
      : safeRecords.map((item, index) => Object.assign({}, item, { selected: index === 0 }));
    this.setData({
      records: selectedRecords,
      selectedCount: selectedRecords.filter((item) => item.selected).length
    });
  },

  changeScope(event = {}) {
    const scope = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.scope;
    if (!scope || (scope === this.data.scope && !this.data.usingDevicePhotos)) return;
    this.setData({ scope, usingDevicePhotos: false }, () => this.refreshVisibleRecords());
  },

  changeFormat(event = {}) {
    const format = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.format;
    if (format !== "jpg" && format !== "png") return;
    this.setData({ format });
  },

  changeQuality(event = {}) {
    const value = Number(event.detail && event.detail.value);
    if (!value) return;
    this.setData({ quality: Math.max(60, Math.min(100, Math.round(value))) });
  },

  toggleEnhancement(event = {}) {
    const key = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.key;
    if (!["colorCorrect", "denoise", "sharpen"].includes(key)) return;
    this.setData({
      [key]: Boolean(event.detail && event.detail.value)
    });
  },

  getAdvancedStrengthValue(event = {}) {
    const key = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.key;
    const value = Number(event.detail && event.detail.value);
    if (
      !["cameraNoiseStrength", "frequencyStrength", "watermarkStrength"].includes(key)
      || !Number.isFinite(value)
    ) return null;
    return {
      key,
      previewKey: `${key}Preview`,
      value: Math.max(1, Math.min(5, Math.round(value * 10) / 10))
    };
  },

  previewAdvancedStrength(event = {}) {
    const update = this.getAdvancedStrengthValue(event);
    if (!update || this.data[update.previewKey] === update.value) return;
    this.setData({
      [update.previewKey]: update.value
    });
  },

  commitAdvancedStrength(event = {}) {
    const update = this.getAdvancedStrengthValue(event);
    if (!update) return;
    if (
      this.data[update.key] === update.value
      && this.data[update.previewKey] === update.value
    ) return;
    this.setData({
      [update.key]: update.value,
      [update.previewKey]: update.value
    });
  },

  toggleAdvanced(event = {}) {
    const key = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.key;
    if (!["cameraNoise", "frequencyPerturb", "resamplePerturb"].includes(key)) {
      return;
    }
    this.setData({
      [key]: Boolean(event.detail && event.detail.value)
    });
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
    const count = sourceType === "camera" ? 1 : 9;
    const success = (result = {}) => {
      const files = Array.isArray(result.tempFiles)
        ? result.tempFiles
        : (Array.isArray(result.tempFilePaths)
          ? result.tempFilePaths.map((path) => ({ tempFilePath: path }))
          : []);
      const deviceRecords = files
        .map((file, index) => {
          const path = file.tempFilePath || file.path || "";
          if (!path) return null;
          return {
            id: `device-${Date.now()}-${index}`,
            projectName: `导入照片 ${index + 1}`,
            createdAt: "刚选择",
            tempFileURL: "",
            path,
            prompt: "",
            source: "device",
            sourceLabel: "导入照片",
            selected: true
          };
        })
        .filter(Boolean);

      if (!deviceRecords.length) {
        wx.showToast({ title: "没有拿到照片", icon: "none" });
        return;
      }
      this.setData(
        {
          deviceRecords,
          usingDevicePhotos: true
        },
        () => this.refreshVisibleRecords()
      );
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

  previewRecord(event = {}) {
    const url = event.currentTarget
      && event.currentTarget.dataset
      && event.currentTarget.dataset.url;
    if (!url) return;
    wx.previewImage({
      current: url,
      urls: [url]
    });
  },

  getSelectedRecords() {
    return this.data.records.filter((item) => item.selected);
  },

  getExportOptions() {
    return publishExportCore.normalizeOptions({
      format: this.data.format,
      quality: this.data.quality,
      colorOptimize: this.data.colorCorrect,
      gentleSoften: this.data.denoise,
      gentleSharpen: this.data.sharpen,
      cameraNoise: this.data.cameraNoise,
      cameraNoiseStrength: this.data.cameraNoiseStrength,
      frequencyPerturb: this.data.frequencyPerturb,
      frequencyStrength: this.data.frequencyStrength,
      removeVisibleMarks: true,
      watermarkStrength: this.data.watermarkStrength,
      resamplePerturb: this.data.resamplePerturb
    });
  },

  confirmCloudExport(reason) {
    if (this.cloudConsentGranted) return Promise.resolve(true);
    if (this.data.cloudConfirming) return Promise.resolve(false);
    this.setData({ cloudConfirming: true });
    return new Promise((resolve) => {
      wx.showModal({
        title: "需要云端处理",
        content: `${reason || "当前图片不适合在手机本地处理。"}\n\n继续后会上传临时文件，原图不会被覆盖。`,
        confirmText: "继续上传",
        cancelText: "取消",
        success: (result) => {
          const confirmed = Boolean(result && result.confirm);
          if (confirmed) this.cloudConsentGranted = true;
          resolve(confirmed);
        },
        fail: () => resolve(false),
        complete: () => this.setData({ cloudConfirming: false })
      });
    });
  },

  async cloudExportRecord(record, sourcePath, options) {
    if (!cloud.isCloudReady()) {
      throw new Error("云端处理还没有配置，请先完成 CloudBase 配置。");
    }
    const item = record && typeof record === "object" ? record : {};
    const isArchiveRecord = item.source !== "device" && item.fileID;
    let uploaded = null;
    let fileID = isArchiveRecord ? item.fileID : "";
    try {
      if (!fileID) {
        uploaded = await cloud.uploadAsset(sourcePath, "main", {
          temporary: true,
          fileName: `${item.projectName || "publish-export"}.${options.format}`
        });
        fileID = uploaded && uploaded.fileID;
      }
      if (!fileID) throw new Error("上传临时图片后没有拿到 fileID。");
      const result = await cloud.publishExport({
        recordId: isArchiveRecord ? item.id : "",
        fileID,
        temporaryInput: Boolean(uploaded),
        options
      });
      if (!result || !result.fileID) {
        throw new Error("云端处理完成但没有返回结果文件。");
      }
      const downloaded = await cloud.downloadFile(result.fileID);
      try {
        await cloud.cleanupPublishExportResult(result.jobId, result.fileID);
      } catch (cleanupError) {
        console.warn("[publish-export] 云端结果临时文件清理失败", cleanupError);
      }
      return downloaded;
    } catch (error) {
      if (uploaded && uploaded.fileID) {
        try {
          await cloud.deleteFile(uploaded.fileID);
        } catch (_) {
          // 云端函数失败时的输入清理由服务端和定期任务兜底。
        }
      }
      throw error;
    }
  },

  async startExport() {
    if (this.data.processing) return;
    const records = this.getSelectedRecords();
    if (!records.length) {
      wx.showToast({ title: "先选择要导出的记录", icon: "none" });
      return;
    }
    const exportOptions = this.getExportOptions();
    diagnosticLog.info("export", "batch-start", "开始批量导出图片", {
      recordCount: records.length,
      options: exportOptions
    });

    this.setData({
      processing: true,
      progressValue: 0,
      progressText: `准备处理 ${records.length} 张图片...`
    });

    let successCount = 0;
    const failures = [];
    try {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        this.setData({
          progressValue: Math.round((index / records.length) * 100),
          progressText: `正在处理第 ${index + 1} / ${records.length} 张：${record.projectName}`
        });

        let decision = null;
        let sourcePath = "";
        try {
          sourcePath = await publishExport.resolveImageSource(record);
          const imageInfo = await publishExport.getImageInfo(sourcePath);
          decision = publishExport.getProcessingDecision(
            imageInfo.width,
            imageInfo.height,
            exportOptions,
            typeof wx.createWorker === "function"
          );
          let tempFilePath;
          if (decision.mode === "cloud") {
            const confirmed = await this.confirmCloudExport(decision.reason);
            if (!confirmed) throw new Error("你取消了云端处理。");
            this.setData({
              progressText: `正在云端处理第 ${index + 1} / ${records.length} 张...`
            });
            tempFilePath = await this.cloudExportRecord(
              record,
              sourcePath,
              exportOptions
            );
          } else {
            const outputSize = decision.output;
            this.setData({
              canvasWidth: outputSize.width,
              canvasHeight: outputSize.height
            });
            await waitForViewUpdate(this);
            tempFilePath = await publishExport.renderToTempFile({
              page: this,
              canvasId: "publish-export-canvas",
              sourcePath,
              width: outputSize.width,
              height: outputSize.height,
              format: exportOptions.format,
              quality: exportOptions.quality,
              options: exportOptions,
              colorOptimize: exportOptions.colorOptimize,
              gentleSoften: exportOptions.gentleSoften,
              gentleSharpen: exportOptions.gentleSharpen,
              cameraNoise: exportOptions.cameraNoise,
              cameraNoiseStrength: exportOptions.cameraNoiseStrength,
              frequencyPerturb: exportOptions.frequencyPerturb,
              frequencyStrength: exportOptions.frequencyStrength,
              removeVisibleMarks: exportOptions.removeVisibleMarks,
              watermarkStrength: exportOptions.watermarkStrength,
              resamplePerturb: exportOptions.resamplePerturb,
              useWorker: decision.mode === "local-worker",
              seed: `${record.id || index}:${exportOptions.format}`,
              onStage: (stage) => {
                this.setData({
                  progressText: `正在处理第 ${index + 1} / ${records.length} 张：${stage}`
                });
              }
            });
          }
          await publishExport.saveToAlbum(tempFilePath);
          successCount += 1;
          diagnosticLog.info("export", "item-success", "单张图片导出完成", {
            recordId: record.id,
            projectName: record.projectName,
            format: exportOptions.format,
            outputSize: decision.output,
            mode: decision.mode
          });
        } catch (error) {
          if (
            decision
            && decision.mode !== "cloud"
            && !/取消了云端处理/.test(String(error && error.message || error))
          ) {
            try {
              const confirmed = await this.confirmCloudExport(
                "手机本地处理失败，可以改用云端继续。"
              );
              if (confirmed) {
                this.setData({
                  progressText: `本地处理失败，正在云端处理第 ${index + 1} / ${records.length} 张...`
                });
                const cloudTempFilePath = await this.cloudExportRecord(
                  record,
                  sourcePath,
                  exportOptions
                );
                await publishExport.saveToAlbum(cloudTempFilePath);
                successCount += 1;
                diagnosticLog.info("export", "item-cloud-fallback-success", "本地失败后云端导出完成", {
                  recordId: record.id,
                  projectName: record.projectName,
                  format: exportOptions.format,
                  outputSize: decision.output
                });
                continue;
              }
              error = new Error("你取消了云端处理。");
            } catch (cloudError) {
              error = cloudError;
            }
          }
          console.warn("[publish-export] 单张导出失败", record.id, error);
          diagnosticLog.error("export", "item-failed", "单张图片导出失败", {
            recordId: record.id,
            projectName: record.projectName,
            error
          });
          failures.push({
            name: record.projectName,
            message: this.formatError(error)
          });
        }
      }

      this.setData({
        progressValue: 100,
        progressText: `处理完成：成功 ${successCount} 张${failures.length ? `，失败 ${failures.length} 张` : ""}`
      });
      this.showExportResult(successCount, failures);
      diagnosticLog.info("export", "batch-finish", "批量图片导出完成", {
        successCount,
        failureCount: failures.length
      });
    } finally {
      setTimeout(() => {
        this.setData({
          processing: false,
          progressValue: 0,
          progressText: ""
        });
      }, 700);
    }
  },

  formatError(error) {
    const raw = error && (error.errMsg || error.message);
    const message = String(raw || "导出失败");
    if (/auth deny|authorize|permission/i.test(message)) {
      return "没有相册权限，请在设置里允许保存图片";
    }
    if (/download|url|网络|request/i.test(message)) {
      return "图片下载失败，可能是记录链接已过期";
    }
    return message.length > 48 ? `${message.slice(0, 48)}…` : message;
  },

  showExportResult(successCount, failures) {
    if (successCount && !failures.length) {
      wx.showToast({
        title: `已保存 ${successCount} 张`,
        icon: "success"
      });
      return;
    }

    const detail = failures
      .slice(0, 3)
      .map((item) => `${item.name}：${item.message}`)
      .join("\n");
    if (successCount) {
      wx.showModal({
        title: `已保存 ${successCount} 张`,
        content: `还有 ${failures.length} 张没有保存：\n${detail}`,
        showCancel: false
      });
      return;
    }

    wx.showModal({
      title: "导出没有完成",
      content: detail || "没有图片被保存，请稍后重试。",
      showCancel: false
    });
  },

  goToCreate() {
    wx.navigateTo({
      url: "/pages/index/index?new=1"
    });
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  }
});
