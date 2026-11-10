"""Browser regression test: a drag-selection band must hug the glyph em box.

The reader paints its own selection bands (``.r-pick``) because native
``::selection`` fragments on PDF.js CJK spans.  A live range reports *two*
boxes per glyph: PDF.js's span box (exactly one em tall, where the glyph is)
and the browser's font box (ascent+descent, ~1.25-1.33em, taller).  The band
builder used to size the band from ``min(rect.height, em * 1.12)`` anchored on
the *font box* and pad it by a fixed 0.6 page-space pixels, which the zoom
factor then multiplies.  The band therefore read as a tall tinted strip that
started above the text and ended well past it - the user's "划词过程的显示存在
一定问题" report on a 9pt CJK translated paper at high zoom.

Measured before the fix, band geometry relative to the selected line's em box
(the union of the PDF.js span boxes):

    zoom   band height / em   band above em   band below em
    100%        1.253 x           -1.66 px        +0.62 px
    125%        1.253 x           -1.56 px        +1.28 px
    150%        1.253 x           -2.47 px        +0.94 px
    300%        1.253 x           -3.92 px        +2.91 px
    400%        1.253 x           -5.06 px        +4.05 px

After the fix (band = em box, pad = 6% of the em box, centred on the em box):

    100%        1.120 x           -0.54 px        +0.54 px
    400%        1.120 x           -2.16 px        +2.16 px

The test drag-selects one CJK line with real mouse events at 100% and 300% and
asserts: one band, band height <= 1.16 x em, band edges within 9% of an em
(+0.4px) of the glyph box, horizontal edges at the glyph extremes, and the
committed highlight (after clicking a colour) exactly on the preview geometry.
It fails against the pre-fix builder (1.253 x em / -1.66px top) and passes now.

Run:  python tests/selection_band_geometry.py
Needs playwright + msedge and pymupdf (same harness as tests/selection_paint_ui.py).
"""

import json
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
QA_DIR = ROOT / ".tmp" / "selection-fix"

PAGE_W, PAGE_H = 900, 600
BODY_FONT = 16
CHUNK = 6
LINES = [
    "这是用于测量选择色带几何的正文示例",
    "第二行由多个独立文字片段拼接而成",
    "第三行用来验证每一行只绘制一条色带",
    "第四行是额外的干扰行不应进入选择范围",
    "第五行文字保证页面下方留有空白区域",
]
SELECT_LINE = 1
SELECT_CHARS = 8
MAX_HEIGHT_RATIO = 1.16      # band height / em box (pre-fix: 1.253)
MAX_EDGE_RATIO = 0.09        # band overhang past the em box, as a fraction of em
EDGE_SLOP = 0.4              # plus this many CSS px of layout rounding

DRAG_TARGET = r"""
(args) => {
  const [lineIndex, chars] = args;
  const page = document.querySelector('.r-sheet .r-page');
  const box = page.getBoundingClientRect();
  const spans = [...page.querySelectorAll('.r-text span')]
    .map((s) => ({ s, r: s.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 1 && r.height > 1);
  const lines = new Map();
  for (const span of spans) {
    const key = Math.round(span.r.top);
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(span);
  }
  const keys = [...lines.keys()].sort((a, b) => a - b);
  if (keys.length <= lineIndex) return null;
  const items = lines.get(keys[lineIndex]).slice().sort((a, b) => a.r.left - b.r.left);
  const upto = items.slice(0, chars);
  const em = {
    x: Math.min(...upto.map((i) => i.r.left)),
    y: Math.min(...upto.map((i) => i.r.top)),
    right: Math.max(...upto.map((i) => i.r.right)),
    bottom: Math.max(...upto.map((i) => i.r.bottom)),
  };
  return {
    start: { x: upto[0].r.left + 1, y: upto[0].r.top + upto[0].r.height / 2 },
    end: { x: upto[upto.length - 1].r.right - 1,
           y: upto[upto.length - 1].r.top + upto[upto.length - 1].r.height / 2 },
    em: { x: em.x - box.left, y: em.y - box.top, w: em.right - em.x, h: em.bottom - em.y },
    text: upto.map((i) => i.s.textContent).join(''),
  };
}
"""

