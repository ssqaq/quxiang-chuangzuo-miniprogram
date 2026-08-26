# 图片模型主备容错实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为普通版和腾讯版第一阶段加入“星炬 `jw-gpt-image-2` 重试一次，再切凌云 `gpt-image-2`”的统一主备容错，同时保持一次逻辑扣费、像素保护和腾讯独立重试。

**Architecture:** 保留 `cloudfunctions/api/index.js` 中现有单 provider 图片请求函数，在 `cloudfunctions/api/lib/image-provider-failover.js` 增加纯编排逻辑。现有 `image` 作为主配置，新增 `imageBackup` 作为备用配置；普通异步 worker 和腾讯第一阶段传入同一编排器。像素保护硬闸门扩展为仅允许已确认的星炬和凌云模型，最终合成及验收不因 provider 改变。

**Tech Stack:** 微信小程序 JavaScript/WXML/WXSS、CloudBase 云函数、Node.js、`wx-server-sdk`、现有 smoke 测试与 `scripts/validate.js`。

---

## 文件结构和职责

### 新增文件

- `cloudfunctions/api/lib/image-provider-failover.js`
  - 生成固定主备尝试计划；
  - 判断错误是否允许重试或切备用；
  - 逐次调用注入的单 provider 执行函数；
  - 返回最终结果和实际命中的 provider 元数据。
- `cloudfunctions/api/tests/image-provider-failover.test.js`
  - 单测星炬首成功、星炬重试、切凌云、最终失败、不可重试错误和尝试元数据。
- `scripts/image-provider-failover-smoke.js`
  - 静态验证普通版、腾讯版、配置、超时和腾讯独立重试均已接线。

### 修改文件

- `cloudfunctions/api/lib/pixel-protection-flow.js`
  - 把凌云专用硬闸门扩展为星炬和凌云白名单；
  - 保留旧导出别名，避免并行代码立即断裂。
- `cloudfunctions/api/index.js`
  - 新增主、备用配置解析；
  - 扩展管理员运行时配置、校验、脱敏和部署状态；
  - 把普通版和腾讯第一阶段接入统一编排器；
  - 把底层单 provider 自动重试关闭，由编排器精确控制；
  - 记录每次尝试和最终命中 provider；
  - 腾讯第二阶段保持 `maxAttempts: 2`、75 秒，并复用中间图。
- `pages/admin/admin.js`
  - 新增 `imageBackup` 表单、配置读取和保存；
  - 图片主模型默认 150000 毫秒和重试 1 次；
  - 备用模型默认 150000 毫秒且不做内部重试。
- `pages/admin/admin.wxml`
  - 图片配置区分为主模型和备用模型；
  - 明确显示执行顺序和腾讯第二阶段规则。
- `pages/admin/admin.wxss`
  - 仅补充主备区块的轻量分隔样式。
- `pages/index/index.js`
  - 根据 operation 的 provider 阶段展示“主模型重试/切备用”状态；
  - 不新增衣服、背景、光影的独立调用。
- `pages/tencent-face-fusion/tencent-face-fusion.js`
  - 保持页面总等待 150 秒语义；
  - 用户提示区分第一阶段主备和第二阶段腾讯重试。
- `scripts/validate.js`
  - 加入新增单测和 smoke。
- `scripts/image-edit-routing-smoke.js`
  - 更新允许 provider 和主备调用断言。
- `scripts/tencent-face-fusion-smoke.js`
  - 断言腾讯重试不再次执行第一阶段。
- `cloudfunctions/api/package.json`
  - 增加主备单测脚本，版本随正式发布升级。
- `project.config.json`
  - 按项目发布规则升级小程序版本描述或由打包脚本更新对应版本文件。

---

## Task 1：先锁定主备编排行为

**Files:**
- Create: `cloudfunctions/api/tests/image-provider-failover.test.js`
- Create: `cloudfunctions/api/lib/image-provider-failover.js`
- Modify: `cloudfunctions/api/package.json`

- [ ] **Step 1：写失败测试**

测试注入 `executeAttempt`，记录每次调用的 `role`、`attempt`、`provider`、`model` 和 `timeoutMs`。至少写出以下场景：

