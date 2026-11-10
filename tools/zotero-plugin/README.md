# ReadPI Zotero 桥接插件

一个面向 Zotero 7–10 的 bootstrapped 插件：把 Zotero 里的本地 PDF 交给 **ReadPI**
阅读或翻译，并把 Zotero 文件夹和论文 PDF 快照同步到结果库。应用侧接收接口是
`POST /api/zotero/open`（见 [`docs/zotero-api-notes.md`](../../docs/zotero-api-notes.md) §7
与 `core/zotero.py`）。

## 功能

- **主窗口顶部图标**：点 ReadPI 图标可选「翻译 / 阅读 / 打开结果库」；
  前两项按当前文献或阅读器中的本地 PDF 可用性置灰。
- **结果库文库**：启动、文库变化和打开顶部菜单时同步 Zotero 文库快照，包含嵌套文件夹与带本地 PDF 的论文。
- **版本握手**：检查 `/api/health` 中的 `features` 是否含 `zotero`，优先连接可用新版；
  若只发现旧版，会尝试自动启动新版一次，仍不可用时说明需要关闭旧版并启动新版。

- **文献列表右键菜单**：选中一篇文献（或它的 PDF 附件）后右键 →
  「在 ReadPI 中阅读」。只有本地存在 PDF 文件时才显示；在 PDF 阅读器标签页里始终显示
  （EPUB/快照阅读器没有 PDF 可交付，仍按选中项规则判断）。
- **PDF 阅读器入口**：阅读器工具栏上的 **BabelDOC** 按钮，以及阅读器页面右键菜单里的
  「在 ReadPI 中阅读」。
- **当前页**：阅读器入口会把 `reader._state.pageIndex + 1` 一起发送（服务端 page 是 1 基）。
  读取顺序：`_state.pageIndex` → `reader._getState().pageIndex` →
  `item.getAttachmentLastPageIndex()` → 1。`_state` 是内部字段，因此每一步都有 try/catch。
- **一篇文献多个 PDF**：用 `Services.prompt.select` 弹出选择框（签名见
  `nsIPromptService.idl`，Firefox ESR 115 / Zotero 7）。如果当前平台没有该 API，
  会打开第 1 个本地 PDF，并在进度窗里明确写出「有 N 个 PDF，已打开第 1 个」，不会静默乱选。
- **应用没启动时自动启动**：读取 `launch-info.json` → 探活 `/api/health` → 依次尝试
  `launcher` → `Start.bat`（`cmd.exe /c start`）→ `pythonw app.py --server-only --port N`，
  然后轮询约 25 秒。启动失败会显示真实原因，并提供「重试」。
- **错误可见**：后端返回的 `error` / `retryable` 原样展示；可重试的错误弹
  `Services.prompt.confirmEx` 的「重试」；不可重试的（如不是 PDF）只提示原因。
- **偏好面板**：Tools → Settings → BabelDOC（启动器路径、launch-info.json 路径、端口覆盖、
  自动启动、传递当前页、连接检测）。

## 安装

1. 启动 ReadPI（它会写出 `%APPDATA%\BabelDOC-Studio\zotero\launch-info.json`）。
2. 下载插件：
   - 应用内地址：<http://127.0.0.1:8765/api/zotero/plugin.xpi>（端口以实际为准），或
   - 在仓库里构建：`python tools/build_zotero_plugin.py`，产物在
     `dist/babeldoc-zotero-1.0.6.xpi`。
3. Zotero → **Tools → Plugins** → 齿轮 → **Install Plugin From File…**，选择 xpi；
   也可以直接把 xpi 拖进 Plugins 窗口。bootstrapped 插件安装/启用后**不需要重启 Zotero**。

## 偏好设置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `extensions.babeldoc.launchInfoPath` | `""` | 自定义 launch-info.json 路径；可填文件或目录 |
| `extensions.babeldoc.appPath` | `""` | 启动器路径（`.exe` / `.bat` / 目录）；优先于 launch-info |
| `extensions.babeldoc.port` | 空 / `0` | 自动：先读 launch-info 的端口，再扫描 8765–8804（字符串保存，避免偏好类型冲突） |
| `extensions.babeldoc.autoLaunch` | `true` | 应用未运行时自动启动 |
| `extensions.babeldoc.passPage` | `true` | 把阅读器当前页传给应用 |

默认值写在插件根目录的 `prefs.js`（Zotero 7 的默认偏好文件；`defaults/preferences/` 不生效）。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 菜单不出现 | 选中的条目没有本地 PDF（未下载 / 链接文件失效）；阅读器标签页里始终出现 |
| 「ReadPI 没有响应」 | 应用没启动且自动启动失败。按提示手动启动后点「重试」；或在偏好里指定启动器路径 |
| 提示端口不对 | 端口填了非 0 值但应用换端口了：把端口改回 `0`（自动扫描 8765–8804） |
| 后端报「附件尚未下载或文件已丢失」 | 在 Zotero 里先下载 PDF（或修复链接文件），再点「重试」 |
| 后端报 `not_pdf` | 该附件不是 PDF，插件只支持 PDF |
| 提示「检测到旧版本」 | 关闭占用端口的 BabelDOC Studio 1.7.0 旧进程，启动 ReadPI 1.8.1 或更新版本 |
| 结果库没有 Zotero 文库 | 在 Zotero 打开顶部 BabelDOC 菜单触发同步，确认 PDF 附件已下载到本地 |
| 代理/防火墙拦截 127.0.0.1 | Zotero 的代理设置对 `Zotero.HTTP` 生效，把 `127.0.0.1` 加入代理例外 |

