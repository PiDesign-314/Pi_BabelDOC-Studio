"""BabelDOC Studio — local web app with an iOS-style interface.

Run ``python app.py`` to start the server and open the app window (Microsoft
Edge app mode, Chrome fallback, browser as last resort).

The UI never leaves 127.0.0.1; API keys are stored with Windows DPAPI.
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from core import (  # noqa: E402
    annotations,
    config,
    glossary,
    library,
    pdfexport,
    pdfinfo,
    presets,
    providers,
    runner,
)
from core.languages import LANGUAGES  # noqa: E402

WEB_DIR = BASE_DIR / "web"

app = Flask(__name__, static_folder=str(WEB_DIR), static_url_path="/assets")
try:
    app.json.ensure_ascii = False
except AttributeError:  # pragma: no cover
    app.config["JSON_AS_ASCII"] = False

manager = runner.JobManager()


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _json(data, status: int = 200):
    return jsonify(data), status


def _error(message: str, status: int = 400):
    return jsonify({"error": message}), status


@app.get("/api/fonts")
def local_fonts():
    """Enumerate installed font families without exposing local file paths."""
    names = set()
    if sys.platform == "win32":
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as key:
                    for index in range(winreg.QueryInfoKey(key)[1]):
                        name = winreg.EnumValue(key, index)[0]
                        name = name.split(" (")[0]
                        names.update(part.strip() for part in name.split(" & ") if part.strip())
            except OSError:
                pass
    return jsonify({"fonts": sorted(names, key=str.casefold)})


@app.after_request
def _no_cache(response):
    if response.mimetype in {"text/html", "application/javascript", "text/css"}:
        response.headers["Cache-Control"] = "no-store"
    return response


def _allowed_roots() -> list[Path]:
    roots: list[Path] = []
    candidates = [config.UPLOAD_DIR, *[Path(item) for item in library.watched_dirs()]]
    for path in candidates:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            continue
        if resolved not in roots:
            roots.append(resolved)
    return roots


def _allowed_file(raw: str, suffixes: tuple[str, ...]) -> Path | None:
    """Resolve a user supplied path, but only inside folders the app manages."""
    if not raw:
        return None
    try:
        candidate = Path(str(raw)).expanduser().resolve()
    except OSError:
        return None
    if not candidate.is_file() or candidate.suffix.lower() not in suffixes:
        return None
    for root in _allowed_roots():
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        return candidate
    return None


def _is_watched_folder(raw: str) -> bool:
    """A watched folder itself, or one of its per-paper subfolders."""
    if not raw:
        return False
    try:
        folder = Path(str(raw)).expanduser().resolve()
    except OSError:
        return False
    for root in _allowed_roots():
        if folder == root or folder.parent == root:
            return True
    return False


def _resolve_exe(settings: dict) -> str | None:
    return runner.find_babeldoc(settings.get("exe_path") or "")


def _console_python() -> str:
    """pythonw.exe has no stdout, so the picker must run under python.exe."""
    exe = Path(sys.executable)
    if exe.name.lower() == "pythonw.exe":
        candidate = exe.with_name("python.exe")
        if candidate.exists():
            return str(candidate)
    return str(exe)


def _pick_native(mode: str, title: str = "", default_name: str = "") -> list[str]:
    cmd = [_console_python(), "-u", str(BASE_DIR / "core" / "picker.py"), "--mode", mode]
    if title:
        cmd += ["--title", title]
    if default_name:
        cmd += ["--default-name", default_name]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as exc:
        raise RuntimeError(f"无法打开文件选择窗口：{exc}") from exc
    text = (proc.stdout or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except ValueError:
        return []
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(data["error"])
    return data if isinstance(data, list) else []


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.get("/library")
def library_page():
    return send_from_directory(WEB_DIR, "library.html")


@app.get("/viewer")
def viewer_page():
    return send_from_directory(WEB_DIR, "viewer.html")


@app.get("/api/health")
def health():
    return _json({"ok": True, "app": "BabelDOC Studio"})


@app.post("/api/quit")
def quit_app():
    """Shut the local server down (used by the 退出应用 button)."""
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return _json({"ok": True})


@app.get("/favicon.svg")
def favicon_svg():
    icon = WEB_DIR / "favicon.svg"
    if icon.exists():
        return send_from_directory(WEB_DIR, "favicon.svg", mimetype="image/svg+xml")
    return ("", 204)


@app.get("/favicon.ico")
def favicon():
    """Windows taskbar / app windows want a real icon, not an SVG payload."""
    ico = WEB_DIR / "babeldoc.ico"
    if ico.exists():
        return send_from_directory(WEB_DIR, "babeldoc.ico", mimetype="image/x-icon")
    icon = WEB_DIR / "favicon.svg"
    if icon.exists():
        return send_from_directory(WEB_DIR, "favicon.svg", mimetype="image/svg+xml")
    return ("", 204)


# --------------------------------------------------------------------------- #
# Bootstrap / settings
# --------------------------------------------------------------------------- #
@app.get("/api/bootstrap")
def bootstrap():
    settings = config.public_settings()
    exe = _resolve_exe(settings)
    try:
        presets.ensure_seeded()
    except Exception:  # a broken preset folder must not block the app
        pass
    return _json(
        {
            "app": "BabelDOC Studio",
            "version": "1.3.0",
            "providers": [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "base_url": item["base_url"],
                    "models": item["models"],
                    "hint": item["hint"],
                }
                for item in providers.PRESETS
            ],
            "languages": LANGUAGES,
            "settings": settings,
            "first_run": not config.SETTINGS_FILE.exists(),
            "glossaries": glossary.list_glossaries(),
            "babeldoc": {
                "available": bool(exe),
                "path": exe or "",
                "version": runner.babeldoc_version(exe),
            },
        }
    )


@app.post("/api/settings")
def save_settings():
    payload = request.get_json(silent=True) or {}
    saved = config.save_public(payload)
    return _json({"settings": saved})


# --------------------------------------------------------------------------- #
# Files
# --------------------------------------------------------------------------- #
@app.post("/api/pick")
def pick_files():
    payload = request.get_json(silent=True) or {}
    mode = payload.get("mode", "files")
    try:
        paths = _pick_native(mode, payload.get("title", ""))
    except RuntimeError as exc:
        return _error(str(exc), 500)
    if mode == "dir":
        return _json({"paths": paths})
    return _json({"files": [pdfinfo.inspect(p) for p in paths]})


@app.post("/api/inspect")
def inspect_paths():
    payload = request.get_json(silent=True) or {}
    paths = payload.get("paths") or []
    return _json({"files": [pdfinfo.inspect(p) for p in paths if Path(p).exists()]})


@app.post("/api/upload")
def upload_files():
    uploaded = request.files.getlist("files")
    if not uploaded:
        return _error("没有收到文件")
    folder = config.UPLOAD_DIR / uuid.uuid4().hex[:10]
    folder.mkdir(parents=True, exist_ok=True)
    infos = []
    for item in uploaded:
        name = Path(item.filename or "document.pdf").name
        if not name.lower().endswith(".pdf"):
            continue
        target = folder / name
        index = 2
        while target.exists():
            target = folder / f"{Path(name).stem} ({index}).pdf"
            index += 1
        item.save(target)
        infos.append(pdfinfo.inspect(target))
    if not infos:
        return _error("只支持 PDF 文件")
    return _json({"files": infos})


# --------------------------------------------------------------------------- #
# Glossaries
# --------------------------------------------------------------------------- #
@app.get("/api/glossaries")
def get_glossaries():
    return _json({"glossaries": glossary.list_glossaries()})


@app.get("/api/glossaries/<name>")
def get_glossary(name: str):
    item = glossary.get_glossary(name)
    if not item:
        return _error("术语库不存在", 404)
    return _json(item)


@app.post("/api/glossaries")
def save_glossary():
    payload = request.get_json(silent=True) or {}
    name = payload.get("name") or ""
    entries = payload.get("entries") or []
    if not name.strip():
        return _error("请填写术语库名称")
    if not entries:
        return _error("请至少添加一条术语")
    result = glossary.write_glossary(name, entries)
    return _json(result)


@app.post("/api/glossaries/import")
def import_glossary():
    uploaded = request.files.get("file")
    if not uploaded:
        return _error("没有收到文件")
    result = glossary.import_csv(uploaded.filename or "imported.csv", uploaded.read())
    return _json(result)


# --------------------------------------------------------------------------- #
# Preset glossaries
# --------------------------------------------------------------------------- #
@app.get("/api/presets")
def preset_index():
    return _json({"presets": presets.list_presets()})


@app.post("/api/presets/install")
def preset_install():
    payload = request.get_json(silent=True) or {}
    try:
        info = presets.install(str(payload.get("id") or ""))
    except ValueError as exc:
        return _error(str(exc), 400)
    except OSError as exc:
        return _error(f"无法写入术语库：{exc}", 500)
    return _json(
        {
            "glossary": info,
            "glossaries": glossary.list_glossaries(),
            "presets": presets.list_presets(),
        }
    )


@app.delete("/api/glossaries/<name>")
def remove_glossary(name: str):
    ok = glossary.delete_glossary(name)
    return _json({"deleted": ok})


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #
def _normalize_job_payload(payload: dict) -> tuple[dict, list[str]]:
    settings = config.public_settings()
    provider_id = payload.get("provider") or settings.get("active_provider") or "zhipu"
    provider_state = (settings.get("providers") or {}).get(provider_id, {})
    preset = providers.get_preset(provider_id)

    base_url = (payload.get("base_url") or provider_state.get("base_url") or preset["base_url"]).strip()
    model = (payload.get("model") or provider_state.get("model") or (preset["models"][0] if preset["models"] else "")).strip()
    api_key = (payload.get("api_key") or provider_state.get("api_key") or "").strip()

    files = [str(Path(p)) for p in payload.get("files") or [] if Path(p).exists()]
    glossary_ids = payload.get("glossary_ids") or []
    page_mode = payload.get("page_mode") or "all"
    page_range = (payload.get("page_range") or "").strip()

    cfg = {
        "provider": provider_id,
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "lang_in": payload.get("lang_in") or "en",
        "lang_out": payload.get("lang_out") or "zh",
        "page_mode": page_mode,
        "page_range": page_range,
        "dual_mode": payload.get("dual_mode") or "side",
        "glossary_paths": glossary.resolve_paths(glossary_ids),
        "auto_glossary": bool(payload.get("auto_glossary", True)),
        "save_glossary": bool(payload.get("save_glossary", True)),
        "skip_references": bool(payload.get("skip_references", True)),
        "reference_page": payload.get("reference_page") or "",
        "output_dir": str(Path(payload.get("output_dir") or config.DEFAULTS["output_dir"])),
        "watermark": payload.get("watermark") or "no_watermark",
        "open_when_done": bool(payload.get("open_when_done", True)),
        "qps": int(payload.get("qps") or 4),
        "custom_prompt": payload.get("custom_prompt") or "",
        "price_input": payload.get("price_input") or "",
        "price_output": payload.get("price_output") or "",
        "price_currency": payload.get("price_currency") or "",
        "skip_scanned": bool(payload.get("skip_scanned", False)),
        "ocr_workaround": bool(payload.get("ocr_workaround", False)),
        "term_model": (payload.get("term_model") or "").strip(),
        "term_model_enabled": bool(payload.get("term_model_enabled", False)),
    }
    return cfg, files


@app.post("/api/jobs")
def start_job():
    payload = request.get_json(silent=True) or {}
    cfg, files = _normalize_job_payload(payload)

    if not files:
        return _error("请先添加至少一个 PDF 文件")
    if not cfg["base_url"]:
        return _error("请填写 API 地址")
    if not cfg["model"]:
        return _error("请填写模型名称")
    if not cfg["api_key"]:
        return _error("请填写 API Key")
    if cfg["page_mode"] == "custom" and not cfg["page_range"]:
        return _error("请输入页面范围，例如 1-5,8")
    exe = _resolve_exe(config.public_settings())
    if not exe:
        return _error("没有找到 babeldoc 命令，请先安装 BabelDOC（uv tool install babeldoc）")

    # Keep earlier results visible in the library if the output folder changes.
    try:
        folder = str(Path(cfg["output_dir"]).resolve())
        if folder not in library.watched_dirs():
            library.add_dir(folder)
    except (OSError, ValueError):
        pass

    try:
        job = manager.start(cfg, files, exe)
    except RuntimeError as exc:
        return _error(str(exc), 409)
    return _json({"job": job.snapshot(0)})


@app.get("/api/jobs/<job_id>")
def job_state(job_id: str):
    job = manager.get(job_id)
    if not job:
        return _error("任务不存在", 404)
    cursor = int(request.args.get("cursor") or 0)
    return _json(job.snapshot(cursor))


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id: str):
    job = manager.get(job_id)
    if not job:
        return _error("任务不存在", 404)
    ok = manager.cancel(job_id)
    if not ok:
        return _error("任务已经结束", 409)
    return _json({"cancelled": True})


# --------------------------------------------------------------------------- #
# Library (translated results) and reader annotations
# --------------------------------------------------------------------------- #
@app.get("/api/library")
def library_index():
    query = (request.args.get("q") or "").strip().lower()
    sort = request.args.get("sort") or "recent"
    items = library.scan()
    if query:
        items = [
            item
            for item in items
            if query in item["name"].lower()
            or any(query in file["name"].lower() for file in item["files"])
        ]
    if sort == "name":
        items.sort(key=lambda item: item["name"].lower())
    elif sort == "size":
        items.sort(key=lambda item: item["size"], reverse=True)
    return _json(
        {
            "items": items,
            "dirs": library.watched_dirs(),
            "extra_dirs": library.extra_dirs(),
            "collections": library.collections(),
        }
    )


@app.get("/api/library/thumb")
def library_thumb():
    target = _allowed_file(request.args.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    try:
        width = max(120, min(1200, int(request.args.get("w") or 420)))
    except ValueError:
        width = 420
    data = library.thumbnail(target, width)
    if not data:
        return _error("无法生成缩略图", 404)
    response = Response(data, mimetype="image/png")
    response.headers["Cache-Control"] = "private, max-age=600"
    return response


@app.get("/api/file")
def serve_document():
    target = _allowed_file(request.args.get("path", ""), (".pdf", ".csv"))
    if not target:
        return _error("文件不可用", 404)
    mimetype = "application/pdf" if target.suffix.lower() == ".pdf" else "text/csv"
    return send_file(
        target,
        mimetype=mimetype,
        conditional=True,
        download_name=target.name,
    )


# --------------------------------------------------------------------------- #
# Collections (paper groups inside the library)
# --------------------------------------------------------------------------- #
@app.get("/api/collections")
def get_collections():
    return _json({"collections": library.collections()})


@app.post("/api/collections")
def create_collection():
    payload = request.get_json(silent=True) or {}
    try:
        entry = library.create_collection(payload.get("name") or "")
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"collection": entry, "collections": library.collections()})


@app.post("/api/collections/<collection_id>")
def rename_collection(collection_id: str):
    payload = request.get_json(silent=True) or {}
    try:
        entry = library.rename_collection(collection_id, payload.get("name") or "")
    except FileNotFoundError as exc:
        return _error(str(exc), 404)
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"collection": entry, "collections": library.collections()})


@app.delete("/api/collections/<collection_id>")
def delete_collection(collection_id: str):
    try:
        library.delete_collection(collection_id)
    except FileNotFoundError as exc:
        return _error(str(exc), 404)
    return _json({"collections": library.collections()})


@app.post("/api/collections/assign")
def assign_collections():
    payload = request.get_json(silent=True) or {}
    item = str(payload.get("item") or "").strip()
    if not item:
        return _error("缺少要归类的条目", 400)
    ids = [str(value) for value in (payload.get("collections") or [])]
    return _json({"collections": library.assign_collections(item, ids)})


@app.post("/api/library/rename")
def library_rename():
    payload = request.get_json(silent=True) or {}
    folder = payload.get("dir") or ""
    if not _is_watched_folder(folder):
        return _error("文件夹不在资料库中", 400)
    try:
        result = library.rename(folder, payload.get("name") or "", payload.get("new_name") or "")
    except FileExistsError as exc:
        return _error(f"已存在同名文件：{exc}", 409)
    except FileNotFoundError as exc:
        return _error(str(exc), 404)
    except ValueError as exc:
        return _error(str(exc), 400)
    except OSError as exc:
        return _error(f"重命名失败：{exc}", 500)
    return _json(result)


@app.post("/api/library/delete")
def library_delete():
    payload = request.get_json(silent=True) or {}
    folder = payload.get("dir") or ""
    if not _is_watched_folder(folder):
        return _error("文件夹不在资料库中", 400)
    try:
        result = library.delete(folder, payload.get("name") or "")
    except FileNotFoundError as exc:
        return _error(str(exc), 404)
    except OSError as exc:
        return _error(f"删除失败：{exc}", 500)
    return _json(result)


@app.post("/api/library/dirs")
def library_add_dir():
    payload = request.get_json(silent=True) or {}
    try:
        dirs = library.add_dir(payload.get("path") or "")
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"dirs": dirs})


@app.delete("/api/library/dirs")
def library_remove_dir():
    payload = request.get_json(silent=True) or {}
    return _json({"dirs": library.remove_dir(payload.get("path") or "")})


@app.get("/api/annotations")
def get_annotations():
    target = _allowed_file(request.args.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    data = annotations.load(target)
    data["path"] = str(target)
    data["doc_id"] = annotations.document_id(target)
    return _json(data)


@app.post("/api/annotations")
def save_annotations():
    payload = request.get_json(silent=True) or {}
    target = _allowed_file(payload.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    try:
        data = annotations.save(target, payload.get("items") or [])
    except OSError as exc:
        return _error(str(exc), 500)
    data["path"] = str(target)
    data["doc_id"] = annotations.document_id(target)
    return _json(data)


@app.post("/api/annotations/export")
def export_annotations_pdf():
    """Write the reader's highlights and notes into a shareable PDF copy."""
    payload = request.get_json(silent=True) or {}
    target = _allowed_file(payload.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    items = payload.get("items")
    if items is None:
        items = annotations.load(target)["items"]
    try:
        result = pdfexport.export(target, items)
    except OSError:
        # A read-only output folder must not cost the user their notes.
        fallback = config.APP_DIR / "exports" / pdfexport.default_target(target).name
        try:
            result = pdfexport.export(target, items, fallback)
        except Exception as exc:
            return _error(f"导出失败：{exc}", 500)
    except Exception as exc:
        return _error(f"导出失败：{exc}", 500)
    result["name"] = Path(result["path"]).name
    return _json(result)


@app.get("/api/annotations/pdf")
def read_annotations_pdf():
    """Annotations already embedded in a PDF (e.g. shared from another machine)."""
    target = _allowed_file(request.args.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    try:
        items = pdfexport.read(target)
    except Exception as exc:
        return _error(f"无法读取 PDF 批注：{exc}", 500)
    return _json({"items": items, "count": len(items)})


# --------------------------------------------------------------------------- #
# System integration
# --------------------------------------------------------------------------- #
@app.post("/api/open")
def open_path():
    payload = request.get_json(silent=True) or {}
    target = Path(payload.get("path") or "")
    if not target.exists():
        return _error("路径不存在", 404)
    try:
        if target.is_dir():
            os.startfile(str(target))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["explorer", "/select,", str(target)])
    except Exception as exc:
        return _error(f"无法打开：{exc}", 500)
    return _json({"ok": True})


@app.post("/api/test-connection")
def test_connection():
    payload = request.get_json(silent=True) or {}
    base_url = (payload.get("base_url") or "").strip().rstrip("/")
    api_key = (payload.get("api_key") or "").strip()
    model = (payload.get("model") or "").strip()
    if not base_url or not model:
        return _error("请先填写 API 地址与模型")
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1,
            "temperature": 0,
        }
    ).encode("utf-8")
    request_obj = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}" if api_key else "",
        },
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request_obj, timeout=25) as response:
            response.read(200)
        return _json(
            {"ok": True, "latency_ms": int((time.time() - started) * 1000)}
        )
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return _json(
            {"ok": False, "status": exc.code, "message": detail or str(exc)}, 200
        )
    except Exception as exc:
        return _json({"ok": False, "message": str(exc)}, 200)


