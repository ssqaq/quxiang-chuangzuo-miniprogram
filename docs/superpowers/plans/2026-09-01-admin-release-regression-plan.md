# 四页后台发布回归实施计划

## 1. 发布链

- 移动本地云函数依赖安装到 `validate.js` 与 `check-deployment.js --strict` 之前。
- 增加顺序 smoke，防止后续发布脚本再次回退。

## 2. 演示数据

- 新增统一 fixture 服务。
- 接入 dashboard、operations、config、provider 的加载路径。
- 为 query 开关和 fixture 形状补 smoke，确保默认真实数据路径不变。

## 3. 像素回归

- 新增 PNG/JPEG 解码、归一化、阈值比较和 heatmap 输出工具。
- 新增单元 smoke 及四页基线清单，记录运行命令和差异报告位置。

## 4. 交付

- 运行全量 validate 和专项 smoke。
- 按版本规则发布新版本，生成正式 ZIP 与最终二维码。
- 推送 GitHub 并合并 PR，部署 CloudBase，导入开发者工具并记录结果。
