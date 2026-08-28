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

`queued -> reserved -> prepared -> committed -> packaged -> pushed -> merged -> previewed -> deployed -> verified`

失败时记录 `failedStage` 和原 context。恢复只能继续同一个 `operationId`，不得重新占用版本；提交前失败可释放 reservation，提交后失败保留 reservation 和分支供恢复。

## 路径与来源校验

- `IncludePath` 先展开为真正的字符串数组；只兼容一次旧逗号格式。
- 拒绝空项、绝对路径、`..`、`.git`、`.worktrees`、密钥文件、逗号文件名和不存在的来源文件。
- 发布工作树始终从刚 fetch 的 `origin/main` 创建，再逐项复制来源快照。
- 旧 clone/worktree 不删除，通过封存清单标记为不可发布；其中的旧脚本也会因 canonical 路径校验而拒绝执行。

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

每个操作写独立日志 `wechat-miniapp-sync-logs/<operationId>.log`，并在外部状态目录保存 reservation/context/record。日志不得输出 token、AppSecret、环境变量或 CloudBase 原始敏感响应。

## 本次迁移

远端基线为 `0.57.7`。首次通过新闸门的发布为 `0.57.8`，业务文件只包含已确认的解析页修改和对应 smoke；同时带上本设计的发布链修复。历史 ZIP、clone 和 worktree 保留，只读封存。

执行核对时远端已被并发任务推进到 `0.57.8`，且已有对应 record；闸门拒绝重用或覆盖该版本，并把后续准备操作自动分配到全局未占用的 patch 版本。实际远端发布仍必须通过 `gh` 创建 PR，不能直接 push `main`。
