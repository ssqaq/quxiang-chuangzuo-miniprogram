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
    const maxRetries = data && data.action === "generate"
      ? Math.max(0, Number(data.retryLimit === undefined ? 2 : data.retryLimit))
      : 2;
    const retryDelay = data && data.action === "generate" ? 2000 : 500;
    const onRetry = data && typeof data.onRetry === "function" ? data.onRetry : null;
    const requestData = Object.assign({}, data);
    delete requestData.onRetry;
    delete requestData.retryLimit;
    if (!requestData.requestId) {
      requestData.requestId = `client-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    }
    const requestStartedAt = Date.now();
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
    const invoke = (attempt) => {
      wx.cloud.callFunction({
        name: config.cloudFunctionName,
        data: requestData,
        success(response) {
          const result = response && response.result ? response.result : response;
          if (result && result.ok === false) {
            const error = new Error(result.message || result.error || "云函数请求失败");
            error.payload = result;
            if (result.retryable && attempt < maxRetries) {
              const nextAttempt = attempt + 1;
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
            reject(error);
            return;
          }
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
          resolve(result);
        },
        fail(error) {
          if (attempt < maxRetries) {
            const nextAttempt = attempt + 1;
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
              error
            });
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
            error
          });
          reject(error);
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

module.exports = {
  isCloudReady,
  callApi,
  uploadFile,
  getTempUrl,
  downloadFile,
  analyzeImage(payload) {
    return callApi({ action: "analyze", payload });
  },
  analyzeWebPoses(payload) {
    return callApi({ action: "analyzeWebPoses", payload });
  },
  detectFaceCircle(payload) {
    return callApi({ action: "detectFaceCircle", payload });
  },
  generateImage(payload, options = {}) {
    return callApi({
      action: "generate",
      payload,
      requestId: options.requestId || "",
      retryLimit: options.maxRetries,
      onRetry: options.onRetry
    });
  },
  listRecords() {
    return callApi({ action: "listRecords" });
  },
  deleteRecord(recordId) {
    return callApi({ action: "deleteRecord", recordId });
  },
  getVideoProviderStatus() {
    return callApi({ action: "videoProviderStatus" });
  },
  createVideoTask(payload) {
    return callApi({ action: "createVideoTask", payload });
  },
  queryVideoTask(taskId) {
    return callApi({ action: "queryVideoTask", taskId });
  }
};
