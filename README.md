# BabelDOC Studio

一个面向 **PDF 论文 / 技术文档** 的桌面级翻译工具：底层调用
[BabelDOC](https://github.com/funstory-ai/BabelDOC)（保留原始排版、公式、图表），
上层是本项目自研的 **iOS 风格可视化界面**，可自由配置任意 OpenAI 兼容大模型。

> 本目录由旧版 Tkinter 脚本（`babeldoc_gui.py`）迁移而来，现已重写为
> 「本地 Web 服务 + 浏览器应用窗口」架构。

## 界面

主界面（浅色）：

![主界面](docs/screenshots/main-light.png)

高级设置（API 地址、Key、输出目录、QPS、提示词等）：

![高级设置](docs/screenshots/settings-advanced.png)

深色模式（右上角 ☀/☾ 按钮在 跟随系统 → 浅色 → 深色 之间切换）：

![深色模式](docs/screenshots/main-dark.png)

## 功能

- **拖拽即翻译**：把 PDF 拖进窗口即可，支持多文件、点击选择、自动读取页数。
- **任意大模型**：OpenAI / DeepSeek / 智谱 GLM / 通义千问 / OpenRouter / Moonshot /
  自定义网关，模型名可手填，API Key 用 Windows DPAPI 加密保存在本机。
- **页面范围**：全部页或 `1-5,8` 这样的自定义范围。
- **双语对照方式**：左右对照（原文 | 译文）、交替页、仅译文。
- **术语库**：可视化管理 CSV 术语表（新建 / 编辑 / 导入 / 删除），翻译时注入。
- **自动提取术语**：翻译前自动识别专有名词，可另存为 CSV 复用。
- **不翻译参考文献**：自动定位 References / 参考文献；标题在页首时按页裁剪（确定性），
  在页中（双栏）时改用提示词让模型原样保留条目（可用高级设置手动指定起始页）。
- **实时反馈**：阶段、进度、流式日志、结果文件一键打开。
- **费用估算**：任务结束后显示本次输入/输出 token 与实际花费（内置常见模型参考价，
  可在高级设置里填写自定义单价与货币）。
- 其余：水印开关、QPS 限速、自定义系统提示词、OCR 兼容模式、扫描件检测开关、
  完成后自动打开输出目录。

## 启动

前置条件：

1. 安装 BabelDOC（命令行版）：

   ```powershell
   uv tool install babeldoc
   # 或：pip install babeldoc
   ```

2. Python 3.10+，并安装两个依赖：

   ```powershell
   pip install flask pymupdf
   ```

然后双击 **`启动.bat`**。它会启动本地服务（默认 `http://127.0.0.1:8765`）并用
Edge/Chrome 的应用窗口打开界面。

桌面快捷方式：`BabelDOC Studio`（指向 `pythonw.exe app.py`，图标为
`web/babeldoc.ico`，由 `tools/make_icon.py` 生成）。重复双击不会重复启动服务，
只会再开一个窗口；界面右下角「退出应用」可停掉本地服务。项目路径变动后，
重新运行 `tools/create_shortcut.ps1` 即可刷新快捷方式。

调试时可直接运行（保留控制台输出）：

```powershell
python app.py            # 打开应用窗口
python app.py --server-only   # 只启动服务，自己用浏览器访问
```

## 目录结构

```
app.py                  Flask 服务 + API + 启动器
core/
  config.py             设置持久化（API Key 走 DPAPI 加密）
  providers.py          服务商预设
  languages.py          语言代码表
  glossary.py           术语库 CSV 读写
  pdfinfo.py            页数 / 大小探测
  picker.py             原生文件选择对话框（独立进程）
  runner.py             调用 babeldoc、流式日志、阶段进度、结果重命名
web/
  index.html            界面结构
  styles.css            iOS 风格样式（浅色 / 深色自适应）
  app.js               交互逻辑
docs/
  BABELDOC-NOTES.md     BabelDOC 集成笔记（CLI、产物命名、术语格式）
  screenshots/          界面截图
tests/
  test_smoke.py         命令拼装 / 阶段识别 / 产物重命名的离线测试
tools/
  make_icon.py          生成应用图标（web/babeldoc.ico）
babeldoc_gui.py         旧版 Tkinter 界面（保留备查）
```

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 设置（含加密密钥） | `%APPDATA%\BabelDOC-Studio\settings.json` |
| 术语库 | `%APPDATA%\BabelDOC-Studio\glossaries\*.csv` |
| 拖拽上传的临时 PDF | `%APPDATA%\BabelDOC-Studio\uploads\` |
| 默认输出目录 | `%USERPROFILE%\Documents\BabelDOC-Studio` |

## 结果文件

BabelDOC 原始产物形如 `论文.zh.mono.pdf` / `论文.zh.dual.pdf`，本工具会自动整理成：

- `论文_译文.pdf`
- `论文_双语对照.pdf`
- `论文_术语表.csv`（勾选「保存自动术语表」时）
- 同名文件已存在时追加 `(2)`、`(3)`，不覆盖旧结果

## 已验证

- 命令拼装：`--openai/--pages/--glossary-files/--no-dual/--use-alternating-pages-dual/
  --watermark-output-mode/--custom-system-prompt/--openai-term-extraction-model` 均正确生成。
- 输出整理：`paper.zh.mono.pdf` → `paper_译文.pdf`、`no_watermark` 变体 →
  `paper_译文（无水印）.pdf`、`paper.zh.glossary.csv` → `paper_术语表.csv`。
- 设置持久化：API Key 经 DPAPI 加密，明文不会出现在 `settings.json`。
- 真实调用：用 1 页 PDF 跑通 babeldoc 全流程（版面解析 → 翻译 → 排版 → 产物回收），
  断网/无效 Key 时也能正常回报失败并保留日志。
- 跳过参考文献：2 页样例（第 2 页为 References）实测只翻译第 1 页，
  输出仍是 2 页且第 2 页保留英文原文。
- 费用统计：用本地 mock LLM（每次请求固定 900 输入 / 300 输出 tokens）跑通，
  接口返回 `usage={prompt:1800, completion:600}`、`cost=¥0.0084`（deepseek-chat 参考价）。

## 已知限制

- 进度是**阶段式**（解析版面 → 提取术语 → 翻译正文 → 排版生成），
  因为 BabelDOC 命令行不提供结构化进度回调。
- 多文件翻译共用同一页面范围与同一模型设置。
- 术语库当前为单选；BabelDOC 支持多文件，UI 后续可扩展。
- 首次翻译需下载版面分析模型/字体，耗时与网速有关。

