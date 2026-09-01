/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = Object.freeze([".json", ".md", ".markdown", ".html", ".htm"]);
const ALLOWED_DEMO_PREFIXES = Object.freeze(["demo-", "fake-", "test-", "example-"]);
const SAFE_PLACEHOLDERS = Object.freeze([
  "",
  "***",
  "redacted",
  "[redacted]",
  "<redacted>",
  "not-configured",
  "not-set",
  "keep-existing",
  "unchanged",
  "none",
  "null",
  "undefined"
]);
const SENSITIVE_KEYS = new Set([
  "apikey",
  "secretid",
  "secretkey",
  "accesskeyid",
  "accesskeysecret",
  "accesstoken",
  "authorization"
]);
const SENSITIVE_CONTAINERS = new Set(["providersecretsv2", "credentials", "secrets"]);
const SECRET_LABEL_SOURCE = [
  "api\\s*[-_]?\\s*key",
  "secret\\s*[-_]?\\s*id",
  "secret\\s*[-_]?\\s*key",
  "access\\s*[-_]?\\s*key\\s*[-_]?\\s*id",
  "access\\s*[-_]?\\s*key\\s*[-_]?\\s*secret",
  "access\\s*[-_]?\\s*token",
  "authorization"
].join("|");

function normalizeKey(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function decodeText(value) {
  return String(value || "")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function normalizedSecretValue(value) {
  let text = decodeText(value).trim();
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) text = decoded.trim();
  } catch (error) {
    // 不是 URL 编码时按原值检查。
  }
  return text.replace(/^Bearer\s+/i, "").trim();
}

function isAllowedDemoValue(value) {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.every(isAllowedDemoValue);
  if (value && typeof value === "object") return Object.values(value).every(isAllowedDemoValue);
  if (typeof value !== "string") return false;
  const normalized = normalizedSecretValue(value).toLowerCase();
  if (SAFE_PLACEHOLDERS.indexOf(normalized) >= 0) return true;
  return ALLOWED_DEMO_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function jsonPath(parent, key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return `${parent}.${key}`;
  return `${parent}[${JSON.stringify(String(key))}]`;
}

function inspectJson(value, file, violations, currentPath = "$", sensitiveContext = false) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectJson(item, file, violations, `${currentPath}[${index}]`, sensitiveContext));
    return;
  }
  if (!value || typeof value !== "object") return;
  Object.keys(value).forEach(key => {
    const child = value[key];
    const normalized = normalizeKey(key);
    const childPath = jsonPath(currentPath, key);
    const sensitive = sensitiveContext || SENSITIVE_KEYS.has(normalized) || SENSITIVE_CONTAINERS.has(normalized);
    if (sensitive && !isAllowedDemoValue(child)) {
      violations.push({ file, path: childPath, field: key, format: "json" });
      return;
    }
    if (child && typeof child === "object") {
      inspectJson(child, file, violations, childPath, sensitiveContext || SENSITIVE_CONTAINERS.has(normalized));
    }
  });
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function assignmentPattern() {
  return new RegExp(
    `(${SECRET_LABEL_SOURCE})\\s*[\"']?\\s*(?::|：|=)\\s*`
      + `(?:\"([^\"\\r\\n]*)\"|'([^'\\r\\n]*)'|(\\[[^\\]\\r\\n]*\\])|(<[^>\\r\\n]*>)|([^\\s,;|}\\]<>]+))`,
    "gi"
  );
}

function htmlAttributes(tag) {
  const result = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    result[String(match[1]).toLowerCase()] = match[2] !== undefined
      ? match[2]
      : (match[3] !== undefined ? match[3] : match[4]);
  }
  return result;
}

