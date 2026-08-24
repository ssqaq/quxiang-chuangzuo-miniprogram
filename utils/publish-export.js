const core = require("./publish-export-core");

const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_QUALITY = 88;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isCloudFileId(value) {
  return /^cloud:\/\//i.test(String(value || ""));
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    if (!url || typeof wx.downloadFile !== "function") {
      reject(new Error("当前环境不支持下载制作记录图片。"));
      return;
    }
    wx.downloadFile({
      url,
      success(result) {
        if (result && result.statusCode && result.statusCode >= 400) {
          reject(new Error(`图片下载失败（${result.statusCode}）`));
          return;
        }
        const filePath = result && result.tempFilePath;
        if (!filePath) {
          reject(new Error("图片下载后没有得到临时路径。"));
          return;
        }
        resolve(filePath);
      },
      fail: reject
    });
  });
}

function downloadCloudFile(fileID) {
  return new Promise((resolve, reject) => {
    if (
      !fileID
      || !wx.cloud
      || typeof wx.cloud.downloadFile !== "function"
    ) {
      reject(new Error("当前环境不支持读取云端图片。"));
      return;
    }
    wx.cloud.downloadFile({
      fileID,
      success(result) {
        const filePath = result && result.tempFilePath;
        if (!filePath) {
          reject(new Error("云端图片下载后没有得到临时路径。"));
          return;
        }
        resolve(filePath);
      },
      fail: reject
    });
  });
}

async function resolveImageSource(record) {
  const item = record && typeof record === "object" ? record : {};
  const source = item.sourcePath || item.path || item.displayURL || item.tempFileURL || "";
  const fileID = item.sourceFileID
    || item.fileID
    || (isCloudFileId(source) ? source : "");

  if (source && !isCloudFileId(source)) {
    try {
      if (isHttpUrl(source)) return await downloadUrl(source);
      return source;
    } catch (error) {
      if (!fileID) throw error;
      console.warn("[publish-export] 临时图片地址不可用，改用云端 fileID", error);
    }
  }

  if (fileID) return downloadCloudFile(fileID);
  if (!source) throw new Error("这条制作记录没有图片地址。");
  throw new Error("这条制作记录的图片地址不可用。");
}

function getImageInfo(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.getImageInfo !== "function") {
      reject(new Error("当前环境不支持读取图片尺寸。"));
      return;
    }
    wx.getImageInfo({
      src: filePath,
      success(result) {
        const width = Number(result && result.width) || 0;
        const height = Number(result && result.height) || 0;
        if (!width || !height) {
          reject(new Error("无法读取图片尺寸。"));
          return;
        }
        resolve(Object.assign({}, result, { width, height }));
      },
      fail: reject
    });
  });
}

function getOutputSize(width, height, maxEdge) {
  return core.getOutputSize(width, height, maxEdge);
}

function getProcessingDecision(width, height, options = {}, workerAvailable) {
  const canUseWorker = workerAvailable === undefined
    ? typeof wx.createWorker === "function"
    : Boolean(workerAvailable);
  return core.chooseLocalMode(width, height, options, canUseWorker);
}

function buildCanvasFilter(options = {}) {
  const filters = [];
  if (options.colorOptimize || options.colorCorrect) {
    filters.push("brightness(1.02)", "contrast(1.05)", "saturate(1.05)");
  }
  if (options.gentleSoften || options.denoise) filters.push("contrast(0.99)");
  if (options.gentleSharpen || options.sharpen) filters.push("contrast(1.04)");
  return filters.join(" ");
}

function getCanvasImageData(canvasId, width, height) {
  return new Promise((resolve, reject) => {
    if (typeof wx.canvasGetImageData !== "function") {
      const error = new Error("当前微信环境不支持读取 Canvas 像素。");
      error.code = "LOCAL_PIXEL_API_UNAVAILABLE";
      reject(error);
      return;
    }
    wx.canvasGetImageData({
      canvasId,
      x: 0,
      y: 0,
      width,
      height,
      success(result) {
        if (!result || !result.data) {
          const error = new Error("Canvas 没有返回像素数据。");
          error.code = "LOCAL_PIXEL_DATA_EMPTY";
          reject(error);
          return;
        }
        resolve(result);
      },
      fail(error) {
        const wrapped = error instanceof Error ? error : new Error(
          error && error.errMsg ? error.errMsg : "读取 Canvas 像素失败。"
        );
        wrapped.code = wrapped.code || "LOCAL_PIXEL_READ_FAILED";
        reject(wrapped);
      }
    });
  });
}

function putCanvasImageData(canvasId, data, width, height) {
  return new Promise((resolve, reject) => {
    if (typeof wx.canvasPutImageData !== "function") {
      const error = new Error("当前微信环境不支持写回 Canvas 像素。");
      error.code = "LOCAL_PIXEL_API_UNAVAILABLE";
      reject(error);
      return;
    }
    wx.canvasPutImageData({
      canvasId,
      x: 0,
      y: 0,
      width,
      height,
      data,
      success: resolve,
      fail(error) {
        const wrapped = error instanceof Error ? error : new Error(
          error && error.errMsg ? error.errMsg : "写回 Canvas 像素失败。"
        );
        wrapped.code = wrapped.code || "LOCAL_PIXEL_WRITE_FAILED";
        reject(wrapped);
      }
    });
  });
}

