# 圈像创作微信小程序

这是从原 Electron + Python 桌面版拆出来的微信小程序独立工程。

原桌面工程仍然保留在：

```text
D:\aips小程序\展示面工具_源码_20260821
```

小程序工程在：

```text
D:\aips小程序\wechat-miniapp
```

## 已实现

- 原生微信小程序分步向导；
- 主图选择；
- 主图重新选择与独立清除；
- 手指拖动绘制红圈；
- 主图支持双指捏合缩放、双指平移，单指继续绘制红圈；
- 主图与红圈分层绘制，降低真机拖动卡顿；
- 最多 6 张人脸参考图；
- 最多 12 张衣物 / 配饰参考图；
- 场景、姿态、面部朝向、光影妆容描述；
- 区域锁定提示词和负面约束生成；
- 本地预览模式；
- CloudBase 云函数调用入口；
- 云端生图结果归档和记录删除；
- 每个微信用户每日生成次数限制。
- 主图、人脸参考图、穿搭参考图上传前自动压缩；
- 压缩失败或压缩后变大时自动回退原图，mask 保留 PNG 透明通道。

## 和桌面版的差异

微信小程序不能直接运行 Electron、Python、Playwright、Windows 文件系统和本地 Ollama，所以 MVP 暂时不包含：

- ChatGPT / Gemini 网页自动登录和自动发送；
- Windows 文件夹、ZIP 和本地项目文件导出；
- 本地 Ollama；
- 桌面端 MediaPipe 本地自动蒙脸（小程序已改为云函数调用阿里云百炼视觉模型）。

“红圈自动贴脸”现在只走云端：小程序先上传主图，再由 `api` 云函数调用百炼识别人脸位置。云端不可用或没有识别到清晰人脸时，会自动进入手动画圈，不再下载或运行本地模型、MediaPipe、WASM。

## 用微信开发者工具打开

不要打开上级目录 `D:\aips小程序`，也不要打开旧桌面目录。

在微信开发者工具中选择：

```text
导入项目
项目目录：D:\aips小程序\wechat-miniapp
AppID：wxa5aaf3392cbeb39a
```

这个目录根部必须能看到：

```text
app.json
app.js
project.config.json
pages\
cloudfunctions\
```

如果模拟器仍然提示“找不到 app.json”，说明开发者工具打开的不是 `wechat-miniapp` 目录。

## 配置 CloudBase

### 1. 创建环境

在开发者工具打开本项目后，进入“云开发”，创建一个环境，记下环境 ID。

### 2. 填环境 ID

编辑：

```text
D:\aips小程序\wechat-miniapp\config.js
```

把：

```js
  cloudEnvId: ""
```

改成：

```js
cloudEnvId: "你的云环境 ID"
```

不要把 `AppSecret` 或 AI API Key 写进 `config.js`。

如果要启用编辑模式，还要把同一个文件里的：

```js
imageMode: "generations"
```

改成：

```js
imageMode: "edits"
```

它必须和云函数环境变量 `AI_IMAGE_MODE=edits` 同时设置；只改一边会得到明确的
`missing-edit-asset` 提示，不会悄悄走错图片模式。

图片上传默认使用以下本地压缩配置：

```js
imageCompression: {
  enabled: true,
  quality: 82,
  minBytes: 262144
}
```

`minBytes` 以下的小图不压缩；压缩结果没有明显变小时会自动使用原图。
红圈导出的 mask 不走压缩，避免透明区域被破坏。

### 3. 部署云函数

在开发者工具的文件树中：

```text
右键 cloudfunctions/api
→ 上传并部署：云端安装依赖
```

云函数目录里的 `package.json` 会自动安装 `wx-server-sdk`。

### 4. 配置云端自动贴脸

不需要上传本地模型，也不需要配置 WASM 文件。部署 `api` 云函数后，只要在云函数环境变量里配置 `AI_VISION_API_KEY`，自动贴脸就会使用阿里云百炼。

默认配置已经写进云函数：

```text
服务商：dashscope
接口地址：https://dashscope.aliyuncs.com/compatible-mode/v1
视觉模型：qwen3-vl-flash（想要更高质量时可改回 qwen3-vl-plus）
超时：25 秒
主图上限：5 MB
```

这些默认值可以用环境变量覆盖，但 API Key 只能放在云函数环境变量，不能写进小程序源码。

### 5. 配置云函数环境变量

在云函数 `api` 的配置中填写环境变量：

