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
const qrDecodeScript = path.join(root, "scripts", "qr-decode.js");
const qrDecodeSmokeScript = path.join(root, "scripts", "qr-decode-smoke.js");
const pixelManifest = path.join(root, "visual-evidence", "admin-v2-pixel-manifest.json");
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
  assert.ok(fs.existsSync(qrDecodeScript), "qr-decode.js 不存在");
  assert.ok(fs.existsSync(qrDecodeSmokeScript), "qr-decode-smoke.js 不存在");
  assert.ok(fs.existsSync(pixelManifest), "四页像素基线 manifest 不存在");
  assert.ok(fs.existsSync(policyPath), "外部发布策略不存在");
  for (const file of [gateScript, entryScript, previewScript, deployScript, protectionScript, resumeScript, qrDecodeScript, qrDecodeSmokeScript, pixelManifest]) {
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
  for (const key of ["lockPath", "artifactRoot", "reservationRoot", "worktreeRoot", "contextRoot", "logRoot", "archiveManifestPath", "reportRoot", "backupRoot", "alertRoot", "latestReleasePath"]) {
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
    reportRoot: path.join(expectedParent, "wechat-miniapp-release-reports"),
    backupRoot: path.join(expectedParent, "wechat-miniapp-release-backups"),
    alertRoot: path.join(expectedParent, "wechat-miniapp-release-logs", "alerts"),
    latestReleasePath: path.join(expectedParent, "wechat-miniapp-latest-release.json"),
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
    "Invoke-ReleasePreviewImport",
    "Resolve-ReleaseDevToolsCli",
    "open_project_window",
    "simulator_refresh",
    "project_import",
    "未返回可解析的 JSON",
    "返回待确认任务",
    "Write-ReleaseImmutableFile",
  ]) {
    assert.ok(gate.includes(marker) || entry.includes(marker), `发布闸门缺少 ${marker}`);
  }
  assert.ok(entry.includes("[switch]$PrepareOnly"), "发布必须支持显式只准备模式");
  assert.ok(entry.includes("$effectivePublish"), "发布默认行为必须计算自动发布状态");
  assert.ok(entry.includes("$effectivePreview"), "发布默认行为必须计算自动开发者工具同步状态");
  assert.ok(entry.includes("--release-context"), "正式打包必须使用 release context");
  assert.ok(entry.includes('"scripts/release-lock-smoke.js"'), "发布工具快照必须包含锁 smoke");
  assert.ok(entry.includes('"scripts/version-concurrency-smoke.js"'), "发布工具快照必须包含版本并发 smoke");
  assert.ok(entry.includes('"scripts/resume-release-smoke.js"'), "发布工具快照必须包含恢复 smoke");
  assert.ok(entry.includes('"scripts/cloud-deploy-safety-smoke.js"'), "发布工具快照必须包含 Cloud 快照 smoke");
  assert.ok(entry.includes('"scripts/deployment-script-smoke.js"'), "发布工具快照必须包含部署 smoke");
  assert.ok(entry.includes('"scripts/release-report.ps1"'), "发布工具快照必须包含验收报告");
  assert.ok(entry.includes('"scripts/qr-decode.js"'), "发布工具快照必须包含二维码解码脚本");
  assert.ok(entry.includes('"scripts/qr-decode-smoke.js"'), "发布工具快照必须包含二维码 smoke");
  assert.ok(entry.includes('"scripts/vendor/qrcode-reader.js"'), "发布工具快照必须包含二维码解码器");
  assert.ok(entry.includes('"scripts/admin-v2-pixel-baseline.js"'), "发布工具快照必须包含四页像素基线脚本");
  assert.ok(gate.includes("二维码真实解码失败"), "验收报告必须执行真实二维码解码");
  assert.ok(entry.includes('"scripts/rollback-release.ps1"'), "发布工具快照必须包含回滚入口");
  assert.ok(entry.includes('"scripts/release-maintenance.ps1"'), "发布工具快照必须包含 reservation 维护");
  assert.ok(entry.includes('"scripts/install-git-hooks.ps1"'), "发布工具快照必须包含 Git hooks 安装器");
  assert.ok(entry.includes('"scripts/write-release-record.ps1"'), "发布工具快照必须包含旧记录入口封锁");
  assert.ok(entry.includes('"一键刷新预览.cmd"'), "发布工具快照必须包含一键预览入口");
  assert.ok(entry.includes('preview-import'), "正式预览必须先导入微信开发者工具");
  assert.ok(!entry.includes("push origin \"HEAD:main\""), "闸门不能直接 push main");
  assert.ok(gate.indexOf("auth status") < gate.indexOf("push origin"), "GitHub 认证检查必须先于推送 release 分支");
  assert.ok(entry.indexOf("Test-ReleaseGitHubProtection") < entry.indexOf("New-ReleaseQueueTicket"), "正式发布保护预检必须先于创建队列票据");
  assert.ok(resume.indexOf("Test-ReleaseGitHubProtection") < resume.indexOf("Claim-ReleaseQueueTicket"), "恢复发布保护预检必须先于领取队列租约");
  assert.ok(preview.includes("release.ps1"), "预览入口必须转发到统一闸门");
  assert.ok(!preview.includes("package-release.py"), "预览入口不能直接调用打包器");
  assert.ok(preview.includes("PrepareOnly"), "预览入口必须显式使用只准备模式，避免失败时分配版本");
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

