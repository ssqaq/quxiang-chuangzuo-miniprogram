/* eslint-disable no-console */

/**
 * 生成控制台四页像素差异报告。
 *
 * 图片解码、尺寸归一化和热图写入全部复用 admin-v2-pixel-regression；
 * 本文件只补充定位信息（包围盒与热点 tile），不把截图像素或页面字段
 * 写入报告之外的地方，也不会读取运行时凭证。
 */

const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const PAGE_NAMES = ["dashboard", "operations", "config", "provider"];
const DEFAULT_THRESHOLD = 32;
const DEFAULT_MAX_DIFF_RATIO = 0.5;
const DEFAULT_TILE_SIZE = 32;
const DEFAULT_TOP_TILES = 5;
const DEFAULT_MANIFEST = path.join(ROOT, "visual-evidence", "admin-v2-pixel-manifest.json");
const DEFAULT_HEATMAP_ROOT = path.join(ROOT, "visual-evidence", "pixel-diffs");
const DEFAULT_JSON = path.join(DEFAULT_HEATMAP_ROOT, "admin-v2-pixel-diff-report.json");
const DEFAULT_MARKDOWN = path.join(DEFAULT_HEATMAP_ROOT, "admin-v2-pixel-diff-report.md");

function resolveFromRoot(root, value) {
  if (!value) return "";
  return path.isAbsolute(String(value))
    ? path.resolve(String(value))
    : path.resolve(root, String(value));
}

