/**
 * 图片选择后的轻量压缩。
 *
 * 目的：
 * - 主图、人脸参考图、穿搭参考图上传前尽量减小体积；
 * - 保留原图宽高和原始大小，方便提示词、记录和问题排查；
 * - wx.compressImage 不可用或压缩结果更大时，自动回退原文件；
 * - mask 不经过这里，避免破坏透明通道。
 */

const DEFAULT_QUALITY = 82;
const DEFAULT_MIN_BYTES = 256 * 1024;

function getImageInfo(filePath) {
  return new Promise((resolve, reject) => {
    if (
      !filePath ||
      typeof wx === "undefined" ||
      typeof wx.getImageInfo !== "function"
    ) {
      reject(new Error("当前运行环境不支持读取图片信息。"));
      return;
    }
    wx.getImageInfo({
      src: filePath,
      success: resolve,
      fail: reject
    });
  });
}

function getFileSize(filePath) {
  return new Promise((resolve) => {
    if (!filePath || typeof wx === "undefined") {
      resolve(0);
      return;
    }

    if (typeof wx.getFileInfo === "function") {
      wx.getFileInfo({
        filePath,
        success: (result) => resolve(Number(result && result.size) || 0),
        fail: () => resolve(0)
      });
      return;
    }

    if (typeof wx.getFileSystemManager === "function") {
      try {
        const manager = wx.getFileSystemManager();
        manager.getFileInfo({
          filePath,
          success: (result) => resolve(Number(result && result.size) || 0),
          fail: () => resolve(0)
        });
        return;
      } catch (_) {
        // 旧基础库可能没有可用的文件系统管理器，继续走无大小信息分支。
      }
    }
    resolve(0);
  });
}

function compressFile(filePath, quality) {
  return new Promise((resolve) => {
    if (
      !filePath ||
      typeof wx === "undefined" ||
      typeof wx.compressImage !== "function"
    ) {
      resolve("");
      return;
    }
    wx.compressImage({
      src: filePath,
      quality,
      success: (result) => resolve((result && result.tempFilePath) || ""),
      fail: () => resolve("")
    });
  });
}

function sameAspectRatio(first, second) {
  if (!first || !second || !first.width || !first.height || !second.width || !second.height) {
    return true;
  }
  const a = Number(first.width) / Number(first.height);
  const b = Number(second.width) / Number(second.height);
  return Math.abs(a - b) <= 0.01;
}

function normalizeMime(file, imageInfo) {
  const raw = String(
    (file && (file.type || file.fileType)) ||
    (imageInfo && imageInfo.type) ||
    ""
  ).trim().toLowerCase();
  if (raw === "image") return "image/jpeg";
  if (raw === "jpg" || raw === "jpeg" || raw === "image/jpg") return "image/jpeg";
  if (raw === "png" || raw === "image/png") return "image/png";
  if (raw === "webp" || raw === "image/webp") return "image/webp";
  if (raw.indexOf("image/") === 0) return raw;
  return "image/jpeg";
}

/**
 * 返回可直接放进项目状态的图片元数据。
 *
 * 这个函数不处理 mask。调用方如果传入 skipCompression，也会保留原路径。
 */
async function prepareImageAsset(fileOrPath, options = {}) {
  const file = typeof fileOrPath === "string"
    ? { tempFilePath: fileOrPath }
    : (fileOrPath || {});
  const sourcePath = file.tempFilePath || file.path || "";
  if (!sourcePath) throw new Error("图片临时路径为空。");

  const originalInfo = options.imageInfo || await getImageInfo(sourcePath);
  const originalSize = Number(options.originalSize || file.size || await getFileSize(sourcePath)) || 0;
  const compression = options.compression || {};
  const enabled = compression.enabled !== false && options.skipCompression !== true;
  const quality = Math.max(
    40,
    Math.min(95, Number(compression.quality) || DEFAULT_QUALITY)
  );
  const minBytes = Math.max(
    0,
    Number(compression.minBytes) || DEFAULT_MIN_BYTES
  );

  const base = {
    path: sourcePath,
    width: Number(originalInfo.width) || 0,
    height: Number(originalInfo.height) || 0,
    originalWidth: Number(originalInfo.width) || 0,
    originalHeight: Number(originalInfo.height) || 0,
    originalSize,
    compressedSize: originalSize,
    compressed: false,
    compressionChecked: true,
    compressionQuality: quality,
    type: normalizeMime(file, originalInfo)
  };

  if (
    !enabled ||
    typeof wx === "undefined" ||
    typeof wx.compressImage !== "function"
  ) {
    return base;
  }
  if (originalSize > 0 && originalSize < minBytes && options.force !== true) {
    return base;
  }

  const compressedPath = await compressFile(sourcePath, quality);
  if (!compressedPath || compressedPath === sourcePath) {
    return base;
  }

  let compressedInfo;
  try {
    compressedInfo = await getImageInfo(compressedPath);
  } catch (_) {
    return base;
  }
  if (!sameAspectRatio(originalInfo, compressedInfo)) {
    return base;
  }

  const compressedSize = await getFileSize(compressedPath);
  // 没有拿到文件大小时，只要压缩接口成功且尺寸比例没变，就使用压缩文件。
  // 有大小信息时，压缩结果至少要比原文件小 2%，避免上传反而变大。
  if (
    originalSize > 0 &&
    compressedSize > 0 &&
    compressedSize >= Math.floor(originalSize * 0.98)
  ) {
    return base;
  }

  return Object.assign({}, base, {
    path: compressedPath,
    width: Number(compressedInfo.width) || base.width,
    height: Number(compressedInfo.height) || base.height,
    compressedSize: compressedSize || base.compressedSize,
    compressed: true
  });
}

module.exports = {
  DEFAULT_MIN_BYTES,
  DEFAULT_QUALITY,
  getFileSize,
  getImageInfo,
  normalizeMime,
  prepareImageAsset
};
