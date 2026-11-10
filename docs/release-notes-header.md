> [!IMPORTANT]
> **Windows 11「智能应用控制」用户请先读这里。** 本包目前没有代码签名，开启智能应用控制的机器会拦截
> `Start.bat`、`pythonw.exe` 或 `*.pyd`，提示「智能应用控制已阻止可能不安全的文件/应用」。
>
> - 解压前先右键 ZIP → 属性 → 勾选「解除锁定」，再解压；
> - 已经解压过：在解压目录打开 PowerShell，执行
>   `Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Unblock-File`；
> - 或者改用 `Expand-Archive` / `tar -xf` 解压（不会带上 Internet 标记）；
> - 如果提示变成「已阻止可能不安全的应用」，说明 SAC 拦的是未签名程序：SAC 没有白名单，
>   只能在「设置 → 隐私和安全性 → Windows 安全中心 → 应用和浏览器控制 → 智能应用控制」里关闭它，
>   或等待签名版。
>
> 完整排查步骤与签名进度：<https://github.com/PiDesign-314/ReadPI/blob/main/docs/SMART-APP-CONTROL.md>

> [!NOTE]
> **启动方式：未签名版请双击 `Start.bat`。** 包内也提供 `BabelDOC Studio.exe`，它和 `Start.bat`
> 启动的是同一个应用；但未签名的 exe 在 Windows 11 智能应用控制下更容易被按「未签名应用」拦截，
> 所以当前版本仍以 `Start.bat` 作为首选入口。等代码签名配置完成后，会改为直接双击
> `BabelDOC Studio.exe`（签名的 exe 才能降低 SAC / SmartScreen 的拦截概率）。
