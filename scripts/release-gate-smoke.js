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
const resumeScript = path.join(root, "scripts", "resume-release.ps1");
const policyCandidates = [
  process.env.MINIPROGRAM_RELEASE_POLICY,
  path.resolve(root, "..", "wechat-miniapp-release-policy.json"),
  path.resolve(root, "..", "..", "wechat-miniapp-release-policy.json"),
].filter(Boolean).map((candidate) => path.resolve(candidate));
const policyPath = policyCandidates.find((candidate) => fs.existsSync(candidate)) || policyCandidates[0];

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
  assert.ok(fs.existsSync(resumeScript), "resume-release.ps1 不存在");
  assert.ok(fs.existsSync(policyPath), "外部发布策略不存在");
  for (const file of [gateScript, entryScript, previewScript, deployScript, protectionScript, resumeScript]) {
    assertNoInteriorBom(file, path.basename(file));
  }
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.strictEqual(policy.schemaVersion, 1);
  const canonicalRoot = path.resolve(policy.canonicalRepo);
  const relativeToCanonicalParent = path.relative(path.dirname(canonicalRoot), root);
  const isolatedWorktree = relativeToCanonicalParent &&
    relativeToCanonicalParent.toLowerCase().startsWith("wechat-miniapp-release-worktrees" + path.sep);
  assert.ok(
    canonicalRoot.toLowerCase() === root.toLowerCase() || isolatedWorktree,
    `当前测试目录既不是 canonical 也不是其隔离发布 worktree：${root}`
  );
  assert.strictEqual(policy.branch, "main");
  assert.ok(policy.remote.includes("github.com/ssqaq/"));
  for (const key of ["lockPath", "artifactRoot", "reservationRoot", "worktreeRoot", "contextRoot", "logRoot", "archiveManifestPath"]) {
    assert.ok(policy[key], `策略缺少 ${key}`);
  }
  const expectedParent = path.dirname(canonicalRoot);
  const expectedPaths = {
    lockPath: path.join(expectedParent, "wechat-miniapp-release.lock"),
    artifactRoot: expectedParent,
    reservationRoot: path.join(expectedParent, "wechat-miniapp-release-reservations"),
    worktreeRoot: path.join(expectedParent, "wechat-miniapp-release-worktrees"),
    recordRoot: path.join(expectedParent, "wechat-miniapp-release-records"),
    contextRoot: path.join(expectedParent, "wechat-miniapp-release-contexts"),
    logRoot: path.join(expectedParent, "wechat-miniapp-release-logs"),
    queueRoot: path.join(expectedParent, "wechat-miniapp-release-queue"),
    archiveManifestPath: path.join(expectedParent, "wechat-miniapp-release-archive.json"),
  };
  assert.strictEqual(path.resolve(policyPath).toLowerCase(), path.resolve(path.join(expectedParent, "wechat-miniapp-release-policy.json")).toLowerCase(), "策略文件不是固定唯一路径");
  for (const [key, expected] of Object.entries(expectedPaths)) {
    assert.strictEqual(path.resolve(policy[key]).toLowerCase(), path.resolve(expected).toLowerCase(), `策略 ${key} 不是固定唯一路径`);
  }
  assert.strictEqual(policy.remote.replace(/\/$/, "").toLowerCase(), "https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git");
  assert.strictEqual(policy.mainProtection.mode, "pr-only");
  assert.strictEqual(policy.queue.waitSeconds, 1800);
}

