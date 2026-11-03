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

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from core import config, glossary, pdfinfo, providers, runner  # noqa: E402
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


@app.after_request
def _no_cache(response):
    if response.mimetype in {"text/html", "application/javascript", "text/css"}:
        response.headers["Cache-Control"] = "no-store"
    return response


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


@app.get("/api/health")
def health():
    return _json({"ok": True, "app": "BabelDOC Studio"})


@app.post("/api/quit")
def quit_app():
    """Shut the local server down (used by the 退出应用 button)."""
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return _json({"ok": True})


@app.get("/favicon.ico")
def favicon():
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
    return _json(
        {
            "app": "BabelDOC Studio",
            "version": "1.0.0",
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
