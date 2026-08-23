const config = require("../../config");
const cloud = require("../../services/cloud");
const diagnosticLog = require("../../utils/diagnostic-log");
const pointsUi = require("../../utils/points-ui");

function buildCheckInToast(result = {}) {
  const copy = config.points.copy;
  const duplicate = Boolean(result.duplicate);
  const earned = Number(result.earnedToday) || 0;
  return {
    title: duplicate
      ? copy.checkInDuplicate
      : `${copy.checkInSuccessPrefix}${earned}${copy.checkInSuccessSuffix}`,
    icon: duplicate ? "none" : "success"
  };
}

function normalizePoints(result = {}) {
  const source = result && typeof result === "object" ? result : {};
  const streak = Math.max(0, Number(source.currentStreak) || 0);
  const streakDays = Number(source.streakDays) || config.points.streakDays;
  const progress = streak > 0 && streak % streakDays === 0
    ? streakDays
    : streak % streakDays;
  return {
    accountBound: Boolean(source.accountBound),
    boundMessage: source.boundMessage || config.points.copy.defaultBoundMessage,
    pointsBalance: Math.max(0, Number(source.pointsBalance) || 0),
    totalEarned: Math.max(0, Number(source.totalEarned) || 0),
    totalSpent: Math.max(0, Number(source.totalSpent) || 0),
    imageCost: Math.max(0, Number(source.imageCost) || config.points.imageCost),
    videoCost: Math.max(0, Number(source.videoCost) || config.points.videoCost),
    currentStreak: streak,
    checkedInToday: Boolean(source.checkedInToday),
    freeRemaining: Math.max(0, Number(source.freeRemaining) || 0),
    freeLimit: Math.max(0, Number(source.freeLimit) || config.points.dailyFreeLimit),
    promoActive: Boolean(source.promoActive),
    promoStartDate: source.promoStartDate || config.points.promoStartDate,
    promoEndDate: source.promoEndDate || config.points.promoEndDate,
    checkinPoints: Number(source.checkinPoints) || config.points.checkinPoints,
    streakBonus: Number(source.streakBonus) || config.points.streakBonus,
    streakDays,
    progress,
    progressPercent: Math.min(100, Math.max(0, progress / streakDays * 100)),
    nextCheckinReward: Math.max(
      0,
      Number(source.nextCheckinReward)
        || Number(source.checkinPoints)
        || Number(config.points.checkinPoints)
    ),
    billingMode: source.billingMode || "daily-free"
  };
}

function normalizeLedger(item = {}) {
  const amount = Number(item.amount) || 0;
  return {
    id: item.id || item._id || `ledger-${Date.now()}`,
    amount,
    amountText: amount > 0 ? `+${amount}` : String(amount),
    amountClass: amount > 0 ? "ledger-income" : amount < 0 ? "ledger-expense" : "ledger-free",
    description: item.description || config.points.copy.ledgerDefaultDescription,
    createdAt: item.createdAt
      ? String(item.createdAt).replace("T", " ").replace(/\.\d+Z$/, "")
      : config.points.copy.justNow,
    type: item.type || ""
  };
}

Page({
  data: {
    appVersion: config.appVersion,
    pointsCopy: config.points.copy,
    loading: true,
    checkingIn: false,
    message: "",
    points: normalizePoints(),
    ledger: []
  },

  onShow() {
    this.loadPoints();
    this.schedulePromoRefresh();
  },

  onHide() {
    this.clearPromoRefreshTimer();
  },

  onUnload() {
    this.clearPromoRefreshTimer();
  },

  onPullDownRefresh() {
    this.loadPoints().finally(() => wx.stopPullDownRefresh());
  },

  async loadPoints() {
    if (!cloud.isCloudReady()) {
      this.setData({
        loading: false,
        points: normalizePoints({ accountBound: false }),
        message: config.points.copy.localPreviewMessage
      });
      this.schedulePromoRefresh();
      return;
    }
    this.setData({ loading: true, message: "" });
    try {
      const [pointsResult, ledgerResult] = await Promise.all([
        cloud.getUserPoints(),
        cloud.getPointLedger()
      ]);
      this.setData({
        loading: false,
        points: normalizePoints(pointsResult),
        ledger: (ledgerResult && ledgerResult.records || []).map(normalizeLedger)
      });
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
    const request = this.performCheckIn();
    this._checkInPromise = request;
    const clearCheckInLock = () => {
      if (this._checkInPromise === request) {
        this._checkInPromise = null;
      }
    };
    request.then(clearCheckInLock, clearCheckInLock);
    return request;
  },

  async performCheckIn() {
    this.setData({ checkingIn: true, message: "" });
    try {
      const result = await cloud.checkIn();
      const checkInMessage = result.duplicate
        ? config.points.copy.checkInDuplicate
        : `${config.points.copy.checkInSuccessPrefix}${result.earnedToday || 0}${config.points.copy.checkInSuccessSuffix}`;
      this.setData({
        checkingIn: false,
        points: normalizePoints(result),
        message: checkInMessage
      });
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
