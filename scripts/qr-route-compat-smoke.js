"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const legacyRoute = "pages/user/user";
const targetRoute = "pages/workbench/workbench";

assert.ok(Array.isArray(app.pages), "app.json pages 必须是数组");
assert.ok(app.pages.includes(legacyRoute), "体验版二维码旧路径必须注册");
assert.ok(app.pages.includes(targetRoute), "用户中心目标路径必须注册");

const shim = fs.readFileSync(path.join(root, "pages", "user", "user.js"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
assert.ok(shim.includes('const TARGET_ROUTE = "/pages/workbench/workbench";'), "兼容页必须跳转到工作台");
assert.ok(shim.includes("wx.redirectTo"), "兼容页必须使用 redirectTo");
assert.ok(shim.includes("wx.reLaunch"), "兼容页必须保留 reLaunch 兜底");
assert.ok(appSource.includes("onPageNotFound"), "全局必须保留不存在页面兜底");
assert.ok(appSource.includes('const LEGACY_USER_ROUTE = "pages/user/user";'), "全局必须识别旧用户路径");

assert.ok(appSource.includes('const LEGACY_USER_TARGET_ROUTE = "/pages/workbench/workbench";'), "全局兜底必须跳转到工作台");
console.log("qr route compat smoke: OK (pages/user/user -> pages/workbench/workbench)");
