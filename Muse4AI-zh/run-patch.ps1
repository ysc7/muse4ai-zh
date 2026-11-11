param([switch]$Quiet, [switch]$Force)
# Muse4AI 汉化 - 运行补丁（优先使用系统 Node.js，没有则借用 Muse4AI.exe 自带的 Node 运行时）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $env:LOCALAPPDATA 'Programs\Muse4AI'
$logFile = Join-Path $here 'patch.log'

function Notify([string]$text, [string]$icon = 'Info') {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $n = New-Object System.Windows.Forms.NotifyIcon
    $n.Icon = [System.Drawing.SystemIcons]::Information
    $n.Visible = $true
    $n.ShowBalloonTip(10000, 'Muse4AI 汉化', $text, $icon)
    Start-Sleep -Seconds 10
    $n.Dispose()
  } catch {}
}

$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
else {
  $ver = (Get-Content (Join-Path $root 'current.txt') -Raw).Trim()
  $node = Join-Path $root "app-$ver\Muse4AI.exe"
  $env:ELECTRON_RUN_AS_NODE = '1'
}
$pargs = @((Join-Path $here 'patch.js'))
if ($Force) { $pargs += '--force' }

$out = (& $node @pargs 2>&1 | Out-String)
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Add-Content -Path $logFile -Value ("[{0}]`r`n{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $out.Trim()) -Encoding UTF8

$status = $null
if ($out -match '@@STATUS (\{.*\})') { $status = $Matches[1] | ConvertFrom-Json }
if (-not $Quiet) {
  $out -split "`r?`n" | Where-Object { $_ -notmatch '^@@STATUS' -and $_.Trim() } | ForEach-Object { Write-Host $_ }
}

if ($Quiet -and $status) {
  if ($status.status -eq 'patched') {
    $running = Get-Process Muse4AI -ErrorAction SilentlyContinue
    if ($running) { Notify ("检测到新版本 {0}，汉化已自动完成。完全退出 Muse4AI（托盘图标 → 退出）再打开即可生效。" -f $status.version) }
  } elseif ($status.status -eq 'error') {
    Notify ("自动汉化失败：{0}" -f $status.message) 'Warning'
  }
}
if ($status -and $status.status -eq 'error') { exit 2 }
exit 0
