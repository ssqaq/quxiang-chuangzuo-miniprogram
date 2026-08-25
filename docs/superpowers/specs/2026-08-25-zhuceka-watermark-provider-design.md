# 注册卡媒体解析 Provider 接入设计

日期：2026-08-25

## 已确认范围

- 复用独立云函数 `watermark-gateway`，不把第三方接口塞进主 `api` 云函数。
- 接入 `https://api.zhuceka.cn/home/api?type=dsp`。
- 第三方账号只用于登录核对；运行时只需要 UID 和 Key。
- UID、Key 仅放 CloudBase 云函数环境变量，不进入小程序前端、Git、日志或发布包。
- 首期真实返回支持视频和单张图片：优先使用 `data.video`，没有视频时取 `data.images[0]`。
- 图集只展示第一张；`live_photo` 暂不支持并返回明确错误。
- Mock 只允许通过 `WATERMARK_PROVIDER=mock` 显式开启。真实接口失败时不得自动回退 Mock。

## 数据流

1. 小程序把分享文本提交给 `watermark-gateway`。
2. 网关提取第一个 HTTP/HTTPS 分享链接，拒绝本地、内网和带账号密码的链接。
3. 网关从环境变量读取 UID/Key，调用固定的注册卡 API。
4. 网关把服务商响应归一化为视频或单图结果，且不返回原始响应和密钥。
5. 小程序按真实类型预览并调用微信相册保存接口。

## 错误处理

- 未配置 UID/Key：`PROVIDER_NOT_CONFIGURED`
- 链接无效：`INVALID_URL`
- 第三方超时：`PROVIDER_TIMEOUT`
- 余额或次数不足：`QUOTA_EXCEEDED`
- 请求频繁：`RATE_LIMITED`
- 只有实况内容：`CONTENT_TYPE_NOT_SUPPORTED`
- 服务商没有返回媒体：`PROVIDER_FAILED`

## 测试闸门

- Mock 视频和图片。
- 未配置密钥。
- 视频映射、图片数组第一张映射。
- 服务商失败、额度不足、空媒体、实况和超时。
- 页面真实结果不显示“演示数据”。
- 云函数调用失败不得生成本地演示结果。
- 测试和返回对象中不得出现真实密钥。

## 已知限制

首期直接返回服务商媒体 URL。若真机因动态 CDN 域名不在微信合法域名列表导致预览或保存失败，再增加“云函数下载并转存 CloudBase”的第二阶段能力；本轮不把网关做成任意 URL 下载代理。
