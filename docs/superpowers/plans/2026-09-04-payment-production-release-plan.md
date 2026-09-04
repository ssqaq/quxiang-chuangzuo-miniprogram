# Payment Production Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在最新正式基线上开启已实现的微信支付生产链并完成受保护的正式发布、部署、导入与上传。

**Architecture:** 支付源码继续对缺失 provider 参数失败关闭；生产启用状态由受版本控制的部署合同和 CloudBase 运行配置共同决定。发布必须经过 canonical FIFO 闸门，线上资源由幂等 PowerShell 脚本创建并回读，微信代码上传绑定同一 release context。

**Tech Stack:** 微信小程序、Node.js 20、CloudBase CLI、PowerShell 7、GitHub CLI、微信开发者工具 CLI。

**Spec:** `docs/superpowers/specs/2026-09-04-payment-production-release-design.md`

## Global Constraints

- 基线为已验收 `0.57.151`，最终版本由发布闸门再次扫描后自动分配，禁止硬编码。
- 支付宝保持关闭；微信支付、下单、回调、对账、充值和全量灰度开启。
- 不把任何 API Key、AppSecret、RSA 私钥或 `.env` 写入源码、Git、ZIP 或日志。
- 不执行真实扣款；未取得平台正式发布回执不得宣称线上正式发布成功。
- canonical `D:\aips小程序\wechat-miniapp` 的用户改动不可覆盖或清理。

---

### Task 1: 合并依赖修复并锁定生产合同

**Files:**
- Modify: `scripts/payment-cloudfunctions.json`
- Modify: `cloudfunctions/payment-core/config.js`
- Modify: `cloudfunctions/payment-api/vendor/payment-core/config.js`
- Modify: `cloudfunctions/payment-notify/vendor/payment-core/config.js`
- Modify: `cloudfunctions/payment-reconcile/vendor/payment-core/config.js`
- Test: `scripts/payment-deployment-smoke.js`

**Interfaces:**
- Consumes: 任务 `01a0680a-bf6c-7c93-b0e1-e892fa4f7133` 的干净 commit。
- Produces: `productionDeployment.enabled=true`、三个已声明函数和微信支付全量生产默认配置。

- [ ] **Step 1: 写出预期为生产开启的 smoke 断言**

```js
assert.equal(manifest.productionDeployment.enabled, true);
assert.equal(manifest.productionDeployment.automaticDeployment, true);
assert.equal(DEFAULT_RECHARGE_CONFIG.rechargeEnabled, true);
assert.equal(DEFAULT_RECHARGE_CONFIG.channelConfig.wxpay.enabled, true);
assert.equal(DEFAULT_RECHARGE_CONFIG.gray.rolloutPercent, 100);
```

- [ ] **Step 2: 运行 smoke 并确认旧关闭合同失败**

Run: `node scripts/payment-deployment-smoke.js`
Expected: FAIL，指出生产部署或充值默认值仍为 false。

- [ ] **Step 3: 修改合同与四份一致的 config**

只把已实现的微信支付链设为 true；`alipay.enabled` 继续固定 false。

- [ ] **Step 4: 运行支付单测和 vendor 一致性检查**

Run: `node --test cloudfunctions/payment-core/tests/*.test.js`
Expected: PASS。

Run: `node scripts/payment-deployment-smoke.js`
Expected: PASS。

### Task 2: 让发布门禁接受明确生产授权

**Files:**
- Modify: `scripts/release-version.ps1`
- Modify: `scripts/package-release.py`
- Modify: `scripts/release.ps1`
- Test: `scripts/package-release-smoke.py`
- Test: `scripts/release-workflow-smoke.js`

**Interfaces:**
- Consumes: Task 1 的生产合同。
- Produces: 只接受完整生产合同的版本同步、正式包校验和可恢复发布入口。

- [ ] **Step 1: 把 smoke 从“全部必须 false”改为精确生产合同**

Run: `python scripts/package-release-smoke.py`
Expected: 修改实现前 FAIL。

- [ ] **Step 2: 更新门禁校验**

门禁只允许三个既定函数；notify 只允许 HTTP，reconcile 只允许 Timer；支付宝和任何额外入口继续拒绝。

- [ ] **Step 3: 转发恢复发布参数**

`release.ps1 -ResumeOperation` 必须把 `-AllowOutOfOrder` 传给 `resume-release.ps1`，避免旧 prepared 票据阻断本次明确恢复。

- [ ] **Step 4: 运行打包与发布 smoke**

Run: `python scripts/package-release-smoke.py`
Expected: PASS。

Run: `node scripts/release-workflow-smoke.js`
Expected: PASS。

### Task 3: 增加幂等生产部署脚本

**Files:**
- Create: `scripts/deploy-payment-production.ps1`
- Create: `scripts/payment-production-deploy-smoke.js`
- Modify: `scripts/payment-cloudfunctions.json`

**Interfaces:**
- Consumes: `-ProjectPath`、`-EnvironmentId`、可选仓库外 `-SecretFile`、release context。
- Produces: 不含密钥的 JSON 回执，记录集合、索引、函数、路由、Timer、运行开关和充值配置的回读状态。

