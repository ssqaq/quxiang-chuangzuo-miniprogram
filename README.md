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
- 照片转动态视频入口、相册/制作记录选图和小程序内长按预览骨架；
- 媒体解析结果通过 CloudBase 临时转存后再保存到手机，成功立即释放，失败最多保留约 2 小时；

## 和桌面版的差异

微信小程序不能直接运行 Electron、Python、Playwright、Windows 文件系统和本地 Ollama，所以 MVP 暂时不包含：

- ChatGPT / Gemini 网页自动登录和自动发送；
- Windows 文件夹、ZIP 和本地项目文件导出；
- 本地 Ollama；
- 桌面端 MediaPipe 本地自动蒙脸（小程序已改为云函数调用阿里云百炼视觉模型）。

“自动识别人脸”现在只走云端：小程序先上传主图，再由 `api` 云函数调用百炼识别人脸位置。云端不可用或没有识别到清晰人脸时，会自动进入手动画圈，不再下载或运行本地模型、MediaPipe、WASM。

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

媒体解析功能使用独立云函数，不和主 `api` 云函数混在一起：

```text
右键 cloudfunctions/watermark-gateway
→ 上传并部署：云端安装依赖
```

然后只在 `watermark-gateway` 云函数控制台配置：

```text
WATERMARK_PROVIDER=zhuceka
ZHUCEKA_API_BASE=https://api.zhuceka.cn/home/api
ZHUCEKA_UID=你的接口 UID
ZHUCEKA_KEY=你的接口 Key
ZHUCEKA_TIMEOUT_MS=20000
```

UID、Key 不能写进源码、README、Git 或小程序前端。媒体解析网关返回视频或图片地址后，
小程序点击“保存媒体”会调用主 `api` 云函数，把第三方文件转存到 CloudBase 临时文件，
再由小程序下载到本地并保存到手机相册。保存成功后立即删除云端临时文件；网络中断、
用户退出或删除失败时，由每 15 分钟一次的清理任务兜底，文件最多保留约 2 小时。
这条链路不新增独立服务器，也不把第三方动态 CDN 域名直接交给微信 `downloadFile`。

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
# 人脸识别专用：和生图、视频使用不同的配置
AI_VISION_PROVIDER=dashscope
AI_VISION_API_KEY=你的阿里云百炼 API Key
AI_VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
AI_VISION_MODEL=qwen3-vl-flash
AI_FACE_MODEL=qwen3-vl-flash

# 生图专用：和人脸识别、视频模型完全分开
AI_IMAGE_PROVIDER=lingyun
AI_IMAGE_API_KEY=你的生图服务 API Key
AI_IMAGE_BASE_URL=https://api.lingyunapi.xyz/v1
AI_IMAGE_ENDPOINT=https://api.lingyunapi.xyz/v1/images/generations
AI_IMAGE_MODEL=gpt-image-2
AI_IMAGE_SIZE=1024x1024
DAILY_GENERATION_LIMIT=5
AI_IMAGE_MODE=edits
AI_IMAGE_EDIT_ENDPOINT=https://api.lingyunapi.xyz/v1/images/edits
AI_IMAGE_MAIN_FIELD=image
AI_IMAGE_MASK_FIELD=mask
AI_IMAGE_REFERENCE_FIELD=image[]
AI_MASK_INVERT=false
AI_MAX_RETRIES=2
AI_IMAGE_RETRY_ENABLED=true

