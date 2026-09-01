/* eslint-disable no-console */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "visual-evidence", "admin-v2-state-matrix.json");
const FIXTURE_ID = "admin-v2-reference-20260901-v1";
const FONT_PROFILE = "admin-reference-font-v1";
const VIEWPORT = Object.freeze({ width: 390, height: 844 });
const STATES = Object.freeze([
  Object.freeze({ id: "collapsed-default-v1", pages: Object.freeze(["dashboard", "operations", "config", "provider"]), expected: Object.freeze({ mainExpanded: false, backupExpanded: false, advancedExpanded: false }) }),
  Object.freeze({ id: "expanded-v1", pages: Object.freeze(["config"]), expected: Object.freeze({ mainExpanded: true, backupExpanded: true, advancedExpanded: true }) }),
  Object.freeze({ id: "backup-disabled-v1", pages: Object.freeze(["config"]), expected: Object.freeze({ mainExpanded: true, backupExpanded: true, advancedExpanded: false, backupStatus: "not-ready" }) }),
  Object.freeze({ id: "video-mode-v1", pages: Object.freeze(["config"]), expected: Object.freeze({ mainExpanded: true, backupExpanded: true, advancedExpanded: true, group: "shared", tab: "video" }) })
]);

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolve(root, value) {
  return path.isAbsolute(String(value || "")) ? path.resolve(String(value)) : path.resolve(root, String(value || ""));
}

function validate(manifest, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("状态矩阵 manifest 必须是对象。");
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (manifest.fixtureId !== FIXTURE_ID) errors.push(`fixtureId 必须为 ${FIXTURE_ID}`);
  if (manifest.fontProfile !== FONT_PROFILE) errors.push(`fontProfile 必须为 ${FONT_PROFILE}`);
  const states = Array.isArray(manifest.states) ? manifest.states : [];
  if (JSON.stringify(states.map(item => item && item.id)) !== JSON.stringify(STATES.map(item => item.id))) errors.push("四个状态必须完整且顺序固定");
  const checkedStates = STATES.map(contract => {
    const state = states.find(item => item && item.id === contract.id) || {};
    const pages = Array.isArray(state.pages) ? state.pages : [];
    const stateErrors = [];
    if (JSON.stringify(state.expected || {}) !== JSON.stringify(contract.expected)) stateErrors.push("expected 展开/模式合同不匹配");
    if (JSON.stringify(pages.map(item => item && item.name)) !== JSON.stringify(contract.pages)) stateErrors.push(`页面必须为 ${contract.pages.join("、")}`);
    const checkedPages = contract.pages.map(name => {
      const page = pages.find(item => item && item.name === name) || {};
      const filePath = resolve(root, page.screenshot);
      const pageErrors = [];
      if (!page.screenshot || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) pageErrors.push("截图不存在");
      else {
        const image = regression.decodeImage(filePath);
        if (image.width !== VIEWPORT.width || image.height !== VIEWPORT.height) pageErrors.push(`截图尺寸为 ${image.width}x${image.height}`);
        const actualHash = sha256(filePath);
        if (page.sha256 && String(page.sha256).toLowerCase() !== actualHash) pageErrors.push("SHA256 不匹配");
        page.sha256 = actualHash;
      }
      return { name, screenshot: page.screenshot || "", sha256: page.sha256 || "", errors: pageErrors, pass: pageErrors.length === 0 };
    });
    checkedPages.forEach(page => page.errors.forEach(error => stateErrors.push(`${page.name}：${error}`)));
    return { id: contract.id, expected: contract.expected, pages: checkedPages, errors: stateErrors, pass: stateErrors.length === 0 };
  });
  checkedStates.forEach(state => state.errors.forEach(error => errors.push(`${state.id}：${error}`)));
  return { schemaVersion: 1, ok: errors.length === 0, status: errors.length ? "fail" : "pass", fixtureId: manifest.fixtureId || null, fontProfile: manifest.fontProfile || null, viewport: VIEWPORT, states: checkedStates, errors };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifestPath = resolve(root, options.manifest || DEFAULT_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`状态矩阵 manifest 不存在：${manifestPath}`);
  const report = validate(JSON.parse(fs.readFileSync(manifestPath, "utf8")), { root });
  report.manifestPath = manifestPath;
  report.checkedAt = new Date().toISOString();
  return report;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") result.help = true;
    else if (argv[index] === "--root") result.root = argv[++index];
    else if (argv[index] === "--manifest") result.manifest = argv[++index];
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log("用法：node scripts/admin-v2-state-matrix.js [--manifest <JSON>]"); return 0; }
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) { console.error(`状态矩阵失败：${error.message || error}`); return 2; }
}

module.exports = { ROOT, DEFAULT_MANIFEST, FIXTURE_ID, FONT_PROFILE, VIEWPORT, STATES, sha256, resolve, validate, run, parseArgs, main };
if (require.main === module) process.exitCode = main();
