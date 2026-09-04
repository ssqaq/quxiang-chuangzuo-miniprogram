/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const accountUi = require(path.join(root, "utils", "account-ui"));
const accountService = require(path.join(root, "services", "account"));
const paymentLauncher = require(path.join(root, "services", "payment-launcher"));

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function assertIncludes(text, marker, label) {
  assert.ok(text.includes(marker), `${label} 缺少 ${marker}`);
}

async function runRechargeCase(options = {}) {
  const rechargePath = require.resolve(path.join(root, "pages", "recharge", "recharge.js"));
  const accountPath = require.resolve(path.join(root, "services", "account.js"));
  const launcherPath = require.resolve(path.join(root, "services", "payment-launcher.js"));
  const oldRechargeCache = require.cache[rechargePath];
  const oldAccountCache = require.cache[accountPath];
  const oldLauncherCache = require.cache[launcherPath];
  const oldPage = global.Page;
  const oldWx = global.wx;
  const requestIds = [];
  let requestIdCount = 0;
  let paymentCalls = 0;
  let queryCalls = 0;
  let configCalls = 0;
  let pullDownStops = 0;
  let removed = false;
  let removeAttempts = 0;
  let stored = options.initialStored
    ? Object.assign({}, options.initialStored)
    : null;
  let pageDefinition;
  let activePage = null;
  const createPayloads = [];
  const toasts = [];
  let queryStartedResolve;
  const queryStarted = new Promise((resolve) => {
    queryStartedResolve = resolve;
  });

  const accountStub = {
    async getRechargeConfig() {
      configCalls += 1;
      if (typeof options.configResult === "function") {
        return options.configResult(configCalls);
      }
      return options.configResult || {
        eligible: true,
        channels: ["wxpay"],
        products: accountUi.RECHARGE_PACKAGES.map((item) => Object.assign({}, item))
      };
    },
    createRequestId() {
      requestIdCount += 1;
      return `fixed-request-${requestIdCount}`;
    },
    async createRechargeOrder(payload) {
      requestIds.push(payload.requestId);
      createPayloads.push(Object.assign({}, payload));
      return typeof options.createResult === "function"
        ? options.createResult(payload)
        : options.createResult;
    },
    async queryRechargeOrder(orderNo) {
      queryCalls += 1;
      if (options.queryGate) {
        options.queryGate.started = true;
        queryStartedResolve();
        if (typeof options.queryGate.onStart === "function") {
          options.queryGate.onStart(activePage, orderNo);
        }
        await options.queryGate.promise;
      }
      if (typeof options.queryError === "function") {
        throw options.queryError(orderNo, queryCalls);
      }
      if (options.queryError) throw options.queryError;
      return typeof options.queryResult === "function"
        ? options.queryResult(orderNo, queryCalls)
        : options.queryResult;
    }
  };
  const launcherStub = {
    async launchPayment() {
      paymentCalls += 1;
      if (typeof options.launchError === "function") throw options.launchError(paymentCalls);
      if (options.launchError) throw options.launchError;
      return { errMsg: "requestPayment:ok" };
    }
  };
  const wxStub = {
    getStorageSync() {
      return stored;
    },
    setStorageSync(key, value) {
      if (options.storageError) throw options.storageError;
      stored = Object.assign({}, value);
    },
    removeStorageSync() {
      removeAttempts += 1;
      const removeError = typeof options.removeStorageError === "function"
        ? options.removeStorageError(removeAttempts)
        : options.removeStorageError;
      if (removeError) throw removeError;
      removed = true;
      stored = null;
    },
    showToast(payload) {
      toasts.push(payload);
    },
    stopPullDownRefresh() {
      pullDownStops += 1;
    }
  };

  try {
    require.cache[accountPath] = {
      id: accountPath,
      filename: accountPath,
      loaded: true,
      exports: accountStub
    };
    require.cache[launcherPath] = {
      id: launcherPath,
      filename: launcherPath,
      loaded: true,
      exports: launcherStub
    };
    delete require.cache[rechargePath];
    global.wx = wxStub;
    global.Page = (definition) => {
      pageDefinition = definition;
    };
    require(rechargePath);
    assert.ok(pageDefinition, "充值页必须注册 Page");

    const page = Object.assign({}, pageDefinition, {
      data: Object.assign({}, pageDefinition.data, {
        eligible: true,
        hasWxpay: true,
        packages: options.packages || [
          { productId: "pkg_990", amountFen: 990, grantPoints: 100 }
        ],
        selectedProductId: options.selectedProductId || "pkg_990"
      }),
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
    activePage = page;
    page._pendingOrder = stored ? Object.assign({}, stored) : null;
    if (typeof options.beforeAction === "function") await options.beforeAction(page);
    if (options.action === "restore") {
      const restorePromise = page.restorePendingOrder();
      if (
        options.unloadDuringRestore
        || options.concurrentDuringRestore
        || options.releaseQueryGate
      ) {
        await queryStarted;
        if (options.unloadDuringRestore) page.onUnload();
        const submitPromise = options.concurrentDuringRestore
          ? page.submitPayment()
          : Promise.resolve();
        if (options.queryGate && typeof options.queryGate.release === "function") {
          options.queryGate.release();
        }
        await Promise.all([restorePromise, submitPromise]);
      } else {
        await restorePromise;
      }
    } else if (options.action === "pullDown") {
      await page.onPullDownRefresh();
    } else if (options.concurrentSubmit) {
      await Promise.all([page.submitPayment(), page.submitPayment()]);
    } else {
      const submitCount = Math.max(1, Number(options.submitCount) || 1);
      for (let index = 0; index < submitCount; index += 1) {
        await page.submitPayment();
      }
    }
    return {
      data: page.data,
      createPayloads,
      paymentCalls,
      configCalls,
      pullDownStops,
      queryCalls,
      removed,
      removeAttempts,
      stored,
      requestIdCount,
      requestIds,
      toasts
    };
  } finally {
    global.Page = oldPage;
    global.wx = oldWx;
    if (oldRechargeCache) require.cache[rechargePath] = oldRechargeCache;
    else delete require.cache[rechargePath];
    if (oldAccountCache) require.cache[accountPath] = oldAccountCache;
    else delete require.cache[accountPath];
    if (oldLauncherCache) require.cache[launcherPath] = oldLauncherCache;
    else delete require.cache[launcherPath];
  }
}

async function runUserCenterCase(options = {}) {
  const pagePath = require.resolve(path.join(root, "pages", "user-center", "user-center.js"));
  const accountPath = require.resolve(path.join(root, "services", "account.js"));
  const oldPageCache = require.cache[pagePath];
  const oldAccountCache = require.cache[accountPath];
  const oldPage = global.Page;
  const oldWx = global.wx;
  let pageDefinition;
  const toasts = [];
  const navigations = [];
  const calls = { profile: 0, overview: 0, config: 0 };

  const resolveOrThrow = async (value, error, fallback) => {
    if (error) throw error;
    return value === undefined ? fallback : value;
  };
  const fromSequence = (name, value, error, fallback) => {
    const sequence = options[`${name}Sequence`];
    if (!Array.isArray(sequence) || !sequence.length) {
      return resolveOrThrow(value, error, fallback);
    }
    const index = Math.min(calls[name], sequence.length - 1);
    calls[name] += 1;
    const step = sequence[index] || {};
    return resolveOrThrow(step.value, step.error, fallback);
  };
  const accountStub = {
    getUserProfile() {
      return fromSequence(
        "profile",
        options.profileResult,
        options.profileError,
        { nickname: "测试用户" }
      );
    },
    getAccountOverview() {
      return fromSequence("overview", options.overviewResult, options.overviewError, {
        account: { pointsBalance: 12, totalPurchasedPoints: 100 },
        recentRecords: []
      });
    },
    getRechargeConfig() {
      return fromSequence("config", options.configResult, options.configError, {
        eligible: false,
        channels: [],
        products: []
      });
    }
  };

  try {
    require.cache[accountPath] = {
      id: accountPath,
      filename: accountPath,
      loaded: true,
      exports: accountStub
    };
    delete require.cache[pagePath];
    global.wx = {
      showToast(payload) {
        toasts.push(payload);
      },
      navigateTo(payload) {
        navigations.push(payload);
      }
    };
    global.Page = (definition) => {
      pageDefinition = definition;
    };
    require(pagePath);
    assert.ok(pageDefinition, "用户中心必须注册 Page");

    const page = Object.assign({}, pageDefinition, {
      data: Object.assign({}, pageDefinition.data),
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
    await page.loadUserCenter();
    const snapshots = [Object.assign({}, page.data)];
    if (options.openRecharge) page.openRecharge();
    if (options.openRecords) page.openAccountRecords();
    if (options.reload) {
      await page.loadUserCenter();
      snapshots.push(Object.assign({}, page.data));
    }
    return { data: page.data, page, snapshots, toasts, navigations };
  } finally {
    global.Page = oldPage;
    global.wx = oldWx;
    if (oldPageCache) require.cache[pagePath] = oldPageCache;
    else delete require.cache[pagePath];
    if (oldAccountCache) require.cache[accountPath] = oldAccountCache;
    else delete require.cache[accountPath];
  }
}

async function main() {
  const rawCloudError = {
    errCode: -501000,
    errMsg: "cloud.callFunction:fail FUNCTION_NOT_FOUND",
    message: "FunctionName parameter could not be found. https://docs.cloudbase.net/error-code/basic/FUNCTION_NOT_FOUND"
  };
  const friendlyCloudError = accountUi.userErrorMessage(
    rawCloudError,
    "余额读取失败，请稍后重试。"
  );
  assert.strictEqual(friendlyCloudError, accountUi.ACCOUNT_SERVICE_NOT_READY_MESSAGE);
  assert.ok(!/cloud|function|https|errMsg|-501000/i.test(friendlyCloudError));
  for (const errorShape of [
    { errCode: -501000 },
    { errMsg: "FUNCTION_NOT_FOUND" },
    { message: "FunctionName parameter could not be found" }
  ]) {
    assert.strictEqual(
      accountUi.userErrorMessage(errorShape, "读取失败"),
      accountUi.ACCOUNT_SERVICE_NOT_READY_MESSAGE
    );
  }
  const serviceCloudError = accountService.__test__.paymentError(
    rawCloudError,
    "账户服务请求失败，请稍后重试。"
  );
  assert.strictEqual(serviceCloudError.code, "ACCOUNT_SERVICE_NOT_DEPLOYED");
  assert.strictEqual(serviceCloudError.message, accountUi.ACCOUNT_SERVICE_NOT_READY_MESSAGE);
  const preparingState = await runUserCenterCase({
    overviewError: rawCloudError,
    configError: rawCloudError,
    openRecharge: true,
    openRecords: true
  });
  assert.strictEqual(preparingState.data.accountServicePreparing, true);
  assert.strictEqual(preparingState.data.accountError, "");
  assert.strictEqual(preparingState.data.recordsError, "");
  assert.strictEqual(preparingState.data.rechargeConfigError, "");
  assert.strictEqual(preparingState.data.hasAnyError, false);
  assert.deepStrictEqual(
    preparingState.toasts.map((item) => item.title),
    ["账户功能准备中"]
  );
  assert.deepStrictEqual(
    preparingState.navigations.map((item) => item.url),
    ["/pages/account-records/account-records"],
    "账户服务准备中也必须允许进入收支记录错误态"
  );

  const regularFailureState = await runUserCenterCase({
    overviewError: new Error("unknown overview failure"),
    configError: new Error("unknown config failure")
  });
  assert.strictEqual(regularFailureState.data.accountServicePreparing, false);
  assert.strictEqual(regularFailureState.data.accountError, "余额读取失败，请稍后重试。");
  assert.strictEqual(regularFailureState.data.recordsError, "最近记录暂时无法读取。");
  assert.strictEqual(regularFailureState.data.rechargeConfigError, "充值状态读取失败，请稍后重试。");
  assert.strictEqual(regularFailureState.data.hasAnyError, true);

  const recoveredState = await runUserCenterCase({
    overviewSequence: [
      { error: rawCloudError },
      {
        value: {
          account: { pointsBalance: 88, totalPurchasedPoints: 100 },
          recentRecords: []
        }
      }
    ],
    configSequence: [
      { error: rawCloudError },
      { value: { eligible: false, channels: [], products: [] } }
    ],
    reload: true
  });
  assert.strictEqual(recoveredState.snapshots[0].accountServicePreparing, true);
  assert.strictEqual(recoveredState.data.accountServicePreparing, false);
  assert.strictEqual(recoveredState.data.account.pointsBalanceText, "88");
  assert.strictEqual(recoveredState.data.hasAnyError, false);

  const unavailableRechargeState = await runUserCenterCase({ openRecharge: true });
  assert.strictEqual(unavailableRechargeState.toasts[0].title, "充值服务暂未开放");
  assert.strictEqual(
    accountUi.userErrorMessage(
      { errorCode: "PAYMENT_ORDER_CREATION_DISABLED", message: "provider internal" },
      "支付失败"
    ),
    "充值服务暂未开放。"
  );
  assert.strictEqual(
    accountUi.userErrorMessage(new Error("记录翻页信息无效，请刷新后重试。"), "读取失败"),
    "读取失败"
  );
  assert.strictEqual(
    accountUi.userErrorMessage(new Error("network timeout"), "读取失败"),
    "网络不稳定，请稍后重试。"
  );
  assert.strictEqual(
    accountUi.userErrorMessage(
      new Error("数据库 collection payment_orders 读取失败，secret 泄漏"),
      "余额读取失败，请稍后重试。"
    ),
    "余额读取失败，请稍后重试。"
  );
  assert.strictEqual(
    accountUi.userErrorMessage(new Error("数据库权限不足"), "余额读取失败，请稍后重试。"),
    "余额读取失败，请稍后重试。"
  );
  const trustedPublicError = new Error("当前账号暂未开放充值");
  trustedPublicError.userSafe = true;
  assert.strictEqual(
    accountUi.userErrorMessage(trustedPublicError, "充值服务暂不可用"),
    "当前账号暂未开放充值"
  );
  const trustedServiceError = accountService.__test__.paymentError(
    { errorCode: "PAYMENT_ACCOUNT_NOT_ELIGIBLE", message: "当前账号暂未开放充值" },
    "充值服务暂不可用",
    { trustedPublic: true }
  );
  assert.strictEqual(
    accountUi.userErrorMessage(trustedServiceError, "充值服务暂不可用"),
    "当前账号暂未开放充值"
  );

  const gateError = new Error("payment gate closed");
  gateError.code = "PAYMENT_CHANNEL_DISABLED";
  const gateRefresh = await runRechargeCase({
    createResult() {
      throw gateError;
    },
    configResult() {
      return { eligible: false, channels: [], products: [], message: "充值暂未开放" };
    }
  });
  assert.strictEqual(gateRefresh.paymentCalls, 0, "服务端关闸后不得拉起微信支付");
  assert.strictEqual(gateRefresh.configCalls, 1, "服务端关闸后必须刷新一次权威配置");
  assert.strictEqual(gateRefresh.data.eligible, false, "新配置必须隐藏充值 CTA");
  assert.strictEqual(gateRefresh.data.hasWxpay, false, "新配置必须关闭微信通道");

  const accountSource = read("services/account.js");
  const userCenterSource = read("pages/user-center/user-center.js");
  const rechargeSource = read("pages/recharge/recharge.js");
  const recordsSource = read("pages/account-records/account-records.js");
  assertIncludes(accountSource, "accountUi.userErrorMessage", "账户服务错误收口");
  for (const [label, source] of [
    ["用户中心", userCenterSource],
    ["充值页", rechargeSource],
    ["收支记录页", recordsSource]
  ]) {
    assertIncludes(source, "accountUi.userErrorMessage", `${label}友好错误提示`);
    assert.ok(!source.includes("String(error && error.message"), `${label}不得直出底层错误`);
  }

  assert.deepStrictEqual(
    accountUi.RECHARGE_PACKAGES.map((item) => [item.productId, item.amountFen, item.grantPoints]),
    [
      ["pkg_990", 990, 100],
      ["pkg_2990", 2990, 330],
      ["pkg_5990", 5990, 688]
    ]
  );

  const serverProducts = [
    { productId: "pkg_990", amountFen: 990, grantPoints: 100 },
    { productId: "pkg_5990", amountFen: 5990, grantPoints: 688 },
    { productId: "pkg_990", amountFen: 1, grantPoints: 9999 },
    { productId: "unknown", amountFen: 2990, grantPoints: 330 }
  ];
  assert.deepStrictEqual(
    accountUi.normalizeProducts(serverProducts).map((item) => item.productId),
    ["pkg_990", "pkg_5990"],
    "客户端只能展示服务端返回且与固定商品表完全匹配的套餐"
  );

  const hidden = accountUi.normalizeRechargeConfig({
    eligible: false,
    channels: ["wxpay"],
    products: serverProducts
  });
  assert.strictEqual(hidden.eligible, false);
  const disabled = accountUi.normalizeRechargeConfig({
    eligible: true,
    channels: [],
    products: serverProducts
  });
  assert.strictEqual(disabled.eligible, true);
  assert.strictEqual(disabled.hasWxpay, false);
  const enabled = accountUi.normalizeRechargeConfig({
    eligible: true,
    availableChannels: ["wxpay", "unsupported"],
    products: serverProducts
  });
  assert.deepStrictEqual(enabled.channels, ["wxpay"]);
  assert.strictEqual(enabled.hasWxpay, true);

  const validPayment = {
    timeStamp: "1788048000",
    nonceStr: "noncestring",
    package: "prepay_id=wx123",
    signType: "RSA",
    paySign: "A".repeat(64)
  };
  assert.deepStrictEqual(paymentLauncher.normalizePaymentParams(validPayment), validPayment);
  assert.throws(
    () => paymentLauncher.normalizePaymentParams(Object.assign({}, validPayment, { package: "javascript:bad" })),
    (error) => error && error.code === "INVALID_PAYMENT_PARAMS"
  );

  global.wx = {
    requestPayment(options) {
      options.success({ errMsg: "requestPayment:ok" });
    }
  };
  const launched = await paymentLauncher.launchPayment("wxpay", validPayment);
  assert.strictEqual(launched.errMsg, "requestPayment:ok");
  await assert.rejects(
    paymentLauncher.launchPayment("unknown", validPayment),
    (error) => error && error.code === "UNSUPPORTED_PAYMENT_PROVIDER"
  );

  const concurrentSubmit = await runRechargeCase({
    concurrentSubmit: true,
    createResult: {
      order: { orderNo: "order-concurrent", status: "created", channel: "wxpay" }
    }
  });
  assert.strictEqual(concurrentSubmit.createPayloads.length, 1, "并发双击只能创建一次订单");
  assert.strictEqual(concurrentSubmit.requestIdCount, 1, "并发双击只能生成一个 requestId");
  assert.strictEqual(concurrentSubmit.paymentCalls, 0);

  const storageFailure = await runRechargeCase({
    storageError: new Error("storage unavailable"),
    createResult: {
      order: { orderNo: "order-must-not-exist", status: "created", channel: "wxpay" }
    }
  });
  assert.strictEqual(storageFailure.createPayloads.length, 0, "首次 pending 未落盘不得创建订单");
  assert.strictEqual(storageFailure.data.paymentStatus, "failed");

  const packageLockedWithoutOrderNo = await runRechargeCase({
    initialStored: {
      requestId: "fixed-existing-request",
      productId: "pkg_990",
      createdAt: 1788048000000
    },
    packages: [
      { productId: "pkg_990", amountFen: 990, grantPoints: 100 },
      { productId: "pkg_2990", amountFen: 2990, grantPoints: 330 }
    ],
    createResult: {
      order: { orderNo: "order-package-lock", status: "created", channel: "wxpay" }
    },
    beforeAction(page) {
      page.selectPackage({ currentTarget: { dataset: { productId: "pkg_2990" } } });
    }
  });
  assert.strictEqual(packageLockedWithoutOrderNo.data.selectedProductId, "pkg_990");
  assert.strictEqual(packageLockedWithoutOrderNo.createPayloads[0].productId, "pkg_990");
  assert.strictEqual(packageLockedWithoutOrderNo.createPayloads[0].requestId, "fixed-existing-request");
  assert.strictEqual(packageLockedWithoutOrderNo.toasts[0].title, "请先完成待确认订单");

  let uncertainCreateCalls = 0;
  const uncertainCreateResume = await runRechargeCase({
    submitCount: 2,
    createResult() {
      uncertainCreateCalls += 1;
      if (uncertainCreateCalls === 1) throw new Error("request:fail timeout");
      return {
        order: { orderNo: "order-created-after-timeout", status: "created", channel: "wxpay" }
      };
    }
  });
  assert.strictEqual(uncertainCreateResume.requestIdCount, 1);
  assert.deepStrictEqual(
    uncertainCreateResume.requestIds,
    ["fixed-request-1", "fixed-request-1"],
    "创建结果不确定时只能复用原 requestId"
  );
  assert.deepStrictEqual(
    uncertainCreateResume.createPayloads.map((item) => item.productId),
    ["pkg_990", "pkg_990"],
    "创建结果不确定时不得更换原套餐"
  );

  const canceledError = new Error("payment canceled");
  canceledError.code = "PAYMENT_CANCELED";
  canceledError.canceled = true;
  const canceledResume = await runRechargeCase({
    submitCount: 2,
    createResult: {
      order: { orderNo: "order-canceled", status: "pending", channel: "wxpay" },
      payment: validPayment
    },
    launchError: canceledError
  });
  assert.strictEqual(canceledResume.requestIdCount, 1);
  assert.deepStrictEqual(
    canceledResume.requestIds,
    ["fixed-request-1", "fixed-request-1"],
    "取消后继续只能复用原 requestId"
  );
  assert.strictEqual(canceledResume.removed, false);
  assert.strictEqual(canceledResume.data.paymentStatus, "canceled");

  const uncertainLaunchError = new Error("requestPayment:fail system error");
  uncertainLaunchError.code = "PAYMENT_FAILED";
  const uncertainPayment = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-uncertain", status: "pending", channel: "wxpay" },
      payment: validPayment
    },
    launchError: uncertainLaunchError,
    queryResult: {
      order: { orderNo: "order-uncertain", status: "pending" }
    }
  });
  assert.strictEqual(uncertainPayment.paymentCalls, 1);
  assert.strictEqual(uncertainPayment.queryCalls, 1, "非取消支付失败必须先查询原订单");
  assert.strictEqual(uncertainPayment.data.paymentStatus, "confirming");
  assert.strictEqual(uncertainPayment.removed, false);

  const notFoundError = new Error("充值订单不存在。");
  notFoundError.code = "PAYMENT_ORDER_NOT_FOUND";
  const stalePending = await runRechargeCase({
    action: "restore",
    initialStored: {
      requestId: "fixed-stale-request",
      productId: "pkg_990",
      orderNo: "PAY00000000000000000000000000000"
    },
    queryError: notFoundError
  });
  assert.strictEqual(stalePending.removed, true, "服务端明确 NOT_FOUND 才能清理旧 pending");
  assert.strictEqual(stalePending.stored, null);

  const restoreNetworkError = new Error("request:fail timeout");
  restoreNetworkError.code = "ACCOUNT_NETWORK_ERROR";
  const retainedPending = await runRechargeCase({
    action: "restore",
    initialStored: {
      requestId: "fixed-retained-request",
      productId: "pkg_990",
      orderNo: "PAY11111111111111111111111111111"
    },
    queryError: restoreNetworkError
  });
  assert.strictEqual(retainedPending.removed, false, "网络失败不得清理 pending");
  assert.strictEqual(retainedPending.stored.requestId, "fixed-retained-request");

  const malformedPending = await runRechargeCase({
    action: "restore",
    initialStored: { orderNo: "order-malformed-pending", productId: "pkg_990" }
  });
  assert.strictEqual(malformedPending.removed, true, "缺少 requestId 的坏 pending 必须清理");
  assert.strictEqual(malformedPending.stored, null);
  assert.strictEqual(malformedPending.toasts[0].title, "待确认订单信息已失效");

  for (const [label, invalidPending] of [
    ["缺少 productId", { requestId: "fixed-missing-product", orderNo: "order-missing-product" }],
    ["未知 productId", {
      requestId: "fixed-unknown-product",
      productId: "pkg_unknown",
      orderNo: "order-unknown-product"
    }]
  ]) {
    const invalidResult = await runRechargeCase({
      action: "restore",
      initialStored: invalidPending
    });
    assert.strictEqual(invalidResult.removed, true, `${label} 的坏 pending 必须安全清理`);
    assert.strictEqual(invalidResult.stored, null);
    assert.strictEqual(invalidResult.toasts[0].title, "待确认订单信息已失效");
  }

  const replacedGate = {};
  replacedGate.promise = new Promise((resolve) => {
    replacedGate.release = resolve;
  });
  replacedGate.onStart = (page) => {
    const replacement = {
      requestId: "fixed-replacement-request",
      productId: "pkg_990",
      orderNo: "order-replacement"
    };
    page._pendingOrder = Object.assign({}, replacement);
    global.wx.setStorageSync("account_pending_recharge_order_v1", replacement);
  };
  const replacedPending = await runRechargeCase({
    action: "restore",
    releaseQueryGate: true,
    queryGate: replacedGate,
    initialStored: {
      requestId: "fixed-old-request",
      productId: "pkg_990",
      orderNo: "order-old-query"
    },
    queryResult: {
      order: { orderNo: "order-old-query", status: "fulfilled", grantPoints: 100 },
      account: { pointsBalance: 100 }
    }
  });
  assert.strictEqual(replacedPending.removed, false, "旧查询不得清理后来写入的新 pending");
  assert.strictEqual(replacedPending.stored.requestId, "fixed-replacement-request");
  assert.strictEqual(replacedPending.stored.orderNo, "order-replacement");
  assert.notStrictEqual(replacedPending.data.paymentStatus, "success");

  const pullDownRestore = await runRechargeCase({
    action: "pullDown",
    initialStored: {
      requestId: "fixed-pull-down-request",
      productId: "pkg_990",
      orderNo: "order-pull-down"
    },
    queryResult: {
      order: { orderNo: "order-pull-down", status: "pending" }
    }
  });
  assert.strictEqual(pullDownRestore.queryCalls, 1, "下拉刷新必须同时恢复待确认订单");
  assert.strictEqual(pullDownRestore.pullDownStops, 1, "配置和订单恢复完成后才能结束下拉刷新");
  assert.strictEqual(pullDownRestore.data.paymentStatus, "confirming");

  const restoreGate = {};
  restoreGate.promise = new Promise((resolve) => {
    restoreGate.release = resolve;
  });
  const restoreLocked = await runRechargeCase({
    action: "restore",
    concurrentDuringRestore: true,
    queryGate: restoreGate,
    initialStored: {
      requestId: "fixed-restore-request",
      productId: "pkg_990",
      orderNo: "order-restore-lock"
    },
    queryResult: {
      order: { orderNo: "order-restore-lock", status: "pending" }
    }
  });
  assert.strictEqual(restoreLocked.createPayloads.length, 0, "恢复查询期间不得并发创建新订单");
  assert.strictEqual(restoreLocked.queryCalls, 1);
  assert.strictEqual(restoreLocked.data.paymentStatus, "confirming");

  const unloadGate = {};
  unloadGate.promise = new Promise((resolve) => {
    unloadGate.release = resolve;
  });
  const delayedUnload = await runRechargeCase({
    action: "restore",
    unloadDuringRestore: true,
    queryGate: unloadGate,
    initialStored: {
      requestId: "fixed-delayed-request",
      productId: "pkg_990",
      orderNo: "order-delayed-unload"
    },
    queryResult: {
      order: { orderNo: "order-delayed-unload", status: "fulfilled", grantPoints: 100 },
      account: { pointsBalance: 100 }
    }
  });
  assert.strictEqual(delayedUnload.removed, false, "卸载后的旧查询不得清理 pending");
  assert.strictEqual(delayedUnload.stored.requestId, "fixed-delayed-request");
  assert.notStrictEqual(delayedUnload.data.paymentStatus, "success");

  const removeFailure = await runRechargeCase({
    removeStorageError: new Error("remove failed"),
    createResult: {
      order: { orderNo: "order-remove-failure", status: "fulfilled", channel: "wxpay" },
      payment: validPayment
    },
    queryResult: {
      order: { orderNo: "order-remove-failure", status: "fulfilled", grantPoints: 100 },
      account: { pointsBalance: 100 }
    }
  });
  assert.strictEqual(removeFailure.removed, false, "删除失败不能伪装成已清理");
  assert.ok(removeFailure.stored && removeFailure.stored.orderNo === "order-remove-failure");
  assert.strictEqual(removeFailure.data.paymentStatus, "confirming");
  assert.ok(/清理/.test(removeFailure.data.statusMessage));

  const codeOnlyCanceled = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-code-only-cancel", status: "pending", channel: "wxpay" },
      payment: validPayment
    },
    launchError: Object.assign(new Error("cancelled"), { code: "PAYMENT_CANCELED" })
  });
  assert.strictEqual(codeOnlyCanceled.data.paymentStatus, "canceled", "仅 code=PAYMENT_CANCELED 也要识别取消");
  assert.strictEqual(codeOnlyCanceled.removed, false);

  const errorCodeOnlyCanceled = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-error-code-cancel", status: "pending", channel: "wxpay" },
      payment: validPayment
    },
    launchError: Object.assign(new Error("cancelled"), { errorCode: "PAYMENT_CANCELED" })
  });
  assert.strictEqual(errorCodeOnlyCanceled.data.paymentStatus, "canceled", "仅 errorCode=PAYMENT_CANCELED 也要识别取消");

  let terminalCreateCalls = 0;
  const terminalThenNew = await runRechargeCase({
    submitCount: 2,
    createResult() {
      terminalCreateCalls += 1;
      return terminalCreateCalls === 1
        ? { order: { orderNo: "order-terminal-first", status: "closed", channel: "wxpay" } }
        : { order: { orderNo: "order-new-after-terminal", status: "created", channel: "wxpay" } };
    }
  });
  assert.deepStrictEqual(
    terminalThenNew.requestIds,
    ["fixed-request-1", "fixed-request-2"],
    "终态清理成功后下一笔必须生成新 requestId"
  );
  assert.strictEqual(terminalThenNew.removed, true);

  const fulfilledResume = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-fulfilled", status: "fulfilled", channel: "wxpay" },
      payment: validPayment
    },
    queryResult: {
      order: { orderNo: "order-fulfilled", status: "fulfilled", grantPoints: 100 },
      account: { pointsBalance: 100 }
    }
  });
  assert.strictEqual(fulfilledResume.paymentCalls, 0, "已完成订单不得再次拉起微信支付");
  assert.strictEqual(fulfilledResume.queryCalls, 1, "已完成订单必须查询确认到账结果");
  assert.strictEqual(fulfilledResume.data.paymentStatus, "success");
  assert.strictEqual(fulfilledResume.removed, true, "已完成订单必须清理本地 pending");

  for (const status of [
    "created",
    "creation_unknown",
    "verifying",
    "paid",
    "review",
    "refund_review"
  ]) {
    const result = await runRechargeCase({
      createResult: {
        order: { orderNo: `order-${status}`, status, channel: "wxpay" },
        payment: validPayment
      }
    });
    assert.strictEqual(result.paymentCalls, 0, `${status} 订单不得拉起微信支付`);
    assert.strictEqual(result.data.paymentStatus, "confirming", `${status} 订单必须保持确认状态`);
    assert.ok(result.stored && result.stored.requestId, `${status} 订单必须保留原 requestId`);
    if (status === "review" || status === "refund_review") {
      assert.strictEqual(result.data.statusTitle, "人工核对中");
    }
  }

  const missingLauncher = await runRechargeCase({
    createResult: { order: { orderNo: "order-no-launcher", status: "pending", channel: "wxpay" } }
  });
  assert.strictEqual(missingLauncher.paymentCalls, 0, "缺少支付参数时不得调用 requestPayment");
  assert.strictEqual(missingLauncher.data.paymentStatus, "confirming");
  assert.strictEqual(missingLauncher.data.statusTitle, "支付信息确认中");

  const queryFailure = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-query-failure", status: "fulfilled", channel: "wxpay" },
      payment: validPayment
    },
    queryError: new Error("temporary query failure")
  });
  assert.strictEqual(queryFailure.paymentCalls, 0);
  assert.strictEqual(queryFailure.data.paymentStatus, "confirming", "查询失败不得覆盖成可重试新订单");
  assert.ok(queryFailure.stored && queryFailure.stored.orderNo === "order-query-failure");

  const creationUnknownFailure = await runRechargeCase({
    createResult() {
      const error = new Error("订单创建结果待确认");
      error.payload = {
        order: {
          orderNo: "order-creation-unknown-error",
          status: "creation_unknown",
          channel: "wxpay"
        }
      };
      throw error;
    }
  });
  assert.strictEqual(creationUnknownFailure.paymentCalls, 0);
  assert.strictEqual(creationUnknownFailure.data.paymentStatus, "confirming");
  assert.strictEqual(creationUnknownFailure.stored.orderNo, "order-creation-unknown-error");
  assert.strictEqual(creationUnknownFailure.requestIdCount, 1);

  for (const status of ["closed", "refunded"]) {
    const result = await runRechargeCase({
      createResult: {
        order: { orderNo: `order-${status}`, status, channel: "wxpay" },
        payment: validPayment
      }
    });
    assert.strictEqual(result.paymentCalls, 0, `${status} 订单不得拉起微信支付`);
    assert.strictEqual(result.data.paymentStatus, "terminated", `${status} 订单必须显示终止`);
    assert.strictEqual(result.removed, true, `${status} 订单必须清理本地 pending`);
  }

  const stableRequest = await runRechargeCase({
    submitCount: 2,
    createResult: {
      order: { orderNo: "order-stable-request", status: "created", channel: "wxpay" },
      payment: validPayment
    }
  });
  assert.strictEqual(stableRequest.requestIdCount, 1, "恢复同一订单不得创建新 requestId");
  assert.deepStrictEqual(
    stableRequest.requestIds,
    ["fixed-request-1", "fixed-request-1"],
    "重复确认只能使用原 requestId"
  );

  let conflictAttempts = 0;
  const idempotencyConflict = await runRechargeCase({
    submitCount: 2,
    createResult() {
      conflictAttempts += 1;
      if (conflictAttempts === 1) {
        const error = new Error("request conflict");
        error.code = "IDEMPOTENCY_CONFLICT";
        throw error;
      }
      return {
        order: { orderNo: "order-after-conflict", status: "closed", channel: "wxpay" }
      };
    }
  });
  assert.deepStrictEqual(
    idempotencyConflict.requestIds,
    ["fixed-request-1", "fixed-request-2"],
    "明确幂等冲突后下一次支付必须生成新 requestId"
  );
  assert.strictEqual(idempotencyConflict.paymentCalls, 0, "幂等冲突不得拉起微信支付");

  const pendingLaunch = await runRechargeCase({
    createResult: {
      order: { orderNo: "order-pending", status: "pending", channel: "wxpay" },
      payment: validPayment
    },
    queryResult: {
      order: { orderNo: "order-pending", status: "fulfilled", grantPoints: 100 },
      account: { pointsBalance: 100 }
    }
  });
  assert.strictEqual(pendingLaunch.paymentCalls, 1, "只有 pending 且支付参数完整时可以拉起微信支付");
  assert.strictEqual(pendingLaunch.data.paymentStatus, "success");

  const app = JSON.parse(read("app.json"));
  [
    "pages/user-center/user-center",
    "pages/recharge/recharge",
    "pages/account-records/account-records"
  ].forEach((page) => assert.ok(app.pages.includes(page), `app.json 未注册 ${page}`));
  assert.strictEqual(Object.prototype.hasOwnProperty.call(app, "tabBar"), false);

  const workbenchWxml = read("pages/workbench/workbench.wxml");
  assertIncludes(workbenchWxml, 'bindtap="openUserCenter"', "工作台入口");
  assertIncludes(workbenchWxml, 'aria-label="我的"', "工作台入口");
  assertIncludes(workbenchWxml, "user-center-red-dot", "工作台入口");
  const userCenterJs = read("pages/user-center/user-center.js");
  assert.strictEqual(userCenterJs.includes("openProfile"), false, "用户中心不得保留资料编辑入口");
  assert.strictEqual(userCenterJs.includes("/pages/profile/profile?from=user-center"), false, "用户中心不得跳转资料编辑页");
  assertIncludes(userCenterJs, "nextData.rechargeVisible = config.eligible", "充值资格隐藏逻辑");
  assertIncludes(userCenterJs, "nextData.rechargeDisabled = !config.hasWxpay", "空通道禁用逻辑");
  assertIncludes(userCenterJs, "accountServicePreparing", "账户服务未部署态收口");
  const userCenterWxml = read("pages/user-center/user-center.wxml");
  assertIncludes(userCenterWxml, "账户功能准备中", "账户服务未部署态提示");
  assertIncludes(userCenterWxml, "图片与视频创作统一使用积分", "浏览器原稿余额说明");
  assertIncludes(userCenterWxml, 'class="balance-recharge-hit', "浏览器原稿卡内充值入口");
  assertIncludes(userCenterWxml, 'class="quick-grid ', "浏览器原稿双入口");
  assertIncludes(userCenterWxml, 'class="account-panel"', "浏览器原稿最近记录面板");
  assert.strictEqual(userCenterWxml.includes("编辑"), false, "用户中心界面不得出现编辑功能");
  const userCenterWxss = read("pages/user-center/user-center.wxss");
  assert.ok(/page\s*\{[^}]*background:\s*#f5f7fb/.test(userCenterWxss), "用户中心必须使用 G1 页面底色");
  assert.ok(/\.balance-recharge-hit\s*\{[^}]*height:\s*44px/.test(userCenterWxss), "余额充值触控层必须为 44px");

  const accountServiceSource = read("services/account.js");
  const createStart = accountServiceSource.indexOf("createRechargeOrder(options");
  const createEnd = accountServiceSource.indexOf("queryRechargeOrder", createStart);
  const createSource = accountServiceSource.slice(createStart, createEnd);
  assertIncludes(createSource, "retryLimit: 0", "创建订单调用");
  assertIncludes(createSource, 'channel: "wxpay"', "创建订单调用");
  assert.strictEqual(/amountFen|grantPoints|money/.test(createSource), false, "客户端创建订单不得提交金额或积分");

  const frontendFiles = [
    "app.json",
    "services/account.js",
    "services/payment-launcher.js",
    "utils/account-ui.js",
    "pages/workbench/workbench.js",
    "pages/workbench/workbench.wxml",
    "pages/user-center/user-center.js",
    "pages/user-center/user-center.wxml",
    "pages/recharge/recharge.js",
    "pages/recharge/recharge.wxml",
    "pages/account-records/account-records.js",
    "pages/account-records/account-records.wxml"
  ];
  frontendFiles.forEach((relative) => {
    assert.strictEqual(
      /alipay|支付宝|plugin/i.test(read(relative)),
      false,
      `首版前端不得包含支付宝或插件实现：${relative}`
    );
  });

  delete global.wx;
  console.log("payment ui smoke: OK");
}

main().catch((error) => {
  delete global.wx;
  console.error(error);
  process.exitCode = 1;
});
