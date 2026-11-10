# Zotero 7 插件 API 参考（用于 BabelDOC Studio 桥接插件）

> 本文档的目标：让实现者不看源码也能写出「在 Zotero 里右键一篇文献 / 在 PDF 阅读器里点一下，就把它交给 BabelDOC Studio 打开」的插件。
> **证据等级**（每条结论后标注，未标注的一律视为不可信）：
>
> - **【源码验证 7.0.32】**：直接读 `zotero/zotero` 仓库 `7.0.32` tag 的源码得到，行号一并给出。
> - **【官方文档】**：来自 `zotero.org/support/dev/*`。
> - **【本项目契约】**：来自本仓库 `app.py` / `core/zotero.py` 已经实现好的 HTTP 契约（这部分不是 Zotero API，但插件必须遵守）。
> - **【社区示例】**：来自第三方插件或社区惯例，未在官方源码中确认。
> - **【推断】**：由源码行为推导，未运行验证，标出风险点与安全回退方案。
>
> **版本背景（重要）**：本机没有安装 Zotero，所有结论来自源码 + 官方文档的静态阅读，**没有做运行时验证**。
> 仓库 `zotero/zotero` 的 `tags` 显示 7.0.x 线的最高版本是 **7.0.32**，同时 8.0.x / 9.0.x / 10.0.x 也已发布（<https://api.github.com/repos/zotero/zotero/tags>）。
> 因此本文按 **Zotero 7.0.x** 写主体，凡与 8+ 有差异的地方单独标注。**插件必须做能力探测（feature detection），不能假设 8+ 的 API 存在。**

参考的核心页面：

- Zotero 7 for Developers：<https://www.zotero.org/support/dev/zotero_7_for_developers>
- Zotero 8 for Developers：<https://www.zotero.org/support/dev/zotero_8_for_developers>
- Zotero JavaScript API（官方，含 `getSelectedItems()` / `Zotero.File` 示例）：<https://www.zotero.org/support/dev/client_coding/javascript_api>
- 用户端安装说明（拖 `.xpi` 到 Plugins 窗口）：<https://www.zotero.org/support/plugins>
- 官方示例插件 Make It Red：<https://github.com/zotero/make-it-red>

---

## 0.0 实现阶段勘误（优先阅读）

> 以下三处是骨架（§12）在真正实现 `tools/zotero-plugin/` 时被修正的点；按**修正后**的写法实现。

1. **插件偏好读取必须带 `global=true`**：7.0.32 的 `prefs.js` 里是
   `pref = global ? pref : PREF_BRANCH + pref`，插件自己的偏好要
   `Zotero.Prefs.get(key, true)` / `Zotero.Prefs.set(key, value, true)`。
   §12.3 / §12.5 的骨架漏了这个参数，照抄会让用户设置被静默忽略、永远用默认值。
   官方 make-it-red 示例同样传 `true`。
2. **不要调用 `Zotero.Reader.unregisterEventListener()`（7.0.32 有 bug）**：其实现按
   `x.type === type && x.handler === handler` 过滤，结果是**保留**匹配监听器、删掉其它监听器。
   正确做法：`registerEventListener(type, handler, pluginID)`，shutdown 交给 Zotero 的
   pluginID 清理观察者（`reader.js:1795-1799`）。
3. **年份用 `item.getField("year")`**：§12.3 里的 `getField("date")` 会返回完整日期；
   与 §12.7 保持一致（实现里是 `year` + `date` 正则兜底）。

## 0. 结论速查（TL;DR）

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| `Zotero.MenuManager` 在 Zotero 7 存在吗？ | **不存在**。7.0.32 的 `chrome/content/zotero/xpcom/pluginAPI/` 只有 `itemPaneManager.js`、`itemTreeManager.js`、`pluginAPIBase.mjs` 三个文件 | 【源码验证 7.0.32】<https://github.com/zotero/zotero/tree/7.0.32/chrome/content/zotero/xpcom/pluginAPI> |
| 那 8+ 呢？ | **存在**，`Zotero.MenuManager.registerMenu({menuID, pluginID, target, menus})`，官方在 “Zotero 8 for Developers → Custom Menu Items” 里文档化 | 【官方文档】<https://www.zotero.org/support/dev/zotero_8_for_developers>；【源码验证 8.0】<https://github.com/zotero/zotero/blob/8.0/chrome/content/zotero/xpcom/pluginAPI/menuManager.js> |
| Zotero 7 怎么加右键菜单？ | 自己往 `#zotero-itemmenu`（文献列表右键菜单，`zoteroPane.xhtml` 静态存在）里插 `<menuitem>`，并监听该 popup 的 `popupshowing` 控制显隐 | 【源码验证 7.0.32】`zoteroPane.xhtml:955`、`zoteroPane.js:3157,3562,3599` |
| `Zotero.Reader.getActiveReader()`？ | **7.0.32 里没有这个方法**。官方做法是 `Zotero_Tabs.selectedType === 'reader'` + `Zotero.Reader.getByTabID(selectedID)` | 【源码验证 7.0.32】`tabs.js:39-58`、`reader.js:1978`、`zoteroPane.js:3072-3093` |
| 当前页？ | `reader._state.pageIndex`（`ReaderInstance` 是 Proxy，未知属性转发给 `_internalReader`），0 基；持久化回退 `item.getAttachmentLastPageIndex()` | 【源码验证 7.0.32】`reader.js:64-88, 937-1000, 1682` |
| 起本地进程？ | `Zotero.Utilities.Internal.exec(cmd, args)` **存在**，参数是 `nsIFile|String` + `String[]`，用 `nsIProcess.runwAsync` | 【源码验证 7.0.32】`utilities_internal.js:585-621` |
| 本机能用 `http://127.0.0.1` 吗？ | 可以。插件跑在 chrome 权限下，`Zotero.HTTP` 走 XHR，不受页面 mixed-content 限制 | 【推断，低风险】+【官方文档】示例见下 |
| 打包/签名？ | XPI = manifest.json 在根目录的 zip；官方安装方式是拖进 Plugins 窗口；官方文档**未提及任何签名要求** | 【官方文档】<https://www.zotero.org/support/plugins>；【推断】 |

---

## 1. 插件骨架：manifest.json 与 bootstrap.js

### 1.1 manifest.json

Zotero 7 用 WebExtension 风格 `manifest.json` 取代 `install.rdf`，其中 **`applications.zotero` 必须存在**，否则 Zotero 不会安装该插件【官方文档】。

```json
{
  "manifest_version": 2,
  "name": "BabelDOC Studio Bridge",
  "version": "0.1.0",
  "description": "在 BabelDOC Studio 中打开 Zotero 里选中的 PDF，并跳转到当前页。",
  "author": "PiDesign",
  "icons": {
    "48": "icons/icon-48.png",
    "96": "icons/icon-96.png"
  },
  "applications": {
    "zotero": {
      "id": "babeldoc-studio@pidesign.local",
      "update_url": "https://example.com/babeldoc/updates.json",
      "strict_min_version": "7.0",
      "strict_max_version": "7.0.*"
    }
  }
}
```

字段逐条确认：

| 字段 | 是否必需 | 说明 | 证据 |
| --- | --- | --- | --- |
| `manifest_version` | 是 | 固定 `2` | 【官方文档】Zotero 7 dev 页示例 |
| `name` / `version` / `description` / `author` | 是 | `version` 决定升级判定，`/api/zotero/plugin.xpi` 的文件名也用它 | 【官方文档】+【本项目契约】`core/zotero.py:plugin_version()` |
| `icons` | 否 | 建议 48 / 96（2x）PNG，也用于偏好面板默认图标 | 【官方文档】 |
| `applications.zotero.id` | 是 | 插件唯一 ID，强烈建议 `xxx@yyy` 形式，后续 `pluginID` 参数都用它 | 【官方文档】 |
| `applications.zotero.strict_min_version` | 是 | Zotero 7 正式版写 `"7.0"`；要允许装到 7 beta 用 `"6.999"` | 【官方文档】 |
| `applications.zotero.strict_max_version` | 是 | 写「已测试的最高 minor」+ `.*`，如 `"7.0.*"`；想兼容 8 需实测后改 `"8.*"` | 【官方文档】 |
| `applications.zotero.update_url` | 否 | 指向 `updates.json`（JSON 更新清单），见 §10 | 【官方文档】 |
| `applications.gecko` | 否 | Zotero 6 时代用的是 `applications.gecko`（填 **Firefox 平台版本** `60.9`）。7 只认 `applications.zotero`，两者可同时存在以兼容 6 | 【官方文档】 |

> **注意**：`strict_max_version` 写太死会导致新版 Zotero 拒绝安装。官方说法是「之后可通过 update manifest 调整兼容性而不用发新版本」【官方文档】，所以 `update_url` 建议一开始就配好。

### 1.2 bootstrap.js：必须导出的函数

bootstrapped 插件必须导出 6 个函数【官方文档】：

| 函数 | 参数 | 用途 |
| --- | --- | --- |
| `startup({id, version, rootURI}, reason)` | 生命周期，`reason` 为 `APP_STARTUP` / `ADDON_ENABLE` / `ADDON_INSTALL` / `ADDON_UPGRADE` … | 与窗口无关的初始化（注册偏好面板、reader 事件、HTTP 客户端） |
| `shutdown({id, version, rootURI}, reason)` | 同上 | **必须**撤销 startup 里做的一切（内存泄漏 / 重复菜单都源于此） |
| `install(data, reason)` | — | 首次安装 |
| `uninstall(data, reason)` | — | 卸载 |
| `onMainWindowLoad({window})` | 仅 Zotero 7 | 主窗口每次打开都会调，所有 UI 修改必须放这里 |
| `onMainWindowUnload({window})` | 仅 Zotero 7 | 主窗口关闭，必须解绑事件、断开引用 |

关键事实：

- Zotero 7 里 `startup()` / `install()` 在 Zotero 初始化完成后才调用，且 **`Zotero`、`Services`、`Cc`、`Ci` 已自动注入 bootstrap 作用域**【官方文档】。所以不需要 Zotero 6 那套「等 `Zotero` 出现」的样板。
- 主窗口可能被多次打开/关闭，**任何 DOM 改动都必须放在 `onMainWindowLoad`**，并在 `onMainWindowUnload` 里清掉【官方文档】。
- 关闭窗口时 DOM 元素会自动销毁，但 **事件监听器 / 定时器 / 对 window 的引用必须手动清**【官方文档】。

### 1.3 「在主窗口加载时运行代码」与「在 reader 加载时运行代码」

- **主窗口**：`onMainWindowLoad({window})`。【源码验证 7.0.32】`window.Zotero_Tabs`、`window.document` 都可直接用；`Zotero.getMainWindow()` 也能拿（`reader.js:1864`、`progressWindow.js:126`）。
- **reader**：**没有** `onReaderLoad` 这种钩子。Zotero 7 有三种可用的接入点：
  1. `Zotero.Reader.registerEventListener(type, handler, pluginID)`：类型包括 `renderToolbar`、`renderTextSelectionPopup`、`renderSidebarAnnotationHeader`、`createViewContextMenu`、`createAnnotationContextMenu`、`createColorContextMenu`、`createThumbnailContextMenu`、`createSelectorContextMenu`【源码验证 7.0.32】`reader.js:1810-1846`（该段注释即官方给出的用法示例）。
  2. 轮询 / 监听 tab 变化，用 `win.Zotero_Tabs.selectedID` + `Zotero.Reader.getByTabID()` 找到 reader 实例【源码验证 7.0.32】`tabs.js`、`reader.js:1978`。
  3. 用 `Zotero.Notifier.registerObserver(this, ['tab'], 'myplugin')` 接收 tab `add/close/select` 事件【源码验证 7.0.32】`reader.js:1782, 1914-1935`。

  `registerEventListener` 的第 3 个参数 `pluginID` 很重要：Zotero 会在插件 shutdown 时自动注销该 pluginID 的所有监听器【源码验证 7.0.32】`reader.js:1795-1799, 1848-1850`。

