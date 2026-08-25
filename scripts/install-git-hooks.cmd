@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-git-hooks.ps1" %*
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo Git hooks 安装失败，错误码：%exitCode%
)

exit /b %exitCode%
