/* eslint-disable no-console */

/**
 * 发布前视觉证据清单检查。
 *
 * 只认清单里明确列出的、非空的相对路径；路径越界、重复、缺文件和
 * 清单状态不对都会失败。ZIP 内的同一组文件由 package-release.py 再校验。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join("visual-evidence", "admin-v2-release-evidence-manifest.json");
const SENSITIVE_NAME = /(?:apiKey|secretKey|secretId|accessToken|authorization|password|token)/i;

function resolveInside(root, relative, label) {
  const text = String(relative || "").trim();
  if (!text || path.isAbsolute(text)) throw new Error(`${label} 必须是非空相对路径：${relative}`);
  const candidate = path.resolve(root, text);
  const relativeToRoot = path.relative(path.resolve(root), candidate);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error(`${label} 越出源码目录：${relative}`);
  }
  return candidate;
}

function readManifest(root = ROOT, manifestPath = DEFAULT_MANIFEST) {
  const resolvedRoot = path.resolve(root);
  const resolvedManifest = resolveInside(resolvedRoot, manifestPath, "视觉证据清单路径");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvedManifest, "utf8"));
  } catch (error) {
    throw new Error(`无法读取视觉证据清单：${resolvedManifest}（${error.message || error}）`);
  }
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("视觉证据清单 schemaVersion 必须为 1");
  if (manifest.status !== "accepted") throw new Error(`视觉证据清单 status 必须为 accepted：${manifest.status}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.baselineVersion || ""))) throw new Error("视觉证据清单 baselineVersion 必须是三段版本号");
  if (!Number.isInteger(manifest.retentionDays) || manifest.retentionDays < 1) throw new Error("视觉证据清单 retentionDays 必须是大于 0 的整数");
  if (!Array.isArray(manifest.requiredFiles) || manifest.requiredFiles.length === 0) throw new Error("视觉证据清单 requiredFiles 不能为空");
  const seen = new Set();
  const files = manifest.requiredFiles.map((relative, index) => {
    const normalized = String(relative || "").replace(/\\/g, "/").trim();
    if (seen.has(normalized)) throw new Error(`视觉证据清单存在重复文件：${normalized}`);
    seen.add(normalized);
    if (SENSITIVE_NAME.test(normalized)) throw new Error(`视觉证据清单路径疑似凭证文件：${normalized}`);
    const filePath = resolveInside(resolvedRoot, normalized, `requiredFiles[${index}]`);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`视觉证据清单文件不存在：${normalized}`);
    const bytes = fs.statSync(filePath).size;
    if (bytes <= 0) throw new Error(`视觉证据清单文件为空：${normalized}`);
    return { path: normalized, bytes };
  });
  return {
    manifestPath: path.relative(resolvedRoot, resolvedManifest).replace(/\\/g, "/"),
    schemaVersion: manifest.schemaVersion,
    status: manifest.status,
    baselineVersion: manifest.baselineVersion,
    retentionDays: manifest.retentionDays,
    files,
  };
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const manifestPath = options.manifest || DEFAULT_MANIFEST;
  const report = readManifest(root, manifestPath);
  return Object.assign({ ok: true, status: "pass", root }, report, { checkedAt: new Date().toISOString() });
}

function parseArgs(argv) {
  const result = { root: ROOT, manifest: DEFAULT_MANIFEST, checkOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--manifest") result.manifest = argv[++index] || result.manifest;
    else if (token === "--check-only") result.checkOnly = true;
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("用法：node scripts/admin-v2-release-evidence-check.js [--root <目录>] [--manifest <清单>] [--check-only]");
      return 0;
    }
    process.stdout.write(`${JSON.stringify(run(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`发布视觉证据清单失败：${error.message || error}`);
    return 1;
  }
}

module.exports = { ROOT, DEFAULT_MANIFEST, resolveInside, readManifest, run, parseArgs, main };

if (require.main === module) process.exitCode = main();
