/* eslint-disable no-console */

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "scripts", "release.ps1");

function run(command, args, cwd, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
  assert.strictEqual(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return (result.stdout || "").trim();
}

function testStaticContract() {
  const text = fs.readFileSync(entry, "utf8");
  for (const marker of [
    "Test-ReleaseGitBlobAtRevision",
    "$canonicalToolSnapshot",
    "$missingToolPaths",
    "$baseToolSnapshot",
    "canonical 与锁定基线",
    "worktree",
    "$baseHead",
  ]) {
    assert.ok(text.includes(marker), `release.ps1 缺少回退合同：${marker}`);
  }
  assert.ok(
    text.includes("elseif ($UseSourceTooling)"),
    "来源工具模式没有保持严格缺失检查"
  );
  assert.ok(
    text.includes("Assert-ReleaseFileSnapshotStable -SourceRoot $toolSnapshotRoot -Snapshot $canonicalToolSnapshot"),
    "canonical 工具快照没有稳定性复核"
  );
  assert.ok(
    text.includes("$packageToolRoot = if ($UseSourceTooling) { $releaseWorktree } else { $canonicalRepo }"),
    "来源工具模式没有从隔离发布工作树运行配套打包器"
  );
  assert.ok(
    text.includes("$versionToolRoot = if ($UseSourceTooling) { $releaseWorktree } else { $canonicalRepo }"),
    "来源工具模式没有选择配套版本同步器"
  );
  assert.ok(
    text.indexOf('. (Join-Path $versionToolRoot "scripts/release-version.ps1")') <
      text.indexOf("Get-ReleaseVersionPaths -SourceRoot $releaseWorktree"),
    "来源版本同步器必须在计算和改写版本组前加载"
  );
  assert.ok(
    text.includes("-ReleaseWorktree $releaseWorktree"),
    "release context 必须在调用来源版打包器前绑定隔离工作树"
  );
  const packageCalls = text.match(/Invoke-GatePython -ScriptRoot \$\w+/g) || [];
  assert.strictEqual(packageCalls.length, 3, "正式发布的打包器调用数量变化，需重新核对调用根目录");
  assert.ok(
    packageCalls.every((call) => call === "Invoke-GatePython -ScriptRoot $packageToolRoot"),
    "正式发布仍存在绕过 packageToolRoot 的打包器调用"
  );
}

function testExactBaseFallback() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-tool-fallback-"));
  const repo = path.join(temp, "repo");
  const worktree = path.join(temp, "worktree");
  try {
    fs.mkdirSync(repo, { recursive: true });
    run("git", ["init", repo], temp);
    run("git", ["-C", repo, "config", "user.name", "release smoke"], temp);
    run("git", ["-C", repo, "config", "user.email", "release@example.com"], temp);
    run("git", ["-C", repo, "config", "core.autocrlf", "false"], temp);
    const fallback = path.join(repo, "scripts", "admin-v2-pixel-regression.js");
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, "base-tool-v1\n", "utf8");
    run("git", ["-C", repo, "add", "scripts/admin-v2-pixel-regression.js"], temp);
    run("git", ["-C", repo, "commit", "-m", "base"], temp);
    const baseHead = run("git", ["-C", repo, "rev-parse", "HEAD"], temp);
    const blobType = run(
      "git",
      ["-C", repo, "cat-file", "-t", `${baseHead}:scripts/admin-v2-pixel-regression.js`],
      temp
    );
    assert.strictEqual(blobType, "blob", "锁定基线工具不是 blob");
    const missing = childProcess.spawnSync(
      "git",
      ["-C", repo, "cat-file", "-t", `${baseHead}:scripts/not-present.js`],
      { cwd: temp, encoding: "utf8" }
    );
    assert.notStrictEqual(missing.status, 0, "基线不存在的工具被错误接受");

    run("git", ["-C", repo, "worktree", "add", "--detach", worktree, baseHead], temp);
    const checkedOut = fs
      .readFileSync(path.join(worktree, "scripts", "admin-v2-pixel-regression.js"), "utf8")
      .replace(/\r\n/g, "\n");
    assert.strictEqual(checkedOut, "base-tool-v1\n", "工作树没有保留 baseHead 的回退工具");
    console.log("BASE_FALLBACK_OK");
  } finally {
    try {
      if (fs.existsSync(worktree)) {
        childProcess.spawnSync("git", ["-C", repo, "worktree", "remove", "--force", worktree], {
          cwd: temp,
          encoding: "utf8",
        });
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

testStaticContract();
testExactBaseFallback();
console.log("release tool fallback smoke: OK");
