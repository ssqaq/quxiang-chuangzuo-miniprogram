# 用户中心视觉预览包

这是用户中心、充值页、记录页的可审计浏览器预览源码快照。它只提供视觉 fixture，不连接小程序云函数、支付接口或真实密钥。

## 本地运行

```powershell
npm ci
npm run dev -- --host localhost --port 3000
```

页面入口：`#user-center`、`#recharge`、`#records`。截图模式使用 `?payState=enabled&capture=1`。

## 冻结基线

从仓库根目录执行：

```powershell
$env:G1_OUTPUT_DIR = (Resolve-Path 'docs/superpowers/visual-baselines/user-center-g1-v2').Path
node tools/user-center-preview/scripts/freeze-g1.mjs
```

冻结脚本会记录源码文件 SHA256、浏览器环境、三页 PNG SHA256 和 CTA 状态；旧的 `user-center-g1` 基线不会被覆盖。

## 视觉差异

```powershell
node scripts/user-center-responsive-capture.js
node scripts/user-center-visual-diff.js --config docs/superpowers/visual-baselines/user-center-regression.config.json --output artifacts/user-center-visual/latest
```

比较器每次从 PNG 原图重新计算，不读取旧 `ssim.json`。输出目录包含 `report.json`、`report.md`、三页 `.diff.png`、`.heatmap.png`、`.overlay.png` 和绑定 SHA256 的 `report.manifest.json`。
