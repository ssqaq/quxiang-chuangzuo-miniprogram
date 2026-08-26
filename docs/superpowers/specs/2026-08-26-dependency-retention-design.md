# 依赖安全升级与旧任务历史清理设计

## 背景

当前主线版本为 `0.45.0`。`cloudfunctions/api` 依赖审计存在 1 个 moderate、6 个 high、0 个 critical：

- `xlsx@0.18.5` 是可直接处理的高风险依赖；
- `wx-server-sdk@4.0.2` 是当前稳定版本，但它依赖的 CloudBase、Axios 和 Lodash 子包仍会触发审计告警；
- `npm audit` 建议降级到 `wx-server-sdk@2.5.3`，隔离探测显示该路线会引入 3 个 critical、6 个 high，因此禁止采用；
- `generation_operations` 会持续保存图片和视频任务，当前没有面向终态旧任务的统一保留期。

本设计采用用户批准的方案 A：安全升级可升级的直接依赖、固定微信 SDK 稳定版本，并对已经彻底结束的旧任务记录执行保守清理。

## 目标

- 将 `xlsx` 从 npm registry 的 `0.18.5` 更新到 SheetJS 官方 `0.20.3`。
- 将官方包解压后放入仓库，云函数安装依赖时不依赖 SheetJS CDN 可用性。
- 将 `wx-server-sdk` 从浮动的 `latest` 固定为 `4.0.2`，避免未来重新安装时无意改变云函数运行环境。
- 保持依赖审计对 critical 的阻断策略，不使用 `npm audit fix --force`。
- `generation_operations` 中符合条件的终态旧记录默认保留 90 天。
- 每天自动清理一次，每次最多删除 50 条。
- 管理员可以手动执行相同清理逻辑并查看本次摘要。
- 不删除用户作品、云存储结果文件、`generation_records`、积分账户或积分流水。
- 普通用户接口、参数、返回字段和页面行为保持不变。

## 非目标

- 不降级到 `wx-server-sdk@2.5.3`。
- 不通过强制覆盖 Axios、Lodash 等内部包来伪造零告警。
- 不更换微信云开发 SDK，不重写 CloudBase 数据库和文件接口。
- 不删除失败、排队、处理中、退款中或仍需文件清理的任务。
- 不新增数据库集合，不新增外部服务和密钥。
- 不清理用户生成记录、作品文件或积分账本。

## 依赖方案

### xlsx

在 `cloudfunctions/api/vendor` 保存解压后的官方包目录：

```text
xlsx/
```

`package.json` 使用本地文件依赖：

```json
{
  "xlsx": "file:vendor/xlsx"
}
```

这样做有三个目的：

1. 使用包含安全修复的官方版本，原始官方包 SHA256 为
   `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`；
2. 正式部署时不依赖第三方 CDN 临时可用；
3. `package-lock.json` 和发布包可以复现同一份依赖。

现有代码继续使用 `require("xlsx")`，Excel 导出接口和文件格式不变。

### wx-server-sdk

`package.json` 从：

```json
{
  "wx-server-sdk": "latest"
}
```

改为：

```json
{
  "wx-server-sdk": "4.0.2"
}
```

本轮接受官方稳定版本仍存在的传递依赖告警，但必须满足：

- 0 critical；
- 审计报告明确列出剩余告警；
- 不自动执行破坏性修复；
- 完整 CloudBase、图片、视频、管理员和导出测试通过。

## 旧任务保留策略

继续使用现有 `generation_operations`，不新增集合。

默认策略：

```js
{
  retentionDays: 90,
  batchSize: 50
}
```

约束：

- `retentionDays` 限制为 30 到 365 天；
- `batchSize` 限制为 1 到 50；
- 截止时间使用 `updatedAt <= 当前时间 - retentionDays`；
- 每次运行最多删除 `batchSize` 条；
- 图片和视频任务使用同一规则。

### 允许删除

只有以下状态允许进入清理候选：

- `succeeded`
- `refunded`

并且必须同时满足：

- `cleanupPending !== true`
- `refundPending !== true`
- `reconcilePending !== true`
- `updatedAt` 存在且早于截止时间

### 永不删除

- `reserved`
- `queued`
- `processing`
- `failed`
- `refunding`
- 缺少有效 `updatedAt` 的记录
- 仍有退款、回收或文件清理标记的记录

删除前再次读取原记录并重新判断，防止候选读取后状态发生变化。

清理只删除 operation 文档，不删除：

- `generation_records`
- 云存储图片或视频
- `point_ledger`
- `user_accounts`
- `user_quotas`

## 组件设计

### 纯逻辑模块

新增：

```text
cloudfunctions/api/lib/generation-operation-retention.js
```