# 转实况/动态视频专用：凌云中转站 + Grok 异步视频任务
AI_VIDEO_PROVIDER=lingyun
AI_VIDEO_BASE_URL=https://api.lingyunapi.xyz
AI_VIDEO_ENDPOINT=
AI_VIDEO_QUERY_ENDPOINT=
AI_VIDEO_MODEL=grok-imagine-video-1.5
AI_VIDEO_API_KEY=你的凌云视频 API Key
AI_VIDEO_CREATE_PATH=/v1/videos/generations
AI_VIDEO_QUERY_PATH=/v1/videos/{taskId}
AI_VIDEO_RESOLUTION=720p
AI_VIDEO_ASPECT_RATIO=
AI_VIDEO_TIMEOUT_MS=90000
```

真实密钥只放云函数环境变量，不写进小程序前端。

## 管理员配置与部署检查

管理员白名单通过云函数环境变量 `ADMIN_OPENIDS` 配置，支持逗号或换行分隔多个微信
OpenID。管理员进入工作台后会看到“管理员配置”入口，普通用户不会看到；即使手动打开
页面地址，云函数也会再次校验 OpenID。

管理员页可以在线修改生图和视频模型的非敏感参数，包括 provider、地址、模型、模式、
清晰度、超时和重试设置。API Key 永远只从云函数环境变量读取，不下发前端、不写入
`admin_runtime_config`，也不会出现在部署检查日志中。

管理员点击“立即检查线上部署”后，可以看到云函数版本、构建标记、生图/视频配置状态、
动态配置版本和最近 20 条检查记录。日志只记录版本和状态，不记录图片、提示词或密钥。

管理员页的“模型用量统计”还支持：

- 按用户哈希统计谁使用次数最多，不保存真实 OpenID；
- 按 Provider 和模型名称分组比较调用次数、Token、视频秒数和成本；
- 按北京时间查看每日明细和最近 12 个月的月度趋势；
- 按人民币统计人脸 Token、生图分辨率、视频分辨率和视频秒数成本；
- 导出包含“每日明细、按用户、按模型、按月份”四个工作表的 Excel 文件。

默认成本配置为：

- 人脸识别：输入 0.15 元 / 百万 Token，输出 1.5 元 / 百万 Token；
- 生图：1K 0.015 元 / 张，2K 0.025 元 / 张，4K 0.035 元 / 张；
- 视频：480p 0.2 元 / 秒，720p 0.3 元 / 秒，1080p 1.8 元 / 秒。

供应商返回真实 Token 或视频秒数时按真实用量计算；没有返回时按请求分辨率和默认时长估算，
后台会区分“实际”和“估算”。旧的模型调用记录没有完整成本字段，只保留调用次数，不补造历史金额。

当前凌云生图配置：

- 中转站根地址：`https://api.lingyunapi.xyz`
- 普通生图接口：`POST https://api.lingyunapi.xyz/v1/images/generations`
- 图片编辑接口：`POST https://api.lingyunapi.xyz/v1/images/edits`
- 模型：`gpt-image-2`
- 编辑请求使用 JSON，主图和参考图放到 `images[].image_url`，mask 放到 `mask.image_url`

Key 只填写到云函数环境变量 `AI_IMAGE_API_KEY`，不要写进源码、README、
日志或发布 ZIP。自动识别人脸继续使用 `AI_VISION_API_KEY` 的 DashScope，
不会被凌云生图配置替换。

部署前可以在工程根目录执行：

```powershell
node .\scripts\check-deployment.js
node .\scripts\check-deployment.js --strict
```

不填 `cloudEnvId` 时，普通检查会给出警告；`--strict` 适合正式发布前使用。

不要只看开发者工具弹出的“部署成功”。部署 `api` 时，直接运行下面这个脚本：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-and-verify-api.ps1
```

它会自动完成“部署云函数 → 调用线上云函数 → 对比本地版本和线上版本/构建标记”。
只有线上返回完全一致才会显示通过；如果线上还是旧版本，脚本会报错并停止。
运行前要在微信开发者工具里登录管理员微信，并打开服务端口。

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

先部署最新版 `api` 云函数，并确认当前测试微信已经加入云函数环境变量
`ADMIN_OPENIDS`。然后在工程根目录执行：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\init-cloud-database.ps1
```

脚本会通过微信开发者工具当前登录态调用管理员初始化接口，自动检查并补齐以下集合：

