@echo off
cd /d "%~dp0.."
powershell.exe -NoProfile -File tools\start-next-apps.ps1 -Restart
pause
