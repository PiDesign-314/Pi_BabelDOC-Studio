<#
.SYNOPSIS
    在桌面创建（或刷新）BabelDOC Studio 快捷方式。
.DESCRIPTION
    默认指向 pythonw.exe + app.py，使用 web/babeldoc.ico 图标，
    工作目录设为项目根目录。项目路径或图标变化后重新运行本脚本即可；
    已存在的桌面 / 开始菜单 / 任务栏固定快捷方式会一起刷新，并清理图标缓存。
#>
[CmdletBinding()]
param(
    [string]$Desktop = [Environment]::GetFolderPath('Desktop'),
    [string]$Pythonw = 'D:\Develop\Python\pythonw.exe'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app.py'
$icon = Join-Path $root 'web\babeldoc.ico'

if (-not (Test-Path -LiteralPath $app))  { throw "找不到 $app" }
if (-not (Test-Path -LiteralPath $Pythonw)) {
    $candidate = Join-Path (Split-Path -Parent (Get-Command python.exe).Source) 'pythonw.exe'
    if (Test-Path -LiteralPath $candidate) { $Pythonw = $candidate }
    else { throw "找不到 pythonw.exe，可用 -Pythonw 指定路径" }
}

$shell = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path $Desktop 'BabelDOC Studio.lnk'

$targets = New-Object System.Collections.Generic.List[string]
$targets.Add($lnkPath)
$extra = @(
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\BabelDOC Studio.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\BabelDOC Studio.lnk')
)
foreach ($path in $extra) {
    if (Test-Path -LiteralPath $path) { $targets.Add($path) }
}

foreach ($path in $targets) {
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $Pythonw
    $shortcut.Arguments = '"' + $app + '"'
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = 'BabelDOC Studio - PDF 论文翻译'
    $shortcut.WindowStyle = 1
    if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
    $shortcut.Save()
    Write-Host "已刷新快捷方式：$path"
}

# Windows caches shortcut icons; ask the shell to rebuild them so the new
# artwork shows up without logging out.
$ie4 = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
if (Test-Path -LiteralPath $ie4) {
    try { Start-Process -FilePath $ie4 -ArgumentList '-show' -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue } catch {}
}

Write-Host "  目标：$Pythonw `"$app`""
Write-Host "  图标：$icon"
