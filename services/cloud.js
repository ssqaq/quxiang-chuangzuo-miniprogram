const config = require("../config");
const diagnosticLog = require("../utils/diagnostic-log");

function getAppInstance() {
  try {
    return getApp();
  } catch (error) {
    return null;
  }
}

function isCloudReady() {
  const app = getAppInstance();
  return Boolean(
    wx.cloud &&
      config.cloudEnvId &&
      config.cloudEnvId !== "YOUR_CLOUDBASE_ENV_ID" &&
      app &&
      app.globalData &&
      app.globalData.cloudReady
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enrichCloudError(error, details = {}) {
  const normalized = error instanceof Error
    ? error
    : new Error(
      error && (error.errMsg || error.message)
        ? String(error.errMsg || error.message)
        : "云函数请求失败"
    );
  if (details.status !== undefined && details.status !== null) {
    normalized.status = Number(details.status) || 0;
  }
  if (details.retryable !== undefined) {
    normalized.retryable = Boolean(details.retryable);
  }
  if (details.requestId) {
    normalized.requestId = String(details.requestId);
  }
  return normalized;
}

function callApi(data) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady()) {
      const error = new Error("还没有配置 CloudBase 环境 ID。");
      diagnosticLog.error("cloud", "call-blocked", "云函数调用被阻止：云端未就绪", {
        step: data && data.action,
        error
      });
      reject(error);
      return;
    }
    const retryLimit = data && data.retryLimit !== undefined
      ? Number(data.retryLimit)
      : null;
    const maxRetries = retryLimit !== null && Number.isFinite(retryLimit)
      ? Math.max(0, retryLimit)
      : data && data.action === "generate"
        ? 2
        : 2;
    const retryDelay = data && data.action === "generate" ? 2000 : 500;
    const silent = Boolean(data && data.silent);
    const onRetry = data && typeof data.onRetry === "function" ? data.onRetry : null;
    const requestData = Object.assign({}, data);
    delete requestData.onRetry;
    delete requestData.retryLimit;
    delete requestData.silent;
    if (!requestData.requestId) {
      requestData.requestId = `client-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    }
    const requestStartedAt = Date.now();
    if (!silent) {
      console.info("[cloud] call.start", {
        action: requestData.action || "",
        requestId: requestData.requestId
      });
      diagnosticLog.info("cloud", "call-start", "开始调用云函数", {
        step: requestData.action || "",
        requestId: requestData.requestId,
        payloadSummary: requestData.payload || {},
        recordId: requestData.recordId || "",
        taskId: requestData.taskId || ""
      });
    }
    const invoke = (attempt) => {
      wx.cloud.callFunction({
        name: config.cloudFunctionName,
        data: requestData,
        success(response) {
          const result = response && response.result ? response.result : response;
          if (result && result.ok === false) {
            const error = enrichCloudError(
              new Error(result.message || result.error || "云函数请求失败"),
              {
                status: result.status,
                retryable: result.retryable,
                requestId: result.requestId || requestData.requestId
              }
            );
            error.payload = result;
            if (result.retryable && attempt < maxRetries) {
              const nextAttempt = attempt + 1;
              if (!silent) {
                console.warn("[cloud] retry", {
                  action: requestData && requestData.action,
                  attempt: nextAttempt,
                  requestId: result.requestId || ""
                });
                diagnosticLog.warn("cloud", "call-retry", "云函数请求准备重试", {
                  step: requestData.action || "",
                  requestId: result.requestId || requestData.requestId,
                  attempt: nextAttempt,
                  maxRetries,
                  delayMs: retryDelay,
                  code: result.errorCode || result.code || ""
                });
              }
              if (onRetry) {
                onRetry({
                  attempt: nextAttempt,
                  maxRetries,
                  delayMs: retryDelay,
                  code: result.errorCode || result.code || ""
                });
              }
              sleep(retryDelay).then(() => invoke(nextAttempt));
              return;
            }
            if (!silent) {
              console.warn("[cloud] call.finish", {
                action: requestData.action || "",
                requestId: result.requestId || requestData.requestId,
                durationMs: Date.now() - requestStartedAt,
                ok: false,
                attempt,
                errorCode: result.errorCode || result.code || ""
              });
              diagnosticLog.error("cloud", "call-failed", "云函数返回失败结果", {
                step: requestData.action || "",
                requestId: result.requestId || requestData.requestId,
                durationMs: Date.now() - requestStartedAt,
                attempt,
                code: result.errorCode || result.code || "",
                error
              });
            }
            if (silent) {
              resolve(Object.assign({}, result, {
                unavailable: true,
                isAdmin: Boolean(result.isAdmin)
              }));
              return;
            }
            reject(error);
            return;
          }
          if (!silent) {
            console.info("[cloud] call.finish", {
              action: requestData.action || "",
              requestId: result && result.requestId || requestData.requestId,
              durationMs: Date.now() - requestStartedAt,
              ok: true,
              attempt
            });
            diagnosticLog.info("cloud", "call-success", "云函数调用完成", {
              step: requestData.action || "",
              requestId: result && result.requestId || requestData.requestId,
              durationMs: Date.now() - requestStartedAt,
              attempt,
              resultSummary: {
                ok: result && result.ok,
                recordId: result && result.recordId,
                taskId: result && result.taskId,
                status: result && result.status,
                provider: result && result.provider,
                model: result && result.model
              }
            });
          }
          resolve(result);
        },
        fail(error) {
          const normalizedError = enrichCloudError(error, {
            retryable: true,
            requestId: requestData.requestId
          });
          if (attempt < maxRetries) {
            const nextAttempt = attempt + 1;
            if (!silent) {
              console.warn("[cloud] retry", {
                action: requestData && requestData.action,
                attempt: nextAttempt
              });
              diagnosticLog.warn("cloud", "call-retry", "云函数调用失败，准备重试", {
                step: requestData.action || "",
                requestId: requestData.requestId,
                attempt: nextAttempt,
                maxRetries,
                delayMs: retryDelay,
                error: normalizedError
              });
            }
            if (onRetry) {
              onRetry({
                attempt: nextAttempt,
                maxRetries,
                delayMs: retryDelay,
                code: error && (error.errCode || error.code || "")
              });
            }
            sleep(retryDelay).then(() => invoke(nextAttempt));
            return;
          }
          if (!silent) {
            console.warn("[cloud] call.finish", {
              action: requestData.action || "",
              requestId: requestData.requestId,
              durationMs: Date.now() - requestStartedAt,
              ok: false,
              attempt,
              errorCode: error && (error.errCode || error.code || "")
            });
            diagnosticLog.error("cloud", "call-failed", "云函数调用最终失败", {
              step: requestData.action || "",
              requestId: requestData.requestId,
              durationMs: Date.now() - requestStartedAt,
              attempt,
              error: normalizedError
            });
          }
          if (silent) {
            resolve({
              ok: false,
              isAdmin: false,
              unavailable: true,
              requestId: requestData.requestId
            });
            return;
          }
          reject(normalizedError);
        }
      });
    };
    invoke(0);
  });
}

function uploadFile(filePath, folder) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady()) {
      const error = new Error("还没有配置 CloudBase 环境 ID。");
      diagnosticLog.error("upload", "upload-blocked", "文件上传被阻止：云端未就绪", {
        step: folder || "uploads",
        filePath,
        error
      });
      reject(error);
      return;
    }
    const safeName = String(filePath || "image.jpg").split(/[\\/]/).pop().replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
    const cloudPath = `${folder || "uploads"}/${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
    const startedAt = Date.now();
    console.info("[cloud] upload.start", { folder: folder || "uploads", filePath });
    diagnosticLog.info("upload", "upload-start", "开始上传文件", {
      step: folder || "uploads",
      filePath
    });
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success(response) {
        console.info("[cloud] upload.finish", {
          folder: folder || "uploads",
          filePath,
          durationMs: Date.now() - startedAt,
          fileID: response && response.fileID || ""
        });
        diagnosticLog.info("upload", "upload-success", "文件上传完成", {
          step: folder || "uploads",
          filePath,
          durationMs: Date.now() - startedAt,
          fileID: response && response.fileID || ""
        });
        resolve(response);
      },
      fail(error) {
        console.warn("[cloud] upload.finish", {
          folder: folder || "uploads",
          filePath,
          durationMs: Date.now() - startedAt,
          ok: false,
          errorCode: error && (error.errCode || error.code || "")
        });
        diagnosticLog.error("upload", "upload-failed", "文件上传失败", {
          step: folder || "uploads",
          filePath,
          durationMs: Date.now() - startedAt,
          error
        });
        reject(error);
      }
    });
  });
}

