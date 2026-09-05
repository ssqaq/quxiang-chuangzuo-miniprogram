/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "scripts", "deploy-and-verify-api.ps1");
const npmCacheScriptPath = path.join(root, "scripts", "npm-dependency-cache.ps1");
const cloudbaseDeployPath = path.join(
  root,
  "scripts",
  "deploy-api-cloudbase-cli.ps1"
);
const verifyScriptPath = path.join(root, "scripts", "verify-online-api.ps1");
const safetyScriptPath = path.join(root, "scripts", "cloud-deploy-safety.ps1");
const source = fs.readFileSync(scriptPath, "utf8");
const npmCacheSource = fs.readFileSync(npmCacheScriptPath, "utf8");
const cloudbaseDeploySource = fs.readFileSync(cloudbaseDeployPath, "utf8");
const verifySource = fs.readFileSync(verifyScriptPath, "utf8");
const safetySource = fs.readFileSync(safetyScriptPath, "utf8");
const releaseLockSource = fs.readFileSync(
  path.join(root, "scripts", "release-lock.ps1"),
  "utf8"
);
const apiSource = fs.readFileSync(
  path.join(root, "cloudfunctions", "api", "index.js"),
  "utf8"
);
const deploymentCheckSource = fs.readFileSync(
  path.join(root, "scripts", "check-deployment.js"),
  "utf8"
);
const requiredEnvBlock = deploymentCheckSource.match(
  /const requiredEnv = \[([\s\S]*?)\];/
);
const apiConfig = JSON.parse(
  fs.readFileSync(
    path.join(root, "cloudfunctions", "api", "config.json"),
    "utf8"
  )
);

assert.ok(requiredEnvBlock, "部署检查缺少环境变量清单");
[
  "AI_IMAGE_PRIMARY_MODEL",
  "AI_IMAGE_PRIMARY_API_KEY",
  "AI_IMAGE_BACKUP_MODEL",
  "AI_IMAGE_BACKUP_API_KEY",
  "AI_IMAGE_PRIMARY_TIMEOUT_MS",
  "AI_IMAGE_BACKUP_TIMEOUT_MS",
  "TENCENT_FACEFUSION_TIMEOUT_MS",
].forEach((name) => {
  assert.ok(
    requiredEnvBlock[1].includes(`"${name}"`),
    `部署检查必须核对新版图片主备配置：${name}`
  );
});
assert.ok(
  !requiredEnvBlock[1].includes('"AI_IMAGE_MODEL"'),
  "部署检查不能再把旧 AI_IMAGE_MODEL 当成必填项"
);