```js
assert.deepStrictEqual(calls, [
  { role: "primary", attempt: 1, provider: "xingju", model: "jw-gpt-image-2", timeoutMs: 150000 }
]);

assert.deepStrictEqual(retryCalls.map((item) => `${item.role}:${item.attempt}`), [
  "primary:1",
  "primary:2"
]);

assert.deepStrictEqual(fallbackCalls.map((item) => `${item.role}:${item.attempt}`), [
  "primary:1",
  "primary:2",
  "backup:1"
]);
```

不可重试的素材或像素保护错误必须只调用一次；鉴权错误允许立即跳到备用，但不得再次调用同一主模型。

- [ ] **Step 2：运行失败测试**

运行：

```powershell
node cloudfunctions/api/tests/image-provider-failover.test.js
```

预期：因模块或导出不存在而失败。

- [ ] **Step 3：实现最小编排模块**

模块导出：

```js
buildImageProviderAttemptPlan(primaryConfig, backupConfig)
classifyImageProviderError(error)
runImageProviderFailover(options)
```

尝试计划默认是：

```js
[
  { role: "primary", attempt: 1, config: primaryConfig },
  { role: "primary", attempt: 2, config: primaryConfig },
  { role: "backup", attempt: 1, config: backupConfig }
]
```

`runImageProviderFailover` 必须支持 `onAttemptStart`、`onAttemptFinish` 回调，并在全部失败时抛出带 `attempts` 脱敏摘要的 `IMAGE_PROVIDER_FAILOVER_EXHAUSTED`。

- [ ] **Step 4：运行单测**

运行：

```powershell
node cloudfunctions/api/tests/image-provider-failover.test.js
```

预期：全部断言通过。

## Task 2：扩展图片配置和管理员保存

**Files:**
- Modify: `cloudfunctions/api/index.js`
- Modify: `pages/admin/admin.js`
- Modify: `pages/admin/admin.wxml`
- Modify: `pages/admin/admin.wxss`
- Test: `scripts/image-provider-failover-smoke.js`

- [ ] **Step 1：写配置 smoke**

断言：

```js
resolveImageConfig().model === "jw-gpt-image-2"
resolveImageConfig().timeoutMs === 150000
resolveImageBackupConfig().model === "gpt-image-2"
resolveImageBackupConfig().timeoutMs === 150000
resolveTencentFaceFusionConfig().timeoutMs === 75000
```

同时验证管理员表单存在 `form.imageBackup`，保存 payload 包含 `imageBackup`，页面不渲染真实 API Key。

- [ ] **Step 2：扩展服务端配置**

新增：

```js
function resolveImageBackupConfig(overrides = {}) { ... }
```

`resolveEffectiveConfigs()` 返回 `imageBackup`。`normalizeRuntimePatch`、`validateRuntimePatch`、`mergeRuntimeConfig`、`redactConfig`、`adminConfigView`、`checkDeployment` 和测试导出同步支持该字段。

图片超时校验范围改为 `5000～180000`，主、备用都允许 150000；腾讯超时校验和默认值允许 75000。

- [ ] **Step 3：扩展管理员页面**

主图片配置显示：

```text
主模型：星炬 jw-gpt-image-2
单次超时：150000
失败重试：1 次
```

备用图片配置显示：

```text
备用模型：凌云 gpt-image-2
单次超时：150000
主模型两次失败后调用 1 次
```

保存时分别发送 `image` 和 `imageBackup`。

- [ ] **Step 4：运行配置 smoke**

运行：

```powershell
node scripts/image-provider-failover-smoke.js
```

预期：配置、表单和超时断言全部通过。

## Task 3：把像素保护硬闸门改为双 provider 白名单

**Files:**
- Modify: `cloudfunctions/api/lib/pixel-protection-flow.js`
- Modify: `cloudfunctions/api/tests/pixel-protection.test.js`
- Modify: `scripts/image-edit-routing-smoke.js`

- [ ] **Step 1：增加失败测试**

分别验证：

```js
assertSupportedImageEditFlow(
  { provider: "xingju", model: "jw-gpt-image-2" },
  "https://example.com/v1/images/edits"
);

assertSupportedImageEditFlow(
  { provider: "lingyun", model: "gpt-image-2" },
  "https://example.com/v1/images/edits"
);
```

