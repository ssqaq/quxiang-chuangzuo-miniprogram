# 小程序用户中心、支付暗部署与最新版编译实施计划

> 依据：`docs/superpowers/specs/2026-08-30-payment-production-dark-deploy-design.md`
> 当前策略：方案 B；测试商户允许临时 MD5，正式环境默认 RSA；所有支付业务开关先保持关闭。

## 目标

完成六项改动并产出可导入微信开发者工具的最新正式包：用户中心入口、充值/余额/记录页面已具备；账户记录改为稳定游标；支付核心支持受限测试 MD5 与生产 RSA；支付健康监控、索引、函数权限和 HTTP/Timer 配置具备下一轮部署清单；不把任何密钥写入仓库或发布物。本轮不写生产资源、不部署、不打开支付。

## 实施步骤

1. **签名适配**
   - 在 `cloudfunctions/payment-core/signature.js` 增加 RSA/MD5 模式选择、V1 MD5 原串和验签。
   - 在 `config.js`、`provider-xingju.js`、`.env.example` 增加模式及测试门禁。
   - 同步 `payment-api`、`payment-notify`、`payment-reconcile` 的 vendored core。
   - 用无密钥 fixture 覆盖排序、空值、大小写、错误签名、生产禁止 MD5。

2. **账户记录游标**
   - `payment-api` 按 `(createdAt desc, _id desc)` 查询，cursor 使用版本化 opaque 编码并绑定用户/筛选条件。
   - `services/account.js` 与 `pages/account-records/*` 改用 `cursor/nextCursor`，刷新和筛选切换清空游标，失败保留错误态。
   - `scripts/database-indexes.json` 增加无跳过查询所需复合索引。

3. **监控与基础设施**
   - `payment-reconcile` 幂等写 `payment_monitor_status/global`，记录断跑、积压、待复核、已支付未履约和连续失败等级。
   - 现有管理员白名单增加 `getPaymentMonitor`，管理页展示健康卡片；普通用户不可见。
   - 完善三个支付函数配置：客户端/HTTP/Timer 边界和关闭态环境变量；补部署与结构 smoke。

4. **本地验证**
   - 运行支付、游标、监控、索引、UI、依赖一致性和发布安全门禁。
   - 检查 vendored core 哈希、搜索仓库内敏感值、确认四个支付开关仍为 false。

5. **发布与编译**
   - 在隔离工作树升中间版本（加功能按项目规则升级），调用 canonical 发布闸门生成不可变 ZIP、release context 和独立目录。
   - 用微信开发者工具导入新目录并刷新模拟器，核对页脚动态版本、“我的”入口和页面编译结果；不覆盖旧 `wechat-miniapp` 工作区。

6. **下一轮生产暗部署清单（本轮只保留，不执行）**
   - 创建集合、查重后建索引，部署函数并回读权限、HTTP 路由和 Timer。
   - 注入密钥只允许通过安全环境变量；测试 MD5 仅限测试商户/单一白名单，生产开关仍关闭，未获得真机回执不开放充值。

## 完成判定

- 所有本地门禁通过，正式包非空且有 SHA-256。
- 微信开发者工具运行信息显示新版本而非 `0.51.1`。
- 监控快照和游标测试有可复现输出。
- 密钥不出现在源码、Git、ZIP、日志和前端包。
- 任何生产能力未能回读时，明确标记为未完成，不虚报已上线。
- 本轮生产变更计数必须为 0；不得把本地配置文件当成线上部署回执。
