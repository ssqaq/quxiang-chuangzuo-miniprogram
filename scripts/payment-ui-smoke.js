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
  let removed = false;
  let stored = null;
  let pageDefinition;

  const accountStub = {
    createRequestId() {
      requestIdCount += 1;
      return `fixed-request-${requestIdCount}`;
    },
    async createRechargeOrder(payload) {
      requestIds.push(payload.requestId);
      return typeof options.createResult === "function"
        ? options.createResult(payload)
        : options.createResult;
    },
    async queryRechargeOrder(orderNo) {
      queryCalls += 1;
      if (options.queryError) throw options.queryError;
      return typeof options.queryResult === "function"
        ? options.queryResult(orderNo, queryCalls)
        : options.queryResult;
    }
  };
  const launcherStub = {
    async launchPayment() {
      paymentCalls += 1;
      return { errMsg: "requestPayment:ok" };
    }
  };
  const wxStub = {
    getStorageSync() {
      return stored;
    },
    setStorageSync(key, value) {
      stored = Object.assign({}, value);
    },
    removeStorageSync() {
      removed = true;
      stored = null;
    },
    showToast() {}
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
        packages: [{ productId: "pkg_990", amountFen: 990, grantPoints: 100 }],
        selectedProductId: "pkg_990"
      }),
      setData(patch) {
        Object.assign(this.data, patch);
      }
    });
    const submitCount = Math.max(1, Number(options.submitCount) || 1);
    for (let index = 0; index < submitCount; index += 1) {
      await page.submitPayment();
    }
    return {
      data: page.data,
      paymentCalls,
      queryCalls,
      removed,
      stored,
      requestIdCount,
      requestIds
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
      navigateTo() {}
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
    return { data: page.data, page, snapshots, toasts };
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
    ["账户功能准备中", "账户功能准备中"]
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
  assertIncludes(userCenterWxml, 'class="balance-recharge"', "浏览器原稿卡内充值入口");
  assertIncludes(userCenterWxml, 'class="quick-grid"', "浏览器原稿双入口");
  assertIncludes(userCenterWxml, 'class="account-panel"', "浏览器原稿最近记录面板");
  assert.strictEqual(userCenterWxml.includes("编辑"), false, "用户中心界面不得出现编辑功能");
  const userCenterWxss = read("pages/user-center/user-center.wxss");
  assert.strictEqual(
    /background(?:-color)?\s*:\s*#(?:fff|ffffff)\b/i.test(userCenterWxss),
    false,
    "用户中心不得使用纯白色背景"
  );

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
