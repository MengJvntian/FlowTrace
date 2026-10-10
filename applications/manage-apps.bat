@echo off
chcp 65001 >nul
cd /d "%~dp0.."
powershell.exe -NoProfile -Command "& ([scriptblock]::Create((Get-Content -LiteralPath 'applications\manage-apps.ps1' -Raw -Encoding UTF8))) -ProjectDirectory (Get-Location).Path"
pause
