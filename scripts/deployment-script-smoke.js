/* eslint-disable no-console */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const root = path.resolve(__dirname, "..");
const scriptPath = path.join(root, "scripts", "deploy-and-verify-api.ps1");
const source = fs.readFileSync(scriptPath, "utf8");
const apiConfig = JSON.parse(
  fs.readFileSync(
    path.join(root, "cloudfunctions", "api", "config.json"),
    "utf8"
  )
);

assert.ok(
  source.includes("Assert-CloudFunctionDeploymentResult"),
  "部署脚本必须检查云函数部署结果中的隐藏错误"
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
  source.includes('"--remote-npm-install"'),
  "部署脚本必须强制远程安装 npm 依赖"
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