# --------------------------------------------------------------------------- #
# Launcher
# --------------------------------------------------------------------------- #
def _free_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _open_window(url: str) -> None:
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    for exe in candidates:
        if Path(exe).exists():
            try:
                subprocess.Popen(
                    [exe, f"--app={url}", "--window-size=1240,960", "--disable-features=Translate"],
                )
                return
            except OSError:
                continue
    webbrowser.open(url)


def _app_alive(port: int) -> bool:
    """Fast socket probe so a second launch just re-opens the existing app."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.3) as sock:
            sock.settimeout(0.6)
            sock.sendall(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
            data = b""
            while len(data) < 1024:
                chunk = sock.recv(512)
                if not chunk:
                    break
                data += chunk
                if b"BabelDOC Studio" in data:
                    return True
    except OSError:
        return False
    return False


def main() -> None:
    # pythonw.exe starts with no std streams; keep prints/logging harmless.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")

    args = sys.argv[1:]
    server_only = "--server-only" in args
    port = 8765
    for index, arg in enumerate(args):
        if arg == "--port" and index + 1 < len(args):
            try:
                port = int(args[index + 1])
            except ValueError:
                pass

    # Reuse a running instance instead of stacking servers on new ports.
    if not server_only:
        for candidate in range(8765, 8805):
            if _app_alive(candidate):
                _open_window(f"http://127.0.0.1:{candidate}/")
                return

    config.ensure_dirs()
    port = _free_port(port)
    url = f"http://127.0.0.1:{port}/"

    from werkzeug.serving import make_server

    server = make_server("127.0.0.1", port, app, threaded=True)
    print(f"BabelDOC Studio running at {url}", flush=True)
    if not server_only:
        threading.Timer(0.8, lambda: _open_window(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopping…", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:  # keep a traceback even under pythonw (no console)
        import traceback

        try:
            config.APP_DIR.mkdir(parents=True, exist_ok=True)
            (config.APP_DIR / "last-error.log").write_text(
                traceback.format_exc(), encoding="utf-8"
            )
        except Exception:
            pass
        raise
