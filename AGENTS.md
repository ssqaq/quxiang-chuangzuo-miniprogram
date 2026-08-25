# 圈像创作微信小程序协作规则

## GitHub 立即同步

- 每次修改小程序源码、云函数、脚本或发布配置后，先完成必要的检查，再立即提交并推送：

  ```powershell
  & .\scripts\sync-to-github.ps1 -IncludePath @(
    "本次修改的文件1",
    "本次修改的文件2"
  )
  ```

- 同步脚本会先获取独占发布锁、拉取 `origin/main`，再只提交 `-IncludePath` 明确指定的文件并推送。
- 禁止使用 `git add -A`；未显式列出的并行修改不会进入暂存区或发布包。
- 打包前后会校验 HEAD、暂存 tree SHA 和工作区状态；发现并行任务插入后立即停止。
- 并行任务必须在独立分支或 worktree 开发；`main` 直接提交会被 `pre-commit` hook 拒绝。
- 换电脑或新克隆仓库后，先执行 `.\scripts\install-git-hooks.cmd` 一键安装 hooks；已有自定义 `core.hooksPath` 时必须明确使用 `-Force`。
- 有新修改时会先运行发布包检查并生成 `D:\aips小程序\wechat-miniapp-release-v版本.zip`；
  打包失败会停止提交和推送，不把未验证的修改推上去。
- 自动提交标题会按修改范围生成，例如“页面 2、脚本 1、配置 1”，提交正文会列出文件摘要和暂存 tree SHA。
- 没有新修改时脚本安全退出，不创建空提交。
- 不依赖 Windows 定时任务，也不要等 10 分钟；改完并验证后马上运行同步脚本。
- 独立分支直接提交仍由 `post-commit` hook 推送；`main` 只能通过受控同步脚本提交和推送。
- 正式推送并核对远端 SHA 后，会在项目目录外生成 `D:\aips小程序\wechat-miniapp-release-records\release-v版本-提交号.json`，记录版本、commit、tree、源码指纹、包 SHA256、包大小和变更文件。
- 交付前必须确认：

  ```powershell
  git status --short --branch
  git rev-parse HEAD
  git rev-parse origin/main
  ```

  工作区应无未提交修改，且本地 `HEAD` 与 `origin/main` 一致。
- 不要提交 API Key、AppSecret、`.env` 或其他密钥。
