# 工作台缩略图与制作记录页布局修复设计

## 背景

工作台“制作记录”卡片直接读取本地缓存的 `tempFileURL`。云文件临时地址过期后，页面仍会渲染图片节点，但缩略图只显示灰色背景。制作记录页顶部的操作区还会挤压说明文字，导致说明换行，返回按钮与说明并列显示。

## 目标

- 工作台打开时先显示本地记录，随后用云端返回的新临时地址刷新首条记录。
- 缩略图加载失败时，使用记录的 `fileID` 再请求一次临时地址并回写缓存。
- 保留缩略图旁的项目名、生成时间和预览箭头。
- 制作记录页显示“返回工作台”，说明文字保持单行，返回按钮放在说明下一行。
- 不改生成接口、记录字段协议和云函数部署。

## 实现

`pages/workbench/workbench.js` 的记录规范化保留 `fileID`，`refreshWorkbench` 先设置本地记录，再异步调用现有 `cloud.listRecords`。服务端会按 `fileID` 刷新 `tempFileURL`，成功后更新首条记录和本地缓存；图片节点增加 `binderror`，作为临时地址失效时的单次 `cloud.getTempUrl` 兜底。

`pages/workbench/workbench.wxml` 恢复最近记录的项目名、时间和箭头，并把记录 ID 传给图片错误回调。`pages/records/records.wxml/.wxss` 将标题与操作区放到同一行，说明单独占一行，返回按钮紧随其后；无记录提示同步改为“返回工作台”。

## 验收

- `node scripts/workbench-media-parser-layout-smoke.js`
- `node scripts/records-head-layout-smoke.js`
- `node scripts/validate.js`
- `git diff --check`
- 微信开发者工具检查 375、390、430 宽度下的卡片高度、单行说明、按钮位置、缩略图和长文本适配。
