/* eslint-disable no-console */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { generateKeyPairSync } = require("crypto");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(__dirname, "deploy-payment-production.ps1");
const source = fs.readFileSync(scriptPath, "utf8");

for (const marker of [
  "[string]$ProjectPath",
  "[string]$EnvironmentId",
  "[string]$ReleaseContext",
  "[string]$SecretFile",
  "[switch]$WhatIf",
  "scripts\\payment-cloudfunctions.json",
  "@cloudbase/cli@3.8.1",
  "Assert-CloudDeployReleaseContext",
  "Enter-CloudDeployLock",
  "Assert-ReleaseLockHandoff",
  "ImportFromPem",
  "paymentDeployment",
  "Raw CLI output was suppressed",
  "DescribeHTTPServiceRoute",
  "DescribeEnvInfo",
  "Protect-SensitivePath",
  "RESOURCE_NOT_FOUND",
]) {
  assert.ok(source.includes(marker), `deployment script is missing ${marker}`);
}

for (const collection of [
  "payment_orders",
  "payment_events",
  "recharge_config",
  "payment_monitor_status",
]) {
  assert.ok(source.includes(`\"${collection}\"`), `missing collection ${collection}`);
}

for (const functionName of [
  "payment-api",
  "payment-notify",
  "payment-reconcile",
]) {
  assert.ok(source.includes(`\"${functionName}\"`), `missing function ${functionName}`);
}

for (const key of [
  "XINGJU_API_BASE_URL",
  "XINGJU_PID",
  "XINGJU_PLATFORM_PUBLIC_KEY",
  "XINGJU_MERCHANT_PRIVATE_KEY",
  "XINGJU_NOTIFY_URL",
  "PAYMENT_ORDER_CREATION_ENABLED",
  "PAYMENT_CALLBACK_PROCESSING_ENABLED",
  "PAYMENT_RECONCILIATION_ENABLED",
]) {
  assert.ok(source.includes(key), `missing production key ${key}`);
}

for (const marker of [
  "/payment/xingju/notify",
  "0 */2 * * * * *",
  "rechargeEnabled = $true",
  "wxpay = [ordered]@{ enabled = $true }",
  "alipay = [ordered]@{ enabled = $false }",
  "rolloutPercent = 100",
  "CreateTable",
  "DescribeTable",
  "UpdateTable",
  "api\", \"tcb\", \"DescribeHTTPServiceRoute",
  "fn\", \"trigger\", \"create",
  "fn\", \"trigger\", \"delete",
  "enableSafeDomain = $true",
  "enablePathTransmission = $false",
]) {
  assert.ok(source.includes(marker), `missing deployment contract ${marker}`);
}

assert.ok(
  source.indexOf('Name "payment-notify"') < source.indexOf('Name "payment-reconcile"')
    && source.indexOf('Name "payment-reconcile"') < source.lastIndexOf('Name "payment-api"'),
  "payment activation order must be notify -> reconcile -> api",
);
assert.ok(source.includes("SecretFile must be outside the repository."));
assert.ok(source.includes("if ($WhatIf)"));
assert.ok(source.includes("WHATIF_OK: no CloudBase read or mutation was executed."));
assert.ok(source.lastIndexOf("Ensure-RechargeConfig") > source.lastIndexOf('Name "payment-api"'));
assert.ok(source.includes('state = "verified"'));
assert.ok(source.includes('status = "verified"'));
assert.ok(source.includes("credentialsConfigured = [bool]$credentialsConfigured"));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "payment-production-smoke-"));
const secretPath = path.join(tempRoot, "production-secrets.json");
const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const sentinels = {
  XINGJU_API_BASE_URL: "https://api.example.test/SENTINEL_BASE_URL",
  XINGJU_PID: "SENTINEL_PID_847263",
  XINGJU_PLATFORM_PUBLIC_KEY: keyPair.publicKey,
  XINGJU_MERCHANT_PRIVATE_KEY: keyPair.privateKey,
  XINGJU_NOTIFY_URL: "https://notify.example.test/payment/xingju/notify?sentinel=847263",
};

