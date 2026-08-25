const app = getApp();
const config = require("../../config");
const cloud = require("../../services/cloud");
const storage = require("../../utils/storage");
const diagnosticLog = require("../../utils/diagnostic-log");
const {
  LOCKED_ELEMENTS,
  buildPrompt,
  buildNegativePrompt
} = require("../../utils/prompt");
const { exportMaskFile } = require("../../utils/mask");
const { prepareImageAsset } = require("../../utils/image");
const {
  MIN_SCALE,
  MAX_SCALE,
  clampOffset,
  createPinchState,
  createTouchCoordinateContext,
  mapViewportPointToCanvas,
  resolveTouchPoint,
  resolveTouchPoints,
  updatePinchView
} = require("../../utils/canvas-gesture");
const {
  circleFromPoints: createCircleFromPoints,
  findTouchByIdentifier,
  getTouchIdentifier
} = require("../../utils/circle-gesture");
const {
  appendWebPosePromptBlock,
  normalizeWebPoseSuggestion,
  normalizeWebPoseSuggestions
} = require("../../utils/web-pose");
const { canRepairRecord } = require("../../utils/repair");

const CLOTHING_TARGETS = ["整套穿搭", "上装", "外套", "下装", "连衣裙/连体装", "鞋靴"];
const ACCESSORY_TARGETS = [
  "对应配饰位置",
  "包袋",
  "首饰",
  "帽子",
  "眼镜",
  "腰带",
  "手表",
  "其他配饰"
];

const AUTO_FACE_WIDTH_SCALE = 1.2;
const AUTO_FACE_HEIGHT_SCALE = 1.15;
const AUTO_FACE_MIN_WIDTH = 48;
const AUTO_FACE_MIN_HEIGHT = 56;
const GENERATION_TIMEOUT_MS = 120000;
const GENERATION_RETRY_LIMIT = 2;
const GENERATION_PHASES = [
  { key: "prepare", label: "准备素材" },
  { key: "upload", label: "上传素材" },
  { key: "generate", label: "AI生成" },
  { key: "save", label: "保存记录" }
];
const GENERATION_ASSET_ERROR_MESSAGES = {
  MAIN_IMAGE_MISSING: "主图缺失，请重新上传",
  MASK_CIRCLE_MISSING: "请先在主图上圈选区域",
  MASK_EXPORT_FAILED: "红圈导出失败，请重试",
  MASK_UPLOAD_FAILED: "红圈上传失败，请检查网络后重试",
  PROJECT_STATE_CHANGED: "操作状态已变化，请重新圈选后再生成",
  MAIN_FILE_MISSING: "主图文件缺失，请重新上传后重试",
  MASK_FILE_MISSING: "红圈遮罩未生成，请重新圈选后重试",
  "missing-edit-asset": "编辑素材不完整，请重新上传主图并圈选区域"
};

