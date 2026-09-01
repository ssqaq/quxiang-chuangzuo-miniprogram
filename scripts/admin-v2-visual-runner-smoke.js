/* eslint-disable no-console */

const assert = require("assert");
const runner = require("./admin-v2-visual-runner");

const parsed = runner.parseArgs(["--project", ".", "--state", "video-mode-v1"]);
assert.strictEqual(parsed.project, ".");
assert.strictEqual(parsed.state, "video-mode-v1");
assert.strictEqual(parsed.allStates, false);
assert.throws(() => runner.parseArgs(["--state", "unknown"]), /未知视觉状态/);
const check = runner.preflight({ project: __dirname, connectPort: 9437, automator: "missing-automator" });
assert.strictEqual(check.status, "blocked");
assert.ok(check.missing.includes("miniprogram-automator"));
console.log("admin-v2-visual-runner-smoke: PASS (args/preflight/blocked-prerequisite)" );
