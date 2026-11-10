"""Browser regression test: drag-selection paint must be continuous per-line bands.

The reader used to let the browser paint ``.r-text ::selection``: one translucent
box per PDF.js span.  On BabelDOC CJK lines (many spans with sub-pixel gaps and
overlaps) that shows white seams and darker double-painted stripes.  The reader
now hides the native paint and draws one ``.r-pick`` band per visual line inside
an app-rendered ``.r-select`` layer.

This test proves the new paint and fails loudly against the old behaviour:

1. serves the app on an ephemeral port with throw-away upload/annotation dirs;
2. generates a deterministic CJK PDF whose lines are split into several spans;
3. drag-selects exactly three visual lines with real mouse events;
4. checks the selection overlay (one band per line, glyph-extreme x/width, equal
   band heights, no vertical overlap between neighbouring bands);
5. measures the screenshot: no unpainted run longer than 2px inside a band
   (anti-seam) and shade sigma < 2.0 (anti double-painted stripes);
6. verifies the same metric fails on the stored pre-fix baseline screenshot, so
   the thresholds are demonstrably meaningful;
7. guards ``::selection`` computed paint, the selection toolbar, copy text,
   commit-to-highlight geometry, and clearing on collapse; no JS errors.

Run:  python tests/selection_paint_ui.py
Needs playwright + msedge, pymupdf, PIL, numpy (all used by other tests here).
"""

import json
import math
import re
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

ROOT = Path(__file__).resolve().parents[1]
QA_DIR = ROOT / ".tmp" / "sel-qa"
BASELINE_SHOT = ROOT / ".tmp" / "sel-repro-d27ce4" / "selection.png"

# A deterministic CJK page: every visual line is written as several separate
# text chunks, which PDF.js turns into several spans per line - exactly the
# geometry that used to make the native ::selection paint fragment.
PAGE_W, PAGE_H = 900, 600
BODY_FONT = 16
CHUNK = 6
LINES = [
    "这是用于测试选择涂色连续性的中文正文内容示例",
    "第二行文字同样由多个独立的文字片段拼接而成",
    "第三行文字用来验证每一行只绘制一条选择色带",
    "第四行是额外的干扰行不应被包含在选择范围之内",
    "第五行文字保证页面下方留有可以点击的空白区域",
]
SELECT_LINE = 1          # skip the top line, keep blank space above
SELECT_COUNT = 3
MAX_GAP_PX = 2.0         # anti-seam: no unpainted run longer than this
MAX_SIGMA = 2.0          # anti double-paint: shade luminance std inside a band

COLLECT_LINES = r"""
() => {
  const page = document.querySelector('.r-sheet .r-page');
  const box = page.getBoundingClientRect();
  const spans = [...page.querySelectorAll('.r-text span')]
    .map((s) => ({ s, r: s.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 2 && r.height > 2 && r.left >= box.left && r.right <= box.right + 1);
  const lines = [];
  for (const span of spans) {
    const key = Math.round(span.r.top);
    let line = lines.find((entry) => Math.abs(entry.key - key) <= 1);
    if (!line) {
      line = { key, items: [] };
      lines.push(line);
    }
    line.items.push({ s: span.s, r: span.r });
  }
  lines.sort((a, b) => a.key - b.key);
  return lines.map((line) => {
    const items = line.items.slice().sort((a, b) => a.r.left - b.r.left);
    return {
      top: line.key,
      left: items[0].r.left,
      right: items[items.length - 1].r.right,
      bottom: Math.max(...items.map((i) => i.r.bottom)),
      height: Math.max(...items.map((i) => i.r.height)),
      spans: items.length,
      text: items.map((i) => i.s.textContent).join(''),
    };
  });
}
"""

