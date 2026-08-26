const assert = require("assert");
const jpeg = require("jpeg-js");
const { PNG } = require("pngjs");

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
  const generated = rgbaImage(1024, 1536, [215, 205, 195, 255]);
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
      strategy: "stretch-to-baseline",
      sourceWidth: 1024,
      sourceHeight: 1536,
      targetWidth: 896,
      targetHeight: 1195
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
    1024
  );
  assert.strictEqual(
    protectedTencent.protection.dimensionNormalization.sourceHeight,
    1536
  );
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

testFormatsAndExif();
testEllipseProtection();
testTencentRectProtection();
testPngRoundTripAndSizeGate();
testDimensionGate();
testDimensionNormalization();
testModelFlowGuards();
testProtectionFlow();

console.log("像素保护基础模块测试通过。");
