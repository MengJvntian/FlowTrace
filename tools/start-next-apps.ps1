# Load only this user's saved credentials. No OAuth or client configuration changes.
param([switch]$Restart, [switch]$NoOpen, [switch]$KeepAlive, [switch]$RequireRoutes, [switch]$Foreground, [switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectDirectory
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$previousEnvironment = @{}
function Set-SessionVariable([string]$Name, [string]$Value) {
    if (-not $previousEnvironment.ContainsKey($Name)) { $previousEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}
try {
    $manifest = Get-Content -LiteralPath 'trace.manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $entries = @($manifest.upstreams | Where-Object { $_.upstreamApp -like 'mock-*' })
    $disabled = @()
    if (Test-Path -LiteralPath 'applications/preferences.json') {
        $disabled = @((Get-Content -LiteralPath 'applications/preferences.json' -Raw -Encoding UTF8 | ConvertFrom-Json).disabled)
    }
    foreach ($folder in Get-ChildItem -LiteralPath 'applications' -Directory) {
        $moduleFile = Join-Path $folder.FullName 'application.json'
        if (-not (Test-Path -LiteralPath $moduleFile)) { continue }
        $module = Get-Content -LiteralPath $moduleFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $module.upstream -or $module.id -in $disabled -or $module.status -like 'excluded-*') { continue }
        $credentialName = if ($module.id -eq 'github') { 'github-readonly' } else { $module.id }
        $credentialFile = Join-Path $credentialDirectory ($credentialName + '.credential.xml')
        $connected = $false
        if ($module.id -like 'google-*') {
            $app = $module.id.Substring(7)
            $accountDirectory = Join-Path $env:USERPROFILE ('.google_workspace_mcp/credentials-' + $app)
            if (Test-Path -LiteralPath $accountDirectory) {
                $accounts = @(Get-ChildItem -LiteralPath $accountDirectory -Filter '*.json' -File | Where-Object { $_.Name -match '^[^@\s]+@[^@\s]+\.json$' })
                if ($accounts.Count -eq 1) {
                    $account = Get-Content -LiteralPath $accounts[0].FullName -Raw | ConvertFrom-Json
                    if ($account.client_id -and $account.client_secret) {
                        Set-SessionVariable 'GOOGLE_OAUTH_CLIENT_ID' $account.client_id
                        Set-SessionVariable 'GOOGLE_OAUTH_CLIENT_SECRET' $account.client_secret
                        $connected = $true
                    }
                    $account = $null
                }
            }
        } elseif (Test-Path -LiteralPath $credentialFile) {
            $configuration = Import-Clixml -LiteralPath $credentialFile
            $credential = if ($module.id -eq 'github') { $configuration } else { $configuration.Credential }
            $secret = $credential.GetNetworkCredential().Password
            if ([string]::IsNullOrWhiteSpace($secret) -or $secret -match '[\r\n]') { throw ('Invalid saved credential: ' + $module.id) }
            switch ($module.id) {
                'github' { Set-SessionVariable 'GITHUB_MCP_TOKEN' $secret }
                'feishu' {
                    Set-SessionVariable 'FEISHU_APP_ID' $credential.UserName
                    Set-SessionVariable 'FEISHU_APP_SECRET' $secret
                    Set-SessionVariable 'FEISHU_DOMAIN' $(if ($configuration.Domain) { $configuration.Domain } else { 'https://open.feishu.cn' })
                }
                'tencent-docs' { Set-SessionVariable 'TENCENT_DOCS_TOKEN' $secret }
                'dingtalk' { Set-SessionVariable 'DINGTALK_CLIENT_ID' $credential.UserName; Set-SessionVariable 'DINGTALK_CLIENT_SECRET' $secret }
                'notion' { Set-SessionVariable 'NOTION_TOKEN' $secret }
                'gitee' { Set-SessionVariable 'GITEE_MCP_TOKEN' $secret }
                'qq-mail' { Set-SessionVariable 'QQ_MAIL_EMAIL' $credential.UserName; Set-SessionVariable 'QQ_MAIL_AUTH_CODE' $secret }
                default { throw ('Unsupported saved credential type: ' + $module.id) }
            }
            $connected = $true
            $secret = $null
            $configuration = $null
            $credential = $null
        }
        if ($connected) { $entries += $module.upstream }
    }
    $manifest.upstreams = $entries
    $selectedManifest = 'trace.manifest.applications.json'
    $json = $manifest | ConvertTo-Json -Depth 30
    [IO.File]::WriteAllText((Join-Path $projectDirectory $selectedManifest), $json, [Text.UTF8Encoding]::new($false))
    & node tools/node.js tools/application-catalog.js prepare $selectedManifest $selectedManifest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node tools/node.js bin/application-routing.js preflight --manifest $selectedManifest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($PrepareOnly) { exit 0 }
    if ($RequireRoutes) {
        & node tools/node.js bin/application-routing.js check --manifest $selectedManifest --profile desktop --strict
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if ($Restart) { & node tools/node.js bin/serve.js --stop; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
    $serveArguments = @('tools/node.js', 'bin/serve.js', '--manifest', $selectedManifest, '--timeout=90000', '--status-timeout=150000')
    if (-not $Foreground) { $serveArguments += '--mount' }
    if ($NoOpen) { $serveArguments += '--no-open' }
    if ($KeepAlive) { $serveArguments += '--keep-alive' } else { $serveArguments += '--exit-when-idle=90' }
    & node @serveArguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if ($RequireRoutes) {
        & node tools/node.js bin/application-routing.js check --manifest $selectedManifest --profile desktop --health --strict
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    exit 0
} finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
}
