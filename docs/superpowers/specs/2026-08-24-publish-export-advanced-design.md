# 小程序高级图片导出设计

## 目标

在保留现有导出页流程的基础上，补齐桌面版高级参数和处理链：

- 小图优先在手机本地处理；
- 4096px、超过本地能力或本地失败时，先征得用户同意再走云端；
- 本地和云端使用同一套纯 JavaScript 像素处理规则；
- 原图永远不覆盖，结果生成新文件并保存到相册；
- 不承诺删除不可见 provenance，也不把功能命名成“绕过检测”。

当前真实版本由外部同步推进到 `0.32.0`，本次功能按语义化版本升到 `0.33.0`。实现前后均保留工作区已有的外部改动。

## 页面方案

导出页保留：

- 最新一张 / 全部记录；
- 相册导入；
- JPG / PNG；
- 1536px / 2048px / 4096px；
- JPG 品质、处理进度和相册保存。

增加默认展开的三组参数：

### 画面处理

- 基础色彩校正：默认开；
- 轻度降噪：默认关；
- 清晰补偿：默认开。

### 相机质感

- 固定相机颗粒：默认开；
- 颗粒强度：1-5，默认 3。

### 高级画面处理

- 频域扰动：默认开，强度 1-5，默认 3；
- 反向重采样：默认开；
- 可见标记淡化：默认关，强度 1-5，默认 1。

“可见标记淡化”文案必须说明：仅尝试淡化可见标记，不保证移除不可见溯源信息或 AI 来源标识，可能影响局部细节。

## 共享处理核心

处理顺序固定为：

```text
缩放/方向处理
→ 色彩校正
→ 降噪
→ 清晰补偿
→ 相机颗粒
→ 可见标记淡化
→ 频域扰动
→ 反向重采样
→ JPG/PNG 编码
```

核心保持平台无关：

- 固定种子伪随机颗粒，RGB 同步变化；
- Sobel 梯度只处理小范围高对比区域；
- FFT 只对最长边不超过 1024px 的亮度代理图做轻微幅度扰动，保持相位、共轭对称和 alpha；
- 所有 RGB 结果钳位到 `0-255`；
- 处理前后尺寸一致，透明度不变。

小程序端使用 Canvas/ImageData；Worker 可用时优先 Worker，不可用时回退主线程。云函数端使用同一核心和 Node 编解码器。

## 本地和云端阈值

- Worker 最长边不超过 2048px；
- 主线程最长边不超过 1536px；
- 本地解码后的总像素不超过 4,194,304；
- 选择 4096px 时不在普通手机上做全尺寸高级处理，直接提示云端；
- 低端设备出现 OOM 时，只降低阈值，不改变算法。

## 云端接口

客户端调用 `publishExport` 时传入：

```js
{
  action: "publishExport",
  recordId: "...",
  fileID: "cloud://...",
  options: {
    format: "jpg",
    quality: 88,
    maxLongEdge: 4096,
    colorOptimize: true,
    gentleSoften: false,
    gentleSharpen: true,
    cameraNoise: true,
    cameraNoiseStrength: 3,
    frequencyPerturb: true,
    frequencyStrength: 3,
    removeVisibleMarks: false,
    watermarkStrength: 1,
    resamplePerturb: true
  }
}
```

安全规则：

1. 有 `recordId` 时，按当前 openid 读取 `generation_records`，只使用记录自己的 fileID；
2. 只有 fileID 时，必须通过 `user_assets` 或 `generation_records` 的当前用户归属校验；
3. 不信任客户端传入的 cloudPath；
4. 幂等键使用 `ownerHash|inputHash|optionsHash`；
5. 任务状态为 `processing/done/failed`，processing 超过 90 秒才允许重试；
6. 输入、输出临时文件统一在 `try/finally` 中清理；
7. 输出结果保留短期，定期清理长期残留。

Node 端使用 `jpeg-js + pngjs`，JPEG 上限 4096px，PNG 上限 2048px。目标峰值内存不超过 512MiB，目标执行时间不超过 60 秒；smoke 不达标时降低云端尺寸阈值。

## 错误处理

- 本地处理成功：直接保存相册；
- 4096px、本地能力不足、本地异常：弹窗询问是否云端处理；
- 用户取消：不上传，保留原图；
- 云端失败：不覆盖原图，提示原因；
- 批量导出：单张失败不影响已成功保存的图片；
- 相册权限失败：提示用户去设置开启。

## 验证

测试覆盖：

- 默认值和 1-5 边界；
- FFT 尺寸、alpha、RGB 钳位和亮度变化；
- JPG/PNG 编码；
- Worker 和主线程回退；
- 4096px 强制云端；
- 本地失败后的确认弹窗；
- fileID 归属和幂等锁；
- 云端成功后的相册保存和临时文件清理；
- 原图不覆盖。

