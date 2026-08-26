# 图片模型主备容错设计

## 背景

普通版和腾讯版第一阶段当前都通过一套图片编辑配置调用 `/v1/images/edits`，现有像素保护又把 provider 硬限制为凌云。用户已确认新的生产规则：

- 主模型：星炬 `jw-gpt-image-2`；
- 备用模型：凌云 `gpt-image-2`；
- 图片编辑单次超时：150 秒；
- 腾讯 `FuseFaceUltra` 单次超时：75 秒；
- 主模型失败或超时后先用同一主模型重试 1 次，仍失败才切备用模型；
- 腾讯换脸失败只重试腾讯 1 次，不能切换为图片编辑模型；
- 普通版一次图片编辑同时处理换脸、衣服、背景和光影；
- 腾讯版第一步一次图片编辑处理衣服、背景和光影，第二步再由腾讯换脸。

## 目标

1. 普通版和腾讯版第一阶段共用同一套主备调用顺序。
2. 星炬最多调用 2 次，均失败后凌云调用 1 次。
3. 每次尝试使用独立 provider、model、endpoint、API Key 和 150 秒超时。
4. 切换 provider 后仍执行同一套素材预检、mask、像素保护、结果验收和无损 PNG 输出。
5. 一个逻辑创作任务只预留或扣除一次用户额度，重试和切备用不重复扣费。
6. 每次上游尝试单独记录 provider、model、attempt、耗时、状态和脱敏错误。
7. 腾讯第二步只复用已经验收并保存的第一阶段中间图；腾讯重试不得重新调用第一阶段。
8. API Key 只保存在云函数环境变量或管理员服务端配置中，不进入小程序日志、任务数据或 Git。

## 非目标

- 不把衣服、背景、光影拆成三次图片调用。
- 不改变提示词拼接规则和用户现有创作步骤。
- 不改变积分价格和单次逻辑任务的扣费规则。
- 不用凌云代替腾讯 `FuseFaceUltra`。
- 不在失败时绕过像素保护或把未经验收的原始模型图直接交付。
- 不改造局部修正 `repairImage` 的用户交互；局部修正继续使用主图片配置，后续可单独接入主备编排。

## 采用方案

在云函数后端增加统一图片 provider 编排器，保留现有 `requestImageEdits` 作为“单个 provider 的一次请求”。

编排器固定执行：

```text
星炬 jw-gpt-image-2，第 1 次，150 秒
→ 失败或超时
星炬 jw-gpt-image-2，第 2 次，150 秒
→ 失败或超时
凌云 gpt-image-2，第 1 次，150 秒
→ 失败或超时
最终失败
```

单个 provider 请求内部关闭通用自动重试，避免出现“编排器重试一次，底层又自动重试多次”的重复调用。是否继续下一次尝试由统一编排器判断。

## 配置结构

保留现有 `image` 作为主图片配置，新增 `imageBackup` 作为备用图片配置：

```text
image:
  provider = xingju
  model = jw-gpt-image-2
  timeoutMs = 150000
  maxRetries = 1

imageBackup:
  provider = lingyun
  model = gpt-image-2
  timeoutMs = 150000
  maxRetries = 0
```

默认环境变量：

```text
AI_IMAGE_PROVIDER
AI_IMAGE_BASE_URL
AI_IMAGE_ENDPOINT
AI_IMAGE_API_KEY
AI_IMAGE_MODEL
AI_IMAGE_TIMEOUT_MS

AI_IMAGE_BACKUP_PROVIDER
AI_IMAGE_BACKUP_BASE_URL
AI_IMAGE_BACKUP_ENDPOINT
AI_IMAGE_BACKUP_API_KEY
AI_IMAGE_BACKUP_MODEL
AI_IMAGE_BACKUP_TIMEOUT_MS
```

管理员页分别展示“图片主模型”和“图片备用模型”。读取配置时只返回密钥是否已配置；保存空密钥时继续保留原服务端密钥，不把真实密钥回传前端。

腾讯配置继续独立读取，默认 `timeoutMs = 75000`，上限允许 75 秒。

## 普通版数据流

```text
页面一次性拼接换脸、衣服、背景、光影要求
→ 上传主图、mask 和参考素材
→ submitGeneration
→ generation worker
→ 下载并预检素材一次
→ 主备编排器
→ 单次图片编辑结果
→ 本地椭圆像素保护和验收
→ 保存结果、写制作记录
→ 前端轮询取得图片
```

衣服、背景和光影仍在同一个 prompt 和同一个 `/v1/images/edits` 请求中，不累加成三次模型等待。

## 腾讯版数据流

```text
人脸检测与素材预检
→ 主备编排器完成一次衣服、背景、光影编辑
→ 本地人脸矩形保护和验收
→ 保存已验收中间图及保护元数据
→ 腾讯 FuseFaceUltra，75 秒
→ 腾讯失败时仅重试腾讯 1 次
→ 本地最终像素保护和验收
→ 保存最终图
```

