<#
.SYNOPSIS
    在桌面创建（或刷新）BabelDOC Studio 快捷方式。
.DESCRIPTION
    默认指向 pythonw.exe + app.py，使用 web/babeldoc.ico 图标，
    工作目录设为项目根目录。项目路径变化后重新运行本脚本即可。
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

$lnkPath = Join-Path $Desktop 'BabelDOC Studio.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $Pythonw
$shortcut.Arguments = '"' + $app + '"'
$shortcut.WorkingDirectory = $root
$shortcut.Description = 'BabelDOC Studio - PDF 论文翻译'
$shortcut.WindowStyle = 1
if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Save()

Write-Host "已创建快捷方式：$lnkPath"
Write-Host "  目标：$Pythonw `"$app`""
