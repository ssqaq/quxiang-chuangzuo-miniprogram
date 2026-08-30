const accountService = require("../../services/account");
const paymentLauncher = require("../../services/payment-launcher");
const accountUi = require("../../utils/account-ui");

const PENDING_ORDER_KEY = "account_pending_recharge_order_v1";
const QUERY_ATTEMPTS = 3;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPendingOrder() {
  try {
    const value = wx.getStorageSync(PENDING_ORDER_KEY);
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    return null;
  }
}

function savePendingOrder(order) {
  try {
    wx.setStorageSync(PENDING_ORDER_KEY, order);
  } catch (error) {
    console.warn("保存待确认订单失败", error);
  }
}

function clearPendingOrder() {
  try {
    wx.removeStorageSync(PENDING_ORDER_KEY);
  } catch (error) {
    console.warn("清理待确认订单失败", error);
  }
}

function orderStatus(result) {
  return String(
    result && result.order && result.order.status
      || result && result.status
      || ""
  ).toLowerCase();
}

function confirmationCopy(status, missingLauncher = false) {
  if (status === "review" || status === "refund_review") {
    return {
      title: "人工核对中",
      message: status === "refund_review"
        ? "退款状态正在人工核对，请勿重复付款。"
        : "订单状态正在人工核对，请勿重复付款。"
    };
  }
  if (status === "created" || status === "creation_unknown") {
    return {
      title: "订单创建结果确认中",
      message: "系统会继续确认原订单，请勿重新下单或重复付款。"
    };
  }
  if (missingLauncher) {
    return {
      title: "支付信息确认中",
      message: "订单已保留，但支付信息尚未就绪，请勿重复付款。"
    };
  }
  return {
    title: "支付结果确认中",
    message: status === "paid"
      ? "支付已确认，积分到账处理中，请勿重复付款。"
      : "系统正在确认原订单，请勿重复付款。"
  };
}

function terminalCopy(status) {
  return status === "refunded"
    ? {
      title: "订单已退款",
      message: "该订单已经终止并退款，不会再次发起支付。"
    }
    : {
      title: "订单已关闭",
      message: "该订单已经终止，不会再次发起支付。"
    };
}

