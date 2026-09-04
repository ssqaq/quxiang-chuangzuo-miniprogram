/* eslint-disable no-console */

const assert = require("assert");
const { blockSsim, compareRgba } = require("./user-center-visual-diff");

function image(width, height, fill) {
  const data = Buffer.alloc(width * height * 4, fill);
  for (let index = 3; index < data.length; index += 4) data[index] = 255;
  return data;
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

  assert.throws(() => compareRgba(baseline, Buffer.alloc(3), width, height, 0), /长度不一致/);
  assert.strictEqual(blockSsim(baseline, same, width, height), 1);
  console.log("user-center visual diff smoke: OK");
}

main();
