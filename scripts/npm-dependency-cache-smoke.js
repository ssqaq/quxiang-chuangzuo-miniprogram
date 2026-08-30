/* eslint-disable no-console */

const assert = require("assert");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "scripts", "npm-dependency-cache.ps1");
const deploy = path.join(root, "scripts", "deploy-and-verify-api.ps1");

function runPowerShellScript(script, env, shell = "pwsh") {
  const tempScript = path.join(
    os.tmpdir(),
    `npm-dependency-cache-smoke-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`
  );
  // Keep the generated script ASCII-only; paths are passed through the
  // environment so Windows PowerShell 5.1 never decodes Chinese literals.
  fs.writeFileSync(tempScript, script, "ascii");
  try {
    return cp.spawnSync(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tempScript],
      { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }
    );
  } finally {
    fs.rmSync(tempScript, { force: true });
  }
}

function assertPowerShellOk(result, label) {
  assert.strictEqual(
    result.status,
    0,
    `${label}失败\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function writeFixture(tempRoot) {
  const apiRoot = path.join(tempRoot, "project", "cloudfunctions", "api");
  fs.mkdirSync(apiRoot, { recursive: true });
  const packageJson = {
    name: "cache-smoke-api",
    version: "1.0.0",
    dependencies: {},
  };
  const packageLock = {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: 3,
    packages: {
      "": { name: packageJson.name, version: packageJson.version, dependencies: {} },
    },
  };
  fs.writeFileSync(path.join(apiRoot, "package.json"), JSON.stringify(packageJson), "utf8");
  fs.writeFileSync(path.join(apiRoot, "package-lock.json"), JSON.stringify(packageLock), "utf8");
  const checkScript = path.join(tempRoot, "dependency-check.js");
  fs.writeFileSync(
    checkScript,
    [
      "const fs=require('fs');",
      "const path=require('path');",
      "const a=process.argv.indexOf('--api-root');",
      "const root= a >= 0 ? process.argv[a+1] : '';",
      "process.exit(fs.existsSync(path.join(root,'node_modules')) ? 0 : 1);",
      "",
    ].join("\n"),
    "utf8"
  );
  const fakeNpm = path.join(tempRoot, "fake-npm.cmd");
  fs.writeFileSync(
    fakeNpm,
    [
      "@echo off",
      ">>\"%FAKE_NPM_LOG%\" echo %*",
      "if /I \"%FAKE_NPM_MODE%\"==\"offline-fail\" if /I \"%~3\"==\"--prefer-offline\" exit /b 17",
      "if not exist \"%FAKE_NPM_NODE_MODULES%\" mkdir \"%FAKE_NPM_NODE_MODULES%\"",
      "exit /b 0",
      "",
    ].join("\r\n"),
    "ascii"
  );
  return { apiRoot, checkScript, fakeNpm };
}

function invokeEnsure(fixture, cacheRoot, logPath, mode) {
  const script = [
    ". $env:HELPER",
    "$fake = [pscustomobject]@{ Source = $env:FAKE_NPM }",
    "$info = Ensure-LocalCloudFunctionDependencies -ApiPath $env:API_ROOT -CacheRoot $env:CACHE_ROOT -DependencyCheckScript $env:CHECK_SCRIPT -NpmPath $env:FAKE_NPM",
    "$info | ConvertTo-Json -Compress",
  ].join("\n");
  const result = runPowerShellScript(script, {
    HELPER: helper,
    API_ROOT: fixture.apiRoot,
    CACHE_ROOT: cacheRoot,
    CHECK_SCRIPT: fixture.checkScript,
    FAKE_NPM: fixture.fakeNpm,
    FAKE_NPM_LOG: logPath,
    FAKE_NPM_NODE_MODULES: path.join(fixture.apiRoot, "node_modules"),
    FAKE_NPM_MODE: mode,
  });
  assertPowerShellOk(result, `Ensure（${mode}）`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function getCacheInfo(apiRoot, cacheRoot) {
  const result = runPowerShellScript(
    ". $env:HELPER; Get-NpmDependencyCacheInfo -ApiPath $env:API_ROOT -CacheRoot $env:CACHE_ROOT | ConvertTo-Json -Compress",
    { HELPER: helper, API_ROOT: apiRoot, CACHE_ROOT: cacheRoot }
  );
  assertPowerShellOk(result, "读取 npm 缓存信息");
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

function main() {
  assert.ok(fs.readFileSync(deploy, "utf8").includes("NpmCachePath"), "部署入口缺少 -NpmCachePath");
  const helperBytes = fs.readFileSync(helper);
  const helperSource = helperBytes.toString("utf8");
  assert.ok(
    helperSource.includes("Ensure-ManifestCloudFunctionDependencies"),
    "缓存 helper 缺少支付云函数清单入口"
  );
  assert.ok(
    helperSource.includes("$functionName-$dependencyFingerprint"),
    "缓存键必须按云函数目录隔离，不能把三个支付函数共用 api 前缀"
  );
  assert.strictEqual(helperBytes[0], 0xef, "缓存 helper 必须使用 UTF-8 BOM 兼容 Windows PowerShell 5.1");
  const ps5 = runPowerShellScript(
    "$text=[IO.File]::ReadAllText($env:HELPER,[Text.Encoding]::UTF8); [scriptblock]::Create($text) | Out-Null; Write-Output PARSE_OK",
    { HELPER: helper },
    "powershell.exe"
  );
  assertPowerShellOk(ps5, "Windows PowerShell 5.1 解析 helper");
  assert.ok(ps5.stdout.includes("PARSE_OK"));

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npm-dependency-cache-smoke-"));
  try {
    const fixture = writeFixture(tempRoot);
    const cacheRoot = path.join(tempRoot, "external-cache");
    const logPath = path.join(tempRoot, "npm.log");

    const first = invokeEnsure(fixture, cacheRoot, logPath, "success");
    const lockSha = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(fixture.apiRoot, "package-lock.json")))
      .digest("hex");
    assert.strictEqual(first.Key, `api-${lockSha}`);
    assert.ok(first.Path.startsWith(cacheRoot));
    assert.ok(!first.Path.startsWith(fixture.apiRoot));
    assert.ok(fs.existsSync(path.join(fixture.apiRoot, "node_modules", ".npm-cache-lock-sha256")));
    const firstLog = fs.readFileSync(logPath, "utf8");
    assert.ok(firstLog.includes("ci --ignore-scripts --prefer-offline"), "首次安装没有使用 prefer-offline");
    const firstLineCount = firstLog.trim().split(/\r?\n/).length;

    invokeEnsure(fixture, cacheRoot, logPath, "fail");
    const secondLog = fs.readFileSync(logPath, "utf8");
    assert.strictEqual(secondLog.trim().split(/\r?\n/).length, firstLineCount, "同一 lockfile 未复用已验证依赖");

    const lockPath = path.join(fixture.apiRoot, "package-lock.json");
    const changed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    changed.smokeNonce = "changed";
    fs.writeFileSync(lockPath, JSON.stringify(changed), "utf8");
    const changedInfo = invokeEnsure(fixture, cacheRoot, logPath, "success");
    assert.notStrictEqual(changedInfo.Key, first.Key, "lockfile 变化没有生成新缓存键");
    assert.ok(fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).length > firstLineCount);

    fs.rmSync(path.join(fixture.apiRoot, "node_modules"), { recursive: true, force: true });
    const beforeFallback = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).length;
    invokeEnsure(fixture, cacheRoot, logPath, "offline-fail");
    const fallbackLog = fs.readFileSync(logPath, "utf8");
    const fallbackLines = fallbackLog.trim().split(/\r?\n/);
    assert.ok(fallbackLines.length >= beforeFallback + 2, "缓存失败没有触发在线回退");
    assert.ok(fallbackLog.includes("--prefer-offline") && fallbackLog.includes("--prefer-online"));

    const invalid = runPowerShellScript(
      ". $env:HELPER; Get-NpmDependencyCacheInfo -ApiPath $env:API_ROOT -CacheRoot $env:BAD_ROOT | Out-Null",
      { HELPER: helper, API_ROOT: fixture.apiRoot, BAD_ROOT: path.join(tempRoot, "project", "inside-cache") }
    );
    assert.notStrictEqual(invalid.status, 0, "项目内缓存目录没有被拒绝");

    const packagePath = path.join(fixture.apiRoot, "package.json");
    const packageLockPath = path.join(fixture.apiRoot, "package-lock.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    packageJson.dependencies["aips-payment-core"] = "file:vendor/payment-core";
    packageLock.packages[""].dependencies["aips-payment-core"] = "file:vendor/payment-core";
    fs.writeFileSync(packagePath, JSON.stringify(packageJson), "utf8");
    fs.writeFileSync(packageLockPath, JSON.stringify(packageLock), "utf8");
    const localCore = path.join(fixture.apiRoot, "vendor", "payment-core");
    fs.mkdirSync(localCore, { recursive: true });
    fs.writeFileSync(
      path.join(localCore, "package.json"),
      JSON.stringify({ name: "aips-payment-core", version: "1.0.0", main: "index.js" }),
      "utf8"
    );
    fs.writeFileSync(path.join(localCore, "index.js"), "module.exports = 1;\n", "utf8");
    const localFirst = getCacheInfo(fixture.apiRoot, cacheRoot);
    fs.writeFileSync(path.join(localCore, "index.js"), "module.exports = 2;\n", "utf8");
    const localSecond = getCacheInfo(fixture.apiRoot, cacheRoot);
    assert.strictEqual(localSecond.LockSha256, localFirst.LockSha256);
    assert.notStrictEqual(
      localSecond.DependencyFingerprintSha256,
      localFirst.DependencyFingerprintSha256,
      "file: 依赖源码变化没有使缓存失效"
    );
    assert.notStrictEqual(localSecond.Key, localFirst.Key);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("npm dependency cache smoke: OK");
}

main();
