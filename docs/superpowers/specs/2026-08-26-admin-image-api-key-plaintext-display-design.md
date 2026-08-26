# 管理员页生图 API Key 完整显示设计

## 一、目标

管理员进入“生图模型配置”后，直接看到当前云端实际使用的两条完整 API Key：

- 主用生图模型 `image.apiKey`；
- 备用生图模型 `imageBackup.apiKey`。

输入框不使用密码圆点，不增加显示/隐藏按钮。管理员可以直接查看、复制或修改。

## 二、范围

本次只修改生图主用与备用两条 Key。

不修改：

- 人脸识别 Key；
- 图片分析 Key；
- 视频模型 Key；
- 腾讯人脸融合 SecretId / SecretKey；
- 普通用户页面；
- 生图路由、模型、主备切换和扣费逻辑。

## 三、现状

当前 `getAdminConfig` 虽然只允许管理员调用，但返回前统一经过 `redactConfig`：

- `apiKey` 固定返回空字符串；
- 页面只能看到 `apiKeyConfigured=true/false`；
- 输入框使用 `password`；
- 输入框留空保存时，服务端保留旧 Key。

因此只删除输入框的 `password` 属性没有用，云函数还必须提供受管理员权限保护的真实 Key 读取能力。

## 四、选定方案

新增独立管理员接口 `getAdminImageApiKeys`。

### 4.1 权限

接口第一步继续调用现有 `isAdminContext(context)`：

- 管理员白名单内账号：允许读取；
- 其他账号或匿名请求：返回 `ADMIN_FORBIDDEN`；
- 不降低现有管理员权限标准。

### 4.2 返回范围

接口只返回：

```js
{
  image: {
    apiKey: "当前主用生图完整 Key"
  },
  imageBackup: {
    apiKey: "当前备用生图完整 Key"
  }
}
```

Key 从 `resolveEffectiveConfigs()` 读取，所以无论密钥来自云函数环境变量还是管理员运行时配置，页面看到的都是当前实际生效值。

接口不返回人脸、图片分析、视频或腾讯密钥。

### 4.3 页面加载

管理员身份确认后：

1. 原有 `getAdminConfig` 继续读取普通脱敏配置；
2. 新接口读取两条生图完整 Key；
3. 将完整 Key 填入 `form.image.apiKey` 和 `form.imageBackup.apiKey`；
4. 两个输入框改成普通文本输入框；
5. 提示文字改为“当前显示云端实际生效的完整 Key”。

如果真实 Key 读取失败：

- 普通配置仍正常显示；
- Key 输入框保持空白；
- 页面明确提示“完整 Key 读取失败，请刷新”；
- 不使用假值或脱敏值冒充真实 Key。

## 五、保存行为

页面记录加载时的两条 Key 基线值。

保存全部配置时：

- Key 与加载基线相同：请求中删除该 `apiKey` 字段，避免把环境变量中的 Key 无意义复制到运行时数据库；
- Key 被管理员修改：只提交发生变化的 Key；
- Key 被清空：沿用现有规则，视为“保留原 Key”，不删除云端密钥；
- 保存成功后：把当前输入值更新为新的基线。

这样修改价格、模型、超时等其他字段时，不会重复保存或覆盖原 Key。

## 六、密钥保护边界

用户明确要求管理员页面不隐藏完整 Key，因此接受以下结果：

- 完整 Key 会出现在管理员设备内存和管理员请求响应中；
- 进入管理员页面的人可以直接看到和复制完整 Key；
- 微信开发者工具的管理员请求详情中可能看到该响应。

仍然必须保证：

- Key 不写入前端源码；
- Key 不写入 Git；
- Key 不写入普通用户接口；
- Key 不写入诊断日志、云函数日志、部署日志或错误信息；
- Key 不写入本地缓存、Storage 或制作记录；
- 页面卸载后不额外持久化 Key。

## 七、修改文件

预计修改：

- `cloudfunctions/api/index.js`
  - 新增管理员专用 Key 读取函数；
  - 注册 `getAdminImageApiKeys` action；
  - 保持 `getAdminConfig` 原有脱敏行为。
- `services/cloud.js`
  - 新增管理员专用客户端调用。
- `pages/admin/admin.js`
  - 加载完整 Key；
  - 维护 Key 基线；
  - 保存时剔除未修改 Key。
- `pages/admin/admin.wxml`
  - 主用、备用两处输入框取消 `password`；
  - 更新提示文案。
- 专项 smoke / `scripts/validate.js`
  - 验证权限、返回范围、输入框和保存行为。

## 八、验收标准

1. 管理员打开生图配置后，主用和备用输入框显示完整 Key。
2. 两个输入框不显示密码圆点。
3. 非管理员调用专用接口返回 `ADMIN_FORBIDDEN`。
4. 专用接口不返回人脸、分析、视频和腾讯密钥。
5. 原 `getAdminConfig` 仍然不返回任何完整 Key。
6. 未修改 Key 时保存其他配置，请求不携带 Key。
7. 修改一条 Key 时，只更新对应的一条。
8. Key 不进入日志、Git、发布包静态内容或本地缓存。
9. 管理员页其他配置、模型测试和主备切换不受影响。

## 九、回滚

若线上出现问题：

1. 回滚云函数和管理员页到修改前版本；
2. 删除 `getAdminImageApiKeys` action；
3. 恢复两个输入框的 `password` 属性和原提示文案；
4. 已保存的模型配置与 Key 不做数据回滚，因为本次不迁移也不批量改写现有密钥。
