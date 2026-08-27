/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "scripts", "safe-sync-to-release.ps1");

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(args, cwd = root) {
  return cp.spawnSync(
    "pwsh",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    { cwd, encoding: "utf8" }
  );
}

function runGit(args, cwd) {
  const result = cp.spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(
    result.status,
    0,
    `git ${args.join(" ")} 失败\n${result.stdout}\n${result.stderr}`
  );
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "safe-sync-smoke-"));
const source = path.join(tempRoot, "source");
const target = path.join(tempRoot, "target");
try {
  fs.mkdirSync(path.join(source, "pages", "admin"), { recursive: true });
  fs.mkdirSync(path.join(source, "docs"), { recursive: true });
  fs.mkdirSync(path.join(target, "pages", "admin"), { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(source, "pages", "admin", "admin.js"),
    "source-v2\n"
  );
  fs.writeFileSync(path.join(source, "docs", "only-source.md"), "source-only\n");
  fs.writeFileSync(path.join(target, "pages", "admin", "admin.js"), "base-v1\n");

  runGit(["init"], target);
  runGit(["config", "user.email", "smoke@example.test"], target);
  runGit(["config", "user.name", "Smoke"], target);
  runGit(["add", "."], target);
  runGit(["commit", "-m", "base"], target);
  const beforeStatus = cp.spawnSync(
    "git",
    ["status", "--short"],
    { cwd: target, encoding: "utf8" }
  ).stdout;

  const copied = runPowerShell([
    "-SourcePath", source,
    "-TargetPath", target,
    "-IncludePath", "pages/admin/admin.js",
    "-AllowTargetOverwrite",
  ]);
  assert.strictEqual(
    copied.status,
    0,
    `安全同步复制失败\n${copied.stdout}\n${copied.stderr}`
  );
  assert.ok(copied.stdout.includes("已复制并校验"));
  assert.strictEqual(
    fs.readFileSync(path.join(target, "pages", "admin", "admin.js"), "utf8"),
    "source-v2\n"
  );
  assert.ok(
    !fs.existsSync(path.join(target, "docs", "only-source.md")),
    "未列出的源文件被错误复制"
  );
  const afterStatus = cp.spawnSync(
    "git",
    ["status", "--short"],
    { cwd: target, encoding: "utf8" }
  ).stdout;
  assert.strictEqual(afterStatus, " M pages/admin/admin.js\n");
  assert.strictEqual(beforeStatus, "");

  fs.writeFileSync(
    path.join(target, "pages", "admin", "admin.js"),
    "user-edited\n"
  );
  const blocked = runPowerShell([
    "-SourcePath", source,
    "-TargetPath", target,
    "-IncludePath", "pages/admin/admin.js",
    "-AllowTargetOverwrite",
  ]);
  assert.notStrictEqual(blocked.status, 0, "目标用户改动没有被拦截");
  assert.ok(
    `${blocked.stdout}\n${blocked.stderr}`.includes("用户改动"),
    "目标用户改动拦截提示不清楚"
  );

  const unsafe = runPowerShell([
    "-SourcePath", source,
    "-TargetPath", target,
    "-IncludePath", "..\\outside.txt",
  ]);
  assert.notStrictEqual(unsafe.status, 0, "越界 IncludePath 没有被拒绝");

  const sensitive = runPowerShell([
    "-SourcePath", source,
    "-TargetPath", target,
    "-IncludePath", ".env",
  ]);
  assert.notStrictEqual(sensitive.status, 0, "敏感文件 IncludePath 没有被拒绝");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("safe sync smoke: OK");
