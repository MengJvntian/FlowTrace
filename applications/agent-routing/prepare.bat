@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
node tools/node.js bin/application-routing.js prepare
pause
