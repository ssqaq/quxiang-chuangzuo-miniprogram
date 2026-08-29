# 圈像创作微信小程序协作规则

## 统一发布闸门

- 每次修改小程序源码、云函数、脚本或发布配置后，先完成必要的检查，再从 canonical 仓库进入统一队列。发布源可以是开发 worktree，但发布脚本只能从 `D:\aips小程序\wechat-miniapp` 调用：

  ```powershell
  PowerShell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release.ps1 `
    -SourcePath "D:\aips小程序\wechat-miniapp-publish-0578" `
    -IncludePath @(
    "本次修改的文件1",
    "本次修改的文件2"
    )
  ```

- 默认发布会准备隔离 worktree、不可变 ZIP 和 release context，然后自动推送 `release/<version>-<operationId>` 分支、创建并合并 PR；合并后自动导入微信开发者工具、打开项目窗口并触发重新编译。只想生成包和 context 时显式使用 `-PrepareOnly`，不需要开发者工具时使用 `-SkipDevTools`。正式入口会在锁内重新 fetch `origin/main`、分配全局唯一版本，不允许直推 `main`。
- `scripts/sync-to-github.ps1` 只保留旧命令兼容转发，不能绕过队列；不要从旧 clone/worktree 或临时 policy 调用发布。
- 策略文件、锁、队列、产物、reservation、context、record、日志和封存清单必须使用 `D:\aips小程序` 下的固定路径；即使目录名相同，换到别的父目录也会被拒绝。
- 禁止使用 `git add -A`；未显式列出的并行修改不会进入暂存区或发布包。
- 打包前后会校验来源快照、tree SHA、版本组和 context；发现并行任务插入、版本占用或清单漂移立即停止。
- 并行任务必须在独立分支或 worktree 开发；`main` 直接提交会被 `pre-commit` hook 拒绝。
- 换电脑或新克隆仓库后，先执行 `.\scripts\install-git-hooks.cmd` 一键安装 hooks；已有自定义 `core.hooksPath` 时必须明确使用 `-Force`。
- 正式包固定命名为 `D:\aips小程序\wechat-miniapp-release-v版本-提交号.zip`；同名不同 SHA 永远拒绝覆盖。context、reservation、record、ZIP、二维码和 CloudBase 核验必须绑定同一个 operationId、版本、commit、tree 和源码 SHA。
- 提交后任意阶段失败都保留原 context 和版本；只能用 `resume-release.ps1` 恢复，不能重新开一个版本“碰碰运气”。
- 正式发布会在创建队列票据前先做 GitHub 主线保护预检；恢复也会在领取租约前预检，套餐/认证失败不会消耗 attempt 或堵住 FIFO，锁内仍会再次复核。
- 恢复同一个 operation 默认沿用自动推送和开发者工具同步；只有要改成只准备或跳过开发者工具时，才显式带 `-PrepareOnly`/`-SkipDevTools`。恢复入口会把这些意图写回持久队列，PR 还会持续校验 base=`main`、head=`releaseCommit`。
- 不依赖 Windows 定时任务，也不要手工并行启动多个发布器；队列会按 FIFO 排队，租约和 heartbeat 会在进程崩溃后接管。
- GitHub `main` 必须是 PR-only，`release-gate` 是必需检查且管理员也受约束；保护 API 不可用时发布器在推送前失败关闭，不伪造成功。
- 正式完成并核对远端 SHA 后，会在项目目录外生成 `D:\aips小程序\wechat-miniapp-release-records\release-v版本-提交号.json`，记录版本、commit、tree、源码指纹、包 SHA256、包大小和变更文件。
- 交付前必须确认：

  ```powershell
  git status --short --branch
  git rev-parse HEAD
  git rev-parse origin/main
  ```

  只核对对应 release context、PR 合并 commit、`origin/main`、ZIP、二维码和 CloudBase 四处一致；canonical 开发工作区允许保留其他未提交修改。
- 不要提交 API Key、AppSecret、`.env` 或其他密钥。
