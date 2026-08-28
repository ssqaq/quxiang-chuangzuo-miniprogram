/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const gateScript = path.join(root, "scripts", "release-gate.ps1");
const entryScript = path.join(root, "scripts", "release.ps1");
const previewScript = path.join(root, "scripts", "refresh-preview.ps1");
const deployScript = path.join(root, "scripts", "deploy-and-verify-api.ps1");
const protectionScript = path.join(root, "scripts", "configure-github-protection.ps1");
const policyPath = path.resolve(root, "..", "wechat-miniapp-release-policy.json");

function runPowerShell(command) {
  return childProcess.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
  );
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function assertPowerShellOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function assertNoInteriorBom(file, label) {
  const content = fs.readFileSync(file, "utf8");
  const body = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  assert.strictEqual(body.includes("\ufeff"), false, `${label}包含函数体内 BOM`);
}

function testFilesAndPolicy() {
  assert.ok(fs.existsSync(gateScript), "release-gate.ps1 不存在");
  assert.ok(fs.existsSync(entryScript), "release.ps1 不存在");
  assert.ok(fs.existsSync(previewScript), "refresh-preview.ps1 不存在");
  assert.ok(fs.existsSync(deployScript), "deploy-and-verify-api.ps1 不存在");
  assert.ok(fs.existsSync(protectionScript), "configure-github-protection.ps1 不存在");
  assert.ok(fs.existsSync(policyPath), "外部发布策略不存在");
  for (const file of [gateScript, entryScript, previewScript, deployScript, protectionScript]) {
    assertNoInteriorBom(file, path.basename(file));
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.strictEqual(policy.schemaVersion, 1);
  assert.strictEqual(policy.canonicalRepo.toLowerCase(), root.toLowerCase());
  assert.strictEqual(policy.branch, "main");
  assert.ok(policy.remote.includes("github.com/ssqaq/"));
  for (const key of ["lockPath", "artifactRoot", "reservationRoot", "worktreeRoot", "contextRoot", "logRoot", "archiveManifestPath"]) {
    assert.ok(policy[key], `策略缺少 ${key}`);
  }
  assert.strictEqual(policy.mainProtection.mode, "pr-only");
  assert.strictEqual(policy.queue.waitSeconds, 1800);
}

function testStaticContracts() {
  const gate = fs.readFileSync(gateScript, "utf8");
  const entry = fs.readFileSync(entryScript, "utf8");
  const preview = fs.readFileSync(previewScript, "utf8");
  const deploy = fs.readFileSync(deployScript, "utf8");
  const protection = fs.readFileSync(protectionScript, "utf8");
  for (const marker of [
    "Normalize-ReleaseIncludePaths",
    "New-ReleaseReservation",
    "Get-ReleaseUsedVersions",
    "Resolve-ReleaseIdentity",
    "New-ReleaseContext",
    "Invoke-ReleasePullRequest",
    "FileSnapshotStable",
    "release/$target-$operationId",
  ]) {
    assert.ok(gate.includes(marker) || entry.includes(marker), `发布闸门缺少 ${marker}`);
  }
  assert.ok(entry.includes("[switch]$Publish"), "发布必须显式 -Publish");
  assert.ok(entry.includes("--release-context"), "正式打包必须使用 release context");
  assert.ok(!entry.includes("push origin \"HEAD:main\""), "闸门不能直接 push main");
  assert.ok(gate.indexOf("auth status") < gate.indexOf("push origin"), "GitHub 认证检查必须先于推送 release 分支");
  assert.ok(preview.includes("release.ps1"), "预览入口必须转发到统一闸门");
  assert.ok(!preview.includes("package-release.py"), "预览入口不能直接调用打包器");
  assert.ok(preview.includes("闸门尚未分配版本"), "预览 CLI 失败必须在版本分配前拦截");
  assert.ok(deploy.includes("ReleaseContext") && deploy.includes("ReleaseGateLockHeld"), "云部署必须接收 release context 和外层锁");
  assert.ok(entry.includes("DeployLockPath"), "闸门调用云部署时必须传递共享锁路径");
  assert.ok(entry.includes("旧 clone/worktree"), "旧 clone/worktree 必须被发布入口拒绝");
  assert.ok(protection.includes("release-gate") && protection.includes("allow_force_pushes") && protection.includes("allow_deletions"), "主分支保护必须锁定 release-gate、禁止强推和删除");
}

function testIncludePathNormalization() {
  const script = [
    `. ${quote(gateScript)}`,
    "$a = @(Normalize-ReleaseIncludePaths -InputPath @('pages/a.js'))",
    "$b = @(Normalize-ReleaseIncludePaths -InputPath @('pages/a.js,pages/b.js'))",
    "if ($a.Count -ne 1 -or $a[0] -ne 'pages/a.js') { throw 'single path failed' }",
    "if ($b.Count -ne 2 -or $b[1] -ne 'pages/b.js') { throw 'comma compatibility failed' }",
    "try { Normalize-ReleaseIncludePaths -InputPath @('pages/a.js,,pages/b.js') | Out-Null; throw 'empty item accepted' } catch { if ($_.Exception.Message -notmatch '空项') { throw } }",
    "try { Normalize-ReleaseIncludePaths -InputPath @('../outside.js') | Out-Null; throw 'parent path accepted' } catch { if ($_.Exception.Message -notmatch '安全') { throw } }",
    "try { Normalize-ReleaseIncludePaths -InputPath @('project.private.config.json') | Out-Null; throw 'private config accepted' } catch { if ($_.Exception.Message -notmatch '敏感') { throw } }",
    "Write-Output 'INCLUDE_OK'",
  ].join("; ");
  const result = runPowerShell(script);
  assertPowerShellOk(result, "IncludePath 规范化");
  assert.ok(result.stdout.includes("INCLUDE_OK"));
}

function testIdentityDerivation() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-identity-"));
  try {
    const result = runPowerShell([
      `. ${quote(gateScript)}`,
      `New-Item -ItemType Directory -Path ${quote(temp)} -Force | Out-Null`,
      `git -C ${quote(temp)} init -b main | Out-Null`,
      `git -C ${quote(temp)} config user.name 'release smoke'`,
      `git -C ${quote(temp)} config user.email '你的GitHub邮箱'`,
      `$identity = Resolve-ReleaseIdentity -WorkingDirectory ${quote(temp)} -RemoteUrl 'https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git'`,
      `if ($identity.Email -ne 'ssqaq@users.noreply.github.com') { throw $identity.Email }`,
      "Write-Output 'IDENTITY_OK'",
    ].join("; "));
    assertPowerShellOk(result, "Git identity 推导");
    assert.ok(result.stdout.includes("IDENTITY_OK"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

testFilesAndPolicy();
testStaticContracts();
testIncludePathNormalization();
testIdentityDerivation();
console.log("release gate smoke: OK");
