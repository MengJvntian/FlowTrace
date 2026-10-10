param([Parameter(Mandatory=$true)][ValidateSet('notion','gitee','qq-mail')][string]$App, [switch]$Check)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$credentialPath = Join-Path $credentialDirectory ($App + '.credential.xml')
$variable = @{ notion='NOTION_TOKEN'; gitee='GITEE_MCP_TOKEN'; 'qq-mail'='QQ_MAIL_AUTH_CODE' }[$App]
$previousValue = [Environment]::GetEnvironmentVariable($variable, 'Process')
$previousEmail = $env:QQ_MAIL_EMAIL
try {
    Set-Location -LiteralPath $projectDirectory
    if ($Check) {
        if (-not (Test-Path -LiteralPath $credentialPath)) { Write-Host 'Account is not connected. Run this application connect.bat first.'; exit 3 }
        $configuration = Import-Clixml -LiteralPath $credentialPath
    } else {
        $url = @{ notion='https://www.notion.so/profile/integrations'; gitee='https://gitee.com/profile/personal_access_tokens'; 'qq-mail'='https://mail.qq.com/' }[$App]
        Write-Host ('Create your token in your browser: ' + $url)
        Write-Host 'Notion: grant the connection access to a dedicated test page in Content access.'
        Write-Host 'Input is hidden. Do not send the token in chat.'
        $secret = Read-Host 'Token (without Bearer prefix)' -AsSecureString
        $account = if ($App -eq 'qq-mail') { Read-Host 'QQ Mail address (not QQ number)' } else { $App }
        $credential = [System.Management.Automation.PSCredential]::new($account, $secret)
        $configuration = [PSCustomObject]@{ Credential = $credential }
    }
    $plain = $configuration.Credential.GetNetworkCredential().Password
    if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '[\r\n]' -or $plain -match '^Bearer\s') { throw 'Invalid token format' }
    [Environment]::SetEnvironmentVariable($variable, $plain, 'Process')
    if ($App -eq 'qq-mail') { $env:QQ_MAIL_EMAIL = $configuration.Credential.UserName }
    $plain = $null
    & node tools/node.js applications/_shared/check-final-batch.js $App
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (-not $Check) {
        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        $temporaryPath = $credentialPath + '.tmp'
        $configuration | Export-Clixml -LiteralPath $temporaryPath
        Move-Item -LiteralPath $temporaryPath -Destination $credentialPath -Force
        & node tools/node.js applications/_shared/prepare-final-batch.js select $App
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    Write-Host 'Connection check completed. No business writes or browser windows were started.'
    Write-Host 'Run applications/reload.bat to load the selected application, then check Gateway readiness before binding Agent routes.'
} catch {
    Write-Host 'Connection failed. Check token, permissions, network, and the application README. No secret was printed.'
    exit 1
} finally { [Environment]::SetEnvironmentVariable($variable, $previousValue, 'Process'); $env:QQ_MAIL_EMAIL = $previousEmail }
