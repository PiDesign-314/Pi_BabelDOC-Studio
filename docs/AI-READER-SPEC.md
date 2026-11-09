# AI 助读 + 自动目录：接口与分工约定

本文件是「AI 助读（回答带出处）」与「自动识别文献目录」两个功能的实现契约。
所有参与实现的人都必须先读这一份，代码按这里写的接口对齐。

## 0. 目标体验

1. **自动目录**：打开 PDF 后左侧栏出现「目录」页签。
   - 优先读 PDF 自带 outline；没有时用字体/编号启发式自动识别标题。
   - 点击条目 → 跳到对应页并高亮该标题；滚动时当前章节自动高亮。
2. **AI 助读（Grounded Reading）**：
   - 在正文里选中一句 → 右键 → 菜单里出现「引用提问」「解释这段」。
   - 打开右侧 AI 面板，选中文字作为引用卡片带进去；可直接问「这个结论有实验支撑吗？」。
   - 回答中的每个论断带 `[pN]` 出处；点击 → 回到该页并闪烁高亮原文；回答末尾有「依据」列表。
   - 模型来源：优先使用本机已登录的 CLI（Codex CLI / Kimi Code CLI / Claude Code），也支持填 API Key + 模型（OpenAI 兼容）。

## 1. 文件所有权（写作用域，互不重叠）

| 责任 | 文件 |
| --- | --- |
| Lead | `web/viewer.js`（只加 bridge / 菜单 / 事件，不改已有逻辑）、`web/viewer.html`、`docs/*`、`tests/reader_ai_toc_ui.py` |
| 后端 | `core/toc.py`、`core/ai_reader.py`、`app.py`（新增路由区）、`core/config.py`、`tests/test_toc.py`、`tests/test_ai_reader.py` |
| TOC 前端 | `web/reader-toc.js`、`web/reader-toc.css` |
| AI 前端 | `web/reader-ai.js`、`web/reader-ai.css` |

不要改别人的文件；需要改时先发消息给 Lead。

## 2. 后端 HTTP 接口（`app.py`）

所有 path 参数一律走现有 `_allowed_file(path, (".pdf",))` 校验；失败返回
`{"error": "..."}` 且状态码 400/404/500。

### 2.1 `GET /api/reader/toc?path=<abs pdf path>[&force=1]`

```json
{
  "path": "E:\\...\\paper.pdf",
  "source": "outline" | "heuristic" | "none",
  "items": [
    {"title": "1 Introduction", "page": 1, "level": 1, "y": 84.5, "score": 1.0}
  ],
  "count": 12,
  "cached": true
}
```

- `source=outline`：PyMuPDF `doc.get_toc(simple=True)`，`y` 可为 `null`。
- `source=heuristic`：自动识别（字体明显大于正文 / 编号标题 / Abstract、Introduction、References 等常见标题）。`score` 为置信度 0–1。
- `source=none`：识别不到，`items=[]`。
- 结果按 doc 路径 + mtime + size 缓存到 `%APPDATA%/BabelDOC-Studio/ai/toc-<sha1>.json`；`force=1` 绕过缓存。

### 2.2 `POST /api/reader/ask`

请求：

```json
{
  "path": "E:\\...\\paper.pdf",
  "question": "这个结论有实验支撑吗？",
  "quote": {"text": "选中的原文…", "page": 3, "section": "1.1 Motivation"},
  "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}],
  "provider": {
    "id": "auto | codex | kimi | claude | api",
    "model": "",
    "base_url": "",
    "api_key": ""
  },
  "images": [
    {"data_url": "data:image/png;base64,iVBORw0KG...", "name": "screenshot.png"}
  ]
}
```

- `images` 可选，最多 4 张；只接受 PNG / JPEG / WebP / GIF 的 data URL，单张 ≤ 6 MB、总计 ≤ 12 MB，
  不合法时返回 400。API 模型会收到 OpenAI 兼容的视觉内容块；CLI 模型会把图片写到临时工作目录，
  并在 prompt 末尾告知文件名（由 CLI 自己的文件读取能力查看）。

响应：

