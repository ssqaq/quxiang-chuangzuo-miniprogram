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
