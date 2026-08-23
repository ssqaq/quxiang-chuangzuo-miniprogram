const config = require("../config");

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
      reject(new Error("还没有配置 CloudBase 环境 ID。"));
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
          resolve(result);
        },
        fail(error) {
          if (attempt < maxRetries) {
            const nextAttempt = attempt + 1;
            console.warn("[cloud] retry", {
              action: requestData && requestData.action,
              attempt: nextAttempt
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
      reject(new Error("还没有配置 CloudBase 环境 ID。"));
      return;
    }
    const safeName = String(filePath || "image.jpg").split(/[\\/]/).pop().replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
    const cloudPath = `${folder || "uploads"}/${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`;
    const startedAt = Date.now();
    console.info("[cloud] upload.start", { folder: folder || "uploads", filePath });
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
        reject(error);
      }
    });
  });
}

function getTempUrl(fileID) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady() || !fileID) {
      resolve("");
      return;
    }
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success(response) {
        const item = response.fileList && response.fileList[0];
        resolve((item && item.tempFileURL) || "");
      },
      fail: reject
    });
  });
}

module.exports = {
  isCloudReady,
  callApi,
  uploadFile,
  getTempUrl,
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
  }
};