MEASURE = r"""
() => {
  const page = document.querySelector('.r-sheet .r-page');
  const box = page.getBoundingClientRect();
  const out = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
  };
  return {
    picks: [...page.querySelectorAll('.r-pick')].map(out),
    marks: [...page.querySelectorAll('.r-mark')].map(out),
    text: String(window.getSelection()),
  };
}
"""

ZOOM = "() => ({ scale: window.__readerDebug().scale, label: document.querySelector('#zoom-label').textContent })"


def build_pdf(path):
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


def set_exact_zoom(page, target):
    """The reader fits the page width; resize the window until scale == target."""
    for _ in range(6):
        info = page.evaluate(ZOOM)
        if abs(info["scale"] - target) < 0.0009:
            return info
        stage = page.evaluate("() => document.querySelector('#stage').clientWidth")
        basew = page.evaluate(
            "() => document.querySelector('.r-sheet .r-page').getBoundingClientRect().width "
            "/ window.__readerDebug().scale"
        )
        need = target * basew + 48
        vp = page.viewport_size
        page.set_viewport_size(
            {"width": max(900, int(round(vp["width"] + (need - stage)))), "height": vp["height"]}
        )
        page.wait_for_timeout(420)
    return page.evaluate(ZOOM)


def drag(page, target):
    page.mouse.move(target["start"]["x"], target["start"]["y"])
    page.mouse.down()
    page.mouse.move(target["end"]["x"], target["end"]["y"], steps=16)
    page.mouse.up()
    page.wait_for_timeout(300)


class Report:
    def __init__(self):
        self.failures = []

    def check(self, ok, message):
        if not ok:
            self.failures.append(message)
        return bool(ok)


