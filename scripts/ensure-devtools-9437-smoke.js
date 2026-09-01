/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const script = path.join(__dirname, "ensure-devtools-9437.ps1");
assert.ok(fs.existsSync(script), "9437 启动脚本必须随源码存在");
const text = fs.readFileSync(script, "utf8");
assert.ok(text.includes("--auto-port"), "启动脚本必须传递 --auto-port");
assert.ok(text.includes("Get-Command \"wechatidecli.cmd\""), "默认应自动发现 CLI");
assert.ok(text.includes("project.config.json"), "启动脚本必须校验项目目录");
assert.ok(text.includes("already-listening"), "已有监听时必须复用");
assert.ok(text.includes("DevTools automation WebSocket"), "启动失败必须给出明确错误");
assert.ok(!text.includes("wechatide.cmd auto"), "脚本不能把命令拼成不可复用的字符串");
console.log("ensure-devtools-9437-smoke: PASS (script/port/project/reuse/failure-message)");
