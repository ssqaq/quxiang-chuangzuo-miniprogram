const config = require("../../config");
const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");

function emptyForm() {
  return {
    face: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      model: "",
      timeoutMs: "30000"
    },
    analysis: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      model: "",
      timeoutMs: "30000"
    },
    image: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      model: "",
      mode: "generations",
      size: "1024x1024",
      timeoutMs: "90000",
      maxRetries: "2",
      retryEnabled: false
    },
    video: {
      provider: "",
      baseUrl: "",
      endpoint: "",
      queryEndpoint: "",
      model: "",
      createPath: "/v1/videos/generations",
      queryPath: "/v1/videos/{taskId}",
      resolution: "720p",
      aspectRatio: "",
      timeoutMs: "90000"
    },
    points: {
      dailyFreeLimit: "3",
      imageCost: "10",
      videoCost: "10",
      checkinPoints: "5",
      streakBonus: "20",
      streakDays: "7",
      promoStartDate: "2026-08-24",
      promoEndDate: "2026-08-25",
      timeZone: "Asia/Shanghai"
    },
    costs: {
      faceInputPerMillionTokens: "0.15",
      faceOutputPerMillionTokens: "1.5",
      image1K: "0.015",
      image2K: "0.025",
      image4K: "0.035",
      video480p: "0.2",
      video720p: "0.3",
      video1080p: "1.8",
      videoDefaultDuration: "3"
    }
  };
}

const USAGE_TYPE_META = [
  { key: "face", title: "人脸识别", icon: "脸" },
  { key: "analysis", title: "图片分析", icon: "图" },
  { key: "image", title: "生图模型", icon: "生" },
  { key: "video", title: "视频模型", icon: "视" }
];

// 控制台首页只展示到小数点后 4 位，底层统计金额仍保留原值。
function formatCostDisplay(value) {
  const amount = Math.max(0, Number(value) || 0);
  const truncated = Math.floor(amount * 10000) / 10000;
  return truncated.toFixed(4).replace(/\.?(0+)$/, "");
}

const CONFIG_SECTION_TITLES = Object.freeze({
  face: "人脸识别模型",
  analysis: "图片分析模型",
  image: "生图模型",
  video: "视频模型",
  points: "签到与积分规则",
  costs: "模型成本配置",
  users: "用户统计"
});

function emptyDashboardStatus() {
  return {
    tone: "neutral",
    title: "等待检查",
    probeDurationText: "未检查"
  };
}

function emptyFaceConfigSummary() {
  return {
    provider: "未读取",
    model: "未读取",
    ready: false
  };
}

function emptyUsageCounter() {
  return {
    total: 0,
    success: 0,
    failure: 0,
    estimatedCost: 0,
    estimatedCostDisplay: "0",
    pricedCost: 0,
    unavailableCostCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    videoDurationSeconds: 0,
    imageResolutions: {
      "1K": { count: 0, cost: 0 },
      "2K": { count: 0, cost: 0 },
      "4K": { count: 0, cost: 0 }
    },
    videoResolutions: {
      "480p": { seconds: 0, cost: 0 },
      "720p": { seconds: 0, cost: 0 },
      "1080p": { seconds: 0, cost: 0 }
    }
  };
}

function emptyFailureStats() {
  return {
    total: 0,
    failureRate: 0,
    topFailureReasons: [],
    failedModels: [],
    failureDetails: []
  };
}

function emptyUsageStats() {
  return {
    timeZone: "Asia/Shanghai",
    days: 30,
    todayKey: "",
    today: emptyUsageCounter(),
    last7d: emptyUsageCounter(),
    last30d: emptyUsageCounter(),
    summary: {
      image: emptyUsageCounter(),
      analysis: emptyUsageCounter(),
      face: emptyUsageCounter(),
      video: emptyUsageCounter()
    },
    cards: USAGE_TYPE_META.map((item) => ({
      key: item.key,
      title: item.title,
      icon: item.icon,
      total: 0,
      success: 0,
      failure: 0,
      modelText: "暂无调用"
    })),
    daily: [],
    monthly: [],
    users: [],
    models: [],
    failureStats: emptyFailureStats(),
    pricing: null,
    unavailable: false,
    message: ""
  };
}

