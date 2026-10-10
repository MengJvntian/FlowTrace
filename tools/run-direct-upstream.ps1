param([Parameter(Mandatory=$true)][string]$App, [Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
try {
    Set-Location -LiteralPath $projectDirectory
    # Only the requested account is loaded, only after explicit OFF fallback.
    if ($App -like 'google-*') {
        $serviceName = @{ 'google-gmail'='gmail'; 'google-calendar'='calendar'; 'google-docs'='docs'; 'google-drive'='drive'; 'google-sheets'='sheets' }[$App]
        if (-not $serviceName) { throw 'Unknown Google application' }
        $credentialDirectory = Join-Path $env:USERPROFILE ('.google_workspace_mcp/credentials-' + $serviceName)
        $accountFiles = @(Get-ChildItem -LiteralPath $credentialDirectory -Filter '*.json' | Where-Object { $_.Name -match '^[^@\s]+@[^@\s]+\.json$' })
        if ($accountFiles.Count -ne 1) { throw 'Expected one existing account' }
        $configuration = Get-Content -LiteralPath $accountFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $configuration.token -and -not $configuration.refresh_token) { throw 'Existing authorization missing' }
        $env:GOOGLE_OAUTH_CLIENT_ID = $configuration.client_id
        $env:GOOGLE_OAUTH_CLIENT_SECRET = $configuration.client_secret
        $configuration = $null
    } else {
        $credentialName = if ($App -eq 'github') { 'github-readonly' } else { $App }
        $credentialPath = Join-Path $env:LOCALAPPDATA ('mcp-cross-app-trace/' + $credentialName + '.credential.xml')
        $configuration = Import-Clixml -LiteralPath $credentialPath
        $credential = if ($App -eq 'github') { $configuration } else { $configuration.Credential }
        $secret = $credential.GetNetworkCredential().Password
        if ([string]::IsNullOrWhiteSpace($secret)) { throw 'Credential missing' }
        switch ($App) {
            'github' { $env:GITHUB_MCP_TOKEN = $secret }
            'tencent-docs' { $env:TENCENT_DOCS_TOKEN = $secret }
            'notion' { $env:NOTION_TOKEN = $secret }
            'gitee' { $env:GITEE_MCP_TOKEN = $secret }
            'qq-mail' { $env:QQ_MAIL_EMAIL = $credential.UserName; $env:QQ_MAIL_AUTH_CODE = $secret }
            'feishu' { $env:FEISHU_APP_ID = $credential.UserName; $env:FEISHU_APP_SECRET = $secret; $env:FEISHU_DOMAIN = $configuration.Domain }
            'dingtalk' { $env:DINGTALK_CLIENT_ID = $credential.UserName; $env:DINGTALK_CLIENT_SECRET = $secret }
            default { throw 'Direct fallback is not implemented for this application' }
        }
        $configuration = $null
        $credential = $null
        $secret = $null
    }
    & node tools/node.js bin/direct-upstream.js --app $App --manifest $Manifest
    exit $LASTEXITCODE
} catch { [Console]::Error.WriteLine('Direct upstream unavailable. Check the saved account configuration; no secret was printed.'); exit 3 }
