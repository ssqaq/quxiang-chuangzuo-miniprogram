/* eslint-disable no-console */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));
const manifest = readJson("scripts/payment-cloudfunctions.json");
const appVersionMatch = read("config.js").match(/appVersion:\s*"([^"]+)"/);
assert.ok(appVersionMatch, "config.js 缺少 appVersion");
const appVersion = appVersionMatch[1];
const sha256 = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
function relativeFiles(directory, excluded, excludedPrefixes) {
  const output = new Map();
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      if (entry.isFile()) {
        const relative = path.relative(directory, full).replace(/\\/g, "/");
        if (
          !excluded.has(relative)
          && !excludedPrefixes.some((prefix) => relative.startsWith(prefix))
        ) output.set(relative, sha256(full));
      }
    }
  };
  visit(directory);
  return output;
}
const expected = new Map([
  ["payment-api", { timeout: 15, http: false, timer: false, client: true, switchName: "orderCreationEnabled" }],
  ["payment-notify", { timeout: 15, http: true, timer: false, client: false, switchName: "callbackProcessingEnabled" }],
  ["payment-reconcile", { timeout: 120, http: false, timer: true, client: false, switchName: "reconciliationEnabled" }],
]);

assert.strictEqual(manifest.schemaVersion, 1);
assert.deepStrictEqual(manifest.productionDeployment, {
  enabled: false,
  automaticDeployment: false,
  requiresExplicitProductionAuthorization: true,
});
assert.strictEqual(manifest.sharedCore.name, "aips-payment-core");
assert.strictEqual(manifest.sharedCore.root, "cloudfunctions/payment-core");
assert.strictEqual(manifest.sharedCore.lockRequired, false);
assert.ok(Array.isArray(manifest.sharedCore.requiredFiles));
assert.strictEqual(manifest.sharedCore.requiredFiles.length, 13);
assert.deepStrictEqual(manifest.sharedCore.vendorExcludedFiles, [".env.example"]);
assert.deepStrictEqual(manifest.sharedCore.vendorExcludedPrefixes, ["tests/"]);

const corePackage = readJson(manifest.sharedCore.packageJson);
const coreConfigSource = read("cloudfunctions/payment-core/config.js");
assert.strictEqual(corePackage.name, manifest.sharedCore.name);
assert.strictEqual(corePackage.main, "index.js");
assert.strictEqual(corePackage.version, appVersion);
for (const marker of [
  "rechargeEnabled: false",
  "wxpay: Object.freeze({ enabled: false })",
  "alipay: Object.freeze({ enabled: false })",
  "rolloutPercent: 0",
]) {
  assert.ok(coreConfigSource.includes(marker), `支付默认关闭配置缺少 ${marker}`);
}
for (const relative of manifest.sharedCore.requiredFiles) {
  assert.ok(fs.statSync(path.join(root, relative)).isFile(), `payment-core 缺少 ${relative}`);
}
const canonicalCoreFiles = new Map(manifest.sharedCore.requiredFiles.map((relative) => {
  const runtimeRelative = path.posix.relative(manifest.sharedCore.root, relative);
  return [runtimeRelative, sha256(path.join(root, relative))];
}));

