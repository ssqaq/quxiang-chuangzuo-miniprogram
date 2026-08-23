function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function normalizeCircle(circle, width, height) {
  const imageWidth = Math.max(1, Number(width) || 1);
  const imageHeight = Math.max(1, Number(height) || 1);
  const circleWidth = Math.max(1, Number(circle && circle.width) || 1);
  const circleHeight = Math.max(1, Number(circle && circle.height) || 1);
  const left = clamp((Number(circle && circle.x) || 0) - circleWidth / 2, 0, imageWidth);
  const top = clamp((Number(circle && circle.y) || 0) - circleHeight / 2, 0, imageHeight);
  const right = clamp(left + circleWidth, 0, imageWidth);
  const bottom = clamp(top + circleHeight, 0, imageHeight);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function getProtectionRects(circle, width, height) {
  const imageWidth = Math.max(1, Number(width) || 1);
  const imageHeight = Math.max(1, Number(height) || 1);
  const box = normalizeCircle(circle, imageWidth, imageHeight);
  return [
    { x: 0, y: 0, width: imageWidth, height: box.top },
    { x: 0, y: box.bottom, width: imageWidth, height: imageHeight - box.bottom },
    { x: 0, y: box.top, width: box.left, height: box.height },
    { x: box.right, y: box.top, width: imageWidth - box.right, height: box.height }
  ].filter((item) => item.width > 0 && item.height > 0);
}

function exportMaskFile(page, circle, width, height) {
  return new Promise((resolve, reject) => {
    if (!page || !circle || !width || !height) {
      reject(new Error("缺少 mask 导出参数。"));
      return;
    }
    const ctx = wx.createCanvasContext("maskExportCanvas", page);
    const rects = getProtectionRects(circle, width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.setFillStyle("#ffffff");
    rects.forEach((rect) => {
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    });
    ctx.draw(false, () => {
      wx.canvasToTempFilePath({
        canvasId: "maskExportCanvas",
        x: 0,
        y: 0,
        width,
        height,
        destWidth: width,
        destHeight: height,
        fileType: "png",
        quality: 1,
        success(response) {
          if (!response || !response.tempFilePath) {
            reject(new Error("mask 导出为空。"));
            return;
          }
          resolve(response.tempFilePath);
        },
        fail: reject
      }, page);
    });
  });
}

module.exports = {
  clamp,
  normalizeCircle,
  getProtectionRects,
  exportMaskFile
};
