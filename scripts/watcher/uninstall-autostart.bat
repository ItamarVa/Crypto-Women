@echo off
REM === Crypto Women blog watcher - REMOVE boot-time auto-start ===
REM Stops the watcher and removes the scheduled task. Self-elevates.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Stopping and removing the boot-time watcher task...
schtasks /End /TN "CryptoWomen Blog Watcher" >nul 2>&1
schtasks /Delete /TN "CryptoWomen Blog Watcher" /F
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*blog-import.mjs*' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } }"
echo Done - auto-start removed.
echo.
pause
