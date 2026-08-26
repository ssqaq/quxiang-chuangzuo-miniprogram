/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";

const root = path.resolve(__dirname, "..");
const api = require(path.join(root, "cloudfunctions", "api", "index.js"));
const test = api.__test;
const triggerConfig = JSON.parse(
  fs.readFileSync(
    path.join(root, "cloudfunctions", "api", "config.json"),
    "utf8"
  )
);

function operation(overrides = {}) {
  return Object.assign({
    _id: "operation-id",
    openid: "test-user",
    requestId: "generation-request",
    kind: "image",
    status: "processing",
    pipelineStage: "record",
    progress: 95,
    payload: {
      generationType: "normal",
      projectName: "异步测试",
      prompt: "test prompt"
    },
    billing: {
      source: "daily-free",
      pointsCharged: 0,
      quota: {
        freeUsed: 1,
        freeLimit: 3,
        freeRemaining: 2
      }
    },
    model: "gpt-image-2",
    size: "1024x1024",
    resolution: "1K",
    updatedAt: new Date("2026-08-26T11:30:00.000Z")
  }, overrides);
}

function hookRecorder(overrides = {}) {
  const calls = {
    update: [],
    fail: [],
    refund: [],
    deleteFile: [],
    persist: [],
    complete: []
  };
  const hooks = {
    async updateOperation(openid, requestId, patch, options) {
      calls.update.push({ openid, requestId, patch, options });
      return Object.assign({}, patch);
    },
    async failOperation(openid, requestId, error) {
      calls.fail.push({ openid, requestId, error });
      return { status: "failed" };
    },
    async refund(openid, requestId, reason) {
      calls.refund.push({ openid, requestId, reason });
      return { duplicate: false, operation: { status: "refunded" } };
    },
    async deleteFile(fileID) {
      calls.deleteFile.push(fileID);
      return { fileList: [{ fileID, status: 0 }] };
    },
    async persistResult(openid, source, result, billing) {
      calls.persist.push({ openid, source, result, billing });
      return {
        recordId: "rebuilt-record",
        fileID: result.fileID,
        tempFileURL: result.tempFileURL,
        createdAt: result.createdAt,
        record: {
          id: "rebuilt-record",
          fileID: result.fileID,
          tempFileURL: result.tempFileURL
        }
      };
    },
    async completeOperation(openid, requestId, result) {
      calls.complete.push({ openid, requestId, result });
      return { status: "succeeded" };
    },
    async tempFileUrl(fileID) {
      return `https://temporary.example/${encodeURIComponent(fileID)}`;
    }
  };
  return {
    calls,
    hooks: Object.assign(hooks, overrides)
  };
}

async function main() {
  assert.ok(
    triggerConfig.triggers.some((item) => (
      item.name === "generation-queue-worker"
      && item.type === "timer"
    )),
    "缺少普通生图队列 worker 定时器"
  );
  assert.ok(
    triggerConfig.triggers.some((item) => (
      item.name === "generation-operation-reconcile"
      && item.type === "timer"
    )),
    "缺少普通生图任务回收定时器"
  );

  const now = new Date("2026-08-26T12:00:00.000Z");

  {
    const recorder = hookRecorder();
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        resultFileID: "cloud://results/rebuild.png",
        resultCreatedAt: new Date("2026-08-26T11:58:00.000Z")
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "record-rebuilt");
    assert.strictEqual(recorder.calls.persist.length, 1);
    assert.strictEqual(recorder.calls.complete.length, 1);
    assert.strictEqual(recorder.calls.deleteFile.length, 0);
    assert.strictEqual(recorder.calls.refund.length, 0);
  }

  {
    const recorder = hookRecorder({
      async persistResult() {
        throw Object.assign(new Error("record unavailable"), {
          code: "record-unavailable"
        });
      }
    });
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        resultFileID: "cloud://results/retry.png",
        reconcileAttemptCount: 0
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "record-retry-pending");
    assert.strictEqual(result.attemptCount, 1);
    assert.ok(recorder.calls.update.some((item) => (
      item.patch.reconcilePending === true
      && item.patch.reconcileAttemptCount === 1
    )));
    assert.strictEqual(recorder.calls.deleteFile.length, 0);
    assert.strictEqual(recorder.calls.refund.length, 0);
  }

  {
    const recorder = hookRecorder({
      async persistResult() {
        throw Object.assign(new Error("record unavailable again"), {
          code: "record-unavailable"
        });
      }
    });
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        resultFileID: "cloud://results/orphan.png",
        reconcileAttemptCount: 1
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "orphan-cleaned-refund");
    assert.deepStrictEqual(
      recorder.calls.deleteFile,
      ["cloud://results/orphan.png"]
    );
    assert.strictEqual(recorder.calls.fail.length, 1);
    assert.strictEqual(recorder.calls.refund.length, 1);
  }

  {
    const recorder = hookRecorder({
      async deleteFile(fileID) {
        recorder.calls.deleteFile.push(fileID);
        throw Object.assign(new Error("delete service unavailable"), {
          code: "delete-unavailable"
        });
      }
    });
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        status: "refunded",
        resultFileID: "cloud://results/cleanup-retry.png",
        cleanupPending: true
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "cleanup-pending");
    assert.ok(recorder.calls.update.some((item) => (
      item.patch.cleanupPending === true
      && /delete service unavailable/.test(item.patch.cleanupLastError)
    )));
    assert.strictEqual(recorder.calls.refund.length, 0);
  }

  {
    const recorder = hookRecorder();
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        status: "queued",
        pipelineStage: "queued",
        updatedAt: new Date("2026-08-26T11:50:00.000Z")
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "queued-refund");
    assert.strictEqual(recorder.calls.fail.length, 1);
    assert.strictEqual(recorder.calls.refund.length, 1);
  }

  {
    const recorder = hookRecorder();
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        status: "processing",
        pipelineStage: "upstream",
        recoveryAttemptCount: 0,
        updatedAt: new Date("2026-08-26T11:40:00.000Z")
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "processing-requeued");
    assert.ok(recorder.calls.update.some((item) => (
      item.patch.status === "queued"
      && item.patch.recoveryAttemptCount === 1
    )));
    assert.strictEqual(recorder.calls.refund.length, 0);
  }

  {
    const recorder = hookRecorder();
    const result = await test.reconcileGenerationOperationForTest(
      operation({
        status: "processing",
        pipelineStage: "upstream",
        recoveryAttemptCount: 2,
        updatedAt: new Date("2026-08-26T11:40:00.000Z")
      }),
      now,
      recorder.hooks
    );
    assert.strictEqual(result.action, "processing-refund");
    assert.strictEqual(recorder.calls.fail.length, 1);
    assert.strictEqual(recorder.calls.refund.length, 1);
  }

  console.log(
    "generation orphan cleanup smoke: OK "
    + "(record rebuild/retry/orphan cleanup/stale recovery/refund)"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
