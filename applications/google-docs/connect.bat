@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
powershell.exe -NoProfile -Command "$entry='applications\_shared\connect-google.ps1'; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) $entry),[Text.Encoding]::UTF8))) -App docs"
pause
