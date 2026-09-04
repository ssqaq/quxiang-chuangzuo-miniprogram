const config = require("../../config");
const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");
const pointsUi = require("../../utils/points-ui");
const accountUi = require("../../utils/account-ui");

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finiteNumber(value, fallback));
}

function buildCheckInToast(result = {}) {
  const copy = config.points.copy;
  const duplicate = Boolean(result.duplicate);
  const earned = finiteNumber(result.earnedToday, 0);
  return {
    title: duplicate
      ? copy.checkInDuplicate
      : `${copy.checkInSuccessPrefix}${accountUi.formatPoints(earned, { fallback: "0" })}${copy.checkInSuccessSuffix}`,
    icon: duplicate ? "none" : "success"
  };
}

function normalizePoints(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const streak = nonNegative(source.currentStreak, 0);
  const streakDays = finiteNumber(source.streakDays, config.points.streakDays);
  const freeLimit = Math.max(
    0,
    finiteNumber(source.freeLimit, config.points.dailyFreeLimit)
  );
  const freeRemaining = Math.min(
    freeLimit,
    nonNegative(source.freeRemaining, 0)
  );
  const freeUsed = Math.max(0, freeLimit - freeRemaining);
  const progress = streak > 0 && streak % streakDays === 0
    ? streakDays
    : streak % streakDays;
  return {
    accountBound: Boolean(source.accountBound),
    boundMessage: source.boundMessage || config.points.copy.defaultBoundMessage,
    pointsBalance: nonNegative(source.pointsBalance, 0),
    pointsBalanceText: accountUi.formatPoints(nonNegative(source.pointsBalance, 0), { fallback: "0" }),
    totalEarned: nonNegative(source.totalEarned, 0),
    totalEarnedText: accountUi.formatPoints(nonNegative(source.totalEarned, 0), { fallback: "0" }),
    totalSpent: nonNegative(source.totalSpent, 0),
    totalSpentText: accountUi.formatPoints(nonNegative(source.totalSpent, 0), { fallback: "0" }),
    imageCost: nonNegative(source.imageCost, config.points.imageCost),
    imageCostText: accountUi.formatPoints(nonNegative(source.imageCost, config.points.imageCost), { fallback: "0" }),
    videoCost: nonNegative(source.videoCost, config.points.videoCost),
    videoCostText: accountUi.formatPoints(nonNegative(source.videoCost, config.points.videoCost), { fallback: "0" }),
    currentStreak: streak,
    checkedInToday: Boolean(source.checkedInToday),
    freeRemaining,
    freeLimit,
    freeUsed,
    freeUsagePercent: freeLimit > 0
      ? Math.min(100, Math.max(0, freeUsed / freeLimit * 100))
      : 0,
    promoActive: Boolean(source.promoActive),
    promoStartDate: source.promoStartDate || config.points.promoStartDate,
    promoEndDate: source.promoEndDate || config.points.promoEndDate,
    promoLabel: pointsUi.buildPromoLabel(
      source.promoStartDate || config.points.promoStartDate,
      source.promoEndDate || config.points.promoEndDate
    ),
    checkinPoints: nonNegative(source.checkinPoints, config.points.checkinPoints),
    checkinPointsText: accountUi.formatPoints(
      nonNegative(source.checkinPoints, config.points.checkinPoints),
      { fallback: "0" }
    ),
    streakBonus: nonNegative(source.streakBonus, config.points.streakBonus),
    streakBonusText: accountUi.formatPoints(
      nonNegative(source.streakBonus, config.points.streakBonus),
      { fallback: "0" }
    ),
    streakDays,
    progress,
    progressPercent: Math.min(100, Math.max(0, progress / streakDays * 100)),
    nextCheckinReward: Math.max(
      0,
      finiteNumber(
        source.nextCheckinReward,
        finiteNumber(source.checkinPoints, config.points.checkinPoints)
      )
    ),
    nextCheckinRewardText: accountUi.formatPoints(
      nonNegative(
        source.nextCheckinReward,
        finiteNumber(source.checkinPoints, config.points.checkinPoints)
      ),
      { fallback: "0" }
    ),
    billingMode: source.billingMode || "daily-free"
  };
}

