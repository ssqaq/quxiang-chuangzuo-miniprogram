const assert = require("assert");
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");

process.env.WECHAT_MINIAPP_TEST = "1";

const codec = require("../lib/image-pixel-codec");
const composite = require("../lib/image-composite");
const acceptance = require("../lib/pixel-acceptance");
const flow = require("../lib/pixel-protection-flow");

function rgbaImage(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = pixel[0];
    data[offset + 1] = pixel[1];
    data[offset + 2] = pixel[2];
    data[offset + 3] = pixel.length > 3 ? pixel[3] : 255;
  }
  return { width, height, data };
}

function withExifOrientation(jpegBuffer, orientation) {
  const payload = Buffer.alloc(32);
  payload.write("Exif\u0000\u0000", 0, "ascii");
  const tiff = 6;
  payload.write("MM", tiff, "ascii");
  payload.writeUInt16BE(42, tiff + 2);
  payload.writeUInt32BE(8, tiff + 4);
  payload.writeUInt16BE(1, tiff + 8);
  payload.writeUInt16BE(0x0112, tiff + 10);
  payload.writeUInt16BE(3, tiff + 12);
  payload.writeUInt32BE(1, tiff + 14);
  payload.writeUInt16BE(orientation, tiff + 18);
  payload.writeUInt16BE(0, tiff + 20);
  payload.writeUInt32BE(0, tiff + 22);
  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  return Buffer.concat([jpegBuffer.subarray(0, 2), app1, jpegBuffer.subarray(2)]);
}

function testFormatsAndExif() {
  const png = new PNG({ width: 2, height: 2 });
  png.data = Buffer.from([
    1, 2, 3, 255,
    4, 5, 6, 255,
    7, 8, 9, 255,
    10, 11, 12, 255
  ]);
  const pngBuffer = PNG.sync.write(png);
  const decodedPng = codec.decodeImage(pngBuffer, { label: "PNG 测试" });
  assert.strictEqual(decodedPng.format, "png");
  assert.strictEqual(decodedPng.width, 2);
  assert.strictEqual(decodedPng.height, 2);
  assert.deepStrictEqual(Array.from(decodedPng.data), Array.from(png.data));

  const jpegSource = {
    width: 2,
    height: 1,
    data: Buffer.from([
      255, 0, 0, 255,
      0, 0, 255, 255
    ])
  };
  const encodedJpeg = Buffer.from(jpeg.encode(jpegSource, 100).data);
  const orientedJpeg = withExifOrientation(encodedJpeg, 6);
  assert.strictEqual(codec.readJpegOrientation(orientedJpeg), 6);
  const decodedJpeg = codec.decodeImage(orientedJpeg, { label: "EXIF 测试" });
  assert.strictEqual(decodedJpeg.width, 1);
  assert.strictEqual(decodedJpeg.height, 2);
  assert.strictEqual(decodedJpeg.orientation, 6);

  const webp = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WEBPVP8 ")
  ]);
  assert.throws(
    () => codec.decodeImage(webp, { label: "WebP 测试" }),
    (error) => error && error.code === "PIXEL_IMAGE_WEBP_UNSUPPORTED"
  );
}

function testEllipseProtection() {
  const baseline = rgbaImage(20, 20, [10, 20, 30, 255]);
  const generated = rgbaImage(20, 20, [210, 220, 230, 255]);
  const edit = composite.buildEllipseEditAlpha(20, 20, {
    x: 10,
    y: 10,
    width: 12,
    height: 8
  }, {
    featherPixels: 2
  });
  assert.strictEqual(edit.mode, "ellipse-inside");
  assert.strictEqual(edit.alpha[0], 0);
  assert.strictEqual(edit.alpha[10 * 20 + 10], 255);
  const delivered = composite.composeRgba(baseline, generated, edit.alpha);
  const metrics = acceptance.assertProtectedPixels(
    baseline,
    delivered,
    edit.alpha,
    { label: "普通版" }
  );
  assert.strictEqual(metrics.supportOutsideExactMismatchCount, 0);
  assert.ok(metrics.changedT5Count <= metrics.supportCount);
  assert.ok(metrics.supportCoverage > 0 && metrics.supportCoverage <= 0.2);

  const leaked = {
    width: delivered.width,
    height: delivered.height,
    data: Buffer.from(delivered.data)
  };
  leaked.data[0] += 1;
  assert.throws(
    () => acceptance.assertProtectedPixels(baseline, leaked, edit.alpha, {
      label: "普通版"
    }),
    (error) => (
      error
      && error.code === "PIXEL_PROTECTION_OUTSIDE_MISMATCH"
      && error.pixelProtectionMetrics.supportOutsideExactMismatchCount === 1
    )
  );
}

