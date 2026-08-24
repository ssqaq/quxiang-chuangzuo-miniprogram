# 重复签到验收与云数据库一键初始化设计

## 目标

补齐两项发布前保障：

1. 用独立自动测试证明同一微信用户在同一天无论连续点击还是并发请求，都只获得一次签到积分；
2. 提供可重复执行的云数据库初始化脚本，自动创建项目依赖但当前环境缺少的集合。

本次不修改签到奖励、连续签到、活动免费次数和已有数据结构。

## 重复签到测试

在现有内存数据库测试能力上增加独立的签到幂等验收，固定验证：

- 第一次签到返回成功且 `duplicate=false`；
- 第二次签到返回成功但 `duplicate=true`；
- 第二次签到获得积分为 `0`；
- 用户积分余额、累计获得积分和连续签到天数不会被第二次请求再次增加；
- 同一天只生成一条 `checkin` 积分流水；
- 保留现有 10 个并发签到请求只成功记账一次的测试。

测试失败时输出具体断言，不依赖真实微信身份或线上数据库。

## 数据库初始化入口

在 `api` 云函数增加管理员专用动作 `initializeDatabase`。

入口使用 `db.createCollection` 创建项目所需集合。创建前后逐项记录结果：

- `created`：本次新建；
- `existing`：集合已经存在，不做修改；
- `failed`：创建失败，返回集合名和错误原因。

重复执行不会删除集合、不会清空数据、不会覆盖已有记录。

固定集合清单：

- `admin_deployment_logs`
- `admin_runtime_config`
- `asset_upload_tickets`
- `auto_face_failure_logs`
- `auto_face_probe_logs`
- `generation_operations`
- `generation_records`
- `model_usage_events`
- `photo_to_video_temp_assets`
- `point_ledger`
- `repair_chains`
- `user_accounts`
- `user_assets`
- `user_quotas`

权限继续复用现有 `ADMIN_OPENIDS` 判断。普通用户调用时返回
`ADMIN_FORBIDDEN`，不执行任何建表操作。

## 本地一键脚本

新增 PowerShell 脚本，通过微信开发者工具当前登录态调用云函数初始化动作。

脚本流程：

1. 检查微信开发者工具命令入口和项目目录；
2. 确认项目窗口可运行；
3. 在小程序运行时调用 `wx.cloud.callFunction`；
4. 输出环境 ID、云函数名，以及每个集合的创建结果；
5. 任意集合失败时返回非零退出码。

脚本不保存 AppSecret、API Key、OpenID 或临时令牌。

## 错误处理

- “集合已存在”按成功处理；
- 管理员未配置或当前微信不是管理员时明确提示权限错误；
- 开发者工具未登录、项目未打开、云函数未部署或网络异常时停止并打印原始原因；
- 初始化结果中存在 `failed` 时脚本整体判定失败，方便发布流程发现问题。

## 验证

- 新增重复签到独立测试；
- 新增数据库初始化函数单元测试，模拟“新建、已存在、失败”三种结果；
- 验证非管理员无法初始化；
- 运行现有签到、并发、修复、云端贴脸等测试；
- 运行 `node scripts/validate.js` 和 `git diff --check`；
- 将修复版本从 `0.24.3` 升到 `0.24.4`；
- 正式生成 `D:\aips小程序\wechat-miniapp-release-v0.24.4.zip`。

## 回滚

- 删除 `initializeDatabase` 动作和本地初始化脚本；
- 删除新增测试；
- 已创建的空集合可以保留，不影响旧版本；本次脚本不会修改或删除已有数据。
