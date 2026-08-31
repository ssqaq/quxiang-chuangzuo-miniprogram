/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const DEFAULT_THRESHOLD = 16;
const DEFAULT_MAX_DIFF_RATIO = 0.05;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function loadCodec(name) {
  try {
    return require(name);
  } catch (error) {
    const fallback = path.join(__dirname, "..", "cloudfunctions", "api", "node_modules", name);
    try {
      return require(fallback);
    } catch (fallbackError) {
      const message = `${name} 依赖不可用，请先安装 cloudfunctions/api 的依赖。`;
      const wrapped = new Error(message);
      wrapped.code = "PIXEL_DEPENDENCY_MISSING";
      wrapped.cause = error;
      throw wrapped;
    }
  }
}

function isPng(buffer) {
  return buffer.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.equals(buffer.subarray(0, PNG_SIGNATURE.length));
}

function decodeImage(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    const error = new Error(`图片不存在：${resolved}`);
    error.code = "PIXEL_IMAGE_NOT_FOUND";
    throw error;
  }
  const buffer = fs.readFileSync(resolved);
  if (isPng(buffer)) {
    const PNG = loadCodec("pngjs").PNG;
    const decoded = PNG.sync.read(buffer);
    return {
      path: resolved,
      format: "png",
      width: decoded.width,
      height: decoded.height,
      data: Buffer.from(decoded.data),
    };
  }
  try {
    const jpeg = loadCodec("jpeg-js").decode(buffer, { useTArray: true });
    if (!jpeg || !jpeg.width || !jpeg.height || !jpeg.data) throw new Error("JPEG 解码结果为空");
    return {
      path: resolved,
      format: "jpeg",
      width: jpeg.width,
      height: jpeg.height,
      data: Buffer.from(jpeg.data),
    };
  } catch (error) {
    const wrapped = new Error(`不支持的图片格式或图片损坏：${resolved}`);
    wrapped.code = "PIXEL_IMAGE_DECODE_FAILED";
    wrapped.cause = error;
    throw wrapped;
  }
}

function pixelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function resizeNearest(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const source = pixelIndex(image.width, sourceX, sourceY);
      const target = pixelIndex(width, x, y);
      data[target] = image.data[source];
      data[target + 1] = image.data[source + 1];
      data[target + 2] = image.data[source + 2];
      data[target + 3] = image.data[source + 3];
    }
  }
  return Object.assign({}, image, { width, height, data });
}

function compareImages(actual, reference, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Math.max(0, Number(options.threshold))
    : DEFAULT_THRESHOLD;
  const width = reference.width;
  const height = reference.height;
  const normalizedActual = resizeNearest(actual, width, height);
  const normalizedReference = resizeNearest(reference, width, height);
  const heatmap = Buffer.alloc(width * height * 4);
  let differentPixels = 0;
  let sumMaxChannelDiff = 0;
  let maxChannelDiff = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = pixelIndex(width, x, y);
      const maxDiff = Math.max(
        Math.abs(normalizedActual.data[offset] - normalizedReference.data[offset]),
        Math.abs(normalizedActual.data[offset + 1] - normalizedReference.data[offset + 1]),
        Math.abs(normalizedActual.data[offset + 2] - normalizedReference.data[offset + 2]),
        Math.abs(normalizedActual.data[offset + 3] - normalizedReference.data[offset + 3])
      );
      sumMaxChannelDiff += maxDiff;
      maxChannelDiff = Math.max(maxChannelDiff, maxDiff);
      if (maxDiff > threshold) {
        differentPixels += 1;
        heatmap[offset] = 255;
        heatmap[offset + 1] = Math.max(0, 64 - Math.min(64, Math.floor(maxDiff / 4)));
        heatmap[offset + 2] = 0;
        heatmap[offset + 3] = 255;
      } else {
        heatmap[offset] = 0;
        heatmap[offset + 1] = 0;
        heatmap[offset + 2] = 0;
        heatmap[offset + 3] = 0;
      }
    }
  }

  const totalPixels = width * height;
  return {
    width,
    height,
    scaled: actual.width !== width || actual.height !== height,
    sourceWidth: actual.width,
    sourceHeight: actual.height,
    threshold,
    totalPixels,
    differentPixels,
    diffRatio: totalPixels ? differentPixels / totalPixels : 0,
    meanMaxChannelDiff: totalPixels ? sumMaxChannelDiff / totalPixels : 0,
    maxChannelDiff,
    heatmap,
  };
}

function writeHeatmap(summary, outputPath) {
  if (!outputPath) return null;
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const PNG = loadCodec("pngjs").PNG;
  const encoded = PNG.sync.write({
    width: summary.width,
    height: summary.height,
    data: summary.heatmap,
  });
  fs.writeFileSync(resolved, encoded);
  return resolved;
}

function runRegression(options = {}) {
  if (!options.actualPath || !options.referencePath) {
    const error = new Error("必须提供 --actual 和 --reference。");
    error.code = "PIXEL_ARGUMENT_MISSING";
    throw error;
  }
  const actual = decodeImage(options.actualPath);
  const reference = decodeImage(options.referencePath);
  const summary = compareImages(actual, reference, options);
  const maxDiffRatio = Number.isFinite(Number(options.maxDiffRatio))
    ? Math.max(0, Number(options.maxDiffRatio))
    : DEFAULT_MAX_DIFF_RATIO;
  summary.maxDiffRatio = maxDiffRatio;
  summary.pass = summary.diffRatio <= maxDiffRatio;
  summary.actualPath = actual.path;
  summary.referencePath = reference.path;
  summary.heatmapPath = writeHeatmap(summary, options.outputPath);
  return summary;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (key === "help") {
      result.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function printUsage() {
  console.log([
    "用法：node scripts/admin-v2-pixel-regression.js --actual <截图> --reference <参考图>",
    "      [--output <差异热图.png>] [--threshold 16] [--max-diff-ratio 0.05] [--label <名称>]",
    "支持 PNG/JPEG。尺寸不一致时按参考图尺寸做最近邻归一化；差异超过 threshold 的像素计入比例。",
  ].join("\n"));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help || !options.actual || !options.reference) {
    printUsage();
    return options.help ? 0 : 2;
  }
  try {
    const summary = runRegression({
      actualPath: options.actual,
      referencePath: options.reference,
      outputPath: options.output,
      threshold: options.threshold,
      maxDiffRatio: options.maxDiffRatio,
    });
    const label = options.label ? ` [${options.label}]` : "";
    const state = summary.pass ? "PASS" : "FAIL";
    console.log(
      `admin-v2-pixel-regression ${state}${label}: `
      + `${summary.differentPixels}/${summary.totalPixels} 像素，`
      + `比例 ${(summary.diffRatio * 100).toFixed(3)}%（阈值 ${(summary.maxDiffRatio * 100).toFixed(3)}%），`
      + `尺寸 ${summary.sourceWidth}x${summary.sourceHeight} -> ${summary.width}x${summary.height}`
    );
    if (summary.heatmapPath) console.log(`差异热图：${summary.heatmapPath}`);
    return summary.pass ? 0 : 1;
  } catch (error) {
    console.error(`admin-v2-pixel-regression 失败：${error.message || error}`);
    return 2;
  }
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_DIFF_RATIO,
  decodeImage,
  resizeNearest,
  compareImages,
  writeHeatmap,
  runRegression,
  parseArgs,
  main,
};

if (require.main === module) process.exitCode = main();
