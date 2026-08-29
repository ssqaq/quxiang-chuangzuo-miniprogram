/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const lockScript = path.join(root, "scripts", "release-lock.ps1");

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-lock-smoke-"));
const projectA = path.join(tempRoot, "wechat-miniapp");
const projectB = path.join(tempRoot, "wechat-miniapp-release-20260827");
const explicitLock = path.join(tempRoot, "explicit", "custom.lock");
const holderPath = path.join(tempRoot, "holder.ps1");
try {
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.writeFileSync(
    holderPath,
    [
      `. ${psQuote(lockScript)}`,
      `$lock = Enter-ReleaseLock -ProjectPath ${psQuote(projectA)} -TargetVersion '0.49.1' -TargetType 'smoke-holder' -WaitSeconds 2`,
      "try {",
      "  Write-Output 'LOCKED'",
      "  [Console]::Out.Flush()",
      "  Start-Sleep -Seconds 4",
      "}",
      "finally { Exit-ReleaseLock -LockHandle $lock }",
      "",
    ].join("\n")
  );

  const pathsResult = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$a = Get-ReleaseLockPaths -ProjectPath ${psQuote(projectA)}`,
    `$b = Get-ReleaseLockPaths -ProjectPath ${psQuote(projectB)}`,
    `if ($a.LockPath -ne $b.LockPath) { throw "默认锁不统一：$($a.LockPath) / $($b.LockPath)" }`,
    `$c = Get-ReleaseLockPaths -ProjectPath ${psQuote(projectA)} -LockPath ${psQuote(explicitLock)}`,
    // Windows runners can return an equivalent path with different casing,
    // separator style, or a trailing separator.  Compare canonical paths so
    // this smoke tests the lock contract instead of PowerShell formatting.
    "function Normalize-TestPath([string]$value) { return (([IO.Path]::GetFullPath($value) -replace '[\\/]+$','').ToLowerInvariant()) }",
    `if ((Normalize-TestPath $c.LockPath) -ne (Normalize-TestPath ${psQuote(explicitLock)})) { throw "显式锁路径没有优先使用：$($c.LockPath) / ${explicitLock}" }`,
    "Write-Output 'PATHS_OK'",
  ].join("; "));
  assert.strictEqual(
    pathsResult.status,
    0,
    `发布锁路径测试失败\n${pathsResult.stdout}\n${pathsResult.stderr}`
  );
  assert.ok(pathsResult.stdout.includes("PATHS_OK"));

  const holder = cp.spawn(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", holderPath],
    { cwd: root, stdio: "ignore" }
  );
  const ownerPath = path.join(tempRoot, "wechat-miniapp-release.lock.owner.json");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ownerPath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(fs.existsSync(ownerPath), "第一个进程没有取得公共发布锁");
  const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  assert.strictEqual(owner.targetType, "smoke-holder");
  assert.strictEqual(owner.targetVersion, "0.49.1");
  assert.ok(!Object.prototype.hasOwnProperty.call(owner, "projectPath"));

  const contender = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$lock = Enter-ReleaseLock -ProjectPath ${psQuote(projectB)} -TargetVersion '0.49.2' -TargetType 'smoke-contender' -WaitSeconds 1`,
    "try { Write-Output 'SECOND_LOCKED' } finally { Exit-ReleaseLock -LockHandle $lock }",
  ].join("; "));
  assert.notStrictEqual(contender.status, 0, "第二个进程错误地抢到了公共锁");
  assert.ok(
    `${contender.stdout}\n${contender.stderr}`.includes("timed out"),
    "锁超时提示不清楚"
  );

  const holderDeadline = Date.now() + 7000;
  while (fs.existsSync(ownerPath) && Date.now() < holderDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.ok(!fs.existsSync(ownerPath), "第一个进程没有释放公共锁");

  const afterRelease = runPowerShell([
    `. ${psQuote(lockScript)}`,
    `$lock = Enter-ReleaseLock -ProjectPath ${psQuote(projectB)} -TargetVersion '0.49.2' -TargetType 'smoke-contender' -WaitSeconds 1`,
    "try { Write-Output 'SECOND_LOCKED' } finally { Exit-ReleaseLock -LockHandle $lock }",
  ].join("; "));
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

console.log("release lock smoke: OK");