DRAG_TARGET = r"""
(args) => {
  const [startLine, count] = args;
  const page = document.querySelector('.r-sheet .r-page');
  const box = page.getBoundingClientRect();
  const spans = [...page.querySelectorAll('.r-text span')]
    .map((s) => ({ s, r: s.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 2 && r.height > 2 && r.left >= box.left && r.right <= box.right + 1);
  const lines = new Map();
  for (const span of spans) {
    const key = Math.round(span.r.top);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(span);
  }
  const keys = [...lines.keys()].sort((a, b) => a - b);
  if (keys.length <= startLine) return null;
  const firstLine = lines.get(keys[startLine]).slice().sort((a, b) => a.r.left - b.r.left);
  const lastLine = lines.get(keys[Math.min(startLine + count - 1, keys.length - 1)])
    .slice().sort((a, b) => a.r.left - b.r.left);
  const first = firstLine[0];
  const last = lastLine[lastLine.length - 1];
  return {
    start: { x: first.r.left + 2, y: first.r.top + first.r.height / 2 },
    end: { x: last.r.right - 2, y: last.r.top + last.r.height / 2 },
    firstText: first.s.textContent,
    expectedLines: Math.min(count, keys.length - startLine),
  };
}
"""

RANGE_LINES = r"""
() => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return { text: '', collapsed: true, lines: [] };
  }
  const page = document.querySelector('.r-sheet .r-page');
  const box = page.getBoundingClientRect();
  const rects = [...selection.getRangeAt(0).getClientRects()]
    .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }))
    .filter((r) => r.w > 0.5 && r.h > 0.5);
  const lines = [];
  for (const rect of rects) {
    let line = lines.find(
      (entry) => Math.abs((entry.y + entry.h / 2) - (rect.y + rect.h / 2)) <= Math.max(2, Math.min(entry.h, rect.h) * 0.4)
    );
    if (!line) {
      line = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, rects: 1 };
      lines.push(line);
      continue;
    }
    const right = Math.max(line.x + line.w, rect.x + rect.w);
    const bottom = Math.max(line.y + line.h, rect.y + rect.h);
    line.x = Math.min(line.x, rect.x);
    line.y = Math.min(line.y, rect.y);
    line.w = right - line.x;
    line.h = bottom - line.y;
    line.rects += 1;
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    text: selection.toString(),
    collapsed: false,
    lines,
    pageBox: { x: box.x, y: box.y, w: box.width, h: box.height },
  };
}
"""

BOXES = r"""
(selector) => [...document.querySelectorAll(selector)].map((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, cls: el.className };
})
"""

SELECTION_STYLE = r"""
() => {
  const span = document.querySelector('.r-sheet .r-text span');
  if (!span) return { supported: false };
  // True feature check: style a throw-away element with ::selection and see if
  // the browser resolves the pseudo-element's computed background.
  const probe = document.createElement('div');
  probe.id = '__dsh_selection_probe__';
  document.body.appendChild(probe);
  const style = document.createElement('style');
  style.textContent = '#__dsh_selection_probe__::selection{background-color:rgb(1,2,3)}';
  document.head.appendChild(style);
  let probeValue = '';
  try {
    probeValue = getComputedStyle(probe, '::selection').backgroundColor || '';
  } catch (error) {
    probeValue = '';
  }
  probe.remove();
  style.remove();
  const supported = probeValue.replace(/\s+/g, '') === 'rgb(1,2,3)';
  let background = '';
  try {
    background = getComputedStyle(span, '::selection').backgroundColor || '';
  } catch (error) {
    background = '';
  }
  return { supported, background, color: getComputedStyle(span, '::selection').color, probe: probeValue };
}
"""


def build_cjk_pdf(path):
    doc = pymupdf.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)
    y = 150
    for line in LINES:
        x = 80.0
        for offset in range(0, len(line), CHUNK):
            chunk = line[offset:offset + CHUNK]
            page.insert_text((x, y), chunk, fontname="china-s", fontsize=BODY_FONT)
            x += len(chunk) * BODY_FONT
        y += 30
    doc.save(path)
    doc.close()


