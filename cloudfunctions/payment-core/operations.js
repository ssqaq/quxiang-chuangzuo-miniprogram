"use strict";

const {
  PAYMENT_COLLECTIONS,
  RECONCILE_LEASE_MS,
  NOT_FOUND_REVIEW_THRESHOLD,
  PROVIDER_CHANNEL
} = require("./constants");
const {
  sha256,
  hashObject,
  randomToken,
  moneyToFen
} = require("./crypto");
const {
  paymentLedgerId,
  callbackEventId,
  callbackPayloadHash
} = require("./idempotency");
const { transitionOrder } = require("./state-machine");
const { paymentError } = require("./errors");
const {
  readDocument,
  stripDocumentId,
  pointsAccountId,
  dateMillis,
  defaultPointsAccount,
  accountView,
  orderView
} = require("./storage");
const { providerData } = require("./provider-xingju");

function callbackEventFields(payload, orderId, eventId, payloadHash, now) {
  return {
    _id: eventId,
    orderId: orderId || "",
    eventType: "callback_received",
    provider: "xingju",
    outTradeNo: String(payload.out_trade_no || ""),
    providerTradeNo: String(payload.trade_no || "").slice(0, 100),
    providerStatus: String(payload.trade_status || "").slice(0, 80),
    channel: String(payload.type || "").slice(0, 24),
    amountFen: moneyToFen(payload.money),
    pidHash: sha256(String(payload.pid || "")),
    callbackTimestamp: Number(payload.timestamp) || 0,
    payloadHash,
    createdAt: now
  };
}

function callbackEventMatches(existing, expected) {
  return [
    "orderId",
    "outTradeNo",
    "providerTradeNo",
    "providerStatus",
    "channel",
    "amountFen",
    "pidHash",
    "payloadHash"
  ].every((key) => String(existing && existing[key]) === String(expected && expected[key]));
}

function callbackOrderMismatches(order, payload, providerConfig) {
  const mismatches = [];
  const amountFen = moneyToFen(payload.money);
  if (!String(payload.out_trade_no || "") || payload.out_trade_no !== order.outTradeNo) {
    mismatches.push("outTradeNo");
  }
  if (!String(payload.trade_no || "").trim()) mismatches.push("providerTradeNo");
  if (String(payload.trade_status || "") !== "TRADE_SUCCESS") mismatches.push("tradeStatus");
  if (String(payload.type || "") !== PROVIDER_CHANNEL || order.channel !== PROVIDER_CHANNEL) {
    mismatches.push("channel");
  }
  if (amountFen === null || amountFen !== Number(order.amountFen)) mismatches.push("amountFen");
  if (
    !String(payload.pid || "")
    || String(payload.pid) !== String(providerConfig.pid)
    || String(order.pid || "") !== String(providerConfig.pid)
  ) {
    mismatches.push("pid");
  }
  if (
    order.providerTradeNo
    && String(order.providerTradeNo) !== String(payload.trade_no || "")
  ) {
    mismatches.push("providerTradeNo");
  }
  return mismatches;
}

async function findOrderByOutTradeNo(db, outTradeNo) {
  const result = await db
    .collection(PAYMENT_COLLECTIONS.orders)
    .where({ outTradeNo: String(outTradeNo || "") })
    .limit(1)
    .get();
  return result && Array.isArray(result.data) ? result.data[0] || null : null;
}

async function writeOrphanCallback(db, event, reason) {
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PAYMENT_COLLECTIONS.events).doc(event._id);
    const existing = await readDocument(ref);
    if (existing) {
      return { duplicate: callbackEventMatches(existing, event), conflict: !callbackEventMatches(existing, event) };
    }
    await ref.set({
      data: stripDocumentId(Object.assign({}, event, {
        eventType: "callback_orphan",
        outcome: "fail",
        reason: String(reason || "order_not_found").slice(0, 120),
        attentionRequired: true
      }))
    });
    return { duplicate: false, conflict: false };
  }, 5);
}

