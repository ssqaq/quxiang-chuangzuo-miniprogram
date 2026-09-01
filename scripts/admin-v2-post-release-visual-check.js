/* eslint-disable no-console */

/**
 * 发布后视觉回归入口：截图（可选）、布局合同、字体合同、像素差异和证据归档一次完成。
 * 没有 miniprogram-automator 时，--allow-existing 允许复用已验收截图，但会在报告中明示。
 */

const fs = require("fs");
const path = require("path");
const capture = require("./admin-v2-visual-capture");
const layout = require("./admin-v2-layout-contract");
const font = require("./admin-v2-font-contract");
const diff = require("./admin-v2-pixel-diff-report");
const archive = require("./admin-v2-visual-archive");
const indexer = require("./admin-v2-visual-index");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SOURCE = path.join(ROOT, "visual-evidence", "captured-final-v8");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "post-release");
const DEFAULT_SOURCE_RELATIVE = path.join("visual-evidence", "captured-final-v8");
const DEFAULT_OUTPUT_RELATIVE = path.join("visual-evidence", "post-release");
const DEFAULT_FIXTURE_ID = "admin-v2-reference-20260901-v1";
const DEFAULT_FONT_PROFILE = "admin-reference-font-v1";
const DEFAULT_STATE_ID = "collapsed-default-v1";
const PAGE_NAMES = ["dashboard", "operations", "config", "provider"];

function resolve(root, value) { return path.isAbsolute(String(value || "")) ? path.resolve(String(value)) : path.resolve(root, String(value || "")); }

function screenshotFiles(sourceRoot) {
  return PAGE_NAMES.map(name => {
    const candidates = [path.join(sourceRoot, `${name}.png`), path.join(sourceRoot, `${name}-390x844.png`), path.join(sourceRoot, `${name}-browser-390x844.png`)];
    const filePath = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0);
    if (!filePath) throw new Error(`发布后截图不存在或为空：${candidates[0]}`);
    return filePath;
  });
}

