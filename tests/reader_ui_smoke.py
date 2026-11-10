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
# Insert the two columns in separate passes so the PDF.js text layer keeps a
# reading order per column: a multi-line range then stays inside one column.
for y in range(80, 700, 25):
    page.insert_text((60, y), "Original paragraph example for selection testing.", fontsize=14)
for y in range(80, 700, 25):
    page.insert_text((660, y), "Translated paragraph example for reading.", fontsize=14)
doc.save(pdf)
doc.close()

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()


def select_reader_text(pg, start=0, count=5):
    """Select a run of ``count`` lines in the first page's source column.

    ``start`` skips a number of lines so a test can create a second highlight
    that does not overlap the first one (overlap is now merged on purpose).
    """
    pg.evaluate(
        """(args) => {
          const [start, count] = args;
          const page = document.querySelector('.r-sheet .r-page').getBoundingClientRect();
          const half = page.left + page.width * 0.48;
          const spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4 && r.left > page.left && r.left < half);
          if (!spans.length) return;
          /* PDF.js emits one span per text run (and one for trailing spaces);
             group by visual line so a window of N lines is really N lines. */
          const lines = new Map();
          for (const span of spans) {
            const key = Math.round(span.r.top);
            if (!lines.has(key)) lines.set(key, []);
            lines.get(key).push(span);
          }
          const keys = [...lines.keys()].sort((a, b) => a - b);
          const firstLine = lines.get(keys[Math.min(start, keys.length - 1)]);
          const lastLine = lines.get(keys[Math.min(start + count - 1, keys.length - 1)]);
          const first = firstLine.slice().sort((a, b) => a.r.left - b.r.left)[0];
          const last = lastLine.slice().sort((a, b) => a.r.left - b.r.left).pop();
          const range = document.createRange();
          range.setStart(first.s.firstChild, 0);
          range.setEnd(last.s.firstChild, last.s.firstChild.data.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }""",
        [start, count],
    )


def mark_ids(pg):
    return set(pg.eval_on_selector_all(".r-mark", "els => els.map((el) => el.dataset.id)"))


def assert_marks_do_not_overlap(pg, item_id, label):
    """Bands of one multi-line highlight must never stack on top of each other."""
    boxes = pg.evaluate(
        """(id) => [...document.querySelectorAll('.r-mark')]
            .filter((el) => el.dataset.id === id)
            .map((el) => {
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            })""",
        item_id,
    )
    assert len(boxes) > 1, f"{label}: expected a multi-line highlight, got {boxes}"
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            vertical = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
            horizontal = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
            assert not (vertical > 1 and horizontal > 0.5), (
                f"{label}: mark boxes overlap by {vertical:.1f}px: {a} / {b}"
            )
    return boxes


