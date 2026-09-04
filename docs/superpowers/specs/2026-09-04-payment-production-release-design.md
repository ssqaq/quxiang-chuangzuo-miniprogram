# 支付生产启用与正式发布设计

## 目标

以已验收正式版本 `0.57.151` 为基线，合入另一个任务交付的支付云函数依赖修复，开启当前代码真实支持的微信支付生产能力，重新经过统一发布闸门自动分配下一个补丁版本，完成 GitHub PR 合并、CloudBase 部署、微信开发者工具导入和代码上传。

## 已确认边界

- 用户已明确授权 GitHub push、PR 合并、CloudBase 生产部署、微信开发者工具导入和微信代码上传。
- `payment-api`、`payment-notify`、`payment-reconcile` 的部署、下单、回调、对账和充值开关全部开启。
- 微信支付渠道开启，灰度比例设为 `100`，全部有效微信用户可见。
- 支付宝 launcher/provider 尚未实现，继续强制关闭，不能用一个无效布尔值冒充上线。
- 不执行真实扣款测试。
- 星聚生产 RSA 参数只允许从仓库外安全文件或云函数环境变量注入，禁止写入 Git、ZIP、日志和对话输出。
- 缺少星聚 RSA 参数时，代码、集合、索引、路由、Timer 和版本仍可发布；支付请求由现有 provider 配置校验继续失败关闭，交付时明确标出“支付通道未配置”，不能宣称真实支付可用。

## 实现结构

1. `scripts/payment-cloudfunctions.json` 成为生产部署合同，显式声明三个函数、三个运行开关、HTTP 回调路由和对账 Timer 均启用。
2. `cloudfunctions/payment-core/config.js` 仍保留缺配置失败关闭，但生产充值默认配置改为微信支付开启、全量灰度；三个 vendored 副本必须完全一致。
3. 发布门禁和正式包检查从“永远禁止生产启用”改为“只允许这份明确、完整的生产合同”，仍拒绝支付宝、额外 HTTP 路由、额外 Timer 和未声明函数。
4. 新增生产部署脚本，按集合与索引、函数、环境变量、HTTP 路由、Timer、`recharge_config/global` 的顺序执行；每一步随后回读。敏感参数只从外部 JSON 读取且不回显。
5. 统一发布闸门从 canonical 仓库重新扫描版本记录、队列、reservation 和 ZIP，自动分配补丁号；使用 `-AllowOutOfOrder` 越过用户已明确要求不恢复的旧 prepared 票据。
6. 发布闸门完成 PR 合并和开发者工具导入；之后使用微信开发者工具 CLI 上传同一 release worktree。只有拿到平台提审与正式发布回执，才写“线上正式发布成功”。

## 失败与回滚

- 任一集合、索引、路由、Timer 或函数状态无法回读时立即停止后续启用。
- 生产参数不完整时不调用星聚，不做真实支付；已打开的业务开关仍受 provider 配置校验保护。
- CloudBase 部署失败使用同一 release operation 恢复，禁止换版本重打。
- 回滚优先把三个运行开关、充值和微信渠道恢复为 `false`，再停 Timer 和 HTTP 路由；订单、事件和账本数据不删除。

## 验收

- 本地支付、依赖、打包和发布 smoke 全部通过。
- 正式记录、队列、release context、ZIP、GitHub main、CloudBase 回执和微信开发者工具导入版本一致。
- CloudBase 回读三个函数 Active，运行开关为 true，HTTP 回调和 Timer 存在，充值配置为微信渠道开启且 `rolloutPercent=100`。
- 发布 ZIP 非空且 SHA-256 已记录；微信上传回执版本与 release context 一致。
- 星聚 RSA 参数缺失或微信平台没有自动提审凭据时，分别作为独立阻塞项明确交付。
