@echo off
chcp 65001 >nul
setlocal
if "%~1"=="" (
  echo 用法：一键刷新预览.cmd -SourcePath "发布源目录" -IncludePath "文件1,文件2"
  echo 现在预览必须明确来源和文件，避免把脏工作区误打进发布包。
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refresh-preview.ps1" %*
if errorlevel 1 (
  echo.
  echo 刷新预览失败，请查看上面的错误。
  pause
  exit /b 1
)
echo.
echo 刷新预览完成。
pause
