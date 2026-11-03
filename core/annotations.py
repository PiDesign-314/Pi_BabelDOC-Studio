"""Per-document annotations (highlights and notes) for the built-in reader.

Annotations live in ``%APPDATA%\\BabelDOC-Studio\\annotations\\<doc>.json`` so the
translated PDFs themselves are never modified.  Coordinates are stored in PDF
page units (scale 1.0, origin at the top-left of the page), which keeps them
valid at every zoom level.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

from . import config

ANNOTATION_DIR = config.APP_DIR / "annotations"
COLORS = {"yellow", "green", "blue", "pink"}
MAX_ITEMS = 4000
MAX_RECTS = 240
MAX_RANGES = 32


def document_id(path: str | Path) -> str:
    raw = str(Path(str(path)).resolve()).lower()
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _file(path: str | Path) -> Path:
    return ANNOTATION_DIR / f"{document_id(path)}.json"


def _number(value, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return low
    if number != number:  # NaN
        return low
    return max(low, min(high, number))


def _sanitize(items) -> list[dict]:
    cleaned: list[dict] = []
    for item in list(items or [])[:MAX_ITEMS]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind not in {"highlight", "note"}:
            continue
        color = item.get("color")
        rects = []
        for rect in list(item.get("rects") or [])[:MAX_RECTS]:
            if not isinstance(rect, dict):
                continue
            rects.append(
                {
                    "x": _number(rect.get("x"), 0, 100000),
                    "y": _number(rect.get("y"), 0, 100000),
                    "w": _number(rect.get("w"), 0, 100000),
                    "h": _number(rect.get("h"), 0, 100000),
                }
            )
        # Character offsets into the page's text layer: the precise way to
        # paint a highlight, and stable across zoom levels and re-renders.
        ranges = []
        for part in list(item.get("ranges") or [])[:MAX_RANGES]:
            if not isinstance(part, dict):
                continue
            start = int(_number(part.get("start"), 0, 5000000))
            end = int(_number(part.get("end"), 0, 5000000))
            if end <= start:
                continue
            ranges.append(
                {"page": int(_number(part.get("page"), 1, 100000)), "start": start, "end": end}
            )
        if kind == "highlight" and not rects and not ranges:
            continue
        cleaned.append(
            {
                "id": str(item.get("id") or hashlib.sha1(
                    f"{time.time()}-{len(cleaned)}".encode("utf-8")
                ).hexdigest()[:12])[:64],
                "type": kind,
                "page": int(_number(item.get("page"), 1, 100000)),
                "color": color if color in COLORS else "yellow",
                "rects": rects,
                "ranges": ranges,
                "point": {
                    "x": _number((item.get("point") or {}).get("x"), 0, 100000),
                    "y": _number((item.get("point") or {}).get("y"), 0, 100000),
                },
                "text": str(item.get("text") or "")[:4000],
                "comment": str(item.get("comment") or "")[:8000],
                "created": _number(item.get("created"), 0, 4e9),
                "updated": _number(item.get("updated"), 0, 4e9),
            }
        )
    return cleaned


def load(path: str | Path) -> dict:
    target = _file(path)
    items: list[dict] = []
    updated = 0.0
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            items = _sanitize(data.get("items"))
            updated = _number(data.get("updated"), 0, 4e9)
    except (OSError, ValueError):
        pass
    return {"path": str(path), "items": items, "updated": updated}


def save(path: str | Path, items) -> dict:
    cleaned = _sanitize(items)
    updated = time.time()
    target = _file(path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(
                {"path": str(Path(str(path)).resolve()), "updated": updated, "items": cleaned},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError as exc:
        raise OSError(f"无法保存批注：{exc}") from exc
    return {"path": str(path), "items": cleaned, "updated": updated}


def count(path: str | Path) -> int:
    value = load(path)
    return len(value["items"])


def migrate(old_path: str | Path, new_path: str | Path) -> None:
    """Keep annotations attached to a document after it is renamed."""
    source = _file(old_path)
    if not source.exists():
        return
    data = load(old_path)
    if not data["items"]:
        return
    save(new_path, data["items"])
    try:
        source.unlink()
    except OSError:
        pass


def forget(path: str | Path) -> None:
    try:
        _file(path).unlink()
    except OSError:
        pass
