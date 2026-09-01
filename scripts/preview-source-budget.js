/* eslint-disable no-console */

/**
 * 统计微信开发者工具预览时会打包的源码体积。
 *
 * 这里按 project.config.json 的 packOptions.ignore/include 规则做保守匹配，
 * 只在本地读取文件并做逐文件 gzip 估算，不上传任何内容。这样发布前
 * 可以先发现超过开发者工具预览上传上限的项目，而不是等二维码生成
 * 阶段才失败。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
// 开发者工具提示的“2MB”按二进制 MiB 计算；闸门调用方可以传入更保守的
// --max-bytes（例如 1_900_000）给上传链路预留协议开销。
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_WARN_BYTES = Math.floor(1.8 * 1024 * 1024);
const DEFAULT_METRIC = "compressed";
const COMPRESSION_LEVEL = 9;
const DEFAULT_CONFIG_NAME = "project.config.json";
const IMPLICIT_IGNORES = [
  { type: "folder", value: ".git" },
  { type: "glob", value: "**/node_modules/**" },
];

function normalizeRelativePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const type = String(rule.type || "").trim().toLowerCase();
  const value = normalizeRelativePath(rule.value);
  if (!type || !value) return null;
  return { type, value };
}

function globToRegExp(glob) {
  const source = normalizeRelativePath(glob);
  let expression = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        if (source[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function ruleMatches(relativePath, rule) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedRule = normalizeRule(rule);
  if (!normalizedPath || !normalizedRule) return false;
  const { type, value } = normalizedRule;
  const basename = path.posix.basename(normalizedPath);
  switch (type) {
    case "folder":
      return normalizedPath === value || normalizedPath.startsWith(`${value}/`)
        || normalizedPath.split("/").includes(value);
    case "file":
      return normalizedPath === value;
    case "prefix":
      return normalizedPath.startsWith(value) || basename.startsWith(value);
    case "suffix":
      return normalizedPath.endsWith(value) || basename.endsWith(value);
    case "glob":
      return globToRegExp(value).test(normalizedPath);
    default:
      return false;
  }
}

function normalizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map(normalizeRule).filter(Boolean);
}

function loadProjectConfig(projectRoot, configPath) {
  const resolvedRoot = path.resolve(projectRoot || ROOT);
  const resolvedConfig = path.resolve(configPath || path.join(resolvedRoot, DEFAULT_CONFIG_NAME));
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolvedConfig, "utf8"));
  } catch (error) {
    const wrapped = new Error(`无法读取项目配置：${resolvedConfig}（${error.message}）`);
    wrapped.code = "PREVIEW_CONFIG_READ_FAILED";
    throw wrapped;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    const error = new Error(`项目配置必须是 JSON 对象：${resolvedConfig}`);
    error.code = "PREVIEW_CONFIG_INVALID";
    throw error;
  }
  const packOptions = config.packOptions && typeof config.packOptions === "object"
    ? config.packOptions
    : {};
  return {
    root: resolvedRoot,
    path: resolvedConfig,
    include: normalizeRules(packOptions.include),
    ignore: normalizeRules(packOptions.ignore),
  };
}

function isIgnored(relativePath, ignoreRules) {
  return [...IMPLICIT_IGNORES, ...(ignoreRules || [])]
    .some(rule => ruleMatches(relativePath, rule));
}

function isIncluded(relativePath, includeRules) {
  if (!includeRules || includeRules.length === 0) return true;
  return includeRules.some(rule => ruleMatches(relativePath, rule));
}

function directoryMayContainIncluded(directoryPath, includeRules) {
  if (!includeRules || includeRules.length === 0) return true;
  const normalized = normalizeRelativePath(directoryPath);
  return includeRules.some(rule => {
    if (rule.type === "folder") return normalized === rule.value || rule.value.startsWith(`${normalized}/`) || normalized.startsWith(`${rule.value}/`);
    if (rule.type === "file") return rule.value.startsWith(`${normalized}/`);
    if (rule.type === "glob") return true;
    return true;
  });
}

function collectPreviewFiles(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || ROOT);
  const ignoreRules = normalizeRules(options.ignoreRules || options.ignore || []);
  const includeRules = normalizeRules(options.includeRules || options.include || []);
  const files = [];
  const errors = [];
  let ignoredFileCount = 0;
  let ignoredBytes = 0;
  let ignoredDirectoryCount = 0;

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    const error = new Error(`项目目录不存在：${root}`);
    error.code = "PREVIEW_PROJECT_NOT_FOUND";
    throw error;
  }

  function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: normalizeRelativePath(relativeDirectory), reason: `目录读取失败：${error.message}` });
      return;
    }
    for (const entry of entries) {
      const relativePath = normalizeRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // 开发者工具不会跟随项目外的符号链接；跳过可避免重复统计或越界。
        continue;
      }
      if (entry.isDirectory()) {
        if (isIgnored(relativePath, ignoreRules)) {
          ignoredDirectoryCount += 1;
          countIgnoredTree(absolutePath);
          continue;
        }
        if (!directoryMayContainIncluded(relativePath, includeRules)) continue;
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      let sizeBytes;
      try {
        sizeBytes = fs.statSync(absolutePath).size;
      } catch (error) {
        errors.push({ path: relativePath, reason: `文件读取失败：${error.message}` });
        continue;
      }
      if (isIgnored(relativePath, ignoreRules) || !isIncluded(relativePath, includeRules)) {
        ignoredFileCount += 1;
        ignoredBytes += sizeBytes;
        continue;
      }
      files.push({ path: relativePath, absolutePath, sizeBytes });
    }
  }

  // 被忽略目录不会进入预览包，但报告仍尽量给出完整的忽略统计，方便
  // 排查“为什么源码目录很大、实际预览包却很小”的情况。
  function countIgnoredTree(directory) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: directory, reason: `忽略目录读取失败：${error.message}` });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        countIgnoredTree(absolutePath);
      } else if (entry.isFile()) {
        try {
          ignoredFileCount += 1;
          ignoredBytes += fs.statSync(absolutePath).size;
        } catch (error) {
          errors.push({ path: absolutePath, reason: `忽略文件读取失败：${error.message}` });
        }
      }
    }
  }

  visit(root, "");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, errors, ignoredFileCount, ignoredBytes, ignoredDirectoryCount };
}

function calculateBudget(projectRoot, options = {}) {
  const config = options.config && typeof options.config === "object" && !Array.isArray(options.config)
    ? options.config
    : loadProjectConfig(
      projectRoot,
      options.configPath || (typeof options.config === "string" ? options.config : undefined)
    );
  const collected = collectPreviewFiles(config.root, {
    ignoreRules: config.ignore,
    includeRules: config.include,
  });
  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Math.max(0, Math.floor(Number(options.maxBytes)))
    : DEFAULT_MAX_BYTES;
  const warnBytes = Number.isFinite(Number(options.warnBytes))
    ? Math.max(0, Math.floor(Number(options.warnBytes)))
    : Math.min(DEFAULT_WARN_BYTES, maxBytes);
  const totalBytes = collected.files.reduce((total, item) => total + item.sizeBytes, 0);
  // DevTools 上传的是压缩后的文件包，而不是工作树裸字节。按文件分别
  // gzip，外加相对路径和条目头开销，得到稳定且偏保守的传输估算。
  const estimatedTransferBytes = collected.files.reduce((total, item) => {
    const content = fs.readFileSync(item.absolutePath);
    return total + zlib.gzipSync(content, { level: COMPRESSION_LEVEL }).length
      + Buffer.byteLength(item.path, "utf8") + 32;
  }, 0);
  const metric = String(options.metric || DEFAULT_METRIC).trim().toLowerCase();
  if (!["raw", "compressed"].includes(metric)) {
    const error = new Error(`预算 metric 只支持 raw 或 compressed：${metric}`);
    error.code = "PREVIEW_BUDGET_METRIC_INVALID";
    throw error;
  }
  const measuredBytes = metric === "raw" ? totalBytes : estimatedTransferBytes;
  const largestFiles = [...collected.files]
    .sort((left, right) => right.sizeBytes - left.sizeBytes || left.path.localeCompare(right.path))
    .slice(0, 20)
    .map(item => ({ path: item.path, sizeBytes: item.sizeBytes }));
  return {
    schemaVersion: 1,
    status: collected.errors.length ? "error" : (measuredBytes <= maxBytes ? "pass" : "fail"),
    ok: collected.errors.length === 0 && measuredBytes <= maxBytes,
    projectRoot: config.root,
    configPath: config.path,
    maxBytes,
    warnBytes,
    metric,
    measuredBytes,
    totalBytes,
    rawBytes: totalBytes,
    estimatedTransferBytes,
    compression: { algorithm: "gzip", level: COMPRESSION_LEVEL, overheadPerFileBytes: 32 },
    fileCount: collected.files.length,
    ignoredFileCount: collected.ignoredFileCount,
    ignoredBytes: collected.ignoredBytes,
    ignoredDirectoryCount: collected.ignoredDirectoryCount,
    budgetRemainingBytes: maxBytes - measuredBytes,
    usageRatio: maxBytes ? measuredBytes / maxBytes : null,
    warning: measuredBytes > warnBytes || totalBytes > maxBytes,
    errors: collected.errors,
    largestFiles,
    checkedAt: new Date().toISOString(),
  };
}

function parseArgs(argv) {
  const result = {
    projectRoot: ROOT,
    maxBytes: DEFAULT_MAX_BYTES,
    warnBytes: DEFAULT_WARN_BYTES,
    metric: DEFAULT_METRIC,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (key === "help") {
      result.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function printUsage() {
  console.log([
    "用法：node scripts/preview-source-budget.js [选项]",
    "  --project-root <目录>  项目根目录（默认当前脚本所在项目）",
    "  --config <文件>        project.config.json 路径",
    "  --max-bytes <字节>     硬上限（默认 2MiB；可传更保守值预留协议余量）",
    "  --warn-bytes <字节>    预警线（默认约 1.8MiB）",
    "  --metric <raw|compressed> 预算口径（默认 compressed，另报告原始字节）",
    "  --json <文件>          同时写出结构化 JSON 报告",
  ].join("\n"));
}

function run(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || ROOT);
  const report = calculateBudget(projectRoot, options);
  if (options.json) {
    const outputPath = path.resolve(projectRoot, String(options.json));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    report.jsonPath = outputPath;
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  try {
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : (report.status === "fail" ? 1 : 2);
  } catch (error) {
    const result = {
      schemaVersion: 1,
      status: "error",
      ok: false,
      error: error.message || String(error),
      code: error.code || "PREVIEW_BUDGET_FAILED",
      checkedAt: new Date().toISOString(),
    };
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    return 2;
  }
}

module.exports = {
  ROOT,
  DEFAULT_MAX_BYTES,
  DEFAULT_WARN_BYTES,
  DEFAULT_METRIC,
  COMPRESSION_LEVEL,
  IMPLICIT_IGNORES,
  normalizeRelativePath,
  normalizeRule,
  normalizeRules,
  globToRegExp,
  ruleMatches,
  isIgnored,
  isIncluded,
  loadProjectConfig,
  collectPreviewFiles,
  calculateBudget,
  parseArgs,
  run,
  main,
};

if (require.main === module) process.exitCode = main();
