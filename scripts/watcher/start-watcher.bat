@echo off
REM === Crypto Women blog watcher - START ===
REM Watches "D:\AI Projects\Crypto Women\Blog - Crypto Women" and turns any
REM document dropped into a category sub-folder into a published blog post.
REM Double-click to run it in this window (shows live logs). Close the window
REM to stop it. For a background service that starts at boot without login,
REM run install-autostart.bat once instead.

cd /d "D:\AI Projects\Crypto Women\crypto-women-site"
echo Starting Crypto Women blog watcher...
echo Inbox: D:\AI Projects\Crypto Women\Blog - Crypto Women
echo (Close this window or run stop-watcher.bat to stop.)
echo.
node scripts\blog-import.mjs --watch
