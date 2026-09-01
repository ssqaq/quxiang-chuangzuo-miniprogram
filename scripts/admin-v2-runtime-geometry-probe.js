/* eslint-disable no-console */

/**
 * 校验真实浏览器/开发者工具采集的四页运行时几何数据。
 * 输入由浏览器 evaluate 生成，不依赖具体浏览器自动化库，便于 CI 和本地复核。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "visual-evidence", "runtime-geometry", "browser-probe.json");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "runtime-geometry", "geometry-contract.json");
const EXPECTED_FIXTURE_ID = "admin-v2-reference-20260901-v1";
const EXPECTED_FONT_PROFILE = "admin-reference-font-v1";
const EXPECTED_VIEWPORT = { width: 390, height: 844 };
const PAGE_NAMES = ["dashboard", "operations", "config", "provider"];
const REQUIRED_SELECTORS = {
  // 浏览器参考层把小程序页面包在统一 phone-screen 外壳里，运行时应检查
  // 外壳和真实内容框，而不是把 DevTools 专用 WXML 类名硬套到网页预览。
  dashboard: [".phone-screen", ".appbar", ".app-content"],
  operations: [".phone-screen", ".appbar", ".app-content"],
  config: [".phone-screen", ".appbar", ".app-content", ".advanced-grid", ".save-wrap"],
  provider: [".phone-screen", ".provider-layout", ".app-content", ".field-label"],
};

function readJson(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`运行时几何输入不存在：${resolved}`);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function checkRect(rect, viewport) {
  if (!rect || number(rect.width) === null || number(rect.height) === null) return { pass: false, reason: "缺少矩形尺寸" };
  if (rect.width <= 0 || rect.height <= 0) return { pass: false, reason: "矩形尺寸非正数" };
  const left = number(rect.left);
  const right = number(rect.right);
  if (left === null || right === null) return { pass: false, reason: "缺少横向边界" };
  if (left < -1 || right > viewport.width + 1) return { pass: false, reason: `横向越界 left=${left}, right=${right}` };
  return { pass: true, reason: "" };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const inputPath = path.resolve(root, options.input || path.relative(root, DEFAULT_INPUT));
  const input = readJson(inputPath);
  const errors = [];
  if (input.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (input.fixtureId !== EXPECTED_FIXTURE_ID) errors.push(`fixtureId 必须为 ${EXPECTED_FIXTURE_ID}`);
  if (input.fontProfile !== EXPECTED_FONT_PROFILE) errors.push(`fontProfile 必须为 ${EXPECTED_FONT_PROFILE}`);
  if (!input.viewport || input.viewport.width !== EXPECTED_VIEWPORT.width || input.viewport.height !== EXPECTED_VIEWPORT.height) {
    errors.push("顶层 viewport 必须为 390x844");
  }
  const pages = Array.isArray(input.pages) ? input.pages : [];
  const byName = new Map(pages.map(page => [page.name, page]));
  if (pages.length !== PAGE_NAMES.length || PAGE_NAMES.some(name => !byName.has(name))) errors.push("四页名称必须完整且不能重复");
  const results = PAGE_NAMES.map(name => {
    const page = byName.get(name) || {};
    const viewport = page.viewport || {};
    const pageErrors = [];
    if (viewport.width !== EXPECTED_VIEWPORT.width || viewport.height !== EXPECTED_VIEWPORT.height) pageErrors.push("视口不是 390x844");
    if (number(viewport.dpr) === null || viewport.dpr <= 0) pageErrors.push("DPR 无效");
    if (number(viewport.scrollWidth) === null || viewport.scrollWidth > EXPECTED_VIEWPORT.width) pageErrors.push(`横向滚动宽度异常：${viewport.scrollWidth}`);
    const elements = Array.isArray(page.elements) ? page.elements : [];
    const elementMap = new Map(elements.map(element => [element.selector, element]));
    const elementResults = REQUIRED_SELECTORS[name].map(selector => {
      const element = elementMap.get(selector);
      const check = checkRect(element && element.rect, EXPECTED_VIEWPORT);
      if (!element) pageErrors.push(`${selector} 未采集`);
      else if (!check.pass) pageErrors.push(`${selector}：${check.reason}`);
      return { selector, present: Boolean(element), ...check };
    });
    return { name, viewport, elements: elementResults, errors: pageErrors, pass: pageErrors.length === 0 };
  });
  results.forEach(page => page.errors.forEach(error => errors.push(`${page.name}：${error}`)));
  const report = {
    schemaVersion: 1,
    status: errors.length === 0 ? "pass" : "fail",
    ok: errors.length === 0,
    fixtureId: input.fixtureId || null,
    fontProfile: input.fontProfile || null,
    viewport: EXPECTED_VIEWPORT,
    pages: results,
    errors,
    checkedAt: new Date().toISOString(),
  };
  if (options.output !== false) {
    const outputPath = path.resolve(root, options.output || path.relative(root, DEFAULT_OUTPUT));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.output = outputPath;
  }
  return report;
}

function parseArgs(argv) {
  const result = { root: ROOT, input: path.relative(ROOT, DEFAULT_INPUT), output: path.relative(ROOT, DEFAULT_OUTPUT) };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") result.help = true;
    else if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--input") result.input = argv[++index] || result.input;
    else if (token === "--output") result.output = argv[++index] || result.output;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-runtime-geometry-probe.js [--root <目录>] [--input <JSON>] [--output <JSON>]");
    return 0;
  }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`运行时几何探针失败：${error.message || error}`);
    return 2;
  }
}

module.exports = { ROOT, DEFAULT_INPUT, DEFAULT_OUTPUT, EXPECTED_FIXTURE_ID, EXPECTED_FONT_PROFILE, EXPECTED_VIEWPORT, PAGE_NAMES, REQUIRED_SELECTORS, readJson, checkRect, run, parseArgs, main };

if (require.main === module) process.exitCode = main();
