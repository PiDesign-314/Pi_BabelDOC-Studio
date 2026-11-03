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

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

git add -A
$pending = git status --porcelain
if ($pending) {
    git commit -m $Message | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "提交失败，请检查 git 输出。" -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "没有需要提交的改动。"
}

git push 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "已推送（直连）。"
    exit 0
}

Write-Host "直连失败，尝试代理 $Proxy ..."
git -c "http.proxy=$Proxy" -c "https.proxy=$Proxy" push 2>&1 | Out-Host
if ($LASTEXITCODE -eq 0) {
    Write-Host "已推送（通过代理）。"
    exit 0
}

Write-Host "推送失败：请检查网络、代理端口或 GitHub 凭据。" -ForegroundColor Red
exit 1
