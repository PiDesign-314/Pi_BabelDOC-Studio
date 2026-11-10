# BabelDOC 集成笔记

> 这份文档是「项目记忆」：记录上游项目、命令行契约与本项目的集成方式，
> 方便后续继续开发时不必重新调研。最后核对：BabelDOC **0.6.4**。

## 1. 上游项目

- 仓库：<https://github.com/funstory-ai/BabelDOC>
- 定位：PDF 科学论文翻译，保留原始版式（公式、图表、双栏），输出单语 / 双语 PDF。
- 本机安装：`uv tool install babeldoc`
  - 命令：`C:\Users\Xuanyu_Pan\.local\bin\babeldoc.exe`
  - 包体：`%APPDATA%\uv\tools\babeldoc\Lib\site-packages\babeldoc`
  - 版本：`babeldoc 0.6.4`
- 依赖链：`pdf2zh` 的同源项目，内部用 doclayout / onnx 做版面分析，首次运行会下载模型资源。

## 2. 命令行契约（本项目实际使用）

```powershell
babeldoc --openai `
  --openai-model <model> `
  --openai-base-url <baseUrl> `
  --openai-api-key <key> `
  --lang-in en --lang-out zh `
  --output <dir> `
  --files a.pdf --files b.pdf `
  [--pages "1-5,8"] `
  [--watermark-output-mode no_watermark|watermarked|both] `
  [--use-alternating-pages-dual | --no-dual] `
  [--glossary-files g1.csv,g2.csv] `
  [--no-auto-extract-glossary] [--save-auto-extracted-glossary] `
  [--qps 4] [--custom-system-prompt "..."] `
  [--skip-scanned-detection] [--auto-enable-ocr-workaround] `
  [--disable-rich-text-translate] `
  [--openai-term-extraction-model <model>]