---

## 2. 右键菜单（文献列表 + 阅读器）

### 2.1 先确认：Zotero 7 **没有** `Zotero.MenuManager`

- `7.0.32` 的 `pluginAPI` 目录只有 `itemPaneManager.js` / `itemTreeManager.js` / `pluginAPIBase.mjs`，**没有 `menuManager.js`**【源码验证 7.0.32】<https://github.com/zotero/zotero/tree/7.0.32/chrome/content/zotero/xpcom/pluginAPI>。
- 官方文档把 “Custom Menu Items” 明确写在 **Zotero 8 for Developers** 页面，而不是 Zotero 7 页面【官方文档】<https://www.zotero.org/support/dev/zotero_8_for_developers>。
- 结论：**面向 Zotero 7 必须自己做 DOM 注入**；`Zotero.MenuManager` 只能作为 8+ 的可选增强路径。

### 2.2 Zotero 8+ 的 `Zotero.MenuManager`（先记下来，做兼容分支用）

```js
// 仅当 Zotero.MenuManager 存在时执行
let registeredID = Zotero.MenuManager.registerMenu({
  menuID: "babeldoc-open",                 // 唯一 ID
  pluginID: "babeldoc-studio@pidesign.local",
  target: "main/library/item",             // 见下表
  menus: [
    {
      menuType: "menuitem",                // "menuitem" | "separator" | "submenu"
      l10nID: "babeldoc-menu-open",        // .ftl 里需提供 .label
      onShowing: (event, context) => {
        context.setVisible(context.items?.some(it => it.isRegularItem()));
      },
      onCommand: (event, context) => { /* ... */ },
    },
  ],
});
// 注销：Zotero.MenuManager.unregisterMenu(registeredID);
```

`target` 的合法取值（源码 `VALID_TARGETS`，8.0）【源码验证 8.0】`menuManager.js:30-60`：

```
main/menubar/file | main/menubar/edit | main/menubar/view | main/menubar/go
main/menubar/tools | main/menubar/help
main/library/item | main/library/collection      ← 文献列表右键菜单就是 main/library/item
main/library/addAttachment | main/library/addNote
main/tab                                         ← 主窗口「标签页」右键菜单（含 reader 标签页）
reader/menubar/file | reader/menubar/edit | reader/menubar/view | reader/menubar/go | reader/menubar/window
itemPane/info/row
notesPane/addItemNote | notesPane/addStandaloneNote
sidenav/locate
```

**没有 `main/reader/tab` 这个 target**。reader 标签页的右键菜单对应 `main/tab`（与其它标签页共用）；reader 窗口内的菜单对应 `reader/menubar/*`【源码验证 8.0】同上。

`context` 上可用的方法（源码 `defaultContext`）【源码验证 8.0】`menuManager.js:572-606`：

| 成员 | 签名 | 作用 |
| --- | --- | --- |
| `context.menuElem` | XULElement | 当前菜单元素 |
| `context.setVisible(v)` | `(boolean)` | 设置 `hidden` |
| `context.setEnabled(v)` | `(boolean)` | 设置 `disabled` |
| `context.setIcon(icon, darkIcon?)` | `(string, string?)` | 设置图标 CSS 变量 |
| `context.setL10nArgs(args)` | `(object)` | 设置 `data-l10n-args` |
| `context.items` | `Item[]` | 库视图上下文里的选中项（官方 8 文档示例使用）【官方文档】 |

> 说明：`context.items` 来自 Zotero 自己对各 target 提供的 `getContext()`，源码里 `getContext` 只被透传合并（`menuManager.js:607-609`），所以「`items` 一定存在」只在官方文档示例层面有保证【官方文档】。拿不到时回退到 `Zotero.getActiveZoteroPane().getSelectedItems()`。

### 2.3 Zotero 7 的可用做法：注入 `#zotero-itemmenu`

`#zotero-itemmenu` 是 `zoteroPane.xhtml` 里静态存在的 `<menupopup>`【源码验证 7.0.32】`zoteroPane.xhtml:955`。Zotero 每次右键前调用 `ZoteroPane.buildItemContextMenu()`【源码验证 7.0.32】`zoteroPane.js:3157, 3562`，它按固定顺序重排内置项（用 `hidden`/`disabled` 集合控制显隐，只删除带 `zotero-locate` 属性的节点，**不会清空整张菜单**）【源码验证 7.0.32】`zoteroPane.js:3599-3620`。

所以安全做法：**在 `onMainWindowLoad` 里 append 一次，显隐用 `popupshowing` 计算**。

```js
const PLUGIN_ID = "babeldoc-studio@pidesign.local";
const ITEM_MENU_ID = "babeldoc-menuitem-open";

function hasLocalPDFSync(items) {
  // 同步判定：getFilePath() 是同步 API，返回路径或 false
  for (const item of items) {
    if (item.isAttachment()) {
      if (item.isPDFAttachment() && item.getFilePath()) return true;
    }
    else if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = Zotero.Items.get(id);
        if (att && att.isPDFAttachment() && att.getFilePath()) return true;
      }
    }
  }
  return false;
}

function installItemMenu(win) {
  const doc = win.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup || popup.querySelector(`#${ITEM_MENU_ID}`)) return;

  const sep = doc.createXULElement("menuseparator");
  sep.id = ITEM_MENU_ID + "-sep";
  sep.classList.add("babeldoc-menuitem");

  const mi = doc.createXULElement("menuitem");
  mi.id = ITEM_MENU_ID;
  mi.classList.add("menuitem-iconic", "babeldoc-menuitem");
  mi.setAttribute("label", "在 BabelDOC Studio 中打开"); // 简版；Fluent 见 §2.5
  mi.addEventListener("command", () => {
    openSelectionInBabelDOC(win);
  });

  popup.append(sep, mi);

  const onShowing = () => {
    let show = false;
    try {
      const zp = Zotero.getActiveZoteroPane();
      const items = zp ? zp.getSelectedItems() : [];
      show = hasLocalPDFSync(items);
    } catch (e) {
      Zotero.logError(e);
    }
    mi.hidden = !show;
    sep.hidden = !show;
  };
  popup.addEventListener("popupshowing", onShowing);
  mi._babeldocOnShowing = onShowing;   // 供 onMainWindowUnload 解绑
  mi._babeldocPopup = popup;
}

function uninstallItemMenu(win) {
  const doc = win.document;
  const mi = doc.getElementById(ITEM_MENU_ID);
  if (!mi) return;
  const popup = mi._babeldocPopup;
  if (popup && mi._babeldocOnShowing) {
    popup.removeEventListener("popupshowing", mi._babeldocOnShowing);
  }
  doc.getElementById(ITEM_MENU_ID + "-sep")?.remove();
  mi.remove();
}
```

要点：

- `doc.createXULElement(...)` 在 Zotero 7 里是标准写法【源码验证 7.0.32】`progressWindow.js:162`、`reader.js:1242-1252`。
- 显隐必须放 `popupshowing`，因为选中项在菜单打开时才知道；`popupshowing` 里**不要 `await`**（异步结果赶不上菜单展开），所以用同步的 `getFilePath()`，真正打开时再用异步的 `getFilePathAsync()`。
- 多选时用 `items` 全量判断；`getSelectedItems()` 在 reader 标签页激活时返回的是**父条目**（见 §3.1），所以这条菜单在阅读器标签页里右键也可能命中——需要区分时用 `Zotero_Tabs.selectedType`。

### 2.4 阅读器里的入口

Zotero 7 的 reader **标签页**没有稳定的右键菜单 DOM id：标签页由 React 渲染，右键菜单在 `tabs.js` 的 `_openMenu()` 里**动态 `createXULElement('menupopup')`**，没有可 hook 的 id【源码验证 7.0.32】`tabs.js:702-716`。因此 Zotero 7 上推荐这两个官方钩子（都在 `startup()` 里注册）：

```js
// 1) 阅读器工具栏按钮（最像「在 BabelDOC 中打开」的入口）
Zotero.Reader.registerEventListener("renderToolbar", (event) => {
  const { reader, doc, append } = event;
  const btn = doc.createElement("button");
  btn.className = "toolbar-button babeldoc-open";
  btn.title = "在 BabelDOC Studio 中打开";
  btn.textContent = "BabelDOC";
  btn.addEventListener("click", () => {
    openAttachmentInBabelDOC(reader.itemID, getReaderPage(reader));
  });
  append(btn);
}, PLUGIN_ID);

// 2) PDF 页面右键菜单（在阅读器里右键页面时出现）
Zotero.Reader.registerEventListener("createViewContextMenu", (event) => {
  const { reader, params, append } = event;
  append({
    label: "在 BabelDOC Studio 中打开",
    onCommand() {
      openAttachmentInBabelDOC(reader.itemID, getReaderPage(reader));
    },
  });
}, PLUGIN_ID);
```

`registerEventListener` 的回调参数结构见源码注释：`{ reader, doc, params, append }`，`append` 已由 Zotero 做过 `cloneInto` 包装，可直接塞 DOM 节点或 `{label, onCommand}` 对象【源码验证 7.0.32】`reader.js:1810-1839` 与 `reader.js:171-179`。

> 如果一定要「主窗口标签栏右键」，Zotero 7 只能 monkey-patch `Zotero_Tabs._openMenu`（不推荐，升级易碎）。**Zotero 8+ 用 `Zotero.MenuManager` 的 `main/tab` target 即可**，这条差异应写进 CHANGELOG。

### 2.5 分隔符 / 图标 / 中文标签（本地化）

- **分隔符**：`doc.createXULElement("menuseparator")`，与菜单项同时显隐。
- **图标**：菜单项加 `class="menuitem-iconic"`，再用 CSS `list-style-image: url(...)`；Zotero 7 自带图标通过 `chrome://zotero/skin/16/universal/...svg` 引用【源码验证 7.0.32】`zoteroPane.xhtml:957-1000` 大量使用 `menuitem-iconic`。插件自带图标用 `rootURI + "icons/icon-16.svg"`。
- **本地化（推荐 Fluent）**：官方要求插件把 `.ftl` 放到 `locale/<locale>/xxx.ftl`，Zotero 会自动注册【官方文档】。菜单项需要 `.label` 属性：

```ftl
# locale/zh-CN/babeldoc.ftl
babeldoc-menu-open =
    .label = 在 BabelDOC Studio 中打开
```

```js
// 在改 DOM 前先把 ftl 挂进窗口
win.MozXULElement.insertFTLIfNeeded("babeldoc.ftl");
doc.l10n.setAttributes(mi, "babeldoc-menu-open");
```

`MozXULElement.insertFTLIfNeeded` 与 `document.l10n.setAttributes` 都是官方文档给的写法【官方文档】；shutdown 时要移除 `<link href="babeldoc.ftl">`【官方文档】。

> 最小可行版可以先 `setAttribute("label", "在 BabelDOC Studio 中打开")` 硬编码中文，Fluent 作为后续优化。注意 Fluent 的 id 和文件名在共享文档里是全局命名空间，**必须加插件前缀**（`babeldoc-`）【官方文档】。

---

