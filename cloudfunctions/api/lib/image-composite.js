function compositeError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function assertImage(image, label) {
  const width = Number(image && image.width);
  const height = Number(image && image.height);
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 1
    || height < 1
    || !image.data
    || image.data.length !== width * height * 4
  ) {
    throw compositeError(`${label || "图片"} RGBA 数据无效。`, "PIXEL_COMPOSITE_IMAGE_INVALID");
  }
}

function normalizeEllipseGeometry(geometry, imageWidth, imageHeight) {
  const width = Number(imageWidth);
  const height = Number(imageHeight);
  const centerX = Number(geometry && geometry.x);
  const centerY = Number(geometry && geometry.y);
  const ellipseWidth = Number(geometry && geometry.width);
  const ellipseHeight = Number(geometry && geometry.height);
  if (
    !Number.isFinite(centerX)
    || !Number.isFinite(centerY)
    || !Number.isFinite(ellipseWidth)
    || !Number.isFinite(ellipseHeight)
    || ellipseWidth < 1
    || ellipseHeight < 1
  ) {
    throw compositeError("红圈椭圆参数无效，请重新圈选。", "PIXEL_ELLIPSE_INVALID");
  }
  const left = clamp(centerX - ellipseWidth / 2, 0, width);
  const top = clamp(centerY - ellipseHeight / 2, 0, height);
  const right = clamp(centerX + ellipseWidth / 2, 0, width);
  const bottom = clamp(centerY + ellipseHeight / 2, 0, height);
  if (right - left < 1 || bottom - top < 1) {
    throw compositeError("红圈椭圆没有有效面积，请重新圈选。", "PIXEL_ELLIPSE_EMPTY");
  }
  return {
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
    left,
    top,
    right,
    bottom
  };
}

function ellipseFeatherPixels(ellipse) {
  const minRadius = Math.min(ellipse.width, ellipse.height) / 2;
  return Math.max(1, Math.min(24, Math.round(minRadius * 0.06)));
}

function buildEllipseEditAlpha(width, height, geometry, options = {}) {
  const ellipse = normalizeEllipseGeometry(geometry, width, height);
  const radiusX = ellipse.width / 2;
  const radiusY = ellipse.height / 2;
  const minRadius = Math.min(radiusX, radiusY);
  const featherPixels = Math.max(
    0,
    Number.isFinite(Number(options.featherPixels))
      ? Number(options.featherPixels)
      : ellipseFeatherPixels(ellipse)
  );
  const alpha = Buffer.alloc(width * height);
  const startX = Math.max(0, Math.floor(ellipse.left));
  const endX = Math.min(width, Math.ceil(ellipse.right));
  const startY = Math.max(0, Math.floor(ellipse.top));
  const endY = Math.min(height, Math.ceil(ellipse.bottom));
  for (let y = startY; y < endY; y += 1) {
    const normalizedY = (y + 0.5 - ellipse.y) / radiusY;
    for (let x = startX; x < endX; x += 1) {
      const normalizedX = (x + 0.5 - ellipse.x) / radiusX;
      const radius = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
      if (radius >= 1) continue;
      const inwardDistance = (1 - radius) * minRadius;
      const value = featherPixels > 0
        ? Math.max(1, Math.min(255, Math.round(inwardDistance / featherPixels * 255)))
        : 255;
      alpha[y * width + x] = value;
    }
  }
  return {
    alpha,
    geometry: ellipse,
    featherPixels,
    mode: "ellipse-inside"
  };
}

function normalizeRects(rects, width, height) {
  const result = [];
  (Array.isArray(rects) ? rects : []).forEach((rect) => {
    const x = Number(rect && rect.x);
    const y = Number(rect && rect.y);
    const rectWidth = Number(rect && rect.width);
    const rectHeight = Number(rect && rect.height);
    if (![x, y, rectWidth, rectHeight].every(Number.isFinite)) return;
    const left = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const top = Math.max(0, Math.min(height - 1, Math.floor(y)));
    const right = Math.max(left + 1, Math.min(width, Math.ceil(x + rectWidth)));
    const bottom = Math.max(top + 1, Math.min(height, Math.ceil(y + rectHeight)));
    if (right <= left || bottom <= top) return;
    result.push({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      left,
      top,
      right,
      bottom
    });
  });
  if (!result.length) {
    throw compositeError("人脸保护矩形为空。", "PIXEL_FACE_RECTS_EMPTY");
  }
  return result;
}

