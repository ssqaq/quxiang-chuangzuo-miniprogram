/* eslint-disable no-console */

/**
 * 本地和 self-hosted Windows runner 的统一视觉截图入口。
 *
 * 先做依赖预检，再调用严格截图门禁；缺少微信开发者工具或
 * miniprogram-automator 时明确返回 blocked，不会偷偷复用旧截图。
 */

const fs = require("fs");
const path = require("path");
const capture = require("./admin-v2-visual-capture");
const gate = require("./admin-v2-visual-capture-gate");
const devtoolsCliCapture = require("./admin-v2-devtools-cli-capture");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT, "visual-evidence", "runner-capture");
const DEFAULT_FIXTURE_ID = gate.FIXTURE_ID;

function resolve(value) {
  return path.isAbsolute(String(value || ""))
    ? path.resolve(String(value))
    : path.resolve(ROOT, String(value || ""));
}

function existingFile(value) {
  const candidate = String(value || "").trim();
  return candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? path.resolve(candidate)
    : "";
}

function discoverCli(options = {}) {
  if (options.cli) return existingFile(options.cli);
  const candidates = [
    process.env.WECHAT_DEVTOOLS_CLI,
    process.env.WECHATIDE_CLI,
    "D:/微信web开发者工具/wechatide.cmd",
    "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat",
    "C:/Program Files/Tencent/微信web开发者工具/wechatide.cmd",
  ];
  return candidates.map(existingFile).find(Boolean) || "";
}

function discoverAutomator(options = {}) {
  if (options.automator) {
    try {
      require(options.automator);
      return String(options.automator);
    } catch (error) {
      if (error && error.code === "MODULE_NOT_FOUND") return "";
      throw error;
    }
  }
  const candidates = [process.env.MINIPROGRAM_AUTOMATOR_PATH, ...capture.automatorCandidates()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      require(candidate);
      return String(candidate);
    } catch (error) {
      if (error && error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  return "";
}

function preflight(options = {}) {
  const project = resolve(options.project || ROOT);
  const devtoolsCli = Boolean(options.devtoolsCli);
  const cli = Number(options.connectPort || 0) ? "" : (devtoolsCli ? devtoolsCliCapture.discoverCli(options.cli) : discoverCli(options));
  const automator = devtoolsCli ? "" : discoverAutomator(options);
  const missing = [];
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) missing.push("project");
  if (!Number(options.connectPort || 0) && !cli) missing.push("wechat-devtools-cli");
  if (!devtoolsCli && !automator) missing.push("miniprogram-automator");
  return {
    ok: missing.length === 0,
    status: missing.length ? "blocked" : "ready",
    missing,
    project,
    cli,
    automator,
    devtoolsCli,
    connectPort: Number(options.connectPort || 0),
    output: resolve(options.output || DEFAULT_OUTPUT),
    fixtureId: String(options.fixtureId || DEFAULT_FIXTURE_ID),
    states: options.allStates ? capture.STATE_IDS.slice() : [options.state || capture.DEFAULT_STATE_ID],
  };
}

async function run(options = {}) {
  const check = preflight(options);
  if (!check.ok) {
    const error = new Error(`视觉 runner 依赖未就绪：${check.missing.join("、")}`);
    error.code = "VISUAL_RUNNER_PREREQUISITE_MISSING";
    error.preflight = check;
    throw error;
  }
  if (options.devtoolsCli) {
    const states = options.allStates ? capture.STATE_IDS : [options.state || capture.DEFAULT_STATE_ID];
    const captureReports = states.map(state => devtoolsCliCapture.captureCurrentDevice({
      root: ROOT,
      project: check.project,
      cli: check.cli,
      client: options.client,
      output: states.length === 1 ? check.output : path.join(check.output, state),
      state
    }));
    return { runner: check, status: "captured", ok: true, capture: captureReports.length === 1 ? captureReports[0] : captureReports };
  }
  const report = await gate.run({
    root: ROOT,
    project: check.project,
    cli: check.cli,
    output: check.output,
    fixtureId: check.fixtureId,
    connectPort: check.connectPort,
    allStates: Boolean(options.allStates),
    state: options.state || capture.DEFAULT_STATE_ID,
  });
  return Object.assign({ runner: check }, report);
}

function parseArgs(argv) {
  const result = { project: ROOT, output: DEFAULT_OUTPUT, allStates: true };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") result.project = argv[++index] || result.project;
    else if (token === "--cli") result.cli = argv[++index] || result.cli;
    else if (token === "--automator") result.automator = argv[++index] || result.automator;
    else if (token === "--output") result.output = argv[++index] || result.output;
    else if (token === "--connect-port") result.connectPort = Number(argv[++index] || 0);
    else if (token === "--fixture-id") result.fixtureId = argv[++index] || result.fixtureId;
    else if (token === "--state") { result.state = argv[++index] || capture.DEFAULT_STATE_ID; result.allStates = false; }
    else if (token === "--all-states") result.allStates = true;
    else if (token === "--check-only") result.checkOnly = true;
    else if (token === "--devtools-cli") result.devtoolsCli = true;
    else if (token === "--client") result.client = argv[++index] || result.client;
    else if (token === "--help" || token === "-h") result.help = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (result.state && !capture.STATE_TARGETS[result.state]) throw new Error(`未知视觉状态：${result.state}`);
  return result;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`视觉 runner 参数错误：${error.message}`); return 2; }
  if (options.help) {
    console.log("用法：node scripts/admin-v2-visual-runner.js [--project <目录>] [--cli <wechatide.cmd>] [--automator <模块>] [--output <目录>] [--connect-port <端口>] [--state <状态>|--all-states] [--devtools-cli --client <名称>] [--check-only]");
    return 0;
  }
  try {
    const check = preflight(options);
    if (options.checkOnly) { console.log(JSON.stringify(check, null, 2)); return check.ok ? 0 : 2; }
    const report = await run(options);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    const result = { status: error.code === "VISUAL_RUNNER_PREREQUISITE_MISSING" ? "blocked" : "fail", ok: false, code: error.code || "VISUAL_RUNNER_FAILED", error: error.message || String(error), preflight: error.preflight || null };
    console.error(JSON.stringify(result, null, 2));
    return result.status === "blocked" ? 2 : 1;
  }
}

module.exports = { ROOT, DEFAULT_OUTPUT, DEFAULT_FIXTURE_ID, resolve, discoverCli, discoverAutomator, preflight, run, parseArgs, main };

if (require.main === module) main().then(code => { process.exitCode = code; });