async function persistCallbackReceipt(options) {
  const db = options.db;
  const payload = options.payload || {};
  const providerConfig = options.providerConfig;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const outTradeNo = String(payload.out_trade_no || "").trim();
  const eventId = callbackEventId(payload);
  const payloadHash = callbackPayloadHash(payload);
  let found = outTradeNo ? await findOrderByOutTradeNo(db, outTradeNo) : null;
  const initialEvent = callbackEventFields(payload, found && found._id, eventId, payloadHash, now);
  if (!found) {
    await writeOrphanCallback(db, initialEvent, "order_not_found");
    return { ack: "fail", reason: "order_not_found", order: null };
  }

  return db.runTransaction(async (transaction) => {
    const orderRef = transaction.collection(PAYMENT_COLLECTIONS.orders).doc(found._id);
    const eventRef = transaction.collection(PAYMENT_COLLECTIONS.events).doc(eventId);
    const order = await readDocument(orderRef);
    if (!order) {
      const error = new Error("PAYMENT_ORDER_DISAPPEARED");
      error.code = "PAYMENT_ORDER_DISAPPEARED";
      throw error;
    }
    const event = callbackEventFields(payload, order._id, eventId, payloadHash, now);
    const existingEvent = await readDocument(eventRef);
    if (existingEvent) {
      if (callbackEventMatches(existingEvent, event)) {
        if (
          existingEvent.outcome === "success"
          && ["closed", "refunded"].includes(order.status)
        ) {
          const conflictId = sha256(
            `payment-event:callback-late-conflict:${eventId}:${order.status}:${payloadHash}`
          );
          const conflictRef = transaction.collection(PAYMENT_COLLECTIONS.events).doc(conflictId);
          if (!await readDocument(conflictRef)) {
            await conflictRef.set({
              data: stripDocumentId(Object.assign({}, event, {
                _id: conflictId,
                eventType: "callback_late_conflict",
                outcome: "fail",
                originalEventId: eventId,
                fromStatus: order.status,
                attentionRequired: true
              }))
            });
          }
          const review = transitionOrder(order, "review", { updatedAt: now }, {
            reviewReason: "late_success_callback",
            reviewEvidence: {
              eventId,
              conflictId,
              payloadHash,
              fromStatus: order.status
            },
            now
          });
          await orderRef.set({ data: stripDocumentId(review) });
          return { ack: "fail", duplicate: true, conflict: true, order: review };
        }
        if (["review", "refund_review"].includes(order.status)) {
          const stopped = transitionOrder(order, order.status, {
            attentionRequired: true,
            updatedAt: now
          });
          await orderRef.set({ data: stripDocumentId(stopped) });
          return { ack: "fail", duplicate: true, order: stopped };
        }
        return {
          ack: existingEvent.outcome === "success" ? "success" : "fail",
          duplicate: true,
          order
        };
      }
      const conflictId = sha256(`payment-event:callback-conflict:${eventId}:${payloadHash}`);
      const conflictRef = transaction.collection(PAYMENT_COLLECTIONS.events).doc(conflictId);
      const existingConflict = await readDocument(conflictRef);
      if (!existingConflict) {
        await conflictRef.set({
          data: stripDocumentId(Object.assign({}, event, {
            _id: conflictId,
            eventType: "callback_duplicate_conflict",
            outcome: "fail",
            originalEventId: eventId,
            attentionRequired: true
          }))
        });
      }
      const review = transitionOrder(order, "review", {
        attentionRequired: true,
        updatedAt: now
      }, {
        reviewReason: "callback_duplicate_conflict",
        reviewEvidence: { eventId, conflictId, payloadHash },
        now
      });
      await orderRef.set({ data: stripDocumentId(review) });
      return { ack: "fail", conflict: true, order: review };
    }

    const mismatches = callbackOrderMismatches(order, payload, providerConfig);
    if (mismatches.length) {
      await eventRef.set({
        data: stripDocumentId(Object.assign({}, event, {
          eventType: "callback_mismatch",
          outcome: "fail",
          mismatchFields: mismatches,
          attentionRequired: true
        }))
      });
      const review = transitionOrder(order, "review", {
        attentionRequired: true,
        updatedAt: now
      }, {
        reviewReason: "callback_mismatch",
        reviewEvidence: { eventId, mismatchFields: mismatches, payloadHash },
        now
      });
      await orderRef.set({ data: stripDocumentId(review) });
      return { ack: "fail", mismatch: true, order: review };
    }

    if (["closed", "refunded"].includes(order.status)) {
      await eventRef.set({
        data: stripDocumentId(Object.assign({}, event, {
          eventType: "callback_late_conflict",
          outcome: "fail",
          attentionRequired: true
        }))
      });
      const review = transitionOrder(order, "review", { updatedAt: now }, {
        reviewReason: "late_success_callback",
        reviewEvidence: { eventId, payloadHash, fromStatus: order.status },
        now
      });
      await orderRef.set({ data: stripDocumentId(review) });
      return { ack: "fail", conflict: true, order: review };
    }

    if (["review", "refund_review"].includes(order.status)) {
      await eventRef.set({
        data: stripDocumentId(Object.assign({}, event, {
          eventType: "callback_while_review",
          outcome: "fail",
          attentionRequired: true
        }))
      });
      const stopped = transitionOrder(order, order.status, {
        attentionRequired: true,
        updatedAt: now
      });
      await orderRef.set({ data: stripDocumentId(stopped) });
      return { ack: "fail", order: stopped };
    }

    const next = ["created", "creation_unknown", "pending"].includes(order.status)
      ? transitionOrder(order, "verifying", {}, {})
      : Object.assign({}, order);
    next.callbackSuccessVerified = true;
    next.callbackVerifiedAt = now;
    next.lastCallbackEventId = eventId;
    next.providerTradeNo = String(payload.trade_no);
    next.providerStatus = String(payload.trade_status);
    next.reconcileRequired = next.status !== "fulfilled";
    next.nextReconcileAt = next.status === "fulfilled" ? null : now;
    next.reconcileLeaseOwner = "";
    next.reconcileLeaseToken = "";
    next.reconcileLeaseUntil = null;
    next.updatedAt = now;

    await eventRef.set({
      data: stripDocumentId(Object.assign({}, event, {
        eventType: order.status === "fulfilled" ? "callback_duplicate" : "callback_received",
        outcome: "success"
      }))
    });
    await orderRef.set({ data: stripDocumentId(next) });
    return {
      ack: "success",
      duplicate: order.status === "fulfilled",
      order: next
    };
  }, 5);
}

