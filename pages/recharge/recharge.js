const accountService = require("../../services/account");
const paymentLauncher = require("../../services/payment-launcher");
const accountUi = require("../../utils/account-ui");
const accountDemo = require("../../utils/account-demo");

const PENDING_ORDER_KEY = "account_pending_recharge_order_v1";
const QUERY_ATTEMPTS = 3;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPendingOrder() {
  try {
    const value = wx.getStorageSync(PENDING_ORDER_KEY);
    return value === null || value === undefined ? null : value;
  } catch (error) {
    return null;
  }
}

function savePendingOrder(order) {
  try {
    wx.setStorageSync(PENDING_ORDER_KEY, order);
    return true;
  } catch (error) {
    console.warn("保存待确认订单失败", error);
    return false;
  }
}

function clearPendingOrder() {
  try {
    wx.removeStorageSync(PENDING_ORDER_KEY);
    return true;
  } catch (error) {
    console.warn("清理待确认订单失败", error);
    return false;
  }
}

function valueText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function selectedPackageDisplay(packages, productId) {
  const selected = (Array.isArray(packages) ? packages : []).find(
    (item) => valueText(item && item.productId) === valueText(productId)
  );
  const grantPoints = selected && selected.grantPoints !== undefined
    ? selected.grantPoints
    : "";
  return {
    selectedAmountText: selected ? valueText(selected.amountText) : "",
    selectedGrantPointsText: selected && accountUi.safeNumber(grantPoints, 0) > 0
      ? accountUi.formatPoints(grantPoints, { signed: true, fallback: "" })
      : ""
  };
}

function pendingKey(pending) {
  return {
    requestId: valueText(pending && pending.requestId),
    orderNo: valueText(pending && pending.orderNo)
  };
}

function hasPendingFields(pending) {
  const requestId = valueText(pending && pending.requestId);
  const productId = valueText(pending && pending.productId);
  return /^[A-Za-z0-9_-]{8,80}$/.test(requestId)
    && accountUi.RECHARGE_PACKAGES.some((item) => item.productId === productId);
}

function samePendingIdentity(left, right) {
  const a = pendingKey(left);
  const b = pendingKey(right);
  return Boolean(
    a.requestId
    && a.orderNo
    && a.requestId === b.requestId
    && a.orderNo === b.orderNo
  );
}

function samePendingSnapshot(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (error) {
    return false;
  }
}

function samePendingRequest(left, right) {
  const leftRequestId = valueText(left && left.requestId);
  const rightRequestId = valueText(right && right.requestId);
  const leftProductId = valueText(left && left.productId);
  const rightProductId = valueText(right && right.productId);
  return Boolean(
    leftRequestId
    && rightRequestId
    && leftProductId
    && rightProductId
    && leftRequestId === rightRequestId
    && leftProductId === rightProductId
  );
}

function removeStoredPending(expected, allowInvalid = false) {
  let current;
  try {
    current = wx.getStorageSync(PENDING_ORDER_KEY);
  } catch (error) {
    return false;
  }
  if (current !== null && current !== undefined) {
    const matches = allowInvalid
      ? samePendingSnapshot(current, expected)
      : samePendingIdentity(current, expected);
    if (!matches) return false;
  }
  return clearPendingOrder();
}

