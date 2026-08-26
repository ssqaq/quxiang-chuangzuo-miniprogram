# 生图后台稳定性、任务监控与视频内核迁移设计

## 背景

当前主线版本为 `0.42.10`。普通生图已经具备 Action Registry、异步队列、状态机、阶段历史、幂等扣费、失败退款和任务回收能力，但后台还存在以下缺口：

1. 管理员看不到当前排队数量、最老任务等待时间和 worker 实际并发数；
2. `generation_operations.stageHistory` 已经写入数据库，但管理员没有查看入口；
3. Action Registry 只有 smoke 检查，缺少面向公开接口和权限边界的契约测试；
4. 视频任务仍由云函数入口中的旧函数直接处理，状态、恢复和日志没有通过依赖注入的统一内核；
5. 生图 worker 每轮只处理 1 个任务，并发数写死在代码中；
6. 云函数和媒体 worker 的依赖存在已知安全告警，但当前没有可重复执行的审计脚本和发布报告。

本设计覆盖用户选择的功能编号 `1、2、3、4、5、7`。实施采用稳妥的方案 A：先补齐后台可见性、配置、测试和安全审计，再把视频任务的状态、计费和恢复逐步接入统一内核。

## 目标

- 管理员页面能看到生图队列是否积压，并能手动刷新。
- 队列达到告警阈值时写入脱敏服务端日志，恢复正常时写一条恢复日志。
- 管理员可以按任务查看最多 20 条阶段历史，普通用户看不到内部字段。
- Action Registry 的 action、权限、定时器匹配、日志和异常格式有稳定的自动化契约。
- 生图 worker 并发数可由管理员配置，默认行为仍与当前一致。
- 视频任务保持原 action、请求参数、返回字段和页面行为，同时接入依赖注入、状态机、阶段历史、幂等扣费、幂等退款和任务回收。
- 依赖漏洞可以一键审计并生成脱敏报告，但不自动执行破坏性升级。
- 不新增数据库集合，不引入外部通知服务，不覆盖原开发目录的未提交改动。

## 非目标

- 不发送微信订阅消息、短信、邮件或第三方告警。
- 不新增任务中心，不修改普通用户页面布局。
- 不改变 `generate`、`getGenerationStatus`、`createVideoTask`、`queryVideoTask` 的公开名称和现有字段。
- 不把视频创建请求强制改成后台排队；本轮先统一视频任务的执行内核和恢复能力，后续再单独评估视频排队调度。
- 不迁移腾讯融合、修图、导出、实况照片封装等其他任务。
- 不新增数据库集合、模型、密钥或外部服务。
- 不运行 `npm audit fix --force`，不为了消除告警盲目升级关键依赖。

## 方案选择

### 方案 A：分阶段接入现有内核（采用）

先增加队列监控、历史查看、Registry 契约测试、worker 并发配置和依赖审计，再把视频任务接入依赖注入的执行内核。

优点：

- 公开接口不变；
- 生图和视频可以分开验证；
- 出现问题时能按功能单独回退；
- 不需要新增云函数或数据库集合。

代价：

- `cloudfunctions/api/index.js` 中仍会保留部分旧 action 兜底；
- 视频本轮不会改成和生图完全相同的后台排队模式。

### 方案 B：一次性把图片和视频全部改成统一队列

架构最整齐，但会改变视频 `taskId` 的产生时机和现有轮询语义，容易影响照片转视频页面，不采用。

### 方案 C：只增加管理员展示，不改执行逻辑

风险最低，但无法解决并发写死、视频恢复不统一和依赖审计缺失，不采用。

## 总体架构

### 组件职责

| 组件 | 职责 |
|---|---|
| Action Registry | 统一 action 识别、权限判断、`requestId`、开始/结束/异常日志和错误映射 |
| 生图执行内核 | 提交生图、查询状态、按并发领取任务、处理队列、回收异常任务 |
| 视频执行内核 | 创建视频任务、查询上游、保存结果、失败退款和回收卡住任务 |
| 状态机 | 校验合法状态变化，追加最多 20 条脱敏阶段历史 |
| 队列监控服务 | 统计排队、处理中、失败、退款等数量，计算最老任务等待时间和告警状态 |
| 管理员 API | 只向管理员返回队列摘要、任务摘要和指定任务的阶段历史 |
| 管理员页面 | 展示队列状态、并发配置、任务列表和阶段历史 |
| 依赖审计脚本 | 审计两个 Node 项目，输出机器可读和人可读报告 |

