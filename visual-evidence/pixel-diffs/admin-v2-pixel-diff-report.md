# 控制台四页像素差异报告

- 总状态：**PASS**
- 阈值：32（单通道最大差）
- 最大差异比例：8.000%
- 热点 tile：32x32，视口：390x844
- fixture：`admin-v2-reference-20260901-v1`，状态：`collapsed-default-v1`
- 截图来源：`captured`，证据摘要：`f6e336924713c8239583544413480f04cfb90f69e68afc596193758ca8c279ed`
- 字体 profile：`admin-reference-font-v1`
- 基线清单：`visual-evidence/admin-v2-pixel-manifest-current.json`

| 页面 | 状态 | 差异像素 | 差异比例 | 最大通道差 | 差异包围盒 | 热点 tile | 热图 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| dashboard | PASS | 36/325920 | 0.011% | 255 | (27,18) - (32,26)，6x9 | tile(0,0) 30px/2.9% | `visual-evidence/pixel-diffs/dashboard.png` |
| operations | PASS | 36/325920 | 0.011% | 255 | (27,18) - (32,26)，6x9 | tile(0,0) 30px/2.9% | `visual-evidence/pixel-diffs/operations.png` |
| config | PASS | 36/325920 | 0.011% | 255 | (27,18) - (32,26)，6x9 | tile(0,0) 30px/2.9% | `visual-evidence/pixel-diffs/config.png` |
| provider | PASS | 36/325920 | 0.011% | 255 | (27,18) - (32,26)，6x9 | tile(0,0) 30px/2.9% | `visual-evidence/pixel-diffs/provider.png` |

生成时间：2026-09-05T01:43:22.827Z