function processPixelsWithWorker(payload) {
  return new Promise((resolve, reject) => {
    if (typeof wx.createWorker !== "function") {
      const error = new Error("当前环境没有 Worker，回退主线程。");
      error.code = "WORKER_UNAVAILABLE";
      reject(error);
      return;
    }
    let worker;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (worker && typeof worker.terminate === "function") worker.terminate();
      const error = new Error("Worker 处理超时。");
      error.code = "WORKER_TIMEOUT";
      reject(error);
    }, 20000);

    try {
      worker = wx.createWorker("workers/publish-export-worker.js");
      worker.onMessage((message = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker && typeof worker.terminate === "function") worker.terminate();
        if (!message.ok) {
          const error = new Error(message.error || "Worker 图像处理失败。");
          error.code = "WORKER_PROCESS_FAILED";
          reject(error);
          return;
        }
        resolve(message.data instanceof Uint8ClampedArray
          ? message.data
          : new Uint8ClampedArray(message.data || []));
      });
      worker.postMessage(payload);
    } catch (error) {
      clearTimeout(timer);
      if (worker && typeof worker.terminate === "function") worker.terminate();
      reject(error);
    }
  });
}

async function processPixels(data, width, height, options = {}) {
  const source = data instanceof Uint8ClampedArray
    ? data
    : new Uint8ClampedArray(data || []);
  const workerPayload = {
    id: `publish-${Date.now().toString(36)}`,
    width,
    height,
    data: source,
    options: core.normalizeOptions(options),
    seed: options.seed || "publish-export"
  };
  if (options.useWorker !== false) {
    try {
      return await processPixelsWithWorker(workerPayload);
    } catch (error) {
      if (error && error.code !== "WORKER_UNAVAILABLE") {
        console.warn("[publish-export] Worker 处理失败，回退主线程", error);
      }
    }
  }
  return core.processRgba({
    data: source,
    width,
    height,
    options,
    seed: options.seed || "publish-export"
  });
}

function canvasToTempFile(page, canvasId, width, height, format, quality) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvasId,
      x: 0,
      y: 0,
      width,
      height,
      destWidth: width,
      destHeight: height,
      fileType: format,
      quality,
      success(result) {
        const tempFilePath = result && result.tempFilePath;
        if (!tempFilePath) {
          reject(new Error("Canvas 导出后没有得到新图片。"));
          return;
        }
        resolve(tempFilePath);
      },
      fail: reject
    }, page);
  });
}

function renderToTempFile(options = {}) {
  const page = options.page;
  const canvasId = options.canvasId || "publish-export-canvas";
  const sourcePath = options.sourcePath;
  const width = Math.max(1, Number(options.width) || 1);
  const height = Math.max(1, Number(options.height) || 1);
  const format = options.format === "png" ? "png" : "jpg";
  const quality = Math.max(
    0.4,
    Math.min(1, (Number(options.quality) || DEFAULT_QUALITY) / 100)
  );
  const normalized = core.normalizeOptions(options);
  const onStage = typeof options.onStage === "function" ? options.onStage : () => {};

  return new Promise((resolve, reject) => {
    if (!sourcePath || typeof wx.createCanvasContext !== "function") {
      reject(new Error("当前环境不支持 Canvas 导出。"));
      return;
    }

    let context;
    try {
      context = wx.createCanvasContext(canvasId, page);
    } catch (error) {
      reject(error);
      return;
    }
    if (!context) {
      reject(new Error("Canvas 初始化失败。"));
      return;
    }

    try {
      context.clearRect(0, 0, width, height);
      const filter = buildCanvasFilter(normalized);
      if (filter && "filter" in context) context.filter = filter;
      context.drawImage(sourcePath, 0, 0, width, height);
      if (filter && "filter" in context) context.filter = "none";
    } catch (error) {
      reject(error);
      return;
    }

    context.draw(false, async () => {
      try {
        onStage("read-pixels");
        const imageData = await getCanvasImageData(canvasId, width, height);
        onStage("process-pixels");
        const processed = await processPixels(
          imageData.data,
          width,
          height,
          Object.assign({}, normalized, {
            useWorker: options.useWorker,
            seed: options.seed || "publish-export"
          })
        );
        onStage("write-pixels");
        await putCanvasImageData(canvasId, processed, width, height);
        onStage("encode");
        resolve(await canvasToTempFile(page, canvasId, width, height, format, quality));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function saveToAlbum(filePath) {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof wx.saveImageToPhotosAlbum !== "function") {
      reject(new Error("当前环境不支持保存到相册。"));
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath,
      success: resolve,
      fail: reject
    });
  });
}

module.exports = {
  DEFAULT_MAX_EDGE,
  DEFAULT_QUALITY,
  getImageInfo,
  getOutputSize,
  getProcessingDecision,
  renderToTempFile,
  resolveImageSource,
  saveToAlbum,
  processPixels,
  buildCanvasFilter
};

