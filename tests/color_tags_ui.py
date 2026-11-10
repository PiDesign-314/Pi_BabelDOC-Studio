"""Browser regression test: managed colour tags (颜色标签).

Run:  python tests/color_tags_ui.py        (needs playwright + msedge)

Covers the reader request for manageable colour tags:

  * 颜色标签 lists the eight default tags in palette order; clicking the dock
    action again closes the popover; renaming a tag persists across reload;
  * a custom tag (#3aa0ff / 待核) can be added, dragged to the first position
    (the tag list is a 250px scroll container, so the drag is performed with the
    same scroll-between-gestures a user needs), and both the order and the names
    survive reopening the popover and reload;
  * highlighting with the custom tag from the selection toolbar stores the hex
    colour, renders a mark in that exact colour and labels the card/notes entry
    with 待核;
  * deleting the tag keeps the annotation and its colour (mark still rendered),
    the label falls back without a JS error, and the exported markdown shows the
    fallback label;
  * deleting the palette green tag removes its toolbar dot while green marks
    stay; re-adding a green tag restores the dot without touching those marks;
  * no pageerror / console errors in the whole scenario.

State is isolated under .tmp/qa-features/; server on an ephemeral port; the
browser/server are always closed.  Screenshots and the exported markdown stay in
the run folder.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

# The progress line prints the drag handle "⋮⋮"; a GBK console cannot encode it
# and would turn a passing run into a traceback + exit 1 (seen on Windows CI).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pymupdf
from PIL import Image
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config

ROOT = Path(__file__).resolve().parents[1]
RUN = (ROOT / ".tmp" / "qa-features" / ("tags-" + uuid.uuid4().hex[:8])).resolve()
RUN.mkdir(parents=True, exist_ok=True)

config.UPLOAD_DIR = RUN
annotations.ANNOTATION_DIR = RUN / "annotations"

PDF = RUN / "colour-tags.pdf"
doc = pymupdf.open()
page = doc.new_page(width=1000, height=700)
for index, y in enumerate(range(70, 650, 26)):
    page.insert_text(
        (70, y),
        f"Colour tag source line {index + 1:02d} with sample words for highlights.",
        fontsize=14,
    )
doc.save(PDF)
doc.close()

DEFAULT_TAG_COLORS = ["yellow", "green", "blue", "pink", "orange", "purple", "teal", "red"]
DEFAULT_TAG_NAMES = ["疑问", "结论", "证据", "灵感", "待办", "定义", "方法", "重点"]
CUSTOM_COLOR = "#3aa0ff"
CUSTOM_NAME = "待核"
CUSTOM_RGB = (58, 160, 255)
GREEN_HEX = "#74dc9e"
GREEN_BAND_RGB = (174, 234, 192)

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

metrics: dict[str, object] = {}


def annotation_file() -> Path:
    return annotations.ANNOTATION_DIR / f"{annotations.document_id(PDF)}.json"


def annotation_items(pg, timeout: float = 8.0) -> list[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = json.loads(annotation_file().read_text(encoding="utf-8"))
            items = data.get("items") if isinstance(data, dict) else None
            if items:
                return items
        except (OSError, ValueError):
            pass
        pg.wait_for_timeout(120)
    return []


def find_item(pg, item_id: str, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for item in annotation_items(pg, timeout=0.2):
            if item.get("id") == item_id:
                return item
        pg.wait_for_timeout(120)
    raise AssertionError(f"annotation {item_id} was never persisted")


def prefs(pg) -> dict:
    try:
        return json.loads(pg.evaluate("() => localStorage.getItem('babeldoc-reader') || '{}'")) or {}
    except ValueError:
        return {}


def select_text_lines(pg, start: int, count: int = 3) -> None:
    pg.evaluate(
        """(args) => {
          const [start, count] = args;
          const page = document.querySelector('.r-sheet .r-page').getBoundingClientRect();
          const spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4);
          if (!spans.length) return;
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


