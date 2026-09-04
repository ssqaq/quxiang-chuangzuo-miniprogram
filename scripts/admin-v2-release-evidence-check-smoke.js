/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const checker = require("./admin-v2-release-evidence-check");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-release-evidence-"));
try {
  fs.mkdirSync(path.join(root, "visual-evidence"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  ["baseline.json", "archive.js", "contract.js"].forEach(name => fs.writeFileSync(path.join(root, "scripts", name), `${name}\n`, "utf8"));
  fs.writeFileSync(path.join(root, "visual-evidence", "baseline.json"), "{}\n", "utf8");
  const manifest = {
    schemaVersion: 1,
    status: "accepted",
    baselineVersion: "1.2.3",
    retentionDays: 3,
    requiredFiles: ["visual-evidence/baseline.json", "scripts/baseline.json", "scripts/archive.js", "scripts/contract.js"]
  };
  fs.writeFileSync(path.join(root, "visual-evidence", "manifest.json"), JSON.stringify(manifest), "utf8");
  const result = checker.run({ root, manifest: "visual-evidence/manifest.json", checkOnly: true });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.files.length, 4);
  assert.strictEqual(result.retentionDays, 3);
  assert.throws(() => checker.resolveInside(root, "../outside.txt", "test"), /越出源码目录/);
  const duplicate = Object.assign({}, manifest, { requiredFiles: ["scripts/archive.js", "scripts/archive.js"] });
  fs.writeFileSync(path.join(root, "visual-evidence", "manifest.json"), JSON.stringify(duplicate), "utf8");
  assert.throws(() => checker.run({ root, manifest: "visual-evidence/manifest.json" }), /重复文件/);
  console.log("admin-v2-release-evidence-check-smoke: PASS (manifest/status/version/retention/path/existence/duplicate)");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
