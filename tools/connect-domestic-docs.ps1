# Compatibility entry; canonical account script lives in applications.
param([ValidateSet('tencent-docs')][string]$App = 'tencent-docs', [switch]$Check)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'applications\tencent-docs\connect.ps1') -Check:$Check
exit $LASTEXITCODE
