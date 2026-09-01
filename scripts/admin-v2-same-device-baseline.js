/* eslint-disable no-console */

/**
 * 同设备视觉基线校验。
 *
 * 这层记录“截图由什么 renderer、什么 viewport 产生”，再复用像素回归
 * 做实际比较。它不修改页面，也不把图片内容写进 JSON，只保存文件摘要。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "visual-evidence", "admin-v2-same-device-manifest.json");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "same-device-diffs");
const PAGE_NAMES = ["dashboard", "operations", "config", "provider"];
const REQUIRED_VIEWPORT = { width: 390, height: 844 };

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolveFromRoot(root, relativeOrAbsolute) {
  if (!relativeOrAbsolute) return "";
  return path.isAbsolute(String(relativeOrAbsolute))
    ? path.resolve(String(relativeOrAbsolute))
    : path.resolve(root, String(relativeOrAbsolute));
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const wrapped = new Error(`同设备基线 manifest 无法读取：${filePath}（${error.message}）`);
    wrapped.code = "SAME_DEVICE_MANIFEST_READ_FAILED";
    throw wrapped;
  }
}

function validateManifest(manifest, root = ROOT, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("同设备基线 manifest 必须是 JSON 对象。");
  }
  if (manifest.schemaVersion !== 1) throw new Error("同设备基线 manifest schemaVersion 必须为 1。");
  if (!manifest.viewport || Number(manifest.viewport.width) !== REQUIRED_VIEWPORT.width
    || Number(manifest.viewport.height) !== REQUIRED_VIEWPORT.height) {
    throw new Error("同设备基线 viewport 必须固定为 390 x 844。");
  }
  const capture = manifest.capture;
  if (!capture || typeof capture !== "object"
    || String(capture.renderer || "").trim() === ""
    || String(capture.device || "").trim() === ""
    || String(capture.command || "").trim() === "") {
    throw new Error("同设备基线必须记录 renderer、device 和 capture command。");
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length !== PAGE_NAMES.length) {
    throw new Error("同设备基线 manifest 必须正好覆盖四个页面。");
  }
  const names = manifest.pages.map(item => item && item.name);
  if (JSON.stringify(names) !== JSON.stringify(PAGE_NAMES)) {
    throw new Error(`同设备基线页面顺序必须为：${PAGE_NAMES.join("、")}。`);
  }
  const checkedPages = manifest.pages.map(item => {
    if (!item || !item.actual || !item.reference) {
      throw new Error("同设备基线页面缺少 actual/reference 路径。");
    }
    const actualPath = resolveFromRoot(root, item.actual);
    const referencePath = resolveFromRoot(root, item.reference);
    for (const filePath of [actualPath, referencePath]) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        throw new Error(`同设备基线图片不存在：${filePath}`);
      }
      const image = regression.decodeImage(filePath);
      if (image.width !== REQUIRED_VIEWPORT.width || image.height !== REQUIRED_VIEWPORT.height) {
        throw new Error(`同设备基线图片尺寸必须为 390 x 844：${filePath}（${image.width} x ${image.height}）`);
      }
    }
    const actualSha = sha256(actualPath);
    const referenceSha = sha256(referencePath);
    if (options.verifyHashes !== false) {
      if (item.actualSha256 && String(item.actualSha256).toLowerCase() !== actualSha) {
        throw new Error(`actual SHA256 不匹配：${item.name}`);
      }
      if (item.referenceSha256 && String(item.referenceSha256).toLowerCase() !== referenceSha) {
        throw new Error(`reference SHA256 不匹配：${item.name}`);
      }
    }
    return Object.assign({}, item, {
      actualPath,
      referencePath,
      actualSha256: actualSha,
      referenceSha256: referenceSha,
    });
  });
  return {
    schemaVersion: 1,
    viewport: { width: REQUIRED_VIEWPORT.width, height: REQUIRED_VIEWPORT.height },
    capture: Object.assign({}, capture),
    pages: checkedPages,
  };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifestPath = resolveFromRoot(root, options.manifest || DEFAULT_MANIFEST);
  const manifest = readJson(manifestPath);
  const normalized = validateManifest(manifest, root, options);
  const threshold = options.threshold === undefined ? 32 : Number(options.threshold);
  const maxDiffRatio = options.maxDiffRatio === undefined ? 0.5 : Number(options.maxDiffRatio);
  const outputRoot = resolveFromRoot(root, options.output || DEFAULT_OUTPUT);
  fs.mkdirSync(outputRoot, { recursive: true });
  const results = normalized.pages.map(page => {
    const summary = regression.runRegression({
      actualPath: page.actualPath,
      referencePath: page.referencePath,
      threshold,
      maxDiffRatio,
      outputPath: path.join(outputRoot, `${page.name}.png`),
    });
    return {
      name: page.name,
      actual: page.actual,
      reference: page.reference,
      actualSha256: page.actualSha256,
      referenceSha256: page.referenceSha256,
      width: summary.width,
      height: summary.height,
      scaled: summary.scaled,
      differentPixels: summary.differentPixels,
      totalPixels: summary.totalPixels,
      diffRatio: summary.diffRatio,
      meanMaxChannelDiff: summary.meanMaxChannelDiff,
      maxChannelDiff: summary.maxChannelDiff,
      pass: summary.pass,
      heatmap: summary.heatmapPath,
    };
  });
  return {
    schemaVersion: 1,
    status: results.every(item => item.pass) ? "pass" : "fail",
    ok: results.every(item => item.pass),
    manifestPath,
    renderer: normalized.capture.renderer,
    device: normalized.capture.device,
    viewport: normalized.viewport,
    threshold,
    maxDiffRatio,
    pages: results,
    checkedAt: new Date().toISOString(),
  };
}

function parseArgs(argv) {
  const result = { manifest: DEFAULT_MANIFEST, output: DEFAULT_OUTPUT, threshold: 32, maxDiffRatio: 0.5 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (key === "help") { result.help = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) result[key] = true;
    else { result[key] = value; index += 1; }
  }
  if (result.noVerifyHashes) result.verifyHashes = false;
  return result;
}

function printUsage() {
  console.log([
    "用法：node scripts/admin-v2-same-device-baseline.js [选项]",
    "  --manifest <文件>       同设备基线 manifest",
    "  --output <目录>         差异热图输出目录",
    "  --threshold <数值>      单像素通道差阈值（默认 32）",
    "  --max-diff-ratio <数值> 最大差异比例（默认 0.5）",
    "  --no-verify-hashes      只校验图片，不比较 manifest 中旧 SHA256",
  ].join("\n"));
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { printUsage(); return 0; }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`同设备视觉基线失败：${error.message || error}`);
    return 2;
  }
}

module.exports = {
  ROOT,
  DEFAULT_MANIFEST,
  DEFAULT_OUTPUT,
  PAGE_NAMES,
  REQUIRED_VIEWPORT,
  sha256,
  resolveFromRoot,
  readJson,
  validateManifest,
  run,
  parseArgs,
  main,
};

if (require.main === module) process.exitCode = main();
