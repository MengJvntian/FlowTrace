param([switch]$Check)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$credentialPath = Join-Path $credentialDirectory 'tencent-docs.credential.xml'
$previousToken = $env:TENCENT_DOCS_TOKEN
try {
    Set-Location -LiteralPath $projectDirectory
    if ($Check) {
        if (-not (Test-Path -LiteralPath $credentialPath)) { Write-Output 'Tencent Docs: not configured'; exit 3 }
        $configuration = Import-Clixml -LiteralPath $credentialPath
    } else {
        Write-Host 'Get your Token: https://docs.qq.com/open/auth/mcp.html'
        Write-Host 'Paste the Authorization value exactly as shown; no account name or app ID needed.'
        Write-Host 'Input is hidden. Do not paste the Token into chat.'
        $secret = Read-Host 'Token' -AsSecureString
        $credential = [System.Management.Automation.PSCredential]::new('tencent-docs', $secret)
        $plain = $credential.GetNetworkCredential().Password
        if ([string]::IsNullOrWhiteSpace($plain) -or $plain -match '[\r\n]') { throw 'Invalid token' }
        $configuration = [PSCustomObject]@{ Credential = $credential }
        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        $configuration | Export-Clixml -LiteralPath $credentialPath
        $plain = $null
    }
    $env:TENCENT_DOCS_TOKEN = $configuration.Credential.GetNetworkCredential().Password
    & node tools/node.js tools/check-domestic-mcp.js tencent-docs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output 'Configuration saved and tool discovery passed. Business tests run through Gateway separately.'
} catch {
    Write-Error 'Connection failed. Check local input, token permissions and network; no secret was printed.'
    exit 1
} finally { $env:TENCENT_DOCS_TOKEN = $previousToken }
