/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const captureTool = require("./admin-v2-visual-capture");
const regression = require("./admin-v2-pixel-regression");

const ROOT = path.resolve(__dirname, "..");
const FIXTURE_ID = "admin-v2-reference-20260901-v1";

function resolve(root, value) {
  return path.isAbsolute(String(value || "")) ? path.resolve(String(value)) : path.resolve(root, String(value || ""));
}

function validateManifest(manifest, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("真实截图 manifest 必须是对象。");
  if (manifest.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
  if (manifest.fixtureId !== FIXTURE_ID) errors.push(`fixtureId 必须为 ${FIXTURE_ID}`);
  if (manifest.renderer !== "wechat-devtools-simulator") errors.push("renderer 必须为 wechat-devtools-simulator");
  if (manifest.captureStatus !== "captured") errors.push("captureStatus 必须为 captured，严格门禁不接受旧截图回退");
  if (Number(manifest.dpr) !== 1) errors.push("dpr 必须为 1");
  if (!manifest.scroll || Number(manifest.scroll.x) !== 0 || Number(manifest.scroll.y) !== 0) errors.push("scroll 必须锁定为 0,0");
  if (manifest.fontProfile !== "admin-reference-font-v1") errors.push("fontProfile 不匹配");
  const states = Array.isArray(manifest.states) ? manifest.states : [];
  const expectedStates = options.allStates ? captureTool.STATE_IDS : [options.state || captureTool.DEFAULT_STATE_ID];
  if (JSON.stringify(states) !== JSON.stringify(expectedStates)) errors.push(`状态必须为 ${expectedStates.join("、")}`);
  const captures = Array.isArray(manifest.captures) ? manifest.captures : [];
  const expected = expectedStates.flatMap(stateId => captureTool.STATE_TARGETS[stateId].map(name => ({ stateId, name })));
  if (captures.length !== expected.length) errors.push(`截图数量必须为 ${expected.length}`);
  const checked = expected.map(contract => {
    const item = captures.find(entry => entry && entry.stateId === contract.stateId && entry.name === contract.name) || {};
    const itemErrors = [];
    const filePath = resolve(root, item.output);
    if (!item.output || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile() || fs.statSync(filePath).size <= 0) itemErrors.push("截图不存在或为空");
    else {
      const image = regression.decodeImage(filePath);
      if (image.width !== captureTool.VIEWPORT.width || image.height !== captureTool.VIEWPORT.height) itemErrors.push(`截图尺寸为 ${image.width}x${image.height}`);
      const actualHash = captureTool.sha256(filePath);
      if (item.sha256 !== actualHash) itemErrors.push("SHA256 不匹配");
      if (Number(item.bytes) !== fs.statSync(filePath).size) itemErrors.push("文件字节数不匹配");
    }
    if (!item.route || !String(item.route).includes(`visualState=${encodeURIComponent(contract.stateId)}`)) itemErrors.push("路由没有锁定 visualState");
    if (item.fixtureId !== FIXTURE_ID) itemErrors.push("截图 fixtureId 不匹配");
    if (item.dimensions && Number(item.dimensions.windowWidth) && Number(item.dimensions.windowWidth) !== captureTool.VIEWPORT.width && Number(item.dimensions.windowWidth) !== 430) itemErrors.push("DevTools windowWidth 不匹配");
    if (item.dimensions && Number(item.dimensions.windowHeight) && Number(item.dimensions.windowHeight) !== captureTool.VIEWPORT.height && Number(item.dimensions.windowHeight) !== 932) itemErrors.push("DevTools windowHeight 不匹配");
    return { stateId: contract.stateId, name: contract.name, output: item.output || "", errors: itemErrors, pass: itemErrors.length === 0 };
  });
  checked.forEach(item => item.errors.forEach(error => errors.push(`${item.stateId}/${item.name}：${error}`)));
  return { schemaVersion: 1, ok: errors.length === 0, status: errors.length ? "fail" : "pass", fixtureId: manifest.fixtureId || null, renderer: manifest.renderer || null, states: expectedStates, captures: checked, errors };
}

async function run(options = {}, dependencies = {}) {
  const root = path.resolve(options.root || ROOT);
  const capture = dependencies.capture || captureTool.capture;
  const captureOptions = {
    project: resolve(root, options.project || root),
    cli: options.cli || process.env.WECHAT_DEVTOOLS_CLI || "",
    output: resolve(root, options.output || path.join("visual-evidence", "ci-capture")),
    fixtureId: FIXTURE_ID,
    demo: true,
    connectPort: Number(options.connectPort || 0),
    states: options.allStates ? captureTool.STATE_IDS.slice() : [options.state || captureTool.DEFAULT_STATE_ID]
  };
  if (!captureOptions.connectPort && (!captureOptions.cli || !fs.existsSync(captureOptions.cli))) throw new Error(`微信开发者工具 CLI 不存在：${captureOptions.cli || "未配置"}`);
  if (!fs.existsSync(captureOptions.project)) throw new Error(`小程序项目不存在：${captureOptions.project}`);
  captureTool.loadAutomator();
  const manifest = await capture(captureOptions);
  const report = validateManifest(manifest, { root, allStates: options.allStates, state: options.state });
  report.manifestPath = manifest.manifestPath;
  report.checkedAt = new Date().toISOString();
  if (!report.ok) throw new Error(`真实截图门禁失败：${report.errors.join("；")}`);
  return report;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") result.help = true;
    else if (token === "--root") result.root = argv[++index];
    else if (token === "--project") result.project = argv[++index];
    else if (token === "--cli") result.cli = argv[++index];
    else if (token === "--output") result.output = argv[++index];
    else if (token === "--connect-port") result.connectPort = Number(argv[++index] || 0);
    else if (token === "--state") result.state = argv[++index];
    else if (token === "--all-states") result.allStates = true;
    else throw new Error(`未知参数：${token}`);
  }
  if (result.state && !captureTool.STATE_TARGETS[result.state]) throw new Error(`未知视觉状态：${result.state}`);
  return result;
}

function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(`真实截图门禁失败：${error.message}`); return 2; }
  if (options.help) { console.log("用法：node scripts/admin-v2-visual-capture-gate.js --cli <CLI> [--output <目录>] [--state <ID>|--all-states]"); return 0; }
  run(options).then(report => { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); process.exitCode = 0; }).catch(error => { console.error(`真实截图门禁失败：${error.stack || error}`); process.exitCode = 1; });
  return undefined;
}
module.exports = { ROOT, FIXTURE_ID, resolve, validateManifest, run, parseArgs, main };
if (require.main === module) main();
