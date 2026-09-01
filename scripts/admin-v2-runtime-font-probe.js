/* eslint-disable no-console */

/** 校验浏览器 evaluate 采集到的实际生效字体，而不是只看 wxss 源码。 */

const fs = require("fs");
const path = require("path");
const layout = require("./admin-v2-layout-contract");
const geometry = require("./admin-v2-runtime-geometry-probe");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "visual-evidence", "runtime-font", "browser-font-probe.json");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "runtime-font", "font-runtime-contract.json");

function normalizeFontStack(value) {
  return String(value || "").replace(/\s*,\s*/g, ",").replace(/"/g, "").trim().toLowerCase();
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const inputPath = path.resolve(root, options.input || path.relative(root, DEFAULT_INPUT));
  const input = geometry.readJson(inputPath);
  const expected = layout.FONT_STACK;
  const errors = [];
  if (input.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (input.fixtureId !== geometry.EXPECTED_FIXTURE_ID) errors.push("fixtureId 不匹配");
  if (input.fontProfile !== geometry.EXPECTED_FONT_PROFILE) errors.push("fontProfile 不匹配");
  const pages = Array.isArray(input.pages) ? input.pages : [];
  const results = geometry.PAGE_NAMES.map(name => {
    const page = pages.find(item => item.name === name) || {};
    const samples = Array.isArray(page.samples) ? page.samples : [];
    const values = samples.map(sample => ({ selector: sample.selector, actual: sample.fontFamily || "", pass: normalizeFontStack(sample.fontFamily) === normalizeFontStack(expected) }));
    if (!page.pageFontFamily) errors.push(`${name} 缺少 pageFontFamily`);
    if (page.pageFontFamily && normalizeFontStack(page.pageFontFamily) !== normalizeFontStack(expected)) errors.push(`${name} 页面字体不匹配`);
    if (!values.length) errors.push(`${name} 缺少字体样本`);
    values.filter(item => !item.pass).forEach(item => errors.push(`${name} ${item.selector || "sample"} 字体不匹配`));
    return { name, pageFontFamily: page.pageFontFamily || "", samples: values, pass: Boolean(page.pageFontFamily) && normalizeFontStack(page.pageFontFamily) === normalizeFontStack(expected) && values.length > 0 && values.every(item => item.pass) };
  });
  const report = { schemaVersion: 1, status: errors.length ? "fail" : "pass", ok: errors.length === 0, profile: geometry.EXPECTED_FONT_PROFILE, fontStack: expected, pages: results, errors, checkedAt: new Date().toISOString() };
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
  if (options.help) { console.log("用法：node scripts/admin-v2-runtime-font-probe.js [--root <目录>] [--input <JSON>] [--output <JSON>]"); return 0; }
  try { const report = run(options); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.ok ? 0 : 1; }
  catch (error) { console.error(`运行时字体探针失败：${error.message || error}`); return 2; }
}

module.exports = { ROOT, DEFAULT_INPUT, DEFAULT_OUTPUT, normalizeFontStack, run, parseArgs, main };
if (require.main === module) process.exitCode = main();
