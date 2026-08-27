/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "scripts", "cloud-deploy-safety.ps1");
const deployPath = path.join(root, "scripts", "deploy-and-verify-api.ps1");
const deploySource = fs.readFileSync(deployPath, "utf8");
const cloudbaseDeployPath = path.join(
  root,
  "scripts",
  "deploy-api-cloudbase-cli.ps1"
);
const cloudbaseDeploySource = fs.readFileSync(cloudbaseDeployPath, "utf8");

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(command, cwd = root) {
  return cp.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd, encoding: "utf8" }
  );
}

assert.ok(
  deploySource.includes("Enter-CloudDeployLock")
    && deploySource.includes("Exit-CloudDeployLock"),
  "真实部署必须在 finally 中取得并释放独占锁"
);
assert.ok(
  deploySource.includes("Assert-CloudDeployVersionNotDowngrade")
    && deploySource.indexOf("Assert-CloudDeployVersionNotDowngrade")
      < deploySource.indexOf('"cloud_fn_deploy"'),
  "真实部署必须在 cloud_fn_deploy 前检查线上版本，禁止降级"
);
assert.ok(
  deploySource.includes("Get-DeploymentResult")
    && deploySource.includes("-ReadOnly"),
  "真实部署必须用只读 checkDeployment 读取线上版本"
);
assert.ok(
  cloudbaseDeploySource.includes("Get-CloudBaseFunctionVersion")
    && cloudbaseDeploySource.includes("Assert-CloudDeployVersionNotDowngrade"),
  "CloudBase 直部署入口也必须检查线上版本，禁止降级"
);
assert.ok(
  deploySource.includes("Assert-CloudDeploySourceSnapshotStable"),
  "真实部署必须检查云函数源码快照"
);
const verifyBranchEnd = deploySource.indexOf(
  'Write-Host "1/7 Check WechatIDE login"',
  0
);
const verifyBranchStart = deploySource.lastIndexOf(
  "if ($VerifyOnly)",
  verifyBranchEnd
);
assert.ok(verifyBranchStart >= 0 && verifyBranchEnd > verifyBranchStart);
const verifyBranch = deploySource.slice(verifyBranchStart, verifyBranchEnd);
assert.ok(
  !verifyBranch.includes("Enter-CloudDeployLock"),
  "VerifyOnly 不能抢写部署锁"
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-deploy-lock-"));
const lockPath = path.join(tempRoot, "api.lock");
const holderPath = path.join(tempRoot, "holder.ps1");
try {
  const pendingPath = path.join(tempRoot, "pending.json");
  const pendingCommand = [
    `. ${psQuote(helperPath)}`,
    `$record = [ordered]@{ taskId = 'task-smoke'; targetVersion = '1.2.3'; functionName = 'api' }`,
    `Write-CloudDeployPending -PendingPath ${psQuote(pendingPath)} -Record $record`,
    `$loaded = Read-CloudDeployPending -PendingPath ${psQuote(pendingPath)}`,
    "if ($loaded.taskId -ne 'task-smoke') { throw 'Pending record mismatch.' }",
    `Remove-CloudDeployPending -PendingPath ${psQuote(pendingPath)}`,
    `if (Test-Path -LiteralPath ${psQuote(pendingPath)}) { throw 'Pending record was not removed.' }`,
    "Write-Output 'PENDING_OK'",
  ].join("; ");
  const pendingResult = runPowerShell(pendingCommand);
  assert.strictEqual(
    pendingResult.status,
    0,
    `待确认任务记录测试失败\n${pendingResult.stdout}\n${pendingResult.stderr}`
  );
  assert.ok(pendingResult.stdout.includes("PENDING_OK"));

  const versionGuardCommand = [
    `. ${psQuote(helperPath)}`,
    "if ((Compare-CloudDeployVersions -LeftVersion '0.46.3' -RightVersion '0.46.2') -ne 1) { throw 'Newer local version was not recognized.' }",
    "if ((Compare-CloudDeployVersions -LeftVersion '0.46.2' -RightVersion '0.46.3') -ne -1) { throw 'Older local version was not recognized.' }",
    "if ((Compare-CloudDeployVersions -LeftVersion '0.46.3' -RightVersion '0.46.3') -ne 0) { throw 'Equal versions were not recognized.' }",
    "$same = Assert-CloudDeployVersionNotDowngrade -LocalVersion '0.46.3' -OnlineVersion '0.46.3'",
    "if ($same.Relation -ne 'same') { throw 'Equal version relation mismatch.' }",
    "$newer = Assert-CloudDeployVersionNotDowngrade -LocalVersion '0.46.3' -OnlineVersion '0.46.2'",
    "if ($newer.Relation -ne 'local-newer') { throw 'Newer local version relation mismatch.' }",
    "$downgradeCaught = $false",
    "try { Assert-CloudDeployVersionNotDowngrade -LocalVersion '0.46.2' -OnlineVersion '0.46.3' } catch { if ($_.Exception.Message -like '*禁止版本降级*') { $downgradeCaught = $true } else { throw } }",
    "if (-not $downgradeCaught) { throw 'Version downgrade was not blocked.' }",
    "$invalidCaught = $false",
    "try { Assert-CloudDeployVersionNotDowngrade -LocalVersion '0.46.x' -OnlineVersion '0.46.3' } catch { if ($_.Exception.Message -like '*三段式*') { $invalidCaught = $true } else { throw } }",
    "if (-not $invalidCaught) { throw 'Invalid version was not blocked.' }",
    "$missingCaught = $false",
    "try { Assert-CloudDeployVersionNotDowngrade -LocalVersion '0.46.3' -OnlineVersion '' } catch { if ($_.Exception.Message -like '*读取不到线上版本*') { $missingCaught = $true } else { throw } }",
    "if (-not $missingCaught) { throw 'Missing online version was not blocked.' }",
    "Write-Output 'VERSION_GUARD_OK'",
  ].join("; ");
  const versionGuardResult = runPowerShell(versionGuardCommand);
  assert.strictEqual(
    versionGuardResult.status,
    0,
    `版本防降级测试失败\n${versionGuardResult.stdout}\n${versionGuardResult.stderr}`
  );
  assert.ok(versionGuardResult.stdout.includes("VERSION_GUARD_OK"));

  const transportCommand = [
    `. ${psQuote(helperPath)}`,
    `$autoCloudBase = Resolve-CloudDeployTransport -RequestedTransport auto -CloudBaseCliPath 'npx.cmd' -WechatIdePath 'wechatide.cmd'`,
    `if ($autoCloudBase -ne 'cloudbase') { throw "auto should prefer cloudbase, got: $autoCloudBase" }`,
    `$autoWechat = Resolve-CloudDeployTransport -RequestedTransport auto -CloudBaseCliPath '' -WechatIdePath 'wechatide.cmd'`,
    `if ($autoWechat -ne 'wechat') { throw "auto should fall back to wechat, got: $autoWechat" }`,
    `$explicitCloudBase = Resolve-CloudDeployTransport -RequestedTransport cloudbase -CloudBaseCliPath 'npx.cmd' -WechatIdePath ''`,
    `if ($explicitCloudBase -ne 'cloudbase') { throw "explicit cloudbase selection failed" }`,
    `$explicitWechat = Resolve-CloudDeployTransport -RequestedTransport wechat -CloudBaseCliPath '' -WechatIdePath 'wechatide.cmd'`,
    `if ($explicitWechat -ne 'wechat') { throw "explicit wechat selection failed" }`,
    `$resume = Resolve-CloudDeployTransport -RequestedTransport auto -CloudBaseCliPath 'npx.cmd' -WechatIdePath 'wechatide.cmd' -ResumePendingDeploy`,
    `if ($resume -ne 'wechat') { throw "pending task must resume through wechat, got: $resume" }`,
    `$verify = Resolve-CloudDeployTransport -RequestedTransport auto -CloudBaseCliPath 'npx.cmd' -WechatIdePath 'wechatide.cmd' -VerifyOnly`,
    `if ($verify -ne 'wechat') { throw "verify-only must use wechat, got: $verify" }`,
    `$caught = $false`,
    `try { Resolve-CloudDeployTransport -RequestedTransport cloudbase -CloudBaseCliPath '' -WechatIdePath 'wechatide.cmd' } catch { if ($_.Exception.Message -like '*CloudBase CLI*') { $caught = $true } else { throw } }`,
    `if (-not $caught) { throw 'forced cloudbase without CLI was not rejected' }`,
    `$caught = $false`,
    `try { Resolve-CloudDeployTransport -RequestedTransport cloudbase -CloudBaseCliPath 'npx.cmd' -WechatIdePath 'wechatide.cmd' -ResumePendingDeploy } catch { if ($_.Exception.Message -like '*只能恢复微信*') { $caught = $true } else { throw } }`,
    `if (-not $caught) { throw 'pending task was allowed to use cloudbase' }`,
    "Write-Output 'TRANSPORT_OK'",
  ].join("; ");
  const transportResult = runPowerShell(transportCommand);
  assert.strictEqual(
    transportResult.status,
    0,
    `部署方式选择测试失败\n${transportResult.stdout}\n${transportResult.stderr}`
  );
  assert.ok(transportResult.stdout.includes("TRANSPORT_OK"));

  const apiRoot = path.join(tempRoot, "api");
  fs.mkdirSync(apiRoot, { recursive: true });
  fs.writeFileSync(path.join(apiRoot, "index.js"), "module.exports = 1;\n");

  const successLog = path.join(tempRoot, "cloudbase-success.log");
  const successNpx = path.join(tempRoot, "fake-npx-success.cmd");
  fs.writeFileSync(
    successNpx,
    [
      "@echo off",
      `> "%CLOUDBASE_SMOKE_LOG%" echo %CD%`,
      "exit /b 0",
      "",
    ].join("\r\n")
  );
  const successCommand = [
    `$env:CLOUDBASE_SMOKE_LOG = ${psQuote(successLog)}`,
    `. ${psQuote(helperPath)}`,
    `$result = Invoke-CloudBaseFunctionDeploy -EnvironmentId 'env-smoke' -FunctionName 'api' -ApiPath ${psQuote(apiRoot)} -TimeoutSeconds 900 -NpxPath ${psQuote(successNpx)}`,
    `if ($result.Transport -ne 'cloudbase' -or $result.FunctionName -ne 'api') { throw 'successful CloudBase deploy result mismatch' }`,
    `if (-not (Test-Path -LiteralPath ${psQuote(successLog)})) { throw 'fake CloudBase CLI was not called' }`,
    `$workDir = (Get-Content -LiteralPath ${psQuote(successLog)} -Raw).Trim()`,
    `if (Test-Path -LiteralPath (Join-Path $workDir 'cloudbaserc.json')) { throw 'temporary CloudBase config was not cleaned' }`,
    "Write-Output 'DIRECT_SUCCESS_OK'",
  ].join("; ");
  const successResult = runPowerShell(successCommand);
  assert.strictEqual(
    successResult.status,
    0,
    `CloudBase 直部署成功路径测试失败\n${successResult.stdout}\n${successResult.stderr}`
  );
  assert.ok(successResult.stdout.includes("DIRECT_SUCCESS_OK"));

  const failureLog = path.join(tempRoot, "cloudbase-failure.log");
  const failureNpx = path.join(tempRoot, "fake-npx-failure.cmd");
  fs.writeFileSync(
    failureNpx,
    [
      "@echo off",
      `>> "%CLOUDBASE_SMOKE_LOG%" echo CALL`,
      "echo simulated failure 1>&2",
      "exit /b 17",
      "",
    ].join("\r\n")
  );
  const failureCommand = [
    `$env:CLOUDBASE_SMOKE_LOG = ${psQuote(failureLog)}`,
    `. ${psQuote(helperPath)}`,
    `$caught = $false`,
    `try { Invoke-CloudBaseFunctionDeploy -EnvironmentId 'env-smoke' -FunctionName 'api' -ApiPath ${psQuote(apiRoot)} -TimeoutSeconds 900 -NpxPath ${psQuote(failureNpx)} | Out-Null } catch { if ($_.Exception.Message -like '*未自动切换*') { $caught = $true } else { throw } }`,
    `if (-not $caught) { throw 'CloudBase failure was not surfaced as a no-fallback error' }`,
    `$calls = @(Get-Content -LiteralPath ${psQuote(failureLog)})`,
    `if ($calls.Count -ne 1) { throw "CloudBase failure invoked CLI $($calls.Count) times" }`,
    "Write-Output 'DIRECT_FAILURE_NO_FALLBACK_OK'",
  ].join("; ");
  const failureResult = runPowerShell(failureCommand);
  assert.strictEqual(
    failureResult.status,
    0,
    `CloudBase 直部署失败不重传测试失败\n${failureResult.stdout}\n${failureResult.stderr}`
  );
  assert.ok(failureResult.stdout.includes("DIRECT_FAILURE_NO_FALLBACK_OK"));

  const fakeWechatIde = path.join(tempRoot, "wechatide.cmd");
  const dryRunLock = path.join(tempRoot, "dry-run.lock");
  fs.writeFileSync(fakeWechatIde, "@echo off\r\nexit /b 0\r\n");
  const dryRun = cp.spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      deployPath,
      "-DryRun",
      "-WechatIde",
      fakeWechatIde,
      "-DeployLockPath",
      dryRunLock,
    ],
    { cwd: root, encoding: "utf8" }
  );
  assert.strictEqual(
    dryRun.status,
    0,
    `DryRun 失败\n${dryRun.stdout}\n${dryRun.stderr}`
  );
  assert.ok(!fs.existsSync(dryRunLock), "DryRun 不能创建写部署锁");
  assert.ok(
    !fs.existsSync(`${dryRunLock}.owner.json`),
    "DryRun 不能创建锁占用信息"
  );

  fs.writeFileSync(
    holderPath,
    [
      `. ${psQuote(helperPath)}`,
      `$lock = Enter-CloudDeployLock -ProjectPath ${psQuote(root)} -TargetVersion 'test' -FunctionName 'api' -WaitSeconds 1 -LockPath ${psQuote(lockPath)}`,
      "try {",
      '  Write-Output "LOCKED"',
      "  [Console]::Out.Flush()",
      "  Start-Sleep -Seconds 4",
      "}",
      "finally {",
      "  Exit-CloudDeployLock -LockHandle $lock",
      "}",
      "",
    ].join("\n")
  );
  const holder = cp.spawn(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath],
    { cwd: root, stdio: "ignore" }
  );
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(`${lockPath}.owner.json`) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(
    fs.existsSync(`${lockPath}.owner.json`),
    "第一个部署进程没有取得锁"
  );

  const contenderCommand = [
    `. ${psQuote(helperPath)}`,
    `$lock = Enter-CloudDeployLock -ProjectPath ${psQuote(root)} -TargetVersion 'test-2' -FunctionName 'api' -WaitSeconds 1 -LockPath ${psQuote(lockPath)}`,
    "try { Write-Output 'SECOND_LOCKED' } finally { Exit-CloudDeployLock -LockHandle $lock }",
  ].join("; ");
  const blocked = runPowerShell(contenderCommand);
  assert.notStrictEqual(blocked.status, 0, "第二个部署进程不应抢到锁");
  assert.ok(
    `${blocked.stdout}\n${blocked.stderr}`.includes("Cloud deployment lock timed out"),
    "抢锁失败提示不清楚"
  );

  const holderExitDeadline = Date.now() + 7000;
  while (fs.existsSync(`${lockPath}.owner.json`) && Date.now() < holderExitDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(
    !fs.existsSync(`${lockPath}.owner.json`),
    "第一个部署进程没有按时释放锁"
  );

  const afterRelease = runPowerShell(contenderCommand);
  assert.strictEqual(
    afterRelease.status,
    0,
    `锁释放后第二个进程仍无法继续\n${afterRelease.stdout}\n${afterRelease.stderr}`
  );
  assert.ok(afterRelease.stdout.includes("SECOND_LOCKED"));
  if (holder.exitCode === null) holder.kill();
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-deploy-snapshot-"));
try {
  fs.mkdirSync(path.join(snapshotRoot, "cloudfunctions", "api"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(snapshotRoot, "config.js"),
    'module.exports = { appVersion: "1.2.3" };\n'
  );
  fs.writeFileSync(
    path.join(snapshotRoot, "cloudfunctions", "api", "index.js"),
    "module.exports = 1;\n"
  );
  [
    ["git", "init"],
    ["git", "config", "user.email", "smoke@example.test"],
    ["git", "config", "user.name", "Smoke"],
    ["git", "add", "."],
    ["git", "commit", "-m", "snapshot"],
  ].forEach(([command, ...args]) => {
    const result = cp.spawnSync(command, args, {
      cwd: snapshotRoot,
      encoding: "utf8",
    });
    assert.strictEqual(
      result.status,
      0,
      `${command} ${args.join(" ")} 失败\n${result.stdout}\n${result.stderr}`
    );
  });
  const apiRoot = path.join(snapshotRoot, "cloudfunctions", "api");
  const snapshotCommand = [
    `. ${psQuote(helperPath)}`,
    `$snapshot = Get-CloudDeploySourceSnapshot -ProjectPath ${psQuote(snapshotRoot)} -ApiPath ${psQuote(apiRoot)}`,
    `Assert-CloudDeploySourceSnapshotStable -Snapshot $snapshot -ProjectPath ${psQuote(snapshotRoot)} -ApiPath ${psQuote(apiRoot)} -Stage 'smoke-stable'`,
    `Set-Content -LiteralPath ${psQuote(path.join(apiRoot, "index.js"))} -Value 'module.exports = 2;' -Encoding UTF8`,
    "$caught = $false",
    "try { Assert-CloudDeploySourceSnapshotStable -Snapshot $snapshot -ProjectPath "
      + `${psQuote(snapshotRoot)} -ApiPath ${psQuote(apiRoot)} -Stage 'smoke-change' } `
      + "catch { if ($_.Exception.Message -like '*source changed*') { $caught = $true } else { throw } }",
    "if (-not $caught) { throw 'Snapshot change was not detected.' }",
    "Write-Output 'SNAPSHOT_OK'",
  ].join("; ");
  const snapshotResult = runPowerShell(snapshotCommand, snapshotRoot);
  assert.strictEqual(
    snapshotResult.status,
    0,
    `源码快照专项测试失败\n${snapshotResult.stdout}\n${snapshotResult.stderr}`
  );
  assert.ok(snapshotResult.stdout.includes("SNAPSHOT_OK"));
} finally {
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
}

console.log("cloud deploy safety smoke: OK");