function testReceiptDictionaryAccess() {
  const result = runPowerShell([
    `. ${quote(gateScript)}`,
    `$receipt = [ordered]@{ status = 'imported'; onlineBuildMarker = 'API_BUILD_TAG_AUTO_VERSION_V00001' }`,
    `if ((Get-ReleaseReceiptField $receipt 'status') -ne 'imported') { throw 'ordered receipt status unreadable' }`,
    `if ((Get-ReleaseReceiptField $receipt 'onlineBuildMarker') -notmatch '^API_BUILD_TAG_') { throw 'ordered receipt marker unreadable' }`,
    "Write-Output 'RECEIPT_DICTIONARY_OK'",
  ].join("; "));
  assertPowerShellOk(result, "有序回执字段读取");
  assert.ok(result.stdout.includes("RECEIPT_DICTIONARY_OK"));
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

function testImmutableBinary() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-immutable-"));
  const source = path.join(temp, "source.tmp");
  const destination = path.join(temp, "artifact.bin");
  try {
    fs.writeFileSync(source, Buffer.from("same-bytes"));
    const first = runPowerShell([
      `. ${quote(gateScript)}`,
      `$r = Write-ReleaseImmutableFile -SourcePath ${quote(source)} -DestinationPath ${quote(destination)}`,
      `if ($r.Status -ne 'created') { throw "first status=$($r.Status)" }`,
      `if (-not (Test-Path -LiteralPath ${quote(destination)} -PathType Leaf)) { throw 'destination missing' }`,
      `Write-Output 'IMMUTABLE_CREATE_OK'`,
    ].join("; "));
    assertPowerShellOk(first, "不可变二进制首次落盘");
    assert.ok(first.stdout.includes("IMMUTABLE_CREATE_OK"));
    const secondSource = path.join(temp, "source2.tmp");
    fs.writeFileSync(secondSource, Buffer.from("same-bytes"));
    const second = runPowerShell([
      `. ${quote(gateScript)}`,
      `$r = Write-ReleaseImmutableFile -SourcePath ${quote(secondSource)} -DestinationPath ${quote(destination)}`,
      `if ($r.Status -ne 'reused') { throw "second status=$($r.Status)" }`,
      `Write-Output 'IMMUTABLE_REUSE_OK'`,
    ].join("; "));
    assertPowerShellOk(second, "不可变二进制幂等复用");
    assert.ok(second.stdout.includes("IMMUTABLE_REUSE_OK"));
    const conflictSource = path.join(temp, "source3.tmp");
    fs.writeFileSync(conflictSource, Buffer.from("different-bytes"));
    const conflict = runPowerShell([
      `. ${quote(gateScript)}`,
      `try { Write-ReleaseImmutableFile -SourcePath ${quote(conflictSource)} -DestinationPath ${quote(destination)} | Out-Null; throw 'different bytes accepted' } catch { if ($_.Exception.Message -notmatch '内容不同') { throw } }`,
      `Write-Output 'IMMUTABLE_CONFLICT_OK'`,
    ].join("; "));
    assertPowerShellOk(conflict, "不可变二进制冲突");
    assert.ok(conflict.stdout.includes("IMMUTABLE_CONFLICT_OK"));
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
testReceiptDictionaryAccess();
testIdentityDerivation();
testImmutableBinary();
testMainCommitContainment();
console.log("release gate smoke: OK");
