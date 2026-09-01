const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const capture = require("./admin-v2-visual-capture");
const gate = require("./admin-v2-visual-capture-gate");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-capture-gate-"));
try {
  const captures = [];
  capture.STATE_IDS.forEach(stateId => {
    capture.STATE_TARGETS[stateId].forEach(name => {
      const output = path.join(root, stateId, `${name}-390x844.png`);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, PNG.sync.write(new PNG({ width: 390, height: 844 })));
      captures.push({ stateId, name, output, route: `/pages/${name}?demo=1&fixture=${gate.FIXTURE_ID}&visualState=${encodeURIComponent(stateId)}`, dimensions: { windowWidth: 390, windowHeight: 844 }, image: { width: 390, height: 844 }, bytes: fs.statSync(output).size, sha256: capture.sha256(output), fixtureId: gate.FIXTURE_ID });
    });
  });
  const manifest = { schemaVersion: 1, fixtureId: gate.FIXTURE_ID, renderer: "wechat-devtools-simulator", captureStatus: "captured", viewport: capture.VIEWPORT, states: capture.STATE_IDS.slice(), captures };
  assert.strictEqual(gate.validateManifest(manifest, { root, allStates: true }).ok, true);
  const badHash = JSON.parse(JSON.stringify(manifest));
  badHash.captures[0].sha256 = "0".repeat(64);
  assert.strictEqual(gate.validateManifest(badHash, { root, allStates: true }).ok, false);
  const missing = JSON.parse(JSON.stringify(manifest));
  missing.captures.pop();
  assert.strictEqual(gate.validateManifest(missing, { root, allStates: true }).ok, false);
  assert.throws(() => capture.parseArgs(["--state", "unknown"]), /未知视觉状态/);
  console.log("admin-v2-visual-capture-gate-smoke: PASS (strict-devtools/state-count/dimensions/hash)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
