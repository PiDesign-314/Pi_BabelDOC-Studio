# 在 Zotero 中打开 ReadPI

适用版本：ReadPI **1.8.1**、Zotero 插件 **1.0.6**、Zotero **7–10**。
Zotero 10.0.8 已在独立配置中验证插件加载、顶部图标和三项菜单。
Zotero 的文献和文件夹会以只读快照显示在 Studio 结果库；PDF 原件仍由 Zotero 管理。
Zotero 10 的文件夹读取使用 `Zotero.Collections.getByLibrary(libraryID, true)`，
确保主文件夹及子文件夹都进入快照。

## 1. 它解决什么

在 Zotero 里选中一篇论文（或正开着它的 PDF），点一下「在 ReadPI 中阅读」，就能：

- 自动启动 / 唤起 ReadPI；
- 首次打开时把 PDF 接入应用（建立与 Zotero 文献、附件的关联），不用手动导出、再上传；
- 再次打开同一附件时复用已有记录：**翻译结果、笔记、批注和阅读位置都保留**；
- 从 Zotero 阅读器发起时尽量定位到当前页；从文献列表发起时回到上次读到的位置。

关联使用 **Zotero 的稳定标识**（`libraryID + itemKey + attachmentKey`，内容 SHA-256 兜底），
不依赖文件名。

## 2. 安装插件

