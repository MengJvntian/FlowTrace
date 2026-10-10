param([Parameter(Mandatory=$true)][ValidateSet('gmail','calendar','docs','drive','sheets')][string]$App)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$logDirectory = Join-Path (Get-Location) 'demo-data/google-data'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$connectLog = Join-Path $logDirectory ($App + '-connect.log')
$verifyLog = Join-Path $logDirectory ($App + '-verify.log')
$reloadLog = Join-Path $logDirectory ($App + '-reload.log')
$result = & cmd.exe /d /c ('node tools/node.js applications/_shared/google-account.js ' + $App + ' connect 2>"' + $connectLog + '"')
if ($LASTEXITCODE -ne 0) { Write-Host ('无法打开授权页，请查看日志：' + $connectLog); exit $LASTEXITCODE }
$configuration = $result | ConvertFrom-Json
Write-Host '正在打开 Google 授权页，请在浏览器中完成授权。'
Start-Process -FilePath $configuration.authorization_url -WindowStyle Hidden
if ($App -in @('drive', 'sheets')) {
    Read-Host '授权完成后，回到这里按回车' | Out-Null
    $verification = & cmd.exe /d /c ('node tools/node.js applications/_shared/google-account.js ' + $App + ' verify 2>"' + $verifyLog + '"')
    if ($LASTEXITCODE -ne 0) { Write-Host ('账户读取验证未通过，请查看日志：' + $verifyLog); exit $LASTEXITCODE }
    Write-Host '授权已保存，账户读取验证通过。'
    Write-Host '正在更新监控服务，通常需要约1分钟，请稍候；无需再次授权。'
    # Release the lazy OAuth callback listener before authorizing another separate app.
    & cmd.exe /d /c ('powershell.exe -NoProfile -File tools/start-next-apps.ps1 -Restart -NoOpen -KeepAlive >"' + $reloadLog + '" 2>&1')
    $reloadExit = $LASTEXITCODE
    if ($reloadExit -ne 0) {
        Write-Host '账户授权已经成功，监控服务更新失败；无需重新授权。'
        Write-Host ('请查看日志：' + $reloadLog)
        exit $reloadExit
    }
    Write-Host ($App + ' 连接完成。account_read_verified: true')
    Write-Host '可以关闭本窗口，或继续连接下一项应用。'
    exit 0
}
