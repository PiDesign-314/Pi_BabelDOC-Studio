"""Write reader annotations into a copy of the PDF, and read them back.

The reader keeps its notes in ``%APPDATA%\\BabelDOC-Studio\\annotations`` so the
translated PDFs are never touched while reading.  This module is the bridge to a
shareable file: highlights and sticky notes are written as **standard PDF
annotations** (``Highlight`` / ``Text``), so Acrobat, Edge, Preview, Zotero and
most other readers show them — and :func:`read` can load them again on another
machine where the local annotation store knows nothing about the document.

Coordinates are the same ones the reader stores: PDF page units with the origin
at the top-left corner of the page, which is also PyMuPDF's page space.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

try:  # the reader works without it; only export/import need PyMuPDF
    import pymupdf
except Exception:  # pragma: no cover - exercised on machines without the extra
    pymupdf = None

AUTHOR = "BabelDOC Studio"
SUBJECT = "BabelDOC-Studio"
SUFFIX = "_批注"


def _require() -> None:
    if pymupdf is None:
        raise RuntimeError("需要 PyMuPDF 才能读写 PDF 批注：pip install pymupdf")

# Pastel on screen, but a PDF reader paints these straight onto the glyphs, so
# they need a little more saturation to stay visible over black text.
COLORS = {
    "yellow": (1.0, 0.84, 0.10),
    "green": (0.40, 0.85, 0.52),
    "blue": (0.38, 0.70, 1.0),
    "pink": (1.0, 0.48, 0.72),
    "orange": (1.0, 0.62, 0.22),
    "purple": (0.62, 0.48, 1.0),
    "teal": (0.20, 0.78, 0.72),
    "red": (1.0, 0.40, 0.36),
}
OPACITY = 0.42
NOTE_ICON = "Comment"
NOTE_SIZE = 16.0


def default_target(source: str | Path) -> Path:
    """``论文_译文.pdf`` → ``论文_译文_批注.pdf`` next to the original.

    Saving a file that already carries the suffix overwrites it instead of
    stacking another ``_批注`` on every save.
    """
    path = Path(str(source))
    stem = path.stem
    if stem.endswith(SUFFIX):
        stem = stem[: -len(SUFFIX)]
    return path.with_name(f"{stem}{SUFFIX}.pdf")


def _color(item: dict) -> tuple[float, float, float]:
    return COLORS.get(str(item.get("color")), COLORS["yellow"])


def _clean_rects(item: dict, page: pymupdf.Page) -> list[pymupdf.Rect]:
    bounds = page.rect
    rects: list[pymupdf.Rect] = []
    for raw in item.get("rects") or []:
        try:
            x = float(raw.get("x"))
            y = float(raw.get("y"))
            w = float(raw.get("w"))
            h = float(raw.get("h"))
        except (TypeError, ValueError):
            continue
        if w < 0.6 or h < 0.6:
            continue
        rect = pymupdf.Rect(x, y, x + w, y + h) & bounds
        if rect.is_empty or rect.width < 0.6 or rect.height < 0.6:
            continue
        rects.append(rect)
    return rects


def export(
    source: str | Path,
    items,
    target: str | Path | None = None,
) -> dict:
    """Save ``source`` with every annotation baked in as a PDF annotation."""
    _require()
    origin = Path(str(source))
    destination = Path(str(target)) if target else default_target(origin)
    notes = 0
    highlights = 0
    skipped = 0

    with pymupdf.open(origin) as document:
        # Re-exporting a file that already carries our annotations (the user
        # reopened it and kept reading) replaces them instead of stacking a
        # second copy on every save.  Annotations from other tools are left
        # untouched.
        for page in document:
            try:
                existing = list(page.annots() or [])
            except Exception:
                continue
            for annot in existing:
                try:
                    if (annot.info or {}).get("subject") == SUBJECT:
                        page.delete_annot(annot)
                except Exception:
                    pass

        for item in items or []:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind not in {"highlight", "note"}:
                continue
            try:
                number = int(item.get("page") or 1)
            except (TypeError, ValueError):
                skipped += 1
                continue
            if not 1 <= number <= document.page_count:
                skipped += 1
                continue
            page = document[number - 1]
            comment = str(item.get("comment") or "").strip()

            try:
                if kind == "highlight":
                    rects = _clean_rects(item, page)
                    if not rects:
                        skipped += 1
                        continue
                    annot = page.add_highlight_annot(quads=rects)
                    highlights += 1
                else:
                    point = item.get("point") or {}
                    x = float(point.get("x") or 0) - NOTE_SIZE / 2
                    y = float(point.get("y") or 0) - NOTE_SIZE / 2
                    annot = page.add_text_annot(
                        pymupdf.Point(x, y),
                        comment or "（空白便签）",
                        icon=NOTE_ICON,
                    )
                    notes += 1
            except Exception:
                skipped += 1
                continue

            try:
                annot.set_colors(stroke=_color(item))
                if kind == "highlight":
                    annot.set_opacity(OPACITY)
                annot.set_info(
                    title=AUTHOR,
                    subject=SUBJECT,
                    content=comment,
                )
                annot.update()
            except Exception:
                skipped += 1

        destination.parent.mkdir(parents=True, exist_ok=True)
        # Re-saving a file that already has its annotations in it must not read
        # and write the same path: write beside it, then swap it in.
        same_file = destination.exists() and destination.resolve() == origin.resolve()
        written = destination
        if same_file:
            written = destination.with_name(
                f"{destination.stem}.{uuid.uuid4().hex[:8]}.tmp.pdf"
            )
        document.save(str(written), garbage=3, deflate=True)

    if written != destination:
        os.replace(written, destination)

    return {
        "path": str(destination),
        "count": highlights + notes,
        "highlights": highlights,
        "notes": notes,
        "skipped": skipped,
    }


def _rect_from_quad(points) -> pymupdf.Rect | None:
    try:
        xs = [float(points[index]) for index in range(0, len(points), 2)]
        ys = [float(points[index]) for index in range(1, len(points), 2)]
    except (TypeError, ValueError, IndexError):
        return None
    rect = pymupdf.Rect(min(xs), min(ys), max(xs), max(ys))
    return rect if not rect.is_empty else None


def read(path: str | Path) -> list[dict]:
    """Load annotations this app wrote into ``path`` (used as a fallback when the
    local annotation store is empty, e.g. a file shared from another machine)."""
    items: list[dict] = []
    if pymupdf is None:  # nothing to read without the optional dependency
        return items
    try:
        document = pymupdf.open(str(path))
    except Exception:
        return items

    with document:
        for number, page in enumerate(document, start=1):
            try:
                annots = page.annots()
            except Exception:
                continue
            for annot in annots or []:
                try:
                    info = annot.info or {}
                except Exception:
                    continue
                if info.get("subject") != SUBJECT:
                    continue
                comment = str(info.get("content") or "")
                rect = annot.rect
                if getattr(annot, "type", (None, ""))[0] == 8:
                    vertices = annot.vertices
                    rects: list[dict] = []
                    if vertices:
                        for start in range(0, len(vertices), 4):
                            piece = _rect_from_quad(
                                [value for point in vertices[start:start + 4] for value in point]
                            )
                            if piece:
                                rects.append(
                                    {
                                        "x": piece.x0,
                                        "y": piece.y0,
                                        "w": piece.width,
                                        "h": piece.height,
                                    }
                                )
                    if not rects and not rect.is_empty:
                        rects = [
                            {
                                "x": rect.x0,
                                "y": rect.y0,
                                "w": rect.width,
                                "h": rect.height,
                            }
                        ]
                    if not rects:
                        continue
                    items.append(
                        {
                            "type": "highlight",
                            "page": number,
                            "color": "yellow",
                            "rects": rects,
                            "ranges": [],
                            "text": "",
                            "comment": comment,
                        }
                    )
                elif getattr(annot, "type", (None, ""))[0] == 0:
                    items.append(
                        {
                            "type": "note",
                            "page": number,
                            "color": "pink",
                            "rects": [],
                            "ranges": [],
                            "point": {
                                "x": (rect.x0 + rect.x1) / 2,
                                "y": (rect.y0 + rect.y1) / 2,
                            },
                            "text": "",
                            "comment": comment,
                        }
                    )
    return items


def has_annotations(path: str | Path) -> bool:
    return bool(read(path))
