/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function assertIncludes(source, marker, label) {
  assert.ok(source.includes(marker), `${label} 缺少 ${marker}`);
}

function loadRecordsPage(accountStub) {
  const pagePath = require.resolve(path.join(root, "pages", "account-records", "account-records.js"));
  const accountPath = require.resolve(path.join(root, "services", "account.js"));
  const oldPage = global.Page;
  const oldWx = global.wx;
  const oldAccount = require.cache[accountPath];
  const oldPageModule = require.cache[pagePath];
  let definition;
  require.cache[accountPath] = { id: accountPath, filename: accountPath, loaded: true, exports: accountStub };
  delete require.cache[pagePath];
  global.Page = (value) => { definition = value; };
  global.wx = {
    stopPullDownRefresh() {}
  };
  delete require.cache[pagePath];
  require(pagePath);
  assert.ok(definition, "收支记录页必须注册 Page");
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); }
  });
  return {
    page,
    restore() {
      global.Page = oldPage;
      global.wx = oldWx;
      if (oldAccount) require.cache[accountPath] = oldAccount;
      else delete require.cache[accountPath];
      if (oldPageModule) require.cache[pagePath] = oldPageModule;
      else delete require.cache[pagePath];
    }
  };
}

async function testIndependentState() {
  const calls = [];
  let overviewReject = false;
  let recordsReject = false;
  let recordsResolve;
  const accountStub = {
    getAccountOverview() {
      calls.push("overview");
      return overviewReject
        ? Promise.reject(new Error("overview down"))
        : Promise.resolve({ account: { pointsBalance: 128, totalPurchasedPoints: 330 } });
    },
    getAccountRecords(options) {
      calls.push(`records:${options.type || "all"}`);
      if (recordsResolve) return recordsResolve;
      return recordsReject
        ? Promise.reject(new Error("records down"))
        : Promise.resolve({ items: [{ id: "r1", type: "checkin", amount: 5, createdAt: "2026-08-31T09:15:00Z" }], hasMore: false });
    }
  };
  const loaded = loadRecordsPage(accountStub);
  const page = loaded.page;
  try {
    page.onLoad();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(calls.includes("overview"), "初始加载必须请求 overview");
    assert.ok(calls.includes("records:all"), "初始加载必须请求 records");
    assert.strictEqual(page.data.summary.pointsBalanceText, "128", "overview 成功后应显示服务端余额");
    assert.strictEqual(page.data.records.length, 1, "records 成功后应显示记录");

    overviewReject = true;
    recordsReject = false;
    await page.loadSummary({ refresh: true });
    assert.ok(page.data.summaryError, "overview 失败必须有独立错误态");
    assert.strictEqual(page.data.records.length, 1, "overview 失败不得抹掉 records");

    overviewReject = false;
    recordsReject = true;
    await page.loadRecords({ reset: true, preserveExisting: true });
    assert.ok(page.data.errorMessage, "records 失败必须有独立错误态");
    assert.strictEqual(page.data.summary.pointsBalanceText, "128", "records 失败不得抹掉 overview");

    recordsReject = false;
    calls.length = 0;
    await page.chooseFilter({ currentTarget: { dataset: { filter: "reward" } } });
    assert.deepStrictEqual(calls, ["records:reward"], "切筛选只能请求 records，不得重复请求 overview");
  } finally {
    loaded.restore();
  }
}

async function testStaleRecordsAreDropped() {
  let firstResolve;
  let secondResolve;
  let request = 0;
  const accountStub = {
    getAccountOverview() {
      return Promise.resolve({ account: { pointsBalance: 7, totalPurchasedPoints: 9 } });
    },
    getAccountRecords() {
      request += 1;
      return new Promise((resolve) => {
        if (request === 1) firstResolve = resolve;
        else secondResolve = resolve;
      });
    }
  };
  const loaded = loadRecordsPage(accountStub);
  const page = loaded.page;
  try {
    const first = page.loadRecords({ reset: true });
    const second = page.loadRecords({ reset: true });
    secondResolve({ items: [{ id: "new", type: "spend", amount: -2 }], hasMore: false });
    await second;
    firstResolve({ items: [{ id: "old", type: "spend", amount: -99 }], hasMore: false });
    await first;
    assert.deepStrictEqual(page.data.records.map((item) => item.id), ["new"], "旧 records 响应必须丢弃");
  } finally {
    loaded.restore();
  }
}

