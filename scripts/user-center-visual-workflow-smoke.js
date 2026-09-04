/* eslint-disable no-console */

// This is a dependency-free contract check for the visual workflow.  It is
// intentionally text based so a fresh CI runner can validate the safety
// boundary before installing preview dependencies.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "user-center-visual-regression.yml");
const visualConfigPath = path.join(root, "docs", "superpowers", "visual-baselines", "user-center-regression.config.json");
const previewPackagePath = path.join(root, "tools", "user-center-preview", "package.json");
const previewLockPath = path.join(root, "tools", "user-center-preview", "package-lock.json");

function readWorkflow() {
  assert.ok(fs.existsSync(workflowPath), `找不到视觉 workflow：${workflowPath}`);
  const raw = fs.readFileSync(workflowPath, "utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  assert.strictEqual(text.includes("\ufeff"), false, "workflow 含有函数体内 BOM");
  return text.replace(/\r\n/g, "\n");
}

function mustContain(text, marker, label) {
  assert.ok(text.includes(marker), `${label}缺少：${marker}`);
}

function mustMatch(text, expression, label) {
  assert.ok(expression.test(text), `${label}不符合预期：${expression}`);
}

function assertNoUnsafePublish(text) {
  for (const marker of [
    "release.ps1 -Publish",
    "-DeployCloud",
    "git push",
    "npm publish",
    "cloudbase functions:deploy",
    "cloudfunctions/payment-api",
    "wx.requestPayment",
    "PAYMENT_API_SECRET",
    "continue-on-error: true"
  ]) {
    assert.strictEqual(text.includes(marker), false, `视觉 workflow 不得包含危险动作：${marker}`);
  }
}

function testWorkflow(text) {
  assert.ok(fs.existsSync(visualConfigPath), `找不到视觉比较配置：${visualConfigPath}`);
  assert.ok(fs.existsSync(previewPackagePath), `找不到版本化预览 package.json：${previewPackagePath}`);
  assert.ok(fs.existsSync(previewLockPath), `找不到版本化预览 package-lock.json：${previewLockPath}`);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(visualConfigPath, "utf8"));
  } catch (error) {
    throw new Error(`视觉比较配置不是有效 JSON：${error.message}`);
  }
  assert.strictEqual(config.canvas && config.canvas.width, 338, "视觉比较画布宽度必须冻结为 338");
  assert.strictEqual(config.canvas && config.canvas.height, 654, "视觉比较画布高度必须冻结为 654");
  assert.deepStrictEqual(
    (config.pages || []).map((item) => item.id).sort(),
    ["recharge", "records", "user-center"],
    "视觉比较配置必须覆盖三页"
  );
  mustMatch(text, /^name:\s*user-center-visual-regression\s*$/m, "workflow 名称");
  mustMatch(text, /^  pull_request:\s*$/m, "PR 触发器");
  mustMatch(text, /^  workflow_dispatch:\s*$/m, "手动触发器");
  assert.strictEqual(/^  push\s*:/m.test(text), false, "视觉回归不得由 push 直接触发");
  mustContain(text, "permissions:\n  contents: read", "最小权限");
  mustContain(text, "cancel-in-progress: false", "并发不取消策略");

  for (const job of [
    "browser-design-regression:",
    "devtools-regression:",
    "g3-device-gate:",
    "release-package-audit:"
  ]) mustContain(text, `  ${job}`, "四段视觉闸门");

  mustContain(text, "runs-on: windows-latest", "浏览器 hosted runner");
  mustMatch(
    text,
    /runs-on:\s*\[self-hosted,\s*Windows,\s*X64,\s*wechat-devtools\]/,
    "DevTools self-hosted runner 标签"
  );
  mustMatch(
    text,
    /runs-on:\s*\[self-hosted,\s*Windows,\s*X64,\s*wechat-g3-devices\]/,
    "G3 真机 runner 标签"
  );

  for (const marker of [
    "tools/user-center-preview",
    "npm ci --prefix",
    "node scripts/user-center-responsive-capture.js",
    "node scripts/user-center-visual-diff.js --config",
    "SHARP_MODULE",
    "BROWSER_EXECUTABLE",
    "actions/upload-artifact@v4",
    "browser-candidate",
    "browser-report",
    "candidateManifest.sha256"
  ]) mustContain(text, marker, "浏览器真实截图链路");
  assert.ok(
    (text.match(/npm ci --prefix/g) || []).length >= 2,
    "browser 和 DevTools job 都必须安装冻结的视觉比较依赖"
  );
  assert.ok(
    (text.match(/\$config\.candidateManifest\.path = \$candidateManifest/g) || []).length >= 2,
    "browser 和 DevTools job 都必须把候选 manifest 指向本轮截图"
  );
  assert.ok(
    (text.match(/\$config\.candidateManifest\.sha256 = \(Get-FileHash -LiteralPath \$candidateManifest/g) || []).length >= 2,
    "browser 和 DevTools job 都必须重算本轮候选 manifest SHA256"
  );
  assert.strictEqual(text.includes("${{ env:"), false, "GitHub Actions env 表达式必须使用 env.NAME，不能使用 env:NAME");
  mustContain(text, "浏览器截图缺少候选 manifest", "浏览器 manifest 缺失时失败关闭");
  mustContain(text, "DevTools 截图缺少候选 manifest", "DevTools manifest 缺失时失败关闭");

  mustContain(text, "WECHAT_DEVTOOLS_CAPTURE_SCRIPT", "DevTools 受审计截图脚本");
  mustContain(text, "禁止用浏览器截图冒充 G2", "DevTools 失败关闭策略");
  mustContain(text, "WECHAT_DEVTOOLS_VERSION", "DevTools 版本锁定");
  mustContain(text, "2.02.2608040", "固定 DevTools 版本");
  mustContain(text, "WECHAT_BASE_LIBRARY", "基础库锁定");
  mustContain(text, "3.16.2", "固定基础库版本");

  mustContain(text, "node scripts/user-center-g3-check.js", "G3 设备检查");
  mustContain(text, '$normalized = if ($status.releaseGate -eq "passed") { "passed" } else { "pending" }', "G3 无设备状态归一化");
  mustContain(text, 'g3_status="${G3_STATUS:-pending}"', "无设备 pending 兜底");
  mustContain(text, "G3_STATUS", "生产审计读取 G3 状态");
  mustContain(text, "release_eligible=false", "候选构建默认不可发布");
  mustContain(text, '"releaseEligible": $release_eligible', "releaseEligible 写入");
  mustContain(text, '"g3Status": "$g3_status"', "g3Status 写入");
  mustContain(text, '[[ "$G3_RESULT" == "success" && "$g3_status" == "passed" ]]', "生产发布必须要求 G3 passed");
  mustContain(text, "if: always()", "审计和证据上传不得因前置失败而消失");
  mustContain(text, "needs: [browser-design-regression, devtools-regression, g3-device-gate]", "发布审计依赖完整");
  mustContain(text, "PRODUCTION_GATE", "生产闸门显式开关");
  assertNoUnsafePublish(text);
}

function main() {
  const workflow = readWorkflow();
  testWorkflow(workflow);
  console.log("user-center visual workflow smoke: OK");
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}
