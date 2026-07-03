@echo off
REM === Crypto Women blog watcher - INSTALL boot-time auto-start ===
REM Registers a scheduled task that runs the watcher AT STARTUP, whether or not
REM you are logged in. You will be asked once for your Windows password (Windows
REM stores it for the task). Must run as Administrator - it self-elevates below.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-blog-watcher.ps1"
echo.
pause
