@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Install Node.js 24 or newer and reopen this window.
  pause
  exit /b 2
)
if not exist "node_modules\@modelcontextprotocol\client\package.json" (
  echo ERROR: Run npm.cmd ci in this folder before starting.
  pause
  exit /b 2
)
node tools\node.js bin\serve.js --stop %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" pause
exit /b %RC%