assert.ok(
  source.includes("Assert-CloudFunctionDeploymentResult"),
  "部署脚本必须检查云函数部署结果中的隐藏错误"
);
assert.ok(
  source.includes('$Arguments -contains "open_project_window"'),
  "WechatIDE 登录检查不能被打开项目窗口开关误拦截"
);
assert.ok(
  source.includes("Wait-CloudFunctionReady"),
  "部署脚本必须等待云函数恢复 Active"
);
assert.ok(
  source.includes('"cloud_fn_info"'),
  "部署脚本必须读取线上云函数状态"
);
assert.strictEqual(
  apiConfig.timeout,
  900,
  "api 云函数平台超时必须设置为 900 秒，覆盖图片主备和腾讯两阶段流程"
);
assert.ok(
  source.includes("Online function timeout"),
  "部署脚本必须输出线上云函数实际超时"
);
assert.ok(
  source.includes("actualFunctionTimeout -lt $expectedFunctionTimeout"),
  "部署脚本必须拦截线上超时未生效"
);
assert.ok(
  source.includes("[switch]$VerifyOnly")
    && source.includes("Repair-CloudFunctionTimeout"),
  "部署脚本必须支持只读核验和900秒自动修正"
);
assert.ok(
  source.includes("Get-CloudBaseFunctionSnapshot")
    && source.includes("Assert-CloudBaseFunctionSnapshot")
    && source.includes("Assert-DeploymentImageConfiguration"),
  "部署脚本必须独立核验线上代码快照和图片主备配置"
);
assert.ok(
  source.includes("原始输出已隐藏")
    && !source.includes("throw \"CloudBase CLI 请求失败：$text\""),
  "CloudBase 详情可能包含环境变量，失败时不能回显原始输出"
);
const verifyBranchEnd = source.indexOf('Write-Host "1/7 Check WechatIDE login"');
const verifyBranchStart = source.lastIndexOf("if ($VerifyOnly)", verifyBranchEnd);
assert.ok(verifyBranchStart >= 0 && verifyBranchEnd > verifyBranchStart, "只读核验分支缺失");
const verifyBranch = source.slice(verifyBranchStart, verifyBranchEnd);
assert.ok(
  !verifyBranch.includes('"cloud_fn_deploy"')
    && !verifyBranch.includes("Repair-CloudFunctionTimeout"),
  "VerifyOnly 分支不能上传代码或修改线上配置"
);
assert.ok(
  verifyBranch.includes("-ReadOnly")
    && verifyBranch.includes("Get-CloudBaseFunctionSnapshot"),
  "VerifyOnly 必须使用不写部署日志的运行时检查和 CloudBase 代码快照"
);
assert.ok(
  apiSource.includes("const readOnly = Boolean(event && event.readOnly)")
    && apiSource.includes("const logWritten = readOnly")
    && apiSource.includes("allowMigrations: !readOnly")
    && apiSource.includes("cache: !readOnly"),
  "云函数只读核验不能写部署日志、配置迁移或缓存"
);
[
  "timeoutMs: Number(configs.image.timeoutMs) || 0",
  "timeoutMs: Number(configs.imageBackup.timeoutMs) || 0",
  "tencentFaceFusion:",
  "flows:",
  "totalSteps: 1",
  "totalSteps: 2",
].forEach((text) => {
  assert.ok(apiSource.includes(text), `线上配置核验缺少字段：${text}`);
});
assert.ok(
  verifySource.includes("deploy-and-verify-api.ps1")
    && verifySource.includes("-VerifyOnly"),
  "只读线上核验入口没有复用 VerifyOnly"
);
assert.ok(
  source.includes('"--remote-npm-install"'),
  "部署脚本必须强制远程安装 npm 依赖"
);
assert.ok(
  source.includes("check-cloudfunction-dependencies.js")
    && source.includes("Assert-RuntimeDependencies"),
  "部署脚本必须执行本地依赖扫描并断言线上依赖健康状态"
);
assert.ok(
  source.includes("Ensure-LocalCloudFunctionDependencies")
    && source.includes("Ensure-ManifestCloudFunctionDependencies")
    && source.includes("scripts\\payment-cloudfunctions.json")
    && npmCacheSource.includes('"ci"')
    && npmCacheSource.includes('"--ignore-scripts"'),
  "隔离发布工作树缺少 node_modules 时必须按 lockfile 安装全部云函数依赖"
);
const dependencyInstallIndex = source.indexOf("Ensure-LocalCloudFunctionDependencies");
const paymentDependencyInstallIndex = source.indexOf("Ensure-ManifestCloudFunctionDependencies");
const localValidationIndex = source.indexOf('scripts\\validate.js');
const strictDeploymentCheckIndex = source.indexOf('scripts\\check-deployment.js');
const dependencyCheckIndex = source.lastIndexOf('scripts\\check-cloudfunction-dependencies.js');
assert.ok(
  dependencyInstallIndex >= 0
    && paymentDependencyInstallIndex > dependencyInstallIndex
    && paymentDependencyInstallIndex < localValidationIndex
    && localValidationIndex > dependencyInstallIndex
    && strictDeploymentCheckIndex > localValidationIndex
    && dependencyCheckIndex > dependencyInstallIndex,
  "发布脚本必须先安装并检查全部云函数依赖，再执行全量校验"
);
assert.ok(
  source.includes("[string]$NpmCachePath")
    && source.includes("npm-dependency-cache.ps1")
    && source.includes("-CacheRoot $NpmCachePath")
    && source.includes("-DependencyCheckScript")
    && npmCacheSource.includes("LockSha256")
    && npmCacheSource.includes("prefer-offline")
    && npmCacheSource.includes("PreferOnline"),
  "部署脚本必须接入按 lockfile 指纹隔离的本机 npm 缓存"
);
assert.ok(
  apiSource.includes("runtimeDependencies")
    && apiSource.includes("checkRuntimeDependencies")
    && apiSource.includes('"local-modules"'),
  "checkDeployment 必须返回脱敏的运行依赖健康状态"
);
assert.ok(
  source.includes("Enter-CloudDeployLock")
    && source.includes("Exit-CloudDeployLock")
    && source.includes("Assert-CloudDeploySourceSnapshotStable"),
  "真实部署必须使用独占锁并检查源码快照"
);
assert.ok(
  source.includes("Get-DeploymentResult")
    && source.includes("-ReadOnly")
    && source.includes("Assert-CloudDeployVersionNotDowngrade")
    && source.indexOf("Assert-CloudDeployVersionNotDowngrade")
      < source.indexOf('"cloud_fn_deploy"'),
  "真实部署必须在上传前读取线上版本并禁止降级"
);
assert.ok(
  safetySource.includes("Compare-CloudDeployVersions")
    && safetySource.includes("Assert-CloudDeployVersionNotDowngrade")
    && safetySource.includes("Get-CloudBaseFunctionVersion"),
  "部署保护脚本必须包含版本比较、降级拦截和 CloudBase 版本读取"
);
assert.ok(
  source.includes("[switch]$ResumePendingDeploy")
    && source.includes("Write-CloudDeployPending")
    && source.includes("Read-CloudDeployPending")
    && source.includes("DEPLOY_CONFIRMATION_REQUIRED")
    && source.includes("duplicate uploads are blocked"),
  "部署确认任务必须落盘并支持只恢复旧任务，禁止重复上传"
);
assert.ok(
  source.includes('[ValidateSet("auto", "wechat", "cloudbase")]')
    && source.includes('[string]$DeployTransport = "auto"')
    && source.includes("Resolve-CloudDeployTransport"),
  "部署入口必须支持 auto/wechat/cloudbase，默认使用自动选择"
);
assert.ok(
  source.includes("Invoke-CloudBaseFunctionDeploy")
    && source.includes('if ($resolvedDeployTransport -eq "cloudbase")'),
  "自动选择到 CloudBase 时必须调用公共直部署函数"
);
const cloudbaseBranchStart = source.indexOf(
  'if ($resolvedDeployTransport -eq "cloudbase")'
);
const cloudbaseBranchEnd = source.indexOf(
  "else {",
  cloudbaseBranchStart
);
assert.ok(
  cloudbaseBranchStart >= 0 && cloudbaseBranchEnd > cloudbaseBranchStart,
  "部署方式分支缺失"
);
const cloudbaseBranch = source.slice(cloudbaseBranchStart, cloudbaseBranchEnd);
assert.ok(
  !cloudbaseBranch.includes('"cloud_fn_deploy"'),
  "CloudBase 直部署分支不能再调用微信确认弹窗部署"
);
const postDirectVerificationStart = source.indexOf(
  'if ($resolvedDeployTransport -eq "cloudbase")',
  cloudbaseBranchEnd + 1
);
const wechatBranch = source.slice(
  cloudbaseBranchEnd,
  postDirectVerificationStart >= 0
    ? postDirectVerificationStart
    : source.length
);
assert.ok(
  !wechatBranch.includes("Invoke-CloudBaseFunctionDeploy"),
  "微信部署分支不能在失败后偷偷切回 CloudBase 重复上传"
);
assert.ok(
  cloudbaseDeploySource.includes("Invoke-CloudBaseFunctionDeploy")
    && cloudbaseDeploySource.includes("Get-CloudBaseFunctionVersion"),
  "独立 CloudBase 部署入口必须复用公共直部署和线上版本保护"
);
assert.ok(
  releaseLockSource.includes("[IO.FileShare]::None")
    && safetySource.includes("Get-CloudDeploySourceSnapshot")
    && safetySource.includes("ApiFingerprint"),
  "部署保护脚本必须使用独占文件锁和 API 源码指纹"
);
assert.ok(
  source.includes("-SkipRemoteNpmInstall is disabled"),
  "部署脚本必须拒绝不携带依赖的危险参数"
);
assert.ok(
  !source.includes("$payload.isAdmin"),
  "checkDeployment 已自行校验管理员，脚本不能把缺少 isAdmin 字段误判为无权限"
);
assert.ok(
  !/if\s*\(\s*-\s*not\s+\$SkipRemoteNpmInstall\s*\)/i.test(source),
  "远程 npm 安装不能再由可选分支控制"
);

