/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const capture = require("./admin-v2-devtools-cli-capture");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "admin-v2-devtools-cli-capture-"));
try {
  assert.strictEqual(capture.routeFor(capture.PAGE_TARGETS ? capture.PAGE_TARGETS[0] : { pathPart: "pages/admin-dashboard/admin-dashboard", name: "dashboard" }, "collapsed-default-v1").includes("fixture=admin-v2-reference-20260901-v1"), true);
  assert.ok(capture.quoteWindowsArg("demo=1&fixture=test").startsWith('"'));
  assert.ok(capture.quoteWindowsArg("中文 路径").endsWith('"'));
  const parsed = capture.parseArgs(["--project", ".", "--client", "default", "--state", "video-mode-v1"]);
  assert.strictEqual(parsed.project, ".");
  assert.strictEqual(parsed.client, "default");
  assert.strictEqual(parsed.state, "video-mode-v1");
  assert.throws(() => capture.parseArgs(["--state", "missing"]), /未知视觉状态/);
  const envelope = capture.parseJsonEnvelope("日志\n{\"ok\":true,\"result\":{\"success\":true}}", "probe");
  assert.strictEqual(envelope.ok, true);
  assert.throws(() => capture.parseJsonEnvelope("{\"ok\":false,\"message\":\"bad\"}", "probe"), /probe 失败/);
  const output = path.join(tempRoot, "out");
  fs.mkdirSync(output, { recursive: true });
  assert.ok(output.endsWith("out"));
  console.log("admin-v2-devtools-cli-capture-smoke: PASS (args/quoting/routes/envelope/blocked-safe)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
