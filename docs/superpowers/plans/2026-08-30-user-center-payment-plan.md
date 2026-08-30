# “我的”用户中心与星聚微信充值实施计划

## 交付原则

所有工作在 `codex/user-center-payment-20260830` 隔离 worktree 完成，原脏工作区只读保留。代码、测试、配置样例和发布包可以落地；生产数据库、云函数、HTTP 路由、Timer、密钥、真实支付和开关不得变更。

## 任务 1：固化账户字段与兼容输出

- 修改 `cloudfunctions/api/index.js`，为默认账户和积分摘要增加 `totalPurchasedPoints`、`totalReversedPurchasedPoints`。
- 保持 `totalEarned`、`totalSpent` 和现有 `refundUsage` 语义不变。
- 补单元测试，验证老账户缺字段时返回 0。

## 任务 2：建立可测试的 payment-core

- 新增固定商品、状态机、签名、确定性 ID、配置/灰度、订单指纹和 provider 结果校验模块。
- 明确 `creation_unknown`、回调验证、not-found 计数、晚到冲突和人工复核的转换规则。
- 使用 `node:test` 覆盖纯函数；不依赖 CloudBase 或真实星聚服务。

## 任务 3：实现三个隔离云函数

- `payment-api`：配置、创建、查询订单、账户记录；创建调用禁止自动重试且复用原 `outTradeNo`。
- `payment-notify`：GET 参数规范化、验签、确定性事件、事务内回调收据与 `verifying`、协议 ACK。
- `payment-reconcile`：CAS 租约、事务外查单、fencing 回写、原子入账和异常转 `review`。
- 三个函数都显式写 timeout，默认无 Timer、无 HTTP 路由、无密钥、无开启开关。

## 任务 4：实现客户端用户中心

- 工作台右上角加入“我的”头像入口和红点。
- 新增用户中心、充值、收支记录页面及服务层。
- 充值页只展示服务端许可的微信通道，支付拉起只接受 `wxpay`。
- 补齐加载、空态、失败、取消、支付后轮询和刷新余额。

## 任务 5：补部署前配置与安全检查

- 增加集合/索引声明或只读检查脚本，列出全部必需唯一键和复合索引。
- 增加非敏感 `.env.example` 或配置样例，所有开关为 false，灰度为 0。
- 扩展本地打包/依赖检查，让三个函数和 payment-core 被正式 ZIP 纳入并做 hash/smoke；不得触发部署。

## 任务 6：验证

- 运行新增 payment-core、payment-api、payment-notify、payment-reconcile 与现有 API 测试。
- 运行 UTF-8、发布安全、依赖和打包 check-only。
- 启动本地方案/页面预览，用浏览器核对“我的”入口、三页布局和禁用态；不模拟成功到账。

## 任务 7：版本与正式本地包

- 从 canonical `scripts/release.ps1` 调用，`SourcePath` 指向隔离 worktree，`IncludePath` 逐文件明确列出。
- 不写死版本，不传 `TargetVersion`，由发布锁内最新 `origin/main` 动态分配。
- 使用 `-PrepareOnly -SkipDevTools` 生成不可变正式 ZIP；不传 `-DeployCloud`，不执行 GitHub 发布。
- 核对 ZIP 存在、非零、manifest 与版本一致，并交付完整路径和 SHA256。
