/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const DEFAULT_PROJECTS = Object.freeze([
  "cloudfunctions/api",
  "media-worker"
]);
const SEVERITIES = Object.freeze([
  "info",
  "low",
  "moderate",
  "high",
  "critical"
]);

function parseArgs(argv) {
  const options = {
    input: "",
    outputDir: "",
    projects: DEFAULT_PROJECTS.slice()
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--input") {
      options.input = String(argv[index + 1] || "");
      index += 1;
    } else if (value === "--output-dir") {
      options.outputDir = String(argv[index + 1] || "");
      index += 1;
    } else if (value === "--project") {
      options.projects = [String(argv[index + 1] || "")];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      options.help = true;
    } else {
      throw new Error(`不支持的参数：${value}`);
    }
  }
  options.projects = options.projects
    .map((item) => String(item || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return options;
}

function redactText(value, maxLength = 500) {
  return String(value || "")
    .replace(/:\/\/[^/@\s:]+:[^/@\s]+@/g, "://***:***@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
    .replace(/\bnpm_[A-Za-z0-9]{8,}\b/g, "npm_***")
    .replace(
      /\b(api[_-]?key|token|password|passwd|proxy[_-]?password|authorization)\s*[:=]\s*[^,\s;]+/gi,
      "$1=***"
    )
    .slice(0, maxLength);
}

function safeSeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  return SEVERITIES.includes(severity) ? severity : "info";
}

function emptyCounts() {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0
  };
}

function normalizeCounts(metadata = {}, findings = []) {
  const raw = metadata && metadata.vulnerabilities || {};
  const counts = emptyCounts();
  SEVERITIES.forEach((severity) => {
    const value = Number(raw[severity]);
    counts[severity] = Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : findings.filter((item) => item.severity === severity).length;
  });
  const rawTotal = Number(raw.total);
  counts.total = Number.isFinite(rawTotal) && rawTotal >= 0
    ? Math.round(rawTotal)
    : SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  return counts;
}

function normalizeFixAvailable(value) {
  if (value === true) {
    return { available: true, breaking: false, target: "" };
  }
  if (!value || value === false) {
    return { available: false, breaking: false, target: "" };
  }
  if (typeof value === "object") {
    return {
      available: true,
      breaking: Boolean(value.isSemVerMajor),
      target: redactText(
        value.name && value.version
          ? `${value.name}@${value.version}`
          : value.version || value.name || "",
        160
      )
    };
  }
  return { available: Boolean(value), breaking: false, target: "" };
}

function advisoryFromVia(dependency, via) {
  if (!via || typeof via !== "object") return null;
  const fix = normalizeFixAvailable(via.fixAvailable);
  return {
    id: redactText(via.source || via.name || dependency, 120),
    dependency: redactText(via.dependency || dependency, 160),
    severity: safeSeverity(via.severity),
    title: redactText(via.title || via.name || "依赖安全告警", 240),
    range: redactText(via.range || "", 120),
    direct: false,
    fixAvailable: fix.available,
    breakingFix: fix.breaking,
    fixTarget: fix.target
  };
}

function normalizeFindings(payload = {}) {
  const vulnerabilities = payload && payload.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") return [];
  const findings = [];
  Object.keys(vulnerabilities).sort().forEach((dependency) => {
    const item = vulnerabilities[dependency] || {};
    const fix = normalizeFixAvailable(item.fixAvailable);
    const via = Array.isArray(item.via) ? item.via : [];
    const advisories = via
      .map((entry) => advisoryFromVia(dependency, entry))
      .filter(Boolean);
    if (advisories.length) {
      advisories.forEach((finding) => {
        finding.direct = Boolean(item.isDirect);
        if (!finding.fixAvailable && fix.available) {
          finding.fixAvailable = true;
          finding.breakingFix = fix.breaking;
          finding.fixTarget = fix.target;
        }
        findings.push(finding);
      });
      return;
    }
    findings.push({
      id: redactText(dependency, 120),
      dependency: redactText(item.name || dependency, 160),
      severity: safeSeverity(item.severity),
      title: redactText(`${dependency} 存在依赖安全告警`, 240),
      range: redactText(item.range || "", 120),
      direct: Boolean(item.isDirect),
      fixAvailable: fix.available,
      breakingFix: fix.breaking,
      fixTarget: fix.target
    });
  });
  const unique = new Map();
  findings.forEach((finding) => {
    const key = [
      finding.id,
      finding.dependency,
      finding.severity,
      finding.range
    ].join(":");
    if (!unique.has(key)) unique.set(key, finding);
  });
  return [...unique.values()];
}

