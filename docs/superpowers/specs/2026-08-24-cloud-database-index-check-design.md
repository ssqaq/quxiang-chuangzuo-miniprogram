# 云数据库索引检查与逐项确认创建设计

## 1. 背景

项目已经提供 `scripts/init-cloud-database.ps1`，可以检查并补齐云数据库集合，但集合存在不代表查询所需索引已经配置。

当前云函数包含按时间清理、按用户分页、按请求号查重和按父记录查询等操作。数据量较小时缺少索引不明显，数据量增长后可能出现查询变慢、查询失败或后台统计超时。

本次增加一套独立的数据库索引管理工具，采用“先完整检查，再由操作者逐项确认创建”的方式。工具不在云函数运行时自动修改索引，避免线上服务在无人确认时发生索引重建。

## 2. 目标

1. 根据项目真实查询维护一份明确的必需索引清单。
2. 一键读取云端集合的现有索引。
3. 区分索引已存在、存在等价索引、缺失、同名但配置错误、集合缺失和检查失败。
4. 检查阶段保持只读，不对云端数据库做任何修改。
5. 完整展示检查结果后，对缺失索引逐项询问是否创建。
6. 同名但配置错误的索引必须进行更严格的二次确认。
7. 创建完成后重新读取云端索引，验证是否真正生效。
8. 不自动删除项目清单之外的索引。
9. 腾讯云访问密钥只从环境变量读取，不写入项目文件、日志或发布包。

## 3. 非目标

1. 不在小程序页面或管理员控制台增加索引管理按钮。
2. 不让 `api` 云函数持有腾讯云管理端密钥。
3. 不自动删除多余索引。
4. 不自动修改现有业务查询。
5. 不修改数据库权限规则。
6. 不把索引工具依赖打进云函数部署依赖。

## 4. 必需索引清单

索引清单使用稳定名称、字段顺序、排序方向和唯一性配置。除特别说明外，索引均为非唯一索引。

| 集合 | 索引名 | 字段 |
|------|--------|------|
| `auto_face_failure_logs` | `idx_created_at_desc` | `createdAt: -1` |
| `photo_to_video_temp_assets` | `idx_session_id_asc` | `sessionId: 1` |
| `photo_to_video_temp_assets` | `idx_idle_cleanup_after_asc` | `idleCleanupAfter: 1` |
| `photo_to_video_temp_assets` | `idx_cleanup_after_asc` | `cleanupAfter: 1` |
| `admin_deployment_logs` | `idx_checked_at_desc` | `checkedAt: -1` |
| `model_usage_events` | `idx_date_key_asc` | `dateKey: 1` |
| `auto_face_probe_logs` | `idx_created_at_checked_at` | `createdAt: 1, checkedAt: -1` |
| `point_ledger` | `idx_openid_created_at` | `openid: 1, createdAt: -1` |
| `generation_records` | `idx_openid_request_id` | `openid: 1, requestId: 1` |
| `generation_records` | `idx_openid_created_at` | `openid: 1, createdAt: -1` |
| `generation_records` | `idx_openid_parent_record_id` | `openid: 1, parentRecordId: 1` |

系统自带的 `_id` 索引不纳入项目索引清单，也不参与多余索引警告。

## 5. 文件结构

### `scripts/database-indexes.json`

保存必需索引清单，是检查脚本和自动测试共同使用的唯一配置来源。

每项包含：

- `collection`：集合名称；
- `name`：稳定索引名；
- `keys`：按顺序保存字段名和方向；
- `unique`：是否唯一；
- `reason`：对应的业务查询用途。

### `scripts/cloud-database-index-manager/package.json`

只保存本地索引管理工具所需的 Manager Node SDK 依赖。依赖安装到该目录自己的 `node_modules`，不进入 `cloudfunctions/api`，也不会随云函数部署。

### `scripts/cloud-database-index-manager/index.js`

负责：

1. 初始化 CloudBase Manager SDK；
2. 读取集合详情和现有索引；
3. 统一不同返回字段的格式；
4. 比较期望索引和实际索引；
5. 按明确指令创建或重建单个索引；
6. 返回结构化 JSON，不直接处理交互界面。

### `scripts/check-cloud-database-indexes.ps1`

作为用户入口，负责：

1. 读取项目路径和 `config.js` 中的环境 ID；
2. 检查密钥环境变量；
3. 首次运行时安装本地管理工具依赖；
4. 执行只读检查；
5. 打印完整检查报告；
6. 在检查完成后逐项询问；
7. 调用 Node 工具创建已确认的索引；
8. 最后重新检查并输出验证结果。

### `scripts/database-index-smoke.js`

使用假的 Manager SDK 响应验证比较、确认和创建逻辑，不连接真实云环境。

## 6. 凭据与配置

本地脚本从以下环境变量读取腾讯云凭据：

- `TENCENTCLOUD_SECRET_ID`
- `TENCENTCLOUD_SECRET_KEY`
- 可选：`TENCENTCLOUD_SESSION_TOKEN`

