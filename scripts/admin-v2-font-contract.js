/* eslint-disable no-console */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const layout = require("./admin-v2-layout-contract");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "font-contract.json");
const PAGE_STYLES = [
  ["dashboard", "pages/admin-dashboard/admin-dashboard.wxss"],
  ["operations", "pages/admin-operations/admin-operations.wxss"],
  ["config", "pages/admin-config/admin-config.wxss"],
  ["provider", "pages/admin-provider/admin-provider.wxss"],
];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const pages = PAGE_STYLES.map(([name, relativePath]) => {
    const filePath = path.resolve(root, relativePath);
    if (!fs.existsSync(filePath)) throw new Error(`字体合同文件不存在：${filePath}`);
    const source = fs.readFileSync(filePath, "utf8");
    const actual = layout.cssValue(source, "page", "font-family");
    return {
      name,
      path: relativePath,
      sourceSha256: sha256(filePath),
      expected: layout.FONT_STACK,
      actual,
      pass: actual === layout.FONT_STACK,
    };
  });
  const report = {
    schemaVersion: 1,
    status: pages.every(page => page.pass) ? "pass" : "fail",
    ok: pages.every(page => page.pass),
    profile: "admin-reference-font-v1",
    fontStack: layout.FONT_STACK,
    pages,
    checkedAt: new Date().toISOString(),
  };
  if (options.output !== false) {
    const output = path.resolve(root, options.output || path.relative(root, DEFAULT_OUTPUT));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.output = output;
  }
  return report;
}

function parseArgs(argv) {
  const result = { root: ROOT, output: path.relative(ROOT, DEFAULT_OUTPUT) };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") result.help = true;
    else if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--output") result.output = argv[++index] || result.output;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-font-contract.js [--root <目录>] [--output <文件>]");
    return 0;
  }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`字体合同失败：${error.message || error}`);
    return 2;
  }
}

module.exports = { ROOT, PAGE_STYLES, run, parseArgs, main };

if (require.main === module) process.exitCode = main();