```json
{
  "answer": "论文确实给出了实验支撑：… [p5] …",
  "citations": [
    {"ref": "p5", "page": 5, "section": "4 Evaluation", "snippet": "原文片段…"}
  ],
  "provider": "codex",
  "model": "gpt-6-sol",
  "elapsed": 12.4,
  "source": "cli | api",
  "usage": {"input_tokens": 1234, "output_tokens": 240}
}
```

- `answer` 保留 `[pN]` 标记，前端把它渲染成可点击的出处 chip。
- `citations` 是 `answer` 里出现过的页码去重后的来源列表；`snippet` 从该页原文中截取（150–240 字），`section` 来自目录。
- 失败：`{"error": "..."}`，状态码 400/503/504；错误文案要能指导用户（如「Codex 未登录：在终端运行 codex login」）。

### 2.3 `GET /api/ai/status`

```json
{
  "providers": [
    {"id": "codex", "name": "Codex CLI", "available": true, "logged_in": true,
     "version": "0.167.0", "command": "C:\\...\\codex.exe", "hint": ""},
    {"id": "kimi", "name": "Kimi Code CLI", "available": false, "logged_in": false,
     "version": "", "command": "", "hint": "未检测到 kimi 命令"},
    {"id": "claude", "name": "Claude Code", "available": true, "logged_in": true,
     "version": "2.1.120", "command": "C:\\...\\claude.exe", "hint": ""}
  ],
  "configured": {"provider": "auto", "model": "", "base_url": "", "api_key_set": false,
                 "preset": "moonshot"},
  "default": "codex"
}
```

- Codex 探测：PATH 里的 `codex`；否则扫 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`（取最新）；
  `logged_in` 看 `~/.codex/auth.json` 是否存在且非空。
- Kimi 探测：PATH 里的 `kimi` / `kimi.exe`，`logged_in` 看 `~/.kimi-code` 是否有登录态（有目录即视为可能已登录，错误由调用时暴露）。
- Claude 探测：PATH 里的 `claude`。
- 版本号探测结果缓存 ≥ 60 秒，避免每次打开面板都起子进程。

### 2.4 `GET /api/ai/settings` / `POST /api/ai/settings`

读写 `settings["ai"]`，结构：

```json
{"provider": "auto", "model": "", "base_url": "", "preset": "moonshot",
 "api_key_set": true}
