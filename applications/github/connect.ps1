param([switch]$Check)
$ErrorActionPreference = 'Stop'
$credentialDirectory = Join-Path $env:LOCALAPPDATA 'mcp-cross-app-trace'
$credentialPath = Join-Path $credentialDirectory 'github-readonly.credential.xml'
try {
    if ($Check) {
        if (-not (Test-Path -LiteralPath $credentialPath)) {
            Write-Output 'GitHub platform credential: not configured'
            exit 3
        }
        $credential = Import-Clixml -LiteralPath $credentialPath
    } else {
        Write-Host 'Select your own repositories to include (public and private).'
        $requestedAccount = Read-Host 'GitHub username'
        if ([string]::IsNullOrWhiteSpace($requestedAccount)) { throw 'Username is required' }
        Write-Host 'Fine-grained token: Contents = Read-only; Metadata = Read-only.'
        Write-Host 'Enter the token here. Input is hidden; do not paste it into chat.'
        $secret = Read-Host 'GitHub token' -AsSecureString
        $credential = [System.Management.Automation.PSCredential]::new($requestedAccount, $secret)
    }
    $token = $credential.GetNetworkCredential().Password
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'Empty credential' }
    $headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'FlowTrace-account-check' }
    $account = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -Method Get
    if ($account.login -ine $credential.UserName) { throw 'Credential belongs to a different account' }
    if (-not $Check) {
        New-Item -ItemType Directory -Path $credentialDirectory -Force | Out-Null
        # Windows DPAPI encrypts the SecureString for the current Windows account.
        $credential | Export-Clixml -LiteralPath $credentialPath
    }
    Write-Output ('GitHub account verified: ' + $account.login)
    Write-Output 'Credential is available to this Windows account; it was not saved in the project.'
    Write-Output 'This checks login only. README access and data-flow monitoring are tested through Gateway separately.'
} catch {
    # Do not echo response bodies or exception details containing credential data.
    Write-Error 'GitHub connection failed: check the token, account selection, expiry and network access.'
    exit 1
} finally {
    $token = $null
    if ($headers) { $headers.Clear() }
}
