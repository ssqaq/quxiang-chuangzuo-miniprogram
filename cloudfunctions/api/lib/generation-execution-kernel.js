function missingDependency(name) {
  const error = new Error(`生图执行内核缺少依赖：${name}`);
  error.code = "generation-kernel-dependency-missing";
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

function createGenerationExecutionKernel(services = {}) {
  const access = services.access || {};
  const identity = services.identity || {};
  const config = services.config || {};
  const image = services.image || {};
  const records = services.records || {};
  const assets = services.assets || {};
  const billing = services.billing || {};
  const operations = services.operations || {};
  const queue = services.queue || {};
  const results = services.results || {};
  const files = services.files || {};
  const response = services.response || {};
  const serialization = services.serialization || {};

  const isAdmin = requiredFunction(access, "isAdmin");
  const forbidden = requiredFunction(access, "forbidden");
  const getOpenId = requiredFunction(identity, "getOpenId");
  const resolveConfig = requiredFunction(config, "resolve");
  const hasEditAssets = requiredFunction(image, "hasEditAssets");
  const resolveMode = requiredFunction(image, "resolveMode");
  const hasFileID = requiredFunction(image, "hasFileID");
  const resolveEditEndpoint = requiredFunction(image, "resolveEditEndpoint");
  const assertEditFlow = requiredFunction(image, "assertEditFlow");
  const buildRequest = requiredFunction(image, "buildRequest");
  const resolveOutputSize = requiredFunction(image, "resolveOutputSize");
  const normalizeResolution = requiredFunction(image, "normalizeResolution");
  const findGenerationRecord = requiredFunction(records, "findGenerationRecord");
  const validateAssets = requiredFunction(assets, "validate");
  const reserveUsage = requiredFunction(billing, "reserve");
  const refundUsage = requiredFunction(billing, "refund");
  const publicBilling = requiredFunction(billing, "publicView");
  const findOperation = requiredFunction(operations, "find");
  const enqueueOperation = requiredFunction(operations, "enqueue");
  const failOperation = requiredFunction(operations, "fail");
  const claimNextOperation = requiredFunction(operations, "claimNext");
  const processQueuedOperation = requiredFunction(operations, "processQueued");
  const resolveQueueSettings = optionalFunction(
    queue,
    "settings",
    async () => ({ workerConcurrency: 1 })
  );
  const observeQueue = optionalFunction(queue, "observe", async () => null);
  const loadReconcileCandidates = requiredFunction(operations, "loadReconcileCandidates");
  const reconcileOperation = requiredFunction(operations, "reconcile");
  const updateOperation = requiredFunction(operations, "update");
  const completeOperation = requiredFunction(operations, "complete");
  const persistResult = requiredFunction(results, "persist");
  const deleteFile = requiredFunction(files, "delete");
  const tempFileUrl = requiredFunction(files, "tempFileUrl");
  const okResponse = requiredFunction(response, "ok");
  const failResponse = requiredFunction(response, "fail");
  const buildStatus = requiredFunction(response, "buildStatus");
  const statusMessage = requiredFunction(response, "statusMessage");
  const normalizeStatus = requiredFunction(response, "normalizeStatus");
  const serializeDate = requiredFunction(serialization, "date");
  const sanitizeError = requiredFunction(serialization, "sanitizeError");
  const log = optionalFunction(services, "log", () => {});
  const now = optionalFunction(services, "now", () => new Date());

  async function getGenerationStatus(event = {}, context = {}) {
    const openid = getOpenId(context);
    const payload = event && event.payload && typeof event.payload === "object"
      ? event.payload
      : {};
    const requestId = String(
      event && (event.requestId || event.taskId)
        || payload.requestId
        || ""
    ).trim().slice(0, 100);
    if (!requestId) {
      return failResponse("缺少任务编号。", "missing-generation-task");
    }
    const operation = await findOperation(openid, requestId);
    if (!operation) {
      return failResponse("没有找到这个生图任务。", "generation-task-not-found");
    }
    return okResponse(Object.assign(
      buildStatus(operation),
      { billing: publicBilling(operation.billing) }
    ));
  }

  async function generate(event = {}, context = {}) {
    const payload = event.payload || {};
    const openid = getOpenId(context);
    if (!payload.prompt || !String(payload.prompt).trim()) {
      return failResponse("提示词不能为空。", "empty-prompt");
    }
    if (payload.generationType === "repair") {
      return failResponse(
        "局部修正请求必须改用 repairImage。",
        "repair-action-required"
      );
    }

    const configs = await resolveConfig();
    const imageConfig = configs.image;
    const imageBackupConfig = configs.imageBackup || {};
    const costs = configs.costs;
    const editAssetsDetected = hasEditAssets(payload);
    const mode = resolveMode(payload, imageConfig);
    if (
      mode === "edits"
      && (!hasFileID(payload.mainFileID) || !hasFileID(payload.maskFileID))
    ) {
      return failResponse(
        "人脸替换需要主图和 mask 文件，请先完成主图圈选后再提交。",
        "missing-edit-asset"
      );
    }
    const imageBackupUsable = Boolean(
      imageBackupConfig.enabled
      && imageBackupConfig.apiKey
      && (imageBackupConfig.baseUrl || imageBackupConfig.endpoint)
      && imageBackupConfig.model
    );
    if (
      mode === "edits"
        ? !imageConfig.apiKey && !imageBackupUsable
        : !imageConfig.apiKey
    ) {
      return failResponse(
        "云函数还没有配置可用的图片服务密钥。",
        "missing-api-key"
      );
    }

    const requestId = event.requestId;
    const model = imageConfig.model;
    const imageRequest = mode === "edits"
      ? {
          model: String(imageConfig.model || payload.model || "").trim(),
          prompt: `${String(payload.prompt || "").trim()}${
            payload.negativePrompt
              ? `\n\n负面约束：${String(payload.negativePrompt).trim()}`
              : ""
          }`,
          size: resolveOutputSize(imageConfig, payload.size),
          quality: imageConfig.compatibilityMode ? "" : "auto",
          n: 1
        }
      : buildRequest(payload, imageConfig);
    const size = imageRequest.size;
    const resolution = imageConfig.resolution || normalizeResolution(size, "1K");
    const existingRecord = await findGenerationRecord(openid, requestId);
    if (existingRecord) {
      const existingOperation = await findOperation(openid, requestId);
      const existingResult = {
        requestId,
        recordId: existingRecord._id || existingRecord.id,
        fileID: existingRecord.fileID || "",
        tempFileURL: existingRecord.tempFileURL || "",
        createdAt: serializeDate(existingRecord.createdAt),
        model: existingRecord.model || model,
        size: existingRecord.size || size,
        resolution: existingRecord.resolution || resolution,
        pipelineStage: "succeeded",
        record: Object.assign({}, existingRecord, {
          id: existingRecord._id || existingRecord.id,
          createdAt: serializeDate(existingRecord.createdAt)
        }),
        billing: publicBilling(existingOperation && existingOperation.billing)
      };
      log("info", "generation.idempotent_hit", {
        requestId,
        recordId: existingRecord._id || existingRecord.id
      });
      return okResponse(Object.assign(
        buildStatus(Object.assign({}, existingOperation || {}, {
          requestId,
          status: "succeeded",
          pipelineStage: "succeeded",
          progress: 100,
          result: existingResult,
          recordId: existingResult.recordId,
          resultFileID: existingResult.fileID,
          tempFileURL: existingResult.tempFileURL,
          succeededAt: existingRecord.createdAt
        })),
        {
          billing: publicBilling(existingOperation && existingOperation.billing),
          deduplicated: true
        }
      ));
    }

    await validateAssets(openid, payload);
    if (mode === "edits") {
      const initialEditConfig = imageConfig.apiKey
        ? imageConfig
        : imageBackupUsable
          ? imageBackupConfig
          : imageConfig;
      const editEndpoint = resolveEditEndpoint(initialEditConfig);
      assertEditFlow(initialEditConfig, editEndpoint.url);
    }
    log("info", "generation.start", {
      requestId,
      action: "generate",
      mode,
      editAssetsDetected,
      model,
      primaryProvider: imageConfig.provider || "",
      backupProvider: mode === "edits"
        ? imageBackupConfig.provider || ""
        : "",
      backupModel: mode === "edits"
        ? imageBackupConfig.model || ""
        : "",
      size,
      faceRefs: Array.isArray(payload.faceFileIDs) ? payload.faceFileIDs.length : 0,
      wardrobeRefs: Array.isArray(payload.wardrobeFileIDs)
        ? payload.wardrobeFileIDs.length
        : 0,
      backgroundRefs: Array.isArray(payload.backgroundFileIDs)
        ? payload.backgroundFileIDs.length
        : 0
    });

    let reservedBilling = null;
    let operation = null;
    try {
      reservedBilling = await reserveUsage(openid, requestId, "image");
      operation = await enqueueOperation(
        openid,
        requestId,
        payload,
        reservedBilling,
        { model, resolution, size }
      );
      return okResponse(Object.assign(
        buildStatus(operation),
        {
          billing: publicBilling(reservedBilling),
          deduplicated: Boolean(reservedBilling && reservedBilling.alreadyReserved),
          message: operation.status === "queued"
            ? "生图任务已提交"
            : statusMessage(normalizeStatus(operation.status), operation.pipelineStage)
        }
      ));
    } catch (error) {
      if (
        reservedBilling
        && !reservedBilling.untracked
        && !reservedBilling.alreadyReserved
        && !operation
      ) {
        try {
          await failOperation(openid, requestId, error, {
            enforceState: true,
            actor: "client"
          });
          await refundUsage(
            openid,
            requestId,
            "生图任务提交失败，已退回本次使用额度"
          );
        } catch (refundError) {
          log("error", "generation.enqueue-refund-failed", {
            requestId,
            error: sanitizeError(refundError && refundError.message)
          });
        }
      }
      throw error;
    }
  }

  async function processGenerationQueue(event = {}, context = {}) {
    if (event.action === "processGenerationQueue" && !isAdmin(context)) {
      return forbidden();
    }
    await observeQueue({ phase: "before", event, context });
    const settings = await resolveQueueSettings();
    const requestedConcurrency = Number(
      settings && settings.workerConcurrency
    );
    const concurrency = Number.isFinite(requestedConcurrency)
      ? Math.max(1, Math.min(4, Math.round(requestedConcurrency)))
      : 1;
    const claimed = [];
    for (let index = 0; index < concurrency; index += 1) {
      const operation = await claimNextOperation();
      if (!operation) break;
      claimed.push(operation);
    }
    if (!claimed.length) {
      await observeQueue({ phase: "after", event, context, claimed: 0 });
      return okResponse({
        claimed: 0,
        processed: 0,
        succeeded: 0,
        failed: 0,
        results: [],
        message: "暂无排队任务。"
      });
    }
    const settled = await Promise.allSettled(
      claimed.map((operation) => processQueuedOperation(operation))
    );
    const results = settled.map((item, index) => {
      const operation = claimed[index] || {};
      if (item.status === "fulfilled") {
        return {
          ok: true,
          requestId: String(operation.requestId || ""),
          result: item.value
        };
      }
      return {
        ok: false,
        requestId: String(operation.requestId || ""),
        errorCode: String(
          item.reason && item.reason.code
          || "generation-worker-item-failed"
        ).slice(0, 80),
        message: sanitizeError(
          item.reason && item.reason.message
          || "生图任务处理失败。"
        )
      };
    });
    const succeeded = results.filter((item) => item.ok).length;
    const failed = results.length - succeeded;
    await observeQueue({
      phase: "after",
      event,
      context,
      claimed: claimed.length,
      succeeded,
      failed
    });
    return okResponse({
      claimed: claimed.length,
      processed: claimed.length,
      succeeded,
      failed,
      results,
      result: results.length === 1
        ? (results[0].result || results[0])
        : null
    });
  }

  async function reconcileGenerationOperations(event = {}, context = {}) {
    if (
      event.action === "reconcileGenerationOperations"
      && !isAdmin(context)
    ) {
      return forbidden();
    }
    const currentTime = now();
    const candidates = await loadReconcileCandidates();
    const reconcileOptions = {
      now: currentTime,
      updateOperation,
      failOperation,
      completeOperation,
      persistResult,
      refund: refundUsage,
      deleteFile,
      tempFileUrl
    };
    const reconciled = [];
    for (const operation of candidates) {
      try {
        reconciled.push(await reconcileOperation(operation, reconcileOptions));
      } catch (error) {
        const requestId = String(operation && operation.requestId || "");
        reconciled.push({
          action: "reconcile-error",
          requestId,
          errorCode: String(error && error.code || "generation-reconcile-failed"),
          error: sanitizeError(error && error.message || "任务回收失败。")
        });
        log("error", "generation.reconcile-failed", {
          requestId,
          errorCode: String(error && error.code || "generation-reconcile-failed"),
          error: sanitizeError(error && error.message)
        });
      }
    }
    const summary = reconciled.reduce((accumulator, item) => {
      const action = String(item && item.action || "unknown");
      accumulator[action] = (Number(accumulator[action]) || 0) + 1;
      return accumulator;
    }, {});
    return okResponse({
      scanned: candidates.length,
      processed: reconciled.filter(
        (item) => !String(item.action || "").startsWith("skip-")
      ).length,
      summary,
      results: reconciled
    });
  }

  return Object.freeze({
    generate,
    getGenerationStatus,
    processGenerationQueue,
    reconcileGenerationOperations
  });
}

module.exports = {
  createGenerationExecutionKernel
};
