/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const baseline = require("./admin-v2-same-device-baseline");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "visual-evidence", "admin-v2-same-device-manifest.json");
const manifest = baseline.readJson(manifestPath);

assert.strictEqual(manifest.schemaVersion, 1);
assert.strictEqual(manifest.viewport.width, 390);
assert.strictEqual(manifest.viewport.height, 844);
assert.strictEqual(manifest.capture.renderer, "wechat-devtools-simulator");
assert.strictEqual(manifest.capture.fixtureId, baseline.REQUIRED_FIXTURE_ID);
assert.strictEqual(manifest.capture.fontProfile, baseline.REQUIRED_FONT_PROFILE);
assert.strictEqual(manifest.capture.stateId, "collapsed-default-v1");
assert.deepStrictEqual(manifest.pages.map(item => item.name), baseline.PAGE_NAMES);
const normalized = baseline.validateManifest(manifest, root);
assert.strictEqual(normalized.pages.length, 4);
normalized.pages.forEach(item => {
  assert.match(item.actualSha256, /^[0-9a-f]{64}$/);
  assert.match(item.referenceSha256, /^[0-9a-f]{64}$/);
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "same-device-baseline-"));
try {
  const badViewport = JSON.parse(JSON.stringify(manifest));
  badViewport.viewport.width = 375;
  assert.throws(() => baseline.validateManifest(badViewport, root), /390 x 844/);
  const badRenderer = JSON.parse(JSON.stringify(manifest));
  badRenderer.capture.renderer = "";
  assert.throws(() => baseline.validateManifest(badRenderer, root), /renderer/);
  const staleHash = JSON.parse(JSON.stringify(manifest));
  staleHash.pages[0].actualSha256 = "0".repeat(64);
  assert.throws(() => baseline.validateManifest(staleHash, root), /SHA256/);

  const output = path.join(tempRoot, "diffs");
  const report = baseline.run({ root, manifest: manifestPath, output, threshold: 32, maxDiffRatio: 0.5 });
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.pages.length, 4);
  report.pages.forEach(item => assert.ok(fs.existsSync(item.heatmap), `${item.name} 必须生成热图`));

  const cli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "admin-v2-same-device-baseline.js"),
    "--manifest", manifestPath,
    "--output", output,
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(cli.status, 0, `CLI 应通过：${cli.stderr}`);
  assert.strictEqual(JSON.parse(cli.stdout).pages.length, 4);
  const noHashCli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, "admin-v2-same-device-baseline.js"),
    "--manifest", manifestPath,
    "--output", output,
    "--no-verify-hashes",
  ], { cwd: root, encoding: "utf8" });
  assert.strictEqual(noHashCli.status, 0, `--no-verify-hashes 应通过：${noHashCli.stderr}`);
  console.log("admin-v2-same-device-baseline-smoke: PASS (manifest/viewport/renderer/hash/four-pages/cli)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
