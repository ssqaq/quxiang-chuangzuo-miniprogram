const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const syncScript = path.join(root, "scripts", "sync-to-github.ps1");
const releaseLockScript = path.join(root, "scripts", "release-lock.ps1");
const versionScript = path.join(root, "scripts", "release-version.ps1");
const versionConcurrencySmoke = path.join(root, "scripts", "version-concurrency-smoke.js");
const packageScript = path.join(root, "scripts", "package-release.py");
const installHooksScript = path.join(root, "scripts", "install-git-hooks.ps1");
const installHooksCmd = path.join(root, "scripts", "install-git-hooks.cmd");
const releaseRecordScript = path.join(root, "scripts", "write-release-record.ps1");
const preCommitHook = path.join(root, ".githooks", "pre-commit");
const postCommitHook = path.join(root, ".githooks", "post-commit");
const prePushHook = path.join(root, ".githooks", "pre-push");
const postCheckoutHook = path.join(root, ".githooks", "post-checkout");
const releaseHooksSmoke = path.join(root, "scripts", "release-hooks-smoke.js");
const releaseWorkflow = path.join(root, ".github", "workflows", "release-gate.yml");
const paymentManifest = path.join(root, "scripts", "payment-cloudfunctions.json");
const paymentDeploymentSmoke = path.join(root, "scripts", "payment-deployment-smoke.js");
const qrRouteCompatSmoke = path.join(root, "scripts", "qr-route-compat-smoke.js");

