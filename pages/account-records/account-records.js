const accountService = require("../../services/account");
const accountUi = require("../../utils/account-ui");

const PAGE_SIZE = 20;

Page({
  data: {
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
    paginationLimited: false
  },

  onLoad() {
    this.loadRecords(true);
  },

  onUnload() {
    this._loadToken = (this._loadToken || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadRecords(true).finally(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  chooseFilter(event) {
    const filter = String(event.currentTarget.dataset.filter || "all");
    if (!this.data.filters.some((item) => item.id === filter)) return;
    if (filter === this.data.activeFilter || this.data.loading || this.data.loadingMore) return;
    this.setData({ activeFilter: filter });
    this.loadRecords(true);
  },

  retryLoad() {
    this.loadRecords(!this.data.records.length);
  },

  loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.loadRecords(false);
  },

  async loadRecords(reset) {
    const loadToken = (this._loadToken || 0) + 1;
    this._loadToken = loadToken;
    const cursor = reset ? "" : String(this.data.nextCursor || "");
    if (reset) {
      this.setData({
        records: [],
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
      const result = await accountService.getAccountRecords({
        cursor,
        limit: PAGE_SIZE,
        type: this.data.activeFilter === "all" ? "" : this.data.activeFilter
      });
      if (loadToken !== this._loadToken) return;
      const items = accountUi.normalizeRecords(result.items || result.records || []);
      const hasMore = Boolean(result.hasMore);
      const nextCursor = typeof result.nextCursor === "string" && result.nextCursor
        ? result.nextCursor
        : null;
      if (hasMore && !nextCursor) {
        const error = new Error("记录翻页信息无效，请刷新后重试。");
        error.code = "PAYMENT_RECORD_CURSOR_MISSING";
        throw error;
      }
      this.setData({
        records: reset ? items : this.data.records.concat(items),
        loading: false,
        loadingMore: false,
        errorMessage: "",
        nextCursor,
        hasMore,
        paginationLimited: Boolean(result.paginationLimited)
      });
    } catch (error) {
      if (loadToken !== this._loadToken) return;
      this.setData({
        loading: false,
        loadingMore: false,
        errorMessage: accountUi.userErrorMessage(error, "收支记录读取失败，请重试。")
      });
    }
  }
});
