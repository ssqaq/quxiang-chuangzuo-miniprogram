/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const budget = require("./preview-source-budget");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "preview-source-budget-"));

function write(relativePath, content) {
  const target = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

try {
  write("project.config.json", JSON.stringify({
    packOptions: {
      ignore: [
        { type: "folder", value: "ignored" },
        { type: "glob", value: "**/node_modules/**" },
        { type: "prefix", value: "_tmp_" },
        { type: "suffix", value: ".log" },
        { type: "file", value: "private.json" },
      ],
      include: [],
    },
  }));
  write("app.js", "12345");
  write("pages/index/index.wxml", "1234567");
  write("ignored/large.bin", "1234567890");
  write("nested/node_modules/pkg/index.js", "1234567890");
  write("_tmp_debug.txt", "1234567890");
  write("nested/debug.log", "1234567890");
  write("private.json", "1234567890");

  assert.strictEqual(budget.normalizeRelativePath(".\\pages\\index\\index.wxml"), "pages/index/index.wxml");
  assert.strictEqual(budget.ruleMatches("nested/node_modules/pkg/index.js", { type: "glob", value: "**/node_modules/**" }), true);
  assert.strictEqual(budget.ruleMatches("pages/index/index.wxml", { type: "suffix", value: ".wxml" }), true);
  assert.strictEqual(budget.ruleMatches("pages/index/index.wxml", { type: "prefix", value: "pages/" }), true);

  const config = budget.loadProjectConfig(tempRoot);
  const collected = budget.collectPreviewFiles(tempRoot, {
    ignoreRules: config.ignore,
    includeRules: config.include,
  });
  assert.deepStrictEqual(collected.files.map(item => item.path), [
    "app.js",
    "pages/index/index.wxml",
    "project.config.json",
  ]);
  const expectedTotal = Buffer.byteLength("12345")
    + Buffer.byteLength("1234567")
    + fs.statSync(path.join(tempRoot, "project.config.json")).size;
  const pass = budget.run({ projectRoot: tempRoot, maxBytes: expectedTotal, warnBytes: expectedTotal, metric: "raw" });
  assert.strictEqual(pass.ok, true, "刚好达到上限应通过");
  assert.strictEqual(pass.totalBytes, expectedTotal);
  assert.strictEqual(pass.warning, false);
  assert.ok(pass.ignoredFileCount >= 5, "应统计被忽略文件");
  const fail = budget.run({ projectRoot: tempRoot, maxBytes: expectedTotal - 1, metric: "raw" });
  assert.strictEqual(fail.ok, false, "超过上限应失败");
  assert.strictEqual(fail.status, "fail");

  const reportPath = path.join(os.tmpdir(), `preview-source-budget-report-${process.pid}.json`);
  const written = budget.run({ projectRoot: tempRoot, maxBytes: expectedTotal, metric: "raw", json: reportPath });
  assert.strictEqual(written.jsonPath, reportPath);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(reportPath, "utf8")).totalBytes, expectedTotal);
  const compressed = budget.run({ projectRoot: tempRoot, maxBytes: budget.DEFAULT_MAX_BYTES });
  assert.strictEqual(compressed.metric, "compressed");
  assert.ok(compressed.estimatedTransferBytes > 0);
  assert.strictEqual(compressed.measuredBytes, compressed.estimatedTransferBytes);

  const customConfigPath = path.join(tempRoot, "custom.config.json");
  fs.writeFileSync(customConfigPath, JSON.stringify({
    packOptions: { ignore: [{ type: "file", value: "app.js" }], include: [] },
  }), "utf8");
  const customConfig = budget.run({ projectRoot: tempRoot, configPath: customConfigPath, metric: "raw" });
  assert.strictEqual(customConfig.files, undefined, "报告不应泄露内部 files 数组");
  assert.strictEqual(customConfig.configPath, customConfigPath, "--config 自定义配置路径应生效");
  assert.strictEqual(customConfig.ignoredFileCount, 2, "--config 自定义忽略规则应生效");

  const cli = path.join(__dirname, "preview-source-budget.js");
  const cliResult = childProcess.spawnSync(process.execPath, [
    cli,
    "--project-root", tempRoot,
    "--config", customConfigPath,
    "--max-bytes", String(customConfig.rawBytes),
    "--metric", "raw",
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(cliResult.status, 0, `CLI 应通过：${cliResult.stderr}`);
  assert.strictEqual(JSON.parse(cliResult.stdout).ok, true, "CLI 应输出结构化 JSON");

  console.log("preview-source-budget-smoke: PASS (ignore/include/limit/json/cli)");
} finally {
  const reportPath = path.join(os.tmpdir(), `preview-source-budget-report-${process.pid}.json`);
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
