# 腾讯版脸部保护、图片编辑检查与等待超时设计

日期：2026-08-26
状态：用户已确认，进入实现

## 1. 目标

在不改变腾讯 `FuseFaceUltra` 请求格式和普通制作页 mask 链路的前提下，补齐三项能力：

1. 腾讯版第一阶段在修改衣服、背景、光影前，自动检测主图中的全部人脸，并生成脸部保护 mask；
2. 管理员页面增加不扣费的图片编辑配置检查，明确展示 provider、model、edits endpoint 和请求格式；
3. 腾讯版页面增加客户端等待超时和“继续查询”入口，超时后绝不自动重新提交生成请求。

版本从 `0.42.4` 升级到 `0.42.5`。

## 2. 明确不改动

- 不修改腾讯 `FuseFaceUltra` 的请求字段、签名、模型参数和最终换脸逻辑；
- 不修改普通制作页已有的 `maskFileID` 导出、上传和提交链路；
- 不修改视频、实况、普通生图和局部修正流程；
- 图片编辑失败继续 fail-closed，不自动退回 `/images/generations`；
- 不把 API Key、AppSecret、图片内容或完整提示词写入日志。

## 3. 腾讯版脸部保护 mask

### 3.1 数据流

```text
主图
  ↓
现有视觉人脸检测
  ↓
归一化 0-1000 人脸框
  ↓
按主图实际宽高生成同尺寸 PNG 保护 mask
  ↓
GPT/Lingyun 图片编辑：主图 + 保护 mask + 提示词
  ↓
腾讯 FuseFaceUltra 最终换脸
```

保护 mask 只用于第一阶段。腾讯阶段重试直接复用已保存的中间图，不重复调用视觉检测和图片编辑，避免重复扣费。

### 3.2 人脸框和安全边距

- 使用 `normalizeFaceDetections` 的全部有效人脸框，不只保护第一张脸；
- 每个人脸框四周增加安全边距，默认按人脸框宽高的 22% 扩展；
- 扩展后的坐标裁剪到图片边界；
- 至少保留 1 像素宽高；
- 多个人脸框重叠时直接合并为同一个不透明保护区域。

### 3.3 mask 默认语义

沿用现有图片编辑语义：

- 透明区域：允许编辑衣服、背景和光影；
- 不透明区域：保护脸部，不允许编辑；
- mask 尺寸必须与主图完全一致；
- mask 固定输出 PNG。

如果供应商 mask 语义相反，继续使用现有 `AI_MASK_INVERT=true` 反转 alpha，不修改页面或检测逻辑。

### 3.4 支持的主图与失败行为

- 从 PNG、JPEG、WebP 文件头读取主图宽高；
- 无法识别格式、尺寸异常、像素数过大、检测接口失败或没有检测到人脸时，第一阶段直接停止；
- 错误码区分：
  - `TENCENT_PIPELINE_FACE_DETECTION_FAILED`
  - `TENCENT_PIPELINE_FACE_NOT_FOUND`
  - `TENCENT_PIPELINE_MASK_INVALID`
- 失败时不得发送没有保护 mask 的图片编辑请求；
- 失败仍沿用现有额度退款和请求幂等逻辑。

## 4. 图片编辑请求适配

`requestTencentPipelineImageEdit` 增加必填的保护 mask Buffer：

- multipart provider：
  - 主图字段继续读取 `AI_IMAGE_MAIN_FIELD`，默认 `image`；
  - mask 字段继续读取 `AI_IMAGE_MASK_FIELD`，默认 `mask`；
- Lingyun JSON provider：
  - 主图继续放入 `images[0].image_url`；
  - mask 放入 `mask.image_url`；
- 请求日志只记录：
  - provider、model、脱敏 endpoint；
  - `requestFormat`；
  - `mainImagePresent`；
  - `maskPresent`；
  - 主图和 mask 的尺寸；
  - 不记录图片 Base64、密钥和完整 prompt。

## 5. 管理员图片编辑配置检查

新增管理员动作 `probeImageEditCapability`，默认只做安全配置检查，不发送生成请求：

- 校验管理员权限；
- 解析当前有效图片配置；
- 返回脱敏后的 provider、model、edits endpoint、endpoint 来源；
- 返回当前请求格式：
  - Lingyun 使用 JSON；
  - 其他 provider 使用 multipart；
- 返回主图字段、mask 字段、参考图字段和 `AI_MASK_INVERT` 状态；
- 返回 API Key 是否已配置，但绝不返回 Key；
- 明确返回：
  - `liveVerified: false`
  - `billingRisk: false`
  - `requiresLiveTest: true`
  - “本次只核对配置，不代表上游已经实测支持 mask 像素合成”。

管理员页按钮文案使用“检查图片编辑配置”，结果中必须醒目标明“不扣费、未真实生图”。不能把 `/models` 可访问误报成 edits/mask 已验证。

## 6. 腾讯版页面等待超时

### 6.1 状态

新增 `timedOut` 状态：

- 单次页面等待超过 150 秒后停止前端轮询；
- 保留 `requestId`、已上传 fileID 和当前进度；
- 页面提示：“服务可能仍在处理，请勿重复点击开始制作”；
- 显示“继续查询结果”按钮；
- 不自动重新提交 `tencentFaceFusionPipeline`；
- 用户点击继续查询时，仅调用 `getTencentFaceFusionPipelineStatus`。

### 6.2 查询结果

- 查询到 `processing`：恢复轮询，重新开始一轮等待计时；
- 查询到 `succeeded`：如果状态接口带最终结果，则进入成功状态；如果只返回阶段状态，提示用户到制作记录查看，不重新提交；
- 查询到 `failed`：显示失败信息和现有“只重试腾讯换脸”能力；
- 查询失败：保留 requestId，允许再次手动查询。

## 7. 错误、幂等与扣费

- 新建请求继续使用现有 `requestId` 和 `reserveUsage`；
- 页面超时只代表客户端停止等待，不代表云函数任务失败；
- 超时后禁止自动生成新的 requestId；
- “继续查询”只读状态，不扣费；
- 腾讯阶段失败且中间图存在时，继续只重试腾讯阶段；
- 图片编辑能力不支持、endpoint 无效、model 不支持等错误不重试，不降级到 generations。

## 8. 测试

专项测试必须覆盖：

1. 单人脸 mask；
2. 多人脸 mask；
3. 22% 安全边距；
4. 贴边人脸坐标裁剪；
5. mask 与主图尺寸一致且为 PNG；
6. 默认 alpha 语义；
7. `AI_MASK_INVERT`；
8. 检测失败或无人脸时不发送图片编辑请求；
9. multipart 请求包含真实 mask；
10. Lingyun JSON 请求包含 `mask.image_url`；
11. 腾讯 `FuseFaceUltra` 请求格式保持不变；
12. 页面 150 秒超时后保留 requestId；
13. 超时后不自动重新提交；
14. 手动继续查询只调用状态接口；
15. 管理员检查不发起生图、不显示密钥，并明确 `liveVerified=false`；
16. edits 错误不自动调用 generations；
17. 普通制作页、视频、腾讯单独重试和旧 mask 链路回归通过。

## 9. 回滚

- 代码回滚到 `0.42.4`；
- 不涉及数据库结构变更，无需迁移数据；
- 不涉及腾讯或图片上游密钥变更；
- 如新 mask 适配导致兼容问题，回滚本次版本，不允许临时去掉 mask 后继续请求；
- 如管理员检查显示配置异常，只调整运行时 provider、model、endpoint，不改普通制作页。