def cross_highlight_overlaps(pg):
    """Any pair of marks belonging to different annotations that overlap."""
    return pg.evaluate(
        """() => {
          const boxes = [...document.querySelectorAll('.r-mark')].map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.id, x: r.x, y: r.y, w: r.width, h: r.height };
          });
          const out = [];
          for (let i = 0; i < boxes.length; i += 1) {
            for (let j = i + 1; j < boxes.length; j += 1) {
              const a = boxes[i];
              const b = boxes[j];
              if (a.id === b.id) continue;
              const v = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
              const h = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
              if (v > 1 && h > 0.5) out.push([a.id, b.id, v, h]);
            }
          }
          return out;
        }"""
    )


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

    # an empty history must be a safe no-op, not a JS error
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(300)
    assert pg.locator(".r-mark").count() == 0
    assert "撤回" in pg.inner_text("#toasts")

    # freehand + line
    pg.locator('#reader-dock [data-tool="pen"]').click()
    pg.mouse.move(x, y)
    pg.mouse.down()
    pg.mouse.move(x + 100, y + 60, steps=12)
    pg.mouse.up()
    pg.wait_for_timeout(500)
    assert pg.locator(".r-ink path").count() == 1
    # a fresh pen stroke must use the automatic red, not the old dark grey
    assert pg.eval_on_selector(
        ".r-ink path", "el => (el.getAttribute('stroke') || '').toLowerCase()"
    ) == "#ff375f", "pen stroke is not red by default"
    pg.locator('#reader-dock [data-tool="line"]').click()
    pg.mouse.move(x + 20, y + 90)
    pg.mouse.down()
    pg.mouse.move(x + 160, y + 140, steps=4)
    pg.mouse.up()
    pg.wait_for_timeout(900)
    assert pg.locator(".r-ink path").count() == 2

    # page text edits in place: no popover window, but a formatting bar
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 120, y + 140)
    pg.wait_for_selector(".r-page-text.editing")
    assert not pg.locator("#editor").is_visible()
    assert pg.locator("#textbar").is_visible()
    pg.keyboard.type("中文批注 Hello")
    pg.locator('#textbar [data-text-color="#0a84ff"]').click()
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(700)
    assert pg.locator(".r-page-text").inner_text() == "中文批注 Hello"
    assert "10, 132, 255" in pg.eval_on_selector(".r-page-text", "el => getComputedStyle(el).color")
    assert pg.locator(".r-note").count() == 0

    # arming the note tool first must not leak into the text tool
    pg.locator('#reader-dock [data-tool="note"]').click()
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 260, y + 180)
    pg.wait_for_selector(".r-page-text.editing")
    pg.keyboard.type("第二段文字")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(700)
    assert pg.locator(".r-page-text").count() == 2
    assert pg.locator(".r-note").count() == 0

    # an empty text box removes itself instead of leaving an invisible item
    pg.locator('#reader-dock [data-tool="text"]').click()
    pg.mouse.click(x + 300, y + 220)
    pg.wait_for_selector(".r-page-text.editing")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)
    assert pg.locator(".r-page-text").count() == 2

    # note, movable
    pg.locator('#reader-dock [data-tool="note"]').click()
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

    # hide the original half of a dual page; margin cards must stay visible
    pg.locator('#reader-dock [data-action="layout"]').click()
    pg.wait_for_timeout(700)
    pg.locator('#reader-dock [data-action="original"]').click()
    assert pg.locator(".translation-only").count() == 1
    pg.wait_for_timeout(500)
    assert pg.locator(".r-mcard").count() > 0, "margin cards disappeared with original hidden"
    card_box = pg.locator(".r-mcard").first.bounding_box()
    assert card_box and card_box["x"] >= 0 and card_box["x"] < 1440, card_box
    pg.locator('#reader-dock [data-action="original"]').click()
    pg.locator('#reader-dock [data-action="layout"]').click()
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(400)

    # highlight with an explicit style, then restyle it from the editor
    pg.locator('#reader-dock [data-style="underline"]').click()
    select_reader_text(pg)
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

    # Ctrl+Z takes the newest highlight back and updates the sidebar count
    # (start further down the page: an overlapping selection is merged, tested
    # separately below)
    marks_before = pg.locator(".r-mark").count()
    count_before = pg.inner_text("#anno-count")
    select_reader_text(pg, 8)
    pg.wait_for_timeout(400)
    pg.locator("#sel-toolbar .r-dot.blue").click()
    pg.wait_for_timeout(800)
    assert pg.locator(".r-mark").count() > marks_before
    assert pg.inner_text("#anno-count") != count_before
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(900)
    assert pg.locator(".r-mark").count() == marks_before, "Ctrl+Z did not remove the highlight"
    assert pg.inner_text("#anno-count") == count_before, "sidebar count did not follow the undo"

    # Ctrl+Shift+Z redoes it, Ctrl+Z takes it back again
    pg.keyboard.press("Control+Shift+z")
    pg.wait_for_timeout(900)
    assert pg.locator(".r-mark").count() > marks_before, "Ctrl+Shift+Z did not redo the highlight"
    assert "已重做" in pg.inner_text("#toasts")
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(900)
    assert pg.locator(".r-mark").count() == marks_before
    assert pg.inner_text("#anno-count") == count_before

    # ---- selection style buttons apply immediately, with the remembered colour
    ids_before = mark_ids(pg)
    select_reader_text(pg, 5, 4)
    pg.wait_for_timeout(400)
    assert pg.locator("#sel-toolbar").is_visible()
    pg.locator('#sel-styles [data-style="wavy"]').click()
    pg.wait_for_timeout(800)
    new_ids = mark_ids(pg) - ids_before
    assert len(new_ids) == 1, new_ids
    style_id = new_ids.pop()
    assert not pg.locator("#sel-toolbar").is_visible(), "toolbar stayed open after applying a style"
    assert "已标记所选文字" in pg.inner_text("#toasts")
    assert pg.eval_on_selector_all(
        f'.r-mark[data-id="{style_id}"]', "els => els.every((e) => e.dataset.style === 'wavy')"
    ), "the clicked style was not applied to the new highlight"
    # the last colour dot clicked above was blue; no colour needed this time
    assert pg.eval_on_selector_all(
        f'.r-mark[data-id="{style_id}"]', "els => els.every((e) => e.classList.contains('blue'))"
    ), "style click did not use the remembered highlight colour"
    assert pg.evaluate(
        "() => JSON.parse(localStorage.getItem('babeldoc-reader')).highlightColor"
    ) == "blue"
    assert_marks_do_not_overlap(pg, style_id, "style-click highlight")

    # ---- hand-drawn underline: one toolbar entry, preset chosen in the editor
    ids_before = mark_ids(pg)
    select_reader_text(pg, 18, 3)
    pg.wait_for_timeout(400)
    # Only one hand entry is visible now; the three presets are not parallel
    # toolbar buttons any more.
    assert pg.locator('#sel-styles [data-style="hand"]').count() == 1, "missing single hand style button"
    assert pg.locator('#sel-styles [data-style="hand-soft"]').count() == 0
    assert pg.locator('#sel-styles [data-style="hand-strong"]').count() == 0
    assert pg.locator('#sel-styles [data-style="hand"]').get_attribute("data-family") == "hand"
    pg.locator('#sel-styles [data-style="hand"]').click()
    pg.wait_for_timeout(900)
    hand_ids = mark_ids(pg) - ids_before
    assert len(hand_ids) == 1, hand_ids
    hand_id = hand_ids.pop()
    assert pg.locator(
        f'.r-mark[data-id="{hand_id}"][data-family="hand"] svg.hand-underline path.hand-underline-ink'
    ).count() >= 1, "hand underline did not render an SVG path"
    # a hand mark must be a transparent band + SVG ink, never a filled highlighter
    assert pg.eval_on_selector(
        f'.r-mark[data-id="{hand_id}"]', "el => getComputedStyle(el).backgroundColor"
    ) in ("rgba(0, 0, 0, 0)", "transparent"), "hand mark painted a filled band"
    # choose the 明显 preset through the editor chips (the single hand button
    # applies the remembered preset; the chips live next to the editor styles)
    hand_mark = pg.locator(f'.r-mark[data-id="{hand_id}"]').first.bounding_box()
    pg.mouse.click(hand_mark["x"] + 14, hand_mark["y"] + hand_mark["height"] / 2)
    pg.wait_for_timeout(500)
    assert pg.locator("#editor").is_visible(), "clicking the hand mark did not open the editor"
    assert pg.locator("#editor-hand-presets").is_visible(), "hand preset chips are not shown for a hand mark"
    pg.locator('#editor-hand-presets [data-hand-preset="hand-strong"]').click()
    pg.wait_for_timeout(900)
    assert pg.eval_on_selector_all(
        f'.r-mark[data-id="{hand_id}"]', "els => els.every((e) => e.dataset.style === 'hand-strong')"
    ), "editor preset chip did not restyle the hand highlight"
    assert pg.evaluate(
        "() => JSON.parse(localStorage.getItem('babeldoc-reader')).handStyle"
    ) == "hand-strong", "hand preset was not persisted"
    assert pg.locator(
        f'.r-mark[data-id="{hand_id}"][data-style="hand-strong"] svg.hand-underline path.hand-underline-ink'
    ).count() >= 1, "hand underline lost its SVG path after the preset change"
    first_d = pg.eval_on_selector(
        f'.r-mark[data-id="{hand_id}"] path.hand-underline-ink', "el => el.getAttribute('d')"
    )
    assert first_d and first_d.startswith("M "), first_d
    # Repainting the page keeps exactly the same deterministic stroke.
    pg.evaluate("window.dispatchEvent(new Event('resize'))")
    pg.wait_for_timeout(900)
    same_d = pg.eval_on_selector(
        f'.r-mark[data-id="{hand_id}"] path.hand-underline-ink', "el => el.getAttribute('d')"
    )
    assert same_d == first_d, "hand-drawn underline was regenerated on repaint"
    pg.locator("#editor-done").click()
    pg.wait_for_timeout(400)

    # ---- a new highlight trims an older overlapping one instead of stacking
    ids_before = mark_ids(pg)
    anno_before = pg.inner_text("#anno-count")
    select_reader_text(pg, 12, 5)
    pg.wait_for_timeout(400)
    pg.locator("#sel-toolbar .r-dot.orange").click()
    pg.wait_for_timeout(900)
    outer_ids = mark_ids(pg) - ids_before
    assert len(outer_ids) == 1, outer_ids
    outer_id = outer_ids.pop()
    outer_bands = pg.locator(f'.r-mark[data-id="{outer_id}"]').count()
    assert outer_bands >= 4, outer_bands
    assert_marks_do_not_overlap(pg, outer_id, "outer highlight")

    select_reader_text(pg, 14, 2)  # strictly inside the highlight above
    pg.wait_for_timeout(400)
    pg.locator("#sel-toolbar .r-dot.blue").click()
    pg.wait_for_timeout(900)
    assert "已合并重叠高亮" in pg.inner_text("#toasts")
    trimmed = pg.locator(f'.r-mark[data-id="{outer_id}"]').count()
    assert trimmed < outer_bands, (trimmed, outer_bands, "inside highlight did not trim the outer one")
    assert pg.inner_text("#anno-count") != anno_before
    assert not cross_highlight_overlaps(pg), cross_highlight_overlaps(pg)
    inner_id = (mark_ids(pg) - ids_before - {outer_id}).pop()
    assert_marks_do_not_overlap(pg, inner_id, "inner highlight")

    # one Ctrl+Z restores the outer highlight and drops the inner one
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(900)
    assert pg.locator(f'.r-mark[data-id="{outer_id}"]').count() == outer_bands, "undo did not restore the trimmed highlight"
    assert inner_id not in mark_ids(pg)

    # ---- highlighting exactly the same words replaces, not duplicates
    select_reader_text(pg, 12, 5)
    pg.wait_for_timeout(400)
    pg.locator("#sel-toolbar .r-dot.green").click()
    pg.wait_for_timeout(900)
    assert "已合并重叠高亮" in pg.inner_text("#toasts")
    assert outer_id not in mark_ids(pg), "fully covered highlight was stacked instead of replaced"
    assert not cross_highlight_overlaps(pg)
    replacement = mark_ids(pg) - ids_before
    assert len(replacement) == 1, replacement
    green_id = replacement.pop()
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(900)
    assert green_id not in mark_ids(pg)
    assert outer_id in mark_ids(pg), "undo did not bring the replaced highlight back"

    # ---- note badges sit in the page margin, not on the following text
    mark_box = pg.locator(f'.r-mark[data-id="{outer_id}"]').first.bounding_box()
    # click near the start of the band: the centre of a wide line can land on a
    # page-text annotation that was placed there by an earlier step
    pg.mouse.click(mark_box["x"] + 14, mark_box["y"] + mark_box["height"] / 2)
    pg.wait_for_timeout(400)
    assert pg.locator("#editor").is_visible()
    pg.locator("#editor-text").fill("页边批注")
    pg.locator("#editor-done").click()
    pg.wait_for_timeout(800)
    assert pg.locator(".r-note-badge").count() == 1
    badge_box = pg.locator(".r-note-badge").bounding_box()
    page_box = pg.locator(".r-sheet .r-page").first.bounding_box()
    assert badge_box["x"] >= page_box["x"] - 1, (badge_box, page_box)
    assert badge_box["x"] + badge_box["width"] <= page_box["x"] + page_box["width"] + 1
    assert badge_box["x"] + badge_box["width"] < mark_box["x"] + 1, (
        "note badge still covers the highlighted text",
        badge_box,
        mark_box,
    )
    # hover preview and click still work from the new position
    badge = pg.locator(".r-note-badge")
    badge.hover()
    pg.wait_for_timeout(400)
    assert pg.locator("#tip").is_visible()
    pg.mouse.click(badge_box["x"] + badge_box["width"] / 2, badge_box["y"] + badge_box["height"] / 2)
    pg.wait_for_timeout(400)
    assert pg.locator("#editor").is_visible(), "badge click no longer opens the annotation"
    assert pg.locator("#editor-text").input_value() == "页边批注"
    pg.locator("#editor-close").click()
    pg.wait_for_timeout(300)

    # ---- sidebar collapse: edge handle + floating expand tab + persisted state
    assert pg.locator("#sidebar").is_visible()
    assert pg.locator("#side-expand").is_hidden()
    pg.locator("#side-handle").click()
    pg.wait_for_timeout(500)
    assert not pg.locator("#sidebar").is_visible(), "sidebar handle did not collapse the sidebar"
    assert pg.locator("#side-expand").is_visible(), "no floating expand tab after collapsing"
    assert pg.get_attribute("#btn-sidebar", "aria-pressed") == "false"
    assert pg.evaluate(
        "() => JSON.parse(localStorage.getItem('babeldoc-reader')).sidebarHidden === true"
    ), "collapsed state was not persisted"
    pg.locator("#side-expand").click()
    pg.wait_for_timeout(500)
    assert pg.locator("#sidebar").is_visible()
    assert pg.locator("#side-expand").is_hidden()

    # the resize strip still works next to the new collapse tab
    width_before = pg.eval_on_selector("#sidebar", "el => el.getBoundingClientRect().width")
    strip = pg.locator("#side-resize").bounding_box()
    pg.mouse.move(strip["x"] + 2, strip["y"] + 200)
    pg.mouse.down()
    pg.mouse.move(strip["x"] + 60, strip["y"] + 200, steps=6)
    pg.mouse.up()
    pg.wait_for_timeout(500)
    width_after = pg.eval_on_selector("#sidebar", "el => el.getBoundingClientRect().width")
    assert width_after > width_before + 20, (width_before, width_after)
    pg.locator("#side-resize").dblclick(position={"x": 2, "y": 200})
    pg.wait_for_timeout(500)
    assert abs(pg.eval_on_selector("#sidebar", "el => el.getBoundingClientRect().width") - 178) < 2

    # ---- a left-column annotation gets a mirrored left rail and gutter
    pg.locator('#reader-dock [data-action="layout"]').click()
    pg.wait_for_timeout(900)
    body_class = pg.get_attribute("body", "class") or ""
    assert "margin-notes" in body_class
    assert "margin-left" in body_class, "no left-margin body state for a left-side card"
    assert pg.locator(".r-margin-left .r-mcard").count() > 0, "left-side cards are not in a left rail"
    page_box = pg.locator(".r-sheet .r-page").first.bounding_box()
    left_card = pg.locator(".r-margin-left .r-mcard").first.bounding_box()
    assert left_card["x"] + left_card["width"] <= page_box["x"] + 1, (left_card, page_box)
    padding_left = pg.eval_on_selector(".r-scroll", "el => getComputedStyle(el).paddingLeft")
    assert float(padding_left.replace("px", "")) > 100, padding_left
    pg.locator('#reader-dock [data-action="layout"]').click()
    pg.wait_for_timeout(700)

    # paper theme from the dock popover
    pg.locator('#reader-dock [data-action="paper"]').click()
    pg.locator('#r-pop [data-paper="ink"]').click()
    pg.wait_for_timeout(300)
    assert pg.eval_on_selector("body", "b => b.dataset.paper") == "ink"
    pg.locator('#reader-dock [data-action="paper"]').click()

    # colour tags popover (formerly “颜色含义”)
    pg.locator('#reader-dock [data-action="legend"]').click()
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
    pg.locator('#reader-dock [data-action="legend"]').click()

    pg.screenshot(path=str(root / "reader.png"))

    # everything survives a reload
    pg.reload()
    pg.wait_for_selector(".r-page.painted")
    pg.wait_for_timeout(1600)
    assert pg.locator(".r-ink path").count() == 2
    assert pg.locator(".r-page-text").count() == 2
    assert pg.locator(".r-page-text").filter(has_text="中文批注 Hello").count() == 1
    assert pg.locator(".r-mark").count() > 0

    # right-click tool menu + eraser (the reader restores the scroll position,
    # so measure the page again instead of reusing the pre-reload box)
    fresh = pg.locator(".r-sheet .r-page").first.bounding_box()
    x, y = fresh["x"] + 200, fresh["y"] + 200
    pg.mouse.click(x + 420, y + 600, button="right")
    assert pg.locator("#menu").is_visible()
    pg.locator("#menu button").filter(has_text="选择 / 移动").click()
    pg.locator('#reader-dock [data-tool="erase"]').click()
    pg.mouse.click(x + 50, y + 30)
    pg.wait_for_timeout(600)
    assert pg.locator(".r-ink path").count() == 1
    pg.locator('#reader-dock [data-tool="select"]').click()

    assert not errors, errors
    pg.screenshot(path=str(root / "reader-final.png"))
    print(
        "READER UI PASS: dock tools, styles, paper, legend, text, notes, "
        "style-click applies, overlap merge, sidebar collapse, margin rails; no JS errors"
    )
    browser.close()
server.shutdown()
