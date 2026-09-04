/* eslint-disable no-console */

const assert = require("assert");
const { blockSsim, compareRgba } = require("./user-center-visual-diff");

function image(width, height, fill) {
  const data = Buffer.alloc(width * height * 4, fill);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return data;
}

function passes(metrics, thresholds) {
  return metrics.changedPixelRatio <= thresholds.changedPixelRatio
    && metrics.mae <= thresholds.mae
    && metrics.maxDelta <= thresholds.maxDelta
    && metrics.ssim >= thresholds.ssim;
}

function main() {
  const width = 4;
  const height = 4;
  const baseline = image(width, height, 240);
  const same = Buffer.from(baseline);
  const identical = compareRgba(baseline, same, width, height, 0);
  assert.strictEqual(identical.metrics.rawChangedPixels, 0);
  assert.strictEqual(identical.metrics.changedPixels, 0);
  assert.strictEqual(identical.metrics.mae, 0);
  assert.strictEqual(identical.metrics.maxDelta, 0);
  assert.strictEqual(identical.metrics.ssim, 1);
  assert.strictEqual(identical.images.diff.length, baseline.length);

  const changed = Buffer.from(baseline);
  changed[0] = 0;
  const onePixel = compareRgba(baseline, changed, width, height, 0);
  assert.strictEqual(onePixel.metrics.rawChangedPixels, 1);
  assert.strictEqual(onePixel.metrics.changedPixels, 1);
  assert.strictEqual(onePixel.metrics.maxDelta, 240);
  assert.ok(onePixel.metrics.changedPixelRatio > 0 && onePixel.metrics.changedPixelRatio < 1);
  assert.ok(onePixel.metrics.ssim < 1);

  const ciThresholds = {
    pixelDelta: 4,
    changedPixelRatio: 0.005,
    mae: 0.5,
    maxDelta: 128,
    ssim: 0.999
  };
  const antiAliasBaseline = image(100, 100, 240);
  const antiAliased = Buffer.from(antiAliasBaseline);
  antiAliased[0] -= 4;
  antiAliased[1] -= 3;
  antiAliased[2] -= 2;
  const antiAliasResult = compareRgba(
    antiAliasBaseline,
    antiAliased,
    100,
    100,
    ciThresholds.pixelDelta
  );
  assert.strictEqual(antiAliasResult.metrics.changedPixels, 0);
  assert.strictEqual(passes(antiAliasResult.metrics, ciThresholds), true);

  const layoutBaseline = image(100, 100, 240);
  const shiftedLayout = Buffer.from(layoutBaseline);
  for (let y = 0; y < 100; y += 1) {
    for (let x = 40; x < 42; x += 1) {
      const offset = (y * 100 + x) * 4;
      shiftedLayout[offset] = 80;
      shiftedLayout[offset + 1] = 80;
      shiftedLayout[offset + 2] = 80;
    }
  }
  const layoutResult = compareRgba(
    layoutBaseline,
    shiftedLayout,
    100,
    100,
    ciThresholds.pixelDelta
  );
  assert.ok(layoutResult.metrics.changedPixelRatio > ciThresholds.changedPixelRatio);
  assert.strictEqual(passes(layoutResult.metrics, ciThresholds), false);

  assert.throws(() => compareRgba(baseline, Buffer.alloc(3), width, height, 0), /长度不一致/);
  assert.strictEqual(blockSsim(baseline, same, width, height), 1);
  console.log("user-center visual diff smoke: OK");
}

main();
