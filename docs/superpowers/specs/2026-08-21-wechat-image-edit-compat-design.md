# 微信小程序图片编辑兼容层设计

日期：2026-08-21  
状态：已获用户确认，进入实现

## 1. 目标

在不破坏当前 `images/generations` 流程的前提下，为微信小程序增加可配置的
`images/edits` 多图编辑路径，并补齐 CloudBase/AI 配置检查、可靠重试和脱敏日志。

本轮还要解决两个部署现实问题：

- 小程序工程没有绑定环境 ID 时，页面要给出明确提示；
- 微信开发者工具 CLI 服务端口关闭时，给出可执行的本机检查结果，而不是让用户猜。

## 2. 约束

- AppID 继续使用 `wxa5aaf3392cbeb39a`。
- API Key、AppSecret、CloudBase 密钥不进入前端源码、发布包或日志。
- 原桌面版 Electron、Python、Playwright 和本地 Ollama 不迁入小程序。
- 真实中转站可能改变 endpoint、multipart 字段名或是否支持多张参考图，因此不能把供应商字段写死。
- 生图请求默认不自动重试，避免上游已经扣费但客户端没有收到响应时重复生成。

## 3. 方案

### 3.1 配置切换

云函数读取以下配置：

- `AI_IMAGE_MODE=generations|edits`，默认 `generations`；
- `AI_IMAGE_EDIT_ENDPOINT`，为空时由 `AI_BASE_URL` 拼接 `/images/edits`；
- `AI_IMAGE_MAIN_FIELD`，默认 `image`；
- `AI_IMAGE_MASK_FIELD`，默认 `mask`；
- `AI_IMAGE_REFERENCE_FIELD`，默认 `image[]`；
- `AI_MAX_RETRIES`，默认 `2`；
- `AI_IMAGE_RETRY_ENABLED`，默认 `false`。

`generations` 保留现有 JSON 请求。`edits` 使用 multipart，主图、mask 和参考素材
均从云存储下载为 Buffer 后上传给上游。

### 3.2 mask 数据流

前端继续保存红圈坐标，同时新增一个不展示给用户的 mask canvas：

1. 清空画布；
2. 圈外绘制不透明保护区域；
3. 圈内保留透明编辑区域；
4. 使用 `wx.canvasToTempFilePath` 导出 PNG；
5. 和主图、参考图一样上传 CloudBase；
6. 生图请求把 mask 的 `fileID` 一并发送给云函数。

mask 的默认语义是“透明区域允许编辑”。如果供应商语义相反，由
`AI_MASK_INVERT=true` 控制反转，不改页面逻辑。

### 3.3 multipart 组装

云函数新增通用 multipart builder，不依赖前端直接传二进制。字段分为：

- 文本：`model`、`prompt`、`size`、可选 `n`；
- 文件：主图、mask、face refs、wardrobe refs。

参考图字段使用可重复字段名，默认是 `image[]`；供应商如果要求
`reference_images[]`，只改环境变量。

不会把完整图片内容、完整提示词或授权材料写入日志。

### 3.4 重试和日志

安全重试范围：

- 视觉分析 JSON 请求；
- 云文件下载；
- 上游返回图片 URL 的 GET 下载。

默认重试状态码：408、409、425、429、500、502、503、504。采用指数退避并尊重
`Retry-After`，每次请求最多 `AI_MAX_RETRIES + 1` 次。

生图 POST 默认不重试；只有显式设置 `AI_IMAGE_RETRY_ENABLED=true` 才允许重试。

每次云函数调用生成 `requestId`，结构化日志记录：

- action；
- requestId；
- attempt；
- status；
- durationMs；
- endpoint 主机；
- retryable；
- 错误分类。

密钥通过脱敏过滤器移除，URL 只保留协议、主机和路径，不输出 query 中的密钥。

### 3.5 配置和开发者工具检查

新增两个本地脚本：

- `scripts/check-deployment.js`：检查 `cloudEnvId`、变量模板、云函数依赖和敏感文件；
- `scripts/check-devtools.ps1`：检查微信开发者工具安装路径、CLI 可调用性和服务端口状态。

脚本只读检查，不自动修改微信账号、注册表或开发者工具设置。

## 4. 错误行为

- 没有 CloudBase 环境 ID：前端显示“请先填写 config.js 的 cloudEnvId”；
- 缺 AI Key、模型或 endpoint：云函数返回具体 `errorCode`；
- edits 缺主图或 mask：返回 `missing-edit-asset`；
- 上游 multipart 不接受字段：保留上游状态码和 requestId，前端只显示可读错误；
- 重试耗尽：返回 `retry-exhausted`，不隐藏最后一次错误。

## 5. 验证

必须完成：

1. JSON、JavaScript 静态检查；
2. prompt fallback smoke；
3. 云函数未知 action、缺配置和 consent 校验 smoke；
4. 本地 mock HTTP 服务验证：
   - 视觉请求按状态码重试；
   - 图片生成默认只提交一次；
   - edits multipart 包含主图、mask、参考图和文本字段；
5. 发布包校验不含 `node_modules`、密钥和临时文件。

## 6. 交付

代码完成后：

- 版本从 `0.1.1` 升到 `0.1.2`；
- 重新生成 `D:\aips小程序\wechat-miniapp-release-v0.1.2.zip`；
- 在 README 中写明两种图片模式、环境变量和开发者工具检查命令。
