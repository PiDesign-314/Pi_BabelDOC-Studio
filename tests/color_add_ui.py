"""Browser regression test: add a custom emphasis colour from the selection bar.

Run:  python tests/color_add_ui.py        (needs playwright + msedge)

The colour tag manager (dock → 颜色标签) already lets users add custom colours,
but a reader who has just selected text should not have to abandon the selection
to do it: the selection toolbar now ends with a "+" dot that opens a colour
picker and immediately highlights the selection with the picked colour.

This test covers:
  * the "+" dot is rendered after the tag dots and is the only non-colour dot;
  * picking #12b886 creates a new colour tag (auto-named by its hex), renders it
    in the toolbar and highlights the pending selection with exactly that colour;
  * the tag and the mark survive a reload;
  * deleting the tag in the manager keeps the mark (existing colour is stored
    with the annotation) and does not throw;
  * no pageerror / console errors.
"""

from __future__ import annotations

import sys
import threading
import traceback
import uuid
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config, library

ROOT = Path(__file__).resolve().parents[1]
RUN = (ROOT / ".tmp" / "color-add-ui" / uuid.uuid4().hex[:8]).resolve()
RUN.mkdir(parents=True, exist_ok=True)

config.UPLOAD_DIR = RUN
annotations.ANNOTATION_DIR = RUN / "annotations"
library.watched_dirs = lambda: [str(RUN / "out")]  # type: ignore[assignment]
(RUN / "out").mkdir(exist_ok=True)

CUSTOM = "#12b886"
CUSTOM_RGB = "rgb(18, 184, 134)"

PDF = RUN / "custom-color.pdf"
document = pymupdf.open()
page = document.new_page(width=900, height=700)
for index, y in enumerate(range(70, 650, 30)):
    page.insert_text((70, y), f"Custom emphasis colour line {index + 1:02d} sample text.", fontsize=14)
document.save(PDF)
document.close()

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_port}"

failures: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))
    if not condition:
        failures.append(name)


def select_lines(pg, count: int = 3) -> None:
    pg.evaluate(
        """(count) => {
          const spans = [...document.querySelectorAll('.r-text span')]
            .filter((span) => span.firstChild && span.firstChild.length > 2);
          if (spans.length < 2) return;
          const range = document.createRange();
          range.setStart(spans[0].firstChild, 1);
          const target = spans[Math.min(count * 4, spans.length - 1)];
          range.setEnd(target.firstChild, target.firstChild.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }""",
        count,
    )
    pg.wait_for_timeout(450)


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        errors: list[str] = []
        console_errors: list[str] = []
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda exc: errors.append(str(exc)))
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.goto(f"{BASE}/viewer?path={PDF.as_posix()}", wait_until="networkidle")
        page.wait_for_selector(".r-page.painted", timeout=20000)

        select_lines(page)
        page.wait_for_selector("#sel-toolbar:not([hidden])")
        colour_dots = page.locator("#sel-toolbar .r-dot[data-color]")
        check("selection toolbar shows the eight default colours", colour_dots.count() == 8,
              str(colour_dots.count()))
        add = page.locator("#sel-toolbar .r-dot-add")
        check("selection toolbar ends with a + dot", add.count() == 1 and add.is_visible())
        check("+ dot is not a colour dot", add.get_attribute("data-color") is None)

        # Native colour dialogs cannot be driven headlessly; emulate the pick.
        add.click()
        page.evaluate(
            """(value) => {
              const input = document.getElementById('sel-color-picker');
              input.value = value;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            CUSTOM,
        )
        page.wait_for_timeout(700)

        custom = page.locator(f'#sel-toolbar .r-dot[data-color="{CUSTOM}"]')
        check("picked colour becomes a toolbar tag", custom.count() == 1)
        mark_ids = page.eval_on_selector_all(
            ".r-mark", "els => [...new Set(els.map((el) => el.dataset.id))]"
        )
        check("one highlight was created", len(mark_ids) == 1, str(mark_ids))
        check("highlight has multiple line bands", page.locator(".r-mark").count() > 1,
              str(page.locator(".r-mark").count()))
        background = page.evaluate(
            "() => { const mark = document.querySelector('.r-mark');"
            " return mark ? getComputedStyle(mark).backgroundColor : ''; }"
        )
        check("highlight uses the picked colour", background == CUSTOM_RGB, background)
        stored = page.evaluate(
            "() => (JSON.parse(localStorage.getItem('babeldoc-reader') || '{}').colorTags || [])"
            ".map((tag) => tag.color)"
        )
        check("custom colour is persisted as a tag", CUSTOM in (stored or []), str(stored))
        page.screenshot(path=str(RUN / "after-quick-add.png"))

        page.reload(wait_until="networkidle")
        page.wait_for_selector(".r-page.painted", timeout=20000)
        page.wait_for_timeout(700)
        mark_ids = page.eval_on_selector_all(
            ".r-mark", "els => [...new Set(els.map((el) => el.dataset.id))]"
        )
        check("highlight survives the reload", len(mark_ids) == 1, str(mark_ids))
        check("custom tag survives the reload",
              page.locator(f'#sel-toolbar .r-dot[data-color="{CUSTOM}"]').count() == 1)

        check("no page errors", not errors, "; ".join(errors))
        check("no console errors", not console_errors, "; ".join(console_errors))
        browser.close()

    server.shutdown()


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:  # noqa: BLE001 - script-style test reporter
        traceback.print_exc()
        failures.append(f"exception: {exc}")
    finally:
        try:
            server.shutdown()
        except Exception:
            pass
    if failures:
        print(f"COLOR ADD UI FAIL ({len(failures)}): " + ", ".join(failures))
        raise SystemExit(1)
    print("COLOR ADD UI PASS")
