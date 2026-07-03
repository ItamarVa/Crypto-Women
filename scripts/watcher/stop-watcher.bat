@echo off
REM === Crypto Women blog watcher - STOP ===
REM Stops the running watcher (whether started manually or by the boot task).
REM This does NOT remove the boot task - to disable auto-start at boot as well,
REM run uninstall-autostart.bat.

echo Stopping Crypto Women blog watcher...

REM End the scheduled-task instance if it is running (ignore if not installed).
schtasks /End /TN "CryptoWomen Blog Watcher" >nul 2>&1

REM Kill any watcher processes (node running blog-import.mjs).
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*blog-import.mjs*' }; if ($p) { $p | ForEach-Object { Write-Host ('Stopping PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force } } else { Write-Host 'No watcher process was running.' }"

echo Done.
pause
