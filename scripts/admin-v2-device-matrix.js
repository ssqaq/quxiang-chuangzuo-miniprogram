/* eslint-disable no-console */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(ROOT, "visual-evidence", "admin-v2-device-matrix.json");
const FIXTURE_ID = "admin-v2-reference-20260901-v1";
const FONT_PROFILE = "admin-reference-font-v1";
const PAGE_NAMES = Object.freeze(["dashboard", "operations", "config", "provider"]);
const DEVICES = Object.freeze([
  Object.freeze({ id: "compact-375x812", width: 375, height: 812 }),
  Object.freeze({ id: "reference-390x844", width: 390, height: 844 }),
  Object.freeze({ id: "large-430x932", width: 430, height: 932 })
]);

function sha256(filePath) { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"); }
function resolve(root, value) { return path.isAbsolute(String(value || "")) ? path.resolve(String(value)) : path.resolve(root, String(value || "")); }

function validate(manifest, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("设备矩阵 manifest 必须是对象。");
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (manifest.fixtureId !== FIXTURE_ID) errors.push(`fixtureId 必须为 ${FIXTURE_ID}`);
  if (manifest.fontProfile !== FONT_PROFILE) errors.push(`fontProfile 必须为 ${FONT_PROFILE}`);
  if (!String(manifest.renderer || "").trim()) errors.push("renderer 不能为空");
  const devices = Array.isArray(manifest.devices) ? manifest.devices : [];
  if (JSON.stringify(devices.map(item => item && item.id)) !== JSON.stringify(DEVICES.map(item => item.id))) errors.push("三档设备必须完整且顺序固定");
  const checkedDevices = DEVICES.map(contract => {
    const device = devices.find(item => item && item.id === contract.id) || {};
    const deviceErrors = [];
    const pages = Array.isArray(device.pages) ? device.pages : [];
    if (JSON.stringify(pages.map(item => item && item.name)) !== JSON.stringify(PAGE_NAMES)) deviceErrors.push("四页必须完整且顺序固定");
    const checkedPages = PAGE_NAMES.map(name => {
      const page = pages.find(item => item && item.name === name) || {};
      const pageErrors = [];
      const filePath = resolve(root, page.screenshot);
      if (!page.screenshot || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) pageErrors.push("截图不存在");
      else {
        const image = regression.decodeImage(filePath);
        if (image.width !== contract.width || image.height !== contract.height) pageErrors.push(`截图尺寸为 ${image.width}x${image.height}`);
        const actualHash = sha256(filePath);
        if (page.sha256 && String(page.sha256).toLowerCase() !== actualHash) pageErrors.push("SHA256 不匹配");
        page.sha256 = actualHash;
      }
      const viewport = page.viewport || {};
      if (Number(viewport.width) !== contract.width || Number(viewport.height) !== contract.height) pageErrors.push("运行时 viewport 不匹配");
      if (!Number.isFinite(Number(viewport.dpr)) || Number(viewport.dpr) <= 0) pageErrors.push("DPR 无效");
      if (!Number.isFinite(Number(viewport.scrollWidth)) || Number(viewport.scrollWidth) > contract.width) pageErrors.push(`横向溢出：${viewport.scrollWidth}`);
      return { name, screenshot: page.screenshot || "", sha256: page.sha256 || "", viewport, errors: pageErrors, pass: pageErrors.length === 0 };
    });
    checkedPages.forEach(page => page.errors.forEach(error => deviceErrors.push(`${page.name}：${error}`)));
    return { id: contract.id, width: contract.width, height: contract.height, pages: checkedPages, errors: deviceErrors, pass: deviceErrors.length === 0 };
  });
  checkedDevices.forEach(device => device.errors.forEach(error => errors.push(`${device.id}：${error}`)));
  return { schemaVersion: 1, ok: errors.length === 0, status: errors.length ? "fail" : "pass", fixtureId: manifest.fixtureId || null, fontProfile: manifest.fontProfile || null, renderer: manifest.renderer || null, devices: checkedDevices, errors };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifestPath = resolve(root, options.manifest || DEFAULT_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new Error(`设备矩阵 manifest 不存在：${manifestPath}`);
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
    if (options.help) { console.log("用法：node scripts/admin-v2-device-matrix.js [--manifest <JSON>]"); return 0; }
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) { console.error(`设备矩阵失败：${error.message || error}`); return 2; }
}
module.exports = { ROOT, DEFAULT_MANIFEST, FIXTURE_ID, FONT_PROFILE, PAGE_NAMES, DEVICES, sha256, resolve, validate, run, parseArgs, main };
if (require.main === module) process.exitCode = main();
