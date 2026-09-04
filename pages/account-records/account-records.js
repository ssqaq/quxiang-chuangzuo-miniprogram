const accountService = require("../../services/account");
const accountUi = require("../../utils/account-ui");
const accountDemo = require("../../utils/account-demo");

const PAGE_SIZE = 20;

function requestOptions(options, defaultReset = true) {
  if (typeof options === "boolean") {
    return { reset: options, preserveExisting: false };
  }
  const source = options && typeof options === "object" ? options : {};
  return {
    reset: source.reset === undefined ? defaultReset : source.reset !== false,
    preserveExisting: source.preserveExisting === true
  };
}

Page({
  data: {
    summary: {
      pointsBalanceText: "--",
      totalPurchasedPointsText: "--"
    },
    summaryLoading: true,
    summaryRefreshing: false,
    summaryHasData: false,
    summaryError: "",
    filters: [
      { id: "all", label: "全部" },
      { id: "recharge", label: "充值" },
      { id: "spend", label: "消费" },
      { id: "reward", label: "奖励" },
      { id: "refund", label: "退款" }
    ],
    activeFilter: "all",
    records: [],
    loading: true,
    loadingMore: false,
    errorMessage: "",
    nextCursor: null,
    hasMore: false,
    paginationLimited: false,
    visualDemoAvailable: false,
    visualDemoEnabled: false,
    visualDemoControlVisible: false
  },

  onLoad(options = {}) {
    const mode = accountDemo.resolve(options);
    this._demoMode = mode;
    this._demoEnabled = mode.enabled;
    this._accountClient = mode.enabled ? accountDemo.createAdapter() : accountService;
    this.setData({
      visualDemoAvailable: mode.available,
      visualDemoEnabled: mode.enabled,
      visualDemoControlVisible: mode.showControl
    });
    this._pageVisible = true;
    this.loadSummary({ reset: true });
    this.loadRecords({ reset: true });
  },

  onUnload() {
    this._pageVisible = false;
    this._summaryToken = (this._summaryToken || 0) + 1;
    this._recordsToken = (this._recordsToken || 0) + 1;
  },

  onPullDownRefresh() {
    Promise.all([
      this.loadSummary({ refresh: true, preserveExisting: true }),
      this.loadRecords({ reset: true, preserveExisting: true })
    ]).finally(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  chooseFilter(event) {
    const filter = String(event && event.currentTarget && event.currentTarget.dataset
      && event.currentTarget.dataset.filter || "all");
    if (!this.data.filters.some((item) => item.id === filter)) return Promise.resolve();
    if (filter === this.data.activeFilter || this.data.loading || this.data.loadingMore) {
      return Promise.resolve();
    }
    this.setData({ activeFilter: filter });
    return this.loadRecords({ reset: true });
  },

  retryLoad() {
    return this.loadRecords({
      reset: true,
      preserveExisting: Boolean(this.data.records && this.data.records.length)
    });
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) {
      return Promise.resolve();
    }
    return this.loadRecords({ reset: false });
  },

  async loadSummary(options = {}) {
    const service = this._accountClient || accountService;
    const hasData = Boolean(this.data.summaryHasData);
    const summaryToken = (this._summaryToken || 0) + 1;
    this._summaryToken = summaryToken;
    this.setData({
      summaryLoading: !hasData,
      summaryRefreshing: hasData,
      summaryError: ""
    });

    try {
      const result = await service.getAccountOverview();
      if (summaryToken !== this._summaryToken) return;
      this.setData({
        summary: accountUi.normalizeAccount(result || {}),
        summaryLoading: false,
        summaryRefreshing: false,
        summaryHasData: true,
        summaryError: ""
      });
    } catch (error) {
      if (summaryToken !== this._summaryToken) return;
      this.setData({
        summaryLoading: false,
        summaryRefreshing: false,
        summaryError: accountUi.userErrorMessage(error, "余额读取失败，请稍后重试。")
      });
    }
  },

  async loadRecords(options = true) {
    const service = this._accountClient || accountService;
    const request = requestOptions(options);
    const recordsToken = (this._recordsToken || 0) + 1;
    this._recordsToken = recordsToken;
    const filter = String(this.data.activeFilter || "all");
    const cursor = request.reset ? "" : String(this.data.nextCursor || "");
    const existingRecords = Array.isArray(this.data.records) ? this.data.records : [];
    if (request.reset) {
      this.setData({
        records: request.preserveExisting ? existingRecords : [],
        loading: true,
        loadingMore: false,
        errorMessage: "",
        nextCursor: null,
        hasMore: false,
        paginationLimited: false
      });
    } else {
      this.setData({ loadingMore: true, errorMessage: "" });
    }

    try {
      const result = await service.getAccountRecords({
        cursor,
        limit: PAGE_SIZE,
        type: filter === "all" ? "" : filter
      });
      if (recordsToken !== this._recordsToken) return;
      const sourceItems = result && (result.items || result.records);
      const items = accountUi.normalizeRecords(sourceItems || []);
      const hasMore = Boolean(result && result.hasMore);
      const nextCursor = result && typeof result.nextCursor === "string" && result.nextCursor
        ? result.nextCursor
        : null;
      if (hasMore && !nextCursor) {
        const error = new Error("记录翻页信息无效，请刷新后重试。");
        error.code = "PAYMENT_RECORD_CURSOR_MISSING";
        throw error;
      }
      this.setData({
        records: request.reset ? items : this.data.records.concat(items),
        loading: false,
        loadingMore: false,
        errorMessage: "",
        nextCursor,
        hasMore,
        paginationLimited: Boolean(result.paginationLimited)
      });
    } catch (error) {
      if (recordsToken !== this._recordsToken) return;
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: accountUi.userErrorMessage(error, "收支记录读取失败，请重试。")
      });
    }
  },

  toggleVisualDemo(event) {
    if (!this._demoMode || !this._demoMode.available) return;
    const enabled = Boolean(event && event.detail && event.detail.value);
    wx.redirectTo({
      url: accountDemo.pageUrl("/pages/account-records/account-records", enabled),
      fail: () => wx.showToast({ title: "演示模式切换失败", icon: "none" })
    });
  }
});