Page({
  data: {
    loading: true,
    errorMessage: "",
    eligible: false,
    unavailableMessage: "",
    packages: [],
    selectedProductId: "",
    hasWxpay: false,
    channelMessage: "",
    paying: false,
    paymentStatus: "idle",
    statusTitle: "",
    statusMessage: "",
    lastOrderNo: "",
    currentBalanceText: ""
  },

  onLoad() {
    const pending = readPendingOrder();
    this._pendingOrder = pending;
    if (pending && pending.productId) {
      this.setData({ selectedProductId: String(pending.productId) });
    }
    this.loadRechargeConfig();
  },

  onShow() {
    this._pageVisible = true;
    if (this._didInitialShow) {
      this.restorePendingOrder();
    } else {
      this._didInitialShow = true;
      setTimeout(() => this.restorePendingOrder(), 0);
    }
  },

  onHide() {
    this._pageVisible = false;
  },

  onUnload() {
    this._pageVisible = false;
    this._queryToken = (this._queryToken || 0) + 1;
  },

  onPullDownRefresh() {
    this.loadRechargeConfig().finally(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  async loadRechargeConfig() {
    this.setData({ loading: true, errorMessage: "" });
    try {
      const result = await accountService.getRechargeConfig();
      const config = accountUi.normalizeRechargeConfig(result);
      const selectedExists = config.products.some(
        (item) => item.productId === this.data.selectedProductId
      );
      this.setData({
        loading: false,
        eligible: config.eligible,
        unavailableMessage: config.eligible
          ? ""
          : config.message || "充值暂未向当前账号开放",
        packages: config.products,
        selectedProductId: selectedExists
          ? this.data.selectedProductId
          : config.products.length
            ? config.products[0].productId
            : "",
        hasWxpay: config.hasWxpay,
        channelMessage: config.hasWxpay
          ? ""
          : config.message || "支付通道准备中"
      });
    } catch (error) {
      this.setData({
        loading: false,
        eligible: false,
        packages: [],
        hasWxpay: false,
        errorMessage: accountUi.userErrorMessage(error, "充值配置读取失败，请重试。")
      });
    }
  },

  retryConfig() {
    this.loadRechargeConfig();
  },

  selectPackage(event) {
    if (this.data.paying) return;
    const productId = String(event.currentTarget.dataset.productId || "");
    if (!this.data.packages.some((item) => item.productId === productId)) return;
    const pending = this._pendingOrder || readPendingOrder();
    if (pending && pending.orderNo && pending.productId !== productId) {
      wx.showToast({ title: "请先完成待确认订单", icon: "none" });
      return;
    }
    this.setData({
      selectedProductId: productId,
      paymentStatus: "idle",
      statusTitle: "",
      statusMessage: ""
    });
  },

  async submitPayment() {
    if (this.data.paying || !this.data.eligible || !this.data.hasWxpay) return;
    const selected = this.data.packages.find(
      (item) => item.productId === this.data.selectedProductId
    );
    if (!selected) {
      wx.showToast({ title: "请先选择充值套餐", icon: "none" });
      return;
    }

    const cached = this._pendingOrder || readPendingOrder();
    if (cached && cached.orderNo && cached.productId !== selected.productId) {
      wx.showToast({ title: "请先完成待确认订单", icon: "none" });
      return;
    }
    const requestId = cached && cached.requestId
      ? cached.requestId
      : accountService.createRequestId("recharge");
    const pendingDraft = Object.assign({}, cached || {}, {
      requestId,
      productId: selected.productId,
      createdAt: cached && cached.createdAt || Date.now()
    });
    this._pendingOrder = pendingDraft;
    savePendingOrder(pendingDraft);
    this._paymentFlowActive = true;
    this.setData({
      paying: true,
      paymentStatus: "creating",
      statusTitle: "正在创建订单",
      statusMessage: "请不要重复点击或关闭页面。",
      currentBalanceText: ""
    });

    let paymentAccepted = false;
    let orderNeedsConfirmation = false;
    let confirmationStatus = "";
    let confirmationMissingLauncher = false;
    try {
      const result = await accountService.createRechargeOrder({
        requestId,
        productId: selected.productId
      });
      const order = result && result.order || {};
      const status = orderStatus(result);
      const orderNo = String(order.orderNo || result.orderNo || "");
      const payment = result && (result.payment || result.payParams || result.launcher);

      if (status === "closed" || status === "refunded") {
        const copy = terminalCopy(status);
        clearPendingOrder();
        this._pendingOrder = null;
        this._pendingPayment = null;
        this.setData({
          lastOrderNo: orderNo,
          paymentStatus: "terminated",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }

      if (!orderNo) {
        orderNeedsConfirmation = true;
        confirmationStatus = status || "creation_unknown";
        const copy = confirmationCopy(confirmationStatus, true);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }

      this._pendingOrder = Object.assign({}, pendingDraft, {
        orderNo,
        channel: String(order.channel || "wxpay")
      });
      this._pendingPayment = payment;
      savePendingOrder(this._pendingOrder);
      this.setData({ lastOrderNo: orderNo });

      if (status === "fulfilled" || status === "success") {
        orderNeedsConfirmation = true;
        confirmationStatus = status;
        const copy = confirmationCopy(status);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        await this.confirmOrder(orderNo, QUERY_ATTEMPTS);
        return;
      }

      const mustNotLaunch = [
        "created",
        "creation_unknown",
        "verifying",
        "paid",
        "review",
        "refund_review"
      ].includes(status);
      if (mustNotLaunch || !payment) {
        orderNeedsConfirmation = true;
        confirmationStatus = status;
        confirmationMissingLauncher = !payment;
        const copy = confirmationCopy(status, !payment);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }

      if (status !== "pending") {
        orderNeedsConfirmation = true;
        confirmationStatus = status;
        const copy = confirmationCopy(status);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }

      this.setData({
        paymentStatus: "paying",
        statusTitle: "等待微信支付",
        statusMessage: "请在微信支付窗口完成付款。"
      });

      await paymentLauncher.launchPayment(order.channel || "wxpay", payment);
      paymentAccepted = true;
      this.setData({
        paymentStatus: "confirming",
        statusTitle: "支付结果确认中",
        statusMessage: "正在向支付服务确认到账，请稍候。"
      });
      await this.confirmOrder(orderNo, QUERY_ATTEMPTS);
    } catch (error) {
      const failedOrder = error && error.payload && error.payload.order || null;
      const failedOrderNo = String(failedOrder && failedOrder.orderNo || "");
      if (!paymentAccepted && !orderNeedsConfirmation && failedOrderNo) {
        confirmationStatus = String(failedOrder.status || "creation_unknown").toLowerCase();
        confirmationMissingLauncher = true;
        orderNeedsConfirmation = true;
        this._pendingOrder = Object.assign({}, pendingDraft, {
          orderNo: failedOrderNo,
          channel: String(failedOrder.channel || "wxpay")
        });
        savePendingOrder(this._pendingOrder);
        this.setData({ lastOrderNo: failedOrderNo });
      }
      if (error && error.canceled) {
        this.setData({
          paymentStatus: "canceled",
          statusTitle: "已取消支付",
          statusMessage: "订单仍会保留，再次点击可继续同一笔订单。"
        });
      } else if (paymentAccepted || orderNeedsConfirmation) {
        const copy = confirmationCopy(confirmationStatus, confirmationMissingLauncher);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: paymentAccepted
            ? "支付窗口已完成，查询暂时失败。系统会继续确认，请勿重复付款。"
            : copy.message
        });
      } else {
        this.setData({
          paymentStatus: "failed",
          statusTitle: "充值没有完成",
          statusMessage: accountUi.userErrorMessage(
            error,
            "请稍后重试，系统不会自动重复创建订单。"
          )
        });
      }
    } finally {
      this._paymentFlowActive = false;
      this.setData({ paying: false });
    }
  },

  async confirmOrder(orderNo, attempts = 1) {
    const queryToken = (this._queryToken || 0) + 1;
    this._queryToken = queryToken;
    let lastResult = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await wait(1200);
      if (queryToken !== this._queryToken) return;
      lastResult = await accountService.queryRechargeOrder(orderNo);
      const status = orderStatus(lastResult);
      const order = lastResult && lastResult.order || {};
      const grantPoints = Number(order.grantPoints || lastResult.grantPoints) || 0;
      if (status === "fulfilled" || status === "success") {
        const account = accountUi.normalizeAccount(lastResult && lastResult.account || lastResult);
        clearPendingOrder();
        this._pendingOrder = null;
        this._pendingPayment = null;
        this.setData({
          paymentStatus: "success",
          statusTitle: "充值成功",
          statusMessage: grantPoints > 0 ? `${grantPoints} 积分已到账` : "积分已到账",
          currentBalanceText: account.pointsBalanceText
        });
        return;
      }
      if (status === "closed" || status === "refunded") {
        const copy = terminalCopy(status);
        clearPendingOrder();
        this._pendingOrder = null;
        this._pendingPayment = null;
        this.setData({
          paymentStatus: "terminated",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }
      if (status === "review" || status === "refund_review") {
        const copy = confirmationCopy(status);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }
    }
    this.setData({
      paymentStatus: "confirming",
      statusTitle: "支付结果确认中",
      statusMessage: "结果确认需要一点时间，可稍后下拉刷新或查看收支记录。"
    });
  },

  async restorePendingOrder() {
    if (this._paymentFlowActive || this.data.paying) return;
    const pending = this._pendingOrder || readPendingOrder();
    if (!pending) return;
    this._pendingOrder = pending;
    if (!pending.orderNo) {
      const copy = confirmationCopy("creation_unknown", true);
      this.setData({
        selectedProductId: String(pending.productId || this.data.selectedProductId),
        paymentStatus: "confirming",
        statusTitle: copy.title,
        statusMessage: copy.message
      });
      return;
    }
    this.setData({
      selectedProductId: String(pending.productId || this.data.selectedProductId),
      lastOrderNo: String(pending.orderNo),
      paymentStatus: "confirming",
      statusTitle: "正在恢复订单",
      statusMessage: "正在确认上次支付结果。"
    });
    try {
      await this.confirmOrder(String(pending.orderNo), 1);
    } catch (error) {
      this.setData({
        paymentStatus: "confirming",
        statusTitle: "订单等待确认",
        statusMessage: "暂时无法查询结果，下拉刷新后可再试。"
      });
    }
  },

  openRecords() {
    wx.navigateTo({
      url: "/pages/account-records/account-records",
      fail: () => wx.showToast({ title: "收支记录打开失败", icon: "none" })
    });
  }
});