function testStaticContracts() {
  const gate = fs.readFileSync(gateScript, "utf8");
  const entry = fs.readFileSync(entryScript, "utf8");
  const preview = fs.readFileSync(previewScript, "utf8");
  const deploy = fs.readFileSync(deployScript, "utf8");
  const protection = fs.readFileSync(protectionScript, "utf8");
  const resume = fs.readFileSync(resumeScript, "utf8");
  for (const marker of [
    "Normalize-ReleaseIncludePaths",
    "New-ReleaseReservation",
    "Get-ReleaseUsedVersions",
    "Resolve-ReleaseIdentity",
    "New-ReleaseContext",
    "Invoke-ReleasePullRequest",
    "FileSnapshotStable",
    "release/$target-$operationId",
    "refs/heads/$Branch",
    "pr checks",
    "--fail-fast",
    "headRefOid",
    "Assert-ReleasePullRequestHead",
    "baseRefName",
    "Assert-ReleasePullRequestBase",
    "Assert-ReleaseMainContainsCommit",
    "refs/heads/main:refs/remotes/origin/main",
    "merge-base --is-ancestor",
    "status = \"merged\"",
    "mainCommit",
    "checkDeadline",
    "no checks reported",
    "Start-Sleep -Seconds 5",
  ]) {
    assert.ok(gate.includes(marker) || entry.includes(marker), `发布闸门缺少 ${marker}`);
  }
  assert.ok(entry.includes("[switch]$Publish"), "发布必须显式 -Publish");
  assert.ok(entry.includes("--release-context"), "正式打包必须使用 release context");
  assert.ok(!entry.includes("push origin \"HEAD:main\""), "闸门不能直接 push main");
  assert.ok(gate.indexOf("auth status") < gate.indexOf("push origin"), "GitHub 认证检查必须先于推送 release 分支");
  assert.ok(entry.indexOf("Test-ReleaseGitHubProtection") < entry.indexOf("New-ReleaseQueueTicket"), "正式发布保护预检必须先于创建队列票据");
  assert.ok(resume.indexOf("Test-ReleaseGitHubProtection") < resume.indexOf("Claim-ReleaseQueueTicket"), "恢复发布保护预检必须先于领取队列租约");
  assert.ok(preview.includes("release.ps1"), "预览入口必须转发到统一闸门");
  assert.ok(!preview.includes("package-release.py"), "预览入口不能直接调用打包器");
  assert.ok(preview.includes("闸门尚未分配版本"), "预览 CLI 失败必须在版本分配前拦截");
  assert.ok(deploy.includes("ReleaseContext") && deploy.includes("ReleaseGateLockHeld"), "云部署必须接收 release context 和外层锁");
  assert.ok(entry.includes("DeployLockPath"), "闸门调用云部署时必须传递共享锁路径");
  assert.ok(entry.includes("旧 clone/worktree"), "旧 clone/worktree 必须被发布入口拒绝");
  assert.ok(protection.includes("release-gate") && protection.includes("allow_force_pushes") && protection.includes("allow_deletions"), "主分支保护必须锁定 release-gate、禁止强推和删除");
  assert.ok(protection.includes("required_approving_review_count = 0"), "自动合并发布不能被人工审批要求卡住");
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
      `$beforeEmail = (git -C ${quote(temp)} config --local --get user.email | Out-String).Trim()`,
      `$identity = Resolve-ReleaseIdentity -WorkingDirectory ${quote(temp)} -RemoteUrl 'https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git'`,
      `if ($identity.Email -ne 'ssqaq@users.noreply.github.com') { throw $identity.Email }`,
      `$afterEmail = (git -C ${quote(temp)} config --local --get user.email | Out-String).Trim()`,
      `if ($afterEmail -ne $beforeEmail) { throw 'Resolve-ReleaseIdentity mutated shared git config' }`,
      `Set-Content -LiteralPath ${quote(path.join(temp, "identity.txt"))} -Value 'identity' -Encoding UTF8`,
      `git -C ${quote(temp)} add identity.txt`,
      `git -C ${quote(temp)} -c ("user.name=" + $identity.Name) -c ("user.email=" + $identity.Email) commit -m identity | Out-Null`,
      `$commitEmail = (git -C ${quote(temp)} log -1 --format='%ae').Trim()`,
      `if ($commitEmail -ne $identity.Email) { throw "per-commit identity failed: $commitEmail" }`,
      "Write-Output 'IDENTITY_OK'",
    ].join("; "));
    assertPowerShellOk(result, "Git identity 推导");
    assert.ok(result.stdout.includes("IDENTITY_OK"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function testMainCommitContainment() {
  // Build a tiny local bare remote to exercise the exact squash-merge case.
  // In a squash merge releaseCommit is not an ancestor of main; the PR's
  // mergeCommit is.  The gate must accept that relation only after the
  // headRefOid binding has been checked by Invoke-ReleasePullRequest.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-main-"));
  const bare = path.join(temp, "origin.git");
  const repo = path.join(temp, "repo");
  try {
    const command = [
      `. ${quote(gateScript)}`,
      `New-Item -ItemType Directory -Path ${quote(temp)} -Force | Out-Null`,
      `git init --bare ${quote(bare)} | Out-Null`,
      `git init -b main ${quote(repo)} | Out-Null`,
      `git -C ${quote(repo)} config user.name 'release smoke'`,
      `git -C ${quote(repo)} config user.email 'release@example.com'`,
      `Set-Content -LiteralPath ${quote(path.join(repo, "version.txt"))} -Value 'base' -Encoding utf8`,
      `git -C ${quote(repo)} add version.txt`,
      `git -C ${quote(repo)} commit -m base | Out-Null`,
      `git -C ${quote(repo)} remote add origin ${quote(bare)}`,
      `git -C ${quote(repo)} push -u origin main | Out-Null`,
      `git -C ${quote(repo)} checkout -b release/test | Out-Null`,
      `Set-Content -LiteralPath ${quote(path.join(repo, "version.txt"))} -Value 'release' -Encoding utf8`,
      `git -C ${quote(repo)} commit -am release | Out-Null`,
      `$release = (git -C ${quote(repo)} rev-parse HEAD).Trim()`,
      `git -C ${quote(repo)} checkout main | Out-Null`,
      `Set-Content -LiteralPath ${quote(path.join(repo, "version.txt"))} -Value 'release' -Encoding utf8`,
      `git -C ${quote(repo)} commit -am squash | Out-Null`,
      `$merge = (git -C ${quote(repo)} rev-parse HEAD).Trim()`,
      `git -C ${quote(repo)} push origin main | Out-Null`,
      `$check = Assert-ReleaseMainContainsCommit -RepositoryRoot ${quote(repo)} -ReleaseCommit $release -MergeCommit $merge`,
      `if ($check.relation -ne 'pr-merge-ancestor') { throw "unexpected relation: $($check.relation)" }`,
      `try { Assert-ReleasePullRequestHead -PullRequest ([pscustomobject]@{ headRefOid = ('0' * 40) }) -CommitSha $release | Out-Null; throw 'head mismatch accepted' } catch { if ($_.Exception.Message -notmatch '不一致') { throw } }`,
      `try { Assert-ReleasePullRequestBase -PullRequest ([pscustomobject]@{ baseRefName = 'develop' }) -ExpectedBase 'main' | Out-Null; throw 'base mismatch accepted' } catch { if ($_.Exception.Message -notmatch '不是受保护目标分支') { throw } }`,
      `Write-Output 'MAIN_CONTAINMENT_OK'`,
    ].join("; ");
    const result = runPowerShell(command);
    assertPowerShellOk(result, "origin/main 合并完整性");
    assert.ok(result.stdout.includes("MAIN_CONTAINMENT_OK"));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

testFilesAndPolicy();
testStaticContracts();
testIncludePathNormalization();
testIdentityDerivation();
testMainCommitContainment();
console.log("release gate smoke: OK");