function safeRoute(value) {
  return String(value || "")
    .replace(/([?&](?:api[-_]?key|token|secret|password)=)[^&#]*/gi, "$1<redacted>")
    .replace(/([?&](?:api[-_]?key|token|secret|password))(?=&|#|$)/gi, "$1=<redacted>");
}

function relativeDisplayPath(root, value) {
  const resolved = resolveFromRoot(root, value);
  const relative = path.relative(root, resolved).replace(/\\/g, "/");
  // 只输出项目内相对路径，避免把本机用户名或其他绝对路径写入报告。
  return relative && !relative.startsWith("../") && relative !== ".."
    ? relative
    : path.basename(resolved);
}

function readManifest(manifestPath, root = ROOT) {
  const resolvedManifest = resolveFromRoot(root, manifestPath || DEFAULT_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifest, "utf8"));
  } catch (error) {
    const wrapped = new Error(`像素差异 manifest 无法读取：${resolvedManifest}（${error.message}）`);
    wrapped.code = "PIXEL_DIFF_MANIFEST_READ_FAILED";
    throw wrapped;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("像素差异 manifest 必须是 JSON 对象。");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("像素差异 manifest schemaVersion 必须为 1。");
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== PAGE_NAMES.length) {
    throw new Error("像素差异 manifest 必须正好覆盖四个页面。");
  }
  const names = manifest.pages.map(item => item && item.name);
  if (JSON.stringify(names) !== JSON.stringify(PAGE_NAMES)) {
    throw new Error(`像素差异页面顺序必须为：${PAGE_NAMES.join("、")}。`);
  }
  const pages = manifest.pages.map(item => {
    if (!item || typeof item !== "object" || !item.actual || !item.reference) {
      throw new Error("像素差异页面必须提供 actual 和 reference 路径。");
    }
    return {
      name: String(item.name),
      route: safeRoute(item.route),
      actual: String(item.actual),
      reference: String(item.reference),
      actualPath: resolveFromRoot(root, item.actual),
      referencePath: resolveFromRoot(root, item.reference),
    };
  });
  return {
    path: resolvedManifest,
    schemaVersion: manifest.schemaVersion,
    viewport: manifest.viewport && typeof manifest.viewport === "object"
      ? {
        width: Number(manifest.viewport.width) || null,
        height: Number(manifest.viewport.height) || null,
        device: manifest.viewport.device ? String(manifest.viewport.device) : "",
      }
      : null,
    mode: manifest.mode ? String(manifest.mode) : "",
    pages,
  };
}

function finiteNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function pixelOffset(width, x, y) {
  return (y * width + x) * 4;
}

function compareChannelDiff(actual, reference, offset) {
  return Math.max(
    Math.abs(actual[offset] - reference[offset]),
    Math.abs(actual[offset + 1] - reference[offset + 1]),
    Math.abs(actual[offset + 2] - reference[offset + 2]),
    Math.abs(actual[offset + 3] - reference[offset + 3])
  );
}

/**
 * 计算差异空间统计。right/bottom 为包含边界，方便直接对应截图坐标。
 */
function analyzeDiff(actualImage, referenceImage, options = {}) {
  const threshold = finiteNumber(options.threshold, DEFAULT_THRESHOLD);
  const tileSize = Math.max(1, Math.floor(finiteNumber(options.tileSize, DEFAULT_TILE_SIZE, 1)));
  const topTiles = Math.max(1, Math.floor(finiteNumber(options.topTiles, DEFAULT_TOP_TILES, 1)));
  const width = referenceImage.width;
  const height = referenceImage.height;
  const actual = regression.resizeNearest(actualImage, width, height);
  const reference = regression.resizeNearest(referenceImage, width, height);
  let differentPixels = 0;
  let sumMaxChannelDiff = 0;
  let maxChannelDiff = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const tileMap = new Map();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = pixelOffset(width, x, y);
      const maxDiff = compareChannelDiff(actual.data, reference.data, offset);
      sumMaxChannelDiff += maxDiff;
      if (maxDiff > maxChannelDiff) maxChannelDiff = maxDiff;
      if (maxDiff <= threshold) continue;
      differentPixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const tileX = Math.floor(x / tileSize);
      const tileY = Math.floor(y / tileSize);
      const key = `${tileX}:${tileY}`;
      let tile = tileMap.get(key);
      if (!tile) {
        tile = {
          tileX,
          tileY,
          left: tileX * tileSize,
          top: tileY * tileSize,
          right: Math.min(width - 1, ((tileX + 1) * tileSize) - 1),
          bottom: Math.min(height - 1, ((tileY + 1) * tileSize) - 1),
          differentPixels: 0,
          maxChannelDiff: 0,
          sumMaxChannelDiff: 0,
        };
        tileMap.set(key, tile);
      }
      tile.differentPixels += 1;
      tile.sumMaxChannelDiff += maxDiff;
      if (maxDiff > tile.maxChannelDiff) tile.maxChannelDiff = maxDiff;
    }
  }

  const totalPixels = width * height;
  const hotspotTiles = [...tileMap.values()]
    .sort((left, right) => (
      right.differentPixels - left.differentPixels
      || right.sumMaxChannelDiff - left.sumMaxChannelDiff
      || left.tileY - right.tileY
      || left.tileX - right.tileX
    ))
    .slice(0, topTiles)
    .map(tile => ({
      tileX: tile.tileX,
      tileY: tile.tileY,
      left: tile.left,
      top: tile.top,
      right: tile.right,
      bottom: tile.bottom,
      width: tile.right - tile.left + 1,
      height: tile.bottom - tile.top + 1,
      differentPixels: tile.differentPixels,
      diffRatio: tile.differentPixels / ((tile.right - tile.left + 1) * (tile.bottom - tile.top + 1)),
      maxChannelDiff: tile.maxChannelDiff,
      meanMaxChannelDiff: tile.differentPixels ? tile.sumMaxChannelDiff / tile.differentPixels : 0,
    }));

  return {
    width,
    height,
    sourceWidth: actualImage.width,
    sourceHeight: actualImage.height,
    scaled: actualImage.width !== width || actualImage.height !== height,
    threshold,
    tileSize,
    totalPixels,
    differentPixels,
    diffRatio: totalPixels ? differentPixels / totalPixels : 0,
    meanMaxChannelDiff: totalPixels ? sumMaxChannelDiff / totalPixels : 0,
    maxChannelDiff,
    boundingBox: maxX < 0 ? null : {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      differentPixels,
    },
    hotspotTile: hotspotTiles[0] || null,
    hotspotTiles,
  };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifest = readManifest(
    options.manifest || path.join(root, "visual-evidence", "admin-v2-pixel-manifest.json"),
    root
  );
  const threshold = finiteNumber(options.threshold, DEFAULT_THRESHOLD);
  const maxDiffRatio = finiteNumber(options.maxDiffRatio, DEFAULT_MAX_DIFF_RATIO);
  const tileSize = Math.max(1, Math.floor(finiteNumber(options.tileSize, DEFAULT_TILE_SIZE, 1)));
  const topTiles = Math.max(1, Math.floor(finiteNumber(options.topTiles, DEFAULT_TOP_TILES, 1)));
  const heatmapRoot = resolveFromRoot(
    root,
    options.heatmapRoot || path.join("visual-evidence", "pixel-diffs")
  );
  fs.mkdirSync(heatmapRoot, { recursive: true });
  const pages = manifest.pages.map(page => {
    if (!fs.existsSync(page.actualPath) || !fs.existsSync(page.referencePath)) {
      throw new Error(`页面图片不存在：${page.name}`);
    }
    const actualImage = regression.decodeImage(page.actualPath);
    const referenceImage = regression.decodeImage(page.referencePath);
    const stats = analyzeDiff(actualImage, referenceImage, { threshold, tileSize, topTiles });
    const regressionSummary = regression.runRegression({
      actualPath: page.actualPath,
      referencePath: page.referencePath,
      threshold,
      maxDiffRatio,
      outputPath: path.join(heatmapRoot, `${page.name}.png`),
    });
    return {
      name: page.name,
      route: safeRoute(page.route),
      actual: relativeDisplayPath(root, page.actualPath),
      reference: relativeDisplayPath(root, page.referencePath),
      heatmap: relativeDisplayPath(root, regressionSummary.heatmapPath),
      pass: regressionSummary.pass,
      maxDiffRatio,
      ...stats,
    };
  });
  const report = {
    schemaVersion: 1,
    status: pages.every(page => page.pass) ? "pass" : "fail",
    ok: pages.every(page => page.pass),
    viewport: manifest.viewport,
    mode: manifest.mode,
    threshold,
    maxDiffRatio,
    tileSize,
    topTiles,
    manifest: relativeDisplayPath(root, manifest.path),
    pages,
    checkedAt: new Date().toISOString(),
  };
  const jsonPath = options.json === false
    ? null
    : resolveFromRoot(root, options.json || path.join("visual-evidence", "pixel-diffs", "admin-v2-pixel-diff-report.json"));
  const markdownPath = options.markdown === false
    ? null
    : resolveFromRoot(root, options.markdown || path.join("visual-evidence", "pixel-diffs", "admin-v2-pixel-diff-report.md"));
  if (jsonPath) report.jsonPath = relativeDisplayPath(root, jsonPath);
  if (markdownPath) report.markdownPath = relativeDisplayPath(root, markdownPath);
  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (markdownPath) {
    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  }
  return report;
}

