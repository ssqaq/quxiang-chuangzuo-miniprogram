const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const { prepareImageAsset } = require("../../utils/image");

const PIPELINE_VERSION = "gpt-image-2-tencent-facefusion-v1";
const STATUS_POLL_INTERVAL_MS = 2200;

function chooseOneImage() {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: resolve,
      fail: reject
    });
  });
}

function createRequestId() {
  return `tencent-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function basename(value) {
  return String(value || "图片").split(/[\\/]/).pop() || "图片";
}

function errorPayload(error) {
  return error && error.payload && typeof error.payload === "object"
    ? error.payload
    : {};
}

function errorMessage(error, fallback = "制作失败，请稍后重试") {
  const payload = errorPayload(error);
  return String(payload.message || error && error.message || fallback);
}

function decorateRecord(record, result = {}) {
  const source = record && typeof record === "object" ? record : {};
  return Object.assign({}, source, {
    id: source.id || result.recordId || `local-${Date.now()}`,
    imagePath: source.tempFileURL || source.path || result.tempFileURL || "",
    projectName: source.projectName || "腾讯版自动换脸",
    createdAt: source.createdAt || result.createdAt || new Date().toISOString()
  });
}

Page({
  data: {
    appVersion: config.appVersion,
    cloudReady: false,
    mainImage: null,
    faceImage: null,
    prompt: "换成白色西装，背景改成海边，整体光影自然，保持人物姿态和画面构图。",
    negativePrompt: "不要新增人物，不要改变人物身份，不要改变手脚数量，不要出现文字、水印、变形。",
    loading: false,
    stage: "idle",
    stageText: "上传两张图片后，一次完成修改和换脸",
    requestId: "",
    mainFileID: "",
    faceFileID: "",
    resultUrl: "",
    resultFileID: "",
    resultRecordId: "",
    retryTencentAvailable: false,
    retryHint: "",
    message: "",
    previewVisible: false,
    previewPath: ""
  },

  onLoad() {
    this.setData({
      cloudReady: cloud.isCloudReady()
    });
  },

  onUnload() {
    this.stopStatusPolling();
  },

  chooseMainImage() {
    return this.chooseImage("main");
  },

  chooseFaceImage() {
    return this.chooseImage("face");
  },

  async chooseImage(kind) {
    try {
      const result = await chooseOneImage();
      const file = result && result.tempFiles && result.tempFiles[0];
      if (!file || !file.tempFilePath) return;
      const prepared = await prepareImageAsset(file, {
        compression: config.imageCompression
      });
      const image = {
        path: prepared.path,
        name: file.name || basename(prepared.path),
        type: prepared.type,
        size: prepared.compressedSize || file.size || 0,
        width: prepared.width,
        height: prepared.height,
        fileID: ""
      };
      this.setData({
        [kind === "main" ? "mainImage" : "faceImage"]: image,
        message: "",
        retryTencentAvailable: false,
        retryHint: ""
      });
    } catch (error) {
      diagnosticLog.error("generation", "tencent-image-choose-failed", "腾讯版图片选择失败", {
        kind,
        error
      });
      wx.showToast({ title: errorMessage(error, "图片选择失败"), icon: "none" });
    }
  },

  clearImage(event) {
    const kind = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.kind
      : "";
    if (kind === "main") this.setData({ mainImage: null, mainFileID: "" });
    if (kind === "face") this.setData({ faceImage: null, faceFileID: "" });
  },

  onPromptInput(event) {
    this.setData({ prompt: String(event && event.detail && event.detail.value || "").slice(0, 1000) });
  },

  onNegativePromptInput(event) {
    this.setData({
      negativePrompt: String(event && event.detail && event.detail.value || "").slice(0, 1000)
    });
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  },

  openRecords() {
    wx.navigateTo({
      url: "/pages/records/records",
      fail: () => wx.reLaunch({ url: "/pages/records/records" })
    });
  },

  previewResult() {
    if (!this.data.resultUrl) return;
    this.setData({
      previewVisible: true,
      previewPath: this.data.resultUrl
    });
  },

  closePreview() {
    this.setData({ previewVisible: false });
  },

  stopStatusPolling() {
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = null;
    }
    this._polling = false;
  },

  scheduleStatusPolling(requestId) {
    this.stopStatusPolling();
    this._polling = true;
    const poll = async () => {
      if (!this._polling || !requestId || this.data.requestId !== requestId) return;
      try {
        const status = await cloud.getTencentFaceFusionPipelineStatus(requestId);
        if (status && status.stage) {
          this.applyPipelineStatus(status);
        }
      } catch (error) {
        diagnosticLog.warn("generation", "tencent-status-poll-failed", "腾讯版状态读取失败", {
          requestId,
          error
        });
      }
      if (this._polling) {
        this._statusTimer = setTimeout(poll, STATUS_POLL_INTERVAL_MS);
      }
    };
    poll();
  },

  applyPipelineStatus(status = {}) {
    const stage = String(status.stage || "").trim();
    const stageMap = {
      preparing: {
        stage: "preparing",
        stageText: "正在修改衣服、背景和光影"
      },
      facefusion: {
        stage: "facefusion",
        stageText: "正在融合参考人脸"
      },
      succeeded: {
        stage: "succeeded",
        stageText: "制作完成，最终图片已保存"
      },
      failed: {
        stage: "failed",
        stageText: "本次制作没有完成"
      }
    };
    const mapped = stageMap[stage];
    if (mapped) this.setData(mapped);
  },

  async uploadPipelineAsset(image, kind) {
    if (!image || !image.path) throw new Error(kind === "main" ? "请先上传原始主图" : "请先上传参考脸");
    if (image.fileID) return image.fileID;
    const uploaded = await cloud.uploadAsset(image.path, kind, {
      fileName: image.name,
      contentType: image.type || "image/jpeg"
    });
    if (!uploaded || !uploaded.fileID) throw new Error("图片上传完成但没有返回文件编号");
    return uploaded.fileID;
  },

  validateBeforeStart() {
    if (!this.data.mainImage) return "请先上传原始主图";
    if (!this.data.faceImage) return "请先上传参考脸";
    if (!String(this.data.prompt || "").trim()) return "请填写要修改的内容";
    if (!cloud.isCloudReady()) return "云端未连接，请先配置 CloudBase";
    return "";
  },

  async startPipeline() {
    if (this.data.loading) return;
    const validation = this.validateBeforeStart();
    if (validation) {
      wx.showToast({ title: validation, icon: "none" });
      return;
    }
    const isTencentRetry = Boolean(
      this.data.retryTencentAvailable
      && this.data.requestId
      && this.data.mainFileID
      && this.data.faceFileID
    );
    const requestId = isTencentRetry ? this.data.requestId : createRequestId();
    this.setData({
      loading: true,
      cloudReady: true,
      requestId,
      stage: "preparing",
      stageText: isTencentRetry ? "正在重新融合参考人脸" : "正在准备图片并修改衣服、背景和光影",
      message: "",
      retryTencentAvailable: false,
      retryHint: ""
    });
    this.scheduleStatusPolling(requestId);
    try {
      let mainFileID = this.data.mainFileID;
      let faceFileID = this.data.faceFileID;
      if (!isTencentRetry) {
        this.setData({ stageText: "正在上传原始主图和参考脸" });
        mainFileID = await this.uploadPipelineAsset(this.data.mainImage, "main");
        faceFileID = await this.uploadPipelineAsset(this.data.faceImage, "face");
        this.setData({
          mainFileID,
          faceFileID,
          mainImage: Object.assign({}, this.data.mainImage, { fileID: mainFileID }),
          faceImage: Object.assign({}, this.data.faceImage, { fileID: faceFileID }),
          stageText: "正在修改衣服、背景和光影"
        });
      }
      const result = await cloud.tencentFaceFusionPipeline({
        mainFileID,
        faceFileID,
        prompt: String(this.data.prompt || "").trim(),
        negativePrompt: String(this.data.negativePrompt || "").trim(),
        requestId,
        pipelineVersion: PIPELINE_VERSION,
        retryTencentOnly: isTencentRetry
      }, {
        requestId,
        maxRetries: 0
      });
      this.stopStatusPolling();
      const record = decorateRecord(result && result.record, result || {});
      const records = [record].concat(storage.loadRecords() || [])
        .filter((item, index, list) => item && list.findIndex((candidate) => (
          String(candidate.id) === String(item.id)
        )) === index)
        .slice(0, 50);
      storage.saveRecords(records);
      this.setData({
        loading: false,
        stage: "succeeded",
        stageText: "制作完成，最终图片已保存到制作记录",
        resultUrl: result.tempFileURL || record.imagePath || "",
        resultFileID: result.fileID || record.fileID || "",
        resultRecordId: result.recordId || record.id || "",
        message: "当前使用链路：GPT Image 2 → 腾讯人脸融合专业版",
        retryTencentAvailable: false,
        retryHint: ""
      });
      wx.showToast({ title: "制作完成", icon: "success" });
    } catch (error) {
      this.stopStatusPolling();
      const payload = errorPayload(error);
      const canRetryTencent = Boolean(
        payload.canRetryTencent
        && payload.intermediateAvailable
        && requestId
      );
      this.setData({
        loading: false,
        stage: "failed",
        stageText: canRetryTencent ? "腾讯换脸失败，可只重试最后一步" : "本次制作没有完成",
        message: errorMessage(error),
        retryTencentAvailable: canRetryTencent,
        retryHint: canRetryTencent
          ? "中间图已经保留，再点一次只重试腾讯换脸，不会重新修改衣服和背景。"
          : ""
      });
      diagnosticLog.error("generation", "tencent-pipeline-failed", "腾讯版自动换脸失败", {
        requestId,
        stage: payload.pipelineStage || "",
        canRetryTencent,
        error
      });
      wx.showModal({
        title: canRetryTencent ? "换脸失败" : "制作失败",
        content: `${errorMessage(error)}${canRetryTencent ? "\n\n可以点击“只重试换脸”。" : ""}`,
        showCancel: false
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  retryTencent() {
    if (!this.data.retryTencentAvailable || this.data.loading) return;
    this.startPipeline();
  },

  resetForNew() {
    this.stopStatusPolling();
    this.setData({
      resultUrl: "",
      resultFileID: "",
      resultRecordId: "",
      stage: "idle",
      stageText: "上传两张图片后，一次完成修改和换脸",
      message: "",
      requestId: "",
      mainFileID: "",
      faceFileID: "",
      retryTencentAvailable: false,
      retryHint: ""
    });
  },

  onShareAppMessage() {
    return {
      title: "腾讯版自动换脸",
      path: "/pages/tencent-face-fusion/tencent-face-fusion"
    };
  }
});