## 3. 取选中项、PDF 附件、路径与元数据

### 3.1 选中项

```js
const zp = Zotero.getActiveZoteroPane();      // 官方文档首推写法
const items = zp.getSelectedItems();          // Zotero.Item[]
const ids = zp.getSelectedItems(true);        // 只要 itemID[]
```

【官方文档】<https://www.zotero.org/support/dev/client_coding/javascript_api>（“Get the Zotero Pane…” 一节）。

**重要细节（源码）**：`getSelectedItems()` 已经处理了「当前激活的是 reader 标签页」的情况——它会 `Zotero.Reader.getByTabID(Zotero_Tabs.selectedID)`，然后返回**父条目**（若附件有 parent），否则返回附件本身【源码验证 7.0.32】`zoteroPane.js:3072-3093`：

```js
case 'reader': {
  let reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
  if (reader) {
    let item = Zotero.Items.get(reader.itemID);
    if (item.parentItem) item = item.parentItem;
    return asIDs ? [item.id] : [item];
  }
  return [];
}
```

→ 所以「用户在阅读器里」时，`getSelectedItems()` 给的是父条目，**拿不到页码信息**；页码要单独从 reader 拿（§4）。

### 3.2 判定与遍历

| API | 返回值 | 证据 |
| --- | --- | --- |
| `item.isRegularItem()` | 是否常规文献（非附件/笔记） | 【源码验证 7.0.32】`item.js:2156` |
| `item.isAttachment()` | 是否附件 | `item.js:2415` |
| `item.isFileAttachment()` | 是否「有文件」的附件（排除 linked URL） | `item.js:2462` |
| `item.isPDFAttachment()` | `isFileAttachment() && attachmentContentType == 'application/pdf'` | `item.js:2497-2499` |
| `item.isStoredFileAttachment()` / `isLinkedFileAttachment()` | 导入副本 / 链接文件 | `item.js:2438, 2472` |
| `item.getAttachments(includeTrashed?)` | **返回 itemID 数组**（不是 Item 对象）；在附件上调用会抛错 | `item.js:3802-3833` |
| `item.getFilePath()` | **同步**，绝对路径字符串或 `false`（不校验文件是否存在） | `item.js:2592-2680` |
| `item.getFilePathAsync()` | **异步**，`Promise<string|false>`，文件不存在返回 `false` | `item.js:2689+` |
| `item.fileExists()` | 异步，检查文件是否真的在磁盘上 | `item.js:2860` |
| `item.attachmentLinkMode` | 常量：`Zotero.Attachments.LINK_MODE_IMPORTED_FILE` / `LINK_MODE_IMPORTED_URL` / `LINK_MODE_LINKED_FILE` / `LINK_MODE_LINKED_URL` | `item.js:3107`、`item.js:1314-1316, 2601, 2638` |
| `Zotero.Items.get(id)` / `getAsync(ids)` | 按 id 取 Item | 【官方文档】javascript_api |

`getFilePath()`/`getFilePathAsync()` 的关键行为【源码验证 7.0.32】：

- `LINK_MODE_LINKED_URL` → 直接 `false`（没有本地文件）；
- 导入附件（`storage:` 前缀）→ 拼成 `<Zotero 数据目录>/storage/<key>/<filename>`；
- 链接文件（`attachments:` 相对基路径）→ 用 `Zotero.Attachments.resolveRelativePath()` 还原，还原失败会 `_updateAttachmentStates(false)` 并返回 `false`；
- 老式 macOS alias（以 `AAAA` 开头）→ 非 mac 平台返回 `false`。

→ 也就是说：「缺文件 / 链接失效 / 只有 URL 附件」都统一表现为 `false`，**不需要自己判断 linkMode**，但错误提示可以据此区分。

### 3.3 一个可直接用的「取 PDF 路径 + 元数据」函数

```js
/**
 * 从选中项里挑出第一个可用的本地 PDF，并带上元数据。
 * @returns {Promise<null|{path, attachment, item, page}>}
 */
async function pickPDFFromItems(items) {
  for (const item of items) {
    let attachment = null;
    let parent = null;

    if (item.isAttachment()) {
      if (!item.isPDFAttachment()) continue;
      attachment = item;
      parent = item.parentItem || null;
    }
    else if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = Zotero.Items.get(id);
        if (att && att.isPDFAttachment()) { attachment = att; parent = item; break; }
      }
    }
    if (!attachment) continue;

    // 异步版会真正校验文件存在，缺失返回 false
    const path = await attachment.getFilePathAsync();
    if (!path) continue;

    return { path, attachment, item: parent || attachment, page: 0 };
  }
  return null;
}
```

元数据（DOI / 标题）取法：

```js
const title = item.getField("title");        // 常规条目
const doi   = item.getField("DOI");          // 无 DOI 时返回 ""
const year  = item.getField("year");         // Zotero 直接支持 'year'：取 date 前 4 位（item.js:256-257）
// 作者（可选，给 BabelDOC 展示用）
const creators = item.getCreators()
  .map(c => [c.firstName, c.lastName].filter(Boolean).join(" "))
  .join(", ");
// 条目在 Zotero 里的稳定标识
const libraryID = item.libraryID;
const itemKey = item.key;
const attachmentKey = attachment.key;
```

`getField('DOI')` 对没有该字段的条目类型返回空字符串（Zotero 内部按字段是否存在处理）；`getField('year')` 是内置支持的派生字段，返回 `date` 的前 4 位【源码验证 7.0.32】`item.js:256-257`。`item.key`/`libraryID` 是同步属性【源码验证 7.0.32】`item.js:46, 1279-1283, 1314-1316` 及【官方文档】`getField` 用法示例。

> **注意**：插件只应读取，不要 `saveTx()`，避免污染用户库。

---

## 4. Zotero Reader：找到「当前打开的 PDF」和当前页

### 4.1 没有 `getActiveReader`，用 Tabs + getByTabID

- `7.0.32` 的 `Zotero.Reader` 只有：`open` / `openURI` / `getByTabID` / `getWindowStates` / `registerEventListener` / `unregisterEventListener` / `getSidebarWidth` / `flushAllReaderStates` 等，**没有 `getActiveReader()`、也没有 `getReader()`**【源码验证 7.0.32】`reader.js:1776-2152`（全量方法列表见 §4.4）。
- 官方自己的「当前 reader」写法就是【源码验证 7.0.32】`zoteroPane.js:3080`：

```js
function getActiveReader() {
  const win = Zotero.getMainWindow();
  if (!win || !win.Zotero_Tabs) return null;
  const Tabs = win.Zotero_Tabs;
  if (Tabs.selectedType !== "reader") return null;
  return Zotero.Reader.getByTabID(Tabs.selectedID) || null;
}
```

`Zotero_Tabs` 是主窗口作用域里的全局对象（`var Zotero_Tabs = new function(){...}`，定义在 `tabs.js`）【源码验证 7.0.32】`tabs.js:39`。可用成员【源码验证 7.0.32】`tabs.js:39-170, 283, 347, 462, 702`：

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `Zotero_Tabs.selectedID` | string | 当前标签页 id（库视图是 `'zotero-pane'`） |
| `Zotero_Tabs.selectedType` | string | `'library'` / `'reader'` / 其它 |
| `Zotero_Tabs.selectedIndex` | number | |
| `Zotero_Tabs.numTabs` | number | |
| `Zotero_Tabs._tabs` | array | 每项 `{id, type, title, data}`，reader 的 `data.itemID` 是附件 itemID |
| `Zotero_Tabs.getTabIDByItemID(itemID)` | string? | |
| `Zotero_Tabs.add/close/select(...)` | — | 给 Zotero 自用 |

> **Zotero 8+ 提示**：`Zotero_Tabs` 在 8 里仍是窗口全局（`tabs.js` 仍在），但如果你只面向 8+，优先用 `Zotero.MenuManager` + `Zotero.getMainWindow().Zotero_Tabs`；本仓库目标是 7，用上面的写法最稳。

### 4.2 reader 实例的可用属性

`Zotero.Reader.getByTabID(tabID)` 返回 `ReaderTab extends ReaderInstance`。`ReaderInstance` 的构造函数返回了一个 **Proxy**：访问实例上不存在的属性时，会自动转发给内部的 `_internalReader`【源码验证 7.0.32】`reader.js:64-88`：

```js
return new Proxy(this, {
  get(target, prop) {
    if (target[prop] === undefined && target._internalReader
        && target._internalReader[prop] !== undefined) {
      if (typeof target._internalReader[prop] === 'function') {
        return function (...args) { return target._internalReader[prop](...args); };
      }
      return target._internalReader[prop];
    }
    return target[prop];
  }, ...
});
```

因此从插件侧可用：

| 成员 | 说明 | 证据 |
| --- | --- | --- |
| `reader.itemID` | 附件 itemID（`get itemID()`） | `reader.js:604-606` |
| `reader.type` | `'pdf'` / `'epub'` / `'snapshot'` | `reader.js:91-93`（`_type = item.attachmentReaderType`，`reader.js:59`） |
| `reader.tabID` | 标签页 id | `reader.js:1223` |
| `reader._state` | 实时状态对象，PDF 下有 `pageIndex`、`primaryViewStats` | `reader.js:1682`（`_internalReader?._state?.primaryViewStats...`）+ Proxy |
| `reader._iframeWindow` | 阅读器 iframe 的 window | `reader.js:1278` |
| `reader._internalReader` | 阅读器内部 API 对象 | `reader.js:195` |
| `reader.navigate(location)` | 跳转（`{pageIndex}`） | `reader.js:630-632` |
| `reader._getState()` | **异步**，落盘的上次状态（含 `pageIndex`），有 5s 防抖写盘，可能略旧 | `reader.js:937-1000, 889-929` |

### 4.3 当前页码（0 基）与页数

```js
function getReaderPage(reader) {
  // 1) 首选的实时值：Proxy 转发到 _internalReader._state
  let pageIndex = reader?._state?.pageIndex;
  if (Number.isInteger(pageIndex)) return pageIndex;
  // 2) 回退：Zotero 落盘的「上次阅读页」，也是 0 基
  try {
    const item = Zotero.Items.get(reader.itemID);
    const last = item.getAttachmentLastPageIndex();
    if (Number.isInteger(last)) return last;
  } catch (e) { /* ignore */ }
  return 0;
}
```

- **0 基 vs 1 基**：`pageIndex` 是 pdf.js 的 `pageIndex`（0 基），Zotero 原样存进 `setAttachmentLastPageIndex()`【源码验证 7.0.32】`reader.js:893`，恢复时原样写回 `state.pageIndex`（`reader.js:966-977`）。**给用户显示 / 传给 BabelDOC 时要 +1**——本仓库后端的 `/api/zotero/open` 的 `page` 字段是 **1 基**（见 §7），所以插件应传 `pageIndex + 1`。这一点是【推断】，实现后必须本机验证一次。
- `_state.pageIndex` 属于**内部字段**（带 `_`），Zotero 8/9 里可能改名 → 必须 try/catch + 回退到 `_getState()` 或 `getAttachmentLastPageIndex()`。

**页数**：Zotero 7 没有公开的「附件页数」API（`item.js`、`pdfWorker` 里都没有 `numPages`/`pageCount` 之类，全库搜 `pagesCount|numPages|getPageCount` 无命中）【源码验证 7.0.32】。可选方案：

1. **推荐**：让 BabelDOC Studio 用 `pypdf` 自己算（本仓库已有 `core/pdfinfo.page_count()`，见 `core/zotero.py:761`），插件不传 `page_total`。
2. 从 pdf.js 内部取（脆弱，不建议上生产）：`reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pagesCount`【推断，基于 reader.js 里对 `PDFViewerApplication.pdfViewer` 的使用 `reader.js:1738-1739`】。