const parse = cp.spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-Command",
    `[scriptblock]::Create([IO.File]::ReadAllText('${scriptPath.replace(/'/g, "''")}')) | Out-Null`,
  ],
  {
    cwd: root,
    encoding: "utf8",
  }
);
assert.strictEqual(
  parse.status,
  0,
  `部署脚本 PowerShell 语法错误\n${parse.stdout}\n${parse.stderr}`
);
const verifyParse = cp.spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-Command",
    `[scriptblock]::Create([IO.File]::ReadAllText('${verifyScriptPath.replace(/'/g, "''")}')) | Out-Null`,
  ],
  {
    cwd: root,
    encoding: "utf8",
  }
);
assert.strictEqual(
  verifyParse.status,
  0,
  `只读线上核验脚本 PowerShell 语法错误\n${verifyParse.stdout}\n${verifyParse.stderr}`
);
const safetyParse = cp.spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-Command",
    `[scriptblock]::Create([IO.File]::ReadAllText('${safetyScriptPath.replace(/'/g, "''")}')) | Out-Null`,
  ],
  {
    cwd: root,
    encoding: "utf8",
  }
);
assert.strictEqual(
  safetyParse.status,
  0,
  `部署保护脚本 PowerShell 语法错误\n${safetyParse.stdout}\n${safetyParse.stderr}`
);

const blocked = cp.spawnSync(
  "pwsh",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-SkipRemoteNpmInstall",
    "-DryRun",
  ],
  {
    cwd: root,
    encoding: "utf8",
  }
);
assert.notStrictEqual(
  blocked.status,
  0,
  "危险的 -SkipRemoteNpmInstall 参数必须被拒绝"
);
assert.ok(
  `${blocked.stdout}\n${blocked.stderr}`.includes(
    "-SkipRemoteNpmInstall is disabled"
  ),
  "危险参数的失败提示不明确"
);

console.log("deployment script smoke: OK");
