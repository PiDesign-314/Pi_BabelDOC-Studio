"""Table of contents detection for the reader.

PyMuPDF's embedded outline is used when the PDF has one.  Most arXiv / NIPS
papers do not, so headings are also guessed from the text layer: bold or
larger-than-body lines, numbered section titles, and the usual section names
(Abstract / Introduction / References ...).

Results are cached under ``%APPDATA%/BabelDOC-Studio/ai/toc-<sha1>.json``
keyed by absolute path + mtime + size, so re-opening a paper is instant.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from core import config

HEURISTIC_PAGE_LIMIT = 80
MAX_HEADING_CHARS = 140

_FIGURE_RE = re.compile(
    r"^(?:fig(?:ure)?|table|algorithm|listing|equation|eq\.|scheme)\s*[\dIVXivx]+",
    re.IGNORECASE,
)
_NUMBERED_RE = re.compile(r"^(?P<num>\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(?P<title>\S.*)$")
_ROMAN_RE = re.compile(r"^(?P<num>[IVX]{1,7})\.\s+(?P<title>[A-Z0-9].*)$")
_PURE_NUMBER_RE = re.compile(r"^[\d\s.,·•\-–—]+$")
_NAMED_RE = re.compile(
    r"^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+)?"
    r"(?P<name>abstract|summary|introduction|background|related\s+work|prior\s+work|"
    r"literature\s+review|motivation|method(?:s|ology)?|approach|"
    r"model(?:\s+architecture)?|architecture|experimental\s+setup|experiments?|"
    r"evaluation|results?|discussion|analysis|ablation(?:\s+stud(?:y|ies))?|"
    r"conclusions?|future\s+work|references|bibliography|acknowledg(?:e)?ments?|"
    r"appendix(?:\s+[A-Z0-9]+)?|supplementary(?:\s+material)?)"
    r"(?P<rest>\s*[:：]?\s*\S{0,48})?$",
    re.IGNORECASE,
)

_BOLD_FONT_HINTS = ("bold", "medi", "black", "heavy", "semibold", "demibold", "demi")


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _fitz():
    try:
        import pymupdf  # type: ignore[import-not-found]
        return pymupdf
    except ImportError:  # pragma: no cover - older PyMuPDF only exposes fitz
        import fitz  # type: ignore[import-not-found]
        return fitz


def ai_dir() -> Path:
    """Folder for cached TOC / extracted text (shared with ``ai_reader``)."""
    return Path(config.APP_DIR) / "ai"


def _signature(pdf: Path) -> str:
    stat = pdf.stat()
    raw = f"{pdf.resolve()}|{int(stat.st_mtime_ns)}|{stat.st_size}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def cache_path(pdf: Path) -> Path:
    return ai_dir() / f"toc-{_signature(pdf)}.json"


def _is_bold(font: str, flags: int) -> bool:
    # PyMuPDF span flag bit 4 (value 16) means bold.
    if int(flags or 0) & 16:
        return True
    lowered = str(font or "").lower()
    return any(hint in lowered for hint in _BOLD_FONT_HINTS)


def _clean_title(text: str) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    value = value.rstrip(" \t.:：·—-")
    return value


def _norm_key(text: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(text or "").lower())


def _leading_level(text: str) -> int:
    match = re.match(r"^(\d{1,2}(?:\.\d{1,2}){0,3})", text or "")
    if match:
        return match.group(1).count(".") + 1
    return 1


def _looks_like_title(text: str) -> bool:
    letters = sum(1 for char in text if char.isalpha())
    if letters < 3:
        return False
    if _PURE_NUMBER_RE.match(text):
        return False
    return True


# --------------------------------------------------------------------------- #
# Outline
# --------------------------------------------------------------------------- #
def _read_outline(pdf: Path) -> list[dict]:
    fitz = _fitz()
    items: list[dict] = []
    try:
        with fitz.open(pdf) as doc:
            total = max(1, int(doc.page_count))
            for entry in doc.get_toc(simple=True) or []:
                if not isinstance(entry, (list, tuple)) or len(entry) < 3:
                    continue
                try:
                    level, title, page = int(entry[0]), str(entry[1] or ""), int(entry[2])
                except (TypeError, ValueError):
                    continue
                title = _clean_title(title)
                if not title:
                    continue
                if page < 1:
                    page = 1
                if page > total:
                    page = total
                items.append(
                    {
                        "title": title,
                        "page": page,
                        "level": max(1, level),
                        "y": None,
                        "score": 1.0,
                    }
                )
    except Exception:
        return []
    return items


# --------------------------------------------------------------------------- #
# Heuristic heading detection
# --------------------------------------------------------------------------- #
def _collect_lines(page) -> list[dict]:
    """Lines of a page with same-baseline fragments joined back together.

    PDF text extractors split ``1  Introduction`` or ``3.1  Encoder`` into two
    lines; joining fragments that share a baseline keeps the heading intact
    without mixing the two columns of a two-column paper (their horizontal gap
    is much larger than a word space).
    """
    try:
        data = page.get_text("dict")
    except Exception:
        return []

    fragments: list[dict] = []
    for block in data.get("blocks") or []:
        if block.get("type", 0) != 0:
            continue
        for line in block.get("lines") or []:
            spans = [
                span for span in (line.get("spans") or [])
                if str(span.get("text") or "").strip()
            ]
            if not spans:
                continue
            text = "".join(str(span.get("text") or "") for span in spans).strip()
            if not text:
                continue
            sizes = [float(span.get("size") or 0.0) for span in spans]
            bbox = line.get("bbox") or [0.0, 0.0, 0.0, 0.0]
            fragments.append(
                {
                    "text": text,
                    "x0": float(bbox[0]),
                    "y0": float(bbox[1]),
                    "x1": float(bbox[2]),
                    "y1": float(bbox[3]),
                    "size": max(sizes) if sizes else 0.0,
                    "bold": any(
                        _is_bold(str(span.get("font") or ""), int(span.get("flags") or 0))
                        for span in spans
                    ),
                }
            )

    fragments.sort(key=lambda frag: (frag["y0"], frag["x0"]))
    merged: list[dict] = []
    for frag in fragments:
        target = None
        for line in merged:
            if (
                abs(line["y0"] - frag["y0"]) <= 2.2
                and abs(line["y1"] - frag["y1"]) <= 2.6
                and -2.0 <= frag["x0"] - line["x1"] <= 22.0
            ):
                target = line
                break
        if target is None:
            merged.append(dict(frag))
            continue
        gap = frag["x0"] - target["x1"]
        joiner = " " if gap > 1.5 else ""
        target["text"] = f"{target['text']}{joiner}{frag['text']}"
        target["x1"] = max(target["x1"], frag["x1"])
        target["y1"] = max(target["y1"], frag["y1"])
        target["size"] = max(target["size"], frag["size"])
        target["bold"] = bool(target["bold"] or frag["bold"])
    return merged


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _detect_column_split(lines: list[dict], width: float) -> float | None:
    """Find the gutter of a two-column page, or ``None`` for one column.

    Long body lines are clustered by where they start.  A page where a
    meaningful chunk of long lines starts in the right half, while others end
    before the middle, is treated as two-column; the split sits between the
    left column's right edge and the right column's left edge.
    """
    wide = [line for line in lines if len(line["text"]) >= 25 and width > 0]
    if len(wide) < 8:
        return None
    left = [line for line in wide if line["x1"] < width * 0.62]
    right = [
        line for line in wide
        if width * 0.35 < line["x0"] < width * 0.78
    ]
    if len(left) < 4 or len(right) < max(4, int(len(wide) * 0.12)):
        return None
    left_x0 = _median([line["x0"] for line in left])
    right_x0 = _median([line["x0"] for line in right])
    if right_x0 - left_x0 < width * 0.15:
        return None
    return (max(line["x1"] for line in left) + right_x0) / 2


def _body_size(pages_lines: list[list[dict]]) -> float:
    """Most common font size by character count — the running body text."""
    weights: dict[float, int] = {}
    for lines in pages_lines:
        for line in lines:
            text = line["text"]
            if len(text) < 20 or _PURE_NUMBER_RE.match(text):
                continue
            bucket = round(float(line["size"]), 1)
            weights[bucket] = weights.get(bucket, 0) + len(text)
    if not weights:
        return 0.0
    return max(weights.items(), key=lambda item: item[1])[0]


def _classify(
    text: str,
    size: float,
    bold: bool,
    body: float,
    page_index: int,
) -> tuple[float, int] | None:
    norm = _clean_title(text)
    if not norm or len(norm) > MAX_HEADING_CHARS:
        return None
    if _PURE_NUMBER_RE.match(norm) or _FIGURE_RE.match(norm):
        return None
    if _looks_like_title(norm) is False:
        return None
    if norm.lower().startswith(("figure ", "table ", "algorithm ", "listing ", "equation ")):
        return None

    words = norm.split()
    styled = bool(bold) or (body > 0 and size >= body * 1.03)
    larger = body > 0 and size >= body * 1.12

    # 1) Well-known section names: Abstract, References, 3 Model Architecture ...
    named = _NAMED_RE.match(norm)
    if named and len(words) <= 7 and not norm.endswith((".", "?", "!")):
        name = (named.group("name") or "").lower()
        known_short = name in {"abstract", "references", "bibliography", "appendix"}
        if styled or known_short or larger:
            return 0.9, _leading_level(norm)

    # 2) N. Title / N.M Title / N.M.K Title
    numbered = _NUMBERED_RE.match(norm)
    if numbered and not norm.endswith((".", "?", "!")) and "...." not in norm:
        title = numbered.group("title")
        if (
            len(title.split()) <= 14
            and sum(1 for char in title if char.isalpha()) >= 3
        ):
            level = max(1, numbered.group("num").count(".") + 1)
            if bold or larger:
                return 0.84, level
            if level == 1 and len(norm) <= 72:
                return 0.66, level

    # 3) I. INTRODUCTION (IEEE style)
    roman = _ROMAN_RE.match(norm)
    if roman and not norm.endswith((".", "?", "!")):
        title = roman.group("title")
        if len(title.split()) <= 12 and sum(1 for char in title if char.isalpha()) >= 3:
            if bold or larger:
                return 0.8, 1

    # 4) Merely bigger than body text; the first page is ignored here because
    #    its large lines are the paper title and authors.
    if (
        page_index > 0
        and larger
        and size >= (body * 1.18 if body else 0)
        and len(norm) <= 90
        and not norm.endswith((".", "?", "!"))
    ):
        return 0.6, 1

    return None


def _heuristic(pdf: Path) -> list[dict]:
    fitz = _fitz()
    try:
        doc = fitz.open(pdf)
    except Exception:
        return []

    pages_lines: list[list[dict]] = []
    widths: list[float] = []
    heights: list[float] = []
    try:
        limit = min(int(doc.page_count), HEURISTIC_PAGE_LIMIT)
        for index in range(limit):
            page = doc[index]
            pages_lines.append(_collect_lines(page))
            widths.append(float(page.rect.width or 612.0))
            heights.append(float(page.rect.height or 792.0))
    finally:
        try:
            doc.close()
        except Exception:
            pass

    if not any(pages_lines):
        return []

    body = _body_size(pages_lines)
    entries: list[dict] = []
    title_fallback: list[dict] = []

    for page_index, lines in enumerate(pages_lines):
        width = widths[page_index] or 612.0
        height = heights[page_index] or 792.0
        split = _detect_column_split(lines, width)
        for line in lines:
            classified = _classify(
                line["text"], float(line["size"]), bool(line["bold"]), body, page_index
            )
            if classified is None:
                if (
                    page_index == 0
                    and body
                    and line["size"] >= body * 1.25
                    and len(line["text"]) <= 120
                    and _looks_like_title(line["text"])
                    and not _FIGURE_RE.match(line["text"])
                ):
                    title_fallback.append(
                        {
                            "title": _clean_title(line["text"]),
                            "page": 1,
                            "level": 1,
                            "y": round(float(line["y0"]), 1),
                            "score": 0.45,
                        }
                    )
                continue
            score, level = classified
            if split is not None and line["x0"] < split < line["x1"]:
                # A heading spanning both columns: above the columns or below.
                column = -1 if line["y0"] < height * 0.5 else 2
            elif split is not None and line["x0"] >= split:
                column = 1
            else:
                column = 0
            entries.append(
                {
                    "title": _clean_title(line["text"]),
                    "page": page_index + 1,
                    "level": level,
                    "y": round(float(line["y0"]), 1),
                    "score": round(min(1.0, max(0.0, score)), 2),
                    "_column": column,
                    "_x": float(line["x0"]),
                }
            )

    if not entries:
        return title_fallback[:1]

    # Reading order: page, then column, then vertical position.
    entries.sort(key=lambda item: (item["page"], item["_column"], item["y"], item["_x"]))

    result: list[dict] = []
    seen: set[str] = set()
    for item in entries:
        key = _norm_key(item["title"])
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "title": item["title"],
                "page": int(item["page"]),
                "level": int(item["level"]),
                "y": item["y"],
                "score": item["score"],
            }
        )
    return result


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #
def _read_cache(pdf: Path) -> dict | None:
    try:
        path = cache_path(pdf)
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    items = raw.get("items")
    if not isinstance(items, list):
        return None
    source = raw.get("source")
    if source not in {"outline", "heuristic", "none"}:
        return None
    clean: list[dict] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            clean.append(
                {
                    "title": str(item.get("title") or ""),
                    "page": int(item.get("page") or 1),
                    "level": int(item.get("level") or 1),
                    "y": None if item.get("y") is None else round(float(item["y"]), 1),
                    "score": float(item.get("score") or 0.0),
                }
            )
        except (TypeError, ValueError):
            continue
    return {"source": source, "items": clean}


def _write_cache(pdf: Path, data: dict) -> None:
    try:
        path = cache_path(pdf)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "path": str(pdf),
            "source": data.get("source"),
            "items": data.get("items") or [],
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def read_toc(path: str | Path, force: bool = False) -> dict:
    """Return ``{"path","source","items","count","cached"}`` for a PDF.

    ``force`` skips the on-disk cache (the refreshed result is still written
    back).  Cache read/write failures never break the returned TOC.
    """
    pdf = Path(path).expanduser()
    if not pdf.is_file():
        raise FileNotFoundError(f"文件不存在：{pdf}")

    force = bool(force)
    if not force:
        cached = _read_cache(pdf)
        if cached is not None:
            return {
                "path": str(pdf),
                "source": cached["source"],
                "items": cached["items"],
                "count": len(cached["items"]),
                "cached": True,
            }

    items = _read_outline(pdf)
    source = "outline" if items else "heuristic"
    if not items:
        items = _heuristic(pdf)
        source = "heuristic" if items else "none"

    data = {
        "path": str(pdf),
        "source": source,
        "items": items,
        "count": len(items),
        "cached": False,
    }
    try:
        _write_cache(pdf, data)
    except Exception:
        # A read-only profile or full disk must not cost the user their TOC.
        pass
    return data
