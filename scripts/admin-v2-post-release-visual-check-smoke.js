/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const check = require("./admin-v2-post-release-visual-check");
const archive = require("./admin-v2-visual-archive");

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-post-release-"));
  try {
    const source = path.join(root, "visual-evidence", "captured-final-v8");
    fs.mkdirSync(source, { recursive: true });
    check.PAGE_NAMES.forEach(name => fs.writeFileSync(path.join(source, `${name}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, name.length]), "binary"));
    archive.DEFAULT_REPORTS.forEach(relative => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ok: true }), "utf8"); });
    const result = await check.run({ root, version: "0.0.1-smoke", allowExisting: true, skipContracts: true, skipDiff: true, retentionDays: 2 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.capture.status, "reused-existing");
    assert.ok(fs.existsSync(result.archive.manifestPath));
    assert.strictEqual(result.archive.retentionDays, 2);
    assert.ok(result.archive.cutoffAt);
    assert.ok(Array.isArray(result.archive.skippedVersions));
    assert.deepStrictEqual(archive.listArchiveVersions(path.join(root, "visual-evidence", "archive")), ["v0.0.1-smoke"]);
    assert.throws(() => check.validateCapturedManifest(source), /capture-manifest/);
    const captured = path.join(root, "captured");
    fs.mkdirSync(captured, { recursive: true });
    check.PAGE_NAMES.forEach(name => fs.copyFileSync(path.join(source, `${name}.png`), path.join(captured, `${name}.png`)));
    const captures = check.PAGE_NAMES.map(name => {
      const file = path.join(captured, `${name}.png`);
      return { name, output: file, bytes: fs.statSync(file).size, sha256: check.resolve ? require("./admin-v2-visual-capture").sha256(file) : "" };
    });
    fs.writeFileSync(path.join(captured, "capture-manifest.json"), JSON.stringify({ captureStatus: "captured", fixtureId: check.DEFAULT_FIXTURE_ID, viewport: { width: 390, height: 844 }, captures }), "utf8");
    assert.strictEqual(check.validateCapturedManifest(captured).manifest.captureStatus, "captured");
    console.log("admin-v2-post-release-visual-check-smoke: PASS (reuse/capture-report/archive/retention)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
