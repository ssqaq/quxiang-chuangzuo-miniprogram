# 发布安全、CloudBase 直连核验与管理员异常恢复实施计划

**目标：** 在保留现有工作区其他任务改动的前提下，统一发布锁、增加受控安全同步、让 CloudBase CLI 能直接完成只读运行核验，并补齐管理员服务异常时的页面恢复和专项测试。

**开发来源：** `D:\aips小程序\wechat-miniapp`

**发布目标：** `D:\aips小程序\wechat-miniapp-admin-access-release-20260827`

**当前版本边界：**

- 开发来源当前 `config.js` 为 `0.48.1`；
- 发布目标当前 `config.js` 为 `0.49.0`；
- 实现期间不得用开发来源版本覆盖发布目标版本；
- 最终版本必须在统一发布锁内读取远端最新版本并自动分配下一个补丁版本；
- 只有远端仍为 `0.49.0` 时，候选版本才是 `0.49.1`。

## 文件范围

### 新增

- `scripts/release-lock.ps1`
- `scripts/safe-sync-to-release.ps1`
- `scripts/release-lock-smoke.js`
- `scripts/safe-sync-smoke.js`
- `scripts/cloudbase-runtime-health-smoke.js`
- `scripts/admin-service-recovery-smoke.js`

### 修改

- `scripts/sync-to-github.ps1`
- `scripts/cloud-deploy-safety.ps1`
- `scripts/deploy-and-verify-api.ps1`
- `scripts/deploy-api-cloudbase-cli.ps1`
- `cloudfunctions/api/index.js`
- `cloudfunctions/api/lib/action-registry.js`（仅在运行健康动作需要登记时修改）
- `pages/admin/admin.js`
- `pages/admin/admin.wxml`
- `services/cloud.js`（仅在页面需要新的错误分类或调用封装时修改）
- `scripts/deployment-script-smoke.js`
- `scripts/cloud-deploy-safety-smoke.js`
- `scripts/admin-loading-smoke.js`
- `scripts/validate.js`（仅在项目已有校验入口需要接入新 smoke 时修改）

### 不修改

- 用户端生图、图片编辑、视频、换脸和记录业务；
- 用户密钥、`.env`、AppSecret、API Key；
- 未列入本次 `IncludePath` 的工作区文件；
- Git index、未授权目标文件和其他任务的提交内容；
- 管理员专用 `checkDeployment` 的权限要求和原有业务含义。

## Task 1：实施前基线和改动隔离

**文件：** 不新增源码；只记录检查结果。

### 步骤

- [ ] 记录开发来源的 `git status --short --branch`、当前 HEAD 和相关文件差异。
- [ ] 记录发布目标的 HEAD、`origin/main` 和版本。
- [ ] 确认本任务涉及的文件是否已有其他任务修改；逐文件保存修改前摘要。
- [ ] 确认不存在已暂存的无关文件。
- [ ] 不执行 `git reset`、`git clean`、全量复制或全量暂存。
- [ ] 后续每次编辑只改本计划列出的文件，并保留已有逻辑。

### 完成标准

- 已明确开发来源、发布目标和版本基线；
- 可区分本任务新增差异与工作区已有差异；
- 没有清理或覆盖其他任务改动。

## Task 2：公共发布锁模块

**文件：**

- 新增 `scripts/release-lock.ps1`
- 修改 `scripts/cloud-deploy-safety.ps1`
- 修改 `scripts/sync-to-github.ps1`
- 新增 `scripts/release-lock-smoke.js`

### 步骤

