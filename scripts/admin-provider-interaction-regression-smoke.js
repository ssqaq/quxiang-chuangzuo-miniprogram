/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-provider-interaction-regression");

async function run() {
  const parsed = regression.parseArgs([
    "--mode", "automator",
    "--connect-port", "9423",
    "--allow-missing-runtime",
    "--check-only",
    "--timeout-ms", "5000"
  ]);
  assert.strictEqual(parsed.mode, "automator");
  assert.strictEqual(parsed.connectPort, 9423);
  assert.strictEqual(parsed.automatorPort, 9437);
  assert.strictEqual(parsed.allowMissingRuntime, true);
  assert.strictEqual(parsed.checkOnly, true);
  assert.strictEqual(parsed.timeoutMs, 5000);

  const touch = regression.buildTouchEvent(12, 34);
  assert.deepStrictEqual(touch.touches[0], {
    identifier: 1,
    pageX: 12,
    pageY: 34,
    clientX: 12,
    clientY: 34
  });
  assert.strictEqual(touch.changeTouches.length, 1);

  const contract = regression.providerContract(path.resolve(__dirname, ".."));
  assert.strictEqual(contract.ok, true, `供应商页源码契约不满足：${JSON.stringify(contract)}`);
  assert.ok(contract.checks.some(check => check.id === "provider-pull-refresh" && check.pass));
  assert.ok(contract.checks.some(check => check.id === "provider-list-anchor" && check.pass));

  let scrollTop = 0;
  const touchCalls = [];
  const fakeList = {
    async size() { return { width: "200", height: "100" }; },
    async scrollHeight() { return "320"; },
    async property(name) { assert.strictEqual(name, "scrollTop"); return scrollTop; },
    async offset() { return { left: 10, top: 20 }; },
    async touchstart(event) { touchCalls.push(["start", event]); },
    async touchmove(event) { touchCalls.push(["move", event]); scrollTop = 180; },
    async touchend(event) { touchCalls.push(["end", event]); },
    async scrollTo(x, y) { assert.strictEqual(x, 0); scrollTop = y; }
  };
  const swipe = await regression.swipeProviderList({ $: async selector => {
    assert.strictEqual(selector, ".provider-list");
    return fakeList;
  } }, { waitMs: 0 });
  assert.strictEqual(swipe.moved, true);
  assert.strictEqual(swipe.mode, "touch");
  assert.strictEqual(swipe.restored, true);
  assert.strictEqual(scrollTop, 0, "滑动回归结束必须恢复目录首端");
  assert.deepStrictEqual(touchCalls.map(call => call[0]), ["start", "move", "end"]);
  assert.ok(touchCalls[0][1].touches[0].pageY > touchCalls[1][1].touches[0].pageY);

  let fallbackScrollTop = 0;
  const fallbackList = {
    async size() { return { width: "200", height: "100" }; },
    async scrollHeight() { return "320"; },
    async property() { return fallbackScrollTop; },
    async touchstart() { throw new Error("模拟触摸协议错误"); },
    async scrollTo(x, y) { assert.strictEqual(x, 0); fallbackScrollTop = y; }
  };
  const fallback = await regression.swipeProviderList({ $: async () => fallbackList }, { waitMs: 0 });
  assert.strictEqual(fallback.mode, "scrollTo-fallback");
  assert.strictEqual(fallback.moved, true);
  assert.strictEqual(fallback.restored, true);
  assert.strictEqual(fallbackScrollTop, 0);

  const report = await regression.run({
    root: path.resolve(__dirname, ".."),
    checkOnly: true,
    output: fs.mkdtempSync(path.join(require("os").tmpdir(), "provider-interaction-smoke-"))
  });
  assert.strictEqual(report.status, "passed");
  assert.strictEqual(report.mode, "check-only");
  assert.strictEqual(report.refresh, null);
  assert.strictEqual(report.swipe, null);
  console.log("admin-provider-interaction-regression-smoke: PASS (contract/args/touch/check-only)");
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
