const config = require("../../config");
const accountService = require("../../services/account");
const accountUi = require("../../utils/account-ui");
const accountDemo = require("../../utils/account-demo");

function settled(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
}

function errorMessage(error, fallback) {
  return accountUi.userErrorMessage(error, fallback);
}

function isAccountServiceNotDeployed(result) {
  return Boolean(
    result
    && !result.ok
    && accountUi.accountErrorCode(result.error) === "ACCOUNT_SERVICE_NOT_DEPLOYED"
  );
}

Page({
  data: {
    // 版本号来自当前包内配置，便于确认开发者工具实际加载的是哪个包。
    loadedAppVersion: String(config.appVersion || "未知"),
    loading: true,
    profile: accountUi.normalizeProfile(),
    account: {
      pointsBalanceText: "--",
      totalPurchasedPointsText: "--"
    },
    recentRecords: [],
    profileError: "",
    accountError: "",
    recordsError: "",
    rechargeConfigError: "",
    accountServicePreparing: false,
    rechargeVisible: false,
    rechargeDisabled: true,
    redeemVisible: true,
    rechargeHint: "",
    hasAnyError: false,
    visualDemoAvailable: false,
    visualDemoEnabled: false,
    visualDemoControlVisible: false
  },

  onLoad(options = {}) {
    this.setDemoMode(options);
  },

  setDemoMode(options = {}) {
    const mode = accountDemo.resolve(options);
    this._demoMode = mode;
    this._demoEnabled = mode.enabled;
    this._accountClient = mode.enabled ? accountDemo.createAdapter() : accountService;
    this.setData({
      visualDemoAvailable: mode.available,
      visualDemoEnabled: mode.enabled,
      visualDemoControlVisible: mode.showControl
    });
    return mode;
  },

  onShow() {
    if (!this._demoMode) this.setDemoMode({});
    this._pageVisible = true;
    this._navigating = false;
    this.loadUserCenter();
  },

  onHide() {
    this._pageVisible = false;
  },

  onUnload() {
    this._pageVisible = false;
    this._loadToken = (this._loadToken || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadUserCenter().finally(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  async loadUserCenter() {
    const service = this._accountClient || accountService;
    const loadToken = (this._loadToken || 0) + 1;
    this._loadToken = loadToken;
    this.setData({
      loading: true,
      profileError: "",
      accountError: "",
      recordsError: "",
      rechargeConfigError: "",
      accountServicePreparing: false,
      hasAnyError: false
    });

    const [profileResult, overviewResult, configResult] = await Promise.all([
      settled(service.getUserProfile({ retryLimit: 0, silent: true })),
      settled(service.getAccountOverview()),
      settled(service.getRechargeConfig())
    ]);
    if (loadToken !== this._loadToken) return;

    const accountServicePreparing = (
      !overviewResult.ok
      && !configResult.ok
      && (
        isAccountServiceNotDeployed(overviewResult)
        && isAccountServiceNotDeployed(configResult)
      )
    );
    const nextData = {
      loading: false,
      accountServicePreparing
    };
    if (profileResult.ok && !(profileResult.value && profileResult.value.unavailable)) {
      nextData.profile = accountUi.normalizeProfile(profileResult.value);
    } else {
      nextData.profileError = errorMessage(
        profileResult.error,
        "头像和昵称读取失败，可下拉重试。"
      );
    }

    if (overviewResult.ok) {
      const overview = overviewResult.value || {};
      nextData.account = accountUi.normalizeAccount(overview);
      nextData.recentRecords = accountUi
        .normalizeRecords(overview.recentRecords || overview.records || [])
        .slice(0, 3);
      if (overview.recordsUnavailable) {
        nextData.recordsError = "最近记录暂时无法读取。";
      }
    } else if (accountServicePreparing) {
      nextData.account = {
        pointsBalanceText: "--",
        totalPurchasedPointsText: "--"
      };
      nextData.recentRecords = [];
    } else {
      nextData.account = {
        pointsBalanceText: "--",
        totalPurchasedPointsText: "--"
      };
      nextData.recentRecords = [];
      nextData.accountError = errorMessage(
        overviewResult.error,
        "余额读取失败，请稍后重试。"
      );
      nextData.recordsError = "最近记录暂时无法读取。";
    }

    if (accountServicePreparing) {
      nextData.rechargeVisible = false;
      nextData.rechargeDisabled = true;
      nextData.rechargeHint = "账户功能准备中";
    } else if (configResult.ok) {
      const config = accountUi.normalizeRechargeConfig(configResult.value);
      const paymentAvailable = config.hasWxpay || config.hasAlipay;
      nextData.rechargeVisible = config.eligible;
      nextData.rechargeDisabled = !paymentAvailable;
      nextData.rechargeHint = !config.eligible
        ? config.message || "充值服务暂未开放"
        : !paymentAvailable
          ? config.message || "支付通道准备中"
          : "";
    } else if (overviewResult.ok && isAccountServiceNotDeployed(configResult)) {
      // payment-api 尚未上线时，余额仍可由已上线的 api 积分链路提供；
      // 保留充值入口，让用户知道功能位置；入口必须保持禁用，不能绕过服务端开关。
      nextData.rechargeVisible = true;
      nextData.rechargeDisabled = true;
      nextData.rechargeHint = "充值服务暂未开放";
      nextData.rechargeConfigError = "";
    } else {
      nextData.rechargeVisible = false;
      nextData.rechargeDisabled = true;
      nextData.rechargeConfigError = errorMessage(
        configResult.error,
        "充值状态读取失败，请稍后重试。"
      );
    }

    nextData.hasAnyError = Boolean(
      nextData.profileError
      || nextData.accountError
      || nextData.recordsError
      || nextData.rechargeConfigError
    );
    this.setData(nextData);
  },

  retryLoad() {
    this.loadUserCenter();
  },

  navigate(url, failureTitle) {
    if (this._navigating) return;
    this._navigating = true;
    wx.navigateTo({
      url,
      fail: () => {
        this._navigating = false;
        wx.showToast({ title: failureTitle, icon: "none" });
      }
    });
  },

  openRecharge() {
    if (this.data.accountServicePreparing) {
      wx.showToast({ title: "账户功能准备中", icon: "none" });
      return;
    }
    if (!this.data.rechargeVisible) {
      wx.showToast({
        title: this.data.rechargeConfigError || this.data.rechargeHint || "充值服务暂未开放",
        icon: "none"
      });
      return;
    }
    if (this.data.rechargeDisabled) {
      wx.showToast({
        title: this.data.rechargeHint || "支付通道准备中",
        icon: "none"
      });
      return;
    }
    this.navigate(
      accountDemo.pageUrl("/pages/recharge/recharge", this._demoEnabled),
      "充值页打开失败"
    );
  },

  openRedeem() {
    this.navigate(
      accountDemo.pageUrl("/pages/redeem/redeem", this._demoEnabled),
      "兑换页打开失败"
    );
  },

  openAccountRecords() {
    this.navigate(
      accountDemo.pageUrl("/pages/account-records/account-records", this._demoEnabled),
      "收支记录打开失败"
    );
  },

  toggleVisualDemo(event) {
    if (!this._demoMode || !this._demoMode.available) return;
    const enabled = Boolean(event && event.detail && event.detail.value);
    wx.redirectTo({
      url: accountDemo.pageUrl("/pages/user-center/user-center", enabled),
      fail: () => wx.showToast({ title: "演示模式切换失败", icon: "none" })
    });
  }
});
