# 三类模型每日用量统计设计

## 目标

在现有管理员配置页增加模型用量统计，按北京时间每天统计：

- 生图模型
- 人脸识别模型
- 视频模型

统计按真实上游模型调用次数计算，不统计视频查询轮询。

## 统计口径

每次真正发往上游模型接口的请求记 1 次：

- `generate`：生图模型调用
- `detectFaceCircle`：人脸识别模型调用
- `video.create`：视频模型创建调用

每类同时记录总次数、成功次数和失败次数，并保存实际 provider、model、请求编号、耗时和北京时间日期。视频 `video.query` 不计入模型用量。

失败请求也计入总次数，便于看真实请求量和故障率。功能上线前的历史调用没有完整事件数据，不做虚假补录。

## 数据结构

新增 CloudBase 集合 `model_usage_events`，每次上游调用写一条脱敏事件：

- `requestId`
- `usageType`: `image`、`face`、`video`
- `action`
- `provider`
- `model`
- `dateKey`: `YYYY-MM-DD`，按 `Asia/Shanghai`
- `success`
- `status`
- `durationMs`
- `attempt`
- `createdAt`

事件不保存 API Key、Prompt、图片 fileID、用户身份和素材内容。

## 服务端接口

新增管理员 action：`getModelUsageStats`。

默认返回最近30天，支持管理员传入 `days`（1～90）。返回：

- `today`
- `last7d`
- `last30d`
- `summary`: 三类模型总数/成功/失败
- `daily`: 每天三类模型的调用明细
- `models`: 实际使用的 provider 和 model

继续复用现有 `ADMIN_OPENIDS` 管理员白名单，普通用户返回无权限。

## 管理员页面

在 `pages/admin` 的部署日志前增加“模型用量统计”卡片：

- 顶部显示今天、最近7天、最近30天三组汇总
- 中间显示生图、人脸识别、视频三张类型卡
- 下方显示最近30天逐日明细
- 提供刷新按钮
- 无记录时显示空状态
- 统计读取失败只提示，不影响模型配置和部署检查

## 验证

- 静态检查通过
- 统计分类、北京时间日期、成功/失败计数专项测试
- 非管理员不能读取统计
- 视频查询不产生统计事件
- 发布包包含接口、页面和测试文件