def mark_ids(pg) -> set[str]:
    return set(pg.eval_on_selector_all(".r-mark", "els => els.map((el) => el.dataset.id)"))


def open_legend(pg) -> None:
    if pg.locator("#r-pop").is_visible():
        raise AssertionError("popover already open before open_legend")
    pg.locator('#reader-dock [data-action="legend"]').click()
    pg.wait_for_selector("#r-pop:not([hidden])")
    pg.wait_for_timeout(350)
    title = pg.inner_text("#r-pop .r-pop-title").strip()
    assert title == "颜色标签", f"legend popover title is {title!r}"


def assert_legend_fits(pg, label: str) -> dict:
    """The legend popover must show the add row and every tag row un-clipped."""
    info = pg.evaluate(
        """() => {
          const pop = document.querySelector('#r-pop');
          const list = document.querySelector('#pop-tags');
          const add = document.querySelector('.r-tag-add');
          const rows = [...document.querySelectorAll('#r-pop .r-tag-row')];
          const hints = document.querySelector('#r-pop .r-pop-check');
          const layout = document.querySelector('#r-pop .r-settings-block');
          const inViewport = (rect) =>
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth;
          const pr = pop.getBoundingClientRect();
          /* overflow:auto clips at the padding box; keep 1px for the border. */
          const clipTop = pr.top + 1;
          const clipBottom = pr.bottom - 1;
          const insidePopover = (rect) =>
            rect.top >= clipTop - 0.5 && rect.bottom <= clipBottom + 0.5;
          const lr = list.getBoundingClientRect();
          const ar = add.getBoundingClientRect();
          return {
            viewport: [window.innerWidth, window.innerHeight],
            popover: {
              top: pr.top,
              bottom: pr.bottom,
              height: pr.height,
              clientHeight: pop.clientHeight,
              scrollHeight: pop.scrollHeight,
              scrollable: pop.scrollHeight > pop.clientHeight + 1,
              inViewport: inViewport(pr),
            },
            list: {
              top: lr.top,
              bottom: lr.bottom,
              clientHeight: list.clientHeight,
              scrollHeight: list.scrollHeight,
              scrollable: list.scrollHeight > list.clientHeight + 1,
            },
            addRow: {
              top: ar.top,
              bottom: ar.bottom,
              aboveList: ar.bottom <= lr.top + 0.5,
              insidePopover: insidePopover(ar),
              visible: inViewport(ar),
            },
            hints: {
              top: hints.getBoundingClientRect().top,
              bottom: hints.getBoundingClientRect().bottom,
              insidePopover: insidePopover(hints.getBoundingClientRect()),
            },
            layoutBlock: {
              top: layout.getBoundingClientRect().top,
              bottom: layout.getBoundingClientRect().bottom,
              insidePopover: insidePopover(layout.getBoundingClientRect()),
            },
            rows: rows.map((row) => {
              const b = row.getBoundingClientRect();
              return {
                top: b.top,
                bottom: b.bottom,
                fullyVisible:
                  b.top >= lr.top - 0.5 &&
                  b.bottom <= lr.bottom + 0.5 &&
                  insidePopover(b) &&
                  inViewport(b),
              };
            }),
          };
        }"""
    )
    metrics[label] = info
    assert info["popover"]["inViewport"], f"{label}: popover is clipped by the viewport"
    assert not info["popover"]["scrollable"], (
        f"{label}: legend popover still scrolls "
        f"(clientHeight={info['popover']['clientHeight']}, "
        f"scrollHeight={info['popover']['scrollHeight']}); "
        "rows/hints/批注显示 are clipped below the fold"
    )
    assert info["addRow"]["visible"] and info["addRow"]["insidePopover"], (
        f"{label}: the 新增标签 row is clipped"
    )
    assert info["addRow"]["aboveList"], f"{label}: the 新增标签 row is not above the tag list"
    assert not info["list"]["scrollable"], (
        f"{label}: tag list still scrolls ({info['list']}) so rows are clipped"
    )
    hidden = [row for row in info["rows"] if not row["fullyVisible"]]
    assert not hidden, (
        f"{label}: {len(hidden)} tag rows are clipped "
        f"(popover bottom={info['popover']['bottom']:.1f}): {hidden}"
    )
    assert info["hints"]["insidePopover"], (
        f"{label}: the 显示功能提示 row is clipped below the popover"
    )
    assert info["layoutBlock"]["insidePopover"], (
        f"{label}: the 批注显示 block is clipped below the popover"
    )
    assert len(info["rows"]) == 9, f"{label}: expected 9 tag rows, got {len(info['rows'])}"
    return info