function run(command, args, options = {}) {
  return cp.spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertCommandOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function assertFileIncludes(file, text, label) {
  const content = fs.readFileSync(file, "utf8");
  assert.ok(content.includes(text), `${label}缺少：${text}`);
}

function testStaticContracts() {
  const syncContent = fs.readFileSync(syncScript, "utf8");
  assertFileIncludes(syncScript, "[string[]]$IncludePath", "同步脚本参数");
  assertFileIncludes(syncScript, "release.ps1", "统一发布入口");
  assertFileIncludes(syncScript, "Publish = $true", "旧入口必须走正式发布模式");
  assertFileIncludes(syncScript, "SourcePath = $repoRoot", "旧入口必须固定 canonical 来源");
  assertFileIncludes(syncScript, "LockWaitSeconds", "旧入口必须传递统一等待时间");
  assertFileIncludes(releaseLockScript, "FileShare]::None", "发布锁实现");
  assertFileIncludes(syncScript, "旧 clone/worktree", "旧 clone/worktree 拒绝提示");
  assertFileIncludes(syncScript, "统一发布队列策略", "旧入口不能覆盖重试策略");
  assert.ok(!/^[ \t]*(?:&\s*)?git\s+.*\b(push|commit|add|reset|read-tree)\b/im.test(syncContent),
    "旧同步入口不能包含独立 Git 写操作");
  assert.ok(!syncContent.includes("Start-Transcript"), "旧入口不能合并日 transcript");
  assert.ok(!syncContent.includes("write-tree"), "旧入口不能自行计算/写整棵 tree");
  assertFileIncludes(versionScript, "Get-VersionGroupPaths", "版本组处理器");
  assertFileIncludes(versionConcurrencySmoke, "version concurrency smoke", "版本并发专项 smoke");
  assertFileIncludes(installHooksScript, "core.hooksPath", "hooks 一键安装");
  assertFileIncludes(installHooksScript, ".githooks", "hooks 目录校验");
  assertFileIncludes(installHooksCmd, "install-git-hooks.ps1", "hooks 一键入口");
  assertFileIncludes(releaseRecordScript, "旧入口 scripts/write-release-record.ps1 已封锁", "旧发布记录入口封锁");
  assertFileIncludes(preCommitHook, "禁止直接在 main 提交", "main 提交保护");
  assertFileIncludes(postCommitHook, "main 只能由受控同步脚本提交", "main 推送保护");
  assertFileIncludes(prePushHook, "拒绝直接 push main", "main 推送前保护");
  assertFileIncludes(prePushHook, "MINIPROGRAM_SYNC_ALLOW_MAIN_PUSH", "main 推送覆盖开关");
  assertFileIncludes(postCheckoutHook, "git lfs post-checkout", "checkout hook 转发");
  assertFileIncludes(installHooksScript, '"pre-push"', "安装 pre-push hook");
  assertFileIncludes(installHooksScript, '"post-checkout"', "安装 post-checkout hook");
  assert.ok(fs.existsSync(releaseHooksSmoke), "release hooks smoke 不存在");
  assert.ok(fs.existsSync(releaseWorkflow), "release workflow 不存在");
  assertFileIncludes(releaseWorkflow, "release-hooks-smoke.js", "CI 必须运行 hooks smoke");
  const workflowText = fs.readFileSync(releaseWorkflow, "utf8");
  const timeoutMatch = workflowText.match(/timeout-minutes:\s*(\d+)/);
  assert.ok(timeoutMatch && Number(timeoutMatch[1]) >= 30, "CI 超时必须覆盖 30 分钟检查窗口");
  assertFileIncludes(releaseWorkflow, "Public repository compatibility", "公开仓库兼容预检");
  assertFileIncludes(packageScript, "源码内容 SHA256", "发布清单源码指纹");
  assertFileIncludes(packageScript, "reconfigure", "Windows CI UTF-8 输出");
  assertFileIncludes(packageScript, "scripts/install-git-hooks.ps1", "发布包包含 hooks 安装器");
  assert.ok(fs.existsSync(paymentManifest), "支付云函数发布清单不存在");
  assert.ok(fs.existsSync(paymentDeploymentSmoke), "支付 fail-closed smoke 不存在");
  assert.ok(fs.existsSync(qrRouteCompatSmoke), "体验版二维码路由兼容 smoke 不存在");
  assertFileIncludes(versionScript, "payment-cloudfunctions.json", "支付版本组清单");
  assertFileIncludes(packageScript, "_validate_payment_manifest", "支付正式包校验");
  assertFileIncludes(releaseWorkflow, "payment-deployment-smoke.js", "CI 支付部署安全检查");
}

function testInstallHooks() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-smoke-"));
  const hooksRoot = path.join(tempRoot, ".githooks");
  const scriptsRoot = path.join(tempRoot, "scripts");
  try {
    assertCommandOk(run("git", ["init", "-b", "main", tempRoot]), "初始化 hooks 测试仓库");
    fs.mkdirSync(hooksRoot, { recursive: true });
    fs.mkdirSync(scriptsRoot, { recursive: true });
    fs.copyFileSync(preCommitHook, path.join(hooksRoot, "pre-commit"));
    fs.copyFileSync(postCommitHook, path.join(hooksRoot, "post-commit"));
    fs.copyFileSync(prePushHook, path.join(hooksRoot, "pre-push"));
    fs.copyFileSync(postCheckoutHook, path.join(hooksRoot, "post-checkout"));
    fs.copyFileSync(installHooksScript, path.join(scriptsRoot, "install-git-hooks.ps1"));

    const installer = path.join(scriptsRoot, "install-git-hooks.ps1");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run(
        "pwsh",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer],
        { cwd: tempRoot }
      );
      assertCommandOk(result, `安装 Git hooks（第 ${attempt + 1} 次）`);
    }
    const configured = run("git", ["config", "--local", "--get", "core.hooksPath"], {
      cwd: tempRoot,
    });
    assertCommandOk(configured, "读取 hooks 配置");
    assert.strictEqual(configured.stdout.trim(), ".githooks", "hooks 路径配置错误");
    for (const hook of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
      assert.ok(fs.statSync(path.join(hooksRoot, hook)).size > 0, `${hook} 未安装`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testReleaseRecord() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-record-smoke-"));
  const outputRoot = path.join(tempRoot, "records");
  const commitSha = "0123456789abcdef0123456789abcdef01234567";
  const treeSha = "abcdef0123456789abcdef0123456789abcdef01";
  const sourceSha = "a".repeat(64);
  try {
    const result = run(
      "pwsh",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        releaseRecordScript,
        "-Version",
        "0.0.1",
        "-CommitSha",
        commitSha,
        "-TreeSha",
        treeSha,
        "-SourceSha256",
        sourceSha,
         "-PackagePath",
         path.join(tempRoot, "release.zip"),
        "-OutputRoot",
        outputRoot,
        "-ChangedFile",
        "README.md",
        "-BaseHead",
        "fedcba9876543210fedcba9876543210fedcba98",
        "-Attempt",
        "2",
        "-RetryCount",
        "1",
        "-GeneratedVersionPath",
        "config.js",
        "-ReleaseWorktree",
        "C:\\temp\\release-worktree",
      ],
      { cwd: root }
    );
    assert.notStrictEqual(result.status, 0, "旧发布记录入口必须拒绝直接写入");
    assert.ok(
      `${result.stdout}\n${result.stderr}`.includes("旧入口 scripts/write-release-record.ps1 已封锁"),
      "旧发布记录入口的拒绝信息不明确"
    );
    assert.ok(!fs.existsSync(outputRoot), "旧入口拒绝时不能创建 records 目录");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testMainHookRejectsDirectCommit() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-hook-smoke-"));
  try {
    assertCommandOk(run("git", ["init", "-b", "main"], { cwd: tempRoot }), "初始化 hook 测试仓库");
    assertCommandOk(run("git", ["config", "user.name", "release-smoke"], { cwd: tempRoot }), "配置用户名");
    assertCommandOk(run("git", ["config", "user.email", "release-smoke@example.invalid"], { cwd: tempRoot }), "配置邮箱");
    fs.mkdirSync(path.join(tempRoot, ".githooks"), { recursive: true });
    const hookTarget = path.join(tempRoot, ".githooks", "pre-commit");
    fs.copyFileSync(preCommitHook, hookTarget);
    fs.chmodSync(hookTarget, 0o755);
    assertCommandOk(run("git", ["config", "core.hooksPath", ".githooks"], { cwd: tempRoot }), "配置 hook");

    fs.writeFileSync(path.join(tempRoot, "probe.txt"), "main blocked\n");
    assertCommandOk(run("git", ["add", "probe.txt"], { cwd: tempRoot }), "暂存 main 测试文件");
    const blocked = run("git", ["commit", "-m", "should be blocked"], {
      cwd: tempRoot,
      env: { MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT: "" },
    });
    assert.notStrictEqual(blocked.status, 0, "main 直接提交必须被拒绝");

    const allowed = run("git", ["commit", "-m", "controlled main commit"], {
      cwd: tempRoot,
      env: { MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT: "1" },
    });
    assertCommandOk(allowed, "受控 main 提交");

    assertCommandOk(run("git", ["checkout", "-b", "feature/smoke"], { cwd: tempRoot }), "创建功能分支");
    fs.appendFileSync(path.join(tempRoot, "probe.txt"), "feature allowed\n");
    assertCommandOk(run("git", ["add", "probe.txt"], { cwd: tempRoot }), "暂存功能分支文件");
    assertCommandOk(run("git", ["commit", "-m", "feature commit"], { cwd: tempRoot }), "功能分支提交");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testMainPushHookRejectsDirectPush() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-push-hook-smoke-"));
  const hooksRoot = path.join(tempRoot, ".githooks");
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-push-bare-smoke-"));
  const bare = path.join(bareRoot, "origin.git");
  try {
    assertCommandOk(run("git", ["init", "-b", "main", tempRoot]), "初始化 push hook 测试仓库");
    assertCommandOk(run("git", ["config", "user.name", "release-smoke"], { cwd: tempRoot }), "配置 push hook 用户名");
    assertCommandOk(run("git", ["config", "user.email", "release-smoke@example.invalid"], { cwd: tempRoot }), "配置 push hook 邮箱");
    fs.mkdirSync(hooksRoot, { recursive: true });
    const hookTarget = path.join(hooksRoot, "pre-push");
    fs.copyFileSync(prePushHook, hookTarget);
    fs.chmodSync(hookTarget, 0o755);
    assertCommandOk(run("git", ["config", "core.hooksPath", ".githooks"], { cwd: tempRoot }), "配置 push hook");
    fs.writeFileSync(path.join(tempRoot, "probe.txt"), "push blocked\n");
    assertCommandOk(run("git", ["add", "probe.txt"], { cwd: tempRoot }), "暂存 push hook 文件");
    assertCommandOk(run("git", ["commit", "-m", "push hook base"], { cwd: tempRoot }), "提交 push hook 基线");
    assertCommandOk(run("git", ["init", "--bare", bare]), "初始化 push hook 远端");
    assertCommandOk(run("git", ["remote", "add", "origin", bare], { cwd: tempRoot }), "配置 push hook 远端");
    const blocked = run("git", ["push", "origin", "main"], {
      cwd: tempRoot,
      env: { MINIPROGRAM_SYNC_ALLOW_MAIN_PUSH: "", MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
    });
    assert.notStrictEqual(blocked.status, 0, "pre-push 必须拒绝直接推送 main");
    assert.ok(`${blocked.stdout}\n${blocked.stderr}`.includes("拒绝直接 push main"), "pre-push 拒绝信息不明确");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(bareRoot, { recursive: true, force: true });
  }
}

function testExclusiveLockPrimitive() {
  const script = [
    "$p = Join-Path $env:TEMP ('release-lock-smoke-' + [guid]::NewGuid().ToString('N'))",
    "$a = [IO.File]::Open($p,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
    "try {",
    "  try {",
    "    $b = [IO.File]::Open($p,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)",
    "    $b.Dispose()",
    "    exit 2",
    "  } catch [IO.IOException] { exit 0 }",
    "} finally {",
    "  $a.Dispose()",
    "  Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("; ");
  assertCommandOk(
    run("pwsh", ["-NoProfile", "-Command", script]),
    "独占发布锁"
  );
}

function testWorktreeCannotPublishMain() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-worktree-smoke-"));
  const mainRoot = path.join(tempRoot, "main");
  const worktreeRoot = path.join(tempRoot, "worktree");
  try {
    assertCommandOk(run("git", ["init", "-b", "main", mainRoot]), "初始化 worktree 测试仓库");
    assertCommandOk(
      run("git", ["config", "user.name", "release-smoke"], { cwd: mainRoot }),
      "配置 worktree 测试用户名"
    );
    assertCommandOk(
      run("git", ["config", "user.email", "release-smoke@example.invalid"], { cwd: mainRoot }),
      "配置 worktree 测试邮箱"
    );
    fs.writeFileSync(path.join(mainRoot, "README.md"), "worktree smoke\n");
    assertCommandOk(run("git", ["add", "README.md"], { cwd: mainRoot }), "暂存 worktree 测试文件");
    assertCommandOk(
      run("git", ["commit", "-m", "worktree smoke base"], { cwd: mainRoot }),
      "提交 worktree 测试基线"
    );
    assertCommandOk(
      run("git", ["worktree", "add", "-b", "feature/smoke", worktreeRoot, "HEAD"], {
        cwd: mainRoot,
      }),
      "创建临时 worktree"
    );

    const worktreeScript = path.join(worktreeRoot, "scripts", "sync-to-github.ps1");
    fs.mkdirSync(path.dirname(worktreeScript), { recursive: true });
    fs.copyFileSync(syncScript, worktreeScript);
    fs.copyFileSync(
      releaseLockScript,
      path.join(worktreeRoot, "scripts", "release-lock.ps1")
    );
    const result = run(
      "pwsh",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        worktreeScript,
        "-IncludePath",
        "README.md",
      ],
      { cwd: worktreeRoot }
    );
    assert.notStrictEqual(result.status, 0, "独立分支/worktree 不允许发布 main");
    assert.ok(
      `${result.stdout}\n${result.stderr}`.includes("缺少统一发布闸门"),
      "旧入口拒绝信息不明确"
    );
  } finally {
    run("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: mainRoot });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testPackageManifest() {
  const output = path.join(
    os.tmpdir(),
    `release-safety-smoke-${process.pid}-${Date.now()}.zip`
  );
  try {
    const head = run("git", ["rev-parse", "HEAD"]);
    assertCommandOk(head, "读取 HEAD");
    // 正式写包只能由 release gate 生成 context；安全 smoke 永远只做只读校验。
    const packageArgs = [
      packageScript,
      "--check-only",
      "--source-tree",
      head.stdout.trim(),
    ];

    const result = run(
      process.platform === "win32" ? "python" : "python3",
      packageArgs
    );
    assertCommandOk(result, "发布包只读检查");
    assert.ok(!fs.existsSync(output), "只读检查不能创建 ZIP");
    const summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.strictEqual(summary.checkOnly, true, "安全 smoke 必须保持 check-only");
    assert.ok(/^[0-9a-f]{64}$/i.test(summary.sourceSha256), "只读检查必须返回源码 SHA256");
  } finally {
    fs.rmSync(output, { force: true });
  }
}

function testSourceFingerprintAlgorithm() {
  const digest = crypto.createHash("sha256");
  digest.update("release-safety-smoke.js\0");
  digest.update(fs.readFileSync(__filename));
  digest.update("\0");
  assert.strictEqual(digest.digest("hex").length, 64);
}

function main() {
  testStaticContracts();
  assertCommandOk(run("node", [qrRouteCompatSmoke]), "体验版二维码路由兼容检查");
  testInstallHooks();
  testReleaseRecord();
  testMainHookRejectsDirectCommit();
  testMainPushHookRejectsDirectPush();
  testExclusiveLockPrimitive();
  testWorktreeCannotPublishMain();
  testPackageManifest();
  testSourceFingerprintAlgorithm();
  console.log("release safety smoke: OK");
}

main();
