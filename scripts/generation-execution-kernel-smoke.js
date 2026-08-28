/* eslint-disable no-console */

const assert = require("assert");
const {
  createGenerationExecutionKernel
} = require("../cloudfunctions/api/lib/generation-execution-kernel");

function createHarness() {
  const calls = {
    log: [],
    validate: [],
    reserve: [],
    refund: [],
    enqueue: [],
    fail: [],
    claimNext: 0,
    processQueued: [],
    reconcile: []
  };
  const state = {
    existingRecord: null,
    existingOperation: null,
    queuedOperation: null,
    reconcileCandidates: [],
    configs: {
      image: {
        apiKey: "test-key",
        provider: "primary-test",
        model: "test-image-model",
        resolution: "1K",
        compatibilityMode: false
      },
      imageBackup: {
        enabled: true,
        apiKey: "",
        provider: "backup-test",
        baseUrl: "https://backup.example/v1",
        model: "backup-image-model",
        resolution: "1K",
        compatibilityMode: false
      },
      costs: {}
    },
    reserve: async (openid, requestId, kind) => ({
      requestId,
      kind,
      source: "daily-free",
      pointsCharged: 0,
      alreadyReserved: false
    }),
    enqueue: async (openid, requestId, payload, billing, metadata) => ({
      openid,
      requestId,
      kind: "image",
      status: "queued",
      pipelineStage: "queued",
      progress: 0,
      payload,
      billing,
      metadata
    }),
    reconcile: async (operation) => ({
      action: operation.action || "skip-fresh",
      requestId: operation.requestId
    })
  };
  const services = {
    access: {
      isAdmin: (context) => Boolean(context && context.admin),
      forbidden: () => ({ ok: false, errorCode: "ADMIN_FORBIDDEN" })
    },
    identity: {
      getOpenId: (context) => String(context && context.OPENID || "anonymous")
    },
    config: {
      resolve: async () => state.configs
    },
    image: {
      hasEditAssets: () => false,
      resolveMode: () => "generations",
      hasFileID: (value) => Boolean(value),
      resolveEditEndpoint: () => ({ url: "https://example.test/images/edits" }),
      assertEditFlow: () => {},
      buildRequest: (payload) => ({
        model: "test-image-model",
        prompt: payload.prompt,
        size: "1024x1024",
        quality: "auto",
        n: 1
      }),
      resolveOutputSize: () => "1024x1024",
      normalizeResolution: () => "1K"
    },
    records: {
      findGenerationRecord: async () => state.existingRecord
    },
    assets: {
      validate: async (openid, payload) => {
        calls.validate.push({ openid, payload });
      }
    },
    billing: {
      reserve: async (...args) => {
        calls.reserve.push(args);
        return state.reserve(...args);
      },
      refund: async (...args) => {
        calls.refund.push(args);
        return { duplicate: false };
      },
      publicView: (billing) => billing || null
    },
    operations: {
      find: async () => state.existingOperation,
      enqueue: async (...args) => {
        calls.enqueue.push(args);
        return state.enqueue(...args);
      },
      fail: async (...args) => {
        calls.fail.push(args);
        return { status: "failed" };
      },
      claimNext: async () => {
        calls.claimNext += 1;
        return state.queuedOperation;
      },
      processQueued: async (operation) => {
        calls.processQueued.push(operation);
        return { ok: true, requestId: operation.requestId };
      },
      loadReconcileCandidates: async () => state.reconcileCandidates,
      reconcile: async (operation, options) => {
        calls.reconcile.push({ operation, options });
        return state.reconcile(operation, options);
      },
      update: async () => ({ status: "processing" }),
      complete: async () => ({ status: "succeeded" })
    },
    results: {
      persist: async () => ({ recordId: "record-id" })
    },
    files: {
      delete: async (fileID) => ({ fileList: [{ fileID, status: 0 }] }),
      tempFileUrl: async (fileID) => `https://temporary.test/${fileID}`
    },
    response: {
      ok: (data) => Object.assign({ ok: true }, data),
      fail: (message, errorCode) => ({ ok: false, message, errorCode }),
      buildStatus: (operation) => ({
        taskId: operation.requestId,
        requestId: operation.requestId,
        status: operation.status,
        stage: operation.pipelineStage,
        progress: operation.progress,
        result: operation.status === "succeeded" ? operation.result || null : null
      }),
      statusMessage: (status) => `status:${status}`,
      normalizeStatus: (status) => status
    },
    serialization: {
      date: (value) => value instanceof Date ? value.toISOString() : String(value || ""),
      sanitizeError: (value) => String(value || "").slice(0, 240)
    },
    log: (level, event, fields) => calls.log.push({ level, event, fields }),
    now: () => new Date("2026-08-26T12:00:00.000Z")
  };
  return {
    calls,
    state,
    services,
    kernel: createGenerationExecutionKernel(services)
  };
}

