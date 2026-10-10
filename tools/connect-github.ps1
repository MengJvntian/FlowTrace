# Compatibility entry; canonical account script lives in applications.
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'applications\github\connect.ps1') @args
exit $LASTEXITCODE
