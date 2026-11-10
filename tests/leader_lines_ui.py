"""Browser regression test: rounded orthogonal leader lines (页边注引线).

Run:  python tests/leader_lines_ui.py        (needs playwright + msedge)

With margin mode on and 3+ carded annotations, for every `.r-mlink path`:

  * the `d` commands are only M / L / Q (or A), every L segment is axis
    aligned (|dx| < 0.5 or |dy| < 0.5) and there are >= 2 rounded corners;
  * the first point lands within 1px of the annotation anchor (end / start of
    the first highlighted line) and the last point within 1px of the card's
    side edge and connection y (card top + 17);
  * no leader point crosses a card rectangle (only the terminating edge may
    touch) and no two leader polylines intersect;
  * after zoom-in and zoom-out the endpoints still match the same anchors
    within 1px and all the geometry assertions still hold.

State is isolated under .tmp/qa-features/; server on an ephemeral port; the
browser/server are always closed.  Screenshots stay in the run folder.
"""

from __future__ import annotations

import math
import re
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
RUN = (ROOT / ".tmp" / "qa-features" / ("leaders-" + uuid.uuid4().hex[:8])).resolve()
RUN.mkdir(parents=True, exist_ok=True)

config.UPLOAD_DIR = RUN
annotations.ANNOTATION_DIR = RUN / "annotations"

PDF = RUN / "leaders.pdf"
doc = pymupdf.open()
page = doc.new_page(width=900, height=700)
# One column on the right half of the page: every card lands in the right rail.
for index, y in enumerate(range(70, 650, 24)):
    page.insert_text(
        (470, y),
        f"Leader line source sentence {index + 1:02d} with enough words to select.",
        fontsize=13,
    )
doc.save(PDF)
doc.close()

CARD_COUNT = 4
HIGHLIGHTS = [(0, 2), (3, 2), (6, 2), (9, 2)]  # (start line, line count)

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

metrics: dict[str, object] = {}


