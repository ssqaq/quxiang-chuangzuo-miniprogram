/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const probe = require("./admin-v2-runtime-geometry-probe");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-runtime-geometry-"));
try {
  const input = {
    schemaVersion: 1,
    fixtureId: probe.EXPECTED_FIXTURE_ID,
    fontProfile: probe.EXPECTED_FONT_PROFILE,
    viewport: probe.EXPECTED_VIEWPORT,
    pages: probe.PAGE_NAMES.map(name => ({
      name,
      viewport: { width: 390, height: 844, dpr: 3, scrollWidth: 390, scrollHeight: 1600 },
      elements: probe.REQUIRED_SELECTORS[name].map(selector => ({ selector, rect: { left: 8, right: 382, width: 374, height: 30, top: 10, bottom: 40 } })),
    })),
  };
  fs.writeFileSync(path.join(root, "input.json"), JSON.stringify(input), "utf8");
  const pass = probe.run({ root, input: "input.json", output: "report.json" });
  assert.strictEqual(pass.ok, true);
  input.pages[0].viewport.scrollWidth = 391;
  fs.writeFileSync(path.join(root, "bad.json"), JSON.stringify(input), "utf8");
  const fail = probe.run({ root, input: "bad.json", output: false });
  assert.strictEqual(fail.ok, false);
  assert.match(fail.errors.join(";"), /横向滚动宽度异常/);
  console.log("admin-v2-runtime-geometry-probe-smoke: PASS (viewport/overflow/required-rects/failure)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
