# “我的”用户中心与星聚微信充值设计

## 目标与边界

本次在工作台右上角增加“我的”入口，复用现有积分账户，提供余额、充值入口、累计充值积分和收支记录。充值第一期只实现星聚微信通道；支付宝只保留未来可接入的 provider 边界，客户端、插件和拉起代码均不出现支付宝实现。

本次只交付源码、测试、数据库/云函数配置样例和正式本地发布包，不执行生产数据库建表、索引创建、HTTP 路由绑定、Timer 开启、云函数部署、密钥写入、真实支付或功能开关开启。所有支付开关默认关闭，缺少密钥时必须失败关闭。

## 已批准的页面方案

1. 工作台右上角新增圆形头像按钮，带红点和“我的”可访问语义；不增加底部导航，不拆除现有积分签到页。
2. 用户中心延续当前蓝白卡片风格，顶部为头像、昵称和资料入口，中间突出当前积分余额与“立即充值”，下方提供“积分充值”“收支记录”和最近三条记录。
3. 充值页固定三个商品：`pkg_990` 为 ¥9.9 / 100 积分，`pkg_2990` 为 ¥29.9 / 330 积分，`pkg_5990` 为 ¥59.9 / 688 积分。商品金额和积分由服务端常量决定，客户端传入值不参与计价。
4. 收支记录页独立于现有创作记录页，支持全部、充值、消费、奖励筛选，并显示加载、空态、失败和继续加载状态。
5. 用户中心和记录始终可见。`eligible=false` 时不显示充值 CTA；`eligible=true` 且 `channels=[]` 时显示暂不可用；仅当 `channels` 包含 `wxpay` 时才允许创建订单和拉起微信支付。

## 客户端结构

- `pages/user-center`：聚合用户资料、积分摘要、充值资格和最近记录。
- `pages/recharge`：展示服务端返回的固定商品，创建订单后只允许调用 `wx.requestPayment`。
- `pages/account-records`：读取积分账本并按类型展示。
- `services/account.js`：封装现有 `api` 与新 `payment-api` 的读操作；创建支付订单固定 `retryLimit=0`。
- `services/payment-launcher.js`：只接受 `provider=wxpay`，校验 `timeStamp/noncestr/package/signType/paySign` 后拉起微信；未知 provider 直接拒绝。
- `utils/account-ui.js`：统一账本类型、正负号、时间和空态文案，避免页面各自解释业务类型。

用户点击“立即充值”后的主路径为：

`读取资格 -> 选择商品 -> 创建订单 -> wx.requestPayment -> 查询订单 -> fulfilled 后刷新余额`

支付窗口取消只结束本次前端流程，不关闭服务端订单；窗口结果也不作为到账依据。客户端必须以后端订单状态为准。

## 云函数边界

采用三个独立函数是安全隔离选择，不是 CloudBase 平台硬限制：

- `payment-api`：只处理小程序 `callFunction`，可读取 `getWXContext()`，提供配置、创建订单、查订单和账本查询。
- `payment-notify`：只处理星聚 HTTP GET 回调，不调用也不信任 `getWXContext()`；验签、持久化事件、推进 `verifying` 后才返回协议 ACK。
- `payment-reconcile`：只供未来 Timer 调用，抢占到期订单、在事务外查星聚、带 fencing 条件回写和履约。

共享逻辑放在可单测的 `payment-core`。部署包必须把同一份核心代码放入三个函数包并校验 hash；不能假设兄弟目录会被 CloudBase 自动上传或共享。三个函数都显式配置超时：API 与通知 15 秒，对账 120 秒；provider 单次请求不超过 6 秒。

## 支付订单状态机

状态全集固定为：

`created, creation_unknown, pending, verifying, paid, fulfilled, closed, refund_review, refunded, review`

关键迁移：

- 新订单先写 `created`，再向星聚创建。明确成功后进入 `pending`；超时或无法确认结果进入 `creation_unknown`。
- `creation_unknown` 禁止自动重新创建、禁止更换 `outTradeNo`，只能按原单号查询。
- 合法成功回调必须在同一事务内保存确定性 `payment_event`、写入回调证据、推进 `verifying`、设置 `reconcileRequired/nextReconcileAt`，全部成功后才回复 `success`。
- `verifying -> paid` 只能由签名有效的星聚查单结果推动，并同时核对订单号、金额、商户、通道和支付状态。
- `paid -> fulfilled` 在一个数据库事务中完成积分余额增加、确定性账本写入、累计充值积分增加和状态推进。
- `closed` 只允许签名有效且明确映射的官方终态或经审计的人工处理。第一期没有已确认的星聚终态映射，因此自动关闭禁用。
- 退款或冲正第一期只进入 `refund_review` 并记录事件/告警，不自动扣积分，也不提供可调用的冲正执行器。

无有效成功回调时，连续三次得到签名有效的“订单不存在”才进入 `review`；超时和查询错误不计数。有有效成功回调时，即便连续三次查不到也只能进入 `review`，不能回到关闭、重建或更换单号。

## 幂等、事件与租约

创建订单同时使用两层唯一键：`outTradeNo` 唯一，以及 `openidHash + requestIdHash` 唯一。同一请求键且指纹完全相同返回原订单；同一键但商品、金额、通道等指纹不同返回冲突。创建请求不允许客户端自动重试。

