const codec = require("./image-pixel-codec");
const composite = require("./image-composite");
const acceptance = require("./pixel-acceptance");

const PIXEL_PROTECTION_VERSION = 1;

function flowError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

function normalizedProvider(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function assertLingyunImageEditFlow(imageConfig, resolvedUrl) {
  const provider = normalizedProvider(imageConfig && imageConfig.provider);
  const model = String(imageConfig && imageConfig.model || "").trim();
  let pathname = "";
  try {
    pathname = new URL(String(resolvedUrl || "")).pathname.replace(/\/+$/, "") || "/";
  } catch (_) {
    throw flowError(
      "凌云图片编辑 endpoint 无效，已停止调用。",
      "PIXEL_MODEL_FLOW_ENDPOINT_INVALID"
    );
  }
  if (provider !== "lingyun" && provider !== "凌云") {
    throw flowError(
      `普通版和腾讯第一阶段只允许凌云，当前 provider=${imageConfig && imageConfig.provider || "空"}。`,
      "PIXEL_MODEL_FLOW_PROVIDER_MISMATCH"
    );
  }
  if (model !== "gpt-image-2") {
    throw flowError(
      `普通版和腾讯第一阶段模型必须是 gpt-image-2，当前 model=${model || "空"}。`,
      "PIXEL_MODEL_FLOW_MODEL_MISMATCH"
    );
  }
  if (pathname !== "/v1/images/edits") {
    throw flowError(
      `普通版和腾讯第一阶段 endpoint 必须是 /v1/images/edits，当前 pathname=${pathname}。`,
      "PIXEL_MODEL_FLOW_ENDPOINT_MISMATCH"
    );
  }
  return {
    provider: provider === "凌云" ? "凌云" : "lingyun",
    model,
    pathname
  };
}

function assertTencentFaceFusionFlow(config) {
  const action = String(config && config.action || "").trim();
  const model = String(config && config.model || "").trim();
  const allowTestEndpoint = Boolean(
    config
    && config.allowTestEndpoint === true
    && process.env.WECHAT_MINIAPP_TEST === "1"
  );
  let hostname = "";
  try {
    hostname = new URL(String(config && config.endpoint || "")).hostname.toLowerCase();
  } catch (_) {
    throw flowError(
      "腾讯人脸融合 endpoint 无效，已停止调用。",
      "PIXEL_TENCENT_FLOW_ENDPOINT_INVALID"
    );
  }
  if (action !== "FuseFaceUltra" || model !== "FuseFaceUltra") {
    throw flowError(
      `腾讯第二阶段必须使用 FuseFaceUltra，当前 action=${action || "空"}，model=${model || "空"}。`,
      "PIXEL_TENCENT_FLOW_MODEL_MISMATCH"
    );
  }
  if (hostname !== "facefusion.tencentcloudapi.com" && !allowTestEndpoint) {
    throw flowError(
      `腾讯第二阶段 endpoint 不正确，当前 host=${hostname || "空"}。`,
      "PIXEL_TENCENT_FLOW_ENDPOINT_MISMATCH"
    );
  }
  return { action, model, hostname };
}

function preflightNormalAssets(mainBuffer, maskBuffer, maskGeometry, options = {}) {
  const mainImage = codec.decodeImage(mainBuffer, {
    label: "普通版主图",
    maxPixels: options.maxPixels
  });
  const maskImage = codec.decodeImage(maskBuffer, {
    label: "普通版 mask",
    allowedFormats: ["png"],
    maxPixels: options.maxPixels
  });
  codec.assertSameDimensions(mainImage, maskImage, {
    leftLabel: "普通版主图",
    rightLabel: "普通版 mask"
  });
  const geometry = composite.normalizeEllipseGeometry(
    maskGeometry,
    mainImage.width,
    mainImage.height
  );
  return {
    mainBuffer: Buffer.from(mainBuffer),
    maskBuffer: Buffer.from(maskBuffer),
    mainImage,
    maskImage,
    geometry
  };
}

function preflightTencentAssets(mainBuffer, faceBuffer, options = {}) {
  const mainImage = codec.decodeImage(mainBuffer, {
    label: "腾讯版主图",
    maxPixels: options.maxPixels
  });
  const faceImage = codec.decodeImage(faceBuffer, {
    label: "腾讯版参考脸",
    maxPixels: options.maxPixels
  });
  const maxTencentBytes = Number(options.maxTencentBytes) || 0;
  if (maxTencentBytes > 0 && Buffer.from(faceBuffer).length > maxTencentBytes) {
    throw flowError(
      `腾讯版参考脸为 ${(Buffer.from(faceBuffer).length / 1024 / 1024).toFixed(2)}MB，`
      + `超过 ${(maxTencentBytes / 1024 / 1024).toFixed(2)}MB 限制。`,
      "TENCENT_FACEFUSION_IMAGE_TOO_LARGE"
    );
  }
  return {
    mainBuffer: Buffer.from(mainBuffer),
    faceBuffer: Buffer.from(faceBuffer),
    mainImage,
    faceImage
  };
}

function protectNormalResult(preflight, generatedBuffer, options = {}) {
  if (!preflight || !preflight.mainImage || !preflight.geometry) {
    throw flowError("普通版像素保护预检结果缺失。", "PIXEL_NORMAL_PREFLIGHT_MISSING");
  }
  const generatedImage = codec.decodeImage(generatedBuffer, {
    label: "普通版凌云结果",
    maxPixels: options.maxPixels
  });
  codec.assertSameDimensions(preflight.mainImage, generatedImage, {
    leftLabel: "普通版主图",
    rightLabel: "普通版凌云结果"
  });
  const edit = composite.buildEllipseEditAlpha(
    preflight.mainImage.width,
    preflight.mainImage.height,
    preflight.geometry,
    { featherPixels: options.featherPixels }
  );
  const composed = composite.composeRgba(
    preflight.mainImage,
    generatedImage,
    edit.alpha
  );
  const encoded = codec.encodePngRoundTrip(composed, {
    label: "普通版最终图",
    maxPixels: options.maxPixels
  });
  const metrics = acceptance.assertProtectedPixels(
    preflight.mainImage,
    encoded.delivered,
    edit.alpha,
    {
      label: "普通版最终图",
      outsideErrorCode: "PIXEL_NORMAL_OUTSIDE_MISMATCH",
      coverageErrorCode: "PIXEL_NORMAL_COVERAGE_EXCEEDED"
    }
  );
  return {
    buffer: encoded.buffer,
    delivered: encoded.delivered,
    metrics,
    protection: {
      version: PIXEL_PROTECTION_VERSION,
      mode: edit.mode,
      geometry: edit.geometry,
      featherPixels: edit.featherPixels,
      outputBytes: encoded.bytes,
      compression: encoded.compression
    }
  };
}

function protectTencentIntermediate(mainImage, generatedBuffer, rects, options = {}) {
  const generatedImage = codec.decodeImage(generatedBuffer, {
    label: "腾讯版凌云中间结果",
    maxPixels: options.maxPixels
  });
  codec.assertSameDimensions(mainImage, generatedImage, {
    leftLabel: "腾讯版主图",
    rightLabel: "腾讯版凌云中间结果"
  });
  const edit = composite.buildRectProtectionEditAlpha(
    mainImage.width,
    mainImage.height,
    rects,
    { featherPixels: options.featherPixels }
  );
  const composed = composite.composeRgba(mainImage, generatedImage, edit.alpha);
  const encoded = codec.encodePngRoundTrip(composed, {
    label: "腾讯版已验收中间图",
    maxBytes: options.maxTencentBytes,
    maxPixels: options.maxPixels
  });
  const metrics = acceptance.assertProtectedPixels(
    mainImage,
    encoded.delivered,
    edit.alpha,
    {
      label: "腾讯版凌云中间图",
      outsideErrorCode: "PIXEL_TENCENT_INTERMEDIATE_FACE_MISMATCH",
      coverageErrorCode: "PIXEL_TENCENT_INTERMEDIATE_COVERAGE_EXCEEDED"
    }
  );
  return {
    buffer: encoded.buffer,
    delivered: encoded.delivered,
    metrics,
    protection: {
      version: PIXEL_PROTECTION_VERSION,
      mode: edit.mode,
      rects: edit.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
      featherPixels: edit.featherPixels,
      width: mainImage.width,
      height: mainImage.height,
      outputBytes: encoded.bytes,
      compression: encoded.compression
    }
  };
}

function protectTencentFinal(intermediateImage, tencentBuffer, rects, options = {}) {
  const tencentImage = codec.decodeImage(tencentBuffer, {
    label: "腾讯 FuseFaceUltra 结果",
    maxPixels: options.maxPixels
  });
  codec.assertSameDimensions(intermediateImage, tencentImage, {
    leftLabel: "已验收凌云中间图",
    rightLabel: "腾讯 FuseFaceUltra 结果"
  });
  const edit = composite.buildRectEditAlpha(
    intermediateImage.width,
    intermediateImage.height,
    rects,
    { featherPixels: options.featherPixels }
  );
  const composed = composite.composeRgba(intermediateImage, tencentImage, edit.alpha);
  const encoded = codec.encodePngRoundTrip(composed, {
    label: "腾讯版最终图",
    maxPixels: options.maxPixels
  });
  const addedMetrics = acceptance.assertProtectedPixels(
    intermediateImage,
    encoded.delivered,
    edit.alpha,
    {
      label: "腾讯版最终图",
      outsideErrorCode: "PIXEL_TENCENT_FINAL_OUTSIDE_MISMATCH",
      coverageErrorCode: "PIXEL_TENCENT_FINAL_COVERAGE_EXCEEDED"
    }
  );
  const originalMetrics = options.originalImage
    ? acceptance.measurePixelChange(options.originalImage, encoded.delivered)
    : null;
  return {
    buffer: encoded.buffer,
    delivered: encoded.delivered,
    addedMetrics,
    originalMetrics,
    protection: {
      version: PIXEL_PROTECTION_VERSION,
      mode: edit.mode,
      rects: edit.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
      featherPixels: edit.featherPixels,
      width: intermediateImage.width,
      height: intermediateImage.height,
      outputBytes: encoded.bytes,
      compression: encoded.compression
    }
  };
}

function restoreTencentProtectionState(operation, image) {
  const source = operation && operation.pixelProtection;
  const metrics = operation && operation.pixelProtectionMetrics;
  if (
    !source
    || Number(source.version) !== PIXEL_PROTECTION_VERSION
    || !Array.isArray(source.faceProtectionRects)
    || !source.faceProtectionRects.length
    || !metrics
    || !metrics.lingyunIntermediate
  ) {
    throw flowError(
      "旧中间图缺少已验收的人脸保护数据，不能安全重试腾讯换脸。",
      "TENCENT_RETRY_PIXEL_PROTECTION_MISSING"
    );
  }
  if (
    Number(source.width) !== Number(image && image.width)
    || Number(source.height) !== Number(image && image.height)
  ) {
    throw flowError(
      "腾讯重试的中间图尺寸与已保存保护数据不一致。",
      "TENCENT_RETRY_PIXEL_PROTECTION_SIZE_MISMATCH"
    );
  }
  const rects = composite.normalizeRects(
    source.faceProtectionRects,
    image.width,
    image.height
  ).map(({ x, y, width, height }) => ({ x, y, width, height }));
  return {
    rects,
    metrics,
    width: image.width,
    height: image.height,
    version: PIXEL_PROTECTION_VERSION
  };
}

module.exports = {
  PIXEL_PROTECTION_VERSION,
  normalizedProvider,
  assertLingyunImageEditFlow,
  assertTencentFaceFusionFlow,
  preflightNormalAssets,
  preflightTencentAssets,
  protectNormalResult,
  protectTencentIntermediate,
  protectTencentFinal,
  restoreTencentProtectionState
};