- [ ] 抽出统一的默认锁路径计算，默认路径固定在项目父目录的统一发布锁文件。
- [ ] 支持 `-LockPath` 显式覆盖；云部署入口继续支持 `-DeployLockPath`，内部映射到同一公共模块。
- [ ] 使用 `.NET FileStream` + `FileShare.None`，确保锁覆盖整个真实写发布流程。
- [ ] 记录脱敏 owner 信息：PID、开始时间、目标版本、目标类型和项目标识。
- [ ] 处理等待、超时、占用者读取和异常释放。
- [ ] 保留微信待确认任务的 pending 占位，防止新任务覆盖未完成发布。
- [ ] 明确 `VerifyOnly`、`DryRun` 不拿写锁、不上传、不改远端。
- [ ] 将现有云部署安全脚本的锁函数改为调用公共模块，保持旧参数兼容。
- [ ] 将 GitHub 同步脚本的仓库名锁改为公共默认锁，不再自行拼接另一套路径。

### Smoke

- [ ] 两个进程争抢同一锁时，第二个不能进入写操作。
- [ ] 首个进程释放后，第二个可以取得锁。
- [ ] 等待超时能返回占用信息且不上传、不提交。
- [ ] 异常退出或 `finally` 路径释放句柄。
- [ ] 显式锁路径优先于默认路径。
- [ ] `VerifyOnly` 和 `DryRun` 不创建写锁。

## Task 3：安全同步脚本

**文件：**

- 新增 `scripts/safe-sync-to-release.ps1`
- 新增 `scripts/safe-sync-smoke.js`

### 步骤

- [ ] 参数强制要求源目录、目标目录和一个或多个 `IncludePath`。
- [ ] 规范化相对路径，拒绝绝对路径、`..`、`.git`、`.worktrees` 和仓库外目标。
- [ ] 只复制 `IncludePath` 指定的文件或目录，不修改 Git index、暂存区、分支和提交。
- [ ] 默认拒绝 `.env`、密钥、AppSecret、API Key、临时文件和发布包。
- [ ] 复制前记录源文件存在性、大小和 SHA256。
- [ ] 目标不存在时允许创建；内容相同时跳过。
- [ ] 目标存在且内容不同、同时检测到目标用户改动时拒绝覆盖。
- [ ] 受控覆盖时记录明确结果，不删除未列出的目标文件。
- [ ] 复制后重新计算目标文件 SHA256、存在性和大小并断言一致。
- [ ] 输出只包含仓库相对路径和脱敏结果。

### Smoke

- [ ] 只同步一个明确文件。
- [ ] 目录 IncludePath 能递归复制且不越界。
- [ ] 未列出的源文件不会进入目标。
- [ ] 目标相同内容被跳过。
- [ ] 目标用户改动导致覆盖拒绝。
- [ ] 绝对路径、越界路径、敏感文件和空 IncludePath 被拒绝。
- [ ] 复制前后哈希不一致时失败。
- [ ] 源工作区 Git index 和未列出文件保持不变。

## Task 4：GitHub 发布脚本接入安全边界

**文件：**

- 修改 `scripts/sync-to-github.ps1`
- 修改已有发布 smoke

### 步骤

- [ ] 增加 `-LockPath`，默认复用公共发布锁。
- [ ] 保留 `-IncludePath` 强制显式清单，不恢复 `git add -A`。
- [ ] 将版本读取、补丁版本分配、预检查包、提交、正式打包和推送放在同一发布锁内。
- [ ] 在版本分配前重新读取远端主线最新版本。
- [ ] 冲突时重新读取并重试，不覆盖其他任务的提交。
- [ ] 只对本次 IncludePath 生成 Git tree 和发布清单。
- [ ] 推送前后核对 commit SHA、tree SHA、源码 SHA256 和发布包清单。
- [ ] 推送失败时保留本地提交和产物，不自动清理。
- [ ] 不把开发来源 `0.48.1` 直接当作最终版本；由发布 clone 和远端基线决定最终版本。

### Smoke

- [ ] 静态确认不存在 `git add -A`。
- [ ] 锁、IncludePath、main 分支保护和 SHA 校验均存在。
- [ ] 并发发布不能互相覆盖。
- [ ] 版本冲突会重试并产生下一个补丁版本。
- [ ] 正式包只来自受控 tree，清单 SHA 与提交一致。

