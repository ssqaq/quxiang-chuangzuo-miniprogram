# 微信小程序统一发布闸门设计

## 背景

历史发布链允许多个 clone/worktree 分别调用同步、打包、预览和云部署脚本。版本号、Git 提交、ZIP、二维码和 CloudBase 因此可能来自不同源码快照；同名 ZIP 还会被后一次任务覆盖。

本设计把所有会写入发布状态的操作收口到一个队列，并用不可变 release context 串起整个流程。

## 不变量

1. 唯一 canonical 仓库是 `D:\aips小程序\wechat-miniapp`，唯一远端是 `https://github.com/ssqaq/quxiang-chuangzuo-miniprogram.git`，主分支是 `main`。
2. 开发可在任意 worktree 进行，但发布只能由 canonical 仓库的 `scripts/release.ps1` 发起。
3. 每次发布必须显式提供来源目录和文件清单；清单外的脏改动不得进入发布提交。
4. 版本号必须在持有共享发布锁后，从最新 `origin/main` 分配。显式版本只允许等于下一 patch 版本。
5. reservation、release context、Git 提交、ZIP、二维码元数据和发布记录共享同一 `operationId`。
6. 正式 ZIP 使用 `wechat-miniapp-release-v<version>-<commit>.zip`，只允许同 SHA 幂等复用，禁止覆盖不同内容。
7. 发布分支使用 `release/<version>-<operationId>`，`main` 只接受通过必需检查的 PR。
8. CloudBase 部署和二维码生成只能消费尚未过期、且与当前提交/tree/源码指纹完全一致的 context。

## 发布状态机

持久队列记录顺序、租约、尝试次数和每个阶段：

`queued -> reserved -> prepared -> committed -> packaged -> pushed -> merged -> previewed -> deployed -> verified`

最终完成采用两阶段写入：先把 context、reservation、record 写成 `finalizing`，最后才把队列票据写成 `succeeded`。这样进程在任意中间点崩溃，都能用原 `operationId` 恢复，不能重新占用版本。准备包会保持 FIFO 队头，普通 worker 不能越过；只有 `resume-release.ps1 -Publish` 能继续它。context 过期会被恢复扫描标成 `expired`，解除队列阻塞。

失败时记录 `failedStage` 和原 context。提交前失败可释放 reservation；提交后失败保留 reservation、不可变 ZIP、隔离 worktree 和发布分支供恢复。队列租约由独立 heartbeat 续期，并同时核对进程 PID 与启动时间，避免 PID 复用把死任务误判为存活。

## 路径与来源校验

- `IncludePath` 先展开为真正的字符串数组；只兼容一次旧逗号格式。
- 拒绝空项、绝对路径、`..`、`.git`、`.worktrees`、密钥文件、逗号文件名和不存在的来源文件。
- 发布工作树始终从刚 fetch 的 `origin/main` 创建，再逐项复制来源快照。
- 策略文件、锁、队列、产物、reservation、context、record、日志和封存清单都必须是 canonical 仓库父目录下的固定绝对路径；同名目录搬到别处也会被拒绝。
- 旧 clone/worktree 不删除，通过封存清单标记为不可发布；其中的旧脚本也会因 canonical 路径校验而拒绝执行。旧 `sync-to-github.ps1` 只保留兼容转发，不再含独立的 Git 写操作。

## 产物与一致性

`package-release.py` 的正式写包接口只接受 `--release-context`。`--check-only` 可用于只读预检；旧的 `--output` 写入入口直接失败。

打包器检查：

- `config.js`、API build version/marker、三个 `package.json`；
- API 和 media worker 两个 `package-lock.json` 的根版本及 `packages[""].version`；
- context 的版本、commit、tree、源码 SHA、canonical 仓库、过期时间和不可变文件名；
- ZIP 内 manifest 与 context 的 `operationId`、版本、commit、tree、源码 SHA。

ZIP 先写到目标目录中的随机临时文件，完整性校验通过后再原子改名。失败时删除临时文件，不删除已有正式产物。

## GitHub 主线保护

`.github/workflows/release-gate.yml` 对 release PR 执行静态检查、发布安全 smoke、版本一致性检查和打包只读预检。GitHub ruleset 要求 PR、禁止 force push/delete，并把 `release-gate` 设为必需检查且对管理员生效。

策略文件在本地固定放在仓库父目录；GitHub runner 没有该本机路径时，workflow 会在 checkout 的父目录生成同 schema 的临时策略，canonicalRepo、锁、reservation、record 和日志路径全部绑定当前 checkout，避免 smoke 因路径不同而误报。

主分支保护由 `scripts/configure-github-protection.ps1` 幂等配置；它只接受策略文件中的 canonical 仓库和 `main`，实际写入前先检查 `gh auth status`，因此没有 GitHub 凭证时不会留下半完成的远端状态。

## 日志与审计

每个操作写独立日志 `wechat-miniapp-release-logs/<operationId>.log`，并在外部状态目录保存 reservation/context/record。日志不得输出 token、AppSecret、环境变量或 CloudBase 原始敏感响应。