```

要点：

- `--openai-base-url` 允许结尾带 `/`，内部会 `rstrip("/")` 后拼 `/chat/completions`。
- 双语对照默认是**左右对照**；`--use-alternating-pages-dual` 才是「原文/译文交替页」。
- 仅译文 = `--no-dual`；仅双语 = `--no-mono`（本项目 UI 未暴露后者）。
- 自动提取术语**默认开启**，关闭要显式传 `--no-auto-extract-glossary`。
- 术语提取走独立模型：`--openai-term-extraction-model`。
- 没有 `--openai-api-key` 时会读 `OPENAI_API_KEY` 环境变量。
- 「兼容性优先」开启时传 `--disable-rich-text-translate`：上游说明该选项可改善部分 PDF
  的兼容性；本项目现在只把它当作「完整性校验失败后的自动恢复手段」和用户手动选项，
  默认路径由 `core/babelguard` 兜底（见第 8 节）。
- BabelDOC 0.6.x 的翻译缓存**在模型返回空字符串时也会写入空值**，而回退路径不会再次校验，
  于是同一段之后每次都会得到空译文。本项目双层防护：任务启动前用 `core/babelcache.py`
  删除 `cache.v1.db` 中 `trim(translation)=''` 的行；BabelDOC 子进程内的
  `core/babelguard` 再把「空缓存值」当作未命中、并拒绝写入空译文（见第 8 节）。


## 3. 输出文件命名

`babeldoc/format/pdf/result_merger.py`：

```
{basename}.{lang_out}.mono.pdf
{basename}.{lang_out}.dual.pdf
{basename}.no_watermark.{lang_out}.mono.pdf   # 无水印变体
{basename}.no_watermark.{lang_out}.dual.pdf
{basename}.{lang_out}.glossary.csv            # 自动术语表（--save-auto-extracted-glossary）
```

本项目在任务成功后扫描输出目录，把 `mono`→`_译文.pdf`、`dual`→`_双语对照.pdf`、
`glossary.csv`→`_术语表.csv`，并处理重名与无水印标记（`（无水印）`）。
整理后的文件会移动到 `<输出目录>/<论文名>/` 子文件夹里，同一篇论文的产物集中存放；
重复翻译复用该文件夹，同名文件追加 `(2)`。旧版本的平铺结果仍可被结果库识别。

## 4. 术语库 CSV 格式

`babeldoc/glossary.py::Glossary.from_csv`：

```csv
source,target,tgt_lng
transformer,变换器,
attention,注意力机制,zh
```

- 必须有 `source`、`target` 两列；`tgt_lng` 可选，用于限定目标语言。
- 编码不限（内部用 chardet 探测），本项目统一写 UTF-8。
- 多个术语库用逗号拼给 `--glossary-files`。

## 5. 与本项目的集成方式

`core/runner.py`：

1. `build_command(cfg, files, exe)` 拼参数；
2. `subprocess.Popen(..., creationflags=CREATE_NO_WINDOW)`，stdout/stderr 合并逐行读取；
3. 日志关键字映射阶段（解析版面 → 提取术语 → 翻译正文 → 排版生成 → 收尾），
   规则按「命中最高阶段」计算且只进不退；注意 BabelDOC 每行日志都带模块路径
   `babeldoc.format.pdf…`，所以不能用 `pdf`/`save` 这类裸词做匹配；
   进度条只在出现 `2/2` 这类比率时推进，否则停留在该阶段起点；
4. 结束后扫描输出目录，重命名、收进每篇论文的子文件夹，并回报结果列表；
5. 取消：`terminate()` + `cancel_requested` 标记 → 状态记为 `cancelled`。

`app.py` 提供 REST 接口：`/api/bootstrap`、`/api/settings`、`/api/pick`、
`/api/upload`、`/api/jobs`、`/api/jobs/<id>`（轮询日志与进度）、`/api/glossaries*`、
`/api/open`、`/api/test-connection`，以及结果库 / Zotero 桥接接口
`/api/zotero/open`、`/api/zotero/library` 等。

结果库的阅读与翻译入口（2026-11 交互调整）：

- `POST /api/zotero/open` 的 `mode` 有三种：`read`（默认，导入/复用 Zotero 附件副本并打开阅读器）、
  `prepare`（只导入/复用副本，返回 `url = /?prepare=<绝对路径>`，**不启动翻译任务**，供结果库
  「翻译」按钮先让用户确认设置）、`translate`（旧行为，立即开始任务，Zotero 插件仍使用）。
- `read` 模式支持可选 `variant`：`original` / `translation` / `dual`，分别打开原文、仅译文、
  左右排版译文；不存在时返回 404 `variant_missing`，非法值返回 400 `bad_variant`。
  不传时保持原有偏好（上次阅读的译文 → 双语 → 译文 → 原文）。
- 翻译首页支持 `/?prepare=<urlencoded 绝对路径>`（兼容 `?file=`）：载入该 PDF、显示设置并聚焦
  「开始翻译」，绝不自动开始；与 `?job=` 同时出现时任务恢复优先。

## 6. 费用统计

BabelDOC 每次运行结束会在日志里打印用量（`babeldoc/main.py` 772-791 行）：

```
Total tokens: 2400
Prompt tokens: 1800
Completion tokens: 600
Cache hit prompt tokens: 0
Term extraction tokens: total=… prompt=… completion=… cache_hit_prompt=…
```

本项目在 `core/runner.py::Job._scan_usage` 里逐行解析这些值（含续行兜底），
每次 babeldoc 调用结束后 `commit_usage()` 归档，多文件时累加；
`core/pricing.py` 用「每百万 tokens」单价换算金额，支持 `price_input /
price_output / price_currency` 覆盖内置参考价。

注意：这是**按日志里 BabelDOC 自己统计的 token** 估算的，若服务商计费口径不同
（例如按图片/按次、缓存价不同、失败重试也计费），结果会有偏差；
内置价格是 2025-11 左右的公开参考价，随时可能过期，重要场合请用自定义单价。

## 7. 已知限制 / 后续可做

- **不翻译参考文献** 的实现方式：BabelDOC 没有段落级的「跳过翻译」开关，于是分两种情况：
  1. 参考文献标题在某页顶部（`y < 页高 18%`）：`--pages` 之外的页面会原样保留进输出
     （实测只翻译第 1 页时输出仍是 2 页，第 2 页英文未改动），所以直接传
     `--pages 1..R-1`，结果确定。
  2. 标题在页面中部（双栏论文常见）：按页裁剪会误伤正文，于是改用
     `--custom-system-prompt` 注入「参考文献条目原样返回」规则，并加
     `--disable-same-text-fallback`（否则输出与输入相同会被当作失败重试）。
     这种方式依赖模型遵守指令，属于尽力而为。
  页码参数是每次调用独立的，因此多文件会拆成多次 babeldoc 调用，各自计算范围。
  检测不到标题时（扫描版 PDF）可在高级设置里手动指定「参考文献起始页」。

- BabelDOC 需要 Python ≥3.10；本机系统 Python 3.14 仅用于跑界面与调进程，
  翻译本身在 uv 工具环境（3.12）里执行。
- 首次翻译会下载版面分析模型与字体，耗时较长，属正常现象。
- 进度是**阶段式**（解析版面 / 提取术语 / 翻译正文 / 排版生成 / 收尾），
  不是上游的精确百分比；BabelDOC 命令行没有结构化进度回调。
- 界面用 `?theme=dark|light` 或右上角按钮切换外观，选择存在 localStorage。
- 多文件当前共用同一套页面范围设置。
- 术语库目前单选；BabelDOC 本身支持多文件，UI 可扩展为多选。
- 未做任务历史记录，进程退出后结果只留在输出目录。
- `pythonw` 无控制台，启动失败会写入 `%APPDATA%\BabelDOC-Studio\last-error.log`。

## 8. 译文缺失（空白段）：根因、防护与校验

这一节记录 2026-11 修复「部分段落没有译文、页面大面积空白」时的结论，后续不要重复调研。

### 8.1 根因链（BabelDOC 0.6.4 + deepseek-flash 实测）

1. 默认（富文本）路径走 `format/pdf/document_il/midend/il_translator_llm_only.py`：把多个段落
   打包成一个 JSON 数组请求模型，要求返回同长度 JSON。
2. 模型（例：`deepseek-flash`）偶尔返回非法 JSON（`Expecting value: line 1 column 1 (char 0)`、
   `Unterminated string ...`），整个批次失败，BabelDOC 退回逐段翻译
   （`il_translator.translate_paragraph`）。
3. 逐段翻译偶尔收到**空字符串回复**；`post_translate_paragraph` 不校验空值，直接把
   `paragraph.unicode = ""`、生成空的 composition，排版阶段自然没有文字对象 → 页面上该段位置
   完全空白（不是文字变小或排版错位，而是真的没有内容）。
4. 空回复还会被 `BaseTranslator.llm_translate` 写进 `~/.cache/babeldoc/cache.v1.db`，之后
   同一段永远命中空译文，空白可复现。
5. 复现证据：`.lead/repro/real-out/stein-real/work/stein/translate_tracking.json` 中
   `output=""` 的段落（`Due to notable advancements…`、`The tendency to treat computers…`、
   `Considering the social quality…`、`Despite being an increasingly…`）正好是产物 PDF 里
   空白的四段；用本地 mock LLM 对其中一段返回空串即可离线复现。

### 8.2 运行时防护 `core/babelguard/`（新增）

不改动已安装的 BabelDOC，也不 fork 上游：`core/runner.py` 给 BabelDOC 子进程设置

```text
PYTHONPATH = <repo>\core\babelguard [; 原有 PYTHONPATH]
BABELDOC_STUDIO_GUARD = 1
BABELDOC_STUDIO_GUARD_STATUS = <每次调用的状态文件路径>
BABELDOC_STUDIO_GUARD_DOC = <任务/文件标识>
可选：BABELDOC_STUDIO_GUARD_LOG / _RETRIES / _BACKOFF / _DOC
```

Python 启动时会自动 import `sitecustomize.py`，由它调用 `babeldoc_guard.install()` 打补丁。
补丁全部防御式：任一安装步骤失败只记录事件，不影响翻译；未设置环境变量时完全不生效
（非 BabelDOC 的 Python 进程、BabelDOC 自己的字体子进程都会跳过）。

| # | 目标 | 作用 |
|---|------|------|
| 1 | `TranslationCache.get` | 空/纯空白缓存值视为未命中 |
| 2 | `TranslationCache.set` | 永不写入空译文 |
| 3 | `BaseTranslator.translate` / `.llm_translate` | 空回复按退避重试（默认 2 次，1s/3s），返回最后一次结果；按段落累计重试次数 |
| 4 | `ILTranslator.post_translate_paragraph` | 原文非空而译文为空 → 不应用空译文，段落保留原文，记录 EMPTY/KEPT_ORIGINAL |
| 5 | `ILTranslator.translate_paragraph` | 逐段记录页码（1 起）、`debug_id`、原文/译文字数、状态、重试次数、错误原因 |
| 6 | `ILTranslatorLLMOnly.translate_paragraph` | 记录 JSON 批次失败 / 回退事件，便于定位"又是 JSON 协议"的问题 |
| 7 | `Typesetting.render_paragraph` | 排版后若无可绘制字符 → 记 RENDER_FAILED，并按最小字号强制排版兜底（FORCED） |
| 8 | `PDFCreater.render_paragraph_to_char` | 非空原文却产不出字符时补记 RENDER_FAILED（不改变行为） |

`--debug` 模式会额外生成 `pagenumber`、`paragraph[...]` 之类的标记段落（没有 `debug_id`）：
守卫对它们**不记录、不恢复**，与上游 `pdf_creater` 的处理一致，避免误报缺失。

状态文件（退出时原子写入，取消时每 2s 增量落盘）：

```json
{"schema":1,"guard":"babeldoc-studio","doc":"paper.pdf",
 "paragraphs":[{"page":2,"paragraph_id":"mfKck","source_chars":707,"translated_chars":707,
   "status":"RENDERED","retry_count":2,
   "error_reason":"empty_translation_kept_original",
   "layout_status":"kept_original","render_status":"rendered"}],
 "counts":{"paragraphs":29,"translated":28,"empty":0,"render_failed":0,
           "retried":1,"kept_original":1},
 "errors":[]}
