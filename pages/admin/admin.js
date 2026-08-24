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
      analysisInputPerMillionTokens: "0.15",
      analysisOutputPerMillionTokens: "1.5",
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

function usageTypeLabel(type) {
  const item = USAGE_TYPE_META.find((entry) => entry.key === type);
  return item ? item.title : "模型";
}

// 成本金额只展示到小数点后 4 位并直接截断，底层统计和 Excel 仍保留原值。
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

const MONITOR_SECTION_KEYS = Object.freeze([
  "usage",
  "autoFaceFailure",
  "diagnosticLogs",
  "deployment"
]);
const USAGE_SECTION_KEYS = Object.freeze([
  "failure",
  "daily",
  "users",
  "models",
  "monthly"
]);
const AUTO_FACE_FAILURE_SECTION_KEYS = Object.freeze([
  "failure",
  "daily",
  "users",
  "monthly"
]);
const MONITOR_LAYOUT_STORAGE_KEY = "admin-monitor-layout-v2";
const AUTO_FACE_FAILURE_AUTO_REFRESH_MS = 10 * 60 * 1000;
const MODEL_FAILURE_AUTO_REFRESH_MS = 10 * 60 * 1000;

function defaultUsageSections() {
  return {
    failure: true,
    daily: true,
    users: true,
    models: false,
    monthly: true
  };
}

function defaultAutoFaceFailureSections() {
  return {
    failure: true,
    daily: true,
    users: false,
    monthly: false
  };
}

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
    pricedCount: 0,
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

function formatUsageCounter(counter) {
  const normalized = Object.assign(emptyUsageCounter(), counter || {});
  normalized.total = Math.max(0, Number(normalized.total) || 0);
  normalized.unavailableCostCount = Math.max(0, Number(normalized.unavailableCostCount) || 0);
  normalized.pricedCount = Math.max(0, normalized.total - normalized.unavailableCostCount);
  normalized.estimatedCost = Math.max(0, Number(normalized.estimatedCost) || 0);
  normalized.pricedCost = Math.max(0, Number(normalized.pricedCost) || 0);
  normalized.estimatedCostDisplay = formatCostDisplay(normalized.estimatedCost);
  normalized.pricedCostDisplay = formatCostDisplay(normalized.pricedCost);
  return normalized;
}

function emptyFailureStats() {
  return {
    total: 0,
    failureRate: 0,
    topFailureReasons: [],
    failedModels: [],
    failureDetails: [],
    details: [],
    monthly: [],
    users: []
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
      modelText: "暂无调用",
      modelLines: ["暂无调用"]
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
    daily: [],
    monthly: [],
    users: [],
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

function emptyModelProbes() {
  return {
    available: false,
    status: "not-run",
    statusText: "尚未探测",
    buildVersion: "",
    buildMarker: "",
    checkedAtText: "未知时间",
    readyCount: 0,
    total: 4,
    results: [],
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
    search: "",
    dateRange: "all",
    gender: "all",
    startDate: "",
    endDate: "",
    signupTrend: [],
    signupTrendTotal: 0,
    nextOffset: null,
    unavailable: false,
    message: ""
  };
}

function emptyAdminDiagnosticLogs() {
  return {
    retentionHours: 72,
    hours: 72,
    level: "all",
    category: "all",
    userHash: "",
    summary: {
      total: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      userCount: 0,
      categories: []
    },
    userOptions: [{ value: "", label: "全部用户" }],
    logs: [],
    nextOffset: null,
    eventCount: 0,
    truncated: false,
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
  "diagnosticLogs",
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

function createModuleState(
  status = "idle",
  hasData = false,
  message = "",
  updatedAtText = "尚未更新"
) {
  return {
    status,
    label: moduleStateLabel(status),
    hasData: Boolean(hasData),
    message: message || "",
    updatedAtText: updatedAtText || "尚未更新"
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
      previousState.message || "",
      previousState.updatedAtText || "尚未更新"
    );
    return result;
  }, {});
}

function updateAdminModuleState(
  states,
  key,
  status,
  hasData,
  message = "",
  updatedAtText = ""
) {
  const previous = states && states[key] ? states[key] : createModuleState();
  return Object.assign({}, states || {}, {
    [key]: createModuleState(
      status,
      hasData === undefined ? previous.hasData : hasData,
      message,
      updatedAtText || previous.updatedAtText
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
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      failureType: item.failureType || "unknown",
      failureTypeLabel: item.failureTypeLabel || item.failureType || "其他失败",
      failureTypeTone: autoFaceFailureTypeTone(item.failureType),
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
    })),
    details: (Array.isArray(source.details) ? source.details : []).map((item) => ({
      requestId: item.requestId || "",
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      failureType: item.failureType || "unknown",
      failureTypeLabel: item.failureTypeLabel || item.failureType || "其他失败",
      failureTypeTone: autoFaceFailureTypeTone(item.failureType),
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
      dateKey: item.dateKey || "",
      monthKey: item.monthKey || String(item.dateKey || "").slice(0, 7),
      createdAtText: formatAdminDate(item.createdAt)
    })),
    daily: (Array.isArray(source.daily) ? source.daily : []).map((item) => ({
      dateKey: item.dateKey || "",
      total: Number(item.total) || 0,
      userCount: Number(item.userCount) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType),
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    monthly: (Array.isArray(source.monthly) ? source.monthly : []).map((item) => ({
      monthKey: item.monthKey || "",
      total: Number(item.total) || 0,
      userCount: Number(item.userCount) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType),
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    })),
    users: (Array.isArray(source.users) ? source.users : []).map((item) => ({
      userHash: item.userHash || "anonymous",
      userLabel: item.userHash === "anonymous" ? "匿名用户" : `用户 ${item.userHash}`,
      total: Number(item.total) || 0,
      topFailureType: item.topFailureType || "unknown",
      topFailureTypeLabel: item.topFailureTypeLabel || "其他失败",
      lastSeenText: item.lastSeen ? formatAdminDate(item.lastSeen) : "暂无"
    }))
  });
}

function autoFaceFailureTypeTone(type) {
  const value = String(type || "").toLowerCase();
  if (value === "timeout") return "warning";
  if (value === "network" || value === "upstream" || value === "cloud-unavailable") {
    return "danger";
  }
  if (value === "missing-api-key" || value === "empty-face-detection") return "violet";
  if (value === "missing-main-image" || value === "image-too-large") return "info";
  return "neutral";
}

function buildAutoFaceFailureView(stats, requestedMonth = "") {
  const source = stats || emptyAutoFaceFailureStats();
  const currentMonth = String(source.todayKey || "").slice(0, 7);
  const detailSource = Array.isArray(source.details) && source.details.length
    ? source.details
    : source.recent || [];
  const months = Array.from(new Set(
    [currentMonth].concat(
      (Array.isArray(source.monthly) ? source.monthly : []).map((item) => item.monthKey)
    )
  ))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left));
  const selectedMonth = months.includes(requestedMonth) ? requestedMonth : (months[0] || currentMonth);
  const details = detailSource
    .filter((item) => !selectedMonth || item.monthKey === selectedMonth)
    .map((item) => Object.assign({}, item, {
      failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(item.failureType)
    }));
  const daily = (Array.isArray(source.daily) ? source.daily : [])
    .filter((item) => !selectedMonth || String(item.dateKey || "").startsWith(selectedMonth))
    .map((item) => Object.assign({}, item, {
      topFailureTypeTone: autoFaceFailureTypeTone(item.topFailureType)
    }));
  const typeMap = {};
  const userMap = {};
  details.forEach((item) => {
    const type = item.failureType || "unknown";
    if (!typeMap[type]) {
      typeMap[type] = {
        type,
        label: item.failureTypeLabel || "其他失败",
        count: 0,
        lastSeenText: item.createdAtText || "暂无",
        failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(type)
      };
    }
    typeMap[type].count += 1;
    if (!userMap[item.userHash || "anonymous"]) {
      userMap[item.userHash || "anonymous"] = {
        userHash: item.userHash || "anonymous",
        userLabel: item.userLabel || "匿名用户",
        total: 0,
        topFailureType: type,
        topFailureTypeLabel: item.failureTypeLabel || "其他失败",
        failureTypeTone: item.failureTypeTone || autoFaceFailureTypeTone(type),
        lastSeenText: item.createdAtText || "暂无"
      };
    }
    userMap[item.userHash || "anonymous"].total += 1;
  });
  const users = Object.values(userMap).sort((left, right) => {
    if (right.total !== left.total) return right.total - left.total;
    return left.userHash.localeCompare(right.userHash);
  });
  const byType = Object.values(typeMap).sort((left, right) => right.count - left.count);
  return {
    selectedMonth,
    monthOptions: months,
    monthOptionIndex: Math.max(0, months.indexOf(selectedMonth)),
    total: details.length,
    today: selectedMonth === currentMonth ? Number(source.today) || 0 : 0,
    last7d: selectedMonth === currentMonth ? Number(source.last7d) || 0 : 0,
    byType,
    daily,
    users,
    recent: details.slice(0, 20),
    details,
    monthly: Array.isArray(source.monthly) ? source.monthly : [],
    emptyText: selectedMonth ? `${selectedMonth} 没有自动贴脸失败记录。` : "没有自动贴脸失败记录。"
  };
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