function normalizeLedger(item = {}) {
  const amount = finiteNumber(item.amount, 0);
  return {
    id: item.id || item._id || `ledger-${Date.now()}`,
    amount,
    amountText: accountUi.formatPoints(amount, { signed: true, fallback: "0" }),
    amountClass: amount > 0 ? "ledger-income" : amount < 0 ? "ledger-expense" : "ledger-free",
    description: item.description || config.points.copy.ledgerDefaultDescription,
    createdAt: item.createdAt
      ? String(item.createdAt).replace("T", " ").replace(/\.\d+Z$/, "")
      : config.points.copy.justNow,
    type: item.type || ""
  };
}

function filterLedger(records = [], filter = "all") {
  if (filter === "income") {
    return records.filter((item) => item.amount > 0);
  }
  if (filter === "expense") {
    return records.filter((item) => item.amount < 0);
  }
  return records;
}

Page({
  data: {
    appVersion: config.appVersion,
    pointsCopy: config.points.copy,
    loading: true,
    checkingIn: false,
    message: "",
    points: normalizePoints(),
    ledger: [],
    visibleLedger: [],
    ledgerFilter: "all",
    animatedPointsBalance: 0,
    animatedCurrentStreak: 0,
    animatedFreeRemaining: 0,
    animatedTotalEarned: 0,
    checkinCelebrationVisible: false,
    checkinCelebrationText: ""
  },

  onShow() {
    this.loadPoints();
    this.schedulePromoRefresh();
  },

  onHide() {
    this.clearPromoRefreshTimer();
    this.stopDashboardNumberAnimation();
    this.clearCheckinCelebrationTimer();
  },

  onUnload() {
    this.clearPromoRefreshTimer();
    this.stopDashboardNumberAnimation();
    this.clearCheckinCelebrationTimer();
  },

  onPullDownRefresh() {
    this.loadPoints().finally(() => wx.stopPullDownRefresh());
  },

  async loadPoints() {
    if (!cloud.isCloudReady()) {
      const points = normalizePoints({ accountBound: false });
      const ledger = [];
      this.setData({
        loading: false,
        points,
        ledger,
        visibleLedger: filterLedger(ledger, this.data.ledgerFilter),
        message: config.points.copy.localPreviewMessage
      });
      this.animateDashboardNumbers(points);
      this.schedulePromoRefresh();
      return;
    }
    this.setData({ loading: true, message: "" });
    try {
      const [pointsResult, ledgerResult] = await Promise.all([
        cloud.getUserPoints(),
        cloud.getPointLedger()
      ]);
      const points = normalizePoints(pointsResult);
      const ledger = (ledgerResult && ledgerResult.records || []).map(normalizeLedger);
      this.setData({
        loading: false,
        points,
        ledger,
        visibleLedger: filterLedger(ledger, this.data.ledgerFilter)
      });
      this.animateDashboardNumbers(points);
    } catch (error) {
      this.setData({
        loading: false,
        message: config.points.copy.loadFailedMessage
      });
      diagnosticLog.error("points", "load-failed", "积分页读取失败", { error });
    } finally {
      this.schedulePromoRefresh();
    }
  },

  animateDashboardNumbers(points = {}) {
    this.stopDashboardNumberAnimation();
    this.setData({
      animatedPointsBalance: accountUi.formatPoints(points.pointsBalance, { fallback: "0" }),
      animatedTotalEarned: accountUi.formatPoints(points.totalEarned, { fallback: "0" })
    });
    const targets = {
      animatedCurrentStreak: Math.max(0, Number(points.currentStreak) || 0),
      animatedFreeRemaining: Math.max(0, Number(points.freeRemaining) || 0)
    };
    const keys = Object.keys(targets);
    const starts = keys.reduce((result, key) => {
      result[key] = Math.max(0, Number(this.data[key]) || 0);
      return result;
    }, {});
    const startTime = Date.now();
    const duration = 560;
    const tick = () => {
      const progress = Math.min(1, (Date.now() - startTime) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const values = keys.reduce((result, key) => {
        result[key] = Math.round(
          starts[key] + (targets[key] - starts[key]) * eased
        );
        return result;
      }, {});
      this.setData(values);
      if (progress >= 1) {
        this._dashboardNumberTimer = null;
        return;
      }
      this._dashboardNumberTimer = setTimeout(tick, 32);
    };
    tick();
  },

  stopDashboardNumberAnimation() {
    if (this._dashboardNumberTimer) {
      clearTimeout(this._dashboardNumberTimer);
      this._dashboardNumberTimer = null;
    }
  },

  clearCheckinCelebrationTimer() {
    if (this._checkinCelebrationTimer) {
      clearTimeout(this._checkinCelebrationTimer);
      this._checkinCelebrationTimer = null;
    }
  },

  showCheckinCelebration(text) {
    this.clearCheckinCelebrationTimer();
    this.setData({
      checkinCelebrationVisible: true,
      checkinCelebrationText: text
    });
    this._checkinCelebrationTimer = setTimeout(() => {
      this._checkinCelebrationTimer = null;
      this.setData({ checkinCelebrationVisible: false });
    }, 1800);
  },

  onLedgerFilterTap(event) {
    const filter = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.filter
      : "all";
    if (["all", "income", "expense"].indexOf(filter) === -1) return;
    this.setData({
      ledgerFilter: filter,
      visibleLedger: filterLedger(this.data.ledger, filter)
    });
  },

  clearPromoRefreshTimer() {
    if (this._promoRefreshTimer) {
      clearTimeout(this._promoRefreshTimer);
      this._promoRefreshTimer = null;
    }
  },

  schedulePromoRefresh() {
    this.clearPromoRefreshTimer();
    const points = this.data.points || {};
    const remaining = pointsUi.getPromoRefreshDelay(
      points.promoEndDate || config.points.promoEndDate
    );
    if (remaining <= 0) {
      if (points.promoActive) {
        this.setData({ "points.promoActive": false });
      }
      return;
    }
    const wait = Math.min(remaining, pointsUi.MAX_TIMER_DELAY_MS);
    this._promoRefreshTimer = setTimeout(() => {
      this._promoRefreshTimer = null;
      if (remaining > pointsUi.MAX_TIMER_DELAY_MS) {
        this.schedulePromoRefresh();
        return;
      }
      if (this.data.points && this.data.points.promoActive) {
        this.setData({ "points.promoActive": false });
      }
      this.loadPoints();
    }, wait);
    if (
      this._promoRefreshTimer
      && typeof this._promoRefreshTimer.unref === "function"
    ) {
      this._promoRefreshTimer.unref();
    }
  },

  checkIn() {
    if (this._checkInPromise) return this._checkInPromise;
    if (this.data.checkingIn || this.data.points.checkedInToday) {
      return Promise.resolve();
    }
    if (!cloud.isCloudReady()) {
      wx.showToast({ title: config.points.copy.cloudRequired, icon: "none" });
      return Promise.resolve();
    }
    const request = this.checkProfileAndCheckIn();
    this._checkInPromise = request;
    const clearCheckInLock = () => {
      if (this._checkInPromise === request) {
        this._checkInPromise = null;
      }
    };
    request.then(clearCheckInLock, clearCheckInLock);
    return request;
  },

  async checkProfileAndCheckIn() {
    this.setData({ checkingIn: true, message: "" });
    try {
      const profile = await cloud.getMyUserProfile({ retryLimit: 0 });
      if (!profile || !profile.completed) {
        this.setData({ checkingIn: false });
        wx.navigateTo({ url: "/pages/profile/profile?from=checkin" });
        return;
      }
    } catch (error) {
      this.setData({ checkingIn: false });
      wx.showModal({
        title: "签到前检查失败",
        content: String(error && error.message || "请稍后重试。"),
        showCancel: false
      });
      return;
    }
    return this.performCheckIn();
  },

  async performCheckIn() {
    this.setData({ checkingIn: true, message: "" });
    try {
      const result = await cloud.checkIn();
      const checkInMessage = result.duplicate
        ? config.points.copy.checkInDuplicate
        : `${config.points.copy.checkInSuccessPrefix}${accountUi.formatPoints(result.earnedToday, { fallback: "0" })}${config.points.copy.checkInSuccessSuffix}`;
      const points = normalizePoints(result);
      this.setData({
        checkingIn: false,
        points,
        message: checkInMessage
      });
      this.animateDashboardNumbers(points);
      if (!result.duplicate) {
        this.showCheckinCelebration(checkInMessage);
      }
      await this.loadPoints();
      this.setData({ message: checkInMessage });
      wx.showToast(buildCheckInToast(result));
    } catch (error) {
      this.setData({ checkingIn: false });
      const payload = error && error.payload;
      const message = payload && payload.message
        || error && error.message
        || config.points.copy.checkInFailedFallback;
      diagnosticLog.error("points", "checkin-failed", "签到失败", { error });
      wx.showModal({
        title: config.points.copy.checkInFailedTitle,
        content: String(message),
        showCancel: false
      });
    }
  },

  backToWorkbench() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: "/pages/workbench/workbench" })
    });
  }
});
