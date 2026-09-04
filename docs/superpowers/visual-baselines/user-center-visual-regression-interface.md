# 三页视觉回归接口

## 预览源码

版本化预览包位于 `tools/user-center-preview`，不包含 `node_modules`、`.next`、`.vinext` 或运行产物。CI 进入该目录执行 `npm ci`；默认开发命令为 `npm run dev -- --host localhost --port <port>`。

## 截图入口

从仓库根目录执行：

```powershell
node scripts/user-center-responsive-capture.js
```

脚本默认从 `tools/user-center-preview` 启动临时预览服务，并把四宽度（三页）截图写入 `docs/superpowers/visual-baselines/user-center-g4`。需要复用已启动服务时设置 `USER_CENTER_PREVIEW_ORIGIN`；需要换源码目录时设置 `USER_CENTER_PREVIEW_ROOT`。

## 像素比较入口

```powershell
node scripts/user-center-visual-diff.js `
  --config docs/superpowers/visual-baselines/user-center-regression.config.json `
  --output artifacts/user-center-visual/latest
```

配置固定 G1 v2（三张 `338x654` PNG）与 G4 `338px` 候选截图，要求三页全部通过。脚本每次重新读取 RGBA PNG，不消费旧 `ssim.json`。输出 `report.json`、`report.md`、`user-center|recharge|records.{diff,heatmap,overlay}.png` 和 `report.manifest.json`。

## 失败语义

画布宽高、输入 manifest SHA256、基线 PNG SHA256、候选 PNG SHA256 任一不一致都会失败；变化像素、MAE、最大通道差值或 SSIM 任一越界都会失败。不要在失败后降低阈值，应先查看热图。
