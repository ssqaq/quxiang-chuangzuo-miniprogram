/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const archive = require("./admin-v2-visual-archive");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ARCHIVE_ROOT = path.join(ROOT, "visual-evidence", "archive");

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isImage(name) {
  return /\.(?:png|jpe?g)$/i.test(String(name || ""));
}

function readVersion(archiveRoot, versionName) {
  const versionRoot = path.join(archiveRoot, versionName);
  const manifestPath = path.join(versionRoot, "archive-manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`归档缺少 manifest：${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.length) throw new Error(`归档 manifest 没有文件：${manifestPath}`);
  const checked = files.map(entry => {
    const name = path.basename(String(entry && entry.name || ""));
    const filePath = path.join(versionRoot, name);
    if (!name || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`归档文件不存在：${filePath}`);
    const bytes = fs.statSync(filePath).size;
    const hash = archive.sha256(filePath);
    if (Number(entry.bytes) !== bytes) throw new Error(`归档字节数不匹配：${versionName}/${name}`);
    if (String(entry.sha256 || "").toLowerCase() !== hash) throw new Error(`归档 SHA256 不匹配：${versionName}/${name}`);
    return {
      name,
      href: `${versionName}/${encodeURIComponent(name)}`,
      bytes,
      sha256: hash,
      image: isImage(name)
    };
  });
  return {
    version: String(manifest.version || versionName.replace(/^v/, "")),
    versionName,
    fixtureId: manifest.fixtureId || null,
    renderer: manifest.renderer || null,
    viewport: manifest.viewport || null,
    archivedAt: manifest.archivedAt || null,
    files: checked,
    manifest: `${versionName}/archive-manifest.json`
  };
}

function render(index) {
  const versions = index.versions.map(version => {
    const viewport = version.viewport ? `${version.viewport.width} x ${version.viewport.height}` : "未知";
    const images = version.files.filter(file => file.image).map(file => (
      `<figure><a href="${escapeHtml(file.href)}"><img src="${escapeHtml(file.href)}" alt="${escapeHtml(`${version.version} ${file.name}`)}" loading="lazy"></a><figcaption>${escapeHtml(file.name)}</figcaption></figure>`
    )).join("");
    const rows = version.files.map(file => `<tr><td><a href="${escapeHtml(file.href)}">${escapeHtml(file.name)}</a></td><td>${file.bytes}</td><td><code>${escapeHtml(file.sha256.slice(0, 12))}</code></td></tr>`).join("");
    return `<section><header><div><h2>v${escapeHtml(version.version)}</h2><p>${escapeHtml(version.fixtureId || "无 fixture")} · ${escapeHtml(viewport)} · ${escapeHtml(version.renderer || "未知渲染器")}</p></div><a href="${escapeHtml(version.manifest)}">manifest</a></header><div class="shots">${images || "<p>本版本没有图片。</p>"}</div><details><summary>文件校验明细（${version.files.length}）</summary><table><thead><tr><th>文件</th><th>字节</th><th>SHA256</th></tr></thead><tbody>${rows}</tbody></table></details></section>`;
  }).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>四页视觉归档</title>
<style>
:root{font-family:"Microsoft YaHei","PingFang SC",SimHei,system-ui,sans-serif;color:#102a43;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}main{max-width:1180px;margin:auto;padding:24px 18px 48px}h1{font-size:24px;margin:0 0 6px}h2{font-size:18px;margin:0}p{margin:0;color:#526b84;font-size:13px}nav{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #c9d8e8;padding-bottom:16px;margin-bottom:18px}section{background:#fff;border:1px solid #b9d0e8;border-radius:8px;padding:16px;margin-bottom:16px}section>header{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:14px}a{color:#136df0;text-decoration:none}a:hover{text-decoration:underline}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}figure{margin:0;border:1px solid #d4e0ec;border-radius:6px;overflow:hidden;background:#eef4fa}img{display:block;width:100%;height:260px;object-fit:contain;background:#e8eef5}figcaption{padding:8px;font-size:12px;overflow-wrap:anywhere}details{margin-top:14px}summary{cursor:pointer;font-size:13px;color:#32506d}table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e2eaf2}code{font-size:11px}@media(max-width:560px){main{padding:16px 10px 36px}nav{align-items:start;gap:10px}.shots{grid-template-columns:1fr 1fr}img{height:220px}th:nth-child(2),td:nth-child(2){display:none}}
</style></head><body><main><nav><div><h1>四页视觉归档</h1><p>版本、设备、状态和文件哈希均已复核</p></div><a href="index.json">index.json</a></nav>${versions || "<section><p>还没有视觉归档。</p></section>"}</main></body></html>`;
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const archiveRoot = path.isAbsolute(String(options.archiveRoot || ""))
    ? path.resolve(String(options.archiveRoot))
    : path.resolve(root, String(options.archiveRoot || path.relative(root, DEFAULT_ARCHIVE_ROOT)));
  fs.mkdirSync(archiveRoot, { recursive: true });
  const versions = archive.listArchiveVersions(archiveRoot).reverse().map(name => readVersion(archiveRoot, name));
  const index = { schemaVersion: 1, status: "pass", ok: true, versions, generatedAt: new Date().toISOString() };
  const jsonPath = path.join(archiveRoot, "index.json");
  const htmlPath = path.join(archiveRoot, "index.html");
  fs.writeFileSync(jsonPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(htmlPath, render(index), "utf8");
  return Object.assign(index, { jsonPath, htmlPath });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") result.help = true;
    else if (argv[index] === "--root") result.root = argv[++index];
    else if (argv[index] === "--archive-root") result.archiveRoot = argv[++index];
    else throw new Error(`未知参数：${argv[index]}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log("用法：node scripts/admin-v2-visual-index.js [--archive-root <目录>]"); return 0; }
    const result = run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) { console.error(`视觉归档索引失败：${error.message || error}`); return 2; }
}
module.exports = { ROOT, DEFAULT_ARCHIVE_ROOT, escapeHtml, isImage, readVersion, render, run, parseArgs, main };
if (require.main === module) process.exitCode = main();