function testTencentRectProtection() {
  const baseline = rgbaImage(12, 12, [30, 40, 50, 255]);
  const lingyun = rgbaImage(12, 12, [130, 140, 150, 255]);
  const rects = [{ x: 4, y: 4, width: 4, height: 4 }];
  const beforeTencent = composite.buildRectProtectionEditAlpha(
    12,
    12,
    rects,
    { featherPixels: 2 }
  );
  assert.strictEqual(beforeTencent.mode, "rect-protection-outside");
  assert.strictEqual(beforeTencent.alpha[5 * 12 + 5], 0);
  assert.strictEqual(beforeTencent.alpha[0], 255);
  assert.ok(beforeTencent.alpha[5 * 12 + 3] > 0);
  assert.ok(beforeTencent.alpha[5 * 12 + 3] < 255);
  const intermediate = composite.composeRgba(
    baseline,
    lingyun,
    beforeTencent.alpha
  );
  const intermediateMetrics = acceptance.assertProtectedPixels(
    baseline,
    intermediate,
    beforeTencent.alpha,
    { label: "腾讯前置中间图" }
  );
  assert.strictEqual(intermediateMetrics.supportOutsideExactMismatchCount, 0);

  const tencent = rgbaImage(12, 12, [230, 200, 180, 255]);
  const afterTencent = composite.buildRectEditAlpha(
    12,
    12,
    rects,
    { featherPixels: 2 }
  );
  assert.strictEqual(afterTencent.mode, "rect-edit-inside");
  assert.strictEqual(afterTencent.alpha[0], 0);
  assert.ok(afterTencent.alpha[4 * 12 + 4] > 0);
  assert.ok(afterTencent.alpha[4 * 12 + 4] < 255);
  assert.strictEqual(afterTencent.alpha[5 * 12 + 5], 255);
  const finalImage = composite.composeRgba(
    intermediate,
    tencent,
    afterTencent.alpha
  );
  const finalMetrics = acceptance.assertProtectedPixels(
    intermediate,
    finalImage,
    afterTencent.alpha,
    { label: "腾讯后最终图" }
  );
  assert.strictEqual(finalMetrics.supportOutsideExactMismatchCount, 0);
  assert.ok(finalMetrics.changedT5Count <= finalMetrics.supportCount);
}

function testPngRoundTripAndSizeGate() {
  const source = rgbaImage(8, 8, [11, 22, 33, 255]);
  source.data[(3 * 8 + 4) * 4] = 199;
  const encoded = codec.encodePngRoundTrip(source, { label: "PNG 回环测试" });
  assert.ok(encoded.buffer.length > 0);
  assert.strictEqual(encoded.delivered.format, "png");
  assert.ok(Buffer.from(source.data).equals(Buffer.from(encoded.delivered.data)));
  assert.throws(
    () => codec.encodePngRoundTrip(source, {
      label: "PNG 大小测试",
      maxBytes: 1
    }),
    (error) => error && error.code === "PIXEL_PNG_TOO_LARGE"
  );
}

function testDimensionGate() {
  assert.throws(
    () => codec.assertSameDimensions(
      rgbaImage(2, 2, [0, 0, 0, 255]),
      rgbaImage(2, 3, [0, 0, 0, 255])
    ),
    (error) => error && error.code === "PIXEL_IMAGE_SIZE_MISMATCH"
  );
}