## 兼容性

- `manifest.json`：`strict_min_version` = `7.0`；`strict_max_version` = `10.*`。
  保留 7 的 DOM 菜单回退，10.x 为当前适配目标。
  Zotero 8 没有 `#zotero-itemmenu` 的稳定入口，因此启动时**能力探测**
  `Zotero.MenuManager.registerMenu`：存在就用官方 `main/library/item` 菜单 API，否则走 7 的 DOM 注入。
- 刻意不使用 Zotero 8 已移除的 API：`Zotero.spawn`、bluebird 的 `.each/.map` 实例方法、
  `Services.appShell.hiddenDOMWindow`。全部使用 `async/await` + 标准 Promise。
- Zotero 10 安装器要求非空的 HTTPS `update_url`，即使手动分发也不能省略。
  地址指向本项目仓库的 `tools/zotero-plugin/updates.json`；清单不含可自动安装的更新版本。
  现阶段请手动下载新版 XPI。
- 1.0.4 已在本机 Zotero 10.0.8 独立测试配置中加载：`isCompatible=true`、
  `isActive=true`、`appDisabled=false`，左侧 `zotero-items-toolbar` 中仅有一个图标和三项菜单。
  菜单操作、快照请求和阅读器交互由 `tests/zotero_plugin_harness.mjs` 覆盖。

## 结构

```
tools/zotero-plugin/
├── manifest.json     # applications.zotero.{id,strict_min_version,strict_max_version}
├── bootstrap.js      # 生命周期 + 菜单 + 阅读器入口 + 启动/HTTP/重试/清理（无 import/export）
├── prefs.js          # 默认偏好（Zotero 读取的默认值文件）
├── prefs.xhtml       # 偏好面板片段（XUL + html: 前缀，无 DOCTYPE）
├── prefsPane.js      # 面板逻辑（注意不叫 prefs.js，那个名字被 Zotero 占用）
├── icons/            # icon-16.svg / icon-20.png / icon-48.png / icon-96.png
└── locale/
    ├── zh-CN/babeldoc.ftl
    └── en-US/babeldoc.ftl
```

## 开发 / 测试

```powershell
# 构建 dist/babeldoc-zotero-1.0.6.xpi（内部调用 core.zotero.build_plugin_xpi）
python tools/build_zotero_plugin.py

# Mocked Zotero 环境的 Node 测试（无需安装 Zotero）
node tests/zotero_plugin_harness.mjs

# pytest 包装（node 缺失时 skip；另含 manifest/XPI 静态检查）
python -m pytest tests/test_zotero_plugin.py -q
```

`tests/zotero_plugin_harness.mjs` 用 `vm` 加载 `bootstrap.js`，mock 了 `Zotero`、
`Zotero.HTTP`、`Zotero.ProgressWindow`、`Zotero.Reader`、`Zotero.Items`、`Zotero.Prefs`、
`Services.prompt`、`Zotero.Utilities.Internal.exec`、`nsIFile` 等。它断言：

- 启动/停止的幂等性：重复 enable 不会出现第二个菜单项；shutdown 后菜单、`popupshowing`
  监听器、FTL `<link>` 和窗口引用都被清掉；
- 文献列表菜单与阅读器入口发出的 POST body（path、1 基 page、library_id/item_key/
  attachment_key、title/DOI/creators/year），以及请求参数 `errorDelayMax: 0`、
  `successCodes: false`、不带 `open_window`；
- 阅读器当前页的 4 条取数路径（Proxy 转发 / `_getState` / `getAttachmentLastPageIndex` / 默认 1）；
- 多 PDF 选择：选择第 N 个、取消、API 缺失时的回退与提示；
- 后端 404/415 的 `error` 展示、`retryable` 与 `confirmEx` 重试；
- 启动回退链（launcher → `cmd.exe /c start` bat → pythonw）、端口扫描、25 秒轮询、
  「已启动但没起来」的报错与重试；
- 偏好面板注册参数、Zotero 8 `Zotero.MenuManager` 分支。

## 已知风险与限制

1. `reader._state.pageIndex` 是内部字段：Zotero 8/9 可能改名。已做多层回退。
2. `Services.prompt.select` 在 Zotero 7（Firefox 115）的 `nsIPromptService.idl` 中存在，
   但 Zotero 自己没用到它；若未来签名变化，插件会走「第 1 个 PDF + 进度窗说明」的回退。
3. `.bat` 通过 `cmd.exe /c start` 启动；若安全软件拦截未签名 exe/bat，只能手动启动应用。
4. Zotero 8 分支（`Zotero.MenuManager`）只按 8.0 源码 + 官方文档实现，没有运行时验证。
5. 无签名 XPI：官方安装方式（拖入 Plugins）不要求签名；若策略变化需要另行分发。