def main():
    QA_DIR.mkdir(parents=True, exist_ok=True)
    run = QA_DIR / ("geom-" + uuid.uuid4().hex[:6])
    run.mkdir()
    config.UPLOAD_DIR = run
    annotations.ANNOTATION_DIR = run / "annotations"
    annotations.ANNOTATION_DIR.mkdir(parents=True, exist_ok=True)
    pdf = run / "cjk-band.pdf"
    build_pdf(pdf)

    report = Report()
    metrics = {"run": str(run), "zoom": []}
    server = make_server("127.0.0.1", 0, app.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                channel="msedge", headless=True, args=["--no-proxy-server"]
            )
            try:
                context = browser.new_context(
                    viewport={"width": 1440, "height": 1000}, device_scale_factor=1
                )
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on(
                    "console",
                    lambda msg: errors.append("console: " + msg.text) if msg.type == "error" else None,
                )
                page.goto(f"{base}/viewer?path=" + str(pdf))
                page.wait_for_selector(".r-page.painted", timeout=30000)
                page.wait_for_selector(".r-sheet .r-text span", timeout=30000)
                page.wait_for_timeout(900)

                for zoom in (1.0, 3.0):
                    info = set_exact_zoom(page, zoom)
                    page.wait_for_timeout(300)
                    target = page.evaluate(DRAG_TARGET, [SELECT_LINE, SELECT_CHARS])
                    if not report.check(bool(target), f"zoom {zoom}: could not locate the drag target"):
                        continue
                    drag(page, target)
                    data = page.evaluate(MEASURE)
                    picks = sorted(data["picks"], key=lambda b: b["y"])
                    em = target["em"]
                    row = {
                        "zoom": info["label"],
                        "scale": round(info["scale"], 4),
                        "em": {k: round(v, 2) for k, v in em.items()},
                        "pick": {k: round(v, 2) for k, v in picks[0].items()} if picks else None,
                        "text": data["text"],
                    }
                    if picks:
                        pick = picks[0]
                        row["height_ratio"] = round(pick["h"] / em["h"], 3)
                        row["above"] = round(em["y"] - pick["y"], 2)
                        row["below"] = round((pick["y"] + pick["h"]) - (em["y"] + em["h"]), 2)
                        row["dx"] = round(pick["x"] - em["x"], 2)
                        row["dright"] = round((pick["x"] + pick["w"]) - (em["x"] + em["w"]), 2)
                    metrics["zoom"].append(row)

                    report.check(
                        len(picks) == 1,
                        f"zoom {zoom}: expected one band for a one-line selection, got {len(picks)}",
                    )
                    if not picks:
                        continue
                    pick = picks[0]
                    report.check(
                        row["height_ratio"] <= MAX_HEIGHT_RATIO,
                        f"zoom {zoom}: band is {row['height_ratio']:.3f} x em tall "
                        f"({pick['h']:.2f}px for a {em['h']:.2f}px glyph box, max {MAX_HEIGHT_RATIO}); "
                        "the band hangs past the glyphs",
                    )
                    limit = em["h"] * MAX_EDGE_RATIO + EDGE_SLOP
                    report.check(
                        row["above"] <= limit,
                        f"zoom {zoom}: band top is {row['above']:.2f}px above the glyph box "
                        f"(max {limit:.2f}px); font-box anchoring is back",
                    )
                    report.check(
                        row["below"] <= limit,
                        f"zoom {zoom}: band bottom is {row['below']:.2f}px past the glyph box "
                        f"(max {limit:.2f}px); selection tint spills below the text",
                    )
                    report.check(
                        abs(row["dx"]) <= 0.6,
                        f"zoom {zoom}: band starts {row['dx']:.2f}px off the first glyph",
                    )
                    report.check(
                        abs(row["dright"]) <= 1.5,
                        f"zoom {zoom}: band ends {row['dright']:.2f}px off the last glyph",
                    )
                    report.check(
                        abs(row["above"] - row["below"]) <= em["h"] * 0.10 + 0.3,
                        f"zoom {zoom}: band is vertically lopsided (above {row['above']:.2f}px, "
                        f"below {row['below']:.2f}px); glyphs are not centred in the band",
                    )

                # committed highlight must reuse the preview geometry exactly
                info = page.evaluate(ZOOM)
                target = page.evaluate(DRAG_TARGET, [SELECT_LINE, SELECT_CHARS])
                drag(page, target)
                preview = page.evaluate(MEASURE)
                marks_before = len(preview["marks"])
                try:
                    page.locator(".r-sel .r-dot").first.click(timeout=2500)
                    page.wait_for_timeout(600)
                except Exception as error:
                    report.check(False, f"could not commit the preview to a highlight: {error}")
                committed = page.evaluate(MEASURE)
                row = {
                    "zoom": info["label"],
                    "preview": sorted(preview["picks"], key=lambda b: b["y"]),
                    "marks": committed["marks"],
                }
                metrics["commit"] = row
                report.check(
                    len(committed["marks"]) > marks_before,
                    "clicking a colour did not paint a committed .r-mark",
                )
                if preview["picks"] and committed["marks"]:
                    pre = sorted(preview["picks"], key=lambda b: b["y"])[0]
                    mark = sorted(committed["marks"], key=lambda b: b["y"])[0]
                    deltas = {
                        "dx": abs(pre["x"] - mark["x"]),
                        "dy": abs(pre["y"] - mark["y"]),
                        "dw": abs(pre["w"] - mark["w"]),
                        "dh": abs(pre["h"] - mark["h"]),
                    }
                    metrics["commit"]["deltas"] = {k: round(v, 3) for k, v in deltas.items()}
                    report.check(
                        max(deltas.values()) <= 1.0,
                        f"committed highlight geometry differs from the preview: {deltas}",
                    )

                report.check(not errors, "page/console errors: " + " | ".join(errors))
                metrics["errors"] = errors
            finally:
                browser.close()
    finally:
        server.shutdown()

    print()
    print("=== selection band geometry ===")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))
    (run / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    if report.failures:
        print()
        print(f"SELECTION BAND GEOMETRY FAIL ({len(report.failures)} problem(s)):")
        for failure in report.failures:
            print("  -", failure)
        raise SystemExit(1)
    print()
    print(
        "SELECTION BAND GEOMETRY PASS: band hugs the em box "
        f"(height <= {MAX_HEIGHT_RATIO} x em, overhang <= {MAX_EDGE_RATIO} em + {EDGE_SLOP}px at 100% "
        "and 300%), one band per line, committed highlight matches the preview, no JS errors"
    )


if __name__ == "__main__":
    main()