function testDimensionNormalization() {
  const main = rgbaImage(896, 1195, [15, 25, 35, 255]);
  const mask = rgbaImage(896, 1195, [255, 255, 255, 255]);
  const generated = rgbaImage(1085, 1450, [215, 205, 195, 255]);
  const mainPng = codec.encodePngRoundTrip(main, {
    label: "尺寸归一化主图"
  }).buffer;
  const maskPng = codec.encodePngRoundTrip(mask, {
    label: "尺寸归一化 mask"
  }).buffer;
  const generatedPng = codec.encodePngRoundTrip(generated, {
    label: "尺寸归一化模型图"
  }).buffer;
  const preflight = flow.preflightNormalAssets(
    mainPng,
    maskPng,
    { x: 448, y: 598, width: 320, height: 420 }
  );
  const protectedNormal = flow.protectNormalResult(preflight, generatedPng, {
    featherPixels: 8
  });
  assert.strictEqual(protectedNormal.delivered.width, 896);
  assert.strictEqual(protectedNormal.delivered.height, 1195);
  assert.strictEqual(
    protectedNormal.metrics.supportOutsideExactMismatchCount,
    0
  );
  assert.deepStrictEqual(
    protectedNormal.protection.dimensionNormalization,
    {
      resized: true,
      strategy: "isotropic-bilinear-to-baseline",
      sourceWidth: 1085,
      sourceHeight: 1450,
      targetWidth: 896,
      targetHeight: 1195,
      scaleW: 1085 / 896,
      scaleH: 1450 / 1195,
      anisotropy: Math.abs(1085 * 1195 - 1450 * 896)
        / Math.max(1085 * 1195, 1450 * 896),
      anisotropyThreshold: flow.MAX_GENERATED_ANISOTROPY,
      minScale: flow.MIN_GENERATED_SCALE,
      maxScale: flow.MAX_GENERATED_SCALE,
      maxEdge: flow.MAX_GENERATED_EDGE
    }
  );

  const protectedTencent = flow.protectTencentIntermediate(
    preflight.mainImage,
    generatedPng,
    [{ x: 320, y: 360, width: 256, height: 300 }],
    {
      featherPixels: 8,
      maxTencentBytes: 5 * 1024 * 1024
    }
  );
  assert.strictEqual(protectedTencent.delivered.width, 896);
  assert.strictEqual(protectedTencent.delivered.height, 1195);
  assert.strictEqual(
    protectedTencent.metrics.supportOutsideExactMismatchCount,
    0
  );
  assert.strictEqual(
    protectedTencent.protection.dimensionNormalization.resized,
    true
  );
  assert.strictEqual(
    protectedTencent.protection.dimensionNormalization.sourceWidth,
    1085
  );
  assert.strictEqual(
    protectedTencent.protection.dimensionNormalization.sourceHeight,
    1450
  );
}

