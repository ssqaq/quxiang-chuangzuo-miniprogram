/* eslint-disable no-console */

const assert = require("assert");
const {
  ACCESS,
  createActionRegistry
} = require("../cloudfunctions/api/lib/action-registry");

async function main() {
  const logs = [];
  const calls = [];
  const registry = createActionRegistry({
    log(level, event, fields) {
      logs.push({ level, event, fields });
    },
    isAdmin(context) {
      return Boolean(context && context.admin);
    },
    forbidden() {
      return { ok: false, errorCode: "ADMIN_FORBIDDEN" };
    },
    mapError(error, fields) {
      return {
        ok: false,
        errorCode: error.code,
        requestId: fields.requestId
      };
    }
  });

  registry.register({
    name: "generate",
    access: ACCESS.USER,
    handler: async ({ requestId }) => {
      calls.push(`generate:${requestId}`);
      return { ok: true, requestId };
    }
  });
  registry.register({
    name: "processGenerationQueue",
    triggerName: "generation-queue-worker",
    access: ACCESS.TIMER_OR_ADMIN,
    handler: async ({ matchedBy }) => {
      calls.push(`worker:${matchedBy}`);
      return { ok: true, matchedBy };
    }
  });
  registry.register({
    name: "explode",
    access: ACCESS.USER,
    handler: async () => {
      const error = new Error("boom");
      error.code = "boom-code";
      throw error;
    }
  });

  const unknown = await registry.dispatch({ action: "legacy" }, {});
  assert.strictEqual(unknown.handled, false);

  const generated = await registry.dispatch(
    { action: "generate", requestId: "registry-request" },
    {}
  );
  assert.strictEqual(generated.handled, true);
  assert.strictEqual(generated.result.requestId, "registry-request");

  const denied = await registry.dispatch(
    { action: "processGenerationQueue" },
    { admin: false }
  );
  assert.strictEqual(denied.handled, true);
  assert.strictEqual(denied.denied, true);
  assert.strictEqual(denied.result.errorCode, "ADMIN_FORBIDDEN");

  const admin = await registry.dispatch(
    { action: "processGenerationQueue" },
    { admin: true }
  );
  assert.strictEqual(admin.result.matchedBy, "action");

  const timer = await registry.dispatch(
    { triggerName: "generation-queue-worker" },
    { admin: false }
  );
  assert.strictEqual(timer.result.matchedBy, "trigger");

  const wrongTimer = await registry.dispatch(
    { triggerName: "generation-queue-worker-near-match" },
    { admin: false }
  );
  assert.strictEqual(wrongTimer.handled, false);

  const exploded = await registry.dispatch(
    { action: "explode", requestId: "explode-request" },
    {}
  );
  assert.strictEqual(exploded.handled, true);
  assert.strictEqual(exploded.errorMapped, true);
  assert.strictEqual(exploded.result.errorCode, "boom-code");
  assert.strictEqual(exploded.result.requestId, "explode-request");

  assert.ok(logs.some((item) => item.event === "action-registry.start"));
  assert.ok(logs.some((item) => item.event === "action-registry.finish"));
  assert.ok(logs.some((item) => item.event === "action-registry.denied"));
  assert.ok(logs.some((item) => item.event === "action-registry.error"));
  assert.deepStrictEqual(calls, [
    "generate:registry-request",
    "worker:action",
    "worker:trigger"
  ]);
  console.log("action registry smoke: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
