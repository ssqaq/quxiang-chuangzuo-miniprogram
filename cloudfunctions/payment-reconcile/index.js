"use strict";

const cloud = require("wx-server-sdk");
const payment = require("aips-payment-core");
const monitor = require("./monitor");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const TRIGGER_NAME = "payment-reconcile";
const MAX_BATCH_SIZE = 20;

function triggerName(event = {}) {
  return String(event.triggerName || event.TriggerName || event.name || "").trim();
}

function callerOpenid(context = {}) {
  const direct = context && (context.OPENID || context.openid);
  if (direct) return String(direct).trim();
  try {
    const wxContext = cloud.getWXContext() || {};
    return String(wxContext.OPENID || wxContext.openid || "").trim();
  } catch (_error) {
    return "";
  }
}

function createProviderIfConfigured() {
  const evaluated = payment.evaluateProviderConfig(process.env);
  return evaluated.configured
    ? new payment.XingjuProvider(evaluated.value, { timeoutMs: payment.PROVIDER_TIMEOUT_MS })
    : null;
}

async function loadCandidates(now, limit = MAX_BATCH_SIZE) {
  const result = await db
    .collection(payment.PAYMENT_COLLECTIONS.orders)
    .where({
      reconcileRequired: true,
      nextReconcileAt: db.command.lte(now)
    })
    .orderBy("nextReconcileAt", "asc")
    .limit(Math.max(1, Math.min(MAX_BATCH_SIZE, Number(limit) || MAX_BATCH_SIZE)))
    .get();
  return result && Array.isArray(result.data) ? result.data : [];
}

async function runReconcile(event = {}) {
  const startedAt = Date.now();
  const provider = createProviderIfConfigured();
  const owner = `timer-${startedAt.toString(36)}-${payment.randomToken(8)}`;
  const candidates = await loadCandidates(new Date(), event.limit);
  const summary = {
    scanned: candidates.length,
    claimed: 0,
    processed: 0,
    fulfilled: 0,
    skipped: 0,
    failed: 0,
    stoppedEarly: false
  };
  for (const order of candidates) {
    if (Date.now() - startedAt >= payment.RECONCILE_STOP_CLAIMING_MS) {
      summary.stoppedEarly = true;
      break;
    }
    try {
      const result = await payment.reconcileOrder({
        db,
        provider,
        orderId: order._id,
        owner,
        now: new Date()
      });
      if (result && result.skipped) summary.skipped += 1;
      else {
        summary.claimed += 1;
        summary.processed += 1;
        const fulfilled = result && (
          result.order && result.order.status === "fulfilled"
          || result.fulfilled && result.fulfilled.order
            && result.fulfilled.order.status === "fulfilled"
        );
        if (fulfilled) summary.fulfilled += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error("payment-reconcile.order-failed", {
        orderId: order._id,
        code: String(error && error.code || "PAYMENT_RECONCILE_FAILED")
      });
    }
  }
  return Object.assign({ ok: true, durationMs: Date.now() - startedAt }, summary);
}

exports.main = async (event = {}, context = {}) => {
  // config.json 首版不开 Timer。未来显式开启后，也必须同时满足：
  // 1) 云端调用上下文没有 OPENID；2) 触发器名严格等于固定值。
  // 普通客户端即使伪造 TriggerName，仍会因 OPENID 存在而失败关闭。
  if (callerOpenid(context) || triggerName(event) !== TRIGGER_NAME) {
    return {
      ok: false,
      errorCode: "PAYMENT_RECONCILE_FORBIDDEN",
      message: "只允许支付对账定时任务调用。"
    };
  }
  if (!payment.paymentRuntimeSwitches(process.env).reconciliationEnabled) {
    return {
      ok: false,
      errorCode: "PAYMENT_RECONCILIATION_DISABLED",
      message: "支付对账任务未开启。"
    };
  }
  const runStartedAt = new Date();
  const previous = await monitor.readSnapshot(db);
  let summary = null;
  let runError = null;
  try {
    summary = await runReconcile(event);
  } catch (error) {
    runError = error;
    console.error("payment-reconcile.failed", {
      code: String(error && error.code || "PAYMENT_RECONCILE_FAILED")
    });
  }
  let metrics = {};
  let metricsAvailable = true;
  try {
    metrics = await monitor.loadPaymentHealthMetrics(db, new Date());
  } catch (error) {
    metricsAvailable = false;
    console.error("payment-reconcile.metrics-failed", {
      code: String(error && error.code || "PAYMENT_MONITOR_METRICS_FAILED")
    });
  }
  const completedAt = new Date();
  const safeSummary = summary || {
    scanned: 0,
    claimed: 0,
    processed: 0,
    fulfilled: 0,
    failed: 1,
    skipped: 0,
    stoppedEarly: false
  };
  const snapshot = monitor.buildSnapshot({
    previous,
    summary: safeSummary,
    metrics,
    metricsAvailable,
    mode: "enabled",
    startedAt: runStartedAt,
    completedAt,
    runError: Boolean(runError)
  });
  try {
    await monitor.writeSnapshot(db, snapshot);
  } catch (error) {
    console.error("payment-reconcile.monitor-write-failed", {
      code: String(error && error.code || "PAYMENT_MONITOR_WRITE_FAILED")
    });
    if (!runError) runError = payment.paymentError(
      "PAYMENT_MONITOR_WRITE_FAILED",
      "支付监控状态写入失败。",
      { cause: error, retryable: true }
    );
  }
  if (runError) return payment.toPublicFailure(runError, "支付对账任务执行失败。");
  return Object.assign({}, summary, {
    ok: true,
    monitor: monitor.publicSnapshot(snapshot, completedAt)
  });
};

exports.__test__ = {
  triggerName,
  callerOpenid,
  loadCandidates,
  runReconcile,
  monitor
};
