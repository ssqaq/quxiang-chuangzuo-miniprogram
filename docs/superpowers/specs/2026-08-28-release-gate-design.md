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

版本不写死在脚本里：每次在锁内重新 fetch `origin/main`，从远端基线和所有本地/远端 reservation、record、context、tag、release 分支中选出全局未占用的下一个 patch。当前核对到的远端基线是 `0.57.40`，所以新的候选应为 `0.57.41`；历史 `0.57.39/0.57.40` 绝不复用或覆盖。业务文件只带明确列出的解析页修复和发布链修复，历史 ZIP、clone 和 worktree 保留并只读封存。

实际远端发布仍必须通过 `gh` 创建并确认合并 PR，PR 的 base 也必须持续是 `main`，不能直接 push `main`。保护规则只要求 `release-gate` 检查，不强制人工审批，这样闸门可以在检查通过后自动合并；强推和删除仍被禁止。封存清单在共享发布锁内更新，恢复时会把 `-Publish/-Preview/-DeployCloud` 意图写回持久票据。如果 GitHub 主分支保护 API 因私有仓库套餐返回 403，发布器会在推送前失败关闭，保留原 context，不生成第二个版本。

正式发布和恢复都会在创建/领取队列票据之前先做一次只读主线保护预检；套餐或认证失败不会消耗 attempt，也不会留下新的 FIFO 阻塞票据。真正推送前仍在共享锁内重复校验，防止预检后保护设置被改动。
