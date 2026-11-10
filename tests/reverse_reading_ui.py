"""Browser regression test: 反色阅读 (invert reading display) toggle.

Run:  python tests/reverse_reading_ui.py        (needs playwright + msedge)

Covers the reader request for an inverted reading mode:

  * the top bar exposes #btn-invert with aria-pressed, placed before the theme
    button inside .r-tools;
  * clicking it toggles a body class (body.invert-reading) and persists the
    state across reload;
  * when on, the rendered page is dark with light body text (background
    luminance < 0.25, text > 0.5, contrast >= 4.5:1), while highlights, hand
    underlines and the selection band stay distinguishable from the page, and a
    page with a multi-colour figure keeps >= 3 luminance levels (not a black
    box);
  * when off, the page matches the pre-toggle screenshot (small anti-aliasing
    tolerance) and paper themes still apply;
  * toggling never modifies the PDF file (hash before/after).

State is isolated under .tmp/qa-features/; the server uses an ephemeral port and
the browser/server are always closed.  Screenshots stay in the run folder.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pymupdf
from PIL import Image
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config

ROOT = Path(__file__).resolve().parents[1]
RUN = (ROOT / ".tmp" / "qa-features" / ("reverse-" + uuid.uuid4().hex[:8])).resolve()
RUN.mkdir(parents=True, exist_ok=True)

# Isolate all persistent state BEFORE the server is created.
config.UPLOAD_DIR = RUN
annotations.ANNOTATION_DIR = RUN / "annotations"

PDF = RUN / "reading.pdf"
doc = pymupdf.open()

# Page 1: a full text page (dark text on white paper).
text_page = doc.new_page(width=1000, height=740)
for index, y in enumerate(range(70, 700, 28)):
    text_page.insert_text(
        (70, y),
        f"Night reading sample line {index + 1:02d}: the reader inverts the page "
        "display without touching the document.",
        fontsize=15,
        color=(0.05, 0.05, 0.05),
    )

# Page 2: a figure with several clearly different fill luminances.
figure = doc.new_page(width=1000, height=740)
figure.insert_text((70, 46), "Figure page: colour blocks and bars", fontsize=17, color=(0, 0, 0))
blocks = [
    (pymupdf.Rect(70, 70, 420, 260), (0.82, 0.82, 0.82)),
    (pymupdf.Rect(470, 70, 820, 260), (0.50, 0.50, 0.50)),
    (pymupdf.Rect(70, 300, 420, 500), (0.16, 0.16, 0.16)),
    (pymupdf.Rect(470, 300, 820, 500), (0.74, 0.20, 0.16)),
    (pymupdf.Rect(70, 540, 820, 690), (0.12, 0.52, 0.30)),
]
for rect, colour in blocks:
    figure.draw_rect(rect, color=None, fill=colour)
for rect, colour in blocks:
    figure.draw_rect(rect, color=(0.9, 0.9, 0.9), width=2)
    figure.insert_text(
        (rect.x0 + 12, rect.y0 + 26),
        "chart panel ABC 123",
        fontsize=14,
        color=(1 if sum(colour) < 1.5 else 0, 1 if sum(colour) < 1.5 else 0, 1 if sum(colour) < 1.5 else 0),
    )
doc.save(PDF)
doc.close()

pdf_hash_before = hashlib.sha256(PDF.read_bytes()).hexdigest()

# Paper themes the reader exposes through the dock popover.
PAPERS = {"white": (255, 255, 255), "cream": (243, 236, 218)}

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

metrics: dict[str, object] = {}


def select_reader_text(pg, start: int = 0, count: int = 3) -> None:
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


def load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)


def relative_luminance(rgb: np.ndarray) -> np.ndarray:
    channels = rgb / 255.0
    linear = np.where(
        channels <= 0.04045,
        channels / 12.92,
        ((channels + 0.055) / 1.055) ** 2.4,
    )
    return linear[..., 0] * 0.2126 + linear[..., 1] * 0.7152 + linear[..., 2] * 0.0722


def page_metrics(path: Path, inset: int = 12) -> dict:
    rgb = load_rgb(path)[inset:-inset, inset:-inset]
    luminance = relative_luminance(rgb)
    flat = luminance.ravel()
    bg_lum = float(np.median(flat))
    near = np.abs(flat - bg_lum) <= 0.02
    flat_rgb = rgb.reshape(-1, 3)
    bg_rgb = flat_rgb[near].mean(axis=0) if near.any() else flat_rgb.mean(axis=0)
    bright = flat > bg_lum + 0.45
    text_lum = float(flat[bright].mean()) if bright.any() else 0.0
    lo, hi = (bg_lum, text_lum) if text_lum >= bg_lum else (text_lum, bg_lum)
    contrast = (hi + 0.05) / (lo + 0.05) if hi > lo else 1.0
    histogram, _ = np.histogram(flat, bins=16, range=(0.0, 1.0))
    levels = int((histogram / flat.size >= 0.02).sum())
    return {
        "size": [int(rgb.shape[1]), int(rgb.shape[0])],
        "bg_lum": round(bg_lum, 4),
        "bg_rgb": [round(float(value), 1) for value in bg_rgb],
        "text_lum": round(text_lum, 4),
        "contrast": round(float(contrast), 2),
        "bright_fraction": round(float(bright.mean()), 4),
        "levels": levels,
    }


def region_metrics(path: Path, bg_rgb: list[float]) -> dict:
    rgb = load_rgb(path)
    if rgb.shape[0] > 6 and rgb.shape[1] > 6:
        rgb = rgb[2:-2, 2:-2]
    flat = rgb.reshape(-1, 3)
    distance = np.linalg.norm(flat - np.asarray(bg_rgb, dtype=np.float64), axis=1)
    return {
        "mean_rgb": [round(float(value), 1) for value in flat.mean(axis=0)],
        "mean_dist": round(float(distance.mean()), 2),
        "max_dist": round(float(distance.max()), 2),
        "fraction_gt_25": round(float((distance > 25).mean()), 3),
        "fraction_gt_40": round(float((distance > 40).mean()), 3),
        "fraction_gt_60": round(float((distance > 60).mean()), 3),
    }


def invert_signature(pg) -> dict:
    return pg.evaluate(
        """() => {
          const button = document.querySelector('#btn-invert');
          const page = document.querySelector('.r-sheet .r-page');
          const canvas = page ? page.querySelector('canvas') : null;
          const storage = {};
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            /* The reading-position key embeds the document path, which itself
               may contain the word "invert"; only the mode preference counts. */
            if (/invert/i.test(key) && !/^babeldoc-pos:/.test(key)) {
              storage[key] = localStorage.getItem(key);
            }
          }
          return {
            bodyClass: [...document.body.classList],
            bodyData: { ...document.body.dataset },
            pressed: button ? button.getAttribute('aria-pressed') : null,
            title: button ? (button.getAttribute('title') || '') : null,
            ariaLabel: button ? (button.getAttribute('aria-label') || '') : null,
            pageFilter: page ? getComputedStyle(page).filter : null,
            canvasFilter: canvas ? getComputedStyle(canvas).filter : null,
            storage,
          };
        }"""
    )


def assert_invert_on(pg, label: str) -> dict:
    signature = invert_signature(pg)
    filters = [signature["pageFilter"], signature["canvasFilter"]]
    assert signature["pressed"] == "true", f"{label}: aria-pressed={signature['pressed']!r}"
    assert "invert-reading" in signature["bodyClass"], (
        f"{label}: body class is {signature['bodyClass']}, expected invert-reading"
    )
    assert any("invert(" in (value or "").replace(" ", "").lower() for value in filters), (
        f"{label}: no invert CSS filter on the page/canvas ({filters})"
    )
    assert signature["storage"], f"{label}: no invert persistence key in localStorage"
    assert any(
        str(value).lower() not in ("", "0", "false", "off", "null")
        for value in signature["storage"].values()
    ), f"{label}: stored invert value is falsy: {signature['storage']}"
    return signature


def assert_invert_off(pg, label: str) -> dict:
    signature = invert_signature(pg)
    filters = [signature["pageFilter"], signature["canvasFilter"]]
    assert signature["pressed"] == "false", f"{label}: aria-pressed={signature['pressed']!r}"
    assert "invert-reading" not in signature["bodyClass"], (
        f"{label}: body still has invert-reading: {signature['bodyClass']}"
    )
    assert not any(
        "invert(" in (value or "").replace(" ", "").lower() for value in filters
    ), f"{label}: invert filter still applied ({filters})"
    assert not any(
        str(value).lower() not in ("", "0", "false", "off", "null")
        for value in signature["storage"].values()
    ), f"{label}: stored invert value is still truthy: {signature['storage']}"
    return signature


def shot_element(pg, selector: str, path: Path, index: int = 0) -> Path:
    locator = pg.locator(selector).nth(index)
    locator.screenshot(path=str(path))
    return path


def shot_page(pg, page_index: int, path: Path) -> Path:
    # Put the page just below the fixed top bar so the element screenshot never
    # captures the reader chrome that floats over a scrolled page.
    pg.evaluate(
        """(index) => {
          const stage = document.querySelector('.r-stage');
          const page = document.querySelectorAll('.r-sheet .r-page')[index];
          if (!stage || !page) return;
          const stageRect = stage.getBoundingClientRect();
          const pageTop =
            page.getBoundingClientRect().top - stageRect.top + stage.scrollTop;
          stage.scrollTop = Math.max(0, pageTop - 70);
        }""",
        page_index,
    )
    pg.wait_for_timeout(400)
    pg.wait_for_function(
        """(index) => {
          const pages = [...document.querySelectorAll('.r-sheet .r-page')];
          return pages.length > index && pages[index].classList.contains('painted');
        }""",
        arg=page_index,
        timeout=30000,
    )
    return shot_element(pg, ".r-sheet .r-page", path, page_index)


def wait_page_number(pg, number: int) -> None:
    pg.wait_for_function(
        "(expected) => document.querySelector('#page-input') && "
        "Number(document.querySelector('#page-input').value) === expected",
        arg=number,
        timeout=20000,
    )


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1440, "height": 1200})
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
        pg.wait_for_timeout(1000)

        # ------------------------------------------------------- top-bar toggle
        assert pg.locator("#btn-invert").count() == 1, "#btn-invert is missing"
        assert pg.locator(".r-tools #btn-invert").count() == 1, (
            "#btn-invert is not inside .r-tools"
        )
        order_ok = pg.evaluate(
            """() => {
              const invert = document.querySelector('#btn-invert');
              const theme = document.querySelector('#btn-theme');
              return Boolean(
                invert && theme &&
                (invert.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING)
              );
            }"""
        )
        assert order_ok, "#btn-invert is not placed before #btn-theme"
        signature = invert_signature(pg)
        metrics["initial toggle"] = {
            "pressed": signature["pressed"],
            "title": signature["title"],
            "aria_label": signature["ariaLabel"],
            "body_class": signature["bodyClass"],
        }
        assert signature["pressed"] == "false", (
            f"toggle starts pressed: {signature['pressed']!r}"
        )
        assert "反色阅读" in signature["title"] or "反色阅读" in signature["ariaLabel"], (
            f"toggle has no 反色阅读 label: {signature['title']!r} / {signature['ariaLabel']!r}"
        )

        # ----------------------------------- annotation fixtures (mark + hand)
        select_reader_text(pg, 2, 3)
        pg.wait_for_timeout(400)
        assert pg.locator("#sel-toolbar").is_visible(), "selection toolbar did not open"
        pg.locator("#sel-toolbar .r-dot.yellow").click()
        pg.wait_for_timeout(900)
        assert pg.locator(".r-mark").count() > 0, "marker highlight did not render"

        select_reader_text(pg, 6, 3)
        pg.wait_for_timeout(400)
        pg.locator('#sel-styles [data-style="hand"]').click()
        pg.wait_for_timeout(1000)
        assert pg.locator(".r-mark[data-style]").count() > 0, "hand highlight did not render"
        assert pg.locator(".r-mark[data-style] svg.hand-underline").count() > 0, (
            "hand highlight has no SVG underline"
        )
        marker_id = pg.eval_on_selector(".r-mark", "el => el.dataset.id")
        metrics["fixtures"] = {
            "marks": pg.locator(".r-mark").count(),
            "hand_marks": pg.locator(".r-mark[data-style] svg.hand-underline").count(),
        }

        baseline_path = RUN / "invert-before.png"
        shot_page(pg, 0, baseline_path)
        baseline = page_metrics(baseline_path)
        metrics["normal page"] = baseline
        assert baseline["bg_lum"] > 0.5, f"normal page is not light: {baseline}"

        # ------------------------------------------------------------- enable
        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(900)
        on_signature = assert_invert_on(pg, "after enabling")
        metrics["toggle on"] = {
            "body_class": on_signature["bodyClass"],
            "page_filter": on_signature["pageFilter"],
            "canvas_filter": on_signature["canvasFilter"],
            "storage": on_signature["storage"],
        }

        inverted_path = RUN / "invert-on-text.png"
        shot_page(pg, 0, inverted_path)
        inverted = page_metrics(inverted_path)
        metrics["inverted text page"] = inverted
        assert inverted["bg_lum"] < 0.25, (
            f"inverted page background is not dark: bg_lum={inverted['bg_lum']}"
        )
        assert inverted["text_lum"] > 0.5, (
            f"inverted body text is not light: text_lum={inverted['text_lum']}"
        )
        assert inverted["contrast"] >= 4.5, (
            f"inverted text contrast is only {inverted['contrast']}:1"
        )

        # Highlight + hand underline stay distinguishable from the page.
        mark_path = RUN / "invert-on-mark.png"
        shot_element(pg, ".r-mark", mark_path)
        mark_region = region_metrics(mark_path, inverted["bg_rgb"])
        hand_path = RUN / "invert-on-hand.png"
        shot_element(pg, ".r-mark[data-style] svg.hand-underline", hand_path)
        hand_region = region_metrics(hand_path, inverted["bg_rgb"])
        metrics["inverted mark region"] = mark_region
        metrics["inverted hand region"] = hand_region
        assert mark_region["mean_dist"] > 30, (
            f"highlight is lost against the inverted page: {mark_region}"
        )
        assert mark_region["fraction_gt_25"] > 0.25, mark_region
        assert hand_region["max_dist"] > 40 and hand_region["fraction_gt_60"] > 0.0, (
            f"hand underline is lost against the inverted page: {hand_region}"
        )

        # Selection band must remain visible in inverted mode too.
        select_reader_text(pg, 10, 2)
        pg.wait_for_timeout(500)
        picks = pg.locator(".r-select .r-pick")
        assert picks.count() >= 1, "no app-drawn selection band while inverted"
        pick_path = RUN / "invert-on-selection.png"
        picks.first.screenshot(path=str(pick_path))
        pick_region = region_metrics(pick_path, inverted["bg_rgb"])
        metrics["inverted selection region"] = pick_region
        assert pick_region["mean_dist"] > 15, (
            f"selection band is indistinguishable from the inverted page: {pick_region}"
        )
        # collapse the selection on empty page space before leaving the page
        box = pg.locator(".r-sheet .r-page").first.bounding_box()
        pg.mouse.click(
            box["x"] + box["width"] - 14,
            box["y"] + box["height"] - 14,
        )
        pg.wait_for_timeout(500)
        assert pg.locator(".r-select .r-pick").count() == 0, (
            "selection bands did not clear after collapsing the selection"
        )
        assert pg.locator("#sel-toolbar").is_hidden(), (
            "selection toolbar stayed open after collapsing the selection"
        )

        # --------------------------------------------------- figure page (on)
        pg.locator("#btn-next").click()
        wait_page_number(pg, 2)
        pg.wait_for_timeout(900)
        figure_path = RUN / "invert-on-figure.png"
        shot_page(pg, 1, figure_path)
        figure = page_metrics(figure_path)
        metrics["inverted figure page"] = figure
        assert figure["levels"] >= 3, (
            f"inverted figure page is a black box ({figure['levels']} luminance levels)"
        )
        assert figure["bright_fraction"] > 0.03, (
            f"inverted figure has almost no light detail: {figure}"
        )

        # ----------------------------------------------------------- disable
        pg.locator("#btn-prev").click()
        wait_page_number(pg, 1)
        pg.wait_for_timeout(800)
        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(900)
        assert_invert_off(pg, "after disabling")
        restored_path = RUN / "invert-after-off.png"
        shot_page(pg, 0, restored_path)
        before_rgb = load_rgb(baseline_path).astype(np.float64)
        after_rgb = load_rgb(restored_path).astype(np.float64)
        assert before_rgb.shape == after_rgb.shape, (
            f"page screenshot size changed: {before_rgb.shape} -> {after_rgb.shape}"
        )
        delta = np.abs(before_rgb - after_rgb)
        diff = delta.mean(axis=2)
        pixel_mean = float(diff.mean())
        changed_fraction = float((diff > 8).mean())
        metrics["off vs before"] = {
            "mean_abs_diff": round(pixel_mean, 3),
            "fraction_over_8": round(changed_fraction, 4),
            "max_diff": round(float(delta.max()), 1),
        }
        assert pixel_mean < 1.0 and changed_fraction < 0.005, (
            "turning invert off did not restore the page look: "
            f"mean_diff={pixel_mean:.3f} changed={changed_fraction:.4%}"
        )

        # ------------------------------------------------ paper theme still works
        pg.locator('#reader-dock [data-action="paper"]').click()
        pg.wait_for_selector("#r-pop:not([hidden])")
        pg.locator('#r-pop [data-paper="cream"]').click()
        pg.wait_for_timeout(500)
        pg.locator('#reader-dock [data-action="paper"]').click()  # close popover
        pg.wait_for_timeout(300)
        cream = page_metrics(shot_page(pg, 0, RUN / "paper-cream.png"))
        cream_rgb = cream["bg_rgb"]
        metrics["cream paper"] = cream
        for got, expected in zip(cream_rgb, PAPERS["cream"]):
            assert abs(got - expected) <= 12, (
                f"paper theme cream is not applied: page background {cream_rgb}"
            )
        assert pg.evaluate("() => document.body.dataset.paper") == "cream", (
            "body.dataset.paper is not cream"
        )

        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(800)
        assert_invert_on(pg, "paper theme + invert")
        dark_cream = page_metrics(shot_page(pg, 0, RUN / "paper-cream-inverted.png"))
        metrics["cream paper inverted"] = dark_cream
        assert dark_cream["bg_lum"] < 0.25, dark_cream
        assert pg.evaluate("() => document.body.dataset.paper") == "cream", (
            "invert mode dropped the paper theme"
        )
        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(800)
        assert_invert_off(pg, "paper theme after invert cycle")
        cream_again = page_metrics(shot_page(pg, 0, RUN / "paper-cream-restored.png"))
        for got, expected in zip(cream_again["bg_rgb"], PAPERS["cream"]):
            assert abs(got - expected) <= 12, (
                f"cream paper was not restored: {cream_again['bg_rgb']}"
            )

        # ------------------------------------------------------- reload persistence
        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(500)
        assert_invert_on(pg, "before reload (on)")
        pg.reload()
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(1500)
        reloaded_on = assert_invert_on(pg, "after reload (on)")
        page_after_reload = page_metrics(shot_page(pg, 0, RUN / "invert-reload-on.png"))
        metrics["reload on"] = {
            "body_class": reloaded_on["bodyClass"],
            "page": page_after_reload,
        }
        assert page_after_reload["bg_lum"] < 0.25, (
            f"inverted page was not restored after reload: {page_after_reload}"
        )

        pg.locator("#btn-invert").click()
        pg.wait_for_timeout(600)
        assert_invert_off(pg, "before reload (off)")
        pg.reload()
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(1200)
        reloaded_off = assert_invert_off(pg, "after reload (off)")
        page_after_off_reload = page_metrics(shot_page(pg, 0, RUN / "invert-reload-off.png"))
        metrics["reload off"] = {
            "body_class": reloaded_off["bodyClass"],
            "page": page_after_off_reload,
        }
        assert page_after_off_reload["bg_lum"] > 0.5, (
            f"normal page was not restored after reload: {page_after_off_reload}"
        )

        # ------------------------------------------------- document must be untouched
        pdf_hash_after = hashlib.sha256(PDF.read_bytes()).hexdigest()
        metrics["pdf hash unchanged"] = pdf_hash_after == pdf_hash_before
        assert pdf_hash_after == pdf_hash_before, "toggling invert modified the PDF file"

        metrics["annotations intact"] = pg.evaluate(
            "() => document.querySelectorAll('.r-mark').length"
        )
        metrics["js pageerrors"] = len(errors)
        metrics["console errors"] = len(console_errors)
        assert not errors, f"page errors: {errors}"
        assert not console_errors, f"console errors: {console_errors}"

        pg.screenshot(path=str(RUN / "reverse-reading-final.png"))
        metrics["runtime seconds"] = round(time.time() - started, 1)
        print("REVERSE READING UI PASS")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
    except BaseException as exc:  # noqa: BLE001 - standalone script reports everything
        print("REVERSE READING UI FAIL")
        print(f"  {''.join(traceback.format_exception_only(type(exc), exc)).strip()}")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
        try:
            pg.screenshot(path=str(RUN / "reverse-reading-failure.png"))
        except Exception:  # noqa: BLE001 - best-effort evidence
            pass
        raise
    finally:
        try:
            browser.close()
        finally:
            server.shutdown()
