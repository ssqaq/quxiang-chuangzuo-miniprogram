const accountService = require("../../services/account");
const accountUi = require("../../utils/account-ui");
const accountDemo = require("../../utils/account-demo");

const PENDING_KEY = "account_pending_redeem_v1";
const CODE_PATTERN = /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{8}$/;

function readPending() {
  try {
    const value = wx.getStorageSync(PENDING_KEY);
    return value && typeof value === "object" ? value : null;
  } catch (_error) {
    return null;
  }
}

function savePending(clientAttemptId, requestId = "") {
  try { wx.setStorageSync(PENDING_KEY, { clientAttemptId: String(clientAttemptId || ""), requestId: String(requestId || "") }); } catch (_error) { /* server remains authoritative */ }
}

function clearPending() {
  try { wx.removeStorageSync(PENDING_KEY); } catch (_error) { /* noop */ }
}

function createUuidV4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === "x" ? value : (value & 3 | 8)).toString(16);
  });
}

Page({
  data: {
    code: "",
    balanceText: "--",
    buttonEnabled: false,
    loading: true,
    submitting: false,
    status: "idle",
    statusTitle: "",
    statusMessage: "",
    statusBalance: ""
  },

  onLoad(options = {}) {
    const mode = accountDemo.resolve(options);
    this._demoMode = mode;
    this._accountClient = mode.enabled ? accountDemo.createAdapter() : accountService;
    this.loadOverview();
  },

  onPullDownRefresh() {
    return this.loadOverview().finally(() => wx.stopPullDownRefresh());
  },

  async loadOverview() {
    this.setData({ loading: true });
    try {
      const result = await (this._accountClient || accountService).getAccountOverview();
      this.setData({ loading: false, balanceText: accountUi.normalizeAccount(result || {}).pointsBalanceText });
      const pending = readPending();
      if (pending && /^[0-9a-f-]{36}$/.test(pending.clientAttemptId || pending.requestId)) await this.restoreRequest(pending);
    } catch (error) {
      this.setData({ loading: false, balanceText: "--", status: "failed", statusTitle: "余额读取失败", statusMessage: accountUi.userErrorMessage(error, "请稍后重试。") });
    }
  },

  onCodeInput(event) {
    const code = String(event && event.detail && event.detail.value || "");
    this.setData({ code, buttonEnabled: CODE_PATTERN.test(code), status: "idle", statusTitle: "", statusMessage: "" });
  },

  async submit() {
    if (!this.data.buttonEnabled || this.data.submitting) return;
    const clientAttemptId = createUuidV4();
    this.setData({ submitting: true, status: "processing", statusTitle: "兑换处理中", statusMessage: "正在核验兑换码，请不要重复点击。" });
    savePending(clientAttemptId);
    try {
      const result = await (this._accountClient || accountService).redeemPoints({ clientAttemptId, code: this.data.code });
      savePending(clientAttemptId, result.requestId);
      this.applyResult(result);
    } catch (error) {
      this.setData({ submitting: false, status: "failed", statusTitle: "兑换失败", statusMessage: accountUi.userErrorMessage(error, "兑换暂时失败，请稍后重试。") });
    }
  },

  async restoreRequest(pending) {
    try {
      this.applyResult(await (this._accountClient || accountService).queryRedeem(pending.requestId, pending.clientAttemptId));
    } catch (_error) {
      this.setData({ status: "processing", statusTitle: "兑换结果确认中", statusMessage: "正在查询上次兑换结果，请稍后查看。" });
    }
  },

  applyResult(result = {}) {
    const status = String(result.status || result.requestStatus || "");
    if (status === "success" || status === "succeeded") {
      clearPending();
      const points = Number(result.points) || 0;
      const balance = result.balance === undefined || result.balance === null ? this.data.balanceText : accountUi.formatPoints(result.balance, { fallback: "0" });
      this.setData({ submitting: false, status: "success", statusTitle: "兑换成功", statusMessage: "已到账 " + points + " 积分", balanceText: balance, statusBalance: "当前余额 " + balance + " 积分" });
      return;
    }
    if (status === "manual_review") {
      savePending(result.clientAttemptId || "", result.requestId);
      this.setData({ submitting: false, status: "manual_review", statusTitle: "正在人工核验", statusMessage: "兑换请求已记录，请稍后查看结果。" });
      return;
    }
    if (status === "processing") {
      savePending(result.clientAttemptId || "", result.requestId);
      this.setData({ submitting: false, status: "processing", statusTitle: "兑换处理中", statusMessage: "兑换结果确认中，请稍后查看。" });
      return;
    }
    clearPending();
    this.setData({ submitting: false, status: "failed", statusTitle: "兑换失败", statusMessage: result.message || "兑换码无效或已使用。" });
  },

  back() {
    const pages = getCurrentPages();
    if (pages && pages.length > 1) wx.navigateBack();
    else wx.redirectTo({ url: "/pages/user-center/user-center" });
  }
});
