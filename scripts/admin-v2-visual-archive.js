/* eslint-disable no-console */

/**
 * 归档四页视觉验收证据。
 *
 * 只复制截图、manifest、差异报告和合同报告，写入 SHA256 和字节数。
 * 文本证据在落盘前拒绝凭证字段，避免把 API Key 带进归档目录。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_VERSION = "local";
const DEFAULT_RETENTION_DAYS = 3;
// 保留旧导出名，外部脚本仍可读取，但语义已经是“天数”而不是目录数量。
const DEFAULT_RETENTION = DEFAULT_RETENTION_DAYS;
const DEFAULT_SOURCE = path.join(ROOT, "visual-evidence", "captured-final-v8");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "visual-evidence", "archive");
const DEFAULT_FILES = [
  "dashboard.png",
  "operations.png",
  "config.png",
  "provider.png",
];
const DEFAULT_REPORTS = [
  "visual-evidence/capture-manifest.json",
  "visual-evidence/admin-v2-same-device-manifest.json",
  "visual-evidence/admin-v2-pixel-manifest.json",
  "visual-evidence/pixel-diffs/admin-v2-pixel-diff-report.json",
  "visual-evidence/pixel-diffs/admin-v2-pixel-diff-report.md",
  "visual-evidence/layout-contract.json",
  "visual-evidence/font-contract.json",
  "visual-evidence/preview-source-budget.json",
  "visual-evidence/admin-v2-state-matrix.json",
  "visual-evidence/admin-v2-device-matrix.json",
];
const SENSITIVE_PATTERN = /["']?(?:apiKey|secretId|secretKey|providerSecretsV2|accessToken|authorization)["']?\s*[:=]/i;

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolve(root, value) {
  return path.isAbsolute(String(value || ""))
    ? path.resolve(String(value))
    : path.resolve(root, String(value || ""));
}

function assertSafeArtifact(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension || [".json", ".md", ".txt"].indexOf(extension) < 0) return;
  const text = fs.readFileSync(filePath, "utf8");
  if (SENSITIVE_PATTERN.test(text)) {
    throw new Error(`视觉归档拒绝包含凭证字段的文件：${filePath}`);
  }
}

function copyImmutable(sourcePath, destinationPath) {
  const sourceHash = sha256(sourcePath);
  if (fs.existsSync(destinationPath)) {
    if (sha256(destinationPath) !== sourceHash) {
      throw new Error(`视觉归档目标已存在且内容不同，拒绝覆盖：${destinationPath}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function listArchiveVersions(outputRoot) {
  const resolved = path.resolve(outputRoot);
  if (!fs.existsSync(resolved)) return [];
  return fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^v[0-9A-Za-z._-]+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalizeRetentionOptions(options) {
  if (options === undefined || options === null) return {};
  if (typeof options === "number" || typeof options === "string") return { retentionDays: Number(options) };
  if (typeof options !== "object") throw new Error(`归档保留天数参数无效：${options}`);
  return options;
}

function parseArchiveTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function archiveManifestInfo(target) {
  const manifestPath = path.join(target, "archive-manifest.json");
  if (!fs.existsSync(manifestPath)) return { manifestPath, archivedAt: null, reason: "missing-manifest" };
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const archivedAt = parseArchiveTimestamp(manifest && manifest.archivedAt);
    if (!archivedAt) return { manifestPath, archivedAt: null, reason: "invalid-archivedAt" };
    return { manifestPath, archivedAt, reason: null };
  } catch (error) {
    return { manifestPath, archivedAt: null, reason: `invalid-manifest:${error.message || error}` };
  }
}

function normalizeProtectedVersions(values) {
  return new Set((Array.isArray(values) ? values : values ? [values] : []).map(value => {
    const name = String(value || "").trim();
    return name.startsWith("v") ? name : `v${name}`;
  }));
}

function pruneArchives(outputRoot, options = DEFAULT_RETENTION_DAYS) {
  const normalized = normalizeRetentionOptions(options);
  const retentionDays = normalized.retentionDays === undefined
    ? (normalized.retention === undefined ? DEFAULT_RETENTION_DAYS : Number(normalized.retention))
    : Number(normalized.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(`归档保留天数必须是大于 0 的整数：${retentionDays}`);
  }
  const now = parseArchiveTimestamp(normalized.now || new Date());
  if (!now) throw new Error(`归档清理时间无效：${normalized.now}`);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const resolvedRoot = path.resolve(outputRoot);
  const versions = listArchiveVersions(resolvedRoot);
  const protectedVersions = normalizeProtectedVersions(normalized.protectVersions);
  const prunedVersions = [];
  const keptVersions = [];
  const skippedVersions = [];
  versions.forEach(versionName => {
    const target = path.join(resolvedRoot, versionName);
    if (!isWithin(resolvedRoot, target) || path.dirname(target) !== resolvedRoot) {
      throw new Error(`归档清理目标越界：${target}`);
    }
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      skippedVersions.push({ version: versionName, reason: "symlink-or-nondirectory" });
      return;
    }
    if (protectedVersions.has(versionName)) {
      keptVersions.push(versionName);
      return;
    }
    const info = archiveManifestInfo(target);
    if (!info.archivedAt) {
      skippedVersions.push({ version: versionName, reason: info.reason });
      return;
    }
    if (info.archivedAt.getTime() <= cutoff.getTime()) {
      fs.rmSync(target, { recursive: true, force: true });
      prunedVersions.push(versionName);
    } else {
      keptVersions.push(versionName);
    }
  });
  return {
    retention: retentionDays,
    retentionDays,
    now: now.toISOString(),
    cutoffAt: cutoff.toISOString(),
    versions,
    prunedVersions,
    keptVersions: listArchiveVersions(resolvedRoot).filter(name => !prunedVersions.includes(name)),
    skippedVersions,
  };
}

function cleanup(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const outputRoot = resolve(root, options.outputRoot || path.join("visual-evidence", "archive"));
  return pruneArchives(outputRoot, {
    retentionDays: options.retentionDays === undefined ? options.retention : options.retentionDays,
    now: options.now,
    protectVersions: options.protectVersions,
  });
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const version = String(options.version || DEFAULT_VERSION).trim();
  if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`归档版本名不安全：${version}`);
  const sourceRoot = resolve(root, options.source || path.relative(root, DEFAULT_SOURCE));
  const outputRoot = resolve(root, options.outputRoot || path.relative(root, DEFAULT_OUTPUT_ROOT));
  const output = path.join(outputRoot, `v${version}`);
  const relativeFiles = Array.isArray(options.files) && options.files.length
    ? options.files.map(String)
    : DEFAULT_FILES.map(file => path.join(path.relative(root, sourceRoot), file));
  const reportFiles = Array.isArray(options.reports) ? options.reports.map(String) : DEFAULT_REPORTS;
  const inputs = [...relativeFiles, ...reportFiles];
  const entries = [];
  inputs.forEach(relative => {
    const sourcePath = resolve(root, relative);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw new Error(`视觉归档文件不存在：${sourcePath}`);
    }
    assertSafeArtifact(sourcePath);
    const destinationName = path.basename(sourcePath);
    const destinationPath = path.join(output, destinationName);
    copyImmutable(sourcePath, destinationPath);
    const stat = fs.statSync(destinationPath);
    entries.push({
      name: destinationName,
      source: path.relative(root, sourcePath).replace(/\\/g, "/"),
      archivePath: path.relative(root, destinationPath).replace(/\\/g, "/"),
      bytes: stat.size,
      sha256: sha256(destinationPath),
    });
  });
  const manifest = {
    schemaVersion: 1,
    version,
    fixtureId: "admin-v2-reference-20260901-v1",
    viewport: { width: 390, height: 844 },
    renderer: "wechat-devtools-simulator",
    files: entries,
    archivedAt: new Date().toISOString(),
  };
  const manifestPath = path.join(output, "archive-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const current = JSON.stringify(Object.assign({}, manifest, { archivedAt: undefined }));
    const prior = JSON.stringify(Object.assign({}, existing, { archivedAt: undefined }));
    if (current !== prior) throw new Error(`视觉归档 manifest 已存在且内容不同：${manifestPath}`);
  } else {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  const retentionDays = options.retentionDays === undefined
    ? (options.retention === undefined ? DEFAULT_RETENTION_DAYS : options.retention)
    : options.retentionDays;
  const retentionResult = pruneArchives(outputRoot, {
    retentionDays,
    now: options.now,
    protectVersions: [version, ...(Array.isArray(options.protectVersions) ? options.protectVersions : [])],
  });
  return Object.assign(manifest, { output: output, manifestPath, ...retentionResult });
}

function parseArgs(argv) {
  const result = { root: ROOT, version: DEFAULT_VERSION, retentionDays: DEFAULT_RETENTION_DAYS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") result.help = true;
    else if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--version") result.version = argv[++index] || result.version;
    else if (token === "--source") result.source = argv[++index] || result.source;
    else if (token === "--output-root") result.outputRoot = argv[++index] || result.outputRoot;
    else if (token === "--retain-days") result.retentionDays = Number(argv[++index] || result.retentionDays);
    else if (token === "--retain") result.retentionDays = Number(argv[++index] || result.retentionDays);
    else if (token === "--now") result.now = argv[++index] || result.now;
    else if (token === "--protect-version") {
      if (!Array.isArray(result.protectVersions)) result.protectVersions = [];
      result.protectVersions.push(argv[++index] || "");
    } else if (token === "--cleanup-only") result.cleanupOnly = true;
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-visual-archive.js --version <版本> [--source <截图目录>] [--output-root <目录>] [--retain-days 3]");
    console.log("清理：node scripts/admin-v2-visual-archive.js --cleanup-only [--output-root <目录>] [--retain-days 3] [--now <ISO时间>]");
    return 0;
  }
  try {
    const result = options.cleanupOnly ? cleanup(options) : run(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`视觉证据归档失败：${error.message || error}`);
    return 2;
  }
}

module.exports = { ROOT, DEFAULT_FILES, DEFAULT_REPORTS, DEFAULT_RETENTION, DEFAULT_RETENTION_DAYS, SENSITIVE_PATTERN, sha256, assertSafeArtifact, listArchiveVersions, parseArchiveTimestamp, pruneArchives, cleanup, run, parseArgs, main };

if (require.main === module) process.exitCode = main();