错误模型、错误 provider 和非 `/v1/images/edits` endpoint 必须抛错。

- [ ] **Step 2：实现通用硬闸门**

新增 `assertSupportedImageEditFlow`，返回标准化的 `{ provider, model, endpointPath }`。保留：

```js
const assertLingyunImageEditFlow = assertSupportedImageEditFlow;
```

作为兼容别名，但业务接线全部改用新名称。

- [ ] **Step 3：运行像素保护测试**

运行：

```powershell
npm --prefix cloudfunctions/api run test:pixel-protection
node scripts/image-edit-routing-smoke.js
```

预期：星炬和凌云通过，其他组合 fail-closed。

## Task 4：普通异步生图接入主备编排器

**Files:**
- Modify: `cloudfunctions/api/index.js`
- Modify: `pages/index/index.js`
- Modify: `scripts/generation-async-smoke.js`
- Test: `cloudfunctions/api/tests/image-provider-failover.test.js`

- [ ] **Step 1：抽出单 provider 执行**

把 `executeImageGeneration` 中从“调用图片接口”到“取得原始结果 Buffer”的部分封装为可由编排器调用的函数。每次传入当前 provider config，底层 `requestImageEdits` 的 `maxAttempts` 固定为 1。

- [ ] **Step 2：接入统一编排**

普通 `edits` 模式执行：

```js
runImageProviderFailover({
  primaryConfig: configs.image,
  backupConfig: configs.imageBackup,
  executeAttempt: ({ config, role, attempt }) => requestImageEdits(...),
  onAttemptStart: (...) => updateGenerationOperation(...),
  onAttemptFinish: (...) => record attempt summary
});
```

素材下载、mask 预检只执行一次，并把同一 `preparedAssets` 复用于三次可能的上游尝试。

- [ ] **Step 3：保存最终命中信息**

operation 和结果至少保存：

```text
provider
model
providerRole
providerAttempt
providerAttempts[]
```

`providerAttempts[]` 只含脱敏字段，不含 URL query、API Key 或响应正文。

- [ ] **Step 4：前端状态**

根据 operation 增加阶段：

```text
provider-primary
provider-primary-retry
provider-backup
```

页面分别显示“正在使用主模型生成”“主模型暂时失败，正在重试”“正在切换备用模型”。

- [ ] **Step 5：运行普通版测试**

运行：

```powershell
node scripts/generation-async-smoke.js
node scripts/generation-experience-smoke.js
node cloudfunctions/api/tests/image-provider-failover.test.js
```

预期：首成功只调用星炬一次；星炬两次失败后只调用凌云一次；同一 requestId 仍只预留一次额度。

## Task 5：腾讯版第一阶段接入主备，第二阶段保持独立

**Files:**
- Modify: `cloudfunctions/api/index.js`
- Modify: `pages/tencent-face-fusion/tencent-face-fusion.js`
- Modify: `scripts/tencent-face-fusion-smoke.js`
- Modify: `cloudfunctions/api/tests/pixel-protection.test.js`

- [ ] **Step 1：腾讯第一阶段复用编排器**

`requestTencentPipelineImageEdit` 继续只执行单 provider 请求，调用处使用 `runImageProviderFailover`。主、备用共用已下载素材和人脸矩形保护数据。

- [ ] **Step 2：中间图元数据中性化**

新任务写 `pixelProtectionMetrics.imageEditIntermediate`；恢复逻辑按以下顺序读取：

```js
metrics.imageEditIntermediate || metrics.lingyunIntermediate
```

保证旧任务继续可重试腾讯。

- [ ] **Step 3：腾讯只重试腾讯**

`requestTencentFaceFusion` 保持：

```js
timeoutMs: 75000
maxAttempts: 2
```

`retryTencentOnly` 路径只能读取 operation 的中间图和保护元数据，不得调用 `runImageProviderFailover`、`requestTencentPipelineImageEdit` 或重新扣费。

- [ ] **Step 4：运行腾讯测试**

运行：

```powershell
node scripts/tencent-face-fusion-smoke.js
npm --prefix cloudfunctions/api run test:pixel-protection
```

预期：第一阶段可从星炬切凌云；第二阶段失败仅增加腾讯调用次数，图片 provider 调用次数不变。

