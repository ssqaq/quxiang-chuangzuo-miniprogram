const assert = require("assert");

const {
  buildImageProviderAttemptPlan,
  classifyImageProviderError,
  runImageProviderFailover
} = require("../lib/image-provider-failover");

function providerConfig(provider, model) {
  return {
    provider,
    model,
    baseUrl: `https://${provider}.example/v1`,
    apiKey: `${provider}-test-key`,
    timeoutMs: 150000
  };
}

function upstreamError(code, options = {}) {
  const error = new Error(options.message || code);
  error.code = code;
  error.status = Number(options.status) || 0;
  if (options.retryable !== undefined) error.retryable = Boolean(options.retryable);
  return error;
}

async function testAttemptPlan() {
  const primary = providerConfig("xingju", "jw-gpt-image-2");
  const backup = providerConfig("lingyun", "gpt-image-2");
  const plan = buildImageProviderAttemptPlan(primary, backup);
  assert.deepStrictEqual(
    plan.map((item) => ({
      role: item.role,
      attempt: item.attempt,
      provider: item.config.provider,
      model: item.config.model,
      timeoutMs: item.config.timeoutMs
    })),
    [
      {
        role: "primary",
        attempt: 1,
        provider: "xingju",
        model: "jw-gpt-image-2",
        timeoutMs: 150000
      },
      {
        role: "primary",
        attempt: 2,
        provider: "xingju",
        model: "jw-gpt-image-2",
        timeoutMs: 150000
      },
      {
        role: "backup",
        attempt: 1,
        provider: "lingyun",
        model: "gpt-image-2",
        timeoutMs: 150000
      }
    ]
  );
}

async function testPrimaryFirstAttemptSuccess() {
  const calls = [];
  const result = await runImageProviderFailover({
    requestId: "failover-primary-success",
    primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
    backupConfig: providerConfig("lingyun", "gpt-image-2"),
    executeAttempt: async (attempt) => {
      calls.push(attempt);
      return { image: "primary-result" };
    }
  });
  assert.strictEqual(result.value.image, "primary-result");
  assert.strictEqual(result.providerRole, "primary");
  assert.strictEqual(result.providerAttempt, 1);
  assert.strictEqual(result.provider, "xingju");
  assert.strictEqual(result.model, "jw-gpt-image-2");
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1"]
  );
  assert.strictEqual(result.attempts.length, 1);
  assert.strictEqual(result.attempts[0].success, true);
  assert.strictEqual(
    calls[0].idempotencyKey,
    "failover-primary-success:primary:1"
  );
}

async function testPrimaryRetrySuccess() {
  const calls = [];
  const result = await runImageProviderFailover({
    requestId: "failover-primary-retry",
    primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
    backupConfig: providerConfig("lingyun", "gpt-image-2"),
    executeAttempt: async (attempt) => {
      calls.push(attempt);
      if (attempt.attempt === 1) {
        throw upstreamError("timeout", { retryable: true });
      }
      return { image: "primary-retry-result" };
    }
  });
  assert.strictEqual(result.value.image, "primary-retry-result");
  assert.strictEqual(result.providerRole, "primary");
  assert.strictEqual(result.providerAttempt, 2);
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1", "primary:2"]
  );
  assert.strictEqual(result.attempts.length, 2);
  assert.strictEqual(result.attempts[0].success, false);
  assert.strictEqual(result.attempts[0].retryable, true);
  assert.strictEqual(result.attempts[1].success, true);
}

async function testFallbackSuccess() {
  const calls = [];
  const result = await runImageProviderFailover({
    requestId: "failover-backup-success",
    primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
    backupConfig: providerConfig("lingyun", "gpt-image-2"),
    executeAttempt: async (attempt) => {
      calls.push(attempt);
      if (attempt.role === "primary") {
        throw upstreamError("upstream-unavailable", {
          status: 503,
          retryable: true
        });
      }
      return { image: "backup-result" };
    }
  });
  assert.strictEqual(result.value.image, "backup-result");
  assert.strictEqual(result.providerRole, "backup");
  assert.strictEqual(result.providerAttempt, 1);
  assert.strictEqual(result.provider, "lingyun");
  assert.strictEqual(result.model, "gpt-image-2");
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1", "primary:2", "backup:1"]
  );
}

