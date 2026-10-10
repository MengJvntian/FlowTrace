@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File tools\start-next-apps.ps1 -RequireRoutes
pause
