# 支付生产暗部署、监控、游标分页与最新版编译设计

## 1. 目标与已确认路径

本轮按用户确认的方案 B 执行：先在现有生产 CloudBase 环境完成“关闭态”基础设施和代码部署，支付总开关、订单创建开关、回调处理开关和对账开关继续保持关闭；监控、索引、权限、HTTP 回调、Timer 和最新版编译全部可核验后，才允许注入星聚商户配置并做单一白名单用户的小额真机验收。

本轮覆盖六项：

1. 星聚微信真机闭环准备与验收证据脚本。
2. 生产支付集合和索引创建、回读与回执保存。
3. `payment-api`、`payment-notify`、`payment-reconcile` 三个函数部署及调用边界核验。
4. 星聚 HTTP 回调与对账 Timer 接线。
5. 支付健康监控和管理员页面展示。
6. 账户记录由 offset 分页迁移为稳定游标分页。

同时修复微信开发者工具仍显示 `0.51.1` 的问题：不覆盖旧的脏 canonical 工作区，最终只导入本轮发布闸门生成的不可变发布目录并重新编译。

> **本轮部署边界（沿用 C4 最终裁决）**：本轮只完成源码、测试、版本升级、正式打包和本地开发者工具编译。禁止创建生产数据库集合/索引、部署生产云函数、配置生产 HTTP 路由或 Timer、写入生产密钥、开启充值开关和执行真实扣款。方案 B 的生产步骤只保留为下一轮可执行的带回执清单。

## 2. 当前事实

- AppID：`wxa5aaf3392cbeb39a`。
- CloudBase 环境：`cloud1-d4g05zdxc94d17112`。
- 微信开发者工具当前运行目录为 `D:\aips小程序\wechat-miniapp`，该目录的 `config.js` 为 `0.51.1`，因此截图显示旧版本不是缓存错误。
- 用户中心与支付源码位于隔离工作树 `D:\aips小程序\_user-center-payment-20260830`；上一份正式包为 `0.57.67`，当时使用了 `PrepareOnly + SkipDevTools`，没有导入开发者工具。
- 线上当前只有 `api`、`watermark-gateway` 两个云函数；三个支付函数尚未部署。
- 线上集合清单没有 `payment_orders`、`payment_events`、`recharge_config`。
- 用户已提供星聚测试商户后台截图。截图确认接口地址、商户 ID、平台 RSA 公钥、商户 RSA 公钥和 MD5 密钥均已在测试商户后台配置，但没有展示商户 RSA 私钥；当前后台仍选中“MD5 + RSA 兼容模式”。用户已明确允许本轮测试商户临时使用 MD5，正式环境仍以 RSA 为默认和唯一启用模式。真实扣款阶段仍需先完成测试密钥的安全注入和回调验收。

## 3. 代码架构

### 3.1 稳定游标分页

账户流水采用 `(createdAt desc, _id desc)` 双字段顺序。服务端只接受自己格式化的 opaque cursor，解码后严格验证时间、文档 ID、版本和筛选类型；所有查询仍强制绑定当前调用者 OpenID，修改 cursor 不能跨用户读取。

查询条件：

- 首屏：`openid = currentOpenid`，按 `createdAt desc, _id desc` 取 `limit + 1`。
- 后续页：`createdAt < cursor.createdAt`，或 `createdAt == cursor.createdAt && _id < cursor.id`。
- 指定类型时额外增加标准化后的 `type` 等值条件。

返回 `items`、`nextCursor`、`hasMore`，不再返回或使用 `nextOffset`。前端刷新和切换筛选时清空 cursor；加载更多只能复用服务端返回的 cursor。数据库错误必须保留错误态，不能伪装成空记录。

新增两个账本索引：

- `point_ledger(openid asc, createdAt desc, _id desc)`。
- `point_ledger(openid asc, type asc, createdAt desc, _id desc)`。

### 3.2 支付健康监控

新增集合 `payment_monitor_status`，固定文档 `global` 保存最近一次对账健康快照，不保存密钥、原始 OpenID、原始签名或完整回调载荷。

快照字段包括：