REAL_PDF = (
    ROOT
    / "papers"
    / "Arias 等 - Toward designing user-centered idle behaviors for social robots in the"
    / "Arias 等 - Toward designing user-centered idle behaviors for social robots in the home_译文（无水印）.pdf"
)


def make_pdf(run):
    """Prefer the deterministic generated CJK PDF; fall back to the real one."""
    pdf = run / "cjk-selection.pdf"
    try:
        build_cjk_pdf(pdf)
        return pdf
    except Exception as error:  # pymupdf built without the china-s CJK font
        if not REAL_PDF.exists():
            raise SystemExit(
                f"cannot build the generated CJK PDF ({error}) and the real repro PDF "
                f"is missing: {REAL_PDF}"
            )
        import shutil

        print(f"NOTE: generated CJK PDF unavailable ({error}); copying the real repro PDF")
        shutil.copyfile(REAL_PDF, pdf)
        return pdf


def _band_row(img, ref, box, dy):
    """Metrics for one band row sampled ``dy`` px below the band top.

    A BabelDOC CJK glyph nearly fills its em box, so every row inside a
    selection band crosses glyph ink and canvas anti-aliasing.  When a clean
    reference screenshot (same page, no selection) is available, only the
    pixels that are plain white paper there are inspected: seams become white
    runs and double-painted stripes become two shades of the same tint, without
    glyph fringes polluting the shade sigma.
    """
    import numpy as np

    height, width = img.shape[:2]
    x0 = int(math.ceil(box["x"])) + 2
    x1 = int(math.floor(box["x"] + box["w"])) - 2
    y = int(round(box["y"])) + dy
    if x1 - x0 < 8 or not (0 <= y < height):
        return None
    row = img[y, x0:x1].astype(int)
    if ref is not None:
        ref_row = ref[y, x0:x1].astype(int)
        paper = ref_row.min(axis=1) >= 248
    else:
        paper = np.ones(len(row), dtype=bool)
    r, g, b = row[:, 0], row[:, 1], row[:, 2]
    lum = (r + g + b) / 3.0
    # The app tint is rgba(10,132,255,0.26) over the white page: the blue channel
    # stays at 255 while red drops by ~65.  Pixels blended into glyph ink have a
    # low blue channel, so they are not "paint on paper".
    paint = paper & (b >= 250) & (b - r >= 30) & (lum >= 160)
    unpainted = paper & (lum >= 235) & (b - r < 20)
    # Selecting text switches the canvas from LCD to grayscale anti-aliasing, so
    # a column that was plain paper in the reference can carry a faint glyph
    # fringe in the preview.  That column is still covered by the band (the tint
    # multiplies underneath it) - only a column that stayed *white paper* is a
    # seam, which is what the gap/coverage checks below are for.
    covered = paint | (paper & (lum < 235))
    paper_count = int(paper.sum())
    paint_count = int(paint.sum())
    covered_count = int(covered.sum())
    # Longest unpainted (white) run inside the band: a seam between two spans
    # shows up here, glyph ink never does.
    longest = 0
    run = 0
    for value in unpainted:
        if value:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    sigma = float(np.std(lum[paint])) if paint_count >= 20 else None
    return {
        "y": y,
        "dy": dy,
        "width": int(x1 - x0),
        "paper": paper_count,
        "paint": paint_count,
        "coverage": round(covered_count / paper_count, 4) if paper_count else None,
        "paint_frac": round(float(paint.mean()), 3),
        "gap_max": int(longest),
        "sigma": None if sigma is None else round(sigma, 2),
    }


def measure_band(img, box, ref=None):
    """Measure the row 2-5px below the band top that shows the most paper tint."""
    best = None
    for dy in (2, 3, 4, 5):
        metrics = _band_row(img, ref, box, dy)
        if metrics is None:
            continue
        if best is None or metrics["paint"] > best["paint"]:
            best = metrics
    return best


def _load_image(path):
    import numpy as np
    from PIL import Image

    return np.asarray(Image.open(path).convert("RGB"))