function safeAssetFileName(filePath) {
  return String(filePath || "image.jpg")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
}

function prepareAssetUpload(kind, filePath, options = {}) {
  return callApi({
    action: "prepareAssetUpload",
    kind,
    fileName: options.fileName || safeAssetFileName(filePath),
    contentType: options.contentType || options.mime || "image/jpeg"
  });
}

function registerAsset(ticket, fileID, kind, options = {}) {
  return callApi({
    action: "registerAsset",
    ticketId: ticket && (ticket.ticketId || ticket.id) || "",
    fileID,
    kind,
    temporary: Boolean(options.temporary)
  });
}

function registerPhotoToVideoTempAsset(fileID, kind, options = {}) {
  return callApi({
    action: "registerPhotoToVideoTempAsset",
    fileID,
    kind,
    sessionId: options.sessionId || "",
    recordId: options.recordId || "",
    retryLimit: 0,
    silent: true
  });
}

function registerPhotoToVideoRecord(recordId, sessionId) {
  return registerPhotoToVideoTempAsset("", "record", {
    recordId,
    sessionId
  });
}

function markPhotoToVideoSessionActive(sessionId) {
  return callApi({
    action: "markPhotoToVideoSessionActive",
    sessionId,
    retryLimit: 0,
    silent: true
  });
}