回调事件 ID 由 provider、订单号、交易号、状态和规范化载荷 hash 确定。重复事件必须重新读取并逐项核对关键字段/hash：

- `fulfilled` 的完全相同重复回调返回 `success`。
- `closed/refunded` 收到晚到成功时记录冲突事件、订单进 `review` 并返回 `fail`。
- 同 ID 内容不一致一律进入 `review`，不得把唯一键冲突当成成功。

对账领取条件使用 `owner + token + epoch + statusVersion` fencing。租约 180 秒，函数上限 120 秒，运行到 90 秒后停止领取新单；provider 请求上限 6 秒。外部查询永远在数据库事务外，回写前重新核对 fencing 条件。新订单必须初始化租约字段，避免缺字段导致条件更新语义不一致。

## 数据模型与索引

### `payment_orders`

保存内部订单号、`outTradeNo`、用户 hash、请求 hash、固定商品快照、分币金额、积分数、provider、状态、状态版本、创建结果、回调证据、查单计数、对账计划、租约和人工复核字段。人工复核字段全部保留：`reviewFromStatus`、`reviewReason`、`reviewEvidence`、`reviewStatusVersion`。

必需索引：

- UNIQUE `outTradeNo`
- UNIQUE `openidHash + requestIdHash`
- `openidHash + createdAt`
- `reconcileRequired + nextReconcileAt`
- `status + paidAt`
- `createdAt`

不建立单独 `leaseUntil` 索引。

### `payment_events`

保存确定性事件 ID、订单 ID、事件类型、规范化载荷 hash、验签结果、关键 provider 字段和处理结果。必需索引为 `orderId + createdAt`。

### `recharge_config`

运行时只读取固定文档 `global`。文档缺失、字段非法或读取失败都使用全关闭默认值；本次不在生产创建该文档。字段只允许 `rechargeEnabled`、`channelConfig` 和嵌套的 `gray`，其中支付宝开关虽然保留为未来配置位，但第一期不会因此生成支付宝 UI 或拉起能力。

### 现有积分集合

`user_accounts` 新增：

- `totalPurchasedPoints`：累计成功购买积分。
- `totalReversedPurchasedPoints`：经人工审计确认的购买积分冲正累计；第一期只读和初始化，不自动增加。

现有 `totalEarned` 保持签到/非购买收入语义，现有 `refundUsage` 继续表示生产失败返还消耗，不能与支付退款混用。充值账本用确定性 ID 写入 `point_ledger`，已存在时必须完整核对用户、订单、金额、积分和类型；任何“账本已存在但账户/订单状态不一致”的组合进入 `review`。

## 配置、灰度与密钥

安全默认值固定为：

- `rechargeEnabled=false`
- `channelConfig.wxpay.enabled=false`
- `channelConfig.alipay.enabled=false`
- `gray.rolloutPercent=0`
- `gray.strategy` 只允许 `whitelist` 或 `hash`
- `gray.allowOpenidHashes=[]`

用户是否可见充值由总开关、通道开关、灰度策略和稳定的 OpenID hash 决定。密钥、商户 ID 和回调密钥只读环境变量；仓库只保留非敏感字段样例。任一必需密钥缺失时，资格接口返回不可充值，创建/查询/回调均失败关闭，并且日志不得输出密钥或原始敏感载荷。

## 星聚协议与验证

星聚 PHP SDK 固定下载地址为 `https://pay.xjukeji.cn/static/files/SDK_2.0.zip`，已核验 SHA256 为 `307a5ea75e27c81096b2825acdc2a093d86026858a932d07024fb709c602e1ff`。回调为 GET，ACK 只允许 `success` 或 `fail`，时间戳窗口为正负 300 秒。

官方没有提供可直接使用的签名向量，因此本地测试使用固定非生产密钥，生成 PHP SDK 与 Node 实现交叉验证 fixtures；签名实现必须采用确定字段排序、空值处理和常量时间比较。生产密钥不得进入 fixture、日志或发布包。

## 监控与处置

- 签名有效但订单号、金额、商户、通道或状态不一致：P0，立即失败并转人工复核。
- 完全重复事件、重复履约差异和 reconciliation 数据差异：目标为零，出现即告警。
- 无效签名按时间窗口和请求总量监控，不使用“硬编码 0.1%”这种无流量基线阈值。
- `creation_unknown`、长时间 `verifying`、租约冲突、三次已确认 not-found 和 `refund_review` 分别统计数量与最长等待时间。

## 验收和上线顺序

本地验收必须覆盖固定商品不可篡改、创建幂等冲突、creation_unknown、回调重复/冲突、状态机非法迁移、签名窗口、fencing、履约账本一致性、灰度矩阵、缺密钥失败关闭、未知 provider 拒绝以及前端三种资格状态。

未来生产上线严格分阶段：先建集合/索引，再部署关闭状态的三个函数，再绑定通知路由和 Timer，再配置星聚回调与密钥，再用白名单做非生产/小额验收，最后逐步提高 hash 灰度比例。任一步缺少可核验回执都不得开启下一步；本次交付不执行这些生产步骤。
