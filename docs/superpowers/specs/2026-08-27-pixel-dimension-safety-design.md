# 阶段 A：像素保护尺寸安全门设计

## 目标

修复像素保护流程对任意尺寸不一致结果直接执行
`stretch-to-baseline` 的问题。只有近似等比、缩放比例和资源尺寸都在安全范围内
时，才允许把模型结果确定性缩放回基准图尺寸。

本阶段不改变模型调用流程，也不实施腾讯 `post margin` 或低差异恢复。

## 固定边界

- 不修改 `utils/mask.js`。
- 不修改 provider、failover、凌云参数、腾讯参数或调用顺序。
- 普通版仍使用真实椭圆后处理；腾讯前置仍使用原图坐标矩形。
- 腾讯最终结果仍要求尺寸完全一致，禁止缩放。
- 原图和 mask 不缩放，只允许缩放模型生成图。
- 不裁切、不补边、不旋转、不做内容配准。
- 不使用 JPEG 降级，最终继续使用无损 PNG。

## 尺寸安全规则

尺寸相同则直接使用模型结果，不缩放。

尺寸不同时定义：

```text
scaleW = sourceWidth / targetWidth
scaleH = sourceHeight / targetHeight
anisotropy = abs(scaleW - scaleH) / max(scaleW, scaleH)
```

第一版使用闭区间：

```text
anisotropy <= 0.003
0.75 <= scaleW <= 1.50
0.75 <= scaleH <= 1.50
```

源图、模型结果、目标图都必须满足：

```text
width * height <= 4,194,304
width <= 8192
height <= 8192
```

以上检查必须在创建缩放输出 Buffer 前完成。

## 缩放与坐标

- 继续使用现有确定性 RGBA 双线性插值。
- 只把模型结果缩放到基准图尺寸。
- 缩放后必须再次确认宽高完全一致。
- 不重新做人脸检测。
- 腾讯前置矩形继续使用原图坐标。
- 不增加模糊的“人脸矩形明显漂移”判断。

## 验收和失败

缩放后重新执行：

```text
合成
→ PNG 编码
→ PNG 重新解码
→ support 外 exact mismatch 验收
→ 统计变化率
```

尺寸安全失败时：

```text
普通版：禁止上传结果
腾讯版：禁止进入 FuseFaceUltra
两者：进入现有失败和退款链
```

错误码使用：

```text
PIXEL_IMAGE_ASPECT_MISMATCH
PIXEL_IMAGE_SCALE_OUT_OF_RANGE
PIXEL_IMAGE_RESIZE_FAILED
```

继续保留 `PIXEL_IMAGE_SIZE_MISMATCH` 作为兼容兜底，并把新增错误码加入上层错误保留列表，
避免被重新映射成通用错误。

## 测试

必须保留以下通过和失败样本：

- 通过：尺寸完全一致。
- 通过：`896×1195 -> 1085×1450`，`anisotropy` 约 `0.2023%`。
- 失败：`896×1195 -> 1024×1536`，`anisotropy` 约 `11.0863%`。
- 失败：缩放比例低于 `0.75` 或高于 `1.50`。
- 失败：超过 4M 像素或单边超过 8192。
- 失败：缩放失败、RGBA 数据长度错误。
- 失败：腾讯最终结果尺寸不一致。
- 通过：PNG 编码后重新解码，保护区和 support 外验收仍满足硬保证。
- 退款：新增错误码被保留，任务进入失败/退款中，不误报成功、不漏退款。

普通版真实 `maskGeometry` 端到端测试和腾讯最终两次真实输出测试属于后续验证阶段；
本阶段不提前实施腾讯 `post margin`。