assert.strictEqual(manifest.functions.length, expected.size);
for (const item of manifest.functions) {
  const contract = expected.get(item.name);
  assert.ok(contract, `出现未批准支付函数：${item.name}`);
  assert.strictEqual(item.root, `cloudfunctions/${item.name}`);
  assert.strictEqual(item.entry, `${item.root}/index.js`);
  assert.strictEqual(item.packageJson, `${item.root}/package.json`);
  assert.strictEqual(item.packageLock, `${item.root}/package-lock.json`);
  assert.strictEqual(item.config, `${item.root}/config.json`);
  assert.strictEqual(item.sharedCoreRoot, manifest.sharedCore.root);
  assert.strictEqual(item.vendoredCoreRoot, `${item.root}/vendor/payment-core`);
  assert.strictEqual(item.timeoutSeconds, contract.timeout);
  assert.strictEqual(item.deploymentEnabled, false);
  assert.strictEqual(item.clientInvocationAllowed, contract.client,
    `${item.name} clientInvocationAllowed 与入口职责不一致`);
  assert.deepStrictEqual(item.runtimeSwitches, { [contract.switchName]: false });
  assert.deepStrictEqual(item.httpRoute, {
    declared: contract.http,
    enabled: false,
    requiresExplicitProductionAuthorization: true,
  });
  assert.deepStrictEqual(item.timer, {
    declared: contract.timer,
    enabled: false,
    requiresExplicitProductionAuthorization: true,
  });

  const packageJson = readJson(item.packageJson);
  const packageLock = readJson(item.packageLock);
  const config = readJson(item.config);
  assert.strictEqual(packageJson.name, item.packageName);
  assert.strictEqual(packageJson.main, "index.js");
  assert.strictEqual(packageJson.version, appVersion);
  assert.strictEqual(
    packageJson.dependencies[manifest.sharedCore.name],
    "file:vendor/payment-core"
  );
  assert.strictEqual(packageLock.name, item.packageName);
  assert.strictEqual(packageLock.version, packageJson.version);
  assert.strictEqual(packageLock.packages[""].version, packageJson.version);
  assert.strictEqual(config.timeout, contract.timeout);
  assert.ok(!Array.isArray(config.triggers) || config.triggers.length === 0,
    `${item.name} config.json 不得提前启用触发器`);
  assert.ok(fs.statSync(path.join(root, item.entry)).isFile());
  assert.ok(!packageJson.scripts || !packageJson.scripts.deploy,
    `${item.name} 不得提供绕开生产授权的一键 deploy script`);
  const vendorCoreFiles = relativeFiles(
    path.join(root, item.vendoredCoreRoot),
    new Set(manifest.sharedCore.vendorExcludedFiles),
    manifest.sharedCore.vendorExcludedPrefixes
  );
  assert.deepStrictEqual(
    [...vendorCoreFiles.keys()].sort(),
    [...canonicalCoreFiles.keys()].sort(),
    `${item.name} vendor/payment-core 文件集漂移`
  );
  for (const [relative, digest] of canonicalCoreFiles) {
    assert.strictEqual(vendorCoreFiles.get(relative), digest,
      `${item.name} vendor/payment-core 内容漂移：${relative}`);
  }
}

const releaseVersion = read("scripts/release-version.ps1");
const releaseGate = read("scripts/release-gate.ps1");
const packageRelease = read("scripts/package-release.py");
const dependencyCheck = read("scripts/check-cloudfunction-dependencies.js");
const dependencyCache = read("scripts/npm-dependency-cache.ps1");
const workflow = read(".github/workflows/release-gate.yml");

for (const marker of [
  "scripts/payment-cloudfunctions.json",
  "cloudfunctions/payment-core/package.json",
  "payment-api",
  "payment-notify",
  "payment-reconcile",
]) {
  assert.ok(releaseVersion.includes(marker), `版本组缺少 ${marker}`);
}
for (const marker of [
  "PAYMENT_MANIFEST_RELATIVE",
  "_validate_payment_manifest",
  "sharedCore",
  "requiredFiles",
  "vendoredCoreRoot",
  "payment-api",
  "payment-notify",
  "payment-reconcile",
]) {
  assert.ok(packageRelease.includes(marker), `正式包检查缺少 ${marker}`);
}
assert.ok(releaseGate.includes("Get-VersionGroupPaths"));
assert.ok(dependencyCheck.includes("runManifestDependencyCheck"));
assert.ok(dependencyCache.includes("Ensure-ManifestCloudFunctionDependencies"));
assert.ok(workflow.includes("payment-deployment-smoke.js"));
assert.ok(workflow.includes("payment-cloudfunctions.json"));
assert.ok(!/(?:tcb|cloudbase)[^\r\n]*(?:deploy|create)[^\r\n]*payment-/i.test(workflow),
  "CI 禁止部署支付函数、创建 HTTP 路由或启用 Timer");

console.log("payment deployment smoke: OK (fail-closed/package-only)");
