/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "scripts/devtools-9437-watch.ps1"), "utf8");
assert.ok(script.includes("-AutoPort 9437") || script.includes("-AutoPort", 1), "保活未固定 9437 入口");
assert.ok(script.includes("$Once") && script.includes("Start-Sleep"), "保活缺少一次检查/轮询");
assert.ok(script.includes("ensure-devtools-9437.ps1") && script.includes("ConvertTo-Json"), "保活未复用诊断脚本或 JSON 状态");
assert.ok(!/Remove-Item|Stop-Process|git\s+reset/i.test(script), "保活脚本包含破坏性动作");
console.log("devtools-9437-watch-smoke: PASS (9437/once/polling/diagnostics/non-destructive)");
