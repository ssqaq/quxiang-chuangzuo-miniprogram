/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const monitor = require(path.join(root, "cloudfunctions", "payment-reconcile", "monitor.js"));

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function createFakeDb(options = {}) {
  const now = options.now || new Date("2026-08-30T12:00:00.000Z");
  const snapshot = options.snapshot || null;
  const records = Array.isArray(options.records) ? options.records.slice() : [];
  const writes = [];
  const queries = [];

  function buildQuery(filters = []) {
    return {
      _filters: filters,
      where(condition) {
        return buildQuery(filters.concat([{ type: "where", condition }]));
      },
      orderBy(field, direction) {
        return buildQuery(filters.concat([{ type: "orderBy", field, direction }]));
      },
      limit(size) {
        return buildQuery(filters.concat([{ type: "limit", size }]));
      },
      async count() {
        queries.push({ kind: "count", filters: filters.slice() });
        const matched = filterRecords(records, filters, now);
        return { total: matched.length };
      },
      async get() {
        queries.push({ kind: "get", filters: filters.slice() });
        const matched = filterRecords(records, filters, now);
        return { data: matched };
      }
    };
  }

  function collection(name) {
    if (name === monitor.MONITOR_COLLECTION) {
      return {
        doc(docId) {
          assert.strictEqual(docId, monitor.MONITOR_DOCUMENT_ID);
          return {
            async get() {
              if (!snapshot) throw new Error("not found");
              return { data: snapshot };
            },
            async set(payload) {
              writes.push({ collection: name, docId, payload });
              return { errMsg: "ok" };
            }
          };
        }
      };
    }
    assert.strictEqual(name, "payment_orders", "只允许访问 payment_orders 和监控集合");
    return buildQuery([]);
  }

  return {
    command: {
      lte(value) {
        return { op: "lte", value: new Date(value).getTime() };
      }
    },
    collection,
    _writes: writes,
    _queries: queries,
    _now: now
  };
}

function getField(record, key) {
  return record ? record[key] : undefined;
}

function matchCondition(record, condition, now) {
  return Object.keys(condition || {}).every((key) => {
    const expected = condition[key];
    const actual = getField(record, key);
    if (expected && expected.op === "lte") {
      const actualMs = new Date(actual).getTime();
      return Number.isFinite(actualMs) && actualMs <= expected.value;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      return matchCondition(actual || {}, expected, now);
    }
    if (expected === now) return actual === expected;
    return actual === expected;
  });
}

function filterRecords(records, filters, now) {
  let output = records.slice();
  for (const filter of filters) {
    if (filter.type === "where") {
      output = output.filter((record) => matchCondition(record, filter.condition, now));
    } else if (filter.type === "orderBy") {
      const { field, direction } = filter;
      const dir = direction === "desc" || direction === -1 ? -1 : 1;
      output = output.slice().sort((left, right) => {
        const a = new Date(getField(left, field)).getTime();
        const b = new Date(getField(right, field)).getTime();
        return (a - b) * dir;
      });
    } else if (filter.type === "limit") {
      output = output.slice(0, filter.size);
    }
  }
  return output;
}