- `lastRunStartedAt`、`lastRunCompletedAt`、`lastSuccessAt`、`durationMs`。
- `scanned`、`claimed`、`fulfilled`、`failed`。
- `dueBacklogCount`、`oldestDueAt`。
- `reviewCount`、`refundReviewCount`、`paidUnfulfilledCount`。
- `severity`、`reasonCodes`、`schemaVersion`、`updatedAt`。

告警判定：

- Timer 超过 5 分钟无成功快照：严重。
- 存在 `paid` 超过 5 分钟未履约：严重。
- 存在 `review` 或 `refund_review`：警告。
- 到期积压超过 20 笔或最老积压超过 15 分钟：警告。
- 本轮对账出现失败：警告；连续失败升级为严重。

`payment-reconcile` 在每次 Timer 运行结束后幂等覆盖 `global` 快照。关闭态下也允许写入一条 `mode=disabled` 的安全心跳，但不得读取待对账订单、调用星聚或推进任何订单状态；这样能先验证 Timer 接线而不会触发支付业务。现有 `api` 云函数增加管理员专用 `getPaymentMonitor` action，复用现有管理员白名单校验；管理员页面增加“支付健康”卡片，显示健康级别、Timer 心跳、积压、待复核和未履约数量。普通用户不能读取该数据。

### 3.3 签名模式适配（测试 MD5、生产 RSA）

支付核心增加统一的签名模式适配器，所有模式共用同一套参数白名单、超时、响应校验和幂等逻辑：

- `XINGJU_SIGNATURE_MODE` 默认 `rsa`；只有同时满足“测试环境标记 + 测试商户白名单”时才允许显式设为 `md5`。
- RSA 模式继续使用 V2 `RSA-SHA256`，生产环境默认且推荐只保留 RSA。
- MD5 模式按兼容易支付 V1 规则对非空标量参数按 ASCII key 排序，拼接 `key=value&...` 后直接追加商户 MD5 密钥，计算 32 位小写 MD5；`sign`、`sign_type` 不参与原串。实现必须通过固定 fixture 测试，并拒绝数组、对象和未允许字段参与签名。
- MD5 密钥只从 CloudBase 函数环境变量或仓库外的本机安全文件注入，绝不进入源码、Git、发布 ZIP、前端包、截图或日志；前端永远看不到签名密钥。
- 回调验签按同一模式适配，必须绑定当前配置的商户和环境；模式不匹配、时间窗或签名错误统一返回 `fail`，不泄露内部原因。

### 3.4 回调与 Timer 适配

`payment-notify` 增加 HTTP 网关事件适配层，兼容平铺 GET 参数以及网关的 `queryStringParameters`、`headers`、`requestContext` 结构，规范化后再进入现有 RSA 验签和幂等事务。ACK 只能原样返回 `success` 或 `fail`，任何异常不得返回堆栈、密钥或内部订单详情。

`payment-reconcile` 配置一个名为 `payment-reconcile` 的 Timer，七段 Cron 为 `0 */2 * * * * *`。函数继续要求无小程序 `OPENID` 且触发器名称匹配，并使用现有 CAS 租约和 fencing 防止重复履约。

### 3.5 生产关闭态

部署时以下值固定为关闭：

- `PAYMENT_ORDER_CREATION_ENABLED=false`
- `PAYMENT_CALLBACK_PROCESSING_ENABLED=false`
- `PAYMENT_RECONCILIATION_ENABLED=false`
- `recharge_config/global.rechargeEnabled=false`
- `recharge_config/global.channelConfig.wxpay.enabled=false`
- 支付宝继续强制关闭。

关闭态仍可部署代码、创建集合和索引、绑定 HTTP 路由、创建 Timer；函数命中后必须在任何外部下单、回调推进或查单前失败关闭。只有获得星聚商户配置、回调地址和白名单 OpenID hash 后，才进入单独的启用步骤。

## 4. 下一轮生产变更顺序（本轮不执行）

1. 运行本地测试和发布门禁，确认代码仍默认关闭。
2. 创建 `payment_orders`、`payment_events`、`recharge_config`、`payment_monitor_status` 集合。
3. 创建唯一索引前先查重；发现重复立即停止，不自动删除或合并数据。
4. 创建现有七个支付索引和两个游标索引，逐个回读名称、字段、方向和唯一性。
5. 部署三个支付函数及更新后的 `api` 函数，保持所有支付环境变量为空或 false。
6. 将 `payment-api` 保持小程序可调用；`payment-notify` 只允许匿名 HTTP 网关；`payment-reconcile` 只允许 Timer。若管理工具不能回读权限，视为未完成，不打开业务开关。
7. 绑定 `/payment/xingju/notify` HTTP 路径和两分钟 Timer，分别用无签名请求和关闭态 Timer 做安全验证。
8. 保存部署前后函数、集合、索引、路由、Timer 和关闭态检查回执。

