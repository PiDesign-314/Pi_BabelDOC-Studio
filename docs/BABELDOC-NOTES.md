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
  [--openai-term-extraction-model <model>]
```

要点：

- `--openai-base-url` 允许结尾带 `/`，内部会 `rstrip("/")` 后拼 `/chat/completions`。
- 双语对照默认是**左右对照**；`--use-alternating-pages-dual` 才是「原文/译文交替页」。
- 仅译文 = `--no-dual`；仅双语 = `--no-mono`（本项目 UI 未暴露后者）。
- 自动提取术语**默认开启**，关闭要显式传 `--no-auto-extract-glossary`。
- 术语提取走独立模型：`--openai-term-extraction-model`。
- 没有 `--openai-api-key` 时会读 `OPENAI_API_KEY` 环境变量。

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
4. 结束后扫描输出目录，重命名并回报结果列表；
5. 取消：`terminate()` + `cancel_requested` 标记 → 状态记为 `cancelled`。

`app.py` 提供 REST 接口：`/api/bootstrap`、`/api/settings`、`/api/pick`、
`/api/upload`、`/api/jobs`、`/api/jobs/<id>`（轮询日志与进度）、`/api/glossaries*`、
`/api/open`、`/api/test-connection`。

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