## Task 5：CloudBase 只读运行健康动作

**文件：**

- 修改 `cloudfunctions/api/index.js`
- 视需要修改 `cloudfunctions/api/lib/action-registry.js`
- 新增 `scripts/cloudbase-runtime-health-smoke.js`

### 步骤

- [ ] 增加固定名称的只读运行健康动作，例如 `checkRuntimeHealth`。
- [ ] 保持现有 `checkDeployment` 的管理员权限和读写语义不变。
- [ ] 健康动作只返回版本、Build Marker、Active 状态、依赖健康结果和时间戳。
- [ ] 对运行依赖使用固定白名单，不允许由请求参数选择模块或配置。
- [ ] 失败只返回脱敏错误码和依赖名，不返回堆栈、绝对路径、环境变量和密钥。
- [ ] 确认动作不写数据库、不写部署日志、不迁移配置、不调用计费型上游接口。
- [ ] 在本地 smoke 中验证成功、依赖缺失、返回字段缺失、异常和敏感字段过滤。
- [ ] 验证普通用户不能借此读取管理员配置或业务数据。

## Task 6：CloudBase CLI 直连核验

**文件：**

- 修改 `scripts/deploy-and-verify-api.ps1`
- 修改 `scripts/deploy-api-cloudbase-cli.ps1`
- 修改 `scripts/cloud-deploy-safety.ps1`
- 修改相关部署 smoke

### 步骤

- [ ] 复用现有 CloudBase CLI JSON 调用封装，不回显原始 CLI 输出。
- [ ] 增加直连运行健康动作的调用适配，先以固定测试参数验证 CLI 实际返回结构。
- [ ] `DeployTransport=cloudbase` 上传后按顺序检查 Active、代码快照、版本、Build Marker、超时和运行健康。
- [ ] `VerifyOnly` 在没有微信开发者工具时走 CloudBase 代码快照和运行健康核验。
- [ ] 微信部署链保留现有管理员核验作为兼容路径，复用相同断言规则。
- [ ] 任意核验失败返回非零状态，不继续 GitHub 正式同步。
- [ ] 保留源码快照检查：部署前、上传后、线上核验完成前各检查一次。
- [ ] `deploy-api-cloudbase-cli.ps1` 增加显式锁路径参数，并与主入口共用锁。
- [ ] 增加错误码映射：未 Active、版本不一致、标记不一致、超时不一致、依赖异常、调用超时、调用错误、返回结构错误。

### Smoke

- [ ] CloudBase 代码快照和健康结果均成功时通过。
- [ ] 版本、Build Marker、超时或依赖任一不匹配时失败。
- [ ] CLI 调用失败不自动切换到微信上传。
- [ ] `VerifyOnly` 不上传、不改配置、不写部署日志。
- [ ] 原始 CLI 输出和敏感字段不会进入日志。
- [ ] `DeployLockPath` 和独立 CloudBase CLI 入口使用同一锁规则。

## Task 7：管理员服务异常恢复

**文件：**

- 修改 `pages/admin/admin.js`
- 修改 `pages/admin/admin.wxml`
- 视需要修改 `services/cloud.js`
- 扩展 `scripts/admin-loading-smoke.js`
- 新增 `scripts/admin-service-recovery-smoke.js`

### 步骤

- [ ] 梳理当前 `loadAdminModule`、`refreshAll`、初始加载和模块状态的错误分支。
- [ ] 将超时、网络错误、CloudBase 5xx 和服务返回失败统一标成“管理员服务暂时不可用”。
- [ ] 保留真正的身份失败、权限失败和数据格式失败，不混成服务错误。
- [ ] 服务异常时显示重试入口，设置 `canRetry=true`。
- [ ] 重试开始前重新进入 loading，避免旧错误和旧按钮状态残留。
- [ ] 重试成功后清理错误消息、失败标记和重试状态。
- [ ] 单模块失败只影响对应模块，其他模块继续显示。
- [ ] 重复点击刷新时去重或忽略并发请求。
- [ ] 服务异常时不得调用 `wx.reLaunch` 跳离管理员页。
- [ ] 日志记录错误类别和模块名，不记录密钥、完整响应和用户数据。

