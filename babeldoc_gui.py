from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

BUNDLE_DIR = Path(__file__).resolve().parent
VENDOR_DIR = BUNDLE_DIR / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

from tkinterdnd2 import DND_FILES, TkinterDnD


APP_TITLE = "BabelDOC PDF 翻译器"
APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / "BabelDOC-GUI"
SETTINGS_FILE = APP_DIR / "settings.json"

PROVIDER_PRESETS = {
    "OpenAI": {
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
    },
    "DeepSeek": {
        "base_url": "https://api.deepseek.com",
        "models": ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    },
    "阿里云百炼（Qwen）": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-plus", "qwen-flash", "qwen3.8-flash", "qwen3.8-max"],
    },
    "智谱 GLM": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4/",
        "models": ["glm-4-flash", "glm-4-plus", "glm-5.2"],
    },
    "OpenRouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "models": ["openai/gpt-4o", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro"],
    },
    "自定义": {"base_url": "", "models": []},
}


class DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _data_blob(data: bytes) -> tuple[DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    blob = DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def protect_secret(secret: str) -> str:
    """Encrypt a secret with Windows DPAPI for the current signed-in user."""
    in_blob, _buffer = _data_blob(secret.encode("utf-8"))
    out_blob = DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(in_blob), "BabelDOC-GUI", None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise ctypes.WinError()
    try:
        encrypted = ctypes.string_at(out_blob.pbData, out_blob.cbData)
        return base64.b64encode(encrypted).decode("ascii")
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


def unprotect_secret(encrypted: str) -> str:
    """Decrypt a secret saved by protect_secret for the current Windows user."""
    in_blob, _buffer = _data_blob(base64.b64decode(encrypted))
    out_blob = DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(in_blob), None, None, None, None, 0, ctypes.byref(out_blob)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out_blob.pbData, out_blob.cbData).decode("utf-8")
    finally:
        ctypes.windll.kernel32.LocalFree(out_blob.pbData)


