# 生图稳定性、管理员监控与视频内核迁移实施计划

**目标：** 在不改变普通用户接口和页面行为的前提下，增加队列积压告警、管理员任务历史、Action Registry 契约测试、可配置 worker 并发、视频执行内核和依赖安全审计。

**架构：** 继续使用现有 `api` 云函数和 `generation_operations`。新增纯逻辑队列监控模块和依赖注入的视频执行内核；云函数入口负责组装数据库、配置、计费、文件和日志服务。管理员页面通过两个管理员 action 读取队列摘要和单任务历史。视频保持同步创建、轮询查询的公开语义，只统一状态、计费、历史和回收。

**技术栈：** 微信小程序 JavaScript/WXML/WXSS、CloudBase、Node.js、`wx-server-sdk`、现有 smoke/validate、npm audit JSON。

---

## 文件范围

### 新增

- `cloudfunctions/api/lib/generation-queue-monitor.js`
- `cloudfunctions/api/lib/video-execution-kernel.js`
- `scripts/generation-queue-monitor-smoke.js`
- `scripts/generation-worker-concurrency-smoke.js`
- `scripts/action-registry-contract-smoke.js`
- `scripts/video-execution-kernel-smoke.js`
- `scripts/dependency-security-audit.js`
- `scripts/dependency-security-audit-smoke.js`

### 修改

- `cloudfunctions/api/index.js`
- `cloudfunctions/api/lib/generation-execution-kernel.js`
- `cloudfunctions/api/lib/generation-state-machine.js`（仅在视频迁移暴露出必要兼容时修改）
- `cloudfunctions/api/package.json`
- `cloudfunctions/api/package-lock.json`
- `cloudfunctions/api/.env.example`
- `services/cloud.js`
- `pages/admin/admin.js`
- `pages/admin/admin.wxml`
- `pages/admin/admin.wxss`
- `scripts/validate.js`
- `README.md`
- 根版本文件和 `media-worker` 版本文件

### 不修改

- 普通生图和照片转视频页面布局；
- `repairImage`、腾讯融合、导出和实况照片任务架构；
- 原开发目录 `D:\aips小程序\wechat-miniapp`；
- 密钥和本地 `.env`。

---

## Task 1：队列监控纯逻辑和测试

**文件：**

- 新增 `cloudfunctions/api/lib/generation-queue-monitor.js`
- 新增 `scripts/generation-queue-monitor-smoke.js`

### 步骤

- [ ] 先写 smoke，覆盖默认配置、配置上下限、状态计数、图片/视频计数、最老排队时间、任务脱敏和历史最多 20 条。
- [ ] 实现 `normalizeQueueSettings`：
  - `workerConcurrency` 默认 1，限制 1-4；
  - `alertThreshold` 默认 5，限制 1-100；
  - `alertCooldownMinutes` 默认 10，限制 1-60。
- [ ] 实现 `buildQueueSnapshot`，只处理传入任务，不访问数据库。
- [ ] 实现 `buildAdminOperationSummary` 和 `buildAdminOperationHistory`，不返回完整 OpenID、提示词、输入快照和上游响应。
- [ ] 实现 `decideQueueAlert`，覆盖首次告警、冷却期、告警续期和恢复。
- [ ] 运行：

```powershell
node scripts/generation-queue-monitor-smoke.js
```

---

## Task 2：管理员配置和队列查询 API

**文件：**

- 修改 `cloudfunctions/api/index.js`
- 修改 `services/cloud.js`
- 修改 `cloudfunctions/api/.env.example`

### 步骤

- [ ] 把 `generationQueue` 加入管理员运行配置白名单。
- [ ] 读取配置时合并默认值；保存时限制数值范围。
- [ ] 服务端内部保留 `generationQueueAlertState`，管理员保存表单不得覆盖。
- [ ] 新增数据库查询适配器：
  - 按状态查询任务；
  - 合并并去重；
  - 默认返回最近 20 条，最多 50 条；
  - 集合不存在时返回未初始化状态。
- [ ] 新增 `getAdminGenerationQueue`：
  - 管理员权限；
  - 返回队列摘要、最近任务、设置和告警状态。
- [ ] 新增 `getAdminGenerationOperationHistory`：
  - 管理员权限；
  - 按 operation ID 或 `requestId` 查询；
  - 只返回脱敏摘要和最多 20 条历史。
