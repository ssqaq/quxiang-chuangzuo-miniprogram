# 控制台四页像素差异报告

- 总状态：**PASS**
- 阈值：32（单通道最大差）
- 最大差异比例：50.000%
- 热点 tile：32x32，视口：390x844
- 基线清单：`visual-evidence/admin-v2-pixel-manifest.json`

| 页面 | 状态 | 差异像素 | 差异比例 | 最大通道差 | 差异包围盒 | 热点 tile | 热图 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| dashboard | PASS | 45069/329160 | 13.692% | 255 | (0,0) - (389,843)，390x844 | tile(4,0) 1024px/100.0% | `visual-evidence/pixel-diffs/dashboard.png` |
| operations | PASS | 41630/329160 | 12.647% | 255 | (0,0) - (389,843)，390x844 | tile(4,0) 1024px/100.0% | `visual-evidence/pixel-diffs/operations.png` |
| config | PASS | 39566/329160 | 12.020% | 255 | (0,0) - (387,841)，388x842 | tile(1,16) 655px/64.0% | `visual-evidence/pixel-diffs/config.png` |
| provider | PASS | 49001/329160 | 14.887% | 255 | (0,0) - (387,841)，388x842 | tile(10,16) 924px/90.2% | `visual-evidence/pixel-diffs/provider.png` |

生成时间：2026-09-01T03:22:35.653Z