### 执行入口

云函数入口继续只负责：

1. 构造 `requestId` 和执行上下文；
2. 调用 Action Registry；
3. Registry 未处理的旧 action 继续走现有兼容分发；
4. 统一记录函数级开始、完成和异常日志。

本轮新增或迁移进 Registry 的 action：

- `createVideoTask`
- `queryVideoTask`
- `getAdminGenerationQueue`
- `getAdminGenerationOperationHistory`

已登记的以下 action 保持不变：

- `generate`
- `getGenerationStatus`
- `processGenerationQueue`
- `reconcileGenerationOperations`

其他旧 action 仍走兼容兜底。

## 数据设计

### 继续使用 `generation_operations`

不新增集合。图片和视频都继续通过 `kind` 区分：

- `kind: "image"`
- `kind: "video"`

现有字段保持兼容，并统一使用：

| 字段 | 用途 |
|---|---|
| `requestId` | 用户侧幂等任务编号 |
| `openid` | 数据库内部归属校验，不直接返回管理员页面 |
| `kind` | 图片或视频 |
| `status` | `reserved / queued / processing / succeeded / failed / refunding / refunded` |
| `pipelineStage` | 当前处理阶段 |
| `progress` | 0 到 100 的整数 |
| `attemptCount` | worker 或恢复尝试次数 |
| `providerTaskId` | 视频上游任务编号 |
| `billing` | 扣费与退款状态 |
| `stageHistory` | 最多 20 条脱敏阶段历史 |
| `lastHeartbeatAt` | 判断任务是否卡住 |
| `lastError` | 脱敏错误码、短消息和是否可重试 |
| `resultFileID` / `videoFileID` | 成功结果文件 |
| `cleanupPending` | 结果文件需要继续清理 |
| `refundPending` | 退款需要继续重试 |

### 阶段历史

阶段历史单条结构保持：

```js
{
  at,
  fromStatus,
  status,
  stage,
  progress,
  attemptCount,
  actor,
  code
}
```

限制：

- 只保留最后 20 条；
- 不保存完整 OpenID、提示词、API Key、图片内容、请求头或上游完整响应；
- 同状态、同阶段、同结果码的安全重复调用不重复刷历史；
- 管理员接口返回脱敏任务编号和用户哈希，普通状态接口不返回 `stageHistory`。

### 管理员运行配置

继续使用现有管理员运行配置文档，增加：

```js
generationQueue: {
  workerConcurrency: 1,
  alertThreshold: 5,
  alertCooldownMinutes: 10
}
```

约束：

- `workerConcurrency` 允许 `1-4`，非法值回退为 `1`；
- `alertThreshold` 允许 `1-100`，默认 `5`；
- `alertCooldownMinutes` 允许 `1-60`，默认 `10`；
- 保存配置时继续采用字段白名单，不允许前端写入服务端内部告警状态。

同一份运行配置文档允许服务端维护不返回编辑表单的内部字段：

```js
generationQueueAlertState: {
  active,
  signature,
  lastAlertAt,
  lastRecoveredAt
}
```

该字段只用于跨云函数实例去重告警，不新增集合。

## 功能设计

### 1. 队列积压监控与告警

新增管理员 action `getAdminGenerationQueue`，只允许管理员调用。返回：

- 各状态任务数量；
- 图片和视频任务数量；
- 当前排队数；
- 当前处理数；
- 最老排队任务等待秒数；
- 最近任务摘要，默认 20 条，最多 50 条；
- 生效的 worker 并发数和告警阈值；
- 当前是否处于告警状态；
- 数据生成时间。

队列 worker 每次运行前后各读取一次轻量摘要。满足以下条件时进入告警：

