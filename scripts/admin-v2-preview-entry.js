/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_ID = "admin-v2-reference-20260901-v1";
const PAGE_NAMES = ["dashboard", "operations", "config", "provider"];

function trimBase(value) { return String(value || "http://localhost:49713").replace(/\/+$/, ""); }
function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }

function buildEntry(baseUrl = "http://localhost:49713", fixtureId = FIXTURE_ID) {
  const base = trimBase(baseUrl);
  const fixture = encodeURIComponent(String(fixtureId || FIXTURE_ID));
  const pages = PAGE_NAMES.map(name => {
    const browserPath = name === "operations" ? "/dashboard/operations.html?view=usage" : (name === "dashboard" ? "/dashboard/" : `/${name}/`);
    const browserUrl = `${base}${browserPath}${browserPath.includes("?") ? "&" : "?"}demo=1&fixture=${fixture}`;
    const miniPath = name === "operations" ? "pages/admin-operations/admin-operations?view=usage" : `pages/admin-${name === "dashboard" ? "dashboard" : name}/admin-${name}`;
    const miniQuery = miniPath.includes("?") ? "&demo=1" : "?demo=1";
    return { name, browserUrl, miniProgramRoute: `/${miniPath}${miniQuery}&fixture=${fixtureId}` };
  });
  return { schemaVersion: 1, fixtureId: String(fixtureId || FIXTURE_ID), viewport: { width: 390, height: 844 }, pages, generatedAt: new Date().toISOString() };
}

function renderHtml(entry) {
  const rows = entry.pages.map(page => `<li><strong>${escapeHtml(page.name)}</strong><br><a href="${escapeHtml(page.browserUrl)}">浏览器参考页</a><br><code>${escapeHtml(page.miniProgramRoute)}</code></li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>四页视觉演示入口</title><style>body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;max-width:720px;margin:32px auto;padding:0 20px;color:#102a43}li{margin:16px 0;padding:12px;border:1px solid #c9d8e8;border-radius:8px}a{color:#136df0}code{font-size:12px;color:#526b84}</style></head><body><h1>四页视觉演示入口</h1><p>fixture：${escapeHtml(entry.fixtureId)} · 视口：${entry.viewport.width}x${entry.viewport.height}</p><ol>${rows}</ol></body></html>`;
}

function run(options = {}) {
  const entry = buildEntry(options.baseUrl, options.fixtureId);
  const jsonPath = path.resolve(options.json || path.join(ROOT, "visual-evidence", "admin-v2-preview-entry.json"));
  const htmlPath = path.resolve(options.html || path.join(ROOT, "visual-evidence", "admin-v2-preview-entry.html"));
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  fs.writeFileSync(htmlPath, renderHtml(entry), "utf8");
  return Object.assign(entry, { jsonPath, htmlPath });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--base-url") result.baseUrl = argv[++index];
    else if (token === "--fixture-id") result.fixtureId = argv[++index];
    else if (token === "--json") result.json = argv[++index];
    else if (token === "--html") result.html = argv[++index];
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log("用法：node scripts/admin-v2-preview-entry.js [--base-url <地址>] [--fixture-id <ID>] [--json <文件>] [--html <文件>]"); return 0; }
  try { console.log(JSON.stringify(run(options), null, 2)); return 0; } catch (error) { console.error(`演示入口生成失败：${error.message || error}`); return 2; }
}

module.exports = { ROOT, FIXTURE_ID, PAGE_NAMES, trimBase, escapeHtml, buildEntry, renderHtml, run, parseArgs, main };
if (require.main === module) process.exitCode = main();
