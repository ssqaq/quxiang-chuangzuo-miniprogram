const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const versionScript = path.join(root, "scripts", "release-version.ps1");
const syncScript = path.join(root, "scripts", "sync-to-github.ps1");
const gateScript = path.join(root, "scripts", "release-gate.ps1");
const entryScript = path.join(root, "scripts", "release.ps1");
const queueScript = path.join(root, "scripts", "release-queue.ps1");

function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return cp.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }
  );
}

function assertPowerShellOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function testPatchAllocation() {
  const script = `
. '${versionScript.replace(/'/g, "''")}'
$a = Get-NextPatchVersion -BaseVersion '0.38.3'
$b = Get-NextPatchVersion -BaseVersion '0.38.99'
if ($a -ne '0.38.4' -or $b -ne '0.38.100') { exit 2 }
try { Get-NextPatchVersion -BaseVersion '0.38' | Out-Null; exit 3 } catch {}
Write-Output 'PATCH_OK'
`;
  const result = runPowerShell(script);
  assertPowerShellOk(result, "补丁版本自动分配");
  assert.ok(result.stdout.includes("PATCH_OK"), "补丁版本 smoke 没有成功标记");
}

function testVersionGroupAndExactReplacement() {
  const script = `
. '${versionScript.replace(/'/g, "''")}'
$paths = @(Get-VersionGroupPaths -SourceRoot '${root.replace(/'/g, "''")}')
if ($paths.Count -ne 21) { Write-Output ($paths -join '|'); exit 2 }
$lock = '{"version":"0.38.3","packages":{"":{"version":"0.38.3"},"dep":{"version":"9.9.9"}}}'
$updated = Set-VersionText -RelativePath 'cloudfunctions/api/package-lock.json' -Text $lock -TargetVersion '0.38.4'
if ($updated -notmatch '"dep":\\{"version":"9\\.9\\.9"') { exit 3 }
if (($updated -split '0\\.38\\.4').Count -ne 3) { exit 4 }
$paymentLock = '{"version":"0.38.3","packages":{"":{"version":"0.38.3"},"node_modules/dep":{"version":"9.9.9"},"vendor/payment-core":{"name":"aips-payment-core","version":"0.38.3","extraneous":true}}}'
$paymentLockUpdated = Set-VersionText -RelativePath 'cloudfunctions/payment-api/package-lock.json' -Text $paymentLock -TargetVersion '0.38.4'
if (($paymentLockUpdated -split '0\\.38\\.4').Count -ne 4) { exit 7 }
if ($paymentLockUpdated -notmatch '"node_modules/dep":\\{"version":"9\\.9\\.9"') { exit 8 }
$invalidPaymentLock = '{"version":"0.38.3","packages":{"":{"version":"0.38.3"},"vendor/payment-core":{"name":"aips-payment-core"},"node_modules/dep":{"version":"9.9.9"}}}'
try {
  Set-VersionText -RelativePath 'cloudfunctions/payment-api/package-lock.json' -Text $invalidPaymentLock -TargetVersion '0.38.4' | Out-Null
  exit 9
} catch {}
$vendorPackage = '{"name":"aips-payment-core","version":"0.38.3"}'
$vendorUpdated = Set-VersionText -RelativePath 'cloudfunctions/payment-api/vendor/payment-core/package.json' -Text $vendorPackage -TargetVersion '0.38.4'
if ($vendorUpdated -notmatch '"version":"0\\.38\\.4"') { exit 5 }
$paymentConfig = '{"timeout":15}'
$configUpdated = Set-VersionText -RelativePath 'cloudfunctions/payment-api/config.json' -Text $paymentConfig -TargetVersion '0.38.4'
if ($configUpdated -ne $paymentConfig) { exit 6 }
Write-Output ($paths -join '|')
`;
  const result = runPowerShell(script);
  assertPowerShellOk(result, "版本组和精确替换");
  assert.ok(
    result.stdout.includes("cloudfunctions/watermark-gateway/package.json"),
    "版本组没有包含媒体解析网关"
  );
  for (const marker of [
    "scripts/payment-cloudfunctions.json",
    "cloudfunctions/payment-core/package.json",
    "cloudfunctions/payment-api/package-lock.json",
    "cloudfunctions/payment-notify/config.json",
    "cloudfunctions/payment-reconcile/vendor/payment-core/package.json",
  ]) {
    assert.ok(result.stdout.includes(marker), `支付版本组缺少 ${marker}`);
  }
}