- [ ] 把两个 action 登记到 Action Registry。
- [ ] 在 `services/cloud.js` 增加对应调用封装。

---

## Task 3：队列积压告警

**文件：**

- 修改 `cloudfunctions/api/index.js`
- 修改 `cloudfunctions/api/lib/generation-execution-kernel.js`
- 扩展 `scripts/generation-queue-monitor-smoke.js`

### 步骤

- [ ] 增加队列观察服务，通过数据库轻量查询生成 snapshot。
- [ ] worker 每轮开始和结束都观察队列。
- [ ] 达到阈值写 `generation.queue-backlog-alert`。
- [ ] 恢复正常写 `generation.queue-backlog-recovered`。
- [ ] 使用运行配置文档中的内部状态跨实例去重。
- [ ] 统计或告警状态写入失败只写 warning，不阻止 worker。
- [ ] 测试同一告警 10 分钟内只写一次，恢复日志只写一次。

---

## Task 4：Worker 并发配置

**文件：**

- 修改 `cloudfunctions/api/lib/generation-execution-kernel.js`
- 修改 `cloudfunctions/api/index.js`
- 新增 `scripts/generation-worker-concurrency-smoke.js`
- 回归 `scripts/generation-concurrency-smoke.js`

### 步骤

- [ ] 给生图内核注入 `queue.settings` 和 `queue.observe`。
- [ ] `processGenerationQueue` 按配置连续领取最多 1-4 个任务。
- [ ] 没任务时提前停止领取。
- [ ] 使用 `Promise.allSettled` 处理已领取任务。
- [ ] 返回 `claimed/processed/succeeded/failed/results`，保留旧 `processed` 字段。
- [ ] 单任务失败转成脱敏结果，不让整轮 worker 抛弃其他任务。
- [ ] 测试并发 1、2、4、领取不足、处理失败和重复抢占。

---

## Task 5：Action Registry 契约测试

**文件：**

- 新增 `scripts/action-registry-contract-smoke.js`
- 必要时修改 `cloudfunctions/api/lib/action-registry.js`

### 步骤

- [ ] 覆盖用户、管理员、定时器或管理员三种权限。
- [ ] 覆盖正确 trigger、近似 trigger、错误 trigger 和 action 冒充定时器。
- [ ] 覆盖未知 action `{ handled: false }`。
- [ ] 覆盖 `requestId` 透传和 metadata。
- [ ] 覆盖 denied/start/finish/error/error-map-failed 日志。
- [ ] 覆盖 handler 错误映射和映射器自身失败。
- [ ] 覆盖重复 action、重复 trigger。
- [ ] 保证现有 `scripts/action-registry-smoke.js` 继续通过。

---

## Task 6：管理员页面监控和阶段历史

**文件：**

- 修改 `pages/admin/admin.js`
- 修改 `pages/admin/admin.wxml`
- 修改 `pages/admin/admin.wxss`
- 修改相关管理员 smoke

### 步骤

- [ ] 增加 `generationQueue` 模块状态和空数据构造器。
- [ ] 后台加载和“刷新全部”时并行读取队列。
- [ ] 增加单独刷新队列方法。
- [ ] 队列卡片展示排队、处理中、待退款、最老等待、并发和告警阈值。
- [ ] 增加 `1-4` 并发选择和告警阈值、冷却时间输入，继续复用“保存全部配置”。
- [ ] 最近任务默认 20 条，可按图片/视频和状态过滤。
- [ ] 点击任务时加载单条历史，不一次返回全部历史。
- [ ] 增加正常、提醒、告警三种视觉状态。
- [ ] 模块失败只影响队列卡片，不影响现有模型、用量、用户和日志模块。
- [ ] 扩展响应式、加载和配置 smoke。

---

## Task 7：视频执行内核

**文件：**

- 新增 `cloudfunctions/api/lib/video-execution-kernel.js`
- 新增 `scripts/video-execution-kernel-smoke.js`
- 修改 `cloudfunctions/api/index.js`

### 步骤

- [ ] 先写依赖缺失、参数校验、重复创建、已有 provider task、创建失败退款、成功查询、失败查询和重复成功测试。
- [ ] 视频内核只通过注入访问：
  - 权限和身份；
  - 配置；
  - operation；
  - billing；
  - 源图处理；
  - provider；
  - 文件；
  - response；
  - 日志与时间。