function markdownCell(value) {
  return String(value === null || value === undefined ? "-" : value)
    .replace(/\\/g, "/")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function formatBox(box) {
  if (!box) return "无";
  return `(${box.left},${box.top}) - (${box.right},${box.bottom})，${box.width}x${box.height}`;
}

function formatHotspot(tile) {
  if (!tile) return "无";
  return `tile(${tile.tileX},${tile.tileY}) ${tile.differentPixels}px/${(tile.diffRatio * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const viewport = report.viewport && report.viewport.width && report.viewport.height
    ? `${report.viewport.width}x${report.viewport.height}`
    : "以参考图为准";
  const lines = [
    "# 控制台四页像素差异报告",
    "",
    `- 总状态：**${report.ok ? "PASS" : "FAIL"}**` ,
    `- 阈值：${report.threshold}（单通道最大差）` ,
    `- 最大差异比例：${(report.maxDiffRatio * 100).toFixed(3)}%`,
    `- 热点 tile：${report.tileSize}x${report.tileSize}，视口：${viewport}`,
    `- 基线清单：\`${markdownCell(report.manifest)}\``,
    "",
    "| 页面 | 状态 | 差异像素 | 差异比例 | 最大通道差 | 差异包围盒 | 热点 tile | 热图 |",
    "| --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ];
  report.pages.forEach(page => {
    lines.push(
      `| ${markdownCell(page.name)} | ${page.pass ? "PASS" : "FAIL"}`
      + ` | ${page.differentPixels}/${page.totalPixels}`
      + ` | ${(page.diffRatio * 100).toFixed(3)}%`
      + ` | ${page.maxChannelDiff}`
      + ` | ${markdownCell(formatBox(page.boundingBox))}`
      + ` | ${markdownCell(formatHotspot(page.hotspotTile))}`
      + ` | \`${markdownCell(page.heatmap)}\` |`
    );
  });
  lines.push("", `生成时间：${report.checkedAt}`, "");
  return lines.join("\n");
}

function parseArgs(argv) {
  const result = {
    root: ROOT,
    // 保持相对路径，配合 --root 对临时项目和 CI 工作树也能正确落盘。
    manifest: path.join("visual-evidence", "admin-v2-pixel-manifest.json"),
    heatmapRoot: path.join("visual-evidence", "pixel-diffs"),
    json: path.join("visual-evidence", "pixel-diffs", "admin-v2-pixel-diff-report.json"),
    markdown: path.join("visual-evidence", "pixel-diffs", "admin-v2-pixel-diff-report.md"),
    threshold: DEFAULT_THRESHOLD,
    maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
    tileSize: DEFAULT_TILE_SIZE,
    topTiles: DEFAULT_TOP_TILES,
  };
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
    "用法：node scripts/admin-v2-pixel-diff-report.js [选项]",
    "  --manifest <文件>        四页像素基线 manifest",
    "  --root <目录>            项目根目录",
    "  --heatmap-root <目录>    差异热图目录",
    "  --json <文件>            JSON 报告输出路径",
    "  --markdown <文件>        Markdown 报告输出路径",
    "  --threshold <数值>       单像素通道差阈值（默认 32）",
    "  --max-diff-ratio <数值>  页面通过的最大差异比例（默认 0.5）",
    "  --tile-size <像素>       热点网格边长（默认 32）",
    "  --top-tiles <数量>       保留热点数量（默认 5）",
  ].join("\n"));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`四页像素差异报告失败：${error.message || error}`);
    return 2;
  }
}

module.exports = {
  ROOT,
  PAGE_NAMES,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_DIFF_RATIO,
  DEFAULT_TILE_SIZE,
  DEFAULT_TOP_TILES,
  DEFAULT_MANIFEST,
  DEFAULT_HEATMAP_ROOT,
  DEFAULT_JSON,
  DEFAULT_MARKDOWN,
  resolveFromRoot,
  relativeDisplayPath,
  safeRoute,
  readManifest,
  analyzeDiff,
  renderMarkdown,
  parseArgs,
  run,
  main,
};

if (require.main === module) process.exitCode = main();
