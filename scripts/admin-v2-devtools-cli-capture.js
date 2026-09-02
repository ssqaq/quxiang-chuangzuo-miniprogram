/* eslint-disable no-console */

/**
 * 使用新版微信开发者工具 skill CLI 做真实四页截图。
 *
 * 这个入口不依赖旧版 miniprogram-automator/9437 WebSocket 协议。
 * CLI 只能读取当前模拟器尺寸，不能在命令行切换设备；因此 manifest
 * 同时记录 runtime viewport 和截图文件实际像素，避免把两者混为一谈。
 */

const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const regression = require("./admin-v2-pixel-regression");
const capture = require("./admin-v2-visual-capture");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CLI = "D:/微信web开发者工具/wechatide.cmd";
const DEFAULT_CLIENT = "default";
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "devtools-cli-capture");
const FIXTURE_ID = "admin-v2-reference-20260901-v1";

function resolve(root, value) {
  return path.isAbsolute(String(value || ""))
    ? path.resolve(String(value))
    : path.resolve(root, String(value || ""));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function existingFile(value) {
  const candidate = String(value || "").trim();
  return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? path.resolve(candidate)
    : "";
}

function discoverCli(value) {
  const candidates = [value, process.env.WECHAT_DEVTOOLS_CLI, process.env.WECHATIDE_CLI, DEFAULT_CLI,
    "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"];
  return candidates.map(existingFile).find(Boolean) || "";
}

function parseJsonEnvelope(stdout, operation) {
  const text = String(stdout || "").trim();
  const candidates = [];
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "{") continue;
    candidates.push(text.slice(index));
  }
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate);
      if (envelope && typeof envelope === "object" && Object.prototype.hasOwnProperty.call(envelope, "ok")) {
        if (!envelope.ok) {
          const error = new Error(`${operation} 失败：${envelope.message || envelope.error || envelope.errorType || "CLI 返回 ok=false"}`);
          error.code = "DEVTOOLS_CLI_OPERATION_FAILED";
          error.envelope = envelope;
          throw error;
        }
        return envelope;
      }
    } catch (error) {
      if (error && error.code === "DEVTOOLS_CLI_OPERATION_FAILED") throw error;
    }
  }
  const error = new Error(`${operation} 没有返回可解析的 CLI JSON。`);
  error.code = "DEVTOOLS_CLI_INVALID_JSON";
  error.stdout = text.slice(-2000);
  throw error;
}

function quoteWindowsArg(value) {
  const text = String(value === undefined || value === null ? "" : value);
  // spawnSync(.cmd, ..., { shell: true }) 由 cmd.exe 解析；双引号包住
  // 每个参数即可保留 query 中的 &、空格和中文路径。
  return `"${text.replace(/"/g, '""')}"`;
}

function runCli(options, tool, extraArgs) {
  const args = ["-c", options.client, tool, ...extraArgs];
  const command = [options.cli, ...args].map(quoteWindowsArg).join(" ");
  const result = childProcess.spawnSync(command, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    shell: true
  });
  if (result.error) throw result.error;
  try {
    return parseJsonEnvelope(result.stdout, tool);
  } catch (stdoutError) {
    try {
      return parseJsonEnvelope(result.stderr, tool);
    } catch (stderrError) {
      const error = new Error(`${tool} CLI 输出无法解析：${stdoutError.message}`);
      error.code = "DEVTOOLS_CLI_INVALID_JSON";
      error.stdout = String(result.stdout || "").slice(-2000);
      error.stderr = String(result.stderr || "").slice(-2000);
      throw error;
    }
  }
}

function runtimeInfo(options) {
  const envelope = runCli(options, "automation_runtime_info", [
    "--project", options.project,
    "--action", "systemInfo"
  ]);
  const result = envelope.result || {};
  const systemInfo = result.systemInfo && result.systemInfo.result
    ? result.systemInfo.result
    : (result.systemInfo || result);
  if (!systemInfo || !Number(systemInfo.windowWidth) || !Number(systemInfo.windowHeight)) {
    throw new Error("DevTools systemInfo 缺少 windowWidth/windowHeight。");
  }
  return {
    model: String(systemInfo.model || ""),
    windowWidth: Number(systemInfo.windowWidth),
    windowHeight: Number(systemInfo.windowHeight),
    screenWidth: Number(systemInfo.screenWidth || 0),
    screenHeight: Number(systemInfo.screenHeight || 0),
    pixelRatio: Number(systemInfo.pixelRatio || systemInfo.devicePixelRatio || 0),
    sdkVersion: String(systemInfo.SDKVersion || "")
  };
}

function openProject(options) {
  const envelope = runCli(options, "open_project_window", [
    "--project", options.project,
    "--window-mode", "liteMode"
  ]);
  const result = envelope.result || {};
  if (!result.success) throw new Error("DevTools 项目窗口未成功打开。");
  return result;
}

function openPage(options, target, route) {
  const query = route.includes("?") ? route.slice(route.indexOf("?") + 1) : "";
  const args = ["--project", options.project, "--page", target.pathPart];
  if (query) args.push("--query", query);
  runCli(options, "simulator_open_page", args);
}

