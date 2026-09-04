/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const archive = require("./admin-v2-visual-archive");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-visual-archive-"));
try {
  const source = path.join(tempRoot, "screenshots");
  const reports = path.join(tempRoot, "reports");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(reports, { recursive: true });
  ["dashboard", "operations", "config", "provider"].forEach(name => fs.writeFileSync(path.join(source, `${name}.png`), `${name}\n`));
  fs.writeFileSync(path.join(reports, "layout.json"), JSON.stringify({ ok: true }), "utf8");
  const result = archive.run({
    root: tempRoot,
    version: "0.0.1-smoke",
    source: source,
    outputRoot: path.join(tempRoot, "archive"),
    files: ["dashboard.png", "operations.png", "config.png", "provider.png"].map(name => path.join(source, name)),
    reports: [path.join(reports, "layout.json")],
  });
  assert.strictEqual(result.files.length, 5);
  assert.strictEqual(result.fixtureId, "admin-v2-reference-20260901-v1");
  assert.deepStrictEqual(result.viewport, { width: 390, height: 844 });
  assert.ok(fs.existsSync(result.manifestPath));
  result.files.forEach(item => {
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.ok(item.bytes > 0);
  });
  fs.writeFileSync(path.join(reports, "bad.json"), JSON.stringify({ apiKey: "secret" }), "utf8");
  assert.throws(() => archive.assertSafeArtifact(path.join(reports, "bad.json")), /凭证字段/);
  const retentionRoot = path.join(tempRoot, "archive-retention");
  const now = new Date("2026-09-03T12:00:00.000Z");
  const writeArchive = (version, archivedAt) => {
    const dir = path.join(retentionRoot, `v${version}`);
    fs.mkdirSync(dir, { recursive: true });
    if (archivedAt !== null) {
      fs.writeFileSync(path.join(dir, "archive-manifest.json"), JSON.stringify({ archivedAt }), "utf8");
    }
    fs.writeFileSync(path.join(dir, "marker.txt"), version, "utf8");
  };
  writeArchive("0.0.1-old", "2026-08-29T11:59:59.999Z");
  writeArchive("0.0.1-edge", "2026-08-31T12:00:00.000Z");
  writeArchive("0.0.1-new", "2026-09-02T12:00:00.001Z");
  writeArchive("0.0.1-protected", "2026-08-20T12:00:00.000Z");
  writeArchive("0.0.1-missing", null);
  writeArchive("0.0.1-bad", "not-a-date");
  const retention = archive.pruneArchives(retentionRoot, {
    retentionDays: 3,
    now,
    protectVersions: ["0.0.1-protected"],
  });
  assert.deepStrictEqual(retention.prunedVersions, ["v0.0.1-edge", "v0.0.1-old"]);
  assert.strictEqual(retention.retentionDays, 3);
  assert.strictEqual(retention.cutoffAt, "2026-08-31T12:00:00.000Z");
  assert.ok(retention.keptVersions.includes("v0.0.1-new"));
  assert.ok(retention.keptVersions.includes("v0.0.1-protected"));
  assert.deepStrictEqual(retention.skippedVersions.map(item => item.version), ["v0.0.1-bad", "v0.0.1-missing"]);
  assert.throws(() => archive.pruneArchives(retentionRoot, 0), /保留天数/);
  const args = archive.parseArgs(["--cleanup-only", "--retain-days", "3", "--now", now.toISOString()]);
  assert.strictEqual(args.cleanupOnly, true);
  assert.strictEqual(args.retentionDays, 3);
  console.log("admin-v2-visual-archive-smoke: PASS (immutable-copy/hash/fixture/viewport/secret-guard/time-retention/cleanup-only)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