function parseAuditPayload(payload, project) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${project} 的 npm audit JSON 格式无效。`);
  }
  const findings = normalizeFindings(payload);
  const counts = normalizeCounts(payload.metadata, findings);
  return {
    project,
    status: "audited",
    counts,
    blocked: counts.critical > 0,
    findings
  };
}

function npmInvocation(args = []) {
  const npmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (fs.existsSync(npmCli)) {
    return {
      command: process.execPath,
      args: [npmCli].concat(args)
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args
  };
}

function npmVersion() {
  const invocation = npmInvocation(["--version"]);
  const result = cp.spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  return result.status === 0
    ? redactText(result.stdout, 40)
    : "unknown";
}

function runOnlineAudit(project) {
  const projectDir = path.join(root, ...project.split("/"));
  const lockPath = path.join(projectDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) {
    return {
      project,
      status: "skipped",
      counts: emptyCounts(),
      blocked: false,
      findings: [],
      errorCode: "package-lock-missing",
      error: "没有 package-lock.json，已跳过。"
    };
  }
  const invocation = npmInvocation(["audit", "--json", "--omit=dev"]);
  const result = cp.spawnSync(invocation.command, invocation.args, {
    cwd: projectDir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024
  });
  const raw = String(result.stdout || "").trim();
  if (!raw) {
    return {
      project,
      status: "failed",
      counts: emptyCounts(),
      blocked: true,
      findings: [],
      errorCode: result.error && result.error.code
        ? redactText(result.error.code, 80)
        : "npm-audit-no-json",
      error: "npm audit 没有返回可解析的 JSON。"
    };
  }
  try {
    return parseAuditPayload(JSON.parse(raw), project);
  } catch (error) {
    return {
      project,
      status: "failed",
      counts: emptyCounts(),
      blocked: true,
      findings: [],
      errorCode: "npm-audit-json-invalid",
      error: redactText(error && error.message || "npm audit JSON 无效。", 240)
    };
  }
}

function loadInputPayload(inputPath) {
  const absolute = path.resolve(inputPath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

function auditFromInput(input, projects) {
  const source = input && input.projects && typeof input.projects === "object"
    ? input.projects
    : null;
  if (!source && projects.length !== 1) {
    throw new Error("--input 包含多个项目时必须使用 projects 对象。");
  }
  return projects.map((project) => {
    const payload = source ? source[project] : input;
    if (!payload) {
      return {
        project,
        status: "skipped",
        counts: emptyCounts(),
        blocked: false,
        findings: [],
        errorCode: "input-project-missing",
        error: "固定输入中没有这个项目。"
      };
    }
    return parseAuditPayload(payload, project);
  });
}

function markdownReport(report) {
  const lines = [
    "# 依赖安全审计报告",
    "",
    `- 审计时间：${report.generatedAt}`,
    `- Node：${report.nodeVersion}`,
    `- npm：${report.npmVersion}`,
    `- 发布阻断：${report.blocked ? "是（存在 critical 或审计失败）" : "否"}`,
    "",
    "| 项目 | 状态 | moderate | high | critical | 总数 | 结果 |",
    "|------|------|----------|------|----------|------|------|"
  ];
  report.projects.forEach((project) => {
    lines.push([
      `| ${project.project}`,
      project.status,
      project.counts.moderate,
      project.counts.high,
      project.counts.critical,
      project.counts.total,
      project.blocked ? "阻断" : "通过",
      "|"
    ].join(" | "));
  });
  report.projects.forEach((project) => {
    lines.push("", `## ${project.project}`);
    if (project.error) {
      lines.push("", `- 审计错误：${redactText(project.error, 240)}`);
    }
    if (!project.findings.length) {
      lines.push("", "- 没有可列出的依赖安全告警。");
      return;
    }
    lines.push(
      "",
      "| 等级 | 依赖 | 范围 | 可修复 | 是否破坏性升级 | 说明 |",
      "|------|------|------|--------|----------------|------|"
    );
    project.findings.forEach((finding) => {
      lines.push([
        `| ${finding.severity}`,
        finding.dependency,
        finding.range || "-",
        finding.fixAvailable ? "是" : "否",
        finding.breakingFix ? "是" : "否",
        finding.title.replace(/\|/g, "｜"),
        "|"
      ].join(" | "));
    });
  });
  lines.push(
    "",
    "## 处理规则",
    "",
    "- critical：阻止正式发布。",
    "- moderate/high：只报告，不自动升级。",
    "- 本工具不会执行 npm audit fix 或 npm audit fix --force。",
    ""
  );
  return lines.join("\n");
}

function defaultOutputDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(root, "..", `dependency-security-audit-${stamp}`);
}

function writeReport(report, outputDir) {
  const absolute = path.resolve(outputDir || defaultOutputDir());
  fs.mkdirSync(absolute, { recursive: true });
  const jsonPath = path.join(absolute, "dependency-security-audit.json");
  const markdownPath = path.join(absolute, "dependency-security-audit.md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, markdownReport(report), "utf8");
  return { outputDir: absolute, jsonPath, markdownPath };
}

function buildReport(projects, mode) {
  const failed = projects.some((item) => item.status === "failed");
  const critical = projects.some((item) => item.counts.critical > 0);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    nodeVersion: process.version,
    npmVersion: npmVersion(),
    blocked: failed || critical,
    blockReason: failed
      ? "audit-failed"
      : critical
        ? "critical-vulnerability"
        : "",
    policy: {
      criticalBlocksRelease: true,
      moderateHighReportOnly: true,
      automaticFix: false
    },
    projects
  };
}

function printHelp() {
  console.log([
    "用法：",
    "  node scripts/dependency-security-audit.js",
    "  node scripts/dependency-security-audit.js --input audit.json",
    "  node scripts/dependency-security-audit.js --output-dir <目录>",
    "  node scripts/dependency-security-audit.js --project cloudfunctions/api"
  ].join("\n"));
}

function run(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return { exitCode: 0, report: null, files: null };
    }
    const mode = options.input ? "input" : "online";
    const projects = options.input
      ? auditFromInput(loadInputPayload(options.input), options.projects)
      : options.projects.map(runOnlineAudit);
    const report = buildReport(projects, mode);
    const files = writeReport(report, options.outputDir);
    console.log(`依赖安全审计 JSON：${files.jsonPath}`);
    console.log(`依赖安全审计 Markdown：${files.markdownPath}`);
    if (report.blocked) {
      console.error(`依赖安全审计未通过：${report.blockReason}`);
    } else {
      console.log("依赖安全审计通过：没有 critical 漏洞。");
    }
    return {
      exitCode: report.blocked ? 2 : 0,
      report,
      files
    };
  } catch (error) {
    console.error(`依赖安全审计失败：${redactText(error && error.message || error, 240)}`);
    return {
      exitCode: 3,
      report: null,
      files: null,
      error
    };
  }
}

if (require.main === module) {
  const result = run();
  process.exitCode = result.exitCode;
}

module.exports = {
  DEFAULT_PROJECTS,
  SEVERITIES,
  parseArgs,
  redactText,
  normalizeFindings,
  parseAuditPayload,
  auditFromInput,
  markdownReport,
  buildReport,
  writeReport,
  run
};