## Task 6：补齐错误、成本和幂等测试

**Files:**
- Modify: `cloudfunctions/api/index.js`
- Modify: `cloudfunctions/api/tests/image-provider-failover.test.js`
- Modify: `scripts/generation-async-smoke.js`
- Modify: `scripts/model-usage-export-detail-smoke.js`

- [ ] **Step 1：验证一次逻辑扣费**

对同一 `requestId` 模拟三次 provider 尝试，断言：

```text
reserveUsage 调用次数 = 1
refundUsage 最多调用次数 = 1
generation_records 数量 = 1
```

- [ ] **Step 2：验证逐次成本事件**

每次 provider 尝试都记录自己的 provider、model、attempt 和耗时；总成本统计按真实上游调用事件展示，不能把三次尝试伪装成一次。

- [ ] **Step 3：验证错误提示**

普通用户只收到统一提示和请求编号；管理员日志保留脱敏尝试摘要。断言错误对象和 operation 中不存在 `apiKey`、`authorization`。

- [ ] **Step 4：运行专项测试**

运行：

```powershell
node scripts/model-usage-export-detail-smoke.js
node scripts/generation-orphan-cleanup-smoke.js
node scripts/image-provider-failover-smoke.js
```

预期：全部通过。

## Task 7：全量验证、升版本和正式打包

**Files:**
- Modify: `cloudfunctions/api/package.json`
- Modify: 项目现有版本来源文件
- Modify: `scripts/validate.js`
- Produce: `D:\aips小程序\wechat-miniapp-release-v<新版本>.zip`

- [ ] **Step 1：运行语法与专项测试**

```powershell
node --check cloudfunctions/api/index.js
node --check cloudfunctions/api/lib/image-provider-failover.js
node --check pages/admin/admin.js
node --check pages/index/index.js
node --check pages/tencent-face-fusion/tencent-face-fusion.js
npm --prefix cloudfunctions/api run test:pixel-protection
npm --prefix cloudfunctions/api run test:image-provider-failover
node scripts/image-provider-failover-smoke.js
node scripts/tencent-face-fusion-smoke.js
node scripts/generation-async-smoke.js
```

预期：所有命令退出码为 0。

- [ ] **Step 2：运行全量校验**

```powershell
node scripts/validate.js
```

预期：输出所有 smoke 通过且退出码为 0。

- [ ] **Step 3：升级补丁版本**

读取当前正式版本；若并行任务已把版本升级，则在最新版本基础上再升级补丁号，禁止覆盖回旧版本。

- [ ] **Step 4：正式打包**

```powershell
python scripts/package-release.py
```

确认 ZIP 存在、大小大于 0，并计算 SHA256。

## Task 8：受控同步和最终核对

**Files:**
- 只同步本计划实际修改的文件。

- [ ] **Step 1：运行受控同步**

```powershell
& .\scripts\sync-to-github.ps1 -IncludePath @(
  "cloudfunctions/api/lib/image-provider-failover.js",
  "cloudfunctions/api/lib/pixel-protection-flow.js",
  "cloudfunctions/api/tests/image-provider-failover.test.js",
  "cloudfunctions/api/tests/pixel-protection.test.js",
  "cloudfunctions/api/index.js",
  "cloudfunctions/api/package.json",
  "pages/admin/admin.js",
  "pages/admin/admin.wxml",
  "pages/admin/admin.wxss",
  "pages/index/index.js",
  "pages/tencent-face-fusion/tencent-face-fusion.js",
  "scripts/image-provider-failover-smoke.js",
  "scripts/image-edit-routing-smoke.js",
  "scripts/tencent-face-fusion-smoke.js",
  "scripts/generation-async-smoke.js",
  "scripts/model-usage-export-detail-smoke.js",
  "scripts/validate.js",
  "docs/superpowers/specs/2026-08-26-image-provider-failover-design.md",
  "docs/superpowers/plans/2026-08-26-image-provider-failover-plan.md"
)
```

实际列表必须按最终 `git diff --name-only` 调整，禁止把无关并行修改加入。

- [ ] **Step 2：核对远端**

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

确认本次文件已同步；若工作区仍有其他并行任务未提交文件，必须明确列出，不能虚报整个工作区干净。

