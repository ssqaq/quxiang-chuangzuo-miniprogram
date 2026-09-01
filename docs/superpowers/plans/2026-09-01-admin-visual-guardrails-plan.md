# Admin Visual Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为控制台四页增加可重复的同设备视觉基线、预览源码体积预算和四页差异报告，并把三项检查接入本地校验与发布闸门。

**Architecture:** 继续复用现有 `admin-v2-pixel-regression.js` 的图片解码和像素比较；新增轻量报告层输出 JSON/Markdown，不改变页面运行时。源码预算工具按 `project.config.json` 的 `packOptions` 计算实际预览文件，发布前和 CI 共用同一 Node CLI。同设备基线以 viewport、renderer、capture source 和文件 SHA 形成 manifest，截图更新与回归比较分开。

**Tech Stack:** Node.js 20、PNG/JPEG 编解码（现有 `pngjs`/`jpeg-js`）、PowerShell 发布脚本、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-01-admin-release-regression-design.md`

## Global Constraints

- 四页固定为 `dashboard`、`operations`、`config`、`provider`，验收 viewport 为 `390 x 844`。
- 预览源码预算按逐文件 gzip 加路径开销估算传输体积，硬上限为 `2 MiB`（`2,097,152` bytes），预警线为 `1.8 MiB`（`1,887,436` bytes）；同时回报裸源码字节，任何传输估算超限都必须在二维码生成前失败。
- 视觉报告不读取或输出 API Key、凭证或其他敏感字段。
- 保留现有 `packOptions.ignore` 规则和发布 IncludePath 白名单，不做全量发布。

### Task 1: 同设备基线

**Files:**
- Create/modify: `scripts/admin-v2-same-device-baseline.js`
- Create/modify: `scripts/admin-v2-same-device-baseline-smoke.js`
- Modify: `visual-evidence/admin-v2-same-device-manifest.json`
- Modify: `scripts/validate.js`, `scripts/release.ps1`, `.github/workflows/release-gate.yml`

- [x] 记录 renderer、viewport、capture command、四页 actual/reference 路径和 SHA256。
- [x] 校验 manifest 完整性、尺寸一致性和文件存在性；输出可机器读取 JSON。
- [x] smoke 覆盖缺页、尺寸不符和正常四页 manifest。

### Task 2: 预览源码大小预算

**Files:**
- Create: `scripts/preview-source-budget.js`
- Create: `scripts/preview-source-budget-smoke.js`
- Modify: `scripts/release.ps1`, `scripts/release-gate.ps1`, `scripts/release-gate-smoke.js`, `.github/workflows/release-gate.yml`, `scripts/validate.js`

- [x] 按 `packOptions.ignore/include` 枚举源码并统计裸字节、压缩传输估算、文件数和最大文件。
- [x] CLI 超限返回非零并可写 JSON 报告；忽略规则和隐式 `node_modules/.git` 覆盖 smoke。
- [x] 发布工作树在打包/二维码前执行预算检查。

### Task 3: 四页差异报告

**Files:**
- Create: `scripts/admin-v2-pixel-diff-report.js`
- Create: `scripts/admin-v2-pixel-diff-report-smoke.js`
- Modify: `scripts/validate.js`, `scripts/release.ps1`, `.github/workflows/release-gate.yml`

- [x] 对 manifest 四页生成 JSON 和 Markdown，包含差异像素、比例、最大通道差、差异包围盒和热点 tile。
- [x] 复用现有比较逻辑并保留 heatmap；报告不得泄露凭证。
- [x] smoke 覆盖零差异、局部差异和 CLI 输出。

### Task 4: 回归与发布

- [x] 跑新增合同 smoke、四页像素回归、完整 `validate.js` 和发布 gate smoke。
- [x] 按发布脚本规则分配下一 patch 版本，正式生成非空 ZIP、SHA256 和报告。
- [x] 核对 GitHub/CloudBase/开发者工具回执，并在交付中给出版本、产物路径和打包状态。

### Task 5: 固定演示 fixture

- [x] 增加 `admin-v2-reference-20260901-v1` 固定 fixture ID，四页跳转和截图命令统一传递。
- [x] fixture 数据和统计数据返回 ID，未知 ID 回退到唯一已审核 fixture，演示数据继续禁止云端调用和凭证输出。

### Task 6: 布局与字体合同

- [x] 用 `scripts/admin-v2-layout-contract.js` 固定四页关键选择器、宽度、高度、字号、居中和横向边界。
- [x] 用 `scripts/admin-v2-font-contract.js` 固定 `Microsoft YaHei > PingFang SC > SimHei > system-ui` 字体 profile，并记录源码 SHA256。
- [x] 两项合同均生成 JSON 报告并接入 validate 和 GitHub release gate。

### Task 7: 视觉证据归档

- [x] 用 `scripts/admin-v2-visual-archive.js` 归档四页截图、manifest、差异报告、布局合同、字体合同和源码预算。
- [x] 归档写入版本、fixture、viewport、文件大小和 SHA256；目标内容不一致时拒绝覆盖，文本证据拒绝凭证字段。

### Task 8: 同渲染器浏览器参考图

- [x] 逐页新建活动浏览器标签，锁定 390x844 后再截图，避免把桌面外壳 1280x720 当作手机参考。
- [x] 生成 `visual-evidence/admin-v2-browser-reference-manifest.json`，记录 fixture、DPR、URL、字节数和 SHA256。

### Task 9: 运行时几何与字体探针

- [x] 用浏览器 `evaluate` 采集四页真实内容框、横向滚动宽度和字体样本。
- [x] 新增 `admin-v2-runtime-geometry-probe.js`、`admin-v2-runtime-font-probe.js` 及 smoke，分别验证 390x844 边界和实际 computed font-family。

### Task 10: 归档保留策略

- [x] 归档默认保留最近 5 个版本，只清理 `visual-evidence/archive/v*` 子目录，越界目标直接拒绝。
- [x] smoke 覆盖旧版本清理、保留列表和非法保留数量。

### Task 11: 发布后自动视觉检查

- [x] 新增 `admin-v2-post-release-visual-check.js`，串联截图、布局合同、字体合同、像素报告和归档。
- [x] 发布队列成功后自动写入检查摘要；没有自动化截图环境时可明确复用既有截图并记录状态。

### Task 12: 严格真实截图 CI

- [x] 微信开发者工具截图记录路由、状态、窗口尺寸、PNG 尺寸、字节数和 SHA256。
- [x] 增加 Windows self-hosted workflow；严格模式失败时不允许复用旧图。

### Task 13: 四状态基线

- [x] 固定默认、展开、备用关闭、视频模式四个状态；`visualState` 只在演示 fixture 生效。
- [x] 备用关闭继续使用 `not-ready` 并保留供应商和模型，符合真实 V2 schema。

### Task 14: 三设备矩阵

- [x] 固定 375x812、390x844、430x932 三档设备和四页顺序。
- [x] 逐图校验尺寸、DPR、横向滚动宽度和 SHA256。

### Task 15: 归档索引

- [x] 重新校验每个历史归档的字节数和 SHA256 后生成 `index.json`、`index.html`。
- [x] 发布后归档完成自动刷新索引，索引不改写不可变版本目录。
