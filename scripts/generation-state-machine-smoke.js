/* eslint-disable no-console */

const assert = require("assert");
const stateMachine = require("../cloudfunctions/api/lib/generation-state-machine");

const reserved = {
  status: "reserved",
  pipelineStage: "reserved",
  attemptCount: 0,
  stageHistory: []
};
const queuedPatch = stateMachine.applyTransition(reserved, {
  status: "queued",
  pipelineStage: "queued",
  progress: 0
}, {
  actor: "client"
});
assert.strictEqual(queuedPatch.status, "queued");
assert.strictEqual(queuedPatch.stageHistory.length, 1);
assert.strictEqual(queuedPatch.stageHistory[0].fromStatus, "reserved");
assert.strictEqual(queuedPatch.stageHistory[0].actor, "client");

const processing = Object.assign({}, reserved, queuedPatch);
const processingPatch = stateMachine.applyTransition(processing, {
  status: "processing",
  pipelineStage: "validate",
  progress: 5,
  attemptCount: 1
}, {
  actor: "worker"
});
assert.strictEqual(processingPatch.stageHistory.length, 2);
assert.strictEqual(processingPatch.stageHistory[1].stage, "validate");
assert.strictEqual(processingPatch.stageHistory[1].attemptCount, 1);

const repeated = stateMachine.applyTransition(
  Object.assign({}, processing, processingPatch),
  {
    status: "processing",
    pipelineStage: "validate",
    progress: 10,
    attemptCount: 1
  },
  { actor: "worker" }
);
assert.strictEqual(repeated.stageHistory.length, 2);

const failedPatch = stateMachine.applyTransition(
  Object.assign({}, processing, processingPatch),
  {
    status: "failed",
    pipelineStage: "failed",
    progress: 0,
    lastError: { code: "provider-failed", message: "must-not-be-copied" }
  },
  { actor: "worker" }
);
const failed = Object.assign({}, processing, processingPatch, failedPatch);
const recoveredPatch = stateMachine.applyTransition(failed, {
  status: "queued",
  pipelineStage: "queued",
  progress: 0
}, {
  actor: "reconcile",
  code: "generation-processing-requeued"
});
assert.strictEqual(recoveredPatch.status, "queued");
assert.strictEqual(
  recoveredPatch.stageHistory[recoveredPatch.stageHistory.length - 1].actor,
  "reconcile"
);

const refundedPatch = stateMachine.applyTransition(failed, {
  status: "refunded",
  pipelineStage: "refunded",
  progress: 0
}, {
  actor: "billing",
  code: "refund-ledger-created"
});
const refunded = Object.assign({}, failed, refundedPatch);
const repeatedRefund = stateMachine.applyTransition(refunded, {
  status: "refunded",
  pipelineStage: "refunded",
  progress: 0
}, {
  actor: "billing",
  code: "refund-ledger-created"
});
assert.strictEqual(
  repeatedRefund.stageHistory.length,
  refundedPatch.stageHistory.length
);

assert.throws(
  () => stateMachine.applyTransition(
    { status: "reserved", pipelineStage: "reserved" },
    { status: "succeeded", pipelineStage: "succeeded" }
  ),
  (error) => error && error.code === "generation-transition-invalid"
);

assert.throws(
  () => stateMachine.applyTransition(
    { status: "succeeded", pipelineStage: "succeeded" },
    { status: "processing", pipelineStage: "validate" }
  ),
  (error) => error && error.code === "generation-transition-invalid"
);

let operation = {
  status: "processing",
  pipelineStage: "validate",
  attemptCount: 1,
  stageHistory: []
};
for (let index = 0; index < 30; index += 1) {
  const patch = stateMachine.applyTransition(operation, {
    status: "processing",
    pipelineStage: `stage-${index}`,
    progress: index
  }, {
    actor: "worker",
    code: index === 29 ? "last-code" : ""
  });
  operation = Object.assign({}, operation, patch);
}
assert.strictEqual(operation.stageHistory.length, 20);
assert.strictEqual(operation.stageHistory[19].stage, "stage-29");
assert.strictEqual(operation.stageHistory[19].code, "last-code");
assert.ok(!JSON.stringify(operation.stageHistory).includes("prompt"));
assert.strictEqual(stateMachine.isTerminalStatus("succeeded"), true);
assert.strictEqual(stateMachine.isTerminalStatus("refunded"), true);
assert.strictEqual(stateMachine.isTerminalStatus("failed"), false);

console.log("generation state machine smoke: OK");
