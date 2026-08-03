@echo off
REM Double-click to open the live Breadwright 3PL /Test SFTP watcher.
cd /d "%~dp0"
start "" http://localhost:4599
node sftp-check.js
pause
