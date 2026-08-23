@echo off
chcp 65001 >nul
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\refresh-preview.ps1"
if errorlevel 1 (
  echo.
  echo 刷新预览失败，请查看上面的错误。
  pause
  exit /b 1
)
echo.
echo 刷新预览完成，二维码已生成到项目上级目录。
pause
