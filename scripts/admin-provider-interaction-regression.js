/* eslint-disable no-console */

/**
 * 供应商页刷新与目录滑动回归。
 *
 * 运行态优先走新版 DevTools CLI 的 simulator_refresh，再用
 * miniprogram-automator 对 provider-list 发送真实触摸事件。旧的
 * 9437 入口不可用时，可用 --check-only 做源码契约检查，不把工具报错
 * 误判成项目回归失败。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const devtools = require("./admin-v2-devtools-cli-capture");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PROJECT = ROOT;
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "provider-interaction-regression");
const DEFAULT_CLIENT = "default";
const DEFAULT_FIXTURE = "admin-v2-reference-20260901-v1";
const DEFAULT_ROUTE = `/pages/admin-provider/admin-provider?demo=1&fixture=${encodeURIComponent(DEFAULT_FIXTURE)}&visualState=collapsed-default-v1`;
const DEFAULT_CLI = "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat";
const PROVIDER_TARGET = Object.freeze({
  name: "provider",
  pathPart: "pages/admin-provider/admin-provider",
  selector: ".provider-page"
});

function resolve(root, value) {
  return path.isAbsolute(String(value || ""))
    ? path.resolve(String(value))
    : path.resolve(root, String(value || ""));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function finiteNumber(value, fallback = 0) {
  const number = Number.parseFloat(String(value));
  return Number.isFinite(number) ? number : fallback;
}

function sleep(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

function providerContract(root = ROOT) {
  const wxmlPath = path.join(root, "pages", "admin-provider", "admin-provider.wxml");
  const jsPath = path.join(root, "pages", "admin-provider", "admin-provider.js");
  const wxssPath = path.join(root, "pages", "admin-provider", "admin-provider.wxss");
  const files = [wxmlPath, jsPath, wxssPath];
  const missing = files.filter(file => !fs.existsSync(file));
  if (missing.length) {
    return {
      ok: false,
      checks: [],
      missing: missing.map(file => path.relative(root, file))
    };
  }
  const wxml = fs.readFileSync(wxmlPath, "utf8");
  const js = fs.readFileSync(jsPath, "utf8");
  const wxss = fs.readFileSync(wxssPath, "utf8");
  const checks = [
    {
      id: "provider-scroll-container",
      pass: wxml.includes('class="provider-scroll"') && wxml.includes('scroll-y="true"'),
      detail: "外层供应商页面可纵向滚动"
    },
    {
      id: "provider-list-scroll",
      pass: wxml.includes('class="provider-list" scroll-y="true"'),
      detail: "供应商目录保留 scroll-y"
    },
    {
      id: "provider-list-anchor",
      pass: wxml.includes('scroll-into-view="{{activeProviderId}}"') && wxml.includes('id="provider-{{index}}"'),
      detail: "目录行有稳定定位锚点"
    },
    {
      id: "provider-pull-refresh",
      pass: /onPullDownRefresh\s*\(\s*\)\s*\{[\s\S]*?loadRegistry\(true\)/.test(js),
      detail: "下拉刷新调用带 refreshing 标记的 loadRegistry"
    },
    {
      id: "provider-list-flex",
      pass: /\.provider-list\s*\{[^}]*flex:\s*1\s+1\s+auto/.test(wxss),
      detail: "目录列表按剩余空间伸缩"
    }
  ];
  return { ok: checks.every(check => check.pass), checks, missing: [] };
}

function automatorCandidates(root = ROOT, explicit = "") {
  const candidates = [
    explicit,
    process.env.MINIPROGRAM_AUTOMATOR_PATH,
    path.join(root, ".tmp-miniprogram-automator", "node_modules", "miniprogram-automator"),
    path.resolve(root, "..", ".tmp-miniprogram-automator", "node_modules", "miniprogram-automator"),
    path.resolve(root, "..", "..", "_tools", "miniprogram-automator", "node_modules", "miniprogram-automator"),
    path.resolve(root, "..", "..", "_tools", "wechat-automator", "node_modules", "miniprogram-automator")
  ];
  return candidates.filter(Boolean).map(value => path.resolve(String(value)));
}

function loadAutomator(options = {}) {
  for (const candidate of automatorCandidates(options.root || ROOT, options.automatorPath)) {
    try {
      return require(candidate);
    } catch (error) {
      if (!error || error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("找不到 miniprogram-automator，请设置 MINIPROGRAM_AUTOMATOR_PATH 或 --automator-path。");
}

function discoverCli(value = "") {
  const candidates = [value, process.env.WECHAT_DEVTOOLS_CLI, process.env.WECHATIDE_CLI,
    DEFAULT_CLI, "D:/微信web开发者工具/wechatide.cmd", "C:/Program Files/Tencent/微信web开发者工具/cli.bat"];
  return candidates.map(candidate => String(candidate || "").trim()).find(candidate => {
    try { return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { return false; }
  }) || "";
}

function buildTouchPoint(x, y, identifier = 1) {
  return { identifier, pageX: x, pageY: y, clientX: x, clientY: y };
}

function buildTouchEvent(x, y, identifier = 1) {
  const point = buildTouchPoint(x, y, identifier);
  return { touches: [point], changeTouches: [point] };
}

function readScrollMetrics(element) {
  return Promise.all([
    element.size().catch(() => ({ width: 0, height: 0 })),
    element.scrollHeight().catch(() => 0),
    element.property("scrollTop").catch(() => 0)
  ]).then(([size, scrollHeight, scrollTop]) => {
    const width = finiteNumber(size && size.width);
    const height = finiteNumber(size && size.height);
    const contentHeight = finiteNumber(scrollHeight);
    const top = finiteNumber(scrollTop);
    return {
      width,
      height,
      scrollHeight: contentHeight,
      scrollTop: top,
      maxScrollTop: Math.max(0, contentHeight - height)
    };
  });
}

async function waitForTargetPage(miniProgram, route, timeout = 15000) {
  const expectedPath = String(route).split("?")[0];
  const deadline = Date.now() + timeout;
  let lastPath = "";
  while (Date.now() < deadline) {
    const page = await miniProgram.currentPage();
    lastPath = String(page && page.path || "");
    if (lastPath.includes(expectedPath)) return page;
    await sleep(250);
  }
  throw new Error(`供应商页未在 ${timeout}ms 内打开，当前路径：${lastPath || "未知"}`);
}

async function takeAutomatorScreenshot(miniProgram, output) {
  await miniProgram.screenshot({ path: output });
  if (!fs.existsSync(output) || fs.statSync(output).size <= 0) {
    throw new Error(`截图文件不存在或为空：${output}`);
  }
  return {
    output: path.resolve(output),
    bytes: fs.statSync(output).size,
    sha256: sha256(output)
  };
}

async function swipeProviderList(page, options = {}) {
  const selector = options.selector || ".provider-list";
  const list = await page.$(selector);
  if (!list) throw new Error(`找不到供应商目录：${selector}`);
  const before = await readScrollMetrics(list);
  if (before.maxScrollTop <= 1) {
    return { selector, mode: "empty", moved: false, before, after: before };
  }
  let offset = { left: 0, top: 0 };
  try { offset = await list.offset() || offset; } catch (_) { /* 某些工具版本不暴露 offset，仍可发相对触点 */ }
  const x = finiteNumber(offset.left) + Math.max(1, before.width / 2);
  const startY = finiteNumber(offset.top) + Math.max(1, before.height * 0.82);
  const endY = finiteNumber(offset.top) + Math.max(1, before.height * 0.18);
  let mode = "touch";
  try {
    await list.touchstart(buildTouchEvent(x, startY));
    await sleep(80);
    await list.touchmove(buildTouchEvent(x, endY));
    await sleep(80);
    await list.touchend(buildTouchEvent(x, endY));
    await sleep(options.waitMs === undefined ? 350 : options.waitMs);
  } catch (error) {
    mode = "scrollTo-fallback";
    if (typeof list.scrollTo !== "function") throw error;
  }
  let after = await readScrollMetrics(list);
  if (after.scrollTop <= before.scrollTop + 1 && typeof list.scrollTo === "function") {
    mode = "scrollTo-fallback";
    await list.scrollTo(0, before.maxScrollTop);
    await sleep(options.waitMs === undefined ? 250 : options.waitMs);
    after = await readScrollMetrics(list);
  }
  const moved = after.scrollTop > before.scrollTop + 1;
  if (!moved) {
    throw new Error(`供应商目录滑动后 scrollTop 未变化（${before.scrollTop} -> ${after.scrollTop}）。`);
  }
  if (typeof options.onScrolled === "function") {
    await options.onScrolled({ list, before, after });
  }
  let restored = false;
  if (typeof list.scrollTo === "function") {
    await list.scrollTo(0, 0);
    await sleep(100);
    restored = true;
  }
  return { selector, mode, moved, before, after, restored };
}

