"""Browser test for the result library's card menus and prepare-mode 翻译.

Covers the three UX changes on /library:

1. right-click a card -> 「打开源文件所在位置」 posts the source PDF path to
   /api/open (intercepted: Windows Explorer must never actually open);
2. the split 阅读 control: 阅读原文 / 仅译文 / 左右排版译文, listing only the
   variants the paper really has; result cards get a caret listing their PDFs;
3. 翻译 hands the PDF to the home page as /?prepare=<path> and starts no job.

Run: python tests/library_ui_features.py
"""
from __future__ import annotations

import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pymupdf
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from core import config, library


ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / ".tmp" / "library-ui-features" / uuid.uuid4().hex[:8]
RUN.mkdir(parents=True, exist_ok=True)
OUTPUT = RUN / "output"
config.APP_DIR = RUN / "appdata"
config.UPLOAD_DIR = RUN / "uploads"
config.DEFAULTS["output_dir"] = str(OUTPUT)
library.watched_dirs = lambda: [str(OUTPUT)]
OUTPUT.mkdir(parents=True, exist_ok=True)


def make_pdf(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 90), text)
    doc.save(path)
    doc.close()
    return path


# One Zotero item with both translated artefacts next to the imported copy, one
# without translations, a result paper with two PDFs and one with a single PDF.
zot_pdf = make_pdf(RUN / "zotero" / "zotpaper.pdf", "Zotero paper")
plain_pdf = make_pdf(RUN / "zotero" / "plain.pdf", "Zotero plain")
result_translation = make_pdf(OUTPUT / "示例论文_译文.pdf", "translated")
result_dual = make_pdf(OUTPUT / "示例论文_双语对照.pdf", "dual manuscript")
single_pdf = make_pdf(OUTPUT / "单篇_译文.pdf", "single")
zot_translation = make_pdf(OUTPUT / "zotpaper_译文.pdf", "zotero translated")
zot_dual = make_pdf(OUTPUT / "zotpaper_双语对照.pdf", "zotero dual")

SNAPSHOT = {
    "schema": 1,
    "zotero_version": "10.0.8",
    "libraries": [{"id": 1, "name": "我的文库"}],
    "collections": [{"id": 7, "library_id": 1, "name": "机器人", "parent_id": 0}],
    "items": [
        {
            "key": "ITEM0001",
            "library_id": 1,
            "title": "Zotero 已翻译论文",
            "creators": "Alice Example",
            "year": "2024",
            "collections": [7],
            "attachments": [
                {"key": "PDF00001", "path": str(zot_pdf), "filename": zot_pdf.name}
            ],
        },
        {
            "key": "ITEM0002",
            "library_id": 1,
            "title": "Zotero 未翻译论文",
            "creators": "Bob Example",
            "year": "2023",
            "collections": [7],
            "attachments": [
                {"key": "PDF00002", "path": str(plain_pdf), "filename": plain_pdf.name}
            ],
        },
    ],
}

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"


def query_param(url: str, name: str) -> str:
    values = parse_qs(urlparse(url).query).get(name) or [""]
    return values[0]


def menu_labels(page) -> list[str]:
    return [
        text.strip()
        for text in page.locator(".card-menu .card-menu-label").all_inner_texts()
    ]


def open_library(page, query: str = "") -> None:
    """Load /library.  The cards arrive through fetch, so callers wait for them."""
    page.goto(base + "/library" + query, wait_until="domcontentloaded")


def viewer_entry_url(page) -> str:
    """The URL the viewer document was created with (before any rewrite)."""
    page.locator("#back-link").wait_for(state="visible")
    return page.evaluate("window.__entryUrl") or ""


