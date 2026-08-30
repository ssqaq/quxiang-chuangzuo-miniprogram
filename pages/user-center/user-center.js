const accountService = require("../../services/account");
const accountUi = require("../../utils/account-ui");

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
    rechargeHint: "",
    hasAnyError: false
  },

  onShow() {
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
      settled(accountService.getUserProfile({ retryLimit: 0, silent: true })),
      settled(accountService.getAccountOverview()),
      settled(accountService.getRechargeConfig())
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
      nextData.rechargeVisible = config.eligible;
      nextData.rechargeDisabled = !config.hasWxpay;
      nextData.rechargeHint = !config.eligible
        ? config.message || "充值服务暂未开放"
        : !config.hasWxpay
          ? config.message || "支付通道准备中"
          : "";
    } else if (overviewResult.ok && isAccountServiceNotDeployed(configResult)) {
      // payment-api 尚未上线时，余额仍可由已上线的 api 积分链路提供；
      // 只关闭充值入口，不要再把整张账户卡误报成“准备中”。
      nextData.rechargeVisible = false;
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
    this.navigate("/pages/recharge/recharge", "充值页打开失败");
  },

  openAccountRecords() {
    if (this.data.accountServicePreparing) {
      wx.showToast({ title: "账户功能准备中", icon: "none" });
      return;
    }
    this.navigate("/pages/account-records/account-records", "收支记录打开失败");
  }
});
