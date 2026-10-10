# Compatibility entry; canonical account script lives in applications.
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'applications\feishu\connect.ps1') @args
exit $LASTEXITCODE
