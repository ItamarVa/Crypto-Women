@echo off
REM === Crypto Women blog watcher - START ===
REM Watches "D:\AI Projects\Crypto Women\Blog - Crypto Women" and turns any
REM document dropped into a category sub-folder into a published blog post.
REM Double-click to run in this window (live logs). Close the window to stop.

REM --- kill any existing watcher first (no duplicates) ---
echo Stopping any existing watcher...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*blog-import.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

REM --- markitdown on D: (reachable under the S4U task; the uv-tool venv in
REM     AppData\Roaming is NOT, because S4U doesn't load the roaming profile) ---
set "MARKITDOWN_BIN=D:\AI Projects\Crypto Women\tools\markitdown-venv\Scripts\markitdown.exe"

cd /d "D:\AI Projects\Crypto Women\crypto-women-site"
echo Starting Crypto Women blog CLOUD sync (pulls straight from Google Drive)...
echo Source: Google Drive folder (no login / Drive-for-Desktop needed)
echo (Close this window or run stop-watcher.bat to stop.)
echo.
node scripts\blog-import.mjs --drive