function ledgerMatchesOrder(ledger, order) {
  const billing = ledger && ledger.billing || {};
  return Boolean(
    ledger
    && ledger.openid === order.openid
    && ledger.requestId === `payment:${order.outTradeNo}`
    && ledger.type === "recharge"
    && Number(ledger.amount) === Number(order.grantPoints)
    && billing.source === "payment"
    && billing.orderId === order._id
    && billing.outTradeNo === order.outTradeNo
    && billing.productId === order.productId
    && Number(billing.amountFen) === Number(order.amountFen)
    && Number(billing.grantPoints) === Number(order.grantPoints)
    && billing.channel === order.channel
    && billing.provider === order.provider
    && billing.providerTradeNo === String(order.providerTradeNo || "")
    && billing.pidHash === sha256(String(order.pid || ""))
  );
}

function fenceMatches(order, fence) {
  if (!fence) return true;
  return order.reconcileLeaseOwner === fence.owner
    && order.reconcileLeaseToken === fence.token
    && Number(order.reconcileLeaseEpoch) === Number(fence.epoch)
    && Number(order.statusVersion) === Number(fence.statusVersion);
}

async function fulfillPaidOrder(options) {
  const db = options.db;
  const orderId = String(options.orderId || "");
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const fence = options.fence || null;
  return db.runTransaction(async (transaction) => {
    const orderRef = transaction.collection(PAYMENT_COLLECTIONS.orders).doc(orderId);
    const order = await readDocument(orderRef);
    if (!order) throw paymentError("PAYMENT_ORDER_NOT_FOUND", "充值订单不存在。");
    if (!fenceMatches(order, fence)) return { skipped: true, reason: "fence_lost", order };
    const ledgerId = paymentLedgerId(order.outTradeNo);
    const ledgerRef = transaction.collection(PAYMENT_COLLECTIONS.pointsLedger).doc(ledgerId);
    const ledger = await readDocument(ledgerRef);

    if (order.status === "fulfilled") {
      if (ledgerMatchesOrder(ledger, order)) {
        return { duplicate: true, order, ledger };
      }
      const review = transitionOrder(order, "review", { updatedAt: now }, {
        reviewReason: "fulfilled_ledger_inconsistent",
        reviewEvidence: { ledgerId, ledgerExists: Boolean(ledger) },
        now
      });
      await orderRef.set({ data: stripDocumentId(review) });
      return { review: true, order: review };
    }
    if (order.status !== "paid") return { skipped: true, reason: "status_not_paid", order };
    if (ledger) {
      const review = transitionOrder(order, "review", { updatedAt: now }, {
        reviewReason: "ledger_exists_before_fulfilled",
        reviewEvidence: {
          ledgerId,
          ledgerMatches: ledgerMatchesOrder(ledger, order)
        },
        now
      });
      await orderRef.set({ data: stripDocumentId(review) });
      return { review: true, order: review, ledger };
    }

    const accountId = pointsAccountId(order.openid);
    const accountRef = transaction.collection(PAYMENT_COLLECTIONS.pointsAccounts).doc(accountId);
    const account = (await readDocument(accountRef)) || defaultPointsAccount(order.openid, now);
    account.pointsBalance = Math.max(0, Number(account.pointsBalance) || 0) + Number(order.grantPoints);
    account.totalPurchasedPoints = Math.max(0, Number(account.totalPurchasedPoints) || 0)
      + Number(order.grantPoints);
    account.totalReversedPurchasedPoints = Math.max(
      0,
      Number(account.totalReversedPurchasedPoints) || 0
    );
    account.updatedAt = now;
    const nextLedger = {
      _id: ledgerId,
      openid: order.openid,
      requestId: `payment:${order.outTradeNo}`,
      type: "recharge",
      kind: "payment",
      amount: Number(order.grantPoints),
      balanceAfter: account.pointsBalance,
      description: `充值获得 ${order.grantPoints} 积分`,
      createdAt: now,
      billing: {
        source: "payment",
        orderId: order._id,
        outTradeNo: order.outTradeNo,
        productId: order.productId,
        amountFen: Number(order.amountFen),
        grantPoints: Number(order.grantPoints),
        channel: order.channel,
        provider: order.provider,
        providerTradeNo: order.providerTradeNo || "",
        pidHash: sha256(String(order.pid || ""))
      }
    };
    const fulfilled = transitionOrder(order, "fulfilled", {
      fulfilledAt: now,
      fulfillmentLedgerId: ledgerId,
      fulfillmentError: "",
      reconcileRequired: false,
      nextReconcileAt: null,
      reconcileLeaseOwner: "",
      reconcileLeaseToken: "",
      reconcileLeaseUntil: null,
      updatedAt: now
    });
    await accountRef.set({ data: stripDocumentId(account) });
    await ledgerRef.set({ data: stripDocumentId(nextLedger) });
    await orderRef.set({ data: stripDocumentId(fulfilled) });
    return {
      duplicate: false,
      order: fulfilled,
      ledger: nextLedger,
      account: accountView(account)
    };
  }, 5);
}