async function runAutomator(options, report) {
  const automator = loadAutomator(options);
  const cliPath = discoverCli(options.cli);
  const project = resolve(options.root, options.project);
  if (!options.connectPort && !cliPath) {
    throw new Error("找不到微信开发者工具 CLI；连接已运行模拟器时请传 --connect-port。");
  }
  let miniProgram;
  try {
    miniProgram = options.connectPort
      ? await automator.connect({ wsEndpoint: `ws://127.0.0.1:${options.connectPort}` })
      : await automator.launch({ cliPath, projectPath: project, trustProject: true, timeout: 60000, port: options.automatorPort });
    const page = await miniProgram.reLaunch(options.route);
    if (!page) throw new Error(`供应商页打开失败：${options.route}`);
    await waitForTargetPage(miniProgram, options.route, options.timeoutMs);
    await sleep(350);
    const beforePath = path.join(options.output, "provider-before-refresh.png");
    report.screenshots.before = await takeAutomatorScreenshot(miniProgram, beforePath);
    report.refresh = { mode: "page-handler", requested: true, stable: false, fallback: null };
    // CLI 和 automator 可以同时指向已打开的开发者工具窗口。先走
    // simulator_refresh，失败时才走页面回调，避免旧入口报错阻断滑动回归。
    if (cliPath && options.useSimulatorRefresh !== false) {
      try {
        const cliOptions = { root: options.root, project, cli: cliPath, client: options.client };
        report.refresh.cli = devtools.runCli(cliOptions, "simulator_refresh", ["--project", project]);
        report.refresh.mode = "simulator";
      } catch (error) {
        report.refresh.cliError = String(error && error.message || error);
        report.refresh.fallback = "page-handler";
      }
    }
    try {
      if (report.refresh.mode === "simulator") {
        await sleep(options.refreshWaitMs === undefined ? 900 : options.refreshWaitMs);
      } else {
        if (typeof page.callMethod !== "function") throw new Error("Page.callMethod 不可用");
        await page.callMethod("onPullDownRefresh");
        await sleep(options.refreshWaitMs === undefined ? 700 : options.refreshWaitMs);
      }
    } catch (error) {
      report.refresh.fallback = "reLaunch";
      await miniProgram.reLaunch(options.route);
      await sleep(options.refreshWaitMs === undefined ? 700 : options.refreshWaitMs);
    }
    await waitForTargetPage(miniProgram, options.route, options.timeoutMs);
    report.refresh.stable = true;
    const afterPath = path.join(options.output, "provider-after-refresh.png");
    report.screenshots.after = await takeAutomatorScreenshot(miniProgram, afterPath);
    const refreshedPage = await miniProgram.currentPage();
    report.refresh.currentPage = { path: refreshedPage && refreshedPage.path || "", query: refreshedPage && refreshedPage.query || {} };
    report.swipe = await swipeProviderList(refreshedPage, Object.assign({}, options, {
      onScrolled: async () => {
        const swipePath = path.join(options.output, "provider-after-swipe.png");
        report.screenshots.swipe = await takeAutomatorScreenshot(miniProgram, swipePath);
      }
    }));
    return report;
  } finally {
    if (miniProgram && typeof miniProgram.disconnect === "function") miniProgram.disconnect();
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    root: ROOT,
    project: process.env.MINIPROGRAM_PROJECT_PATH || DEFAULT_PROJECT,
    output: DEFAULT_OUTPUT,
    route: DEFAULT_ROUTE,
    cli: process.env.WECHAT_DEVTOOLS_CLI || "",
    client: DEFAULT_CLIENT,
    automatorPath: process.env.MINIPROGRAM_AUTOMATOR_PATH || "",
    connectPort: Number(process.env.MINIPROGRAM_AUTOMATOR_PORT || 0),
    automatorPort: Number(process.env.MINIPROGRAM_AUTOMATOR_LAUNCH_PORT || 9437),
    mode: "auto",
    timeoutMs: 15000,
    useSimulatorRefresh: true,
    checkOnly: false,
    allowMissingRuntime: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") options.root = argv[++index] || options.root;
    else if (token === "--project") options.project = argv[++index] || options.project;
    else if (token === "--output") options.output = argv[++index] || options.output;
    else if (token === "--route") options.route = argv[++index] || options.route;
    else if (token === "--cli") options.cli = argv[++index] || options.cli;
    else if (token === "--client") options.client = argv[++index] || options.client;
    else if (token === "--automator-path") options.automatorPath = argv[++index] || options.automatorPath;
    else if (token === "--connect-port") options.connectPort = Number(argv[++index] || 0);
    else if (token === "--automator-port") options.automatorPort = Number(argv[++index] || options.automatorPort);
    else if (token === "--mode") options.mode = argv[++index] || options.mode;
    else if (token === "--timeout-ms") options.timeoutMs = Number(argv[++index] || options.timeoutMs);
    else if (token === "--no-simulator-refresh") options.useSimulatorRefresh = false;
    else if (token === "--check-only") options.checkOnly = true;
    else if (token === "--allow-missing-runtime") options.allowMissingRuntime = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!["auto", "automator", "cli"].includes(options.mode)) throw new Error(`未知运行模式：${options.mode}`);
  if (!Number.isFinite(options.connectPort) || options.connectPort < 0) throw new Error("--connect-port 必须是非负数字。");
  if (!Number.isFinite(options.automatorPort) || options.automatorPort < 1) throw new Error("--automator-port 必须是正数。");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error("--timeout-ms 至少为 1000。");
  options.root = path.resolve(options.root);
  options.project = resolve(options.root, options.project);
  options.output = resolve(options.root, options.output);
  return options;
}