function clearPagePendingOrder(page, expected) {
  if (!samePendingIdentity(page && page._pendingOrder, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  if (!removeStoredPending(expected)) {
    return { ok: false, reason: "storage" };
  }
  page._pendingOrder = null;
  page._pendingPayment = null;
  return { ok: true, reason: "cleared" };
}

function clearPagePendingRequest(page, expected) {
  if (!samePendingRequest(page && page._pendingOrder, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  let current;
  try {
    current = wx.getStorageSync(PENDING_ORDER_KEY);
  } catch (error) {
    return { ok: false, reason: "storage" };
  }
  if (current !== null && current !== undefined && !samePendingRequest(current, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  if (!clearPendingOrder()) return { ok: false, reason: "storage" };
  page._pendingOrder = null;
  page._pendingPayment = null;
  return { ok: true, reason: "cleared" };
}

function markPendingCleanupFailure(page) {
  page.setData({
    paymentStatus: "confirming",
    statusTitle: "订单已确认",
    statusMessage: "本地订单清理失败，请稍后重试。"
  });
}

function discardInvalidPending(page, pending) {
  if (!pending || hasPendingFields(pending)) return pending;
  if (removeStoredPending(pending, true)) {
    if (samePendingSnapshot(page && page._pendingOrder, pending)) {
      page._pendingOrder = null;
      page._pendingPayment = null;
    }
    wx.showToast({ title: "待确认订单信息已失效", icon: "none" });
    return null;
  }
  page._pendingOrder = pending;
  page.setData({
    paymentStatus: "failed",
    statusTitle: "订单信息损坏",
    statusMessage: "本地订单信息无法清理，请稍后重试。"
  });
  return pending;
}

function isOrderNotFound(error) {
  return accountUi.accountErrorCode(error) === "PAYMENT_ORDER_NOT_FOUND";
}

function isPaymentCanceled(error) {
  const code = valueText(
    error && (error.code || error.errorCode || error.errCode)
  ).toUpperCase();
  return Boolean(error && error.canceled)
    || code === "PAYMENT_CANCELED"
    || accountUi.accountErrorCode(error) === "PAYMENT_CANCELED";
}

function isRechargeGateError(error) {
  return [
    "PAYMENT_ORDER_CREATION_DISABLED",
    "PAYMENT_RECHARGE_DISABLED",
    "PAYMENT_NOT_ELIGIBLE",
    "PAYMENT_ACCOUNT_NOT_ELIGIBLE",
    "PAYMENT_CHANNEL_DISABLED"
  ].includes(accountUi.accountErrorCode(error));
}

function isDeterministicNoOrderError(error) {
  return [
    "PAYMENT_ALIPAY_PROTOCOL_UNCONFIRMED",
    "PAYMENT_CHANNEL_DISABLED",
    "PAYMENT_ORDER_CREATION_DISABLED",
    "PAYMENT_NOT_ELIGIBLE",
    "PAYMENT_PRODUCT_INVALID",
    "PAYMENT_CHANNEL_UNSUPPORTED",
    "PAYMENT_ORDER_GUARD_INVALID"
  ].includes(accountUi.accountErrorCode(error));
}

function isIdempotencyConflict(error) {
  return accountUi.accountErrorCode(error) === "IDEMPOTENCY_CONFLICT";
}

async function checkPendingBeforeCreate(page, service, selected, cached) {
  const selectedProductId = valueText(selected && selected.productId);
  const cachedProductId = valueText(cached && cached.productId);
  if (
    cachedProductId
    && cachedProductId === selectedProductId
    && valueText(cached && cached.orderNo)
    && !["canceled", "confirming"].includes(
      String(page && page.data && page.data.paymentStatus || "")
    )
  ) {
    page.setData({
      paymentStatus: "confirming",
      statusTitle: "订单核实中",
      statusMessage: "您有一笔相同套餐订单正在核实，请稍后重试或联系客服。"
    });
    return false;
  }

  let pending = null;
  if (service && typeof service.getPendingOrderStatus === "function") {
    try {
      pending = await service.getPendingOrderStatus(selectedProductId);
    } catch (error) {
      page.setData({
        paymentStatus: "failed",
        statusTitle: "订单状态读取失败",
        statusMessage: accountUi.userErrorMessage(error, "请稍后重试。")
      });
      return false;
    }
  }
  if (pending && pending.sameProductBlocked) {
    page.setData({
      paymentStatus: "confirming",
      statusTitle: "订单核实中",
      statusMessage: "您有一笔相同套餐订单正在核实，请稍后重试或联系客服。"
    });
    return false;
  }

  const hasOtherProduct = Boolean(
    (pending && Array.isArray(pending.otherProductOrders) && pending.otherProductOrders.length)
    || (cachedProductId && cachedProductId !== selectedProductId)
  );
  if (!hasOtherProduct) return true;

  const modal = typeof wx.showModal === "function"
    ? await new Promise((resolve) => wx.showModal({
      title: "已有待确认订单",
      content: "您还有其他套餐订单正在核实，继续充值可能产生重复扣款风险。是否继续？",
      confirmText: "继续充值",
      cancelText: "返回",
      success: resolve,
      fail: () => resolve({ confirm: false })
    }))
    : { confirm: false };
  return Boolean(modal && modal.confirm);
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
    selectedAmountText: "",
    selectedGrantPointsText: "",
    hasWxpay: false,
    hasAlipay: false,
    channelMessage: "",
    alipayModalVisible: false,
    alipayQrCode: "",
    alipayOrderNo: "",
    alipayAmountText: "",
    alipayQuerying: false,
    paying: false,
    paymentStatus: "idle",
    statusTitle: "",
    statusMessage: "",
    lastOrderNo: "",
    currentBalanceText: "",
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
    if (mode.enabled) {
      this._pendingOrder = null;
      this.loadRechargeConfig();
      return;
    }
    const pending = readPendingOrder();
    this._pendingOrder = pending;
    if (pending && !hasPendingFields(pending)) {
      discardInvalidPending(this, pending);
    } else if (pending && pending.productId) {
      this.setData({ selectedProductId: String(pending.productId) });
    }
    this.loadRechargeConfig();
  },

  onShow() {
    this._pageVisible = true;
    if (this._demoEnabled) return;
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
    this._lifecycleToken = (this._lifecycleToken || 0) + 1;
    this._configToken = (this._configToken || 0) + 1;
  },

  onPullDownRefresh() {
    const configPromise = this.loadRechargeConfig();
    const restorePromise = this._demoEnabled ? Promise.resolve() : this.restorePendingOrder();
    return Promise.all([
      Promise.resolve(configPromise).catch(() => null),
      Promise.resolve(restorePromise).catch(() => null)
    ]).finally(() => {
      if (typeof wx.stopPullDownRefresh === "function") wx.stopPullDownRefresh();
    });
  },

  async loadRechargeConfig(options = {}) {
    const service = this._accountClient || accountService;
    const silent = Boolean(options.silent);
    const configToken = (this._configToken || 0) + 1;
    this._configToken = configToken;
    if (!silent) this.setData({ loading: true, errorMessage: "" });
    try {
      const result = await service.getRechargeConfig();
      if (configToken !== this._configToken) return false;
      const config = accountUi.normalizeRechargeConfig(result);
      const selectedExists = config.products.some(
        (item) => item.productId === this.data.selectedProductId
      );
      const selectedProductId = selectedExists
        ? this.data.selectedProductId
        : config.products.length
          ? (config.products.find((item) => item.productId === "pkg_2990") || config.products[0]).productId
          : "";
      this.setData(Object.assign({
        loading: false,
        eligible: config.eligible,
        unavailableMessage: config.eligible
          ? ""
          : config.message || "充值暂未向当前账号开放",
        packages: config.products,
        selectedProductId,
        // 当前版本按产品要求暂不开放微信支付，保留服务端能力但前端入口锁定。
        hasWxpay: false,
        hasAlipay: config.hasAlipay,
        channelMessage: "通道暂未开通"
      }, selectedPackageDisplay(config.products, selectedProductId)));
      return true;
    } catch (error) {
      if (configToken !== this._configToken) return false;
      if (silent) return false;
      this.setData({
        loading: false,
        eligible: false,
        packages: [],
        selectedProductId: "",
        selectedAmountText: "",
        selectedGrantPointsText: "",
        hasWxpay: false,
        hasAlipay: false,
        errorMessage: accountUi.userErrorMessage(error, "充值配置读取失败，请重试。")
      });
      return false;
    }
  },

  retryConfig() {
    this.loadRechargeConfig();
  },

  selectPackage(event) {
    if (this._paymentFlowActive || this.data.paying) return;
    const productId = String(event.currentTarget.dataset.productId || "");
    if (!this.data.packages.some((item) => item.productId === productId)) return;
    this.setData(Object.assign({
      selectedProductId: productId,
      paymentStatus: "idle",
      statusTitle: "",
      statusMessage: ""
    }, selectedPackageDisplay(this.data.packages, productId)));
  },

  async submitPayment() {
    if (
      this._paymentFlowActive
      || this.data.paying
      || !this.data.eligible
      || !this.data.hasWxpay
    ) return;
    const selected = this.data.packages.find(
      (item) => item.productId === this.data.selectedProductId
    );
    if (!selected) {
      wx.showToast({ title: "请先选择充值套餐", icon: "none" });
      return;
    }

    if (this._demoEnabled) {
      this.submitDemoPayment(selected);
      return;
    }

    const service = this._accountClient || accountService;
    const rawCached = this._pendingOrder || readPendingOrder();
    const cached = discardInvalidPending(this, rawCached);
    if (cached && !hasPendingFields(cached)) {
      wx.showToast({ title: "请先清理失效订单", icon: "none" });
      return;
    }
    this._paymentFlowActive = true;
    if (!await checkPendingBeforeCreate(this, service, selected, cached)) {
      this._paymentFlowActive = false;
      return;
    }
    const requestId = cached && cached.requestId
      ? cached.requestId
      : service.createRequestId("recharge");
    const pendingDraft = Object.assign({}, cached || {}, {
      requestId,
      productId: selected.productId,
      createdAt: cached && cached.createdAt || Date.now()
    });
    const isNewPending = !(cached && cached.requestId);
    this._paymentFlowActive = true;
    const lifecycleToken = this._lifecycleToken || 0;
    this._pendingOrder = pendingDraft;
    if (!savePendingOrder(pendingDraft) && isNewPending) {
      this._pendingOrder = null;
      this._paymentFlowActive = false;
      this.setData({
        paying: false,
        paymentStatus: "failed",
        statusTitle: "订单未创建",
        statusMessage: "无法保存订单信息，请清理存储空间后重试。"
      });
      return;
    }
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
    let activeOrderNo = "";
    let paymentLaunchAttempted = false;
    try {
      const result = await service.createRechargeOrder({
        requestId,
        productId: selected.productId
      });
      if (lifecycleToken !== (this._lifecycleToken || 0)) return;
      const order = result && result.order || {};
      const status = orderStatus(result);
      const orderNo = String(order.orderNo || result.orderNo || "");
      activeOrderNo = orderNo;
      const payment = result && (result.payment || result.payParams || result.launcher);

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

      if (status === "closed" || status === "refunded") {
        const copy = terminalCopy(status);
        const clearResult = clearPagePendingOrder(this, {
          requestId: pendingDraft.requestId,
          orderNo
        });
        if (!clearResult.ok) {
          if (clearResult.reason === "storage") markPendingCleanupFailure(this);
          return;
        }
        this.setData({
          lastOrderNo: orderNo,
          paymentStatus: "terminated",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        return;
      }

      if (status === "fulfilled" || status === "success") {
        orderNeedsConfirmation = true;
        confirmationStatus = status;
        const copy = confirmationCopy(status);
        this.setData({
          paymentStatus: "confirming",
          statusTitle: copy.title,
          statusMessage: copy.message
        });
        await this.confirmOrder(orderNo, QUERY_ATTEMPTS, pendingDraft.requestId);
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

      paymentLaunchAttempted = true;
      await paymentLauncher.launchPayment(order.channel || "wxpay", payment);
      if (lifecycleToken !== (this._lifecycleToken || 0)) return;
      paymentAccepted = true;
      this.setData({
        paymentStatus: "confirming",
        statusTitle: "支付结果确认中",
        statusMessage: "正在向支付服务确认到账，请稍候。"
      });
      await this.confirmOrder(orderNo, QUERY_ATTEMPTS, pendingDraft.requestId);
    } catch (error) {
      if (lifecycleToken !== (this._lifecycleToken || 0)) return;
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
      const gateError = isRechargeGateError(error);
      if (isIdempotencyConflict(error)) {
        const clearResult = clearPagePendingRequest(this, pendingDraft);
        this.setData({
          paymentStatus: "failed",
          statusTitle: "充值请求已失效",
          statusMessage: clearResult.ok
            ? "请求编号发生冲突，请重新点击创建新订单。"
            : "请求编号发生冲突且本地状态无法清理，请稍后重试。"
        });
      } else if (isPaymentCanceled(error)) {
        this.setData({
          paymentStatus: "canceled",
          statusTitle: "已取消支付",
          statusMessage: "订单仍会保留，再次点击可继续同一笔订单。"
        });
      } else if (!paymentAccepted && paymentLaunchAttempted && activeOrderNo) {
        this.setData({
          paymentStatus: "confirming",
          statusTitle: "支付结果确认中",
          statusMessage: "支付窗口返回异常，正在确认原订单，请勿重复付款。"
        });
        try {
          await this.confirmOrder(activeOrderNo, 1, pendingDraft.requestId);
        } catch (_queryError) {
          this.setData({
            paymentStatus: "confirming",
            statusTitle: "支付结果确认中",
            statusMessage: "暂时无法确认原订单，请稍后再试，勿重复付款。"
          });
        }
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
      if (gateError) await this.loadRechargeConfig({ silent: true });
    } finally {
      this._paymentFlowActive = false;
      this.setData({ paying: false });
    }
  },

  async submitAlipayPayment() {
    if (this._paymentFlowActive || this.data.paying || !this.data.eligible) return;
    if (!this.data.hasAlipay) {
      wx.showToast({ title: "支付宝通道暂不可用", icon: "none" });
      return;
    }
    const selected = this.data.packages.find(
      (item) => item.productId === this.data.selectedProductId
    );
    if (!selected) {
      wx.showToast({ title: "请先选择充值套餐", icon: "none" });
      return;
    }
    if (this._demoEnabled) {
      wx.showToast({ title: "演示模式不创建真实订单", icon: "none" });
      return;
    }
    const service = this._accountClient || accountService;
    const cached = discardInvalidPending(this, this._pendingOrder || readPendingOrder());
    if (cached && !hasPendingFields(cached)) {
      wx.showToast({ title: "请先清理失效订单", icon: "none" });
      return;
    }
    this._paymentFlowActive = true;
    if (!await checkPendingBeforeCreate(this, service, selected, cached)) {
      this._paymentFlowActive = false;
      return;
    }
    const requestId = service.createRequestId("alipay");
    const pendingDraft = {
      requestId,
      productId: selected.productId,
      channel: "alipay",
      createdAt: Date.now()
    };
    this._pendingOrder = pendingDraft;
    if (!savePendingOrder(pendingDraft)) {
      this._paymentFlowActive = false;
      this._pendingOrder = null;
      this.setData({
        paymentStatus: "failed",
        statusTitle: "订单未创建",
        statusMessage: "无法保存订单状态，请清理存储空间后重试。"
      });
      return;
    }
    this.setData({
      paying: true,
      alipayQuerying: false,
      paymentStatus: "creating",
      statusTitle: "正在创建支付宝订单",
      statusMessage: "二维码生成中，请稍候。"
    });
    try {
      const result = await service.createAlipayRechargeOrder({
        requestId,
        productId: selected.productId
      });
      const order = result && result.order || {};
      const payment = result && (result.payment || result.payParams || result.launcher) || {};
      const orderNo = String(order.orderNo || result.orderNo || "");
      const qrCode = String(payment.qrCode || payment.qrcode || payment.qr_code || "").trim();
      if (!orderNo || !/^https:\/\//i.test(qrCode)) {
        throw new Error("支付通道未返回支付宝二维码，请稍后重试。");
      }
      this._pendingOrder = Object.assign({}, pendingDraft, { orderNo });
      if (!savePendingOrder(this._pendingOrder)) {
        throw new Error("无法保存支付宝订单状态，请清理存储空间后重试。");
      }
      this.setData({
        paying: false,
        alipayModalVisible: true,
        alipayQrCode: qrCode,
        alipayOrderNo: orderNo,
        alipayAmountText: String(order.amountText || selected.amountText || ""),
        paymentStatus: "confirming",
        statusTitle: "等待支付宝扫码",
        statusMessage: "请用另一部手机打开支付宝扫码。",
        lastOrderNo: orderNo
      });
    } catch (error) {
      const failedOrder = error && error.payload && (error.payload.order
        || error.payload.details && error.payload.details.order);
      const failedOrderNo = String(failedOrder && failedOrder.orderNo || "");
      if (failedOrderNo) {
        this._pendingOrder = Object.assign({}, pendingDraft, {
          orderNo: failedOrderNo,
          channel: String(failedOrder.channel || "alipay")
        });
        savePendingOrder(this._pendingOrder);
        this.setData({
          paying: false,
          paymentStatus: "confirming",
          statusTitle: String(failedOrder.status || "").toLowerCase() === "review"
            ? "订单核实中"
            : "支付结果确认中",
          statusMessage: String(failedOrder.status || "").toLowerCase() === "review"
            ? "已有订单正在核实，请联系客服后再继续充值。"
            : "订单创建结果需要确认，请勿重复付款。",
          lastOrderNo: failedOrderNo
        });
      } else if (isDeterministicNoOrderError(error)) {
        clearPagePendingRequest(this, pendingDraft);
        this.setData({
          paying: false,
          paymentStatus: "failed",
          statusTitle: accountUi.accountErrorCode(error) === "PAYMENT_ALIPAY_PROTOCOL_UNCONFIRMED"
            ? "支付宝通道维护中"
            : "充值暂时不可用",
          statusMessage: accountUi.userErrorMessage(error, "请稍后重试。")
        });
      } else {
        this.setData({
          paying: false,
          paymentStatus: "confirming",
          statusTitle: "订单核实中",
          statusMessage: "支付服务暂时无法确认，请联系客服，勿重复付款。"
        });
      }
    } finally {
      this._paymentFlowActive = false;
      this.setData({ paying: false });
    }
  },

  closeAlipayModal() {
    if (this.data.alipayQuerying) return;
    this.setData({ alipayModalVisible: false });
  },

  stopModalTap() {},

  async queryAlipayPayment() {
    const orderNo = String(this.data.alipayOrderNo || this._pendingOrder && this._pendingOrder.orderNo || "").trim();
    if (!orderNo || this.data.alipayQuerying) return;
    this.setData({ alipayQuerying: true });
    try {
      await this.confirmOrder(orderNo, QUERY_ATTEMPTS, String(this._pendingOrder && this._pendingOrder.requestId || ""));
      if (this.data.paymentStatus === "success") {
        this.setData({ alipayModalVisible: false });
      }
    } catch (error) {
      this.setData({
        paymentStatus: "confirming",
        statusTitle: "订单确认中",
        statusMessage: accountUi.userErrorMessage(error, "暂时无法确认，请稍后重试。")
      });
    } finally {
      this.setData({ alipayQuerying: false });
    }
  },

  async confirmOrder(orderNo, attempts = 1, requestId = "") {
    const service = this._accountClient || accountService;
    const queryToken = (this._queryToken || 0) + 1;
    this._queryToken = queryToken;
    const expected = {
      requestId: valueText(requestId || this._pendingOrder && this._pendingOrder.requestId),
      orderNo: valueText(orderNo)
    };
    let lastResult = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await wait(1200);
      if (queryToken !== this._queryToken) return;
      try {
        lastResult = await service.queryRechargeOrder(orderNo);
      } catch (error) {
        if (queryToken !== this._queryToken) return;
        if (accountUi.accountErrorCode(error) === "PAYMENT_PROVIDER_QUERY_REFERENCE_MISSING") {
          this.setData({
            paymentStatus: "confirming",
            statusTitle: "订单核实中",
            statusMessage: "支付通道没有返回平台订单号，请联系客服核实后再继续充值。"
          });
          return;
        }
        if (!isOrderNotFound(error)) throw error;
        const clearResult = clearPagePendingOrder(this, expected);
        if (!clearResult.ok) {
          if (clearResult.reason === "storage") markPendingCleanupFailure(this);
          return;
        }
        this.setData({
          paymentStatus: "failed",
          statusTitle: "原订单已失效",
          statusMessage: "未找到待确认订单，请重新选择套餐。",
          lastOrderNo: ""
        });
        return;
      }
      if (queryToken !== this._queryToken) return;
      const status = orderStatus(lastResult);
      const order = lastResult && lastResult.order || {};
      const grantSource = order.grantPoints !== undefined
        ? order.grantPoints
        : lastResult.grantPoints;
      const grantPoints = accountUi.safeNumber(grantSource, 0);
      if (status === "fulfilled" || status === "success") {
        const account = accountUi.normalizeAccount(lastResult && lastResult.account || lastResult);
        const clearResult = clearPagePendingOrder(this, expected);
        if (!clearResult.ok) {
          if (clearResult.reason === "storage") markPendingCleanupFailure(this);
          return;
        }
        this.setData({
          paymentStatus: "success",
          statusTitle: "充值成功",
          statusMessage: grantPoints > 0
            ? `${accountUi.formatPoints(grantPoints, { fallback: "0" })} 积分已到账`
            : "积分已到账",
          currentBalanceText: account.pointsBalanceText
        });
        return;
      }
      if (status === "closed" || status === "refunded") {
        const copy = terminalCopy(status);
        const clearResult = clearPagePendingOrder(this, expected);
        if (!clearResult.ok) {
          if (clearResult.reason === "storage") markPendingCleanupFailure(this);
          return;
        }
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
    if (this._demoEnabled) return;
    if (this._paymentFlowActive || this.data.paying) return;
    const rawPending = this._pendingOrder || readPendingOrder();
    const pending = discardInvalidPending(this, rawPending);
    if (!pending) return;
    if (!hasPendingFields(pending)) return;
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
    const lifecycleToken = this._lifecycleToken || 0;
    this._paymentFlowActive = true;
    this.setData({
      paying: true,
      selectedProductId: String(pending.productId || this.data.selectedProductId),
      lastOrderNo: String(pending.orderNo),
      paymentStatus: "confirming",
      statusTitle: "正在恢复订单",
      statusMessage: "正在确认上次支付结果。"
    });
    try {
      await this.confirmOrder(String(pending.orderNo), 1, String(pending.requestId));
    } catch (error) {
      if (lifecycleToken !== (this._lifecycleToken || 0)) return;
      this.setData({
        paymentStatus: "confirming",
        statusTitle: "订单等待确认",
        statusMessage: "暂时无法查询结果，下拉刷新后可再试。"
      });
    } finally {
      if (lifecycleToken === (this._lifecycleToken || 0)) {
        this._paymentFlowActive = false;
        this.setData({ paying: false });
      }
    }
  },

  openRecords() {
    wx.navigateTo({
      url: accountDemo.pageUrl("/pages/account-records/account-records", this._demoEnabled),
      fail: () => wx.showToast({ title: "收支记录打开失败", icon: "none" })
    });
  },

  submitDemoPayment(selected) {
    const grantText = accountUi.formatPoints(selected && selected.grantPoints, { fallback: "0" });
    this.setData({
      paying: false,
      paymentStatus: "success",
      statusTitle: "演示支付完成",
      statusMessage: `${grantText} 积分演示到账`,
      currentBalanceText: "128.5",
      lastOrderNo: "visual-test-only"
    });
  },

  toggleVisualDemo(event) {
    if (!this._demoMode || !this._demoMode.available) return;
    const enabled = Boolean(event && event.detail && event.detail.value);
    wx.redirectTo({
      url: accountDemo.pageUrl("/pages/recharge/recharge", enabled),
      fail: () => wx.showToast({ title: "演示模式切换失败", icon: "none" })
    });
  }
});
