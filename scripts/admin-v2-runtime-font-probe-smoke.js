/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const font = require("./admin-v2-runtime-font-probe");
const geometry = require("./admin-v2-runtime-geometry-probe");
const layout = require("./admin-v2-layout-contract");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-runtime-font-"));
try {
  const input = { schemaVersion: 1, fixtureId: geometry.EXPECTED_FIXTURE_ID, fontProfile: geometry.EXPECTED_FONT_PROFILE, pages: geometry.PAGE_NAMES.map(name => ({ name, pageFontFamily: layout.FONT_STACK, samples: [{ selector: "body", fontFamily: layout.FONT_STACK }, { selector: ".title", fontFamily: layout.FONT_STACK }] })) };
  fs.writeFileSync(path.join(root, "input.json"), JSON.stringify(input), "utf8");
  assert.strictEqual(font.run({ root, input: "input.json", output: "report.json" }).ok, true);
  input.pages[0].samples[0].fontFamily = "Arial";
  fs.writeFileSync(path.join(root, "bad.json"), JSON.stringify(input), "utf8");
  const fail = font.run({ root, input: "bad.json", output: false });
  assert.strictEqual(fail.ok, false);
  assert.match(fail.errors.join(";"), /字体不匹配/);
  console.log("admin-v2-runtime-font-probe-smoke: PASS (computed-font-profile/samples/failure)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
