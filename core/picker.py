"""Native Windows file/folder picker.

The UI runs inside a browser window, which cannot hand over real filesystem
paths.  This helper is launched as its own process so a native Tk dialog can
return absolute paths to the Flask backend.
"""

from __future__ import annotations

import json
import sys


def pick(mode: str, title: str) -> list[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except tk.TclError:
        pass
    if mode == "dir":
        selected = filedialog.askdirectory(title=title or "选择文件夹", mustexist=False)
        result = [selected] if selected else []
    else:
        selected = filedialog.askopenfilenames(
            title=title or "选择 PDF 文件",
            filetypes=[("PDF 文件", "*.pdf"), ("所有文件", "*.*")],
        )
        result = list(selected) if selected else []
    root.destroy()
    return result


def pick_save(default_name: str) -> list[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except tk.TclError:
        pass
    path = filedialog.asksaveasfilename(
        title="保存文件",
        initialfile=default_name or "export.csv",
        defaultextension=".csv",
        filetypes=[("CSV 文件", "*.csv"), ("所有文件", "*.*")],
    )
    root.destroy()
    return [path] if path else []


if __name__ == "__main__":
    mode = "files"
    title = ""
    default_name = ""
    args = sys.argv[1:]
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--mode" and index + 1 < len(args):
            mode = args[index + 1]
            index += 2
        elif arg == "--title" and index + 1 < len(args):
            title = args[index + 1]
            index += 2
        elif arg == "--default-name" and index + 1 < len(args):
            default_name = args[index + 1]
            index += 2
        else:
            index += 1
    try:
        if mode == "save":
            paths = pick_save(default_name)
        else:
            paths = pick("dir" if mode == "dir" else "files", title)
        print(json.dumps(paths, ensure_ascii=False))
    except Exception as exc:  # keep stdout machine readable
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
