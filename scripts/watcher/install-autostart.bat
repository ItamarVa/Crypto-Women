@echo off
REM === Crypto Women blog watcher - INSTALL boot-time auto-start ===
REM Registers a scheduled task that runs the watcher AT STARTUP, whether or not
REM you are logged in. No password needed (S4U logon). Self-elevates for admin.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

REM --- kill any existing watcher / running task instance first ---
echo Stopping any existing watcher session...
schtasks /End /TN "CryptoWomen Blog Watcher" >nul 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*blog-import.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-blog-watcher.ps1"
set RC=%errorlevel%
echo.
if not "%RC%"=="0" (
  echo *** INSTALL FAILED (exit %RC%). Read the message above. ***
) else (
  echo *** INSTALL OK. ***
)
echo.
pause
