# Admin Visual Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为四页后台建立真实微信开发者工具截图、四状态、三设备和可浏览归档索引的完整发布证据链。

**Architecture:** 截图驱动、矩阵合同、归档索引保持为独立 Node CLI；发布后入口只负责串联，不重复实现校验。真实截图 CI 运行在带微信开发者工具的 Windows self-hosted runner，普通 CI 继续执行无 GUI 的静态和 smoke 检查。

**Tech Stack:** Node.js 20、miniprogram-automator、微信开发者工具 CLI、PNG、PowerShell、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-09-01-admin-visual-matrix-design.md`

## Global Constraints

- 页面：`dashboard`、`operations`、`config`、`provider`。
- 状态：`collapsed-default-v1`、`expanded-v1`、`backup-disabled-v1`、`video-mode-v1`。
- 设备：`375 x 812`、`390 x 844`、`430 x 932`。
- fixture：`admin-v2-reference-20260901-v1`。
- 严格截图失败时不得复用旧图。

---

### Task 1: 严格真实截图门禁

**Files:**
- Modify: `scripts/admin-v2-visual-capture.js`
- Create: `scripts/admin-v2-visual-capture-gate.js`
- Create: `scripts/admin-v2-visual-capture-gate-smoke.js`
- Create: `.github/workflows/admin-visual-capture.yml`

**Interfaces:**
- Consumes: 微信开发者工具 CLI、`miniprogram-automator`、fixture ID。
- Produces: `capture-manifest.json` 与通过 SHA256/尺寸校验的 PNG。

- [ ] 用依赖注入 smoke 固定缺 CLI、错尺寸、缺页面和成功四页用例。
- [ ] 扩展截图脚本输出来源、viewport、状态、设备和 SHA256。
- [ ] 增加 Windows self-hosted 工作流并上传视觉证据。
- [ ] 运行两个 smoke 和一次本机严格截图。

### Task 2: 四状态基线

**Files:**
- Create: `scripts/admin-v2-state-matrix.js`
- Create: `scripts/admin-v2-state-matrix-smoke.js`
- Modify: `pages/admin-config/admin-config.js`
- Modify: `services/admin-preview-fixtures.js`

**Interfaces:**
- Consumes: `visualState` query，仅在 demo fixture 模式生效。
- Produces: `visual-evidence/admin-v2-state-matrix.json`。

- [ ] 先写未知状态、缺状态证据和合法四状态 smoke。
- [ ] 实现四状态常量、query 合同和 manifest 校验。
- [ ] 在演示页面加载时应用固定状态，不修改真实配置。
- [ ] 采集并校验四状态截图。

### Task 3: 三设备矩阵

**Files:**
- Create: `scripts/admin-v2-device-matrix.js`
- Create: `scripts/admin-v2-device-matrix-smoke.js`
- Create: `visual-evidence/admin-v2-device-matrix.json`

**Interfaces:**
- Consumes: 三档设备的四页截图和运行时几何。
- Produces: 设备、页面、尺寸、溢出、SHA256 的矩阵报告。

- [ ] 先写缺设备、错尺寸、横向溢出和成功矩阵 smoke。
- [ ] 实现 manifest 校验和 CLI 报告。
- [ ] 采集三档四页截图与几何数据。
- [ ] 运行设备矩阵并确认十二张图全部通过。

### Task 4: 归档索引

**Files:**
- Create: `scripts/admin-v2-visual-index.js`
- Create: `scripts/admin-v2-visual-index-smoke.js`
- Modify: `scripts/admin-v2-post-release-visual-check.js`
- Modify: `scripts/admin-v2-visual-archive.js`

**Interfaces:**
- Consumes: `visual-evidence/archive/v*/archive-manifest.json`。
- Produces: `visual-evidence/archive/index.json`、`visual-evidence/archive/index.html`。

- [ ] 先写空归档、坏哈希和多版本排序 smoke。
- [ ] 生成自包含、响应式、无外部依赖的索引页。
- [ ] 发布后归档完成再生成索引，不能改写版本目录。
- [ ] 用现有归档生成并打开核对索引页。

### Task 5: 集成、版本和正式发布

**Files:**
- Modify: `scripts/validate.js`
- Modify: `scripts/release.ps1`
- Modify: `.github/workflows/release-gate.yml`
- Modify: `docs/superpowers/plans/2026-09-01-admin-visual-guardrails-plan.md`
- Modify: `docs/superpowers/specs/2026-09-01-admin-release-regression-design.md`

**Interfaces:**
- Consumes: Tasks 1-4 的 CLI 和 smoke。
- Produces: 新 patch 版本、正式 ZIP、GitHub/CloudBase/开发者工具回执。

- [ ] 接入 validate、发布工具白名单、普通 CI 和严格截图 CI。
- [ ] 跑新增 smoke、`node scripts/validate.js` 和发布 gate。
- [ ] 升级 patch 版本并执行正式打包发布。
- [ ] 核对 ZIP、SHA256、PR、CloudBase、开发者工具和归档索引。
