/* eslint-disable no-console */

/**
 * 四页视觉布局合同。
 *
 * 这是静态闸门：把截图里最容易回归的尺寸、字体和横向边界写成机器可读
 * 的合同，发布前先阻止明显的撑宽、字号和按钮尺寸回退。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "layout-contract.json");
const FONT_STACK = '"Microsoft YaHei","PingFang SC","SimHei",system-ui,sans-serif';

const CONTRACTS = [
  {
    name: "dashboard",
    wxml: "pages/admin-dashboard/admin-dashboard.wxml",
    wxss: "pages/admin-dashboard/admin-dashboard.wxss",
    selectors: [".dashboard-page", ".appbar", ".dashboard-scroll", ".appbar-title"],
    checks: [
      ["page font-family", "page", "font-family", FONT_STACK],
      ["page overflow-x", ".dashboard-page", "overflow-x", "hidden"],
      ["scroll width", ".dashboard-scroll", "width", "calc(100% - 48rpx)"],
      ["title font-size", ".appbar-title", "font-size", "42rpx"],
    ],
  },
  {
    name: "operations",
    wxml: "pages/admin-operations/admin-operations.wxml",
    wxss: "pages/admin-operations/admin-operations.wxss",
    selectors: [".operations-page", ".appbar", ".operations-scroll", ".detail-toggle"],
    checks: [
      ["page font-family", "page", "font-family", FONT_STACK],
      ["page overflow-x", ".operations-page", "overflow-x", "hidden"],
      ["scroll width", ".operations-scroll", "width", "calc(100% - 48rpx)"],
      ["detail toggle width", ".detail-toggle", "width", "112rpx"],
      ["detail toggle height", ".detail-toggle", "height", "65rpx"],
      ["detail toggle font-size", ".detail-toggle", "font-size", "19rpx"],
    ],
  },
  {
    name: "config",
    wxml: "pages/admin-config/admin-config.wxml",
    wxss: "pages/admin-config/admin-config.wxss",
    selectors: [".config-page", ".appbar", ".config-scroll", ".save-btn", ".return-btn", ".advanced-selects .picker-value"],
    checks: [
      ["page font-family", "page", "font-family", FONT_STACK],
      ["page overflow-x", ".config-page", "overflow-x", "hidden"],
      ["scroll width", ".config-scroll", "width", "100%"],
      ["save width", ".config-page .save-btn", "width", "100%"],
      ["save height", ".save-btn", "height", "96rpx"],
      ["advanced value alignment", ".advanced-selects .picker-value", "text-align", "center"],
    ],
  },
  {
    name: "provider",
    wxml: "pages/admin-provider/admin-provider.wxml",
    wxss: "pages/admin-provider/admin-provider.wxss",
    selectors: [".provider-page", ".appbar", ".provider-scroll", ".provider-card", ".provider-layout", ".editor-panel", ".editor-scroll", ".editor-actions", ".field-label"],
    checks: [
      ["page font-family", "page", "font-family", FONT_STACK],
      ["page overflow-x", ".provider-page", "overflow-x", "hidden"],
      ["scroll width", ".provider-scroll", "width", "100%"],
      ["provider card height", ".provider-card", "height", "100%"],
      ["provider card overflow", ".provider-card", "overflow", "hidden"],
      ["two-column layout", ".provider-layout", "grid-template-columns", "242rpx minmax(0,1fr)"],
      ["field label font-size", ".field-label", "font-size", "19rpx"],
      ["editor layout flex", ".provider-layout", "flex", "1 1 auto"],
      ["blank-space layout position", ".provider-layout", "position", "relative"],
      ["blank-space directory position", ".directory-panel", "position", "absolute"],
      ["blank-space directory top", ".directory-panel", "top", "0"],
      ["blank-space directory bottom", ".directory-panel", "bottom", "0"],
      ["blank-space directory left", ".directory-panel", "left", "0"],
      ["blank-space directory overflow", ".directory-panel", "overflow", "hidden"],
      ["blank-space directory min-height", ".directory-panel", "min-height", "0"],
      ["blank-space editor min-height", ".editor-panel", "min-height", "0"],
      ["editor panel overflow", ".editor-panel", "overflow", "hidden"],
      ["blank-space editor column", ".editor-panel", "grid-column", "2"],
      ["editor scroll height", ".editor-scroll", "height", "0"],
      ["editor scroll flex", ".editor-scroll", "flex", "1 1 auto"],
      ["editor scroll overflow", ".editor-scroll", "overflow-y", "scroll"],
      ["blank-space list flex", ".provider-list", "flex", "1 1 auto"],
      ["blank-space list height", ".provider-list", "height", "auto"],
      ["blank-space list max-height", ".provider-list", "max-height", "none"],
      ["blank-space actions margin-top", ".editor-actions", "margin-top", "16rpx"],
      ["editor actions flex", ".editor-actions", "flex", "0 0 auto"],
      ["editor actions columns", ".editor-actions", "grid-template-columns", "repeat(2,minmax(0,1fr))"],
      ["editor actions padding", ".editor-actions", "padding", "16rpx 6rpx 0"],
      ["endpoint input left padding", ".provider-page .endpoint-field input", "padding-left", "12rpx"],
      ["key input left padding", ".provider-page .key-field input", "padding-left", "12rpx"],
      ["endpoint input alignment", ".provider-page .endpoint-field input", "text-align", "left"],
      ["key input alignment", ".provider-page .key-field input", "text-align", "left"],
    ],
  },
];

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function read(relativePath, root = ROOT) {
  const filePath = path.resolve(root, relativePath);
  if (!fs.existsSync(filePath)) throw new Error(`布局合同文件不存在：${filePath}`);
  return { path: relativePath, absolutePath: filePath, text: fs.readFileSync(filePath, "utf8") };
}

function cssRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/gm)).map(match => ({
    selectors: match[1].split(",").map(item => item.trim()),
    body: match[2],
  }));
}

function cssValue(source, selector, property) {
  const selectorVariants = selector.startsWith(".provider-page .")
    ? [selector, selector.replace(".provider-page ", "")]
    : [selector];
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = cssRules(source).filter(rule => rule.selectors.some(item => selectorVariants.includes(item)));
  const matches = rules.flatMap(rule => Array.from(rule.body.matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, "gm"))));
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const pages = CONTRACTS.map(contract => {
    const wxml = read(contract.wxml, root);
    const wxss = read(contract.wxss, root);
    const missingSelectors = contract.selectors.filter(selector => {
      const className = selector.replace(/^\./, "").split(/\s|:/)[0];
      return !new RegExp(`class=["'][^"']*\\b${className}\\b`).test(wxml.text)
        && selector !== "page";
    });
    const checks = contract.checks.map(([label, selector, property, expected]) => {
      const actual = cssValue(wxss.text, selector, property);
      return { label, selector, property, expected, actual, pass: actual === expected };
    });
    return {
      name: contract.name,
      wxml: contract.wxml,
      wxss: contract.wxss,
      sourceSha256: { wxml: sha256(wxml.absolutePath), wxss: sha256(wxss.absolutePath) },
      missingSelectors,
      checks,
      pass: missingSelectors.length === 0 && checks.every(item => item.pass),
    };
  });
  const report = {
    schemaVersion: 1,
    status: pages.every(page => page.pass) ? "pass" : "fail",
    ok: pages.every(page => page.pass),
    viewport: { width: 390, height: 844 },
    fontStack: FONT_STACK,
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
    console.log("用法：node scripts/admin-v2-layout-contract.js [--root <目录>] [--output <文件>]");
    return 0;
  }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`四页布局合同失败：${error.message || error}`);
    return 2;
  }
}

module.exports = { ROOT, CONTRACTS, FONT_STACK, cssRules, cssValue, run, parseArgs, main };

if (require.main === module) process.exitCode = main();