function createClientRequestId() {
  return `mini-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function hasImageEditAssets(project = {}) {
  const source = project && typeof project === "object" ? project : {};
  const hasFileID = (value) => Boolean(String(value || "").trim());
  const hasAsset = (items) => (
    Array.isArray(items) && items.some((item) => (
      hasFileID(item && item.fileID) || Boolean(item && item.path)
    ))
  );
  return Boolean(
    source.mainImage
    || hasFileID(source.maskFileID)
    || source.maskCircle
    || hasAsset(source.faceRefs)
    || hasAsset(source.wardrobeRefs)
    || hasAsset(source.backgroundRefs)
  );
}

function resolveImageGenerationMode(project = {}) {
  // 制作页的主流程是人脸替换；只要页面带有主图或参考素材，就必须上传 mask 并走 edits。
  if (hasImageEditAssets(project)) return "edits";
  const mode = String(config.imageMode || "").trim().toLowerCase();
  return mode === "edits" ? "edits" : "generations";
}

function decorateRecordForRepair(record, cloudReady = true) {
  return Object.assign({}, record, {
    canRepair: canRepairRecord(record, cloudReady)
  });
}

function createProject() {
  return {
    projectName: "未命名项目",
    mainImage: null,
    maskCircle: null,
    maskFileID: "",
    faceRefs: [],
    wardrobeRefs: [],
    backgroundRefs: [],
    sceneDescription: "",
    poseDescription: "",
    faceDirectionDescription: "",
    lightingMakeupDescription: "",
    backgroundDescription: "",
    lockedElements: LOCKED_ELEMENTS.slice(),
    customLockedElements: [],
    promptDraft: "",
    negativePrompt: "",
    webPoseSuggestions: [],
    selectedWebPose: null,
    webPoseAnalysisMeta: null,
    results: []
  };
}

function createLockedElementOptions(selectedElements) {
  const selected = Array.isArray(selectedElements) ? selectedElements : LOCKED_ELEMENTS;
  return LOCKED_ELEMENTS.map((value) => ({
    value,
    label: value.replace(/^不改变/, ""),
    checked: selected.indexOf(value) >= 0
  }));
}

function parseCustomLocks(value) {
  const result = [];
  String(value || "").split(/[\n；;]+/).forEach((item) => {
    const text = item.trim();
    if (text && result.indexOf(text) < 0) result.push(text);
  });
  return result.slice(0, 20);
}

function basename(path) {
  return String(path || "图片").split(/[\\/]/).pop() || "图片";
}

function assetKindForFolder(folder) {
  const value = String(folder || "");
  if (value === "main") return "main";
  if (value === "masks") return "mask";
  if (value.includes("faces")) return "face";
  if (value.includes("wardrobe")) return "wardrobe";
  if (value.includes("background")) return "background";
  return "";
}

function chooseImages(count) {
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

const ENTRY_MODE_META = {
  face: {
    title: "局部换脸",
    tone: "face",
    hint: "先上传主图，再添加人脸参考；背景、构图和红圈外内容会继续保持不变。"
  },
  wardrobe: {
    title: "换穿搭",
    tone: "wardrobe",
    hint: "先上传主图，再在参考素材里添加衣物或配饰；未指定的内容不会被额外改动。"
  },
  pose: {
    title: "调姿势",
    tone: "pose",
    hint: "先上传主图，进入提示词步骤后可以使用“参考网感分析”选择姿势建议。"
  },
  custom: {
    title: "新建创作",
    tone: "custom",
    hint: "按五步流程完成一次局部创作，系统会自动保存当前项目草稿。"
  },
  resume: {
    title: "继续上次编辑",
    tone: "resume",
    hint: "已恢复本地草稿，接着完成上次停下的步骤即可。"
  }
};

function resolveEntryMode(options) {
  if (options && options.resume === "1") return ENTRY_MODE_META.resume;
  return ENTRY_MODE_META[options && options.mode] || null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function assetIdentity(asset) {
  if (!asset) return "";
  const primary = asset.id || asset.path || asset.fileID || "";
  return [
    primary,
    asset.size || asset.compressedSize || 0,
    asset.width || 0,
    asset.height || 0
  ].join("|");
}

function getStableMainImageKey(image) {
  if (!image || typeof image !== "object") return "";
  const stableKey = String(image.stableKey || "").trim();
  if (stableKey) return stableKey;
  const path = String(image.path || "").trim();
  if (path) return path;
  return [
    image.originalName || image.name || "",
    image.originalSize || image.size || 0,
    image.originalWidth || image.width || 0,
    image.originalHeight || image.height || 0
  ].join("|");
}

function serializeMaskCircle(circle) {
  if (!circle || typeof circle !== "object") return "";
  try {
    return JSON.stringify(circle);
  } catch (_) {
    return String(circle);
  }
}

function redactAssetID(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= 8 ? "***" : `…${text.slice(-8)}`;
}

function createGenerationAssetError(code, cause) {
  const error = new Error(
    GENERATION_ASSET_ERROR_MESSAGES[code] || String(code || "素材准备失败")
  );
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function getGenerationErrorMessage(error, fallbackMessage) {
  const payload = error && error.payload && typeof error.payload === "object"
    ? error.payload
    : {};
  const code = String(
    payload.errorCode
      || payload.code
      || (error && (error.code || error.errCode))
      || ""
  ).trim();
  return GENERATION_ASSET_ERROR_MESSAGES[code]
    || payload.message
    || payload.error
    || (error && error.errMsg)
    || (error && error.message)
    || fallbackMessage
    || "请稍后重试";
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSameFaceCircle(left, right) {
  if (!left || !right) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const leftValue = Number(left[key]);
    const rightValue = Number(right[key]);
    return Number.isFinite(leftValue)
      && Number.isFinite(rightValue)
      && Math.abs(leftValue - rightValue) < 0.5;
  });
}

function isWechatBindingRequired(errorInfo) {
  const info = errorInfo && typeof errorInfo === "object" ? errorInfo : {};
  const code = String(info.code || "").toLowerCase();
  const message = String(info.message || "").toLowerCase();
  return code === "wechat-binding-required"
    || /微信授权|wechat.*(auth|bind)|openid/.test(`${code} ${message}`);
}

const AUTO_FACE_STATE_LABELS = {
  idle: "未开始",
  running: "识别中",
  ready: "已完成",
  "manual-required": "需要手动",
  fallback: "已切换手动"
};

const AUTO_FACE_STAGE_LABELS = {
  idle: "等待开始",
  "cloud-start": "开始识别",
  "upload-complete": "图片准备完成",
  "cloud-result": "识别结果返回",
  "detect-complete": "识别完成",
  "cache-hit": "复用已有结果",
  "cloud-failed": "云端识别失败",
  "cloud-unavailable": "云端未连接"
};

function createAutoFaceStatus() {
  return {
    state: "idle",
    stateLabel: AUTO_FACE_STATE_LABELS.idle,
    stage: "idle",
    stageLabel: AUTO_FACE_STAGE_LABELS.idle,
    source: "",
    message: "等待自动贴脸",
    details: null,
    shortDetail: "",
    failureReason: "",
    nextStepText: "",
    manualGuideText: "",
    requestId: "",
    durationText: "",
    updatedAt: ""
  };
}

function safeErrorInfo(error, fallbackMessage) {
  const payload = error && error.payload && typeof error.payload === "object"
    ? error.payload
    : {};
  const message = payload.message
    || payload.error
    || (error && error.errMsg)
    || (error && error.message)
    || fallbackMessage
    || "未知错误";
  const code = payload.errorCode
    || payload.code
    || (error && (error.code || error.errCode))
    || "";
  const status = Number(error && error.status)
    || Number(payload.status)
    || 0;
  const retryable = error && error.retryable !== undefined
    ? Boolean(error.retryable)
    : Boolean(payload.retryable);
  return {
    code: String(code || ""),
    message: String(message || "未知错误"),
    status,
    retryable,
    requestId: String(
      payload.requestId
        || (error && error.requestId)
        || ""
    ),
    stack: error && error.stack ? String(error.stack).slice(0, 1200) : ""
  };
}

function getAutoFaceFailureGuide(errorInfo, cloudReady = true) {
  const info = errorInfo && typeof errorInfo === "object" ? errorInfo : {};
  const code = String(info.code || "").toLowerCase();
  const message = String(info.message || "").trim();
  const status = Number(info.status) || 0;
  const searchText = `${code} ${message}`.toLowerCase();
  const manualGuide = "请用一根手指拖动，圈住整张脸；不要只点一下。双指可以放大图片。";

  if (isWechatBindingRequired(info)) {
    return {
      reason: "当前模拟器没有微信授权身份，云端不能上传素材。",
      nextStep: "请用手机预览并完成微信授权；只在模拟器测试时可以直接手动圈选。",
      manualGuide
    };
  }
  if (!cloudReady || code === "cloud-unavailable") {
    return {
      reason: "当前没有连接云端，自动识别人脸没有发出去。",
      nextStep: "请检查网络或稍后重新点击“自动识别人脸”。",
      manualGuide
    };
  }
  if (
    code === "missing-api-key"
    || /api[_ -]?key|没有配置.*视觉|未配置.*视觉/.test(searchText)
  ) {
    return {
      reason: "云端视觉服务没有配置好，当前不能自动识别人脸。",
      nextStep: "请先使用手动圈选；后台配置好视觉服务后再重试。",
      manualGuide
    };
  }
  if (code === "missing-main-image" || code === "empty-main-image") {
    return {
      reason: "主图没有成功上传到云端。",
      nextStep: "请重新选择主图，等图片准备完成后再试。",
      manualGuide
    };
  }
  if (
    code === "image-too-large"
    || /图片过大|主图文件过大|too large|payload too large/.test(searchText)
  ) {
    return {
      reason: "主图文件太大，云端视觉服务拒绝处理。",
      nextStep: "请重新选择一张较小的图片，或直接手动圈选。",
      manualGuide
    };
  }
  if (
    code === "empty-face-detection"
    || /没有识别到|没有返回人脸|清晰人脸|face detection/.test(searchText)
  ) {
    return {
      reason: "照片里没有识别到清晰、完整的人脸，可能是脸太小、太暗或被遮挡。",
      nextStep: "换一张脸部更清楚、光线更好的照片，或直接手动圈选。",
      manualGuide
    };
  }
  if (
    status === 408
    || status === 504
    || /timeout|timed out|超时/.test(searchText)
  ) {
    return {
      reason: "云端识别等待超时，图片本身不一定有问题。",
      nextStep: "请稍后重新点击“自动识别人脸”；连续超时就先手动圈选。",
      manualGuide
    };
  }
  if (
    info.retryable
    || status >= 500
    || code === "rate-limited"
    || code === "upstream-unavailable"
    || code === "vision-upstream-failed"
    || code === "retry-exhausted"
    || /network|request:fail|fail to fetch|socket|网络|连接失败/.test(searchText)
  ) {
    return {
      reason: "云端视觉服务或网络临时异常，没有正常返回结果。",
      nextStep: "请稍后重试；如果连续失败，先手动圈选并保留请求编号。",
      manualGuide
    };
  }

  return {
    reason: message && message !== "云端自动贴脸失败"
      ? `服务端返回：${message}`
      : "服务端没有返回可用的人脸识别结果。",
    nextStep: "请重新点击“自动识别人脸”；如果连续失败，请保留请求编号联系后台。",
    manualGuide
  };
}

function getAutoFaceFailureType(errorInfo) {
  const info = errorInfo && typeof errorInfo === "object" ? errorInfo : {};
  const code = String(info.code || "").toLowerCase();
  const message = String(info.message || "").toLowerCase();
  const searchText = `${code} ${message}`;
  if (isWechatBindingRequired(info)) return "wechat-binding-required";
  if (code === "cloud-unavailable") return "cloud-unavailable";
  if (
    code === "missing-api-key"
    || /api[_ -]?key|没有配置.*视觉|未配置.*视觉/.test(searchText)
  ) return "missing-api-key";
  if (code === "missing-main-image" || code === "empty-main-image") {
    return "missing-main-image";
  }
  if (
    code === "image-too-large"
    || /图片过大|主图文件过大|too large|payload too large/.test(searchText)
  ) return "image-too-large";
  if (
    code === "empty-face-detection"
    || /没有识别到|没有返回人脸|清晰人脸|face detection/.test(searchText)
  ) return "empty-face-detection";
  if (
    Number(info.status) === 408
    || Number(info.status) === 504
    || /timeout|timed out|超时/.test(searchText)
  ) return "timeout";
  if (/network|request:fail|fail to fetch|socket|网络|连接失败/.test(searchText)) {
    return "network";
  }
  if (
    Boolean(info.retryable)
    || Number(info.status) >= 500
    || code === "rate-limited"
    || code === "upstream-unavailable"
    || code === "vision-upstream-failed"
    || code === "retry-exhausted"
  ) return "upstream";
  return "unknown";
}

function getCanvasGestureTip(zoomed, manualGuideActive) {
  if (manualGuideActive) {
    return zoomed
      ? "自动识别没成功：双指拖动找位置，单指拖动圈住整张脸"
      : "自动识别没成功：单指拖动圈住整张脸，不要只点一下；双指可放大";
  }
  return zoomed
    ? "双指拖动找位置，单指拖动圈住整张脸"
    : "单指拖动圈住整张脸，不要只点一下；双指可放大";
}

function formatAutoFaceDetails(details) {
  if (!details || typeof details !== "object") return "";
  try {
    return JSON.stringify(details);
  } catch (error) {
    return String(details);
  }
}

function formatAutoFaceDuration(details) {
  if (!details || typeof details !== "object") return "";
  const rawMs = Number(
    details.clientTotalMs
      || details.durationMs
      || (details.timing && details.timing.totalMs)
      || 0
  );
  if (!Number.isFinite(rawMs) || rawMs <= 0) return "";
  return rawMs >= 1000
    ? `用时 ${(rawMs / 1000).toFixed(1)} 秒`
    : `用时 ${Math.round(rawMs)} 毫秒`;
}

function formatAutoFaceShortDetail(details) {
  if (!details || typeof details !== "object") return "";
  const cloudError = details.cloudError && typeof details.cloudError === "object"
    ? details.cloudError
    : null;
  if (details.failureGuide && details.failureGuide.reason) {
    return `原因：${details.failureGuide.reason}`;
  }
  if (cloudError && cloudError.message) return `原因：${cloudError.message}`;
  if (details.message) return String(details.message);
  if (details.faceCount !== undefined) return `识别到 ${Number(details.faceCount) || 0} 张人脸`;
  if (details.cacheHit) return "已复用本张主图的识别结果";
  if (details.reused) return "已复用云端图片，跳过重复上传";
  if (details.detectComplete) return "已完成位置确认";
  if (details.code) return `错误码：${details.code}`;
  return "";
}

Page({
  data: {
    appVersion: config.appVersion,
    cloudReady: false,
    cloudEnvId: config.cloudEnvId,
    steps: ["主图", "红圈", "参考素材", "提示词", "生成"],
    step: 0,
    entryTitle: "",
    entryHint: "",
    entryTone: "",
    project: createProject(),
    canvasWidth: 0,
    canvasHeight: 0,
    imageWidth: 0,
    imageHeight: 0,
    imagePreviewVisible: false,
    imagePreviewPath: "",
    imagePreviewTitle: "生成结果",
    canvasScale: 1,
    canvasOffsetX: 0,
    canvasOffsetY: 0,
    canvasZoomPercent: 100,
    canvasZoomed: false,
    canvasGestureTip: getCanvasGestureTip(false, false),
    manualGuideActive: false,
    drawing: false,
    loading: false,
    loadingText: "",
    generationStage: "idle",
    generationPhases: GENERATION_PHASES,
    generationPhaseIndex: 0,
    generationWaitText: "",
    generationElapsedSeconds: 0,
    generationRetryCount: 0,
    generationTimedOut: false,
    analysisAction: "",
    statusText: "先上传主图",
    clothingTargets: CLOTHING_TARGETS,
    accessoryTargets: ACCESSORY_TARGETS,
    lockPanelOpen: false,
    lockedElementOptions: createLockedElementOptions(LOCKED_ELEMENTS),
    customLockText: "",
    lockedSelectionCount: LOCKED_ELEMENTS.length,
    records: [],
    generatedResults: [],
    autoFaceStatus: createAutoFaceStatus()
  },

  onLoad(options = {}) {
    const pageLoadStartedAt = Date.now();
    this._mainImagePrepareState = null;
    this._mainImageUploadState = null;
    this._autoFaceDetectionCache = null;
    this._pageDestroyed = false;
    this._pageScrollTop = 0;
    this._canvasViewportRect = null;
    this._canvasDocumentRect = null;
    this._gestureCoordinateContext = null;
    this._gestureMode = null;
    this._pinchState = null;
    this._pinchAwaitingRelease = false;
    const isPreload = options.preload === "1";
    const entry = resolveEntryMode(options);
    const shouldCreateNew = options.new === "1";
    if (shouldCreateNew && !isPreload) {
      storage.clearProject();
    }
    if (entry) {
      this.setData({
        entryTitle: entry.title,
        entryHint: entry.hint,
        entryTone: entry.tone
      });
    }
    this._canvasView = {
      scale: MIN_SCALE,
      offsetX: 0,
      offsetY: 0
    };
    const saved = isPreload || shouldCreateNew ? null : storage.loadProject();
    if (saved && typeof saved === "object") {
      const project = Object.assign(createProject(), saved);
      project.lockedElements = Array.isArray(project.lockedElements)
        ? project.lockedElements.filter((item) => LOCKED_ELEMENTS.indexOf(item) >= 0)
        : LOCKED_ELEMENTS.slice();
      project.customLockedElements = Array.isArray(project.customLockedElements)
        ? project.customLockedElements.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
        : [];
      project.webPoseSuggestions = normalizeWebPoseSuggestions(project.webPoseSuggestions);
      const selectedWebPose = normalizeWebPoseSuggestion(project.selectedWebPose);
      project.selectedWebPose = selectedWebPose && project.webPoseSuggestions.some(
        (item) => item.id === selectedWebPose.id
          && item.title === selectedWebPose.title
          && item.description === selectedWebPose.description
      ) ? selectedWebPose : null;
      project.wardrobeRefs = (project.wardrobeRefs || []).map((item) => Object.assign({}, item, {
        targetOptions: item.kind === "accessory" ? ACCESSORY_TARGETS : CLOTHING_TARGETS
      }));
      this.setData({
        project,
        lockedElementOptions: createLockedElementOptions(project.lockedElements),
        customLockText: project.customLockedElements.join("\n"),
        lockedSelectionCount: project.lockedElements.length + project.customLockedElements.length,
        generatedResults: (project.results || [])
          .map((record) => decorateRecordForRepair(record, this.data.cloudReady))
      });
      if (project.mainImage && project.mainImage.path) {
        this.prepareCanvas(project.mainImage);
      }
    }
    if (!isPreload) {
      this.refreshCloudState();
      const loadRecordsAfterFirstRender = () => {
        this.loadRecords();
      };
      if (typeof wx.nextTick === "function") {
        wx.nextTick(loadRecordsAfterFirstRender);
      } else {
        setTimeout(loadRecordsAfterFirstRender, 0);
      }
    }
    console.info("[index] 制作页首屏初始化完成", {
      durationMs: Date.now() - pageLoadStartedAt,
      shouldCreateNew,
      isPreload
    });
  },

  onShow() {
    const pending = app && app.globalData && app.globalData.pendingNewCreation;
    if (pending) {
      this.resetForNewCreation(pending.mode);
      app.globalData.pendingNewCreation = null;
    }
    this.refreshCloudState();
  },

  onPageScroll(event = {}) {
    const scrollTop = Number(event.scrollTop);
    if (!Number.isFinite(scrollTop)) return;
    this._pageScrollTop = Math.max(0, scrollTop);
  },

  resetForNewCreation(mode) {
    const entry = resolveEntryMode({ mode }) || ENTRY_MODE_META.custom;
    this.clearCanvasDrawTimer();
    this.invalidateMainImageState();
    this._drawingStart = null;
    this._drawingCurrent = null;
    this._drawingTouchId = null;
    this._gestureMode = null;
    this._pinchState = null;
    this._pinchAwaitingRelease = false;
    this._gestureCoordinateContext = null;
    this._canvasViewportRect = null;
    this._canvasDocumentRect = null;
    this._canvasView = {
      scale: MIN_SCALE,
      offsetX: 0,
      offsetY: 0
    };
    storage.clearProject();
    this.setData({
      entryTitle: entry.title,
      entryHint: entry.hint,
      entryTone: entry.tone,
      project: createProject(),
      step: 0,
      canvasWidth: 0,
      canvasHeight: 0,
      imageWidth: 0,
      imageHeight: 0,
      canvasScale: MIN_SCALE,
      canvasOffsetX: 0,
      canvasOffsetY: 0,
      canvasZoomPercent: 100,
      canvasZoomed: false,
      drawing: false,
      loading: false,
      loadingText: "",
      generationStage: "idle",
      generationPhaseIndex: 0,
      generationWaitText: "",
      generationElapsedSeconds: 0,
      generationRetryCount: 0,
      generationTimedOut: false,
      analysisAction: "",
      statusText: "先上传主图",
      lockPanelOpen: false,
      lockedElementOptions: createLockedElementOptions(LOCKED_ELEMENTS),
      customLockText: "",
      lockedSelectionCount: LOCKED_ELEMENTS.length,
      generatedResults: [],
      autoFaceStatus: createAutoFaceStatus()
    });
    console.info("[index] 已复用预热制作页，进入新创作", { mode });
  },

  onUnload() {
    this._pageDestroyed = true;
    this._gestureMode = null;
    this._pinchState = null;
    this._pinchAwaitingRelease = false;
    this._gestureCoordinateContext = null;
    this.clearCanvasDrawTimer();
    this.stopGenerationTimer();
    diagnosticLog.info("creation", "page-unload", "制作页离开", {
      step: this.data.step,
      hasMainImage: Boolean(this.data.project && this.data.project.mainImage)
    });
  },

  startGenerationTimer() {
    this.stopGenerationTimer();
    this._generationStartedAt = Date.now();
    this._generationTimer = setInterval(() => {
      if (!this.data.loading || !this._generationStartedAt) return;
      this.setData({
        generationElapsedSeconds: Math.floor(
          (Date.now() - this._generationStartedAt) / 1000
        )
      });
    }, 1000);
    this._generationTimeoutTimer = setTimeout(() => {
      if (
        this._pageDestroyed
        || !this.data.loading
        || this.data.generationTimedOut
      ) {
        return;
      }
      this.setData({
        generationStage: "timeout",
        generationPhaseIndex: 2,
        generationTimedOut: true,
        generationWaitText: "已经等待超过 2 分钟，服务可能仍在处理中，请不要重复提交。"
      });
      wx.showModal({
        title: "生成时间较长",
        content: "已经等待超过 2 分钟，当前请求可能还在处理。请不要重复点击，完成后会自动显示结果。",
        showCancel: false
      });
      diagnosticLog.warn("generation", "timeout-warning", "生图等待超过两分钟", {
        step: "generate",
        durationMs: GENERATION_TIMEOUT_MS
      });
    }, GENERATION_TIMEOUT_MS);
  },

  stopGenerationTimer() {
    if (this._generationTimer) {
      clearInterval(this._generationTimer);
      this._generationTimer = null;
    }
    if (this._generationTimeoutTimer) {
      clearTimeout(this._generationTimeoutTimer);
      this._generationTimeoutTimer = null;
    }
    this._generationStartedAt = 0;
  },

  setGenerationPhase(stage, loadingText, generationWaitText, extra = {}) {
    const phaseIndex = GENERATION_PHASES.findIndex((item) => item.key === stage);
    this.setData(Object.assign({
      loadingText,
      generationStage: stage,
      generationPhaseIndex: phaseIndex >= 0 ? phaseIndex : this.data.generationPhaseIndex,
      generationWaitText
    }, extra));
    diagnosticLog.info("generation", "phase", `生图进入${stage}阶段`, {
      step: stage,
      loadingText
    });
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => {
        wx.reLaunch({
          url: "/pages/workbench/workbench"
        });
      }
    });
  },

  recordAutoFaceStatus(state, stage, source, message, details) {
    const normalizedState = String(state || "");
    const normalizedStage = String(stage || "");
    const failureGuide = details
      && details.failureGuide
      && typeof details.failureGuide === "object"
      ? details.failureGuide
      : null;
    const cloudError = details
      && details.cloudError
      && typeof details.cloudError === "object"
      ? details.cloudError
      : null;
    const entry = {
      state: normalizedState,
      stateLabel: AUTO_FACE_STATE_LABELS[normalizedState] || normalizedState || "未知",
      stage: normalizedStage,
      stageLabel: AUTO_FACE_STAGE_LABELS[normalizedStage] || normalizedStage || "运行记录",
      source: String(source || ""),
      message: String(message || ""),
      details: details && typeof details === "object" ? clone(details) : null,
      summary: formatAutoFaceDetails(details),
      shortDetail: formatAutoFaceShortDetail(details),
      failureReason: failureGuide && failureGuide.reason
        ? String(failureGuide.reason)
        : "",
      nextStepText: failureGuide && failureGuide.nextStep
        ? String(failureGuide.nextStep)
        : "",
      manualGuideText: failureGuide && failureGuide.manualGuide
        ? String(failureGuide.manualGuide)
        : "",
      requestId: String(
        (cloudError && cloudError.requestId)
          || (details && details.requestId)
          || ""
      ),
      durationText: formatAutoFaceDuration(details),
      updatedAt: new Date().toISOString()
    };
    this.setData({
      autoFaceStatus: entry
    });
    const method = state === "manual-required" || state === "fallback" ? "warn" : "log";
    console[method]("[auto-face]", entry);
    const logMethod = state === "manual-required" || state === "fallback"
      ? diagnosticLog.warn
      : diagnosticLog.info;
    logMethod("auto-face", normalizedStage, message, {
      step: normalizedStage,
      source,
      state: normalizedState,
      details: entry.details
    });
    return entry;
  },

  getMainImageKey(image) {
    return assetIdentity(image);
  },

  invalidateMainImageState() {
    this._mainImagePrepareState = null;
    this._mainImageUploadState = null;
    this._autoFaceDetectionCache = null;
  },

  isCurrentMainImage(key) {
    return Boolean(
      key
      && !this._pageDestroyed
      && this.getMainImageKey(this.data.project && this.data.project.mainImage) === key
    );
  },

  clearStaleAutoFaceCircle() {
    const project = this.data.project || {};
    const currentImageKey = this.getMainImageKey(project.mainImage);
    const cache = this._autoFaceDetectionCache;
    const cachedCircle = cache
      && cache.key === currentImageKey
      && cache.circle
      ? cache.circle
      : null;
    const status = this.data.autoFaceStatus || {};
    const statusCircle = status.state === "ready"
      && status.stage === "detect-complete"
      && status.details
      && status.details.circle
      ? status.details.circle
      : null;
    const autoCircle = cachedCircle || statusCircle;
    const shouldClearCircle = isSameFaceCircle(project.maskCircle, autoCircle);

    this._autoFaceDetectionCache = null;
    if (shouldClearCircle) {
      this.updateProject({ maskCircle: null, maskFileID: "" });
    }
    return shouldClearCircle;
  },

  enterManualFaceCircle(cloudError) {
    const cloudInfo = cloudError || null;
    const failureGuide = getAutoFaceFailureGuide(cloudInfo, Boolean(cloudInfo));
    const authorizationRequired = isWechatBindingRequired(cloudInfo);
    this.clearStaleAutoFaceCircle();
    this.setData({
      step: 1,
      manualGuideActive: true,
      canvasGestureTip: getCanvasGestureTip(Boolean(this.data.canvasZoomed), true)
    });
    this.drawCanvas();
    this.recordAutoFaceStatus(
      "manual-required",
      cloudInfo ? "cloud-failed" : "cloud-unavailable",
      "manual",
      cloudInfo
        ? (authorizationRequired
          ? "模拟器未完成微信授权，已进入手动圈选"
          : "云端自动贴脸不可用，已进入手动圈选")
        : "云端未连接，已进入手动圈选",
      {
        cloudError: cloudInfo,
        failureGuide
      }
    );
    if (cloudInfo) {
      this.reportAutoFaceFailure(cloudInfo, "cloud-failed");
    }
    const requestId = cloudInfo && cloudInfo.requestId;
    const modalContent = [
      `原因：${failureGuide.reason}`,
      `下一步：${failureGuide.nextStep}`,
      `手动圈选：${failureGuide.manualGuide}`,
      requestId ? `请求编号：${requestId}` : ""
    ].filter(Boolean).join("\n");
    wx.showModal({
      title: authorizationRequired ? "模拟器未完成微信授权" : "自动贴脸没成功",
      content: modalContent,
      showCancel: false
    });
  },

  reportAutoFaceFailure(cloudError, stage) {
    const info = cloudError && typeof cloudError === "object" ? cloudError : null;
    if (
      !info
      || !cloud.isCloudReady()
      || typeof cloud.reportAutoFaceFailure !== "function"
    ) return;
    const payload = {
      requestId: String(info.requestId || ""),
      failureType: getAutoFaceFailureType(info),
      errorCode: String(info.code || ""),
      message: String(info.message || "").slice(0, 240),
      status: Number(info.status) || 0,
      retryable: Boolean(info.retryable),
      stage: String(stage || "cloud-failed"),
      durationMs: Math.max(0, Number(info.clientTotalMs) || 0),
      appVersion: String(config.appVersion || ""),
      probe: Object.assign(
        { status: "not-run" },
        this._autoFaceProbe || {}
      )
    };
    try {
      const pending = cloud.reportAutoFaceFailure(payload);
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => {
          diagnosticLog.warn("auto-face", "failure-report-failed", "自动贴脸失败日志上报失败", {
            requestId: payload.requestId,
            failureType: payload.failureType,
            error
          });
        });
      }
    } catch (error) {
      diagnosticLog.warn("auto-face", "failure-report-failed", "自动贴脸失败日志上报失败", {
        requestId: payload.requestId,
        failureType: payload.failureType,
        error
      });
    }
  },

  refreshCloudState() {
    const ready = cloud.isCloudReady();
    this.setData({
      cloudReady: ready,
      cloudEnvId: config.cloudEnvId,
      statusText: ready ? "云端已连接" : "本地预览模式"
    });
    if (ready && this.data.project && this.data.project.mainImage) {
      this.preloadMainImageUpload(this.data.project.mainImage);
    }
  },

  persist() {
    storage.saveProject(this.data.project);
  },

  updateProject(patch) {
    const project = Object.assign({}, this.data.project, patch);
    this.setData({ project });
    storage.saveProject(project);
    return project;
  },

  async chooseMainImage() {
    diagnosticLog.info("creation", "main-image-choose-start", "开始选择主图", {
      step: "main-image"
    });
    try {
      const result = await chooseImages(1);
      const file = result.tempFiles && result.tempFiles[0];
      if (!file) return;
      const prepared = await prepareImageAsset(file, {
        compression: config.imageCompression
      });
      const mainImage = {
        id: `main-${Date.now()}`,
        stableKey: `main-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        name: file.name || basename(file.tempFilePath),
        path: prepared.path,
        type: prepared.type,
        size: prepared.compressedSize || file.size || 0,
        width: prepared.width,
        height: prepared.height,
        originalWidth: prepared.originalWidth,
        originalHeight: prepared.originalHeight,
        originalSize: prepared.originalSize,
        compressedSize: prepared.compressedSize,
        compressed: prepared.compressed,
        compressionChecked: prepared.compressionChecked,
        compressionQuality: prepared.compressionQuality,
        fileID: ""
      };
      this.invalidateMainImageState();
      this.updateProject({
        mainImage,
        maskCircle: null,
        maskFileID: "",
        sceneDescription: "",
        poseDescription: "",
        faceDirectionDescription: "",
        lightingMakeupDescription: "",
        promptDraft: "",
        negativePrompt: "",
        webPoseSuggestions: [],
        selectedWebPose: null,
        webPoseAnalysisMeta: null
      });
      this.resetCanvasView();
      this.setData({
        step: 0,
        manualGuideActive: false,
        canvasGestureTip: getCanvasGestureTip(false, false),
        autoFaceStatus: createAutoFaceStatus()
      });
      this.prepareCanvas(mainImage);
      this.preloadMainImageUpload(mainImage);
      diagnosticLog.info("creation", "main-image-ready", "主图选择和处理完成", {
        step: "main-image",
        filePath: mainImage.path,
        originalSize: mainImage.originalSize,
        compressedSize: mainImage.compressedSize,
        width: mainImage.width,
        height: mainImage.height,
        compressed: mainImage.compressed
      });
    } catch (error) {
      this.showError("主图选择失败", error);
    }
  },

  clearMainImage() {
    if (!this.data.project.mainImage) return;
    wx.showModal({
      title: "清除主图？",
      content: "将清除主图、红圈、图片分析和当前提示词；人脸参考、穿搭参考和历史记录会保留。",
      success: (response) => {
        if (!response.confirm) return;
        this.clearCanvasDrawTimer();
        this._drawingStart = null;
        this.invalidateMainImageState();
        this.updateProject({
          mainImage: null,
          maskCircle: null,
          maskFileID: "",
          sceneDescription: "",
          poseDescription: "",
          faceDirectionDescription: "",
          lightingMakeupDescription: "",
          promptDraft: "",
          negativePrompt: "",
          webPoseSuggestions: [],
          selectedWebPose: null,
          webPoseAnalysisMeta: null
        });
        this.setData({
          step: 0,
          drawing: false,
          canvasWidth: 0,
          canvasHeight: 0,
          imageWidth: 0,
          imageHeight: 0,
          canvasScale: MIN_SCALE,
          canvasOffsetX: 0,
          canvasOffsetY: 0,
          canvasZoomPercent: 100,
          canvasZoomed: false,
          canvasGestureTip: getCanvasGestureTip(false, false),
          manualGuideActive: false,
          autoFaceStatus: createAutoFaceStatus()
        });
        this._canvasView = {
          scale: MIN_SCALE,
          offsetX: 0,
          offsetY: 0
        };
        this._canvasViewportRect = null;
        this._canvasDocumentRect = null;
        this._gestureCoordinateContext = null;
        this._gestureMode = null;
        this._pinchState = null;
        this._pinchAwaitingRelease = false;
        diagnosticLog.info("creation", "main-image-cleared", "主图已清除", {
          step: "main-image"
        });
        wx.showToast({ title: "主图已清除", icon: "success" });
      }
    });
  },

  async prepareCanvas(image) {
    if (!image || !image.path || !image.width || !image.height) return;
    const info = wx.getSystemInfoSync();
    let width = Math.min(690, Math.max(280, info.windowWidth - 56));
    let height = width * image.height / image.width;
    if (height > 620) {
      height = 620;
      width = height * image.width / image.height;
    }
    this.setData({
      canvasWidth: Math.round(width),
      canvasHeight: Math.round(height),
      imageWidth: image.width,
      imageHeight: image.height
    }, () => {
      this.resetCanvasView();
      this.refreshCanvasViewportRect();
      this.drawCanvas();
    });
  },

  drawEllipse(ctx, circle) {
    const k = 0.5522848;
    const cx = circle.x * this.data.canvasWidth / this.data.imageWidth;
    const cy = circle.y * this.data.canvasHeight / this.data.imageHeight;
    const rx = circle.width * this.data.canvasWidth / this.data.imageWidth / 2;
    const ry = circle.height * this.data.canvasHeight / this.data.imageHeight / 2;
    ctx.beginPath();
    ctx.moveTo(cx + rx, cy);
    ctx.bezierCurveTo(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry);
    ctx.bezierCurveTo(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy);
    ctx.bezierCurveTo(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry);
    ctx.bezierCurveTo(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy);
    ctx.closePath();
  },

  clearCanvasDrawTimer() {
    if (this._canvasDrawTimer) {
      clearTimeout(this._canvasDrawTimer);
      this._canvasDrawTimer = null;
    }
    this._pendingCanvasCircle = null;
  },

  scheduleCanvasDraw(circle) {
    this._pendingCanvasCircle = circle;
    if (this._canvasDrawTimer) return;
    const elapsed = Date.now() - (this._lastCanvasDrawAt || 0);
    const wait = Math.max(0, 32 - elapsed);
    this._canvasDrawTimer = setTimeout(() => {
      this._canvasDrawTimer = null;
      this._lastCanvasDrawAt = Date.now();
      const pending = this._pendingCanvasCircle;
      this._pendingCanvasCircle = null;
      if (pending) this.drawCanvas(pending);
    }, wait);
  },

  drawCanvas(circleOverride) {
    const image = this.data.project.mainImage;
    if (!image || !image.path || !this.data.canvasWidth || !this.data.canvasHeight) return;
    const ctx = wx.createCanvasContext("maskCanvas", this);
    ctx.clearRect(0, 0, this.data.canvasWidth, this.data.canvasHeight);
    const circle = circleOverride === undefined
      ? this.data.project.maskCircle
      : circleOverride;
    if (circle) {
      ctx.setLineWidth(4);
      ctx.setStrokeStyle("#ff3b42");
      this.drawEllipse(ctx, circle);
      ctx.stroke();
    }
    ctx.draw();
  },

  refreshCanvasViewportRect() {
    const query = wx.createSelectorQuery().in(this);
    query.select(".canvas-viewport").boundingClientRect();
    if (typeof query.selectViewport === "function") {
      query.selectViewport().scrollOffset();
    }
    query.exec((results) => {
      const rect = results && results[0];
      const scroll = results && results[1];
      if (!rect) return;
      const scrollTop = Number(scroll && scroll.scrollTop);
      if (Number.isFinite(scrollTop)) {
        this._pageScrollTop = Math.max(0, scrollTop);
      }
      this._canvasViewportRect = {
        left: Number(rect.left) || 0,
        top: Number(rect.top) || 0,
        width: Number(rect.width) || this.data.canvasWidth,
        height: Number(rect.height) || this.data.canvasHeight
      };
      this._canvasDocumentRect = {
        left: this._canvasViewportRect.left,
        top: this._canvasViewportRect.top + this._pageScrollTop,
        width: this._canvasViewportRect.width,
        height: this._canvasViewportRect.height
      };
    });
  },

  getCanvasView() {
    if (!this._canvasView) {
      this._canvasView = {
        scale: Number(this.data.canvasScale) || MIN_SCALE,
        offsetX: Number(this.data.canvasOffsetX) || 0,
        offsetY: Number(this.data.canvasOffsetY) || 0
      };
    }
    return this._canvasView;
  },

  setCanvasView(scale, offsetX, offsetY) {
    const safeScale = clamp(Number(scale) || MIN_SCALE, MIN_SCALE, MAX_SCALE);
    const offset = clampOffset(
      safeScale,
      this.data.canvasWidth,
      this.data.canvasHeight,
      offsetX,
      offsetY
    );
    const zoomed = safeScale > MIN_SCALE;
    this._canvasView = {
      scale: safeScale,
      offsetX: offset.x,
      offsetY: offset.y
    };
    this.setData({
      canvasScale: safeScale,
      canvasOffsetX: offset.x,
      canvasOffsetY: offset.y,
      canvasZoomPercent: Math.round(safeScale * 100),
      canvasZoomed: zoomed,
      canvasGestureTip: getCanvasGestureTip(
        zoomed,
        Boolean(this.data.manualGuideActive)
      )
    });
  },

  resetCanvasView() {
    this.setCanvasView(MIN_SCALE, 0, 0);
  },

  zoomBy(step) {
    if (!this.data.project.mainImage) return;
    const view = this.getCanvasView();
    this.setCanvasView(view.scale + Number(step || 0), view.offsetX, view.offsetY);
  },

  zoomIn() {
    this.zoomBy(0.25);
  },

  zoomOut() {
    this.zoomBy(-0.25);
  },

  getCanvasCoordinateLayout() {
    const documentRect = this._canvasDocumentRect;
    const viewportRect = this._canvasViewportRect;
    if (!documentRect && !viewportRect) return null;
    const scrollTop = Math.max(0, Number(this._pageScrollTop) || 0);
    const documentLeft = documentRect
      ? Number(documentRect.left) || 0
      : Number(viewportRect.left) || 0;
    const documentTop = documentRect
      ? Number(documentRect.top) || 0
      : (Number(viewportRect.top) || 0) + scrollTop;
    return {
      documentLeft,
      documentTop,
      viewportLeft: documentLeft,
      viewportTop: documentTop - scrollTop
    };
  },

  getEventTouches(event, includeChanged = false) {
    if (!event) return [];
    const primary = includeChanged ? event.changedTouches : event.touches;
    const fallback = includeChanged ? event.touches : event.changedTouches;
    if (Array.isArray(primary) && primary.length) return primary;
    return Array.isArray(fallback) ? fallback : [];
  },

  beginGestureCoordinateContext(touches) {
    const layout = this.getCanvasCoordinateLayout();
    if (!layout) {
      this.refreshCanvasViewportRect();
      return null;
    }
    const context = createTouchCoordinateContext(touches, layout);
    this._gestureCoordinateContext = context;
    return context;
  },

  getViewportPoint(touch) {
    return resolveTouchPoint(
      touch,
      this._gestureCoordinateContext,
      this.data.canvasWidth,
      this.data.canvasHeight
    );
  },

  getCanvasPoint(touch) {
    const viewportPoint = this.getViewportPoint(touch);
    if (!viewportPoint) return null;
    return mapViewportPointToCanvas(
      viewportPoint,
      this.getCanvasView(),
      this.data.canvasWidth,
      this.data.canvasHeight
    );
  },

  getViewportTouches(event) {
    return resolveTouchPoints(
      this.getEventTouches(event),
      this._gestureCoordinateContext,
      this.data.canvasWidth,
      this.data.canvasHeight
    );
  },

  beginPinch(event) {
    const rawTouches = this.getEventTouches(event).slice(0, 2);
    if (rawTouches.length < 2) return false;
    if (!this.beginGestureCoordinateContext(rawTouches)) return false;
    const touches = resolveTouchPoints(
      rawTouches,
      this._gestureCoordinateContext,
      this.data.canvasWidth,
      this.data.canvasHeight
    );
    if (touches.length < 2) {
      this._gestureCoordinateContext = null;
      return false;
    }
    this.clearCanvasDrawTimer();
    this._drawingStart = null;
    this._drawingCurrent = null;
    this._drawingTouchId = null;
    this._pinchState = createPinchState(
      touches[0],
      touches[1],
      this.getCanvasView(),
      this.data.canvasWidth,
      this.data.canvasHeight
    );
    this._gestureMode = this._pinchState ? "pinch" : null;
    this._pinchAwaitingRelease = false;
    if (this.data.drawing) this.setData({ drawing: false });
    return Boolean(this._pinchState);
  },

  circleFromPoints(start, end) {
    const startPoint = {
      x: start.x * this.data.imageWidth / this.data.canvasWidth,
      y: start.y * this.data.imageHeight / this.data.canvasHeight
    };
    const endPoint = {
      x: end.x * this.data.imageWidth / this.data.canvasWidth,
      y: end.y * this.data.imageHeight / this.data.canvasHeight
    };
    return createCircleFromPoints(
      startPoint,
      endPoint,
      this.data.imageWidth,
      this.data.imageHeight
    );
  },

  getDrawingTouch(event, includeChanged = false) {
    const collections = includeChanged
      ? [event.changedTouches, event.touches]
      : [event.touches, event.changedTouches];
    for (const touches of collections) {
      const touch = findTouchByIdentifier(touches, this._drawingTouchId);
      if (touch) return touch;
    }
    return null;
  },

  getActiveTouchCount(event) {
    return event && Array.isArray(event.touches)
      ? event.touches.length
      : 0;
  },

  onCanvasTouchStart(event) {
    if (!this.data.project.mainImage) return;
    if (this._pinchAwaitingRelease) return;
    const rawTouches = this.getEventTouches(event);
    if (rawTouches.length >= 2) {
      this.beginPinch(event);
      return;
    }
    if (this._gestureMode === "pinch") return;
    const touch = rawTouches[0];
    if (!touch) return;
    if (!this.beginGestureCoordinateContext([touch])) return;
    this.clearCanvasDrawTimer();
    this._lastCanvasDrawAt = 0;
    this._drawingStart = this.getCanvasPoint(touch);
    if (!this._drawingStart) {
      this._gestureCoordinateContext = null;
      return;
    }
    this._drawingCurrent = this._drawingStart;
    this._drawingTouchId = getTouchIdentifier(touch);
    this._gestureMode = "draw";
    this.setData({ drawing: true });
  },

  onCanvasTouchMove(event) {
    if (this._pinchAwaitingRelease) return;
    const rawTouches = this.getEventTouches(event);
    if (rawTouches.length >= 2) {
      if (this._gestureMode !== "pinch" && !this.beginPinch(event)) return;
      const touches = this.getViewportTouches(event);
      if (touches.length < 2) return;
      const nextView = updatePinchView(
        this._pinchState,
        touches[0],
        touches[1],
        this.data.canvasWidth,
        this.data.canvasHeight
      );
      if (nextView && nextView.changed) {
        this.setCanvasView(nextView.scale, nextView.offsetX, nextView.offsetY);
      }
      return;
    }
    if (this._gestureMode === "pinch") return;
    if (this._gestureMode !== "draw" || !this._drawingStart) return;
    const touch = this.getDrawingTouch(event);
    if (!touch) return;
    this._drawingCurrent = this.getCanvasPoint(touch);
    if (!this._drawingCurrent) return;
    const preview = this.circleFromPoints(this._drawingStart, this._drawingCurrent);
    this.scheduleCanvasDraw(preview);
  },

  onCanvasTouchEnd(event) {
    if (this._gestureMode === "pinch") {
      if (this.getActiveTouchCount(event) > 0) {
        this._pinchState = null;
        this._pinchAwaitingRelease = true;
        this._gestureCoordinateContext = null;
        this._drawingStart = null;
        this._drawingCurrent = null;
        this._drawingTouchId = null;
        return;
      }
      this._gestureMode = null;
      this._pinchState = null;
      this._pinchAwaitingRelease = false;
      this._gestureCoordinateContext = null;
      this._drawingStart = null;
      this._drawingCurrent = null;
      this._drawingTouchId = null;
      return;
    }
    if (this._pinchAwaitingRelease) {
      if (this.getActiveTouchCount(event) === 0) {
        this._pinchAwaitingRelease = false;
        this._gestureCoordinateContext = null;
      }
      return;
    }
    if (this._gestureMode !== "draw" || !this._drawingStart) return;
    this.clearCanvasDrawTimer();
    const touch = this.getDrawingTouch(event, true);
    const touchPoint = touch ? this.getCanvasPoint(touch) : null;
    const endPoint = touchPoint
      ? touchPoint
      : (this._drawingCurrent || this._drawingStart);
    const circle = this.circleFromPoints(this._drawingStart, endPoint);
    this._drawingStart = null;
    this._drawingCurrent = null;
    this._drawingTouchId = null;
    this._gestureMode = null;
    this._gestureCoordinateContext = null;
    this.updateProject({ maskCircle: circle, maskFileID: "" });
    this.setData({ drawing: false, step: 1 });
    this.drawCanvas(circle);
  },

  onCanvasTouchCancel() {
    this.clearCanvasDrawTimer();
    this._drawingStart = null;
    this._drawingCurrent = null;
    this._drawingTouchId = null;
    this._gestureMode = null;
    this._pinchState = null;
    this._pinchAwaitingRelease = false;
    this._gestureCoordinateContext = null;
    this.setData({ drawing: false });
    this.drawCanvas();
  },

  clearCircle() {
    if (!this.data.project.maskCircle) {
      wx.showToast({ title: "当前没有红圈", icon: "none" });
      return;
    }
    this.clearCanvasDrawTimer();
    this.updateProject({ maskCircle: null, maskFileID: "" });
    this.drawCanvas(null);
  },

  selectFaceForCircle(faces, currentCircle) {
    const mainImage = this.data.project && this.data.project.mainImage || {};
    const imageWidth = Number(this.data.imageWidth) || Number(mainImage.width) || 1;
    const imageHeight = Number(this.data.imageHeight) || Number(mainImage.height) || 1;
    const normalized = (Array.isArray(faces) ? faces : []).map((face) => {
      const width = clamp(Number(face.width) / 1000 * imageWidth, 24, imageWidth);
      const height = clamp(Number(face.height) / 1000 * imageHeight, 24, imageHeight);
      const left = clamp(Number(face.x) / 1000 * imageWidth, 0, imageWidth - width);
      const top = clamp(Number(face.y) / 1000 * imageHeight, 0, imageHeight - height);
      return {
        x: left + width / 2,
        y: top + height / 2,
        width,
        height,
        area: width * height,
        confidence: Number(face.confidence) || 0
      };
    }).filter((face) => face.width > 24 && face.height > 24);
    if (!normalized.length) return null;
    if (currentCircle) {
      return normalized.sort((left, right) => {
        const leftDistance = Math.pow(left.x - currentCircle.x, 2) + Math.pow(left.y - currentCircle.y, 2);
        const rightDistance = Math.pow(right.x - currentCircle.x, 2) + Math.pow(right.y - currentCircle.y, 2);
        return leftDistance - rightDistance || right.area - left.area;
      })[0];
    }
    return normalized.sort((left, right) => right.area - left.area || right.confidence - left.confidence)[0];
  },

  circleFromFace(face) {
    if (!face) return null;
    const mainImage = this.data.project && this.data.project.mainImage || {};
    const imageWidth = Number(this.data.imageWidth) || Number(mainImage.width) || 1;
    const imageHeight = Number(this.data.imageHeight) || Number(mainImage.height) || 1;
    const width = clamp(
      Math.max(AUTO_FACE_MIN_WIDTH, face.width * AUTO_FACE_WIDTH_SCALE),
      AUTO_FACE_MIN_WIDTH,
      imageWidth
    );
    const height = clamp(
      Math.max(AUTO_FACE_MIN_HEIGHT, face.height * AUTO_FACE_HEIGHT_SCALE),
      AUTO_FACE_MIN_HEIGHT,
      imageHeight
    );
    return {
      x: clamp(face.x, width / 2, imageWidth - width / 2),
      y: clamp(face.y - face.height * 0.04, height / 2, imageHeight - height / 2),
      width,
      height
    };
  },

  applyCachedAutoFaceCircle(circle) {
    const cachedCircle = clone(circle);
    this.updateProject({ maskCircle: cachedCircle, maskFileID: "" });
    this.setData({
      step: 1,
      manualGuideActive: false,
      canvasGestureTip: getCanvasGestureTip(Boolean(this.data.canvasZoomed), false)
    });
    this.drawCanvas(cachedCircle);
    this.recordAutoFaceStatus(
      "ready",
      "cache-hit",
      "cache",
      "已复用本张主图的人脸识别结果",
      { cacheHit: true }
    );
    wx.showToast({ title: "已复用上次贴脸结果", icon: "success" });
  },

  async autoFaceCircle() {
    if (!this.data.project.mainImage) {
      wx.showToast({ title: "请先上传主图", icon: "none" });
      return;
    }
    if (this.data.analysisAction) {
      wx.showToast({ title: "请等当前分析完成", icon: "none" });
      return;
    }
    this.setData({ analysisAction: "faceCircle" });
    const autoFaceStartedAt = Date.now();
    this._autoFaceProbe = {
      status: "not-run"
    };
    try {
      const project = this.data.project;
      const mainImageKey = this.getMainImageKey(project.mainImage);
      const cached = this._autoFaceDetectionCache;
      if (cached && cached.key === mainImageKey && cached.circle) {
        this.applyCachedAutoFaceCircle(cached.circle);
        return;
      }
      if (!cloud.isCloudReady()) {
        this.enterManualFaceCircle(null);
        return;
      }

      let circle = null;
      this.recordAutoFaceStatus(
        "running",
        "cloud-start",
        "cloud",
        "正在使用云端自动贴脸"
      );
      if (typeof cloud.probeAutoFace === "function") {
        const probeStartedAt = Date.now();
        this._autoFaceProbe = {
          status: "pending"
        };
        cloud.probeAutoFace()
          .then((probe) => {
            this._autoFaceProbe = {
              status: "ok",
              requestId: probe && probe.requestId || "",
              buildVersion: probe && probe.buildVersion || "",
              buildMarker: probe && probe.buildMarker || "",
              nodeVersion: probe && probe.runtime && probe.runtime.nodeVersion || "",
              cloudEnvConfigured: Boolean(
                probe && probe.runtime && probe.runtime.cloudEnvConfigured
              ),
              visionConfigured: Boolean(
                probe && probe.vision && probe.vision.configured
              ),
              provider: probe && probe.vision && probe.vision.provider || "",
              model: probe && probe.vision && probe.vision.model || "",
              durationMs: Date.now() - probeStartedAt
            };
            diagnosticLog.info("auto-face", "cloud-probe", "自动贴脸云端探针返回", {
              requestId: this._autoFaceProbe.requestId,
              durationMs: this._autoFaceProbe.durationMs,
              buildVersion: this._autoFaceProbe.buildVersion,
              buildMarker: this._autoFaceProbe.buildMarker,
              cloudEnvConfigured: this._autoFaceProbe.cloudEnvConfigured,
              visionConfigured: this._autoFaceProbe.visionConfigured,
              visionProvider: this._autoFaceProbe.provider,
              visionModel: this._autoFaceProbe.model
            });
          })
          .catch((error) => {
            const probeError = safeErrorInfo(error, "自动贴脸探针失败");
            this._autoFaceProbe = {
              status: "failed",
              requestId: probeError.requestId || "",
              errorCode: probeError.code || "probe-failed",
              durationMs: Date.now() - probeStartedAt
            };
            diagnosticLog.warn("auto-face", "cloud-probe-failed", "自动贴脸云端探针失败", {
              requestId: this._autoFaceProbe.requestId,
              durationMs: this._autoFaceProbe.durationMs,
              code: this._autoFaceProbe.errorCode,
              error
            });
          });
      }
      wx.showLoading({ title: "云端识别人脸中", mask: true });
      try {
        const uploadStartedAt = Date.now();
        const hadMainFileID = Boolean(project.mainImage.fileID);
        const uploadedMainImage = await this.ensureUploaded(project.mainImage, "main");
        const uploadMs = Date.now() - uploadStartedAt;
        this.recordAutoFaceStatus(
          "running",
          "upload-complete",
          "cloud",
          hadMainFileID ? "主图已在云端，跳过重复上传" : "主图上传完成",
          {
            durationMs: uploadMs,
            reused: hadMainFileID,
            fileID: uploadedMainImage.fileID || ""
          }
        );
        if (!this.isCurrentMainImage(mainImageKey)) {
          const staleError = new Error("主图已更换，已取消旧的人脸识别。");
          staleError.code = "stale-main-image";
          throw staleError;
        }
        if (uploadedMainImage.fileID !== project.mainImage.fileID) {
          const currentMainImage = this.data.project.mainImage;
          this.updateProject({
            mainImage: Object.assign({}, currentMainImage, uploadedMainImage)
          });
        }
        const detectStartedAt = Date.now();
        const cloudResult = await cloud.detectFaceCircle({
          mainFileID: uploadedMainImage.fileID,
          projectName: project.projectName
        });
        const clientDetectMs = Date.now() - detectStartedAt;
        if (!this.isCurrentMainImage(mainImageKey)) {
          const staleError = new Error("主图已更换，已取消旧的人脸识别。");
          staleError.code = "stale-main-image";
          throw staleError;
        }
        const selectedFace = this.selectFaceForCircle(
          cloudResult && cloudResult.faces,
          this.data.project.maskCircle
        );
        circle = this.circleFromFace(selectedFace);
        if (!circle) throw new Error("云端没有识别到清晰人脸。");
        this._autoFaceDetectionCache = {
          key: mainImageKey,
          circle: clone(circle),
          faceCount: Array.isArray(cloudResult && cloudResult.faces)
            ? cloudResult.faces.length
            : 0
        };
        this.recordAutoFaceStatus(
          "running",
          "cloud-result",
          "cloud",
          "云端人脸位置已返回",
          {
            faceCount: Array.isArray(cloudResult && cloudResult.faces)
              ? cloudResult.faces.length
              : 0,
            provider: cloudResult && cloudResult.provider || "",
            model: cloudResult && cloudResult.model || "",
            timing: cloudResult && cloudResult.timing || null,
            clientDetectMs,
            clientTotalMs: Date.now() - autoFaceStartedAt
          }
        );
      } catch (error) {
        if (error && error.code === "stale-main-image") {
          console.warn("[index] 自动贴脸已取消：主图发生变化");
          wx.showToast({ title: "主图已更换，请重新识别", icon: "none" });
          return;
        }
        const cloudError = safeErrorInfo(error, "云端自动贴脸失败");
        cloudError.clientTotalMs = Date.now() - autoFaceStartedAt;
        console.error("[index] 云端自动贴脸失败", { cloudError });
        this.enterManualFaceCircle(cloudError);
        return;
      } finally {
        wx.hideLoading();
      }

      this.updateProject({ maskCircle: circle, maskFileID: "" });
      this.setData({
        step: 1,
        manualGuideActive: false,
        canvasGestureTip: getCanvasGestureTip(Boolean(this.data.canvasZoomed), false)
      });
      this.drawCanvas(circle);
      this.recordAutoFaceStatus(
        "ready",
        "detect-complete",
        "cloud",
        "云端自动贴脸完成",
        {
          detectComplete: true,
          clientTotalMs: Date.now() - autoFaceStartedAt,
          circle: clone(circle)
        }
      );
      wx.showToast({
        title: "云端贴脸完成",
        icon: "success"
      });
    } catch (error) {
      const unexpectedError = safeErrorInfo(error, "自动贴脸出现异常");
      console.error("[index] 自动贴脸流程异常", { error: unexpectedError });
      this.enterManualFaceCircle(unexpectedError);
    } finally {
      this.setData({ analysisAction: "" });
    }
  },

  async chooseFaceImages() {
    const remaining = Math.max(0, 6 - this.data.project.faceRefs.length);
    if (!remaining) {
      wx.showToast({ title: "最多添加 6 张人脸参考", icon: "none" });
      return;
    }
    await this.appendAssets("faceRefs", Math.min(remaining, 6));
  },

  async chooseWardrobeImages() {
    const remaining = Math.max(0, 12 - this.data.project.wardrobeRefs.length);
    if (!remaining) {
      wx.showToast({ title: "最多添加 12 张穿搭参考", icon: "none" });
      return;
    }
    await this.appendAssets("wardrobeRefs", Math.min(remaining, 12));
  },

  async chooseBackgroundImages() {
    const remaining = Math.max(0, 3 - this.data.project.backgroundRefs.length);
    if (!remaining) {
      wx.showToast({ title: "最多添加 3 张背景参考", icon: "none" });
      return;
    }
    await this.appendAssets("backgroundRefs", Math.min(remaining, 3));
  },

  async appendAssets(field, count) {
    try {
      const result = await chooseImages(count);
      const files = result.tempFiles || [];
      const assets = await Promise.all(files.map(async (file, index) => {
        const prepared = await prepareImageAsset(file, {
          compression: config.imageCompression
        });
        return {
          id: `${field}-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
          name: file.name || basename(file.tempFilePath),
          path: prepared.path,
          type: prepared.type,
          size: prepared.compressedSize || file.size || 0,
          width: prepared.width,
          height: prepared.height,
          originalWidth: prepared.originalWidth,
          originalHeight: prepared.originalHeight,
          originalSize: prepared.originalSize,
          compressedSize: prepared.compressedSize,
          compressed: prepared.compressed,
          compressionChecked: prepared.compressionChecked,
          compressionQuality: prepared.compressionQuality,
          fileID: "",
          isPrimary: field === "faceRefs" && this.data.project.faceRefs.length === 0 && index === 0,
          kind: field === "backgroundRefs" ? "background" : "clothing",
          target: "整套穿搭",
          targetOptions: CLOTHING_TARGETS,
          tags: [],
          note: ""
        };
      }));
      const current = this.data.project[field] || [];
      const project = Object.assign({}, this.data.project, {
        [field]: current.concat(assets)
      });
      this.setData({ project, step: 2 });
      storage.saveProject(project);
    } catch (error) {
      this.showError("参考图选择失败", error);
    }
  },

  removeFace(event) {
    const index = Number(event.currentTarget.dataset.index);
    const faces = this.data.project.faceRefs.slice();
    faces.splice(index, 1);
    if (faces.length && !faces.some((item) => item.isPrimary)) faces[0].isPrimary = true;
    this.updateProject({ faceRefs: faces });
  },

  setPrimaryFace(event) {
    const index = Number(event.currentTarget.dataset.index);
    const faces = this.data.project.faceRefs.map((item, itemIndex) => Object.assign({}, item, {
      isPrimary: itemIndex === index
    }));
    this.updateProject({ faceRefs: faces });
  },

  onFaceNoteInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const faces = this.data.project.faceRefs.slice();
    faces[index] = Object.assign({}, faces[index], { note: event.detail.value });
    this.updateProject({ faceRefs: faces });
  },

  removeWardrobe(event) {
    const index = Number(event.currentTarget.dataset.index);
    const wardrobe = this.data.project.wardrobeRefs.slice();
    wardrobe.splice(index, 1);
    this.updateProject({ wardrobeRefs: wardrobe });
  },

  onWardrobeKindChange(event) {
    const index = Number(event.currentTarget.dataset.index);
    const wardrobe = this.data.project.wardrobeRefs.slice();
    const kind = String(event.currentTarget.dataset.value) === "1" ? "accessory" : "clothing";
    wardrobe[index] = Object.assign({}, wardrobe[index], {
      kind,
      target: kind === "accessory" ? ACCESSORY_TARGETS[0] : CLOTHING_TARGETS[0],
      targetOptions: kind === "accessory" ? ACCESSORY_TARGETS : CLOTHING_TARGETS
    });
    this.updateProject({ wardrobeRefs: wardrobe });
  },

  onWardrobeTargetInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const wardrobe = this.data.project.wardrobeRefs.slice();
    const options = wardrobe[index].kind === "accessory" ? ACCESSORY_TARGETS : CLOTHING_TARGETS;
    const target = options[Number(event.detail.value)] || options[0];
    wardrobe[index] = Object.assign({}, wardrobe[index], { target });
    this.updateProject({ wardrobeRefs: wardrobe });
  },

  onWardrobeNoteInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const wardrobe = this.data.project.wardrobeRefs.slice();
    wardrobe[index] = Object.assign({}, wardrobe[index], { note: event.detail.value });
    this.updateProject({ wardrobeRefs: wardrobe });
  },

  onBackgroundNoteInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const background = this.data.project.backgroundRefs.slice();
    background[index] = Object.assign({}, background[index], {
      note: event.detail.value
    });
    this.updateProject({ backgroundRefs: background });
  },

  removeBackground(event) {
    const index = Number(event.currentTarget.dataset.index);
    const background = this.data.project.backgroundRefs.slice();
    background.splice(index, 1);
    this.updateProject({ backgroundRefs: background });
  },

  onDescriptionInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    const patch = {};
    patch[field] = event.detail.value;
    this.updateProject(patch);
  },

  onCustomLockInput(event) {
    const customLockText = event.detail.value || "";
    const customLockedElements = parseCustomLocks(customLockText);
    const project = this.updateProject({ customLockedElements });
    this.setData({
      customLockText,
      lockedSelectionCount: project.lockedElements.length + customLockedElements.length
    });
  },

  toggleLockPanel() {
    this.setData({ lockPanelOpen: !this.data.lockPanelOpen });
  },

  selectAllLockedElements() {
    const lockedElements = LOCKED_ELEMENTS.slice();
    const project = this.updateProject({ lockedElements });
    this.setData({
      lockedElementOptions: createLockedElementOptions(lockedElements),
      lockedSelectionCount: lockedElements.length + project.customLockedElements.length
    });
  },

  onLockedElementsChange(event) {
    const lockedElements = Array.isArray(event.detail.value) ? event.detail.value : [];
    const project = this.updateProject({ lockedElements });
    this.setData({
      lockedElementOptions: createLockedElementOptions(lockedElements),
      lockedSelectionCount: lockedElements.length + project.customLockedElements.length
    });
  },

  refreshPromptDraft() {
    const prompt = buildPrompt(this.data.project);
    const negativePrompt = buildNegativePrompt(this.data.project);
    return this.updateProject({ promptDraft: prompt, negativePrompt });
  },

  validateStep(step) {
    const project = this.data.project || {};
    const faceRefs = Array.isArray(project.faceRefs) ? project.faceRefs : [];
    if (step === 4) {
      diagnosticLog.info("generation", "validate-step4", "开始检查生图素材", {
        step: "validate",
        hasMainImage: Boolean(project.mainImage),
        hasMaskCircle: Boolean(project.maskCircle),
        faceReferenceCount: faceRefs.length,
        hasMaskFileID: Boolean(String(project.maskFileID || "").trim())
      });
    }
    if (step === 0 && !project.mainImage) return "请先上传主图";
    if (step === 1 && !project.maskCircle) return "请在主图上拖动圈选区域";
    if (step === 2 && !faceRefs.length) return "至少添加 1 张人脸参考图";
    if (step === 4) {
      if (!project.mainImage) return "请先上传主图";
      if (!project.maskCircle) return "请先在主图上圈选区域";
      if (!faceRefs.length) return "至少添加 1 张人脸参考图";
    }
    return "";
  },

  nextStep() {
    const error = this.validateStep(this.data.step);
    if (error) {
      wx.showToast({ title: error, icon: "none" });
      return;
    }
    const next = Math.min(this.data.steps.length - 1, this.data.step + 1);
    if (this.data.step === 3) this.refreshPromptDraft();
    this.setData({ step: next });
  },

  prevStep() {
    this.setData({ step: Math.max(0, this.data.step - 1) });
  },

  jumpToRecords() {
    wx.navigateTo({ url: "/pages/records/records" });
  },

  openRepair(event) {
    const recordId = String(event.currentTarget.dataset.id || "");
    const record = (this.data.generatedResults || []).find(
      (item) => String(item.id) === recordId
    );
    if (!recordId || !record || !record.canRepair) {
      wx.showToast({ title: "这条结果暂时不能进行局部修正", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/repair/repair?recordId=${encodeURIComponent(recordId)}`
    });
  },

  async ensureUploaded(asset, folder, options = {}) {
    if (!asset || (asset.fileID && asset.assetRegistered === true)) return asset;
    let prepared = asset;
    if (asset.path && asset.compressionChecked !== true && options.skipCompression !== true) {
      const isMainImage = folder === "main";
      const prepareKey = this.getMainImageKey(asset);
      let preparePromise;
      if (isMainImage) {
        const currentState = this._mainImagePrepareState;
        if (currentState && currentState.key === prepareKey && currentState.promise) {
          preparePromise = currentState.promise;
        } else {
          const state = { key: prepareKey, promise: null };
          state.promise = prepareImageAsset(asset, {
            compression: config.imageCompression
          }).catch((error) => {
            if (this._mainImagePrepareState === state) this._mainImagePrepareState = null;
            throw error;
          });
          this._mainImagePrepareState = state;
          preparePromise = state.promise;
        }
      } else {
        preparePromise = prepareImageAsset(asset, {
          compression: config.imageCompression
        });
      }
      const compressed = await preparePromise;
      prepared = Object.assign({}, asset, {
        path: compressed.path,
        type: compressed.type || asset.type,
        size: compressed.compressedSize || asset.size || 0,
        width: compressed.width || asset.width,
        height: compressed.height || asset.height,
        originalWidth: compressed.originalWidth || asset.originalWidth || asset.width,
        originalHeight: compressed.originalHeight || asset.originalHeight || asset.height,
        originalSize: compressed.originalSize || asset.originalSize || asset.size || 0,
        compressedSize: compressed.compressedSize || asset.compressedSize || asset.size || 0,
        compressed: compressed.compressed,
        compressionChecked: true,
        compressionQuality: compressed.compressionQuality
      });
      diagnosticLog.info("upload", "image-prepared", "图片压缩检查完成", {
        step: folder,
        filePath: prepared.path,
        originalSize: prepared.originalSize,
        compressedSize: prepared.compressedSize,
        compressed: prepared.compressed,
        width: prepared.width,
        height: prepared.height
      });
    }
    const isMainImage = folder === "main";
    const key = this.getMainImageKey(prepared);
    if (isMainImage && options.reuseMain !== false) {
      const currentState = this._mainImageUploadState;
      if (currentState && currentState.key === key && currentState.promise) {
        return currentState.promise;
      }
      const state = { key, promise: null };
      const upload = typeof cloud.uploadAsset === "function" && assetKindForFolder(folder)
        ? cloud.uploadAsset(prepared.path, assetKindForFolder(folder), {
          fileName: prepared.name || basename(prepared.path),
          contentType: prepared.type || "image/jpeg"
        })
        : cloud.uploadFile(prepared.path, folder);
      state.promise = Promise.resolve(upload)
        .then((upload) => Object.assign({}, prepared, {
          fileID: upload.fileID,
          assetRegistered: Boolean(
            typeof cloud.uploadAsset === "function" && assetKindForFolder(folder)
          )
        }))
        .catch((error) => {
          if (this._mainImageUploadState === state) this._mainImageUploadState = null;
          throw error;
        });
      this._mainImageUploadState = state;
      return state.promise;
    }
    const upload = typeof cloud.uploadAsset === "function" && assetKindForFolder(folder)
      ? await cloud.uploadAsset(prepared.path, assetKindForFolder(folder), {
        fileName: prepared.name || basename(prepared.path),
        contentType: prepared.type || "image/jpeg"
      })
      : await cloud.uploadFile(prepared.path, folder);
    return Object.assign({}, prepared, {
      fileID: upload.fileID,
      assetRegistered: Boolean(
        typeof cloud.uploadAsset === "function" && assetKindForFolder(folder)
      )
    });
  },

  preloadMainImageUpload(image) {
    if (!image || (image.fileID && image.assetRegistered === true) || !cloud.isCloudReady()) return null;
    const key = this.getMainImageKey(image);
    const promise = this.ensureUploaded(image, "main");
    promise.then(
      (uploaded) => {
        if (this._pageDestroyed || !this.isCurrentMainImage(key)) return;
        const current = this.data.project.mainImage;
        if (!current || current.fileID === uploaded.fileID) return;
        this.updateProject({
          mainImage: Object.assign({}, current, uploaded)
        });
      },
      (error) => {
        console.warn("[index] 主图后台上传失败，点击自动贴脸时将重试", {
          message: error && error.message ? error.message : String(error)
        });
      }
    );
    return promise;
  },

  async prepareMaskAsset(project) {
    diagnosticLog.info("upload", "mask-prepare-start", "开始准备红圈遮罩", {
      step: "prepare-mask",
      hasMainImage: Boolean(project && project.mainImage),
      hasMaskCircle: Boolean(project && project.maskCircle),
      hasMaskFileID: Boolean(project && String(project.maskFileID || "").trim()),
      maskFileID: redactAssetID(project && project.maskFileID)
    });
    if (!project || !project.mainImage) {
      const error = createGenerationAssetError("MAIN_IMAGE_MISSING");
      diagnosticLog.warn("upload", "mask-prepare-blocked", "缺少主图，停止准备红圈遮罩", {
        step: "prepare-mask",
        code: error.code,
        error
      });
      throw error;
    }
    if (!project.maskCircle) {
      const error = createGenerationAssetError("MASK_CIRCLE_MISSING");
      diagnosticLog.warn("upload", "mask-prepare-blocked", "缺少红圈，停止准备红圈遮罩", {
        step: "prepare-mask",
        code: error.code,
        error
      });
      throw error;
    }
    const existingMaskFileID = String(project.maskFileID || "").trim();
    if (existingMaskFileID) {
      project.maskFileID = existingMaskFileID;
      diagnosticLog.info("upload", "mask-prepare-reused", "复用当前红圈遮罩", {
        step: "prepare-mask",
        hasMaskFileID: true,
        maskFileID: redactAssetID(existingMaskFileID)
      });
      return project;
    }

    let maskPath;
    try {
      maskPath = await exportMaskFile(
        this,
        project.maskCircle,
        project.mainImage.width,
        project.mainImage.height
      );
      diagnosticLog.info("upload", "mask-export-success", "红圈遮罩导出完成", {
        step: "prepare-mask",
        hasMaskPath: Boolean(maskPath),
        hasMaskCircle: true
      });
      if (!maskPath) {
        throw createGenerationAssetError("MASK_EXPORT_FAILED");
      }
    } catch (cause) {
      const error = cause && cause.code === "MASK_EXPORT_FAILED"
        ? cause
        : createGenerationAssetError("MASK_EXPORT_FAILED", cause);
      diagnosticLog.error("upload", "mask-export-failed", "红圈遮罩导出失败", {
        step: "prepare-mask",
        code: error.code,
        error
      });
      throw error;
    }

    let uploaded;
    try {
      uploaded = await this.ensureUploaded({
        path: maskPath,
        name: `${basename(project.mainImage.path)}-mask.png`,
        type: "image/png",
        width: project.mainImage.width,
        height: project.mainImage.height,
        compressionChecked: true,
        isMask: true
      }, "masks", { skipCompression: true });
    } catch (cause) {
      const error = createGenerationAssetError("MASK_UPLOAD_FAILED", cause);
      diagnosticLog.error("upload", "mask-upload-failed", "红圈遮罩上传失败", {
        step: "prepare-mask",
        code: error.code,
        error
      });
      throw error;
    }
    const maskFileID = String(uploaded && uploaded.fileID || "").trim();
    diagnosticLog.info("upload", "mask-upload-result", "红圈遮罩上传返回", {
      step: "prepare-mask",
      hasUploadedAsset: Boolean(uploaded),
      hasMaskFileID: Boolean(maskFileID),
      maskFileID: redactAssetID(maskFileID)
    });
    if (!maskFileID) {
      const error = createGenerationAssetError("MASK_UPLOAD_FAILED");
      diagnosticLog.error("upload", "mask-upload-empty", "红圈遮罩上传未返回 fileID", {
        step: "prepare-mask",
        code: error.code,
        error
      });
      throw error;
    }
    project.maskFileID = maskFileID;
    diagnosticLog.info("upload", "mask-prepare-success", "红圈遮罩准备完成", {
      step: "prepare-mask",
      hasMaskFileID: true,
      maskFileID: redactAssetID(maskFileID)
    });
    return project;
  },

  async prepareCloudAssets(options = {}) {
    const project = clone(options.project || this.data.project);
    const snapshot = {
      mainImageKey: getStableMainImageKey(project.mainImage),
      maskCircle: serializeMaskCircle(project.maskCircle)
    };
    diagnosticLog.info("upload", "assets-prepare-start", "开始准备云端素材", {
      step: "prepare-assets",
      includeMask: Boolean(options.includeMask),
      hasMainImage: Boolean(project.mainImage),
      hasMaskCircle: Boolean(project.maskCircle),
      hasMaskFileID: Boolean(String(project.maskFileID || "").trim()),
      mainFileID: redactAssetID(project.mainImage && project.mainImage.fileID),
      maskFileID: redactAssetID(project.maskFileID),
      faceReferenceCount: project.faceRefs.length,
      wardrobeReferenceCount: project.wardrobeRefs.length,
      backgroundReferenceCount: project.backgroundRefs.length
    });
    project.mainImage = await this.ensureUploaded(project.mainImage, "main");
    project.faceRefs = await Promise.all(
      project.faceRefs.map((item) => this.ensureUploaded(item, "references/faces"))
    );
    project.wardrobeRefs = await Promise.all(
      project.wardrobeRefs.map((item) => this.ensureUploaded(item, "references/wardrobe"))
    );
    project.backgroundRefs = await Promise.all(
      project.backgroundRefs.map((item) => this.ensureUploaded(item, "references/background"))
    );
    if (options.includeMask) {
      await this.prepareMaskAsset(project);
    }
    const currentProject = this.data.project || {};
    const currentMainImageKey = getStableMainImageKey(currentProject.mainImage);
    const currentMaskCircle = serializeMaskCircle(currentProject.maskCircle);
    if (
      currentMainImageKey !== snapshot.mainImageKey
      || currentMaskCircle !== snapshot.maskCircle
    ) {
      const error = createGenerationAssetError("PROJECT_STATE_CHANGED");
      diagnosticLog.warn("upload", "assets-prepare-stale", "素材准备期间页面状态发生变化", {
        step: "prepare-assets",
        code: error.code,
        snapshotHasMainImage: Boolean(snapshot.mainImageKey),
        currentHasMainImage: Boolean(currentMainImageKey),
        snapshotHasMaskCircle: Boolean(snapshot.maskCircle),
        currentHasMaskCircle: Boolean(currentMaskCircle),
        error
      });
      throw error;
    }
    this.setData({ project });
    storage.saveProject(project);
    diagnosticLog.info("upload", "assets-prepare-success", "云端素材准备完成", {
      step: "prepare-assets",
      includeMask: Boolean(options.includeMask),
      mainUploaded: Boolean(project.mainImage && project.mainImage.fileID),
      maskUploaded: Boolean(project.maskFileID),
      mainFileID: redactAssetID(project.mainImage && project.mainImage.fileID),
      maskFileID: redactAssetID(project.maskFileID),
      faceReferenceCount: project.faceRefs.filter((item) => item.fileID).length,
      wardrobeReferenceCount: project.wardrobeRefs.filter((item) => item.fileID).length,
      backgroundReferenceCount: project.backgroundRefs.filter((item) => item.fileID).length
    });
    return project;
  },

  async analyzeMainImage() {
    if (!this.data.project.mainImage) {
      wx.showToast({ title: "请先上传主图", icon: "none" });
      return;
    }
    if (!this.data.cloudReady) {
      wx.showModal({
        title: "还没连接云端",
        content: "当前是本地预览模式。请在 config.js 填好 CloudBase 环境 ID 后重新编译。",
        showCancel: false
      });
      return;
    }
    if (this.data.analysisAction) {
      wx.showToast({ title: "请等当前分析完成", icon: "none" });
      return;
    }
    this.setData({ analysisAction: "main" });
    diagnosticLog.info("analysis", "main-start", "开始分析主图", {
      step: "main"
    });
    try {
      const project = await this.prepareCloudAssets();
      const result = await cloud.analyzeImage({
        mainFileID: project.mainImage.fileID,
        instruction: "请用中文分析这张图片的场景、背景环境、空间层次、材质颜色、人物姿态、面部朝向、光影和妆容，严格返回 JSON。",
        projectName: project.projectName
      });
      const analysis = result.analysis || {};
      this.updateProject({
        sceneDescription: analysis.sceneDescription || "",
        backgroundDescription: analysis.backgroundDescription || "",
        poseDescription: analysis.poseDescription || "",
        faceDirectionDescription: analysis.faceDirectionDescription || "",
        lightingMakeupDescription: analysis.lightingMakeupDescription || ""
      });
      wx.showToast({ title: "原图分析完成", icon: "success" });
      diagnosticLog.info("analysis", "main-success", "原图分析完成", {
        step: "main"
      });
    } catch (error) {
      diagnosticLog.error("analysis", "main-failed", "原图分析失败", {
        step: "main",
        error
      });
      this.showError("原图分析失败", error);
    } finally {
      this.setData({ analysisAction: "" });
    }
  },

  async analyzeWebPoses() {
    if (!this.data.project.mainImage) {
      wx.showToast({ title: "请先上传主图", icon: "none" });
      return;
    }
    if (!this.data.cloudReady) {
      wx.showModal({
        title: "还没连接云端",
        content: "参考网感分析需要使用 CloudBase 云函数和服务端视觉模型。",
        showCancel: false
      });
      return;
    }
    if (this.data.analysisAction) {
      wx.showToast({ title: "请等当前分析完成", icon: "none" });
      return;
    }
    this.setData({ analysisAction: "webPose" });
    diagnosticLog.info("analysis", "web-pose-start", "开始分析参考网感姿势", {
      step: "webPose"
    });
    try {
      const project = await this.prepareCloudAssets();
      const result = await cloud.analyzeWebPoses({
        mainFileID: project.mainImage.fileID,
        projectName: project.projectName
      });
      const suggestions = normalizeWebPoseSuggestions(result.suggestions);
      if (suggestions.length !== 8) {
        throw new Error("云端没有返回完整的 8 条网感姿势建议。");
      }
      this.updateProject({
        webPoseSuggestions: suggestions,
        selectedWebPose: null,
        webPoseAnalysisMeta: {
          provider: result.provider || "",
          model: result.model || "",
          analyzedAt: result.analyzedAt || new Date().toISOString()
        }
      });
      wx.showToast({ title: "已生成 8 条建议", icon: "success" });
      diagnosticLog.info("analysis", "web-pose-success", "参考网感姿势分析完成", {
        step: "webPose",
        suggestionCount: suggestions.length
      });
    } catch (error) {
      diagnosticLog.error("analysis", "web-pose-failed", "参考网感姿势分析失败", {
        step: "webPose",
        error
      });
      this.showError("参考网感分析失败", error);
    } finally {
      this.setData({ analysisAction: "" });
    }
  },

  selectWebPose(event) {
    const id = Number(event.currentTarget.dataset.id);
    const suggestion = (this.data.project.webPoseSuggestions || []).find((item) => item.id === id);
    if (!suggestion) {
      wx.showToast({ title: "这条建议已经失效", icon: "none" });
      return;
    }
    this.updateProject({ selectedWebPose: Object.assign({}, suggestion) });
    wx.showToast({ title: `已选择第 ${suggestion.id} 条`, icon: "success" });
  },

  async startGenerate() {
    if (this.data.loading) return;
    const error = this.validateStep(4);
    if (error) {
      wx.showToast({ title: error, icon: "none" });
      return;
    }
    if (!this.data.cloudReady) {
      wx.showModal({
        title: "还没连接云端",
        content: "提示词可以本地生成，但真正生图需要 CloudBase 云函数和服务端 API Key。",
        showCancel: false
      });
      return;
    }
    const requestId = createClientRequestId();
    diagnosticLog.info("generation", "submit-start", "开始提交生图任务", {
      step: "prepare",
      requestId,
      retryLimit: GENERATION_RETRY_LIMIT
    });
    this.setData({
      loading: true,
      generationPhaseIndex: 0,
      generationRetryCount: 0,
      generationTimedOut: false,
      generationElapsedSeconds: 0
    });
    this.setGenerationPhase(
      "prepare",
      "正在准备素材...",
      "正在整理图片、红圈和参考素材，预计还需要几秒。"
    );
    this.startGenerationTimer();
    let generationSucceeded = false;
    try {
      const promptProject = this.refreshPromptDraft();
      const generationMode = resolveImageGenerationMode(promptProject);
      this.setGenerationPhase(
        "upload",
        "正在上传素材...",
        "正在上传主图、红圈和参考素材，请稍等。"
      );
      const project = await this.prepareCloudAssets({
        includeMask: generationMode === "edits",
        project: promptProject
      });
      this.setGenerationPhase(
        "generate",
        "AI正在生成图片...",
        "预计需要 20～60 秒，网络较慢时可能更久，请耐心等待。",
        { generationRetryCount: 0 }
      );
      const submittedPrompt = appendWebPosePromptBlock(
        project.promptDraft,
        project.selectedWebPose
      );
      diagnosticLog.info("generation", "submit", "生图任务参数准备完成", {
        step: "generate",
        requestId,
        projectName: project.projectName,
        prompt: submittedPrompt,
        negativePrompt: project.negativePrompt,
        mainImageUploaded: Boolean(project.mainImage && project.mainImage.fileID),
        maskUploaded: Boolean(project.maskFileID),
        faceReferenceCount: project.faceRefs.length,
        wardrobeReferenceCount: project.wardrobeRefs.length,
        backgroundReferenceCount: project.backgroundRefs.length
      });
      const mainFileID = String(project.mainImage && project.mainImage.fileID || "").trim();
      const maskFileID = String(project.maskFileID || "").trim();
      diagnosticLog.info("generation", "asset-gate", "生图前素材硬闸门检查完成", {
        step: "generate",
        requestId,
        generationMode,
        hasMainImage: Boolean(project.mainImage),
        hasMaskCircle: Boolean(project.maskCircle),
        hasMainFileID: Boolean(mainFileID),
        hasMaskFileID: Boolean(maskFileID),
        mainFileID: redactAssetID(mainFileID),
        maskFileID: redactAssetID(maskFileID),
        faceReferenceCount: project.faceRefs.length
      });
      if (!mainFileID) {
        throw createGenerationAssetError("MAIN_FILE_MISSING");
      }
      if (generationMode === "edits" && !maskFileID) {
        throw createGenerationAssetError("MASK_FILE_MISSING");
      }
      diagnosticLog.info("generation", "generate-call", "即将调用 cloud.generateImage", {
        step: "generate",
        requestId,
        generationMode,
        hasMainFileID: true,
        hasMaskFileID: generationMode === "edits" ? true : Boolean(maskFileID),
        mainFileID: redactAssetID(mainFileID),
        maskFileID: redactAssetID(maskFileID),
        faceReferenceCount: project.faceRefs.length
      });
      const result = await cloud.generateImage(
        {
          generationType: "normal",
          mode: generationMode,
          projectName: project.projectName,
          prompt: submittedPrompt,
          negativePrompt: project.negativePrompt,
          mainFileID,
          maskFileID,
          maskGeometry: project.maskCircle || {},
          assetRegistrationVersion: 1,
          faceFileIDs: project.faceRefs.map((item) => item.fileID).filter(Boolean),
          wardrobeFileIDs: project.wardrobeRefs.map((item) => item.fileID).filter(Boolean),
          backgroundFileIDs: project.backgroundRefs.map((item) => item.fileID).filter(Boolean),
          size: "1024x1024"
        },
        {
          requestId,
          maxRetries: GENERATION_RETRY_LIMIT,
          onRetry: ({ attempt, maxRetries }) => {
            diagnosticLog.warn("generation", "retry", "生图请求准备重试", {
              step: "generate",
              requestId,
              attempt,
              maxRetries
            });
            if (this._pageDestroyed || !this.data.loading) return;
            this.setData({
              generationStage: "retry",
              generationPhaseIndex: 2,
              generationRetryCount: attempt,
              generationWaitText: `网络有点慢，正在进行第 ${attempt}/${maxRetries} 次重试，请不要重复点击。`
            });
            this.setData({
              loadingText: `正在重试生成（${attempt}/${maxRetries}）...`
            });
          }
        }
      );
      this.setGenerationPhase(
        "save",
        "正在保存生成结果...",
        "图片已经生成，正在保存到制作记录。"
      );
      const record = decorateRecordForRepair(Object.assign({}, result.record || {}, {
        id: result.recordId || `local-${Date.now()}`,
        fileID: result.fileID || "",
        tempFileURL: result.tempFileURL || "",
        projectName: project.projectName,
        prompt: submittedPrompt,
        createdAt: result.createdAt || new Date().toISOString(),
        generationType: "normal",
        revisionNumber: 0,
        repairContext: Object.assign({
          sourceFileID: result.fileID || "",
          originalMainFileID: project.mainImage && project.mainImage.fileID || "",
          mainInputFileID: project.mainImage && project.mainImage.fileID || "",
          maskFileID: project.maskFileID || "",
          maskGeometry: project.maskCircle || {},
          faceFileIDs: project.faceRefs.map((item) => item.fileID).filter(Boolean),
          wardrobeFileIDs: project.wardrobeRefs.map((item) => item.fileID).filter(Boolean),
          backgroundFileIDs: project.backgroundRefs.map((item) => item.fileID).filter(Boolean)
        }, result.record && result.record.repairContext || {})
      }), this.data.cloudReady);
      const records = [record].concat(this.data.records || []).slice(0, 50);
      const nextProject = Object.assign({}, project, {
        results: [record].concat(project.results || []).slice(0, 20)
      });
      this.setData({
        project: nextProject,
        records,
        generatedResults: nextProject.results,
        step: 4
      });
      generationSucceeded = true;
      storage.saveProject(nextProject);
      storage.saveRecords(records);
      wx.showToast({ title: "生成完成", icon: "success" });
      diagnosticLog.info("generation", "success", "生图完成并保存记录", {
        step: "save",
        requestId,
        recordId: record.id,
        fileID: record.fileID
      });
    } catch (error) {
      diagnosticLog.error("generation", "failed", "生图流程失败", {
        step: "generate",
        requestId,
        error
      });
      this.showError("生图失败", error);
    } finally {
      this.stopGenerationTimer();
      this.setData({
        loading: false,
        loadingText: "",
        generationStage: "idle",
        generationPhaseIndex: 0,
        generationWaitText: "",
        generationElapsedSeconds: 0,
        generationRetryCount: 0,
        generationTimedOut: false
      });
    }
  },

  async loadRecords() {
    const localRecords = (storage.loadRecords() || [])
      .map((record) => decorateRecordForRepair(record, this.data.cloudReady));
    diagnosticLog.info("records", "load-start", "开始读取制作记录", {
      localCount: localRecords.length
    });
    if (cloud.isCloudReady()) {
      try {
        const result = await cloud.listRecords();
        const remoteRecords = ((result && result.records) || [])
          .map((record) => decorateRecordForRepair(record, this.data.cloudReady));
        const records = remoteRecords.length ? remoteRecords : localRecords;
        this.setData({ records });
        if (remoteRecords.length) {
          storage.saveRecords(remoteRecords);
        } else if (localRecords.length) {
          console.warn("云端记录为空，保留本地制作记录", localRecords.length);
          diagnosticLog.warn("records", "cloud-empty", "云端记录为空，保留本地记录", {
            localCount: localRecords.length
          });
        }
        diagnosticLog.info("records", "load-success", "制作记录读取完成", {
          remoteCount: remoteRecords.length,
          localCount: localRecords.length,
          selectedCount: records.length
        });
        return;
      } catch (error) {
        console.warn("云端记录读取失败，回退本地记录", error);
        diagnosticLog.warn("records", "load-fallback", "云端记录读取失败，回退本地记录", {
          localCount: localRecords.length,
          error
        });
      }
    }
    this.setData({ records: localRecords });
    diagnosticLog.info("records", "load-local", "使用本地制作记录", {
      localCount: localRecords.length
    });
  },

  previewImage(event) {
    const url = event.currentTarget.dataset.url;
    if (!url) return;
    this.setData({
      imagePreviewVisible: true,
      imagePreviewPath: url,
      imagePreviewTitle: "生成结果"
    });
  },

  closeImagePreview() {
    this.setData({ imagePreviewVisible: false });
  },

  onImagePreviewError() {
    this.setData({ imagePreviewVisible: false });
    wx.showToast({ title: "图片加载失败，请重试", icon: "none" });
  },

  showError(title, error) {
    const payload = error && error.payload;
    const message = getGenerationErrorMessage(error, "请稍后重试");
    const requestId = payload && payload.requestId;
    diagnosticLog.error("page", "operation-failed", title, {
      requestId,
      error,
      message
    });
    wx.showModal({
      title,
      content: `${String(message)}${requestId ? `\n请求编号：${requestId}` : ""}`,
      showCancel: false
    });
  },

  onShareAppMessage() {
    return {
      title: "圈像创作",
      path: "/pages/index/index"
    };
  }
});
