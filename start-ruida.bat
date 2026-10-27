@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 set "PATH=%LOCALAPPDATA%\Programs\cursor\resources\app\resources\helpers;%PATH%"
node server.js --open
if errorlevel 1 pause
