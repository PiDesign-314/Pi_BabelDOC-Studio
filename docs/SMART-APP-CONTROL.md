# Windows 11「智能应用控制」拦住安装包怎么办

本页同时面向**使用者**和**维护者**。如果你只是下载了免安装包、启动时被 Windows 拦住，
直接看「一、使用者」；如果你是仓库维护者、准备发版，看「二、维护者」。

相关背景：本仓库的 Windows 免安装包是「解压即用」的绿色包，里面自带 CPython、BabelDOC、
PyMuPDF、ONNX Runtime、离线模型和字体，**没有做代码签名**。这会被 Windows 11 的
**智能应用控制（Smart App Control，下称 SAC）** 和 SmartScreen 拦截。

---

## 一、使用者：先分辨是哪一种拦截

被拦时窗口标题有两种，处理方式完全不同：

| 提示 | 是什么 | 能怎么办 |
| --- | --- | --- |
| **智能应用控制已阻止可能不安全的文件**<br>（此文件已被阻止，因为来自 Internet 的此类型文件可能存在危险） | SAC 的「文件类型 + 来自 Internet 标记」拦截，常见于双击 `Start.bat` 这类脚本 | 见「第 1 步」 |
| **智能应用控制已阻止可能不安全的应用**<br>（我们已阻止 xxx，因为无法验证其发布者） | SAC 的「未签名程序」拦截，常见于 `pythonw.exe`、`*.pyd`、`*.dll` | 见「第 2 步」 |
| 蓝色「Windows 已保护你的电脑」+「未知发布者」 | SmartScreen（不是 SAC） | 点「更多信息 → 仍要运行」即可 |

先确认自己是不是开着 SAC：

> 设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → **智能应用控制**
>
> - 显示「开启 / On」= 强制模式，会拦截；
> - 显示「评估 / Evaluation」= 只记录不拦截；
> - 显示「关闭 / Off」= 没开，说明你遇到的是 SmartScreen 或别的问题。

### 第 1 步：不要用资源管理器直接解压，或者先「解除锁定」

从浏览器下载的 ZIP 会被打上 **Mark-of-the-Web（来自 Internet 的标记）**。
用资源管理器（右键 → 全部解压缩）解压时，这个标记会**复制到解压出来的每个文件**，
于是 `Start.bat`、`pythonw.exe` 都变成「来自 Internet 的文件」，SAC 就会拦。

最省事的两个办法，任选其一：

**A. 解压前先解除 ZIP 的锁定（推荐）**

1. 在下载目录右键 `BabelDOC-Studio-Windows-x64.zip` → **属性**；
2. 在「常规」页最下方勾选 **解除锁定 / Unblock** → 确定；
3. 再解压。解压出来的文件就不会带「来自 Internet」标记。

**B. 用 PowerShell / tar 解压（这两种方式不传播标记）**

在 PowerShell 里执行（把路径换成你自己的下载路径和目标目录）：

```powershell
$zip = "$env:USERPROFILE\Downloads\BabelDOC-Studio-Windows-x64.zip"
$dst = "$env:USERPROFILE\Documents\BabelDOC-Studio"
Expand-Archive -LiteralPath $zip -DestinationPath $dst
```

或者：

```powershell
tar -xf "$env:USERPROFILE\Downloads\BabelDOC-Studio-Windows-x64.zip" -C "$env:USERPROFILE\Documents\BabelDOC-Studio"
```

然后双击解压目录里的 `Start.bat`。

**已经用资源管理器解压过了？** 用 PowerShell 把标记清掉即可（直接粘贴命令，不要保存成
`.ps1` 再运行——带标记的脚本本身也可能被拦）：

```powershell
Get-ChildItem "$env:USERPROFILE\Documents\BabelDOC-Studio" -Recurse -File -ErrorAction SilentlyContinue | Unblock-File
```

也可以只对单个文件操作：右键被拦的文件 → 属性 → 勾选「解除锁定」。

> 补充：包里的 `BabelDOC Studio.exe` 和 `Start.bat` **首次运行时会自动做这件事**（见 2.5），
> 完成后写 `.babeldoc-unblocked` 标记，之后不再扫描。所以多数用户其实不需要手动输入命令；
> 只有它们本身被 Windows 拦住、根本没机会执行时，才需要手动解锁被拦的那一个文件。

> 说明：这一步能解决「文件被阻止，因为来自 Internet」这一类提示。清掉标记后如果程序能正常
> 启动，就不需要再往下做。

### 第 2 步：提示「已阻止可能不安全的应用」时

这说明 SAC 拦的是**没有数字签名的程序**（本包里的 `pythonw.exe`、`*.pyd`、`*.dll` 都没有签名）。
SAC 的规则是：微软云端能判定安全 → 放行；否则必须有**可信 CA 的有效签名**，否则一律拦截。
而且：