def baseline_metrics(path, report):
    """Measure the stored pre-fix screenshot and prove the thresholds bite."""
    if not path.exists():
        report.note(f"baseline screenshot missing, skipped: {path}")
        return []
    img = _load_image(path)
    import numpy as np

    a = img.astype(int)
    # The selection was painted with rgba(10,132,255,0.28) over white: single
    # paint is ~(187,221,255), a double-painted stripe ~(138,197,255).  The
    # app's own blue highlight marks use #bcdcff, so only look above them.
    single = (abs(a[:, :, 0] - 187) <= 4) & (abs(a[:, :, 1] - 221) <= 4) & (abs(a[:, :, 2] - 255) <= 2)
    double = (abs(a[:, :, 0] - 138) <= 5) & (abs(a[:, :, 1] - 197) <= 5) & (abs(a[:, :, 2] - 255) <= 2)
    mask = (single | double)
    mask[520:, :] = False  # ignore the page's pre-existing highlight marks
    rows = np.where(mask.sum(axis=1) >= 40)[0]
    if not len(rows):
        report.note("baseline screenshot: no selection band found, skipped")
        return []
    bands = []
    start = prev = int(rows[0])
    for y in rows[1:]:
        if y - prev > 2:
            bands.append((start, prev))
            start = int(y)
        prev = int(y)
    bands.append((start, prev))

    out = []
    for y0, y1 in bands:
        cols = np.where(mask[y0:min(y1 + 1, y0 + 5)].any(axis=0))[0]
        if not len(cols) or y1 - y0 < 6:
            continue
        box = {"x": float(cols.min()), "y": float(y0), "w": float(cols.max() - cols.min() + 1), "h": float(y1 - y0 + 1)}
        metrics = measure_band(img, box)
        if not metrics:
            continue
        metrics["band"] = f"y={y0}..{y1} x={int(box['x'])}..{int(box['x'] + box['w'])}"
        metrics["fails_gap"] = metrics["gap_max"] > MAX_GAP_PX
        metrics["fails_sigma"] = metrics["sigma"] is None or metrics["sigma"] >= MAX_SIGMA
        out.append(metrics)
    return out


class Report:
    def __init__(self):
        self.failures = []
        self.notes = []

    def check(self, condition, message):
        if not condition:
            self.failures.append(message)
        return bool(condition)

    def note(self, message):
        self.notes.append(message)
        print("NOTE:", message)


def _wait_picks(page, count, timeout=2500):
    try:
        page.wait_for_function(
            "n => document.querySelectorAll('.r-pick').length === n", arg=count, timeout=timeout
        )
        return True
    except Exception:
        return False


def _show_toolbar(page, report, label, timeout=4000):
    try:
        page.wait_for_selector("#sel-toolbar", state="visible", timeout=timeout)
    except Exception:
        pass
    return report.check(
        page.locator("#sel-toolbar").is_visible(), f"selection toolbar did not appear {label}"
    )


def _drag(page, target):
    page.mouse.move(target["start"]["x"], target["start"]["y"])
    page.mouse.down()
    page.mouse.move(target["end"]["x"], target["end"]["y"], steps=24)
    page.mouse.up()


def _norm(text):
    return re.sub(r"\s+", "", text or "")