function inspectText(text, file, format, violations) {
  const decoded = decodeText(text);
  const comparable = format === "markdown" ? decoded.replace(/[*_`]/g, "") : decoded;
  const pattern = assignmentPattern();
  let match;
  while ((match = pattern.exec(comparable))) {
    const candidate = match.slice(2).find(item => item !== undefined);
    if (!isAllowedDemoValue(candidate)) {
      violations.push({
        file,
        path: `line:${lineNumber(comparable, match.index)}`,
        field: match[1].replace(/\s+/g, ""),
        format
      });
    }
  }

  if (format !== "html") return;
  const tagPattern = /<[^>]+>/g;
  while ((match = tagPattern.exec(decoded))) {
    const attributes = htmlAttributes(match[0]);
    const field = attributes.name || attributes["data-field"] || attributes["data-key"];
    const candidate = attributes.value !== undefined ? attributes.value : attributes.content;
    if (!field || candidate === undefined || !SENSITIVE_KEYS.has(normalizeKey(field))) continue;
    if (!isAllowedDemoValue(candidate)) {
      violations.push({
        file,
        path: `line:${lineNumber(decoded, match.index)}`,
        field,
        format
      });
    }
  }
}

function displayPath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/") || path.basename(filePath);
}

function collectFiles(root, inputs) {
  const files = new Set();
  function visit(target) {
    if (!fs.existsSync(target)) throw new Error(`视觉证据路径不存在：${target}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.readdirSync(target, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .forEach(entry => visit(path.join(target, entry.name)));
      return;
    }
    if (stat.isFile() && TEXT_EXTENSIONS.indexOf(path.extname(target).toLowerCase()) >= 0) {
      files.add(path.resolve(target));
    }
  }
  inputs.forEach(input => visit(path.isAbsolute(String(input)) ? path.resolve(String(input)) : path.resolve(root, String(input))));
  return [...files].sort((left, right) => left.localeCompare(right));
}

function scanFile(root, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const file = displayPath(root, filePath);
  const text = fs.readFileSync(filePath, "utf8");
  const violations = [];
  if (extension === ".json") {
    try {
      inspectJson(JSON.parse(text), file, violations);
    } catch (error) {
      inspectText(text, file, "json", violations);
    }
  } else {
    inspectText(text, file, extension === ".md" || extension === ".markdown" ? "markdown" : "html", violations);
  }
  const unique = new Map();
  violations.forEach(item => unique.set(`${item.file}|${item.path}|${normalizeKey(item.field)}`, item));
  return [...unique.values()];
}

function run(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const inputs = Array.isArray(options.paths) && options.paths.length ? options.paths : [path.join(root, "visual-evidence")];
  const files = collectFiles(root, inputs);
  const violations = files.flatMap(filePath => scanFile(root, filePath));
  const report = {
    schemaVersion: 1,
    status: violations.length ? "fail" : "pass",
    ok: violations.length === 0,
    policy: {
      scannedExtensions: TEXT_EXTENSIONS.slice(),
      allowedDemoPrefixes: ALLOWED_DEMO_PREFIXES.slice(),
      safePlaceholders: SAFE_PLACEHOLDERS.slice()
    },
    filesChecked: files.length,
    violations,
    checkedAt: new Date().toISOString()
  };
  if (options.output) {
    const output = path.isAbsolute(String(options.output)) ? path.resolve(String(options.output)) : path.resolve(root, String(options.output));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.output = displayPath(root, output);
  }
  return report;
}

function assertSafeArtifacts(options = {}) {
  const report = run(options);
  if (report.ok) return report;
  const locations = report.violations.slice(0, 10).map(item => `${item.file}#${item.path}`).join(", ");
  const error = new Error(`视觉证据包含未标明为演示值的凭据字段：${locations}`);
  error.code = "VISUAL_EVIDENCE_SECRET_DETECTED";
  error.report = report;
  throw error;
}

function parseArgs(argv) {
  const result = { paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") result.root = argv[++index];
    else if (token === "--path") result.paths.push(argv[++index]);
    else if (token === "--output") result.output = argv[++index];
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("用法：node scripts/admin-v2-visual-sensitive-data.js [--root <目录>] [--path <文件或目录>]... [--output <报告.json>]");
      return 0;
    }
    const report = run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`视觉证据敏感数据检查失败：${error.message || error}`);
    return 2;
  }
}

module.exports = {
  ROOT,
  TEXT_EXTENSIONS,
  ALLOWED_DEMO_PREFIXES,
  SAFE_PLACEHOLDERS,
  normalizeKey,
  isAllowedDemoValue,
  inspectJson,
  inspectText,
  collectFiles,
  scanFile,
  run,
  assertSafeArtifacts,
  parseArgs,
  main
};

if (require.main === module) process.exitCode = main();