## 5. 星聚真机闭环门槛（本轮不执行）

以下资料缺一项都不执行真实扣款：

- `XINGJU_API_BASE_URL`
- `XINGJU_PID`
- `XINGJU_PLATFORM_PUBLIC_KEY`
- `XINGJU_NOTIFY_URL`
- 可用于白名单的测试微信 OpenID hash

签名资料按模式分组：

- RSA 验收必须提供 `XINGJU_MERCHANT_PRIVATE_KEY`；生产启用前还必须在星聚后台保存为“仅 RSA 安全模式”。
- MD5 测试验收必须提供 `XINGJU_MD5_KEY`，并同时设置测试环境标记、测试商户标识和单一白名单；没有 RSA 私钥时可以只走这一条测试通道，但不得把该模式推广到生产用户。

商户 RSA 私钥和 MD5 密钥都不得粘贴进源码、Git、发布包、日志或普通聊天文本。用户应提供本机安全文件路径，运行时通过 CloudBase 环境变量注入；若 RSA 私钥已经遗失，只能在获得用户对“旧密钥立即失效”影响的明确确认后重置 RSA 密钥对。截图中 MD5 密钥已暴露在聊天记录，测试完成后必须在星聚后台立即轮换；轮换前只允许测试白名单使用，轮换后旧值必须失效。

资料齐全后按 `callback -> reconcile -> order creation` 顺序逐个开启运行开关。若走 MD5 测试通道，灰度配置必须同时锁定测试商户、一个 OpenID hash 和 `pkg_990`，且禁止公开发布；真机完成一笔 9.9 元支付后立即关闭 MD5 和订单创建开关、轮换 MD5 密钥，再切换到 RSA 预生产验收。核对：

`payment_orders -> payment_events -> point_ledger -> user_accounts`

四处金额、积分、交易号和履约状态必须一致；重复提交相同回调不得重复加积分。未完成真机扣款时，交付状态必须写“真机闭环待商户资料”，不能写成功。

## 6. 最新版编译与发布（本轮执行）

旧 canonical 工作区有大量用户改动，禁止覆盖、清理或直接作为编译源。本轮全部改动在隔离工作树完成并通过测试后，从 canonical 的统一发布入口调用发布闸门，显式列出 IncludePath，动态分配新版本并生成不可变 ZIP、release context 和独立发布目录。

本轮只要求本地正式包和微信开发者工具编译，不自动推送 GitHub。发布完成后将新的独立发布目录导入微信开发者工具、打开项目窗口并刷新模拟器；用运行时信息和截图核对：

- 页脚不再是 `0.51.1`，而是本轮动态版本。
- 工作台右上角显示“我的”。
- 用户中心、充值页和账户记录页能编译打开。
- 充值功能仍保持关闭态，不出现可付款入口。

## 7. 测试与验收

本地测试至少覆盖：

- cursor 首屏、后续页、同时间 `_id` 决胜、筛选切换、非法 cursor、并发插入不重不漏。
- 监控阈值、Timer 断跑、积压、待复核、已支付未履约、连续失败升级。
- 网关 GET 事件规范化、验签失败 ACK、合法重复回调 ACK。
- Timer 事件来源拒绝和关闭态不查单。
- 三个支付函数的 vendored core 与 canonical core 一致。
- 生产集合、索引、函数、权限、HTTP、Timer 的部署前后回读。
- 微信开发者工具编译成功并截图核对动态版本。

## 8. 回滚

- 业务开关始终默认关闭；出现问题先保持或恢复全部 false。
- 新函数可停止 HTTP 路由和 Timer，不删除订单、事件或账本数据。
- 索引创建失败只停止后续步骤，不删除现有索引。
- 新版编译目录与旧 canonical 分离；编译失败时关闭新项目窗口，不覆盖旧目录。
- 已产生的支付证据只追加或标记，不做破坏性清理。