function testRealPaymentLockReplacement() {
  const script = `
. '${versionScript.replace(/'/g, "''")}'
$sourceRoot = '${root.replace(/'/g, "''")}'
$targetVersion = '9.8.7'
$paymentLocks = @(
  'cloudfunctions/payment-api/package-lock.json',
  'cloudfunctions/payment-notify/package-lock.json',
  'cloudfunctions/payment-reconcile/package-lock.json'
)
foreach ($relativePath in $paymentLocks) {
  $fullPath = Join-Path $sourceRoot $relativePath
  $originalText = Get-Content -LiteralPath $fullPath -Raw -Encoding UTF8
  if ($originalText -notmatch '[\\r\\n]') { throw "支付 lock 必须保留真实多行格式：$relativePath" }
  $original = $originalText | ConvertFrom-Json -ErrorAction Stop
  $originalRoot = $original.packages.PSObject.Properties[''].Value
  $originalVendor = $original.packages.PSObject.Properties['vendor/payment-core'].Value
  if ([string]$originalRoot.engines.node -ne '>=18' -or [string]$originalVendor.engines.node -ne '>=18') {
    throw "支付 lock 缺少真实嵌套 engines：$relativePath"
  }
  if ($originalRoot.dependencies.PSObject.Properties.Name -contains 'aips-payment-core') {
    throw "支付 lock 根依赖仍包含失效的 aips-payment-core：$relativePath"
  }
  if ($original.packages.PSObject.Properties.Name -contains 'node_modules/aips-payment-core') {
    throw "支付 lock 仍包含失效的 node_modules/aips-payment-core：$relativePath"
  }

  $unchangedVersions = @{}
  foreach ($property in $original.packages.PSObject.Properties) {
    if ($property.Name -eq '' -or $property.Name -eq 'vendor/payment-core') { continue }
    if ($property.Value.PSObject.Properties['version']) {
      $unchangedVersions[$property.Name] = [string]$property.Value.version
    }
  }

  $updatedText = Set-VersionText -RelativePath $relativePath -Text $originalText -TargetVersion $targetVersion
  $updated = $updatedText | ConvertFrom-Json -ErrorAction Stop
  $updatedRoot = $updated.packages.PSObject.Properties[''].Value
  $updatedVendor = $updated.packages.PSObject.Properties['vendor/payment-core'].Value
  if ([string]$updated.version -ne $targetVersion -or
      [string]$updatedRoot.version -ne $targetVersion -or
      [string]$updatedVendor.version -ne $targetVersion) {
    throw "支付 lock 三处版本没有同步：$relativePath"
  }
  if ([string]$updatedRoot.engines.node -ne '>=18' -or [string]$updatedVendor.engines.node -ne '>=18') {
    throw "支付 lock 升版破坏 engines：$relativePath"
  }
  foreach ($packageName in $unchangedVersions.Keys) {
    $updatedPackage = $updated.packages.PSObject.Properties[$packageName].Value
    if ([string]$updatedPackage.version -ne [string]$unchangedVersions[$packageName]) {
      throw "支付 lock 意外改动其他 npm 包版本：$relativePath -> $packageName"
    }
  }
}
Write-Output 'REAL_PAYMENT_LOCKS_OK'
`;
  const result = runPowerShell(script);
  assertPowerShellOk(result, "真实支付 lock 版本同步");
  assert.ok(
    result.stdout.includes("REAL_PAYMENT_LOCKS_OK"),
    "真实支付 lock smoke 没有成功标记"
  );
}

function testSyncConcurrencyContracts() {
  const content = fs.readFileSync(syncScript, "utf8");
  const gate = fs.readFileSync(gateScript, "utf8");
  const entry = fs.readFileSync(entryScript, "utf8");
  const queue = fs.readFileSync(queueScript, "utf8");
  const required = [
    "release.ps1",
    "Publish = $true",
    "SourcePath = $repoRoot",
    "统一发布队列策略",
  ];
  for (const marker of required) {
    assert.ok(content.includes(marker), `同步脚本缺少并发保护：${marker}`);
  }
  assert.ok(!/^\s*(?:&\s*)?git\s+.*\b(push|commit|add|reset|read-tree)\b/im.test(content),
    "旧同步脚本不能保留独立 Git 写操作");
  for (const marker of [
    "Get-ReleaseUsedVersions",
    "New-ReleaseReservation",
    "Invoke-ReleasePullRequest",
    "refs/heads/$Branch",
    "release/$target-$operationId",
    "origin/main",
  ]) {
    assert.ok(gate.includes(marker) || entry.includes(marker), `统一闸门缺少版本仲裁：${marker}`);
  }
  for (const marker of [
    "requestFingerprintVersion",
    "Assert-ReleaseQueueTurn",
    "Claim-ReleaseQueueTicket",
    "AllowPrepared",
    "expiresAt",
  ]) {
    assert.ok(queue.includes(marker), `发布队列缺少并发恢复保护：${marker}`);
  }
}

function main() {
  testPatchAllocation();
  testVersionGroupAndExactReplacement();
  testRealPaymentLockReplacement();
  testSyncConcurrencyContracts();
  console.log("version concurrency smoke: OK");
}

main();