async function main() {
  assert.throws(
    () => createGenerationExecutionKernel({}),
    (error) => (
      error
      && error.code === "generation-kernel-dependency-missing"
      && error.dependency === "isAdmin"
    )
  );

  {
    const harness = createHarness();
    const result = await harness.kernel.generate(
      {
        requestId: "submit-request",
        payload: { prompt: "画一只海鸥" }
      },
      { OPENID: "submit-user" }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.taskId, "submit-request");
    assert.strictEqual(result.status, "queued");
    assert.strictEqual(result.message, "生图任务已提交");
    assert.strictEqual(harness.calls.validate.length, 1);
    assert.strictEqual(harness.calls.reserve.length, 1);
    assert.strictEqual(harness.calls.enqueue.length, 1);
  }

  {
    const harness = createHarness();
    harness.state.configs.image.apiKey = "";
    harness.state.configs.imageBackup.enabled = true;
    harness.state.configs.imageBackup.apiKey = "backup-test-key";
    harness.services.image.resolveMode = () => "edits";
    harness.services.image.hasEditAssets = () => true;
    harness.kernel = createGenerationExecutionKernel(harness.services);
    const result = await harness.kernel.generate(
      {
        requestId: "submit-backup-only-request",
        payload: {
          prompt: "只用备用模型提交图片编辑",
          mainFileID: "cloud://main.png",
          maskFileID: "cloud://mask.png"
        }
      },
      { OPENID: "backup-only-user" }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "queued");
    assert.strictEqual(harness.calls.reserve.length, 1);
    assert.strictEqual(harness.calls.enqueue.length, 1);
  }

  {
    const harness = createHarness();
    harness.state.existingRecord = {
      _id: "existing-record",
      fileID: "cloud://existing.png",
      tempFileURL: "https://temporary.test/existing.png",
      createdAt: new Date("2026-08-26T10:00:00.000Z")
    };
    harness.state.existingOperation = {
      requestId: "existing-request",
      status: "succeeded",
      billing: { source: "points", pointsCharged: 3 }
    };
    const result = await harness.kernel.generate(
      {
        requestId: "existing-request",
        payload: { prompt: "不会再次扣费" }
      },
      { OPENID: "existing-user" }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deduplicated, true);
    assert.strictEqual(result.result.recordId, "existing-record");
    assert.strictEqual(harness.calls.reserve.length, 0);
    assert.strictEqual(harness.calls.enqueue.length, 0);
  }

  {
    const harness = createHarness();
    let reserveAttempt = 0;
    harness.state.reserve = async (openid, requestId, kind) => {
      reserveAttempt += 1;
      return {
        requestId,
        kind,
        source: "points",
        pointsCharged: 3,
        alreadyReserved: reserveAttempt > 1
      };
    };
    harness.state.enqueue = async () => {
      const error = new Error("queue unavailable");
      error.code = "queue-unavailable";
      throw error;
    };
    await assert.rejects(
      () => harness.kernel.generate(
        {
          requestId: "refund-once-request",
          payload: { prompt: "第一次提交" }
        },
        { OPENID: "refund-user" }
      ),
      (error) => error && error.code === "queue-unavailable"
    );
    await assert.rejects(
      () => harness.kernel.generate(
        {
          requestId: "refund-once-request",
          payload: { prompt: "重复提交" }
        },
        { OPENID: "refund-user" }
      ),
      (error) => error && error.code === "queue-unavailable"
    );
    assert.strictEqual(harness.calls.fail.length, 1);
    assert.strictEqual(harness.calls.refund.length, 1);
  }

  {
    const harness = createHarness();
    const denied = await harness.kernel.processGenerationQueue(
      { action: "processGenerationQueue" },
      { admin: false }
    );
    assert.strictEqual(denied.errorCode, "ADMIN_FORBIDDEN");
    assert.strictEqual(harness.calls.claimNext, 0);

    harness.state.queuedOperation = {
      requestId: "queued-worker-request",
      status: "processing"
    };
    const timer = await harness.kernel.processGenerationQueue(
      { triggerName: "generation-queue-worker" },
      { admin: false }
    );
    assert.strictEqual(timer.ok, true);
    assert.strictEqual(timer.processed, 1);
    assert.strictEqual(harness.calls.claimNext, 1);
    assert.strictEqual(harness.calls.processQueued.length, 1);
  }

  {
    const harness = createHarness();
    harness.state.existingOperation = {
      requestId: "status-request",
      status: "processing",
      pipelineStage: "upload",
      progress: 90,
      stageHistory: [{ stage: "secret" }],
      payload: { prompt: "secret prompt" },
      billing: { source: "daily-free" }
    };
    const result = await harness.kernel.getGenerationStatus(
      { requestId: "status-request" },
      { OPENID: "status-user" }
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stage, "upload");
    assert.ok(!JSON.stringify(result).includes("secret prompt"));
    assert.ok(!JSON.stringify(result).includes("stageHistory"));
  }

  {
    const harness = createHarness();
    harness.state.reconcileCandidates = [
      { requestId: "reconcile-ok", action: "processing-requeued" },
      { requestId: "reconcile-error", action: "error" }
    ];
    harness.state.reconcile = async (operation, options) => {
      assert.strictEqual(typeof options.updateOperation, "function");
      assert.strictEqual(typeof options.failOperation, "function");
      assert.strictEqual(typeof options.completeOperation, "function");
      assert.strictEqual(typeof options.persistResult, "function");
      assert.strictEqual(typeof options.refund, "function");
      assert.strictEqual(typeof options.deleteFile, "function");
      assert.strictEqual(typeof options.tempFileUrl, "function");
      if (operation.action === "error") {
        const error = new Error("reconcile exploded");
        error.code = "reconcile-exploded";
        throw error;
      }
      return {
        action: operation.action,
        requestId: operation.requestId
      };
    };
    const result = await harness.kernel.reconcileGenerationOperations(
      { triggerName: "generation-operation-reconcile" },
      {}
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scanned, 2);
    assert.strictEqual(result.processed, 2);
    assert.strictEqual(result.summary["processing-requeued"], 1);
    assert.strictEqual(result.summary["reconcile-error"], 1);
    assert.strictEqual(harness.calls.reconcile.length, 2);
  }

  console.log(
    "generation execution kernel smoke: OK "
    + "(DI/submit/idempotency/refund-once/worker/status/reconcile)"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
