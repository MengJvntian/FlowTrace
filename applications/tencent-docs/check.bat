@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File applications\tencent-docs\connect.ps1 -Check
pause