function testDimensionNormalizationSafetyGates() {
  const baseline = rgbaImage(100, 100, [10, 20, 30, 255]);
  const withinLow = flow.normalizeGeneratedDimensions(
    baseline,
    rgbaImage(75, 75, [40, 50, 60, 255])
  );
  assert.strictEqual(withinLow.metadata.scaleW, 0.75);
  assert.strictEqual(withinLow.metadata.scaleH, 0.75);
  const withinHigh = flow.normalizeGeneratedDimensions(
    baseline,
    rgbaImage(150, 150, [40, 50, 60, 255])
  );
  assert.strictEqual(withinHigh.metadata.scaleW, 1.5);
  assert.strictEqual(withinHigh.metadata.scaleH, 1.5);
  const exactAnisotropyBoundary = flow.normalizeGeneratedDimensions(
    rgbaImage(10, 1000, [10, 20, 30, 255]),
    rgbaImage(10, 997, [40, 50, 60, 255])
  );
  assert.ok(
    exactAnisotropyBoundary.metadata.anisotropy
      <= flow.MAX_GENERATED_ANISOTROPY + Number.EPSILON
  );

  assert.throws(
    () => flow.normalizeGeneratedDimensions(
      rgbaImage(896, 1195, [10, 20, 30, 255]),
      rgbaImage(1024, 1536, [40, 50, 60, 255])
    ),
    (error) => error && error.code === "PIXEL_IMAGE_ASPECT_MISMATCH"
  );
  assert.throws(
    () => flow.normalizeGeneratedDimensions(
      baseline,
      rgbaImage(74, 74, [40, 50, 60, 255])
    ),
    (error) => error && error.code === "PIXEL_IMAGE_SCALE_OUT_OF_RANGE"
  );
  assert.throws(
    () => flow.normalizeGeneratedDimensions(
      baseline,
      rgbaImage(151, 151, [40, 50, 60, 255])
    ),
    (error) => error && error.code === "PIXEL_IMAGE_SCALE_OUT_OF_RANGE"
  );
  assert.throws(
    () => codec.assertDecodedImage({
      width: 8193,
      height: 1,
      data: Buffer.alloc(8193 * 4)
    }),
    (error) => error && error.code === "PIXEL_IMAGE_EDGE_TOO_LARGE"
  );
  assert.throws(
    () => codec.resizeDecodedImage(
      rgbaImage(2, 2, [40, 50, 60, 255]),
      8193,
      1
    ),
    (error) => error && error.code === "PIXEL_IMAGE_EDGE_TOO_LARGE"
  );
  assert.throws(
    () => codec.assertDecodedImage({
      width: 2049,
      height: 2049,
      data: Buffer.alloc(0)
    }),
    (error) => error && error.code === "PIXEL_IMAGE_TOO_LARGE"
  );
  assert.throws(
    () => codec.resizeDecodedImage(
      rgbaImage(2, 2, [40, 50, 60, 255]),
      2049,
      2049
    ),
    (error) => error && error.code === "PIXEL_IMAGE_TOO_LARGE"
  );

  const originalAllocUnsafe = Buffer.allocUnsafe;
  Buffer.allocUnsafe = () => {
    throw new Error("forced resize allocation failure");
  };
  try {
    assert.throws(
      () => codec.resizeDecodedImage(
        rgbaImage(2, 2, [40, 50, 60, 255]),
        3,
        3
      ),
      (error) => error && error.code === "PIXEL_IMAGE_RESIZE_FAILED"
    );
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
}

function testModelFlowGuards() {
  assert.deepStrictEqual(
    flow.assertSupportedImageEditFlow({
      provider: "星炬",
      model: "jw-gpt-image-2"
    }, "https://newapi.akiyo.fun/v1/images/edits/"),
    {
      provider: "星炬",
      model: "jw-gpt-image-2",
      pathname: "/v1/images/edits"
    }
  );
  assert.strictEqual(
    flow.assertSupportedImageEditFlow({
      provider: "XING_JU",
      model: "jw-gpt-image-2"
    }, "https://example.com/v1/images/edits").provider,
    "xingju"
  );
  assert.deepStrictEqual(
    flow.assertSupportedImageEditFlow({
      provider: "凌云",
      model: "gpt-image-2"
    }, "https://lingyunapi.xyz/v1/images/edits/"),
    {
      provider: "凌云",
      model: "gpt-image-2",
      pathname: "/v1/images/edits"
    }
  );
  assert.strictEqual(
    flow.assertSupportedImageEditFlow({
      provider: "LING_YUN",
      model: "gpt-image-2"
    }, "https://example.com/v1/images/edits").provider,
    "lingyun"
  );
  assert.throws(
    () => flow.assertSupportedImageEditFlow({
      provider: "tencent",
      model: "gpt-image-2"
    }, "https://example.com/v1/images/edits"),
    (error) => error && error.code === "PIXEL_MODEL_FLOW_PROVIDER_MISMATCH"
  );
  assert.throws(
    () => flow.assertSupportedImageEditFlow({
      provider: "xingju",
      model: "gpt-image-2"
    }, "https://example.com/v1/images/edits"),
    (error) => error && error.code === "PIXEL_MODEL_FLOW_MODEL_MISMATCH"
  );
  assert.throws(
    () => flow.assertSupportedImageEditFlow({
      provider: "lingyun",
      model: "wrong-model"
    }, "https://example.com/v1/images/edits"),
    (error) => error && error.code === "PIXEL_MODEL_FLOW_MODEL_MISMATCH"
  );
  assert.throws(
    () => flow.assertSupportedImageEditFlow({
      provider: "lingyun",
      model: "gpt-image-2"
    }, "https://example.com/v1/images/generations"),
    (error) => error && error.code === "PIXEL_MODEL_FLOW_ENDPOINT_MISMATCH"
  );
  assert.deepStrictEqual(
    flow.assertTencentFaceFusionFlow({
      action: "FuseFaceUltra",
      model: "FuseFaceUltra",
      endpoint: "https://facefusion.tencentcloudapi.com"
    }),
    {
      action: "FuseFaceUltra",
      model: "FuseFaceUltra",
      hostname: "facefusion.tencentcloudapi.com"
    }
  );
}

function testProtectionFlow() {
  const main = rgbaImage(16, 16, [10, 20, 30, 255]);
  const generated = rgbaImage(16, 16, [210, 220, 230, 255]);
  const mask = rgbaImage(16, 16, [255, 255, 255, 255]);
  const mainPng = codec.encodePngRoundTrip(main, { label: "流程主图" }).buffer;
  const maskPng = codec.encodePngRoundTrip(mask, { label: "流程 mask" }).buffer;
  const generatedPng = codec.encodePngRoundTrip(
    generated,
    { label: "流程生成图" }
  ).buffer;
  const preflight = flow.preflightNormalAssets(
    mainPng,
    maskPng,
    { x: 8, y: 8, width: 8, height: 8 }
  );
  const protectedNormal = flow.protectNormalResult(preflight, generatedPng, {
    featherPixels: 2
  });
  assert.strictEqual(protectedNormal.metrics.supportOutsideExactMismatchCount, 0);
  assert.strictEqual(protectedNormal.protection.version, 1);

  const intermediate = flow.protectTencentIntermediate(
    preflight.mainImage,
    generatedPng,
    [{ x: 5, y: 5, width: 6, height: 6 }],
    {
      featherPixels: 2,
      maxTencentBytes: 5 * 1024 * 1024
    }
  );
  assert.strictEqual(intermediate.metrics.supportOutsideExactMismatchCount, 0);
  const tencent = rgbaImage(16, 16, [120, 90, 80, 255]);
  const tencentPng = codec.encodePngRoundTrip(
    tencent,
    { label: "流程腾讯图" }
  ).buffer;
  const finalImage = flow.protectTencentFinal(
    intermediate.delivered,
    tencentPng,
    intermediate.protection.rects,
    {
      featherPixels: 2,
      originalImage: preflight.mainImage
    }
  );
  assert.strictEqual(finalImage.addedMetrics.supportOutsideExactMismatchCount, 0);
  assert.ok(finalImage.originalMetrics.changedRatioT5 >= 0);
  const mismatchedTencentPng = codec.encodePngRoundTrip(
    rgbaImage(16, 17, [120, 90, 80, 255]),
    { label: "腾讯尺寸不一致测试图" }
  ).buffer;
  assert.throws(
    () => flow.protectTencentFinal(
      intermediate.delivered,
      mismatchedTencentPng,
      intermediate.protection.rects,
      {
        featherPixels: 2,
        originalImage: preflight.mainImage
      }
    ),
    (error) => error && error.code === "PIXEL_IMAGE_SIZE_MISMATCH"
  );
  assert.deepStrictEqual(
    flow.restoreTencentProtectionState({
      pixelProtection: {
        version: 1,
        width: 16,
        height: 16,
        faceProtectionRects: intermediate.protection.rects
      },
      pixelProtectionMetrics: {
        imageEditIntermediate: intermediate.metrics
      }
    }, intermediate.delivered).rects,
    intermediate.protection.rects
  );
  assert.deepStrictEqual(
    flow.restoreTencentProtectionState({
      pixelProtection: {
        version: 1,
        width: 16,
        height: 16,
        faceProtectionRects: intermediate.protection.rects
      },
      pixelProtectionMetrics: {
        lingyunIntermediate: intermediate.metrics
      }
    }, intermediate.delivered).rects,
    intermediate.protection.rects,
    "旧任务的 lingyunIntermediate 字段必须继续兼容"
  );
  assert.throws(
    () => flow.restoreTencentProtectionState({}, intermediate.delivered),
    (error) => error && error.code === "TENCENT_RETRY_PIXEL_PROTECTION_MISSING"
  );
}

async function testPixelErrorsAndRefundChain() {
  const api = require("../index.js");
  const runtime = api.__test;
  const errorCodes = [
    "PIXEL_IMAGE_ASPECT_MISMATCH",
    "PIXEL_IMAGE_SCALE_OUT_OF_RANGE",
    "PIXEL_IMAGE_RESIZE_FAILED"
  ];
  errorCodes.forEach((code) => {
    const mapped = runtime.mapActionErrorResult(
      "generate",
      Object.assign(new Error(`forced ${code}`), {
        code,
        retryable: false
      }),
      `map-${code}`
    );
    assert.strictEqual(mapped.ok, false);
    assert.strictEqual(mapped.errorCode, code);
  });

  for (const code of errorCodes) {
    const callOrder = [];
    let persisted = false;
    let completed = false;
    const operation = {
      openid: "pixel-refund-user",
      requestId: `pixel-refund-${code}`,
      kind: "image",
      status: "processing",
      billing: { pointsCharged: 1 }
    };
    const result = await runtime.processQueuedGenerationOperation(operation, {
      resolveConfigs: async () => ({
        image: {},
        imageBackup: {},
        costs: {}
      }),
      execute: async () => {
        const error = new Error(`forced ${code}`);
        error.code = code;
        error.retryable = false;
        throw error;
      },
      findOperation: async () => operation,
      failOperation: async () => {
        callOrder.push("failed");
        return { status: "failed" };
      },
      refund: async () => {
        callOrder.push("refunded");
        return { status: "refunded" };
      },
      persistResult: async () => {
        persisted = true;
      },
      completeOperation: async () => {
        completed = true;
      },
      updateOperation: async () => operation,
      log: () => {}
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, code);
    assert.deepStrictEqual(callOrder, ["failed", "refunded"]);
    assert.strictEqual(persisted, false);
    assert.strictEqual(completed, false);
  }

  const pendingPatches = [];
  const refundFailureCode = "PIXEL_IMAGE_ASPECT_MISMATCH";
  const pendingResult = await runtime.processQueuedGenerationOperation({
    openid: "pixel-refund-pending-user",
    requestId: "pixel-refund-pending",
    kind: "image",
    status: "processing",
    billing: { pointsCharged: 1 }
  }, {
    resolveConfigs: async () => ({
      image: {},
      imageBackup: {},
      costs: {}
    }),
    execute: async () => {
      const error = new Error("forced aspect mismatch");
      error.code = refundFailureCode;
      error.retryable = false;
      throw error;
    },
    findOperation: async () => ({
      openid: "pixel-refund-pending-user",
      requestId: "pixel-refund-pending",
      kind: "image",
      status: "failed",
      billing: { pointsCharged: 1 }
    }),
    failOperation: async () => ({ status: "failed" }),
    refund: async () => {
      throw new Error("forced refund failure");
    },
    updateOperation: async (_openid, _requestId, patch) => {
      pendingPatches.push(patch);
      return Object.assign({ status: "failed" }, patch);
    },
    log: () => {}
  });
  assert.strictEqual(pendingResult.ok, false);
  assert.strictEqual(pendingResult.errorCode, refundFailureCode);
  assert.strictEqual(pendingPatches.length, 1);
  assert.strictEqual(pendingPatches[0].refundPending, true);
}

async function main() {
  testFormatsAndExif();
  testEllipseProtection();
  testTencentRectProtection();
  testPngRoundTripAndSizeGate();
  testDimensionGate();
  testDimensionNormalization();
  testDimensionNormalizationSafetyGates();
  testModelFlowGuards();
  testProtectionFlow();
  await testPixelErrorsAndRefundChain();
  console.log("像素保护基础模块测试通过。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
