<#
.SYNOPSIS
    审计或签名 Windows 免安装包里的全部 PE 文件（exe / dll / pyd）。

.DESCRIPTION
    Windows 11 的「智能应用控制」(Smart App Control, SAC) 只放行两类可执行文件：
    微软云端能判定安全的，或带 Microsoft Trusted Root Program 里 CA 有效签名的。
    未签名的 exe / dll / pyd 在强制模式下都会被拦（CodeIntegrity 事件 3077），
    所以发布包必须整包签名，而不是只签一个启动器。

    Audit 模式（默认）只读：统计签名状态，在包目录生成 SIGNING-STATUS.txt，
    不会改动任何文件；加 -FailIfUnsigned 时存在未签名文件就以退出码 1 结束。

    Sign 模式给全部 PE 文件签名并逐个校验。优先用 signtool（需 Windows SDK），
    找不到时退回 Windows 自带的 Set-AuthenticodeSignature，所以只装证书、不装 SDK 也能签。
    证书可以来自 -Thumbprint（CurrentUser/LocalMachine 的 My 存储）或 -PfxPath + -PfxPassword。

    签名会改写文件内容，必须**先签名、再打 ZIP**（build_portable.py --sign 已经处理好顺序）。

.PARAMETER Path
    免安装包目录，例如 dist\BabelDOC-Studio-Windows-x64。

.PARAMETER Mode
    Audit（默认）或 Sign。

.PARAMETER Thumbprint
    签名证书指纹；默认读环境变量 SIGN_CERT_THUMBPRINT。

.PARAMETER PfxPath
    .pfx 证书路径；默认读环境变量 SIGN_PFX_PATH。

.PARAMETER PfxPassword
    .pfx 密码；默认读环境变量 SIGN_PFX_PASSWORD。

.PARAMETER TimestampUrl
    RFC3161 时间戳服务，默认 http://timestamp.digicert.com。

.PARAMETER BatchSize
    用 signtool 时每次传多少个文件，默认 20（避免命令行过长）。

.PARAMETER Resign
    已经有效签名的文件也重新签名（默认跳过，节省时间）。

.PARAMETER FailIfUnsigned
    Audit 模式下发现未签名文件时返回退出码 1。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign_release.ps1 `
        -Path dist\BabelDOC-Studio-Windows-x64 -Mode Audit

.EXAMPLE
    $env:SIGN_CERT_THUMBPRINT = '<证书指纹>'
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign_release.ps1 `
        -Path dist\BabelDOC-Studio-Windows-x64 -Mode Sign
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet('Audit', 'Sign')][string]$Mode = 'Audit',
    [string]$Thumbprint = $env:SIGN_CERT_THUMBPRINT,
    [string]$PfxPath = $env:SIGN_PFX_PATH,
    [string]$PfxPassword = $env:SIGN_PFX_PASSWORD,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [int]$BatchSize = 20,
    [switch]$Resign,
    [switch]$FailIfUnsigned
)

$ErrorActionPreference = 'Stop'

function Get-PeFiles {
    param([string]$Root)
    return @(
        Get-ChildItem -LiteralPath $Root -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in '.exe', '.dll', '.pyd' }
    )
}

function Get-SignatureStatus {
    param([System.IO.FileInfo[]]$Files)
    $results = @()
    foreach ($file in $Files) {
        $sig = Get-AuthenticodeSignature -LiteralPath $file.FullName
        $results += [pscustomobject]@{ Path = $file.FullName; Status = [string]$sig.Status }
    }
    return $results
}

function Find-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $roots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }
    return $null
}

function Get-CodeSigningCertificate {
    param(
        [string]$Thumbprint,
        [string]$PfxPath,
        [string]$PfxPassword
    )
    if ($Thumbprint) {
        $cert = Get-ChildItem -Path Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $Thumbprint } |
            Select-Object -First 1
        if (-not $cert) {
            throw "找不到证书指纹 $Thumbprint（已查 CurrentUser\My 和 LocalMachine\My）。"
        }
        return $cert
    }
    if ($PfxPath) {
        $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'PersistKeySet, Exportable'
        return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($PfxPath, $PfxPassword, $flags)
    }
    throw '需要证书：用 -Thumbprint，或设置 SIGN_PFX_PATH / SIGN_PFX_PASSWORD（也可以设置 SIGN_CERT_THUMBPRINT）。'
}

function Write-SigningStatus {
    param(
        [string]$Root,
        [System.IO.FileInfo[]]$Files,
        [object[]]$Statuses
    )
    $valid = @($Statuses | Where-Object { $_.Status -eq 'Valid' }).Count
    $notSigned = @($Statuses | Where-Object { $_.Status -eq 'NotSigned' }).Count
    $other = @($Statuses | Where-Object { $_.Status -notin 'Valid', 'NotSigned' }).Count
    $byExtension = $Files | Group-Object Extension | Sort-Object Name
    $extensionText = ($byExtension | ForEach-Object { "$($_.Name.TrimStart('.')) $($_.Count)" }) -join ' / '
    if ($notSigned -eq 0 -and $other -eq 0) {
        $verdict = '全部可执行文件都有有效签名。'
    } else {
        $verdict = '存在未签名/签名无效的文件：Windows 11 智能应用控制开启时会拦截本包，详见 docs/SMART-APP-CONTROL.md。'
    }
    $lines = @(
        'BabelDOC Studio - 数字签名状态',
        '================================',
        "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')",
        "目录: $Root",
        "可执行文件: $($Files.Count) 个 ($extensionText)",
        "有效签名 (Valid): $valid",
        "未签名 (NotSigned): $notSigned",
        "其他状态: $other",
        "结论: $verdict",
        '',
        'Windows 11「智能应用控制」(SAC) 在开启状态下会拦截未签名的 exe/dll/pyd。',
        '如果启动时看到「智能应用控制已阻止可能不安全的文件/应用」，请先阅读包内 README.md，',
        '或 docs/SMART-APP-CONTROL.md（https://github.com/PiDesign-314/Pi_BabelDOC-Studio/blob/main/docs/SMART-APP-CONTROL.md）。'
    )
    $statusPath = Join-Path $Root 'SIGNING-STATUS.txt'
    $lines | Out-File -FilePath $statusPath -Encoding utf8
    Write-Host "已写入签名状态：$statusPath"
    return [pscustomobject]@{ Valid = $valid; NotSigned = $notSigned; Other = $other; Total = $Files.Count }
}