```text
queuedCount >= alertThreshold
```

告警日志事件：

- `generation.queue-backlog-alert`
- `generation.queue-backlog-recovered`

日志只包含：

- 排队数量；
- 处理中数量；
- 最老等待秒数；
- 并发数；
- 阈值；
- 时间。

不包含 OpenID、提示词或文件内容。相同告警在冷却时间内不重复写入；队列恢复到阈值以下时允许立即写一次恢复日志。

管理员页面把该状态展示成：

- 正常：绿色；
- 接近告警线：黄色；
- 已达到告警线：红色。

本轮不发送微信通知。

### 2. 管理员任务阶段历史

管理员监控区增加任务列表。每条显示：

- 脱敏任务编号；
- 图片或视频；
- 当前状态和阶段；
- 进度；
- 尝试次数；
- 最近结果码；
- 创建、更新时间；
- 等待或处理时长。

点击任务后调用 `getAdminGenerationOperationHistory`。请求只接收任务记录 ID 或完整 `requestId`，服务端再次验证管理员权限并查询原始记录。返回：

- 任务摘要；
- 最多 20 条脱敏历史；
- 脱敏错误摘要；
- 计费状态摘要；
- 是否等待退款或清理。

接口不返回输入快照、完整提示词、完整 OpenID、密钥和上游完整响应。

### 3. Action Registry 契约

Registry 需要稳定保证：

1. 已登记 action 优先按 action 精确匹配；
2. 定时触发必须精确匹配登记的 trigger 名称；
3. 用户 action、管理员 action、定时器或管理员 action 分别执行对应权限策略；
4. 未知 action 返回 `{ handled: false }`，继续进入旧分发；
5. 每次处理都带统一 `requestId`；
6. 拒绝、开始、完成、异常和错误映射失败都有结构化日志；
7. handler 抛出的异常按现有公开错误格式映射；
8. 重复 action 和重复 trigger 在启动时直接报错；
9. Registry 的元数据只用于内部诊断，不进入普通用户响应。

新增契约测试覆盖：

- 用户调用图片和视频公开 action；
- 普通用户调用管理员 action 被拒绝；
- 管理员手动调用 worker 和回收 action；
- 正确、错误和近似 trigger 名称；
- 未知 action 兼容兜底；
- `requestId` 透传；
- 日志开始、完成、拒绝和异常；
- 错误映射成功和映射器自身失败；
- 重复登记保护。

### 4. 视频任务逐步迁移

新增依赖注入的 `video-execution-kernel`，把当前 `createVideoTask` 和 `queryVideoTask` 中的编排逻辑移入内核。云函数入口只提供：

- 配置解析；
- 用户身份；
- 数据库读写；
- 计费；
- 上游创建和查询；
- 图片标准化；
- 文件下载、上传和删除；
- 日志和公开响应构造。

#### 视频创建

公开调用仍为 `createVideoTask`，并继续返回现有 `taskId`、状态、provider、模型、清晰度、源图信息和 billing 字段。

内部流程：

```text
校验 → 幂等预留额度 → 创建/领取 operation → 处理源图
→ 调用上游 → 保存 providerTaskId → 返回
```

状态变化：

```text
初始 → reserved → processing
```

上游在创建请求内直接完成时允许：

```text
processing → succeeded
```

重复 `requestId`：

- 已成功：直接返回已保存结果；
- 已拿到 `providerTaskId`：返回原任务，不再次调用上游；
- 正在创建：返回兼容的处理中结果或明确的可重试状态；
- 已退款：不允许重新占用同一任务编号。

#### 视频查询

公开调用仍为 `queryVideoTask`，并继续验证 `taskId` 与原 operation 的归属。

查询结果：

- 上游处理中：更新心跳、阶段和 provider 状态；
- 上游成功：只下载并上传一次视频，补写结果后进入 `succeeded`；
- 上游失败或取消：进入 `failed → refunding → refunded`；
- 重复成功查询：复用已保存 `videoFileID`，不重复下载和上传；
- 结果文件已上传但记录未完成：由回收逻辑补齐。

#### 视频任务回收