- **SAC 没有白名单**，不能把本程序加进例外，也不存在「仅这一次允许」；
- 把文件拷到别的目录、改文件名都不行；
- 「更多信息 → 仍要运行」是 SmartScreen 的按钮，SAC 不给这个选项。

所以只有两条路：

**路线 1：关闭 SAC（最快，但会降低系统防护）**

> 设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制设置 → 关闭

注意：

- 关闭后本程序可以正常运行，但**整台机器**都失去了 SAC 保护；
- 早期 Windows 11 版本关闭后要重装/重置系统才能重新开启；较新的版本可以在安全中心重新打开；
- 只在你信任本程序来源（本仓库的 GitHub Releases）时这样做。

**路线 2：等签名版，或换一台没开 SAC 的机器**

本仓库正在准备代码签名（见下面「二、维护者」）。在签名版发布前，开着 SAC 的机器只能选路线 1；
也可以在另一台没开 SAC 的机器上使用，或自行从源码运行（源码运行同样需要本机已安装的
Python 和依赖，而且 PyMuPDF 等扩展模块仍然未签名，SAC 下同样可能被拦）。

---

## 二、维护者：发版前要做的事

### 2.1 现状（2026-11 的 v1.4.0 包）

在 `dist\BabelDOC-Studio-Windows-x64` 里实测：

| 项目 | 数值 |
| --- | --- |
| 可执行文件（`.exe` / `.dll` / `.pyd`） | **390 个**（4 exe + 30 dll + 356 pyd） |
| 体积 | 约 406 MB |
| 有效签名 | **15 个**（随包附带的 VC++ 运行库、onnxruntime、tcl/tk 自带签名） |
| 未签名 | **375 个**，其中包括 `runtime\python.exe`、`pythonw.exe`、`python312.dll`、PyMuPDF 等 |

> 新构建会额外生成一个 `BabelDOC Studio.exe`（见 2.5），所以之后的包是 391 个 PE。

