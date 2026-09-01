# 四页后台视觉矩阵设计

## 目标

在现有四页视觉合同上补齐真实截图、四状态基线、三档设备矩阵和归档索引，保证发布证据能回答“哪个版本、哪个页面、哪个状态、哪个设备、截图来自哪里、是否通过”六个问题。

## 固定合同

- 页面固定为 `dashboard`、`operations`、`config`、`provider`。
- fixture 固定为 `admin-v2-reference-20260901-v1`，演示数据不得读取云端凭证。
- 主设备固定为 `390 x 844`；兼容设备固定为 `375 x 812` 和 `430 x 932`。
- 状态固定为 `collapsed-default-v1`、`expanded-v1`、`backup-disabled-v1`、`video-mode-v1`。
- 字体 profile 继续使用 `admin-reference-font-v1`。
- 真实截图必须由微信开发者工具和 `miniprogram-automator` 当场生成；严格模式失败时不得复用旧图。

## 方案

1. `admin-v2-visual-capture.js` 继续只负责驱动微信开发者工具，增加页面、状态、设备参数并输出带真实窗口尺寸的 capture manifest。
2. `admin-v2-visual-capture-gate.js` 负责严格校验 CLI、automator、截图文件、PNG 尺寸、fixture、状态、设备和 SHA256；CI 使用带微信开发者工具的 Windows self-hosted runner，普通 GitHub runner 只跑静态合同，不伪装成真实截图环境。
3. `admin-v2-state-matrix.js` 固定四状态及其 query、目标页和必须证据；只有演示模式接受 `visualState`，真实管理数据不受影响。
4. `admin-v2-device-matrix.js` 固定三档设备，逐页验证截图尺寸、横向溢出、来源和哈希；`390 x 844` 仍参与像素基线，另外两档只做适配合同。
5. `admin-v2-visual-index.js` 扫描不可变版本归档，校验 manifest 和文件哈希，生成 `index.json` 与自包含 `index.html`。索引只引用归档相对路径，不复制凭证，不改写版本目录。
6. 发布后视觉检查按“严格截图（可选）→合同→像素报告→归档→索引”执行。`ADMIN_POST_RELEASE_CAPTURE=1` 时禁止 `--allow-existing` 回退。

## 状态含义

- `collapsed-default-v1`：四页默认首屏，功能配置的高级参数保持收起。
- `expanded-v1`：功能配置主模型、故障切换和高级参数展开，用来检查密集表单。
- `backup-disabled-v1`：功能配置保留备用供应商和模型，但状态为 `not-ready` 且开关关闭。
- `video-mode-v1`：功能配置切到共享视频模型，主模型和备用视频模型都可见。

## 错误处理

- 缺少 CLI、automator、截图或截图尺寸不符时，真实截图门禁直接失败。
- 未知状态、未知设备、重复页面或 manifest 哈希失配直接失败。
- self-hosted CI 没有配置微信开发者工具时明确失败，不降级为旧图检查。
- 索引遇到损坏归档时停止生成，并给出具体版本和文件。

## 验收

- 本机真实运行微信开发者工具完成四页 `390 x 844` 截图并通过严格门禁。
- 四状态 manifest 和三设备 manifest 均通过 smoke，缺状态、错尺寸、错哈希用例均失败。
- `375 x 812`、`390 x 844`、`430 x 932` 三档四页均无横向溢出，截图文件非空且尺寸正确。
- 归档根目录生成可直接打开的 `index.html` 和机器可读 `index.json`，当前版本可见四页、状态、设备和检查结果。
- `node scripts/validate.js`、发布 gate、正式打包、GitHub PR、CloudBase 和开发者工具验收全部通过。
