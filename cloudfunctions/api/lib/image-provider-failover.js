const TEMPORARY_HTTP_STATUSES = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504
]);

const FATAL_ERROR_CODES = new Set([
  "missing-edit-asset",
  "image-edit-endpoint-invalid",
  "image-edit-model-unsupported",
  "image-edit-unsupported",
  "empty-image-result",
  "IMAGE_ASSET_TOO_LARGE",
  "IMAGE_ASSET_TOTAL_TOO_LARGE",
  "IMAGE_REQUEST_TOO_LARGE",
  "UPSTREAM_RESPONSE_TOO_LARGE",
  "TENCENT_PIPELINE_MASK_REQUIRED",
  "TENCENT_PIPELINE_MASK_INVALID",
  "TENCENT_PIPELINE_FACE_NOT_FOUND"
]);

function compactText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, Number(maxLength) || 240));
}

function normalizedCode(error) {
  return compactText(error && error.code || "", 80);
}

function normalizedStatus(error) {
  const status = Number(error && error.status) || 0;
  return status > 0 ? status : 0;
}

function isFatalSharedInputError(code) {
  return (
    FATAL_ERROR_CODES.has(code)
    || /^PIXEL_/i.test(code)
    || /^IMAGE_(?:DECODE|ENCODE|SIZE|FORMAT|MASK|ASSET)_/i.test(code)
    || /(?:ASSET|MASK|IMAGE)_(?:MISSING|INVALID|UNSUPPORTED|TOO_LARGE)$/i.test(code)
  );
}

function classifyImageProviderError(error) {
  const code = normalizedCode(error);
  const status = normalizedStatus(error);
  const message = compactText(error && error.message, 300).toLowerCase();

  if (isFatalSharedInputError(code)) {
    return {
      category: "fatal",
      retryPrimary: false,
      fallbackAllowed: false,
      retryable: false
    };
  }

  if (
    status === 401
    || status === 403
    || /^(?:authentication-failed|missing-api-key|invalid-api-key)$/i.test(code)
  ) {
    return {
      category: "provider-auth",
      retryPrimary: false,
      fallbackAllowed: true,
      retryable: false
    };
  }

  const temporary = (
    TEMPORARY_HTTP_STATUSES.has(status)
    || error && error.retryable === true
    || /timeout|timed out|deadline|socket hang up|econnreset|econnrefused|enotfound|network/i
      .test(`${code} ${message}`)
    || /rate.?limit|too many requests|busy|temporar|unavailable|限流|频繁|繁忙|超时/
      .test(`${code} ${message}`)
  );
  if (temporary) {
    return {
      category: "temporary",
      retryPrimary: true,
      fallbackAllowed: true,
      retryable: true
    };
  }

  if (
    status >= 400
    && status < 500
  ) {
    return {
      category: "request-invalid",
      retryPrimary: false,
      fallbackAllowed: false,
      retryable: false
    };
  }

  return {
    category: "provider-error",
    retryPrimary: false,
    fallbackAllowed: true,
    retryable: Boolean(error && error.retryable)
  };
}

function normalizedConfig(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  return Object.assign({}, source, {
    provider: compactText(source.provider, 80),
    model: compactText(source.model, 120),
    timeoutMs: Math.max(1000, Number(source.timeoutMs) || 150000)
  });
}

function buildImageProviderAttemptPlan(primaryConfig, backupConfig) {
  const primary = normalizedConfig(primaryConfig);
  const backup = normalizedConfig(backupConfig);
  const plan = [
    { role: "primary", attempt: 1, config: primary },
    { role: "primary", attempt: 2, config: primary }
  ];
  // 新配置显式关闭备用时不再发起备用请求；旧调用方没有 enabled 字段时
  // 保持原有行为，避免破坏历史任务和现有 smoke。
  if (!(Object.prototype.hasOwnProperty.call(backup, "enabled") && backup.enabled === false)) {
    plan.push({ role: "backup", attempt: 1, config: backup });
  }
  return plan;
}

function safeAttemptSummary(attempt, patch = {}) {
  const source = attempt && typeof attempt === "object" ? attempt : {};
  const config = source.config && typeof source.config === "object"
    ? source.config
    : {};
  return Object.assign({
    role: source.role === "backup" ? "backup" : "primary",
    attempt: Math.max(1, Number(source.attempt) || 1),
    provider: compactText(config.provider, 80),
    model: compactText(config.model, 120),
    timeoutMs: Math.max(1000, Number(config.timeoutMs) || 150000),
    success: false,
    status: 0,
    code: "",
    category: "",
    retryable: false,
    durationMs: 0
  }, patch);
}

function failoverError(lastError, summaries) {
  const message = summaries.length
    ? "主模型与备用模型均未成功返回图片。"
    : "没有可用的图片模型配置。";
  const error = new Error(message);
  error.code = "IMAGE_PROVIDER_FAILOVER_EXHAUSTED";
  error.retryable = summaries.some((item) => item.retryable);
  error.status = normalizedStatus(lastError);
  error.cause = lastError || null;
  error.providerAttempts = summaries;
  return error;
}

async function runImageProviderFailover(options = {}) {
  if (typeof options.executeAttempt !== "function") {
    const error = new Error("图片主备编排缺少 executeAttempt。");
    error.code = "IMAGE_PROVIDER_EXECUTOR_MISSING";
    error.retryable = false;
    throw error;
  }

  const requestId = compactText(options.requestId, 160);
  const plan = buildImageProviderAttemptPlan(
    options.primaryConfig,
    options.backupConfig
  );
  const summaries = [];
  let lastError = null;
  let skipRemainingPrimary = false;

  for (const planItem of plan) {
    if (planItem.role === "primary" && skipRemainingPrimary) continue;

    const startedAt = Date.now();
    const attemptContext = {
      role: planItem.role,
      attempt: planItem.attempt,
      config: planItem.config,
      requestId,
      idempotencyKey: `${requestId}:${planItem.role}:${planItem.attempt}`
    };

    if (typeof options.onAttemptStart === "function") {
      await options.onAttemptStart(attemptContext);
    }

    try {
      const value = await options.executeAttempt(attemptContext);
      const summary = safeAttemptSummary(planItem, {
        success: true,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
      summaries.push(summary);
      if (typeof options.onAttemptFinish === "function") {
        await options.onAttemptFinish(summary, attemptContext);
      }
      return {
        value,
        providerRole: planItem.role,
        providerAttempt: planItem.attempt,
        provider: planItem.config.provider,
        model: planItem.config.model,
        attempts: summaries
      };
    } catch (error) {
      lastError = error;
      const classification = classifyImageProviderError(error);
      const summary = safeAttemptSummary(planItem, {
        success: false,
        status: normalizedStatus(error),
        code: normalizedCode(error) || "provider-error",
        category: classification.category,
        retryable: classification.retryable,
        durationMs: Math.max(0, Date.now() - startedAt),
        message: compactText(error && error.message, 240)
      });
      summaries.push(summary);
      if (typeof options.onAttemptFinish === "function") {
        await options.onAttemptFinish(summary, attemptContext);
      }

      if (!classification.fallbackAllowed) {
        error.providerAttempts = summaries;
        throw error;
      }

      if (planItem.role === "primary") {
        const canRetryPrimary = (
          classification.retryPrimary
          && planItem.attempt < 2
        );
        if (!canRetryPrimary) skipRemainingPrimary = true;
        continue;
      }
    }
  }

  throw failoverError(lastError, summaries);
}

module.exports = {
  buildImageProviderAttemptPlan,
  classifyImageProviderError,
  runImageProviderFailover,
  safeAttemptSummary
};
