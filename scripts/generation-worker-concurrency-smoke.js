const assert = require("assert");
const {
  createGenerationExecutionKernel
} = require("../cloudfunctions/api/lib/generation-execution-kernel");

function createKernel(options = {}) {
  const claims = (options.claims || []).slice();
  const observed = [];
  const processed = [];
  const kernel = createGenerationExecutionKernel({
    access: {
      isAdmin: () => true,
      forbidden: () => ({ ok: false, errorCode: "ADMIN_FORBIDDEN" })
    },
    identity: {
      getOpenId: () => "worker-admin"
    },
    config: {
      resolve: async () => ({
        image: { apiKey: "test", model: "image", resolution: "1K" },
        costs: {}
      })
    },
    image: {
      hasEditAssets: () => false,
      resolveMode: () => "generations",
      hasFileID: () => true,
      resolveEditEndpoint: () => ({ url: "https://example.com" }),
      assertEditFlow: () => {},
      buildRequest: () => ({ size: "1024x1024" }),
      resolveOutputSize: () => "1024x1024",
      normalizeResolution: () => "1K"
    },
    records: {
      findGenerationRecord: async () => null
    },
    assets: {
      validate: async () => {}
    },
    billing: {
      reserve: async () => ({}),
      refund: async () => ({}),
      publicView: () => null
    },
    operations: {
      find: async () => null,
      enqueue: async () => ({}),
      fail: async () => ({}),
      claimNext: async () => claims.shift() || null,
      processQueued: async (operation) => {
        processed.push(operation.requestId);
        if (operation.fail) throw Object.assign(new Error("worker item failed"), {
          code: "worker-item-failed"
        });
        return { requestId: operation.requestId, status: "succeeded" };
      },
      loadReconcileCandidates: async () => [],
      reconcile: async () => ({}),
      update: async () => ({}),
      complete: async () => ({})
    },
    queue: {
      settings: async () => ({
        workerConcurrency: options.concurrency
      }),
      observe: async (details) => {
        observed.push(details.phase);
        return { unavailable: false };
      }
    },
    results: {
      persist: async () => ({})
    },
    files: {
      delete: async () => ({}),
      tempFileUrl: async () => ""
    },
    response: {
      ok: (data) => Object.assign({ ok: true }, data),
      fail: (message, errorCode) => ({ ok: false, message, errorCode }),
      buildStatus: (operation) => operation,
      statusMessage: () => "",
      normalizeStatus: (value) => value
    },
    serialization: {
      date: (value) => String(value || ""),
      sanitizeError: (value) => String(value || "").slice(0, 240)
    }
  });
  return { kernel, observed, processed };
}

async function main() {
  const concurrent = createKernel({
    concurrency: 3,
    claims: [
      { requestId: "job-1" },
      { requestId: "job-2", fail: true },
      { requestId: "job-3" },
      { requestId: "job-4" }
    ]
  });
  const result = await concurrent.kernel.processGenerationQueue(
    { action: "processGenerationQueue" },
    { OPENID: "admin" }
  );
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.claimed, 3);
  assert.strictEqual(result.processed, 3);
  assert.strictEqual(result.succeeded, 2);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.results.length, 3);
  assert.strictEqual(result.results[1].errorCode, "worker-item-failed");
  assert.deepStrictEqual(concurrent.processed.sort(), ["job-1", "job-2", "job-3"]);
  assert.deepStrictEqual(concurrent.observed, ["before", "after"]);

  const fallback = createKernel({
    concurrency: 99,
    claims: [
      { requestId: "only-1" },
      { requestId: "only-2" },
      { requestId: "only-3" },
      { requestId: "only-4" },
      { requestId: "not-claimed" }
    ]
  });
  const fallbackResult = await fallback.kernel.processGenerationQueue(
    { action: "processGenerationQueue" },
    { OPENID: "admin" }
  );
  assert.strictEqual(fallbackResult.claimed, 4);
  assert.deepStrictEqual(
    fallback.processed.sort(),
    ["only-1", "only-2", "only-3", "only-4"]
  );

  const empty = createKernel({ concurrency: 2, claims: [] });
  const emptyResult = await empty.kernel.processGenerationQueue(
    { action: "processGenerationQueue" },
    { OPENID: "admin" }
  );
  assert.strictEqual(emptyResult.processed, 0);
  assert.strictEqual(emptyResult.claimed, 0);
  assert.deepStrictEqual(empty.observed, ["before", "after"]);

  console.log("generation worker concurrency smoke: OK");
}

main().catch((error) => {
  console.error(`generation worker concurrency smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
