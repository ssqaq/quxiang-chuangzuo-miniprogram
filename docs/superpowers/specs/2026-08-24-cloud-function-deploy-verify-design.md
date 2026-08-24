# 云函数部署后自动验证设计

## 1. 目标

解决“开发者工具显示部署完成，但线上实际还是旧版本”的问题。

用户执行一个脚本后，脚本自动完成：

1. 读取本地 `config.js` 的小程序版本、CloudBase 环境 ID 和云函数名称；
2. 使用微信开发者工具 CLI 部署 `cloudfunctions/api`；
3. 等待部署命令返回成功；
4. 在当前小程序运行时调用线上 `api` 云函数的 `checkDeployment`；
5. 对比线上 `buildVersion` 和本地 `appVersion`；
6. 版本一致才返回成功，否则明确提示线上仍是旧版本。

本地 `cloudfunctions/api/index.js` 的 `API_BUILD_VERSION` 也必须和
`config.js` 一致，避免发布包自己就带着两个版本号。

## 2. 方案比较

### 方案 A：只增加“部署后验证”脚本（采用）

脚本负责部署和验证，用户不用再手动点管理员页面。

- 优点：流程最短，能直接阻止“假部署成功”；
- 优点：继续复用云函数已有的 `checkDeployment` 接口；
- 优点：不新增密钥、不改变业务接口；
- 缺点：电脑上必须安装并登录微信开发者工具，且开启 CLI 服务。

### 方案 B：只在管理员页面里提示版本不一致

管理员手动点“检查线上部署”后再看版本。

- 优点：改动小；
- 缺点：仍然依赖人工操作，不能防止部署流程漏检查；
- 缺点：开发者工具上传失败或没有真正更新时，仍可能被忽略。

### 方案 C：增加独立服务器版本登记

部署时把版本写入数据库，再由客户端读取。

- 优点：可以做更复杂的发布记录；
- 缺点：需要额外数据库数据和写入流程；
- 缺点：登记成功不代表云函数代码真的更新，反而容易造成假阳性。

采用方案 A。真正的判断依据是“线上云函数自己返回的版本号”，不依赖本地登记。

## 3. 文件和职责

### `scripts/deploy-and-verify-api.ps1`

- 自动查找 `wechatide.cmd`；
- 支持传入项目路径、CLI 路径和客户端名称；
- 先执行 `cloud_fn_deploy`，默认远程安装依赖；
- 部署成功后调用 `automation_evaluate`；
- 解析云函数返回值；
- 校验 `ok`、管理员权限、`buildVersion`、`buildMarker`；
- 线上版本不等于本地版本时以非零退出码结束；
- 不打印密钥和完整用户身份信息。

### `scripts/validate.js`

把新 PowerShell 脚本加入语法检查和必要文件检查，避免脚本被改坏后仍能打包。

### `README.md`

补充一条最简单的发布命令和失败提示，让使用者知道：

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\deploy-and-verify-api.ps1
```

部署检查通过后，才继续上传小程序体验版。

## 4. 失败处理

- 找不到 CLI：提示设置 `WECHATIDE_CLI` 或传入 `-WechatIde`；
- CLI 服务端口未开启：提示在微信开发者工具“设置 → 安全设置”打开；
- 部署命令失败：立即停止，不执行验证；
- 当前开发者工具没有打开该项目运行时：脚本自动打开项目后再验证；
- 云函数返回非管理员：提示检查当前登录微信是否在 `ADMIN_OPENIDS`；
- 线上返回旧版本：显示本地版本、线上版本和构建标记，并以失败结束；
- 线上版本一致：显示验证通过。

## 5. 验证

1. PowerShell 脚本语法检查；
2. `node scripts/validate.js`；
3. `node scripts/check-deployment.js --strict`；
4. 运行管理员配置 smoke，确认 `checkDeployment` 仍返回版本；
5. 使用 `-DryRun` 验证脚本参数和本地配置读取；
6. 升级补丁版本、正式打包并同步 GitHub。

## 6. 范围

本次不修改管理员页面布局，不修改 `checkDeployment` 的业务判断，不自动改云函数环境变量，也不把任何 API Key 写入脚本或日志。