def close_popover(pg) -> None:
    if not pg.locator("#r-pop").is_visible():
        return
    # Click the stage gutter: the popover has no close button, and this keeps
    # the test independent of the dock toggle state.
    stage = pg.locator(".r-stage").bounding_box()
    pg.mouse.click(stage["x"] + 6, stage["y"] + 300)
    pg.wait_for_timeout(350)
    assert pg.locator("#r-pop").is_hidden(), "popover did not dismiss on an outside click"


def tag_geometry(pg) -> dict | None:
    """Tag rows with their positions inside the scrollable #pop-tags list."""
    return pg.evaluate(
        """() => {
          const list = document.querySelector('#pop-tags');
          if (!list) return null;
          const lb = list.getBoundingClientRect();
          const rows = [...document.querySelectorAll('#r-pop .r-tag-row')];
          return {
            list: {
              top: lb.top,
              bottom: lb.bottom,
              client: list.clientHeight,
              scroll: list.scrollHeight,
              scrollTop: list.scrollTop,
            },
            rows: rows.map((row, index) => {
              const b = row.getBoundingClientRect();
              const g = row.querySelector('[data-tag-grip]').getBoundingClientRect();
              return {
                index,
                color: row.dataset.tagColor,
                top: b.top,
                bottom: b.bottom,
                gripX: g.x + g.width / 2,
                gripY: g.y + g.height / 2,
                fully: b.top >= lb.top - 0.5 && b.bottom <= lb.bottom + 0.5,
              };
            }),
          };
        }"""
    )


def scroll_tag_into_view(pg, color: str) -> None:
    pg.evaluate(
        """(color) => {
          const list = document.querySelector('#pop-tags');
          const row = [...list.querySelectorAll('.r-tag-row')].find(
            (entry) => entry.dataset.tagColor === color
          );
          if (!row) return;
          const lb = list.getBoundingClientRect();
          const rb = row.getBoundingClientRect();
          if (rb.top < lb.top) list.scrollTop -= lb.top - rb.top + 2;
          else if (rb.bottom > lb.bottom) list.scrollTop += rb.bottom - lb.bottom + 2;
        }""",
        color,
    )
    pg.wait_for_timeout(250)


def drag_custom_to_first(pg) -> int:
    """Drag the custom tag to the top using real mouse drags.

    #pop-tags is a 250px scroll container (viewer.css), so with nine tags a
    user scrolls the list and drags in more than one gesture; the test does the
    same and keeps the strict "custom tag is first" assertion.  Returns the
    number of drag gestures used.
    """
    gestures = 0
    for _ in range(8):
        info = tag_geometry(pg)
        assert info, "tag list disappeared"
        custom = next((row for row in info["rows"] if row["color"] == CUSTOM_COLOR), None)
        assert custom, "custom tag row is gone"
        if custom["index"] == 0:
            return gestures
        scroll_tag_into_view(pg, CUSTOM_COLOR)
        info = tag_geometry(pg)
        custom = next(row for row in info["rows"] if row["color"] == CUSTOM_COLOR)
        list_top, list_bottom = info["list"]["top"], info["list"]["bottom"]
        assert list_top <= custom["gripY"] <= list_bottom, (
            f"custom tag grip cannot be scrolled into the visible list: {custom}"
        )
        target = None
        for row in info["rows"]:
            if row["index"] >= custom["index"]:
                break
            if row["fully"]:
                target = row
                break
        if target is None:
            pg.eval_on_selector(
                "#pop-tags",
                "el => { el.scrollTop = Math.max(0, el.scrollTop - el.clientHeight + 60); }",
            )
            pg.wait_for_timeout(300)
            continue
        pg.mouse.move(custom["gripX"], custom["gripY"])
        pg.mouse.down()
        pg.mouse.move(custom["gripX"], target["top"] + 2, steps=14)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        gestures += 1
    raise AssertionError("could not drag the custom tag to the first position")


