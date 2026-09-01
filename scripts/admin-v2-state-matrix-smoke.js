const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const matrix = require("./admin-v2-state-matrix");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-state-matrix-"));
try {
  const states = matrix.STATES.map(state => ({
    id: state.id,
    expected: state.expected,
    pages: state.pages.map(name => {
      const relative = path.join("shots", state.id, `${name}.png`);
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, PNG.sync.write(new PNG({ width: 390, height: 844 })));
      return { name, screenshot: relative.replace(/\\/g, "/"), sha256: matrix.sha256(target) };
    })
  }));
  const manifest = { schemaVersion: 1, fixtureId: matrix.FIXTURE_ID, fontProfile: matrix.FONT_PROFILE, states };
  assert.strictEqual(matrix.validate(manifest, { root }).ok, true);
  const missing = JSON.parse(JSON.stringify(manifest));
  missing.states.pop();
  assert.strictEqual(matrix.validate(missing, { root }).ok, false);
  const badHash = JSON.parse(JSON.stringify(manifest));
  badHash.states[0].pages[0].sha256 = "0".repeat(64);
  assert.strictEqual(matrix.validate(badHash, { root }).ok, false);
  const pageSource = fs.readFileSync(path.join(__dirname, "..", "pages", "admin-config", "admin-config.js"), "utf8");
  const fixtureSource = fs.readFileSync(path.join(__dirname, "..", "services", "admin-preview-fixtures.js"), "utf8");
  assert.match(pageSource, /resolveVisualState\(options\)/);
  assert.match(pageSource, /adminConfig\(\{ visualState:/);
  assert.match(fixtureSource, /backup\.status = "not-ready"/);
  console.log("admin-v2-state-matrix-smoke: PASS (four-states/dimensions/hash/demo-only-state)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