async function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const version = String(options.version || "local").trim();
  if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`发布后检查版本名不安全：${version}`);
  const outputRoot = options.outputRoot ? resolve(root, options.outputRoot) : path.join(root, DEFAULT_OUTPUT_RELATIVE);
  const reportDir = path.join(outputRoot, `v${version}`);
  fs.mkdirSync(reportDir, { recursive: true });
  const requestedSource = options.source ? resolve(root, options.source) : path.join(root, DEFAULT_SOURCE_RELATIVE);
  let sourceRoot = requestedSource;
  let captureStatus = "reused-existing";
  let captureResult = null;
  if (options.capture) {
    try {
      const captureOutput = resolve(root, options.captureOutput || path.join("visual-evidence", `captured-post-release-v${version}`));
      captureResult = await capture.capture({ project: options.project || root, cli: options.cli || "", output: captureOutput, fixtureId: options.fixtureId || DEFAULT_FIXTURE_ID, demo: true, connectPort: Number(options.connectPort || 0) });
      sourceRoot = captureOutput;
      captureStatus = "captured";
    } catch (error) {
      if (!options.allowExisting) throw error;
      captureStatus = "capture-failed-reused-existing";
      captureResult = { error: error.message || String(error) };
      sourceRoot = requestedSource;
    }
  }
  const screenshots = screenshotFiles(sourceRoot);
  const layoutReport = options.skipContracts ? { status: "skipped", ok: true } : layout.run({ root, output: path.relative(root, path.join(reportDir, "layout-contract.json")) });
  const fontReport = options.skipContracts ? { status: "skipped", ok: true } : font.run({ root, output: path.relative(root, path.join(reportDir, "font-contract.json")) });
  const pixelReport = options.skipDiff ? { status: "skipped", ok: true } : diff.run({ root, json: path.relative(root, path.join(reportDir, "pixel-diff-report.json")), markdown: path.relative(root, path.join(reportDir, "pixel-diff-report.md")), heatmapRoot: path.relative(root, path.join(reportDir, "heatmaps")) });
  if (!layoutReport.ok || !fontReport.ok || !pixelReport.ok) throw new Error("发布后视觉合同或像素差异检查未通过");
  const reportPath = path.join(reportDir, "visual-check.json");
  const report = { schemaVersion: 1, status: "pass", ok: true, version, fixtureId: options.fixtureId || DEFAULT_FIXTURE_ID, fontProfile: DEFAULT_FONT_PROFILE, stateId: DEFAULT_STATE_ID, viewport: { width: 390, height: 844 }, capture: { status: captureStatus, source: path.relative(root, sourceRoot).replace(/\\/g, "/"), result: captureResult }, checks: { layout: layoutReport, font: fontReport, pixel: pixelReport }, checkedAt: new Date().toISOString() };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const optionalEvidence = [
    "visual-evidence/admin-v2-browser-reference-manifest.json",
    "visual-evidence/runtime-geometry/browser-probe.json",
    "visual-evidence/runtime-font/browser-font-probe.json",
    "visual-evidence/admin-v2-state-matrix.json",
    "visual-evidence/admin-v2-device-matrix.json",
  ];
  const reportFiles = [...archive.DEFAULT_REPORTS, ...optionalEvidence].map(relative => resolve(root, relative)).filter(filePath => fs.existsSync(filePath));
  reportFiles.push(reportPath);
  const archiveResult = archive.run({ root, version, source: sourceRoot, outputRoot: options.archiveRoot || path.join("visual-evidence", "archive"), files: screenshots, reports: reportFiles, retention: options.retention === undefined ? archive.DEFAULT_RETENTION : options.retention });
  const indexResult = indexer.run({ root, archiveRoot: options.archiveRoot || path.join("visual-evidence", "archive") });
  report.archive = { manifestPath: archiveResult.manifestPath, prunedVersions: archiveResult.prunedVersions, keptVersions: archiveResult.keptVersions, indexJsonPath: indexResult.jsonPath, indexHtmlPath: indexResult.htmlPath };
  // 归档前的 report 是不可变输入；归档后只给调用方返回路径，不能回写，
  // 否则 archive-manifest 里的 SHA256 会立刻失真。
  return report;
}

function parseArgs(argv) {
  const result = { root: ROOT, version: "local", allowExisting: false, retention: archive.DEFAULT_RETENTION };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") result.help = true;
    else if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--version") result.version = argv[++index] || result.version;
    else if (token === "--source") result.source = argv[++index] || result.source;
    else if (token === "--output-root") result.outputRoot = argv[++index] || result.outputRoot;
    else if (token === "--archive-root") result.archiveRoot = argv[++index] || result.archiveRoot;
    else if (token === "--capture-output") result.captureOutput = argv[++index] || result.captureOutput;
    else if (token === "--project") result.project = argv[++index] || result.project;
    else if (token === "--cli") result.cli = argv[++index] || result.cli;
    else if (token === "--connect-port") result.connectPort = Number(argv[++index] || 0);
    else if (token === "--fixture-id") result.fixtureId = argv[++index] || result.fixtureId;
    else if (token === "--retain") result.retention = Number(argv[++index] || result.retention);
    else if (token === "--capture") result.capture = true;
    else if (token === "--allow-existing") result.allowExisting = true;
    else if (token === "--skip-contracts") result.skipContracts = true;
    else if (token === "--skip-diff") result.skipDiff = true;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log("用法：node scripts/admin-v2-post-release-visual-check.js --version <版本> [--capture] [--allow-existing] [--retain <数量>]"); return 0; }
  run(options).then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = 0; }).catch(error => { console.error(`发布后视觉检查失败：${error.stack || error}`); process.exitCode = 1; });
  return undefined;
}

module.exports = { ROOT, DEFAULT_SOURCE, DEFAULT_OUTPUT, DEFAULT_FIXTURE_ID, DEFAULT_FONT_PROFILE, DEFAULT_STATE_ID, PAGE_NAMES, resolve, screenshotFiles, run, parseArgs, main };
if (require.main === module) main();