def tag_rows(pg) -> list[dict]:
    return pg.evaluate(
        """() => [...document.querySelectorAll('#r-pop .r-tag-row')].map((row) => ({
            id: row.dataset.tagId,
            color: row.dataset.tagColor,
            name: (row.querySelector('[data-tag-name]') || {}).value || '',
            text: (row.innerText || '').trim(),
        }))"""
    )


def toolbar_dots(pg) -> list[dict]:
    return pg.evaluate(
        """() => [...document.querySelectorAll('#sel-toolbar .r-dot[data-color]')].map((dot) => ({
            color: dot.dataset.color,
            cls: String(dot.className || ''),
            title: dot.getAttribute('title') || '',
            aria: dot.getAttribute('aria-label') || '',
        }))"""
    )


def mark_style(pg, item_id: str) -> dict:
    return pg.evaluate(
        """(id) => {
          const bands = [...document.querySelectorAll('.r-mark')].filter(
            (el) => el.dataset.id === id
          );
          return {
            count: bands.length,
            background: bands.length ? getComputedStyle(bands[0]).backgroundColor : null,
            classes: bands.length ? String(bands[0].className || '') : null,
          };
        }""",
        item_id,
    )


def mark_median_rgb(pg, item_id: str, path: Path) -> tuple[float, float, float]:
    pg.locator(f'.r-mark[data-id="{item_id}"]').first.screenshot(path=str(path))
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    if rgb.shape[0] > 6 and rgb.shape[1] > 6:
        rgb = rgb[2:-2, 2:-2]
    flat = rgb.reshape(-1, 3)
    return tuple(float(value) for value in np.median(flat, axis=0))


def notes_label(pg, item_id: str) -> dict:
    """Where the notes card exposes the tag name (visible text or dot label)."""
    tab = pg.locator('#sidebar [data-tab="notes"]')
    if not tab.evaluate("el => el.classList.contains('on')"):
        tab.click()
        pg.wait_for_timeout(300)
    card = pg.locator(f'#panel-notes .r-card[data-id="{item_id}"]')
    if card.count() == 0:
        return {"exists": False}
    swatch = card.locator(".r-dotview")
    return {
        "exists": True,
        "text": card.inner_text(),
        "swatch_title": (swatch.get_attribute("title") or "") if swatch.count() else "",
        "swatch_aria": (swatch.get_attribute("aria-label") or "") if swatch.count() else "",
    }


