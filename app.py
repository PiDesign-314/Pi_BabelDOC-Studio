"""BabelDOC Studio — local web app with an Apple HIG-style interface.

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
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_file, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from core import (  # noqa: E402
    ai_reader,
    annotations,
    config,
    fonts,
    glossary,
    library,
    notes,
    pdfexport,
    pdfinfo,
    presets,
    providers,
    runner,
    toc as toc_reader,
)
from core.languages import LANGUAGES  # noqa: E402

WEB_DIR = BASE_DIR / "web"

APP_VERSION = "1.6.0"
# The reader checks these before trusting the server with the newer annotation
# types; a stale process keeps an old API alive and silently drops them.
API_FEATURES = ("text", "ink", "styles", "fonts", "margin-notes", "toc", "ai-reader", "notes")


def _build_id() -> int:
    """Newest source mtime — lets the UI tell a stale server from a fresh one."""
    latest = 0.0
    for pattern in ("app.py", "core/*.py", "web/*.js", "web/*.css", "web/*.html"):
        for path in BASE_DIR.glob(pattern):
            try:
                latest = max(latest, path.stat().st_mtime)
            except OSError:
                continue
    return int(latest)


BUILD_ID = _build_id()

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


GOOGLE_TRANSLATE_URL = "https://clients5.google.com/translate_a/t"
GOOGLE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
GOOGLE_LANG = {
    "zh": "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW", "zh-hans": "zh-CN",
    "zh-hant": "zh-TW", "en": "en", "ja": "ja", "ko": "ko", "fr": "fr",
    "de": "de", "es": "es", "ru": "ru", "pt": "pt", "it": "it", "ar": "ar",
    "nl": "nl", "pl": "pl", "tr": "tr", "vi": "vi", "th": "th", "id": "id",
}
_google_lock = threading.Lock()
_google_last = [0.0]


def _google_lang(code: str) -> str:
    return GOOGLE_LANG.get(str(code or "").lower(), str(code or "auto"))


def _google_result_text(data) -> str:
    """The free endpoint replies with either ["text"] or nested segments."""
    if isinstance(data, str):
        return data
    parts: list[str] = []
    if isinstance(data, list):
        # With sl=auto the endpoint appends the detected language as a second
        # string (e.g. ["翻译", "en"]); only the first string is translation.
        if data and isinstance(data[0], str):
            return data[0]
        for item in data:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, list) and item:
                # [["翻译", "en"]] — keep the translated segment, drop the tag.
                if isinstance(item[0], str):
                    parts.append(item[0])
    return "".join(parts)


def _google_translate_chunk(text: str, target: str) -> str:
    params = urllib.parse.urlencode(
        {"client": "dict-chrome-ex", "sl": "auto", "tl": target, "q": text}
    )
    request_ = urllib.request.Request(
        GOOGLE_TRANSLATE_URL + "?" + params,
        headers={"User-Agent": GOOGLE_UA, "Accept": "application/json"},
    )
    # Respect the system proxy (the free endpoint is not reachable directly
    # from mainland China); the local BabelDOC request itself bypasses it via
    # NO_PROXY set in core.runner.
    opener = urllib.request.build_opener()
    with _google_lock:
        wait = 0.32 - (time.monotonic() - _google_last[0])
        if wait > 0:
            time.sleep(wait)
        _google_last[0] = time.monotonic()
        with opener.open(request_, timeout=25) as response:
            data = json.loads(response.read().decode("utf-8"))
    return _google_result_text(data)


def _google_translate(text: str, target: str) -> str:
    """Translate long paragraphs line by line to stay inside the URL limit."""
    text = str(text or "")
    if not text.strip():
        return ""
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        if current and len(current) + len(line) + 1 > 1500:
            chunks.append(current)
            current = line
        else:
            current = f"{current}\n{line}" if current else line
    if current:
        chunks.append(current)
    return "\n".join(
        _google_translate_chunk(chunk, target) if chunk.strip() else chunk
        for chunk in chunks
    )


def _google_source(prompt: str) -> str | None:
    """BabelDOC wraps the paragraph in a long LLM prompt; take only the text."""
    value = str(prompt or "")
    for marker in ("Now translate the following text:", "Input:\n\n"):
        index = value.rfind(marker)
        if index >= 0:
            return value[index + len(marker):].strip("\n")
    return None


@app.post("/api/google/v1/<lang>/chat/completions")
def google_chat_completions(lang: str):
    """OpenAI-compatible shim backed by the free Google Translate endpoint."""
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return _error("仅本机可用", 403)
    payload = request.get_json(silent=True) or {}
    content = ""
    for message in payload.get("messages") or []:
        if isinstance(message, dict) and message.get("role") == "user":
            content = str(message.get("content") or "")
    source = _google_source(content)
    if source is None:
        return _error("Google 翻译只支持纯文本段落", 400)
    try:
        translated = _google_translate(source, _google_lang(lang))
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            return _json(
                {"error": {"message": "Google 翻译限流，请稍后重试", "type": "rate_limit"}},
                429,
            )
        return _error(f"Google 翻译失败：HTTP {exc.code}", 502)
    except Exception as exc:
        return _error(f"Google 翻译失败：{exc}", 502)
    translated = translated or source
    created = int(time.time())
    return _json(
        {
            "id": f"chatcmpl-google-{created}",
            "object": "chat.completion",
            "created": created,
            "model": "google-translate",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": translated},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": max(1, len(source) // 4),
                "completion_tokens": max(1, len(translated) // 4),
                "total_tokens": max(2, (len(source) + len(translated)) // 4),
            },
        }
    )


@app.get("/api/fonts")
def local_fonts():
    """Fonts the reader can use for page text: installed, imported, bundled."""
    return jsonify({"fonts": fonts.public_fonts(), "count": len(fonts.registry())})


@app.get("/api/font-file/<font_id>")
def font_file(font_id):
    """Serve a font file by id so the page can @font-face it without paths."""
    found = fonts.font_file(font_id)
    if not found:
        return _error("字体不可用", 404)
    path, mimetype = found
    response = send_file(path, mimetype=mimetype, conditional=True, max_age=86400)
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response


@app.post("/api/fonts/upload")
def upload_font():
    """Import a .ttf/.otf/.ttc the user picked; it stays on this machine."""
    upload = request.files.get("file")
    if not upload:
        return _error("没有选择字体文件")
    data = upload.read(fonts.MAX_BYTES + 1)
    try:
        entry = fonts.import_bytes(upload.filename or "font.ttf", data, request.form.get("label", ""))
    except ValueError as exc:
        return _error(str(exc))
    return _json({"font": entry})


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
    return _json(
        {
            "ok": True,
            "app": "BabelDOC Studio",
            "version": APP_VERSION,
            "features": list(API_FEATURES),
            "build": BUILD_ID,
        }
    )


@app.post("/api/quit")
def quit_app():
    """Shut the local server down (used by the 退出应用 button)."""
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return _json({"ok": True})


@app.post("/api/app/restart")
def restart_app():
    """Restart the server in place so the page picks up updated code.

    A stale pythonw process is the one reason a brand-new UI could still lose
    annotations, and asking the user to find the window and relaunch it by hand
    is exactly the kind of friction that hides the fix.  The page polls
    /api/health after calling this and reloads when the new server answers.
    """
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        return _error("仅本机可用", 403)
    raw_port = request.host.rsplit(":", 1)[-1] if ":" in request.host else "8765"
    try:
        port = int(raw_port)
    except ValueError:
        port = 8765
    exe = Path(sys.executable)
    if exe.name.lower() == "python.exe":
        windowless = exe.with_name("pythonw.exe")
        if windowless.exists():
            exe = windowless
    script = BASE_DIR / "app.py"
    # Spawn a tiny waiter: it sleeps while this process closes the socket, then
    # starts the new server on the same port (no second app window).
    waiter = (
        "import subprocess, sys, time\n"
        "time.sleep(1.6)\n"
        "subprocess.Popen(sys.argv[2:], cwd=sys.argv[1], close_fds=True)\n"
    )
    try:
        subprocess.Popen(
            [str(exe), "-c", waiter, str(BASE_DIR), str(exe), str(script), "--server-only", "--port", str(port)],
            cwd=str(BASE_DIR),
            close_fds=True,
        )
    except OSError as exc:
        return _error(f"无法重启应用：{exc}", 500)
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return _json({"ok": True, "port": port, "version": APP_VERSION})


@app.get("/favicon.svg")
def favicon_svg():
    icon = WEB_DIR / "favicon.svg"
    if icon.exists():
        response = send_from_directory(WEB_DIR, "favicon.svg", mimetype="image/svg+xml")
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
    return ("", 204)


@app.get("/favicon.ico")
def favicon():
    """Windows taskbar / app windows want a real icon, not an SVG payload."""
    ico = WEB_DIR / "babeldoc.ico"
    if ico.exists():
        response = send_from_directory(WEB_DIR, "babeldoc.ico", mimetype="image/x-icon")
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response
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
            "version": APP_VERSION,
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

    lang_in = payload.get("lang_in") or "en"
    lang_out = payload.get("lang_out") or "zh"
    if provider_id == "google_free":
        host = request.host or "127.0.0.1:8765"
        port = host.rsplit(":", 1)[-1] if ":" in host else "8765"
        if not port.isdigit():
            port = "8765"
        base_url = f"http://127.0.0.1:{port}/api/google/v1/{lang_out}"
        model = "google-translate"
        api_key = "google-free"
    else:
        base_url = (payload.get("base_url") or provider_state.get("base_url") or preset["base_url"]).strip()
        model = (payload.get("model") or provider_state.get("model") or (preset["models"][0] if preset["models"] else "")).strip()
        api_key = (payload.get("api_key") or provider_state.get("api_key") or "").strip()
        if provider_id == "ollama" and not api_key:
            api_key = "ollama"

    files = [str(Path(p)) for p in payload.get("files") or [] if Path(p).exists()]
    glossary_ids = payload.get("glossary_ids") or []
    page_mode = payload.get("page_mode") or "all"
    page_range = (payload.get("page_range") or "").strip()

    cfg = {
        "provider": provider_id,
        "base_url": base_url,
        "model": model,
        "api_key": api_key,
        "lang_in": lang_in,
        "lang_out": lang_out,
        "page_mode": page_mode,
        "page_range": page_range,
        "dual_mode": payload.get("dual_mode") or "side",
        "glossary_paths": glossary.resolve_paths(glossary_ids),
        "auto_glossary": bool(payload.get("auto_glossary", True)) and provider_id != "google_free",
        "save_glossary": bool(payload.get("save_glossary", True)) and provider_id != "google_free",
        "skip_references": bool(payload.get("skip_references", True)),
        "reference_page": payload.get("reference_page") or "",
        "output_dir": str(Path(payload.get("output_dir") or config.DEFAULTS["output_dir"])),
        "watermark": payload.get("watermark") or "no_watermark",
        "open_when_done": bool(payload.get("open_when_done", True)),
        "qps": min(int(payload.get("qps") or 4), 2) if provider_id == "google_free" else int(payload.get("qps") or 4),
        "custom_prompt": payload.get("custom_prompt") or "",
        "price_input": payload.get("price_input") or "",
        "price_output": payload.get("price_output") or "",
        "price_currency": payload.get("price_currency") or "",
        "skip_scanned": bool(payload.get("skip_scanned", False)),
        "ocr_workaround": bool(payload.get("ocr_workaround", False)),
        "term_model": (payload.get("term_model") or "").strip(),
        "term_model_enabled": bool(payload.get("term_model_enabled", False)) and provider_id != "google_free",
        "google_free": provider_id == "google_free",
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
# Reader TOC + AI reading
# --------------------------------------------------------------------------- #
@app.get("/api/reader/toc")
def reader_toc():
    target = _allowed_file(request.args.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    force = (request.args.get("force") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    try:
        data = toc_reader.read_toc(target, force=force)
    except FileNotFoundError:
        return _error("文件不存在", 404)
    except Exception as exc:
        return _error(f"目录识别失败：{exc}", 500)
    return _json(data)


@app.post("/api/reader/ask")
def reader_ask():
    payload = request.get_json(silent=True) or {}
    target = _allowed_file(payload.get("path", ""), (".pdf",))
    if not target:
        return _error("文件不可用", 404)
    question = str(payload.get("question") or "").strip()
    if not question:
        return _error("请输入问题", 400)
    quote = payload.get("quote")
    if not isinstance(quote, dict):
        quote = None
    history = payload.get("history")
    if not isinstance(history, list):
        history = []
    provider = payload.get("provider")
    if not isinstance(provider, (dict, str)):
        provider = None
    try:
        result = ai_reader.answer(str(target), question, quote, history, provider)
    except ai_reader.ReaderError as exc:
        return _error(str(exc), exc.status)
    except Exception as exc:
        return _error(f"AI 助读失败：{exc}", 500)
    return _json(result)


@app.get("/api/ai/status")
def ai_status():
    providers_status = ai_reader.detect_providers()
    return _json(
        {
            "providers": providers_status,
            "configured": config.public_ai_settings(),
            "default": ai_reader.default_provider(providers_status),
        }
    )


@app.get("/api/ai/settings")
def ai_settings_get():
    return _json(config.public_ai_settings())


@app.post("/api/ai/settings")
def ai_settings_save():
    payload = request.get_json(silent=True) or {}
    try:
        return _json(config.save_ai_settings(payload))
    except Exception as exc:
        return _error(f"保存 AI 设置失败：{exc}", 500)


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
# Notes
# --------------------------------------------------------------------------- #
def _notes_payload() -> dict:
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


@app.get("/api/notes")
def notes_index():
    category = request.args.get("category")
    if category is not None and not category.strip():
        category = None
    path = request.args.get("path")
    if path is not None and not path.strip():
        path = None
    return _json(
        notes.list_notes(
            query=request.args.get("q") or "",
            category_id=category,
            path=path,
        )
    )


@app.post("/api/notes")
def notes_create():
    payload = _notes_payload()
    try:
        note = notes.create_note(
            title=payload.get("title") or "",
            body=payload.get("body") or "",
            category_id=payload.get("category_id") or "",
            source=payload.get("source"),
        )
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"note": note})


@app.patch("/api/notes/<note_id>")
def notes_update(note_id: str):
    payload = _notes_payload()
    fields = {
        key: payload[key]
        for key in ("title", "body", "category_id", "source")
        if key in payload
    }
    try:
        note = notes.update_note(note_id, **fields)
    except LookupError as exc:
        return _error(str(exc), 404)
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"note": note})


@app.delete("/api/notes/<note_id>")
def notes_delete(note_id: str):
    try:
        notes.delete_note(note_id)
    except LookupError as exc:
        return _error(str(exc), 404)
    return _json({"ok": True})


@app.post("/api/notes/categories")
def notes_create_category():
    payload = _notes_payload()
    try:
        category = notes.create_category(payload.get("name") or "")
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"category": category, "categories": notes.list_categories()})


@app.patch("/api/notes/categories/<category_id>")
def notes_rename_category(category_id: str):
    payload = _notes_payload()
    try:
        category = notes.rename_category(category_id, payload.get("name") or "")
    except LookupError as exc:
        return _error(str(exc), 404)
    except ValueError as exc:
        return _error(str(exc), 400)
    return _json({"category": category, "categories": notes.list_categories()})


@app.delete("/api/notes/categories/<category_id>")
def notes_delete_category(category_id: str):
    try:
        notes.delete_category(category_id)
    except LookupError as exc:
        return _error(str(exc), 404)
    return _json({"categories": notes.list_categories()})


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
