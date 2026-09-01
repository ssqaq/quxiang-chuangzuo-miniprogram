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
  console.log("admin-v2-visual-archive-smoke: PASS (immutable-copy/hash/fixture/viewport/secret-guard)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