function testStaticContract() {
  const js = read("pages/account-records/account-records.js");
  const wxml = read("pages/account-records/account-records.wxml");
  const wxss = read("pages/account-records/account-records.wxss");
  for (const marker of [
    "loadSummary",
    "_summaryToken",
    "_recordsToken",
    "summaryLoading",
    "summaryError",
    "summaryHasData",
    "getAccountOverview",
    "getAccountRecords",
    "preserveExisting",
    "activeFilter",
    "paginationLimited"
  ]) assertIncludes(js, marker, "记录页独立状态契约");
  for (const marker of [
    'class="record-summary"',
    'class="record-tabs"',
    'class="records-panel account-panel"',
    'class="transaction-row"',
    "summary.pointsBalanceText",
    "summary.totalPurchasedPointsText",
    "filters",
    "filter-button"
  ]) assertIncludes(wxml + wxss, marker, "记录页视觉契约");
  assert.ok(/min-height:\s*44px/.test(wxss), "触控层最小热区必须为 44px");
  assert.strictEqual((wxml.match(/data-filter=/g) || []).length >= 1, true, "筛选按钮必须传递 filter");
  assert.strictEqual((js.match(/id: \"(all|recharge|spend|reward|refund)\"/g) || []).length, 5, "必须有五个互斥筛选");
  assert.ok(/\.record-tabs\s*\{[^}]*display:\s*flex/.test(wxss), "筛选条必须使用等宽横排");
  assert.ok(/\.filter-button[^}]*flex:\s*1/.test(wxss), "筛选按钮必须等宽");
  assert.ok(/overflow-x:\s*hidden/.test(wxss), "记录页必须禁止横向溢出");
  assert.ok(/font-size:\s*\d+px/.test(wxss), "记录页文字必须使用固定 px 字号");
  assertIncludes(wxss, ".transaction-icon-neutral", "未知记录中性色");
  assertIncludes(wxss, ".transaction-amount-neutral", "未知记录中性色");

  assertIncludes(read("pages/user-center/user-center.wxml"), "quick-symbol-wallet", "用户中心充值图标");
  assertIncludes(read("pages/user-center/user-center.wxml"), "quick-symbol-records", "用户中心记录图标");
  assertIncludes(read("pages/recharge/recharge.wxml"), "payment-note-icon", "充值页锁图标");
  assert.ok(/\.quick-symbol-wallet::before\s*\{[^}]*width:\s*42rpx/.test(read("pages/user-center/user-center.wxss")), "充值快捷图标尺寸必须接近 G1");
  assert.ok(/\.quick-symbol-records::before\s*\{[^}]*width:\s*38rpx/.test(read("pages/user-center/user-center.wxss")), "记录快捷图标尺寸必须接近 G1");
  assert.ok(/\.payment-note-icon::before\s*\{/.test(read("pages/recharge/recharge.wxss")), "支付说明必须使用锁形线稿");
}

function testRechargeVisualContract() {
  const js = read("pages/recharge/recharge.js");
  const wxml = read("pages/recharge/recharge.wxml");
  const wxss = read("pages/recharge/recharge.wxss");
  for (const marker of [
    "selectedPackageDisplay",
    "selectedAmountText",
    "selectedGrantPointsText"
  ]) assertIncludes(js, marker, "充值套餐展示契约");
  for (const marker of [
    "本次预计到账",
    "仅支持微信支付",
    'class="package-grid"',
    'class="pay-hit"',
    "selectedAmountText",
    "selectedGrantPointsText"
  ]) assertIncludes(wxml, marker, "充值页视觉契约");
  assert.strictEqual(/支付宝|alipay/i.test(wxml), false, "一期不得出现支付宝入口");
  assert.ok(/\.pay-hit\s*\{[^}]*height:\s*44px/.test(wxss), "支付触控层必须为 44px");
  assert.ok(/\.pay-button\s*\{[^}]*height:\s*38\.5px/.test(wxss), "支付视觉层必须为 38.5px");
  assert.ok(/\.package-grid\s*\{[^}]*display:\s*flex/.test(wxss), "套餐必须三列横排");
  assert.ok(/overflow-x:\s*hidden/.test(wxss), "充值页必须禁止横向溢出");
}

function testRecordDisplayContract() {
  const accountUi = require(path.join(root, "utils", "account-ui.js"));
  const purchase = accountUi.normalizeRecord({
    id: "legacy-purchase",
    type: "purchase",
    amount: 100
  });
  assert.strictEqual(purchase.typeLabel, "历史积分收入");
  assert.strictEqual(purchase.tone, "income");

  for (const sample of [
    { type: "future-v2", amount: 8 },
    { type: "", amount: -3 },
    { type: "unknown", amount: 0 }
  ]) {
    const record = accountUi.normalizeRecord(sample);
    assert.strictEqual(record.typeLabel, "积分变动", "未知类型不得按金额猜测业务类别");
    assert.strictEqual(record.tone, "neutral");
  }
}

async function main() {
  testStaticContract();
  testRechargeVisualContract();
  testRecordDisplayContract();
  await testIndependentState();
  await testStaleRecordsAreDropped();
  console.log("user-center visual smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
