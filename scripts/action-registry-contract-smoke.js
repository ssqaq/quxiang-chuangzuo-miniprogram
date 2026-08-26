const assert = require("assert");
const {
  ACCESS,
  createActionRegistry
} = require("../cloudfunctions/api/lib/action-registry");

async function main() {
  const logs = [];
  const registry = createActionRegistry({
    log: (level, event, fields) => logs.push({ level, event, fields }),
    isAdmin: (context) => Boolean(context && context.admin),
    forbidden: () => ({
      ok: false,
      errorCode: "ADMIN_FORBIDDEN",
      message: "没有管理员权限。"
    }),
    getTriggerName: (event) => String(event.triggerName || ""),
    mapError: (error, fields) => ({
      ok: false,
      errorCode: error.code || "MAPPED_ERROR",
      message: error.message,
      requestId: fields.requestId
    })
  });

  registry.register({
    name: "generate",
    access: ACCESS.USER,
    metadata: { workflow: "image" },
    handler: ({ requestId, metadata, matchedBy }) => ({
      ok: true,
      requestId,
      workflow: metadata.workflow,
      matchedBy
    })
  });
  registry.register({
    name: "getAdminGenerationQueue",
    access: ACCESS.ADMIN,
    handler: () => ({ ok: true, admin: true })
  });
  registry.register({
    name: "processGenerationQueue",
    triggerName: "generation-queue-worker",
    access: ACCESS.TIMER_OR_ADMIN,
    handler: ({ matchedBy, triggerName }) => ({
      ok: true,
      matchedBy,
      triggerName
    })
  });
  registry.register({
    name: "explode",
    access: ACCESS.USER,
    handler: () => {
      throw Object.assign(new Error("boom"), { code: "BOOM" });
    }
  });

  const user = await registry.dispatch(
    { action: "generate", requestId: "request-user" },
    {}
  );
  assert.strictEqual(user.handled, true);
  assert.strictEqual(user.result.ok, true);
  assert.strictEqual(user.result.requestId, "request-user");
  assert.strictEqual(user.result.workflow, "image");
  assert.strictEqual(user.result.matchedBy, "action");

  const denied = await registry.dispatch(
    { action: "getAdminGenerationQueue", requestId: "request-denied" },
    {}
  );
  assert.strictEqual(denied.denied, true);
  assert.strictEqual(denied.result.errorCode, "ADMIN_FORBIDDEN");

  const admin = await registry.dispatch(
    { action: "getAdminGenerationQueue", requestId: "request-admin" },
    { admin: true }
  );
  assert.strictEqual(admin.denied, false);
  assert.strictEqual(admin.result.admin, true);

  const timer = await registry.dispatch(
    { triggerName: "generation-queue-worker", requestId: "request-timer" },
    {}
  );
  assert.strictEqual(timer.result.matchedBy, "trigger");
  assert.strictEqual(timer.result.triggerName, "generation-queue-worker");

  const nearTimer = await registry.dispatch(
    { triggerName: "generation-queue-worker-copy" },
    {}
  );
  assert.deepStrictEqual(nearTimer, { handled: false });

  const fakeTimerAction = await registry.dispatch(
    {
      action: "processGenerationQueue",
      triggerName: "generation-queue-worker-copy"
    },
    {}
  );
  assert.strictEqual(fakeTimerAction.denied, true);

  const manualAdmin = await registry.dispatch(
    { action: "processGenerationQueue" },
    { admin: true }
  );
  assert.strictEqual(manualAdmin.denied, false);
  assert.strictEqual(manualAdmin.result.matchedBy, "action");

  const unknown = await registry.dispatch(
    { action: "legacyAction" },
    {}
  );
  assert.deepStrictEqual(unknown, { handled: false });

  const mapped = await registry.dispatch(
    { action: "explode", requestId: "request-error" },
    {}
  );
  assert.strictEqual(mapped.errorMapped, true);
  assert.strictEqual(mapped.result.errorCode, "BOOM");
  assert.strictEqual(mapped.result.requestId, "request-error");

  assert.ok(logs.some((item) => item.event === "action-registry.start"));
  assert.ok(logs.some((item) => item.event === "action-registry.finish"));
  assert.ok(logs.some((item) => item.event === "action-registry.denied"));
  assert.ok(logs.some((item) => (
    item.event === "action-registry.error"
    && item.fields.errorCode === "BOOM"
  )));

  assert.throws(() => registry.register({
    name: "generate",
    handler: () => ({})
  }), /重复登记/);
  assert.throws(() => registry.register({
    name: "another-worker",
    triggerName: "generation-queue-worker",
    access: ACCESS.TIMER_OR_ADMIN,
    handler: () => ({})
  }), /重复登记定时器/);

  const mappingLogs = [];
  const brokenMapper = createActionRegistry({
    log: (level, event, fields) => mappingLogs.push({ level, event, fields }),
    mapError: () => {
      throw Object.assign(new Error("mapper failed"), { code: "MAPPER_FAILED" });
    }
  });
  brokenMapper.register({
    name: "broken",
    handler: () => {
      throw Object.assign(new Error("handler failed"), { code: "HANDLER_FAILED" });
    }
  });
  await assert.rejects(
    () => brokenMapper.dispatch({ action: "broken" }, {}),
    (error) => error && error.code === "HANDLER_FAILED"
  );
  assert.ok(mappingLogs.some((item) => (
    item.event === "action-registry.error-map-failed"
    && item.fields.errorCode === "MAPPER_FAILED"
  )));

  console.log("action registry contract smoke: OK");
}

main().catch((error) => {
  console.error(`action registry contract smoke 失败：${error.stack || error}`);
  process.exitCode = 1;
});
