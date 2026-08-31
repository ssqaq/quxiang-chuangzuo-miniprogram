const cloud = require("../../services/cloud");

const VIEW_DEFS = [
  {
    key: "usage",
    label: "用量",
    title: "模型用量统计",
    eyebrow: "USAGE DASHBOARD",
    description: "按功能查看模型调用次数、Token、视频秒数和预计成本。",
    refreshLabel: "刷新统计",
    exportLabel: "导出 Excel"
  },
  {
    key: "points",
    label: "积分",
    title: "积分管理",
    eyebrow: "POINTS MANAGEMENT",
    description: "查看已经保存的积分规则；发放、消耗和余额需要对应的汇总接口。",
    refreshLabel: "刷新规则",
    exportLabel: "暂无导出"
  },
  {
    key: "cost",
    label: "成本",
    title: "成本统计",
    eyebrow: "COST DASHBOARD",
    description: "按供应商、模型和功能查看预计成本，快速找出费用高的调用。",
    refreshLabel: "刷新成本",
    exportLabel: "导出报表"
  },
  {
    key: "users",
    label: "用户",
    title: "用户管理",
    eyebrow: "USER MANAGEMENT",
    description: "查看已完善资料的用户、注册趋势和当前用户列表。",
    refreshLabel: "刷新用户",
    exportLabel: "导出名单"
  }
];

