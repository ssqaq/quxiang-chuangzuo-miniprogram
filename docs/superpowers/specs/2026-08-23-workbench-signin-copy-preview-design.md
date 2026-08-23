# 工作台签到卡文案与预览辅助优化设计

## 目标

在不改变签到、积分和免费次数计算逻辑的前提下，完成四项小范围优化：

1. 集中管理签到卡文案；
2. 预览脚本额外生成稳定的 latest 预览码文件；
3. 活动期间突出显示“活动期间免费”；
4. 统一签到成功和重复签到提示。

## 改动边界

- 保留现有签到接口、积分计算、活动日期判断和按钮禁用逻辑。
- 只改工作台/积分页的展示文案、提示文案、活动样式和预览脚本。
- 不覆盖当前并行任务对 `cloudfunctions/api/index.js` 的未提交修改。
- 带版本号的预览码继续保留，latest 文件只是额外复制出来的稳定入口。

## 方案

### 1. 文案配置

在 `config.js` 增加 `points.copy`，统一保存：

- 卡片标题、说明；
- 未签到/已签到状态；
- 免费次数和活动期间文案；
- 签到按钮文字；
- 签到成功和重复签到提示。

工作台 WXML、工作台 JS、积分页 WXML/JS 都从这个配置读取。动态积分、天数和次数仍由现有数据绑定提供。

### 2. latest 预览码

`scripts/refresh-preview.ps1` 继续按版本生成：

- `wechat-miniapp-preview-vX.Y.Z-qr.png`
- `wechat-miniapp-preview-vX.Y.Z-info.json`

预览成功并确认文件存在后，再以临时文件写入并替换：

- `wechat-miniapp-preview-latest-qr.png`
- `wechat-miniapp-preview-latest-info.json`

这样既能追溯版本，也能让真机测试固定使用 latest 文件。

### 3. 活动样式

给活动文案增加独立 class。`promoActive` 为真时使用强调色、浅色背景和圆角；普通免费次数保持原来的弱提示样式。活动判断仍完全复用后端返回值，不在前端重复计算日期。

### 4. 签到提示

工作台和积分页使用同一套配置提示：

- 首次签到：`签到成功，+X 积分`
- 重复签到：`今天已经签到过了`
- 未连接云端和接口异常继续使用现有错误处理。

## 验证

- `node scripts/validate.js`
- 现有 `scripts/points-checkin-smoke.js`
- `python scripts/package-release.py`
- `scripts/refresh-preview.ps1`
- 检查版本号、版本预览码、latest 预览码和 Git 工作区状态。

## 回滚

- 删除 `config.js` 新增的 `points.copy` 并恢复页面原文字；
- 删除活动 class 和 latest 复制逻辑；
- 不触碰签到云函数和积分数据。
