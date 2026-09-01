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

- [ ] 跑三项 smoke、四页像素回归、完整 `validate.js` 和发布 gate smoke。
- [ ] 按发布脚本规则分配下一 patch 版本，正式生成非空 ZIP、SHA256 和报告。
- [ ] 核对 GitHub/CloudBase/开发者工具回执，并在交付中给出版本、产物路径和打包状态。