### Smoke

- [ ] 管理员身份成功、服务超时：出现服务异常和重试按钮。
- [ ] 管理员身份成功、服务 5xx：不显示无权限。
- [ ] 返回权限错误：显示权限提示。
- [ ] 第一次失败、第二次成功：页面数据恢复且错误清除。
- [ ] 连续失败：仍可再次重试。
- [ ] 单模块失败：其他模块状态保持 ready。
- [ ] 重复刷新：调用次数和最终状态符合预期。
- [ ] 任何服务异常路径：跳转函数调用次数为零。

## Task 8：专项回归和完整校验

**文件：** 现有校验入口及本计划新增 smoke。

### 步骤

- [ ] 运行公共锁 smoke。
- [ ] 运行安全同步 smoke。
- [ ] 运行管理员服务恢复 smoke 和现有管理员加载 smoke。
- [ ] 运行部署脚本静态 smoke、CloudBase 安全 smoke 和部署脚本契约 smoke。
- [ ] 运行云函数依赖完整性检查。
- [ ] 运行 `node scripts/validate.js`。
- [ ] 运行 `git diff --check`。
- [ ] 检查新增日志不包含密钥、环境变量、绝对用户路径和用户数据。
- [ ] 对失败项读取完整错误并修复后重跑，不降低断言标准。

## Task 9：版本升级、正式打包和 GitHub 同步

**文件：** 由发布脚本根据最终 IncludePath 和版本规则处理。

### 步骤

- [ ] 在发布锁内读取发布 clone 与远端主线的最新版本。
- [ ] 自动分配下一个补丁版本；若发生并行冲突，重试而不是覆盖。
- [ ] 同步 `config.js`、云函数版本、`API_BUILD_VERSION`、`API_BUILD_MARKER`、`package.json` 和 media-worker 版本等项目要求的版本位置。
- [ ] 运行正式打包脚本，产物输出到明确的发布目录。
- [ ] 检查 ZIP 存在、大小大于 0、可解压、清单完整、SHA256 可复核。
- [ ] 使用安全同步脚本，并显式传入本轮 IncludePath；不得全量复制。
- [ ] 由 `sync-to-github.ps1` 完成提交和推送。
- [ ] 核对本地 HEAD、`origin/main`、最终 commit SHA、tree SHA 和发布包清单。
- [ ] 记录完整产物路径、版本号、SHA256 和线上核验结果。
- [ ] 确认开发来源工作区其他任务改动仍在，未被清理或误提交。

### 完成标准

- [ ] 统一发布锁生效，两个发布入口不能并发写入。
- [ ] 安全同步只复制明确清单，目标用户改动不会被静默覆盖。
- [ ] CloudBase CLI 可以完成直部署后的只读运行核验。
- [ ] `VerifyOnly` 不产生远程写操作。
- [ ] 管理员服务异常可识别、可重试、可恢复且不错误跳转。
- [ ] 专项测试和完整校验通过。
- [ ] 版本按远端最新基线自动升级。
- [ ] 正式包存在并通过完整性检查。
- [ ] GitHub 推送完成且 SHA 一致。

### 交付必填信息

- ✅ 版本号：写明实际从哪个版本升到哪个版本；
- ✅ 打包产物：写明绝对路径和文件名；
- ✅ 打包状态：成功，或明确写出未完成原因和下一步；
- ✅ GitHub 同步状态：写明 commit、远端分支和 SHA 核对结果；
- ✅ 工作区状态：写明哪些剩余改动属于其他任务。
