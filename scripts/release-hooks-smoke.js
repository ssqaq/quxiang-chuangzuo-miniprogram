/* eslint-disable no-console */

// Focused smoke for the repository-side safety net.  GitHub branch protection
// is still authoritative; this test only proves that a fresh checkout can
// install all hooks and that a direct push to main is stopped locally.
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const hooksRoot = path.join(root, ".githooks");
const installer = path.join(root, "scripts", "install-git-hooks.ps1");
const hookNames = ["pre-commit", "post-commit", "pre-push", "post-checkout"];

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    maxBuffer: 4 * 1024 * 1024,
  });
}

function assertOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout || ""}\nstderr:\n${result.stderr || ""}`
  );
}

function outputOf(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function testStaticContracts() {
  assert.ok(fs.existsSync(installer), "hooks 安装器不存在");
  const installerText = fs.readFileSync(installer, "utf8");
  for (const name of hookNames) {
    const file = path.join(hooksRoot, name);
    assert.ok(fs.existsSync(file), `缺少 ${name} hook`);
    assert.ok(fs.statSync(file).size > 0, `${name} hook 为空`);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith("#!/bin/sh"), `${name} hook 缺少 POSIX shebang`);
    assert.ok(installerText.includes(`"${name}"`), `安装器未声明 ${name}`);
  }

  const prePush = fs.readFileSync(path.join(hooksRoot, "pre-push"), "utf8");
  assert.ok(prePush.includes("MINIPROGRAM_SYNC_ALLOW_MAIN_PUSH"), "pre-push 缺少主线覆盖开关");
  assert.ok(prePush.includes("refs/heads/main"), "pre-push 缺少 main ref 拦截");
  assert.ok(prePush.includes("done < \"$refs_file\""), "pre-push 检查没有读取保存的 ref 流");
  assert.ok(prePush.includes("< \"$refs_file\""), "pre-push 没有把 ref 流交还给后续处理");
  assert.ok(prePush.includes("git lfs pre-push"), "pre-push 缺少 Git LFS 转发");

  const postCheckout = fs.readFileSync(path.join(hooksRoot, "post-checkout"), "utf8");
  assert.ok(postCheckout.includes("git lfs post-checkout"), "post-checkout 缺少 Git LFS 转发");
}

function copyHooks(destinationRoot) {
  const destinationHooks = path.join(destinationRoot, ".githooks");
  const destinationScripts = path.join(destinationRoot, "scripts");
  fs.mkdirSync(destinationHooks, { recursive: true });
  fs.mkdirSync(destinationScripts, { recursive: true });
  for (const name of hookNames) {
    fs.copyFileSync(path.join(hooksRoot, name), path.join(destinationHooks, name));
  }
  fs.copyFileSync(installer, path.join(destinationScripts, "install-git-hooks.ps1"));
}

function createInstalledRepo() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-hooks-smoke-"));
  copyHooks(tempRoot);
  assertOk(run("git", ["init", "-b", "main", tempRoot]), "初始化 hooks 仓库");
  assertOk(run("git", ["config", "user.name", "release-hooks-smoke"], { cwd: tempRoot }), "配置用户名");
  assertOk(run("git", ["config", "user.email", "release-hooks@example.invalid"], { cwd: tempRoot }), "配置邮箱");
  fs.writeFileSync(path.join(tempRoot, "README.md"), "release hooks smoke\n");
  assertOk(run("git", ["add", "README.md"], { cwd: tempRoot }), "暂存基线文件");
  assertOk(
    run("git", ["commit", "-m", "hooks smoke base"], {
      cwd: tempRoot,
      env: { MINIPROGRAM_SYNC_ALLOW_MAIN_COMMIT: "1", MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
    }),
    "提交 hooks 基线"
  );

  const installArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(tempRoot, "scripts", "install-git-hooks.ps1")];
  assertOk(run("pwsh", installArgs, { cwd: tempRoot }), "安装全部 hooks");
  // Running the installer twice must be harmless; this is what a clone setup
  // script can safely do after every checkout.
  assertOk(run("pwsh", installArgs, { cwd: tempRoot }), "重复安装全部 hooks");
  const configured = run("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: tempRoot });
  assertOk(configured, "读取 hooksPath");
  assert.strictEqual(configured.stdout.trim(), ".githooks", "hooksPath 未固定到 .githooks");
  for (const name of hookNames) {
    assert.ok(fs.statSync(path.join(tempRoot, ".githooks", name)).size > 0, `${name} 未安装`);
  }
  return tempRoot;
}

function testInstallerAndMainPushGuard() {
  const tempRoot = createInstalledRepo();
  const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-hooks-bare-"));
  const bare = path.join(bareRoot, "origin.git");
  try {
    assertOk(run("git", ["init", "--bare", bare]), "初始化本地远端");
    assertOk(run("git", ["remote", "add", "origin", bare], { cwd: tempRoot }), "配置本地远端");
    const blocked = run("git", ["push", "origin", "main"], {
      cwd: tempRoot,
      env: {
        MINIPROGRAM_SYNC_ALLOW_MAIN_PUSH: "",
        MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1",
      },
    });
    assert.notStrictEqual(blocked.status, 0, "pre-push 必须拒绝直接推送 main");
    assert.ok(outputOf(blocked).includes("拒绝直接 push main"), "main 推送拒绝信息不明确");

    // A normal release branch must still pass through Git LFS after the ref
    // stream has been inspected and replayed.  Skip only when Git LFS is not
    // installed on a developer machine; GitHub's Windows runner includes it.
    const lfs = run("git", ["lfs", "version"], { cwd: tempRoot });
    if (lfs.status === 0) {
      assertOk(run("git", ["checkout", "-b", "release/hooks-smoke"], {
        cwd: tempRoot,
        env: { MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
      }), "创建 release 分支");
      fs.appendFileSync(path.join(tempRoot, "README.md"), "release branch\n");
      assertOk(run("git", ["add", "README.md"], { cwd: tempRoot }), "暂存 release 分支文件");
      assertOk(run("git", ["commit", "-m", "hooks smoke release branch"], {
        cwd: tempRoot,
        env: { MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
      }), "提交 release 分支文件");
      assertOk(run("git", ["push", "origin", "release/hooks-smoke"], {
        cwd: tempRoot,
        env: { MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
      }), "推送 release 分支并转发 LFS ref 流");
    }
    else {
      console.log("release hooks smoke: 未检测到 git-lfs，跳过 release 分支推送测试");
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(bareRoot, { recursive: true, force: true });
  }
}

function testPostCheckoutDelegation() {
  const lfs = run("git", ["lfs", "version"]);
  if (lfs.status !== 0) {
    // GitHub's Windows runner ships Git LFS.  A developer machine may not;
    // static checks above still prove the hook is present and explicit.
    console.log("release hooks smoke: 未检测到 git-lfs，跳过 post-checkout 运行测试");
    return;
  }
  const tempRoot = createInstalledRepo();
  try {
    const checkout = run("git", ["checkout", "-b", "hooks/post-checkout"], {
      cwd: tempRoot,
      env: { MINIPROGRAM_SYNC_SKIP_POST_COMMIT: "1" },
    });
    assertOk(checkout, "post-checkout Git LFS 转发");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  testStaticContracts();
  testInstallerAndMainPushGuard();
  testPostCheckoutDelegation();
  console.log("release hooks smoke: OK");
}

main();