SAC 在**强制模式**下会拦截未签名的 exe，**也会拦截被进程加载的未签名 `.pyd` / `.dll`**
（CodeIntegrity 事件 3077；同类案例见 FreeCAD 的
[#33975](https://github.com/FreeCAD/FreeCAD/issues/33975)：只签了 `bin\`，`lib\*.pyd` 未签，SAC 下
FreeCAD 直接起不来）。所以只签一个启动器没有意义，必须**签全量**。

另外，当前构建用的 CPython 来自未签名的发行版（`CompanyName` 是 Python Software Foundation，
但 Authenticode 状态是 `NotSigned`，典型是 uv / python-build-standalone 的 3.12）。
用 python.org 的 CPython（GitHub Actions 的 `actions/setup-python` 就是）`python.exe` /
`pythonw.exe` 自带 PSF 签名，可以少签两个文件。

### 2.2 签名要求

- 证书必须由 **Microsoft Trusted Root Program** 里的 CA 签发；自签名/私有 CA 无效；
- SAC 不要求 EV 证书（[官方说明](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)），
  但 OV 证书即可；
- 保守选择 **RSA** 证书（ECC 在部分 Windows 版本/组件上仍有兼容性限制）；
- 用 SHA-256 + RFC3161 时间戳（`/tr <url> /td SHA256`），这样证书过期后旧包仍然有效；
- **先签名、再打 ZIP**；签名后重新算 SHA-256 并更新 `.sha256` 文件；
- 所有会执行的 PE 都要签：`*.exe`、`*.dll`、`*.pyd`（本项目约 390 个，别漏 `runtime\Lib\site-packages`
  里的扩展模块、`DLLs` 目录，以及新加的 `BabelDOC Studio.exe`）。

### 2.3 证书渠道

| 渠道 | 成本 | 适用性 |
| --- | --- | --- |
| [SignPath Foundation](https://signpath.org/) | 开源项目免费 | 需要 OSI 认可的开源许可证、公开仓库、GitHub Actions 构建；证书由 SignPath 托管，按构建产物签名 |
| [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)（现名 Artifact Signing） | 约 $9.99/月 | 个人 Public Trust 目前仅限美国/加拿大；组织需要可验证的 3 年历史；支持批量签名，适合 390+ 个文件 |
| 商业 OV 代码签名证书（Sectigo / DigiCert / Certum 等） | 约 ¥1500–3500/年 | 通用，但通常配硬件令牌或云 HSM，CI 里要额外配置 |
| [Certum 开源代码签名](http://certumcodesign.cn/shop/product/open-source-code-signing-cloud/) | €329/年；Star > 1k 的优秀开源项目可免费申请 | 需要项目使用开源许可证；免费档还要求 GitHub 托管、至少一个 Release、申请人中国国籍 |

> 本仓库目前**没有 `LICENSE` 文件**；如果想走 SignPath Foundation 或开源证书，需要先选定一个
> OSI 认可的开源许可证（例如 MIT / Apache-2.0）并加进仓库。这是维护者/权利人才能做的决定。

### 2.4 仓库里已有的工具

```powershell
# 只审计：统计签名状态，并在包目录生成 SIGNING-STATUS.txt（不改动任何文件）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign_release.ps1 `
  -Path dist\BabelDOC-Studio-Windows-x64 -Mode Audit

# 真正签名（证书指纹方式）
$thumb = '你的证书指纹'
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign_release.ps1 `
  -Path dist\BabelDOC-Studio-Windows-x64 -Mode Sign -Thumbprint $thumb

# 或者 PFX 方式
$env:SIGN_PFX_PATH = 'D:\codesign.pfx'
$env:SIGN_PFX_PASSWORD = '证书密码'
powershell -NoProfile -ExecutionPolicy Bypass -File tools/sign_release.ps1 `
  -Path dist\BabelDOC-Studio-Windows-x64 -Mode Sign
```

构建时一步到位（先签名再打 ZIP，签名不成功会直接失败）：

```powershell
$env:SIGN_CERT_THUMBPRINT = '<证书指纹>'
python tools/build_portable.py --sign
```

没有装 Windows SDK（没有 `signtool.exe`）也能签：脚本会自动退回 Windows 自带的
`Set-AuthenticodeSignature`，同样支持证书指纹、PFX 和 RFC3161 时间戳（已用自签名证书验证过
签名 + 时间戳流程；自签名证书的校验结果会是 `UnknownError`，原因是根证书不受信任，属正常）。
正式签名请用可信 CA 的证书，校验结果才会是 `Valid`。

GitHub Actions 里配置仓库 Secrets `SIGN_PFX_BASE64`（证书的 base64）和 `SIGN_PFX_PASSWORD`
之后，`portable.yml` 会先导入证书，再用 `--sign` 构建；没有配置时仍打未签名包，但发布说明顶部
会带上 SAC 提醒。

### 2.5 启动入口：`BabelDOC Studio.exe` 与 `Start.bat`

`.bat` 没法签名，带「来自 Internet」标记时 SAC 仍可能按「来自 Internet 的此类型文件」拦截。
所以免安装包现在同时提供两个入口：

- **`BabelDOC Studio.exe`**：由 `tools/launcher/Launcher.cs` 编译出来的小启动器（约 81 KB），
  只负责以 `runtime\pythonw.exe -s app.py` 启动应用，需要 Windows 自带的 .NET Framework 4.x。
  `build_portable.py` 用系统自带的 `csc.exe` 编译它，签名时和运行时一起签。
- **`Start.bat`**：保留给旧环境，或 exe 暂时被拦时的后备入口。

**自动解除锁定**：两个入口首次运行时都会尽力删除包内所有文件的 `Zone.Identifier`
（启动器用 `DeleteFile("<file>:Zone.Identifier")`，Start.bat 调用 PowerShell 的 `Unblock-File`），
完成后在包目录写 `.babeldoc-unblocked` 标记，之后启动跳过扫描。这样用户通常不用再手动执行
`Unblock-File`。限制：如果 Windows 在启动器/脚本启动**之前**就把它们拦住，这段代码没有机会执行，
仍需手动解锁被拦的那一个文件，或等签名版。

签名版发布后，用户直接双击 `BabelDOC Studio.exe` 就能通过 SAC；在签名版之前，用户仍可用
「解除锁定 / 用 PowerShell 解压」清掉脚本层标记（见第一节第 1 步），然后双击 `Start.bat` 使用。
未签名版本不建议把 `BabelDOC Studio.exe` 作为首选入口：它是全新的未签名 exe，比「无 Internet
标记的脚本」更容易被 SAC 按「未签名应用」拦下。

### 2.6 验证

```powershell
# 每个文件都应返回 Valid
Get-AuthenticodeSignature (Get-ChildItem dist\BabelDOC-Studio-Windows-x64 -Recurse -File -Include *.exe,*.dll,*.pyd) |
  Group-Object Status | Select-Object Name,Count

# signtool 校验
signtool verify /pa /v dist\BabelDOC-Studio-Windows-x64\runtime\pythonw.exe
```

在开着 SAC 的机器上复测：

- 事件查看器 → 应用程序和服务日志 → Microsoft → Windows → **CodeIntegrity** → Operational；
- 事件 **3077** = 强制模式拦截（会写明被拦文件），**3076** = 评估模式记录；
- 相关 3089 事件可看签名被拒原因（`VerificationError`）。

---

## 参考

- [Smart App Control 概述（Microsoft Learn）](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)
- [Smart App Control 常见问题（Microsoft Support）](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)
- [Test your app's signature with Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)
- [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [FreeCAD #33975：只签部分二进制导致 SAC 拦截 `lib\*.pyd`](https://github.com/FreeCAD/FreeCAD/issues/33975)
- [Microsoft Q&A：locally built application blocked by SAC (error 4551 / event 3077)](https://learn.microsoft.com/en-za/answers/questions/6039272/supported-way-to-run-a-locally-built-application-w)