### 4.4 7.0.32 的 `Zotero.Reader` 方法全量（避免再猜 API 名）

```
constructor()                       reader.js:1777
_dispatchEvent(event)               :1802
registerEventListener(type, handler, pluginID?)
unregisterEventListener(type, handler)
_unregisterEventListenerByPluginID(pluginID)
getSidebarWidth() / getSidebarOpen() / setSidebarWidth() / toggleSidebar() / setBottomPlaceholderHeight()
notify(event, type, ids, extraData)
getByTabID(tabID)                   :1978
getWindowStates()                   :1982
openURI(itemURI, location, options):1993
open(itemID, location, {title, tabIndex, tabID, openInBackground, openInWindow, allowDuplicate, secondViewState, preventJumpback})
triggerAnnotationsImportCheck(itemID)
flushAllReaderStates()
```

【源码验证 7.0.32】逐行对照 <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/reader.js>。

`Zotero.Reader.open(itemID, { pageIndex })` 的 `location` 参数就是 `{ pageIndex }`（pdf.js 语义，0 基）【源码验证 7.0.32】`reader.js:1999` + `_open` 里透传。

---

## 5. HTTP：`Zotero.HTTP.request`

### 5.1 签名与选项（源码 JSDoc 原文）

```js
/**
 * @param {String} method
 * @param {nsIURI|String} url
 * @param {Object} [options]
 * @return {Promise<XMLHttpRequest>}
 */
Zotero.HTTP.request(method, url, options)
```

【源码验证 7.0.32】`http.js:116-154`。选项清单（同段注释）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `body` | — | POST 请求体（字符串） |
| `headers` | — | `Object` 或 `Headers` |
| `followRedirects` | `true` | |
| `responseType` | — | XHR2 合法值（`'json'`、`'arraybuffer'`…） |
| `responseCharset` | — | 强制解码字符集 |
| `timeout` | `30000` | 毫秒；`0` = 不超时 |
| `successCodes` | 2xx | 数组；**`false` 表示任何状态码都算成功**（便于读错误体） |
| `noCache` | — | 不走缓存 |
| `foreground` | — | 前台请求（可能弹证书/认证框） |
| `logBodyLength` | `1024` | 日志里 body 截断长度 |
| `errorDelayMax` | `3600000`（1 小时） | **5xx 自动重试的总时长上限**；设 `0` 关闭重试 |
| `errorDelayIntervals` | 内部默认表 | 重试间隔序列 |
| `cancellerReceiver` | — | 回调拿到取消函数 |
| `requestObserver` | — | `open()` 之后拿到 XHR 对象 |

成功时 resolve 的是 **XMLHttpRequest 对象**（用 `.responseText` / `.response` / `.status`），非 2xx 时 **reject**（`UnexpectedStatusException`，带 `.xmlhttp`）【源码验证 7.0.32】`http.js:150-152, 225+`。

### 5.2 面向本地服务的推荐调用

```js
async function apiGet(baseUrl, path, timeout = 1500) {
  const xhr = await Zotero.HTTP.request("GET", baseUrl + path, {
    timeout,
    responseType: "text",
    noCache: true,
    errorDelayMax: 0,        // 关键：别让 5xx 自动重试卡 1 小时
    successCodes: [200],
  });
  return JSON.parse(xhr.responseText);
}

async function apiPost(baseUrl, path, payload, timeout = 15000) {
  const xhr = await Zotero.HTTP.request("POST", baseUrl + path, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    timeout,
    errorDelayMax: 0,
    successCodes: false,     // 4xx 也 resolve，便于把后端错误原样展示
  });
  let data;
  try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
  return { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, data };
}
```

> **必须设 `errorDelayMax: 0`**：默认对 5xx 会自动重试**最长 1 小时**（`http.js:8, 148-149, 172-185`）。本地服务没起来时表现为「点了没反应」，非常难排查。

### 5.3 `http://127.0.0.1` 会被拦吗？

- 插件代码运行在 **chrome 权限**（Zotero 7 dev 页明确说插件仍拥有平台内部完整权限，包括 XPCOM、文件访问）【官方文档】<https://www.zotero.org/support/dev/zotero_7_for_developers>。
- `Zotero.HTTP` 直接 `new XMLHttpRequest()`（`http.js:277`），**不经过页面上下文**，因此不存在「https 页面加载 http 子资源」的 mixed-content 拦截；Zotero 自身就大量用 `Zotero.HTTP` 访问 http 服务（如 `http.js:1166` 的错误提示链接、连接器本地端口）。
- 结论：**可以**直接请求 `http://127.0.0.1:<port>`【推断，低风险；实现后用 `/api/health` 冒烟即可确认】。
- 唯一真实风险是 **网络层**：本机代理 / 防火墙把 `127.0.0.1` 代理掉了。可在偏好里提供「直连」说明；Zotero 的代理配置对 `Zotero.HTTP` 生效，必要时让用户把 `127.0.0.1` 加入代理例外。

---

## 6. 启动本地进程（Windows）

### 6.1 `Zotero.Utilities.Internal.exec` —— 确认存在

【源码验证 7.0.32】`utilities_internal.js:585-621`：

```js
/**
 * Launch a process
 * @param {nsIFile|String} cmd Path to command to launch
 * @param {String[]} args Arguments given
 * @return {Promise} Promise resolved to true if command succeeds, or an error otherwise
 */
exec: Zotero.Promise.method(function (cmd, args) { ... })
```

内部实现要点（决定了我们的用法与坑）：

1. `cmd` 是字符串时用 `FileUtils.File(cmd)` 转成 `nsIFile`（`utilities_internal.js:592-595`）；
2. **`cmd.isExecutable()` 为 false 会直接抛错**（`:597-599`）；
3. `new nsIProcess` + `proc.init(cmd)` + `proc.runwAsync(args, args.length, observer)`（`:601-618`）：
   - `args` 是**数组**，由平台直接传给进程 → **路径带空格不需要加引号**（加了反而会把引号当字符）；
   - `runwAsync` 不阻塞 UI，但 **Promise 在进程结束时才 resolve**（`process-finished` 回调里 resolve/reject，非 0 退出码会 reject，`:608-618`）。对「启动一个常驻 App」的场景，**不要 `await` 它的结果**，否则要等到 App 退出。
4. 存在 `Zotero.Utilities.Internal.subprocess(command, args)`（`:630-647`），用 Mozilla `Subprocess`，**返回 stdout**，适合 `tasklist` 之类探测；命令不是绝对路径时会 `Subprocess.pathSearch` 查 PATH。

### 6.2 打开 URL / 文件：`Zotero.launchURL` / `Zotero.launchFile`

- `Zotero.launchURL(url)`：真实存在，Zotero 内部大量调用【源码验证 7.0.32】`http.js:1166, 1402`、`zoteroPane.js:529, 4318, 6548`；`ZoteroPane.launchURL()` 已废弃并转调它（`zoteroPane.js:5273-5275`：`"ZoteroPane.launchURL() is deprecated -- use Zotero.launchURL()"`）。
- `Zotero.launchFile(file)`：同上，真实存在【源码验证 7.0.32】`file.js:1493, 1554`；`ZoteroPane.launchFile()` 废弃转调（`zoteroPane.js:5264-5266`）。参数是 `nsIFile` 或路径（`file.js:1554` 传的是 `PathUtils.parent(file)` 结果，即路径字符串）。
- **限制**：`launchFile`/`launchURL` 走系统默认关联，**不能传命令行参数**。要带参数（`--open <pdf> --page N`）只能用 `exec`。
- `IOUtils.launchURL` 在 Gecko 中**不保证存在**，本文不采用；请用 `Zotero.launchURL`。`nsIProcess` 直接手搓也就是 `exec` 内部做的事，没必要重复。

### 6.3 本项目的启动策略（最稳的一条）

应用自己会写一份启动信息文件 `%APPDATA%\BabelDOC-Studio\zotero\launch-info.json`【本项目契约】`core/zotero.py:878-908`，字段：

```json
{
  "app": "BabelDOC Studio",
  "version": "1.x.y",
  "port": 8765,
  "url": "http://127.0.0.1:8765",
  "base_dir": "E:\\...\\BabelDOC-Studio",
  "python": "...\\python.exe",
  "pythonw": "...\\pythonw.exe",
  "script": "...\\app.py",
  "start_bat": "...\\Start.bat",
  "launcher": "...\\BabelDOC Studio.exe",
  "started": 1730000000.0
}
```

推荐流程（插件侧）：

```
1. 读 launch-info.json → baseUrl / launcher / start_bat / pythonw+script
2. GET  baseUrl + "/api/health"  （timeout 800ms）
   ├─ 通了 → POST /api/zotero/open
   └─ 不通：
      3. 启动：优先 launcher（.exe）；否则 start_bat；否则 pythonw + script
      4. 轮询 /api/health 最多 ~25s（每 500ms）
      5. 通了 → POST /api/zotero/open；仍不通 → 进度窗报错 + 提供「重试」
```

```js
function launchBabelDOC(info) {
  const cmd = info.launcher || info.start_bat;
  if (!cmd) {
    // 退回用 pythonw 直接跑脚本
    if (info.pythonw && info.script) {
      return Zotero.Utilities.Internal.exec(info.pythonw, [info.script, "--server-only", "--port", String(info.port || 8765)]);
    }
    throw new Error("launch-info.json 里没有可用的启动项");
  }
  if (/\.bat$/i.test(cmd)) {
    // .bat 不是可执行文件（isExecutable() 可能为 false），交给 cmd.exe
    return Zotero.Utilities.Internal.exec("C:\\Windows\\System32\\cmd.exe", ["/c", "start", "", cmd]);
  }
  // 注意：不要 await —— 常驻进程的 Promise 要等进程退出才 resolve
  Zotero.Utilities.Internal.exec(cmd, []).catch(e => Zotero.logError(e));
  return Promise.resolve();
}
```

**风险与回退**（重要）：

| 风险 | 表现 | 回退 |
| --- | --- | --- |
| `FileUtils.File` 对 `.bat` 的 `isExecutable()` 返回 false | `exec` 抛 `xxx is not an executable` | 走 `cmd.exe /c start "" "path.bat"`（如上面代码）；或 `Zotero.launchFile(batPath)`（无参数，但 `Start.bat` 通常无参数即可） |
| `exec` 的 Promise 一直 pending | `await` 后「无响应」 | **不 await**，用轮询 `/api/health` 判断成功 |
| 启动器被杀软拦截（本项目未签名，见 `docs/SMART-APP-CONTROL.md`） | 进程起不来 | 进度窗提示「请手动启动 BabelDOC Studio，然后点重试」 |
| 用户把应用装在别的目录 / 绿色版 | launch-info 路径不对 | 偏好里提供「应用路径」文本框 + 文件选择器（§8） |

> 安全约束：插件拥有完整本机权限（官方明确说明）【官方文档】，所以「起进程」不需要额外权限声明——但也意味着**必须**只从可信路径启动，路径必须来自 launch-info 或用户手选，**绝不能**拼进 shell 命令字符串。

---

## 7. 与 BabelDOC Studio 的 HTTP 契约（本项目已实现，插件照此对接）

【本项目契约】`app.py:1245-1321`、`core/zotero.py:381-424, 740-827, 918-936`。服务默认 `127.0.0.1:8765`（被占用时顺延，`app.py:1327-1338`），**端口以 launch-info.json 的 `port` 为准**。