function closePhotoToVideoSession(sessionId) {
  return callApi({
    action: "closePhotoToVideoSession",
    sessionId,
    retryLimit: 0,
    silent: true
  });
}

function transferMedia(url, kind, options = {}) {
  return callApi({
    action: "transferMedia",
    url: String(url || "").trim(),
    kind: String(kind || "").trim(),
    fileName: String(options.fileName || "").trim(),
    mimeType: String(options.mimeType || "").trim(),
    requestId: options.requestId || "",
    retryLimit: 0
  });
}

function releaseTransferMedia(transferId, fileID, options = {}) {
  return callApi({
    action: "releaseTransferMedia",
    transferId: String(transferId || "").trim(),
    fileID: String(fileID || "").trim(),
    requestId: options.requestId || "",
    retryLimit: 0,
    silent: true
  });
}

async function uploadAsset(filePath, kind, options = {}) {
  const ticket = await prepareAssetUpload(kind, filePath, options);
  if (!ticket || !ticket.cloudPath) {
    throw new Error("云端没有返回素材上传路径。");
  }
  const uploaded = await new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath: ticket.cloudPath,
      filePath,
      success: resolve,
      fail: reject
    });
  });
  if (!uploaded || !uploaded.fileID) {
    throw new Error("素材上传完成但没有返回 fileID。");
  }
  const registered = await registerAsset(ticket, uploaded.fileID, kind, options);
  return Object.assign({}, uploaded, registered && registered.asset ? {
    asset: registered.asset
  } : {}, {
    ticketId: ticket.ticketId || ticket.id || "",
    kind
  });
}

function publishExport(payload = {}) {
  return callApi({
    action: "publishExport",
    recordId: payload.recordId || "",
    fileID: payload.fileID || "",
    temporaryInput: Boolean(payload.temporaryInput),
    options: payload.options && typeof payload.options === "object"
      ? payload.options
      : {}
  });
}

function cleanupPublishExportResult(jobId, fileID) {
  return callApi({
    action: "cleanupPublishExportResult",
    jobId: String(jobId || ""),
    fileID: String(fileID || ""),
    retryLimit: 0,
    silent: true
  });
}