## 本次迁移

版本不写死在脚本里：每次在锁内重新 fetch `origin/main`，从远端基线和所有本地/远端 reservation、record、context、tag、release 分支中选出全局未占用的下一个 patch。版本候选以当次锁内读取到的远端基线为准（本机审计时为 `0.57.49`，因此下一候选是 `0.57.50`）；历史版本绝不复用或覆盖。业务文件只带明确列出的解析页修复和发布链修复，历史 ZIP、clone 和 worktree 保留并只读封存。

实际远端发布仍必须通过 `gh` 创建并确认合并 PR，PR 的 base 也必须持续是 `main`，不能直接 push `main`。保护规则只要求 `release-gate` 检查，不强制人工审批，这样闸门可以在检查通过后自动合并；强推和删除仍被禁止。封存清单在共享发布锁内更新，恢复时会把 `-Publish/-Preview/-DeployCloud` 意图写回持久票据。如果 GitHub 主分支保护 API 因私有仓库套餐返回 403，发布器会在推送前失败关闭，保留原 context，不生成第二个版本。

正式发布和恢复都会在创建/领取队列票据之前先做一次只读主线保护预检；套餐或认证失败不会消耗 attempt，也不会留下新的 FIFO 阻塞票据。真正推送前仍在共享锁内重复校验，防止预检后保护设置被改动。

## 十项运维能力落地（2026-08-29）

本次在上述闸门之上补齐十项面向日常使用的能力。原则是“一个状态源、一个操作号、失败可恢复、成功可对账”，不另建第二套发布器。

1. **唯一入口与状态面板**：`release.ps1` 继续是唯一写入口；`release-status.ps1` 默认输出人类可读的阶段表，`-Json` 输出机器格式，状态同时读取队列、context、record、产物和二维码证据。
2. **失败告警与原 context 恢复**：失败时写入脱敏的 per-operation alert，并可通过显式环境变量发送 webhook；告警带原 `operationId`，恢复只能调用 `resume-release.ps1`，不能重新分配版本。
3. **统一验收报告**：每次成功或可恢复失败都生成 JSON/Markdown 报告，分别核对 `main`、ZIP、二维码和 CloudBase；任一缺证据即为 pending/failed，不能显示“成功”。
4. **独立日志**：日志文件按 `operationId` 独立创建，context/record 记录 `logPath`；写入使用进程内互斥和临时文件，避免同一操作多次恢复时行交错。
5. **发布前预检与源码指纹**：在入队前和锁内再次检查 canonical 路径、认证、分支、依赖、清单及源码快照；打包、二维码、云部署前后都复核指纹。
6. **不可覆盖产物**：ZIP/二维码/报告都先写同目录临时文件，校验通过才原子改名；同名只有相同 SHA 才能幂等复用，不同内容直接失败。
7. **reservation 维护**：过期的失败/取消 reservation 在锁内转移到归档目录并保留索引；归档版本仍计入已用版本，绝不重新占用历史版本号。
8. **clone 发布钩子**：`pre-push` 拦截直接推 `main`，`post-checkout` 提示 canonical 路径；安装器、发布工具快照和 smoke 全部覆盖三类 hook，旧 clone 入口只允许转发或拒绝。
9. **备份与回滚**：成功发布前登记上一版四端证据，生成不可变 backup manifest；`rollback-release.ps1` 只能在同一把锁内按已验证版本恢复，并留下回滚报告，不删除历史产物。
10. **最新版本清单**：成功后原子更新 `latest-release.json`，只允许指向完整验收报告；失败或 pending 不得覆盖上一次成功清单。

### 统一接口

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/release-status.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/release-status.ps1 -OperationId <operationId> -Report
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/rollback-release.ps1 -ToVersion <version> -Confirm
```

所有新增状态文件都放在策略文件指定的父目录，字段至少包含 `schemaVersion`、`operationId`、`version`、`releaseCommit`、`treeSha`、`sourceSha256`、`packageSha256` 和 `createdAt`。敏感信息只允许记录字段名和掩码，不记录 token、AppSecret、Cookie 或原始 CloudBase 响应。

### 验收标准

- 两个并发入口只有一个能进入临界区，另一个可见地排队；状态面板能显示队列顺序和当前阶段。
- 任意阶段失败都能看到独立日志和告警；恢复使用同一 context/版本，重复恢复不产生第二个副作用。
- 报告对四端逐项给出 `pass`/`pending`/`fail`，四端版本或指纹不一致时整体不是 `succeeded`。
- 破坏 ZIP、二维码或 context 后，check-only 和恢复入口拒绝继续；已有同名不同 SHA 文件永不被覆盖。
- 归档 reservation 可追溯且仍阻止版本复用；旧 clone、直接 push main、空/越界 IncludePath 均被拦截。
- 回滚只能选择已验证的历史版本，回滚后生成新报告但不篡改历史记录；latest 清单始终指向最近一次完整验收成功。
