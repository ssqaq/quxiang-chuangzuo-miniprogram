/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const script = path.resolve(__dirname, "dependency-security-audit.js");

function auditPayload(counts, vulnerabilities = {}) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: Object.assign({
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0
      }, counts)
    }
  };
}

function runAudit(inputPath, outputDir) {
  return cp.spawnSync(process.execPath, [
    script,
    "--input",
    inputPath,
    "--output-dir",
    outputDir
  ], {
    encoding: "utf8",
    windowsHide: true
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aips-dependency-audit-"));
  const secret = "npm_NOT_A_REAL_SECRET_TOKEN_123456";
  try {
    const highInput = path.join(temp, "high-input.json");
    fs.writeFileSync(highInput, JSON.stringify({
      projects: {
        "cloudfunctions/api": auditPayload({}),
        "media-worker": auditPayload(
          { high: 1, total: 1 },
          {
            "demo-package": {
              name: "demo-package",
              severity: "high",
              isDirect: true,
              via: [{
                source: 12345,
                name: "demo-package",
                dependency: "demo-package",
                title: `原型污染 token=${secret}`,
                severity: "high",
                range: "<2.0.0"
              }],
              range: "<2.0.0",
              fixAvailable: {
                name: "demo-package",
                version: "2.0.0",
                isSemVerMajor: true
              }
            }
          }
        )
      }
    }), "utf8");
    const highOutput = path.join(temp, "high-output");
    const high = runAudit(highInput, highOutput);
    assert.strictEqual(high.status, 0, high.stderr || high.stdout);
    const highReportPath = path.join(
      highOutput,
      "dependency-security-audit.json"
    );
    const highMarkdownPath = path.join(
      highOutput,
      "dependency-security-audit.md"
    );
    assert.ok(fs.existsSync(highReportPath));
    assert.ok(fs.existsSync(highMarkdownPath));
    const highReport = readJson(highReportPath);
    assert.strictEqual(highReport.blocked, false);
    assert.strictEqual(highReport.projects.length, 2);
    assert.strictEqual(highReport.projects[1].counts.high, 1);
    assert.strictEqual(
      highReport.projects[1].findings[0].breakingFix,
      true
    );
    const combined = [
      fs.readFileSync(highReportPath, "utf8"),
      fs.readFileSync(highMarkdownPath, "utf8"),
      high.stdout,
      high.stderr
    ].join("\n");
    assert.ok(!combined.includes(secret), "审计报告泄露了 token");
    assert.ok(combined.includes("token=***"), "审计报告没有执行脱敏");

    const criticalInput = path.join(temp, "critical-input.json");
    fs.writeFileSync(criticalInput, JSON.stringify({
      projects: {
        "cloudfunctions/api": auditPayload(
          { critical: 1, total: 1 },
          {
            criticalPackage: {
              name: "critical-package",
              severity: "critical",
              isDirect: false,
              via: ["transitive-advisory"],
              range: "*",
              fixAvailable: false
            }
          }
        ),
        "media-worker": auditPayload({})
      }
    }), "utf8");
    const critical = runAudit(
      criticalInput,
      path.join(temp, "critical-output")
    );
    assert.strictEqual(critical.status, 2, "critical 必须阻止发布");
    const criticalReport = readJson(path.join(
      temp,
      "critical-output",
      "dependency-security-audit.json"
    ));
    assert.strictEqual(criticalReport.blocked, true);
    assert.strictEqual(
      criticalReport.blockReason,
      "critical-vulnerability"
    );

    const invalidPath = path.join(temp, "invalid.json");
    fs.writeFileSync(invalidPath, "{invalid-json", "utf8");
    const invalid = runAudit(invalidPath, path.join(temp, "invalid-output"));
    assert.strictEqual(invalid.status, 3, "格式错误必须返回审计失败");

    console.log(
      "dependency security audit smoke: OK "
      + "(two-project/high/critical/redaction/invalid-json)"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main();
