# 依赖安全升级与旧任务历史清理实施计划

**目标：** 在不改变普通用户接口和页面行为的前提下，安全更新 `xlsx`、固定微信云 SDK，并对 90 天前已经彻底结束的任务记录执行可审计、可限量的自动清理。

**基线与版本：** 从 `origin/main` 的 `0.45.0` 开发，完成后发布 `0.45.1`。

---

## Task 1：依赖升级

**文件：**

- `cloudfunctions/api/vendor/xlsx/`
- `cloudfunctions/api/package.json`
- `cloudfunctions/api/package-lock.json`
- `README.md`

### 步骤

- [ ] 下载并核对 SheetJS 官方 `0.20.3` 安装包。
- [ ] 将官方包解压到 `cloudfunctions/api/vendor/xlsx`。
- [ ] 把 `xlsx` 改为本地目录依赖。
- [ ] 把 `wx-server-sdk` 从 `latest` 固定为 `4.0.2`。
- [ ] 重新安装依赖并生成锁文件。
- [ ] 验证实际加载的 `xlsx` 版本为 `0.20.3`。
- [ ] 运行所有 Excel 导出 smoke。
- [ ] 运行真实在线依赖审计，确认 0 critical。

---

## Task 2：清理纯逻辑

**文件：**

- 新增 `cloudfunctions/api/lib/generation-operation-retention.js`
- 新增 `scripts/generation-operation-retention-smoke.js`

### 步骤

- [ ] 先写 smoke 覆盖默认值、边界、截止时间和允许状态。
- [ ] 实现保留期默认 90 天，限制 30-365 天。
- [ ] 实现单次默认和最大 50 条。
- [ ] 只允许 `succeeded/refunded`。
- [ ] 拦截非终态、无效时间和 pending 标记。
- [ ] 生成不包含 OpenID、提示词和输入快照的摘要。

---

## Task 3：数据库清理适配

**文件：**

- `cloudfunctions/api/index.js`
- `scripts/database-indexes.json`

### 步骤

- [ ] 分别读取旧的 `succeeded/refunded` 候选。
- [ ] 合并、去重并按更新时间从旧到新排序。
- [ ] 单次最多处理 50 条。
- [ ] 删除前重新读取并再次判断。
- [ ] 某条删除失败时继续下一条。
- [ ] 集合不存在时返回未初始化摘要。
- [ ] 增加 `status + updatedAt` 清理索引。

---

## Task 4：权限、定时器和日志

**文件：**

- `cloudfunctions/api/index.js`
- `cloudfunctions/api/config.json`
- `scripts/action-registry-contract-smoke.js`
- 新增 `scripts/generation-operation-cleanup-smoke.js`

### 步骤

- [ ] 新增 `cleanupGenerationOperationHistory`。
- [ ] 登记精确 trigger `generation-operation-history-cleanup`。
- [ ] 权限设为 `timer-or-admin`。
- [ ] 普通用户手动调用返回 `ADMIN_FORBIDDEN`。
- [ ] 近似 trigger 不获得系统权限。
- [ ] 增加成功摘要和单条失败脱敏日志。
- [ ] 增加每天一次的定时器配置。

---

## Task 5：管理员手动入口

**文件：**

- `services/cloud.js`
- `pages/admin/admin.js`
- `pages/admin/admin.wxml`
- `pages/admin/admin.wxss`
- 相关管理员 smoke

### 步骤

- [ ] 增加云服务调用封装。
- [ ] 在任务队列卡片显示 90 天和单次 50 条说明。
- [ ] 增加手动清理按钮和二次确认。
- [ ] 显示本次扫描、删除、跳过和失败数量。
- [ ] 清理失败只影响该操作，不影响管理员其他模块。

---

## Task 6：完整验证

### 步骤

- [ ] 运行两个新增清理 smoke。
- [ ] 运行 Action Registry 契约测试。
- [ ] 运行依赖安全审计 smoke 和在线审计。
- [ ] 运行 Excel 导出 smoke。
- [ ] 回归图片、视频、队列、并发、状态机、退款和回收。
- [ ] 回归管理员加载、配置、布局和响应式。
- [ ] 运行 `node scripts/validate.js`。
- [ ] 运行 `git diff --check`。

---

## Task 7：版本和发布

### 步骤

- [ ] 将所有版本标记从 `0.45.0` 升到 `0.45.1`。
- [ ] 核对 `API_BUILD_VERSION` 和 `API_BUILD_MARKER`。
- [ ] 重新运行完整校验。
- [ ] 通过受控同步脚本提交明确文件并推送。
- [ ] 生成 `D:\aips小程序\wechat-miniapp-release-v0.45.1.zip`。
- [ ] 检查 ZIP 非空并计算 SHA256。
- [ ] 核对本地 HEAD、远端 main 和发布记录。
- [ ] 确认原开发目录没有被修改。

---

## 完成定义

- [ ] 可升级的直接高风险依赖已安全处理；
- [ ] 微信 SDK 固定稳定版本且没有危险降级；
- [ ] 旧任务清理只作用于符合条件的终态记录；
- [ ] 自动和手动入口均受权限保护；
- [ ] 用户作品、云文件和积分数据不受影响；
- [ ] 完整测试、正式打包、推送和 SHA256 核对完成。
