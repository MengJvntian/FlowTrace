param([string]$ProjectDirectory)
$ErrorActionPreference = 'Stop'
if (-not $ProjectDirectory) { $ProjectDirectory = Split-Path -Parent $PSScriptRoot }
Set-Location -LiteralPath $projectDirectory
$statusLabels = @{ verified = '支持接入'; 'acceptance-in-progress' = '暂不可用'; 'code-ready' = '暂不可用'; planned = '待开发'; 'pending-free-check' = '待核对免费范围'; 'excluded-paid' = '需付费，已移出目标'; 'excluded-enterprise' = '需企业认证，已跳过' }
while ($true) {
    $catalogJson = & node tools/node.js tools/application-catalog.js list
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $applications = ConvertFrom-Json -InputObject ($catalogJson -join "`n")
    for ($index = 0; $index -lt $applications.Count; $index++) {
        $application = $applications[$index]
        $statusLabel = if ($statusLabels.ContainsKey($application.status)) { $statusLabels[$application.status] } else { $application.status }
        $enabledLabel = if ($application.enabled) { '允许加载' } else { '已停用' }
        Write-Host (('{0}. {1} [{2}] {3}' -f ($index + 1), $application.name, $statusLabel, $enabledLabel))
    }
    Write-Host '输入应用编号，G 绑定 Agent 网关入口，C 检查 Agent 路由，M 强制监控开关，Q 退出。查看列表不会打开浏览器。'
    $selection = Read-Host '选择应用'
    if ($selection -eq 'q') { break }
    if ($selection -eq 'm') {
        & node tools/node.js bin/monitoring-mode.js status
        Write-Host '1=开启强制监控  2=关闭强制监控  3=安装开关路由  0=返回'
        $modeChoice = Read-Host '选择'
        if ($modeChoice -eq '1') { & node tools/node.js bin/monitoring-mode.js on }
        elseif ($modeChoice -eq '2') { & node tools/node.js bin/monitoring-mode.js off }
        elseif ($modeChoice -eq '3') { & (Join-Path $projectDirectory 'applications/agent-routing/install-switch.bat') }
        continue
    }
    if ($selection -eq 'g') { & (Join-Path $projectDirectory 'applications/agent-routing/bind.bat'); continue }
    if ($selection -eq 'c') { & (Join-Path $projectDirectory 'applications/agent-routing/check.bat'); continue }
    $selectedIndex = 0
    if (-not [int]::TryParse($selection, [ref]$selectedIndex) -or $selectedIndex -lt 1 -or $selectedIndex -gt $applications.Count) { continue }
    $application = $applications[$selectedIndex - 1]
    Write-Host '1=查看教程  2=绑定账户  3=检查连接  4=启用  5=停用  0=返回'
    $operation = Read-Host '选择操作'
    if ($operation -eq '1') {
        Get-Content -LiteralPath (Join-Path $application.folder 'README.md') -Encoding UTF8 | Out-Host
    } elseif ($operation -in @('2', '3')) {
        $entryName = if ($operation -eq '2') { 'connect.bat' } else { 'check.bat' }
        $entryPath = Join-Path $application.folder $entryName
        if (Test-Path -LiteralPath $entryPath) { & $entryPath } else { Write-Host '尚未提供此入口，请先查看教程。' }
    } elseif ($operation -in @('4', '5')) {
        $mode = if ($operation -eq '4') { 'enable' } else { 'disable' }
        & node tools/node.js tools/application-catalog.js $mode $application.id
    }
    Write-Host '修改后双击 applications\reload.bat 重载；账户凭据和历史记录保留。'
}