function formatModelProbes(result, error = null) {
  const source = result || {};
  const failed = Boolean(error) || source.ok === false && !Array.isArray(source.results);
  const results = (Array.isArray(source.results) ? source.results : []).map((item) => ({
    type: item.type || "",
    typeLabel: item.typeLabel || usageTypeLabel(item.type),
    provider: item.provider || "未填写",
    model: item.model || "未填写",
    configured: Boolean(item.configured),
    ready: Boolean(item.ready),
    reachable: Boolean(item.reachable),
    status: item.status || "network-error",
    statusText: item.statusText || (item.ready ? "正常" : "需要处理"),
    httpStatus: Number(item.httpStatus) || 0,
    durationMs: Number(item.durationMs) || 0,
    durationText: `${Number(item.durationMs) || 0} 毫秒`,
    endpoint: item.endpoint || "",
    message: item.message || ""
  }));
  const readyCount = Number(source.readyCount);
  const total = Number(source.total) || 4;
  const normalizedReadyCount = Number.isFinite(readyCount)
    ? readyCount
    : results.filter((item) => item.ready).length;
  return Object.assign(emptyModelProbes(), {
    available: !failed,
    status: failed ? "failed" : normalizedReadyCount === total ? "ok" : "warn",
    statusText: failed
      ? `探测失败${error && error.code ? `：${error.code}` : ""}`
      : `${normalizedReadyCount}/${total} 套正常`,
    buildVersion: source.buildVersion || "",
    buildMarker: source.buildMarker || "",
    checkedAtText: source.checkedAt ? formatAdminDate(source.checkedAt) : formatAdminDate(new Date()),
    readyCount: normalizedReadyCount,
    total,
    results,
    message: error && error.message || source.message || ""
  });
}

