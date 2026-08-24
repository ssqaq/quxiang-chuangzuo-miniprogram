/* eslint-disable no-console */

const assert = require("assert");

process.env.WECHAT_MINIAPP_TEST = "1";
process.env.PROMO_START_DATE = "2000-01-01";
process.env.PROMO_END_DATE = "2099-12-31";
process.env.DAILY_FREE_LIMIT = "0";

const api = require("../cloudfunctions/api/index.js");
const helpers = api.__test;
const db = helpers.getTestDatabase();

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function createMemoryStore() {
  const records = new Map();
  const getCollection = (name) => ({
    doc(id) {
      const key = `${name}/${id}`;
      return {
        async get() {
          if (!records.has(key)) {
            const error = new Error("document not exist");
            error.code = "DATABASE_DOCUMENT_NOT_EXIST";
            throw error;
          }
          return { data: clone(records.get(key)) };
        },
        async set({ data }) {
          if (data && Object.prototype.hasOwnProperty.call(data, "_id")) {
            const error = new Error("不能更新_id的值");
            error.code = "-501007";
            throw error;
          }
          records.set(key, clone(data));
          return { stats: { updated: 1 } };
        }
      };
    }
  });
  return {
    records,
    collection: getCollection
  };
}

function valuesFor(store, collectionName) {
  const prefix = `${collectionName}/`;
  return [...store.records.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value);
}

async function main() {
  const store = createMemoryStore();
  const originalCollection = db.collection;
  const originalRunTransaction = db.runTransaction;
  let transactionTail = Promise.resolve();

  db.collection = store.collection;
  db.runTransaction = async (callback) => {
    let release;
    const waitForPrevious = transactionTail;
    transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await waitForPrevious;
    try {
      return await callback({ collection: store.collection });
    } finally {
      release();
    }
  };

  try {
    const user = { OPENID: "concurrency-user" };
    const checkins = await Promise.all(
      Array.from({ length: 10 }, () => helpers.checkIn(user))
    );
    assert.strictEqual(checkins.filter((item) => !item.duplicate).length, 1);
    assert.strictEqual(
      valuesFor(store, "point_ledger").filter((item) => item.type === "checkin").length,
      1
    );

    const requestId = "same-image-request";
    const reservations = await Promise.all(
      Array.from({ length: 10 }, () => helpers.reserveUsage(user.OPENID, requestId, "image"))
    );
    assert.strictEqual(reservations.filter((item) => !item.alreadyReserved).length, 1);
    assert.strictEqual(
      valuesFor(store, "generation_operations").filter((item) => item.requestId === requestId).length,
      1
    );

    const claims = await Promise.all(
      Array.from({ length: 10 }, () => helpers.claimGenerationOperation(user.OPENID, requestId, "image"))
    );
    assert.strictEqual(claims.filter((item) => item.claimed).length, 1);

    await helpers.failGenerationOperation(user.OPENID, requestId, new Error("provider failed"));
    const refunds = await Promise.all(
      Array.from({ length: 10 }, () => helpers.refundUsage(
        user.OPENID,
        requestId,
        "并发测试退款"
      ))
    );
    assert.strictEqual(refunds.filter((item) => item && !item.duplicate).length, 1);
    const refundedOperation = valuesFor(store, "generation_operations")
      .find((item) => item.requestId === requestId);
    assert.strictEqual(refundedOperation.status, "refunded");
    await assert.rejects(
      () => helpers.reserveUsage(user.OPENID, requestId, "image"),
      (error) => error && error.code === "request-refunded"
    );

    const videoRequestId = "same-video-request";
    await helpers.reserveUsage(user.OPENID, videoRequestId, "video");
    const videoClaims = await Promise.all(
      Array.from({ length: 10 }, () => helpers.claimGenerationOperation(
        user.OPENID,
        videoRequestId,
        "video"
      ))
    );
    assert.strictEqual(videoClaims.filter((item) => item.claimed).length, 1);

    process.env.PROMO_END_DATE = "2000-01-01";
    const poorUser = { OPENID: "poor-user" };
    const insufficient = await Promise.all(
      Array.from({ length: 5 }, (_, index) => helpers.reserveUsage(
        poorUser.OPENID,
        `insufficient-${index}`,
        "image"
      ).then(
        () => true,
        (error) => error && error.code === "points-insufficient"
      ))
    );
    assert.ok(insufficient.every(Boolean));

    process.env.ADMIN_OPENIDS = "admin-user";
    process.env.ADMIN_RUNTIME_CONFIG_SMOKE = "1";
    await helpers.saveAdminConfig(
      { config: { points: { dailyFreeLimit: 8 } } },
      { OPENID: "admin-user" }
    );
    const cache = helpers.getAdminRuntimeCache();
    assert.strictEqual(cache.value.points.dailyFreeLimit, 8);

    console.log("generation concurrency smoke: OK (check-in/reserve/claim/refund/retry-lock/cache)");
  } finally {
    db.collection = originalCollection;
    db.runTransaction = originalRunTransaction;
    delete process.env.ADMIN_RUNTIME_CONFIG_SMOKE;
    delete process.env.ADMIN_OPENIDS;
  }
}

main().catch((error) => {
  console.error(`generation concurrency smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