def select_text_lines(pg, start: int, count: int = 2) -> None:
    """Select ``count`` visual lines of the (single) text column."""
    pg.evaluate(
        """(args) => {
          const [start, count] = args;
          const page = document.querySelector('.r-sheet .r-page').getBoundingClientRect();
          const spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 4 && r.left > page.left && r.right < page.right);
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


def read_geometry(pg) -> dict:
    """Cards, leaders (with their owning card id) and mark anchors."""
    return pg.evaluate(
        """() => {
          const rect = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          };
          const cards = [...document.querySelectorAll('.r-mcard')].map((card) => ({
            id: card.dataset.id,
            side: card.closest('.r-margin-left') ? 'left' : 'right',
            rect: rect(card),
          }));
          const links = [];
          for (const layer of document.querySelectorAll('.r-margin')) {
            const side = layer.classList.contains('r-margin-left') ? 'left' : 'right';
            let current = null;
            for (const child of layer.children) {
              if (child.classList.contains('r-mcard')) {
                current = child.dataset.id;
              } else if (child.classList.contains('r-mlink')) {
                const path = child.querySelector('path');
                links.push({
                  id: current,
                  side,
                  d: path ? path.getAttribute('d') || '' : '',
                  rect: rect(child),
                });
              }
            }
          }
          const marks = {};
          for (const mark of document.querySelectorAll('.r-mark')) {
            const id = mark.dataset.id;
            if (!marks[id]) marks[id] = [];
            marks[id].push(rect(mark));
          }
          return {
            marginMode: document.body.classList.contains('margin-notes'),
            marginLeft: document.body.classList.contains('margin-left'),
            cards,
            links,
            marks,
          };
        }"""
    )


def parse_path(d: str) -> list[dict]:
    tokens = re.findall(
        r"([MLQA])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)"
        r"(?:\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?))?"
        r"(?:\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?))?",
        d,
    )
    assert tokens, f"cannot parse path data: {d!r}"
    commands = []
    for token in tokens:
        command = token[0]
        values = [float(value) for value in token[1:] if value != ""]
        commands.append({"cmd": command, "values": values})
    return commands


def sample_polyline(commands: list[dict], samples_per_curve: int = 8) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    current = (0.0, 0.0)
    for item in commands:
        command, values = item["cmd"], item["values"]
        if command == "M":
            current = (values[0], values[1])
            points.append(current)
        elif command == "L":
            current = (values[0], values[1])
            points.append(current)
        elif command == "Q":
            control = (values[0], values[1])
            end = (values[2], values[3])
            for step in range(1, samples_per_curve + 1):
                t = step / samples_per_curve
                x = (1 - t) ** 2 * current[0] + 2 * (1 - t) * t * control[0] + t**2 * end[0]
                y = (1 - t) ** 2 * current[1] + 2 * (1 - t) * t * control[1] + t**2 * end[1]
                points.append((x, y))
            current = end
        elif command == "A":
            # Arc command: the endpoint is the last pair; approximate the arc by
            # a straight run for crossing/overlap sampling (implementation uses Q).
            end = (values[-2], values[-1])
            current = end
            points.append(end)
    return points


def segments_of(points: list[tuple[float, float]]) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    return list(zip(points, points[1:]))


def orientation(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def segments_intersect(a, b, c, d) -> bool:
    """Proper or touching intersection, ignoring shared endpoints."""
    for p in (a, b):
        for q in (c, d):
            if math.hypot(p[0] - q[0], p[1] - q[1]) < 0.6:
                return False

    def on_segment(p, q, r):
        return (
            min(p[0], r[0]) - 1e-6 <= q[0] <= max(p[0], r[0]) + 1e-6
            and min(p[1], r[1]) - 1e-6 <= q[1] <= max(p[1], r[1]) + 1e-6
        )

    o1 = orientation(a, b, c)
    o2 = orientation(a, b, d)
    o3 = orientation(c, d, a)
    o4 = orientation(c, d, b)
    if ((o1 > 0) != (o2 > 0)) and ((o3 > 0) != (o4 > 0)):
        return True
    if abs(o1) < 1e-9 and on_segment(a, c, b):
        return True
    if abs(o2) < 1e-9 and on_segment(a, d, b):
        return True
    if abs(o3) < 1e-9 and on_segment(c, a, d):
        return True
    if abs(o4) < 1e-9 and on_segment(c, b, d):
        return True
    return False


def point_inside(rect: dict, x: float, y: float, inset: float = 1.5) -> bool:
    return (
        rect["x"] + inset < x < rect["x"] + rect["w"] - inset
        and rect["y"] + inset < y < rect["y"] + rect["h"] - inset
    )


def analyse(pg, label: str) -> dict:
    geometry = read_geometry(pg)
    assert geometry["marginMode"], f"{label}: margin mode is off"
    cards = {card["id"]: card for card in geometry["cards"]}
    links = [link for link in geometry["links"] if link["id"] in cards]
    metrics[f"{label} cards/links"] = [len(cards), len(geometry["links"])]
    assert len(links) >= 3, f"{label}: only {len(links)} leaders for {len(cards)} cards"
    assert len(geometry["links"]) == len(cards), (
        f"{label}: {len(geometry['links'])} leaders for {len(cards)} cards"
    )

    max_l_deviation = 0.0
    max_anchor_delta = 0.0
    max_card_delta = 0.0
    corner_counts = []
    overlaps = 0
    sampled: dict[str, list[tuple[float, float]]] = {}
    all_segments: dict[str, list] = {}

    for link in links:
        card = cards[link["id"]]
        commands = parse_path(link["d"])
        commands_used = {item["cmd"] for item in commands}
        assert commands_used <= {"M", "L", "Q", "A"}, (
            f"{label}: leader {link['id']} uses unsupported commands {commands_used}"
        )
        assert commands[0]["cmd"] == "M", f"{label}: leader {link['id']} does not start with M"
        corners = sum(1 for item in commands if item["cmd"] in ("Q", "A"))
        corner_counts.append(corners)
        assert corners >= 2, f"{label}: leader {link['id']} has {corners} corners"

        # Every L segment must be axis aligned.
        current = (commands[0]["values"][0], commands[0]["values"][1])
        for item in commands[1:]:
            values = item["values"]
            if item["cmd"] == "L":
                target = (values[0], values[1])
                dx, dy = abs(target[0] - current[0]), abs(target[1] - current[1])
                max_l_deviation = max(max_l_deviation, min(dx, dy))
                assert dx < 0.5 or dy < 0.5, (
                    f"{label}: leader {link['id']} L segment is not axis aligned "
                    f"(dx={dx:.2f}, dy={dy:.2f})"
                )
                current = target
            elif item["cmd"] == "Q":
                current = (values[2], values[3])
            elif item["cmd"] == "A":
                current = (values[-2], values[-1])

        # Map SVG-local samples into viewport coordinates.
        local = sample_polyline(commands)
        offset = (link["rect"]["x"], link["rect"]["y"])
        points = [(offset[0] + x, offset[1] + y) for x, y in local]
        sampled[link["id"]] = points
        all_segments[link["id"]] = segments_of(points)

        # First point == annotation anchor.
        bands = geometry["marks"].get(link["id"]) or []
        assert bands, f"{label}: no mark bands for {link['id']}"
        first_band = sorted(bands, key=lambda band: band["y"])[0]
        if link["side"] == "left":
            anchor = (first_band["x"], first_band["y"] + first_band["h"] / 2)
        else:
            anchor = (first_band["x"] + first_band["w"], first_band["y"] + first_band["h"] / 2)
        anchor_delta = math.hypot(points[0][0] - anchor[0], points[0][1] - anchor[1])
        max_anchor_delta = max(max_anchor_delta, anchor_delta)
        assert anchor_delta <= 1.0, (
            f"{label}: leader {link['id']} starts {anchor_delta:.2f}px from the anchor "
            f"({points[0]} vs {anchor})"
        )

        # Last point == card connection point (side edge, top + 17).
        card_rect = card["rect"]
        if link["side"] == "left":
            connection = (card_rect["x"] + card_rect["w"], card_rect["y"] + 17)
        else:
            connection = (card_rect["x"], card_rect["y"] + 17)
        card_delta = math.hypot(points[-1][0] - connection[0], points[-1][1] - connection[1])
        max_card_delta = max(max_card_delta, card_delta)
        assert card_delta <= 1.0, (
            f"{label}: leader {link['id']} ends {card_delta:.2f}px from the card edge "
            f"({points[-1]} vs {connection})"
        )

        # No sampled point may sit inside any card rectangle.
        for x, y in points:
            for other in geometry["cards"]:
                if point_inside(other["rect"], x, y):
                    overlaps += 1
                    raise AssertionError(
                        f"{label}: leader {link['id']} crosses card {other['id']} at "
                        f"({x:.1f}, {y:.1f})"
                    )

    # No two leader polylines may intersect.
    ids = sorted(all_segments)
    intersections = 0
    for index in range(len(ids)):
        for other in range(index + 1, len(ids)):
            for a, b in all_segments[ids[index]]:
                for c, d in all_segments[ids[other]]:
                    if segments_intersect(a, b, c, d):
                        intersections += 1
    assert intersections == 0, f"{label}: {intersections} leader-leader intersections"

    result = {
        "leaders": len(links),
        "corners": corner_counts,
        "max_L_deviation": round(max_l_deviation, 3),
        "max_anchor_delta": round(max_anchor_delta, 3),
        "max_card_delta": round(max_card_delta, 3),
        "card_point_overlaps": overlaps,
        "leader_intersections": intersections,
    }
    metrics[label] = result
    return result


with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1440, "height": 1100})
    errors: list[str] = []
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    started = time.time()

    try:
        pg.goto(f"http://127.0.0.1:{server.server_port}/viewer?path=" + str(PDF))
        pg.wait_for_selector(".r-page.painted")
        pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
        pg.wait_for_timeout(900)

        # Create four commented highlights -> four margin cards.
        for index, (start, count) in enumerate(HIGHLIGHTS):
            ids_before = set(
                pg.eval_on_selector_all(".r-mark", "els => els.map((el) => el.dataset.id)")
            )
            select_text_lines(pg, start, count)
            pg.wait_for_timeout(350)
            assert pg.locator("#sel-toolbar").is_visible(), f"toolbar missing for card {index}"
            pg.locator("#sel-toolbar .r-dot.yellow").click()
            pg.wait_for_timeout(800)
            created = (
                set(pg.eval_on_selector_all(".r-mark", "els => els.map((el) => el.dataset.id)"))
                - ids_before
            )
            assert len(created) == 1, f"card {index}: expected one new highlight, got {created}"
            item_id = created.pop()
            mark = pg.locator(f'.r-mark[data-id="{item_id}"]').first
            box = mark.bounding_box()
            pg.mouse.click(box["x"] + 12, box["y"] + box["height"] / 2)
            pg.wait_for_timeout(450)
            assert pg.locator("#editor").is_visible(), f"editor did not open for card {index}"
            pg.locator("#editor-text").fill(f"引线说明 {index + 1}")
            pg.locator("#editor-done").click()
            pg.wait_for_timeout(450)

        marks = pg.locator(".r-mark")
        assert marks.count() >= CARD_COUNT * 2, marks.count()

        # Margin mode on: one card + leader per annotation.
        pg.locator('#reader-dock [data-action="layout"]').click()
        pg.wait_for_timeout(1600)
        assert pg.locator(".r-mcard").count() == CARD_COUNT, (
            f"margin cards: {pg.locator('.r-mcard').count()}"
        )
        assert pg.locator(".r-mlink").count() == CARD_COUNT, (
            f"leader lines: {pg.locator('.r-mlink').count()}"
        )
        base = analyse(pg, "base")
        pg.screenshot(path=str(RUN / "leaders-base.png"))

        # Zoom in: the routing is rebuilt at the new scale.
        old_zoom = pg.inner_text("#zoom-label")
        pg.locator("#btn-zoom-in").click()
        pg.wait_for_function(
            "(before) => document.querySelector('#zoom-label').textContent !== before",
            arg=old_zoom,
            timeout=15000,
        )
        pg.wait_for_timeout(1400)
        analyse(pg, "zoom-in")
        pg.screenshot(path=str(RUN / "leaders-zoom-in.png"))

        # Zoom back out: endpoints must still match.
        pg.locator("#btn-zoom-out").click()
        pg.wait_for_timeout(1400)
        analyse(pg, "zoom-out")
        pg.screenshot(path=str(RUN / "leaders-zoom-out.png"))

        # Margin mode off then on again: leaders rebuild cleanly.
        pg.locator('#reader-dock [data-action="layout"]').click()
        pg.wait_for_timeout(900)
        assert pg.locator(".r-mlink").count() == 0, "leaders survived margin mode off"
        pg.locator('#reader-dock [data-action="layout"]').click()
        pg.wait_for_timeout(1600)
        assert pg.locator(".r-mlink").count() == CARD_COUNT
        analyse(pg, "toggle-back")

        metrics["js pageerrors"] = len(errors)
        assert not errors, f"page errors: {errors}"
        metrics["runtime seconds"] = round(time.time() - started, 1)
        print("LEADER LINES UI PASS")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
    except BaseException as exc:  # noqa: BLE001 - standalone script reports everything
        print("LEADER LINES UI FAIL")
        print(f"  {''.join(traceback.format_exception_only(type(exc), exc)).strip()}")
        for key, value in metrics.items():
            print(f"  {key}: {value}")
        try:
            pg.screenshot(path=str(RUN / "leaders-failure.png"))
        except Exception:  # noqa: BLE001 - best-effort evidence
            pass
        raise
    finally:
        try:
            browser.close()
        finally:
            server.shutdown()
