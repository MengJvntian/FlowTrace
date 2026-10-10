param([switch]$Check)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$credentialPath = Join-Path $credentialDirectory 'dingtalk.credential.xml'
$previousId = $env:DINGTALK_CLIENT_ID
$previousSecret = $env:DINGTALK_CLIENT_SECRET
try {
    if ($Check) {
        if (-not (Test-Path -LiteralPath $credentialPath)) { Write-Output 'DingTalk: not configured'; exit 3 }
        $configuration = Import-Clixml -LiteralPath $credentialPath
    } else {
        Write-Host 'Create an internal app at https://open-dev.dingtalk.com/ . Free account access must be available.'
        Write-Host 'Permissions: Todo.Todo.Read/Write, Calendar.Event.Read/Write, Calendar.EventSchedule.Read, qyapi_addresslist_search, qyapi_get_member.'
        $clientId = Read-Host 'Client ID (AppKey)'
        if ([string]::IsNullOrWhiteSpace($clientId) -or $clientId -match '[\r\n]') { throw 'Invalid Client ID' }
        $secret = Read-Host 'Client Secret (hidden; do not send to chat)' -AsSecureString
        $credential = [System.Management.Automation.PSCredential]::new($clientId, $secret)
        if ([string]::IsNullOrWhiteSpace($credential.GetNetworkCredential().Password)) { throw 'Empty secret' }
        $selfUserId = Read-Host 'Your own organization User ID (optional; blank if unknown)'
        $configuration = [PSCustomObject]@{ Credential = $credential; SelfUserId = $selfUserId }
        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        $configuration | Export-Clixml -LiteralPath $credentialPath
    }
    $env:DINGTALK_CLIENT_ID = $configuration.Credential.UserName
    $env:DINGTALK_CLIENT_SECRET = $configuration.Credential.GetNetworkCredential().Password
    & node tools/node.js applications/dingtalk/check.js
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'Application configuration saved. Tool discovery does not verify account API permissions.'
} catch { Write-Error 'DingTalk connection failed; check local settings. No secret was printed.'; exit 1 }
finally { $env:DINGTALK_CLIENT_ID = $previousId; $env:DINGTALK_CLIENT_SECRET = $previousSecret }