```text
AI_VISION_API_KEY=你的阿里云百炼 API Key

# 以下均为可选覆盖项；不填就使用代码里的百炼默认值
AI_VISION_MODEL=qwen3-vl-flash
AI_FACE_MODEL=qwen3-vl-flash
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_IMAGE_MODEL=实际可用的生图模型
AI_IMAGE_SIZE=1024x1024
DAILY_GENERATION_LIMIT=5
AI_IMAGE_MODE=generations
AI_IMAGE_EDIT_ENDPOINT=
AI_IMAGE_MAIN_FIELD=image
AI_IMAGE_MASK_FIELD=mask
AI_IMAGE_REFERENCE_FIELD=image[]
AI_MASK_INVERT=false
AI_MAX_RETRIES=2
AI_IMAGE_RETRY_ENABLED=false
```

真实密钥只放云函数环境变量，不写进小程序前端。

部署前可以在工程根目录执行：

```powershell
node .\scripts\check-deployment.js
node .\scripts\check-deployment.js --strict
```

不填 `cloudEnvId` 时，普通检查会给出警告；`--strict` 适合正式发布前使用。

微信开发者工具本机检查：

```powershell
PowerShell -ExecutionPolicy Bypass -File .\scripts\check-devtools.ps1
```

如果脚本提示服务端口关闭，在开发者工具中进入：

```text
设置 → 安全设置 → 开启服务端口
```

当前这台电脑的检查结果是：开发者工具已安装，CLI 已找到，但服务端口仍关闭。
需要在开发者工具界面手动打开一次，之后才能使用 `cli.bat` 自动打开、预览或上传项目。

### 6. 创建数据库集合

在云开发数据库创建：

```text
generation_records
user_quotas
```

集合权限建议设置为“仅云函数可读写”。前端不直接读写数据库，统一通过 `api` 云函数处理。

## 调试顺序

1. 确认 `config.js` 已填写 CloudBase 环境 ID；
2. 部署 `cloudfunctions/api`；
3. 在云函数环境变量里配置 `AI_VISION_API_KEY`；
4. 点“红圈自动贴脸”，确认百炼返回人脸位置；
5. 临时断开云端或制造错误，确认页面会进入手动画圈；
6. 点“AI 分析主图”测试视觉接口；
7. 测试“提交生图并归档”；
8. 到“制作记录”检查云端记录和删除功能。

## 当前生图接口约定

百炼视觉默认使用 OpenAI-compatible 接口：

```text
POST {AI_BASE_URL}/chat/completions
POST {AI_BASE_URL}/images/generations
```

如果中转站路径不同，可以配置：

```text
AI_VISION_ENDPOINT=https://example.com/vision
AI_IMAGE_ENDPOINT=https://example.com/image
```

### 编辑模式

默认 `AI_IMAGE_MODE=generations`，保持原来的 JSON 生图流程。

如果中转站支持 multipart 图片编辑，可改成：

```text
AI_IMAGE_MODE=edits
AI_IMAGE_EDIT_ENDPOINT=https://example.com/v1/images/edits
AI_IMAGE_MAIN_FIELD=image
AI_IMAGE_MASK_FIELD=mask
AI_IMAGE_REFERENCE_FIELD=image[]
```

小程序会根据红圈导出透明区域 mask，并把主图、mask、人脸参考图和穿搭参考图交给云函数组装 multipart 请求。不同供应商如果要求 `reference_images[]` 等字段，只改环境变量，不改页面代码。

生图默认不自动重试，避免上游已经扣费但客户端没有收到响应时重复生成。视觉分析、云文件下载和结果图片下载会按 `AI_MAX_RETRIES` 做退避重试；每次云函数请求都有 `requestId`，排查失败时把请求编号交给后台日志即可。

## AI 接口回归测试

本地兼容性检查不访问供应商，也不会产生费用：

```powershell
node .\scripts\ai-provider-smoke.js --check
node .\scripts\image-smoke.js
```

如果要测试真实视觉接口，只在当前终端临时设置变量，不要写进源码或发布包：

```powershell
$env:AI_BASE_URL = "https://你的中转站/v1"
$env:AI_SMOKE_API_KEY = "你的临时测试密钥"
$env:AI_VISION_MODEL = "实际可用的视觉模型"
$env:AI_SMOKE_IMAGE = "D:\测试图片\main.jpg"
node .\scripts\ai-provider-smoke.js --real
```

真实图片生成和编辑可能扣费，脚本要求显式确认：

```powershell
$env:AI_IMAGE_MODEL = "实际可用的生图模型"
$env:AI_SMOKE_MAIN = "D:\测试图片\main.jpg"
$env:AI_SMOKE_MASK = "D:\测试图片\mask.png"
node .\scripts\ai-provider-smoke.js --real --allow-paid --images
node .\scripts\ai-provider-smoke.js --real --allow-paid --edits
```

没有 `AI_SMOKE_API_KEY`、endpoint、模型或测试图片时，脚本会安全停止，不会伪造“真实接口通过”。
