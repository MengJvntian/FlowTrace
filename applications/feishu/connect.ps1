param([switch]$Check, [switch]$LoginOnly, [ValidateSet('https://open.feishu.cn', 'https://open.larksuite.com')][string]$Domain = 'https://open.feishu.cn')
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$credentialPath = Join-Path $credentialDirectory 'feishu.credential.xml'
$previousId = $env:FEISHU_APP_ID
$previousSecret = $env:FEISHU_APP_SECRET
$previousDomain = $env:FEISHU_DOMAIN
try {
    Set-Location -LiteralPath $projectDirectory
    if ($Check -or $LoginOnly) {
        if (-not (Test-Path -LiteralPath $credentialPath)) { Write-Output 'Feishu: not configured. Run connect-feishu.bat.'; exit 3 }
        $configuration = Import-Clixml -LiteralPath $credentialPath
    } else {
        Write-Host 'Set OAuth redirect URL: http://localhost:3000/callback'
        Write-Host 'Enable user scopes offline_access, docx:document and bitable:app; publish the app for your account.'
        $appId = Read-Host 'Feishu App ID'
        if ($appId -notmatch '^cli_[A-Za-z0-9]+$') { throw 'Invalid App ID' }
        $appSecret = Read-Host 'App Secret (hidden input; do not send to chat)' -AsSecureString
        $credential = [System.Management.Automation.PSCredential]::new($appId, $appSecret)
        if ([string]::IsNullOrWhiteSpace($credential.GetNetworkCredential().Password)) { throw 'Empty secret' }
        $configuration = [PSCustomObject]@{ Domain = $Domain; Credential = $credential }
        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        $configuration | Export-Clixml -LiteralPath $credentialPath
    }
    $env:FEISHU_APP_ID = $configuration.Credential.UserName
    $env:FEISHU_APP_SECRET = $configuration.Credential.GetNetworkCredential().Password
    $env:FEISHU_DOMAIN = $configuration.Domain
    if ($Check) { & node tools/node.js tools/feishu-mcp.js check } else {
        Write-Host 'Opening Feishu authorization once. Complete it in the browser within 60 seconds.'
        & node tools/node.js tools/feishu-mcp.js login
    }
    if ($LASTEXITCODE -ne 0) { Write-Output 'Connection is not complete. Check app scopes, publishing and callback URL; rerun connect-feishu.bat.'; exit $LASTEXITCODE }
    Write-Output 'Feishu connected. Business reads/writes will be tested through Gateway separately.'
} catch {
    Write-Error 'Feishu connection failed. Check local inputs, app settings and network; no secret was printed.'
    exit 1
} finally {
    $env:FEISHU_APP_ID = $previousId
    $env:FEISHU_APP_SECRET = $previousSecret
    $env:FEISHU_DOMAIN = $previousDomain
}
