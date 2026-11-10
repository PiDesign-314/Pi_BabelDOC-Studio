"""Browser regression test: Zotero opens the reader at the requested page and
the reader reports its position back to the local bridge.

Run:  python tests/zotero_reader_ui.py        (needs playwright + msedge)

What this proves end-to-end (no Zotero installation needed):

1. a PDF imported through ``core.zotero.import_attachment`` opens with
   ``/viewer?from=zotero&page=N`` on page N (not on the locally remembered
   page), and the reader says it came from Zotero;
2. the reader mirrors its page to ``/api/zotero/position``; the bridge stores
   it in ``links.json`` and the next Zotero-style open resumes there;
3. reopening without ``page`` falls back to the position remembered by the
   reader (localStorage) instead of page 1;
4. when the remembered file is a translation, ``open_link`` maps the original
   page to the translation and the viewer opens it at that page.

Everything uses throw-away APP_DIR / upload / annotation folders.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf
import requests
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config, library, zotero

ROOT = Path(__file__).resolve().parents[1]
RUN = (ROOT / ".tmp" / "zotero-reader-ui" / uuid.uuid4().hex[:8]).resolve()
RUN.mkdir(parents=True, exist_ok=True)

# Isolate everything the app reads/writes before the server starts.
config.APP_DIR = RUN / "appdata"
config.UPLOAD_DIR = RUN / "uploads"
config.DEFAULTS["output_dir"] = str(RUN / "output")
annotations.ANNOTATION_DIR = RUN / "annotations"
library.watched_dirs = lambda: [str(RUN / "output")]  # type: ignore[assignment]
for folder in (config.UPLOAD_DIR, RUN / "output"):
    folder.mkdir(parents=True, exist_ok=True)

PAGES = 5


def make_pdf(path: Path, pages: int = PAGES, title: str = "Zotero reader page") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    for index in range(pages):
        page = document.new_page(width=600, height=800)
        page.insert_text((72, 90), f"{title} {index + 1}", fontsize=16)
        page.insert_text((72, 130), "Selectable body text for the reader.", fontsize=13)
    document.save(path)
    document.close()
    return path


SOURCE = make_pdf(RUN / "zotero-storage" / "ABCD1234" / "zotero-paper.pdf")
JSON_HEADERS = {"Content-Type": "application/json"}

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + name + (f"  [{detail}]" if detail and not condition else ""))
    if not condition:
        failures.append(name)


def primary_path() -> Path:
    status = requests.get(BASE + "/api/zotero/status", timeout=5).json()
    assert status["link_count"] == 1, status
    path = Path(status["links"][0]["imported_path"])
    assert path.is_file(), path
    return path


def link_page() -> int:
    status = requests.get(BASE + "/api/zotero/status", timeout=5).json()
    return int(status["links"][0]["page"])


def wait_for_page(expected: int, timeout: float = 8.0) -> int:
    deadline = time.time() + timeout
    last = -1
    while time.time() < deadline:
        last = link_page()
        if last == expected:
            return last
        time.sleep(0.25)
    return last


def main() -> None:
    payload = {
        "path": str(SOURCE),
        "library_id": "1",
        "item_key": "ITEM0001",
        "attachment_key": "ATTACH01",
        "title": "Zotero 阅读定位测试",
        "doi": "10.1145/0000000.0000001",
        "creators": "Test Author",
        "year": "2026",
    }
    record, copied = zotero.import_attachment(payload)
    check("first import copies the attachment", copied and Path(record["imported_path"]).is_file())
    imported = primary_path()
    check("imported path is inside the managed Zotero folder", "zotero" in str(imported).lower())
    check("initial reading position is page 1", link_page() == 1, str(link_page()))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        errors: list[str] = []
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        # 1) Explicit page from the URL wins and says where it came from.
        page.goto(
            f"{BASE}/viewer?path={imported.as_posix()}&from=zotero&page=3",
            wait_until="networkidle",
        )
        page.wait_for_selector(".r-page", timeout=20000)
        page.wait_for_timeout(600)
        check("viewer opens on the requested page 3", page.input_value("#page-input") == "3",
              page.input_value("#page-input"))
        toasts = page.locator("#toasts").inner_text()
        check("reader shows it came from Zotero", "Zotero" in toasts, toasts)
        check("bridge stores the reported page 3", wait_for_page(3) == 3, str(link_page()))

        # 2) Moving forward is reported too (the reader throttles, so give it
        #    more than one throttle window before changing page).
        page.wait_for_timeout(3300)
        page.evaluate("window.ReaderBridge.goToPage(4)")
        page.wait_for_timeout(900)
        check("bridge stores the new page 4", wait_for_page(4) == 4, str(link_page()))

        # 3) Re-open the same attachment without `page`: the reader's own
        #    remembered position is used, not page 1.
        page.goto(f"{BASE}/viewer?path={imported.as_posix()}&from=zotero",
                  wait_until="networkidle")
        page.wait_for_selector(".r-page", timeout=20000)
        page.wait_for_timeout(600)
        check("reopen resumes page 4", page.input_value("#page-input") == "4",
              page.input_value("#page-input"))

        # 4) A translation is remembered and mapped back to the original page.
        translation = make_pdf(RUN / "output" / imported.stem / f"{imported.stem}_译文（无水印）.pdf")
        zotero.report_position(translation, 4, PAGES)
        opened = requests.post(
            BASE + "/api/zotero/open",
            json={**payload, "open_window": False},
            headers=JSON_HEADERS,
            timeout=20,
        ).json()
        check("open_response uses the translation", opened.get("variant") == "translation",
              json.dumps(opened, ensure_ascii=False))
        check("translation opens at its mapped page 4", opened.get("page") == 4, str(opened.get("page")))
        check("open URL carries from=zotero", "from=zotero" in opened.get("url", ""), opened.get("url", ""))

        check("no page errors", not errors, "; ".join(errors))
        browser.close()

    server.shutdown()


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 - script-style test reporter
        import traceback

        traceback.print_exc()
        failures.append(f"exception: {exc}")
    finally:
        try:
            server.shutdown()
        except Exception:
            pass
    if failures:
        print(f"ZOTERO READER UI FAIL ({len(failures)}): " + ", ".join(failures))
        raise SystemExit(1)
    print("ZOTERO READER UI PASS")