环境 ID 默认读取 `config.js` 中的 `cloudEnvId`，也允许通过脚本参数覆盖。

脚本只显示：

- 环境 ID；
- 凭据是否已配置；
- 索引检查和修改结果。

脚本禁止输出密钥原文，也不把密钥写入 JSON 报告。

## 7. 检查和比较规则

每个必需索引按以下顺序判断：

1. 集合不存在：状态为 `collection-missing`。
2. 存在同名且定义完全一致的索引：状态为 `existing`。
3. 存在不同名称但字段、顺序、方向和唯一性完全一致的索引：状态为 `equivalent`，不重复创建。
4. 存在同名但字段、顺序、方向或唯一性不同的索引：状态为 `mismatched`。
5. 以上都不满足：状态为 `missing`。
6. SDK 请求失败：状态为 `check-failed`，记录脱敏后的错误码和原因。

字段顺序属于索引定义的一部分，不能排序后比较。

项目清单之外的索引状态为 `extra`，仅展示，不删除。

## 8. 交互流程

### 阶段一：只读检查

脚本先读取全部相关集合并打印汇总：

```text
existing=6
equivalent=1
missing=3
mismatched=1
collectionMissing=0
failed=0
extra=2
```

检查结果写入：

```text
_tmp_database-index-reports/database-index-report-YYYYMMDD-HHMMSS.json
```

该目录符合项目现有 `_tmp_*` 忽略和打包排除规则。

### 阶段二：逐项确认

只有阶段一完整结束后才进入修改阶段。

缺失索引提供：

- `Y`：创建当前索引；
- `N`：跳过当前索引；
- `A`：创建后面全部缺失索引；
- `Q`：退出，不再修改。

默认值为 `N`，直接回车不会创建。

### 配置错误索引

同名但定义错误的索引可能涉及重建，不能被 `A` 自动包含。

脚本先显示当前定义和期望定义，再要求操作者输入完整索引名。输入完全一致后才允许重建，否则跳过。

### 阶段三：复查

所有已确认操作结束后重新执行一次只读检查。

只有当所有已选择索引状态变为 `existing` 或 `equivalent` 时，对应操作才算成功。

## 9. 命令模式

脚本支持：

- 默认模式：检查完成后逐项确认；
- `-CheckOnly`：只检查，不出现确认提示，不修改云端；
- `-EnvironmentId`：覆盖 `config.js` 中的环境 ID；
- `-ProjectPath`：指定项目目录。

`-CheckOnly` 在存在缺失、错误或检查失败时返回非零退出码，方便以后接入 CI。

不提供跳过检查直接批量创建的参数。

## 10. 错误处理

1. 缺少密钥：检查开始前终止，并给出环境变量名称。
2. 集合缺失：提示先运行 `scripts/init-cloud-database.ps1`，不自动跨脚本创建集合。
3. 单个集合读取失败：继续检查其他集合，最终汇总失败项。
4. 单个索引创建失败：记录错误并继续后续项目。
5. 网络失败：保留错误码和简短原因，不记录请求头或密钥。
6. 复查仍缺失：脚本以非零退出码结束。
7. 用户跳过：报告标记为 `skipped`，不伪装成成功。

## 11. 测试

自动测试至少覆盖：

1. 同名同定义识别为 `existing`；
2. 不同名同定义识别为 `equivalent`；
3. 缺少索引识别为 `missing`；
4. 同名不同字段识别为 `mismatched`；
5. 字段顺序不同识别为 `mismatched`；
6. 唯一性不同识别为 `mismatched`；
7. 集合不存在识别为 `collection-missing`；
8. 额外索引只报告不删除；
9. 普通缺失索引可在确认后创建；
10. 默认回车不会创建；
11. `A` 不会自动重建配置错误索引；
12. 配置错误索引只有输入完整索引名才重建；
13. 创建失败不会阻止后续索引检查；
14. 复查能识别创建是否生效；
15. 输出和错误中不包含密钥；
16. 发布包不包含本地 `node_modules` 和临时检查报告。

同时更新 `scripts/validate.js`，检查索引清单、PowerShell 入口、Node 管理工具和测试文件是否存在且语法正确。

## 12. 发布与版本

这是新增运维功能，实施时按项目当前已提交版本升级次版本号。

实现完成后必须：

1. 运行静态检查；
2. 运行全部 `*-smoke.js`；
3. 使用真实云环境执行一次 `-CheckOnly`；
4. 在明确确认后至少创建或验证一个缺失索引；如果云端没有缺失索引，则以全部已有作为真实验证结果；
5. 使用干净提交生成正式发布包；
6. 核对 ZIP 完整性、文件数量、大小和 SHA256；
7. 确认本次提交没有混入其他并行任务文件。

## 13. 回滚

代码回滚：

1. 删除索引清单和本地管理工具；
2. 删除 PowerShell 入口和自动测试；
3. 恢复 `README.md`、`scripts/validate.js` 和打包清单。

云端索引不自动回滚。已创建索引通常不会改变业务数据，若确实需要删除，必须由管理员在控制台单独确认后操作。