const POINT_RULES = [
  { key: "dailyFreeLimit", label: "每日免费次数", suffix: " 次" },
  { key: "imageCost", label: "生图消耗", suffix: " 积分/次" },
  { key: "videoCost", label: "视频消耗", suffix: " 积分/次" },
  { key: "checkinPoints", label: "每日签到", suffix: " 积分" },
  { key: "streakBonus", label: "连续奖励", suffix: " 积分" },
  { key: "streakDays", label: "连续奖励天数", suffix: " 天" }
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function numberValue(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function formatNumber(value) {
  const number = numberValue(value, 0);
  return String(Math.round(number * 100) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatCost(value) {
  return `¥${numberValue(value, 0).toFixed(2)}`;
}

function formatPercent(value) {
  return `${Math.round(numberValue(value, 0) * 10) / 10}%`;
}

function unwrap(result) {
  if (!result || result.ok === false) return null;
  if (result.data && typeof result.data === "object" && !result.today && !result.summary && !result.users && !result.effective) {
    return result.data;
  }
  return result;
}

function viewByKey(key) {
  return VIEW_DEFS.find(item => item.key === key) || VIEW_DEFS[0];
}

function navigationLayout() {
  let windowInfo = {};
  let menuButton = {};
  try {
    if (typeof wx !== "undefined" && typeof wx.getWindowInfo === "function") {
      windowInfo = wx.getWindowInfo() || {};
    } else if (typeof wx !== "undefined" && typeof wx.getSystemInfoSync === "function") {
      windowInfo = wx.getSystemInfoSync() || {};
    }
  } catch (error) {
    windowInfo = {};
  }
  try {
    if (typeof wx !== "undefined" && typeof wx.getMenuButtonBoundingClientRect === "function") {
      menuButton = wx.getMenuButtonBoundingClientRect() || {};
    }
  } catch (error) {
    menuButton = {};
  }
  const statusBarHeight = Math.max(0, Number(windowInfo.statusBarHeight) || 0);
  const windowWidth = Math.max(320, Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375);
  const menuTop = Number(menuButton.top);
  const menuHeight = Number(menuButton.height);
  const menuLeft = Number(menuButton.left);
  const hasMenuButton = Number.isFinite(menuTop)
    && Number.isFinite(menuHeight)
    && Number.isFinite(menuLeft)
    && menuHeight > 0
    && menuLeft > 0;
  const navigationBarHeight = hasMenuButton
    ? Math.max(52, (menuTop - statusBarHeight) * 2 + menuHeight)
    : 52;
  const navigationHeight = Math.round(statusBarHeight + navigationBarHeight);
  const capsuleRightInset = hasMenuButton
    ? Math.round(Math.max(14, windowWidth - menuLeft + 8))
    : 14;
  return {
    appbarStyle: `height:${navigationHeight}px;padding-top:${Math.round(statusBarHeight)}px;padding-right:${capsuleRightInset}px`,
    operationsScrollStyle: `height:calc(100vh - ${navigationHeight}px)`
  };
}

const INITIAL_NAVIGATION_LAYOUT = navigationLayout();

function counterTotal(counter) {
  return numberValue(counter && counter.total, 0);
}

function summaryTotal(summary) {
  return ["face", "analysis", "image", "video"].reduce((total, key) => total + counterTotal(summary && summary[key]), 0);
}

function typeLabel(key) {
  return {
    face: "人脸识别",
    analysis: "图片分析",
    image: "生图模型",
    video: "视频模型"
  }[key] || key;
}

function row(title, detail, bodyLines = []) {
  return {
    title,
    detail,
    bodyLines: Array.isArray(bodyLines) ? bodyLines : [],
    expanded: false
  };
}

function emptySummary() {
  return [
    { label: "今日调用", value: "—" },
    { label: "本月调用", value: "—" },
    { label: "失败", value: "—" }
  ];
}

function emptyViewData() {
  return {
    summary: emptySummary(),
    detailRows: [],
    footNote: "正在读取真实数据。",
    empty: false
  };
}

function buildUsageView(source) {
  const today = source.today || {};
  const summary = source.summary || {};
  const rangeTotal = summaryTotal(summary);
  const failureStats = source.failureStats || {};
  const failureTotal = numberValue(failureStats.total, numberValue(today.failure, 0));
  const totalForRate = rangeTotal || numberValue(failureStats.total, 0);
  const failureRate = totalForRate ? failureTotal / totalForRate * 100 : 0;
  const typeLines = ["face", "analysis", "image", "video"].map(key => `${typeLabel(key)} ${formatNumber(counterTotal(summary[key]))} 次`);
  const modelLines = (Array.isArray(source.models) ? source.models : []).slice(0, 8).map(item => `${item.provider || "未填写供应商"} · ${item.model || "未填写模型"}：${formatNumber(item.total)} 次`);
  return {
    summary: [
      { label: "今日调用", value: formatNumber(today.total) },
      { label: "本月调用", value: formatNumber(rangeTotal) },
      { label: "失败", value: formatNumber(today.failure) }
    ],
    detailRows: [
      row("模型调用失败统计", `失败 ${formatNumber(failureTotal)} 次 · 失败率 ${formatPercent(failureRate)}`, (Array.isArray(failureStats.topFailureReasons) ? failureStats.topFailureReasons : []).slice(0, 5).map(item => `${item.label || "未提供错误原因"}：${formatNumber(item.count)} 次`)),
      row("运行监控", `统计范围 ${formatNumber(source.days || 30)} 天 · 记录 ${source.eventCount === undefined ? "—" : formatNumber(source.eventCount)} 条`, [source.truncated ? "记录达到读取上限，结果可能被截断。" : "统计接口已返回当前范围数据。", source.todayKey ? `最新统计日：${source.todayKey}` : "暂无最新统计日期。"]),
      row("功能用量明细", typeLines.join(" · "), typeLines.concat(modelLines))
    ],
    footNote: "统计数据按功能和供应商汇总；点击展开后可继续查看单个模型明细。",
    empty: false
  };
}

function buildCostView(source) {
  const today = source.today || {};
  const last30 = source.last30d || {};
  const summary = source.summary || {};
  const models = Array.isArray(source.models) ? source.models : [];
  const providerMap = {};
  models.forEach(item => {
    const key = item.provider || "未填写供应商";
    providerMap[key] = numberValue(providerMap[key], 0) + numberValue(item.estimatedCost, 0);
  });
  const providerLines = Object.keys(providerMap).sort((left, right) => providerMap[right] - providerMap[left]).slice(0, 8).map(key => `${key}：${formatCost(providerMap[key])}`);
  const typeLines = ["face", "analysis", "image", "video"].map(key => `${typeLabel(key)}：${formatCost(summary[key] && summary[key].estimatedCost)}`);
  const unavailable = numberValue(last30.unavailableCostCount, numberValue(today.unavailableCostCount, 0));
  return {
    summary: [
      { label: "今日成本", value: formatCost(today.estimatedCost) },
      { label: "近30天成本", value: formatCost(last30.estimatedCost) },
      { label: "待核对费用", value: formatNumber(unavailable) }
    ],
    detailRows: [
      row("供应商成本", providerLines.length ? providerLines.join(" · ") : "暂无按供应商统计", providerLines),
      row("功能成本", typeLines.join(" · "), typeLines),
      row("异常费用", unavailable ? `${formatNumber(unavailable)} 条调用没有完整价格` : "当前没有缺少价格的调用", [unavailable ? "这些调用仍计入预计成本，请补齐对应成本规则后再核对。" : "当前统计范围内没有发现缺少价格的调用。"])
    ],
    footNote: "当前为预计成本；最终金额以各供应商账单为准。",
    empty: false
  };
}

function buildUsersView(source) {
  const users = Array.isArray(source.users) ? source.users : [];
  const trend = Array.isArray(source.signupTrend) ? source.signupTrend : [];
  const todaySignup = trend.length ? trend[trend.length - 1].count : 0;
  const userLines = users.slice(0, 8).map(item => `${item.nickname || "未填写昵称"} · ${item.genderText || "未填写性别"} · ${item.userHash || "anonymous"}`);
  const trendLines = trend.slice(-7).map(item => `${item.dateKey || "未知日期"}：${formatNumber(item.count)} 人`);
  return {
    summary: [
      { label: "总用户", value: formatNumber(source.total) },
      { label: "今日新增", value: formatNumber(todaySignup) },
      { label: "异常", value: "—" }
    ],
    detailRows: [
      row("用户列表", `已完善资料 ${formatNumber(source.total)} 人 · 当前显示 ${formatNumber(users.length)} 条`, userLines),
      row("用户状态", "当前接口未提供状态分组汇总", ["如需区分正常、限制使用和已停用，需要增加对应统计字段。"]),
      row("注册趋势", `最近 ${formatNumber(trend.length || 0)} 天 · 今日新增 ${formatNumber(todaySignup)} 人`, trendLines)
    ],
    footNote: "这里显示已保存个人资料的用户，不是小程序访问人数；敏感字段不会在此页展示。",
    empty: false
  };
}

function extractPoints(result) {
  const source = unwrap(result) || {};
  const effective = source.effective || source.config || source;
  const points = effective && effective.points && typeof effective.points === "object" ? effective.points : {};
  return POINT_RULES.reduce((output, rule) => {
    if (points[rule.key] !== undefined && points[rule.key] !== null && String(points[rule.key]).trim() !== "") {
      output[rule.key] = `${points[rule.key]}${rule.suffix}`;
    }
    return output;
  }, {});
}

function buildPointsView(points) {
  const hasRules = Object.keys(points || {}).length > 0;
  const rows = POINT_RULES.map(rule => row(
    rule.label,
    points[rule.key] || "未配置",
    points[rule.key] ? [`当前规则：${points[rule.key]}`] : ["配置接口没有返回这一项规则。"]
  ));
  return {
    summary: [
      { label: "总发放", value: "—" },
      { label: "已消耗", value: "—" },
      { label: "剩余", value: "—" }
    ],
    detailRows: rows,
    footNote: hasRules
      ? "当前没有积分发放、消耗和余额汇总接口，下面只显示已保存规则，不伪造统计数字。"
      : "当前没有积分汇总接口，也没有读取到积分规则；不会伪造发放、消耗或余额。",
    empty: !hasRules
  };
}

Page({
  data: {
    appbarStyle: INITIAL_NAVIGATION_LAYOUT.appbarStyle,
    operationsScrollStyle: INITIAL_NAVIGATION_LAYOUT.operationsScrollStyle,
    loading: true,
    busy: false,
    source: "local",
    activeView: "usage",
    viewTitle: "模型用量统计",
    eyebrow: "USAGE DASHBOARD",
    description: "按功能查看模型调用次数、Token、视频秒数和预计成本。",
    refreshLabel: "刷新统计",
    exportLabel: "导出 Excel",
    viewTabs: VIEW_DEFS,
    summary: emptySummary(),
    detailRows: [],
    footNote: "正在读取真实数据。",
    empty: false,
    message: ""
  },

  onLoad(options) {
    this.applyNavigationLayout();
    const key = options && options.view ? options.view : "usage";
    this.setView(key, false);
  },

  applyNavigationLayout() {
    this.setData(navigationLayout());
  },

  onResize() {
    this.applyNavigationLayout();
  },

  onPullDownRefresh() {
    this.loadData(true);
  },

  setView(key, load = true) {
    const view = viewByKey(key);
    this.setData({
      activeView: view.key,
      viewTitle: view.title,
      eyebrow: view.eyebrow,
      description: view.description,
      refreshLabel: view.refreshLabel,
      exportLabel: view.exportLabel,
      message: ""
    });
    if (load) this.loadData();
    else this.loadData();
  },

  switchView(event) {
    const key = event.currentTarget.dataset.view || "usage";
    this.setView(key, true);
  },

  async loadData(refreshing = false) {
    const activeView = this.data.activeView;
    this.setData({ loading: !refreshing, busy: true, message: "" });
    let result = null;
    let errorMessage = "";
    try {
      if (activeView === "usage" || activeView === "cost") {
        if (cloud && typeof cloud.getModelUsageStats === "function") result = await cloud.getModelUsageStats(30);
        else errorMessage = "当前环境没有模型统计接口。";
      } else if (activeView === "users") {
        if (cloud && typeof cloud.getAdminUserStats === "function") result = await cloud.getAdminUserStats(0, 20, {});
        else errorMessage = "当前环境没有用户统计接口。";
      } else if (cloud && typeof cloud.getAdminConfig === "function") {
        result = await cloud.getAdminConfig({ retryLimit: 0, silent: true });
      } else if (cloud && typeof cloud.getAdminConfigV2 === "function") {
        result = await cloud.getAdminConfigV2({ retryLimit: 0, silent: true });
      } else {
        errorMessage = "当前环境没有配置读取接口。";
      }
    } catch (error) {
      errorMessage = error && error.message ? String(error.message) : "读取数据失败。";
    }
    const source = unwrap(result);
    let built = emptyViewData();
    if (source) {
      if (activeView === "usage") built = buildUsageView(source);
      else if (activeView === "cost") built = buildCostView(source);
      else if (activeView === "users") built = buildUsersView(source);
      else built = buildPointsView(extractPoints(result));
    } else if (activeView === "points") {
      built = buildPointsView({});
    } else {
      built = Object.assign(emptyViewData(), { empty: true, footNote: errorMessage || "接口没有返回数据，请稍后重试。" });
    }
    this.setData(Object.assign({}, built, {
      loading: false,
      busy: false,
      source: source ? "cloud" : "local",
      message: errorMessage
    }));
    if (refreshing && typeof wx !== "undefined" && wx.stopPullDownRefresh) wx.stopPullDownRefresh();
  },

  refreshCurrent() {
    this.loadData(true);
  },

  toggleRow(event) {
    const index = Number(event.currentTarget.dataset.index);
    const rows = clone(this.data.detailRows || []);
    if (!rows[index]) return;
    rows[index].expanded = !rows[index].expanded;
    this.setData({ detailRows: rows });
  },

  async exportCurrent() {
    const activeView = this.data.activeView;
    if (activeView === "points") {
      this.setData({ message: "积分目前没有导出接口，未生成虚假文件。" });
      if (wx.showToast) wx.showToast({ title: "暂无积分导出接口", icon: "none" });
      return;
    }
    this.setData({ busy: true, message: "正在生成文件..." });
    let result = null;
    try {
      if (activeView === "users" && cloud && typeof cloud.exportAdminUserStats === "function") {
        result = await cloud.exportAdminUserStats({});
      } else if (cloud && typeof cloud.exportModelUsageStats === "function") {
        result = await cloud.exportModelUsageStats(30);
      }
      if (!result || result.ok === false || !result.fileID) throw new Error("文件生成接口没有返回可下载文件。");
      await this.openExportResult(result);
      this.setData({ busy: false, message: result.message || "文件已生成" });
    } catch (error) {
      const message = error && error.message ? String(error.message) : "文件生成失败。";
      this.setData({ busy: false, message });
      if (wx.showToast) wx.showToast({ title: "导出失败", icon: "none" });
    }
  },

  async openExportResult(result) {
    if (!result || !result.fileID || !cloud || typeof cloud.downloadFile !== "function" || !wx.openDocument) return;
    const filePath = await cloud.downloadFile(result.fileID);
    if (!filePath) return;
    await new Promise((resolve, reject) => {
      wx.openDocument({ filePath, fileType: "xlsx", showMenu: true, success: resolve, fail: reject });
    });
  },

  openProvider() {
    wx.navigateTo({ url: "/pages/admin-provider/admin-provider" });
  },

  openConfig() {
    wx.navigateTo({ url: "/pages/admin-config/admin-config" });
  },

  backToDashboard() {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 });
      return;
    }
    wx.navigateTo({ url: "/pages/admin-dashboard/admin-dashboard" });
  }
});
