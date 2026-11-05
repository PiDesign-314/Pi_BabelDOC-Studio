"""Browser smoke test for the reader: dock tools, styles, paper themes, notes.

Run:  python tests/reader_ui_smoke.py        (needs playwright + msedge)
"""

import sys
import threading
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config

root = Path(".tmp/ui-reader-" + uuid.uuid4().hex[:6]).resolve()
root.mkdir(exist_ok=True)
config.UPLOAD_DIR = root
annotations.ANNOTATION_DIR = root / "annotations"
pdf = root / "dual.pdf"
doc = pymupdf.open()
page = doc.new_page(width=1200, height=800)
for y in range(80, 700, 25):
    page.insert_text((60, y), "Original paragraph example for selection testing.", fontsize=14)
    page.insert_text((660, y), "Translated paragraph example for reading.", fontsize=14)
doc.save(pdf)
doc.close()

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    pg.goto(f"http://127.0.0.1:{server.server_port}/viewer?path=" + str(pdf))
    pg.wait_for_selector(".r-page.painted")
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(900)

    box = pg.locator(".r-sheet .r-page").bounding_box()
    x, y = box["x"] + 200, box["y"] + 200

    # freehand + line
    pg.locator('#reader-dock [data-tool="pen"]').click()
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(x + 100, y + 60, steps=12)
    pg.mouse.up()
    pg.wait_for_timeout(500)
    assert pg.locator(".r-ink path").count() == 1
    pg.locator('#reader-dock [data-tool="line"]').click()
    pg.mouse.move(x + 20, y + 90)
    pg.mouse.down()
    pg.mouse.move(x + 160, y + 140, steps=4)
    pg.mouse.up()
    pg.wait_for_timeout(900)
    assert pg.locator(".r-ink path").count() == 2

    # page text (must not fall back to a sticky note)
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 120, y + 140)
    pg.locator("#editor-text").fill("中文批注 Hello")
    pg.locator("#editor-done").click()
    pg.wait_for_timeout(700)
    assert pg.locator(".r-page-text").inner_text() == "中文批注 Hello"
    assert pg.locator(".r-note").count() == 0

    # arming the note tool first must not leak into the text tool
    pg.locator("#btn-note-tool").click()
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 260, y + 180)
    pg.wait_for_timeout(300)
    pg.locator("#editor-text").fill("第二段文字")
    pg.locator("#editor-done").click()
    pg.wait_for_timeout(600)
    assert pg.locator(".r-page-text").count() == 2
    assert pg.locator(".r-note").count() == 0

    # an empty text box removes itself instead of leaving an invisible item
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 300, y + 220)
    pg.wait_for_timeout(300)
    pg.locator("#editor-done").click()
    pg.wait_for_timeout(400)
    assert pg.locator(".r-page-text").count() == 2

    # note, movable
    pg.locator("#btn-note-tool").click()
    pg.mouse.click(x + 20, y + 250)
    pg.locator("#editor-text").fill("Movable note")
    pg.locator("#editor-done").click()
    note = pg.locator(".r-note")
    old = note.bounding_box()
    pg.mouse.move(old["x"] + 9, old["y"] + 9)
    pg.mouse.down()
    pg.mouse.move(old["x"] + 80, old["y"] + 50, steps=5)
    pg.mouse.up()
    pg.wait_for_timeout(700)
    new = note.bounding_box()
    assert new["x"] > old["x"] + 40

    # hide the original half of a dual page
    pg.locator("#toggle-original").click()
    assert pg.locator(".translation-only").count() == 1
    pg.locator("#toggle-original").click()
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(400)

    # highlight with an explicit style, then restyle it from the editor
    pg.locator('#reader-dock [data-style="underline"]').click()
    pg.evaluate(
        """() => {
          const page = document.querySelector('.r-sheet .r-page').getBoundingClientRect();
          const half = page.left + page.width * 0.48;
          let spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4 && r.top > page.top + 60 && r.top < page.top + 200 && r.left > page.left && r.left < half)
            .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
          if (spans.length < 3) {
            spans = [...document.querySelectorAll('.r-sheet .r-text span')]
              .map((s) => ({ s, r: s.getBoundingClientRect() }))
              .filter(({ r }) => r.width > 4 && r.left > page.left && r.left < half)
              .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left);
          }
          const first = spans[0].s.firstChild;
          const last = spans[Math.min(4, spans.length - 1)];
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(last.s.firstChild, last.s.firstChild.data.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }"""
    )
    pg.wait_for_timeout(400)
    pg.locator("#sel-toolbar .r-dot.yellow").click()
    pg.wait_for_timeout(800)
    assert pg.locator(".r-mark").count() > 0
    assert pg.eval_on_selector_all(".r-mark", "els => els.every((e) => e.dataset.style === 'underline')")
    mark = pg.locator(".r-mark").first.bounding_box()
    pg.mouse.click(mark["x"] + mark["width"] / 2, mark["y"] + mark["height"] / 2)
    pg.wait_for_timeout(400)
    assert pg.locator("#editor-styles").is_visible()
    pg.locator('#editor-styles [data-style="pencil"]').click()
    pg.wait_for_timeout(800)
    assert pg.eval_on_selector_all(".r-mark", "els => els.every((e) => e.dataset.style === 'pencil')")
    pg.locator("#editor-done").click()

    # paper theme from the dock popover
    pg.locator("#dock-paper").click()
    pg.locator('#r-pop [data-paper="ink"]').click()
    pg.wait_for_timeout(300)
    assert pg.eval_on_selector("body", "b => b.dataset.paper") == "ink"
    pg.locator("#dock-paper").click()

    # colour tags popover (formerly “颜色含义”)
    pg.locator("#dock-legend").click()
    pg.wait_for_timeout(250)
    assert "颜色标签" in pg.inner_text("#r-pop .r-pop-title")
    assert pg.evaluate(
        """() => {
          const box = document.querySelector('#r-pop').getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + 20, box.top + 20);
          return !!hit && !!hit.closest('#r-pop');
        }"""
    )
    pg.locator('#r-pop [data-legend="yellow"]').fill("核对")
    pg.wait_for_timeout(200)
    assert "核对" in pg.get_attribute("#sel-toolbar .r-dot.yellow", "title")
    pg.locator("#dock-legend").click()

    pg.screenshot(path=str(root / "reader.png"))

    # everything survives a reload
    pg.reload()
    pg.wait_for_selector(".r-page.painted")
    pg.wait_for_timeout(1600)
    assert pg.locator(".r-ink path").count() == 2
    assert pg.locator(".r-page-text").count() == 2
    assert pg.locator(".r-page-text").filter(has_text="中文批注 Hello").count() == 1
    assert pg.locator(".r-mark").count() > 0

    # right-click tool menu + eraser
    pg.mouse.click(x, y, button="right")
    assert pg.locator("#menu").is_visible()
    pg.locator("#menu button").filter(has_text="选择 / 移动").click()
    pg.locator('#reader-dock [data-tool="erase"]').click()
    pg.mouse.click(x + 50, y + 30)
    pg.wait_for_timeout(600)
    assert pg.locator(".r-ink path").count() == 1
    pg.locator('#reader-dock [data-tool="select"]').click()

    assert not errors, errors
    pg.screenshot(path=str(root / "reader-final.png"))
    print("READER UI PASS: dock tools, styles, paper, legend, text, notes; no JS errors")
    browser.close()
server.shutdown()