- [ ] 把旧 `createVideoTask` 编排迁入内核：
  - 幂等预留；
  - 原子领取；
  - 源图标准化；
  - 上游幂等创建；
  - 保存 provider task；
  - 失败只退款一次。
- [ ] 把旧 `queryVideoTask` 编排迁入内核：
  - 归属校验；
  - 处理中更新心跳；
  - 成功结果只物化一次；
  - 失败或取消进入退款；
  - 重复查询复用结果。
- [ ] 在 Action Registry 登记 `createVideoTask` 和 `queryVideoTask`。
- [ ] 保留入口同名 wrapper 和旧测试导出，避免现有 smoke 失效。

---

## Task 8：视频任务回收

**文件：**

- 修改 `cloudfunctions/api/index.js`
- 修改 `cloudfunctions/api/lib/generation-execution-kernel.js`
- 扩展 `scripts/video-execution-kernel-smoke.js`
- 回归视频和孤儿清理 smoke

### 步骤

- [ ] `reconcileGenerationOperations` 按 `kind` 分发图片或视频。
- [ ] 视频 `reserved` 超时且无 provider task：失败、退款、清理源图。
- [ ] 视频 `processing` 且有 provider task：查询上游。
- [ ] 上游成功：补下载、上传和任务结果。
- [ ] 上游失败：只退款一次。
- [ ] 文件已上传但状态未完成：补记录。
- [ ] 已退款且文件仍存在：幂等清理。
- [ ] 单个视频回收失败不阻塞其他任务。

---

## Task 9：依赖安全审计

**文件：**

- 新增 `scripts/dependency-security-audit.js`
- 新增 `scripts/dependency-security-audit-smoke.js`
- 修改 `README.md`

### 步骤

- [ ] 支持在线调用 `npm audit --json --omit=dev`。
- [ ] 支持 `--input` 固定 JSON，不访问网络。
- [ ] 同时识别 `cloudfunctions/api` 和 `media-worker`。
- [ ] 输出 JSON 和 Markdown 摘要。
- [ ] 脱敏 registry token、代理凭据、环境变量和命令原始输出。
- [ ] `critical` 返回失败；moderate/high 记录但不自动升级。
- [ ] smoke 覆盖无漏洞、high、critical、格式错误和敏感字段。
- [ ] 正式交付前执行一次真实在线审计。

---

## Task 10：完整验证接入

**文件：**

- 修改 `scripts/validate.js`
- 修改必要的现有 smoke

### 步骤

- [ ] 加入所有新增脚本的语法检查和执行。
- [ ] 运行新增测试。
- [ ] 运行现有生图异步、状态机、并发、体验、孤儿清理和图片编辑路由测试。
- [ ] 运行视频 provider、照片转视频、实况照片和临时清理测试。
- [ ] 运行管理员加载、配置、响应式和布局测试。
- [ ] 运行完整：

```powershell
node scripts/validate.js
```

- [ ] 读取完整错误，逐项修复，直到通过。

---

## Task 11：版本、正式包和发布

**文件：**

- 修改所有项目版本标记
- 修改发布记录涉及的配置文件

### 步骤

- [ ] 版本从 `0.42.10` 升到 `0.42.11`。
- [ ] 核对 `API_BUILD_VERSION` 和 build marker。
- [ ] 正式打包到：

```text
D:\aips小程序\wechat-miniapp-release-v0.42.11.zip
```

- [ ] 检查 ZIP 存在、大小大于 0。
- [ ] 计算 SHA256。
- [ ] 使用受控同步脚本，仅传入本轮明确修改的文件。
- [ ] 核对本地 `HEAD`、`origin/main` 和发布记录 SHA。
- [ ] 确认原开发目录未提交改动保持原样。

---

## 完成定义

- [ ] 六项功能全部可用；
- [ ] 普通用户接口和页面行为兼容；
- [ ] 管理员能查看队列和阶段历史；
- [ ] worker 并发可配且不会重复抢任务；
- [ ] 视频重复创建、失败退款、结果补写和卡住恢复通过；
- [ ] 依赖审计报告生成；
- [ ] 完整校验通过；
- [ ] `0.42.11` 正式包、SHA256、GitHub commit 和发布记录齐全。
