# 圈像创作微信小程序协作规则

## GitHub 立即同步

- 每次修改小程序源码、云函数、脚本或发布配置后，先完成必要的检查，再立即提交并推送：

  ```powershell
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-to-github.ps1
  ```

- 同步脚本会先拉取 `origin/main`，再提交当前修改并推送到 GitHub。
- 没有新修改时脚本安全退出，不创建空提交。
- 不依赖 Windows 定时任务，也不要等 10 分钟；改完并验证后马上运行同步脚本。
- 任何直接执行 `git commit` 的本地提交也会由仓库的 `post-commit` hook 立即推送到当前分支。
- 交付前必须确认：

  ```powershell
  git status --short --branch
  git rev-parse HEAD
  git rev-parse origin/main
  ```

  工作区应无未提交修改，且本地 `HEAD` 与 `origin/main` 一致。
- 不要提交 API Key、AppSecret、`.env` 或其他密钥。
