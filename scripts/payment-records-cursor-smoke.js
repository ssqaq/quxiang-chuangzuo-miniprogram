/* eslint-disable no-console */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function comparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  return value;
}

function compareValues(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function matchesExpected(value, expected) {
  if (expected && expected.__queryOperator === "lt") {
    return compareValues(value, expected.value) < 0;
  }
  if (expected && expected.__queryOperator === "in") {
    return expected.values.some((item) => compareValues(value, item) === 0);
  }
  return compareValues(value, expected) === 0;
}

function matchesCondition(row, condition) {
  if (condition && condition.__logic === "and") {
    return condition.conditions.every((item) => matchesCondition(row, item));
  }
  if (condition && condition.__logic === "or") {
    return condition.conditions.some((item) => matchesCondition(row, item));
  }
  return Object.entries(condition || {}).every(([key, expected]) => (
    matchesExpected(row[key], expected)
  ));
}

function createFakeDatabase(seed) {
  const rows = seed.slice();
  const queryLog = [];
  let failNextGet = null;
  const command = {
    in(values) {
      return { __queryOperator: "in", values: values.slice() };
    },
    lt(value) {
      return { __queryOperator: "lt", value };
    },
    and(...conditions) {
      return { __logic: "and", conditions };
    },
    or(...conditions) {
      return { __logic: "or", conditions };
    }
  };
  const database = {
    command,
    collection(name) {
      assert.strictEqual(name, "point_ledger");
      return {
        where(condition) {
          const order = [];
          let maximum = 20;
          const chain = {
            orderBy(field, direction) {
              order.push({ field, direction });
              return chain;
            },
            limit(value) {
              maximum = Number(value);
              return chain;
            },
            async get() {
              queryLog.push({ condition, order: order.slice(), limit: maximum });
              if (failNextGet) {
                const error = failNextGet;
                failNextGet = null;
                throw error;
              }
              const data = rows
                .filter((row) => matchesCondition(row, condition))
                .sort((left, right) => {
                  for (const rule of order) {
                    const compared = compareValues(left[rule.field], right[rule.field]);
                    if (compared !== 0) return rule.direction === "desc" ? -compared : compared;
                  }
                  return 0;
                })
                .slice(0, maximum)
                .map((row) => Object.assign({}, row));
              return { data };
            }
          };
          return chain;
        }
      };
    },
    insert(row) {
      rows.push(Object.assign({}, row));
    },
    failOnce(error) {
      failNextGet = error;
    },
    queryLog
  };
  return database;
}

function loadPaymentApi(database) {
  const apiRoot = path.join(root, "cloudfunctions", "payment-api");
  const apiPath = path.join(apiRoot, "index.js");
  const sdkPath = require.resolve("wx-server-sdk", { paths: [apiRoot] });
  const oldSdk = require.cache[sdkPath];
  const oldApi = require.cache[apiPath];
  require.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      DYNAMIC_CURRENT_ENV: "test",
      init() {},
      database() {
        return database;
      },
      getWXContext() {
        return {};
      }
    }
  };
  delete require.cache[apiPath];
  const loaded = require(apiPath);
  return {
    api: loaded,
    restore() {
      if (oldSdk) require.cache[sdkPath] = oldSdk;
      else delete require.cache[sdkPath];
      if (oldApi) require.cache[apiPath] = oldApi;
      else delete require.cache[apiPath];
    }
  };
}