- [ ] **Step 1: 写部署脚本静态 smoke**

```js
for (const marker of ["payment_orders", "payment_events", "recharge_config", "payment_monitor_status", "PAYMENT_ORDER_CREATION_ENABLED", "PAYMENT_CALLBACK_PROCESSING_ENABLED", "PAYMENT_RECONCILIATION_ENABLED"]) {
  assert.ok(source.includes(marker));
}
```

- [ ] **Step 2: 实现 `-WhatIf` 预检**

Run: `pwsh -File scripts/deploy-payment-production.ps1 -ProjectPath . -EnvironmentId cloud1-d4g05zdxc94d17112 -WhatIf`
Expected: 不改云端，只返回计划和缺失 secret 键名。

- [ ] **Step 3: 实现幂等资源创建和回读**

集合已存在则复用；唯一索引创建前先查重；函数部署后回读运行时、超时和环境变量键名；路由与 Timer 创建后按名称回读。

- [ ] **Step 4: 写入全开配置**

三个运行开关设为字符串 `true`；`recharge_config/global` 写入 `rechargeEnabled=true`、`wxpay.enabled=true`、`alipay.enabled=false`、`rolloutPercent=100`。

- [ ] **Step 5: 运行静态 smoke**

Run: `node scripts/payment-production-deploy-smoke.js`
Expected: PASS，且输出中不出现 secret 值。

### Task 4: 全量本地验证和提交

**Files:**
- Test: `scripts/validate.js`
- Test: `scripts/check-cloudfunction-dependencies.js`
- Test: all files modified above

**Interfaces:**
- Consumes: Tasks 1-3。
- Produces: 可供统一发布闸门读取的干净 source commit。

- [ ] **Step 1: 运行 Node、Python、PowerShell 语法检查**

Run: `node scripts/validate.js`
Expected: PASS。

Run: `node scripts/check-cloudfunction-dependencies.js`
Expected: PASS。

- [ ] **Step 2: 扫描敏感内容和工作区漂移**

Run: `git diff --check`
Expected: 无输出且退出码 0。

- [ ] **Step 3: 只暂存清单内文件并提交**

```powershell
git add -- <明确文件清单>
git commit -m "feat: enable production payment release"
```

### Task 5: 重新核版、正式打包、Push 与 CloudBase 部署

**Files:**
- Runtime output: `D:\aips小程序\wechat-miniapp-release-contexts\release-<operationId>.json`
- Runtime output: `D:\aips小程序\wechat-miniapp-release-records\release-v<version>-<sha>.json`
- Runtime output: `D:\aips小程序\wechat-miniapp-release-v<version>-<sha>.zip`

**Interfaces:**
- Consumes: Task 4 source commit 与固定 canonical 策略。
- Produces: GitHub merged PR、不可变 ZIP、CloudBase 部署和验收回执。

- [ ] **Step 1: 从 canonical 再次扫描记录、队列、reservation 和产物**

Run: `pwsh -File scripts/release-status.ps1`
Expected: 能识别最新已验收版本和旧 prepared/recoverable 票据。

- [ ] **Step 2: 调用统一发布闸门**

```powershell
pwsh -File .\scripts\release.ps1 -SourcePath "D:\aips小程序\_payment-production-v057152" -IncludePath @(<明确文件清单>) -Publish -DeployCloud -AllowOutOfOrder -PreviewCliPath "D:\微信web开发者工具\cli.bat"
```

Expected: 自动分配补丁号、打包、push release 分支、创建并合并 PR、部署 CloudBase `api`、导入并编译 release worktree。

- [ ] **Step 3: 在同一 release worktree 执行支付生产部署**

Run: `pwsh -File scripts/deploy-payment-production.ps1 -ProjectPath <releaseWorktree> -EnvironmentId cloud1-d4g05zdxc94d17112 -ReleaseContext <contextPath>`
Expected: 所有非密钥生产开关和资源回读一致；缺失 RSA 参数只报告键名。

### Task 6: 微信上传、提审和正式发布核验

**Files:**
- Runtime output: 微信开发者工具 upload info JSON
- Runtime output: release acceptance report

**Interfaces:**
- Consumes: Task 5 的版本、release worktree 和 release context。
- Produces: 微信代码上传回执，以及可获得时的平台提审/正式发布回执。

- [ ] **Step 1: 上传同一正式版本**

```powershell
& "D:\微信web开发者工具\cli.bat" upload --project <releaseWorktree> --version <version> --desc "支付生产启用" --info-output <receiptPath>
```

Expected: CLI 退出码 0，回执版本与 context 一致。

- [ ] **Step 2: 查找现有公众平台 API 凭据和自动发布工具**

只输出凭据是否存在和键名，不输出值；存在则提交审核并轮询结果，审核通过后发布。

- [ ] **Step 3: 最终一致性核验**

核对 GitHub main、release commit、ZIP SHA-256、CloudBase build marker、开发者工具导入路径、微信 upload 版本和平台发布状态。