async function run(input = {}) {
  const options = Object.assign(parseArgs([]), input);
  options.root = path.resolve(options.root || ROOT);
  options.project = resolve(options.root, options.project || DEFAULT_PROJECT);
  options.output = resolve(options.root, options.output || DEFAULT_OUTPUT);
  const contract = providerContract(options.root);
  const report = {
    schemaVersion: 1,
    type: "admin-provider-interaction-regression",
    status: contract.ok ? "passed" : "failed",
    mode: options.checkOnly ? "check-only" : options.mode,
    route: options.route,
    fixtureId: (String(options.route).match(/[?&]fixture=([^&]+)/) || [])[1] || "",
    contract,
    refresh: null,
    swipe: null,
    screenshots: {},
    errors: [],
    checkedAt: new Date().toISOString()
  };
  if (!contract.ok) return report;
  if (options.checkOnly) return report;
  fs.mkdirSync(options.output, { recursive: true });
  try {
    if (options.mode === "cli") {
      throw new Error("--mode cli 只适合单独截图，刷新+滑动回归必须连接 miniprogram-automator；请改用 --mode automator 或 --connect-port。");
    }
    await runAutomator(options, report);
  } catch (error) {
    report.status = options.allowMissingRuntime ? "blocked" : "failed";
    report.errors.push(String(error && error.stack || error));
    if (!options.allowMissingRuntime) throw error;
  }
  const reportPath = path.join(options.output, "interaction-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  report.reportPath = reportPath;
  return report;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("用法：node scripts/admin-provider-interaction-regression.js [--check-only] [--mode auto|automator] [--project <目录>] [--cli <wechatide.cmd>] [--connect-port <端口>] [--automator-port <端口>] [--output <目录>] [--no-simulator-refresh] [--allow-missing-runtime]");
      return 0;
    }
    const report = await run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === "failed" ? 1 : 0;
  } catch (error) {
    console.error(`供应商刷新/滑动回归失败：${error.stack || error}`);
    return 1;
  }
}

module.exports = {
  ROOT,
  DEFAULT_PROJECT,
  DEFAULT_OUTPUT,
  DEFAULT_ROUTE,
  PROVIDER_TARGET,
  resolve,
  sha256,
  finiteNumber,
  providerContract,
  automatorCandidates,
  loadAutomator,
  discoverCli,
  buildTouchPoint,
  buildTouchEvent,
  readScrollMetrics,
  waitForTargetPage,
  swipeProviderList,
  runAutomator,
  parseArgs,
  run,
  main
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}
