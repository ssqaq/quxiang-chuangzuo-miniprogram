/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MAX_DIFF_RATIO = 0.5;
const MANIFEST_PATH = path.join(ROOT, "visual-evidence", "admin-v2-pixel-manifest.json");
const FALLBACK_BASELINES = [
  { name: "dashboard", actual: "visual-evidence/final-dashboard-v5-390x844.png", reference: "visual-evidence/pixel-baselines/dashboard-operations-reference-390x844.png" },
  { name: "operations", actual: "visual-evidence/final-operations-v5-390x844.png", reference: "visual-evidence/pixel-baselines/operations-usage-reference-390x844.png" },
  { name: "config", actual: "visual-evidence/final-config-v6-390x844.png", reference: "visual-evidence/pixel-baselines/config-reference.png" },
  { name: "provider", actual: "visual-evidence/final-provider-v6-390x844.png", reference: "visual-evidence/pixel-baselines/provider-reference.png" }
];

function readBaselines() {
  if (!fs.existsSync(MANIFEST_PATH)) return FALLBACK_BASELINES;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.pages)) {
    throw new Error(`像素基线 manifest 无效：${MANIFEST_PATH}`);
  }
  return manifest.pages.map(item => ({ name: item.name, actual: item.actual, reference: item.reference }));
}

const BASELINES = readBaselines();

function parseArgs(argv) {
  const result = { maxDiffRatio: DEFAULT_MAX_DIFF_RATIO, threshold: 32 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) result[key] = true;
    else { result[key] = value; index += 1; }
  }
  return result;
}

function run(options = {}) {
  const maxDiffRatio = options.maxDiffRatio === undefined ? DEFAULT_MAX_DIFF_RATIO : Number(options.maxDiffRatio);
  const threshold = options.threshold === undefined ? 32 : Number(options.threshold);
  const outputRoot = path.resolve(ROOT, options.outputRoot || "visual-evidence/pixel-diffs");
  fs.mkdirSync(outputRoot, { recursive: true });
  const results = BASELINES.map(item => {
    const summary = regression.runRegression({
      actualPath: path.resolve(ROOT, item.actual),
      referencePath: path.resolve(ROOT, item.reference),
      outputPath: path.join(outputRoot, `${item.name}.png`),
      threshold,
      maxDiffRatio
    });
    return Object.assign({ name: item.name }, summary, { heatmap: summary.heatmapPath });
  });
  return { pass: results.every(item => item.pass), threshold, maxDiffRatio, results };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-pixel-baseline.js [--threshold 32] [--max-diff-ratio 0.5] [--output-root visual-evidence/pixel-diffs]");
    return 0;
  }
  try {
    const report = run(options);
    report.results.forEach(item => {
      console.log(`${item.name}: ${item.pass ? "PASS" : "FAIL"} ${(item.diffRatio * 100).toFixed(3)}% (${item.differentPixels}/${item.totalPixels})`);
      console.log(`  actual: ${item.actualPath}`);
      console.log(`  reference: ${item.referencePath}`);
      console.log(`  heatmap: ${item.heatmapPath}`);
    });
    return report.pass ? 0 : 1;
  } catch (error) {
    console.error(`四页像素基线失败：${error.message || error}`);
    return 2;
  }
}

module.exports = { BASELINES, parseArgs, run, main };

if (require.main === module) process.exitCode = main();
