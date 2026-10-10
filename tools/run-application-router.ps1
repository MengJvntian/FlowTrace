param([Parameter(Mandatory=$true)][string]$App, [Parameter(Mandatory=$true)][ValidateSet('codex','dsh')][string]$Agent, [Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
# No credential load, OAuth, service start, or browser is needed for initialization.
& node tools/node.js bin/application-router.js --app $App --agent $Agent --manifest $Manifest
exit $LASTEXITCODE