现有 `reconcileGenerationOperations` 按 `kind` 分发：

- 图片继续走现有图片回收逻辑；
- 视频走新的视频回收适配器。

视频回收处理：

- `reserved` 长时间没有创建上游任务：失败并退款；
- `processing` 且已有 `providerTaskId`：查询上游并继续完成或退款；
- 上游成功但结果文件未落库：重新补写；
- 结果文件存在但任务最终退款：幂等清理；
- `failed/refunding`：继续退款且只成功一次；
- 已 `succeeded/refunded`：安全跳过。

本轮不把视频创建改成后台排队，因此 worker 并发配置先作用于生图队列。视频已经完成状态、计费、历史和回收的统一，后续若要排队调度，可以在不改页面字段的前提下单独设计兼容层。

### 5. Worker 并发配置

`processGenerationQueue` 不再只领取一个任务，而是：

1. 读取生效配置，取得 `workerConcurrency`；
2. 连续执行原子领取，最多领取该数量；
3. 没有更多任务时提前停止领取；
4. 使用 `Promise.allSettled` 并行处理已经成功领取的不同任务；
5. 单个任务失败不影响其他任务；
6. 汇总返回领取数、成功数、失败数和每项脱敏结果码。

防重依赖现有 operation 原子状态更新：

```text
queued → processing
```

只有抢占成功的 worker 才能执行上游调用。重复 worker、重叠定时器和管理员手动调用都不能处理同一任务两次。

默认并发为 `1`，即使管理员从未保存新配置，线上行为也与当前版本一致。

### 7. 依赖安全审计

新增 `scripts/dependency-security-audit.js`，审计：

- `cloudfunctions/api/package-lock.json`
- `media-worker/package-lock.json`（存在时）

支持两种模式：

1. 默认模式：执行在线 `npm audit --json --omit=dev`；
2. `--input` 模式：读取保存的 audit JSON，用于无网络测试和 smoke。

报告输出到项目外或发布临时目录，内容包括：

- 项目名称；
- 审计时间；
- npm 和 Node 版本；
- `low/moderate/high/critical` 数量；
- advisory 或 vulnerability 标识；
- 受影响依赖；
- 是否存在普通升级修复；
- 是否只能通过破坏性升级修复；
- 建议动作。

规则：

- 不保存 registry token、代理密码、环境变量或完整请求；
- 不自动执行任何修复；
- `critical` 漏洞使正式发布检查失败；
- 已知 `moderate/high` 先生成报告和风险说明，不在本轮强制升级；
- 新增 smoke 使用固定脱敏样本，验证解析、严重等级和退出码，不依赖网络；
- 正式交付时额外执行一次真实在线审计并记录报告路径。

## 接口兼容

### 普通用户接口

以下公开接口保持名称、主要请求参数和现有返回字段：

- `generate`
- `getGenerationStatus`
- `createVideoTask`
- `queryVideoTask`

允许只新增不会影响旧页面的附加字段，例如 `pipelineStage`、`progress` 或 `deduplicated`，但不删除旧字段、不改变成功与失败判定。

### 管理员接口

新增：

- `getAdminGenerationQueue`
- `getAdminGenerationOperationHistory`

继续要求管理员权限。`processGenerationQueue` 和 `reconcileGenerationOperations` 手动调用也仍要求管理员权限；只有精确匹配的定时触发器使用系统身份。

## 管理员页面

不改现有整体布局，只在监控区域增加一张可折叠卡片：

### 队列概览

- 排队；
- 处理中；
- 失败待退款；
- 最老等待；
- 当前并发；
- 告警阈值；
- 状态灯；
- 刷新按钮。

### Worker 设置

- 并发数选择 `1-4`；
- 告警阈值输入 `1-100`；
- 冷却时间输入 `1-60` 分钟；
- 继续通过现有“保存管理员配置”提交。

### 最近任务

- 默认 20 条；
- 图片、视频和状态筛选；
- 点击展开阶段历史；
- 每次只加载一条任务的历史，避免一次返回大量数据。

