"""Browser regression test: one consolidated hand-underline style tool.

Run:  python tests/style_tools_ui.py        (needs playwright + msedge)

Covers the reader requests around hand-drawn underlines:

  * the selection toolbar and the annotation editor expose exactly the six
    visible styles marker / crayon / hand / underline / pencil / wavy, and the
    dock has a single hand item whose label carries no variant suffix;
  * clicking the hand entry stores a hand style and renders an SVG underline
    (transparent band background), never a filled colour band;
  * the 轻微 / 自然 / 明显 presets live in the annotation editor chips and the
    dock settings row, change the stored style, are remembered across reload
    and drive the next colour-dot highlight;
  * every entry point (selection toolbar, dock hand + colour dot, right-click
    "标记所选文字" menu, editor restyle, merge-over-existing-highlight) lands on
    the same visual family;
  * the generated SVG path is identical across a forced repaint (resize).

State is isolated: UPLOAD_DIR and ANNOTATION_DIR both live under
.tmp/qa-features/, the server uses an ephemeral port and the browser/server are
always closed.  Screenshots and the generated PDF stay in that run folder.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config

ROOT = Path(__file__).resolve().parents[1]
RUN = (ROOT / ".tmp" / "qa-features" / ("style-" + uuid.uuid4().hex[:8])).resolve()
RUN.mkdir(parents=True, exist_ok=True)

# Isolate all persistent state BEFORE the server is created.
config.UPLOAD_DIR = RUN
annotations.ANNOTATION_DIR = RUN / "annotations"

PDF = RUN / "dual.pdf"
doc = pymupdf.open()
page = doc.new_page(width=1200, height=800)
# Two text columns in separate passes so the PDF.js text layer keeps a reading
# order per column (same fixture as tests/reader_ui_smoke.py).
for y in range(80, 700, 25):
    page.insert_text((60, y), "Original paragraph example for selection testing.", fontsize=14)
for y in range(80, 700, 25):
    page.insert_text((660, y), "Translated paragraph example for reading.", fontsize=14)
doc.save(PDF)
doc.close()

EXPECTED_STYLES = ["marker", "crayon", "hand", "underline", "pencil", "wavy"]
HAND_STYLES = {"hand", "hand-soft", "hand-natural", "hand-strong"}
PRESET_WORDS = ("轻微", "自然", "明显")

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

failures: list[str] = []
metrics: dict[str, object] = {}


def annotation_file() -> Path:
    return annotations.ANNOTATION_DIR / f"{annotations.document_id(PDF)}.json"


def annotation_items() -> list[dict]:
    try:
        data = json.loads(annotation_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("items") if isinstance(data, dict) else None
    return items if isinstance(items, list) else []


def wait_item(pg, item_id: str, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for item in annotation_items():
            if item.get("id") == item_id:
                return item
        pg.wait_for_timeout(120)
    raise AssertionError(f"annotation {item_id} was never written to {annotation_file()}")


def select_reader_text(pg, start: int = 0, count: int = 5) -> None:
    """Select a run of ``count`` visual lines in the first page's left column."""
    pg.evaluate(
        """(args) => {
          const [start, count] = args;
          const page = document.querySelector('.r-sheet .r-page').getBoundingClientRect();
          const half = page.left + page.width * 0.48;
          const spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4 && r.left > page.left && r.left < half);
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


def style_ids(pg, scope: str) -> list[str]:
    return pg.eval_on_selector_all(
        f"{scope} button[data-style]", "els => els.map((el) => el.dataset.style)"
    )


def prefs(pg) -> dict:
    try:
        return json.loads(pg.evaluate("() => localStorage.getItem('babeldoc-reader') || '{}'")) or {}
    except ValueError:
        return {}


def hand_family(pg, item_id: str, label: str) -> list[dict]:
    """Every band of the annotation must be a transparent SVG hand underline."""
    bands = pg.evaluate(
        """(id) => [...document.querySelectorAll('.r-mark')]
            .filter((el) => el.dataset.id === id)
            .map((el) => {
              const cs = getComputedStyle(el);
              return {
                style: el.dataset.style || '',
                background: cs.backgroundColor,
                backgroundImage: cs.backgroundImage,
                svg: el.querySelectorAll('svg.hand-underline').length,
                ink: [...el.querySelectorAll('path.hand-underline-ink')]
                  .map((p) => p.getAttribute('d') || ''),
              };
            })""",
        item_id,
    )
    assert bands, f"{label}: no .r-mark rendered for {item_id}"
    styles = {band["style"] for band in bands}
    assert styles <= HAND_STYLES, f"{label}: non-hand data-style {styles}"
    for index, band in enumerate(bands):
        assert band["background"] in ("rgba(0, 0, 0, 0)", "transparent"), (
            f"{label}: band {index} still paints a filled colour band ({band['background']})"
        )
        assert band["backgroundImage"] == "none", (
            f"{label}: band {index} still has a painted background image "
            f"({band['backgroundImage']})"
        )
        assert band["svg"] >= 1, f"{label}: band {index} has no svg.hand-underline"
        assert band["ink"], f"{label}: band {index} has no path.hand-underline-ink"
        path_d = band["ink"][0]
        assert path_d.startswith("M ") and " C " in path_d, (
            f"{label}: band {index} path is not a hand-drawn curve ({path_d[:40]!r})"
        )
    return bands


def chip_state(pg, scope: str, label: str) -> dict | None:
    """Locate a preset chip by visible text inside ``scope`` and report state."""
    return pg.evaluate(
        """([scope, label]) => {
          const root = document.querySelector(scope);
          if (!root) return null;
          const nodes = [...root.querySelectorAll('button, [role="button"], label')];
          for (const node of nodes) {
            const text = (node.innerText || node.textContent || '').trim();
            if (!text || text.length > 6 || !text.startsWith(label)) continue;
            const input = node.querySelector('input');
            const active =
              node.classList.contains('on') ||
              node.classList.contains('active') ||
              node.classList.contains('is-on') ||
              node.classList.contains('selected') ||
              node.getAttribute('aria-pressed') === 'true' ||
              node.dataset.active === 'true' ||
              (input ? Boolean(input.checked) : false);
            return { text, active, cls: String(node.className || '') };
          }
          return null;
        }""",
        [scope, label],
    )


def click_chip(pg, scope: str, label: str) -> dict:
    result = pg.evaluate(
        """([scope, label]) => {
          const root = document.querySelector(scope);
          if (!root) return null;
          const nodes = [...root.querySelectorAll('button, [role="button"], label')];
          for (const node of nodes) {
            const text = (node.innerText || node.textContent || '').trim();
            if (!text || text.length > 6 || !text.startsWith(label)) continue;
            node.click();
            return { text, cls: String(node.className || '') };
          }
          return null;
        }""",
        [scope, label],
    )
    assert result, f"{label}: no preset chip inside {scope}"
    return result


def close_popover(pg) -> None:
    """Dismiss #r-pop by clicking the stage gutter outside the page/popover."""
    stage = pg.locator(".r-stage").bounding_box()
    pg.mouse.click(stage["x"] + 6, stage["y"] + 300)
    pg.wait_for_timeout(350)
    assert pg.locator("#r-pop").is_hidden(), "popover did not dismiss on an outside click"


def describe_pre_failure(exc: BaseException) -> str:
    return "".join(traceback.format_exception_only(type(exc), exc)).strip()


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    console_errors: list[str] = []
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    pg.on(
        "console",
        lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
    )
    started = time.time()

    try:
        pg.goto(f"http://127.0.0.1:{server.server_port}/viewer?path=" + str(PDF))
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(900)

        # ---------------------------------------------------------- the 6 styles
        sel_styles = style_ids(pg, "#sel-styles")
        editor_styles = style_ids(pg, "#editor-styles")
        metrics["selection toolbar styles"] = sel_styles
        metrics["editor styles"] = editor_styles
        assert sel_styles == EXPECTED_STYLES, (
            "selection toolbar must show exactly the six visible styles "
            f"{EXPECTED_STYLES}, got {sel_styles}"
        )
        assert editor_styles == EXPECTED_STYLES, (
            f"annotation editor must show exactly {EXPECTED_STYLES}, got {editor_styles}"
        )
        for scope in ("#sel-styles", "#editor-styles"):
            assert pg.locator(f'{scope} [data-style="hand-soft"]').count() == 0, (
                f"{scope} still has a parallel hand-soft button"
            )
            assert pg.locator(f'{scope} [data-style="hand-strong"]').count() == 0, (
                f"{scope} still has a parallel hand-strong button"
            )

        dock_hand = pg.locator('#reader-dock [data-style="hand"]')
        assert dock_hand.count() == 1, f"dock hand items: {dock_hand.count()}"
        assert pg.locator('#reader-dock [data-style^="hand-"]').count() == 0, (
            "dock still exposes a parallel hand-soft/hand-strong entry"
        )
        label = (dock_hand.get_attribute("aria-label") or "").strip()
        title = (dock_hand.get_attribute("title") or "").strip()
        metrics["dock hand label"] = label
        metrics["dock hand title"] = title
        # The dock keeps one hand entry named 手绘下划线 (no variant suffix); only
        # its tooltip names the remembered preset (task-3).
        assert label == "手绘下划线", (
            f"dock hand entry must be named 手绘下划线 without a suffix, got {label!r}"
        )
        assert title.startswith("手绘下划线"), f"dock hand title lost its name: {title!r}"
        default_preset = prefs(pg).get("handStyle") or "hand"
        expected_default = {"hand": "自然", "hand-soft": "轻微", "hand-strong": "明显"}[
            default_preset
        ]
        assert expected_default in title, (
            f"dock hand tooltip {title!r} does not reflect the current preset {default_preset!r}"
        )

        hidden_select = pg.eval_on_selector_all(
            "#highlight-style option", "els => els.map((el) => el.value)"
        )
        metrics["hidden select values"] = hidden_select
        assert set(hidden_select) == {
            "marker",
            "crayon",
            "hand",
            "hand-soft",
            "hand-strong",
            "underline",
            "pencil",
            "wavy",
        }, f"hidden select lost compatibility values: {hidden_select}"

        # ------------------------------------- selection-toolbar hand highlight
        ids_before = mark_ids(pg)
        select_reader_text(pg, 2, 3)
        pg.wait_for_timeout(400)
        assert pg.locator("#sel-toolbar").is_visible(), "selection toolbar did not open"
        pg.locator('#sel-styles [data-style="hand"]').click()
        pg.wait_for_timeout(900)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, f"expected one new highlight, got {created}"
        hand_id = created.pop()
        hand_item = wait_item(pg, hand_id)
        metrics["toolbar hand stored style"] = hand_item["style"]
        assert hand_item["style"] in HAND_STYLES, (
            f"hand button stored {hand_item['style']!r}, expected one of {sorted(HAND_STYLES)}"
        )
        assert not pg.locator("#sel-toolbar").is_visible(), "toolbar stayed open"

        bands = hand_family(pg, hand_id, "selection toolbar hand")
        metrics["toolbar hand bands"] = len(bands)
        metrics["toolbar hand path chars"] = len(bands[0]["ink"][0])
        first_paths = [band["ink"] for band in bands]
        assert first_paths[0], first_paths

        # Deterministic path across a forced repaint (resize event, same viewport).
        pg.evaluate("window.dispatchEvent(new Event('resize'))")
        pg.wait_for_timeout(1000)
        repainted = hand_family(pg, hand_id, "hand after resize repaint")
        metrics["path stable across repaint"] = [band["ink"] for band in repainted] == first_paths
        assert [band["ink"] for band in repainted] == first_paths, (
            "hand underline path changed after a forced repaint"
        )

        # --------------------------------------- preset chips in the annotation editor
        mark_box = pg.locator(f'.r-mark[data-id="{hand_id}"]').first.bounding_box()
        pg.mouse.click(
            mark_box["x"] + 14,
            mark_box["y"] + mark_box["height"] / 2,
        )
        pg.wait_for_timeout(500)
        assert pg.locator("#editor").is_visible(), "clicking the hand mark did not open the editor"
        assert pg.locator("#editor-styles").is_visible(), "editor style row is hidden for a highlight"
        editor_text = pg.inner_text("#editor")
        metrics["editor chip row present"] = all(word in editor_text for word in PRESET_WORDS)
        assert "手绘下划线笔触" in editor_text or all(
            word in editor_text for word in PRESET_WORDS
        ), f"editor does not show the 轻微/自然/明显 preset chips: {editor_text!r}"
        assert all(word in editor_text for word in PRESET_WORDS), (
            f"editor preset chip row is incomplete: {editor_text!r}"
        )

        click_chip(pg, "#editor", "明显")
        pg.wait_for_timeout(900)
        restyled = wait_item(pg, hand_id)
        metrics["editor strong stored style"] = restyled["style"]
        assert restyled["style"] == "hand-strong", (
            f"editor 明显 chip stored {restyled['style']!r}, expected hand-strong"
        )
        strong_bands = hand_family(pg, hand_id, "editor 明显 preset")
        assert [band["ink"] for band in strong_bands] != first_paths, (
            "switching to 明显 did not change the hand stroke"
        )
        assert prefs(pg).get("handStyle") == "hand-strong", (
            f"remembered hand preset is {prefs(pg).get('handStyle')!r}, expected hand-strong"
        )
        pg.locator("#editor-done").click()
        pg.wait_for_timeout(500)

        # --------------------------------------- preset chips in dock settings popover
        pg.locator('#reader-dock [data-action="settings"]').click()
        pg.wait_for_selector("#r-pop:not([hidden])")
        pop_text = pg.inner_text("#r-pop")
        row_name = pg.inner_text('.r-settings-row[data-row="hand"] .r-settings-name')
        metrics["settings hand row label"] = row_name.strip()
        metrics["dock settings row present"] = (
            "手绘下划线" in pop_text and "笔触" in pop_text
        )
        assert row_name.strip() == "手绘下划线", (
            f"dock settings hand row still carries a variant suffix: {row_name!r}"
        )
        assert "手绘下划线" in pop_text and "笔触" in pop_text, (
            f"dock settings popover has no 手绘下划线笔触 row: {pop_text!r}"
        )
        state = chip_state(pg, "#r-pop", "轻微")
        assert state, "dock settings popover has no 轻微 chip"
        click_chip(pg, "#r-pop", "轻微")
        pg.wait_for_timeout(400)
        after_soft = prefs(pg).get("handStyle")
        metrics["dock settings stored preset"] = after_soft
        assert after_soft == "hand-soft", f"dock 轻微 stored {after_soft!r}, expected hand-soft"
        soft_state = chip_state(pg, "#r-pop", "轻微")
        metrics["dock 轻微 chip active"] = bool(soft_state and soft_state["active"])
        assert soft_state and soft_state["active"], "dock 轻微 chip is not marked active"
        dock_after_soft = pg.locator('#reader-dock [data-style="hand"]')
        dock_soft_title = (dock_after_soft.get_attribute("title") or "").strip()
        dock_soft_label = (dock_after_soft.get_attribute("aria-label") or "").strip()
        metrics["dock tooltip after 轻微"] = dock_soft_title
        assert dock_soft_title.endswith("轻微"), (
            f"dock hand tooltip {dock_soft_title!r} did not follow the new preset"
        )
        assert dock_soft_label == "手绘下划线", (
            f"dock hand name gained a preset suffix: {dock_soft_label!r}"
        )
        close_popover(pg)

        # ---------------------------------- remembered after reload, reused by dot
        pg.reload()
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(1500)
        reloaded_prefs = prefs(pg).get("handStyle")
        metrics["preset after reload"] = reloaded_prefs
        assert reloaded_prefs == "hand-soft", (
            f"hand preset after reload is {reloaded_prefs!r}, expected hand-soft"
        )

        hand_button = pg.eval_on_selector(
            '#sel-styles [data-style="hand"]',
            "el => ({cls: String(el.className || ''), pressed: el.getAttribute('aria-pressed')})",
        )
        metrics["hand button active after reload"] = hand_button
        assert "on" in hand_button["cls"].split() or hand_button["pressed"] == "true", (
            f"single hand button is not marked active for a remembered hand style: {hand_button}"
        )

        ids_before = mark_ids(pg)
        select_reader_text(pg, 8, 3)
        pg.wait_for_timeout(400)
        assert pg.locator("#sel-toolbar").is_visible(), "toolbar did not open after reload"
        pg.locator("#sel-toolbar .r-dot.blue").click()
        pg.wait_for_timeout(900)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, f"colour dot created {created}"
        dot_id = created.pop()
        dot_item = wait_item(pg, dot_id)
        metrics["colour dot after reload style"] = dot_item["style"]
        assert dot_item["style"] == "hand-soft", (
            f"colour-dot highlight used {dot_item['style']!r}, expected remembered hand-soft"
        )
        hand_family(pg, dot_id, "colour dot remembered preset")

        # ------------------------------------------- dock hand then colour dot
        pg.locator('#reader-dock [data-style="hand"]').click()
        pg.wait_for_timeout(300)
        ids_before = mark_ids(pg)
        select_reader_text(pg, 12, 3)
        pg.wait_for_timeout(400)
        assert pg.locator("#sel-toolbar").is_visible(), "toolbar did not open for dock hand path"
        pg.locator("#sel-toolbar .r-dot.orange").click()
        pg.wait_for_timeout(900)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, f"dock hand + colour dot created {created}"
        dock_id = created.pop()
        dock_item = wait_item(pg, dock_id)
        metrics["dock hand + dot stored style"] = dock_item["style"]
        assert dock_item["style"] in HAND_STYLES, (
            f"dock hand + colour dot stored {dock_item['style']!r}"
        )
        hand_family(pg, dock_id, "dock hand + colour dot")

        # ------------------------------------- right-click 标记所选文字 menu
        ids_before = mark_ids(pg)
        select_reader_text(pg, 16, 3)
        pg.wait_for_timeout(400)
        anchor = pg.evaluate(
            """() => {
              const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }"""
        )
        pg.mouse.click(anchor["x"], anchor["y"], button="right")
        pg.wait_for_timeout(400)
        assert pg.locator("#menu").is_visible(), "right-click selection menu did not open"
        menu_text = pg.inner_text("#menu")
        assert "标记所选文字" in menu_text, menu_text
        pg.locator('#menu [data-menu-style="hand"]').click()
        pg.wait_for_timeout(900)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, f"menu hand path created {created}"
        menu_id = created.pop()
        menu_item = wait_item(pg, menu_id)
        metrics["menu hand stored style"] = menu_item["style"]
        assert menu_item["style"] in HAND_STYLES, (
            f"right-click hand stored {menu_item['style']!r}"
        )
        hand_family(pg, menu_id, "right-click menu hand")

        # ------------------------------------------ editor restyle of a marker mark
        # Pick the marker style first: a colour dot deliberately reuses the
        # remembered style, which is a hand preset at this point in the test.
        pg.locator('#reader-dock [data-style="marker"]').click()
        pg.wait_for_timeout(300)
        ids_before = mark_ids(pg)
        select_reader_text(pg, 0, 2)
        pg.wait_for_timeout(400)
        pg.locator("#sel-toolbar .r-dot.yellow").click()
        pg.wait_for_timeout(900)
        created = mark_ids(pg) - ids_before
        assert len(created) == 1, created
        marker_id = created.pop()
        marker_item = wait_item(pg, marker_id)
        assert marker_item["style"] == "marker", marker_item["style"]
        marker_box = pg.locator(f'.r-mark[data-id="{marker_id}"]').first.bounding_box()
        pg.mouse.click(
            marker_box["x"] + marker_box["width"] / 2,
            marker_box["y"] + marker_box["height"] / 2,
        )
        pg.wait_for_timeout(500)
        assert pg.locator("#editor").is_visible(), "marker editor did not open"
        marker_editor_text = pg.inner_text("#editor")
        assert not all(word in marker_editor_text for word in PRESET_WORDS), (
            "hand preset chips are shown for a non-hand highlight"
        )
        pg.locator('#editor-styles [data-style="hand"]').click()
        pg.wait_for_timeout(900)
        restyled_item = wait_item(pg, marker_id)
        metrics["editor restyle stored style"] = restyled_item["style"]
        assert restyled_item["style"] in HAND_STYLES, (
            f"editor restyle stored {restyled_item['style']!r}"
        )
        hand_family(pg, marker_id, "editor restyle marker -> hand")
        pg.locator("#editor-done").click()
        pg.wait_for_timeout(400)

        # ------------------------- merge path: hand highlight over an existing one
        ids_before = mark_ids(pg)
        anomaly_before = pg.inner_text("#anno-count")
        select_reader_text(pg, 20, 5)
        pg.wait_for_timeout(400)
        pg.locator("#sel-toolbar .r-dot.teal").click()
        pg.wait_for_timeout(900)
        outer = mark_ids(pg) - ids_before
        assert len(outer) == 1, outer
        outer_id = outer.pop()
        outer_bands = pg.locator(f'.r-mark[data-id="{outer_id}"]').count()
        assert outer_bands >= 4, outer_bands

        ids_before = mark_ids(pg)
        select_reader_text(pg, 21, 3)  # strictly inside the highlight above
        pg.wait_for_timeout(400)
        pg.locator('#sel-styles [data-style="hand"]').click()
        pg.wait_for_timeout(1000)
        assert "已合并重叠高亮" in pg.inner_text("#toasts"), "merge path did not merge"
        assert pg.inner_text("#anno-count") != anomaly_before
        inner = mark_ids(pg) - ids_before - {outer_id}
        assert len(inner) == 1, inner
        inner_id = inner.pop()
        inner_item = wait_item(pg, inner_id)
        metrics["merge stored style"] = inner_item["style"]
        assert inner_item["style"] in HAND_STYLES, (
            f"merge path stored {inner_item['style']!r}"
        )
        hand_family(pg, inner_id, "merge over existing highlight")
        assert pg.locator(f'.r-mark[data-id="{outer_id}"]').count() < outer_bands, (
            "the outer highlight was not trimmed by the merged hand highlight"
        )
        assert pg.locator("#menu").is_hidden()

        # ------------------------------------------------------------------ report
        metrics["js pageerrors"] = len(errors)
        metrics["console errors"] = len(console_errors)
        assert not errors, f"page errors: {errors}"
        assert not console_errors, f"console errors: {console_errors}"

        pg.screenshot(path=str(RUN / "style-tools-final.png"))
        elapsed = time.time() - started
        metrics["runtime seconds"] = round(elapsed, 1)
        print("STYLE TOOLS UI PASS")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
    except BaseException as exc:  # noqa: BLE001 - standalone script reports everything
        failures.append(describe_pre_failure(exc))
        print("STYLE TOOLS UI FAIL")
        for message in failures:
            print(f"  {message}")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
        try:
            pg.screenshot(path=str(RUN / "style-tools-failure.png"))
        except Exception:  # noqa: BLE001 - best-effort evidence
            pass
        raise
    finally:
        try:
            browser.close()
        finally:
            server.shutdown()