function mergeSingleModelProbe(current, incoming, modelType) {
  const previous = current || emptyModelProbes();
  const next = incoming || emptyModelProbes();
  const byType = {};
  (Array.isArray(previous.results) ? previous.results : []).forEach((item) => {
    if (item && item.type) byType[item.type] = item;
  });
  (Array.isArray(next.results) ? next.results : []).forEach((item) => {
    if (item && item.type) byType[item.type] = item;
  });
  const results = USAGE_TYPE_META
    .map((item) => byType[item.key])
    .filter(Boolean);
  const readyCount = results.filter((item) => item.ready).length;
  const target = byType[modelType] || next.results && next.results[0] || null;
  const total = results.length;
  return Object.assign(emptyModelProbes(), previous, next, {
    available: true,
    status: total > 0 && readyCount === total ? "ok" : "warn",
    statusText: target
      ? `${target.typeLabel}：${target.statusText}`
      : `${readyCount}/${total} 套正常`,
    readyCount,
    total,
    results
  });
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
    const counter = formatUsageCounter(summary[meta.key]);
    const modelText = models
      .filter((item) => item.usageType === meta.key)
      .map((item) => {
        const provider = item.provider || "未知 Provider";
        const model = item.model || "未知模型";
        return `${provider} / ${model}`;
      })
      .filter((item, index, list) => list.indexOf(item) === index)
      .join("、") || "暂无调用";
    const modelLines = models
      .filter((item) => item.usageType === meta.key)
      .map((item) => `${item.provider || "未知 Provider"} / ${item.model || "未知模型"}`)
      .filter((item, index, list) => list.indexOf(item) === index);
    if (!modelLines.length) modelLines.push("暂无调用");
    return Object.assign({}, meta, counter, { modelText, modelLines });
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    image: formatUsageCounter(item.image),
    analysis: formatUsageCounter(item.analysis),
    face: formatUsageCounter(item.face),
    video: formatUsageCounter(item.video)
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    image: formatUsageCounter(item.image),
    analysis: formatUsageCounter(item.analysis),
    face: formatUsageCounter(item.face),
    video: formatUsageCounter(item.video)
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
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost),
    byType: item.byType || {}
  }));
  const formattedModels = models.map((item) => Object.assign({}, item, {
    estimatedCostDisplay: formatCostDisplay(item.estimatedCost),
    pricedCostDisplay: formatCostDisplay(item.pricedCost)
  }));
  const failureSource = source.failureStats || {};
  const failureStats = Object.assign(emptyFailureStats(), {
    total: Number(failureSource.total) || 0,
    failureRate: Number(failureSource.failureRate) || 0,
    monthly: (Array.isArray(failureSource.monthly) ? failureSource.monthly : []).map((item) => ({
      monthKey: item.monthKey || "",
      total: Number(item.total) || 0,
      success: Number(item.success) || 0,
      failure: Number(item.failure) || 0,
      userCount: Number(item.userCount) || 0
    })),
    users: (Array.isArray(failureSource.users) ? failureSource.users : []).map((item) => ({
      userHash: item.userHash || "anonymous",
      total: Number(item.total) || 0,
      lastSeen: item.lastSeen || "",
      topFailureReason: item.topFailureReason || "未提供错误原因",
      topFailureCode: item.topFailureCode || "",
      topFailureStatus: Number(item.topFailureStatus) || 0
    })),
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
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
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
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
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
      dateKey: item.dateKey || "",
      monthKey: item.monthKey || String(item.dateKey || "").slice(0, 7),
      createdAt: item.createdAt || "",
      createdAtText: formatAdminDate(item.createdAt || item.dateKey),
      userHash: item.userHash || "anonymous",
      usageType: item.usageType || "unknown",
      usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
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
  failureStats.details = failureStats.failureDetails;
  return Object.assign(emptyUsageStats(), source, {
    today: formatUsageCounter(source.today),
    last7d: formatUsageCounter(source.last7d),
    last30d: formatUsageCounter(source.last30d),
    cards,
    daily,
    monthly,
    users,
    models: formattedModels,
    failureStats
  });
}

function modelFailureReasonKey(item = {}) {
  if (item.errorCode) return `code:${item.errorCode}`;
  if (item.errorStatus) return `http:${item.errorStatus}`;
  if (item.errorMessage) return `message:${item.errorMessage}`;
  return "unknown";
}

function modelFailureReasonLabel(item = {}) {
  if (item.errorMessage && item.errorCode) {
    return `${item.errorCode}：${item.errorMessage}`;
  }
  if (item.errorMessage) return item.errorMessage;
  if (item.errorCode) return item.errorCode;
  if (item.errorStatus) return `HTTP ${item.errorStatus}`;
  return "未提供错误原因";
}

function modelFailureTone(item = {}) {
  const code = String(item.errorCode || "").toLowerCase();
  const message = String(item.errorMessage || "").toLowerCase();
  const status = Number(item.errorStatus) || 0;
  if (
    status === 408
    || status === 504
    || /timeout|timed-out|deadline|超时/.test(`${code} ${message}`)
  ) {
    return "warning";
  }
  if (
    status === 401
    || status === 403
    || /api.?key|auth|config|probe|missing|invalid|鉴权|配置|探针/.test(`${code} ${message}`)
  ) {
    return "violet";
  }
  if (
    status >= 500
    || status === 429
    || /network|upstream|provider|gateway|rate-limit|接口|网络|供应商/.test(`${code} ${message}`)
  ) {
    return "danger";
  }
  return "neutral";
}

function buildModelFailureView(stats, requestedMonth = "") {
  const source = Object.assign(emptyFailureStats(), stats || {});
  const detailSource = Array.isArray(source.details) && source.details.length
    ? source.details
    : (Array.isArray(source.failureDetails) ? source.failureDetails : []);
  const monthOptions = Array.from(new Set(
    (Array.isArray(source.monthly) ? source.monthly : [])
      .map((item) => String(item.monthKey || ""))
      .concat(detailSource.map((item) => String(
        item.monthKey || String(item.dateKey || "").slice(0, 7)
      )))
  ))
    .filter((item) => /^\d{4}-\d{2}$/.test(item))
    .sort((left, right) => right.localeCompare(left));
  const selectedMonth = monthOptions.includes(requestedMonth)
    ? requestedMonth
    : (monthOptions[0] || String(source.todayKey || "").slice(0, 7));
  const details = detailSource
    .filter((item) => {
      const monthKey = item.monthKey || String(item.dateKey || "").slice(0, 7);
      return !selectedMonth || monthKey === selectedMonth;
    })
    .map((item) => Object.assign({}, item, {
      userHash: item.userHash || "anonymous",
      failureTone: modelFailureTone(item),
      failureReasonLabel: modelFailureReasonLabel(item)
    }))
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const reasonMap = {};
  const userMap = {};
  const modelMap = {};
  details.forEach((item) => {
    const reasonKey = modelFailureReasonKey(item);
    if (!reasonMap[reasonKey]) {
      reasonMap[reasonKey] = {
        key: reasonKey,
        code: item.errorCode || "",
        label: modelFailureReasonLabel(item),
        count: 0,
        lastSeen: item.createdAt || "",
        usageType: item.usageType || "",
        usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
        provider: item.provider || "",
        model: item.model || "",
        status: Number(item.errorStatus) || 0,
        failureTone: modelFailureTone(item)
      };
    }
    reasonMap[reasonKey].count += 1;
    if (String(item.createdAt || "") > String(reasonMap[reasonKey].lastSeen || "")) {
      reasonMap[reasonKey].lastSeen = item.createdAt;
    }
    const userHash = item.userHash || "anonymous";
    if (!userMap[userHash]) {
      userMap[userHash] = {
        userHash,
        total: 0,
        lastSeen: item.createdAt || "",
        topFailureReason: modelFailureReasonLabel(item),
        topFailureCode: item.errorCode || "",
        topFailureStatus: Number(item.errorStatus) || 0,
        reasonMap: {}
      };
    }
    userMap[userHash].total += 1;
    if (String(item.createdAt || "") > String(userMap[userHash].lastSeen || "")) {
      userMap[userHash].lastSeen = item.createdAt;
    }
    userMap[userHash].reasonMap[reasonKey] = (userMap[userHash].reasonMap[reasonKey] || 0) + 1;
    const modelKey = [
      item.usageType || "unknown",
      item.provider || "未知 Provider",
      item.model || "未知模型"
    ].join("|");
    if (!modelMap[modelKey]) {
      modelMap[modelKey] = {
        usageType: item.usageType || "unknown",
        usageTypeLabel: item.usageTypeLabel || usageTypeLabel(item.usageType),
        provider: item.provider || "未知 Provider",
        model: item.model || "未知模型",
        failure: 0
      };
    }
    modelMap[modelKey].failure += 1;
  });
  const selectedMonthMeta = (Array.isArray(source.monthly) ? source.monthly : [])
    .find((item) => item.monthKey === selectedMonth);
  const failureTotal = details.length;
  const total = Number(selectedMonthMeta && selectedMonthMeta.total) || failureTotal;
  const topFailureReasons = Object.values(reasonMap)
    .map((item) => Object.assign({}, item, {
      rate: failureTotal ? Number((item.count / failureTotal * 100).toFixed(2)) : 0,
      lastSeenText: formatAdminDate(item.lastSeen)
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 5);
  const users = Object.values(userMap)
    .map((item) => {
      const topReasonKey = Object.entries(item.reasonMap)
        .sort((left, right) => right[1] - left[1])[0];
      const topReason = topReasonKey ? reasonMap[topReasonKey[0]] : null;
      return Object.assign({}, item, {
        topFailureReason: topReason ? topReason.label : item.topFailureReason,
        topFailureCode: topReason ? topReason.code : item.topFailureCode,
        topFailureStatus: topReason ? topReason.status : item.topFailureStatus,
        failureTone: topReason ? topReason.failureTone : "neutral",
        lastSeenText: formatAdminDate(item.lastSeen)
      });
    })
    .sort((left, right) => right.total - left.total);
  const failedModels = Object.values(modelMap)
    .sort((left, right) => right.failure - left.failure)
    .slice(0, 5);
  return {
    selectedMonth,
    monthOptions,
    monthIndex: Math.max(0, monthOptions.indexOf(selectedMonth)),
    total: failureTotal,
    failureRate: total ? Number((failureTotal / total * 100).toFixed(2)) : 0,
    topFailureReasons,
    failedModels,
    users,
    details,
    emptyText: selectedMonth
      ? `${selectedMonth} 没有模型失败记录。`
      : "最近统计范围内没有失败记录。"
  };
}

function diagnosticLevelText(level) {
  if (level === "error") return "错误";
  if (level === "warn") return "提醒";
  return "正常";
}

function diagnosticDetailsText(value) {
  if (!value || typeof value !== "object" || !Object.keys(value).length) return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000);
  } catch (_) {
    return String(value).slice(0, 2000);
  }
}

function formatAdminDiagnosticLogs(result, previousLogs = []) {
  const source = result || {};
  const previousExpanded = {};
  (Array.isArray(previousLogs) ? previousLogs : []).forEach((item) => {
    if (item && item.eventId) previousExpanded[item.eventId] = Boolean(item.expanded);
  });
  const summarySource = source.summary || {};
  return Object.assign(emptyAdminDiagnosticLogs(), source, {
    retentionHours: Number(source.retentionHours) || 72,
    hours: Number(source.hours) || 72,
    summary: {
      total: Number(summarySource.total) || 0,
      errorCount: Number(summarySource.errorCount) || 0,
      warnCount: Number(summarySource.warnCount) || 0,
      infoCount: Number(summarySource.infoCount) || 0,
      userCount: Number(summarySource.userCount) || 0,
      categories: Array.isArray(summarySource.categories) ? summarySource.categories : []
    },
    userOptions: [{ value: "", label: "全部用户" }].concat(
      (Array.isArray(source.userOptions) ? source.userOptions : []).map((item) => ({
        value: item.value || "",
        label: item.label || `用户 ${item.value || ""}`
      }))
    ),
    logs: (Array.isArray(source.logs) ? source.logs : []).map((item) => {
      const detailsText = diagnosticDetailsText(item.details);
      const errorText = diagnosticDetailsText(item.error);
      return {
        eventId: item.eventId || `${item.sessionId || "session"}-${item.sequence || 0}`,
        userHash: item.userHash || "anonymous",
        appVersion: item.appVersion || "未知",
        level: item.level || "info",
        levelText: diagnosticLevelText(item.level),
        category: item.category || "other",
        categoryLabel: item.categoryLabel || "其他",
        event: item.event || "",
        message: item.message || "未提供日志说明",
        route: item.route || "",
        step: item.step || "",
        requestId: item.requestId || "",
        code: item.code || "",
        durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null,
        durationText: Number.isFinite(Number(item.durationMs))
          ? `${Number(item.durationMs)} 毫秒`
          : "未记录",
        detailsText,
        errorText,
        hasDetails: Boolean(detailsText || errorText),
        expanded: Boolean(previousExpanded[item.eventId]),
        createdAt: item.createdAt || "",
        createdAtText: item.createdAt ? formatAdminDate(item.createdAt) : "未知时间"
      };
    }),
    nextOffset: source.nextOffset === null || source.nextOffset === undefined
      ? null
      : Math.max(0, Number(source.nextOffset) || 0),
    eventCount: Number(source.eventCount) || 0,
    truncated: Boolean(source.truncated),
    unavailable: Boolean(source.unavailable),
    message: source.message || ""
  });
}

function formatUserSignupTrend(items = []) {
  const days = (Array.isArray(items) ? items : []).map((item) => {
    const dateKey = String(item && item.dateKey || "");
    const dateParts = dateKey.slice(5).split("-");
    return {
      dateKey,
      label: dateParts.length === 2
        ? `${Number(dateParts[0])}/${Number(dateParts[1])}`
        : dateKey,
      count: Math.max(0, Number(item && item.count) || 0)
    };
  });
  const maxCount = Math.max(0, ...days.map((item) => item.count));
  return days.map((item) => Object.assign({}, item, {
    barPercent: item.count && maxCount
      ? Math.max(14, Math.round(item.count / maxCount * 100))
      : 0
  }));
}

function formatUserStats(result, previousUsers = []) {
  const source = result || {};
  const incoming = (Array.isArray(source.users) ? source.users : []).map((item) => ({
    userHash: item.userHash || "anonymous",
    nickname: item.nickname || "未填写昵称",
    avatarUrl: item.avatarUrl || item.avatarFileID || "",
    gender: item.gender === "female" ? "female" : "male",
    genderText: item.gender === "female" ? "女" : "男",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    createdAtText: item.createdAt ? formatAdminDate(item.createdAt) : "未知时间",
    updatedAtText: item.updatedAt ? formatAdminDate(item.updatedAt) : "暂无修改记录"
  }));
  const users = Number(source.offset) > 0
    ? previousUsers.concat(incoming).filter((item, index, list) => (
      list.findIndex((candidate) => candidate.userHash === item.userHash) === index
    ))
    : incoming;
  const signupTrend = formatUserSignupTrend(source.signupTrend);
  return Object.assign(emptyUserStats(), {
    total: Number(source.total) || 0,
    maleCount: Number(source.maleCount) || 0,
    femaleCount: Number(source.femaleCount) || 0,
    maleRatio: Number(source.maleRatio) || 0,
    femaleRatio: Number(source.femaleRatio) || 0,
    users,
    search: String(source.search || ""),
    dateRange: String(source.dateRange || "all"),
    gender: String(source.gender || "all"),
    startDate: String(source.startDate || ""),
    endDate: String(source.endDate || ""),
    signupTrend,
    signupTrendTotal: signupTrend.reduce((total, item) => total + item.count, 0),
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

function shanghaiTodayDateKey() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function buildUserStatsFilters(data = {}) {
  const custom = data.userDateRange === "custom";
  return {
    search: String(data.userSearch || ""),
    dateRange: String(data.userDateRange || "all"),
    gender: String(data.userGender || "all"),
    startDate: custom ? String(data.userCustomStartDate || "") : "",
    endDate: custom ? String(data.userCustomEndDate || "") : ""
  };
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
      cost: costByDate[dateKey] || 0,
      costDisplay: formatCostDisplay(costByDate[dateKey])
    });
  }
  const maxCost = Math.max(0, ...days.map((item) => item.cost));
  const normalizedDays = days.map((item) => Object.assign({}, item, {
    barPercent: maxCost ? Math.round(item.cost / maxCost * 100) : 0
  }));
  const totalCost = normalizedDays.reduce((total, item) => total + item.cost, 0);
  return {
    days: normalizedDays,
    totalCost,
    totalCostDisplay: formatCostDisplay(totalCost),
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
  const analysisCosts = costs.analysis || faceCosts;
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
      analysisInputPerMillionTokens: String(
        analysisCosts.inputPerMillionTokens !== undefined
          ? analysisCosts.inputPerMillionTokens
          : faceCosts.inputPerMillionTokens || 0.15
      ),
      analysisOutputPerMillionTokens: String(
        analysisCosts.outputPerMillionTokens !== undefined
          ? analysisCosts.outputPerMillionTokens
          : faceCosts.outputPerMillionTokens || 1.5
      ),
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
      analysis: {
        inputPerMillionTokens: Number(form.costs.analysisInputPerMillionTokens || 0),
        outputPerMillionTokens: Number(form.costs.analysisOutputPerMillionTokens || 0)
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
    `功能类型：${safeCopyValue(item.usageTypeLabel || usageTypeLabel(item.usageType))}`,
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

function diagnosticLogCopyText(item = {}) {
  return [
    `发生时间：${safeCopyValue(item.createdAtText, "未知时间")}`,
    `匿名用户：${safeCopyValue(item.userHash)}`,
    `分类：${safeCopyValue(item.categoryLabel)}`,
    `级别：${safeCopyValue(item.levelText)}`,
    `日志：${safeCopyValue(item.message, "未提供日志说明")}`,
    `页面：${safeCopyValue(item.route)}`,
    `步骤：${safeCopyValue(item.step)}`,
    `错误码：${safeCopyValue(item.code)}`,
    `接口耗时：${safeCopyValue(item.durationText)}`,
    `请求编号：${safeCopyValue(item.requestId)}`,
    `错误详情：${safeCopyValue(item.errorText)}`,
    `补充信息：${safeCopyValue(item.detailsText)}`
  ].join("\n");
}

Page({
  data: {
    appVersion: config.appVersion,
    loading: true,
    canRetry: false,
    saving: false,
    checking: false,
    modelProbing: false,
    modelProbingType: "",
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
    userSearchInput: "",
    userSearch: "",
    userDateRange: "all",
    userDateRanges: [
      { value: "all", label: "全部" },
      { value: "today", label: "今天" },
      { value: "7d", label: "近7天" },
      { value: "30d", label: "近30天" },
      { value: "custom", label: "自定义" }
    ],
    userGender: "all",
    userGenders: [
      { value: "all", label: "全部" },
      { value: "male", label: "男性" },
      { value: "female", label: "女性" }
    ],
    userTodayKey: shanghaiTodayDateKey(),
    userCustomStartDate: dateKeyShift(shanghaiTodayDateKey(), -6),
    userCustomEndDate: shanghaiTodayDateKey(),
    userDetailVisible: false,
    selectedUserDetail: null,
    diagnosticLogsLoading: false,
    diagnosticLogs: emptyAdminDiagnosticLogs(),
    diagnosticHours: 72,
    diagnosticLevel: "all",
    diagnosticCategory: "all",
    diagnosticUserHash: "",
    diagnosticUserIndex: 0,
    diagnosticUserLabel: "全部用户",
    diagnosticTimeRanges: [
      { value: 1, label: "1小时" },
      { value: 6, label: "6小时" },
      { value: 24, label: "24小时" },
      { value: 72, label: "72小时" }
    ],
    diagnosticLevels: [
      { value: "all", label: "全部" },
      { value: "error", label: "错误" },
      { value: "warn", label: "提醒" },
      { value: "info", label: "正常" }
    ],
    diagnosticCategories: [
      { value: "all", label: "全部类型" },
      { value: "generation", label: "生图" },
      { value: "video", label: "视频" },
      { value: "analysis", label: "图片分析" },
      { value: "auto-face", label: "自动贴脸" },
      { value: "upload", label: "上传" },
      { value: "cloud", label: "云端" },
      { value: "navigation", label: "页面" },
      { value: "points", label: "积分" },
      { value: "records", label: "作品" },
      { value: "repair", label: "修正" },
      { value: "other", label: "其他" }
    ],
    autoFaceFailureLoading: false,
    autoFaceFailureExporting: false,
    autoFaceFailureStats: emptyAutoFaceFailureStats(),
    autoFaceFailureView: buildAutoFaceFailureView(emptyAutoFaceFailureStats()),
    autoFaceFailureSelectedMonth: "",
    autoFaceFailureDetailOpen: false,
    autoFaceFailureDetail: null,
    modelFailureExporting: false,
    modelFailureView: buildModelFailureView(emptyFailureStats()),
    modelFailureSelectedMonth: "",
    modelFailureDetailOpen: false,
    modelFailureDetail: null,
    autoFaceProbe: emptyAutoFaceProbe(),
    autoFaceProbeHistory: emptyAutoFaceProbeHistory(),
    modelProbes: emptyModelProbes(),
    moduleStates: emptyAdminModuleStates(),
    todayFailureText: "读取中",
    probeHistoryLoading: false,
    dashboardStatus: emptyDashboardStatus(),
    faceConfigSummary: emptyFaceConfigSummary(),
    analysisConfigSummary: emptyAnalysisConfigSummary(),
    entryHealth: buildEntryHealth(),
    activeConfigSection: "",
    activeConfigTitle: "",
    monitorExpanded: true,
    monitorSections: {
      usage: true,
      autoFaceFailure: false,
      diagnosticLogs: false,
      deployment: false
    },
    usageSections: defaultUsageSections(),
    autoFaceFailureSections: defaultAutoFaceFailureSections(),
    monitorOnlyAbnormal: false
  },

  onLoad() {
    this._adminLoadToken = 0;
    this.restoreMonitorLayout();
    this.loadAdminPage();
    this.startModelFailureAutoRefresh();
    this.startAutoFaceFailureAutoRefresh();
  },

  onUnload() {
    this._adminLoadToken = (this._adminLoadToken || 0) + 1;
    this.stopModelFailureAutoRefresh();
    this.stopAutoFaceFailureAutoRefresh();
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
    const autoFaceFailureSelectedMonth = hasOwnValue("autoFaceFailureSelectedMonth")
      ? overrides.autoFaceFailureSelectedMonth
      : this.data.autoFaceFailureSelectedMonth;
    const modelFailureSelectedMonth = hasOwnValue("modelFailureSelectedMonth")
      ? overrides.modelFailureSelectedMonth
      : this.data.modelFailureSelectedMonth;
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
      todayFailureText: buildTodayFailureText(usageStats, moduleStates),
      modelFailureView: buildModelFailureView(
        usageStats && usageStats.failureStats,
        modelFailureSelectedMonth
      ),
      autoFaceFailureView: buildAutoFaceFailureView(
        autoFaceFailureStats,
        autoFaceFailureSelectedMonth
      )
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
        "",
        currentStates[key] && currentStates[key].updatedAtText || "尚未更新"
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
        formatted && formatted.message,
        formatAdminDate(new Date())
      );
      const patch = {};
      if (!unavailable || !previousState.hasData) {
        Object.assign(patch, applyResult(formatted));
      }
      if (options.loadingKey) patch[options.loadingKey] = false;
      patch.moduleStates = nextStates;
      if (unavailable && MONITOR_SECTION_KEYS.includes(key)) {
        patch.monitorExpanded = true;
        patch[`monitorSections.${key}`] = true;
      }
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
        message,
        formatAdminDate(new Date())
      );
      const patch = {
        moduleStates: nextStates
      };
      if (options.loadingKey) patch[options.loadingKey] = false;
      if (MONITOR_SECTION_KEYS.includes(key)) {
        patch.monitorExpanded = true;
        patch[`monitorSections.${key}`] = true;
      }
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
        () => cloud.getAdminUserStats(0, 20, buildUserStatsFilters(this.data)),
        formatUserStats,
        (userStats) => ({ userStats }),
        {
          label: "用户统计",
          loadingKey: "userStatsLoading"
        }
      ),
      this.loadAdminModule(
        token,
        "diagnosticLogs",
        () => cloud.getAdminDiagnosticLogs({
          offset: 0,
          limit: 20,
          hours: this.data.diagnosticHours,
          level: this.data.monitorOnlyAbnormal ? "abnormal" : this.data.diagnosticLevel,
          category: this.data.diagnosticCategory,
          userHash: this.data.diagnosticUserHash
        }),
        (result) => formatAdminDiagnosticLogs(result),
        (diagnosticLogs) => ({ diagnosticLogs }),
        {
          label: "用户端日志",
          loadingKey: "diagnosticLogsLoading"
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
      diagnosticLogsLoading: false,
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

  async refreshModelUsage(options = {}) {
    if (this.data.usageLoading) return;
    const silent = Boolean(options && options.silent);
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
      if (!silent) wx.showToast({ title: "统计已刷新", icon: "success" });
    } else {
      if (silent) {
        diagnosticLog.warn("admin", "model-failure-auto-refresh-failed", "模型失败统计自动刷新失败", {
          error: result.error
        });
      } else {
        this.showError("统计刷新失败", result.error || new Error("统计读取失败，请稍后重试。"));
      }
    }
  },

  startModelFailureAutoRefresh() {
    this.stopModelFailureAutoRefresh();
    this._modelFailureRefreshTimer = setInterval(() => {
      if (
        !this.data.isAdmin
        || this.data.usageLoading
        || this.data.loading
      ) {
        return;
      }
      this.refreshModelUsage({ silent: true });
    }, MODEL_FAILURE_AUTO_REFRESH_MS);
  },

  stopModelFailureAutoRefresh() {
    if (this._modelFailureRefreshTimer) {
      clearInterval(this._modelFailureRefreshTimer);
      this._modelFailureRefreshTimer = null;
    }
  },

  selectModelFailureMonth(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.modelFailureView.monthOptions || [];
    const monthKey = options[index] || options[0] || "";
    this.setData({
      modelFailureSelectedMonth: monthKey
    }, () => {
      this.setData(this.buildAdminDerivedPatch({
        modelFailureSelectedMonth: monthKey
      }, this.data.moduleStates));
    });
  },

  openModelFailureUserDetail(event) {
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    const user = this.data.modelFailureView.users[index];
    if (!user) return;
    const details = this.data.modelFailureView.details
      .filter((item) => item.userHash === user.userHash);
    this.setData({
      modelFailureDetailOpen: true,
      modelFailureDetail: Object.assign({}, user, { details })
    });
  },

  closeModelFailureUserDetail() {
    this.setData({
      modelFailureDetailOpen: false,
      modelFailureDetail: null
    });
  },

  startAutoFaceFailureAutoRefresh() {
    this.stopAutoFaceFailureAutoRefresh();
    this._autoFaceFailureRefreshTimer = setInterval(() => {
      if (
        !this.data.isAdmin
        || this.data.autoFaceFailureLoading
        || this.data.loading
      ) {
        return;
      }
      this.refreshAutoFaceFailureStats({ silent: true });
    }, AUTO_FACE_FAILURE_AUTO_REFRESH_MS);
  },

  stopAutoFaceFailureAutoRefresh() {
    if (this._autoFaceFailureRefreshTimer) {
      clearInterval(this._autoFaceFailureRefreshTimer);
      this._autoFaceFailureRefreshTimer = null;
    }
  },

  async refreshAutoFaceFailureStats(options = {}) {
    if (this.data.autoFaceFailureLoading) return;
    const silent = Boolean(options && options.silent);
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
      if (!silent) wx.showToast({ title: "失败统计已刷新", icon: "success" });
    } else {
      if (silent) {
        diagnosticLog.warn("admin", "auto-face-failure-auto-refresh-failed", "自动刷新失败统计失败", {
          error: result.error
        });
      } else {
        this.showError(
          "失败统计刷新失败",
          result.error || new Error("统计读取失败，请稍后重试。")
        );
      }
    }
  },

  selectAutoFaceFailureMonth(event) {
    const index = Number(event && event.detail && event.detail.value);
    const options = this.data.autoFaceFailureView.monthOptions || [];
    const monthKey = options[index] || options[0] || "";
    this.setData({
      autoFaceFailureSelectedMonth: monthKey
    }, () => {
      this.setData(this.buildAdminDerivedPatch({
        autoFaceFailureSelectedMonth: monthKey
      }, this.data.moduleStates));
    });
  },

  openAutoFaceFailureUserDetail(event) {
    const index = Number(event && event.currentTarget && event.currentTarget.dataset.index);
    const user = this.data.autoFaceFailureView.users[index];
    if (!user) return;
    const details = this.data.autoFaceFailureView.details
      .filter((item) => item.userHash === user.userHash);
    this.setData({
      autoFaceFailureDetailOpen: true,
      autoFaceFailureDetail: Object.assign({}, user, { details })
    });
  },

  closeAutoFaceFailureUserDetail() {
    this.setData({
      autoFaceFailureDetailOpen: false,
      autoFaceFailureDetail: null
    });
  },

  noop() {},

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

  onUserSearchInput(event) {
    this.setData({
      userSearchInput: String(event && event.detail && event.detail.value || "").slice(0, 32)
    });
  },

  applyUserSearch() {
    const search = String(this.data.userSearchInput || "").trim().slice(0, 32);
    this.setData({
      userSearchInput: search,
      userSearch: search
    }, () => this.refreshUserStats(true));
  },

  clearUserSearch() {
    if (!this.data.userSearchInput && !this.data.userSearch) return;
    this.setData({
      userSearchInput: "",
      userSearch: ""
    }, () => this.refreshUserStats(true));
  },

  selectUserDateRange(event) {
    if (this.data.userStatsLoading) return;
    const dateRange = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.range
        : ""
    );
    if (!["all", "today", "7d", "30d", "custom"].includes(dateRange)
      || dateRange === this.data.userDateRange) {
      return;
    }
    this.setData({ userDateRange: dateRange }, () => this.refreshUserStats(true));
  },

  selectUserGender(event) {
    if (this.data.userStatsLoading) return;
    const gender = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.gender
        : ""
    );
    if (!["all", "male", "female"].includes(gender)
      || gender === this.data.userGender) {
      return;
    }
    this.setData({ userGender: gender }, () => this.refreshUserStats(true));
  },

  onUserCustomStartChange(event) {
    if (this.data.userStatsLoading) return;
    const startDate = String(event && event.detail && event.detail.value || "");
    if (!startDate) return;
    const endDate = startDate > this.data.userCustomEndDate
      ? startDate
      : this.data.userCustomEndDate;
    this.setData({
      userDateRange: "custom",
      userCustomStartDate: startDate,
      userCustomEndDate: endDate
    }, () => this.refreshUserStats(true));
  },

  onUserCustomEndChange(event) {
    if (this.data.userStatsLoading) return;
    const endDate = String(event && event.detail && event.detail.value || "");
    if (!endDate) return;
    const startDate = endDate < this.data.userCustomStartDate
      ? endDate
      : this.data.userCustomStartDate;
    this.setData({
      userDateRange: "custom",
      userCustomStartDate: startDate,
      userCustomEndDate: endDate
    }, () => this.refreshUserStats(true));
  },

  openUserDetail(event) {
    const index = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.index
        : -1
    );
    const user = this.data.userStats.users[index];
    if (!user) return;
    this.setData({
      selectedUserDetail: user,
      userDetailVisible: true
    });
  },

  closeUserDetail() {
    this.setData({
      userDetailVisible: false,
      selectedUserDetail: null
    });
  },

  stopUserDetailTap() {},

  async refreshUserStats(reset = true) {
    if (this.data.userStatsLoading) return;
    const shouldReset = reset !== false;
    const offset = shouldReset ? 0 : this.data.userStats.nextOffset;
    if (!shouldReset && (offset === null || offset === undefined)) return;
    const previousUsers = shouldReset ? [] : this.data.userStats.users;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "users",
      () => cloud.getAdminUserStats(
        offset || 0,
        20,
        buildUserStatsFilters(this.data)
      ),
      (rawResult) => formatUserStats(rawResult, previousUsers),
      (userStats) => ({ userStats }),
      {
        label: "用户统计",
        loadingKey: "userStatsLoading"
      }
    );
    if (result.stale) return;
    if (result.ok && shouldReset) {
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

  selectDiagnosticHours(event) {
    const hours = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.hours
        : 0
    );
    if (![1, 6, 24, 72].includes(hours) || hours === this.data.diagnosticHours) return;
    this.setData({ diagnosticHours: hours }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticLevel(event) {
    const level = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.level
        : ""
    );
    if (!["all", "error", "warn", "info"].includes(level)
      || level === this.data.diagnosticLevel) {
      return;
    }
    this.setData({ diagnosticLevel: level }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticCategory(event) {
    const category = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.category
        : ""
    );
    if (!category || category === this.data.diagnosticCategory) return;
    this.setData({ diagnosticCategory: category }, () => this.refreshDiagnosticLogs(true));
  },

  selectDiagnosticUser(event) {
    const index = Math.max(0, Number(event && event.detail && event.detail.value) || 0);
    const option = this.data.diagnosticLogs.userOptions[index] || { value: "" };
    this.setData({
      diagnosticUserIndex: index,
      diagnosticUserHash: option.value || "",
      diagnosticUserLabel: option.label || "全部用户"
    }, () => this.refreshDiagnosticLogs(true));
  },

  async refreshDiagnosticLogs(reset = true) {
    if (this.data.diagnosticLogsLoading) return;
    const shouldReset = reset !== false;
    const offset = shouldReset ? 0 : this.data.diagnosticLogs.nextOffset;
    if (!shouldReset && (offset === null || offset === undefined)) return;
    const previousLogs = shouldReset ? [] : this.data.diagnosticLogs.logs;
    const result = await this.loadAdminModule(
      this._adminLoadToken || 0,
      "diagnosticLogs",
      () => cloud.getAdminDiagnosticLogs({
        offset: offset || 0,
        limit: 20,
        hours: this.data.diagnosticHours,
        level: this.data.monitorOnlyAbnormal ? "abnormal" : this.data.diagnosticLevel,
        category: this.data.diagnosticCategory,
        userHash: this.data.diagnosticUserHash
      }),
      (rawResult) => {
        const formatted = formatAdminDiagnosticLogs(rawResult, previousLogs);
        if (!shouldReset) formatted.logs = previousLogs.concat(formatted.logs);
        return formatted;
      },
      (diagnosticLogs) => ({
        diagnosticLogs,
        diagnosticUserIndex: Math.max(
          0,
          diagnosticLogs.userOptions.findIndex(
            (item) => item.value === this.data.diagnosticUserHash
          )
        ),
        diagnosticUserLabel: (
          diagnosticLogs.userOptions.find(
            (item) => item.value === this.data.diagnosticUserHash
          ) || { label: "全部用户" }
        ).label
      }),
      {
        label: "用户端日志",
        loadingKey: "diagnosticLogsLoading"
      }
    );
    if (result.stale) return;
    if (!result.ok) {
      this.showError(
        "用户端日志刷新失败",
        result.error || new Error("日志读取失败，请稍后重试。")
      );
    }
  },

  loadMoreDiagnosticLogs() {
    this.refreshDiagnosticLogs(false);
  },

  toggleDiagnosticLogDetail(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.diagnosticLogs.logs[index];
    if (!item || !item.hasDetails) return;
    this.setData({
      [`diagnosticLogs.logs[${index}].expanded`]: !item.expanded
    });
  },

  copyDiagnosticLog(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.diagnosticLogs.logs[index];
    if (!item) return;
    wx.setClipboardData({
      data: diagnosticLogCopyText(item),
      success: () => wx.showToast({ title: "日志已复制", icon: "success" })
    });
  },

  async exportUserStats() {
    if (this.data.userStatsExporting) return;
    this.setData({ userStatsExporting: true });
    try {
      const result = await cloud.exportAdminUserStats(buildUserStatsFilters(this.data));
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
      diagnosticLogsLoading: true,
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
        () => cloud.getAdminUserStats(0, 20, buildUserStatsFilters(this.data)),
        formatUserStats,
        (userStats) => ({ userStats }),
        { label: "用户统计", loadingKey: "userStatsLoading" }
      ),
      this.loadAdminModule(
        token,
        "diagnosticLogs",
        () => cloud.getAdminDiagnosticLogs({
          offset: 0,
          limit: 20,
          hours: this.data.diagnosticHours,
          level: this.data.monitorOnlyAbnormal ? "abnormal" : this.data.diagnosticLevel,
          category: this.data.diagnosticCategory,
          userHash: this.data.diagnosticUserHash
        }),
        (result) => formatAdminDiagnosticLogs(result),
        (diagnosticLogs) => ({ diagnosticLogs }),
        { label: "用户端日志", loadingKey: "diagnosticLogsLoading" }
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
        "用户端日志",
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
    const item = this.data.modelFailureView.details[index];
    if (!item) return;
    wx.setClipboardData({
      data: modelFailureCopyText(item),
      success: () => wx.showToast({ title: "错误已复制", icon: "success" })
    });
  },

  copyAutoFaceFailure(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.autoFaceFailureView.recent[index];
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

  copyFaceConfigToAnalysis() {
    const face = this.data.form && this.data.form.face
      ? this.data.form.face
      : emptyForm().face;
    this.setData({
      "form.analysis.provider": face.provider || "",
      "form.analysis.baseUrl": face.baseUrl || "",
      "form.analysis.endpoint": face.endpoint || "",
      "form.analysis.model": face.model || "",
      "form.analysis.timeoutMs": String(face.timeoutMs || "30000"),
      message: "已复制人脸配置到图片分析；点击“保存全部配置”后才会生效。"
    });
    wx.showToast({ title: "已复制，记得保存", icon: "none" });
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
    }, () => this.persistMonitorLayout());
  },

  async exportModelFailureStats() {
    if (this.data.modelFailureExporting) return;
    const monthKey = this.data.modelFailureView.selectedMonth
      || this.data.usageStats.todayKey.slice(0, 7);
    this.setData({ modelFailureExporting: true });
    try {
      const result = await cloud.exportModelFailureStats(monthKey);
      if (!result || !result.fileID) throw new Error("失败统计 Excel 生成失败。");
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
      this.setData({ modelFailureExporting: false });
      wx.showToast({ title: "失败统计已导出", icon: "success" });
    } catch (error) {
      this.setData({ modelFailureExporting: false });
      diagnosticLog.error("admin", "model-failure-export-failed", "模型失败统计 Excel 导出失败", { error });
      this.showError("导出失败", error);
    }
  },

  toggleMonitorSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.section
        : ""
    );
    if (!MONITOR_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`monitorSections.${section}`]: !this.data.monitorSections[section]
    }, () => this.persistMonitorLayout());
  },

  setAllMonitorSections(event) {
    const expanded = Number(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.expanded
        : 0
    ) === 1;
    const patch = {};
    MONITOR_SECTION_KEYS.forEach((section) => {
      patch[`monitorSections.${section}`] = expanded;
    });
    USAGE_SECTION_KEYS.forEach((section) => {
      patch[`usageSections.${section}`] = expanded;
    });
    AUTO_FACE_FAILURE_SECTION_KEYS.forEach((section) => {
      patch[`autoFaceFailureSections.${section}`] = expanded;
    });
    this.setData(patch, () => this.persistMonitorLayout());
  },

  restoreMonitorLayout() {
    let stored = {};
    try {
      stored = wx.getStorageSync(MONITOR_LAYOUT_STORAGE_KEY) || {};
    } catch (error) {
      stored = {};
    }
    const storedMonitorSections = stored.monitorSections || {};
    const storedUsageSections = stored.usageSections || {};
    const storedAutoFaceFailureSections = stored.autoFaceFailureSections || {};
    const monitorSections = {};
    MONITOR_SECTION_KEYS.forEach((section) => {
      monitorSections[section] = typeof storedMonitorSections[section] === "boolean"
        ? storedMonitorSections[section]
        : Boolean(this.data.monitorSections[section]);
    });
    const usageSections = {};
    USAGE_SECTION_KEYS.forEach((section) => {
      usageSections[section] = typeof storedUsageSections[section] === "boolean"
        ? storedUsageSections[section]
        : Boolean(this.data.usageSections[section]);
    });
    const autoFaceFailureSections = {};
    AUTO_FACE_FAILURE_SECTION_KEYS.forEach((section) => {
      autoFaceFailureSections[section] = typeof storedAutoFaceFailureSections[section] === "boolean"
        ? storedAutoFaceFailureSections[section]
        : Boolean(this.data.autoFaceFailureSections[section]);
    });
    this.setData({
      monitorExpanded: typeof stored.monitorExpanded === "boolean"
        ? stored.monitorExpanded
        : this.data.monitorExpanded,
      monitorSections,
      usageSections,
      autoFaceFailureSections,
      monitorOnlyAbnormal: Boolean(stored.monitorOnlyAbnormal)
    });
  },

  async exportAutoFaceFailureStats() {
    if (this.data.autoFaceFailureExporting) return;
    const monthKey = this.data.autoFaceFailureView.selectedMonth
      || this.data.autoFaceFailureStats.todayKey.slice(0, 7);
    this.setData({ autoFaceFailureExporting: true });
    try {
      const result = await cloud.exportAutoFaceFailureStats(monthKey);
      if (!result || !result.fileID) throw new Error("失败统计 Excel 生成失败。");
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
      this.setData({ autoFaceFailureExporting: false });
      wx.showToast({ title: "失败统计已导出", icon: "success" });
    } catch (error) {
      this.setData({ autoFaceFailureExporting: false });
      diagnosticLog.error("admin", "auto-face-failure-export-failed", "自动贴脸失败统计 Excel 导出失败", {
        error,
        monthKey
      });
      this.showError("导出失败", error);
    }
  },

  persistMonitorLayout() {
    try {
      wx.setStorageSync(MONITOR_LAYOUT_STORAGE_KEY, {
        version: 3,
        monitorExpanded: Boolean(this.data.monitorExpanded),
        monitorSections: Object.assign({}, this.data.monitorSections),
        usageSections: Object.assign({}, this.data.usageSections),
        autoFaceFailureSections: Object.assign({}, this.data.autoFaceFailureSections),
        monitorOnlyAbnormal: Boolean(this.data.monitorOnlyAbnormal)
      });
    } catch (error) {
      // 本地缓存不可用时不影响管理页继续使用。
    }
  },

  toggleUsageSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.usageSection
        : ""
    );
    if (!USAGE_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`usageSections.${section}`]: !this.data.usageSections[section]
    }, () => this.persistMonitorLayout());
  },

  toggleAutoFaceFailureSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.autoFaceFailureSection
        : ""
    );
    if (!AUTO_FACE_FAILURE_SECTION_KEYS.includes(section)) return;
    this.setData({
      [`autoFaceFailureSections.${section}`]: !this.data.autoFaceFailureSections[section]
    }, () => this.persistMonitorLayout());
  },

  jumpToMonitorSection(event) {
    const section = String(
      event && event.currentTarget && event.currentTarget.dataset
        ? event.currentTarget.dataset.section
        : ""
    );
    if (!MONITOR_SECTION_KEYS.includes(section)) return;
    this.setData({
      monitorExpanded: true,
      [`monitorSections.${section}`]: true
    }, () => {
      this.persistMonitorLayout();
      if (typeof wx.pageScrollTo === "function") {
        wx.pageScrollTo({
          selector: `#monitor-section-${section}`,
          duration: 220
        });
      }
    });
  },

  toggleMonitorOnlyAbnormal() {
    this.setData({
      monitorOnlyAbnormal: !this.data.monitorOnlyAbnormal,
      monitorExpanded: true,
      "monitorSections.diagnosticLogs": true,
      "monitorSections.usage": true,
      "usageSections.failure": true
    }, () => {
      this.persistMonitorLayout();
      this.refreshDiagnosticLogs(true);
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

  probeModels() {
    return this.runModelProbe("");
  },

  probeSingleModel(event) {
    const modelType = String(
      event && event.currentTarget && event.currentTarget.dataset.modelType || ""
    ).trim();
    if (!modelType) return;
    return this.runModelProbe(modelType);
  },

  async runModelProbe(modelType = "") {
    if (this.data.modelProbing) return;
    const typeLabel = modelType ? usageTypeLabel(modelType) : "四套模型";
    this.setData({
      modelProbing: true,
      modelProbingType: modelType || "all",
      message: `正在探测${typeLabel}接口...`
    });
    try {
      const result = await cloud.probeModels(modelType);
      const formatted = formatModelProbes(result);
      const modelProbes = modelType
        ? mergeSingleModelProbe(this.data.modelProbes, formatted, modelType)
        : formatted;
      const target = modelType
        ? modelProbes.results.find((item) => item.type === modelType)
        : null;
      this.setData({
        modelProbing: false,
        modelProbingType: "",
        modelProbes,
        monitorExpanded: true,
        message: modelType && target
          ? `${target.typeLabel}探测完成：${target.statusText}。`
          : `模型接口探测完成：${modelProbes.readyCount}/${modelProbes.total} 套正常。`
      });
      wx.showToast({
        title: modelType && target
          ? `${target.typeLabel}${target.statusText}`
          : modelProbes.readyCount === modelProbes.total
            ? "四套模型均正常"
            : `${modelProbes.readyCount}/${modelProbes.total} 套正常`,
        icon: modelType
          ? target && target.ready ? "success" : "none"
          : modelProbes.readyCount === modelProbes.total ? "success" : "none"
      });
    } catch (error) {
      const formatted = formatModelProbes(error && error.payload, error);
      const modelProbes = modelType && formatted.results.length
        ? mergeSingleModelProbe(this.data.modelProbes, formatted, modelType)
        : this.data.modelProbes;
      this.setData({
        modelProbing: false,
        modelProbingType: "",
        modelProbes,
        monitorExpanded: true,
        message: `${typeLabel}接口探测失败，请查看结果说明。`
      });
      diagnosticLog.error(
        "admin",
        "model-probe-failed",
        `${typeLabel}接口探测失败`,
        { error, modelType }
      );
      this.showError("探测失败", error);
    }
  },

  backToWorkbench() {
    wx.reLaunch({ url: "/pages/workbench/workbench" });
  },

  showError(title, error) {
    const payload = error && error.payload;
    const originalMessage = (payload && (payload.message || payload.error))
      || (error && error.message)
      || "请稍后重试";
    const modelTypeLabel = payload && payload.modelTypeLabel
      ? String(payload.modelTypeLabel)
      : "";
    const message = modelTypeLabel
      && !String(originalMessage).startsWith(`${modelTypeLabel}模型：`)
      ? `${modelTypeLabel}模型：${originalMessage}`
      : originalMessage;
    wx.showModal({
      title,
      content: String(message),
      showCancel: false
    });
  }
});