function getTempUrl(fileID) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady() || !fileID) {
      diagnosticLog.warn("cloud-file", "temp-url-skipped", "跳过获取云文件临时地址", {
        fileID: fileID || "",
        cloudReady: isCloudReady()
      });
      resolve("");
      return;
    }
    const startedAt = Date.now();
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success(response) {
        const item = response.fileList && response.fileList[0];
        diagnosticLog.info("cloud-file", "temp-url-success", "云文件临时地址获取完成", {
          fileID,
          durationMs: Date.now() - startedAt,
          hasUrl: Boolean(item && item.tempFileURL)
        });
        resolve((item && item.tempFileURL) || "");
      },
      fail(error) {
        diagnosticLog.error("cloud-file", "temp-url-failed", "获取云文件临时地址失败", {
          fileID,
          durationMs: Date.now() - startedAt,
          error
        });
        reject(error);
      }
    });
  });
}

function downloadFile(fileID) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady() || !fileID || !wx.cloud || typeof wx.cloud.downloadFile !== "function") {
      const error = new Error("当前环境不支持读取云端视频。");
      diagnosticLog.error("cloud-file", "download-blocked", "云文件下载被阻止", {
        fileID: fileID || "",
        error
      });
      reject(error);
      return;
    }
    const startedAt = Date.now();
    diagnosticLog.info("cloud-file", "download-start", "开始下载云文件", {
      fileID
    });
    wx.cloud.downloadFile({
      fileID,
      success(response) {
        const filePath = response && response.tempFilePath;
        if (!filePath) {
          const error = new Error("云端视频下载后没有得到临时路径。");
          diagnosticLog.error("cloud-file", "download-failed", "云文件下载结果缺少本地路径", {
            fileID,
            durationMs: Date.now() - startedAt,
            error
          });
          reject(error);
          return;
        }
        diagnosticLog.info("cloud-file", "download-success", "云文件下载完成", {
          fileID,
          filePath,
          durationMs: Date.now() - startedAt
        });
        resolve(filePath);
      },
      fail(error) {
        diagnosticLog.error("cloud-file", "download-failed", "云文件下载失败", {
          fileID,
          durationMs: Date.now() - startedAt,
          error
        });
        reject(error);
      }
    });
  });
}

function deleteFile(fileID) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady() || !fileID || !wx.cloud || typeof wx.cloud.deleteFile !== "function") {
      const error = new Error("当前环境不支持清理云文件。");
      diagnosticLog.warn("cloud-file", "delete-blocked", "云文件清理被阻止", {
        fileID: fileID || "",
        error
      });
      reject(error);
      return;
    }
    const startedAt = Date.now();
    wx.cloud.deleteFile({
      fileList: [fileID],
      success(response) {
        const failed = response && Array.isArray(response.fileList)
          ? response.fileList.find((item) => item.fileID === fileID && item.status !== 0)
          : null;
        if (failed) {
          const error = new Error(failed.errMsg || "云文件清理失败。");
          diagnosticLog.warn("cloud-file", "delete-failed", "云文件清理返回失败", {
            fileID,
            durationMs: Date.now() - startedAt,
            error
          });
          reject(error);
          return;
        }
        diagnosticLog.info("cloud-file", "delete-success", "云文件清理完成", {
          fileID,
          durationMs: Date.now() - startedAt
        });
        resolve(response);
      },
      fail(error) {
        diagnosticLog.warn("cloud-file", "delete-failed", "云文件清理失败", {
          fileID,
          durationMs: Date.now() - startedAt,
          error
        });
        reject(error);
      }
    });
  });
}

function submitGeneration(payload, options = {}) {
  return callApi({
    action: "generate",
    payload: payload && typeof payload === "object" ? payload : {},
    requestId: options.requestId || (payload && payload.requestId) || "",
    retryLimit: 0
  });
}

function getGenerationStatus(requestId, options = {}) {
  return callApi({
    action: "getGenerationStatus",
    requestId: String(requestId || ""),
    retryLimit: 0,
    silent: Boolean(options.silent)
  });
}

