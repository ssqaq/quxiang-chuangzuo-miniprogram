/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

process.env.WECHAT_MINIAPP_TEST = "1";
const api = require(path.join(
  __dirname,
  "..",
  "cloudfunctions",
  "api",
  "index.js"
));
const safetyPath = path.join(__dirname, "cloud-deploy-safety.ps1");
const safetySource = fs.readFileSync(safetyPath, "utf8");

const localHealth = api.__test.checkRuntimeHealth({}, { OPENID: "ordinary-user" });
assert.strictEqual(localHealth.ok, true);
assert.strictEqual(localHealth.active, true);
assert.strictEqual(localHealth.readOnly, true);
assert.strictEqual(localHealth.dependencies.healthy, true);
assert.ok(localHealth.buildVersion);
assert.ok(localHealth.buildMarker);
assert.ok(localHealth.checkedAt);
const localSerialized = JSON.stringify(localHealth);
[
  "apiKey",
  "secret",
  "password",
  "process.env",
  "node_modules",
  "C:\\",
  "/home/"
].forEach((needle) => {
  assert.ok(!localSerialized.includes(needle), `运行健康结果泄露敏感字段：${needle}`);
});

async function main() {
  const ordinaryResult = await api.main(
    { action: "checkRuntimeHealth", requestId: "health-smoke-user" },
    { OPENID: "ordinary-user" }
  );
  assert.strictEqual(ordinaryResult.ok, true);
  assert.strictEqual(ordinaryResult.readOnly, true);
  assert.strictEqual(ordinaryResult.requestId, "health-smoke-user");

  assert.ok(
    safetySource.includes("fn"),
    "CloudBase 安全脚本缺少函数调用入口"
  );
  assert.ok(
    safetySource.includes("checkRuntimeHealth"),
    "CloudBase 安全脚本没有调用运行健康动作"
  );
  assert.ok(
    safetySource.includes("Assert-CloudBaseRuntimeHealth"),
    "CloudBase 安全脚本缺少运行健康断言"
  );

  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const command = [
    `. ${psQuote(safetyPath)}`,
    "$good = [pscustomobject]@{ ok = $true; active = $true; readOnly = $true; buildVersion = '0.48.1'; buildMarker = 'MARKER'; checkedAt = '2026-08-27T00:00:00.000Z'; dependencies = [pscustomobject]@{ healthy = $true; verified = @('jpeg-js'); failed = @() } }",
    "Assert-CloudBaseRuntimeHealth -Health $good -ExpectedVersion '0.48.1' -ExpectedMarker 'MARKER'",
    "$badDependency = $good | Select-Object *",
    "$badDependency.dependencies = [pscustomobject]@{ healthy = $false; verified = @(); failed = @('xlsx') }",
    "$caught = $false",
    "try { Assert-CloudBaseRuntimeHealth -Health $badDependency -ExpectedVersion '0.48.1' } catch { if ($_.Exception.Message -like '*DEPENDENCY_UNHEALTHY*') { $caught = $true } else { throw } }",
    "if (-not $caught) { throw '依赖异常没有被拦截' }",
    "$badVersion = $good | Select-Object *",
    "$badVersion.buildVersion = '0.48.0'",
    "$caught = $false",
    "try { Assert-CloudBaseRuntimeHealth -Health $badVersion -ExpectedVersion '0.48.1' } catch { if ($_.Exception.Message -like '*VERSION_MISMATCH*') { $caught = $true } else { throw } }",
    "if (-not $caught) { throw '版本不一致没有被拦截' }",
    "$missing = [pscustomobject]@{ ok = $true; active = $true; readOnly = $true; buildVersion = '0.48.1' }",
    "$caught = $false",
    "try { Assert-CloudBaseRuntimeHealth -Health $missing -ExpectedVersion '0.48.1' } catch { if ($_.Exception.Message -like '*RESPONSE_INVALID*') { $caught = $true } else { throw } }",
    "if (-not $caught) { throw '返回结构缺失没有被拦截' }",
    "$wrapped = [pscustomobject]@{ data = [pscustomobject]@{ InvokeResult = 0; RetMsg = '{\"ok\":true,\"active\":true,\"readOnly\":true,\"buildVersion\":\"0.48.1\",\"buildMarker\":\"MARKER\",\"checkedAt\":\"2026-08-27T00:00:00.000Z\",\"dependencies\":{\"healthy\":true,\"verified\":[\"jpeg-js\"],\"failed\":[]}}' } }",
    "$wrappedHealth = Get-CloudBaseFunctionInvokePayload -Response $wrapped",
    "Assert-CloudBaseRuntimeHealth -Health $wrappedHealth -ExpectedVersion '0.48.1' -ExpectedMarker 'MARKER'",
    "if ($wrappedHealth.buildVersion -ne '0.48.1') { throw 'RetMsg 内健康结果没有被正确拆包' }",
    "$invalidWrapped = [pscustomobject]@{ data = [pscustomobject]@{ InvokeResult = 0; RetMsg = 'not-json' } }",
    "$caught = $false",
    "try { Assert-CloudBaseRuntimeHealth -Health (Get-CloudBaseFunctionInvokePayload -Response $invalidWrapped) -ExpectedVersion '0.48.1' } catch { if ($_.Exception.Message -like '*RESPONSE_INVALID*') { $caught = $true } else { throw } }",
    "if (-not $caught) { throw '无效 RetMsg 没有作为返回结构异常被拦截' }",
    "Write-Output 'RUNTIME_ASSERTIONS_OK'"
  ].join("; ");
  const result = cp.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" }
  );
  assert.strictEqual(
    result.status,
    0,
    `CloudBase 运行健康断言失败\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(result.stdout.includes("RUNTIME_ASSERTIONS_OK"));
  console.log("cloudbase runtime health smoke: OK");
}

main().catch((error) => {
  console.error(`CloudBase 运行健康 smoke 失败：${error.message || error}`);
  process.exitCode = 1;
});
