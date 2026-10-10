@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File applications\github\connect.ps1 -Check
pause
