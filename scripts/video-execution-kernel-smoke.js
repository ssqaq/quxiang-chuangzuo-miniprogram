/* eslint-disable no-console */

const assert = require("assert");
const {
  createVideoExecutionKernel
} = require("../cloudfunctions/api/lib/video-execution-kernel");

function createHarness() {
  const calls = {
    reserve: 0,
    refund: 0,
    claim: 0,
    update: [],
    complete: 0,
    fail: 0,
    prepare: 0,
    create: 0,
    createProviders: [],
    query: 0,
    queryProviders: [],
    materialize: 0,
    delete: [],
    log: []
  };
  const state = {
    operation: null,
    createResult: {
      taskId: "provider-task-001",
      status: "processing",
      providerStatus: "queued"
    },
    queryResult: {
      status: "processing",
      providerStatus: "running",
      videoURL: "",
      error: ""
    },
    configs: {
      video: {
        configured: true,
        provider: "lingyun",
        apiKey: "primary-video-secret",
        model: "video-model",
        resolution: "720p"
      },
      videoBackup: { configured: false },
      costs: {}
    },
    createHandler: null,
    queryHandler: null,
    reserveErrorWhenRefunded: true,
    now: new Date("2026-08-26T12:00:00.000Z")
  };

  function mergeOperation(openid, requestId, patch = {}) {
    state.operation = Object.assign({
      openid,
      requestId,
      kind: "video",
      status: "reserved",
      createdAt: state.now,
      updatedAt: state.now,
      billing: {
        source: "points",
        kind: "video",
        pointsCharged: 8,
        cost: 8
      }
    }, state.operation || {}, patch, {
      openid,
      requestId,
      kind: "video",
      updatedAt: state.now
    });
    return state.operation;
  }

  const services = {
    identity: {
      getOpenId: (context) => String(context && context.OPENID || "anonymous")
    },
    config: {
      resolve: async () => state.configs
    },
    billing: {
      reserve: async (openid, requestId, kind) => {
        calls.reserve += 1;
        if (
          state.reserveErrorWhenRefunded
          && state.operation
          && state.operation.status === "refunded"
        ) {
          const error = new Error("本次请求已退款");
          error.code = "request-refunded";
          throw error;
        }
        const existing = state.operation;
        const billing = Object.assign({
          source: "points",
          kind,
          pointsCharged: 8,
          cost: 8,
          alreadyReserved: Boolean(existing),
          untracked: false
        }, existing && existing.billing || {});
        if (!existing) {
          mergeOperation(openid, requestId, {
            status: "reserved",
            billing
          });
        }
        return billing;
      },
      refund: async (openid, requestId) => {
        calls.refund += 1;
        if (state.operation && state.operation.status === "refunded") {
          return { duplicate: true, operation: state.operation };
        }
        mergeOperation(openid, requestId, {
          status: "refunded",
          refundPending: false
        });
        return { duplicate: false, operation: state.operation };
      },
      publicView: (billing) => billing || null
    },
    operations: {
      find: async () => state.operation,
      claim: async (openid, requestId) => {
        calls.claim += 1;
        const current = state.operation;
        if (current && current.status === "succeeded") {
          return { claimed: false, completed: true, operation: current };
        }
        if (
          current
          && current.status === "processing"
          && current.providerTaskId
        ) {
          return { claimed: false, completed: false, operation: current };
        }
        if (current && ["refunding", "refunded"].includes(current.status)) {
          const error = new Error("任务已经退款");
          error.code = "request-refunded";
          throw error;
        }
        return {
          claimed: true,
          completed: false,
          operation: mergeOperation(openid, requestId, {
            status: "processing",
            pipelineStage: "processing",
            attemptCount: Number(current && current.attemptCount || 0) + 1
          })
        };
      },
      update: async (openid, requestId, patch, options) => {
        calls.update.push({ patch, options });
        return mergeOperation(openid, requestId, patch);
      },
      complete: async (openid, requestId, result) => {
        calls.complete += 1;
        return mergeOperation(openid, requestId, {
          status: "succeeded",
          pipelineStage: "succeeded",
          progress: 100,
          providerTaskId: result.taskId,
          providerStatus: result.providerStatus,
          videoFileID: result.videoFileID,
          videoCloudPath: result.videoCloudPath,
          videoBytes: result.videoBytes,
          videoURL: result.videoURL,
          result,
          reconcilePending: false,
          cleanupPending: false
        });
      },
      fail: async (openid, requestId, error, patch) => {
        calls.fail += 1;
        return mergeOperation(openid, requestId, Object.assign({
          status: "failed",
          pipelineStage: "failed",
          lastError: {
            code: String(error && error.code || "video-failed"),
            message: String(error && error.message || "视频任务失败"),
            retryable: Boolean(error && error.retryable)
          }
        }, patch || {}));
      },
      stateError: (operation) => {
        const error = new Error("任务正在处理中");
        error.code = `state-${operation && operation.status || "unknown"}`;
        return error;
      }
    },
    source: {
      prepare: async (imageFileID) => {
        calls.prepare += 1;
        return {
          buffer: Buffer.from("jpeg-source"),
          sourceOriginalFileID: imageFileID,
          sourceImageFileID: "cloud://video/source.jpg",
          sourceCloudPath: "photo-to-video-sources/source.jpg",
          width: 1280,
          height: 720,
          bytes: Buffer.byteLength("jpeg-source")
        };
      }
    },
    provider: {
      buildPayload: (payload) => ({
        model: "video-model",
        prompt: payload.prompt,
        resolution: payload.resolution || "720p",
        duration: payload.durationSeconds || 3
      }),
      create: async (input) => {
        calls.create += 1;
        calls.createProviders.push(input && input.video && input.video.provider || "");
        if (typeof state.createHandler === "function") {
          return state.createHandler(input);
        }
        return Object.assign({}, state.createResult);
      },
      query: async (input) => {
        calls.query += 1;
        calls.queryProviders.push(input && input.video && input.video.provider || "");
        if (typeof state.queryHandler === "function") {
          return state.queryHandler(input);
        }
        return Object.assign({}, state.queryResult);
      }
    },
    files: {
      materialize: async ({ taskId }) => {
        calls.materialize += 1;
        return {
          videoFileID: `cloud://video/${taskId}.mp4`,
          videoCloudPath: `photo-to-video-results/${taskId}.mp4`,
          videoBytes: 1024
        };
      },
      delete: async (fileID) => {
        calls.delete.push(fileID);
        return { deleted: true, fileID };
      }
    },
    response: {
      ok: (data) => Object.assign({ ok: true }, data),
      fail: (message, errorCode, detail) => Object.assign({
        ok: false,
        message,
        errorCode
      }, detail || {})
    },
    serialization: {
      sanitizeError: (value) => String(value || "").slice(0, 240)
    },
    log: (level, event, fields) => calls.log.push({ level, event, fields }),
    now: () => state.now,
    recovery: {
      reservedStaleMs: 5 * 60 * 1000,
      processingStaleMs: 10 * 60 * 1000,
      maxAttempts: 2
    }
  };

  return {
    calls,
    state,
    services,
    kernel: createVideoExecutionKernel(services)
  };
}