def assert_same_file(actual: str, expected: Path) -> None:
    assert actual, "reader URL has no path parameter"
    assert Path(actual).resolve() == expected.resolve(), actual


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        # The home page consumes ?prepare= with history.replaceState right away,
        # so remember the URL each document was created with.
        page.add_init_script("window.__entryUrl = location.href;")
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        # ---- seed: Zotero snapshot + the imported link with its artefacts -----
        response = page.request.post(base + "/api/zotero/library", data=SNAPSHOT)
        assert response.status == 200, response.text()
        seed = page.request.post(
            base + "/api/zotero/open",
            data={
                "path": str(zot_pdf),
                "library_id": 1,
                "item_key": "ITEM0001",
                "attachment_key": "PDF00001",
                "mode": "read",
                "variant": "original",
                "page": 0,
                "open_window": False,
            },
        )
        assert seed.status == 200, seed.text()
        view = page.request.get(base + "/api/zotero/library").json()
        items = {item["key"]: item for item in view["items"]}
        assert items["ITEM0001"]["translated"] == {
            "translation": True,
            "dual": True,
        }, items["ITEM0001"]
        assert items["ITEM0002"]["translated"] == {
            "translation": False,
            "dual": False,
        }, items["ITEM0002"]

        # Explorer must never be launched by the test: capture the posted path.
        opened: list[dict] = []

        def capture_open(route):
            opened.append(route.request.post_data_json or {})
            route.fulfill(
                status=200, content_type="application/json", body='{"ok": true}'
            )

        page.route("**/api/open", capture_open)

        # ===================== 1. right-click: source location ================
        open_library(page, "?source=zotero")
        page.locator("#zotero-block").wait_for(state="visible")
        page.locator(".zot-card").first.wait_for(state="visible")
        translated_card = page.locator(".zot-card", has_text="Zotero 已翻译论文")
        plain_card = page.locator(".zot-card", has_text="Zotero 未翻译论文")
        assert translated_card.count() == 1 and plain_card.count() == 1

        translated_card.click(button="right")
        page.locator(".card-menu").wait_for(state="visible")
        assert page.locator(".card-menu").get_attribute("role") == "menu"
        assert menu_labels(page) == ["打开源文件所在位置"], menu_labels(page)
        # The app-wide shortcut menu (context-menu.js) must not open as well.
        assert "翻译工作台" not in page.locator("body").inner_text()
        menu_box = page.locator(".card-menu").bounding_box()
        assert menu_box["x"] >= 0 and menu_box["y"] >= 0, menu_box
        assert menu_box["x"] + menu_box["width"] <= 1440, menu_box
        assert menu_box["y"] + menu_box["height"] <= 900, menu_box
        page.locator(".card-menu [role=menuitem]").first.click()
        page.wait_for_timeout(200)
        assert page.locator(".card-menu").count() == 0, "context menu stayed open"
        assert opened and opened[-1].get("path") == str(zot_pdf), opened

        # Escape and an outside press both close the menu.
        translated_card.click(button="right")
        page.locator(".card-menu").wait_for(state="visible")
        page.keyboard.press("Escape")
        assert page.locator(".card-menu").count() == 0
        translated_card.click(button="right")
        page.locator(".card-menu").wait_for(state="visible")
        page.locator("#lib-title").click()
        assert page.locator(".card-menu").count() == 0

        # ===================== 2a. Zotero read drop-down ======================
        caret = translated_card.locator('[data-zact="readmenu"]')
        assert caret.count() == 1
        assert caret.get_attribute("aria-expanded") == "false"
        caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        assert caret.get_attribute("aria-expanded") == "true"
        assert menu_labels(page) == ["阅读原文", "仅译文", "左右排版译文"], menu_labels(page)

        # light + dark screenshots of the open drop-down (shared design tokens)
        page.keyboard.press("Escape")
        page.locator("#btn-theme").click()  # auto -> light
        caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        page.wait_for_timeout(250)  # let the pop-in animation finish
        page.screenshot(path=str(RUN / "library-menu-light.png"))
        page.keyboard.press("Escape")
        page.locator("#btn-theme").click()  # light -> dark
        caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        page.wait_for_timeout(250)
        page.screenshot(path=str(RUN / "library-menu-dark.png"))
        page.locator("#btn-theme").click()  # dark -> auto

        # Keyboard: Enter opens the caret menu, arrows move, Enter activates.
        caret.focus()
        page.keyboard.press("Enter")
        page.locator(".card-menu").wait_for(state="visible")
        page.keyboard.press("Escape")
        assert page.locator(".card-menu").count() == 0
        caret.focus()
        page.keyboard.press("Enter")
        page.locator(".card-menu").wait_for(state="visible")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
        page.wait_for_url("**/viewer?*")
        assert_same_file(query_param(viewer_entry_url(page), "path"), zot_dual)

        # Back to the Zotero cards: a paper without translations only offers
        # the original, and the mouse picks 仅译文.
        open_library(page, "?source=zotero")
        page.locator(".zot-card").first.wait_for(state="visible")
        translated_card = page.locator(".zot-card", has_text="Zotero 已翻译论文")
        plain_card = page.locator(".zot-card", has_text="Zotero 未翻译论文")
        caret = translated_card.locator('[data-zact="readmenu"]')
        plain_caret = plain_card.locator('[data-zact="readmenu"]')
        plain_caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        assert menu_labels(page) == ["阅读原文"], menu_labels(page)
        page.keyboard.press("Escape")
        assert page.locator(".card-menu").count() == 0
        assert caret.get_attribute("aria-expanded") == "false"

        # Only 译文 opens the translation artefact, not the dual one.
        caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        page.locator(".card-menu [role=menuitem]", has_text="仅译文").click()
        page.wait_for_url("**/viewer?*")
        assert_same_file(
            query_param(viewer_entry_url(page), "path"), zot_translation
        )

        # ===================== 2b. result card read caret =====================
        open_library(page)
        page.locator('#rail [data-filter="all"]').click()
        multi_card = page.locator(".lib-card", has_text="示例论文")
        multi_card.wait_for(state="visible")
        single_card = page.locator(".lib-card", has_text="单篇")
        assert single_card.count() == 1
        assert multi_card.locator('[data-act="readmenu"]').count() == 1
        assert single_card.locator('[data-act="readmenu"]').count() == 0
        page.screenshot(path=str(RUN / "library-result-cards.png"))

        multi_caret = multi_card.locator('[data-act="readmenu"]')
        multi_caret.click()
        page.locator(".card-menu").wait_for(state="visible")
        assert menu_labels(page) == ["译文", "双语对照"], menu_labels(page)
        # The PDF the main 阅读 icon opens is marked as the default choice.
        radios = page.locator('.card-menu [role=menuitemradio][aria-checked="true"]')
        assert radios.count() == 1
        assert radios.inner_text().strip().startswith("译文")
        page.wait_for_timeout(250)
        page.screenshot(path=str(RUN / "library-result-menu.png"))
        page.locator(".card-menu [role=menuitemradio]", has_text="双语对照").click()
        page.wait_for_url("**/viewer?*")
        assert_same_file(query_param(viewer_entry_url(page), "path"), result_dual)

        # Right-click on a result card posts the primary PDF (first 译文 file).
        open_library(page)
        page.locator('#rail [data-filter="all"]').click()
        multi_card = page.locator(".lib-card", has_text="示例论文")
        multi_card.wait_for(state="visible")
        multi_card.click(button="right")
        page.locator(".card-menu").wait_for(state="visible")
        page.wait_for_timeout(250)
        page.screenshot(path=str(RUN / "library-context-menu.png"))
        assert menu_labels(page) == ["打开源文件所在位置"], menu_labels(page)
        page.locator(".card-menu [role=menuitem]").first.click()
        page.wait_for_timeout(200)
        assert opened[-1].get("path") == str(result_translation), opened

        # ===================== 3. 翻译 prepares, never starts =================
        open_library(page, "?source=zotero")
        translated_card = page.locator(".zot-card", has_text="Zotero 已翻译论文")
        translated_card.wait_for(state="visible")
        page.evaluate("localStorage.removeItem('readpi-active-job')")
        assert not errors, f"library page errors: {errors}"

        job_posts: list[str] = []
        page.on(
            "request",
            lambda request: job_posts.append(request.url)
            if request.method == "POST" and request.url.endswith("/api/jobs")
            else None,
        )
        translate = translated_card.locator('[data-zact="translate"]')
        assert translate.inner_text().strip() == "翻译"
        try:
            with page.expect_navigation(timeout=15000):
                translate.click()
        except PlaywrightTimeoutError:
            raise AssertionError(
                "翻译 did not navigate: "
                f"toasts={page.locator('#toasts').inner_text()!r} errors={errors}"
            ) from None

        # The home page really loaded that PDF and waits for 开始翻译.
        page.locator("#file-list .file-row").first.wait_for(state="visible")
        entry = page.evaluate("window.__entryUrl") or ""
        assert "?prepare=" in entry, f"expected /?prepare=..., got {entry}"
        prepared = query_param(entry, "prepare")
        assert Path(prepared).is_absolute(), prepared
        assert Path(prepared).name == "zotpaper.pdf", prepared
        assert "zotpaper.pdf" in page.locator("#file-list").inner_text()
        assert page.locator("#btn-start").is_enabled()

        job = page.request.get(base + "/api/jobs/current").json()
        assert job.get("job") is None, job
        assert not job_posts, job_posts
        assert page.evaluate("localStorage.getItem('readpi-active-job')") is None
        toasts = page.locator("#toasts").inner_text()
        assert "已开始翻译" not in toasts, toasts
        page.wait_for_timeout(500)
        assert not errors, f"page errors: {errors}"

        browser.close()
        print(
            "PASS right-click source menu, read drop-downs (original/translation/"
            f"dual + result PDFs), translate -> /?prepare= with no job: {RUN}"
        )


if __name__ == "__main__":
    try:
        main()
    finally:
        server.shutdown()
