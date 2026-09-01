/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const audit = require("./admin-v2-visual-sensitive-data");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-visual-sensitive-data-"));

function write(relativePath, content) {
  const target = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

try {
  const safeRoot = path.join(tempRoot, "safe-evidence");
  write("safe-evidence/capture-manifest.json", `${JSON.stringify({
    schemaVersion: 1,
    fixtureId: "admin-v2-reference-20260901-v1",
    captures: [{
      name: "config",
      apiKey: "demo-api-key-not-real",
      secretId: "example-secret-id-not-real",
      secretKey: "fake-secret-key-not-real"
    }]
  }, null, 2)}\n`);
  write("safe-evidence/pixel-report.md", [
    "# 视觉回归",
    "",
    "- API Key: test-api-key-not-real",
    "- SecretId: [REDACTED]"
  ].join("\n"));
  write("safe-evidence/index.html", "<input name=\"SecretKey\" value=\"demo-secret-key-not-real\">\n");
  write("safe-evidence/config.png", "binary fixture is intentionally ignored");

  const safe = audit.run({ root: tempRoot, paths: [safeRoot] });
  assert.strictEqual(safe.ok, true, "带明确 demo/test/example/fake 标记的假值应允许进入视觉证据");
  assert.strictEqual(safe.filesChecked, 3, "默认只扫描 JSON/Markdown/HTML，不读取截图二进制");
  assert.deepStrictEqual(safe.violations, []);
  assert.deepStrictEqual(safe.policy.allowedDemoPrefixes, ["demo-", "fake-", "test-", "example-"]);

  const unsafeRoot = path.join(tempRoot, "unsafe-evidence");
  const jsonSentinel = "prod-json-sentinel-not-a-real-secret";
  const markdownSentinel = "prod-markdown-sentinel-not-a-real-secret";
  const htmlSentinel = "prod-html-sentinel-not-a-real-secret";
  write("unsafe-evidence/capture-manifest.json", `${JSON.stringify({
    captures: [{ name: "config", apiKey: jsonSentinel }]
  }, null, 2)}\n`);
  write("unsafe-evidence/report.md", `- SecretId: ${markdownSentinel}\n`);
  write("unsafe-evidence/index.html", `<input name=\"SecretKey\" value=\"${htmlSentinel}\">\n`);

  const unsafe = audit.run({ root: tempRoot, paths: [unsafeRoot] });
  assert.strictEqual(unsafe.ok, false, "没有演示标记的凭据值必须阻断");
  assert.strictEqual(unsafe.violations.length, 3);
  assert.ok(unsafe.violations.some(item => item.file.endsWith("capture-manifest.json") && item.path === "$.captures[0].apiKey"));
  assert.ok(unsafe.violations.some(item => item.file.endsWith("report.md") && item.path === "line:1"));
  assert.ok(unsafe.violations.some(item => item.file.endsWith("index.html") && item.path === "line:1"));
  const serializedReport = JSON.stringify(unsafe);
  [jsonSentinel, markdownSentinel, htmlSentinel].forEach(value => {
    assert.ok(!serializedReport.includes(value), "审计结果不得回显命中的凭据值");
  });
  assert.throws(
    () => audit.assertSafeArtifacts({ root: tempRoot, paths: [unsafeRoot] }),
    error => error && error.code === "VISUAL_EVIDENCE_SECRET_DETECTED"
      && ![jsonSentinel, markdownSentinel, htmlSentinel].some(value => String(error.message).includes(value)),
    "阻断异常不得回显凭据值"
  );

  const cliPath = path.join(__dirname, "admin-v2-visual-sensitive-data.js");
  const safeCli = childProcess.spawnSync(process.execPath, [cliPath, "--root", tempRoot, "--path", safeRoot], { encoding: "utf8" });
  assert.strictEqual(safeCli.status, 0, safeCli.stderr);
  assert.strictEqual(JSON.parse(safeCli.stdout).ok, true);
  const unsafeCli = childProcess.spawnSync(process.execPath, [cliPath, "--root", tempRoot, "--path", unsafeRoot], { encoding: "utf8" });
  assert.strictEqual(unsafeCli.status, 1, unsafeCli.stderr);
  assert.strictEqual(JSON.parse(unsafeCli.stdout).ok, false);
  [jsonSentinel, markdownSentinel, htmlSentinel].forEach(value => {
    assert.ok(!unsafeCli.stdout.includes(value), "CLI 输出不得回显凭据值");
  });

  console.log("admin-v2-visual-sensitive-data-smoke: PASS (manifest/json/markdown/html/demo-policy/no-value-echo/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
