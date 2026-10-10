@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
node tools/node.js bin/monitoring-mode.js on
pause
