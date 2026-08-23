const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const { prepareImageAsset } = require("../../utils/image");
const { exportMaskFile } = require("../../utils/mask");
const { circleFromPoints } = require("../../utils/circle-gesture");
const {
  createSelectableIssueOptions,
  normalizeIssueKeys,
  buildRepairPrompt
} = require("../../utils/repair");

const MAX_REVISIONS = 10;

function chooseImages(count = 1) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: resolve,
      fail: reject
    });
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getFileName(path) {
  return String(path || "image.jpg").split(/[\\/]/).pop() || "image.jpg";
}

function imageInfo(path) {
  return new Promise((resolve) => {
    if (!path || typeof wx.getImageInfo !== "function") {
      resolve({ width: 1024, height: 1024 });
      return;
    }
    wx.getImageInfo({
      src: path,
      success: (result) => resolve({
        width: Number(result.width) || 1024,
        height: Number(result.height) || 1024
      }),
      fail: () => resolve({ width: 1024, height: 1024 })
    });
  });
}

Page({
  data: {
    record: null,
    projectName: "未命名项目",
    sourceImage: null,
    sourceFileID: "",
    parentSourceFileID: "",
    cloudReady: false,
    imageWidth: 0,
    imageHeight: 0,
    canvasWidth: 0,
    canvasHeight: 0,
    maskCircle: null,
    maskConfirmed: false,
    drawing: false,
    issueGroups: [],
    selectedIssueKeys: ["outsideChanged"],
    prompt: "",
    negativePrompt: "",
    faceRefs: [],
    wardrobeRefs: [],
    referencesReady: true,
    legacyReferencesPending: false,
    legacyFacePending: false,
    legacyWardrobePending: false,
    uploading: "",
    generating: false,
    loading: false,
    loadError: "",
    repairLimitReached: false,
    statusText: "请重新确认红圈后再生成",
    revisionText: ""
  },

  onLoad(options = {}) {
    this._recordId = decodeURIComponent(String(options.recordId || ""));
    this._drawStart = null;
    this._pageDestroyed = false;
    this.loadRecord();
  },

  onUnload() {
    this._pageDestroyed = true;
  },

  async loadRecord() {
    const localRecords = storage.loadRecords() || [];
    let record = localRecords.find((item) => String(item.id) === this._recordId);
    this.setData({ loading: true, loadError: "", cloudReady: cloud.isCloudReady() });
    try {
      if (cloud.isCloudReady()) {
        const result = await cloud.listRecords();
        const remoteRecords = (result && result.records) || [];
        const remote = remoteRecords.find((item) => String(item.id) === this._recordId);
        if (remote) {
          record = remote;
          storage.saveRecords(remoteRecords);
        }
      }
      if (!record) throw new Error("找不到这条制作记录。");
      await this.applyRecord(record);
    } catch (error) {
      diagnosticLog.error("repair", "load-failed", "局部修正记录加载失败", { error });
      this.setData({ loadError: error.message || "记录加载失败" });
      wx.showToast({ title: error.message || "记录加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async applyRecord(record) {
    const repairContext = record.repairContext || {};
    const recordId = String(record.id || record._id || "");
    if (!recordId || recordId.startsWith("local-")) {
      throw new Error("本地临时记录不能进入局部修正。");
    }
    if (record.isTombstone) {
      throw new Error("父记录结果图已删除，不能继续修正。");
    }
    let sourcePath = record.tempFileURL || record.path || "";
    const sourceFileID = record.fileID || repairContext.sourceFileID || "";
    if (!sourceFileID) {
      throw new Error("当前记录缺少云端结果图，不能继续修正。");
    }
    if (!sourcePath && sourceFileID && cloud.isCloudReady()) {
      sourcePath = await cloud.getTempUrl(sourceFileID);
    }
    const info = await imageInfo(sourcePath);
    const revision = Math.max(0, Number(record.revisionNumber) || 0);
    const repairLimitReached = revision >= MAX_REVISIONS;
    const hasRegisteredReferences = Number(repairContext.assetRegistrationVersion) >= 1;
    const faceRefs = hasRegisteredReferences
      ? (repairContext.faceFileIDs || []).filter(Boolean).map((fileID) => ({
        fileID,
        name: "已保存人脸参考",
        path: "",
        reusable: true
      }))
      : [];
    const wardrobeRefs = hasRegisteredReferences
      ? (repairContext.wardrobeFileIDs || []).filter(Boolean).map((fileID) => ({
        fileID,
        name: "已保存穿搭参考",
        path: "",
        reusable: true
      }))
      : [];
    const initialCircle = repairContext.maskGeometry && repairContext.maskGeometry.width
      ? clone(repairContext.maskGeometry)
      : null;
    const hasOldAssets = Boolean(
      (repairContext.faceFileIDs || []).length
      || (repairContext.wardrobeFileIDs || []).length
    ) && !hasRegisteredReferences;
    const legacyFacePending = !hasRegisteredReferences
      && (repairContext.faceFileIDs || []).length > 0;
    const legacyWardrobePending = !hasRegisteredReferences
      && (repairContext.wardrobeFileIDs || []).length > 0;
    const next = {
      record,
      projectName: record.projectName || "未命名项目",
      sourceImage: sourcePath
        ? Object.assign({}, info, { path: sourcePath, fileID: sourceFileID })
        : null,
      sourceFileID,
      parentSourceFileID: sourceFileID,
      imageWidth: info.width,
      imageHeight: info.height,
      faceRefs,
      wardrobeRefs,
      referencesReady: !hasOldAssets,
      legacyReferencesPending: hasOldAssets,
      legacyFacePending,
      legacyWardrobePending,
      maskCircle: initialCircle,
      maskConfirmed: false,
      issueGroups: createSelectableIssueOptions(wardrobeRefs.length > 0, ["outsideChanged"]),
      selectedIssueKeys: ["outsideChanged"],
      negativePrompt: record.negativePrompt || "",
      repairLimitReached,
      revisionText: `当前是第 ${revision} 次修正，最多连续修正 ${MAX_REVISIONS} 次。`,
      statusText: repairLimitReached
        ? `已达到最多 ${MAX_REVISIONS} 次修正，不能继续生成。`
        : hasOldAssets
          ? "旧记录的参考素材未登记，请重新补选或确认不再沿用；红圈也必须重新确认。"
          : "旧红圈只作为预填参考，必须重新拖动确认后才能生成。"
    };
    this.setData(next, () => {
      this.prepareCanvas();
      this.refreshPrompt();
    });
  },

  prepareCanvas() {
    if (!this.data.sourceImage) return;
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : { windowWidth: 375 };
    const width = Math.min(690, Math.max(280, Number(info.windowWidth || 375) - 56));
    const height = width * this.data.imageHeight / Math.max(1, this.data.imageWidth);
    this.setData({
      canvasWidth: Math.round(width),
      canvasHeight: Math.round(height)
    }, () => this.drawCanvas(this.data.maskCircle));
  },

  drawCanvas(circle) {
    if (!this.data.canvasWidth || !this.data.canvasHeight) return;
    const ctx = wx.createCanvasContext("repairMaskCanvas", this);
    ctx.clearRect(0, 0, this.data.canvasWidth, this.data.canvasHeight);
    if (circle && circle.width && circle.height) {
      const cx = circle.x * this.data.canvasWidth / this.data.imageWidth;
      const cy = circle.y * this.data.canvasHeight / this.data.imageHeight;
      const rx = circle.width * this.data.canvasWidth / this.data.imageWidth / 2;
      const ry = circle.height * this.data.canvasHeight / this.data.imageHeight / 2;
      ctx.setLineWidth(4);
      ctx.setStrokeStyle("#ff405f");
      ctx.setFillStyle("rgba(255, 64, 95, 0.16)");
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.draw();
  },

  canvasPoint(event) {
    const touch = event && event.touches && event.touches[0];
    return {
      x: Math.max(0, Math.min(this.data.canvasWidth, Number(touch && touch.x) || 0)),
      y: Math.max(0, Math.min(this.data.canvasHeight, Number(touch && touch.y) || 0))
    };
  },

  onCanvasTouchStart(event) {
    if (this.data.generating) return;
    this._drawStart = this.canvasPoint(event);
    this.setData({ drawing: true });
  },

  onCanvasTouchMove(event) {
    if (!this._drawStart) return;
    const end = this.canvasPoint(event);
    const circle = this.circleFromPoints(this._drawStart, end);
    this.drawCanvas(circle);
  },

  onCanvasTouchEnd(event) {
    if (!this._drawStart) return;
    const end = this.canvasPoint(event);
    const circle = this.circleFromPoints(this._drawStart, end);
    this._drawStart = null;
    this.setData({
      maskCircle: circle,
      maskConfirmed: true,
      drawing: false,
      statusText: "红圈已重新确认，可以生成修正版"
    });
    this.drawCanvas(circle);
    this.refreshPrompt(circle);
  },

  onCanvasTouchCancel() {
    this._drawStart = null;
    this.setData({ drawing: false });
    this.drawCanvas(this.data.maskCircle);
  },

  circleFromPoints(start, end) {
    return circleFromPoints(
      {
        x: start.x * this.data.imageWidth / this.data.canvasWidth,
        y: start.y * this.data.imageHeight / this.data.canvasHeight
      },
      {
        x: end.x * this.data.imageWidth / this.data.canvasWidth,
        y: end.y * this.data.imageHeight / this.data.canvasHeight
      },
      this.data.imageWidth,
      this.data.imageHeight,
      24
    );
  },

  toggleIssue(event) {
    const key = String(event.currentTarget.dataset.key || "");
    const selected = this.data.selectedIssueKeys.slice();
    const index = selected.indexOf(key);
    if (index >= 0) selected.splice(index, 1);
    else selected.push(key);
    const normalized = normalizeIssueKeys(selected, this.data.wardrobeRefs.length > 0);
    this.setData({
      selectedIssueKeys: normalized,
      issueGroups: createSelectableIssueOptions(
        this.data.wardrobeRefs.length > 0,
        normalized
      )
    });
    this.refreshPrompt();
  },

  refreshPrompt(circle = this.data.maskCircle) {
    const prompt = buildRepairPrompt({
      projectName: this.data.projectName,
      issues: this.data.selectedIssueKeys,
      hasFaceReferences: this.data.faceRefs.length > 0,
      hasWardrobeReferences: this.data.wardrobeRefs.length > 0,
      maskGeometry: circle
    });
    this.setData({ prompt });
  },

  copyPrompt() {
    if (!this.data.prompt) this.refreshPrompt();
    wx.setClipboardData({
      data: this.data.prompt,
      success: () => wx.showToast({ title: "修正指令已复制", icon: "success" })
    });
  },

  async chooseMainImage() {
    try {
      const result = await chooseImages(1);
      const file = result.tempFiles && result.tempFiles[0];
      if (!file || !file.tempFilePath) return;
      const prepared = await prepareImageAsset({
        path: file.tempFilePath,
        type: file.fileType ? `image/${file.fileType}` : "image/jpeg",
        size: file.size || 0,
        width: file.width || 0,
        height: file.height || 0,
        name: getFileName(file.tempFilePath)
      }, { compression: require("../../config").imageCompression });
      const preparedInfo = prepared.width && prepared.height
        ? { width: prepared.width, height: prepared.height }
        : await imageInfo(prepared.path);
      if (!cloud.isCloudReady()) {
        this.setData({
          sourceImage: Object.assign({}, prepared, preparedInfo),
          sourceFileID: "",
          imageWidth: preparedInfo.width,
          imageHeight: preparedInfo.height,
          maskCircle: null,
          maskConfirmed: false,
          statusText: "主图已更换；连接云端并重新确认红圈后才能生成"
        }, () => this.prepareCanvas());
        return;
      }
      this.setData({ uploading: "main" });
      const uploaded = await cloud.uploadAsset(
        prepared.path,
        "main",
        { fileName: prepared.name || getFileName(prepared.path), contentType: prepared.type }
      );
      this.setData({
        sourceImage: Object.assign({}, prepared, preparedInfo, { fileID: uploaded.fileID }),
        sourceFileID: uploaded.fileID,
        imageWidth: preparedInfo.width,
        imageHeight: preparedInfo.height,
        maskCircle: null,
        maskConfirmed: false,
        statusText: "主图已更换，请重新拖动确认红圈"
      }, () => this.prepareCanvas());
    } catch (error) {
      wx.showToast({ title: error.message || "主图选择失败", icon: "none" });
    } finally {
      this.setData({ uploading: "" });
    }
  },

  async chooseReferences(kind) {
    try {
      const result = await chooseImages(kind === "face" ? 6 : 12);
      const files = (result.tempFiles || []).slice(0, kind === "face" ? 6 : 12);
      const refs = [];
      this.setData({ uploading: kind });
      for (const file of files) {
        const prepared = await prepareImageAsset({
          path: file.tempFilePath,
          type: file.fileType ? `image/${file.fileType}` : "image/jpeg",
          size: file.size || 0,
          width: file.width || 0,
          height: file.height || 0,
          name: getFileName(file.tempFilePath)
        }, { compression: require("../../config").imageCompression });
        if (!cloud.isCloudReady()) {
          refs.push(Object.assign({}, prepared, { fileID: "" }));
          continue;
        }
        const uploaded = await cloud.uploadAsset(prepared.path, kind, {
          fileName: prepared.name || getFileName(prepared.path),
          contentType: prepared.type
        });
        refs.push(Object.assign({}, prepared, { fileID: uploaded.fileID, reusable: true }));
      }
      const current = kind === "face" ? this.data.faceRefs : this.data.wardrobeRefs;
      const next = current.concat(refs).slice(0, kind === "face" ? 6 : 12);
      const hasWardrobe = kind === "wardrobe"
        ? next.length > 0
        : this.data.wardrobeRefs.length > 0;
      const selectedIssueKeys = normalizeIssueKeys(
        this.data.selectedIssueKeys,
        hasWardrobe
      );
      this.setData({
        [kind === "face" ? "faceRefs" : "wardrobeRefs"]: next,
        referencesReady: kind === "face"
          ? !this.data.legacyWardrobePending
          : !this.data.legacyFacePending,
        legacyReferencesPending: kind === "face"
          ? this.data.legacyWardrobePending
          : this.data.legacyFacePending,
        [kind === "face" ? "legacyFacePending" : "legacyWardrobePending"]: false,
        selectedIssueKeys,
        issueGroups: createSelectableIssueOptions(hasWardrobe, selectedIssueKeys)
      });
      this.refreshPrompt();
    } catch (error) {
      wx.showToast({ title: error.message || "参考素材选择失败", icon: "none" });
    } finally {
      this.setData({ uploading: "" });
    }
  },

  chooseFaceImages() {
    return this.chooseReferences("face");
  },

  chooseWardrobeImages() {
    return this.chooseReferences("wardrobe");
  },

  removeReference(event) {
    const kind = event.currentTarget.dataset.kind;
    const index = Number(event.currentTarget.dataset.index);
    const key = kind === "face" ? "faceRefs" : "wardrobeRefs";
    const refs = this.data[key].slice();
    refs.splice(index, 1);
    const hasWardrobe = kind === "wardrobe"
      ? refs.length > 0
      : this.data.wardrobeRefs.length > 0;
    const selectedIssueKeys = normalizeIssueKeys(
      this.data.selectedIssueKeys,
      hasWardrobe
    );
    this.setData({
      [key]: refs,
      selectedIssueKeys,
      issueGroups: createSelectableIssueOptions(hasWardrobe, selectedIssueKeys)
    });
    this.refreshPrompt();
  },

  discardLegacyReferences() {
    this.setData({
      legacyReferencesPending: false,
      legacyFacePending: false,
      legacyWardrobePending: false,
      referencesReady: true,
      faceRefs: [],
      wardrobeRefs: [],
      selectedIssueKeys: normalizeIssueKeys(this.data.selectedIssueKeys, false),
      issueGroups: createSelectableIssueOptions(false, this.data.selectedIssueKeys),
      statusText: "已确认不沿用旧参考，请重新拖动确认红圈"
    });
    this.refreshPrompt();
  },

  async generateRepair() {
    if (this.data.generating) return;
    if (!this.data.cloudReady) {
      wx.showToast({ title: "云端未连接，只能复制修正指令", icon: "none" });
      return;
    }
    if (
      !this.data.record
      || !this.data.record.id
      || String(this.data.record.id).startsWith("local-")
      || this.data.record.isTombstone
    ) {
      wx.showToast({ title: "本地记录没有云端父记录，不能生成", icon: "none" });
      return;
    }
    if (!this.data.sourceFileID) {
      wx.showToast({ title: "缺少当前结果图，请先补选主图", icon: "none" });
      return;
    }
    if (!this.data.maskConfirmed || !this.data.maskCircle) {
      wx.showToast({ title: "请在当前结果图上重新拖动确认红圈", icon: "none" });
      return;
    }
    if (!this.data.referencesReady) {
      wx.showToast({ title: "旧记录参考素材未登记，请重新补选", icon: "none" });
      return;
    }
    const revision = Number(this.data.record.revisionNumber) || 0;
    if (this.data.repairLimitReached || revision >= MAX_REVISIONS) {
      wx.showToast({ title: `最多连续修正 ${MAX_REVISIONS} 次`, icon: "none" });
      return;
    }
    const requestId = `repair-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    this.setData({ generating: true, statusText: "正在上传 mask 并生成修正版..." });
    try {
      const maskPath = await exportMaskFile(
        this,
        this.data.maskCircle,
        this.data.imageWidth,
        this.data.imageHeight
      );
      const maskUpload = await cloud.uploadAsset(maskPath, "mask", {
        fileName: "repair-mask.png",
        contentType: "image/png"
      });
      const result = await cloud.repairImage({
        projectName: this.data.projectName,
        sourceFileID: this.data.parentSourceFileID || this.data.record.fileID,
        mainFileID: this.data.sourceFileID,
        maskFileID: maskUpload.fileID,
        faceFileIDs: this.data.faceRefs.map((item) => item.fileID).filter(Boolean),
        wardrobeFileIDs: this.data.wardrobeRefs.map((item) => item.fileID).filter(Boolean),
        prompt: this.data.prompt,
        negativePrompt: this.data.negativePrompt,
        parentRecordId: this.data.record.id,
        repairIssues: this.data.selectedIssueKeys,
        maskGeometry: this.data.maskCircle,
        assetRegistrationVersion: 1
      }, { requestId, maxRetries: 2 });
      const record = Object.assign({}, result.record || {}, {
        id: result.recordId,
        fileID: result.fileID,
        tempFileURL: result.tempFileURL,
        projectName: this.data.projectName,
        createdAt: result.createdAt || new Date().toISOString()
      });
      const records = [record].concat(storage.loadRecords() || [])
        .filter((item, index, all) => all.findIndex((entry) => entry.id === item.id) === index)
        .slice(0, 50);
      storage.saveRecords(records);
      this.setData({ statusText: "修正版已追加保存，原图未被覆盖" });
      wx.showToast({ title: "修正版已追加保存", icon: "success" });
      setTimeout(() => {
        if (!this._pageDestroyed) wx.navigateBack({ delta: 1 });
      }, 500);
    } catch (error) {
      diagnosticLog.error("repair", "generate-failed", "局部修正生成失败", { error });
      this.setData({ statusText: "修正失败，可使用新的请求重新提交；原图不会被覆盖" });
      wx.showToast({ title: error.message || "修正失败，额度按原逻辑处理", icon: "none" });
    } finally {
      this.setData({ generating: false });
    }
  }
});
