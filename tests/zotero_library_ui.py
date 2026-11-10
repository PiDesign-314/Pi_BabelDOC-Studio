"""Browser smoke test for the Zotero folder tree and paper actions.

Run: python tests/zotero_library_ui.py
"""
from __future__ import annotations

import sys
import threading
import uuid
from pathlib import Path

import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from core import config, library


ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / ".tmp" / "zotero-library-ui" / uuid.uuid4().hex[:8]
RUN.mkdir(parents=True, exist_ok=True)
config.APP_DIR = RUN / "appdata"
config.UPLOAD_DIR = RUN / "uploads"
config.DEFAULTS["output_dir"] = str(RUN / "output")
library.watched_dirs = lambda: [str(RUN / "output")]
(RUN / "output").mkdir(parents=True, exist_ok=True)

pdf = RUN / "zotero" / "paper.pdf"
pdf.parent.mkdir(parents=True, exist_ok=True)
doc = pymupdf.open()
doc.new_page().insert_text((72, 90), "Zotero paper")
doc.save(pdf)
doc.close()

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"


def main() -> None:
    body = {
        "schema": 1,
        "zotero_version": "10.0.8",
        "libraries": [{"id": 1, "name": "我的文库"}],
        "collections": [
            {"id": 7, "library_id": 1, "name": "机器人", "parent_id": 0},
            {"id": 8, "library_id": 1, "name": "社交", "parent_id": 7},
        ],
        "items": [{
            "key": "ITEM0001", "library_id": 1, "title": "机器人交互研究",
            "creators": "Alice Example", "year": "2024", "collections": [8],
            "attachments": [{"key": "PDF00001", "path": str(pdf), "filename": pdf.name}],
        }],
    }
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        response = page.request.post(base + "/api/zotero/library", data=body)
        assert response.status == 200, response.text()
        page.goto(base + "/library?source=zotero", wait_until="networkidle")
        page.locator("#zotero-block").wait_for(state="visible")
        page.locator(".zot-card").wait_for(state="visible")
        assert page.locator("#zotero-tree .zot-coll").count() == 2
        assert page.locator(".zot-card .lib-name").inner_text() == "机器人交互研究"
        assert "未翻译" in page.locator(".zot-card").inner_text()
        assert page.locator(".zot-card img").count() == 1
        light = RUN / "zotero-library-light.png"
        page.screenshot(path=str(light), full_page=True)

        page.locator('#zotero-tree [data-zfilter="7"]').click()
        assert page.locator(".zot-card").count() == 1
        page.locator("#search").fill("不存在的论文")
        page.wait_for_timeout(400)
        assert page.locator(".zot-card").count() == 0
        page.locator("#search").fill("")
        page.wait_for_timeout(400)
        page.locator("#btn-theme").click()
        page.locator("#btn-theme").click()
        dark = RUN / "zotero-library-dark.png"
        page.screenshot(path=str(dark), full_page=True)

        page.locator('.zot-card .zot-actions [data-zact="read"]').click()
        page.wait_for_url("**/viewer?*")
        page.locator("#back-link").click()
        page.wait_for_url(base + "/library")
        assert page.locator('#zotero-tree [data-zfilter="7"]').get_attribute("aria-pressed") == "true"
        assert page.locator("#lib-title").inner_text() == "机器人"
        assert page.locator(".zot-card").count() == 1

        status = {"value": "running", "id": "job-ui"}
        def job_status(route):
            state = status["value"]
            route.fulfill(status=200, content_type="application/json", body=(
                '{"job":{"id":"' + status["id"] + '","status":"' + state + '",'
                '"stage":"正在排版","progress":58,"files":["paper.pdf"],'
                '"finished_at":' + ("0" if state == "running" else str(__import__("time").time())) + '}}'
            ))
        page.route("**/api/jobs/current", job_status)
        page.reload()
        page.locator(".job-monitor").wait_for(state="visible")
        assert "58%" in page.locator(".job-monitor").inner_text()
        assert page.locator(".job-monitor-link").get_attribute("href") == "/?job=job-ui"
        status["value"] = "succeeded"
        page.locator(".job-complete-dialog").wait_for(state="visible", timeout=8000)
        assert "blur(" in page.locator(".job-complete-dialog").evaluate(
            "el => getComputedStyle(el).backdropFilter"
        )
        page.locator("[data-close]").click()
        status.update(value="running", id="job-ui-reader")
        page.locator('.zot-card .zot-actions [data-zact="read"]').click()
        page.wait_for_url("**/viewer?*")
        page.locator(".job-monitor").wait_for(state="visible")
        status["value"] = "succeeded"
        page.locator(".job-complete-dialog").wait_for(state="visible", timeout=8000)
        page.locator("[data-close]").click()
        page.locator("#back-link").click()
        page.wait_for_url(base + "/library")
        page.unroute("**/api/jobs/current", job_status)

        requests: list[dict] = []
        prepare_url = "/?prepare=" + __import__("urllib.parse", fromlist=["quote"]).quote(
            str(pdf), safe=""
        )

        def capture(route):
            requests.append(route.request.post_data_json)
            route.fulfill(
                status=200,
                content_type="application/json",
                body='{"ok":true,"mode":"prepare","url":"' + prepare_url + '"}',
            )

        page.route("**/api/zotero/open", capture)
        page.locator('.zot-card [data-zact="translate"]').click()
        page.wait_for_url(base + "/?prepare=*")
        # The library only prepares the document: the translation page must be
        # loaded with the PDF selected and no job started.
        page.wait_for_selector("#file-list .file-row", state="visible")
        assert "paper.pdf" in page.locator("#file-list").inner_text()
        assert page.locator("#btn-start").is_visible()
        assert not page.locator("#progress-block").is_visible()
        assert requests and requests[0]["mode"] == "prepare", requests
        assert requests[0]["attachment_key"] == "PDF00001", requests
        assert "job" not in requests[0], requests
        current = page.request.get(base + "/api/jobs/current").json()
        assert current.get("job") is None, current
        assert not errors, errors
        browser.close()
        print(f"PASS Zotero tree, paper card, search, translate action, light/dark screenshots: {RUN}")


if __name__ == "__main__":
    try:
        main()
    finally:
        server.shutdown()