async function testAuthenticationSkipsPrimaryRetry() {
  const calls = [];
  const result = await runImageProviderFailover({
    requestId: "failover-auth-backup",
    primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
    backupConfig: providerConfig("lingyun", "gpt-image-2"),
    executeAttempt: async (attempt) => {
      calls.push(attempt);
      if (attempt.role === "primary") {
        throw upstreamError("authentication-failed", {
          status: 403,
          retryable: false
        });
      }
      return { image: "backup-after-auth" };
    }
  });
  assert.strictEqual(result.value.image, "backup-after-auth");
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1", "backup:1"]
  );
}

async function testFatalPixelErrorStopsImmediately() {
  const calls = [];
  await assert.rejects(
    () => runImageProviderFailover({
      requestId: "failover-pixel-fatal",
      primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
      backupConfig: providerConfig("lingyun", "gpt-image-2"),
      executeAttempt: async (attempt) => {
        calls.push(attempt);
        throw upstreamError("PIXEL_IMAGE_SIZE_MISMATCH", {
          retryable: false
        });
      }
    }),
    (error) => (
      error
      && error.code === "PIXEL_IMAGE_SIZE_MISMATCH"
      && Array.isArray(error.providerAttempts)
      && error.providerAttempts.length === 1
    )
  );
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1"]
  );
}

async function testAllAttemptsFail() {
  const calls = [];
  await assert.rejects(
    () => runImageProviderFailover({
      requestId: "failover-exhausted",
      primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
      backupConfig: providerConfig("lingyun", "gpt-image-2"),
      executeAttempt: async (attempt) => {
        calls.push(attempt);
        throw upstreamError("timeout", { retryable: true });
      }
    }),
    (error) => (
      error
      && error.code === "IMAGE_PROVIDER_FAILOVER_EXHAUSTED"
      && error.retryable === true
      && Array.isArray(error.providerAttempts)
      && error.providerAttempts.length === 3
      && !JSON.stringify(error.providerAttempts).includes("test-key")
    )
  );
  assert.deepStrictEqual(
    calls.map((item) => `${item.role}:${item.attempt}`),
    ["primary:1", "primary:2", "backup:1"]
  );
}

async function testCallbacks() {
  const starts = [];
  const finishes = [];
  await runImageProviderFailover({
    requestId: "failover-callbacks",
    primaryConfig: providerConfig("xingju", "jw-gpt-image-2"),
    backupConfig: providerConfig("lingyun", "gpt-image-2"),
    onAttemptStart: async (attempt) => starts.push({
      role: attempt.role,
      attempt: attempt.attempt
    }),
    onAttemptFinish: async (summary) => finishes.push({
      role: summary.role,
      attempt: summary.attempt,
      success: summary.success
    }),
    executeAttempt: async () => ({ ok: true })
  });
  assert.deepStrictEqual(starts, [{ role: "primary", attempt: 1 }]);
  assert.deepStrictEqual(finishes, [{
    role: "primary",
    attempt: 1,
    success: true
  }]);
}

function testErrorClassification() {
  assert.deepStrictEqual(
    classifyImageProviderError(upstreamError("timeout", { retryable: true })),
    {
      category: "temporary",
      retryPrimary: true,
      fallbackAllowed: true,
      retryable: true
    }
  );
  assert.strictEqual(
    classifyImageProviderError(upstreamError("authentication-failed", {
      status: 401,
      retryable: false
    })).retryPrimary,
    false
  );
  assert.strictEqual(
    classifyImageProviderError(upstreamError("authentication-failed", {
      status: 401,
      retryable: false
    })).fallbackAllowed,
    true
  );
  assert.strictEqual(
    classifyImageProviderError(upstreamError("PIXEL_MODEL_FLOW_MODEL_MISMATCH", {
      retryable: false
    })).fallbackAllowed,
    false
  );
  assert.strictEqual(
    classifyImageProviderError(upstreamError("IMAGE_REQUEST_TOO_LARGE", {
      status: 413,
      retryable: false
    })).fallbackAllowed,
    false
  );
}

async function main() {
  await testAttemptPlan();
  await testPrimaryFirstAttemptSuccess();
  await testPrimaryRetrySuccess();
  await testFallbackSuccess();
  await testAuthenticationSkipsPrimaryRetry();
  await testFatalPixelErrorStopsImmediately();
  await testAllAttemptsFail();
  await testCallbacks();
  testErrorClassification();
  console.log("图片主备模型编排测试通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
