const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const archive = require("./admin-v2-visual-archive");
const indexer = require("./admin-v2-visual-index");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-visual-index-"));
try {
  const archiveRoot = path.join(root, "visual-evidence", "archive");
  ["0.0.1", "0.0.2"].forEach(version => {
    const versionRoot = path.join(archiveRoot, `v${version}`);
    fs.mkdirSync(versionRoot, { recursive: true });
    const imagePath = path.join(versionRoot, "dashboard.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, version.length]));
    const stat = fs.statSync(imagePath);
    fs.writeFileSync(path.join(versionRoot, "archive-manifest.json"), `${JSON.stringify({ schemaVersion: 1, version, fixtureId: "fixture", viewport: { width: 390, height: 844 }, renderer: "test", archivedAt: "2026-09-01T00:00:00.000Z", files: [{ name: "dashboard.png", bytes: stat.size, sha256: archive.sha256(imagePath) }] }, null, 2)}\n`);
  });
  const result = indexer.run({ root, archiveRoot });
  assert.deepStrictEqual(result.versions.map(item => item.version), ["0.0.2", "0.0.1"]);
  assert.ok(fs.existsSync(result.jsonPath));
  assert.ok(fs.existsSync(result.htmlPath));
  const html = fs.readFileSync(result.htmlPath, "utf8");
  assert.match(html, /四页视觉归档/);
  assert.match(html, /v0\.0\.2/);
  const manifestPath = path.join(archiveRoot, "v0.0.1", "archive-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files[0].sha256 = "0".repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => indexer.run({ root, archiveRoot }), /SHA256 不匹配/);
  console.log("admin-v2-visual-index-smoke: PASS (version-sort/hash/index-json/index-html)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