```text
admin_deployment_logs
admin_runtime_config
asset_upload_tickets
auto_face_failure_logs
auto_face_probe_logs
generation_operations
generation_records
model_usage_events
photo_to_video_temp_assets
point_ledger
publish_export_jobs
repair_chains
user_accounts
user_assets
user_diagnostic_logs
user_profiles
user_quotas
watermark_transfer_temp_assets
```

已经存在的集合只会显示为 `existing`，不会清空或覆盖数据。正式执行前可追加
`-DryRun`，只检查项目配置和微信开发者工具命令入口，不发送云端请求。

以上集合权限统一设置为“仅云函数可读写”。前端不直接读写数据库，统一通过 `api`
云函数处理；初始化脚本不修改数据库权限规则，所以首次创建后仍需在 CloudBase 控制台的
“数据库 → 集合 → 权限设置”里统一确认一次。

`auto_face_failure_logs` 只保留最近 90 天的数据。`api` 云函数在失败上报或管理员刷新统计
时触发一次懒清理，每次最多删除 100 条过期记录，清理失败不会影响用户上报或管理员查看统计。

`auto_face_probe_logs` 只保存管理员主动检查的探针状态、版本、视觉配置、Provider、Model
和耗时，保留最近 30 天，管理页最多显示 20 条；不保存 API Key、图片、提示词或完整用户身份。

`watermark_transfer_temp_assets` 只登记媒体保存时的临时 CloudBase 文件。正常保存成功后
立即删除；失败或中途退出时，`api` 每 15 分钟检查一次，到期后删除云文件并移除登记，
删除失败会保留记录继续重试。手机相册里的文件不受这个 2 小时清理影响。

### 7. 检查数据库索引

集合已经创建，不代表查询需要的索引也已经存在。先在当前 PowerShell
终端临时设置腾讯云管理凭据，再执行只读检查：

```powershell
$env:TENCENTCLOUD_SECRET_ID = "当前终端临时SecretId"
$env:TENCENTCLOUD_SECRET_KEY = "当前终端临时SecretKey"
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1 -CheckOnly
```

