@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."
node tools/node.js bin/application-routing.js prepare --router --manifest trace.manifest.applications.json
if errorlevel 1 goto finish
node tools/node.js bin/application-routing.js apply
if errorlevel 1 goto finish
node tools/node.js bin/application-routing.js check --manifest trace.manifest.applications.json --profile desktop --health --strict
:finish
pause