function reconcileDelayMs(order, now, attemptCount) {
  const age = Math.max(0, now.getTime() - dateMillis(order.createdAt));
  if (age >= 24 * 60 * 60 * 1000) return 4 * 60 * 60 * 1000;
  const schedule = [60, 5 * 60, 15 * 60, 60 * 60];
  return schedule[Math.min(schedule.length - 1, Math.max(0, attemptCount - 1))] * 1000;
}

async function claimReconcileLease(options) {
  const db = options.db;
  const orderId = String(options.orderId || "");
  const owner = String(options.owner || "worker").slice(0, 100);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const token = options.token || randomToken();
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PAYMENT_COLLECTIONS.orders).doc(orderId);
    const order = await readDocument(ref);
    if (!order || !order.reconcileRequired) return null;
    if (dateMillis(order.nextReconcileAt) > now.getTime()) return null;
    if (dateMillis(order.reconcileLeaseUntil) > now.getTime()) return null;
    if (!["created", "creation_unknown", "pending", "verifying", "paid"].includes(order.status)) {
      // 兼容人工导入或旧版本遗留的脏调度标记：本次扫到就原子清掉，
      // 避免最早一批 review/终态订单永久占满候选窗口。
      await ref.update({
        data: {
          reconcileRequired: false,
          nextReconcileAt: null,
          reconcileLeaseOwner: "",
          reconcileLeaseToken: "",
          reconcileLeaseUntil: null,
          reconcileLeaseStatusVersion: Number(order.statusVersion) || 0,
          updatedAt: now
        }
      });
      return null;
    }
    const fence = {
      owner,
      token,
      epoch: (Number(order.reconcileLeaseEpoch) || 0) + 1,
      statusVersion: Number(order.statusVersion) || 0
    };
    const next = Object.assign({}, order, {
      reconcileLeaseOwner: fence.owner,
      reconcileLeaseToken: fence.token,
      reconcileLeaseEpoch: fence.epoch,
      reconcileLeaseStatusVersion: fence.statusVersion,
      reconcileLeaseUntil: new Date(now.getTime() + RECONCILE_LEASE_MS),
      reconcileClaimedAt: now,
      updatedAt: now
    });
    await ref.set({ data: stripDocumentId(next) });
    return { order: next, fence };
  }, 5);
}

