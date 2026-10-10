@echo off
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File applications\dingtalk\connect.ps1
pause