async function main() {
  assert.strictEqual(monitor.MONITOR_COLLECTION, "payment_monitor_status");
  assert.strictEqual(monitor.MONITOR_DOCUMENT_ID, "global");
  assert.strictEqual(monitor.MONITOR_SCHEMA_VERSION, 1);

  const healthy = monitor.evaluateHealth(
    { dueBacklogCount: 2, reviewCount: 0, refundReviewCount: 0, paidUnfulfilledCount: 0 },
    { failed: 0 },
    { mode: "enabled", consecutiveFailureCount: 0, now: new Date("2026-08-30T12:00:00.000Z") }
  );
  assert.deepStrictEqual(healthy, { severity: "healthy", reasonCodes: [] });

  const warning = monitor.evaluateHealth(
    { dueBacklogCount: 21, reviewCount: 1, refundReviewCount: 0, paidUnfulfilledCount: 0 },
    { failed: 1 },
    { mode: "enabled", consecutiveFailureCount: 1, now: new Date("2026-08-30T12:00:00.000Z") }
  );
  assert.strictEqual(warning.severity, "warning");
  assert.ok(warning.reasonCodes.includes("RECONCILE_RUN_FAILED"));
  assert.ok(warning.reasonCodes.includes("REVIEW_REQUIRED"));
  assert.ok(warning.reasonCodes.includes("DUE_BACKLOG_COUNT"));

  const critical = monitor.evaluateHealth(
    { paidUnfulfilledCount: 1 },
    { failed: 2 },
    { mode: "enabled", consecutiveFailureCount: 2, now: new Date("2026-08-30T12:00:00.000Z") }
  );
  assert.strictEqual(critical.severity, "critical");
  assert.ok(critical.reasonCodes.includes("RECONCILE_CONSECUTIVE_FAILURES"));
  assert.ok(critical.reasonCodes.includes("PAID_UNFULFILLED"));

  const successfulSnapshot = monitor.buildSnapshot({
    previous: {
      consecutiveFailureCount: 4,
      lastSuccessAt: "2026-08-30T10:00:00.000Z"
    },
    summary: { scanned: 5, claimed: 2, fulfilled: 2, failed: 0, skipped: 3 },
    metrics: {},
    mode: "enabled",
    startedAt: "2026-08-30T11:59:30.000Z",
    completedAt: "2026-08-30T12:00:00.000Z"
  });
  assert.strictEqual(successfulSnapshot.severity, "healthy");
  assert.strictEqual(successfulSnapshot.consecutiveFailureCount, 0);
  assert.strictEqual(successfulSnapshot.lastSuccessAt.toISOString(), "2026-08-30T12:00:00.000Z");

  const failedSnapshot = monitor.buildSnapshot({
    previous: {
      consecutiveFailureCount: 1,
      lastSuccessAt: "2026-08-30T10:00:00.000Z"
    },
    summary: { scanned: 1, failed: 1 },
    metrics: {},
    mode: "enabled",
    startedAt: "2026-08-30T11:59:50.000Z",
    completedAt: "2026-08-30T12:00:00.000Z",
    runError: true
  });
  assert.strictEqual(failedSnapshot.severity, "critical");
  assert.strictEqual(failedSnapshot.consecutiveFailureCount, 2);
  assert.strictEqual(failedSnapshot.lastSuccessAt, "2026-08-30T10:00:00.000Z");
  assert.ok(failedSnapshot.reasonCodes.includes("RECONCILE_CONSECUTIVE_FAILURES"));

  const disabled = monitor.evaluateHealth({}, { failed: 0 }, { mode: "disabled" });
  assert.deepStrictEqual(disabled, {
    severity: "disabled",
    reasonCodes: ["RECONCILIATION_DISABLED"]
  });

  const previous = {
    consecutiveFailureCount: 2,
    lastSuccessAt: "2026-08-30T10:00:00.000Z",
    openid: "raw-openid",
    secret: "should-not-leak"
  };
  const snapshot = monitor.buildSnapshot({
    previous,
    summary: {
      scanned: 8,
      claimed: 3,
      fulfilled: 2,
      failed: 1,
      skipped: 2,
      stoppedEarly: false
    },
    metrics: {
      dueBacklogCount: 7,
      oldestDueAt: "2026-08-30T11:30:00.000Z",
      reviewCount: 1,
      refundReviewCount: 0,
      paidUnfulfilledCount: 0
    },
    mode: "enabled",
    startedAt: new Date("2026-08-30T11:55:00.000Z"),
    completedAt: new Date("2026-08-30T12:00:00.000Z")
  });
  assert.strictEqual(snapshot.schemaVersion, 1);
  assert.strictEqual(snapshot.mode, "enabled");
  assert.strictEqual(snapshot.consecutiveFailureCount, 3);
  assert.strictEqual(snapshot.severity, "critical");
  assert.ok(snapshot.reasonCodes.includes("RECONCILE_CONSECUTIVE_FAILURES"));
  assert.ok(snapshot.reasonCodes.includes("REVIEW_REQUIRED"));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, "openid"));
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, "secret"));
  assert.ok(!JSON.stringify(snapshot).includes("raw-openid"));
  assert.ok(!JSON.stringify(snapshot).includes("should-not-leak"));

  const disabledSnapshot = monitor.buildSnapshot({
    previous: { consecutiveFailureCount: 4 },
    summary: { scanned: 1, failed: 0 },
    metrics: {},
    mode: "disabled",
    startedAt: "2026-08-30T11:59:00.000Z",
    completedAt: "2026-08-30T12:00:00.000Z",
    metricsAvailable: false
  });
  assert.strictEqual(disabledSnapshot.mode, "disabled");
  assert.strictEqual(disabledSnapshot.severity, "warning");
  assert.ok(disabledSnapshot.reasonCodes.includes("RECONCILIATION_DISABLED"));
  assert.ok(disabledSnapshot.reasonCodes.includes("METRICS_UNAVAILABLE"));
  assert.strictEqual(disabledSnapshot.metricsAvailable, false);
  assert.strictEqual(disabledSnapshot.consecutiveFailureCount, 0);

  const healthyPublic = monitor.publicSnapshot(successfulSnapshot, new Date("2026-08-30T12:02:00.000Z"));
  assert.strictEqual(healthyPublic.available, true);
  assert.strictEqual(healthyPublic.stale, false);
  assert.strictEqual(healthyPublic.severity, "healthy");

  const stalePublic = monitor.publicSnapshot(Object.assign({}, successfulSnapshot, {
    lastRunCompletedAt: "2026-08-30T11:50:00.000Z",
    openid: "must-not-leak",
    secret: "must-not-leak",
    reasonCodes: ["REVIEW_REQUIRED", "REVIEW_REQUIRED", "bad-reason", "SECRET=oops"]
  }), new Date("2026-08-30T12:00:00.000Z"));
  assert.strictEqual(stalePublic.stale, true);
  assert.strictEqual(stalePublic.severity, "critical");
  assert.deepStrictEqual(stalePublic.reasonCodes, ["REVIEW_REQUIRED", "TIMER_STALE"]);
  assert.ok(!JSON.stringify(stalePublic).includes("must-not-leak"));
  assert.ok(!Object.prototype.hasOwnProperty.call(stalePublic, "openid"));
  assert.ok(!Object.prototype.hasOwnProperty.call(stalePublic, "secret"));

  const disabledPublic = monitor.publicSnapshot({
    mode: "disabled",
    severity: "disabled",
    lastRunCompletedAt: "2026-08-30T10:00:00.000Z",
    reasonCodes: ["RECONCILIATION_DISABLED"]
  }, new Date("2026-08-30T12:00:00.000Z"));
  assert.strictEqual(disabledPublic.stale, false);
  assert.strictEqual(disabledPublic.severity, "disabled");
  assert.deepStrictEqual(disabledPublic.reasonCodes, ["RECONCILIATION_DISABLED"]);

  const fakeDb = createFakeDb({
    records: [
      {
        status: "paid",
        paidAt: "2026-08-30T11:56:00.000Z",
        reconcileRequired: true,
        nextReconcileAt: "2026-08-30T11:50:00.000Z"
      },
      {
        status: "review",
        reconcileRequired: true,
        nextReconcileAt: "2026-08-30T11:40:00.000Z"
      },
      {
        status: "refund_review",
        reconcileRequired: false,
        nextReconcileAt: "2026-08-30T11:30:00.000Z"
      },
      {
        status: "paid",
        paidAt: "2026-08-30T11:59:30.000Z",
        reconcileRequired: true,
        nextReconcileAt: "2026-08-30T11:58:00.000Z"
      },
      {
        status: "paid",
        paidAt: "2026-08-30T11:20:00.000Z",
        reconcileRequired: false,
        nextReconcileAt: "2026-08-30T11:00:00.000Z"
      }
    ]
  });

  const metrics = await monitor.loadPaymentHealthMetrics(fakeDb, new Date("2026-08-30T12:00:00.000Z"));
  assert.deepStrictEqual(metrics, {
    dueBacklogCount: 3,
    oldestDueAt: "2026-08-30T11:40:00.000Z",
    reviewCount: 1,
    refundReviewCount: 1,
    paidUnfulfilledCount: 1
  });
  assert.strictEqual(fakeDb._queries.filter((item) => item.kind === "count").length, 4);
  assert.strictEqual(fakeDb._queries.filter((item) => item.kind === "get").length, 1);

  const snapshotDb = createFakeDb({
    snapshot: {
      schemaVersion: 1,
      mode: "enabled",
      severity: "healthy"
    }
  });
  const read = await monitor.readSnapshot(snapshotDb);
  assert.strictEqual(read.schemaVersion, 1);
  assert.strictEqual(read.mode, "enabled");
  assert.strictEqual(read.severity, "healthy");

  const writeInput = { schemaVersion: 1, mode: "enabled", severity: "warning" };
  const writeResult = await monitor.writeSnapshot(snapshotDb, writeInput);
  assert.deepStrictEqual(writeResult, writeInput);
  assert.strictEqual(snapshotDb._writes.length, 1);
  assert.deepStrictEqual(snapshotDb._writes[0].payload.data, writeInput);
  assert.strictEqual(snapshotDb._writes[0].collection, "payment_monitor_status");
  assert.strictEqual(snapshotDb._writes[0].docId, "global");

  const apiSource = readText("cloudfunctions/api/index.js");
  const serviceSource = readText("services/cloud.js");
  const adminSource = readText("pages/admin/admin.js");
  const adminWxml = readText("pages/admin/admin.wxml");
  [
    'const PAYMENT_MONITOR_COLLECTION = "payment_monitor_status"',
    'const PAYMENT_MONITOR_DOCUMENT_ID = "global"',
    "async function getAdminPaymentMonitor(context)",
    "if (!isAdminContext(context)) return adminForbidden()",
    'else if (action === "getAdminPaymentMonitor")',
    "paymentMonitorView(snapshot, new Date())",
    'errorCode: "PAYMENT_MONITOR_NOT_DEPLOYED"'
  ].forEach((marker) => {
    assert.ok(apiSource.includes(marker), `管理员支付监控 API 接线缺失：${marker}`);
  });
  assert.ok(
    /getAdminPaymentMonitor\(\)\s*\{[\s\S]*?action:\s*"getAdminPaymentMonitor"[\s\S]*?retryLimit:\s*0[\s\S]*?silent:\s*true/.test(serviceSource),
    "客户端云服务没有以只读、静默方式接入支付监控"
  );
  [
    '"paymentMonitor"',
    "function formatPaymentMonitor(result)",
    "paymentMonitorLoading: false",
    "paymentMonitor: emptyPaymentMonitor()",
    "cloud.getAdminPaymentMonitor()",
    "async refreshPaymentMonitor("
  ].forEach((marker) => {
    assert.ok(adminSource.includes(marker), `管理员页支付监控逻辑接线缺失：${marker}`);
  });
  [
    'id="monitor-section-paymentMonitor"',
    "支付与补单",
    'catchtap="refreshPaymentMonitor"',
    'data-section="paymentMonitor"',
    "paymentMonitor.dueBacklogCount",
    "paymentMonitor.paidUnfulfilledCount",
    "paymentMonitor.reasonTexts"
  ].forEach((marker) => {
    assert.ok(adminWxml.includes(marker), `管理员页支付监控视图接线缺失：${marker}`);
  });
  const overviewIndex = adminWxml.indexOf('class="monitor-overview-card"');
  const paymentIndex = adminWxml.indexOf('id="monitor-section-paymentMonitor"');
  const queueIndex = adminWxml.indexOf('id="monitor-section-generationQueue"');
  assert.ok(
    overviewIndex >= 0 && overviewIndex < paymentIndex && paymentIndex < queueIndex,
    "支付监控卡片必须位于运行概览之后、任务队列之前"
  );
  assert.ok(!apiSource.slice(apiSource.indexOf("function paymentMonitorView"), apiSource.indexOf("async function getAdminPaymentMonitor")).includes("openid"), "支付监控公开视图不得返回 OpenID");
  assert.ok(!apiSource.slice(apiSource.indexOf("function paymentMonitorView"), apiSource.indexOf("async function getAdminPaymentMonitor")).includes("secret"), "支付监控公开视图不得返回密钥字段");

  console.log("payment monitor smoke: OK");
}

main().catch((error) => {
  console.error(`payment monitor smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