function queryEnvelope(response) {
  const nested = providerData(response);
  return Object.assign({}, response || {}, nested || {});
}

function classifyProviderQuery(order, response, expectedPid) {
  if (!response || response.__verified !== true) {
    return { kind: "mismatch", mismatchFields: ["signature"] };
  }
  const data = queryEnvelope(response);
  if (data.not_found === true || String(data.status || "").toUpperCase() === "NOT_FOUND") {
    return { kind: "not_found", responseHash: response.__responseHash || hashObject(response) };
  }
  const paid = Number(data.status) === 1 || String(data.trade_status || "") === "TRADE_SUCCESS";
  if (!paid) {
    return {
      kind: "pending",
      providerStatus: String(data.trade_status || data.status || ""),
      responseHash: response.__responseHash || hashObject(response)
    };
  }
  const mismatches = [];
  if (!data.out_trade_no || String(data.out_trade_no) !== String(order.outTradeNo)) {
    mismatches.push("outTradeNo");
  }
  if (moneyToFen(data.money) !== Number(order.amountFen)) mismatches.push("amountFen");
  if (!data.pid || String(data.pid) !== String(expectedPid) || String(order.pid) !== String(expectedPid)) {
    mismatches.push("pid");
  }
  if (!data.type || String(data.type) !== String(order.channel)) mismatches.push("channel");
  if (order.providerTradeNo && String(data.trade_no || "") !== String(order.providerTradeNo)) {
    mismatches.push("providerTradeNo");
  }
  if (mismatches.length) {
    return {
      kind: "mismatch",
      mismatchFields: mismatches,
      responseHash: response.__responseHash || hashObject(response)
    };
  }
  return {
    kind: "paid",
    providerTradeNo: String(data.trade_no || order.providerTradeNo || ""),
    providerStatus: String(data.trade_status || data.status),
    responseHash: response.__responseHash || hashObject(response)
  };
}