$root = (Resolve-Path -LiteralPath $Path).Path
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "不是目录：$root"
}

$files = Get-PeFiles -Root $root
if ($files.Count -eq 0) {
    throw "目录里没有 exe / dll / pyd 文件：$root"
}

if ($Mode -eq 'Sign') {
    $signtool = Find-SignTool
    $cert = $null
    if (-not $signtool) {
        # 没装 Windows SDK 时退回 Windows 自带的签名 API。
        $cert = Get-CodeSigningCertificate -Thumbprint $Thumbprint -PfxPath $PfxPath -PfxPassword $PfxPassword
        Write-Host "未找到 signtool.exe，改用 Set-AuthenticodeSignature 签名。"
    } else {
        if (-not $Thumbprint -and -not $PfxPath) {
            throw '需要证书：用 -Thumbprint，或设置 SIGN_PFX_PATH / SIGN_PFX_PASSWORD（也可以设置 SIGN_CERT_THUMBPRINT）。'
        }
        Write-Host "signtool: $signtool"
        if ($Thumbprint) {
            Write-Host "证书: 指纹 $Thumbprint"
            $certOptions = @('/sha1', $Thumbprint)
        } else {
            Write-Host "证书: PFX $PfxPath"
            $certOptions = @('/f', $PfxPath)
            if ($PfxPassword) { $certOptions += @('/p', $PfxPassword) }
        }
    }

    $targets = $files
    if (-not $Resign) {
        $current = Get-SignatureStatus -Files $files
        $validPaths = @($current | Where-Object { $_.Status -eq 'Valid' } | ForEach-Object { $_.Path })
        if ($validPaths.Count -gt 0) {
            Write-Host "跳过已签名的 $($validPaths.Count) 个文件（-Resign 可强制重签）"
            $targets = @($files | Where-Object { $validPaths -notcontains $_.FullName })
        }
    }
    Write-Host "准备签名 $($targets.Count) 个文件..."

    $failed = @()
    if ($signtool) {
        for ($i = 0; $i -lt $targets.Count; $i += $BatchSize) {
            $last = [Math]::Min($i + $BatchSize - 1, $targets.Count - 1)
            $batch = @($targets[$i..$last] | ForEach-Object { $_.FullName })
            & $signtool sign /v /fd SHA256 /tr $TimestampUrl /td SHA256 @certOptions @batch
            if ($LASTEXITCODE -ne 0) {
                $failed += $batch
            }
        }
    } else {
        $index = 0
        foreach ($file in $targets) {
            $index++
            if ($index % 25 -eq 0) { Write-Host "  已签 $index / $($targets.Count)" }
            try {
                $result = Set-AuthenticodeSignature -LiteralPath $file.FullName -Certificate $cert `
                    -TimestampServer $TimestampUrl -HashAlgorithm SHA256
                if ($result.Status -ne 'Valid') {
                    $failed += $file.FullName
                }
            } catch {
                Write-Host "  签名失败：$($file.FullName) -> $($_.Exception.Message)" -ForegroundColor Yellow
                $failed += $file.FullName
            }
        }
    }

    $after = Get-SignatureStatus -Files $files
    $stillBad = @($after | Where-Object { $_.Status -ne 'Valid' })
    if ($failed.Count -gt 0 -or $stillBad.Count -gt 0) {
        Write-Host "签名失败或校验不通过的文件：$($stillBad.Count) 个" -ForegroundColor Red
        $stillBad | Select-Object -First 20 | ForEach-Object { Write-Host "  $($_.Status)  $($_.Path)" }
        exit 1
    }
    $summary = Write-SigningStatus -Root $root -Files $files -Statuses $after
    Write-Host "签名完成：$($summary.Valid) / $($summary.Total) 个文件有效。" -ForegroundColor Green
    exit 0
}

$statuses = Get-SignatureStatus -Files $files
$summary = Write-SigningStatus -Root $root -Files $files -Statuses $statuses
Write-Host ("签名统计：共 {0} 个，有效 {1}，未签名 {2}，其他 {3}" -f $summary.Total, $summary.Valid, $summary.NotSigned, $summary.Other)
if ($FailIfUnsigned -and ($summary.NotSigned -gt 0 -or $summary.Other -gt 0)) {
    Write-Host '存在未签名文件，-FailIfUnsigned 要求全部签名。' -ForegroundColor Red
    exit 1
}
exit 0