function enableBackup(harness, options = {}) {
  harness.state.configs = {
    video: Object.assign({}, harness.state.configs.video, options.primary || {}),
    videoBackup: Object.assign({
      enabled: true,
      configured: true,
      provider: "xingju",
      apiKey: "backup-video-secret",
      model: "backup-video-model",
      resolution: "720p"
    }, options.backup || {}),
    costs: {}
  };
}

function providerHttpError(status, message = "上游创建失败") {
  const error = new Error(message);
  error.code = `HTTP_${status}`;
  error.status = status;
  return error;
}

async function createTask(harness, requestId = "video-request-001") {
  return harness.kernel.createVideoTask({
    requestId,
    payload: {
      imageFileID: "cloud://source/original.png",
      prompt: "让照片自然动起来",
      durationSeconds: 3,
      resolution: "720p"
    }
  }, { OPENID: "video-user" });
}

async function main() {
  assert.throws(
    () => createVideoExecutionKernel({}),
    (error) => (
      error
      && error.code === "video-kernel-dependency-missing"
      && error.dependency === "getOpenId"
    )
  );

  {
    const harness = createHarness();
    harness.services.config.resolve = async () => ({
      video: { configured: false }
    });
    const kernel = createVideoExecutionKernel(harness.services);
    const result = await createTask(Object.assign({}, harness, { kernel }));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "VIDEO_PROVIDER_NOT_CONFIGURED");
    assert.strictEqual(harness.calls.reserve, 0);
  }

  {
    const harness = createHarness();
    const first = await createTask(harness);
    const second = await createTask(harness);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(first.taskId, "provider-task-001");
    assert.strictEqual(second.taskId, "provider-task-001");
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(harness.calls.create, 1, "重复创建不能重复请求上游");
    assert.strictEqual(harness.calls.prepare, 1, "重复创建不能重复处理源图");
  }

  {
    const harness = createHarness();
    enableBackup(harness);
    const result = await createTask(harness, "primary-success-no-backup");
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(harness.calls.createProviders, ["lingyun"]);
    assert.strictEqual(result.providerRole, "primary");
    assert.strictEqual(result.providerFallbackUsed, false);
  }

  for (const status of [403, 500]) {
    const harness = createHarness();
    enableBackup(harness);
    harness.state.createHandler = ({ video }) => {
      if (video.provider === "lingyun") throw providerHttpError(status);
      return {
        taskId: `backup-task-${status}`,
        status: "processing",
        providerStatus: "queued"
      };
    };
    const result = await createTask(harness, `fallback-${status}`);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.provider, "xingju");
    assert.strictEqual(result.providerRole, "backup");
    assert.strictEqual(result.providerFallbackUsed, true);
    assert.deepStrictEqual(harness.calls.createProviders, ["lingyun", "xingju"]);
    assert.strictEqual(harness.state.operation.provider, "xingju");
    assert.strictEqual(harness.state.operation.providerRole, "backup");
    const persisted = JSON.stringify(harness.state.operation);
    assert.strictEqual(persisted.includes("primary-video-secret"), false);
    assert.strictEqual(persisted.includes("backup-video-secret"), false);
    const logged = JSON.stringify(harness.calls.log);
    assert.strictEqual(logged.includes("primary-video-secret"), false);
    assert.strictEqual(logged.includes("backup-video-secret"), false);
  }

  {
    const harness = createHarness();
    enableBackup(harness);
    harness.state.createHandler = ({ video }) => {
      if (video.provider === "lingyun") throw providerHttpError(500);
      return {
        taskId: "fallback-deduplicated-task",
        status: "processing",
        providerStatus: "queued"
      };
    };
    const first = await createTask(harness, "fallback-deduplicated-request");
    const second = await createTask(harness, "fallback-deduplicated-request");
    assert.strictEqual(first.provider, "xingju");
    assert.strictEqual(second.taskId, first.taskId);
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(harness.calls.reserve, 2);
    assert.strictEqual(harness.calls.create, 2, "重复 requestId 不能再次请求主备服务商");
  }

  {
    const harness = createHarness();
    enableBackup(harness, { backup: { configured: false, enabled: false } });
    harness.state.createHandler = () => {
      throw providerHttpError(500);
    };
    const kernel = createVideoExecutionKernel(harness.services);
    await assert.rejects(
      () => createTask(Object.assign({}, harness, { kernel }), "backup-disabled"),
      (error) => error && error.status === 500
    );
    assert.deepStrictEqual(harness.calls.createProviders, ["lingyun"]);
    assert.strictEqual(harness.calls.refund, 1);
  }

  {
    const harness = createHarness();
    enableBackup(harness);
    harness.state.createHandler = () => {
      throw providerHttpError(500);
    };
    const kernel = createVideoExecutionKernel(harness.services);
    await assert.rejects(
      () => createTask(Object.assign({}, harness, { kernel }), "both-providers-fail"),
      (error) => error && error.status === 500
    );
    assert.deepStrictEqual(harness.calls.createProviders, ["lingyun", "xingju"]);
    assert.strictEqual(harness.calls.refund, 1, "主备都失败只能退款一次");
    assert.strictEqual(harness.calls.fail, 1, "主备都失败只能落一条失败状态");
  }

  {
    const harness = createHarness();
    harness.state.operation = {
      openid: "video-user",
      requestId: "existing-provider-request",
      kind: "video",
      status: "processing",
      providerTaskId: "provider-existing",
      providerStatus: "queued",
      result: {
        taskId: "provider-existing",
        status: "processing",
        providerStatus: "queued"
      },
      billing: { source: "daily-free", kind: "video" }
    };
    const result = await createTask(harness, "existing-provider-request");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.taskId, "provider-existing");
    assert.strictEqual(result.deduplicated, true);
    assert.strictEqual(harness.calls.create, 0);
  }

  {
    const harness = createHarness();
    harness.services.provider.create = async () => {
      harness.calls.create += 1;
      const error = new Error("上游创建失败");
      error.code = "VIDEO_CREATE_FAILED";
      throw error;
    };
    const kernel = createVideoExecutionKernel(harness.services);
    await assert.rejects(
      () => createTask(Object.assign({}, harness, { kernel }), "create-fail-request"),
      (error) => error && error.code === "VIDEO_CREATE_FAILED"
    );
    await assert.rejects(
      () => createTask(Object.assign({}, harness, { kernel }), "create-fail-request"),
      (error) => error && error.code === "request-refunded"
    );
    assert.strictEqual(harness.calls.refund, 1, "创建失败只能退款一次");
    assert.strictEqual(harness.calls.fail, 1);
  }

  {
    const harness = createHarness();
    const created = await createTask(harness, "query-success-request");
    harness.state.queryResult = {
      status: "succeeded",
      providerStatus: "done",
      videoURL: "https://video.example/result.mp4",
      error: ""
    };
    const first = await harness.kernel.queryVideoTask({
      requestId: "query-success-request",
      taskId: created.taskId
    }, { OPENID: "video-user" });
    const second = await harness.kernel.queryVideoTask({
      requestId: "query-success-request",
      taskId: created.taskId
    }, { OPENID: "video-user" });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.status, "succeeded");
    assert.ok(first.videoFileID);
    assert.strictEqual(second.videoFileID, first.videoFileID);
    assert.strictEqual(second.deduplicated, true);
    assert.strictEqual(harness.calls.materialize, 1, "成功结果只能下载上传一次");
    assert.strictEqual(harness.calls.query, 1, "已保存结果后不再重复查上游");
    assert.strictEqual(harness.calls.complete, 1);
  }

  {
    const harness = createHarness();
    const created = await createTask(harness, "query-failed-request");
    harness.state.queryResult = {
      status: "failed",
      providerStatus: "failed",
      videoURL: "",
      error: "供应商拒绝"
    };
    const failed = await harness.kernel.queryVideoTask({
      requestId: "query-failed-request",
      taskId: created.taskId
    }, { OPENID: "video-user" });
    assert.strictEqual(failed.ok, true);
    assert.strictEqual(failed.status, "failed");
    assert.strictEqual(harness.calls.refund, 1);
    await assert.rejects(
      () => harness.kernel.queryVideoTask({
        requestId: "query-failed-request",
        taskId: created.taskId
      }, { OPENID: "video-user" }),
      (error) => error && error.code === "state-refunded"
    );
    assert.strictEqual(harness.calls.refund, 1, "失败轮询也只能退款一次");
  }

  {
    const harness = createHarness();
    enableBackup(harness);
    const created = await createTask(harness, "query-does-not-fallback");
    harness.state.queryHandler = ({ video }) => {
      assert.strictEqual(video.provider, "lingyun");
      const error = providerHttpError(500, "主服务商查询失败");
      throw error;
    };
    await assert.rejects(
      () => harness.kernel.queryVideoTask({
        requestId: "query-does-not-fallback",
        taskId: created.taskId
      }, { OPENID: "video-user" }),
      (error) => error && error.status === 500
    );
    assert.deepStrictEqual(harness.calls.createProviders, ["lingyun"]);
    assert.deepStrictEqual(harness.calls.queryProviders, ["lingyun"]);
  }

  {
    const harness = createHarness();
    enableBackup(harness);
    harness.state.createHandler = ({ video }) => {
      if (video.provider === "lingyun") throw providerHttpError(403);
      return {
        taskId: "backup-query-sticky-task",
        status: "processing",
        providerStatus: "queued"
      };
    };
    const created = await createTask(harness, "backup-query-sticky");
    harness.state.queryResult = {
      status: "processing",
      providerStatus: "running",
      videoURL: "",
      error: ""
    };
    await harness.kernel.queryVideoTask({
      requestId: "backup-query-sticky",
      taskId: created.taskId
    }, { OPENID: "video-user" });
    assert.deepStrictEqual(harness.calls.queryProviders, ["xingju"]);

    harness.state.configs.videoBackup = { configured: false, enabled: false };
    const unavailable = await harness.kernel.queryVideoTask({
      requestId: "backup-query-sticky",
      taskId: created.taskId
    }, { OPENID: "video-user" });
    assert.strictEqual(unavailable.ok, false);
    assert.strictEqual(unavailable.errorCode, "VIDEO_PROVIDER_NOT_CONFIGURED");
    assert.deepStrictEqual(
      harness.calls.queryProviders,
      ["xingju"],
      "备用任务配置失效后不能静默改查主服务商"
    );
  }

  {
    const harness = createHarness();
    harness.state.operation = {
      openid: "video-user",
      requestId: "reconcile-query-request",
      kind: "video",
      status: "processing",
      providerTaskId: "provider-reconcile",
      providerStatus: "running",
      updatedAt: new Date("2026-08-26T11:30:00.000Z"),
      billing: { source: "points", kind: "video", pointsCharged: 8 }
    };
    harness.state.queryResult = {
      status: "succeeded",
      providerStatus: "done",
      videoURL: "https://video.example/reconcile.mp4",
      error: ""
    };
    const result = await harness.kernel.reconcileVideoOperation(
      harness.state.operation,
      { now: harness.state.now }
    );
    assert.strictEqual(result.action, "video-result-completed");
    assert.strictEqual(harness.calls.query, 1, "卡住的视频任务应主动查询上游");
    assert.strictEqual(harness.calls.materialize, 1);
  }

  {
    const harness = createHarness();
    harness.state.operation = {
      openid: "video-user",
      requestId: "reconcile-record-request",
      kind: "video",
      status: "processing",
      providerTaskId: "provider-record",
      providerStatus: "done",
      videoURL: "https://video.example/record.mp4",
      videoFileID: "cloud://video/provider-record.mp4",
      videoCloudPath: "photo-to-video-results/provider-record.mp4",
      videoBytes: 2048,
      result: {
        taskId: "provider-record",
        status: "succeeded",
        providerStatus: "done",
        videoURL: "https://video.example/record.mp4"
      },
      reconcilePending: true,
      updatedAt: new Date("2026-08-26T11:30:00.000Z")
    };
    const result = await harness.kernel.reconcileVideoOperation(
      harness.state.operation,
      { now: harness.state.now }
    );
    assert.strictEqual(result.action, "video-result-rebuilt");
    assert.strictEqual(harness.calls.materialize, 0, "已有云文件时只补记录");
    assert.strictEqual(harness.calls.complete, 1);
  }

  {
    const harness = createHarness();
    harness.state.operation = {
      openid: "video-user",
      requestId: "cleanup-refunded-request",
      kind: "video",
      status: "refunded",
      providerTaskId: "provider-refunded",
      sourceImageFileID: "cloud://video/source-refunded.jpg",
      videoFileID: "cloud://video/result-refunded.mp4",
      cleanupPending: true,
      updatedAt: new Date("2026-08-26T11:30:00.000Z")
    };
    const result = await harness.kernel.reconcileVideoOperation(
      harness.state.operation,
      { now: harness.state.now }
    );
    assert.strictEqual(result.action, "video-cleanup-completed");
    assert.deepStrictEqual(
      harness.calls.delete.sort(),
      [
        "cloud://video/result-refunded.mp4",
        "cloud://video/source-refunded.jpg"
      ].sort()
    );
    assert.strictEqual(harness.state.operation.cleanupPending, false);
    assert.strictEqual(harness.state.operation.videoFileID, "");
    assert.strictEqual(harness.state.operation.sourceImageFileID, "");
  }

  {
    const harness = createHarness();
    harness.state.createResult = {
      taskId: "provider-direct-success",
      status: "succeeded",
      providerStatus: "done",
      videoURL: "https://video.example/direct-success.mp4"
    };
    const result = await createTask(harness, "direct-success-request");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "succeeded");
    assert.ok(result.videoFileID);
    assert.strictEqual(harness.calls.materialize, 1);
    assert.strictEqual(harness.calls.complete, 1);
  }

  console.log(
    "video execution kernel smoke: OK "
    + "(DI/idempotency/provider/result/refund/reconcile/cleanup)"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