### 7.1 `GET /api/health`

```json
{ "ok": true, "app": "BabelDOC Studio", "version": "1.x.y",
  "features": ["..."], "build": "..." }
```

用途：探活。判定条件建议 `data.app === "BabelDOC Studio"`（`app.py` 的 `_app_alive()` 也是匹配 `BabelDOC Studio` 字样，`app.py:1372`）。

### 7.2 `POST /api/zotero/open`

请求体（插件 → 应用）【本项目契约】`core/zotero.py:381-424, 758-759`：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `path` | ✅ | 本地 PDF 绝对路径（也接受 `file`） |
| `page` | 否 | **1 基**当前页，来自 reader（`pageIndex + 1`） |
| `page_total` / `page_count` | 否 | 原 PDF 总页数（插件拿不到可不传，后端会自己算） |
| `library_id` | 否 | `item.libraryID` |
| `item_key` | 否 | 父条目 `item.key` |
| `attachment_key` | 否 | 附件 `attachment.key` |
| `title` | 否 | `item.getField("title")` |
| `doi` | 否 | `item.getField("DOI")` |
| `creators` | 否 | 作者串（≤400 字符） |
| `year` | 否 | 年份 |
| `open_window` | 否 | 默认 `true`，`false` 时只入库不弹窗 |

成功响应：

```json
{ "ok": true, "link_id": "...", "path": "<应用管理的副本路径>", "page": 3, "pages": 20,
  "variant": "original", "title": "...", "doi": "...", "imported": true,
  "source": "reader", "message": "...", "url": "/viewer?..." }
```

失败响应（HTTP 400/404/415）——**插件应直接展示 `error`，并用 `retryable` 决定是否给「重试」**：

```json
{ "ok": false, "error": "附件尚未下载或文件已丢失：xxx.pdf。请先在 Zotero 中下载附件，再重试。",
  "code": "file_missing", "retryable": true, "detail": "C:\\..." }
```

错误码【本项目契约】`core/zotero.py:72-94, 381-414`：

| code | HTTP | retryable | 含义 / 插件动作 |
| --- | --- | --- | --- |
| `missing_path` | 400 | ✅ | 没给路径 / 路径无法识别 → 提示用户在 Zotero 里重新选中 |
| `file_missing` | 404 | ✅ | 文件缺失（附件没下载 / 链接文件已失效）→ 提示「在 Zotero 中下载附件后重试」 |
| `not_pdf` | 415 | ❌ | 不是 PDF → 禁用入口或提示不支持 |
| `plugin_missing` | 404 | ❌ | 应用侧缺插件源码（`tools/zotero-plugin`）→ 只影响 xpi 下载 |

### 7.3 其他可用端点

| 端点 | 用途 |
| --- | --- |
| `POST /api/zotero/position` | 应用侧回报阅读位置（`{path, page, pages}`），一般由应用内部调用，插件不需要 |
| `GET /api/zotero/status` | 返回 `{ok, enabled, imports_dir, link_count, links[], plugin:{available, version}, launch{}}`，可用于设置面板「连接自检」 |
| `GET /api/zotero/plugin.xpi` | 返回 `application/x-xpinstall`，文件名 `babeldoc-zotero-<version>.xpi`，内容 = `tools/zotero-plugin/` 的 zip（**manifest.json 在 zip 根**）【本项目契约】`core/zotero.py:852-872` |

---

## 8. 读取本地 JSON / 目录：拿到 `%APPDATA%`

### 8.1 读文件（官方推荐路径）

```js
// 官方文档明确给出的 API
const text = await Zotero.File.getContentsAsync(path);      // 返回字符串
await Zotero.File.putContentsAsync(path, "some text");      // 写字符串
```

【官方文档】<https://www.zotero.org/support/dev/client_coding/javascript_api>（File I/O 一节）；实现见 `file.js:218-300`（内部用 `IOUtils.read`，`file.js:299`）。

更「新平台」的写法（Zotero 7 源码自己也在用）【源码验证 7.0.32】：

```js
if (!await IOUtils.exists(path)) return null;
const obj = JSON.parse(await IOUtils.readUTF8(path));       // 或 IOUtils.readJSON(path)
await IOUtils.writeJSON(path, obj);                          // reader.js:925
const joined = PathUtils.join(dir, "file.json");              // reader.js:728
const parent = PathUtils.parent(path);                        // file.js:111
```

`IOUtils.writeJSON`、`PathUtils.join/parent/filename` 在 7.0.32 源码里确实被使用（见上面行号；这些调用都发生在 xpcom 模块/窗口作用域），`IOUtils.readUTF8` 属同一 Firefox 115 `IOUtils` 家族（Zotero 7 基于 FF115，官方 dev 页确认平台版本）【官方文档】+【推断，低风险】。保守写法用 `Zotero.File.getContentsAsync` + `JSON.parse`。

> **作用域坑（重要）**：`IOUtils` / `PathUtils` 是 Gecko 的 chrome 全局，官方文档只承诺 bootstrap 作用域里有 `Zotero`、`Services`、`Cc`、`Ci` 等【官方文档】。**在 `bootstrap.js` 顶层直接写 `PathUtils.join(...)` 有 `ReferenceError` 风险**。骨架里请用 `nsIFile`（`Services.dirsvc` + `file.append()` + `file.path`）或 `Zotero.File.pathToFile(path).exists()`，这两条都是 Zotero 源码在用的【源码验证 7.0.32】`file.js:43, 722`。

### 8.2 `%APPDATA%` 怎么拿

Zotero 7 源码本身已经不用 `Services.dirsvc` 了（全库无 `dirsvc` 命中），但 Gecko 的目录服务仍可用：

```js
function getAppDataDir() {
  try {
    return Services.dirsvc.get("AppData", Ci.nsIFile).path;   // C:\Users\<u>\AppData\Roaming
  } catch (e) {
    Zotero.logError(e);
    return null;
  }
}

// 用 nsIFile 拼路径（bootstrap 作用域安全），避免依赖 PathUtils
const appData = getAppDataDir();
const f = Services.dirsvc.get("AppData", Ci.nsIFile).clone();
f.append("BabelDOC-Studio");
f.append("zotero");
f.append("launch-info.json");
const launchInfoPath = f.path;
if (Zotero.File.pathToFile(launchInfoPath).exists()) { /* ... */ }
```

- `Services.dirsvc.get("AppData", Ci.nsIFile)` 是 Gecko 的 Windows 目录服务 key（`NS_WIN_APPDATA_DIR`）【社区示例/平台约定，**未在本机验证**】。
- **安全回退（推荐实现成三级）**：
  1. 偏好 `extensions.babeldoc.launchInfoPath` 若已设置 → 直接用；
  2. 否则 `Services.dirsvc.get("AppData", ...)` 拼默认路径；
  3. 再失败 → 设置面板里让用户「选择 BabelDOC Studio 目录」，选中后用 `PathUtils.join(dir, ".babeldoc", "launch-info.json")` 之类探测，或退化为「只按用户填的端口连接」（不自动启动）。
- 另一个稳定锚点：`Zotero.DataDirectory.dir`（Zotero 数据目录）也可用，但那是 `Documents\Zotero`，与 AppData 无关，仅作日志目录。

### 8.3 让用户选文件 / 目录

Zotero 7 有内部模块 `FilePicker`（源码里这样用）【源码验证 7.0.32】`reader.js:26, 467-473`：

```js
const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
const fp = new FilePicker();
fp.init(window, "选择 BabelDOC Studio 启动器", fp.modeOpen);
fp.appendFilter("可执行文件", "*.exe;*.bat");
const rv = await fp.show();
if (rv === fp.returnOK) {
  const path = fp.file;      // 字符串路径
}
```

> `FilePicker` 是 `chrome://zotero/...` 内部模块，7 里存在、8 里官方也推荐用它（Zotero 8 dev 页提到「we recommend using Zotero's FilePicker module」）【官方文档】。若担心跨版本，回退用 `Zotero.FilePicker`（若存在）或直接从偏好里手填路径。

---

## 9. 偏好设置面板与偏好读写

### 9.1 注册面板

```js
// startup()
Zotero.PreferencePanes.register({
  pluginID: "babeldoc-studio@pidesign.local",   // 必需
  src: "prefs.xhtml",                            // 必需，XHTML 片段（不能有 <!DOCTYPE>）
  scripts: ["prefsPane.js"],                     // 可选
  stylesheets: ["prefs.css"],                    // 可选（可省）
  label: "BabelDOC",                             // 侧栏显示名；不填则用插件名
  image: "icons/icon-20.svg",                    // 侧栏图标；不填用插件图标
});
```

【官方文档】Zotero 7 dev 页 “Preference Panes”；【源码验证 7.0.32】`preferencePanes.js:99-150`（`register` 只强制要求 `pluginID` + `src`，其余可选；`label` 缺省取 `Zotero.Plugins.getName(pluginID)`，`image` 缺省取插件 24px 图标）。

**命名冲突警告**：`src`/`scripts` 里的相对路径会经 `Zotero.Plugins.resolveURI(pluginID, uri)` 解析（`preferencePanes.js:140-145`）。**根目录的 `prefs.js` 已被 Zotero 占用为「默认偏好文件」**（见 §9.3），所以面板脚本请命名 `prefsPane.js`，不要叫 `prefs.js`。

### 9.2 面板 XHTML + 输入框绑定偏好

```xml
<!-- prefs.xhtml：XUL 为默认命名空间，HTML 元素必须加 html: 前缀；不要写 <!DOCTYPE> -->
<vbox>
  <groupbox>
    <label><html:h2>BabelDOC Studio</html:h2></label>
    <hbox align="center">
      <label value="应用路径"/>
      <html:input type="text" preference="extensions.babeldoc.appPath" style="width: 340px"/>
      <button label="浏览…" oncommand="BabeldocPrefs.browse()"/>
    </hbox>
    <hbox align="center">
      <label value="服务端口"/>
      <html:input type="number" preference="extensions.babeldoc.port" style="width: 90px"/>
      <label value="（留空则读 launch-info.json）"/>
    </hbox>
    <checkbox label="点开后自动启动 BabelDOC Studio" preference="extensions.babeldoc.autoLaunch"/>
    <checkbox label="打开时带上当前阅读页" preference="extensions.babeldoc.passPage"/>
  </groupbox>
  <groupbox>
    <label><html:h2>状态</html:h2></label>
    <description id="babeldoc-status">未检测</description>
    <button label="检测连接" oncommand="BabeldocPrefs.test()"/>
  </groupbox>
</vbox>
```

Zotero 7 的绑定方式：**直接把 `preference="<完整偏好键>"` 写在表单元素上，不需要 `<preference>` 标签**；`<preference>` 标签 + 用 `getElementById().value` 读值的方式在 7 里已不再支持，请改用 `Zotero.Prefs.get()`【官方文档】。

元素支持 `preference` 属性的前提是 Zotero 面板加载器会给它们挂上绑定。Zotero 自己的偏好面板就是这么写的，`checkbox` / `radiogroup` / `menulist` / `input` 都支持【源码验证 7.0.32】`preferences/preferences_general.xhtml:88-100`（`<checkbox preference="extensions.zotero.downloadAssociatedFiles">`）、`:33`（`<radiogroup preference="browser.theme.toolbar-theme">`）、`:52`（`<menulist preference="extensions.zotero.itemPaneHeader">`）。

### 9.3 默认值与读写

- 默认偏好放在**插件根目录的 `prefs.js`**（不是 Zotero 6 的 `defaults/preferences/prefs.js`），格式：

