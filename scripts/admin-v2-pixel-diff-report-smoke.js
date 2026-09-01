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
  console.log("admin-v2-pixel-diff-report-smoke: PASS (zero/local-diff/bbox/hotspot/json/markdown/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
