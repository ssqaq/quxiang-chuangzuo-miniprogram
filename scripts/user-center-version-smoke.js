/* eslint-disable no-console */

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const scriptRoot = path.resolve(__dirname, "..");
const versionGroupFiles = [
  "cloudfunctions/api/package.json",
  "cloudfunctions/api/package-lock.json",
  "cloudfunctions/watermark-gateway/package.json",
  "media-worker/package.json",
  "media-worker/package-lock.json",
  "cloudfunctions/payment-core/package.json",
  "cloudfunctions/payment-api/package.json",
  "cloudfunctions/payment-api/package-lock.json",
  "cloudfunctions/payment-api/vendor/payment-core/package.json",
  "cloudfunctions/payment-notify/package.json",
  "cloudfunctions/payment-notify/package-lock.json",
  "cloudfunctions/payment-notify/vendor/payment-core/package.json",
  "cloudfunctions/payment-reconcile/package.json",
  "cloudfunctions/payment-reconcile/package-lock.json",
  "cloudfunctions/payment-reconcile/vendor/payment-core/package.json",
];

function parseArgs() {
  const args = process.argv.slice(2);
  let projectRoot = process.env.USER_CENTER_VERSION_ROOT || scriptRoot;
  let expectedVersion = process.env.USER_CENTER_EXPECTED_VERSION || "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      projectRoot = args[++index];
    } else if (arg === "--expected-version") {
      expectedVersion = args[++index];
    } else if (arg === "--help" || arg === "-h") {
      console.log("用法：node scripts/user-center-version-smoke.js [--root 项目目录] [--expected-version X.Y.Z]");
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return {
    projectRoot: path.resolve(projectRoot),
    expectedVersion: String(expectedVersion || "").trim(),
  };
}

function read(projectRoot, relative) {
  return fs.readFileSync(path.join(projectRoot, relative), "utf8");
}

function readJson(projectRoot, relative) {
  const file = path.join(projectRoot, relative);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertSemver(version, label) {
  assert.match(String(version), /^\d+\.\d+\.\d+$/, `${label} 必须是三段式版本号`);
}

function collectVersionSources(projectRoot) {
  const configPath = require.resolve(path.join(projectRoot, "config.js"));
  delete require.cache[configPath];
  const config = require(configPath);
  const configVersion = String(config.appVersion || "");
  assertSemver(configVersion, "config.appVersion");

  const apiText = read(projectRoot, "cloudfunctions/api/index.js");
  const apiMatch = apiText.match(/const\s+API_BUILD_VERSION\s*=\s*["']([^"']+)["']/);
  assert.ok(apiMatch, "云函数必须声明 API_BUILD_VERSION");
  const markerMatch = apiText.match(/const\s+API_BUILD_MARKER\s*=\s*["']([^"']+)["']/);
  assert.ok(markerMatch, "云函数必须声明 API_BUILD_MARKER");

  const sources = [
    { file: "config.js", value: configVersion },
    { file: "cloudfunctions/api/index.js", value: apiMatch[1] },
  ];
  for (const relative of versionGroupFiles) {
    const filePath = path.join(projectRoot, relative);
    assert.ok(fs.existsSync(filePath), `版本组文件缺失：${relative}`);
    const parsed = readJson(projectRoot, relative);
    if (relative.endsWith("package-lock.json")) {
      assert.ok(parsed && typeof parsed === "object", `${relative} 必须是对象`);
      sources.push({ file: `${relative} (root)`, value: String(parsed.version || "") });
      const rootPackage = parsed.packages && parsed.packages[""];
      assert.ok(rootPackage, `${relative} 缺少 packages[""]`);
      sources.push({ file: `${relative} (packages[""])`, value: String(rootPackage.version || "") });
    } else {
      sources.push({ file: relative, value: String(parsed.version || "") });
    }
  }
  return { config, configVersion, marker: markerMatch[1], sources };
}

function loadPage(projectRoot) {
  const pagePath = require.resolve(path.join(projectRoot, "pages", "user-center", "user-center.js"));
  const oldPage = global.Page;
  let definition;
  delete require.cache[pagePath];
  try {
    global.Page = (value) => {
      definition = value;
    };
    require(pagePath);
  } finally {
    global.Page = oldPage;
  }
  assert.ok(definition, "用户中心必须注册 Page");
  return definition;
}

function main() {
  const { projectRoot, expectedVersion } = parseArgs();
  assert.ok(fs.existsSync(projectRoot), `项目目录不存在：${projectRoot}`);
  const js = read(projectRoot, "pages/user-center/user-center.js");
  const wxml = read(projectRoot, "pages/user-center/user-center.wxml");
  const wxss = read(projectRoot, "pages/user-center/user-center.wxss");
  const workbenchJs = read(projectRoot, "pages/workbench/workbench.js");
  const workbenchWxml = read(projectRoot, "pages/workbench/workbench.wxml");
  const { configVersion, marker, sources } = collectVersionSources(projectRoot);

  assert.ok(js.includes('require("../../config")'), "用户中心必须读取包配置");
  assert.ok(js.includes("loadedAppVersion"), "用户中心必须提供已加载版本字段");
  assert.ok(wxml.includes('class="loaded-version"'), "用户中心必须渲染版本标记");
  assert.ok(wxml.includes("已加载版本 {{loadedAppVersion}}"), "版本标记必须绑定运行时字段");
  assert.ok(wxss.includes(".loaded-version"), "版本标记必须有独立样式");
  assert.ok(workbenchJs.includes("appVersion: config.appVersion"), "工作台版本必须读取包配置");
  assert.ok(workbenchWxml.includes("已加载版本 {{appVersion}}"), "工作台必须明确显示已加载版本");
  assert.ok(!workbenchWxml.includes("<view>版本 {{appVersion}}"), "工作台不得继续使用旧版本文案");

  if (expectedVersion) {
    assertSemver(expectedVersion, "指定版本");
    assert.strictEqual(configVersion, expectedVersion, `当前包版本不是指定版本：${expectedVersion}`);
  }
  for (const source of sources) {
    assert.strictEqual(source.value, configVersion, `${source.file} 与 config.appVersion 不一致：${source.value}`);
  }
  assert.strictEqual(
    marker,
    `API_BUILD_TAG_AUTO_VERSION_V${configVersion.replace(/\./g, "")}`,
    "API_BUILD_MARKER 必须绑定当前版本"
  );

  const page = loadPage(projectRoot);
  assert.strictEqual(
    page.data.loadedAppVersion,
    configVersion,
    "页面显示的版本必须来自当前包 config.appVersion"
  );
  assert.notStrictEqual(page.data.loadedAppVersion, "0.57.135", "不能继续显示旧包版本");
  console.log(`user center version smoke: OK (${configVersion}) root=${projectRoot}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