def set_add_tag_form(pg, color: str, name: str) -> None:
    pg.evaluate(
        """(args) => {
          const [color, name] = args;
          const input = document.querySelector('#pop-tag-color');
          input.value = color;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const text = document.querySelector('#pop-tag-name');
          text.value = name;
          text.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        [color, name],
    )
    pg.wait_for_timeout(150)


def add_tag(pg, color: str, name: str) -> None:
    set_add_tag_form(pg, color, name)
    pg.locator("#pop-tag-add").click()
    pg.wait_for_timeout(500)


def delete_tag(pg, color: str) -> None:
    assert pg.locator("#r-pop").is_visible(), "legend must be open before delete_tag"
    pg.locator(f'#r-pop .r-tag-row[data-tag-color="{color}"] [data-tag-delete]').click()
    pg.wait_for_timeout(500)


def reload_reader(pg) -> None:
    pg.reload()
    pg.wait_for_selector(".r-page.painted")
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(1400)


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    errors: list[str] = []
    console_errors: list[str] = []
    network_failures: list[str] = []
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    pg.on(
        "console",
        lambda msg: console_errors.append(
            f"{msg.type}: {msg.text} [{msg.location.get('url') or '?'}]"
        )
        if msg.type == "error"
        else None,
    )
    pg.on(
        "requestfailed",
        lambda request: network_failures.append(
            f"{request.url} :: {request.failure}"
        ),
    )
    started = time.time()

    try:
        pg.goto(f"http://127.0.0.1:{server.server_port}/viewer?path=" + str(PDF))
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(900)

        # -------------------------------------------------- default tag list
        open_legend(pg)
        rows = tag_rows(pg)
        metrics["default tags"] = rows
        assert len(rows) == 8, f"default tag rows: {len(rows)}"
        assert [row["color"] for row in rows] == DEFAULT_TAG_COLORS, rows
        assert [row["name"] for row in rows] == DEFAULT_TAG_NAMES, rows
        assert len(toolbar_dots(pg)) == 8, toolbar_dots(pg)

        # ------------------------------------------------- rename + persistence
        pg.fill('#r-pop .r-tag-row[data-tag-color="yellow"] [data-tag-name]', "核对")
        pg.wait_for_timeout(400)
        assert prefs(pg)["colorTags"][0]["name"] == "核对", prefs(pg)["colorTags"][0]
        close_popover(pg)
        reload_reader(pg)
        open_legend(pg)
        renamed = tag_rows(pg)[0]
        metrics["rename after reload"] = renamed
        assert renamed["color"] == "yellow" and renamed["name"] == "核对", renamed

        # ----------------------------------------------------- add custom tag
        add_tag(pg, CUSTOM_COLOR, CUSTOM_NAME)
        rows = tag_rows(pg)
        metrics["tags after add"] = [row["color"] for row in rows]
        assert len(rows) == 9, len(rows)
        assert rows[-1]["color"] == CUSTOM_COLOR and rows[-1]["name"] == CUSTOM_NAME, rows[-1]
        assert any(dot["color"] == CUSTOM_COLOR for dot in toolbar_dots(pg)), toolbar_dots(pg)
        stored = prefs(pg)["colorTags"]
        assert stored[-1]["color"] == CUSTOM_COLOR and stored[-1]["name"] == CUSTOM_NAME, stored[-1]
        assert_legend_fits(pg, "legend fit with 9 tags")

        # ------------------------------- dock action toggles the popover closed
        dock_legend = pg.locator('#reader-dock [data-action="legend"]')
        dock_legend.click()
        pg.wait_for_timeout(400)
        assert pg.locator("#r-pop").is_hidden(), (
            "clicking 颜色标签 a second time did not close the popover"
        )
        pg.wait_for_timeout(700)
        metrics["dock toggle closes"] = not pg.locator("#r-pop").is_visible()
        assert pg.locator("#r-pop").is_hidden(), "popover reopened by itself after closing"
        dock_legend.click()
        pg.wait_for_timeout(400)
        assert pg.locator("#r-pop").is_visible(), "颜色标签 did not reopen the popover"

        # ------------------------------------------- drag the custom tag first
        gestures = drag_custom_to_first(pg)
        metrics["drag gestures"] = gestures
        assert gestures == 1, (
            f"drag-to-first needed {gestures} gestures; with the compact legend the "
            "custom row should be reachable in one drag"
        )
        rows = tag_rows(pg)
        metrics["order after drag"] = [row["color"] for row in rows]
        assert rows[0]["color"] == CUSTOM_COLOR, rows
        assert prefs(pg)["colorTags"][0]["color"] == CUSTOM_COLOR, prefs(pg)["colorTags"]

        # ------------------------------------- reopen + reload keep the order
        close_popover(pg)
        open_legend(pg)
        assert tag_rows(pg)[0]["color"] == CUSTOM_COLOR, tag_rows(pg)
        close_popover(pg)
        reload_reader(pg)
        open_legend(pg)
        rows_after_reload = tag_rows(pg)
        metrics["order after reload"] = [row["color"] for row in rows_after_reload]
        assert rows_after_reload[0]["color"] == CUSTOM_COLOR, rows_after_reload
        assert rows_after_reload[0]["name"] == CUSTOM_NAME, rows_after_reload[0]
        close_popover(pg)

        # ------------------------------------ highlight with the custom tag
        ids_before = mark_ids(pg)
        select_text_lines(pg, 2, 3)
        pg.wait_for_timeout(400)
        assert pg.locator("#sel-toolbar").is_visible(), "selection toolbar did not open"
        custom_dot = pg.locator(f'#sel-toolbar .r-dot[data-color="{CUSTOM_COLOR}"]')
        assert custom_dot.count() == 1, "custom tag dot is missing from the selection toolbar"
        custom_dot.click()
        pg.wait_for_timeout(1100)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, created
        custom_id = created.pop()
        custom_item = find_item(pg, custom_id)
        metrics["custom annotation color"] = custom_item["color"]
        assert str(custom_item["color"]).lower() == CUSTOM_COLOR, (
            f"annotation stored colour {custom_item['color']!r}, expected the tag hex {CUSTOM_COLOR}"
        )
        custom_style = mark_style(pg, custom_id)
        metrics["custom mark style"] = custom_style
        assert custom_style["count"] >= 1
        assert custom_style["background"] == "rgb(58, 160, 255)", custom_style
        median = mark_median_rgb(pg, custom_id, RUN / "tag-custom-mark.png")
        distance = float(np.linalg.norm(np.asarray(median) - np.asarray(CUSTOM_RGB)))
        metrics["custom mark median rgb"] = [round(value, 1) for value in median]
        metrics["custom mark colour distance"] = round(distance, 1)
        assert distance < 30, f"rendered mark colour {median} is not the custom hex"

        label = notes_label(pg, custom_id)
        metrics["custom card label"] = label
        assert label.get("exists"), "custom-colour annotation is missing from the notes list"
        assert (
            CUSTOM_NAME in label.get("text", "")
            or CUSTOM_NAME in label.get("swatch_title", "")
            or CUSTOM_NAME in label.get("swatch_aria", "")
        ), f"card/notes label does not show the tag name {CUSTOM_NAME}: {label}"

        # ------------------------------------------------ delete custom tag
        open_legend(pg)
        delete_tag(pg, CUSTOM_COLOR)
        rows = tag_rows(pg)
        metrics["tags after custom delete"] = [row["color"] for row in rows]
        assert len(rows) == 8 and all(row["color"] != CUSTOM_COLOR for row in rows), rows
        assert "保留原颜色" in pg.inner_text("#toasts"), pg.inner_text("#toasts")
        close_popover(pg)

        reload_reader(pg)
        open_legend(pg)
        assert all(row["name"] != CUSTOM_NAME for row in tag_rows(pg)), tag_rows(pg)
        close_popover(pg)
        kept_item = find_item(pg, custom_id)
        metrics["annotation color after tag delete"] = kept_item["color"]
        assert str(kept_item["color"]).lower() == CUSTOM_COLOR, kept_item["color"]
        kept_style = mark_style(pg, custom_id)
        metrics["mark after tag delete"] = kept_style
        assert kept_style["background"] == "rgb(58, 160, 255)", kept_style
        assert pg.locator(f'.r-mark[data-id="{custom_id}"]').count() >= 1

        # The exported markdown must carry the fallback label, not crash.
        menu_button = pg.locator("#btn-export")
        menu_button.click()
        pg.wait_for_selector("#menu:not([hidden])")
        with pg.expect_download(timeout=15000) as download_info:
            pg.locator('#menu [data-act="md"]').click()
        download = download_info.value
        md_path = RUN / "annotations-export.md"
        download.save_as(str(md_path))
        pg.wait_for_timeout(400)
        markdown = md_path.read_text(encoding="utf-8")
        metrics["export fallback label"] = CUSTOM_COLOR in markdown
        assert CUSTOM_COLOR in markdown, (
            "exported markdown lost the fallback label for the deleted tag: "
            + markdown[:400]
        )

        # ------------------------------------- palette tag: green delete / re-add
        ids_before = mark_ids(pg)
        select_text_lines(pg, 8, 3)
        pg.wait_for_timeout(400)
        pg.locator("#sel-toolbar .r-dot.green").click()
        pg.wait_for_timeout(1000)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, created
        green_id = created.pop()
        green_item = find_item(pg, green_id)
        assert green_item["color"] == "green", green_item["color"]
        green_before = mark_style(pg, green_id)
        assert green_before["background"] == "rgb(174, 234, 192)", green_before

        open_legend(pg)
        delete_tag(pg, "green")
        close_popover(pg)
        pg.wait_for_timeout(500)
        dots = toolbar_dots(pg)
        metrics["dots after green delete"] = [dot["color"] for dot in dots]
        assert not any(dot["color"] == "green" for dot in dots), dots
        assert pg.locator("#sel-toolbar .r-dot.green").count() == 0, "green dot still in toolbar"
        green_after = mark_style(pg, green_id)
        metrics["green mark after delete"] = green_after
        assert green_after["count"] > 0 and green_after["background"] == green_before["background"], (
            "green marks changed when their palette tag was deleted",
            green_after,
            green_before,
        )

        open_legend(pg)
        add_tag(pg, GREEN_HEX, "结论")
        rows = tag_rows(pg)
        metrics["tags after green re-add"] = [row["color"] for row in rows]
        green_row = [row for row in rows if row["color"] == "green"]
        assert green_row, rows
        assert green_row[0]["name"] == "结论", green_row[0]
        close_popover(pg)
        pg.wait_for_timeout(500)
        assert pg.locator("#sel-toolbar .r-dot.green").count() == 1, "green dot did not return"
        assert mark_style(pg, green_id)["background"] == green_before["background"], (
            "existing green marks changed when the tag was re-added"
        )

        # ----------------------------------------------------- reload persistence
        reload_reader(pg)
        dots = toolbar_dots(pg)
        metrics["dots after final reload"] = [dot["color"] for dot in dots]
        assert any(dot["color"] == "green" for dot in dots), dots
        assert any(dot["color"] == CUSTOM_COLOR for dot in dots) is False, (
            "deleted custom tag came back after reload"
        )
        assert pg.locator(f'.r-mark[data-id="{custom_id}"]').count() >= 1, (
            "custom-colour annotation disappeared after reload"
        )
        assert mark_style(pg, custom_id)["background"] == "rgb(58, 160, 255)", mark_style(
            pg, custom_id
        )
        assert pg.locator(f'.r-mark[data-id="{green_id}"]').count() >= 1, (
            "green annotation disappeared after reload"
        )

        metrics["js pageerrors"] = len(errors)
        metrics["console errors"] = len(console_errors)
        metrics["network failures"] = len(network_failures)
        assert not errors, f"page errors: {errors}"
        assert not console_errors, (
            f"console errors: {console_errors}; network failures: {network_failures}"
        )

        pg.screenshot(path=str(RUN / "color-tags-final.png"))
        metrics["runtime seconds"] = round(time.time() - started, 1)
        print("COLOR TAGS UI PASS")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
    except BaseException as exc:  # noqa: BLE001 - standalone script reports everything
        print("COLOR TAGS UI FAIL")
        print(f"  {''.join(traceback.format_exception_only(type(exc), exc)).strip()}")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
        try:
            pg.screenshot(path=str(RUN / "color-tags-failure.png"))
        except Exception:  # noqa: BLE001 - best-effort evidence
            pass
        raise
    finally:
        try:
            browser.close()
        finally:
            server.shutdown()