async function commitReconcileOutcome(options) {
  const db = options.db;
  const orderId = String(options.orderId || "");
  const fence = options.fence;
  const outcome = options.outcome || { kind: "error" };
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  return db.runTransaction(async (transaction) => {
    const ref = transaction.collection(PAYMENT_COLLECTIONS.orders).doc(orderId);
    const order = await readDocument(ref);
    if (!order || !fenceMatches(order, fence)) return { skipped: true, reason: "fence_lost" };
    const attemptCount = (Number(order.queryAttemptCount) || 0) + 1;
    let next = Object.assign({}, order, {
      queryAttemptCount: attemptCount,
      lastQueryAt: now,
      reconcileLeaseOwner: "",
      reconcileLeaseToken: "",
      reconcileLeaseUntil: null,
      updatedAt: now
    });
    let nextFence = null;

    if (outcome.kind === "paid") {
      next = transitionOrder(next, "paid", {
        providerTradeNo: outcome.providerTradeNo || order.providerTradeNo || "",
        providerStatus: outcome.providerStatus || "paid",
        providerQueryResponseHash: outcome.responseHash || "",
        paidAt: order.paidAt || now,
        verifiedPaidAt: now,
        reconcileRequired: true,
        nextReconcileAt: now,
        notFoundCount: 0,
        lastQueryErrorCode: "",
        updatedAt: now
      });
      // 查单回写已经通过旧 fence；状态版本加 1 后保留同一租约，
      // 履约事务必须再核对这个新 fence，过期 worker 不能入账。
      next.reconcileLeaseOwner = order.reconcileLeaseOwner;
      next.reconcileLeaseToken = order.reconcileLeaseToken;
      next.reconcileLeaseEpoch = order.reconcileLeaseEpoch;
      next.reconcileLeaseStatusVersion = next.statusVersion;
      next.reconcileLeaseUntil = order.reconcileLeaseUntil;
      nextFence = {
        owner: next.reconcileLeaseOwner,
        token: next.reconcileLeaseToken,
        epoch: next.reconcileLeaseEpoch,
        statusVersion: next.statusVersion
      };
    } else if (outcome.kind === "not_found") {
      const notFoundCount = (Number(order.notFoundCount) || 0) + 1;
      const canEscalate = ["created", "creation_unknown", "pending", "verifying"].includes(order.status);
      if (canEscalate && notFoundCount >= NOT_FOUND_REVIEW_THRESHOLD) {
        next = transitionOrder(next, "review", {
          notFoundCount,
          reconcileRequired: false,
          nextReconcileAt: null,
          updatedAt: now
        }, {
          reviewReason: order.callbackSuccessVerified
            ? "callback_paid_but_provider_not_found"
            : "provider_order_not_found",
          reviewEvidence: {
            notFoundCount,
            callbackSuccessVerified: Boolean(order.callbackSuccessVerified),
            responseHash: outcome.responseHash || ""
          },
          now
        });
      } else {
        next.notFoundCount = notFoundCount;
        next.reconcileRequired = true;
        next.nextReconcileAt = new Date(now.getTime() + reconcileDelayMs(order, now, attemptCount));
      }
    } else if (outcome.kind === "mismatch") {
      next = transitionOrder(next, "review", {
        reconcileRequired: false,
        nextReconcileAt: null,
        updatedAt: now
      }, {
        reviewReason: "provider_query_mismatch",
        reviewEvidence: {
          mismatchFields: outcome.mismatchFields || [],
          responseHash: outcome.responseHash || ""
        },
        now
      });
      const eventId = sha256(`payment-event:query-mismatch:${orderId}:${outcome.responseHash || "none"}`);
      const eventRef = transaction.collection(PAYMENT_COLLECTIONS.events).doc(eventId);
      if (!await readDocument(eventRef)) {
        await eventRef.set({
          data: {
            orderId,
            eventType: "provider_query_mismatch",
            outcome: "review",
            mismatchFields: outcome.mismatchFields || [],
            responseHash: outcome.responseHash || "",
            attentionRequired: true,
            createdAt: now
          }
        });
      }
    } else {
      const age = Math.max(0, now.getTime() - dateMillis(order.createdAt));
      const retryAt = new Date(now.getTime() + reconcileDelayMs(order, now, attemptCount));
      const noQueryReference = String(outcome.errorCode || "") === "PAYMENT_PROVIDER_QUERY_REFERENCE_MISSING"
        && !String(order.providerTradeNo || "").trim();
      if (noQueryReference && ["created", "creation_unknown", "pending", "verifying"].includes(order.status)) {
        next = transitionOrder(next, "review", {
          createClaimToken: "",
          reconcileRequired: false,
          nextReconcileAt: null,
          lastQueryErrorCode: String(outcome.errorCode || "").slice(0, 100),
          updatedAt: now
        }, {
          reviewReason: "provider_query_reference_missing",
          reviewEvidence: {
            providerTradeNo: "",
            queryAttemptCount: attemptCount,
            responseHash: outcome.responseHash || ""
          },
          now
        });
        const reviewEventId = sha256(`payment-event:review:${orderId}:${next.statusVersion}:provider_query_reference_missing`);
        const reviewEventRef = transaction.collection(PAYMENT_COLLECTIONS.events).doc(reviewEventId);
        if (!await readDocument(reviewEventRef)) {
          await reviewEventRef.set({ data: {
            orderId,
            eventType: "order_review_required",
            outcome: "review",
            reason: "provider_query_reference_missing",
            attentionRequired: true,
            createdAt: now
          } });
        }
      } else if (order.status === "created") {
        next = transitionOrder(next, "creation_unknown", {
          createClaimToken: "",
          creationErrorCode: "PAYMENT_CREATE_COMPLETION_UNKNOWN",
          reconcileRequired: true,
          nextReconcileAt: retryAt,
          lastQueryErrorCode: String(outcome.errorCode || "").slice(0, 100),
          providerStatus: outcome.providerStatus || order.providerStatus || "",
          updatedAt: now
        });
      } else {
        next.reconcileRequired = true;
        next.nextReconcileAt = retryAt;
        next.lastQueryErrorCode = String(outcome.errorCode || "").slice(0, 100);
        next.providerStatus = outcome.providerStatus || order.providerStatus || "";
      }
      if (age >= 7 * 24 * 60 * 60 * 1000) next.attentionRequired = true;
    }
    await ref.set({ data: stripDocumentId(next) });
    return { skipped: false, order: next, outcome: outcome.kind, fence: nextFence };
  }, 5);
}

