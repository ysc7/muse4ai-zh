param([ValidateSet('install', 'uninstall', 'repatch')][string]$Action = 'install')
# Muse4AI 简体中文汉化补丁 - 安装 / 卸载 / 重新汉化
#   install   安装：打补丁 + 建立后台自动汉化 + 修正快捷方式
#   repatch   立即重新汉化（改了 zh-CN.json 或想马上应用新版本时用）
#   uninstall 卸载：删除计划任务并还原原始 app.asar
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Join-Path $env:LOCALAPPDATA 'Programs\Muse4AI'
$taskName = 'Muse4AI-ZH-AutoPatch'
$localeFile = Join-Path $env:APPDATA 'MuseStudio\ui-locale'
$installDir = Join-Path $env:LOCALAPPDATA 'Muse4AI-zh'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }

# 从仓库/任意位置运行时，先把工具复制到固定目录：计划任务需要一个稳定路径
$runtimeFiles = @('setup.ps1', 'patch.js', 'run-patch.ps1', 'auto-check.vbs', 'zh-CN.json')
if ($here.TrimEnd('\') -ine $installDir.TrimEnd('\')) {
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  foreach ($f in $runtimeFiles) {
    $dst = Join-Path $installDir $f
    # 保留用户自己改过的翻译表
    if ($f -eq 'zh-CN.json' -and (Test-Path $dst)) { continue }
    Copy-Item (Join-Path $here $f) $installDir -Force
  }
  Say "工具已安装到 $installDir" 'DarkGray'
  & (Join-Path $installDir 'setup.ps1') -Action $Action
  exit $LASTEXITCODE
}

# 找当前版本的程序
function Get-CurrentExe {
  $curFile = Join-Path $root 'current.txt'
  if (-not (Test-Path $curFile)) { return $null }
  $cur = (Get-Content $curFile -Raw).Trim()
  $exe = Join-Path $root "app-$cur\Muse4AI.exe"
  if (Test-Path $exe) { return $exe }
  $any = Get-ChildItem -Path $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'Muse4AI.exe') } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($any) { return (Join-Path $any.FullName 'Muse4AI.exe') }
  return $null
}

# 替换 app.asar 要求软件完全退出（点 X 只会缩到托盘）
function Stop-AppIfRunning {
  $procs = @(Get-Process Muse4AI -ErrorAction SilentlyContinue)
  if (-not $procs.Count) { return $true }
  Say 'Muse4AI 正在运行，需要先完全退出（点窗口的 X 只是缩到托盘）。' 'Yellow'
  $ans = Read-Host '现在自动退出 Muse4AI？[Y/n]'
  if ($ans -and $ans -notmatch '^[Yy]') { Say '请手动退出后重新运行。' 'Yellow'; return $false }
  $exe = Get-CurrentExe
  if ($exe) { Start-Process -FilePath $exe -ArgumentList '--quit' -WindowStyle Hidden -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 40; $i++) {
    if (-not @(Get-Process Muse4AI -ErrorAction SilentlyContinue).Count) { return $true }
    Start-Sleep -Milliseconds 500
  }
  Say 'Muse4AI 仍在运行，请从托盘图标 → 退出后重试。' 'Red'
  return $false
}

if (-not (Test-Path (Join-Path $root 'current.txt'))) {
  Say '没有找到已安装的 Muse4AI（%LOCALAPPDATA%\Programs\Muse4AI）。请先安装官方版本。' 'Red'
  exit 1
}

switch ($Action) {
  'install' {
    Say '== Muse4AI 简体中文汉化 ==' 'Cyan'
    Say '[1/4] 为所有已安装版本打补丁…'
    if (-not (Stop-AppIfRunning)) { exit 1 }
    & (Join-Path $here 'run-patch.ps1') -Force
    if ($LASTEXITCODE -ne 0) { Say '打补丁失败，请查看上面的提示。' 'Red'; exit 1 }

    Say '[2/4] 修正快捷方式指向当前版本…'
    $exe = Get-CurrentExe
    if ($exe) {
      $wsh = New-Object -ComObject WScript.Shell
      $icon = Join-Path (Split-Path $exe) 'resources\icon.ico'
      foreach ($lnk in @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Muse4AI.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Muse4AI.lnk'))) {
        if (Test-Path $lnk) {
          $l = $wsh.CreateShortcut($lnk)
          if ($l.TargetPath -ne $exe) { $l.TargetPath = $exe; $l.WorkingDirectory = Split-Path $exe; if (Test-Path $icon) { $l.IconLocation = "$icon,0" }; $l.Save(); Say "    已修正 $lnk" 'Green' }
        }
      }
      Say "    快捷方式指向：$exe" 'Gray'
    }

    Say '[3/4] 注册后台自动汉化（每 5 分钟 + 登录时检查新版本）…'
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f (Join-Path $here 'auto-check.vbs'))
    $triggers = @(New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
    try { $triggers += New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME" } catch {}
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    try {
      Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $triggers -Settings $settings -Description 'Muse4AI 更新后自动重新应用简体中文汉化' -Force | Out-Null
    } catch {
      # 某些系统非管理员不能用"登录时"触发器，退回只用定时触发
      Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $triggers[0] -Settings $settings -Description 'Muse4AI 更新后自动重新应用简体中文汉化' -Force | Out-Null
    }
    Say "    已创建计划任务：$taskName" 'Green'

    Say '[4/4] 把界面语言设为中文（写 en，补丁后即中文）…'
    try {
      New-Item -ItemType Directory -Force -Path (Split-Path $localeFile) | Out-Null
      Set-Content -Path $localeFile -Value 'en' -Encoding ASCII -NoNewline
    } catch {}
    Say ''
    Say '完成！打开 Muse4AI 即为中文。' 'Green'
    Say "工具目录：$installDir（可删除仓库文件夹，但不要删这个目录）" 'Gray'
  }
  'repatch' {
    if (-not (Stop-AppIfRunning)) { exit 1 }
    & (Join-Path $here 'run-patch.ps1') -Force
  }
  'uninstall' {
    Say '== 卸载 Muse4AI 汉化 ==' 'Cyan'
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop; Say '已删除计划任务。' 'Green' } catch { Say '计划任务不存在（跳过）。' }
    if (-not (Stop-AppIfRunning)) { exit 1 }
    $busy = $false
    Get-ChildItem -Path $root -Directory -Filter 'app-*' -ErrorAction SilentlyContinue | ForEach-Object {
      $res = Join-Path $_.FullName 'resources'
      $orig = Join-Path $res 'app.asar.orig'
      $asar = Join-Path $res 'app.asar'
      if (Test-Path $orig) {
        try {
          if (Test-Path $asar) { Remove-Item $asar -Force }
          Move-Item $orig $asar
          Say "已还原 $($_.Name)\resources\app.asar" 'Green'
        } catch { $busy = $true; Say "无法还原 $asar（文件被占用）" 'Yellow' }
      }
      $marker = Join-Path $res '.zh-patch.json'
      if (Test-Path $marker) { try { Remove-Item $marker -Force } catch { $busy = $true } }
      $legacy = Join-Path $res 'app'   # 旧方案留下的文件夹
      if (Test-Path $legacy) { try { Remove-Item -Recurse -Force $legacy } catch { $busy = $true } }
    }
    if ($busy) { Say '部分文件未能还原，请完全退出 Muse4AI 后再运行一次。' 'Yellow' } else { Say '已恢复原版，重新打开 Muse4AI 生效。' 'Green' }
  }
}