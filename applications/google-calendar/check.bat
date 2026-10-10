@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
node tools/node.js applications/_shared/google-account.js calendar check
pause