```

- 存盘时 API Key 必须用 `config.protect()`（DPAPI）存成 `api_key_enc`；GET 永不返回明文 Key，只返回 `api_key_set`。
- POST 传 `api_key` 为空字符串表示「不改动已存的 Key」；传 `"api_key": null` 表示清除。

## 3. 模型适配（`core/ai_reader.py`）

统一入口：`answer(path, question, quote, history, provider, images=None) -> dict`。

1. **检索**：PyMuPDF 逐页抽文本（缓存 `ai/text-<sha1>.json`），按页切块 + 简易 BM25 打分，
   结合「引用所在页 ±1 页」「问题关键词匹配的页」「含 Table/Figure/experiment/results/ablation 的页」
   选 6–10 段，总长 ≤ 16000 字符；把目录（章节→页码）一并给模型。
2. **Prompt**：中文；要求只依据材料、每个事实后标 `[pN]`（N 就是材料里的页码）；
   材料不足要明说「论文中没有找到直接证据」；不要编造页码。回答控制在 400 字内。
3. **调用器**：
   - `codex`：`codex exec --skip-git-repo-check --ephemeral -s read-only -C <tmp> --json -o <tmp>/last.txt [-m model] "<prompt>"`，
     `stdin=DEVNULL`，超时 180s；从 JSONL 最后一个 `item.completed` 的 `agent_message.text` 或 `last.txt` 取答案。
   - `kimi`：`kimi -p "<prompt>" [--model <model>] --output-format text`，超时 180s，取 stdout。
   - `claude`：`claude -p "<prompt>" --output-format json [--model <model>]`，取 `.result`。
   - `api`：`POST {base_url}/chat/completions`，OpenAI 兼容，超时 180s。
   - `auto`：依次挑第一个 available 的 CLI；都没有则用已保存的 API 配置；再没有就报错。
4. **引文解析**：`answer` 里出现过的 `[pN]` → 去重成 citations；每条的 `snippet` 用该页文本
   与问题词重合度最高的句子（没有就取该页前 180 字）。
5. 安全：CLI 工作目录用临时空目录；不把 API Key 写进日志；错误信息里不带 Key。

## 4. 前端桥（Lead 在 `viewer.js` 里提供）

脚本加载顺序：`pdf.min.js → shared.js → viewer.js → reader-toc.js → reader-ai.js`。

`window.ReaderBridge`：

```js
{
  docPath: "E:\\...\\paper.pdf",       // 与 viewer.js 相同来源
  pageCount(): number,
  currentPage(): number,
  goToPage(n, smooth?): void,
  getPdf(): PDFDocumentProxy,          // 可能为 null
  getPageText(page): string,           // 文本层已建好才有；否则 ""
  getSelection(): {text, page, parts:[{page,start,end}], rects, anchor} | null,
  flashText(page, text, opts?): Promise<boolean>, // 跳页 + 临时高亮匹配文字（不写入批注）
  refit(): void,                       // 侧栏/面板开合后按新的可用宽度重新适配
  whenReady(): Promise<void>,          // 页面与首批文本就绪
}
```

事件（都派发在 `document` 上）：

- `reader:ready` → `detail = {pages}`
- `reader:pagechange` → `detail = {page}`

`window.ReaderAI`：由 `reader-ai.js` 提供，供 `viewer.js` 的右键菜单调用：

```js
{
  open(captured?)            // 打开面板（可带引用）
  quote(captured, opts?)     // 打开面板并填好引用卡片；opts.question 预填问题
  focusInput()
}
```

## 5. DOM 契约（`viewer.html`，Lead 写）

- 顶栏新增按钮 `#btn-ai`（`class="r-btn wide r-ai-toggle"`），`aria-pressed` 表示面板开合。
- 左栏页签：`页面 / 目录 / 批注`；`data-tab="toc"` 对应面板 `#panel-toc`。
- AI 面板：`<aside class="r-ai" id="ai-drawer" hidden>`，位于 `.r-main` 内、`.r-stage` 之后：
  - 头部：`#ai-close`、`#ai-provider-pill`、`#ai-settings-btn`
  - 消息区：`#ai-messages`
  - 引用卡片：`#ai-quote`（含 `.r-ai-quote-text`、`[data-ai-quote-clear]`）
  - 推荐问题：`#ai-suggest`
  - 输入区：`#ai-form`、`#ai-input`、`#ai-send`、`#ai-model-btn`
  - 设置浮层：`#ai-settings`（内容由 `reader-ai.js` 渲染）
- 右键菜单：复用 `#menu`；`viewer.js` 在 `showSelectionMenu()` 里插入
  `data-menu-act="ai-ask"`（引用提问）和 `data-menu-act="ai-explain"`（解释这段）两个按钮，
  点击时调用 `window.ReaderAI.quote(captured, {question})`。

## 6. UI 细节约定

- 出处 chip：`<button class="r-ai-cite" data-page="5" data-ref="p5">p.5</button>`；
  点击 → `ReaderBridge.flashText(page, snippet)`。引用列表里的条目同款。
- 流式/等待：请求期间消息区显示 `.r-ai-msg.pending`（三点动画）；错误显示 `.r-ai-msg.error`。
- 会话历史：`localStorage["babeldoc-ai:" + docPath]`，最多 40 条；面板打开时恢复，提供「清空」。
- 主题：只用 `var(--card) / var(--text) / var(--line) / var(--accent) / var(--blue)` 等现有变量，
  亮/暗色都必须能看。窄屏（<900px）面板宽 320px。
- 打开面板后要调用 `ReaderBridge.refit()`，关闭同理；动画 180ms 内完成。

## 7. 验收与测试

```powershell
python -m pytest tests/test_toc.py tests/test_ai_reader.py -q
python tests/reader_ai_toc_ui.py        # Playwright + msedge
python tests/reader_ui_smoke.py         # 老功能不回归
```

UI 冒烟测试用 `tests/` 里生成的 PDF（PyMuPDF `set_toc` 造目录），AI 请求用
`monkeypatch core.ai_reader.answer` 返回固定答案 + citations，避免测试消耗真实额度。
