function acceptanceError(message, code, metrics) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  error.pixelProtectionMetrics = metrics;
  return error;
}

function ratio(count, total) {
  if (!total) return 0;
  return Number((count / total).toFixed(8));
}

function assertComparableImages(baseline, delivered) {
  if (
    !baseline
    || !delivered
    || Number(baseline.width) !== Number(delivered.width)
    || Number(baseline.height) !== Number(delivered.height)
    || !baseline.data
    || !delivered.data
    || baseline.data.length !== delivered.data.length
    || baseline.data.length !== baseline.width * baseline.height * 4
  ) {
    throw acceptanceError(
      "像素验收的两张图片尺寸或 RGBA 数据不一致。",
      "PIXEL_ACCEPTANCE_IMAGE_MISMATCH",
      null
    );
  }
}

function measurePixelChange(baseline, delivered, options = {}) {
  assertComparableImages(baseline, delivered);
  const threshold = Math.max(0, Number(options.threshold) || 5);
  const pixelCount = baseline.width * baseline.height;
  const alpha = options.editAlpha ? Buffer.from(options.editAlpha) : null;
  if (alpha && alpha.length !== pixelCount) {
    throw acceptanceError(
      "像素验收的 editAlpha 尺寸不正确。",
      "PIXEL_ACCEPTANCE_ALPHA_MISMATCH",
      null
    );
  }
  let exactMismatchCount = 0;
  let changedT5Count = 0;
  let supportCount = 0;
  let supportOutsideExactMismatchCount = 0;
  let supportOutsideChangedT5Count = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let maxDifference = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(baseline.data[offset + channel] - delivered.data[offset + channel])
      );
    }
    const exactMismatch = maxDifference > 0;
    const changedT5 = maxDifference > threshold;
    if (exactMismatch) exactMismatchCount += 1;
    if (changedT5) changedT5Count += 1;
    if (alpha && alpha[pixel] > 0) {
      supportCount += 1;
    } else if (alpha) {
      if (exactMismatch) supportOutsideExactMismatchCount += 1;
      if (changedT5) supportOutsideChangedT5Count += 1;
    }
  }
  const result = {
    width: baseline.width,
    height: baseline.height,
    totalPixels: pixelCount,
    threshold,
    exactMismatchCount,
    exactMismatchRatio: ratio(exactMismatchCount, pixelCount),
    changedT5Count,
    changedRatioT5: ratio(changedT5Count, pixelCount)
  };
  if (alpha) {
    Object.assign(result, {
      supportCount,
      supportCoverage: ratio(supportCount, pixelCount),
      supportOutsideCount: pixelCount - supportCount,
      supportOutsideExactMismatchCount,
      supportOutsideExactMismatchRatio: ratio(
        supportOutsideExactMismatchCount,
        pixelCount - supportCount
      ),
      supportOutsideChangedT5Count,
      supportOutsideChangedRatioT5: ratio(
        supportOutsideChangedT5Count,
        pixelCount - supportCount
      )
    });
  }
  return result;
}

function assertProtectedPixels(baseline, delivered, editAlpha, options = {}) {
  const label = String(options.label || "图片");
  const metrics = measurePixelChange(baseline, delivered, {
    editAlpha,
    threshold: options.threshold
  });
  if (metrics.supportOutsideExactMismatchCount !== 0) {
    throw acceptanceError(
      `${label}保护区发现 ${metrics.supportOutsideExactMismatchCount} 个像素被改动。`,
      String(options.outsideErrorCode || "PIXEL_PROTECTION_OUTSIDE_MISMATCH"),
      metrics
    );
  }
  if (metrics.changedT5Count > metrics.supportCount) {
    throw acceptanceError(
      `${label}整图变化像素超过允许的 edit support。`,
      String(options.coverageErrorCode || "PIXEL_PROTECTION_COVERAGE_EXCEEDED"),
      metrics
    );
  }
  return metrics;
}

module.exports = {
  acceptanceError,
  measurePixelChange,
  assertProtectedPixels
};