管理员模块加载失败时只影响该卡片，不阻塞模型配置、用量和用户统计等其他模块。

## 错误处理与安全

- 管理员接口权限失败继续返回现有 `ADMIN_FORBIDDEN`。
- 数据库集合不存在时返回可读的未初始化状态，不让管理员页面整体崩溃。
- 队列统计失败写告警日志，但不阻止 worker 尝试处理任务。
- 并发处理使用单任务隔离，一个失败不取消其他已领取任务。
- 视频上游错误只保存脱敏错误码和短消息。
- 所有退款继续依赖计费台账幂等键，重复回收只退款一次。
- 所有文件删除允许安全重复调用；文件已经不存在视为清理完成。
- 日志和阶段历史不得写入 API Key、完整 OpenID、图片内容、完整提示词和上游完整响应。

## 测试设计

### Registry

- 权限矩阵；
- trigger 精确匹配；
- 未知 action 兜底；
- 日志事件；
- 异常映射；
- 重复登记；
- `requestId` 透传。

### 队列与并发

- 配置缺失回退为 1；
- 非法并发值被限制；
- 并发为 2、3、4 时领取数量正确；
- 多 worker 重叠只领取一次；
- 单任务失败不拖累其他任务；
- 告警阈值、冷却和恢复日志；
- 管理员队列摘要脱敏。

### 阶段历史

- 最多保留 20 条；
- 安全重复调用不刷重复历史；
- 非法状态跳转被拒绝；
- 普通状态接口不返回内部历史；
- 管理员详情接口只返回脱敏历史。

### 视频

- 重复创建只调用一次上游；
- 已有 `providerTaskId` 时返回原任务；
- 查询任务归属校验；
- 成功结果只下载上传一次；
- 上游失败只退款一次；
- 卡住任务由回收逻辑继续查询；
- 结果补写；
- 孤儿视频清理；
- 原页面 smoke 和返回字段不变。

### 依赖审计

- 两个项目都能被发现；
- audit JSON 正确解析；
- 无漏洞、high、critical 和审计失败退出码正确；
- 报告中不出现敏感环境变量；
- smoke 不访问网络。

### 完整回归

至少运行：

- Action Registry smoke 和契约测试；
- 生图异步、执行内核、状态机、并发、孤儿清理；
- 生图体验和图片编辑路由；
- 视频 provider、照片转视频、实况照片和临时文件清理；
- 管理员加载、响应式布局和配置保存；
- 依赖审计 smoke；
- 完整 `scripts/validate.js`。

## 发布与回滚

### 发布

- 从 `origin/main` 的 `0.42.10` 创建独立分支和 worktree；
- 实现完成并通过完整验证后升级到 `0.42.11`；
- 正式打包并检查 ZIP 非空；
- 计算 SHA256；
- 通过受控同步脚本只提交明确文件；
- 核对本地 `HEAD`、`origin/main` 和发布记录。

### 回滚

各部分可独立回滚：

- 管理员卡片和管理员 action；
- worker 并发读取，回退后默认继续单任务；
- 视频执行内核，入口可恢复旧 handler；
- 依赖审计脚本和发布检查。

数据库没有新增集合。新增配置字段缺失时都有默认值，回滚代码后不会影响旧版本读取。

## 验收标准

1. 管理员能看到真实队列数量、最老等待和当前并发。
2. 队列达到 5 条的默认阈值后写一次脱敏告警，10 分钟内不重复刷屏，恢复后写恢复日志。
3. 管理员能查看最多 20 条任务历史，普通用户接口不泄露历史。
4. worker 并发可配置为 1 到 4，重复 worker 不会重复处理任务。
5. 视频原页面和接口不改，重复创建、成功补写、失败退款和卡住恢复都有测试。
6. Action Registry 的权限、trigger、日志、异常和兜底有契约测试。
7. 两个 Node 项目生成依赖安全报告，不自动强制升级。
8. 完整 `scripts/validate.js` 通过。
9. 版本升级到 `0.42.11`，正式包非空并提供 SHA256。
10. 原开发目录 `D:\aips小程序\wechat-miniapp` 的未提交改动保持不变。
