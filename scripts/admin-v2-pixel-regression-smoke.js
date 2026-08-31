/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PNG = require("../cloudfunctions/api/node_modules/pngjs").PNG;
const jpeg = require("../cloudfunctions/api/node_modules/jpeg-js");
const regression = require("./admin-v2-pixel-regression");

const root = path.join(__dirname, "..");
const cli = path.join(__dirname, "admin-v2-pixel-regression.js");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-pixel-regression-"));

function makeImage(width, height, transform) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const color = transform(x, y);
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = color[3] === undefined ? 255 : color[3];
    }
  }
  return { width, height, data };
}

function writePng(filePath, image) {
  fs.writeFileSync(filePath, PNG.sync.write(image));
}

function writeJpeg(filePath, image) {
  fs.writeFileSync(filePath, jpeg.encode(image, 100).data);
}

try {
  const base = makeImage(4, 3, (x, y) => [20 + x * 10, 40 + y * 20, 80 + x + y, 255]);
  const changed = makeImage(4, 3, (x, y) => (
    x === 2 && y === 1 ? [220, 15, 30, 255] : [20 + x * 10, 40 + y * 20, 80 + x + y, 255]
  ));
  const enlarged = makeImage(8, 6, (x, y) => {
    const sourceX = Math.floor(x / 2);
    const sourceY = Math.floor(y / 2);
    return [20 + sourceX * 10, 40 + sourceY * 20, 80 + sourceX + sourceY, 255];
  });
  const referencePath = path.join(tempRoot, "reference.png");
  const actualPath = path.join(tempRoot, "actual.png");
  const jpegPath = path.join(tempRoot, "actual.jpg");
  const changedPath = path.join(tempRoot, "changed.png");
  const enlargedPath = path.join(tempRoot, "enlarged.png");
  const heatmapPath = path.join(tempRoot, "diff", "changed-heatmap.png");
  writePng(referencePath, base);
  writePng(actualPath, base);
  writeJpeg(jpegPath, base);
  writePng(changedPath, changed);
  writePng(enlargedPath, enlarged);

  const exact = regression.runRegression({
    actualPath,
    referencePath,
    threshold: 0,
    maxDiffRatio: 0,
  });
  assert.strictEqual(exact.pass, true, "相同 PNG 应通过");
  assert.strictEqual(exact.differentPixels, 0, "相同 PNG 不应产生差异像素");

  const jpegResult = regression.runRegression({
    actualPath: jpegPath,
    referencePath,
    threshold: 40,
    maxDiffRatio: 0.1,
  });
  assert.strictEqual(jpegResult.pass, true, "JPEG 与 PNG 的轻微编码误差应在阈值内");
  assert.strictEqual(jpegResult.referencePath, path.resolve(referencePath));

  const scaled = regression.runRegression({
    actualPath: enlargedPath,
    referencePath,
    threshold: 0,
    maxDiffRatio: 0,
  });
  assert.strictEqual(scaled.pass, true, "尺寸不同但内容对应的图片应归一化后通过");
  assert.strictEqual(scaled.scaled, true, "尺寸不同必须标记 scaled");

  const changedResult = regression.runRegression({
    actualPath: changedPath,
    referencePath,
    threshold: 0,
    maxDiffRatio: 0.05,
    outputPath: heatmapPath,
  });
  assert.strictEqual(changedResult.pass, false, "明显改变的像素必须失败");
  assert.strictEqual(changedResult.differentPixels, 1, "应精确识别一个差异像素");
  assert.ok(fs.existsSync(heatmapPath), "失败时应生成差异热图");
  assert.ok(fs.readFileSync(heatmapPath).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "差异热图必须是 PNG");

  const cliPass = cp.spawnSync(process.execPath, [
    cli,
    "--actual", actualPath,
    "--reference", referencePath,
    "--threshold", "0",
    "--max-diff-ratio", "0",
    "--label", "exact",
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(cliPass.status, 0, `CLI 相同图片应成功：${cliPass.stderr}`);
  assert.ok(cliPass.stdout.includes("PASS"), "CLI 输出必须包含 PASS");

  const cliFail = cp.spawnSync(process.execPath, [
    cli,
    "--actual", changedPath,
    "--reference", referencePath,
    "--threshold", "0",
    "--max-diff-ratio", "0",
    "--output", path.join(tempRoot, "cli-fail.png"),
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(cliFail.status, 1, `CLI 差异图片应返回 1：${cliFail.stdout}\n${cliFail.stderr}`);
  assert.ok(cliFail.stdout.includes("FAIL"), "CLI 输出必须包含 FAIL");

  console.log("admin-v2-pixel-regression-smoke: PASS (png/jpeg/resize/threshold/heatmap/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
