/* eslint-disable no-console */

// 本地/发布前截图工具。微信开发者工具本身不在 GitHub runner 中安装，
// 因此 CI 校验已提交的截图和来源指纹；本脚本用于在同一 renderer 下更新
// 四页截图，再由 pixel baseline 门禁验收。
const fs = require("fs");
const path = require("path");

function loadAutomator() {
  const candidates = [
    process.env.MINIPROGRAM_AUTOMATOR_PATH,
    path.resolve(__dirname, "..", "..", "_tools", "miniprogram-automator", "node_modules", "miniprogram-automator"),
    path.resolve(__dirname, "..", "..", "_tools", "wechat-automator", "node_modules", "miniprogram-automator"),
  ].filter(Boolean);
  for (const candidate of candidates) {
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
    connectPort: Number(process.env.MINIPROGRAM_AUTOMATOR_PORT || 0),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") options.project = argv[++index] || options.project;
    else if (token === "--cli") options.cli = argv[++index] || options.cli;
    else if (token === "--output") options.output = argv[++index] || options.output;
    else if (token === "--connect-port") options.connectPort = Number(argv[++index] || 0);
    else if (token === "--no-demo") options.demo = false;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  return options;
}

function query(options) { return options.demo ? "?demo=1" : ""; }

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
        // The route exists while WXML is still being rebuilt; keep polling.
      }
    }
    await sleep(250);
  }
  throw new Error(`页面未在 ${timeout}ms 内稳定：${target.pathPart}，当前路径：${lastPath || "未知"}`);
}

async function capture(options) {
  const automator = loadAutomator();
  const cliPath = options.cli || "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat";
  if (!options.connectPort && !fs.existsSync(cliPath)) throw new Error(`微信开发者工具 CLI 不存在：${cliPath}`);
  if (!fs.existsSync(options.project)) throw new Error(`小程序项目不存在：${options.project}`);
  fs.mkdirSync(options.output, { recursive: true });
  const miniProgram = options.connectPort
    ? await automator.connect({ wsEndpoint: `ws://127.0.0.1:${options.connectPort}` })
    : await automator.launch({
      cliPath,
      projectPath: path.resolve(options.project),
      trustProject: true,
      timeout: 60000,
      port: 9437,
    });
  const pages = [
    { name: "dashboard", route: `/pages/admin-dashboard/admin-dashboard${query(options)}`, pathPart: "pages/admin-dashboard/admin-dashboard", selector: ".dashboard-page" },
    { name: "operations", route: `/pages/admin-operations/admin-operations?view=usage${options.demo ? "&demo=1" : ""}`, pathPart: "pages/admin-operations/admin-operations", selector: ".operations-page" },
    { name: "config", route: `/pages/admin-config/admin-config?group=standard&tab=face${options.demo ? "&demo=1" : ""}`, pathPart: "pages/admin-config/admin-config", selector: ".config-page" },
    { name: "provider", route: `/pages/admin-provider/admin-provider${query(options)}`, pathPart: "pages/admin-provider/admin-provider", selector: ".provider-page" },
  ];
  const result = [];
  try {
    for (const item of pages) {
      await miniProgram.reLaunch(item.route);
      const page = await waitForTargetPage(miniProgram, item);
      await sleep(300);
      const output = path.join(options.output, `${item.name}-390x844.png`);
      await miniProgram.screenshot({ path: output });
      // miniprogram-automator exposes evaluate on the program, not on Page.
      // Keep the route from the requested target and use the public systemInfo
      // method when the connected DevTools build does not support evaluation.
      let dimensions = {};
      if (typeof miniProgram.evaluate === "function") {
        dimensions = await miniProgram.evaluate(() => {
          const info = wx.getSystemInfoSync();
          const pages = getCurrentPages();
          return {
            windowWidth: info.windowWidth,
            windowHeight: info.windowHeight,
            path: pages.length ? pages[pages.length - 1].route : ""
          };
        });
      } else if (typeof miniProgram.systemInfo === "function") {
        const info = await miniProgram.systemInfo();
        dimensions = { windowWidth: info.windowWidth, windowHeight: info.windowHeight, path: item.route };
      } else {
        dimensions = { path: item.route };
      }
      result.push({ name: item.name, route: item.route, output, dimensions });
    }
  } finally {
    miniProgram.disconnect();
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("用法：node scripts/admin-v2-visual-capture.js [--project <路径>] [--cli <cli.bat>] [--output <目录>] [--connect-port <端口>] [--no-demo]");
    return 0;
  }
  const result = await capture(options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`四页截图失败：${error.stack || error}`);
    process.exitCode = 1;
  });
}

module.exports = { capture, loadAutomator, main, parseArgs };
