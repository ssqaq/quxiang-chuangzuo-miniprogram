# 控制台四页像素差异报告

- 总状态：**FAIL**
- 阈值：0（单通道最大差）
- 比较模式：严格零差（threshold=0、maxDiffRatio=0、尺寸完全一致）
- 最大差异比例：0.000%
- 热点 tile：32x32，视口：390x844
- fixture：`admin-v2-reference-20260901-v1`，状态：`collapsed-default-v1`
- 截图来源：`unknown`，证据摘要：`8098b31a104617d931ea971d8e66d9905b041b9a46eaf3c37708a7e403ce85b1`
- 字体 profile：`Microsoft YaHei > PingFang SC > SimHei > system-ui > sans-serif`
- 基线清单：`visual-evidence/admin-v2-pixel-manifest.json`

| 页面 | 状态 | 差异像素 | 差异比例 | 最大通道差 | 差异包围盒 | 热点 tile | 热图 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| dashboard | FAIL | 278263/329160 | 84.537% | 255 | (0,0) - (389,843)，390x844 | tile(4,0) 1024px/100.0% | `visual-evidence/pixel-diffs/dashboard.png` |
| operations | FAIL | 292667/329160 | 88.913% | 255 | (0,0) - (389,843)，390x844 | tile(4,0) 1024px/100.0% | `visual-evidence/pixel-diffs/operations.png` |
| config | FAIL | 66761/329160 | 20.282% | 255 | (0,0) - (389,841)，390x842 | tile(1,20) 716px/69.9% | `visual-evidence/pixel-diffs/config.png` |
| provider | FAIL | 106826/329160 | 32.454% | 255 | (0,0) - (389,841)，390x842 | tile(10,16) 1024px/100.0% | `visual-evidence/pixel-diffs/provider.png` |

生成时间：2026-09-01T21:51:38.588Z
