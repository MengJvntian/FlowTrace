@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File applications\feishu\connect.ps1
pause
