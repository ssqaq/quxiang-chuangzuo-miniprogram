const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const versionScript = path.join(root, "scripts", "release-version.ps1");
const syncScript = path.join(root, "scripts", "sync-to-github.ps1");

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
if ($paths.Count -ne 7) { Write-Output ($paths -join '|'); exit 2 }
$lock = '{"version":"0.38.3","packages":{"":{"version":"0.38.3"},"dep":{"version":"9.9.9"}}}'
$updated = Set-VersionText -RelativePath 'cloudfunctions/api/package-lock.json' -Text $lock -TargetVersion '0.38.4'
if ($updated -notmatch '"dep":\\{"version":"9\\.9\\.9"') { exit 3 }
if (($updated -split '0\\.38\\.4').Count -ne 3) { exit 4 }
Write-Output ($paths -join '|')
`;
  const result = runPowerShell(script);
  assertPowerShellOk(result, "版本组和精确替换");
  assert.ok(
    result.stdout.includes("cloudfunctions/watermark-gateway/package.json"),
    "版本组没有包含媒体解析网关"
  );
}

function testSyncConcurrencyContracts() {
  const content = fs.readFileSync(syncScript, "utf8");
  const required = [
    "worktree",
    "Get-NextPatchVersion",
    "New-VersionReservation",
    "Get-FileSnapshot",
    "Assert-FileSnapshotStable",
    'Invoke-NodeScriptAt -WorkingDirectory $repoRoot -RelativeScript "scripts/validate.js"',
    "主工作区在临时发布准备期间发生变化",
    "retryRemote",
    "MaxAttempts",
    "update-ref",
    "origin/$branch",
    "Start-Sleep -Milliseconds 250",
    "release-reservations",
  ];
  for (const marker of required) {
    assert.ok(content.includes(marker), `同步脚本缺少并发保护：${marker}`);
  }
  assert.ok(
    !/Invoke-Git(?:At)?[\s\S]{0,160}"add"\s*,\s*"-A"/.test(content),
    "同步脚本不能使用 git add -A"
  );
  assert.ok(
    content.includes('push origin "HEAD:$branch"'),
    "推送必须从临时发布工作树快进到 main"
  );
}

function main() {
  testPatchAllocation();
  testVersionGroupAndExactReplacement();
  testSyncConcurrencyContracts();
  console.log("version concurrency smoke: OK");
}

main();
