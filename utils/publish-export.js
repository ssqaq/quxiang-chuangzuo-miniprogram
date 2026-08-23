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
  const source = item.tempFileURL || item.path || "";
  const fileID = item.fileID || (isCloudFileId(source) ? source : "");

  if (source && !isCloudFileId(source)) {
    try {
      if (isHttpUrl(source)) {
        return await downloadUrl(source);
      }
      return source;
    } catch (error) {
      if (!fileID) throw error;
      console.warn("[publish-export] 临时图片地址不可用，改用云端 fileID", error);
    }
  }

  if (fileID) {
    return downloadCloudFile(fileID);
  }

  if (!source) {
    throw new Error("这条制作记录没有图片地址。");
  }
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
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const limit = Math.max(256, Number(maxEdge) || DEFAULT_MAX_EDGE);
  const scale = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale))
  };
}

function buildCanvasFilter(options = {}) {
  const filters = [];
  if (options.colorCorrect) {
    filters.push("brightness(1.02)", "contrast(1.05)", "saturate(1.05)");
  }
  if (options.denoise) {
    // Canvas 没有统一的降噪接口，用很轻的对比度收敛模拟基础降噪。
    filters.push("contrast(0.99)");
  }
  if (options.sharpen) {
    // Canvas 没有统一的锐化接口，用轻微对比度补偿保持兼容。
    filters.push("contrast(1.04)");
  }
  return filters.join(" ");
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

    const filter = buildCanvasFilter(options);
    try {
      context.clearRect(0, 0, width, height);
      if (filter && "filter" in context) {
        context.filter = filter;
      }
      context.drawImage(sourcePath, 0, 0, width, height);
      if (filter && "filter" in context) {
        context.filter = "none";
      }
    } catch (error) {
      reject(error);
      return;
    }

    context.draw(false, () => {
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
  renderToTempFile,
  resolveImageSource,
  saveToAlbum
};
