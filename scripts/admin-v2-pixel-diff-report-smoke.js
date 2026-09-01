/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const regression = require("./admin-v2-pixel-regression");
const report = require("./admin-v2-pixel-diff-report");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-pixel-diff-report-"));

function writePng(filePath, width, height, pixels) {
  const PNG = (() => {
    try {
      return require("pngjs").PNG;
    } catch (error) {
      return require("../cloudfunctions/api/node_modules/pngjs").PNG;
    }
  })();
  const target = path.join(tempRoot, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, PNG.sync.write({ width, height, data: Buffer.from(pixels) }));
}

function solid(width, height, color) {
  const result = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < result.length; offset += 4) {
    result[offset] = color[0];
    result[offset + 1] = color[1];
    result[offset + 2] = color[2];
    result[offset + 3] = color[3];
  }
  return result;
}

function setPixel(pixels, width, x, y, color) {
  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

try {
  const width = 8;
  const height = 8;
  const base = solid(width, height, [245, 248, 252, 255]);
  const operations = Buffer.from(base);
  setPixel(operations, width, 2, 3, [255, 0, 0, 255]);
  setPixel(operations, width, 3, 3, [255, 0, 0, 255]);
  setPixel(operations, width, 4, 4, [255, 0, 0, 255]);
  const config = Buffer.from(base);
  setPixel(config, width, 7, 0, [0, 0, 255, 255]);

  const fixtures = {
    dashboard: { actual: base, reference: base },
    operations: { actual: operations, reference: base },
    config: { actual: config, reference: base },
    provider: { actual: base, reference: base },
  };
  const pages = report.PAGE_NAMES.map(name => {
    const actual = `images/${name}-actual.png`;
    const reference = `images/${name}-reference.png`;
    writePng(actual, width, height, fixtures[name].actual);
    writePng(reference, width, height, fixtures[name].reference);
    return { name, actual, reference };
  });
  const manifestPath = path.join(tempRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    viewport: { width, height },
    mode: "smoke",
    fixtureId: "admin-v2-reference-20260901-v1",
    fontProfile: "Microsoft YaHei > PingFang SC > SimHei > system-ui > sans-serif",
    stateId: "collapsed-default-v1",
    pages,
  }, null, 2));

  const outputRoot = path.join(tempRoot, "diffs");
  const jsonPath = path.join(outputRoot, "report.json");
  const markdownPath = path.join(outputRoot, "report.md");
  const result = report.run({
    root: tempRoot,
    manifest: manifestPath,
    heatmapRoot: outputRoot,
    json: jsonPath,
    markdown: markdownPath,
    threshold: 16,
    maxDiffRatio: 0.5,
    tileSize: 4,
    topTiles: 3,
  });
  assert.strictEqual(result.ok, true, "局部差异在比例阈值内应通过");
  assert.strictEqual(result.pages.length, 4);
  const dashboard = result.pages.find(item => item.name === "dashboard");
  assert.strictEqual(dashboard.differentPixels, 0, "零差异页面应为 0");
  assert.strictEqual(dashboard.boundingBox, null, "零差异页面不应有包围盒");
  assert.strictEqual(dashboard.hotspotTile, null, "零差异页面不应有热点");
  const operationsPage = result.pages.find(item => item.name === "operations");
  assert.strictEqual(operationsPage.differentPixels, 3);
  assert.deepStrictEqual(operationsPage.boundingBox, {
    left: 2,
    top: 3,
    right: 4,
    bottom: 4,
    width: 3,
    height: 2,
    differentPixels: 3,
  });
  assert.strictEqual(operationsPage.hotspotTile.tileX, 0);
  assert.strictEqual(operationsPage.hotspotTile.tileY, 0);
  assert.ok(fs.existsSync(path.join(outputRoot, "operations.png")), "应生成热图");
  assert.ok(fs.existsSync(jsonPath), "应生成 JSON 报告");
  assert.ok(fs.existsSync(markdownPath), "应生成 Markdown 报告");
  const jsonText = fs.readFileSync(jsonPath, "utf8");
  const markdownText = fs.readFileSync(markdownPath, "utf8");
  assert.strictEqual(JSON.parse(jsonText).pages.length, 4);
  assert.match(JSON.parse(jsonText).manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(JSON.parse(jsonText).evidenceDigest, /^[0-9a-f]{64}$/);
  assert.ok(JSON.parse(jsonText).pages.every(item => /^[0-9a-f]{64}$/.test(item.actualSha256) && /^[0-9a-f]{64}$/.test(item.referenceSha256)));
  assert.ok(markdownText.includes("控制台四页像素差异报告"));
  assert.ok(markdownText.includes("证据摘要"));
  assert.ok(!jsonText.includes("apiKey") && !markdownText.includes("apiKey"), "报告不得泄露凭证字段");

  const defaultArgs = report.parseArgs([]);
  assert.strictEqual(defaultArgs.strictZeroDiff, false, "默认模式不应开启严格零差");
  assert.strictEqual(defaultArgs.threshold, report.DEFAULT_THRESHOLD, "默认阈值行为必须保持不变");
  assert.strictEqual(defaultArgs.maxDiffRatio, report.DEFAULT_MAX_DIFF_RATIO, "默认比例行为必须保持不变");
  const strictArgs = report.parseArgs([
    "--threshold", "255",
    "--max-diff-ratio", "1",
    "--strict-zero-diff",
  ]);
  assert.strictEqual(strictArgs.strictZeroDiff, true, "应解析 --strict-zero-diff");
  assert.strictEqual(strictArgs.threshold, 0, "严格模式必须强制 threshold=0");
  assert.strictEqual(strictArgs.maxDiffRatio, 0, "严格模式必须强制 maxDiffRatio=0");

  const strictPages = report.PAGE_NAMES.map(name => {
    const actual = `strict-images/${name}-actual.png`;
    const reference = `strict-images/${name}-reference.png`;
    writePng(actual, width, height, base);
    writePng(reference, width, height, base);
    return { name, actual, reference };
  });
  const strictManifestPath = path.join(tempRoot, "strict-manifest.json");
  fs.writeFileSync(strictManifestPath, JSON.stringify({
    schemaVersion: 1,
    viewport: { width, height },
    mode: "strict-smoke",
    pages: strictPages,
  }, null, 2));
  const strictOutputRoot = path.join(tempRoot, "strict-diffs");
  const strictPass = report.run({
    root: tempRoot,
    manifest: strictManifestPath,
    heatmapRoot: strictOutputRoot,
    json: path.join(strictOutputRoot, "pass.json"),
    markdown: path.join(strictOutputRoot, "pass.md"),
    strictZeroDiff: true,
    threshold: 255,
    maxDiffRatio: 1,
  });
  assert.strictEqual(strictPass.ok, true, "严格模式下完全相同的图片应 PASS");
  assert.strictEqual(strictPass.strictZeroDiff, true, "报告必须记录严格零差模式");
  assert.strictEqual(strictPass.threshold, 0, "严格报告的 threshold 必须为 0");
  assert.strictEqual(strictPass.maxDiffRatio, 0, "严格报告的 maxDiffRatio 必须为 0");
  assert.ok(strictPass.pages.every(page => (
    page.strictZeroDiff === true
    && page.dimensionsMatch === true
    && page.differentPixels === 0
    && page.pass === true
  )), "严格报告页面必须记录尺寸一致、零差异和 PASS");

  const onePixelChanged = Buffer.from(base);
  setPixel(onePixelChanged, width, 1, 1, [244, 248, 252, 255]);
  writePng("strict-images/provider-actual.png", width, height, onePixelChanged);
  const strictPixelFail = report.run({
    root: tempRoot,
    manifest: strictManifestPath,
    heatmapRoot: strictOutputRoot,
    json: false,
    markdown: false,
    strictZeroDiff: true,
  });
  const strictProvider = strictPixelFail.pages.find(item => item.name === "provider");
  assert.strictEqual(strictPixelFail.ok, false, "严格模式下单像素变化应 FAIL");
  assert.strictEqual(strictProvider.differentPixels, 1);
  assert.strictEqual(strictProvider.dimensionsMatch, true);
  assert.strictEqual(strictProvider.pass, false);

  writePng("strict-images/provider-actual.png", width / 2, height / 2, solid(width / 2, height / 2, [245, 248, 252, 255]));
  const strictSizeFail = report.run({
    root: tempRoot,
    manifest: strictManifestPath,
    heatmapRoot: strictOutputRoot,
    json: false,
    markdown: false,
    strictZeroDiff: true,
  });
  const resizedProvider = strictSizeFail.pages.find(item => item.name === "provider");
  assert.strictEqual(strictSizeFail.ok, false, "严格模式下尺寸不一致应 FAIL");
  assert.strictEqual(resizedProvider.differentPixels, 0, "缩放后像素相同也不能掩盖尺寸不一致");
  assert.strictEqual(resizedProvider.dimensionsMatch, false);
  assert.strictEqual(resizedProvider.pass, false);

  const cli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "admin-v2-pixel-diff-report.js"),
    "--root", tempRoot,
    "--manifest", manifestPath,
    "--heatmap-root", outputRoot,
    "--json", path.join(outputRoot, "cli-report.json"),
    "--markdown", path.join(outputRoot, "cli-report.md"),
    "--threshold", "16",
    "--max-diff-ratio", "0.5",
    "--tile-size", "4",
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(cli.status, 0, `CLI 应通过：${cli.stderr}`);
  assert.strictEqual(JSON.parse(cli.stdout).pages.length, 4);
  const strictCli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "admin-v2-pixel-diff-report.js"),
    "--root", tempRoot,
    "--manifest", strictManifestPath,
    "--heatmap-root", strictOutputRoot,
    "--json", path.join(strictOutputRoot, "cli-report.json"),
    "--markdown", path.join(strictOutputRoot, "cli-report.md"),
    "--strict-zero-diff",
  ], { cwd: path.join(__dirname, ".."), encoding: "utf8" });
  assert.strictEqual(strictCli.status, 1, `严格 CLI 对尺寸不一致应 FAIL：${strictCli.stderr}`);
  const strictCliReport = JSON.parse(strictCli.stdout);
  assert.strictEqual(strictCliReport.strictZeroDiff, true);
  assert.strictEqual(strictCliReport.threshold, 0);
  assert.strictEqual(strictCliReport.maxDiffRatio, 0);
  assert.strictEqual(strictCliReport.pages.find(item => item.name === "provider").dimensionsMatch, false);
  console.log("admin-v2-pixel-diff-report-smoke: PASS (default/strict-zero/single-pixel/size/args/report/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