function currentPage(options) {
  const envelope = runCli(options, "automation_runtime_info", [
    "--project", options.project,
    "--action", "currentPage"
  ]);
  const result = envelope.result || {};
  return result.currentPage || (result.result && result.result.currentPage) || {};
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function waitForPage(options, target, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastPath = "";
  while (Date.now() < deadline) {
    const page = currentPage(options);
    lastPath = String(page.path || page.route || "");
    if (lastPath.includes(target.pathPart)) return page;
    sleepSync(250);
  }
  throw new Error(`页面未在 ${timeout}ms 内打开：${target.pathPart}，当前路径：${lastPath || "未知"}`);
}

function screenshot(options, output, selector) {
  const args = ["--project", options.project, "--path", output, "--wait", "2", "--optimize", "false"];
  const envelope = runCli(options, "simulator_screenshot", args);
  const result = envelope.result || {};
  if (!result.success || !result.path) throw new Error("DevTools 截图结果无效。");
  const actualPath = path.resolve(String(result.path));
  if (!fs.existsSync(actualPath) || fs.statSync(actualPath).size <= 0) throw new Error(`截图文件不存在或为空：${actualPath}`);
  const image = regression.decodeImage(actualPath);
  return {
    output: actualPath,
    image: { width: image.width, height: image.height },
    bytes: fs.statSync(actualPath).size,
    sha256: sha256(actualPath),
    cliDimensions: {
      width: Number(result.imageWidth || image.width),
      height: Number(result.imageHeight || image.height)
    }
  };
}

function routeFor(target, stateId) {
  const common = `demo=1&fixture=${encodeURIComponent(FIXTURE_ID)}&visualState=${encodeURIComponent(stateId)}`;
  if (target.name === "operations") return `/pages/admin-operations/admin-operations?view=usage&${common}`;
  if (target.name === "config") return `/pages/admin-config/admin-config?${common}`;
  return `/${target.pathPart}?${common}`;
}

function captureCurrentDevice(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const project = resolve(root, options.project || root);
  const cli = discoverCli(options.cli);
  if (!cli) throw new Error("找不到新版微信开发者工具 CLI，请设置 WECHAT_DEVTOOLS_CLI。");
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error(`小程序项目不存在：${project}`);
  const output = resolve(root, options.output || DEFAULT_OUTPUT);
  fs.mkdirSync(output, { recursive: true });
  const client = String(options.client || DEFAULT_CLIENT);
  const cliOptions = { root, project, cli, client };
  const stateId = String(options.state || capture.DEFAULT_STATE_ID);
  const targets = capture.PAGE_TARGETS.filter(item => (capture.STATE_TARGETS[stateId] || []).includes(item.name));
  if (!targets.length) throw new Error(`未知或没有目标页面的视觉状态：${stateId}`);
  openProject(cliOptions);
  // 新窗口首次打开后 runtime 还未注册，先编译并打开一个目标页再读取 systemInfo。
  openPage(cliOptions, targets[0], routeFor(targets[0], stateId));
  sleepSync(1500);
  const runtime = runtimeInfo(cliOptions);
  const captures = [];
  for (const target of targets) {
    const route = routeFor(target, stateId);
    openPage(cliOptions, target, route);
    const file = path.join(output, `${target.name}-${runtime.windowWidth}x${runtime.windowHeight}.png`);
    const shot = screenshot(cliOptions, file, target.selector);
    captures.push({
      stateId,
      name: target.name,
      route: route.replace(/fixture=[^&]+/g, `fixture=${FIXTURE_ID}`),
      output: shot.output,
      fixtureId: FIXTURE_ID,
      runtime,
      image: shot.image,
      cliDimensions: shot.cliDimensions,
      bytes: shot.bytes,
      sha256: shot.sha256
    });
  }
  const manifest = {
    schemaVersion: 1,
    fixtureId: FIXTURE_ID,
    renderer: "wechat-devtools-skill-cli",
    captureStatus: "captured",
    state: stateId,
    viewport: { width: runtime.windowWidth, height: runtime.windowHeight, contractWidth: 390, contractHeight: 844 },
    dpr: 1,
    scroll: { x: 0, y: 0 },
    fontProfile: "admin-reference-font-v1",
    captureContract: { viewport: { width: 390, height: 844 }, dpr: 1, scroll: { x: 0, y: 0 }, fixtureId: FIXTURE_ID },
    runtime,
    captures,
    capturedAt: new Date().toISOString()
  };
  const manifestPath = path.join(output, "capture-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  manifest.manifestPath = manifestPath;
  return manifest;
}

function parseArgs(argv) {
  const result = { root: ROOT, project: ROOT, output: DEFAULT_OUTPUT, client: DEFAULT_CLIENT, state: capture.DEFAULT_STATE_ID };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root") result.root = argv[++index] || result.root;
    else if (token === "--project") result.project = argv[++index] || result.project;
    else if (token === "--cli") result.cli = argv[++index] || result.cli;
    else if (token === "--client") result.client = argv[++index] || result.client;
    else if (token === "--output") result.output = argv[++index] || result.output;
    else if (token === "--state") result.state = argv[++index] || result.state;
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (!capture.STATE_TARGETS[result.state]) throw new Error(`未知视觉状态：${result.state}`);
  return result;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("用法：node scripts/admin-v2-devtools-cli-capture.js [--project <目录>] [--cli <wechatide.cmd>] [--client <名称>] [--output <目录>] [--state <状态>]");
      return 0;
    }
    const manifest = captureCurrentDevice(options);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`新版 DevTools 截图失败：${error.stack || error}`);
    return 1;
  }
}

module.exports = { ROOT, DEFAULT_CLI, DEFAULT_CLIENT, DEFAULT_OUTPUT, FIXTURE_ID, resolve, sha256, discoverCli, parseJsonEnvelope, quoteWindowsArg, runCli, runtimeInfo, openProject, openPage, currentPage, waitForPage, screenshot, routeFor, captureCurrentDevice, parseArgs, main, PAGE_TARGETS: capture.PAGE_TARGETS, STATE_TARGETS: capture.STATE_TARGETS };

if (require.main === module) process.exitCode = main();
