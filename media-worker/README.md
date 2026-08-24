# Apple Live Photo 媒体 worker

该服务把标准 JPEG 和 MP4 生成为真实 `.livp`：

1. FFmpeg 将 MP4 转为 H.264/AAC MOV，并写入 Apple ContentIdentifier；
2. JPEG 写入相同的 Apple MakerNote ContentIdentifier；
3. MOV 追加 `mebx` 数据轨和 `com.apple.quicktime.still-image-time`；
4. JPEG、MOV 以 Store 模式写入 ZIP；
5. ZIP comment 写入动态 `1000LIVP` 成员偏移描述。

## 环境变量

- `APPLE_LIVE_PHOTO_WORKER_TOKEN`：必填，云函数调用令牌。
- `PORT`：默认 `8080`。
- `FFMPEG_PATH`：默认 `ffmpeg`。
- `APPLE_LIVE_PHOTO_REQUEST_TIMEOUT_MS`：默认 `180000`。

只有本地调试时才允许设置 `ALLOW_INSECURE_WORKER=1` 跳过令牌检查。

## 接口

`POST /v1/apple-live-photo`

```json
{
  "imageUrl": "https://...",
  "videoUrl": "https://...",
  "contentIdentifier": "可选 UUID",
  "baseName": "可选文件名"
}
```

成功时直接返回 `.livp` 二进制，并在响应头返回配对编号、三份 SHA-256
和结构校验状态。