class BabelDocGUI(TkinterDnD.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("920x735")
        self.minsize(780, 620)
        self.process: subprocess.Popen[str] | None = None
        self.messages: queue.Queue[tuple[str, str | int]] = queue.Queue()
        self.pdf_files: list[str] = []
        self.output_snapshot: dict[str, int] = {}

        self.provider = tk.StringVar(value="OpenAI")
        self.base_url = tk.StringVar(value="https://api.openai.com/v1")
        self.model = tk.StringVar(value="gpt-4o-mini")
        self.api_key = tk.StringVar(value=os.environ.get("OPENAI_API_KEY", ""))
        self.lang_in = tk.StringVar(value="en")
        self.lang_out = tk.StringVar(value="zh")
        self.output_dir = tk.StringVar()
        self.pages = tk.StringVar()
        self.output_mode = tk.StringVar(value="both")
        self.no_watermark = tk.BooleanVar(value=False)
        self.open_when_done = tk.BooleanVar(value=True)
        self.show_key = tk.BooleanVar(value=False)
        self.remember_api_key = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="就绪")

        self._load_settings()
        self._configure_style()
        self._build_ui()
        self.after(100, self._drain_messages)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        for theme in ("vista", "clam"):
            if theme in style.theme_names():
                style.theme_use(theme)
                break
        style.configure("Title.TLabel", font=("Microsoft YaHei UI", 18, "bold"))
        style.configure("Hint.TLabel", foreground="#555555")
        style.configure("Accent.TButton", font=("Microsoft YaHei UI", 10, "bold"))

    def _build_ui(self) -> None:
        root = ttk.Frame(self, padding=18)
        root.pack(fill="both", expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(4, weight=1)

        ttk.Label(root, text=APP_TITLE, style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            root,
            text="选择 PDF，填写 OpenAI 兼容服务信息，然后点击“开始翻译”。",
            style="Hint.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 14))

        files_box = ttk.LabelFrame(root, text="1. PDF 文件（可直接拖拽到下方区域）", padding=10)
        files_box.grid(row=2, column=0, sticky="nsew")
        files_box.columnconfigure(0, weight=1)
        self.files_list = tk.Listbox(files_box, height=4, selectmode=tk.EXTENDED)
        self.files_list.grid(row=0, column=0, rowspan=3, sticky="nsew", padx=(0, 8))
        self.files_list.drop_target_register(DND_FILES)
        self.files_list.dnd_bind("<<Drop>>", self._on_drop_files)
        ttk.Button(files_box, text="添加 PDF", command=self._add_files).grid(row=0, column=1, sticky="ew")
        ttk.Button(files_box, text="移除选中", command=self._remove_selected).grid(row=1, column=1, sticky="ew", pady=5)
        ttk.Button(files_box, text="清空", command=self._clear_files).grid(row=2, column=1, sticky="ew")

        settings = ttk.LabelFrame(root, text="2. 翻译设置", padding=10)
        settings.grid(row=3, column=0, sticky="ew", pady=12)
        settings.columnconfigure(1, weight=1)
        settings.columnconfigure(3, weight=1)

        ttk.Label(settings, text="服务商").grid(row=0, column=0, sticky="w", pady=5)
        self.provider_combo = ttk.Combobox(
            settings,
            textvariable=self.provider,
            values=list(PROVIDER_PRESETS),
            state="readonly",
        )
        self.provider_combo.grid(row=0, column=1, sticky="ew", padx=(8, 16), pady=5)
        self.provider_combo.bind("<<ComboboxSelected>>", self._on_provider_changed)

        ttk.Label(settings, text="模型").grid(row=0, column=2, sticky="w", pady=5)
        self.model_combo = ttk.Combobox(settings, textvariable=self.model, state="normal")
        self.model_combo.grid(row=0, column=3, sticky="ew", padx=(8, 0), pady=5)

        ttk.Label(settings, text="API 地址").grid(row=1, column=0, sticky="w", pady=5)
        ttk.Entry(settings, textvariable=self.base_url).grid(
            row=1, column=1, columnspan=3, sticky="ew", padx=(8, 0), pady=5
        )

        ttk.Label(settings, text="API Key").grid(row=2, column=0, sticky="w", pady=5)
        self.key_entry = ttk.Entry(settings, textvariable=self.api_key, show="●")
        self.key_entry.grid(row=2, column=1, sticky="ew", padx=(8, 8), pady=5)
        key_options = ttk.Frame(settings)
        key_options.grid(row=2, column=2, columnspan=2, sticky="w")
        ttk.Checkbutton(key_options, text="显示", variable=self.show_key, command=self._toggle_key).pack(side="left")
        ttk.Checkbutton(
            key_options,
            text="保存（Windows 加密）",
            variable=self.remember_api_key,
        ).pack(side="left", padx=(10, 0))

        self._entry_row(settings, 3, "源语言", self.lang_in, 0, 1, width=10)
        self._entry_row(settings, 3, "目标语言", self.lang_out, 2, 3, width=10)

        ttk.Label(settings, text="输出目录").grid(row=4, column=0, sticky="w", pady=5)
        ttk.Entry(settings, textvariable=self.output_dir).grid(row=4, column=1, columnspan=2, sticky="ew", padx=8, pady=5)
        ttk.Button(settings, text="选择…", command=self._choose_output).grid(row=4, column=3, sticky="e")

        ttk.Label(settings, text="页码（可选）").grid(row=5, column=0, sticky="w", pady=5)
        ttk.Entry(settings, textvariable=self.pages).grid(row=5, column=1, sticky="ew", padx=8, pady=5)
        ttk.Label(settings, text="例如：1-5,8；预设地址与模型仍可编辑", style="Hint.TLabel").grid(
            row=5, column=2, columnspan=2, sticky="w"
        )

        options = ttk.Frame(settings)
        options.grid(row=6, column=0, columnspan=4, sticky="w", pady=(7, 0))
        ttk.Label(options, text="输出：").pack(side="left")
        ttk.Radiobutton(options, text="译文 + 双语", variable=self.output_mode, value="both").pack(side="left")
        ttk.Radiobutton(options, text="仅译文", variable=self.output_mode, value="mono").pack(side="left", padx=8)
        ttk.Radiobutton(options, text="仅双语", variable=self.output_mode, value="dual").pack(side="left")
        ttk.Checkbutton(options, text="无水印", variable=self.no_watermark).pack(side="left", padx=(18, 0))
        ttk.Checkbutton(options, text="完成后打开目录", variable=self.open_when_done).pack(side="left", padx=(12, 0))

        log_box = ttk.LabelFrame(root, text="3. 运行日志", padding=8)
        log_box.grid(row=4, column=0, sticky="nsew")
        log_box.columnconfigure(0, weight=1)
        log_box.rowconfigure(0, weight=1)
        self.log = tk.Text(log_box, height=12, wrap="word", state="disabled", font=("Consolas", 9))
        scroll = ttk.Scrollbar(log_box, command=self.log.yview)
        self.log.configure(yscrollcommand=scroll.set)
        self.log.grid(row=0, column=0, sticky="nsew")
        scroll.grid(row=0, column=1, sticky="ns")

        footer = ttk.Frame(root)
        footer.grid(row=5, column=0, sticky="ew", pady=(12, 0))
        footer.columnconfigure(0, weight=1)
        ttk.Label(footer, textvariable=self.status).grid(row=0, column=0, sticky="w")
        self.cancel_btn = ttk.Button(footer, text="取消", command=self._cancel, state="disabled")
        self.cancel_btn.grid(row=0, column=1, padx=8)
        self.start_btn = ttk.Button(footer, text="开始翻译", command=self._start, style="Accent.TButton")
        self.start_btn.grid(row=0, column=2)
        self._refresh_provider_fields(keep_current=True)

    @staticmethod
    def _entry_row(parent, row, label, variable, label_col, entry_col, width=20) -> None:
        ttk.Label(parent, text=label).grid(row=row, column=label_col, sticky="w", pady=5)
        ttk.Entry(parent, textvariable=variable, width=width).grid(
            row=row, column=entry_col, sticky="ew", padx=(8, 16), pady=5
        )

    def _add_files(self) -> None:
        paths = filedialog.askopenfilenames(title="选择 PDF 文件", filetypes=[("PDF 文件", "*.pdf")])
        self._add_pdf_paths(paths)

    def _add_pdf_paths(self, paths) -> None:
        added = 0
        for path in paths:
            pdf = Path(path)
            if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
                continue
            normalized = str(pdf.resolve())
            if normalized not in self.pdf_files:
                self.pdf_files.append(normalized)
                self.files_list.insert(tk.END, normalized)
                added += 1
        if self.pdf_files and not self.output_dir.get():
            self.output_dir.set(str(Path(self.pdf_files[0]).parent / "BabelDOC-翻译结果"))
        if added:
            self.status.set(f"已添加 {added} 个 PDF")

    def _on_drop_files(self, event) -> None:
        try:
            paths = self.tk.splitlist(event.data)
        except tk.TclError:
            paths = [event.data]
        before = len(self.pdf_files)
        self._add_pdf_paths(paths)
        if len(self.pdf_files) == before:
            messagebox.showinfo(APP_TITLE, "拖入的内容中没有可添加的 PDF 文件。")

    def _remove_selected(self) -> None:
        for index in reversed(self.files_list.curselection()):
            self.files_list.delete(index)
            del self.pdf_files[index]

    def _clear_files(self) -> None:
        self.pdf_files.clear()
        self.files_list.delete(0, tk.END)

    def _choose_output(self) -> None:
        path = filedialog.askdirectory(title="选择输出目录")
        if path:
            self.output_dir.set(path)

    def _toggle_key(self) -> None:
        self.key_entry.configure(show="" if self.show_key.get() else "●")

    def _on_provider_changed(self, _event=None) -> None:
        self._refresh_provider_fields(keep_current=False)

    def _refresh_provider_fields(self, keep_current: bool) -> None:
        preset = PROVIDER_PRESETS.get(self.provider.get(), PROVIDER_PRESETS["自定义"])
        models = preset["models"]
        self.model_combo.configure(values=models)
        if keep_current:
            return
        if preset["base_url"]:
            self.base_url.set(preset["base_url"])
        if models:
            self.model.set(models[0])

    def _find_babeldoc(self) -> str | None:
        found = shutil.which("babeldoc")
        if found:
            return found
        fallback = Path.home() / ".local" / "bin" / "babeldoc.exe"
        return str(fallback) if fallback.exists() else None

    def _validate(self) -> str | None:
        if not self.pdf_files:
            return "请至少添加一个 PDF 文件。"
        if not self.base_url.get().strip():
            return "请填写 API 地址。"
        if not self.model.get().strip():
            return "请填写模型名称。"
        if not self.api_key.get().strip():
            return "请填写 API Key。"
        if not self.output_dir.get().strip():
            return "请选择输出目录。"
        if not self._find_babeldoc():
            return "没有找到 babeldoc 命令，请先安装 BabelDOC。"
        return None

    def _build_command(self) -> list[str]:
        command = [
            self._find_babeldoc() or "babeldoc",
            "--openai",
            "--openai-model",
            self.model.get().strip(),
            "--openai-base-url",
            self.base_url.get().strip(),
            "--openai-api-key",
            self.api_key.get().strip(),
            "--lang-in",
            self.lang_in.get().strip() or "en",
            "--lang-out",
            self.lang_out.get().strip() or "zh",
            "--output",
            self.output_dir.get().strip(),
        ]
        for path in self.pdf_files:
            command.extend(["--files", path])
        if self.pages.get().strip():
            command.extend(["--pages", self.pages.get().strip()])
        if self.output_mode.get() == "mono":
            command.append("--no-dual")
        elif self.output_mode.get() == "dual":
            command.append("--no-mono")
        if self.no_watermark.get():
            command.extend(["--watermark-output-mode", "no_watermark"])
        return command

    def _start(self) -> None:
        error = self._validate()
        if error:
            messagebox.showwarning(APP_TITLE, error)
            return
        output = Path(self.output_dir.get().strip())
        output.mkdir(parents=True, exist_ok=True)
        self.output_snapshot = self._snapshot_pdfs(output)
        self._save_settings()
        self._set_running(True)
        self._append_log("\n=== 开始翻译 ===\n")
        self._append_log(f"文件数量：{len(self.pdf_files)}\n输出目录：{output}\n")
        threading.Thread(target=self._run_translation, args=(self._build_command(),), daemon=True).start()

    def _run_translation(self, command: list[str]) -> None:
        try:
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            self.process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creationflags,
            )
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.messages.put(("log", line))
            code = self.process.wait()
            self.messages.put(("done", code))
        except Exception as exc:
            self.messages.put(("error", str(exc)))
        finally:
            self.process = None

    def _cancel(self) -> None:
        if self.process and self.process.poll() is None:
            self.status.set("正在取消…")
            self.process.terminate()

    def _drain_messages(self) -> None:
        try:
            while True:
                kind, value = self.messages.get_nowait()
                if kind == "log":
                    self._append_log(str(value))
                elif kind == "done":
                    self._set_running(False)
                    if int(value) == 0:
                        self.status.set("翻译完成")
                        self._append_log("\n=== 翻译完成 ===\n")
                        renamed = self._rename_outputs()
                        if renamed:
                            self._append_log("已自动重命名：\n")
                            for old_name, new_name in renamed:
                                self._append_log(f"  {old_name}  →  {new_name}\n")
                        if self.open_when_done.get():
                            os.startfile(self.output_dir.get().strip())
                    else:
                        self.status.set(f"翻译失败（退出码 {value}）")
                        self._append_log(f"\n=== 翻译失败，退出码 {value} ===\n")
                        messagebox.showerror(APP_TITLE, "翻译未成功，请查看运行日志。")
                elif kind == "error":
                    self._set_running(False)
                    self.status.set("启动失败")
                    self._append_log(f"\n启动失败：{value}\n")
                    messagebox.showerror(APP_TITLE, f"无法启动翻译：\n{value}")
        except queue.Empty:
            pass
        self.after(100, self._drain_messages)

    @staticmethod
    def _snapshot_pdfs(directory: Path) -> dict[str, int]:
        snapshot = {}
        for pdf in directory.glob("*.pdf"):
            try:
                snapshot[str(pdf.resolve())] = pdf.stat().st_mtime_ns
            except OSError:
                continue
        return snapshot

    @staticmethod
    def _unique_path(path: Path) -> Path:
        if not path.exists():
            return path
        index = 2
        while True:
            candidate = path.with_name(f"{path.stem} ({index}){path.suffix}")
            if not candidate.exists():
                return candidate
            index += 1

    def _rename_outputs(self) -> list[tuple[str, str]]:
        output = Path(self.output_dir.get().strip())
        source_stems = sorted(
            {Path(path).stem for path in self.pdf_files}, key=len, reverse=True
        )
        renamed: list[tuple[str, str]] = []
        for pdf in output.glob("*.pdf"):
            try:
                old_mtime = self.output_snapshot.get(str(pdf.resolve()))
                if old_mtime == pdf.stat().st_mtime_ns:
                    continue
            except OSError:
                continue

            lower_name = pdf.name.lower()
            if lower_name.endswith(".mono.pdf"):
                kind = "译文"
            elif lower_name.endswith(".dual.pdf"):
                kind = "双语对照"
            else:
                continue

            source_stem = next(
                (stem for stem in source_stems if lower_name.startswith(stem.lower() + ".")),
                None,
            )
            if not source_stem:
                continue
            watermark_suffix = "_无水印" if ".no_watermark." in lower_name else ""
            destination = output / f"{source_stem}_{kind}{watermark_suffix}.pdf"
            if pdf.resolve() == destination.resolve():
                continue
            destination = self._unique_path(destination)
            try:
                old_name = pdf.name
                pdf.replace(destination)
                renamed.append((old_name, destination.name))
            except OSError as exc:
                self._append_log(f"自动重命名失败：{pdf.name}（{exc}）\n")
        return renamed

    def _append_log(self, text: str) -> None:
        self.log.configure(state="normal")
        self.log.insert(tk.END, text)
        self.log.see(tk.END)
        self.log.configure(state="disabled")

    def _set_running(self, running: bool) -> None:
        self.start_btn.configure(state="disabled" if running else "normal")
        self.cancel_btn.configure(state="normal" if running else "disabled")
        if running:
            self.status.set("正在翻译，请勿关闭窗口…")

    def _load_settings(self) -> None:
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for name, variable in (
            ("provider", self.provider),
            ("base_url", self.base_url),
            ("model", self.model),
            ("lang_in", self.lang_in),
            ("lang_out", self.lang_out),
            ("output_dir", self.output_dir),
            ("output_mode", self.output_mode),
            ("no_watermark", self.no_watermark),
            ("open_when_done", self.open_when_done),
            ("remember_api_key", self.remember_api_key),
        ):
            if name in data:
                variable.set(data[name])
        if self.remember_api_key.get() and data.get("encrypted_api_key"):
            try:
                self.api_key.set(unprotect_secret(data["encrypted_api_key"]))
            except (OSError, ValueError):
                self.api_key.set("")

    def _save_settings(self) -> None:
        data = {
            "provider": self.provider.get(),
            "base_url": self.base_url.get(),
            "model": self.model.get(),
            "lang_in": self.lang_in.get(),
            "lang_out": self.lang_out.get(),
            "output_dir": self.output_dir.get(),
            "output_mode": self.output_mode.get(),
            "no_watermark": self.no_watermark.get(),
            "open_when_done": self.open_when_done.get(),
            "remember_api_key": self.remember_api_key.get(),
        }
        if self.remember_api_key.get() and self.api_key.get():
            try:
                data["encrypted_api_key"] = protect_secret(self.api_key.get())
            except OSError as exc:
                messagebox.showwarning(APP_TITLE, f"API Key 无法加密保存：\n{exc}")
        try:
            APP_DIR.mkdir(parents=True, exist_ok=True)
            SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def _on_close(self) -> None:
        if self.process and self.process.poll() is None:
            if not messagebox.askyesno(APP_TITLE, "翻译仍在进行，确定要退出并终止任务吗？"):
                return
            self.process.terminate()
        self._save_settings()
        self.destroy()


if __name__ == "__main__":
    BabelDocGUI().mainloop()