module.exports = {
  isCloudReady,
  callApi,
  uploadFile,
  uploadAsset,
  prepareAssetUpload,
  registerAsset,
  publishExport,
  cleanupPublishExportResult,
  registerPhotoToVideoTempAsset,
  registerPhotoToVideoRecord,
  markPhotoToVideoSessionActive,
  closePhotoToVideoSession,
  transferMedia,
  releaseTransferMedia,
  getTempUrl,
  downloadFile,
  deleteFile,
  submitGeneration,
  getGenerationStatus,
  analyzeImage(payload) {
    return callApi({ action: "analyze", payload });
  },
  analyzeWebPoses(payload) {
    return callApi({ action: "analyzeWebPoses", payload });
  },
  detectFaceCircle(payload) {
    return callApi({ action: "detectFaceCircle", payload });
  },
  probeAutoFace() {
    return callApi({
      action: "probeAutoFace",
      retryLimit: 0
    });
  },
  getAutoFaceProbeHistory() {
    return callApi({
      action: "getAutoFaceProbeHistory",
      retryLimit: 0
    });
  },
  generateImage(payload, options = {}) {
    return submitGeneration(payload, options);
  },
  tencentFaceFusionPipeline(payload, options = {}) {
    return callApi({
      action: "tencentFaceFusionPipeline",
      payload: payload && typeof payload === "object" ? payload : {},
      requestId: options.requestId || (payload && payload.requestId) || "",
      retryLimit: options.maxRetries === undefined ? 0 : options.maxRetries,
      onRetry: options.onRetry
    });
  },
  getTencentFaceFusionPipelineStatus(requestId) {
    return callApi({
      action: "getTencentFaceFusionPipelineStatus",
      requestId: String(requestId || ""),
      retryLimit: 0,
      silent: true
    });
  },
  getTencentFaceFusionAdminStatus() {
    return callApi({
      action: "getTencentFaceFusionAdminStatus",
      retryLimit: 0,
      silent: true
    });
  },
  testTencentFaceFusion(payload = {}, options = {}) {
    return callApi({
      action: "testTencentFaceFusion",
      payload: payload && typeof payload === "object" ? payload : {},
      requestId: options.requestId || (payload && payload.requestId) || "",
      retryLimit: 0
    });
  },
  repairImage(payload, options = {}) {
    return callApi({
      action: "repairImage",
      payload: Object.assign({}, payload, {
        generationType: "repair",
        mode: "edits"
      }),
      requestId: options.requestId || (payload && payload.requestId) || "",
      retryLimit: options.maxRetries,
      onRetry: options.onRetry
    });
  },
  listRecords() {
    return callApi({ action: "listRecords" });
  },
  getMyUserProfile(options = {}) {
    return callApi({
      action: "getMyUserProfile",
      retryLimit: options.retryLimit === undefined ? 1 : options.retryLimit,
      silent: Boolean(options.silent)
    });
  },
  saveMyUserProfile(profile) {
    return callApi({
      action: "saveMyUserProfile",
      profile: profile && typeof profile === "object" ? profile : {},
      retryLimit: 0
    });
  },
  getUserPoints(options = {}) {
    return callApi({
      action: "getUserPoints",
      retryLimit: options.retryLimit === undefined ? 1 : options.retryLimit,
      silent: Boolean(options.silent)
    });
  },
  checkIn() {
    return callApi({ action: "checkIn", retryLimit: 0 });
  },
  getPointLedger() {
    return callApi({ action: "getPointLedger" });
  },
  deleteRecord(recordId) {
    return callApi({ action: "deleteRecord", recordId });
  },
  getVideoProviderStatus() {
    return callApi({ action: "videoProviderStatus" });
  },
  getAdminStatus() {
    return callApi({
      action: "getAdminStatus",
      retryLimit: 0,
      silent: true
    });
  },
  reportDiagnosticLogs(payload) {
    return callApi({
      action: "reportDiagnosticLogs",
      payload: payload && typeof payload === "object" ? payload : {},
      retryLimit: 0,
      silent: true
    });
  },
  getAdminDiagnosticLogs(filters = {}) {
    return callApi({
      action: "getAdminDiagnosticLogs",
      offset: Math.max(0, Number(filters.offset) || 0),
      limit: Math.max(1, Math.min(50, Number(filters.limit) || 20)),
      hours: Math.max(1, Math.min(72, Number(filters.hours) || 72)),
      level: String(filters.level || "all").trim().slice(0, 16),
      category: String(filters.category || "all").trim().slice(0, 40),
      userHash: String(filters.userHash || "").trim().slice(0, 40),
      retryLimit: 0,
      silent: true
    });
  },
  getAdminConfig(options = {}) {
    return callApi({
      action: "getAdminConfig",
      retryLimit: options.retryLimit,
      silent: Boolean(options.silent)
    });
  },
  getAdminUserStats(offset = 0, limit = 20, filters = {}) {
    return callApi({
      action: "getAdminUserStats",
      offset: Math.max(0, Number(offset) || 0),
      limit: Math.max(1, Math.min(50, Number(limit) || 20)),
      search: String(filters.search || "").trim().slice(0, 32),
      dateRange: String(filters.dateRange || "all"),
      gender: String(filters.gender || "all"),
      startDate: String(filters.startDate || ""),
      endDate: String(filters.endDate || "")
    });
  },
  exportAdminUserStats(filters = {}) {
    return callApi({
      action: "exportAdminUserStats",
      search: String(filters.search || "").trim().slice(0, 32),
      dateRange: String(filters.dateRange || "all"),
      gender: String(filters.gender || "all"),
      startDate: String(filters.startDate || ""),
      endDate: String(filters.endDate || "")
    });
  },
  saveAdminConfig(config) {
    return callApi({
      action: "saveAdminConfig",
      config
    });
  },
  checkDeployment() {
    return callApi({ action: "checkDeployment" });
  },
  probeImageEditCapability(modelConfig = null) {
    const data = {
      action: "probeImageEditCapability",
      retryLimit: 0
    };
    if (modelConfig && typeof modelConfig === "object") data.config = modelConfig;
    return callApi(data);
  },
  probeModels(modelType = "", modelConfig = null) {
    const data = {
      action: "probeModels",
      modelType: String(modelType || "").trim(),
      retryLimit: 0
    };
    if (modelConfig && typeof modelConfig === "object") data.config = modelConfig;
    return callApi(data);
  },
  listModels(modelType, modelConfig = null) {
    const data = {
      action: "listModels",
      modelType: String(modelType || "").trim(),
      retryLimit: 0
    };
    if (modelConfig && typeof modelConfig === "object") data.config = modelConfig;
    return callApi(data);
  },
  listDeploymentLogs() {
    return callApi({ action: "listDeploymentLogs" });
  },
  getModelUsageStats(days = 30) {
    return callApi({
      action: "getModelUsageStats",
      days: Math.max(1, Math.min(90, Number(days) || 30))
    });
  },
  reportAutoFaceFailure(payload) {
    return callApi({
      action: "reportAutoFaceFailure",
      payload: payload && typeof payload === "object" ? payload : {},
      retryLimit: 0,
      silent: true
    });
  },
  getAutoFaceFailureStats() {
    return callApi({
      action: "getAutoFaceFailureStats",
      retryLimit: 0
    });
  },
  exportAutoFaceFailureStats(monthKey = "") {
    return callApi({
      action: "exportAutoFaceFailureStats",
      monthKey: String(monthKey || ""),
      retryLimit: 0
    });
  },
  exportModelUsageStats(days = 30) {
    return callApi({
      action: "exportModelUsageStats",
      days: Math.max(1, Math.min(90, Number(days) || 30))
    });
  },
  exportModelFailureStats(monthKey = "") {
    return callApi({
      action: "exportModelFailureStats",
      monthKey: String(monthKey || ""),
      retryLimit: 0
    });
  },
  createVideoTask(payload, options = {}) {
    return callApi({
      action: "createVideoTask",
      payload,
      requestId: options.requestId || (payload && payload.requestId) || ""
    });
  },
  queryVideoTask(taskId, options = {}) {
    return callApi({
      action: "queryVideoTask",
      taskId,
      requestId: options.requestId || ""
    });
  },
  buildAndroidMotionPhoto(taskId, options = {}) {
    return callApi({
      action: "buildAndroidMotionPhoto",
      taskId,
      requestId: options.requestId || ""
    });
  },
  buildAppleLivePhoto(taskId, options = {}) {
    return callApi({
      action: "buildAppleLivePhoto",
      taskId,
      requestId: options.requestId || ""
    });
  }
};