前置条件：Zotero 7–10；ReadPI **1.8.1 或更新版本**。
先启动一次新版应用，它会写出插件需要的
`launch-info.json`，这样即使应用没开着也能被插件自动拉起。
请从 [v1.8.1 发布页](https://github.com/PiDesign-314/Pi_BabelDOC-Studio/releases/tag/v1.8.1)
下载新版 Windows 免安装包；关闭旧版进程后再启动新版，避免插件误连到旧服务。

1. 打开 ReadPI →「翻译设置」→ 拉到最底部「Zotero 集成」；
2. 点「下载插件」，得到 `babeldoc-zotero-<版本>.xpi`；
  （也可以直接访问 `http://127.0.0.1:<端口>/api/zotero/plugin.xpi`，或从仓库的
   `dist/babeldoc-zotero-1.0.6.xpi` 下载；从源码运行时可执行
   `python tools/build_zotero_plugin.py` 自行生成安装包）
3. 在 Zotero 中打开 **工具 → 插件**，点右上角齿轮 → **从文件安装…**，选择刚下载的 `.xpi`；
   也可以把 `.xpi` 直接拖进插件窗口；
4. 安装后无需重启 Zotero。右键文献列表任意一篇有本地 PDF 的文献，应能看到
   「在 ReadPI 中阅读」。

> 插件是 Zotero 的 bootstrapped 扩展，官方安装方式就是拖 `.xpi`，不需要代码签名。
> Windows 的「来自 Internet」标记不会阻止 `.xpi` 安装。

旧版 1.0.0、1.0.1 都缺少 Zotero 安装器要求的 HTTPS 更新地址；1.0.0 还限制到 `8.*`。
请安装 `dist/babeldoc-zotero-1.0.6.xpi`。插件 1.0.4 已在真实 Zotero 10.0.8 的独立配置中确认兼容；
1.0.6 沿用同一插件标识和工具栏位置，并通过插件测试验证。
更新清单不包含可自动安装的版本，现阶段使用手动安装更新。
未来 Zotero 改动接口时仍可能需要更新插件。
自定义数据目录无需改成默认目录：插件用 Zotero 的附件路径接口查找 PDF，
不硬编码 `Zotero/storage`。尚未下载的附件需要先在 Zotero 中下载。

## 3. 使用

Zotero 主窗口顶部有 **ReadPI** 图标。选中带本地 PDF 的文献或打开 PDF 阅读器后，
点击图标可选 **翻译 / 阅读 / 打开结果库**。前两项会根据当前 PDF 是否可用置灰。
「翻译」使用 Studio 已保存的翻译设置直接创建任务并打开进度页；「阅读」优先打开已有译文或双语版；
「打开结果库」直接显示 Zotero 文库、嵌套文件夹与 PDF 卡片。文献新增、移动或删除后插件会同步快照，
再次打开顶部菜单也会同步。结果库内的 Zotero 文库为只读视图，不会改动 Zotero 文件夹。
界面验证截图：[浅色](screenshots/zotero-library-light.png) · [深色](screenshots/zotero-library-dark.png)。

| 场景 | 入口 | 打开的页面 |
| --- | --- | --- |
| 文献列表 | 右键文献 →「在 ReadPI 中阅读」 | ReadPI 中上次读到的位置；已有译文时优先打开译文/双语版 |
| 选中的是附件 | 右键 PDF 附件 → 同一入口 | 同上 |
| PDF 阅读器 | 阅读器工具栏的 **ReadPI** 按钮 | Zotero 阅读器当前页 |
| PDF 页面 | 阅读器内右键 →「在 ReadPI 中阅读」 | Zotero 阅读器当前页 |
| 主窗口顶部 | ReadPI →「翻译」 | 当前 PDF 的翻译任务进度 |
| 主窗口顶部 | ReadPI →「阅读」 | 当前 PDF 的原文或已有译文/双语版 |
| 主窗口顶部 | ReadPI →「打开结果库」 | Zotero 文件夹与 PDF 卡片 |

- 选中文献有多个 PDF 附件时，会先弹出选择框，让你决定打开哪一个。
- 从阅读器发起时会传入当前页；如果 BabelDOC 里上次读的是**译文或双语版**，
  会按页码映射到对应位置（见第 5 节）。
- 翻译时可以打开结果库；在结果库或阅读器中会持续显示进度，完成后弹出提示。
  从阅读器返回结果库时会恢复之前选中的文件夹、搜索、排序和滚动位置。
- 附件尚未下载、文件丢失、应用未启动或连接失败时，插件会说明原因并给出重试方式：
  处理完问题后再点一次入口即可，已发起的打开请求会重新执行。

## 4. 数据放在哪里

| 内容 | 位置 |
| --- | --- |
| 接入的 PDF 副本 | `%APPDATA%\BabelDOC-Studio\zotero\imports\<link-id>\<原文件名>.pdf` |
| 关联记录 / 阅读位置 | `%APPDATA%\BabelDOC-Studio\zotero\links.json` |
| Zotero 文库快照 | `%APPDATA%\BabelDOC-Studio\zotero\library.json` |
| 启动信息（给插件读） | `%APPDATA%\BabelDOC-Studio\zotero\launch-info.json` |
| 批注、笔记、译文 | 与手动上传的文件完全一样，分别位于 `annotations\`、`notes\` 与应用输出目录 |

- 接入只是**复制**一份 PDF 到应用的数据目录；Zotero 的附件原文件、目录结构、元数据都不会被修改。
- 同一附件、同一内容只保留一份副本；重复打开不会产生重复记录。
- 批注和笔记按文档路径保存，而副本路径由稳定 link id 决定，所以重复打开会继续用同一份阅读成果。
- 删除 `%APPDATA%\BabelDOC-Studio\zotero\` 不会删除 Zotero 原件，但会丢失应用侧的关联与阅读位置
  （下一次从 Zotero 打开会重新接入）。

## 5. 页码映射

BabelDOC 的不同产物与原文的页码关系：

| 打开的产物 | 与原文（Zotero 里那份 PDF）的关系 | 映射规则 |
| --- | --- | --- |
| 原文（首次接入的副本） | 同一份文件 | 直接用传入页 |
| 仅译文 `_译文.pdf` | 保持原 PDF 页结构 | 同页 |
| 左右对照 `_双语对照.pdf`（左右版式） | 保持原 PDF 页结构 | 同页 |
| 交替页 `_双语对照.pdf`（交替版式） | 页数约为原来的 2 倍 | 原文第 `n` 页 → 输出第 `2n-1` 页 |

无法确定对应关系（页数不一致、产物被裁剪过）时，回退到**相同页码**并夹到目标文档范围内，
也就是「回退到原文对应页」。

## 6. 异常与排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 右键没有入口 | 该条目没有本地 PDF 附件；或插件未启用 | 先在 Zotero 中下载 PDF；到 工具 → 插件 确认「ReadPI」已启用 |
| 提示「附件尚未下载或文件已丢失」 | 附件是链接文件且路径失效，或还没下载完 | 在 Zotero 中重新下载附件后，再点一次入口 |
| 提示「本地服务未响应」 | 应用没启动，或自动启动被安全软件拦截 | 手动启动 ReadPI（当前旧包仍用 `Start.bat` / `BabelDOC Studio.exe` 文件名），再点一次入口 |
| 一直连不上，但应用在运行 | 端口被占用后应用换了端口；或本机代理拦截了 `127.0.0.1` | 插件会自动扫描 8765–8804；仍有问题可把 `127.0.0.1` 加入代理例外，或重启应用后重试 |
| 提示检测到旧版本 | 8765 等端口运行的 Studio 缺少 Zotero 接口；常见于旧版 1.7.0 免安装包 | 关闭旧版进程，启动 1.8.1；插件只连接 `/api/health` 的 `features` 含 `zotero` 的服务 |
| 结果库没有 Zotero 文献 | 新版应用尚未收到 Zotero 快照，或论文 PDF 仍未下载到本地 | 在 Zotero 打开顶部 ReadPI 菜单触发同步；确认 PDF 附件存在 |
| 装了插件但没有「ReadPI」按钮 | Zotero 版本低于 7，或插件未启用 | 升级 Zotero 到 7.0+；在插件页启用后重开阅读器 |
| 有译文却打开原文 | 应用仍在运行旧版进程 | 关闭旧版服务，启动 ReadPI 1.8.1，再从 Zotero 选择「阅读」 |

插件偏好（Zotero → 编辑 → 设置 → ReadPI）里可以覆盖：启动信息路径、应用启动器路径、
端口（0 = 自动读取）、是否自动启动、是否携带当前页。

## 7. 开发与测试

```powershell
# 插件源码
tools/zotero-plugin/            # manifest.json / bootstrap.js / prefs* / locale / icons

# 生成可安装的 XPI（写到 dist/）
python tools/build_zotero_plugin.py

# 服务端契约与集成测试
python -m pytest tests/test_zotero.py tests/test_zotero_plugin.py tests/test_zotero_library.py -q
node tests/zotero_plugin_harness.mjs       # 插件逻辑（无 Zotero 环境）
python tests/zotero_reader_ui.py           # 浏览器端：页码、位置回传、译文映射
python tests/zotero_library_ui.py          # 浏览器端：文件夹、卡片、翻译入口、浅色/深色
```

应用侧接口（只有本机可访问）：

| 端点 | 用途 |
| --- | --- |
| `POST /api/zotero/open` | 接入附件（去重）；`mode=read` 阅读，`mode=translate` 用已保存设置启动翻译 |
| `POST/GET /api/zotero/library` | 保存/读取 Zotero 文库快照与嵌套文件夹 |
| `GET /api/zotero/thumb` | 为快照内的 PDF 生成缩略图 |
| `POST /api/zotero/panel` | 打开应用页面或结果库的 Zotero 文库视图 |
| `POST /api/zotero/position` | 阅读器回传页码（`{path, page, pages}`） |
| `GET /api/zotero/status` | 关联数量、最近文献、插件版本 |
| `GET /api/zotero/plugin.xpi` | 下载插件安装包（`application/x-xpinstall`） |

## 8. 已知限制

- 文库快照是单向同步；在 Studio 中不能编辑 Zotero 的文献和文件夹，笔记/批注也不会双向同步。
- 不再上传文件：插件只把本机已有的 PDF 路径交给本地服务，不上传云端。
- Zotero 8 的菜单 API 与 7 不同，插件已做能力探测；若遇到菜单缺失，请提交 Zotero 版本与
  插件日志（Zotero → 帮助 → 调试输出）。