async function reconcileOrder(options) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const claimed = await claimReconcileLease({
    db: options.db,
    orderId: options.orderId,
    owner: options.owner,
    token: options.token,
    now
  });
  if (!claimed) return { skipped: true, reason: "not_claimed" };
  if (claimed.order.status === "paid") {
    return fulfillPaidOrder({
      db: options.db,
      orderId: claimed.order._id,
      fence: claimed.fence,
      now
    });
  }
  let outcome;
  try {
    if (!options.provider) {
      outcome = { kind: "error", errorCode: "PAYMENT_NOT_CONFIGURED" };
    } else {
      const response = await options.provider.queryOrder(claimed.order);
      outcome = classifyProviderQuery(claimed.order, response, options.provider.config.pid);
    }
  } catch (error) {
    outcome = {
      kind: "error",
      errorCode: String(error && error.code || "PAYMENT_PROVIDER_QUERY_FAILED")
    };
  }
  const committed = await commitReconcileOutcome({
    db: options.db,
    orderId: claimed.order._id,
    fence: claimed.fence,
    outcome,
    now: new Date()
  });
  if (committed.order && committed.order.status === "paid") {
    const fulfilled = await fulfillPaidOrder({
      db: options.db,
      orderId: claimed.order._id,
      fence: committed.fence,
      now: new Date()
    });
    return Object.assign({}, committed, { fulfilled });
  }
  return committed;
}

module.exports = {
  findOrderByOutTradeNo,
  callbackEventMatches,
  callbackOrderMismatches,
  persistCallbackReceipt,
  ledgerMatchesOrder,
  fulfillPaidOrder,
  fenceMatches,
  reconcileDelayMs,
  claimReconcileLease,
  classifyProviderQuery,
  commitReconcileOutcome,
  reconcileOrder,
  orderView
};
