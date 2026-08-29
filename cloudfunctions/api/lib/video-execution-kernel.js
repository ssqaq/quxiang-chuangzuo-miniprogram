function missingDependency(name) {
  const error = new Error(`视频执行内核缺少依赖：${name}`);
  error.code = "video-kernel-dependency-missing";
  error.dependency = name;
  return error;
}

function requiredFunction(group, name) {
  const candidate = group && group[name];
  if (typeof candidate !== "function") throw missingDependency(name);
  return candidate;
}

function optionalFunction(group, name, fallback) {
  const candidate = group && group[name];
  return typeof candidate === "function" ? candidate : fallback;
}

function text(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function dateMs(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : new Date(date).getTime();
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function operationUpdatedAtMs(operation = {}) {
  return dateMs(
    operation.lastHeartbeatAt
    || operation.updatedAt
    || operation.processingAt
    || operation.createdAt
  );
}

function storedVideoResult(operation = {}) {
  const result = operation.result && typeof operation.result === "object"
    ? operation.result
    : {};
  const videoFileID = text(
    operation.videoFileID
    || operation.resultFileID
    || result.videoFileID
    || result.resultFileID,
    512
  );
  if (!videoFileID) return null;
  return Object.assign({}, result, {
    requestId: text(result.requestId || operation.requestId, 120),
    taskId: text(result.taskId || operation.providerTaskId, 160),
    status: "succeeded",
    providerStatus: text(
      result.providerStatus || operation.providerStatus || "succeeded",
      80
    ),
    provider: text(result.provider || operation.provider, 80),
    videoURL: text(result.videoURL || operation.videoURL, 4096),
    videoFileID,
    videoCloudPath: text(
      result.videoCloudPath || operation.videoCloudPath,
      1024
    ),
    videoBytes: Math.max(
      0,
      Number(result.videoBytes || operation.videoBytes) || 0
    )
  });
}

function providerFailure(normalized = {}) {
  const error = new Error(
    text(normalized.error || "视频任务失败。", 240)
    || "视频任务失败。"
  );
  error.code = normalized.status === "cancelled"
    ? "VIDEO_TASK_CANCELLED"
    : "VIDEO_TASK_FAILED";
  error.retryable = false;
  error.pipelineStage = "provider-failed";
  return error;
}

function normalizedProviderId(video = {}) {
  return text(video.provider, 80).toLowerCase();
}

// 新目录以稳定 providerKey 标识同一档案；旧运行时可能只有外部
// provider 字符串。两者都存在时优先 providerKey，只有缺 key 才回退到
// 外部 ID，避免改名后主/备被错误判成两家或同一家。
function sameVideoProvider(left = {}, right = {}) {
  const leftKey = text(left.providerKey, 160).toLowerCase();
  const rightKey = text(right.providerKey, 160).toLowerCase();
  if (leftKey && rightKey) return leftKey === rightKey;
  return normalizedProviderId(left) === normalizedProviderId(right);
}

function videoProviderCandidates(configs = {}) {
  const primary = configs.video && typeof configs.video === "object"
    ? configs.video
    : {};
  const backup = configs.videoBackup && typeof configs.videoBackup === "object"
    ? configs.videoBackup
    : {};
  const candidates = [];
  if (primary.configured) candidates.push({ role: "primary", video: primary });
  if (
    backup.configured
    && normalizedProviderId(backup)
    && !sameVideoProvider(primary, backup)
  ) {
    candidates.push({ role: "backup", video: backup });
  }
  return candidates;
}

function shouldUseBackupProvider(error) {
  const status = Number(error && (error.status || error.statusCode)) || 0;
  if (status === 403 || status === 408 || status === 429 || status >= 500) {
    return true;
  }
  if (error && error.retryable) return true;
  return /(?:timeout|timed out|network|socket|econn|enotfound|超时|网络|连接)/i.test(
    String(error && error.message || "")
  );
}

function videoConfigForOperation(configs = {}, operation = {}) {
  const requestedProvider = normalizedProviderId(operation);
  const candidates = videoProviderCandidates(configs);
  if (requestedProvider) {
    const matched = candidates.find(
      (candidate) => normalizedProviderId(candidate.video) === requestedProvider
    );
    return matched ? matched.video : {};
  }
  return configs.video && typeof configs.video === "object"
    ? configs.video
    : {};
}

function createVideoExecutionKernel(services = {}) {
  const identity = services.identity || {};
  const config = services.config || {};
  const billing = services.billing || {};
  const operations = services.operations || {};
  const source = services.source || {};
  const provider = services.provider || {};
  const files = services.files || {};
  const response = services.response || {};
  const serialization = services.serialization || {};
  const recovery = services.recovery || {};

  const getOpenId = requiredFunction(identity, "getOpenId");
  const resolveConfig = requiredFunction(config, "resolve");
  const reserveUsage = requiredFunction(billing, "reserve");
  const refundUsage = requiredFunction(billing, "refund");
  const publicBilling = optionalFunction(billing, "publicView", (value) => value || null);
  const findOperation = requiredFunction(operations, "find");
  const claimOperation = requiredFunction(operations, "claim");
  const updateOperation = requiredFunction(operations, "update");
  const completeOperation = requiredFunction(operations, "complete");
  const failOperation = requiredFunction(operations, "fail");
  const operationStateError = requiredFunction(operations, "stateError");
  const prepareSource = requiredFunction(source, "prepare");
  const buildProviderPayload = requiredFunction(provider, "buildPayload");
  const createProviderTask = requiredFunction(provider, "create");
  const queryProviderTask = requiredFunction(provider, "query");
  const materializeVideo = requiredFunction(files, "materialize");
  const deleteFile = requiredFunction(files, "delete");
  const okResponse = requiredFunction(response, "ok");
  const failResponse = requiredFunction(response, "fail");
  const sanitizeError = requiredFunction(serialization, "sanitizeError");
  const log = optionalFunction(services, "log", () => {});
  const now = optionalFunction(services, "now", () => new Date());

  const reservedStaleMs = Math.max(
    60 * 1000,
    Number(recovery.reservedStaleMs) || 5 * 60 * 1000
  );
  const processingStaleMs = Math.max(
    60 * 1000,
    Number(recovery.processingStaleMs) || 10 * 60 * 1000
  );
  const maxRecoveryAttempts = Math.max(
    1,
    Math.min(10, Number(recovery.maxAttempts) || 2)
  );

  function operationResult(operation, video, billingValue, deduplicated) {
    const result = operation && operation.result && typeof operation.result === "object"
      ? operation.result
      : {};
    return Object.assign({}, result, {
      requestId: text(
        result.requestId || operation && operation.requestId,
        120
      ),
      taskId: text(
        result.taskId || operation && operation.providerTaskId,
        160
      ),
      status: text(
        result.status || (
          operation && operation.status === "succeeded"
            ? "succeeded"
            : "processing"
        ),
        40
      ),
      providerStatus: text(
        result.providerStatus
        || operation && operation.providerStatus
        || "processing",
        80
      ),
      provider: text(
        result.provider
        || operation && operation.provider
        || video && video.provider,
        80
      ),
      deduplicated: Boolean(deduplicated),
      billing: publicBilling(billingValue || operation && operation.billing)
    });
  }

  async function markRefundPending(openid, requestId, error) {
    try {
      await updateOperation(openid, requestId, {
        status: "refunding",
        pipelineStage: "refunding",
        progress: 0,
        refundPending: true,
        refundLastError: sanitizeError(error && error.message || "退款失败。"),
        refundLastAttemptAt: now(),
        lastHeartbeatAt: now()
      }, {
        allowedStatuses: ["failed", "refunding"],
        enforceState: true,
        actor: "billing",
        historyStage: "refunding",
        historyCode: text(error && error.code || "video-refund-failed", 80)
      });
    } catch (updateError) {
      log("error", "video.refund-state-write-failed", {
        requestId,
        errorCode: text(updateError && updateError.code, 80),
        error: sanitizeError(updateError && updateError.message)
      });
    }
  }

  async function refundFailedOperation(openid, requestId, reason) {
    try {
      const refunded = await refundUsage(openid, requestId, reason);
      return {
        refunded: Boolean(refunded && !refunded.skipped),
        duplicate: Boolean(refunded && refunded.duplicate),
        skipped: Boolean(refunded && refunded.skipped)
      };
    } catch (error) {
      await markRefundPending(openid, requestId, error);
      return {
        refunded: false,
        pending: true,
        errorCode: text(error && error.code || "video-refund-failed", 80),
        error: sanitizeError(error && error.message || "退款失败。")
      };
    }
  }

  async function cleanupOperationFiles(operation = {}) {
    const requestId = text(operation.requestId, 120);
    const openid = text(operation.openid, 160);
    const result = operation.result && typeof operation.result === "object"
      ? operation.result
      : {};
    const fileIDs = Array.from(new Set([
      operation.videoFileID,
      operation.resultFileID,
      result.videoFileID,
      result.resultFileID,
      operation.sourceImageFileID,
      result.sourceImageFileID
    ].map((value) => text(value, 512)).filter(Boolean)));
    const failures = [];
    for (const fileID of fileIDs) {
      try {
        await deleteFile(fileID);
      } catch (error) {
        failures.push({
          fileID,
          errorCode: text(error && error.code || "video-cleanup-failed", 80),
          error: sanitizeError(error && error.message || "文件清理失败。")
        });
      }
    }
    if (openid && requestId) {
      const cleanupPatch = {
        cleanupPending: failures.length > 0,
        cleanupAttemptCount: (Number(operation.cleanupAttemptCount) || 0) + 1,
        cleanupLastAttemptAt: now(),
        cleanupLastError: failures.length ? failures[0].error : "",
        lastHeartbeatAt: now()
      };
      if (!failures.length) {
        cleanupPatch.videoFileID = "";
        cleanupPatch.resultFileID = "";
        cleanupPatch.videoCloudPath = "";
        cleanupPatch.sourceImageFileID = "";
        cleanupPatch.sourceCloudPath = "";
        cleanupPatch.result = Object.assign({}, result, {
          videoFileID: "",
          resultFileID: "",
          videoCloudPath: "",
          sourceImageFileID: ""
        });
      }
      await updateOperation(openid, requestId, cleanupPatch, {
        allowedStatuses: [
          "processing",
          "succeeded",
          "failed",
          "refunding",
          "refunded"
        ],
        allowRefunded: true,
        enforceState: true,
        actor: "reconcile",
        historyStage: failures.length ? "cleanup-pending" : "cleanup-completed",
        historyCode: failures.length ? failures[0].errorCode : "cleanup-completed"
      });
    }
    return {
      cleaned: failures.length === 0,
      attempted: fileIDs.length,
      failures
    };
  }

  async function materializeAndComplete({
    openid,
    requestId,
    taskId,
    operation,
    normalized,
    video
  }) {
    let stored = storedVideoResult(operation);
    if (!stored) {
      if (!normalized.videoURL) {
        return {
          response: failResponse(
            "视频任务已完成，但服务没有返回视频地址。",
            "VIDEO_RESULT_URL_MISSING",
            {
              taskId,
              provider: video.provider,
              providerStatus: normalized.providerStatus,
              retryable: false
            }
          ),
          action: "video-result-missing"
        };
      }
      const materialized = await materializeVideo({
        openid,
        requestId,
        taskId,
        videoURL: normalized.videoURL
      });
      const partialResult = Object.assign(
        {},
        operation && operation.result || {},
        normalized,
        materialized,
        {
          taskId,
          requestId,
          provider: video.provider
        }
      );
      operation = await updateOperation(openid, requestId, {
        status: operation && operation.status === "succeeded"
          ? "succeeded"
          : "processing",
        pipelineStage: "record",
        progress: 95,
        providerTaskId: taskId,
        providerStatus: normalized.providerStatus,
        videoURL: normalized.videoURL,
        videoFileID: materialized.videoFileID,
        videoCloudPath: materialized.videoCloudPath,
        videoBytes: materialized.videoBytes,
        result: partialResult,
        reconcilePending: true,
        cleanupPending: false,
        lastHeartbeatAt: now()
      }, {
        allowedStatuses: ["processing", "succeeded"],
        enforceState: true,
        actor: "worker",
        historyStage: "record",
        historyCode: "video-result-materialized"
      }) || Object.assign({}, operation || {}, partialResult);
      stored = Object.assign({}, partialResult);
    }

    const completedResult = Object.assign({}, stored, normalized, {
      taskId,
      requestId,
      provider: video.provider,
      status: "succeeded"
    });
    await completeOperation(openid, requestId, completedResult, {
      enforceState: true,
      actor: "worker"
    });
    return {
      response: okResponse(completedResult),
      action: "video-result-completed",
      result: completedResult
    };
  }

  async function processProviderQuery({
    openid,
    requestId,
    taskId,
    operation,
    configs,
    video,
    actor = "client"
  }) {
    const normalized = await queryProviderTask({
      openid,
      requestId,
      taskId,
      configs,
      video
    });
    if (normalized.status === "processing") {
      if (operation) {
        await updateOperation(openid, requestId, {
          status: "processing",
          pipelineStage: "provider-processing",
          progress: Math.max(30, Math.min(90, Number(operation.progress) || 50)),
          providerTaskId: taskId,
          providerStatus: normalized.providerStatus,
          reconcilePending: false,
          lastHeartbeatAt: now(),
          lastError: null
        }, {
          allowedStatuses: ["processing"],
          enforceState: true,
          actor,
          historyStage: "provider-processing",
          historyCode: text(normalized.providerStatus, 80)
        });
      }
      return {
        response: okResponse(Object.assign({}, normalized, {
          requestId,
          taskId,
          provider: video.provider
        })),
        action: "video-provider-processing"
      };
    }

    if (["failed", "cancelled"].includes(normalized.status)) {
      if (operation) {
        const failure = providerFailure(normalized);
        await failOperation(openid, requestId, failure, {
          providerTaskId: taskId,
          providerStatus: normalized.providerStatus,
          result: Object.assign({}, normalized, {
            taskId,
            requestId,
            provider: video.provider
          }),
          refundPending: true,
          reconcilePending: false
        }, {
          enforceState: true,
          actor,
          historyStage: "provider-failed",
          historyCode: failure.code
        });
        await refundFailedOperation(
          openid,
          requestId,
          "视频任务失败，已退回本次使用额度"
        );
      }
      return {
        response: okResponse(Object.assign({}, normalized, {
          requestId,
          taskId,
          provider: video.provider
        })),
        action: "video-provider-failed"
      };
    }

    if (normalized.status === "succeeded" && operation) {
      return materializeAndComplete({
        openid,
        requestId,
        taskId,
        operation,
        normalized,
        video
      });
    }
    if (
      normalized.status === "succeeded"
      && !normalized.videoURL
      && !normalized.videoFileID
    ) {
      return {
        response: failResponse(
          "视频任务已完成，但服务没有返回视频地址。",
          "VIDEO_RESULT_URL_MISSING",
          {
            taskId,
            provider: video.provider,
            providerStatus: normalized.providerStatus,
            retryable: false
          }
        ),
        action: "video-result-missing"
      };
    }
    return {
      response: okResponse(Object.assign({}, normalized, {
        requestId,
        taskId,
        provider: video.provider
      })),
      action: "video-provider-succeeded"
    };
  }

  async function createVideoTask(event = {}, context = {}) {
    const configs = await resolveConfig();
    const providerCandidates = videoProviderCandidates(configs);
    const primaryVideo = configs.video && typeof configs.video === "object"
      ? configs.video
      : {};
    const initialCandidate = providerCandidates[0] || null;
    const video = initialCandidate && initialCandidate.video || {};
    if (!providerCandidates.length) {
      return failResponse(
        "视频服务未配置，请联系管理员配置 AI_VIDEO_PROVIDER、AI_VIDEO_BASE_URL、AI_VIDEO_MODEL 和 AI_VIDEO_API_KEY。",
        "VIDEO_PROVIDER_NOT_CONFIGURED"
      );
    }
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload
      : {};
    if (!payload.imageFileID) {
      return failResponse(
        "缺少视频源图片，请重新选择照片。",
        "VIDEO_SOURCE_IMAGE_MISSING"
      );
    }
    const requestId = text(event.requestId, 120);
    if (!requestId) {
      return failResponse("缺少视频请求编号。", "VIDEO_REQUEST_ID_MISSING");
    }
    const openid = getOpenId(context);
    let billingValue = null;
    let claimed = false;
    let providerAccepted = false;
    let prepared = null;
    try {
      billingValue = await reserveUsage(openid, requestId, "video");
      const claim = billingValue && billingValue.untracked
        ? { claimed: true, operation: null, completed: false }
        : await claimOperation(openid, requestId, "video");
      if (claim.completed && claim.operation && claim.operation.result) {
        return okResponse(operationResult(
          claim.operation,
          video,
          billingValue,
          true
        ));
      }
      if (!claim.claimed) {
        if (claim.operation && claim.operation.providerTaskId) {
          return okResponse(operationResult(
            claim.operation,
            video,
            billingValue,
            true
          ));
        }
        throw operationStateError(claim.operation);
      }
      claimed = true;
      prepared = await prepareSource(payload.imageFileID, {
        openid,
        requestId,
        action: "video.create"
      });
      let activeVideo = video;
      let activeProviderRole = initialCandidate && initialCandidate.role || "primary";
      let requestPayload = null;
      let normalized = null;
      let primaryCreateError = null;
      for (let index = 0; index < providerCandidates.length; index += 1) {
        const candidate = providerCandidates[index];
        activeVideo = candidate.video;
        activeProviderRole = candidate.role;
        requestPayload = buildProviderPayload(
          payload,
          prepared.buffer,
          activeVideo
        );
        if (!(billingValue && billingValue.untracked)) {
          await updateOperation(openid, requestId, {
            kind: "video",
            workflow: "video-generation-v2",
            status: "processing",
            pipelineStage: candidate.role === "backup"
              ? "provider-create-backup"
              : "provider-create",
            progress: candidate.role === "backup" ? 28 : 25,
            sourceOriginalFileID: text(
              prepared.sourceOriginalFileID || payload.imageFileID,
              512
            ),
            sourceImageFileID: text(prepared.sourceImageFileID, 512),
            sourceCloudPath: text(prepared.sourceCloudPath, 1024),
            sourceImageWidth: Math.max(
              0,
              Number(prepared.width || prepared.sourceImageWidth) || 0
            ),
            sourceImageHeight: Math.max(
              0,
              Number(prepared.height || prepared.sourceImageHeight) || 0
            ),
            sourceImageBytes: Math.max(
              0,
              Number(prepared.bytes || prepared.sourceImageBytes) || 0
            ),
            provider: text(activeVideo.provider, 80),
            providerRole: candidate.role,
            providerFallbackUsed: candidate.role === "backup",
            providerFallbackFrom: candidate.role === "backup"
              ? text(primaryVideo.provider, 80)
              : "",
            model: text(requestPayload.model || activeVideo.model, 160),
            resolution: text(
              requestPayload.resolution || activeVideo.resolution,
              32
            ),
            lastHeartbeatAt: now(),
            reconcilePending: false,
            cleanupPending: false,
            lastError: candidate.role === "backup" && primaryCreateError
              ? {
                  code: text(primaryCreateError.code || "video-primary-failed", 80),
                  message: sanitizeError(primaryCreateError.message),
                  retryable: Boolean(primaryCreateError.retryable)
                }
              : null
          }, {
            allowedStatuses: ["processing"],
            enforceState: true,
            actor: "client",
            historyStage: candidate.role === "backup"
              ? "provider-create-backup"
              : "provider-create",
            historyCode: candidate.role === "backup"
              ? "video-provider-fallback"
              : ""
          });
        }
        log("info", "video.create.start", {
          requestId,
          provider: text(activeVideo.provider, 80),
          providerRole: candidate.role,
          model: text(requestPayload.model || activeVideo.model, 160),
          resolution: text(
            requestPayload.resolution || activeVideo.resolution,
            32
          ),
          duration: Math.max(0, Number(requestPayload.duration) || 0),
          imageBytes: Math.max(
            0,
            Number(prepared.bytes || prepared.sourceImageBytes) || 0
          ),
          imageWidth: Math.max(
            0,
            Number(prepared.width || prepared.sourceImageWidth) || 0
          ),
          imageHeight: Math.max(
            0,
            Number(prepared.height || prepared.sourceImageHeight) || 0
          )
        });
        try {
          normalized = await createProviderTask({
            openid,
            requestId,
            configs,
            video: activeVideo,
            requestPayload
          });
          break;
        } catch (error) {
          const canFallback = candidate.role === "primary"
            && providerCandidates.length > 1
            && shouldUseBackupProvider(error);
          if (!canFallback) throw error;
          primaryCreateError = error;
          log("warn", "video.create.fallback", {
            requestId,
            fromProvider: text(activeVideo.provider, 80),
            toProvider: text(providerCandidates[1].video.provider, 80),
            status: Number(error && error.status) || 0,
            errorCode: text(error && error.code || "video-primary-failed", 80),
            error: sanitizeError(error && error.message)
          });
        }
      }
      if (!normalized) throw primaryCreateError || new Error("视频服务没有接收任务。");
      providerAccepted = true;
      const result = Object.assign({}, normalized, {
        requestId,
        provider: activeVideo.provider,
        providerRole: activeProviderRole,
        providerFallbackUsed: activeProviderRole === "backup",
        model: requestPayload.model,
        resolution: requestPayload.resolution || "",
        sourceImageFileID: prepared.sourceImageFileID,
        sourceImageWidth: Math.max(
          0,
          Number(prepared.width || prepared.sourceImageWidth) || 0
        ),
        sourceImageHeight: Math.max(
          0,
          Number(prepared.height || prepared.sourceImageHeight) || 0
        ),
        sourceImageBytes: Math.max(
          0,
          Number(prepared.bytes || prepared.sourceImageBytes) || 0
        ),
        billing: publicBilling(billingValue)
      });
      let currentOperation = claim.operation || null;
      if (!(billingValue && billingValue.untracked)) {
        currentOperation = await updateOperation(openid, requestId, {
          status: "processing",
          pipelineStage: normalized.status === "succeeded"
            ? "provider-succeeded"
            : "provider-processing",
          progress: normalized.status === "succeeded" ? 90 : 35,
          providerTaskId: normalized.taskId,
          providerStatus: normalized.providerStatus,
          provider: activeVideo.provider,
          providerRole: activeProviderRole,
          providerFallbackUsed: activeProviderRole === "backup",
          providerFallbackFrom: activeProviderRole === "backup"
            ? text(primaryVideo.provider, 80)
            : "",
          model: requestPayload.model,
          resolution: requestPayload.resolution || "",
          result: Object.assign({}, result, { billing: null }),
          providerCreatedAt: now(),
          lastHeartbeatAt: now(),
          reconcilePending: normalized.status === "succeeded",
          lastError: null
        }, {
          allowedStatuses: ["processing"],
          enforceState: true,
          actor: "client",
          historyStage: normalized.status === "succeeded"
            ? "provider-succeeded"
            : "provider-processing",
          historyCode: text(normalized.providerStatus, 80)
        });
      }
      log("info", "video.create.finish", {
        requestId,
        provider: text(activeVideo.provider, 80),
        taskId: text(normalized.taskId, 160),
        providerStatus: text(normalized.providerStatus, 80)
      });
      if (
        normalized.status === "succeeded"
        && normalized.videoURL
        && !(billingValue && billingValue.untracked)
      ) {
        const completed = await materializeAndComplete({
          openid,
          requestId,
          taskId: normalized.taskId,
          operation: currentOperation,
          normalized,
          video: activeVideo
        });
        if (completed.response && completed.response.ok !== false) {
          return Object.assign({}, completed.response, {
            billing: publicBilling(billingValue)
          });
        }
        return completed.response;
      }
      return okResponse(result);
    } catch (error) {
      if (
        claimed
        && billingValue
        && !billingValue.untracked
        && !providerAccepted
      ) {
        await failOperation(openid, requestId, error, {
          sourceImageFileID: text(prepared && prepared.sourceImageFileID, 512),
          sourceCloudPath: text(prepared && prepared.sourceCloudPath, 1024),
          cleanupPending: Boolean(prepared && prepared.sourceImageFileID),
          refundPending: true,
          reconcilePending: false
        }, {
          enforceState: true,
          actor: "client",
          historyStage: "create-failed",
          historyCode: text(error && error.code || "video-create-failed", 80)
        });
        await refundFailedOperation(
          openid,
          requestId,
          "视频任务创建失败，已退回本次使用额度"
        );
      }
      throw error;
    }
  }

  async function queryVideoTask(event = {}, context = {}) {
    const configs = await resolveConfig();
    const openid = getOpenId(context);
    const taskId = text(event.taskId, 160);
    if (!taskId) {
      return failResponse("缺少视频任务编号。", "VIDEO_TASK_ID_MISSING");
    }
    const requestId = text(event.requestId, 120);
    const operation = openid !== "anonymous" && requestId
      ? await findOperation(openid, requestId)
      : null;
    const video = videoConfigForOperation(configs, operation || {});
    if (!video.configured) {
      return failResponse(
        "原视频服务配置已失效，暂时无法查询这个任务。",
        "VIDEO_PROVIDER_NOT_CONFIGURED"
      );
    }
    if (operation) {
      if (String(operation.kind || "") !== "video") {
        return failResponse(
          "这次请求不是照片转视频任务。",
          "VIDEO_OPERATION_KIND_MISMATCH"
        );
      }
      if (["refunding", "refunded"].includes(String(operation.status || ""))) {
        throw operationStateError(operation);
      }
      if (
        operation.providerTaskId
        && String(operation.providerTaskId) !== taskId
      ) {
        return failResponse(
          "视频任务编号与原请求不匹配。",
          "VIDEO_TASK_OWNERSHIP_MISMATCH"
        );
      }
      const stored = storedVideoResult(operation);
      if (stored && operation.status === "succeeded") {
        return okResponse(Object.assign({}, stored, {
          requestId,
          taskId,
          provider: text(operation.provider || video.provider, 80),
          deduplicated: true
        }));
      }
    } else if (openid !== "anonymous" && requestId) {
      return failResponse(
        "找不到这次视频生成请求。",
        "VIDEO_OPERATION_NOT_FOUND"
      );
    }
    const processed = await processProviderQuery({
      openid,
      requestId,
      taskId,
      operation,
      configs,
      video,
      actor: "client"
    });
    return processed.response;
  }

  async function reconcileVideoOperation(operation = {}, runtime = {}) {
    const sourceOperation = operation && typeof operation === "object"
      ? operation
      : {};
    const openid = text(sourceOperation.openid, 160);
    const requestId = text(sourceOperation.requestId, 120);
    if (
      !openid
      || !requestId
      || String(sourceOperation.kind || "") !== "video"
    ) {
      return { action: "skip-invalid", requestId };
    }
    const currentTime = runtime.now instanceof Date
      ? runtime.now
      : new Date(runtime.now || now());
    const status = text(sourceOperation.status, 40);
    const taskId = text(sourceOperation.providerTaskId, 160);
    const ageMs = Math.max(
      0,
      currentTime.getTime() - operationUpdatedAtMs(sourceOperation)
    );
    const stored = storedVideoResult(sourceOperation);

    if (
      status === "refunded"
      && (
        sourceOperation.cleanupPending
        || stored
        || sourceOperation.sourceImageFileID
      )
    ) {
      const cleanup = await cleanupOperationFiles(sourceOperation);
      return {
        action: cleanup.cleaned
          ? "video-cleanup-completed"
          : "video-cleanup-pending",
        requestId,
        cleanup
      };
    }

    if (
      ["failed", "refunding"].includes(status)
      || sourceOperation.refundPending
    ) {
      const refund = await refundFailedOperation(
        openid,
        requestId,
        "视频任务失败，继续退回本次使用额度"
      );
      return {
        action: "video-refund-retried",
        requestId,
        refund
      };
    }

    if (stored && status !== "succeeded") {
      const result = Object.assign({}, stored, {
        requestId,
        taskId: taskId || stored.taskId,
        provider: stored.provider || sourceOperation.provider,
        status: "succeeded"
      });
      await completeOperation(openid, requestId, result, {
        enforceState: true,
        actor: "reconcile"
      });
      return {
        action: "video-result-rebuilt",
        requestId,
        taskId: result.taskId,
        videoFileID: result.videoFileID
      };
    }

    if (status === "succeeded" && stored) {
      return { action: "skip-succeeded", requestId };
    }

    if (
      status === "reserved"
      && ageMs >= reservedStaleMs
      && !taskId
    ) {
      const error = new Error("视频任务预留后没有成功创建上游任务，已自动退款。");
      error.code = "video-reservation-stale";
      error.retryable = false;
      await failOperation(openid, requestId, error, {
        refundPending: true,
        cleanupPending: Boolean(sourceOperation.sourceImageFileID)
      }, {
        enforceState: true,
        actor: "reconcile",
        historyStage: "reservation-stale",
        historyCode: error.code
      });
      const refund = await refundFailedOperation(
        openid,
        requestId,
        "视频任务预留超时，已退回本次使用额度"
      );
      if (sourceOperation.sourceImageFileID) {
        await cleanupOperationFiles(Object.assign({}, sourceOperation, {
          status: refund.refunded ? "refunded" : "refunding",
          cleanupPending: true
        }));
      }
      return { action: "video-reserved-refund", requestId, refund };
    }

    if (
      ["processing", "succeeded"].includes(status)
      && taskId
      && (
        sourceOperation.reconcilePending
        || ageMs >= processingStaleMs
        || status === "succeeded"
      )
    ) {
      const attemptCount = Math.max(
        0,
        Number(sourceOperation.recoveryAttemptCount) || 0
      );
      if (attemptCount >= maxRecoveryAttempts) {
        const error = new Error("视频任务多次恢复失败，已停止并退款。");
        error.code = "video-recovery-exhausted";
        error.retryable = false;
        await failOperation(openid, requestId, error, {
          refundPending: true,
          cleanupPending: Boolean(stored)
        }, {
          enforceState: true,
          actor: "reconcile",
          historyStage: "recovery-exhausted",
          historyCode: error.code
        });
        const refund = await refundFailedOperation(
          openid,
          requestId,
          "视频任务恢复失败，已退回本次使用额度"
        );
        return {
          action: "video-recovery-refund",
          requestId,
          refund
        };
      }
      await updateOperation(openid, requestId, {
        recoveryAttemptCount: attemptCount + 1,
        reconcileLastAttemptAt: currentTime,
        lastHeartbeatAt: currentTime,
        reconcilePending: true
      }, {
        allowedStatuses: ["processing", "succeeded"],
        enforceState: true,
        actor: "reconcile",
        historyStage: "provider-recovery",
        historyCode: "video-provider-query"
      });
      const configs = await resolveConfig();
      const video = videoConfigForOperation(configs, sourceOperation);
      const processed = await processProviderQuery({
        openid,
        requestId,
        taskId,
        operation: sourceOperation,
        configs,
        video,
        actor: "reconcile"
      });
      return Object.assign({
        action: processed.action,
        requestId,
        taskId
      }, processed.result ? { result: processed.result } : {});
    }

    if (
      status === "processing"
      && !taskId
      && ageMs >= processingStaleMs
    ) {
      const error = new Error("视频任务创建上游任务超时，已自动退款。");
      error.code = "video-provider-create-timeout";
      error.retryable = false;
      await failOperation(openid, requestId, error, {
        refundPending: true,
        cleanupPending: Boolean(sourceOperation.sourceImageFileID)
      }, {
        enforceState: true,
        actor: "reconcile",
        historyStage: "provider-create-timeout",
        historyCode: error.code
      });
      const refund = await refundFailedOperation(
        openid,
        requestId,
        "视频任务创建超时，已退回本次使用额度"
      );
      return {
        action: "video-processing-refund",
        requestId,
        refund
      };
    }

    return { action: "skip-fresh", requestId };
  }

  return Object.freeze({
    createVideoTask,
    queryVideoTask,
    reconcileVideoOperation
  });
}

module.exports = {
  createVideoExecutionKernel,
  storedVideoResult
};
