# 四页后台发布回归设计

## 目标

为控制台、模型用量统计预览、功能配置、供应商管理四个页面补齐可重复的发布保障：依赖先安装再校验、视觉像素回归、最终预览二维码，以及本地演示数据开关。线上默认继续读取真实数据，演示数据不能进入云端接口或密钥读取流程。

## 约束

- 保留四页现有布局、文案、字体和导航尺寸；像素回归只负责发现偏差，不在运行时改布局。
- 演示数据只接受页面 query `demo=1`/`demo=true`/`demo=0`/`demo=false`，并允许本地配置显式打开；query 优先级高于本地配置。页面顶栏默认不显示演示控件，只有 `demoControl=1` 或本地调试配置显式打开时才显示，避免污染右侧定稿视觉。
- 演示 fixture 不包含真实 API Key，不调用云函数，不写入缓存或数据库。
- 发布脚本在 `validate.js` 和严格部署检查前安装并检查云函数依赖；安装失败立即停止发布。
- 像素工具同时支持 PNG/JPEG，输出差异统计和可视化 heatmap；尺寸不同先做确定性的最近邻归一化，并在报告中标记缩放。

## 方案

1. 新增 `services/admin-preview-fixtures.js`，集中保存四页的脱敏演示配置、统计数据和供应商目录，并提供 query/config 解析函数。
2. 四个页面在 `onLoad(options)` 记录演示模式；开启时直接使用 fixture，刷新也保持本地 fixture，保存、导出、部署检查等写操作仍按本地预览规则阻止或提示。
3. 调整 `scripts/deploy-and-verify-api.ps1` 的第 2 步顺序，并在 `scripts/deployment-script-smoke.js` 中断言顺序不可回退。
4. 新增 `scripts/admin-v2-pixel-regression.js` 和对应 smoke。命令接收实际截图、参考图、阈值、最大差异比例和 heatmap 输出路径；四页基线清单由 `visual-evidence/admin-v2-pixel-manifest.json` 管理，实际截图与参考图均固定为 `390 x 844` 证据，不携带密钥。
5. 发布流程使用同一 release context 生成二维码和预览信息文件，报告中记录二维码绝对路径、版本、源码提交和四页像素检查结果。
6. 新增同设备基线 manifest，锁定微信开发者工具模拟器、`390 x 844` viewport、截图命令及四页图片 SHA256；发布和 CI 共用同一份合同。
7. 新增预览源码预算，按 `project.config.json` 的 `packOptions` 统计裸源码，并按逐文件 gzip 加路径开销估算传输体积；`2 MiB` 为硬上限、`1.8 MiB` 为预警线，在二维码生成前失败。
8. 新增四页 JSON/Markdown 差异报告和热图，逐页输出差异比例、包围盒与热点 tile；报告仅保存项目内相对路径，不读取运行时凭证。
9. 视觉验收合同固定为 fixture `admin-v2-reference-20260901-v1`、状态 `collapsed-default-v1`、视口 `390 x 844`，字体 profile 固定为 `Microsoft YaHei > PingFang SC > SimHei > system-ui > sans-serif`。
10. 布局合同和字体合同各自输出 JSON 与源码 SHA256；四页截图、manifest、差异报告和合同报告按版本不可覆盖地归档，文本证据命中凭证字段时拒绝归档。
11. 浏览器参考图必须由逐页新建的活动标签在 390x844 视口下采集；桌面外壳截图只作诊断证据，不能进入同设备基线。
12. 运行时几何探针读取浏览器 evaluate 的真实矩形和滚动宽度，字体探针读取 computed font-family；两者分别失败，不用截图像素差异替代。
13. 视觉归档默认只保留最近 5 个 `v<version>` 目录，清理范围限定在归档根目录，归档内容不可覆盖且文本证据继续拒绝凭证字段。
14. 发布成功后自动调用视觉检查入口；自动化截图不可用时只有显式 `--allow-existing` 才能复用既有截图，并在回执标明 `reused-existing` 或 `capture-failed-reused-existing`。

## 验收

- `node scripts/validate.js` 通过，且部署脚本 smoke 明确验证依赖安装先于所有本地校验。
- 四页 fixture 模式可在本地运行，页面不触发 `getAdminConfigV2`、密钥读取、统计读取或写接口。
- 像素工具对相同图片返回 0 差异，对人工改动返回非零差异并生成 heatmap；四页基线命令在 GitHub release-gate 中执行，缺少基线文件或超过阈值直接失败。
- 二维码发布门禁必须实际解码 payload，不能只检查文件存在或 SHA；`scripts/qr-decode-smoke.js` 覆盖有效、空文件、非法图片和空白图。
- 同设备基线必须校验四页顺序、图片尺寸和 SHA256；预览传输估算超过 `2 MiB` 必须阻止发布，裸源码超过 `2 MiB` 只触发明确警告。
- 四页差异报告必须同时生成 JSON、Markdown 和 heatmap，并沿用像素回归相同阈值与通过判定。
- 正式版本升级、ZIP 非空、GitHub PR 合并、CloudBase Active、开发者工具导入编译通过，二维码和报告可追溯。
- 浏览器参考 manifest 的四页视口均为 `390x844`，运行时几何/字体探针均 PASS；归档保留策略只删除超出数量的旧版本；发布后视觉回执和归档 manifest 可追溯到同一版本。