try {
  fs.writeFileSync(secretPath, JSON.stringify(sentinels), "utf8");
  const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  const result = spawnSync(powershell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-ProjectPath", root,
    "-EnvironmentId", "payment-production-smoke-env",
    "-SecretFile", secretPath,
    "-WhatIf",
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.ok(output.includes("WHATIF_OK"), "WhatIf did not reach its zero-mutation exit");
  assert.ok(output.includes("SECRET_KEYS_PRESENT: 4/4"), "WhatIf did not validate key presence");
  for (const value of Object.values(sentinels)) {
    assert.ok(!output.includes(value), "WhatIf leaked a production secret value");
  }

  const missingResult = spawnSync(powershell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-ProjectPath", root,
    "-EnvironmentId", "payment-production-smoke-env",
    "-WhatIf",
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  assert.strictEqual(missingResult.status, 0, missingResult.stderr || missingResult.stdout);
  const missingOutput = `${missingResult.stdout || ""}\n${missingResult.stderr || ""}`;
  assert.ok(missingOutput.includes("MISSING_SECRET_KEYS:"), "WhatIf did not report missing keys");
  assert.ok(missingOutput.includes("WHATIF_OK"), "missing-secret WhatIf attempted a mutation");

  const executionMarker = source.search(/\r?\n\$project = Resolve-ProjectRoot/);
  assert.ok(executionMarker > 0, "cannot isolate deployment function definitions");
  const functionSource = source.slice(0, executionMarker);
  const harnessPath = path.join(tempRoot, "payment-production-function-harness.ps1");
  const releasePath = path.join(root, "scripts", "release.ps1").replace(/'/g, "''");
  const resumePath = path.join(root, "scripts", "resume-release.ps1").replace(/'/g, "''");
  const harness = `${functionSource}

$ErrorActionPreference = "Stop"

function Assert-Test($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

# The three function-not-found identities must all be treated as an empty
# environment, while unrelated failures remain fatal.
foreach ($code in @("RESOURCE_NOT_FOUND", "ResourceNotFound.FunctionName", "ResourceNotFound.Function")) {
  $script:MockNotFoundCode = $code
  function Invoke-TcbJsonResult {
    return [pscustomobject]@{
      ExitCode = 1
      Payload = [pscustomobject]@{ error = [pscustomobject]@{ code = $script:MockNotFoundCode; requestId = "mock-request" } }
    }
  }
  $existing = Get-ExistingProductionSecrets -Cli "mock" -Environment "mock-env"
  Assert-Test ($existing.Count -eq 0) "function not-found identity was not accepted: $code"
}
$script:MockNotFoundCode = "ACCESS_DENIED"
try {
  Get-ExistingProductionSecrets -Cli "mock" -Environment "mock-env" | Out-Null
  throw "unrelated function failure was accepted"
}
catch {
  Assert-Test ($_.Exception.Message -match "ACCESS_DENIED") "unrelated function failure lost its identity"
}

# Raw route fixtures include fields that routes list --json drops. Also put
# an AI_AGENT default first to prove domain selection is HTTPSERVICE-only.
function Invoke-TcbJson {
  param([string]$Cli, [string[]]$Arguments, [string]$WorkingDirectory = "", [string]$Operation)
  if ($Operation -eq "read HTTP domains") {
    return [pscustomobject]@{ data = @(
      [pscustomobject]@{ domain = "agent.example.test"; domainType = "AI_AGENT"; isDefault = $true; enable = $true; status = "SUCCESS" },
      [pscustomobject]@{ domain = "mock-123.ap-shanghai.app.tcloudbase.com"; domainType = "HTTPSERVICE"; isDefault = $true; enable = $true; status = "SUCCESS" }
    ) }
  }
  Assert-Test ($Arguments[0] -eq "api" -and $Arguments[1] -eq "tcb" -and $Arguments[2] -eq "DescribeHTTPServiceRoute") "route readback did not use the raw API"
  $bodyIndex = [Array]::IndexOf($Arguments, "--body")
  Assert-Test ($bodyIndex -ge 0) "route readback omitted API body"
  $body = $Arguments[$bodyIndex + 1] | ConvertFrom-Json
  Assert-Test ([string]$body.EnvId -eq "mock-env") "route API body omitted EnvId"
  return [pscustomobject]@{ data = [pscustomobject]@{ Domains = @(
    [pscustomobject]@{
      Domain = "mock-123.ap-shanghai.app.tcloudbase.com"
      Routes = @([pscustomobject]@{
        Path = "/payment/xingju/notify"
        UpstreamResourceType = "SCF"
        UpstreamResourceName = "payment-notify"
        Enable = $true
        EnableAuth = $false
        EnableSafeDomain = $true
        EnablePathTransmission = $false
        QPSPolicy = [pscustomobject]@{
          QPSTotal = 100
          QPSPerClient = [pscustomobject]@{ LimitBy = "ClientIP"; LimitValue = 20 }
        }
      })
    }
  ) } }
}
$domain = Get-DefaultHttpDomain -Cli "mock" -Environment "mock-env"
Assert-Test ($domain -eq "mock-123.ap-shanghai.app.tcloudbase.com") "default HTTP domain selected a non-HTTPSERVICE domain"
$routeManifest = [pscustomobject]@{ path = "/payment/xingju/notify"; qpsTotal = 100; qpsPerClient = 20 }
$routes = @(Get-RouteList -Cli "mock" -Environment "mock-env" -Domain $domain -Path $routeManifest.path)
$verifiedRoute = Assert-NotifyRoute -Routes $routes -Domain $domain -RouteManifest $routeManifest
Assert-Test ([bool]$verifiedRoute.EnableSafeDomain) "raw route safe-domain field was not verified"

# An online index with a different name but the same definition is valid and
# must remain valid after the final readback.
$script:EquivalentIndexDescription = [pscustomobject]@{
  Exists = $true
  Data = [pscustomobject]@{
    Indexes = @([pscustomobject]@{
      Name = "legacy_equivalent_name"
      Keys = @([pscustomobject]@{ Name = "outTradeNo"; Direction = 1 })
      Unique = $true
    })
  }
}
function Get-CollectionDescription { return $script:EquivalentIndexDescription }
function Invoke-FlexDbApi { throw "equivalent index unexpectedly triggered a mutation" }
Ensure-CollectionIndexes -Cli "mock" -Tag "mock-tag" -Collection "payment_orders" -Specs @(
  [pscustomobject]@{ name = "uniq_out_trade_no"; keys = @([pscustomobject]@{ name = "outTradeNo"; direction = 1 }); unique = $true }
)

$aclRoot = Join-Path ([IO.Path]::GetTempPath()) ("payment-acl-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $aclRoot | Out-Null
  Protect-SensitivePath -Path $aclRoot -Directory
  $aclFile = Join-Path $aclRoot "secret.json"
  [IO.File]::WriteAllText($aclFile, "{}", [Text.UTF8Encoding]::new($false))
  Protect-SensitivePath -Path $aclFile
  if ($IsWindows) {
    Assert-Test ((Get-Acl -LiteralPath $aclRoot).AreAccessRulesProtected) "sensitive directory still inherits ACLs"
    Assert-Test ((Get-Acl -LiteralPath $aclFile).AreAccessRulesProtected) "sensitive file still inherits ACLs"
  }
}
finally {
  if (Test-Path -LiteralPath $aclRoot) { Remove-Item -LiteralPath $aclRoot -Recurse -Force }
}

function Get-FunctionText([string]$Path, [string]$Name) {
  $tokens = $null
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  Assert-Test ($errors.Count -eq 0) "cannot parse $Path"
  $definition = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
  }, $true)
  Assert-Test ($null -ne $definition) "missing function $Name in $Path"
  return $definition.Extent.Text
}
Invoke-Expression (Get-FunctionText -Path '${releasePath}' -Name "Assert-GatePaymentDeploymentReceipt")
Invoke-Expression (Get-FunctionText -Path '${resumePath}' -Name "Get-ResumeProperty")
Invoke-Expression (Get-FunctionText -Path '${resumePath}' -Name "Assert-ResumePaymentDeploymentReceipt")
$identity = [pscustomobject]@{
  operationId = "op-payment-smoke"
  version = "0.57.999"
  releaseCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  treeSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  sourceSha256 = ("c" * 64)
  packageSha256 = ("d" * 64)
  mainCommit = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  cloudbaseEnvironment = [pscustomobject]@{ environmentId = "mock-env" }
}
$receipt = [pscustomobject]@{
  schemaVersion = 1; state = "verified"; status = "verified"; operationId = $identity.operationId
  environment = "mock-env"; version = $identity.version; releaseCommit = $identity.releaseCommit
  treeSha = $identity.treeSha; sourceSha256 = $identity.sourceSha256; packageSha256 = $identity.packageSha256
  mainCommit = $identity.mainCommit
  idempotencyKey = "payment:$($identity.operationId):$($identity.releaseCommit):$($identity.treeSha):mock-env"
  credentialsConfigured = $false; providerState = "fail-closed"; missingCredentialKeys = @("XINGJU_PID")
  functions = [pscustomobject]@{}; route = [pscustomobject]@{}; timer = [pscustomobject]@{}; rechargeConfig = [pscustomobject]@{}
  verifiedAt = [DateTimeOffset]::UtcNow.ToString("o")
}
Assert-GatePaymentDeploymentReceipt -Receipt $receipt -Context $identity | Out-Null
Assert-ResumePaymentDeploymentReceipt -Receipt $receipt -Context $identity | Out-Null
$tampered = $receipt | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$tampered.treeSha = "ffffffffffffffffffffffffffffffffffffffff"
foreach ($validator in @("Assert-GatePaymentDeploymentReceipt", "Assert-ResumePaymentDeploymentReceipt")) {
  try { & $validator -Receipt $tampered -Context $identity | Out-Null; throw "$validator accepted a foreign receipt" }
  catch { Assert-Test ($_.Exception.Message -match "treeSha") "$validator did not reject the foreign receipt identity" }
}

Write-Host "PAYMENT_FUNCTION_HARNESS_OK"
`;
  fs.writeFileSync(harnessPath, harness, "utf8");
  const harnessResult = spawnSync(powershell, [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", harnessPath,
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  assert.strictEqual(harnessResult.status, 0, harnessResult.stderr || harnessResult.stdout);
  assert.ok(`${harnessResult.stdout || ""}\n${harnessResult.stderr || ""}`.includes("PAYMENT_FUNCTION_HARNESS_OK"));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("payment production deploy smoke: OK (runtime/raw-route/not-found/receipt/acl)");