function emptyAutoFaceFailureStats() {
  return {
    timeZone: "Asia/Shanghai",
    todayKey: "",
    today: 0,
    last7d: 0,
    total30d: 0,
    byType: [],
    probeSummary: {
      total: 0,
      ok: 0,
      failed: 0,
      pending: 0,
      notRun: 0,
      visionConfigured: 0,
      visionUnavailable: 0,
      versions: []
    },
    recent: [],
    eventCount: 0,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function emptyAutoFaceProbe() {
  return {
    available: false,
    status: "not-run",
    statusText: "尚未检查",
    buildVersion: "",
    buildMarker: "",
    nodeVersion: "",
    cloudEnvConfigured: false,
    visionConfigured: false,
    provider: "",
    model: "",
    durationMs: 0,
    durationText: "未知",
    serverDurationMs: 0,
    serverDurationText: "未知",
    checkedAtText: "未知时间",
    errorCode: "",
    message: ""
  };
}

function emptyAutoFaceProbeHistory() {
  return {
    history: [],
    retentionDays: 30,
    truncated: false,
    unavailable: false,
    message: ""
  };
}

function emptyUserStats() {
  return {
    total: 0,
    maleCount: 0,
    femaleCount: 0,
    maleRatio: 0,
    femaleRatio: 0,
    users: [],
    nextOffset: null,
    unavailable: false,
    message: ""
  };
}

function emptyCostTrend() {
  return {
    days: [],
    totalCost: 0,
    hasCost: false
  };
}

function buildTodayFailureText(usageStats, moduleStates) {
  const state = moduleStates && moduleStates.usage;
  if (state && state.status === "loading") return "读取中";
  if (state && state.status === "failed") return "读取失败";
  const usage = usageStats || emptyUsageStats();
  const today = usage.today || emptyUsageCounter();
  return `${Number(today.failure) || 0} 个失败`;
}

const ADMIN_MODULE_KEYS = [
  "usage",
  "users",
  "autoFaceFailure",
  "probeHistory",
  "logs"
];

function moduleStateLabel(status) {
  if (status === "loading") return "读取中";
  if (status === "ready") return "已读取";
  if (status === "failed") return "读取失败";
  return "未读取";
}

function createModuleState(status = "idle", hasData = false, message = "") {
  return {
    status,
    label: moduleStateLabel(status),
    hasData: Boolean(hasData),
    message: message || ""
  };
}

function emptyAdminModuleStates(status = "idle") {
  return ADMIN_MODULE_KEYS.reduce((result, key) => {
    result[key] = createModuleState(status);
    return result;
  }, {});
}

function loadingAdminModuleStates(previous = {}) {
  return ADMIN_MODULE_KEYS.reduce((result, key) => {
    const previousState = previous[key] || {};
    result[key] = createModuleState(
      "loading",
      Boolean(previousState.hasData),
      previousState.message || ""
    );
    return result;
  }, {});
}

function updateAdminModuleState(states, key, status, hasData, message = "") {
  const previous = states && states[key] ? states[key] : createModuleState();
  return Object.assign({}, states || {}, {
    [key]: createModuleState(
      status,
      hasData === undefined ? previous.hasData : hasData,
      message
    )
  });
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`${label}超过${Math.round(timeoutMs / 1000)}秒未返回`);
      error.code = "ADMIN_LOAD_TIMEOUT";
      reject(error);
    }, timeoutMs);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function formatAdminDate(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "未知时间";
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} `
    + `${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`;
}

function formatAutoFaceFailureStats(result) {
  const source = result || {};
  const probeSource = source.probeSummary || {};
  const probeSummary = Object.assign(emptyAutoFaceFailureStats().probeSummary, {
    total: Number(probeSource.total) || 0,
    ok: Number(probeSource.ok) || 0,
    failed: Number(probeSource.failed) || 0,
    pending: Number(probeSource.pending) || 0,
    notRun: Number(probeSource.notRun) || 0,
    visionConfigured: Number(probeSource.visionConfigured) || 0,
    visionUnavailable: Number(probeSource.visionUnavailable) || 0,
    versions: (Array.isArray(probeSource.versions) ? probeSource.versions : []).map((item) => ({
      buildVersion: item.buildVersion || "未知版本",
      buildMarker: item.buildMarker || "",
      count: Number(item.count) || 0
    }))
  });
  probeSummary.versionText = probeSummary.versions.length
    ? probeSummary.versions
      .map((item) => `${item.buildVersion}${item.count > 1 ? ` (${item.count})` : ""}`)
      .join("、")
    : "暂无";
  return Object.assign(emptyAutoFaceFailureStats(), source, {
    today: Number(source.today) || 0,
    last7d: Number(source.last7d) || 0,
    total30d: Number(source.total30d) || 0,
    eventCount: Number(source.eventCount) || 0,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    probeSummary,
    byType: (Array.isArray(source.byType) ? source.byType : []).map((item) => ({
      type: item.type || "unknown",
      label: item.label || "其他失败",
      count: Number(item.count) || 0,
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    recent: (Array.isArray(source.recent) ? source.recent : []).map((item) => ({
      requestId: item.requestId || "",
      failureType: item.failureType || "unknown",
      failureTypeLabel: item.failureTypeLabel || item.failureType || "其他失败",
      errorCode: item.errorCode || "unknown",
      message: item.message || "未提供错误摘要",
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable),
      stage: item.stage || "",
      durationMs: Number(item.durationMs) || 0,
      appVersion: item.appVersion || "unknown",
      probeStatus: item.probe && item.probe.status || "not-run",
      probeBuildVersion: item.probe && item.probe.buildVersion || "",
      probeBuildMarker: item.probe && item.probe.buildMarker || "",
      probeVisionConfigured: Boolean(item.probe && item.probe.visionConfigured),
      probeProvider: item.probe && item.probe.provider || "",
      probeModel: item.probe && item.probe.model || "",
      probeSummaryText: formatProbeSummaryText(item.probe),
      createdAtText: formatAdminDate(item.createdAt)
    }))
  });
}

function formatProbeSummaryText(probe = {}) {
  const source = probe || {};
  if (source.status === "ok") {
    const version = source.buildVersion || "未知版本";
    return `探针正常 · ${version} · 视觉配置${source.visionConfigured ? "已就绪" : "未就绪"}`;
  }
  if (source.status === "failed") {
    return `探针失败${source.errorCode ? ` · ${source.errorCode}` : ""}`;
  }
  if (source.status === "pending") return "探针当时仍在返回";
  return "探针未返回";
}

function formatAutoFaceProbe(result, error = null) {
  const source = result || {};
  const failed = Boolean(error) || source.ok === false;
  const vision = source.vision || {};
  const runtime = source.runtime || {};
  const hasClientDuration = Number.isFinite(Number(source.clientDurationMs));
  const hasServerDuration = Number.isFinite(Number(source.durationMs));
  const clientDurationMs = hasClientDuration
    ? Math.max(0, Number(source.clientDurationMs))
    : hasServerDuration
      ? Math.max(0, Number(source.durationMs))
      : 0;
  const serverDurationMs = hasServerDuration
    ? Math.max(0, Number(source.durationMs))
    : 0;
  const probe = Object.assign(emptyAutoFaceProbe(), {
    available: !failed,
    status: failed ? "failed" : "ok",
    statusText: failed
      ? `探针失败${error && error.code ? `：${error.code}` : ""}`
      : "探针正常",
    buildVersion: source.buildVersion || "",
    buildMarker: source.buildMarker || "",
    nodeVersion: runtime.nodeVersion || "",
    cloudEnvConfigured: Boolean(runtime.cloudEnvConfigured),
    visionConfigured: Boolean(vision.configured),
    provider: vision.provider || "",
    model: vision.model || "",
    durationMs: clientDurationMs,
    durationText: failed && !hasClientDuration && !hasServerDuration
      ? "未知"
      : `${clientDurationMs} 毫秒`,
    serverDurationMs,
    serverDurationText: hasServerDuration ? `${serverDurationMs} 毫秒` : "未知",
    checkedAtText: source.checkedAt ? formatAdminDate(source.checkedAt) : formatAdminDate(new Date()),
    errorCode: error && (error.code || error.errCode) || "",
    message: error && error.message || ""
  });
  return probe;
}

function formatAutoFaceProbeHistory(result) {
  const source = result || {};
  const history = Array.isArray(source.history) ? source.history : [];
  return Object.assign(emptyAutoFaceProbeHistory(), {
    retentionDays: Number(source.retentionDays) || 30,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    message: source.message || "",
    history: history.map((item) => ({
      status: item.status === "ok" ? "ok" : "failed",
      statusText: item.status === "ok" ? "探针正常" : "探针失败",
      buildVersion: item.buildVersion || "未知版本",
      buildMarker: item.buildMarker || "",
      nodeVersion: item.nodeVersion || "",
      visionConfigured: Boolean(item.visionConfigured),
      provider: item.provider || "未知",
      model: item.model || "未知",
      durationMs: Number(item.durationMs) || 0,
      durationText: `云函数 ${Number(item.durationMs) || 0} 毫秒`,
      errorCode: item.errorCode || "",
      checkedAt: item.checkedAt || "",
      checkedAtText: item.checkedAt ? formatAdminDate(item.checkedAt) : "未知时间"
    }))
  });
}

function buildDashboardStatus(
  effective,
  usageStats,
  autoFaceProbe,
  autoFaceProbeHistory
) {
  const face = effective && effective.face || {};
  const analysis = effective && effective.analysis || {};
  const image = effective && effective.image || {};
  const video = effective && effective.video || {};
  const configReady = Boolean(
    face.apiKeyConfigured
    && face.provider
    && face.model
    && analysis.apiKeyConfigured
    && analysis.provider
    && analysis.model
    && image.apiKeyConfigured
    && image.provider
    && image.model
    && video.apiKeyConfigured
    && video.provider
    && video.model
  );
  const currentProbe = autoFaceProbe || emptyAutoFaceProbe();
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestHistory = history[0] || null;
  const probeStatus = currentProbe.status && currentProbe.status !== "not-run"
    ? currentProbe.status
    : latestHistory
      ? latestHistory.status
      : "not-run";
  const probeDurationText = currentProbe.status && currentProbe.status !== "not-run"
    && currentProbe.durationText
    && currentProbe.durationText !== "未知"
    ? currentProbe.durationText
    : latestHistory && latestHistory.durationText
      ? latestHistory.durationText.replace(/^云函数\s*/, "")
      : "未检查";
  const todayFailure = Number(
    usageStats && usageStats.today && usageStats.today.failure
  ) || 0;

  if (!configReady) {
    return {
      tone: "warn",
      title: "配置未完成",
      probeDurationText
    };
  }
  if (probeStatus === "failed") {
    return {
      tone: "warn",
      title: "探针异常",
      probeDurationText
    };
  }
  if (probeStatus === "ok") {
    return {
      tone: todayFailure > 0 ? "warn" : "ok",
      title: todayFailure > 0 ? "运行正常，有失败" : "全部正常",
      probeDurationText
    };
  }
  return {
    tone: "neutral",
    title: "配置已就绪",
    probeDurationText
  };
}

function buildFaceConfigSummary(
  effective,
  autoFaceProbe,
  autoFaceProbeHistory
) {
  const face = effective && effective.face || {};
  const currentProbe = autoFaceProbe || {};
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestHistory = history[0] || {};
  const provider = face.provider
    || currentProbe.provider
    || latestHistory.provider
    || "未读取";
  const model = face.model
    || currentProbe.model
    || latestHistory.model
    || "未读取";
  const ready = Boolean(
    face.apiKeyConfigured
    || currentProbe.visionConfigured
    || latestHistory.visionConfigured
  );
  return {
    provider,
    model,
    ready
  };
}

function emptyAnalysisConfigSummary() {
  return {
    provider: "未读取",
    model: "未读取",
    ready: false
  };
}

function buildAnalysisConfigSummary(effective) {
  const analysis = effective && effective.analysis || {};
  return {
    provider: analysis.provider || "未读取",
    model: analysis.model || "未读取",
    ready: Boolean(
      analysis.apiKeyConfigured
      && analysis.provider
      && analysis.model
    )
  };
}

function formatUsageStats(result) {
  const source = result || {};
  const summary = source.summary || {};
  const models = Array.isArray(source.models) ? source.models : [];
  const cards = USAGE_TYPE_META.map((meta) => {
    const counter = summary[meta.key] || emptyUsageCounter();
    const modelText = models
      .filter((item) => item.usageType === meta.key)
      .map((item) => {
        const provider = item.provider || "未知 Provider";
        const model = item.model || "未知模型";
        return `${provider} / ${model}`;
      })
      .filter((item, index, list) => list.indexOf(item) === index)
      .join("、") || "暂无调用";
    return Object.assign({}, meta, counter, { modelText });
  });
  const daily = (Array.isArray(source.daily) ? source.daily : []).map((item) => ({
    dateKey: item.dateKey,
    dateLabel: item.dateKey === source.todayKey ? `${item.dateKey} 今天` : item.dateKey,
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    image: Object.assign(emptyUsageCounter(), item.image || {}),
    analysis: Object.assign(emptyUsageCounter(), item.analysis || {}),
    face: Object.assign(emptyUsageCounter(), item.face || {}),
    video: Object.assign(emptyUsageCounter(), item.video || {})
  }));
  const monthly = (Array.isArray(source.monthly) ? source.monthly : []).map((item) => ({
    monthKey: item.monthKey || "",
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    image: Object.assign(emptyUsageCounter(), item.image || {}),
    analysis: Object.assign(emptyUsageCounter(), item.analysis || {}),
    face: Object.assign(emptyUsageCounter(), item.face || {}),
    video: Object.assign(emptyUsageCounter(), item.video || {})
  }));
  const users = (Array.isArray(source.users) ? source.users : []).map((item) => ({
    userHash: item.userHash || "anonymous",
    total: Number(item.total) || 0,
    success: Number(item.success) || 0,
    failure: Number(item.failure) || 0,
    estimatedCost: Number(item.estimatedCost) || 0,
    pricedCost: Number(item.pricedCost) || 0,
    unavailableCostCount: Number(item.unavailableCostCount) || 0,
    inputTokens: Number(item.inputTokens) || 0,
    outputTokens: Number(item.outputTokens) || 0,
    totalTokens: Number(item.totalTokens) || 0,
    videoDurationSeconds: Number(item.videoDurationSeconds) || 0,
    byType: item.byType || {}
  }));
  const failureSource = source.failureStats || {};
  const failureStats = Object.assign(emptyFailureStats(), {
    total: Number(failureSource.total) || 0,
    failureRate: Number(failureSource.failureRate) || 0,
    topFailureReasons: (Array.isArray(failureSource.topFailureReasons)
      ? failureSource.topFailureReasons
      : []
    ).map((item) => ({
      key: item.key || "",
      code: item.code || "",
      label: item.label || "未提供错误原因",
      count: Number(item.count) || 0,
      rate: Number(item.rate) || 0,
      lastSeen: item.lastSeen || "",
      usageType: item.usageType || "",
      provider: item.provider || "",
      model: item.model || "",
      status: Number(item.status) || 0,
      retryable: Boolean(item.retryable)
    })),
    failedModels: (Array.isArray(failureSource.failedModels)
      ? failureSource.failedModels
      : []
    ).map((item) => ({
      usageType: item.usageType || "",
      provider: item.provider || "未知 Provider",
      model: item.model || "未知模型",
      total: Number(item.total) || 0,
      failure: Number(item.failure) || 0,
      failureRate: Number(item.failureRate) || 0
    })),
    failureDetails: (Array.isArray(failureSource.failureDetails)
      ? failureSource.failureDetails
      : []
    ).map((item) => ({
      createdAtText: formatAdminDate(item.createdAt || item.dateKey),
      usageType: item.usageType || "unknown",
      provider: item.provider || "未知 Provider",
      model: item.model || "未知模型",
      requestId: item.requestId || "",
      errorCode: item.errorCode || "unknown",
      errorMessage: String(item.errorMessage || "未提供错误摘要").slice(0, 500),
      errorStatus: Number(item.errorStatus) || 0,
      retryable: Boolean(item.retryable),
      attempt: Math.max(1, Number(item.attempt) || 1),
      durationMs: Math.max(0, Number(item.durationMs) || 0)
    }))
  });
  return Object.assign(emptyUsageStats(), source, {
    today: Object.assign(emptyUsageCounter(), source.today || {}, {
      estimatedCostDisplay: formatCostDisplay(source.today && source.today.estimatedCost)
    }),
    last7d: Object.assign(emptyUsageCounter(), source.last7d || {}),
    last30d: Object.assign(emptyUsageCounter(), source.last30d || {}),
    cards,
    daily,
    monthly,
    users,
    failureStats
  });
}

function formatUserStats(result, previousUsers = []) {
  const source = result || {};
  const incoming = (Array.isArray(source.users) ? source.users : []).map((item) => ({
    userHash: item.userHash || "anonymous",
    nickname: item.nickname || "未填写昵称",
    avatarUrl: item.avatarUrl || item.avatarFileID || "",
    gender: item.gender === "female" ? "female" : "male",
    genderText: item.gender === "female" ? "女" : "男",
    createdAtText: formatAdminDate(item.createdAt)
  }));
  const users = Number(source.offset) > 0
    ? previousUsers.concat(incoming).filter((item, index, list) => (
      list.findIndex((candidate) => candidate.userHash === item.userHash) === index
    ))
    : incoming;
  return Object.assign(emptyUserStats(), {
    total: Number(source.total) || 0,
    maleCount: Number(source.maleCount) || 0,
    femaleCount: Number(source.femaleCount) || 0,
    maleRatio: Number(source.maleRatio) || 0,
    femaleRatio: Number(source.femaleRatio) || 0,
    users,
    nextOffset: source.nextOffset === null || source.nextOffset === undefined
      ? null
      : Math.max(0, Number(source.nextOffset) || 0)
  });
}

function dateKeyShift(dateKey, offset) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const source = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : new Date();
  source.setUTCDate(source.getUTCDate() + Number(offset || 0));
  return source.toISOString().slice(0, 10);
}

function buildCostTrend(usageStats) {
  const source = usageStats || emptyUsageStats();
  const todayKey = source.todayKey || new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const costByDate = {};
  (Array.isArray(source.daily) ? source.daily : []).forEach((item) => {
    costByDate[item.dateKey] = Math.max(0, Number(item.estimatedCost) || 0);
  });
  const days = [];
  for (let index = -6; index <= 0; index += 1) {
    const dateKey = dateKeyShift(todayKey, index);
    days.push({
      dateKey,
      label: dateKey.slice(5),
      cost: Math.round((costByDate[dateKey] || 0) * 10000) / 10000
    });
  }
  const maxCost = Math.max(0, ...days.map((item) => item.cost));
  const normalizedDays = days.map((item) => Object.assign({}, item, {
    barPercent: maxCost ? Math.round(item.cost / maxCost * 100) : 0
  }));
  const totalCost = Math.round(
    normalizedDays.reduce((total, item) => total + item.cost, 0) * 10000
  ) / 10000;
  return {
    days: normalizedDays,
    totalCost,
    hasCost: totalCost > 0
  };
}

function buildEntryHealth(
  effective,
  usageStats,
  autoFaceProbe,
  autoFaceProbeHistory,
  autoFaceFailureStats,
  userStats,
  moduleStates
) {
  const configs = effective || {};
  const usage = usageStats || emptyUsageStats();
  const today = usage.today || emptyUsageCounter();
  const states = moduleStates || emptyAdminModuleStates("ready");
  const currentProbe = autoFaceProbe || emptyAutoFaceProbe();
  const history = autoFaceProbeHistory && Array.isArray(autoFaceProbeHistory.history)
    ? autoFaceProbeHistory.history
    : [];
  const latestProbeStatus = currentProbe.status && currentProbe.status !== "not-run"
    ? currentProbe.status
    : history[0] && history[0].status || "not-run";
  const configReady = (section) => {
    const value = configs[section] || {};
    return Boolean(value.apiKeyConfigured && value.provider && value.model);
  };
  const failureFor = (section) => Number(today[section] && today[section].failure) || 0;
  const stateLabel = (key, normalLabel = "正常") => {
    const state = states[key] || createModuleState("ready", true);
    if (state.status === "loading") return "读取中";
    if (state.status === "failed") return "读取失败";
    return normalLabel;
  };
  const faceAbnormal = !configReady("face")
    || latestProbeStatus === "failed"
    || failureFor("face") > 0
    || Number(autoFaceFailureStats && autoFaceFailureStats.today) > 0;
  return {
    face: {
      abnormal: faceAbnormal,
      label: faceAbnormal ? "异常" : "正常"
    },
    analysis: {
      abnormal: !configReady("analysis") || failureFor("analysis") > 0,
      label: !configReady("analysis") || failureFor("analysis") > 0 ? "异常" : "正常"
    },
    image: {
      abnormal: !configReady("image") || failureFor("image") > 0,
      label: !configReady("image") || failureFor("image") > 0 ? "异常" : "正常"
    },
    video: {
      abnormal: !configReady("video") || failureFor("video") > 0,
      label: !configReady("video") || failureFor("video") > 0 ? "异常" : "正常"
    },
    points: { abnormal: false, label: "正常" },
    costs: {
      abnormal: (states.usage && states.usage.status === "failed")
        || Boolean(usage.unavailable),
      label: stateLabel("usage")
    },
    users: {
      abnormal: (states.users && states.users.status === "failed")
        || Boolean(userStats && userStats.unavailable),
      label: stateLabel("users")
    }
  };
}

function formFromConfig(result) {
  const source = result && result.effective ? result.effective : {};
  const face = source.face || {};
  const analysis = source.analysis || {};
  const image = source.image || {};
  const video = source.video || {};
  const points = source.points || {};
  const costs = source.costs || {};
  const faceCosts = costs.face || {};
  const imageCosts = costs.image || {};
  const videoCosts = costs.video || {};
  return {
    face: {
      provider: face.provider || "",
      baseUrl: face.baseUrl || "",
      endpoint: face.endpoint || "",
      model: face.model || "",
      timeoutMs: String(face.timeoutMs || 30000)
    },
    analysis: {
      provider: analysis.provider || "",
      baseUrl: analysis.baseUrl || "",
      endpoint: analysis.endpoint || "",
      model: analysis.model || "",
      timeoutMs: String(analysis.timeoutMs || 30000)
    },
    image: {
      provider: image.provider || "",
      baseUrl: image.baseUrl || "",
      endpoint: image.endpoint || "",
      model: image.model || "",
      mode: image.mode || "generations",
      size: image.size || "1024x1024",
      timeoutMs: String(image.timeoutMs || 90000),
      maxRetries: String(image.maxRetries || 0),
      retryEnabled: Boolean(image.retryEnabled)
    },
    video: {
      provider: video.provider || "",
      baseUrl: video.baseUrl || "",
      endpoint: video.endpoint || "",
      queryEndpoint: video.queryEndpoint || "",
      model: video.model || "",
      createPath: video.createPath || "/v1/videos/generations",
      queryPath: video.queryPath || "/v1/videos/{taskId}",
      resolution: video.resolution || "720p",
      aspectRatio: video.aspectRatio || "",
      timeoutMs: String(video.timeoutMs || 90000)
    },
    points: {
      dailyFreeLimit: String(points.dailyFreeLimit || 3),
      imageCost: String(points.imageCost || 10),
      videoCost: String(points.videoCost || 10),
      checkinPoints: String(points.checkinPoints || 5),
      streakBonus: String(points.streakBonus || 20),
      streakDays: String(points.streakDays || 7),
      promoStartDate: points.promoStartDate || "2026-08-23",
      promoEndDate: points.promoEndDate || "2026-08-24",
      timeZone: points.timeZone || "Asia/Shanghai"
    },
    costs: {
      faceInputPerMillionTokens: String(faceCosts.inputPerMillionTokens || 0.15),
      faceOutputPerMillionTokens: String(faceCosts.outputPerMillionTokens || 1.5),
      image1K: String(imageCosts.perImage && imageCosts.perImage["1K"] || 0.015),
      image2K: String(imageCosts.perImage && imageCosts.perImage["2K"] || 0.025),
      image4K: String(imageCosts.perImage && imageCosts.perImage["4K"] || 0.035),
      video480p: String(videoCosts.perSecond && videoCosts.perSecond["480p"] || 0.2),
      video720p: String(videoCosts.perSecond && videoCosts.perSecond["720p"] || 0.3),
      video1080p: String(videoCosts.perSecond && videoCosts.perSecond["1080p"] || 1.8),
      videoDefaultDuration: String(videoCosts.defaultDurationSeconds || 3)
    }
  };
}

function formToConfig(form) {
  return {
    face: {
      provider: String(form.face.provider || "").trim(),
      baseUrl: String(form.face.baseUrl || "").trim(),
      endpoint: String(form.face.endpoint || "").trim(),
      model: String(form.face.model || "").trim(),
      timeoutMs: Number(form.face.timeoutMs || 0)
    },
    analysis: {
      provider: String(form.analysis.provider || "").trim(),
      baseUrl: String(form.analysis.baseUrl || "").trim(),
      endpoint: String(form.analysis.endpoint || "").trim(),
      model: String(form.analysis.model || "").trim(),
      timeoutMs: Number(form.analysis.timeoutMs || 0)
    },
    image: {
      provider: String(form.image.provider || "").trim(),
      baseUrl: String(form.image.baseUrl || "").trim(),
      endpoint: String(form.image.endpoint || "").trim(),
      model: String(form.image.model || "").trim(),
      mode: String(form.image.mode || "").trim().toLowerCase(),
      size: String(form.image.size || "").trim(),
      timeoutMs: Number(form.image.timeoutMs || 0),
      maxRetries: Number(form.image.maxRetries || 0),
      retryEnabled: Boolean(form.image.retryEnabled)
    },
    video: {
      provider: String(form.video.provider || "").trim(),
      baseUrl: String(form.video.baseUrl || "").trim(),
      endpoint: String(form.video.endpoint || "").trim(),
      queryEndpoint: String(form.video.queryEndpoint || "").trim(),
      model: String(form.video.model || "").trim(),
      createPath: String(form.video.createPath || "").trim(),
      queryPath: String(form.video.queryPath || "").trim(),
      resolution: String(form.video.resolution || "").trim(),
      aspectRatio: String(form.video.aspectRatio || "").trim(),
      timeoutMs: Number(form.video.timeoutMs || 0)
    },
    points: {
      dailyFreeLimit: Number(form.points.dailyFreeLimit || 0),
      imageCost: Number(form.points.imageCost || 0),
      videoCost: Number(form.points.videoCost || 0),
      checkinPoints: Number(form.points.checkinPoints || 0),
      streakBonus: Number(form.points.streakBonus || 0),
      streakDays: Number(form.points.streakDays || 0),
      promoStartDate: String(form.points.promoStartDate || "").trim(),
      promoEndDate: String(form.points.promoEndDate || "").trim(),
      timeZone: String(form.points.timeZone || "Asia/Shanghai").trim()
    },
    costs: {
      currency: "CNY",
      face: {
        inputPerMillionTokens: Number(form.costs.faceInputPerMillionTokens || 0),
        outputPerMillionTokens: Number(form.costs.faceOutputPerMillionTokens || 0)
      },
      image: {
        defaultResolution: "1K",
        perImage: {
          "1K": Number(form.costs.image1K || 0),
          "2K": Number(form.costs.image2K || 0),
          "4K": Number(form.costs.image4K || 0)
        }
      },
      video: {
        defaultResolution: "720p",
        perSecond: {
          "480p": Number(form.costs.video480p || 0),
          "720p": Number(form.costs.video720p || 0),
          "1080p": Number(form.costs.video1080p || 0)
        },
        defaultDurationSeconds: Number(form.costs.videoDefaultDuration || 0)
      }
    }
  };
}

function displayLog(item) {
  const value = item || {};
  return Object.assign({}, value, {
    checkedAtText: value.checkedAt
      ? String(value.checkedAt).replace("T", " ").replace(/\.\d+Z$/, "")
      : "未知时间",
    statusText: value.ok ? "检查通过" : "需要处理",
    faceText: value.face && value.face.ready ? "人脸可用" : "人脸未就绪",
    analysisText: value.analysis && value.analysis.ready ? "图片分析可用" : "图片分析未就绪",
    imageText: value.image && value.image.ready ? "生图可用" : "生图未就绪",
    videoText: value.video && value.video.ready ? "视频可用" : "视频未就绪"
  });
}

function safeCopyValue(value, fallback = "无") {
  const text = String(value || "")
    .replace(/\bsk-[A-Za-z0-9._~-]+\b/gi, "[Key已隐藏]")
    .replace(/cloud:\/\/[^\s,;]+/gi, "[素材地址已隐藏]")
    .replace(
      /(?:[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users|private|data)\/)[^\s,;]+/g,
      "[路径已隐藏]"
    )
    .replace(/openid\s*[:=]\s*[^\s,;]+/gi, "OpenID=[已隐藏]")
    .slice(0, 500)
    .trim();
  return text || fallback;
}

function modelFailureCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `模型和服务商：${safeCopyValue(item.provider)} / ${safeCopyValue(item.model)}`,
    `错误码：${safeCopyValue(item.errorCode)}`,
    `接口状态：${item.errorStatus ? `HTTP ${item.errorStatus}` : "无"}`,
    `接口耗时：${Number(item.durationMs) || 0} 毫秒`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误原因：${safeCopyValue(item.errorMessage, "未提供错误摘要")}`
  ].join("\n");
}

function autoFaceFailureCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `模型和服务商：${safeCopyValue(item.probeProvider || "人脸识别")} / ${safeCopyValue(item.probeModel || "自动贴脸")}`,
    `错误码：${safeCopyValue(item.errorCode)}`,
    `接口状态：${item.status ? `HTTP ${item.status}` : "无"}`,
    `接口耗时：${Number(item.durationMs) || 0} 毫秒`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误原因：${safeCopyValue(item.message, "未提供错误摘要")}`
  ].join("\n");
}

Page({
  data: {
    appVersion: config.appVersion,
    loading: true,
    canRetry: false,
    saving: false,
    checking: false,
    refreshingAll: false,
    isAdmin: false,
    form: emptyForm(),
    defaults: null,
    effective: null,
    deployment: null,
    logs: [],
    message: "",
    usageLoading: false,
    usageExporting: false,
    usageStats: emptyUsageStats(),
    costTrend: emptyCostTrend(),
    userStatsLoading: false,
    userStatsExporting: false,
    userStats: emptyUserStats(),
    autoFaceFailureLoading: false,
    autoFaceFailureStats: emptyAutoFaceFailureStats(),
    autoFaceProbe: emptyAutoFaceProbe(),
    autoFaceProbeHistory: emptyAutoFaceProbeHistory(),
    moduleStates: emptyAdminModuleStates(),
    todayFailureText: "读取中",
    probeHistoryLoading: false,
    dashboardStatus: emptyDashboardStatus(),
    faceConfigSummary: emptyFaceConfigSummary(),
    analysisConfigSummary: emptyAnalysisConfigSummary(),
    entryHealth: buildEntryHealth(),
    activeConfigSection: "",
    activeConfigTitle: "",
    monitorExpanded: false
  },

  onLoad() {
    this._adminLoadToken = 0;
    this.loadAdminPage();
  },

  onUnload() {
    this._adminLoadToken = (this._adminLoadToken || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadAdminPage().finally(() => wx.stopPullDownRefresh());
  },

  isCurrentAdminLoad(token) {
    return token === this._adminLoadToken;
  },

  buildAdminDerivedPatch(overrides = {}, moduleStates = this.data.moduleStates) {
    const hasOwnValue = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
    const effective = hasOwnValue("effective") ? overrides.effective : this.data.effective;
    const usageStats = hasOwnValue("usageStats") ? overrides.usageStats : this.data.usageStats;
    const autoFaceProbe = hasOwnValue("autoFaceProbe")
      ? overrides.autoFaceProbe
      : this.data.autoFaceProbe;
    const autoFaceProbeHistory = hasOwnValue("autoFaceProbeHistory")
      ? overrides.autoFaceProbeHistory
      : this.data.autoFaceProbeHistory;
    const autoFaceFailureStats = hasOwnValue("autoFaceFailureStats")
      ? overrides.autoFaceFailureStats
      : this.data.autoFaceFailureStats;
    const userStats = hasOwnValue("userStats") ? overrides.userStats : this.data.userStats;
    return {
      dashboardStatus: buildDashboardStatus(
        effective,
        usageStats,
        autoFaceProbe,
        autoFaceProbeHistory
      ),
      faceConfigSummary: buildFaceConfigSummary(
        effective,
        autoFaceProbe,
        autoFaceProbeHistory
      ),
      analysisConfigSummary: buildAnalysisConfigSummary(effective),
      entryHealth: buildEntryHealth(
        effective,
        usageStats,
        autoFaceProbe,
        autoFaceProbeHistory,
        autoFaceFailureStats,
        userStats,
        moduleStates
      ),
      todayFailureText: buildTodayFailureText(usageStats, moduleStates)
    };
  },

  async loadAdminModule(
    token,
    key,
    task,
    formatter,
    applyResult,
    options = {}
  ) {
    if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
      return { ok: false, stale: true };
    }
    const currentStates = this.data.moduleStates || emptyAdminModuleStates();
    const loadingStates = updateAdminModuleState(
      currentStates,
      key,
      "loading",
      undefined,
      ""
    );
    const loadingPatch = {
      moduleStates: loadingStates
    };
    if (options.loadingKey) loadingPatch[options.loadingKey] = true;
    this.setData(Object.assign(
      loadingPatch,
      this.buildAdminDerivedPatch({}, loadingStates)
    ));
    const label = options.label || key;
    const timeoutMs = Number(options.timeoutMs) || 12000;
    try {
      const rawResult = await withTimeout(task(), timeoutMs, label);
      if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
        return { ok: false, stale: true };
      }
      const formatted = formatter ? formatter(rawResult) : rawResult;
      const unavailable = Boolean(formatted && formatted.unavailable);
      const currentStates = this.data.moduleStates || emptyAdminModuleStates();
      const previousState = currentStates[key] || createModuleState("loading");
      const nextStates = updateAdminModuleState(
        currentStates,
        key,
        unavailable ? "failed" : "ready",
        unavailable ? previousState.hasData : true,
        formatted && formatted.message
      );
      const patch = {};
      if (!unavailable || !previousState.hasData) {
        Object.assign(patch, applyResult(formatted));
      }
      if (options.loadingKey) patch[options.loadingKey] = false;
      patch.moduleStates = nextStates;
      Object.assign(patch, this.buildAdminDerivedPatch(patch, nextStates));
      this.setData(patch);
      if (unavailable) {
        diagnosticLog.warn("admin", "module-load-unavailable", `${label}返回不可用状态`, {
          error: formatted && formatted.message
        });
      } else {
        diagnosticLog.info("admin", "module-loaded", `${label}读取完成`, {});
      }
      return { ok: !unavailable, value: formatted, unavailable };
    } catch (error) {
      if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
        return { ok: false, stale: true, error };
      }
      const currentStates = this.data.moduleStates || emptyAdminModuleStates();
      const previousState = currentStates[key] || createModuleState("loading");
      const message = error && error.code === "ADMIN_LOAD_TIMEOUT"
        ? `${label}读取超时，请点击刷新。`
        : `${label}读取失败，请点击刷新。`;
      const nextStates = updateAdminModuleState(
        currentStates,
        key,
        "failed",
        previousState.hasData,
        message
      );
      const patch = {
        moduleStates: nextStates
      };
      if (options.loadingKey) patch[options.loadingKey] = false;
      Object.assign(patch, this.buildAdminDerivedPatch({}, nextStates));
      this.setData(patch);
      diagnosticLog.warn("admin", "module-load-failed", `${label}读取失败`, { error });
      return { ok: false, error };
    }
  },

  loadAdminBackground(token) {
    return Promise.all([
      this.loadAdminModule(
        token,
        "usage",
        () => cloud.getModelUsageStats(30),
        formatUsageStats,
        (usageStats) => ({
          usageStats,
          costTrend: buildCostTrend(usageStats)
        }),
        {
          label: "模型用量和成本",
          loadingKey: "usageLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "users",
        () => cloud.getAdminUserStats(0, 20),
        formatUserStats,
        (userStats) => ({ userStats }),
        {
          label: "用户统计",
          loadingKey: "userStatsLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "autoFaceFailure",
        () => cloud.getAutoFaceFailureStats(),
        formatAutoFaceFailureStats,
        (autoFaceFailureStats) => ({ autoFaceFailureStats }),
        {
          label: "自动贴脸失败统计",
          loadingKey: "autoFaceFailureLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "probeHistory",
        () => cloud.getAutoFaceProbeHistory(),
        formatAutoFaceProbeHistory,
        (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
        {
          label: "探针历史",
          loadingKey: "probeHistoryLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "logs",
        () => cloud.listDeploymentLogs(),
        (result) => result || {},
        (result) => ({
          logs: (result.logs || []).map(displayLog)
        }),
        {
          label: "部署日志"
        }
      )
    ]);
  },

  async loadAdminPage() {
    const token = (this._adminLoadToken || 0) + 1;
    this._adminLoadToken = token;
    if (!cloud.isCloudReady()) {
      this.setData({
        loading: false,
        isAdmin: false,
        canRetry: true,
        moduleStates: emptyAdminModuleStates(),
        todayFailureText: "读取失败",
        message: "云端未连接，无法读取管理员配置。"
      });
      return;
    }
    this.setData({
      loading: true,
      isAdmin: false,
      canRetry: false,
      moduleStates: emptyAdminModuleStates(),
      usageLoading: false,
      userStatsLoading: false,
      autoFaceFailureLoading: false,
      probeHistoryLoading: false,
      todayFailureText: "读取中",
      message: ""
    });
    try {
      const status = await withTimeout(
        cloud.getAdminStatus(),
        8000,
        "管理员权限"
      );
      if (!this.isCurrentAdminLoad(token)) return;
      if (!status || !status.isAdmin) {
        this.setData({
          loading: false,
          isAdmin: false,
          canRetry: false,
          message: "当前账号没有管理员权限。"
        });
        wx.showModal({
          title: "无权访问",
          content: "当前微信账号不在管理员白名单中。",
          showCancel: false,
          success: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
        });
        return;
      }
      const result = await withTimeout(
        cloud.getAdminConfig({ retryLimit: 1 }),
        10000,
        "管理员配置"
      );
      if (!this.isCurrentAdminLoad(token)) return;
      const effective = result && result.effective ? result.effective : null;
      const moduleStates = loadingAdminModuleStates(this.data.moduleStates);
      const basePatch = {
        loading: false,
        isAdmin: true,
        canRetry: false,
        form: formFromConfig(result),
        defaults: result.defaults || null,
        effective,
        moduleStates,
        message: ""
      };
      Object.assign(basePatch, this.buildAdminDerivedPatch(basePatch, moduleStates));
      this.setData(basePatch);
      diagnosticLog.info("admin", "config-loaded", "管理员配置读取完成", {
        runtimeConfigVersion: result.version || 0
      });
      this.loadAdminBackground(token);
    } catch (error) {
      if (!this.isCurrentAdminLoad(token)) return;
      const message = error && error.code === "ADMIN_LOAD_TIMEOUT"
        ? "管理员配置读取超时，请点击重新读取。"
        : "管理员配置读取失败，请检查云函数部署和白名单。";
      this.setData({
        loading: false,
        canRetry: true,
        message
      });
      diagnosticLog.error("admin", "config-load-failed", "管理员配置读取失败", { error });
    }
  },

  async refreshModelUsage() {
    if (this.data.usageLoading) return;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "usage",
      () => cloud.getModelUsageStats(30),
      formatUsageStats,
      (usageStats) => ({
        usageStats,
        costTrend: buildCostTrend(usageStats)
      }),
      {
        label: "模型用量和成本",
        loadingKey: "usageLoading"
      }
    );
    if (result.stale) return;
    if (result.ok) {
      wx.showToast({ title: "统计已刷新", icon: "success" });
    } else {
      this.showError("统计刷新失败", result.error || new Error("统计读取失败，请稍后重试。"));
    }
  },

  async refreshAutoFaceFailureStats() {
    if (this.data.autoFaceFailureLoading) return;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "autoFaceFailure",
      () => cloud.getAutoFaceFailureStats(),
      formatAutoFaceFailureStats,
      (autoFaceFailureStats) => ({ autoFaceFailureStats }),
      {
        label: "自动贴脸失败统计",
        loadingKey: "autoFaceFailureLoading"
      }
    );
    if (result.stale) return;
    if (result.ok) {
      wx.showToast({ title: "失败统计已刷新", icon: "success" });
    } else {
      this.showError(
        "失败统计刷新失败",
        result.error || new Error("统计读取失败，请稍后重试。")
      );
    }
  },

  async refreshAutoFaceProbeHistory() {
    if (this.data.probeHistoryLoading) return;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "probeHistory",
      () => cloud.getAutoFaceProbeHistory(),
      formatAutoFaceProbeHistory,
      (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
      {
        label: "探针历史",
        loadingKey: "probeHistoryLoading"
      }
    );
    if (result.stale) return;
    if (result.ok) {
      wx.showToast({ title: "探针历史已刷新", icon: "success" });
    } else {
      this.showError(
        "探针历史刷新失败",
        result.error || new Error("探针历史读取失败，请稍后重试。")
      );
    }
  },

  async refreshUserStats(reset = true) {
    if (this.data.userStatsLoading) return;
    const offset = reset ? 0 : this.data.userStats.nextOffset;
    if (!reset && (offset === null || offset === undefined)) return;
    const previousUsers = reset ? [] : this.data.userStats.users;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "users",
      () => cloud.getAdminUserStats(offset || 0, 20),
      (rawResult) => formatUserStats(rawResult, previousUsers),
      (userStats) => ({ userStats }),
      {
        label: "用户统计",
        loadingKey: "userStatsLoading"
      }
    );
    if (result.stale) return;
    if (result.ok && reset) {
      wx.showToast({ title: "用户统计已刷新", icon: "success" });
    } else if (!result.ok) {
      this.showError(
        "用户统计刷新失败",
        result.error || new Error("用户统计读取失败，请稍后重试。")
      );
    }
  },

  loadMoreUsers() {
    this.refreshUserStats(false);
  },

  async exportUserStats() {
    if (this.data.userStatsExporting) return;
    this.setData({ userStatsExporting: true });
    try {
      const result = await cloud.exportAdminUserStats();
      if (!result || !result.fileID) throw new Error("用户统计 Excel 生成失败。");
      const filePath = await cloud.downloadFile(result.fileID);
      if (!filePath || typeof wx.openDocument !== "function") {
        throw new Error("文件已生成，但当前微信版本无法打开 Excel 文件。");
      }
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath,
          fileType: "xlsx",
          showMenu: true,
          success: resolve,
          fail: reject
        });
      });
      this.setData({ userStatsExporting: false });
      wx.showToast({ title: "用户表已导出", icon: "success" });
    } catch (error) {
      this.setData({ userStatsExporting: false });
      diagnosticLog.error("admin", "user-stats-export-failed", "用户统计 Excel 导出失败", {
        error
      });
      this.showError("导出失败", error);
    }
  },

  async refreshAll() {
    if (this.data.refreshingAll) return;
    const token = (this._adminLoadToken || 0) + 1;
    this._adminLoadToken = token;
    const loadingStates = loadingAdminModuleStates(this.data.moduleStates);
    this.setData({
      refreshingAll: true,
      message: "正在刷新全部数据...",
      moduleStates: loadingStates,
      usageLoading: true,
      userStatsLoading: true,
      autoFaceFailureLoading: true,
      probeHistoryLoading: true,
      todayFailureText: "读取中"
    });

    const configTask = (async () => {
      try {
        const result = await withTimeout(
          cloud.getAdminConfig({ retryLimit: 1 }),
          10000,
          "管理员配置"
        );
        if (!this.isCurrentAdminLoad(token) || !this.data.isAdmin) {
          return { ok: false, stale: true };
        }
        const patch = {
          form: formFromConfig(result),
          defaults: result.defaults || null,
          effective: result.effective || null
        };
        Object.assign(patch, this.buildAdminDerivedPatch(patch, this.data.moduleStates));
        this.setData(patch);
        return { ok: true };
      } catch (error) {
        diagnosticLog.warn("admin", "refresh-all-part-failed", "模型配置刷新失败", { error });
        return { ok: false, error };
      }
    })();

    const moduleTasks = [
      this.loadAdminModule(
        token,
        "usage",
        () => cloud.getModelUsageStats(30),
        formatUsageStats,
        (usageStats) => ({ usageStats, costTrend: buildCostTrend(usageStats) }),
        { label: "模型用量和成本", loadingKey: "usageLoading" }
      ),
      this.loadAdminModule(
        token,
        "users",
        () => cloud.getAdminUserStats(0, 20),
        formatUserStats,
        (userStats) => ({ userStats }),
        { label: "用户统计", loadingKey: "userStatsLoading" }
      ),
      this.loadAdminModule(
        token,
        "autoFaceFailure",
        () => cloud.getAutoFaceFailureStats(),
        formatAutoFaceFailureStats,
        (autoFaceFailureStats) => ({ autoFaceFailureStats }),
        { label: "自动贴脸失败统计", loadingKey: "autoFaceFailureLoading" }
      ),
      this.loadAdminModule(
        token,
        "probeHistory",
        () => cloud.getAutoFaceProbeHistory(),
        formatAutoFaceProbeHistory,
        (autoFaceProbeHistory) => ({ autoFaceProbeHistory }),
        { label: "探针历史", loadingKey: "probeHistoryLoading" }
      ),
      this.loadAdminModule(
        token,
        "logs",
        () => cloud.listDeploymentLogs(),
        (result) => result || {},
        (result) => ({ logs: (result.logs || []).map(displayLog) }),
        { label: "部署日志" }
      )
    ];
    const [configResult, ...parts] = await Promise.all([configTask, ...moduleTasks]);
    if (
      !this.isCurrentAdminLoad(token)
      || configResult.stale
      || parts.some((part) => part && part.stale)
    ) {
      return;
    }
    const failed = [];
    if (!configResult.ok) failed.push("模型配置");
    parts.forEach((part, index) => {
      if (!part || part.ok) return;
      const labels = [
        "模型用量和成本",
        "用户统计",
        "自动贴脸失败统计",
        "探针历史",
        "部署日志"
      ];
      failed.push(labels[index]);
    });
    this.setData({
      refreshingAll: false,
      message: failed.length
        ? `刷新完成；失败项：${failed.join("、")}`
        : "全部数据已刷新。"
    });
    wx.showToast({
      title: failed.length ? `${failed.length}项失败` : "全部已刷新",
      icon: failed.length ? "none" : "success"
    });
  },

  copyModelFailure(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.usageStats.failureStats.failureDetails[index];
    if (!item) return;
    wx.setClipboardData({
      data: modelFailureCopyText(item),
      success: () => wx.showToast({ title: "错误已复制", icon: "success" })
    });
  },

  copyAutoFaceFailure(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.autoFaceFailureStats.recent[index];
    if (!item) return;
    wx.setClipboardData({
      data: autoFaceFailureCopyText(item),
      success: () => wx.showToast({ title: "错误已复制", icon: "success" })
    });
  },

  async exportModelUsage() {
    if (this.data.usageExporting) return;
    this.setData({ usageExporting: true });
    try {
      const result = await cloud.exportModelUsageStats(30);
      if (!result || !result.fileID) throw new Error("Excel 文件生成失败。");
      const filePath = await cloud.downloadFile(result.fileID);
      if (!filePath || typeof wx.openDocument !== "function") {
        throw new Error("文件已生成，但当前微信版本无法打开 Excel 文件。");
      }
      await new Promise((resolve, reject) => {
        wx.openDocument({
          filePath,
          fileType: "xlsx",
          showMenu: true,
          success: resolve,
          fail: reject
        });
      });
      this.setData({ usageExporting: false });
      wx.showToast({ title: "Excel已导出", icon: "success" });
    } catch (error) {
      this.setData({ usageExporting: false });
      diagnosticLog.error("admin", "usage-export-failed", "模型用量 Excel 导出失败", { error });
      this.showError("导出失败", error);
    }
  },

  onInput(event) {
    const section = event.currentTarget.dataset.section;
    const key = event.currentTarget.dataset.key;
    if (!section || !key) return;
    this.setData({
      [`form.${section}.${key}`]: event.detail.value
    });
  },

  onRetryChange(event) {
    this.setData({
      "form.image.retryEnabled": Array.isArray(event.detail.value)
        && event.detail.value.includes("enabled")
    });
  },

  toggleConfigSection(event) {
    const section = event.currentTarget.dataset.section;
    if (!CONFIG_SECTION_TITLES[section]) return;
    const nextSection = this.data.activeConfigSection === section ? "" : section;
    this.setData({
      activeConfigSection: nextSection,
      activeConfigTitle: nextSection ? CONFIG_SECTION_TITLES[nextSection] : ""
    }, () => {
      if (nextSection === "users" && this.data.userStats.unavailable) {
        this.refreshUserStats(true);
      }
      if (nextSection && typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: "#config-editor",
          duration: 220
        });
      }
    });
  },

  closeConfigSection() {
    this.setData({
      activeConfigSection: "",
      activeConfigTitle: ""
    });
  },

  toggleMonitor() {
    this.setData({
      monitorExpanded: !this.data.monitorExpanded
    });
  },

  async saveConfig() {
    if (this.data.saving) return;
    this.setData({ saving: true, message: "" });
    try {
      const result = await cloud.saveAdminConfig(formToConfig(this.data.form));
      const effective = result.effective || null;
      const patch = {
        form: formFromConfig(result),
        effective,
        saving: false,
        message: `配置已保存，第 ${result.version || 0} 版`
      };
      Object.assign(patch, this.buildAdminDerivedPatch(patch, this.data.moduleStates));
      this.setData(patch);
      diagnosticLog.info("admin", "config-saved", "管理员配置保存完成", {
        version: result.version || 0
      });
      wx.showToast({ title: "配置已保存", icon: "success" });
    } catch (error) {
      this.setData({ saving: false });
      diagnosticLog.error("admin", "config-save-failed", "管理员配置保存失败", { error });
      this.showError("保存失败", error);
    }
  },

  async checkDeployment() {
    if (this.data.checking) return;
    this.setData({ checking: true, message: "" });
    try {
      const probeStartedAt = Date.now();
      const [result, probeResult] = await Promise.all([
        cloud.checkDeployment(),
        cloud.probeAutoFace().catch((error) => ({ __probeError: error }))
      ]);
      const probeError = probeResult && probeResult.__probeError;
      if (probeResult && !probeError) {
        probeResult.clientDurationMs = Math.max(0, Date.now() - probeStartedAt);
      }
      const [logs, probeHistoryResult] = await Promise.all([
        cloud.listDeploymentLogs(),
        cloud.getAutoFaceProbeHistory().catch((error) => ({ __historyError: error }))
      ]);
      const historyError = probeHistoryResult && probeHistoryResult.__historyError;
      const historyUnavailable = Boolean(
        historyError
        || (probeResult && !probeError && probeResult.historyWritten === false)
      );
      const autoFaceProbe = formatAutoFaceProbe(
        probeError ? null : probeResult,
        probeError || null
      );
      const autoFaceProbeHistory = historyError
        ? Object.assign(emptyAutoFaceProbeHistory(), {
          unavailable: true,
          message: "探针结果已返回，但历史读取失败。"
        })
        : formatAutoFaceProbeHistory(probeHistoryResult);
      this.setData({
        deployment: result,
        logs: (logs.logs || []).map(displayLog),
        autoFaceProbe,
        autoFaceProbeHistory,
        dashboardStatus: buildDashboardStatus(
          this.data.effective,
          this.data.usageStats,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        faceConfigSummary: buildFaceConfigSummary(
          this.data.effective,
          autoFaceProbe,
          autoFaceProbeHistory
        ),
        analysisConfigSummary: buildAnalysisConfigSummary(this.data.effective),
        entryHealth: buildEntryHealth(
          this.data.effective,
          this.data.usageStats,
          autoFaceProbe,
          autoFaceProbeHistory,
          this.data.autoFaceFailureStats,
          this.data.userStats
        ),
        monitorExpanded: true,
        checking: false,
        message: result.logWritten
          ? (
            probeError
              ? "线上部署完成，但自动贴脸探针失败。"
              : historyUnavailable
                ? "线上部署检查完成，但探针历史暂时没有写入。"
                : "线上部署检查完成，日志已写入。"
          )
          : "检查完成，但日志写入失败。"
      });
      diagnosticLog.info("admin", "deployment-checked", "线上部署检查完成", {
        buildVersion: result.buildVersion,
        buildMarker: result.buildMarker,
        probeStatus: probeError ? "failed" : "ok",
        probeBuildVersion: probeResult && probeResult.buildVersion || "",
        probeVisionConfigured: Boolean(
          probeResult && probeResult.vision && probeResult.vision.configured
        ),
        logWritten: result.logWritten
      });
    } catch (error) {
      this.setData({ checking: false });
      diagnosticLog.error("admin", "deployment-check-failed", "线上部署检查失败", { error });
      this.showError("检查失败", error);
    }
  },

  backToWorkbench() {
    wx.reLaunch({ url: "/pages/workbench/workbench" });
  },

  showError(title, error) {
    const payload = error && error.payload;
    const message = (payload && (payload.message || payload.error))
      || (error && error.message)
      || "请稍后重试";
    wx.showModal({
      title,
      content: String(message),
      showCancel: false
    });
  }
});
