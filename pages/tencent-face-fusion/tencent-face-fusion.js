const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const { prepareImageAsset } = require("../../utils/image");

const PIPELINE_VERSION = "gpt-image-2-tencent-facefusion-v1";
const STATUS_POLL_INTERVAL_MS = 2200;
const PIPELINE_WAIT_TIMEOUT_MS = 150000;

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

function pipelineWaitTimeoutError() {
  const error = new Error("等待超过 150 秒，服务可能仍在处理，请继续查询结果，不要重复提交。");
  error.code = "TENCENT_PIPELINE_CLIENT_TIMEOUT";
  return error;
}

function isPipelineWaitTimeoutError(error) {
  const payload = errorPayload(error);
  const code = String(
    error && error.code
    || payload.errorCode
    || payload.code
    || ""
  ).toLowerCase();
  const message = String(errorMessage(error, "")).toLowerCase();
  return code === "tencent_pipeline_client_timeout"
    || code === "timeout"
    || /timeout|timed out|deadline|超时/.test(`${code} ${message}`);
}

function withPipelineWaitTimeout(promise, timeoutMs = PIPELINE_WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(pipelineWaitTimeoutError());
    }, Math.max(1000, Number(timeoutMs) || PIPELINE_WAIT_TIMEOUT_MS));
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
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
    adminAccessState: "checking",
    adminAccessGranted: false,
    adminAccessMessage: "正在检查管理员权限...",
    mainImage: null,
    faceImage: null,
    prompt: "换成白色西装，背景改成海边，整体光影自然，保持人物姿态和画面构图。",
    negativePrompt: "不要新增人物，不要改变人物身份，不要改变手脚数量，不要出现文字、水印、变形。",
    loading: false,
    stage: "idle",
    progress: 0,
    progressText: "等待开始",
    stageText: "上传两张图片后，一次完成修改和换脸",
    requestId: "",
    mainFileID: "",
    faceFileID: "",
    resultUrl: "",
    resultFileID: "",
    resultRecordId: "",
    retryTencentAvailable: false,
    retryHint: "",
    timedOut: false,
    statusQuerying: false,
    timeoutHint: "",
    message: "",
    previewVisible: false,
    previewPath: ""
  },

  async onLoad() {
    this._statusOnlyMode = false;
    this._completedRequestId = "";
    this.setData({
      cloudReady: cloud.isCloudReady(),
      adminAccessState: "checking",
      adminAccessGranted: false,
      adminAccessMessage: "正在检查管理员权限..."
    });
    await this.checkAdminAccess();
  },

  async checkAdminAccess() {
    if (!cloud.isCloudReady()) {
      this.denyAdminAccess("当前无法确认管理员身份，请从工作台重新进入。");
      return false;
    }
    try {
      const result = await cloud.getAdminStatus();
      if (!result || result.unavailable || !result.isAdmin) {
        this.denyAdminAccess("该功能正在测试中，仅管理员可用。");
        return false;
      }
      this.setData({
        adminAccessState: "granted",
        adminAccessGranted: true,
        adminAccessMessage: ""
      });
      return true;
    } catch (error) {
      diagnosticLog.warn("admin", "tencent-access-check-failed", "腾讯版管理员权限检查失败", {
        error
      });
      this.denyAdminAccess("当前无法确认管理员身份，请稍后从工作台重试。");
      return false;
    }
  },

  denyAdminAccess(message) {
    this.stopStatusPolling();
    this.setData({
      adminAccessState: "denied",
      adminAccessGranted: false,
      adminAccessMessage: String(message || "该功能正在测试中，仅管理员可用。")
    });
    wx.showModal({
      title: "暂未开放",
      content: String(message || "该功能正在测试中，仅管理员可用。"),
      showCancel: false,
      success: () => this.backToWorkbench(),
      fail: () => this.backToWorkbench()
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
        [kind === "main" ? "mainFileID" : "faceFileID"]: "",
        requestId: "",
        message: "",
        retryTencentAvailable: false,
        retryHint: "",
        timedOut: false,
        statusQuerying: false,
        timeoutHint: ""
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
    if (kind === "main") {
      this.setData({
        mainImage: null,
        mainFileID: "",
        requestId: "",
        timedOut: false,
        statusQuerying: false,
        timeoutHint: ""
      });
    }
    if (kind === "face") {
      this.setData({
        faceImage: null,
        faceFileID: "",
        requestId: "",
        timedOut: false,
        statusQuerying: false,
        timeoutHint: ""
      });
    }
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
    this._pollDeadlineAt = 0;
  },

  scheduleStatusPolling(requestId) {
    this.stopStatusPolling();
    this._polling = true;
    this._pollDeadlineAt = Date.now() + PIPELINE_WAIT_TIMEOUT_MS;
    const poll = async () => {
      if (!this._polling || !requestId || this.data.requestId !== requestId) return;
      if (Date.now() >= this._pollDeadlineAt) {
        this.handlePipelineWaitTimeout(requestId);
        return;
      }
      try {
        const status = await cloud.getTencentFaceFusionPipelineStatus(requestId);
        if (status && status.stage) {
          this.applyPipelineStatus(status);
          if (this._statusOnlyMode && status.stage === "succeeded" && status.result) {
            this.completePipelineResult(status.result);
            return;
          }
          if (this._statusOnlyMode && status.stage === "failed") {
            this.applyStatusOnlyFailure(status);
            return;
          }
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
      pending: {
        stage: "preparing",
        stageText: status.stageText || "请求已提交，正在等待云端开始处理",
        progress: Number(status.progress) || 10,
        progressText: "等待云端处理"
      },
      preparing: {
        stage: "preparing",
        stageText: status.stageText || "正在准备图片",
        progress: Number(status.progress) || 10,
        progressText: "正在准备图片"
      },
      "face-detection": {
        stage: "face-detection",
        stageText: status.stageText || "正在检测主图中的人脸",
        progress: Number(status.progress) || 20,
        progressText: "正在检测人脸"
      },
      "mask-ready": {
        stage: "mask-ready",
        stageText: status.stageText || "正在生成脸部保护 mask",
        progress: Number(status.progress) || 35,
        progressText: "正在保护脸部"
      },
      "image-edit": {
        stage: "image-edit",
        stageText: status.stageText || "正在修改衣服、背景和光影",
        progress: Number(status.progress) || 55,
        progressText: "正在修改衣服、背景和光影"
      },
      "image-edit-primary": {
        stage: "image-edit",
        stageText: status.stageText || "正在使用主模型修改衣服、背景和光影",
        progress: Number(status.progress) || 35,
        progressText: "主模型正在修改图片"
      },
      "image-edit-primary-retry": {
        stage: "image-edit",
        stageText: status.stageText || "主模型暂时失败，正在重试图片编辑",
        progress: Number(status.progress) || 44,
        progressText: "主模型正在重试"
      },
      "image-edit-backup": {
        stage: "image-edit",
        stageText: status.stageText || "主模型不可用，正在切换备用模型",
        progress: Number(status.progress) || 52,
        progressText: "备用模型正在修改图片"
      },
      facefusion: {
        stage: "facefusion",
        stageText: status.stageText || "正在融合参考人脸",
        progress: Number(status.progress) || 85,
        progressText: "正在融合参考人脸"
      },
      succeeded: {
        stage: "succeeded",
        stageText: status.stageText || "制作完成，最终图片已保存",
        progress: 100,
        progressText: "制作完成"
      },
      failed: {
        stage: "failed",
        stageText: status.stageText || "本次制作没有完成",
        progress: Number(status.progress) || 0,
        progressText: "本次制作没有完成"
      }
    };
    const mapped = stageMap[stage];
    if (mapped) this.setData(mapped);
  },

  handlePipelineWaitTimeout(requestId) {
    if (!requestId || this.data.requestId !== requestId) return;
    this.stopStatusPolling();
    this._statusOnlyMode = true;
    this.setData({
      loading: false,
      statusQuerying: false,
      timedOut: true,
      stage: "timeout",
      progress: Math.max(10, Number(this.data.progress) || 0),
      progressText: "处理时间较长",
      stageText: "服务可能仍在处理，请勿重复点击开始制作",
      timeoutHint: `请求编号已保留：${requestId}`,
      message: "页面已停止等待，但云端任务可能还在继续。请点击“继续查询结果”，不要重新提交，避免重复扣费。"
    });
    diagnosticLog.warn("generation", "tencent-pipeline-client-timeout", "腾讯版等待超时，保留请求编号", {
      requestId,
      progress: Number(this.data.progress) || 0
    });
  },

  completePipelineResult(result = {}) {
    const requestId = String(result.requestId || this.data.requestId || "");
    if (requestId && this._completedRequestId === requestId && this.data.resultRecordId) return;
    this.stopStatusPolling();
    this._statusOnlyMode = false;
    this._completedRequestId = requestId;
    const record = decorateRecord(result && result.record, result || {});
    const records = [record].concat(storage.loadRecords() || [])
      .filter((item, index, list) => item && list.findIndex((candidate) => (
        String(candidate.id) === String(item.id)
      )) === index)
      .slice(0, 50);
    storage.saveRecords(records);
    this.setData({
      loading: false,
      statusQuerying: false,
      timedOut: false,
      timeoutHint: "",
      stage: "succeeded",
      progress: 100,
      progressText: "制作完成",
      stageText: "制作完成，最终图片已保存到制作记录",
      resultUrl: result.tempFileURL || record.imagePath || "",
      resultFileID: result.fileID || record.fileID || "",
      resultRecordId: result.recordId || record.id || "",
      message: "当前使用链路：人脸检测 → 脸部保护 mask → GPT Image 2 → 腾讯人脸融合专业版",
      retryTencentAvailable: false,
      retryHint: ""
    });
    wx.showToast({ title: "制作完成", icon: "success" });
  },

  applyStatusOnlyFailure(status = {}) {
    this.stopStatusPolling();
    this._statusOnlyMode = false;
    const canRetryTencent = Boolean(
      status.canRetryTencent
      && status.intermediateAvailable
      && this.data.requestId
    );
    this.setData({
      loading: false,
      statusQuerying: false,
      timedOut: false,
      timeoutHint: "",
      stage: "failed",
      progress: Number(status.progress) || (canRetryTencent ? 85 : 0),
      progressText: canRetryTencent ? "腾讯换脸失败，可重试" : "本次制作没有完成",
      stageText: canRetryTencent ? "腾讯换脸失败，可只重试最后一步" : "本次制作没有完成",
      message: String(status.message || status.errorMessage || "云端任务没有完成。"),
      retryTencentAvailable: canRetryTencent,
      retryHint: canRetryTencent
        ? "中间图已经保留，再点一次只重试腾讯换脸，不会重新修改衣服和背景。"
        : ""
    });
  },

  async continueStatusQuery() {
    if (!this.data.adminAccessGranted) return;
    const requestId = String(this.data.requestId || "");
    if (!requestId || this.data.statusQuerying) return;
    this._statusOnlyMode = true;
    this.setData({
      statusQuerying: true,
      timedOut: true,
      timeoutHint: `正在查询请求：${requestId}`,
      message: "只查询现有任务状态，不会重新提交，也不会重复扣费。"
    });
    try {
      const status = await cloud.getTencentFaceFusionPipelineStatus(requestId);
      if (status && status.stage) this.applyPipelineStatus(status);
      if (status && status.stage === "succeeded" && status.result) {
        this.completePipelineResult(status.result);
        return;
      }
      if (status && status.stage === "failed") {
        this.applyStatusOnlyFailure(status);
        return;
      }
      this.setData({
        statusQuerying: false,
        timedOut: true,
        timeoutHint: `请求仍在处理：${requestId}`,
        message: "云端任务还没结束，页面会继续查询；请勿重新点击开始制作。"
      });
      this.scheduleStatusPolling(requestId);
    } catch (error) {
      this.stopStatusPolling();
      this.setData({
        statusQuerying: false,
        timedOut: true,
        timeoutHint: `请求编号已保留：${requestId}`,
        message: `状态查询失败：${errorMessage(error, "请稍后再查")}。不要重新提交制作。`
      });
      diagnosticLog.warn("generation", "tencent-status-manual-query-failed", "腾讯版手动查询失败", {
        requestId,
        error
      });
    }
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
    if (!this.data.adminAccessGranted) return;
    if (this.data.loading) return;
    if (this.data.timedOut && this.data.requestId) {
      wx.showToast({ title: "请先继续查询原请求", icon: "none" });
      return;
    }
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
    this._statusOnlyMode = false;
    this._completedRequestId = "";
    this.setData({
      loading: true,
      cloudReady: true,
      requestId,
      stage: "preparing",
      progress: 10,
      progressText: isTencentRetry ? "准备重新融合参考人脸" : "准备图片",
      stageText: isTencentRetry ? "正在重新融合参考人脸" : "正在准备图片并修改衣服、背景和光影",
      message: "",
      retryTencentAvailable: false,
      retryHint: "",
      timedOut: false,
      statusQuerying: false,
      timeoutHint: ""
    });
    this.scheduleStatusPolling(requestId);
    try {
      let mainFileID = this.data.mainFileID;
      let faceFileID = this.data.faceFileID;
      if (!isTencentRetry) {
        this.setData({
          stageText: "正在上传原始主图和参考脸",
          progress: 15,
          progressText: "准备图片"
        });
        mainFileID = await this.uploadPipelineAsset(this.data.mainImage, "main");
        faceFileID = await this.uploadPipelineAsset(this.data.faceImage, "face");
        this.setData({
          mainFileID,
          faceFileID,
          mainImage: Object.assign({}, this.data.mainImage, { fileID: mainFileID }),
          faceImage: Object.assign({}, this.data.faceImage, { fileID: faceFileID }),
          stageText: "正在修改衣服、背景和光影",
          progress: 35,
          progressText: "正在修改衣服、背景和光影"
        });
      }
      const result = await withPipelineWaitTimeout(
        cloud.tencentFaceFusionPipeline({
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
        }),
        PIPELINE_WAIT_TIMEOUT_MS
      );
      this.completePipelineResult(result);
    } catch (error) {
      this.stopStatusPolling();
      if (isPipelineWaitTimeoutError(error)) {
        this.handlePipelineWaitTimeout(requestId);
        return;
      }
      const payload = errorPayload(error);
      const canRetryTencent = Boolean(
        payload.canRetryTencent
        && payload.intermediateAvailable
        && requestId
      );
      this.setData({
        loading: false,
        stage: "failed",
        progress: Number(payload.progress) || (canRetryTencent ? 85 : 0),
        progressText: canRetryTencent ? "腾讯换脸失败，可重试" : "本次制作没有完成",
        stageText: canRetryTencent ? "腾讯换脸失败，可只重试最后一步" : "本次制作没有完成",
        message: errorMessage(error),
        retryTencentAvailable: canRetryTencent,
        timedOut: false,
        statusQuerying: false,
        timeoutHint: "",
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
      if (!this.data.timedOut) this.setData({ loading: false });
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
      progress: 0,
      progressText: "等待开始",
      stageText: "上传两张图片后，一次完成修改和换脸",
      message: "",
      requestId: "",
      mainFileID: "",
      faceFileID: "",
      retryTencentAvailable: false,
      retryHint: "",
      timedOut: false,
      statusQuerying: false,
      timeoutHint: ""
    });
  },

  onShareAppMessage() {
    return {
      title: "腾讯版自动换脸",
      path: "/pages/tencent-face-fusion/tencent-face-fusion"
    };
  }
});