职责：

- 规范化保留期和批量数量；
- 计算截止时间；
- 判断单条任务能否删除；
- 生成脱敏清理摘要。

该模块不直接访问数据库，方便独立测试。

### 数据库适配

云函数入口提供：

- 分状态读取旧任务候选；
- 按文档 ID 重新读取；
- 删除单条 operation；
- 集合不存在时返回未初始化摘要。

查询分别读取 `succeeded` 和 `refunded`，合并后按更新时间从旧到新排序，只处理最多 50 条。

### Action Registry

新增登记：

```text
action: cleanupGenerationOperationHistory
trigger: generation-operation-history-cleanup
access: timer-or-admin
```

规则：

- 管理员可以手动调用；
- 只有精确匹配的 trigger 使用系统身份；
- 普通用户直接调用必须返回 `ADMIN_FORBIDDEN`；
- 近似或伪造 trigger 不得获得系统权限。

### 定时器

`cloudfunctions/api/config.json` 增加每天一次的：

```text
generation-operation-history-cleanup
```

默认在凌晨执行，单次最多 50 条。某条删除失败只记录脱敏 warning，并继续处理其他候选。

### 管理员页面

现有队列监控卡片增加：

- 保留天数说明；
- 单次上限说明；
- “清理旧任务记录”按钮；
- 二次确认；
- 本次扫描数、删除数、跳过数和失败数。

按钮调用服务端管理员 action。模块失败只显示提示，不影响管理员其他功能。

## 日志

成功或部分成功：

```text
generation.operation-history-cleanup
```

单条失败：

```text
generation.operation-history-cleanup-item-failed
```

日志只记录：

- 来源是 timer 还是 admin；
- 保留天数；
- 截止时间；
- 扫描、删除、跳过和失败数量；
- 脱敏错误码。

不记录完整 OpenID、提示词、文件内容、API Key 或完整任务输入。

## 测试

### 依赖

- `vendor/xlsx` 官方包目录存在且非空；
- `package.json` 固定 `wx-server-sdk@4.0.2`；
- `xlsx` 实际加载版本为 `0.20.3`；
- 现有 Excel 导出 smoke 继续通过；
- 在线审计保持 0 critical；
- 依赖审计报告不泄露环境变量和凭据。

### 清理纯逻辑

- 默认和边界配置；
- 90 天截止时间；
- `succeeded/refunded` 旧记录允许删除；
- 新记录不删除；
- 非终态不删除；
- 三种 pending 标记不删除；
- 无效日期不删除；
- 摘要不包含 OpenID 和任务输入。

### 云函数与权限

- 管理员手动清理成功；
- 普通用户被拒绝；
- 正确 trigger 通过；
- 近似 trigger 不通过；
- 单次最多 50 条；
- 删除前状态变化时安全跳过；
- 单条删除失败不影响其他条目；
- 集合不存在返回可读结果。

### 回归

- Action Registry 契约；
- 生图队列、状态机、并发、退款和回收；
- 视频创建、查询、恢复和清理；
- 图片编辑、图片容灾和像素保护；
- Excel 导出；
- 管理员加载、配置、响应式和队列监控；
- 完整 `scripts/validate.js`。

## 发布

- 基线：`0.45.0`
- 目标版本：`0.45.1`
- 在独立分支和 worktree 中开发；
- 完整验证后把明确文件同步到最新 `origin/main`；
- 使用受控同步脚本提交、推送并生成正式 ZIP；
- 核对远端提交、发布记录、包大小和 SHA256；
- 原目录 `D:\aips小程序\wechat-miniapp` 保持不变。

## 回滚

- `xlsx` 可恢复到原依赖和锁文件；
- `wx-server-sdk` 固定版本可恢复为上一版本的声明；
- 删除定时器和 Registry 登记即可停止自动清理；
- 已删除的 operation 历史不会自动恢复，因此清理规则必须保持保守，并在上线前通过防误删测试。

## 验收标准

1. `xlsx@0.20.3` 从仓库内解压后的官方包目录安装并通过现有导出测试。
2. `wx-server-sdk` 固定为 `4.0.2`，没有使用 `latest`。
3. 在线依赖审计为 0 critical，并输出剩余风险报告。
4. 只有 90 天前的 `succeeded/refunded` 且无 pending 标记记录会被删除。
5. 单次最多删除 50 条，单条失败不阻塞整轮。
6. 管理员可以手动清理，普通用户和伪造 trigger 被拒绝。
7. 不删除用户作品、生成记录、云文件和积分账本。
8. 完整校验通过。
9. 版本升级到 `0.45.1`，正式包、SHA256、GitHub commit 和发布记录齐全。