async function testServerCursor() {
  const t3 = new Date("2026-08-30T03:00:00.000Z");
  const t2 = new Date("2026-08-30T02:00:00.000Z");
  const t1 = new Date("2026-08-30T01:00:00.000Z");
  const database = createFakeDatabase([
    { _id: "same-z", openid: "user-a", type: "recharge", amount: 10, createdAt: t3 },
    { _id: "same-y", openid: "user-a", type: "spend", amount: -2, createdAt: t3 },
    { _id: "same-x", openid: "user-a", type: "refund", amount: 2, createdAt: t3 },
    { _id: "older-z", openid: "user-a", type: "recharge", amount: 20, createdAt: t2 },
    { _id: "oldest-z", openid: "user-a", type: "checkin", amount: 1, createdAt: t1 },
    { _id: "other-z", openid: "user-b", type: "recharge", amount: 999, createdAt: t3 }
  ]);
  const loaded = loadPaymentApi(database);
  const helpers = loaded.api.__test__;
  const fallbackHelpers = require(path.join(root, "services", "account.js")).__test__;
  try {
    const first = await helpers.loadRecords("user-a", { type: "all", limit: 2 });
    assert.deepStrictEqual(first.items.map((item) => item.id), ["same-z", "same-y"]);
    assert.strictEqual(first.hasMore, true);
    assert.strictEqual(typeof first.nextCursor, "string");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(first, "nextOffset"), false);
    assert.deepStrictEqual(database.queryLog[0].order, [
      { field: "createdAt", direction: "desc" },
      { field: "_id", direction: "desc" }
    ]);

    database.insert({
      _id: "inserted-after-first-page",
      openid: "user-a",
      type: "recharge",
      amount: 30,
      createdAt: new Date("2026-08-30T04:00:00.000Z")
    });
    const second = await helpers.loadRecords("user-a", {
      type: "all",
      limit: 2,
      cursor: first.nextCursor
    });
    assert.deepStrictEqual(second.items.map((item) => item.id), ["same-x", "older-z"]);
    assert.strictEqual(second.hasMore, true);
    const third = await helpers.loadRecords("user-a", {
      type: "all",
      limit: 2,
      cursor: second.nextCursor
    });
    assert.deepStrictEqual(third.items.map((item) => item.id), ["oldest-z"]);
    assert.strictEqual(third.hasMore, false);
    assert.strictEqual(third.nextCursor, null);

    const recharge = await helpers.loadRecords("user-a", { type: "recharge", limit: 10 });
    assert.deepStrictEqual(
      recharge.items.map((item) => item.id),
      ["inserted-after-first-page", "same-z", "older-z"]
    );

    [
      { _id: "daily-free-z", openid: "user-a", type: "daily-free", amount: 0, createdAt: new Date("2026-08-29T03:00:00.000Z") },
      { _id: "promo-free-z", openid: "user-a", type: "promo-free", amount: 0, createdAt: new Date("2026-08-29T02:00:00.000Z") },
      { _id: "reversal-z", openid: "user-a", type: "payment-reversal", amount: -10, createdAt: new Date("2026-08-29T01:00:00.000Z") },
      { _id: "purchase-z", openid: "user-a", type: "purchase", amount: 10, createdAt: new Date("2026-08-29T00:00:00.000Z") },
      { _id: "unknown-z", openid: "user-a", type: "future-v2", amount: 1, createdAt: new Date("2026-08-28T23:00:00.000Z") }
    ].forEach((row) => database.insert(row));

    const expectedFilterTypes = {
      all: [],
      recharge: ["recharge"],
      spend: ["spend"],
      reward: ["checkin", "daily-free", "promo-free"],
      refund: ["refund", "payment-reversal"]
    };
    Object.entries(expectedFilterTypes).forEach(([filter, types]) => {
      assert.deepStrictEqual(helpers.recordTypes(filter), types, `${filter} 云函数类型矩阵必须固定`);
      assert.deepStrictEqual(
        fallbackHelpers.recordTypes(filter),
        types,
        `${filter} 云函数与回退类型矩阵必须一致`
      );
    });
    assert.deepStrictEqual(
      helpers.recordTypes(" Reward "),
      expectedFilterTypes.reward,
      "云函数筛选必须先 trim 并转成小写"
    );
    assert.deepStrictEqual(
      fallbackHelpers.recordTypes(" Reward "),
      expectedFilterTypes.reward,
      "云函数与回退必须接受相同的大小写输入"
    );

    const reward = await helpers.loadRecords("user-a", { type: " Reward ", limit: 50 });
    assert.deepStrictEqual(
      reward.items.map((item) => item.id),
      ["oldest-z", "daily-free-z", "promo-free-z"],
      "奖励筛选不得再包含退款"
    );
    const refunds = await helpers.loadRecords("user-a", { type: "refund", limit: 50 });
    assert.deepStrictEqual(refunds.items.map((item) => item.id), ["same-x", "reversal-z"]);
    const allWithUnknown = await helpers.loadRecords("user-a", { type: "all", limit: 50 });
    assert.ok(allWithUnknown.items.some((item) => item.id === "purchase-z"), "全部筛选必须保留旧类型");
    assert.ok(allWithUnknown.items.some((item) => item.id === "unknown-z"), "全部筛选必须保留未知类型");
    for (const filter of ["recharge", "spend", "reward", "refund"]) {
      const filtered = await helpers.loadRecords("user-a", { type: filter, limit: 50 });
      assert.strictEqual(filtered.items.some((item) => item.id === "purchase-z"), false);
      assert.strictEqual(filtered.items.some((item) => item.id === "unknown-z"), false);
    }

    database.failOnce(new Error("database unavailable after invalid filter"));
    await assert.rejects(
      helpers.loadRecords("user-a", { type: " Unsupported ", cursor: "not-a-cursor", limit: 2 }),
      (error) => error && error.code === "PAYMENT_RECORD_FILTER_INVALID"
    );
    await assert.rejects(
      helpers.loadRecords("user-a", { type: "all", limit: 2 }),
      (error) => error && error.code === "PAYMENT_RECORDS_UNAVAILABLE",
      "非法筛选不得消费已排队的数据库错误"
    );

    assert.throws(
      () => helpers.decodeRecordCursor(first.nextCursor, "user-b", "all"),
      (error) => error && error.code === "PAYMENT_RECORD_CURSOR_INVALID"
    );
    assert.throws(
      () => helpers.decodeRecordCursor(first.nextCursor, "user-a", "spend"),
      (error) => error && error.code === "PAYMENT_RECORD_CURSOR_INVALID"
    );
    const tampered = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("A") ? "B" : "A"}`;
    assert.throws(
      () => helpers.decodeRecordCursor(tampered, "user-a", "all"),
      (error) => error && error.code === "PAYMENT_RECORD_CURSOR_INVALID"
    );
    for (const invalid of [1, " ", "not-a-cursor", `${first.nextCursor} `]) {
      assert.throws(
        () => helpers.decodeRecordCursor(invalid, "user-a", "all"),
        (error) => error && error.code === "PAYMENT_RECORD_CURSOR_INVALID"
      );
    }

    const timestampCursor = helpers.encodeRecordCursor({
      _id: "timestamp-row",
      createdAt: { toDate: () => new Date("2026-08-30T05:00:00.000Z") }
    }, "user-a", "all");
    assert.strictEqual(
      helpers.decodeRecordCursor(timestampCursor, "user-a", "all").createdAt.toISOString(),
      "2026-08-30T05:00:00.000Z"
    );
    assert.strictEqual(
      helpers.recordDateMillis({
        _bsontype: "Timestamp",
        high: 1788066000,
        low: 987654321
      }),
      1788066000000,
      "BSON Timestamp 必须读取 high 秒位，不能把 low 递增序号当时间"
    );

    database.failOnce(new Error("database unavailable"));
    await assert.rejects(
      helpers.loadRecords("user-a", { type: "all", limit: 2 }),
      (error) => error && error.code === "PAYMENT_RECORDS_UNAVAILABLE" && error.retryable === true
    );
    assert.throws(
      () => helpers.normalizeRecordFilter("unsupported"),
      (error) => error && error.code === "PAYMENT_RECORD_FILTER_INVALID"
    );
  } finally {
    loaded.restore();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function testPageCursorState() {
  const pagePath = path.join(root, "pages", "account-records", "account-records.js");
  const servicePath = require.resolve(path.join(root, "services", "account.js"));
  const uiPath = require.resolve(path.join(root, "utils", "account-ui.js"));
  const oldPageModule = require.cache[pagePath];
  const oldService = require.cache[servicePath];
  const oldUi = require.cache[uiPath];
  const realUi = require(uiPath);
  const oldPage = global.Page;
  const calls = [];
  const responses = [];
  let definition;
  require.cache[servicePath] = {
    id: servicePath,
    filename: servicePath,
    loaded: true,
    exports: {
      getAccountRecords(options) {
        calls.push(Object.assign({}, options));
        const next = responses.shift();
        return next && next.promise ? next.promise : Promise.resolve(next);
      }
    }
  };
  require.cache[uiPath] = {
    id: uiPath,
    filename: uiPath,
    loaded: true,
    exports: {
      normalizeRecords: (items) => items.slice(),
      userErrorMessage: realUi.userErrorMessage
    }
  };
  delete require.cache[pagePath];
  global.Page = (value) => { definition = value; };
  require(pagePath);
  const page = Object.assign({}, definition, {
    data: Object.assign({}, definition.data),
    setData(patch) {
      Object.assign(this.data, patch);
    }
  });
  try {
    responses.push({ items: [{ id: "one" }, { id: "two" }], nextCursor: "cursor-1", hasMore: true });
    await page.loadRecords(true);
    assert.strictEqual(calls[0].cursor, "");
    assert.deepStrictEqual(page.data.records.map((item) => item.id), ["one", "two"]);
    assert.strictEqual(page.data.nextCursor, "cursor-1");
    assert.strictEqual(page.data.hasMore, true);

    responses.push({ items: [{ id: "three" }], nextCursor: null, hasMore: false });
    await page.loadRecords(false);
    assert.strictEqual(calls[1].cursor, "cursor-1");
    assert.deepStrictEqual(page.data.records.map((item) => item.id), ["one", "two", "three"]);

    const pending = deferred();
    responses.push(pending);
    const resetPromise = page.loadRecords(true);
    assert.deepStrictEqual(page.data.records, [], "刷新或切换筛选必须立即清空旧记录");
    assert.strictEqual(page.data.nextCursor, null, "刷新或切换筛选必须立即清空游标");
    pending.resolve({ items: [{ id: "fresh" }], nextCursor: "cursor-fresh", hasMore: true });
    await resetPromise;

    const existingRecords = page.data.records.slice();
    responses.push(Promise.reject(new Error("网络故障")));
    await page.loadRecords(false);
    assert.deepStrictEqual(page.data.records, existingRecords, "追加失败不得伪装成空记录");
    assert.strictEqual(page.data.nextCursor, "cursor-fresh", "追加失败必须保留原游标以便重试");
    assert.strictEqual(page.data.errorMessage, "收支记录读取失败，请重试。");

    responses.push({ items: [], nextCursor: null, hasMore: true });
    await page.loadRecords(true);
    assert.strictEqual(page.data.errorMessage, "收支记录已更新，请重新加载。");
    assert.deepStrictEqual(page.data.records, []);
  } finally {
    global.Page = oldPage;
    if (oldPageModule) require.cache[pagePath] = oldPageModule;
    else delete require.cache[pagePath];
    if (oldService) require.cache[servicePath] = oldService;
    else delete require.cache[servicePath];
    if (oldUi) require.cache[uiPath] = oldUi;
    else delete require.cache[uiPath];
  }
}

async function main() {
  const apiSource = fs.readFileSync(path.join(root, "cloudfunctions", "payment-api", "index.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(root, "services", "account.js"), "utf8");
  const pageSource = fs.readFileSync(path.join(root, "pages", "account-records", "account-records.js"), "utf8");
  assert.strictEqual(/\.skip\s*\(/.test(apiSource), false, "账户记录查询不得再使用 offset/skip");
  assert.ok(apiSource.includes('.orderBy("createdAt", "desc")'));
  assert.ok(apiSource.includes('.orderBy("_id", "desc")'));
  assert.strictEqual(/nextOffset|options\.offset/.test(`${serviceSource}\n${pageSource}`), false);
  await testServerCursor();
  await testPageCursorState();
  console.log("payment records cursor smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
