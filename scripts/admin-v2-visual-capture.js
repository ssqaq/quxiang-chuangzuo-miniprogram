/* eslint-disable no-console */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");

const VIEWPORT = Object.freeze({ width: 390, height: 844 });
const DEFAULT_STATE_ID = "collapsed-default-v1";
const STATE_TARGETS = Object.freeze({
  "collapsed-default-v1": Object.freeze(["dashboard", "operations", "config", "provider"]),
  "expanded-v1": Object.freeze(["config"]),
  "backup-disabled-v1": Object.freeze(["config"]),
  "video-mode-v1": Object.freeze(["config"])
});
const STATE_IDS = Object.freeze(Object.keys(STATE_TARGETS));
const PAGE_TARGETS = Object.freeze([
  Object.freeze({ name: "dashboard", pathPart: "pages/admin-dashboard/admin-dashboard", selector: ".dashboard-page" }),
  Object.freeze({ name: "operations", pathPart: "pages/admin-operations/admin-operations", selector: ".operations-page" }),
  Object.freeze({ name: "config", pathPart: "pages/admin-config/admin-config", selector: ".config-page" }),
  Object.freeze({ name: "provider", pathPart: "pages/admin-provider/admin-provider", selector: ".provider-page" })
]);

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function automatorCandidates() {
  return [
    process.env.MINIPROGRAM_AUTOMATOR_PATH,
    path.resolve(__dirname, "..", "..", "_tools", "miniprogram-automator", "node_modules", "miniprogram-automator"),
    path.resolve(__dirname, "..", "..", "_tools", "wechat-automator", "node_modules", "miniprogram-automator")
  ].filter(Boolean);
}

function loadAutomator() {
  for (const candidate of automatorCandidates()) {
    try { return require(candidate); } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("找不到 miniprogram-automator，请设置 MINIPROGRAM_AUTOMATOR_PATH。");
}

function parseArgs(argv) {
  const options = {
    project: process.env.MINIPROGRAM_PROJECT_PATH || path.resolve(__dirname, ".."),
    cli: process.env.WECHAT_DEVTOOLS_CLI || "",
    output: path.resolve(__dirname, "..", "visual-evidence", "captured"),
    demo: true,
    fixtureId: process.env.ADMIN_PREVIEW_FIXTURE_ID || "admin-v2-reference-20260901-v1",
    connectPort: Number(process.env.MINIPROGRAM_AUTOMATOR_PORT || 0),
    states: [DEFAULT_STATE_ID]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") options.project = argv[++index] || options.project;
    else if (token === "--cli") options.cli = argv[++index] || options.cli;
    else if (token === "--output") options.output = argv[++index] || options.output;
    else if (token === "--connect-port") options.connectPort = Number(argv[++index] || 0);
    else if (token === "--no-demo") options.demo = false;
    else if (token === "--fixture-id") options.fixtureId = argv[++index] || options.fixtureId;
    else if (token === "--state") options.states = [argv[++index] || DEFAULT_STATE_ID];
    else if (token === "--all-states") options.states = STATE_IDS.slice();
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  options.states.forEach(stateId => {
    if (!STATE_TARGETS[stateId]) throw new Error(`未知视觉状态：${stateId}`);
  });
  return options;
}

function routeFor(target, options, stateId) {
  const common = options.demo
    ? `demo=1&fixture=${encodeURIComponent(options.fixtureId)}&visualState=${encodeURIComponent(stateId)}`
    : "";
  if (target.name === "operations") return `/pages/admin-operations/admin-operations?view=usage${common ? `&${common}` : ""}`;
  if (target.name === "config") return `/pages/admin-config/admin-config?${common || "group=standard&tab=face"}`;
  return `/${target.pathPart}${common ? `?${common}` : ""}`;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForTargetPage(miniProgram, target, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastPath = "";
  while (Date.now() < deadline) {
    const page = await miniProgram.currentPage();
    lastPath = page && page.path ? page.path : "";
    if (page && lastPath.includes(target.pathPart)) {
      try {
        await page.waitFor(target.selector);
        return page;
      } catch (error) {
        // 路由已出现但 WXML 还在重建，继续轮询。
      }
    }
    await sleep(250);
  }
  throw new Error(`页面未在 ${timeout}ms 内稳定：${target.pathPart}，当前路径：${lastPath || "未知"}`);
}

async function readDimensions(miniProgram, route) {
  if (typeof miniProgram.evaluate === "function") {
    return miniProgram.evaluate(() => {
      const info = wx.getSystemInfoSync();
      const pages = getCurrentPages();
      return {
        windowWidth: info.windowWidth,
        windowHeight: info.windowHeight,
        path: pages.length ? pages[pages.length - 1].route : ""
      };
    });
  }
  if (typeof miniProgram.systemInfo === "function") {
    const info = await miniProgram.systemInfo();
    return { windowWidth: info.windowWidth, windowHeight: info.windowHeight, path: route };
  }
  return { path: route };
}

async function capture(options) {
  const automator = loadAutomator();
  const cliPath = options.cli || "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat";
  if (!options.connectPort && !fs.existsSync(cliPath)) throw new Error(`微信开发者工具 CLI 不存在：${cliPath}`);
  if (!fs.existsSync(options.project)) throw new Error(`小程序项目不存在：${options.project}`);
  fs.mkdirSync(options.output, { recursive: true });
  const miniProgram = options.connectPort
    ? await automator.connect({ wsEndpoint: `ws://127.0.0.1:${options.connectPort}` })
    : await automator.launch({ cliPath, projectPath: path.resolve(options.project), trustProject: true, timeout: 60000, port: 9437 });
  const states = Array.isArray(options.states) && options.states.length ? options.states : [DEFAULT_STATE_ID];
  const captures = [];
  try {
    for (const stateId of states) {
      const pages = PAGE_TARGETS.filter(item => STATE_TARGETS[stateId].includes(item.name));
      for (const item of pages) {
        const route = routeFor(item, options, stateId);
        await miniProgram.reLaunch(route);
        await waitForTargetPage(miniProgram, item);
        await sleep(350);
        const outputDir = states.length === 1 && stateId === DEFAULT_STATE_ID ? options.output : path.join(options.output, stateId);
        fs.mkdirSync(outputDir, { recursive: true });
        const output = path.join(outputDir, `${item.name}-390x844.png`);
        await miniProgram.screenshot({ path: output });
        const dimensions = await readDimensions(miniProgram, route);
        const image = regression.decodeImage(output);
        captures.push({
          stateId,
          name: item.name,
          route,
          output,
          dimensions,
          image: { width: image.width, height: image.height },
          bytes: fs.statSync(output).size,
          sha256: sha256(output),
          fixtureId: options.fixtureId
        });
      }
    }
  } finally {
    await Promise.resolve(miniProgram.disconnect());
  }
  const manifest = {
    schemaVersion: 1,
    fixtureId: options.fixtureId,
    renderer: "wechat-devtools-simulator",
    viewport: VIEWPORT,
    states,
    captures,
    capturedAt: new Date().toISOString()
  };
  const manifestPath = path.join(options.output, "capture-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  manifest.manifestPath = manifestPath;
  return manifest;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-visual-capture.js [--project <路径>] [--cli <cli.bat>] [--output <目录>] [--connect-port <端口>] [--fixture-id <ID>] [--state <ID>|--all-states] [--no-demo]");
    return 0;
  }
  const result = await capture(options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`四页截图失败：${error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { VIEWPORT, DEFAULT_STATE_ID, STATE_TARGETS, STATE_IDS, PAGE_TARGETS, sha256, automatorCandidates, routeFor, capture, loadAutomator, main, parseArgs };
