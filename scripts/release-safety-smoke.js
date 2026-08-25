const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const syncScript = path.join(root, "scripts", "sync-to-github.ps1");
const packageScript = path.join(root, "scripts", "package-release.py");
const preCommitHook = path.join(root, ".githooks", "pre-commit");
const postCommitHook = path.join(root, ".githooks", "post-commit");

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
  assertFileIncludes(syncScript, "FileShare]::None", "发布锁");
  assertFileIncludes(syncScript, "write-tree", "Git tree 校验");
  assertFileIncludes(syncScript, "Assert-ReleaseState", "SHA/工作区校验");
  assertFileIncludes(syncScript, "--source-tree", "从 Git tree 打包");
  assert.ok(
    !/Invoke-Git\s+-Arguments\s+@\(\s*"add"\s*,\s*"-A"/.test(syncContent),
    "同步脚本不能继续使用 git add -A"
  );
  assertFileIncludes(preCommitHook, "禁止直接在 main 提交", "main 提交保护");
  assertFileIncludes(postCommitHook, "main 只能由受控同步脚本提交", "main 推送保护");
  assertFileIncludes(packageScript, "源码内容 SHA256", "发布清单源码指纹");
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
  const result = run("pwsh", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    syncScript,
    "-IncludePath",
    "README.md",
  ]);
  assert.notStrictEqual(result.status, 0, "独立分支/worktree 不允许发布 main");
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes("发布同步只允许在 main"),
    "worktree 拒绝信息不明确"
  );
}

function testPackageManifest() {
  const output = path.join(
    os.tmpdir(),
    `release-safety-smoke-${process.pid}-${Date.now()}.zip`
  );
  try {
    const head = run("git", ["rev-parse", "HEAD"]);
    assertCommandOk(head, "读取 HEAD");
    const tree = run("git", ["rev-parse", "HEAD^{tree}"]);
    assertCommandOk(tree, "读取 tree");
    const trackedAtHead = run("git", [
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      "--",
      "scripts/release-safety-smoke.js",
    ]);
    assertCommandOk(trackedAtHead, "检查 smoke 是否已提交");

    const packageArgs = [
      packageScript,
      "--commit-sha",
      trackedAtHead.stdout.trim() ? head.stdout.trim() : "工作区未提交",
      "--tree-sha",
      tree.stdout.trim(),
      "--output",
      output,
    ];
    if (trackedAtHead.stdout.trim()) {
      packageArgs.splice(1, 0, "--source-tree", head.stdout.trim());
    }

    const result = run(
      process.platform === "win32" ? "python" : "python3",
      packageArgs
    );
    assertCommandOk(result, "从 commit 打包");
    assert.ok(fs.statSync(output).size > 0, "发布包不能为空");

    const unzip = run(
      process.platform === "win32" ? "python" : "python3",
      [
        "-c",
        [
          "import base64",
          "from zipfile import ZipFile",
          "import sys",
          "print(base64.b64encode(ZipFile(sys.argv[1]).read('RELEASE-MANIFEST.txt')).decode('ascii'))",
        ].join(";"),
        output,
      ]
    );
    assertCommandOk(unzip, "读取发布清单");
    const manifest = Buffer.from(unzip.stdout.trim(), "base64").toString("utf8");
    const expectedCommit = trackedAtHead.stdout.trim()
      ? head.stdout.trim()
      : "工作区未提交";
    assert.ok(
      manifest.includes(`提交 SHA：${expectedCommit}`),
      "发布清单缺少最终提交 SHA"
    );
    assert.ok(
      manifest.includes(`Git tree SHA：${tree.stdout.trim()}`),
      "发布清单缺少 Git tree SHA"
    );
    assert.ok(
      /源码内容 SHA256：[0-9a-f]{64}/.test(manifest),
      "发布清单缺少源码内容 SHA256"
    );
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
  testMainHookRejectsDirectCommit();
  testExclusiveLockPrimitive();
  testWorktreeCannotPublishMain();
  testPackageManifest();
  testSourceFingerprintAlgorithm();
  console.log("release safety smoke: OK");
}

main();