确认只读检查结果没有问题后，再运行逐项确认模式：

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-cloud-database-indexes.ps1
```

使用规则：

- `-CheckOnly` 只读取云端索引，不修改云端；
- 默认直接回车等于跳过当前索引；
- 输入 `A` 只对后续缺失索引执行创建，不会回头修改已经跳过的项目；
- 同名但字段配置错误的索引，必须输入完整索引名才会进入重建确认；
- 项目清单之外的多余索引只报告，不自动删除；
- 检查报告保存在 `_tmp_database-index-reports`；
- 如果提示集合缺失，先运行 `scripts/init-cloud-database.ps1` 创建集合；
- 完成后清掉当前终端里的临时凭据：

```powershell
Remove-Item Env:TENCENTCLOUD_SECRET_ID -ErrorAction SilentlyContinue
Remove-Item Env:TENCENTCLOUD_SECRET_KEY -ErrorAction SilentlyContinue
Remove-Item Env:TENCENTCLOUD_SESSION_TOKEN -ErrorAction SilentlyContinue
```

密钥只能通过当前进程环境变量提供，不能写进 `config.js`、`.env`、源码或发布包。

## 调试顺序

1. 确认 `config.js` 已填写 CloudBase 环境 ID；
2. 部署 `cloudfunctions/api`；
3. 在云函数环境变量里配置 `AI_VISION_API_KEY`；
4. 点“自动识别人脸”，确认百炼返回人脸位置；
5. 临时断开云端或制造错误，确认页面会进入手动画圈；
6. 点“AI 分析主图”测试视觉接口；
7. 测试“提交生图并归档”；
8. 到“制作记录”检查云端记录和删除功能。

## 照片转动态视频

首页“照片转实况图”入口当前交付的是小程序内的动态视频体验：

- 可从手机相册或制作记录选择照片；
- 计划由云函数异步调用视频 provider 生成约 2–3 秒无声 MP4；
- 生成后分别保存静态照片和普通视频；
- 生成成功后，小程序内支持按住预览视频、松开回到静态图；
- 单张任务独立记录，失败项可以单独重试。
- 用户离开照片转视频页面后，本次会话进入 2 小时闲置倒计时；云端每 15 分钟检查一次。
- 满 2 小时后，清理本次实际使用的临时源照片、临时结果视频、云端正式结果文件和正式制作记录。
- 小程序本地记录与临时路径会在下次启动时补清；小程序关闭期间无法直接运行本地删除代码。
- 用户在 2 小时内重新进入页面会取消闲置倒计时，避免仍在使用时误删。
- 每个目标仍保留 3×24 小时最终兜底期限；删除失败会保留登记，下一轮继续重试。
- 手机系统相册中已经保存的照片和视频不受自动清理影响，小程序没有后台静默删除系统相册文件的能力。

`photo_to_video_temp_assets` 只登记照片转视频实际使用的 `source`、`result` 和 `record`
目标。`record` 由云函数按当前微信用户身份读取和删除，客户端不能指定其他用户的记录。

`cloudfunctions/api/config.json` 已配置每 15 分钟检查闲置目标，并保留每天凌晨 3 点的
72 小时兜底任务。部署 `api` 云函数后，还要在 CloudBase 数据库创建
`photo_to_video_temp_assets` 集合，并设置为“仅云函数可读写”；只通过本地静态检查
不能代表线上定时任务已经生效。

当前已接入凌云中转站的 Grok 异步视频适配：创建任务使用
`POST /v1/videos/generations`，随后使用 `GET /v1/videos/{taskId}` 轮询，
默认清晰度为 720p。创建请求只发一次，避免网络抖动造成重复扣费；查询可以
自动重试。真实模型名、路径和清晰度都可以通过云函数环境变量调整。

价格按当前供应商报价记录：480p 约 0.2/秒、720p 约 0.3/秒、1080p 约 1.8/秒。
正式测试会产生费用，当前代码不会自动替你生成真实视频。

重要边界：普通 MP4 和静态照片不是 iPhone 原生 Live Photo，也不保证 Android
系统相册按住播放。若要做真正的 Live Photo/Motion Photo，需要原生照片库或按
厂商分别验证的后续实验，不能只依赖微信小程序的相册保存 API。

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

图片编辑模式配置为：

```text
AI_IMAGE_MODE=edits
AI_IMAGE_EDIT_ENDPOINT=https://example.com/v1/images/edits
AI_IMAGE_MAIN_FIELD=image
AI_IMAGE_MASK_FIELD=mask
AI_IMAGE_REFERENCE_FIELD=image[]
```

小程序会根据红圈导出透明区域 mask，并把主图、mask、人脸参考图和穿搭参考图交给云函数。凌云图片上游使用 JSON 格式的 `images[].image_url` 和 `mask.image_url`；其他 OpenAI-compatible 上游继续使用 multipart 的 `image`、`mask` 和 `image[]` 字段。页面上传和 `maskFileID` 链路不需要改。

生图默认允许自动重试，最多按 `AI_MAX_RETRIES` 再试；只对网络失败、限流和服务端临时错误重试。若上游已经扣费但客户端没有收到响应，仍可能产生重复生成；对计费敏感的环境可在管理员页面取消勾选，或把 `AI_IMAGE_RETRY_ENABLED=false`。视觉分析、云文件下载和结果图片下载也会按 `AI_MAX_RETRIES` 做退避重试；每次云函数请求都有 `requestId`，排查失败时把请求编号交给后台日志即可。

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

## GitHub 自动同步与恢复

GitHub 私有仓库：

```text
https://github.com/ssqaq/quxiang-chuangzuo-miniprogram
```

### 手动立即同步

在 PowerShell 执行，必须显式列出本次要同步的文件：

```powershell
Set-Location "D:\aips小程序\wechat-miniapp"
& .\scripts\sync-to-github.ps1 -IncludePath @(
  "scripts\example.js",
  "README.md"
)
```

脚本会先获取独占发布锁并拉取远端更新；有变化时只暂存 `-IncludePath` 指定的文件，
从暂存 Git tree 生成提交前检查包，提交后再从最终 commit SHA 生成正式发布 ZIP，
最后推送到 `main`。没有变化时不会创建空提交。

发布包默认生成在小程序目录旁边：

```text
D:\aips小程序\wechat-miniapp-release-v版本.zip
```

如果发布包检查失败，脚本会停止提交和推送，避免把未通过检查的版本同步到 GitHub。
打包前后如果 HEAD、tree SHA 或工作区状态变化，脚本会判定有并行任务插入并立即停止。
发布包里的 `RELEASE-MANIFEST.txt` 会记录最终 commit SHA、Git tree SHA 和源码内容 SHA256。

### 一键安装 Git hooks

换电脑或重新克隆仓库后，在项目根目录双击下面这个文件即可：

```text
D:\aips小程序\wechat-miniapp\scripts\install-git-hooks.cmd
```

也可以在 PowerShell 执行：

```powershell
Set-Location "D:\aips小程序\wechat-miniapp"
& .\scripts\install-git-hooks.ps1
```

脚本会检查 `.githooks\pre-commit` 和 `.githooks\post-commit`，再把当前仓库的
`core.hooksPath` 设置为 `.githooks`。如果本机已经配置了其他 hooks 路径，默认拒绝覆盖；
确认后可执行 `& .\scripts\install-git-hooks.ps1 -Force`。

### 自动发布记录

每次正式包推送完成并确认本地 `HEAD` 与 `origin/main` 一致后，发布脚本会自动在项目目录外生成一份 JSON：

```text
D:\aips小程序\wechat-miniapp-release-records\release-v版本-提交号.json
```

记录包含版本号、最终 commit SHA、Git tree SHA、源码内容 SHA256、正式 ZIP 的 SHA256、
包大小、发布时间和本次变更文件。记录放在项目目录外，避免写回源码后改变正式包指纹。

### 自动同步

当前采用“改完并验证后立即同步”，不依赖 Windows 每 10 分钟轮询任务。
并行任务必须在独立分支或 worktree 开发；仓库的 `pre-commit` hook 会拒绝直接在 `main` 提交。
`post-commit` hook 只兜底推送独立分支，`main` 统一使用上面的受控同步脚本发布。

同步日志保存在项目目录外，不会上传到 GitHub：

```text
D:\aips小程序\wechat-miniapp-sync-logs\sync-YYYY-MM-DD.log
```

如果自动任务失败，先打开当天日志看最后一段错误，再手动运行同步脚本复现。

### 换电脑恢复

先安装 Git 和微信开发者工具，再执行：

```powershell
git clone https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git `
  "D:\aips小程序\wechat-miniapp"
```

然后：

1. 用微信开发者工具导入 `D:\aips小程序\wechat-miniapp`；
2. 重新填写本机 `project.private.config.json`；
3. 在云函数后台重新配置 API Key 等环境变量；
4. 在 `cloudfunctions\api` 中安装依赖；
5. 重新部署 `api` 云函数；
6. 双击 `scripts\install-git-hooks.cmd` 安装 hooks；
7. 使用同步脚本完成首次提交。

### 常见故障

- `git push` 要求登录：按 Git Credential Manager 提示完成 GitHub 网页登录；
- 提示远端有新提交：先运行 `git pull --rebase --autostash origin main`；
- 提示冲突：不要强制覆盖，先处理冲突再运行同步脚本；
- 同步脚本失败：查看项目外的当天同步日志；
- 云函数密钥不会保存在 GitHub，换电脑后必须在云开发后台重新配置。