```js
// prefs.js（插件根目录）
pref("extensions.babeldoc.appPath", "");
pref("extensions.babeldoc.port", 0);
pref("extensions.babeldoc.autoLaunch", true);
pref("extensions.babeldoc.passPage", true);
pref("extensions.babeldoc.launchInfoPath", "");
```

【官方文档】Zotero 7 dev 页 “Default Preferences”：`prefs.js` 在安装/启用时和每次启动时被读取；`defaults/preferences/` 目录方式在 bootstrapped 插件里不生效。

- 运行时读写：

```js
const v = Zotero.Prefs.get("extensions.babeldoc.autoLaunch");   // 布尔
Zotero.Prefs.set("extensions.babeldoc.appPath", "D:\\Apps\\BabelDOC Studio.exe");
```

【源码验证 7.0.32】`reader.js:1010`（`Zotero.Prefs.set('reader.contentDarkMode', ...)`）、`tabs.js:91`（`Zotero.Prefs.registerObserver`）。

- 监听变化（可选）：

```js
const observerID = Zotero.Prefs.registerObserver("extensions.babeldoc.appPath", (value) => { ... });
// shutdown 里：Zotero.Prefs.unregisterObserver(observerID);
```

【源码验证 7.0.32】`tabs.js:91-98, 100-103`。

---

## 10. 用户反馈：进度窗与「错误 + 重试」

### 10.1 `Zotero.ProgressWindow`

构造与常用方法【源码验证 7.0.32】`progressWindow.js:103-160, 189-210, 245-292, 285-377`：

```js
const pw = new Zotero.ProgressWindow({ closeOnClick: false }); // 可选 { window }
pw.changeHeadline("BabelDOC Studio");        // (text, cssIconKey?, postText?)
pw.addDescription("正在把 PDF 交给 BabelDOC…");
const line = new pw.ItemProgress("document", "准备中");  // (itemType 或 cssIcon, text, parent?)
line.setProgress(30);                                     // 0–100
line.setText("已连接");
line.setError();                                          // 变成错误图标
pw.show();
pw.startCloseTimer(5000);                     // (ms, requireMouseOver?)
pw.close();
```

- `ItemProgress.setError()` 只改图标；错误文案用 `setText()` 或 `addDescription()`。
- `startCloseTimer(ms)` 之后窗口自动关闭；`closeOnClick: false` 可避免用户误点关掉。
- 典型组合：`show()` → 调 HTTP → 成功改 headline + `startCloseTimer(3000)`；失败 `setError()` + 保留窗口（不设 close timer）。

### 10.2 「错误 + 重试」：两种方案

**方案 A（推荐，非阻塞）**：进度窗 + 让用户再点一次菜单/工具栏按钮。

- 完全非阻塞；菜单本身就是天然的「重试按钮」。
- 若后端返回 `retryable: true`（§7.2），文案写清「请先在 Zotero 中下载附件，然后重新点击此菜单」。

**方案 B（模态确认框，会阻塞窗口交互）**：`Services.prompt.confirmEx`

Zotero 自己的用法（源码原文）【源码验证 7.0.32】`reader.js:810-827`：

```js
const ps = Services.prompt;
const buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
                  + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;
const index = ps.confirmEx(
  window,                       // 父窗口（Zotero.getMainWindow()）
  "无法打开 BabelDOC Studio",     // 标题
  "本地服务没有响应。是否重试？",   // 正文
  buttonFlags,
  "重试",                        // 按钮 0 文案（配合 BUTTON_TITLE_IS_STRING）
  "",                            // 按钮 1（此处 CANCEL，文案由系统给）
  "",                            // 按钮 2（未使用）
  null,                          // 复选框文案（null = 不显示）
  {}                             // 复选框状态对象（会被写入 .value）
);
if (index === 0) { /* 重试 */ }
```

`confirmEx` 的返回值是按钮索引（0/1/2）。**它会以模态框阻塞父窗口**，官方/源码都是这样用的，但不符合「不阻塞 UI」的要求 → 只在「首次点击就需要用户决策」时用，常规失败走方案 A。

> 另有 `Zotero.alert(window, title, message)`（`reader.js:838` 使用）作为最简单的错误弹窗；同样模态，适合「不可重试」的硬错误。

---

## 11. 打包、安装、更新

### 11.1 目录布局（与本仓库约定一致）

本仓库后端只会打包 `tools/zotero-plugin/`，并把该目录下的所有文件按**相对路径**写入 zip 根【本项目契约】`core/zotero.py:56, 849-872`；`plugin_available()` 要求该目录下存在 `manifest.json` 和 `bootstrap.js`。

```
tools/zotero-plugin/            ← PLUGIN_DIR，必须新建
├── manifest.json               ← 必须在 zip 根
├── bootstrap.js                ← 必须在 zip 根
├── prefs.js                    ← 默认偏好（Zotero 自动读取）
├── prefs.xhtml                 ← 偏好面板片段
├── prefsPane.js                ← 面板脚本（注意不要叫 prefs.js）
├── icons/
│   ├── icon-48.png
│   ├── icon-96.png
│   └── icon-16.svg
└── locale/
    ├── zh-CN/babeldoc.ftl
    └── en-US/babeldoc.ftl
```

被排除的目录/后缀（后端打包时跳过）：`dist`、`node_modules`、`.git`、`__pycache__`、`tests`，以及 `*.map`、`*.pyc`【本项目契约】`core/zotero.py:849, 867-870`。

### 11.2 本地构建 XPI

XPI 就是 **manifest.json 在根目录的 zip**【官方文档】。Windows 上：

```powershell
# 在仓库根目录执行
$src = "tools\zotero-plugin"
$out = "dist\babeldoc-zotero-0.1.0.xpi"
if (!(Test-Path dist)) { New-Item -ItemType Directory dist | Out-Null }
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path "$src\*" -DestinationPath $out -Force
# 校验：manifest.json 必须在 zip 根（不能多一层目录）
tar -tf $out | Select-String -Pattern "^manifest\.json$"
```

> 注意 `Compress-Archive -Path "dir\*"` 才会把**内容**放到根；用 `-Path "dir"` 会多一层目录，Zotero 会装不上。
> 也可以直接让应用生成：应用已实现 `GET /api/zotero/plugin.xpi`（内存里 zip，manifest 在根）【本项目契约】`core/zotero.py:852-872`，开发时点这个 URL 就能装。

### 11.3 安装

- 用户端官方说明：下载 `.xpi`，在 Zotero 里 `Tools → Plugins`，把 xpi **拖进 Plugins 窗口**【官方文档】<https://www.zotero.org/support/plugins>。
- 也可以 `Tools → Plugins → 齿轮 → Install Plugin From File…`（同一入口的另一种说法，社区通用）【社区示例】。
- 从 URL 安装：`/api/zotero/plugin.xpi` 返回 `Content-Type: application/x-xpinstall`，用浏览器/`Zotero.launchURL` 打开该 URL 时 Zotero 会接管安装【本项目契约】【推断，需实测】。
- 安装/启用/升级后**无需重启 Zotero**（bootstrapped 插件的核心特性）【官方文档】。

### 11.4 需要签名吗？

- 官方插件文档**只字未提签名**，安装方式是「拖 xpi」【官方文档】<https://www.zotero.org/support/plugins>。
- Zotero 用的是**自研的 bootstrapped 插件框架**（不是 Firefox WebExtensions/AMO 渠道），因此 **不需要 AMO 签名**，也没有 `about:config` 里 Firefox 那种 `xpinstall.signatures.required` 限制【推断，中高置信；依据：官方 dev 页说明 Zotero 自行重新实现了 bootstrapped extension 支持，且安装文档无签名步骤】。
- **风险**：如果 Zotero 未来引入签名策略，会在 dev 页公告。缓解：`update_url` 走 HTTPS；发布时同时提供 SHA-256。
- 另需注意：Windows 上「下载的 xpi 带 Mark-of-the-Web」不影响 Zotero 安装（它不是可执行文件），但如果 xpi 内嵌 `.exe`（本项目不嵌）才会触发 SmartScreen。

### 11.5 更新机制

`manifest.json` 的 `update_url` 指向 JSON 清单【官方文档】：

```json
{
  "addons": {
    "babeldoc-studio@pidesign.local": {
      "updates": [
        {
          "version": "0.2.0",
          "update_link": "https://example.com/babeldoc/babeldoc-zotero-0.2.0.xpi",
          "update_hash": "sha256:<hex>",
          "applications": {
            "zotero": { "strict_min_version": "7.0", "strict_max_version": "7.0.*" }
          }
        }
      ]
    }
  }
}
```

- `version` 必须比已装版本**大**才会提示更新；`strict_min_version`/`strict_max_version` 可在清单里覆盖 manifest 里的值，**从而在不发新版的情况下放宽兼容范围**【官方文档】。
- `update_hash` 可选但建议填；`update_link` 必须是可直接下载的 xpi。
- 没有 `update_url` 的插件不会自动更新（本仓库这种「应用自带插件」的场景，可以让应用定期检查 `plugin.version` 与自身期望版本，提示用户重装即可——`GET /api/zotero/status` 已返回 `plugin.version`【本项目契约】）。

### 11.6 Zotero 7 ↔ 8 差异（会影响本插件）

| 主题 | Zotero 7.0.x | Zotero 8+ | 处理 |
| --- | --- | --- | --- |
| 菜单 API | **无** `Zotero.MenuManager` | 有 `Zotero.MenuManager` | 能力探测：有则用，否则 DOM 注入 |
| 模块系统 | `.jsm` + `ChromeUtils.import` | 全量 ESM（`.mjs`），`Services.jsm` 手动 import 被移除 | 插件只用 `Zotero.*` 与 `ChromeUtils.importESModule`，两者都安全 |
| Promise | 蓝鸟 Promise（`.map/.filter/.each` 等实例方法） | 标准 Promise，蓝鸟已移除 | **只用 `async/await` + 标准 Promise**，两边通吃 |
| `Zotero.spawn()` | 存在 | 已移除 | 不要用 |
| `Services.appShell.hiddenDOMWindow` | 可用 | 非 mac 平台已移除 | 不要用 |
| 标签页右键 | 动态 popup，无 id | `main/tab` target | 见 §2.4 |

【官方文档】<https://www.zotero.org/support/dev/zotero_8_for_developers>（Platform Changes + Custom Menu Items）。

---

## 12. 最小可行插件骨架

以下文件可直接落到 `tools/zotero-plugin/`，`bootstrap.js` 已实现：文献列表右键菜单（仅当有本地 PDF）、阅读器工具栏按钮 + 页面右键项、HTTP 探活/打开、启动器回退、进度窗反馈、偏好面板。

### 12.1 `manifest.json`

```json
{
  "manifest_version": 2,
  "name": "BabelDOC Studio Bridge",
  "version": "0.1.0",
  "description": "在 BabelDOC Studio 中打开 Zotero 里选中的 PDF，并跳转到当前阅读页。",
  "author": "PiDesign",
  "icons": {
    "48": "icons/icon-48.png",
    "96": "icons/icon-96.png"
  },
  "applications": {
    "zotero": {
      "id": "babeldoc-studio@pidesign.local",
      "update_url": "https://example.com/babeldoc/updates.json",
      "strict_min_version": "7.0",
      "strict_max_version": "7.0.*"
    }
  }
}
```

### 12.2 `prefs.js`（默认偏好）