function rectFeatherPixels(rects) {
  const minimumEdge = rects.reduce(
    (value, rect) => Math.min(value, rect.width, rect.height),
    Number.POSITIVE_INFINITY
  );
  return Math.max(1, Math.min(24, Math.round(minimumEdge * 0.06)));
}

function buildRectProtectionEditAlpha(width, height, sourceRects, options = {}) {
  const rects = normalizeRects(sourceRects, width, height);
  const featherPixels = Math.max(
    0,
    Number.isFinite(Number(options.featherPixels))
      ? Number(options.featherPixels)
      : rectFeatherPixels(rects)
  );
  const alpha = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 255;
      for (const rect of rects) {
        if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
          value = 0;
          break;
        }
        if (featherPixels <= 0) continue;
        const dx = x < rect.left
          ? rect.left - x
          : x >= rect.right
            ? x - rect.right + 1
            : 0;
        const dy = y < rect.top
          ? rect.top - y
          : y >= rect.bottom
            ? y - rect.bottom + 1
            : 0;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= featherPixels) {
          value = Math.min(value, Math.max(1, Math.round(distance / featherPixels * 255)));
        }
      }
      alpha[y * width + x] = value;
    }
  }
  return {
    alpha,
    rects,
    featherPixels,
    mode: "rect-protection-outside"
  };
}

function buildRectEditAlpha(width, height, sourceRects, options = {}) {
  const rects = normalizeRects(sourceRects, width, height);
  const featherPixels = Math.max(
    0,
    Number.isFinite(Number(options.featherPixels))
      ? Number(options.featherPixels)
      : rectFeatherPixels(rects)
  );
  const alpha = Buffer.alloc(width * height);
  for (const rect of rects) {
    for (let y = rect.top; y < rect.bottom; y += 1) {
      for (let x = rect.left; x < rect.right; x += 1) {
        const inwardDistance = Math.min(
          x - rect.left + 1,
          rect.right - x,
          y - rect.top + 1,
          rect.bottom - y
        );
        const value = featherPixels > 0
          ? Math.max(1, Math.min(255, Math.round(inwardDistance / featherPixels * 255)))
          : 255;
        const index = y * width + x;
        if (value > alpha[index]) alpha[index] = value;
      }
    }
  }
  return {
    alpha,
    rects,
    featherPixels,
    mode: "rect-edit-inside"
  };
}

function composeRgba(protectionBase, modelImage, editAlpha) {
  assertImage(protectionBase, "保护基准图");
  assertImage(modelImage, "模型结果图");
  if (
    protectionBase.width !== modelImage.width
    || protectionBase.height !== modelImage.height
  ) {
    throw compositeError("保护基准图与模型结果图尺寸不一致。", "PIXEL_IMAGE_SIZE_MISMATCH");
  }
  const pixelCount = protectionBase.width * protectionBase.height;
  const alpha = Buffer.from(editAlpha || []);
  if (alpha.length !== pixelCount) {
    throw compositeError("本地 editAlpha 尺寸不正确。", "PIXEL_ALPHA_SIZE_MISMATCH");
  }
  const baseData = Buffer.from(protectionBase.data);
  const modelData = Buffer.from(modelImage.data);
  const output = Buffer.alloc(pixelCount * 4);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const value = alpha[pixel];
    const offset = pixel * 4;
    if (value === 0) {
      baseData.copy(output, offset, offset, offset + 4);
      continue;
    }
    if (value === 255) {
      modelData.copy(output, offset, offset, offset + 4);
      continue;
    }
    for (let channel = 0; channel < 4; channel += 1) {
      const base = protectionBase.data[offset + channel];
      const generated = modelImage.data[offset + channel];
      output[offset + channel] = Math.round(
        (base * (255 - value) + generated * value) / 255
      );
    }
  }
  return {
    data: output,
    width: protectionBase.width,
    height: protectionBase.height,
    format: "rgba"
  };
}

module.exports = {
  compositeError,
  normalizeEllipseGeometry,
  ellipseFeatherPixels,
  buildEllipseEditAlpha,
  normalizeRects,
  rectFeatherPixels,
  buildRectProtectionEditAlpha,
  buildRectEditAlpha,
  composeRgba
};