def main():
    QA_DIR.mkdir(parents=True, exist_ok=True)
    run = QA_DIR / ("run-" + uuid.uuid4().hex[:6])
    run.mkdir()
    config.UPLOAD_DIR = run
    annotations.ANNOTATION_DIR = run / "annotations"
    annotations.ANNOTATION_DIR.mkdir(parents=True, exist_ok=True)
    pdf = make_pdf(run)

    report = Report()
    server = make_server("127.0.0.1", 0, app.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    metrics = {"run": str(run)}
    picks = marks = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                channel="msedge", headless=True, args=["--no-proxy-server"]
            )
            try:
                context = browser.new_context(
                    viewport={"width": 1440, "height": 1000}, device_scale_factor=1
                )
                try:
                    context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
                except Exception as error:  # clipboard permissions are best effort
                    report.note(f"clipboard permissions unavailable: {error}")
                page = context.new_page()
                errors = []
                console_errors = []
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on(
                    "console",
                    lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
                )
                page.goto(f"{base}/viewer?path=" + str(pdf))
                page.wait_for_selector(".r-page.painted", timeout=30000)
                page.wait_for_selector(".r-sheet .r-text span", timeout=30000)
                page.wait_for_timeout(900)

                lines = page.evaluate(COLLECT_LINES)
                metrics["pdf_lines"] = [
                    {"spans": line["spans"], "text": line["text"][:12]} for line in lines
                ]
                report.check(len(lines) >= SELECT_LINE + SELECT_COUNT, f"PDF text layer has too few lines: {len(lines)}")
                report.check(
                    all(line["spans"] >= 2 for line in lines[: SELECT_LINE + SELECT_COUNT]),
                    "generated PDF did not produce multi-span lines: " + str([line["spans"] for line in lines]),
                )

                target = page.evaluate(DRAG_TARGET, [SELECT_LINE, SELECT_COUNT])
                report.check(bool(target), "could not locate drag target spans")
                if not target:
                    raise AssertionError("no drag target; text layer missing")

                # ---- 1) drag-select three body lines -------------------------
                _drag(page, target)
                _show_toolbar(page, report, "after the drag")

                _wait_picks(page, target["expectedLines"])
                page.wait_for_timeout(150)
                range_info = page.evaluate(RANGE_LINES)
                sel_text = range_info["text"]
                range_lines = range_info["lines"]
                picks = page.evaluate(BOXES, ".r-pick")
                picks.sort(key=lambda b: b["y"])
                picks_inside_layer = page.evaluate(
                    "() => [...document.querySelectorAll('.r-pick')].every((el) => !!el.closest('.r-select'))"
                )

                metrics["selection"] = {
                    "text": sel_text[:60],
                    "lines": len(range_lines),
                    "expected_lines": target["expectedLines"],
                    "picks": len(picks),
                    "picks_in_r_select": picks_inside_layer,
                    "picks_geometry": [
                        {"x": round(b["x"], 2), "y": round(b["y"], 2), "w": round(b["w"], 2), "h": round(b["h"], 2)}
                        for b in picks
                    ],
                    "range_lines": [
                        {"x": round(l["x"], 2), "y": round(l["y"], 2), "w": round(l["w"], 2), "h": round(l["h"], 2)}
                        for l in range_lines
                    ],
                }

                report.check(bool(_norm(sel_text)), "window.getSelection() is empty after the drag")
                leading = _norm(LINES[SELECT_LINE])
                selection_norm = _norm(sel_text)
                # A drag started 2px inside the first glyph may report offset 1,
                # so accept the first line with or without its first character.
                report.check(
                    selection_norm.startswith(leading) or selection_norm.startswith(leading[1:]),
                    f"selected text starts with {selection_norm[:14]!r}, expected the dragged line "
                    f"{leading[:14]!r}",
                )
                expected_tail = _norm(LINES[SELECT_LINE + SELECT_COUNT - 1])
                report.check(
                    expected_tail and expected_tail in selection_norm,
                    f"selected text does not contain the last touched line: {sel_text[:50]!r}",
                )
                report.check(
                    len(range_lines) == target["expectedLines"],
                    f"selection covers {len(range_lines)} visual lines, expected {target['expectedLines']}",
                )
                report.check(
                    len(picks) == target["expectedLines"],
                    f"expected one .r-pick band per visual line ({target['expectedLines']}), got {len(picks)} "
                    "(0 means the native ::selection paint is still in charge)",
                )
                if picks:
                    report.check(picks_inside_layer, "selection bands are not inside the .r-select overlay layer")
                    for index, (band, line) in enumerate(zip(picks, range_lines)):
                        dx = abs(band["x"] - line["x"])
                        dright = abs((band["x"] + band["w"]) - (line["x"] + line["w"]))
                        report.check(
                            dx <= 2.0 and dright <= 2.0,
                            f"band {index}: x/width {band['x']:.1f}..{band['x'] + band['w']:.1f} vs glyph extremes "
                            f"{line['x']:.1f}..{line['x'] + line['w']:.1f} (dx {dx:.1f}, dright {dright:.1f})",
                        )
                    heights = [band["h"] for band in picks]
                    report.check(
                        max(heights) - min(heights) <= 1.5,
                        f"band heights differ by {max(heights) - min(heights):.2f}px (>1.5): {heights}",
                    )
                    for index in range(len(picks) - 1):
                        upper = picks[index]
                        lower = picks[index + 1]
                        overlap = (upper["y"] + upper["h"]) - lower["y"]
                        report.check(
                            overlap <= 0.5,
                            f"band {index} and {index + 1} vertically overlap by {overlap:.2f}px (>0.5): "
                            "double-painted stripe",
                        )

                # ---- 2) pixel paint on the bands ------------------------------
                preview_png = run / "preview.png"
                page.screenshot(path=str(preview_png))
                # Reference for "which pixels are plain white paper": hide the
                # tint bands for a moment while the selection is still alive.
                # (The native selection itself switches the canvas from LCD to
                # grayscale anti-aliasing, so a screenshot taken before the drag
                # would not have the same glyph pixels.)
                page.evaluate(
                    "() => document.querySelectorAll('.r-pick').forEach((el) => { el.dataset.wasVisible = el.style.visibility; el.style.visibility = 'hidden'; })"
                )
                page.wait_for_timeout(120)
                reference_png = run / "reference.png"
                page.screenshot(path=str(reference_png))
                page.evaluate(
                    "() => document.querySelectorAll('.r-pick').forEach((el) => { el.style.visibility = el.dataset.wasVisible || ''; delete el.dataset.wasVisible; })"
                )
                reference_img = _load_image(reference_png)
                img = _load_image(preview_png)
                # Pre-fix fallback: measure the native paint inside the glyph
                # extents the selection reports, so the baseline run still
                # prints meaningful numbers instead of stopping at "no bands".
                measure_boxes = picks or [
                    {"x": line["x"], "y": line["y"], "w": line["w"], "h": line["h"]} for line in range_lines
                ]
                paint_metrics = []
                for index, box in enumerate(measure_boxes):
                    item = measure_band(img, box, reference_img if picks else None)
                    if not item:
                        report.check(False, f"band {index}: could not sample the screenshot")
                        continue
                    item["source"] = "r-pick" if picks else "native-selection"
                    paint_metrics.append(item)
                    report.check(
                        item["gap_max"] <= MAX_GAP_PX,
                        f"band {index}: {item['gap_max']}px unpainted run inside the band (> {MAX_GAP_PX}px), "
                        f"sample row dy={item['dy']}",
                    )
                    report.check(
                        item["sigma"] is not None and item["sigma"] < MAX_SIGMA,
                        f"band {index}: shade sigma {item['sigma']} >= {MAX_SIGMA} "
                        f"(double-painted stripes), sample row dy={item['dy']}",
                    )
                    if picks:
                        # Only meaningful with the in-selection reference that
                        # tells plain paper columns apart from glyph ink.
                        report.check(
                            item["coverage"] is not None and item["coverage"] >= 0.995,
                            f"band {index}: only {item['coverage']} of the paper columns are painted "
                            f"(sample row dy={item['dy']}); white seams are back",
                        )
                metrics["paint"] = paint_metrics

                # ---- 3) native ::selection must not paint --------------------
                style_info = page.evaluate(SELECTION_STYLE)
                metrics["selection_style"] = style_info
                # PDF.js text is transparent over the canvas. An opaque global
                # selection foreground repaints it in a different font/colour.
                for theme in ("light", "dark"):
                    page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
                    selected_style = page.evaluate(SELECTION_STYLE)
                    if selected_style.get("supported"):
                        report.check(
                            selected_style.get("color") in {"transparent", "rgba(0, 0, 0, 0)"},
                            f"{theme}: selected PDF text overprints the canvas: {selected_style}",
                        )
                if style_info.get("supported"):
                    background = (style_info.get("background") or "").replace(" ", "").lower()
                    transparent = (
                        background in {"", "transparent", "rgba(0,0,0,0)"}
                        or (background.startswith("rgba(") and background.endswith(",0)"))
                    )
                    report.check(
                        transparent,
                        f".r-text ::selection still paints {background!r}; the native per-span selection paint is back",
                    )
                else:
                    report.note(
                        "this browser does not expose getComputedStyle(el, '::selection'); guard skipped"
                    )

                # ---- 4) copy action keeps the text and consumes the preview --
                copy_ok = False
                if page.locator("#sel-copy").is_visible():
                    page.locator("#sel-copy").click()
                    page.wait_for_timeout(300)
                    toast = page.inner_text("#toasts")
                    report.check("已复制" in toast, f"copy action did not report success: {toast!r}")
                    try:
                        copied = page.evaluate("() => navigator.clipboard.readText()")
                        metrics["copied_text"] = (copied or "")[:60]
                        report.check(
                            _norm(copied) == _norm(sel_text),
                            "copied text differs from the selected text: "
                            f"{_norm(copied)[:40]!r} != {_norm(sel_text)[:40]!r}",
                        )
                        copy_ok = True
                    except Exception as error:
                        report.note(f"clipboard read unavailable ({error}); verified copy by toast only")
                    report.check(
                        bool(_wait_picks(page, 0, timeout=2000)),
                        ".r-pick bands were not cleared after copy consumed the selection",
                    )
                    report.check(
                        page.evaluate("() => window.getSelection().isCollapsed"),
                        "selection was not collapsed after copy",
                    )
                else:
                    report.check(False, "copy button in the selection toolbar is not visible")
                metrics["copy_ok"] = copy_ok

                # ---- 5) commit one highlight, geometry must match preview -----
                target = page.evaluate(DRAG_TARGET, [SELECT_LINE, SELECT_COUNT])
                _drag(page, target)
                _show_toolbar(page, report, "after the second drag")
                _wait_picks(page, target["expectedLines"])
                page.wait_for_timeout(150)
                preview = page.evaluate(BOXES, ".r-pick")
                preview.sort(key=lambda b: b["y"])
                page.locator("#sel-toolbar .r-dot.yellow").click()
                page.wait_for_timeout(600)
                mark_boxes = page.evaluate(BOXES, ".r-mark")
                ids = page.evaluate(
                    "() => [...new Set([...document.querySelectorAll('.r-mark')].map((el) => el.dataset.id))]"
                )
                metrics["highlight"] = {
                    "annotations": len(ids),
                    "marks": len(mark_boxes),
                    "preview_bands": len(preview),
                    "mark_geometry": [
                        {"x": round(b["x"], 2), "y": round(b["y"], 2), "w": round(b["w"], 2), "h": round(b["h"], 2)}
                        for b in sorted(mark_boxes, key=lambda b: b["y"])
                    ],
                }
                report.check(len(ids) == 1, f"clicking one colour dot created {len(ids)} highlights: {ids}")
                report.check(
                    len(mark_boxes) == target["expectedLines"],
                    f"committed highlight has {len(mark_boxes)} bands, expected {target['expectedLines']}",
                )
                if preview and mark_boxes:
                    mark_sorted = sorted(mark_boxes, key=lambda b: b["y"])
                    for index, (pre, mark) in enumerate(zip(preview, mark_sorted)):
                        deltas = {
                            "dx": abs(pre["x"] - mark["x"]),
                            "dy": abs(pre["y"] - mark["y"]),
                            "dw": abs(pre["w"] - mark["w"]),
                            "dh": abs(pre["h"] - mark["h"]),
                        }
                        worst = max(deltas.values())
                        report.check(
                            worst <= 2.0,
                            f"committed band {index} does not match the preview geometry within 2px: {deltas}",
                        )
                report.check(
                    bool(_wait_picks(page, 0, timeout=2500)),
                    ".r-pick preview bands were not cleared after the highlight was committed",
                )
                report.check(
                    page.evaluate("() => window.getSelection().isCollapsed"),
                    "selection was not collapsed after committing the highlight",
                )
                if page.locator("#anno-count").count():
                    report.check(
                        page.inner_text("#anno-count").strip() == "1",
                        f"annotation counter is {page.inner_text('#anno-count')!r}, expected '1'",
                    )
                committed_png = run / "committed.png"
                page.screenshot(path=str(committed_png))

                # ---- 6) clicking elsewhere collapses the selection -----------
                target = page.evaluate(DRAG_TARGET, [SELECT_LINE, SELECT_COUNT])
                _drag(page, target)
                _show_toolbar(page, report, "after the third drag")
                report.check(
                    bool(_wait_picks(page, target["expectedLines"])),
                    "the overlay did not come back for the second drag",
                )
                box = page.locator(".r-sheet .r-page").bounding_box()
                page.mouse.click(box["x"] + 30, box["y"] + 24)
                page.wait_for_timeout(350)
                collapsed = page.evaluate("() => ({ collapsed: window.getSelection().isCollapsed, text: window.getSelection().toString() })")
                metrics["collapse"] = collapsed
                report.check(collapsed["collapsed"], f"clicking a blank page area did not collapse the selection: {collapsed}")
                report.check(
                    bool(_wait_picks(page, 0, timeout=2000)),
                    f"selection bands were not cleared after collapsing ({page.evaluate('() => document.querySelectorAll(\".r-pick\").length')} left)",
                )
                report.check(
                    not page.locator("#sel-toolbar").is_visible(),
                    "selection toolbar stayed visible after the selection collapsed",
                )
                collapsed_png = run / "collapsed.png"
                page.screenshot(path=str(collapsed_png))

                # ---- 7) baseline evidence: thresholds must bite --------------
                baseline = baseline_metrics(BASELINE_SHOT, report) if BASELINE_SHOT.exists() else []
                metrics["baseline"] = baseline
                if baseline:
                    failing = [
                        item for item in baseline if item["fails_gap"] or item["fails_sigma"]
                    ]
                    report.check(
                        bool(failing),
                        "stored pre-fix baseline passes the new thresholds - they are not meaningful",
                    )

                # ---- 8) no JS errors -----------------------------------------
                report.check(not errors, "page errors: " + " | ".join(errors))
                report.check(not console_errors, "console errors: " + " | ".join(console_errors))
                metrics["js_errors"] = errors
                metrics["console_errors"] = console_errors

                # keep the newest evidence easy to find
                for name, source in (
                    ("preview.png", preview_png),
                    ("committed.png", committed_png),
                    ("collapsed.png", collapsed_png),
                ):
                    try:
                        (QA_DIR / f"last-{name}").write_bytes(source.read_bytes())
                    except OSError:
                        pass
                (QA_DIR / "last-metrics.json").write_text(
                    json.dumps(metrics, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
                )
            finally:
                browser.close()
    finally:
        server.shutdown()

    print()
    print("=== selection paint metrics ===")
    print(json.dumps(metrics, ensure_ascii=False, indent=2, default=str))
    if report.failures:
        print()
        print(f"SELECTION PAINT FAIL ({len(report.failures)} problem(s)):")
        for failure in report.failures:
            print("  -", failure)
        raise SystemExit(1)
    print()
    print(
        "SELECTION PAINT PASS: 3 drag-selected lines -> one continuous, uniform "
        f".r-pick band per line (gap<={MAX_GAP_PX}px, sigma<{MAX_SIGMA}); native ::selection "
        "paint hidden; toolbar/copy/commit/collapse OK; no JS errors"
    )


if __name__ == "__main__":
    main()