```js
pref("extensions.babeldoc.appPath", "");
pref("extensions.babeldoc.port", 0);
pref("extensions.babeldoc.autoLaunch", true);
pref("extensions.babeldoc.passPage", true);
pref("extensions.babeldoc.launchInfoPath", "");
```

### 12.3 `bootstrap.js`

```js
/* BabelDOC Studio ↔ Zotero 7 bridge — minimal viable add-on */

const PLUGIN_ID = "babeldoc-studio@pidesign.local";
const ITEM_MENU_ID = "babeldoc-menuitem-open";
const APP_NAME = "BabelDOC Studio";

let chromeHandle = null;

function log(msg) { Zotero.debug("[BabelDOC] " + msg); }

/* ------------------------------------------------------------------ */
/* launch-info.json：由 BabelDOC Studio 写出，告诉插件端口与启动方式     */
/* ------------------------------------------------------------------ */

function getAppDataDir() {
  try {
    return Services.dirsvc.get("AppData", Ci.nsIFile).path;
  } catch (e) {
    log("dirsvc AppData failed: " + e);
    return null;
  }
}

/** 用 nsIFile 拼路径，避开 bootstrap 作用域里可能不存在的 PathUtils */
function joinPath(...parts) {
  let file = null;
  for (const part of parts) {
    if (!part) continue;
    if (file === null) {
      // 第一段可能是绝对路径（用户偏好），也可能是目录名
      file = Zotero.File.pathToFile(part);
    } else {
      file.append(part);
    }
  }
  return file ? file.path : "";
}

function launchInfoCandidates() {
  const list = [];
  const custom = Zotero.Prefs.get("extensions.babeldoc.launchInfoPath");
  if (custom) list.push(custom);
  const appData = getAppDataDir();
  if (appData) {
    list.push(joinPath(appData, "BabelDOC-Studio", "zotero", "launch-info.json"));
  }
  return list;
}

async function readLaunchInfo() {
  for (const path of launchInfoCandidates()) {
    try {
      if (!Zotero.File.pathToFile(path).exists()) continue;
      const data = JSON.parse(await Zotero.File.getContentsAsync(path));
      if (data && data.app === APP_NAME) return data;
    } catch (e) {
      log("read launch-info failed for " + path + ": " + e);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                               */
/* ------------------------------------------------------------------ */

function baseURL(info) {
  const prefPort = parseInt(Zotero.Prefs.get("extensions.babeldoc.port"), 10);
  const port = prefPort || (info && info.port) || 8765;
  return "http://127.0.0.1:" + port;
}

async function probe(url, timeout = 900) {
  try {
    const xhr = await Zotero.HTTP.request("GET", url + "/api/health", {
      timeout, noCache: true, errorDelayMax: 0, successCodes: [200],
    });
    const data = JSON.parse(xhr.responseText);
    return !!(data && data.app === APP_NAME);
  } catch (e) {
    return false;
  }
}

async function postOpen(url, payload) {
  const xhr = await Zotero.HTTP.request("POST", url + "/api/zotero/open", {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    timeout: 20000,
    errorDelayMax: 0,
    successCodes: false,           // 4xx 也要读错误体
  });
  let data = null;
  try { data = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON */ }
  return { status: xhr.status, data };
}

/* ------------------------------------------------------------------ */
/* 选中项 / reader                                                    */
/* ------------------------------------------------------------------ */

function hasLocalPDFSync(items) {
  for (const item of items) {
    try {
      if (item.isAttachment()) {
        if (item.isPDFAttachment() && item.getFilePath()) return true;
      } else if (item.isRegularItem()) {
        for (const id of item.getAttachments()) {
          const att = Zotero.Items.get(id);
          if (att && att.isPDFAttachment() && att.getFilePath()) return true;
        }
      }
    } catch (e) { log("hasLocalPDFSync: " + e); }
  }
  return false;
}

function getActiveReader() {
  const win = Zotero.getMainWindow();
  if (!win || !win.Zotero_Tabs) return null;
  const Tabs = win.Zotero_Tabs;
  if (Tabs.selectedType !== "reader") return null;
  return Zotero.Reader.getByTabID(Tabs.selectedID) || null;
}

/** 0 基页索引；拿不到返回 0 */
function getReaderPageIndex(reader) {
  try {
    if (reader && Number.isInteger(reader._state && reader._state.pageIndex)) {
      return reader._state.pageIndex;
    }
  } catch (e) { /* Proxy/内部字段可能变化 */ }
  try {
    const item = Zotero.Items.get(reader.itemID);
    const last = item.getAttachmentLastPageIndex();
    if (Number.isInteger(last)) return last;
  } catch (e) { /* ignore */ }
  return 0;
}

/** 从「附件 itemID 或父条目」整理出 payload */
async function buildPayload(attachment, parentItem, pageIndex, withPage) {
  const path = await attachment.getFilePathAsync();
  if (!path) return { error: "file_missing" };
  const meta = parentItem || attachment;
  const payload = { path };
  if (withPage && Number.isInteger(pageIndex) && pageIndex >= 0) {
    payload.page = pageIndex + 1;            // 后端 page 是 1 基
  }
  payload.title = meta.getField("title") || "";
  payload.doi = (meta.isRegularItem() && meta.getField("DOI")) || "";
  payload.year = meta.getField("date") || "";
  payload.creators = "";
  try {
    if (meta.isRegularItem()) {
      payload.creators = meta.getCreators()
        .map(c => [c.firstName, c.lastName].filter(Boolean).join(" "))
        .join(", ");
      payload.library_id = String(meta.libraryID || "");
      payload.item_key = meta.key || "";
    }
    payload.attachment_key = attachment.key || "";
  } catch (e) { log("meta: " + e); }
  return { payload, attachment, parentItem: meta };
}

/* ------------------------------------------------------------------ */
/* 主流程：打开                                                       */
/* ------------------------------------------------------------------ */

async function openPayload(payload) {
  const pw = new Zotero.ProgressWindow({ closeOnClick: false });
  pw.changeHeadline("BabelDOC Studio");
  const line = new pw.ItemProgress("document", "正在打开 PDF…");
  pw.show();

  let info = await readLaunchInfo();
  let url = baseURL(info);
  let alive = await probe(url);

  if (!alive && Zotero.Prefs.get("extensions.babeldoc.autoLaunch")) {
    line.setText("正在启动 BabelDOC Studio…");
    try {
      launchApp(info, url);
    } catch (e) {
      log("launch failed: " + e);
    }
    for (let i = 0; i < 50 && !alive; i++) {       // ~25s
      await Zotero.Promise.delay(500);
      alive = await probe(url, 600);
    }
  }

  if (!alive) {
    line.setError();
    line.setText("本地服务未响应");
    pw.addDescription("请先手动启动 BabelDOC Studio，然后再点一次此菜单。可在 设置 → BabelDOC 查看端口。");
    return false;
  }

  line.setText("正在发送文件…");
  try {
    const { status, data } = await postOpen(url, payload);
    if (data && data.ok) {
      line.setProgress(100);
      line.setText("已在 BabelDOC Studio 中打开");
      pw.addDescription(data.message || "");
      pw.startCloseTimer(3500);
      return true;
    }
    line.setError();
    line.setText((data && data.error) || ("请求失败（HTTP " + status + "）"));
    if (data && data.retryable) {
      pw.addDescription("该问题可重试：修复后再次点击菜单即可。");
    }
    return false;
  } catch (e) {
    line.setError();
    line.setText("无法连接 BabelDOC Studio");
    pw.addDescription(String(e));
    return false;
  }
}

function launchApp(info, url) {
  const port = (info && info.port) || 8765;
  const cmd = info && (info.launcher || info.start_bat);
  if (cmd) {
    if (/\.bat$/i.test(cmd)) {
      // .bat 不是可执行文件；交给 cmd.exe，参数用数组，路径空格安全
      return Zotero.Utilities.Internal.exec("C:\\Windows\\System32\\cmd.exe",
        ["/c", "start", "", cmd]);
    }
    // 不 await：常驻进程的 Promise 在进程退出时才 resolve
    Zotero.Utilities.Internal.exec(cmd, []).catch(e => log("exec: " + e));
    return Promise.resolve();
  }
  if (info && info.pythonw && info.script) {
    Zotero.Utilities.Internal.exec(info.pythonw,
      [info.script, "--server-only", "--port", String(port)]).catch(e => log("exec py: " + e));
    return Promise.resolve();
  }
  throw new Error("launch-info.json 中没有可用的启动项，且未配置应用路径");
}

async function openSelectedItems() {
  const zp = Zotero.getActiveZoteroPane();
  const items = zp ? zp.getSelectedItems() : [];
  const reader = getActiveReader();
  const pageIndex = reader ? getReaderPageIndex(reader) : 0;
  const withPage = !!Zotero.Prefs.get("extensions.babeldoc.passPage");

  for (const item of items) {
    if (item.isAttachment()) {
      if (!item.isPDFAttachment()) continue;
      const built = await buildPayload(item, item.parentItem, pageIndex, withPage);
      if (built.error) { notifyMissing(); return; }
      await openPayload(built.payload);
      return;
    }
    if (item.isRegularItem()) {
      for (const id of item.getAttachments()) {
        const att = Zotero.Items.get(id);
        if (!att || !att.isPDFAttachment()) continue;
        const built = await buildPayload(att, item, pageIndex, withPage);
        if (built.error) continue;
        await openPayload(built.payload);
        return;
      }
    }
  }
  Zotero.alert(Zotero.getMainWindow(), "BabelDOC Studio",
    "所选条目没有本地 PDF 附件。请先在 Zotero 中下载附件。");
}

async function openAttachment(attachmentItemID, pageIndex) {
  const att = Zotero.Items.get(attachmentItemID);
  if (!att) return;
  const built = await buildPayload(att, att.parentItem, pageIndex, true);
  if (built.error) { notifyMissing(); return; }
  await openPayload(built.payload);
}

function notifyMissing() {
  const pw = new Zotero.ProgressWindow();
  pw.changeHeadline("BabelDOC Studio");
  const line = new pw.ItemProgress("dialog-error", "找不到 PDF 文件");
  line.setError();
  pw.addDescription("该附件尚未下载或链接已失效，请先在 Zotero 中下载附件。");
  pw.show();
  pw.startCloseTimer(6000);
}

/* ------------------------------------------------------------------ */
/* UI：文献列表右键菜单 + 阅读器入口                                    */
/* ------------------------------------------------------------------ */

function installItemMenu(win) {
  const doc = win.document;
  const popup = doc.getElementById("zotero-itemmenu");
  if (!popup || doc.getElementById(ITEM_MENU_ID)) return;

  win.MozXULElement.insertFTLIfNeeded("babeldoc.ftl");

  const sep = doc.createXULElement("menuseparator");
  sep.id = ITEM_MENU_ID + "-sep";

  const mi = doc.createXULElement("menuitem");
  mi.id = ITEM_MENU_ID;
  mi.classList.add("menuitem-iconic");
  doc.l10n.setAttributes(mi, "babeldoc-menu-open");

  popup.append(sep, mi);

  const onShowing = () => {
    let show = false;
    try {
      const zp = Zotero.getActiveZoteroPane();
      show = !!zp && hasLocalPDFSync(zp.getSelectedItems());
    } catch (e) { log("popupshowing: " + e); }
    mi.hidden = !show;
    sep.hidden = !show;
  };
  popup.addEventListener("popupshowing", onShowing);
  mi.addEventListener("command", () => { openSelectedItems(); });

  mi._babeldoc = { popup, onShowing };
}

function uninstallItemMenu(win) {
  const doc = win.document;
  const mi = doc.getElementById(ITEM_MENU_ID);
  if (!mi) return;
  const saved = mi._babeldoc;
  if (saved && saved.onShowing) saved.popup.removeEventListener("popupshowing", saved.onShowing);
  doc.getElementById(ITEM_MENU_ID + "-sep")?.remove();
  mi.remove();
}

function registerReaderHooks() {
  Zotero.Reader.registerEventListener("renderToolbar", (event) => {
    const { reader, doc, append } = event;
    const btn = doc.createElement("button");
    btn.className = "toolbar-button babeldoc-open";
    btn.title = "在 BabelDOC Studio 中打开";
    btn.textContent = "BabelDOC";
    btn.addEventListener("click", () => openAttachment(reader.itemID, getReaderPageIndex(reader)));
    append(btn);
  }, PLUGIN_ID);

  Zotero.Reader.registerEventListener("createViewContextMenu", (event) => {
    const { reader, append } = event;
    append({
      label: "在 BabelDOC Studio 中打开",
      onCommand: () => openAttachment(reader.itemID, getReaderPageIndex(reader)),
    });
  }, PLUGIN_ID);
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                           */
/* ------------------------------------------------------------------ */

function startup({ id, version, rootURI }, reason) {
  log(`startup ${id} ${version} reason=${reason}`);

  // chrome 注册（只有需要 chrome:// 资源时才必要；本骨架用相对路径即可跳过）
  // 注册偏好面板
  Zotero.PreferencePanes.register({
    pluginID: PLUGIN_ID,
    src: "prefs.xhtml",
    scripts: ["prefsPane.js"],
    label: "BabelDOC",
    image: "icons/icon-16.svg",
  }).catch(e => log("prefs pane: " + e));

  registerReaderHooks();
}

function shutdown({ id, version, rootURI }, reason) {
  log(`shutdown ${id} ${version} reason=${reason}`);
  if (chromeHandle) { chromeHandle.destruct(); chromeHandle = null; }
  for (const win of Zotero.getMainWindows()) {
    try { uninstallItemMenu(win); } catch (e) { log("uninstall menu: " + e); }
    try { win.document.querySelector('[href="babeldoc.ftl"]')?.remove(); } catch (e) {}
  }
  // reader 监听器由 Zotero 按 pluginID 自动清理
}

function install(data, reason) { log("install"); }
function uninstall(data, reason) { log("uninstall"); }

function onMainWindowLoad({ window }) {
  try { installItemMenu(window); } catch (e) { log("install menu: " + e); }
}

function onMainWindowUnload({ window }) {
  try { uninstallItemMenu(window); } catch (e) { log("uninstall menu: " + e); }
}
```

