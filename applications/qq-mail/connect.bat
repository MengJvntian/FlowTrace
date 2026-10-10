@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -File applications\_shared\connect-final-batch.ps1 -App qq-mail
pause
