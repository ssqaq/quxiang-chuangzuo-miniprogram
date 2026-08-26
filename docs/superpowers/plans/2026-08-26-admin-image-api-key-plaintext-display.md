# 管理员页生图 API Key 完整显示实施计划

## 目标

只让已通过现有管理员白名单校验的管理员，在管理页直接看到当前实际生效的：

- 主用生图 `image.apiKey`
- 备用生图 `imageBackup.apiKey`

原有 `getAdminConfig` 继续脱敏，其他模型和腾讯密钥继续隐藏。

## 实施步骤

### 1. 云函数增加最小权限接口

修改 `cloudfunctions/api/index.js`：

- 新增 `getAdminImageApiKeys(context)`。
- 先调用 `isAdminContext(context)`，非管理员返回 `ADMIN_FORBIDDEN`。
- 从 `resolveEffectiveConfigs()` 读取当前实际生效配置。
- 只返回 `image.apiKey` 与 `imageBackup.apiKey`。
- 注册 `getAdminImageApiKeys` action。
- 加入测试导出。
- 不输出任何包含 Key 的日志。

### 2. 客户端增加专用调用

修改 `services/cloud.js`：

- 新增 `getAdminImageApiKeys(options)`。
- 使用现有 `callApi` 调用专用 action。
- 不做缓存，不写 Storage。

### 3. 管理页维护 Key 基线

修改 `pages/admin/admin.js`：

- 增加纯函数：
  - 规范化专用接口返回值；
  - 把真实 Key 合并到脱敏配置生成的表单；
  - 根据加载基线移除未修改或被清空的 Key；
  - 保存后把真实 Key 恢复到脱敏返回生成的新表单。
- 首次加载和“刷新全部”时，同时请求普通配置与专用 Key。
- 将真实 Key 保存到页面实例字段 `_imageApiKeyBaseline`，不放 Storage。
- 专用 Key 读取失败时，普通配置仍可用，但页面提示完整 Key 读取失败。
- 保存时：
  - 未修改的 Key 不提交；
  - 只修改一条时只提交该条；
  - 清空输入框时不提交，沿用服务端“保留旧 Key”规则；
  - 保存成功后输入框不因脱敏返回而变空，并更新基线。

### 4. 管理页取消两处密码显示

修改 `pages/admin/admin.wxml`：

- 主用和备用两个 Key 输入框删除 `password`。
- 状态文字改为“已显示完整 Key”或“未配置”。
- 提示文字明确当前展示的是云端实际生效的完整 Key。
- 人脸、分析、视频三个 Key 输入框保持 `password`。

### 5. 专项测试与旧校验更新

新增 `scripts/admin-image-api-key-display-smoke.js`，验证：

1. 非管理员读取失败。
2. 管理员只拿到主用与备用生图 Key。
3. 原 `getAdminConfig` 仍脱敏。
4. 两个生图输入框不是密码框。
5. 其他三个输入框仍是密码框。
6. 未修改 Key 时保存请求不带 Key。
7. 只修改一条时只提交一条。
8. 清空时不提交 Key。
9. 保存后页面仍显示真实 Key。
10. 页面刷新后真实 Key 不消失。

同步修改 `scripts/validate.js` 的旧输入框断言。

## 验证与发布

1. 运行新增专项 smoke。
2. 运行管理员配置、加载、布局、action registry 等相关 smoke。
3. 运行 `node scripts/validate.js`。
4. 搜索本次提交，确认没有真实 Key 字面量、日志或 Storage 写入。
5. 合并最新 `origin/main`，解决并行修改，不覆盖其他工作。
6. 升级补丁版本。
7. 正式生成发布 ZIP，并核对文件存在、大小和 SHA256。
8. 使用受控同步流程推送。
9. 部署 `api` 云函数并核对线上版本。
10. 用管理员账号验证两处完整 Key 显示，非管理员接口继续被拒绝。

## 回滚

- 回滚本次提交。
- 删除专用 action 和客户端调用。
- 恢复两个输入框的 `password` 属性。
- 不回滚数据库配置，因为本次没有迁移或批量改写 Key。