### 12.4 `prefs.xhtml`

```xml
<vbox>
  <groupbox>
    <label><html:h2>BabelDOC Studio</html:h2></label>
    <hbox align="center">
      <label value="启动器路径"/>
      <html:input type="text" preference="extensions.babeldoc.appPath" style="width: 340px"/>
      <button label="浏览…" oncommand="BabeldocPrefs.browse()"/>
    </hbox>
    <hbox align="center">
      <label value="服务端口（0 = 自动读取）"/>
      <html:input type="number" preference="extensions.babeldoc.port" style="width: 90px"/>
    </hbox>
    <checkbox label="未运行时自动启动 BabelDOC Studio" preference="extensions.babeldoc.autoLaunch"/>
    <checkbox label="打开时跳转到当前阅读页" preference="extensions.babeldoc.passPage"/>
  </groupbox>
  <groupbox>
    <label><html:h2>连接状态</html:h2></label>
    <description id="babeldoc-status">未检测</description>
    <button label="检测" oncommand="BabeldocPrefs.test()"/>
  </groupbox>
</vbox>
```

### 12.5 `prefsPane.js`

```js
var BabeldocPrefs = {
  statusEl() { return document.getElementById("babeldoc-status"); },

  async browse() {
    try {
      const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
      const fp = new FilePicker();
      fp.init(window, "选择 BabelDOC Studio 启动器", fp.modeOpen);
      fp.appendFilter("可执行文件", "*.exe;*.bat");
      const rv = await fp.show();
      if (rv === fp.returnOK && fp.file) {
        Zotero.Prefs.set("extensions.babeldoc.appPath", fp.file);
      }
    } catch (e) {
      Zotero.logError(e);
    }
  },

  async test() {
    const el = this.statusEl();
    el.textContent = "检测中…";
    try {
      const xhr = await Zotero.HTTP.request("GET", "http://127.0.0.1:8765/api/zotero/status", {
        timeout: 1500, noCache: true, errorDelayMax: 0, successCodes: [200],
      });
      const data = JSON.parse(xhr.responseText);
      el.textContent = "已连接 · 链接数 " + (data.link_count ?? "?")
        + " · 插件版本 " + (data.plugin && data.plugin.version ? data.plugin.version : "未打包");
    } catch (e) {
      el.textContent = "未连接（请先启动 BabelDOC Studio）";
    }
  },
};
```

> 注意：偏好面板脚本在 Zotero 8 里运行在独立全局作用域，`var` 不再跨面板共享；上面把对象挂在 `var BabeldocPrefs` 上对 7 有效，8 里建议显式 `window.BabeldocPrefs = ...`【官方文档】。

### 12.6 `locale/zh-CN/babeldoc.ftl` 与 `locale/en-US/babeldoc.ftl`

```ftl
# zh-CN
babeldoc-menu-open =
    .label = 在 BabelDOC Studio 中打开
```

```ftl
# en-US
babeldoc-menu-open =
    .label = Open in BabelDOC Studio
```

### 12.7 骨架中仍需要你补的两处

1. `payload.year`：骨架里直接用了 `meta.getField("date")`，建议改成 `meta.getField("year")`（Zotero 内置派生字段，[源码验证] `item.js:256-257`），或干脆不传。
2. `launch-info.json` 缺失时的「用户手选应用路径」：`extensions.babeldoc.appPath` 已被面板写入，但 `launchApp()` 目前只认 `launch-info.json`；建议在 `launchApp()` 里优先用该偏好作为 `cmd`（`exec` 直接跑 exe；若选的是目录则拼 `Start.bat`）。

---

## 13. 风险清单 / 未验证项（按优先级）

| # | 项 | 置信度 | 影响 | 安全回退 |
| --- | --- | --- | --- | --- |
| 1 | `Zotero.MenuManager` 不存在于 7 | **高**（7.0.32 目录 + 8 文档） | 用错 API 直接 `undefined` 报错 | 能力探测 `typeof Zotero.MenuManager !== 'undefined'`，否则 DOM 注入 |
| 2 | `reader._state.pageIndex` 语义（0 基）与是否稳定 | 中（源码可见但不属公开 API） | 传错页 → 打开到错页 | 试运行验证；回退 `getAttachmentLastPageIndex()`；再不行不传 `page` |
| 3 | `Services.dirsvc.get("AppData", Ci.nsIFile)` | 中（平台约定，未本机验证） | 找不到 launch-info → 不能自动启动 | 三级回退：偏好路径 → 默认拼路径 → 用户手选 |
| 4 | `.bat` 的 `isExecutable()` / `exec` 行为 | 中 | 自动启动失败 | `cmd.exe /c start "" path.bat`；或 `Zotero.launchFile(bat)` |
| 5 | `exec` 返回的 Promise 生命周期（进程退出才 resolve） | 高（源码 `process-finished`） | 误 await 导致「卡住」 | 不 await，改用 `/api/health` 轮询 |
| 6 | 无签名 xpi 是否始终可装 | 中高（官方文档无签名要求） | 若策略变化则装不上 | 保留手动安装说明 + 应用内 `/api/zotero/plugin.xpi` 下载 |
| 7 | 传 URL 安装（`application/x-xpinstall`）是否自动接管 | 中 | 只能手动下载再拖 | 文档里写「下载后拖入 Plugins 窗口」 |
| 8 | `renderToolbar` 事件回调参数（`doc`/`append`）细节 | 中高（源码注释） | 按钮不出现 | 改用 `createViewContextMenu` 或仅在右键菜单提供入口 |
| 9 | `item.getField("DOI")` 在无 DOI 时的返回 | 高（Zotero 按字段存在性处理） | 空串，无影响 | 不改 |
| 10 | reader 窗口（`openInWindow`）场景下的 tab 判定 | 中 | `Zotero_Tabs.selectedType` 不是 reader | 增加 `Zotero.Reader.getWindowStates()` 作为补充探测（`reader.js:1982`） |
| 11 | `IOUtils` / `PathUtils` 在 **bootstrap 作用域**是否可用 | 低（未验证；官方只保证注入 `Zotero/Services/Cc/Ci`） | `ReferenceError: PathUtils is not defined` | 用 `nsIFile`（`Services.dirsvc` + `append()`）或 `Zotero.File.pathToFile().exists()`；在窗口作用域里才用 `PathUtils/IOUtils` |
| 12 | `prefs.xhtml` 里 `type="number"` 的偏好值类型（字符串 vs 数字） | 中 | `parseInt` 已兜底 | 一律 `parseInt(Zotero.Prefs.get(...), 10)` |

---

## 14. 参考链接汇总

官方：

- Zotero 7 for Developers — <https://www.zotero.org/support/dev/zotero_7_for_developers>
- Zotero 8 for Developers（含 `Zotero.MenuManager`）— <https://www.zotero.org/support/dev/zotero_8_for_developers>
- Zotero JavaScript API（`getSelectedItems` / `Zotero.File`）— <https://www.zotero.org/support/dev/client_coding/javascript_api>
- 插件安装说明 — <https://www.zotero.org/support/plugins>
- Make It Red 示例插件 — <https://github.com/zotero/make-it-red>

源码（Zotero 7.0.32 tag）：

- `chrome/content/zotero/xpcom/reader.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/reader.js>
- `chrome/content/zotero/xpcom/http.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/http.js>
- `chrome/content/zotero/xpcom/utilities_internal.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/utilities_internal.js>
- `chrome/content/zotero/xpcom/preferencePanes.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/preferencePanes.js>
- `chrome/content/zotero/xpcom/progressWindow.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/progressWindow.js>
- `chrome/content/zotero/xpcom/data/item.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/data/item.js>
- `chrome/content/zotero/zoteroPane.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/zoteroPane.js>
- `chrome/content/zotero/zoteroPane.xhtml`（`#zotero-itemmenu`）— <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/zoteroPane.xhtml>
- `chrome/content/zotero/tabs.js`（`Zotero_Tabs`）— <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/tabs.js>
- `chrome/content/zotero/reader.xhtml` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/reader.xhtml>
- `chrome/content/zotero/xpcom/file.js` — <https://github.com/zotero/zotero/blob/7.0.32/chrome/content/zotero/xpcom/file.js>

源码（Zotero 8.0 分支）：

- `chrome/content/zotero/xpcom/pluginAPI/menuManager.js` — <https://github.com/zotero/zotero/blob/8.0/chrome/content/zotero/xpcom/pluginAPI/menuManager.js>
- 7.0.32 的 pluginAPI 目录（证明无 menuManager）— <https://github.com/zotero/zotero/tree/7.0.32/chrome/content/zotero/xpcom/pluginAPI>

本仓库（集成契约）：

- `app.py` — `/api/zotero/open`、`/api/zotero/status`、`/api/zotero/plugin.xpi`、`/api/health`
- `core/zotero.py` — `open_link()`、`build_plugin_xpi()`、`write_launch_info()`、`status()`
- `core/config.py` — `APP_DIR = %APPDATA%/BabelDOC-Studio`
