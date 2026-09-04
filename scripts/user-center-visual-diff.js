/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const previewRoot = process.env.USER_CENTER_PREVIEW_ROOT || path.join(projectRoot, "tools", "user-center-preview");
const defaultConfigPath = path.join(
  projectRoot,
  "docs",
  "superpowers",
  "visual-baselines",
  "user-center-regression.config.json"
);
const defaultOutputDirectory = path.join(projectRoot, "artifacts", "user-center-visual", "latest");
const requiredPages = ["user-center", "recharge", "records"];

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function sha256NormalizedText(file) {
  return sha256Buffer(fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n"));
}

function readJson(file, label) {
  assert.ok(fs.existsSync(file), `${label}不存在：${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${file}\n${error.message}`);
  }
}

function resolveConfigPath(configDirectory, value, label) {
  assert.ok(typeof value === "string" && value.trim(), `${label}路径不能为空`);
  return path.resolve(configDirectory, value);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function loadSharp() {
  const candidates = [
    process.env.SHARP_MODULE,
    path.join(projectRoot, "tools", "user-center-visual", "node_modules", "sharp"),
    path.join(previewRoot, "node_modules", "sharp"),
    "sharp"
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.code || error.message}`);
    }
  }
  throw new Error(`找不到 sharp。设置 SHARP_MODULE，或安装 tools/user-center-visual 依赖。\n${errors.join("\n")}`);
}

function parseArguments(argv) {
  const options = {
    configPath: defaultConfigPath,
    outputDirectory: defaultOutputDirectory,
    allowFail: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      options.configPath = path.resolve(argv[++index] || "");
    } else if (argument === "--output") {
      options.outputDirectory = path.resolve(argv[++index] || "");
    } else if (argument === "--allow-fail") {
      options.allowFail = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return options;
}

function printHelp() {
  console.log([
    "用法：node scripts/user-center-visual-diff.js [选项]",
    "",
    "  --config <file>  视觉比较配置文件",
    "  --output <dir>   JSON、Markdown、diff、热图和叠加图输出目录",
    "  --allow-fail     仍生成报告，但页面未达阈值时返回 0",
    "  --help           显示帮助"
  ].join("\n"));
}

function validateHash(value, label) {
  assert.match(String(value || ""), /^[a-f0-9]{64}$/i, `${label}必须是 SHA256`);
  return String(value).toLowerCase();
}

function validateThresholds(value) {
  assert.ok(value && typeof value === "object", "缺少 thresholds");
  const thresholds = {
    pixelDelta: Number(value.pixelDelta),
    changedPixelRatio: Number(value.changedPixelRatio),
    mae: Number(value.mae),
    maxDelta: Number(value.maxDelta),
    ssim: Number(value.ssim)
  };
  assert.ok(Number.isInteger(thresholds.pixelDelta) && thresholds.pixelDelta >= 0 && thresholds.pixelDelta <= 255, "pixelDelta 必须是 0-255 整数");
  assert.ok(Number.isFinite(thresholds.changedPixelRatio) && thresholds.changedPixelRatio >= 0 && thresholds.changedPixelRatio <= 1, "changedPixelRatio 必须在 0-1");
  assert.ok(Number.isFinite(thresholds.mae) && thresholds.mae >= 0 && thresholds.mae <= 255, "mae 必须在 0-255");
  assert.ok(Number.isFinite(thresholds.maxDelta) && thresholds.maxDelta >= 0 && thresholds.maxDelta <= 255, "maxDelta 必须在 0-255");
  assert.ok(Number.isFinite(thresholds.ssim) && thresholds.ssim >= -1 && thresholds.ssim <= 1, "ssim 必须在 -1 到 1");
  return thresholds;
}

function validateConfig(config, configPath, outputDirectory) {
  assert.strictEqual(config.schemaVersion, 1, "视觉比较配置 schemaVersion 必须为 1");
  assert.ok(typeof config.contract === "string" && config.contract, "视觉比较配置缺少 contract");
  assert.ok(config.canvas && Number.isInteger(config.canvas.width) && Number.isInteger(config.canvas.height), "canvas 必须是整数宽高");
  assert.ok(config.canvas.width > 0 && config.canvas.height > 0, "canvas 宽高必须大于 0");
  assert.ok(Array.isArray(config.pages), "pages 必须是数组");
  assert.deepStrictEqual(
    [...config.pages.map((item) => item.id)].sort(),
    [...requiredPages].sort(),
    "比较必须且只能覆盖 user-center、recharge、records 三页"
  );

  const configDirectory = path.dirname(configPath);
  const baselineManifestPath = resolveConfigPath(configDirectory, config.baselineManifest.path, "baselineManifest");
  const candidateManifestPath = resolveConfigPath(configDirectory, config.candidateManifest.path, "candidateManifest");
  const inputDirectories = [path.dirname(baselineManifestPath), path.dirname(candidateManifestPath)];
  for (const directory of inputDirectories) {
    assert.ok(!isInside(outputDirectory, directory), `报告目录不得写入输入或基线目录：${outputDirectory}`);
  }

  return {
    configDirectory,
    baselineManifestPath,
    baselineManifestSha256: validateHash(config.baselineManifest.sha256, "baselineManifest.sha256"),
    candidateManifestPath,
    candidateManifestSha256: validateHash(config.candidateManifest.sha256, "candidateManifest.sha256"),
    canvas: { width: config.canvas.width, height: config.canvas.height },
    thresholds: validateThresholds(config.thresholds)
  };
}

async function readRgba(sharp, file) {
  const metadata = await sharp(file).metadata();
  assert.strictEqual(metadata.format, "png", `只接受 PNG：${file}`);
  const result = await sharp(file)
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.strictEqual(result.info.channels, 4, `PNG 无法转换为 RGBA：${file}`);
  return {
    file,
    width: result.info.width,
    height: result.info.height,
    channels: result.info.channels,
    data: result.data
  };
}

function luminance(data, offset) {
  return 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
}

function blockSsim(left, right, width, height, blockSize = 8) {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let weighted = 0;
  let totalPixels = 0;

  for (let top = 0; top < height; top += blockSize) {
    for (let leftX = 0; leftX < width; leftX += blockSize) {
      const blockWidth = Math.min(blockSize, width - leftX);
      const blockHeight = Math.min(blockSize, height - top);
      const count = blockWidth * blockHeight;
      let meanLeft = 0;
      let meanRight = 0;

      for (let y = 0; y < blockHeight; y += 1) {
        for (let x = 0; x < blockWidth; x += 1) {
          const offset = ((top + y) * width + leftX + x) * 4;
          meanLeft += luminance(left, offset);
          meanRight += luminance(right, offset);
        }
      }
      meanLeft /= count;
      meanRight /= count;

      let varianceLeft = 0;
      let varianceRight = 0;
      let covariance = 0;
      for (let y = 0; y < blockHeight; y += 1) {
        for (let x = 0; x < blockWidth; x += 1) {
          const offset = ((top + y) * width + leftX + x) * 4;
          const leftDelta = luminance(left, offset) - meanLeft;
          const rightDelta = luminance(right, offset) - meanRight;
          varianceLeft += leftDelta * leftDelta;
          varianceRight += rightDelta * rightDelta;
          covariance += leftDelta * rightDelta;
        }
      }
      const denominator = Math.max(1, count - 1);
      varianceLeft /= denominator;
      varianceRight /= denominator;
      covariance /= denominator;
      const numerator = (2 * meanLeft * meanRight + c1) * (2 * covariance + c2);
      const divisor = (meanLeft ** 2 + meanRight ** 2 + c1) * (varianceLeft + varianceRight + c2);
      const value = divisor === 0 ? 1 : numerator / divisor;
      weighted += value * count;
      totalPixels += count;
    }
  }
  return weighted / totalPixels;
}

function compareRgba(left, right, width, height, pixelDelta) {
  assert.strictEqual(left.length, right.length, "RGBA 缓冲区长度不一致");
  const pixelCount = width * height;
  let rawChangedPixels = 0;
  let changedPixels = 0;
  let absoluteDelta = 0;
  let maxDelta = 0;
  const diff = Buffer.alloc(left.length);
  const heatmap = Buffer.alloc(left.length);
  const overlay = Buffer.alloc(left.length);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    let pixelMax = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(left[offset + channel] - right[offset + channel]);
      absoluteDelta += delta;
      pixelMax = Math.max(pixelMax, delta);
      maxDelta = Math.max(maxDelta, delta);
      diff[offset + channel] = channel === 3 ? 255 : Math.min(255, delta * 4);
    }
    if (pixelMax > 0) rawChangedPixels += 1;
    if (pixelMax > pixelDelta) changedPixels += 1;

    // 固定色标：0=黑，1..63=红，64..127=红黄，128..255=黄白。
    heatmap[offset] = Math.min(255, pixelMax * 4);
    heatmap[offset + 1] = Math.min(255, Math.max(0, pixelMax * 4 - 255));
    heatmap[offset + 2] = Math.min(255, Math.max(0, pixelMax * 4 - 510));
    heatmap[offset + 3] = 255;

    // 基线放红通道，候选放绿/蓝通道；错位处会出现红色或青色边缘。
    overlay[offset] = left[offset];
    overlay[offset + 1] = right[offset + 1];
    overlay[offset + 2] = right[offset + 2];
    overlay[offset + 3] = 255;
  }

  return {
    metrics: {
      pixelCount,
      rawChangedPixels,
      rawChangedPixelRatio: rawChangedPixels / pixelCount,
      changedPixels,
      changedPixelRatio: changedPixels / pixelCount,
      mae: absoluteDelta / left.length,
      maxDelta,
      ssim: blockSsim(left, right, width, height)
    },
    images: { diff, heatmap, overlay }
  };
}

function checksFor(metrics, thresholds) {
  return {
    changedPixelRatio: {
      actual: metrics.changedPixelRatio,
      operator: "<=",
      expected: thresholds.changedPixelRatio,
      pass: metrics.changedPixelRatio <= thresholds.changedPixelRatio
    },
    mae: {
      actual: metrics.mae,
      operator: "<=",
      expected: thresholds.mae,
      pass: metrics.mae <= thresholds.mae
    },
    maxDelta: {
      actual: metrics.maxDelta,
      operator: "<=",
      expected: thresholds.maxDelta,
      pass: metrics.maxDelta <= thresholds.maxDelta
    },
    ssim: {
      actual: metrics.ssim,
      operator: ">=",
      expected: thresholds.ssim,
      pass: metrics.ssim >= thresholds.ssim
    }
  };
}

async function writeRgba(sharp, file, image, width, height) {
  await sharp(image, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(file);
}

function relativeFromOutput(outputDirectory, file) {
  return path.relative(outputDirectory, file).replaceAll(path.sep, "/");
}

function markdownReport(report) {
  const lines = [
    "# 用户中心三页视觉差异报告",
    "",
    `- 总结果：**${report.pass ? "通过" : "失败"}**`,
    `- 契约：\`${report.contract}\``,
    `- 画布：\`${report.canvas.width}x${report.canvas.height}\`（尺寸必须完全一致）`,
    `- 计算时间：\`${report.generatedAt}\``,
    `- 配置 SHA256：\`${report.config.sha256}\``,
    `- 基线 manifest SHA256：\`${report.inputs.baselineManifest.sha256}\``,
    `- 候选 manifest SHA256：\`${report.inputs.candidateManifest.sha256}\``,
    "",
    "| 页面 | 结果 | 变化像素 | MAE | 最大差值 | SSIM | 基线 SHA256 | 候选 SHA256 |",
    "|---|---:|---:|---:|---:|---:|---|---|"
  ];
  for (const page of report.pages) {
    lines.push(`| ${page.id} | ${page.pass ? "通过" : "失败"} | ${(page.metrics.changedPixelRatio * 100).toFixed(4)}% | ${page.metrics.mae.toFixed(6)} | ${page.metrics.maxDelta} | ${page.metrics.ssim.toFixed(6)} | \`${page.baseline.sha256}\` | \`${page.candidate.sha256}\` |`);
  }
  lines.push("", "## 阈值", "", "```json", JSON.stringify(report.thresholds, null, 2), "```", "");
  for (const page of report.pages) {
    lines.push(
      `## ${page.id}`,
      "",
      `结果：**${page.pass ? "通过" : "失败"}**`,
      "",
      `![${page.id} diff](./${page.artifacts.diff.path})`,
      "",
      `![${page.id} heatmap](./${page.artifacts.heatmap.path})`,
      "",
      `![${page.id} overlay](./${page.artifacts.overlay.path})`,
      ""
    );
  }
  lines.push(
    "## 算法说明",
    "",
    "- PNG 原图按 RGBA 逐像素重算，不缩放、不复用旧报告。",
    "- changedPixelRatio 使用配置中的 pixelDelta 判断。",
    "- MAE 和 maxDelta 按 RGBA 四通道计算。",
    "- SSIM 使用 8x8 分块、Rec.709 亮度和标准 C1/C2 常量。",
    "- diff 固定放大通道差值 4 倍；heatmap 使用固定黑-红-黄-白色标；overlay 用红/青边缘显示错位。",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function manifestFileEntry(outputDirectory, file) {
  return {
    path: relativeFromOutput(outputDirectory, file),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file)
  };
}

async function runComparison(options) {
  const configPath = path.resolve(options.configPath || defaultConfigPath);
  const outputDirectory = path.resolve(options.outputDirectory || defaultOutputDirectory);
  const config = readJson(configPath, "视觉比较配置");
  const validated = validateConfig(config, configPath, outputDirectory);
  const baselineManifest = readJson(validated.baselineManifestPath, "基线 manifest");
  const candidateManifest = readJson(validated.candidateManifestPath, "候选 manifest");
  const actualBaselineManifestSha256 = sha256NormalizedText(validated.baselineManifestPath);
  assert.strictEqual(actualBaselineManifestSha256, validated.baselineManifestSha256, "基线 manifest SHA256 已变化，必须重新冻结和评审");
  const actualCandidateManifestSha256 = sha256NormalizedText(validated.candidateManifestPath);
  assert.strictEqual(actualCandidateManifestSha256, validated.candidateManifestSha256, "候选 manifest SHA256 已变化，必须重新采集或更新审计配置");
  assert.deepStrictEqual(candidateManifest.widths, [320, 338, 375, 414], "候选 manifest 必须包含固定四宽度");

  fs.mkdirSync(outputDirectory, { recursive: true });
  const sharp = loadSharp();
  const pages = [];
  const artifactFiles = [];

  for (const pageConfig of config.pages) {
    const id = pageConfig.id;
    const baselinePath = resolveConfigPath(validated.configDirectory, pageConfig.baseline.path, `${id}.baseline`);
    const candidatePath = resolveConfigPath(validated.configDirectory, pageConfig.candidate.path, `${id}.candidate`);
    assert.ok(fs.existsSync(baselinePath), `${id} 基线 PNG 不存在：${baselinePath}`);
    assert.ok(fs.existsSync(candidatePath), `${id} 候选 PNG 不存在：${candidatePath}`);

    const expectedBaselineSha256 = validateHash(pageConfig.baseline.sha256, `${id}.baseline.sha256`);
    const actualBaselineSha256 = sha256File(baselinePath);
    const actualCandidateSha256 = sha256File(candidatePath);
    assert.strictEqual(actualBaselineSha256, expectedBaselineSha256, `${id} 基线 PNG SHA256 已变化`);

    const baselineCapture = baselineManifest.captures && baselineManifest.captures[id];
    assert.ok(baselineCapture, `基线 manifest 缺少 ${id}`);
    assert.strictEqual(String(baselineCapture.screenshotSha256).toLowerCase(), actualBaselineSha256, `${id} 基线 PNG 与基线 manifest 不一致`);

    const widthKey = String(validated.canvas.width);
    const candidateCapture = candidateManifest.captures && candidateManifest.captures[id] && candidateManifest.captures[id][widthKey];
    assert.ok(candidateCapture, `候选 manifest 缺少 ${id}/${widthKey}`);
    const candidateFromManifest = path.resolve(path.dirname(validated.candidateManifestPath), candidateCapture.screenshot);
    assert.strictEqual(candidateFromManifest, candidatePath, `${id} 候选 PNG 路径与候选 manifest 不一致`);
    assert.strictEqual(validateHash(candidateCapture.screenshotSha256, `${id} 候选截图 hash`), actualCandidateSha256, `${id} 候选 PNG 与候选 manifest 不一致`);
    assert.deepStrictEqual(candidateCapture.viewport, { width: validated.canvas.width, height: validated.canvas.height, dpr: 1 }, `${id} 候选 viewport 不符合冻结画布`);

    const baseline = await readRgba(sharp, baselinePath);
    const candidate = await readRgba(sharp, candidatePath);
    for (const [kind, image] of [["基线", baseline], ["候选", candidate]]) {
      assert.strictEqual(image.width, validated.canvas.width, `${id} ${kind} PNG 宽度必须精确为 ${validated.canvas.width}`);
      assert.strictEqual(image.height, validated.canvas.height, `${id} ${kind} PNG 高度必须精确为 ${validated.canvas.height}`);
    }

    const comparison = compareRgba(
      baseline.data,
      candidate.data,
      validated.canvas.width,
      validated.canvas.height,
      validated.thresholds.pixelDelta
    );
    const checks = checksFor(comparison.metrics, validated.thresholds);
    const pagePass = Object.values(checks).every((item) => item.pass);
    const outputNames = {
      diff: path.join(outputDirectory, `${id}.diff.png`),
      heatmap: path.join(outputDirectory, `${id}.heatmap.png`),
      overlay: path.join(outputDirectory, `${id}.overlay.png`)
    };
    await Promise.all([
      writeRgba(sharp, outputNames.diff, comparison.images.diff, validated.canvas.width, validated.canvas.height),
      writeRgba(sharp, outputNames.heatmap, comparison.images.heatmap, validated.canvas.width, validated.canvas.height),
      writeRgba(sharp, outputNames.overlay, comparison.images.overlay, validated.canvas.width, validated.canvas.height)
    ]);
    artifactFiles.push(...Object.values(outputNames));
    const artifacts = Object.fromEntries(Object.entries(outputNames).map(([kind, file]) => [kind, manifestFileEntry(outputDirectory, file)]));
    pages.push({
      id,
      pass: pagePass,
      canvas: validated.canvas,
      baseline: { path: path.relative(projectRoot, baselinePath).replaceAll(path.sep, "/"), sha256: actualBaselineSha256 },
      candidate: { path: path.relative(projectRoot, candidatePath).replaceAll(path.sep, "/"), sha256: actualCandidateSha256 },
      metrics: comparison.metrics,
      checks,
      artifacts
    });
  }

  const report = {
    schemaVersion: 1,
    contract: config.contract,
    generatedAt: new Date().toISOString(),
    pass: pages.length === requiredPages.length && pages.every((item) => item.pass),
    config: { path: path.relative(projectRoot, configPath).replaceAll(path.sep, "/"), sha256: sha256File(configPath) },
    canvas: validated.canvas,
    thresholds: validated.thresholds,
    algorithm: {
      source: "RGBA PNG buffers",
      resize: false,
      changedPixel: `max(abs(RGBA delta)) > ${validated.thresholds.pixelDelta}`,
      mae: "mean absolute error across RGBA channels",
      ssim: "8x8 block SSIM over Rec.709 luminance",
      heatmapScale: "fixed black-red-yellow-white"
    },
    inputs: {
      baselineManifest: {
        path: path.relative(projectRoot, validated.baselineManifestPath).replaceAll(path.sep, "/"),
        sha256: actualBaselineManifestSha256
      },
      candidateManifest: {
        path: path.relative(projectRoot, validated.candidateManifestPath).replaceAll(path.sep, "/"),
        sha256: actualCandidateManifestSha256
      }
    },
    pages
  };

  const reportJson = path.join(outputDirectory, "report.json");
  const reportMarkdown = path.join(outputDirectory, "report.md");
  fs.writeFileSync(reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(reportMarkdown, markdownReport(report), "utf8");
  artifactFiles.push(reportJson, reportMarkdown);

  const reportManifest = {
    schemaVersion: 1,
    contract: "user-center-visual-report",
    generatedAt: report.generatedAt,
    pass: report.pass,
    configSha256: report.config.sha256,
    inputSha256: {
      baselineManifest: actualBaselineManifestSha256,
      candidateManifest: actualCandidateManifestSha256
    },
    files: artifactFiles.map((file) => manifestFileEntry(outputDirectory, file)).sort((left, right) => left.path.localeCompare(right.path))
  };
  const reportManifestFile = path.join(outputDirectory, "report.manifest.json");
  fs.writeFileSync(reportManifestFile, `${JSON.stringify(reportManifest, null, 2)}\n`, "utf8");
  const reportManifestSha256 = sha256File(reportManifestFile);

  console.table(pages.map((page) => ({
    page: page.id,
    pass: page.pass,
    changed: `${(page.metrics.changedPixelRatio * 100).toFixed(4)}%`,
    mae: page.metrics.mae.toFixed(6),
    maxDelta: page.metrics.maxDelta,
    ssim: page.metrics.ssim.toFixed(6)
  })));
  console.log(`视觉差异报告：${reportMarkdown}`);
  console.log(`报告 manifest SHA256：${reportManifestSha256}`);
  console.log(`user-center visual diff: ${report.pass ? "OK" : "FAILED"}`);
  return { report, reportManifestFile, reportManifestSha256 };
}

async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return { pass: true };
  }
  const result = await runComparison(options);
  if (!result.report.pass && !options.allowFail) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  blockSsim,
  compareRgba,
  runCli,
  runComparison,
  sha256File
};