```

关键语义：**收到空回复、保留原文的段落**最终是 `status=RENDERED` +
`layout_status=kept_original` + `error_reason=empty_translation_kept_original`，
`counts.translated` 不计入它，`counts.kept_original` 计入；`page` 为 1 起的页码。

### 8.3 完整性校验 `core/translate_qa.py`（新增）

`verify(source_pdf, output_pdf, kind, guard_status=None, page_filter=None)`：

- 有守卫状态时以逐段记录为准（真正的丢失：FAILED / LOST / RENDER_FAILED；保留原文单独统计）；
- 再用 PDF 版式做独立兜底：单栏逐段落区块覆盖率（源段落框在产物页上没有文字 → 缺失）、
  双栏左右半页文字面积比（<0.35 → 右半缺失；实测健康页 0.65-0.94、坏页 0.23、空页 0.10-0.14）、
  整页空白（沿用 `core/pdfqa.py` 阈值）；
- 返回 `ok / checked / expected_paragraphs / translated_paragraphs / untranslated_paragraphs /
  missing / untranslated / blank_pages / warnings / guard`，每条缺失都带页码与段落 ID；
- 自身任何异常都退化为 `checked=False`，绝不影响任务。

`core/runner.py` 每次 BabelDOC 调用结束后都会校验；发现**真正缺失**时自动用兼容模式
（`--disable-rich-text-translate`）把该文件重译一次，比较两次结果保留更完整的一份；
仍不完整则写入结果卡的 `warning` 与 `blank_pages`，任务不会静默通过。
注意：兼容模式**并不会**切换翻译器——BabelDOC 0.6.4 对支持 LLM 的服务商始终走
`ILTranslatorLLMOnly` 的 JSON 批次协议，`--disable-rich-text-translate` 只去掉富文本占位符。
因此自动重译主要降低"占位符/富文本样式"导致的失败，对"模型返回空串"这类问题真正兜底的是
`core/babelguard` 的空译文拒写 + 重试 + 保留原文。

### 8.4 结果字段与日志

`/api/jobs/<id>` 的 `results[]` 新增 `incomplete`、`qc`（截断后的完整报告，含
`missing_total` / `untranslated_total`）、`warning`（中文、带页码/段落 ID）；
job 快照新增 `quality`（`checked / ok / missing / untranslated / pages / warnings`，
同一文档同时产出单语/双语时按源文件去重，不重复计数）。
结果卡沿用 `warning` / `blank_pages` 展示，并在有空白页时提供「用兼容模式重译」按钮。

### 8.5 回归测试

- `tests/test_babelguard.py`：假 BabelDOC 模块树验证 8 个补丁、重试/退避、空缓存、状态合并、
  OWNER 防重复安装、debug 标记段落忽略等（不需要安装 babeldoc）。
- `tests/test_translate_qa.py`：合成 PDF 覆盖单栏/双栏/空白页/守卫状态混合计数/损坏文件等。
- `tests/translate_fixtures.py` + `tests/test_translate_completeness.py`：本地 mock LLM 的
  端到端回归（`empty` 场景必须「没有空白 + 明确标记」，并对未打补丁的管线验证会失败）。
- `tests/test_runner_recovery.py`：runner 的守卫环境变量、缺失判定、兼容模式重译与结果字段。

### 8.6 已知限制

- 空回复来自服务商行为，重试仍可能为空；此时**保留原文并明确标记**，不会用空白冒充成功。
- 兼容模式重译是整文件重跑（不合并单页），只在检测到真正缺失时触发一次，费用与时间会翻倍；
  它不会绕开 JSON 批次协议（见 8.3 的说明），效果有限。
- PDF 版式兜底是启发式：公式、纯图表、扫描页可能被忽略；有守卫状态时以逐段记录为准。
- 一次调用翻译多个文件时，守卫状态文件不按文件拆分（只有页码/段落 ID），因此不使用它做逐段
  核对，此时完整性校验退回 PDF 版式兜底路径。
- 若上游 BabelDOC 升级改变了内部模块/函数名，守卫会记录 `errors` 并以「无状态文件」降级，
  完整性校验自动退回 PDF 兜底路径（`core/runner.py` 不依赖守卫一定安装成功）。
