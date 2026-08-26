# 普通版与腾讯版像素保护设计

## 目标

在不更换模型、不改变供应商调用顺序、不修改现有供应商 mask 导出的前提下，通过本地确定性像素合成，把非目标区域的像素改动降到可硬验收的 0%。

## 不可变模型流程

### 普通版

```text
主图 + 现有供应商 mask + 参考素材
→ 凌云 gpt-image-2 /v1/images/edits
→ 本地真实椭圆合成
→ 无损 PNG
```

- 全部生成能力仍由凌云提供。
- 腾讯调用次数必须为 0。
- 第一版不修改 `utils/mask.js`，供应商请求行为保持不变。
- 本地合成只约束最终交付像素，不参与或改变模型推理。

### 腾讯版

```text
主图 + 参考脸
→ 现有人脸检测
→ 凌云 gpt-image-2 /v1/images/edits
→ 本地人脸矩形保护
→ 腾讯 FuseFaceUltra
→ 腾讯后本地确定性合成
→ 无损 PNG
```

- 必须先凌云、后腾讯。
- 不更换 provider、model、endpoint 或调用顺序。
- 腾讯重试只能复用已验收的凌云中间图，禁止再次调用凌云。
- 本地图片处理不是新增模型。

## 统一像素语义

内部 `editAlpha` 固定为：

```text
0     = 使用保护基准图
255   = 使用模型图
1~254 = feather 混合
```

`AI_MASK_INVERT` 只作用于发送给供应商的请求 mask，禁止进入本地合成。

## 图片编解码

- 支持 JPEG 和 PNG。
- JPEG 解码后必须应用 EXIF Orientation，再进入尺寸校验和合成。
- WebP 在扣费和模型调用前 fail-closed。
- 第一版要求保护基准图和模型结果宽高完全一致；禁止缩放、裁切或配准。
- 输出统一为无损 PNG。
- 验收对象必须是 `PNG encode → PNG decode` 后的 `deliveredRGBA`，不能只验收内存中的编码前像素。
- 可调整 PNG 无损压缩等级；腾讯模板图仍超过大小限制时 fail-closed，禁止降级为 JPEG。

## 普通版合成

- 根据 `payload.maskGeometry` 重建真实椭圆。
- 椭圆外逐像素复制原图。
- 椭圆核心使用凌云结果。
- feather 只放在椭圆内部，边界外不得出现半透明 support。
- 普通版最终 PNG 的椭圆外 exact mismatch 必须为 0。

## 腾讯版前置合成

- 继续使用现有扩大 22% 的人脸保护矩形。
- 矩形核心内逐像素复制原图。
- 矩形外使用凌云结果。
- 为避免接缝，feather 位于矩形外侧；因此前置验收的硬保护区是矩形核心，不把外侧 feather 计入硬保护区。
- 已验收中间图及其矩形、像素指标必须写入 operation，供腾讯重试复用。

## 腾讯版后置合成

- 保护基准图是已验收的凌云中间图，不是原始主图。
- 人脸矩形核心使用腾讯结果。
- 矩形外逐像素复制已验收中间图。
- feather 只放在人脸矩形内部。
- 最终图相对中间图的人脸矩形外 exact mismatch 必须为 0。

## 运行时模型硬闸门

凌云调用前统一标准化并断言：

- provider 是 `lingyun` 或 `凌云`；
- model 精确为 `gpt-image-2`；
- endpoint pathname 精确为 `/v1/images/edits`。

腾讯调用前断言：

- action 精确为 `FuseFaceUltra`；
- model 精确为 `FuseFaceUltra`；
- endpoint host 精确为 `facefusion.tencentcloudapi.com`。

任一条件不匹配立即 fail-closed，不自动切换或降级。

## 预检和计费

### 普通版

扣费前完成：

1. 下载并解码主图；
2. 确认主图不是 WebP；
3. 下载并验证 mask 为 PNG；
4. 验证 mask 与主图尺寸一致；
5. 验证 `maskGeometry` 合法且能形成非空椭圆。

通过后才调用 `reserveUsage()`。预加载的主图和 mask Buffer 直接复用于凌云请求，避免重复下载。

### 腾讯版

首次执行在扣费前下载并预检主图和参考脸，确认格式可解码且不是 WebP。人脸检测、凌云和腾讯仍在成功扣费后按原顺序执行。

腾讯重试必须从 operation 恢复：

- `intermediateFileID`；
- `faceProtectionRects`；
- `pixelProtectionMetrics`；
- 原图逻辑尺寸。

旧任务若缺少上述保护元数据，必须 fail-closed，不能猜测矩形。

## 验收指标

### 通用

- exact mismatch：任一 RGBA 通道不同即算该像素变化。
- changedRatioT5：RGBA 通道最大绝对差值大于 5 才算该像素发生可感知变化。
- support：`editAlpha > 0` 的全部像素。
- support 外 exact mismatch 必须为 0，不设固定 `+2%` 容差。

### 普通版

- 椭圆 support 外 exact mismatch = 0。
- `wholeChangedRatioT5 ≤ ellipseSupportCoverage`。

### 腾讯版中间图

- 人脸硬保护矩形核心内 exact mismatch = 0。
- 实际 edit support 外 exact mismatch = 0。
- 记录中间图相对原图的整图变化率。

### 腾讯版最终图

- 相对已验收中间图，人脸矩形外 exact mismatch = 0。
- 腾讯新增 `changedRatioT5 ≤ faceRectCoverage`。
- 分别记录：
  1. 凌云中间图相对原图；
  2. 腾讯最终图相对中间图；
  3. 腾讯最终图相对原图。

## 失败与退款

- 主图、参考脸、mask 解码失败：不调用模型。
- WebP：不调用模型。
- `maskGeometry` 非法：不调用模型。
- 生成结果解码失败或尺寸不一致：不调用下一供应商，并退款。
- 合成、PNG 编码、重解码或验收失败：不调用下一供应商，并退款。
- 腾讯模板 PNG 超限：不调用腾讯，并退款。
- 腾讯调用失败：保留已验收中间图，重试仅复用该中间图。

## 验证范围

- JPEG、PNG、WebP 拒绝和 EXIF Orientation。
- 椭圆、矩形、贴边和重叠矩形。
- 普通版 feather 位于椭圆内部。
- 腾讯前置 feather 位于矩形外侧。
- 腾讯后置 feather 位于矩形内侧。
- support 外改动 1 个像素必须失败。
- 尺寸不一致必须失败。
- 普通版腾讯调用次数为 0。
- 腾讯版必须先凌云后腾讯。
- 腾讯重试不得再次调用凌云。
- provider、model、endpoint/action 任一串线必须失败。

## 回滚

像素保护路径失败时不静默回退到原先不安全的直传路径。代码回滚使用上一正式版本；生产运行时只允许 fail-closed。
