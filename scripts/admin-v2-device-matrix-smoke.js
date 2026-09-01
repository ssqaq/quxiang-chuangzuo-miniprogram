const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("../cloudfunctions/api/node_modules/pngjs");
const matrix = require("./admin-v2-device-matrix");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-device-matrix-"));
try {
  const devices = matrix.DEVICES.map(device => ({
    id: device.id,
    pages: matrix.PAGE_NAMES.map(name => {
      const relative = path.join("shots", device.id, `${name}.png`);
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, PNG.sync.write(new PNG({ width: device.width, height: device.height })));
      return { name, screenshot: relative.replace(/\\/g, "/"), sha256: matrix.sha256(target), viewport: { width: device.width, height: device.height, scrollWidth: device.width, dpr: 1 } };
    })
  }));
  const manifest = { schemaVersion: 1, fixtureId: matrix.FIXTURE_ID, fontProfile: matrix.FONT_PROFILE, renderer: "browser", devices };
  assert.strictEqual(matrix.validate(manifest, { root }).ok, true);
  const missing = JSON.parse(JSON.stringify(manifest));
  missing.devices.pop();
  assert.strictEqual(matrix.validate(missing, { root }).ok, false);
  const overflow = JSON.parse(JSON.stringify(manifest));
  overflow.devices[0].pages[0].viewport.scrollWidth = 376;
  assert.strictEqual(matrix.validate(overflow, { root }).ok, false);
  console.log("admin-v2-device-matrix-smoke: PASS (three-devices/four-pages/dimensions/overflow/hash)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
