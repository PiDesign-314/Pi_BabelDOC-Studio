<#
.SYNOPSIS
    提交并推送到 GitHub（直连失败时自动改走本机代理）。
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\tools\push.ps1 -Message "feat: xxx"
#>
param(
    [string]$Message = "chore: update",
    [string]$Proxy = "http://127.0.0.1:7890"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

git add -A
if (git status --porcelain) {
    git commit -m $Message
} else {
    Write-Host "没有需要提交的改动。"
}

git push 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "已推送（直连）。"
    exit 0
}

Write-Host "直连失败，尝试代理 $Proxy ..."
git -c "http.proxy=$Proxy" -c "https.proxy=$Proxy" push
if ($LASTEXITCODE -eq 0) {
    Write-Host "已推送（通过代理）。"
} else {
    Write-Error "推送失败，请检查网络或 GitHub 凭据。"
    exit 1
}