第一阶段一旦成功，腾讯重试必须读取同一张中间图，禁止再次进入星炬或凌云。

## 像素保护兼容

把现有 `assertLingyunImageEditFlow` 改为通用的 `assertSupportedImageEditFlow`：

- 星炬仅允许 provider `xingju`、`星炬` 或项目配置的等价标准名，model 必须精确为 `jw-gpt-image-2`；
- 凌云仅允许 provider `lingyun` 或 `凌云`，model 必须精确为 `gpt-image-2`；
- 两者 endpoint pathname 都必须精确为 `/v1/images/edits`；
- 其他 provider、model 或 endpoint 立即 fail-closed；
- 普通版和腾讯版第一阶段的本地合成及验收标准完全相同，不因 provider 改变。

像素保护元数据不再使用 `lingyunIntermediate` 这类绑定单一渠道的字段名，新增中性字段 `imageEditIntermediate`；读取旧任务时兼容旧字段，避免已存在的腾讯中间任务失效。

## 重试和错误规则

### 可进入下一次尝试

- 网络连接失败；
- 单次请求超过对应 provider 的超时；
- HTTP 408、409、425、429；
- HTTP 5xx；
- 上游明确返回 busy、rate limit、temporary unavailable 等临时错误。

### 不进入下一次尝试

- 素材缺失、格式错误、mask 尺寸错误；
- provider、model、endpoint 配置不符合硬闸门；
- 401、403 等明确鉴权或权限错误；
- 上游返回不支持 edits 或请求参数错误；
- 返回图片无法解码、尺寸不一致或像素验收失败。

星炬的 401、403 不会通过重复调用消耗时间；编排器可直接切到凌云备用，但仍记录星炬失败原因。素材或像素保护错误属于整条任务错误，不切换 provider。

## 幂等、扣费和日志

- `requestId` 继续作为逻辑任务幂等键；
- `reserveUsage()` 只在任务入口执行一次；
- 编排器的三次上游尝试不调用 `reserveUsage()`；
- 最终失败只调用一次幂等退款；
- 每次尝试使用派生的上游幂等键，例如：

```text
requestId:primary:1
requestId:primary:2
requestId:backup:1
```

- operation 保存当前 provider、model、attempt、阶段和最近错误，方便恢复和排查；
- `model_usage_events` 每次尝试单独记录，但用户积分流水仍只有一笔；
- 日志不得记录 API Key、Authorization、原始上游响应全文或完整 OpenID。

150 秒客户端超时不等于上游一定停止。后台 worker 必须保存“结果状态未知”的错误分类和尝试信息；同一派生幂等键不得被前端轮询再次触发。

## 前端状态

普通版和腾讯版都只展示用户能看懂的阶段：

- 正在使用主模型生成；
- 主模型暂时失败，正在重试；
- 主模型不可用，正在切换备用模型；
- 正在进行腾讯人脸融合；
- 创作完成；
- 主模型和备用模型均不可用，请稍后重试。

不把 API Key、完整 endpoint 或上游原始错误返回给普通用户。管理员日志可看到脱敏后的 provider、model、attempt、耗时和错误码。

## 测试与验收

必须覆盖：

1. 星炬第一次成功，凌云调用次数为 0。
2. 星炬第一次超时、第二次成功，凌云调用次数为 0。
3. 星炬两次失败，凌云第一次成功。
4. 三次都失败，逻辑任务最终失败且只退款一次。
5. 普通版只执行一次成功图片编辑，prompt 同时包含衣服、背景、光影要求。
6. 腾讯版第一阶段能切到凌云，第二阶段仍只调用腾讯。
7. 腾讯第二阶段失败重试 1 次，不重新调用星炬或凌云。
8. 星炬和凌云结果都经过相同像素保护，圈外 exact mismatch 为 0。
9. 旧腾讯任务的 `lingyunIntermediate` 元数据仍能恢复。
10. 管理员配置能独立保存主模型和备用模型，密钥不回传。
11. 图片超时允许 150000，腾讯超时允许并默认 75000。
12. 重试和切备用不会重复预留积分、重复生成记录或重复退款。

## 发布与回滚

- 在现有并行改动上增量修改，不覆盖工作区其他文件。
- 功能完成后升级小程序补丁版本并生成正式 ZIP。
- 只用项目受控同步脚本提交本次明确文件。
- 部署前同时配置星炬主模型和凌云备用模型密钥；缺少备用密钥时启动检查必须明确显示“备用未配置”。
- 回滚时恢复上一正式版本；运行中任务保留当前 provider 尝试记录，由任务回收逻辑完成退款或结果补记，不能直接删除。

