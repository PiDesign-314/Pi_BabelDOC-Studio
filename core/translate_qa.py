"""Paragraph-level translation completeness QA.

BabelDOC 0.6.4 can finish a job with exit code 0 while a paragraph whose LLM
answer came back empty is typeset as nothing: the page keeps a large white hole
and the user only notices much later.  ``core/pdfqa.py`` already flags mostly
blank *pages*; this module reports the paragraphs that were lost, with page
numbers and paragraph ids, and separates real loss (``missing``) from benign
"the original text was kept" gaps (``untranslated``).

Two independent sources feed the report:

* an optional guard status JSON written by ``core/babelguard`` during the
  BabelDOC run (authoritative per-paragraph status), and
* a PDF-level layout comparison used as an independent safety net (PyMuPDF
  text blocks), which also works standalone without any guard status.

The module is deliberately best-effort: any failure returns ``checked=False``
with a short Chinese warning, because QA must never break a translation job.

Public API::

    verify(source_pdf, output_pdf, kind, guard_status=None, page_filter=None)
    summarize(report) -> list[str]

Module helpers reused by sibling tests::

    text_blocks(page, min_chars=0) -> list[(x0, y0, x1, y1, text)]
    block_coverage(source_rect, output_rects) -> float   # 0.0 .. 1.0
"""

from __future__ import annotations

import json
import os

try:  # normal package import (``from core import translate_qa``)
    from . import pdfqa
except ImportError:  # pragma: no cover - direct module import (tests, scripts)
    import pdfqa  # type: ignore[no-redef]

# PyMuPDF is optional for the whole app; pdfqa already imports it defensively.
pymupdf = getattr(pdfqa, "pymupdf", None)

# --- thresholds -------------------------------------------------------------
# Page-level blank detection reuses core/pdfqa.py: a page is blank when it
# carries <= BLANK_MAX_CHARS visible characters, no images and < 3 drawings,
# but only if the source page had > MIN_SOURCE_CHARS characters.  Importing the
# constants and helpers instead of copying them keeps the two checks aligned.

#: Page cap for the PDF-level comparison (0.6.4 papers are far below this).
MAX_PAGES = int(getattr(pdfqa, "MAX_PAGES", 400))

#: A source page must carry more than this to be judged at page level.
MIN_SOURCE_CHARS = int(getattr(pdfqa, "MIN_SOURCE_CHARS", 400))

#: Short PyMuPDF blocks are page numbers, captions of figures, formulas: they
#: are not paragraphs BabelDOC had to translate and must never be reported.
MIN_BLOCK_CHARS = 25

#: 译文 (mono): share of a source text block's bounding box that must be
#: covered by output text blocks.  Chinese is shorter than English, but a
#: healthy paragraph still overlaps 20%-50% of its source box; below 12% the
#: paragraph effectively got no text.
MONO_BLOCK_MIN_COVERAGE = 0.12

#: 双语对照 (dual side-by-side): a page wider than ``height * 1.2`` is the
#: landscape canvas BabelDOC uses for original | translation.
DUAL_PAGE_ASPECT = float(getattr(pdfqa, "DUAL_PAGE_ASPECT", 1.2))

#: The original (left) half needs this much text-block area before the
#: translated (right) half is judged.
DUAL_LEFT_MIN_AREA = float(getattr(pdfqa, "DUAL_LEFT_MIN_AREA", 5000.0))

#: Flag when the translated (right) area is below this share of the left area.
DUAL_RIGHT_RATIO = float(getattr(pdfqa, "DUAL_RIGHT_RATIO", 0.20))

#: ``warnings`` entries must stay short enough for a one-line UI notice.
WARNING_MAX_CHARS = int(getattr(pdfqa, "WARNING_MAX_CHARS", 120))

#: Warning lines are kept short: at most this many missing pages are spelled
#: out, then a compressed "there are N more pages" line follows.
MAX_WARNING_PAGES = 5
MAX_UNTRANSLATED_WARNING_PAGES = 3
MAX_IDS_PER_WARNING = 4

# Guard statuses that are not paragraphs we had to translate.
_GUARD_SKIP_STATUSES = {"SKIPPED", "SKIP", "IGNORED"}
# Guard statuses that mean the translated text never made it to the page.
_GUARD_LOST_STATUSES = {"FAILED", "LOST", "RENDER_FAILED"}
# Guard statuses/fields that prove the paragraph still has readable text.
_GUARD_RECOVERED_RENDER = {"RENDERED", "FORCED"}
_GUARD_RECOVERED_LAYOUT = {"FORCED", "RECOVERED"}

_MISSING_BLANK_REASON = "页面几乎空白"
_MISSING_BLOCK_REASON = "页面区域无文字"
_MISSING_DUAL_REASON = "右半页译文缺失"


# --- small helpers ----------------------------------------------------------


def _as_int(value) -> int:
    """Best-effort int conversion (never raises)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _clip(text: object, limit: int = WARNING_MAX_CHARS) -> str:
    """Collapse whitespace and hard-truncate *text* to *limit* characters."""
    collapsed = " ".join(str(text or "").split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(1, limit - 1)] + "…"


def _page_count(document) -> int:
    try:
        return int(document.page_count) if document is not None else 0
    except Exception:
        return 0


def _page_text(page) -> str:
    try:
        return page.get_text("text") or ""
    except Exception:
        return ""


def _source_page_chars(source, index: int) -> int:
    """Character count of the stripped text of source page *index*, else 0."""
    if source is None or index < 0:
        return 0
    try:
        if index >= _page_count(source):
            return 0
        return len(_page_text(source[index]).strip())
    except Exception:
        return 0


def _is_dual(kind) -> bool:
    """``译文``/``mono`` -> False, ``双语对照``/``dual`` -> True."""
    try:
        return bool(pdfqa._is_dual(kind))
    except Exception:
        text = str(kind or "").strip().lower()
        return "双" in text or text in {"dual", "bilingual", "side-by-side", "side"}


# --- PyMuPDF block helpers (also useful for sibling tests) ------------------


def _rect_coords(rect) -> tuple[float, float, float, float]:
    """Return ``(x0, y0, x1, y1)`` for a Rect or a rect-like sequence."""
    if isinstance(rect, (tuple, list)):
        if len(rect) < 4:
            raise ValueError("rect sequence needs four numbers")
        return float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])
    return float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)


def text_blocks(page, min_chars: int = 0) -> list[tuple[float, float, float, float, str]]:
    """Text blocks of *page* as ``(x0, y0, x1, y1, stripped_text)`` tuples.

    Blocks with fewer than *min_chars* stripped characters and blocks without
    text (images, formulas drawn as shapes) are dropped.  Never raises.
    """
    if page is None:
        return []
    try:
        raw_blocks = page.get_text("blocks") or []
    except Exception:
        return []

    blocks: list[tuple[float, float, float, float, str]] = []
    for block in raw_blocks:
        try:
            x0 = float(block[0])
            y0 = float(block[1])
            x1 = float(block[2])
            y1 = float(block[3])
            text = block[4]
        except (IndexError, TypeError, ValueError):
            continue
        if not isinstance(text, str):
            continue
        stripped = text.strip()
        if len(stripped) < max(0, int(min_chars)):
            continue
        if x1 <= x0 or y1 <= y0:
            continue
        blocks.append((x0, y0, x1, y1, stripped))
    return blocks


def block_coverage(source_rect, output_rects) -> float:
    """Share of *source_rect* covered by the union of *output_rects*.

    Both may be :class:`pymupdf.Rect` objects or ``(x0, y0, x1, y1)``
    sequences.  Returns a value in ``0.0 .. 1.0`` (``1.0`` for degenerate
    rectangles, so they are never reported as lost).  Overlapping output
    blocks are summed and clamped, which is precise enough for text layout
    where blocks do not overlap.
    """
    try:
        sx0, sy0, sx1, sy1 = _rect_coords(source_rect)
    except Exception:
        return 1.0
    area = max(0.0, sx1 - sx0) * max(0.0, sy1 - sy0)
    if area <= 0.0:
        return 1.0

    covered = 0.0
    for rect in output_rects or ():
        try:
            rx0, ry0, rx1, ry1 = _rect_coords(rect)
        except Exception:
            continue
        ix0 = max(sx0, rx0)
        iy0 = max(sy0, ry0)
        ix1 = min(sx1, rx1)
        iy1 = min(sy1, ry1)
        if ix1 > ix0 and iy1 > iy0:
            covered += (ix1 - ix0) * (iy1 - iy0)
    return max(0.0, min(1.0, covered / area))


def page_block_coverages(
    source_page, output_page, min_chars: int = MIN_BLOCK_CHARS
) -> list[tuple[tuple[float, float, float, float, str], float]]:
    """Coverage of every source text block by the *output_page* text blocks.

    Returns ``[(source_block, coverage), ...]`` where ``source_block`` is the
    ``(x0, y0, x1, y1, text)`` tuple from :func:`text_blocks`.  A paragraph is
    considered lost when its coverage is below ``MONO_BLOCK_MIN_COVERAGE``.
    """
    output_rects = [block[:4] for block in text_blocks(output_page)]
    return [
        (block, block_coverage(block[:4], output_rects))
        for block in text_blocks(source_page, min_chars)
    ]


# --- page filter ------------------------------------------------------------


def _add_page_ranges(text: object, pages: set[int]) -> None:
    """Parse ``"1-3, 5"`` / ``"1-3，5"`` into 1-based page numbers."""
    normalized = str(text or "").replace("，", ",").replace("；", ",")
    for chunk in normalized.replace(";", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            start_text, _, end_text = chunk.partition("-")
            start = _as_int(start_text.strip())
            end = _as_int(end_text.strip())
            if start and end and end >= start:
                pages.update(range(start, end + 1))
            elif start:
                pages.add(start)
            continue
        value = _as_int(chunk)
        if value:
            pages.add(value)


def _normalize_page_filter(page_filter) -> set[int] | None:
    """1-based page subset or ``None`` (= all pages).

    Accepts an int, a ``"1-3,5"`` string, or an iterable of ints/ranges.
    Anything unparseable degrades to ``None`` so QA never fails on it.
    """
    if page_filter is None:
        return None
    try:
        pages: set[int] = set()
        if isinstance(page_filter, bool):
            return None
        if isinstance(page_filter, int):
            pages.add(page_filter)
        elif isinstance(page_filter, str):
            _add_page_ranges(page_filter, pages)
        elif isinstance(page_filter, dict):
            return None
        else:
            for item in page_filter:
                if isinstance(item, str):
                    _add_page_ranges(item, pages)
                elif isinstance(item, (tuple, list)) and len(item) == 2:
                    start = _as_int(item[0])
                    end = _as_int(item[1])
                    if start and end and end >= start:
                        pages.update(range(start, end + 1))
                elif isinstance(item, int) and not isinstance(item, bool):
                    pages.add(item)
        pages = {page for page in pages if page > 0}
        return pages or None
    except Exception:
        return None


def _page_allowed(page_number: int, allowed: set[int] | None) -> bool:
    return allowed is None or page_number in allowed


# --- guard status -----------------------------------------------------------


def _load_guard(guard_status) -> tuple[dict | None, str]:
    """Parse *guard_status* into ``(guard_dict, error_message)``.

    Accepts a dict (already parsed), a path to the JSON file written by
    ``core/babelguard``, raw JSON bytes/text, or ``None``.  A missing file is
    normal (the guard is optional) and yields ``(None, "")``; a malformed file
    yields ``(None, short_reason)`` so the caller can still run the PDF check.
    """
    if guard_status is None:
        return None, ""
    try:
        if isinstance(guard_status, dict):
            data = guard_status
        elif isinstance(guard_status, (bytes, bytearray)):
            data = json.loads(bytes(guard_status).decode("utf-8", "replace"))
        elif isinstance(guard_status, (str, os.PathLike)):
            text = os.fspath(guard_status)
            if not str(text).strip():
                return None, ""
            if str(text).lstrip().startswith("{"):
                data = json.loads(text)
            else:
                if not os.path.exists(text):
                    return None, ""
                with open(text, "r", encoding="utf-8-sig") as handle:
                    raw = handle.read()
                if not raw.strip():
                    return None, ""  # file created but not written yet
                data = json.loads(raw)
        else:
            return None, f"不支持的守卫状态类型：{type(guard_status).__name__}"

        if not isinstance(data, dict):
            return None, "守卫状态 JSON 不是对象"
        if not isinstance(data.get("paragraphs"), list):
            return None, "守卫状态缺少 paragraphs 列表"
        return data, ""
    except Exception as exc:  # corrupt JSON, permission error, encoding, ...
        return None, _clip(f"守卫状态无法读取：{exc}", 160)


def _dedupe_records(records: list) -> list[dict]:
    """Keep the *last* record per paragraph id only.

    ``core/babelguard`` already dedupes by paragraph id (a paragraph keeps its
    debug id across the translate and typesetting phases), but a later status
    must always supersede an earlier one (EMPTY then RENDERED), so redo it
    defensively.  Records without an id are kept as-is (they cannot be matched).
    """
    seen: set[tuple] = set()
    kept: list[dict] = []
    for index in range(len(records) - 1, -1, -1):
        record = records[index]
        if not isinstance(record, dict):
            continue
        paragraph_id = str(record.get("paragraph_id") or "").strip()
        key: tuple = ("p", paragraph_id) if paragraph_id else ("#", index)
        if key in seen:
            continue
        seen.add(key)
        kept.append(record)
    kept.reverse()
    return kept


def _normalize_token(value) -> str:
    """Upper-case a status-like field and normalise its separators."""
    text = str(value or "").strip().upper()
    if not text:
        return ""
    for character in ("-", " ", "/", "."):
        text = text.replace(character, "_")
    while "__" in text:
        text = text.replace("__", "_")
    return text.strip("_")


#: ``layout_status``/``render_status`` values that mean the source text was drawn.
_KEPT_ORIGINAL_TOKENS = {"ORIGINAL", "KEPT", "ORIGINAL_KEPT", "ORIGINAL_TEXT"}


def _is_kept_original_record(record: dict) -> bool:
    """True when the record proves the SOURCE text was drawn for the paragraph.

    ``core/babelguard`` keeps ``layout_status == "kept_original"`` and
    ``error_reason == "empty_translation_kept_original"`` on the record even
    after the typesetting phase supersedes the status with ``RENDERED``: the
    paragraph then shows its source text, so it is neither a blank (it has
    text) nor a translation (it must be reported as 保留原文).  Older/other
    guard versions may put the marker in ``render_status`` or in the status
    itself (``FORCED_KEPT_ORIGINAL``), so every field is inspected.
    """
    for value in (
        record.get("status"),
        record.get("layout_status"),
        record.get("render_status"),
    ):
        token = _normalize_token(value)
        if not token:
            continue
        if "KEPT_ORIGINAL" in token or "KEPTORIGINAL" in token:
            return True
        if token in _KEPT_ORIGINAL_TOKENS:
            return True
    reason = _normalize_token(record.get("error_reason")).lower()
    return "kept_original" in reason or "keptoriginal" in reason


def _classify_record(record: dict) -> tuple[str, str]:
    """Classify one guard record into ``missing`` / ``untranslated`` / ``translated``.

    Never double counts: exactly one bucket is returned together with a short
    Chinese reason (empty for translated paragraphs).
    """
    status = str(record.get("status") or "").strip().upper()
    render_status = str(record.get("render_status") or "").strip().upper().replace(" ", "_")
    layout_status = str(record.get("layout_status") or "").strip().upper().replace(" ", "_")

    raw_translated = record.get("translated_chars")
    has_translated = raw_translated is not None and str(raw_translated).strip() != ""
    translated_chars = _as_int(raw_translated) if has_translated else None

    # 1. Explicit failures: the translated text never reached the page.
    if status in _GUARD_LOST_STATUSES:
        return "missing", ("渲染失败" if status == "RENDER_FAILED" else "翻译失败")

    # 2. The source text was drawn for this paragraph.  This MUST be checked
    #    before the RENDERED -> translated branch: babelguard supersedes the
    #    status with RENDERED once the original text is typeset, and a
    #    kept-original paragraph must be reported, never counted as translated.
    if _is_kept_original_record(record):
        return "untranslated", "保留原文"

    # 3. Explicit fallback statuses (benign, but worth reporting).
    if status == "KEPT_ORIGINAL":
        return "untranslated", "保留原文"
    if status == "FORCED":
        return "untranslated", "强制保留原文"

    # 4. Empty answer: recovered when a retry/render/forced layout filled it.
    if status == "EMPTY":
        recovered = (
            (translated_chars is not None and translated_chars > 0)
            or render_status in _GUARD_RECOVERED_RENDER
            or layout_status in _GUARD_RECOVERED_LAYOUT
        )
        if recovered:
            return "untranslated", "空译文已回退原文"
        return "missing", "空译文"

    # 5. A failed render after a normal translation is still a lost paragraph.
    if render_status == "RENDER_FAILED":
        return "missing", "渲染失败"

    if status == "RENDERED":
        return "translated", ""
    if status == "TRANSLATED":
        if translated_chars is not None and translated_chars <= 0:
            return "missing", "空译文"
        return "translated", ""

    # 6. Unknown/missing status: trust translated_chars when it is present.
    if translated_chars is not None and translated_chars > 0:
        return "translated", ""
    return "untranslated", f"状态未知（{status or '未记录'}）"


def _classify_guard(guard: dict, allowed: set[int] | None) -> dict:
    """Turn guard records into counts + ``missing``/``untranslated`` lists."""
    result = {
        "expected": 0,
        "translated": 0,
        "untranslated_count": 0,
        "missing": [],
        "untranslated": [],
        "seen_pages": set(),
        "missing_pages": set(),
        "counts": {},
    }

    derived = {"paragraphs": 0, "translated": 0, "empty": 0, "render_failed": 0, "retried": 0}

    for record in _dedupe_records(guard.get("paragraphs") or []):
        page = _as_int(record.get("page"))
        paragraph_id = str(record.get("paragraph_id") or "").strip()
        # A guard page outside the requested subset is ignored entirely.
        if page > 0 and not _page_allowed(page, allowed):
            continue
        # Any record means the guard looked at this page: PDF-level findings on
        # it are not duplicated (the guard status is authoritative per page).
        if page > 0:
            result["seen_pages"].add(page)

        source_chars = _as_int(record.get("source_chars"))
        status = str(record.get("status") or "").strip().upper()
        if _as_int(record.get("retry_count")) > 0:
            derived["retried"] += 1
        # "empty" mirrors babelguard's own definition: an EMPTY answer or a
        # paragraph whose original text was kept (also after RENDERED).
        if status == "EMPTY" or _is_kept_original_record(record):
            derived["empty"] += 1
        render_failed = (
            status in {"RENDER_FAILED", "FORCED"}
            or str(record.get("render_status") or "").strip().upper() == "RENDER_FAILED"
        )
        if render_failed:
            derived["render_failed"] += 1

        # Short/empty source paragraphs were not paragraphs to translate.
        if source_chars <= 0 or status in _GUARD_SKIP_STATUSES:
            continue

        result["expected"] += 1
        derived["paragraphs"] += 1
        kind, reason = _classify_record(record)
        entry = {
            "page": page,
            "paragraph_id": paragraph_id,
            "source_chars": source_chars,
            "reason": reason,
        }
        if kind == "missing":
            result["missing"].append(entry)
            result["missing_pages"].add(page)
        elif kind == "untranslated":
            result["untranslated"].append(entry)
            result["untranslated_count"] += 1
        else:
            result["translated"] += 1

    derived["paragraphs"] = result["expected"]
    derived["translated"] = result["translated"]
    #: The report's counts are recomputed from the classification so they can
    #: never contradict ``translated_paragraphs`` (a stale guard summary used
    #: to call a kept-original paragraph "translated"); unknown extra keys from
    #: the guard file are preserved for forward compatibility.
    result["counts"] = dict(derived)
    file_counts = guard.get("counts")
    if isinstance(file_counts, dict):
        for key, value in file_counts.items():
            if key not in result["counts"]:
                result["counts"][key] = value
    return result


# --- PDF-level checks (independent safety net) ------------------------------


def _blank_entry(page_number: int, source_chars: int, kind: str = "blank") -> dict:
    return {
        "page": page_number,
        "source_chars": source_chars,
        "reason": _MISSING_BLANK_REASON,
        "kind": kind,
    }


def _check_mono(source, output, allowed: set[int] | None) -> dict:
    """Compare every source text block against the output page's text blocks."""
    result = {"blank_pages": [], "findings": [], "expected_units": 0, "translated_units": 0}
    try:
        page_total = min(_page_count(source), MAX_PAGES)
    except Exception:
        return result

    for index in range(page_total):
        page_number = index + 1
        if not _page_allowed(page_number, allowed):
            continue
        try:
            source_page = source[index]
        except Exception:
            continue
        source_chars = len(_page_text(source_page).strip())

        try:
            output_page = output[index] if index < _page_count(output) else None
        except Exception:
            output_page = None

        if output_page is None:
            if source_chars > MIN_SOURCE_CHARS:
                result["blank_pages"].append(page_number)
                result["findings"].append(_blank_entry(page_number, source_chars))
                result["expected_units"] += 1
                continue
            output_rects: list = []
        else:
            output_text = _page_text(output_page)
            try:
                blank = bool(pdfqa._is_blank(output_page, output_text))
            except Exception:
                blank = False
            if blank and source_chars > MIN_SOURCE_CHARS:
                result["blank_pages"].append(page_number)
                result["findings"].append(_blank_entry(page_number, source_chars))
                result["expected_units"] += 1
                continue
            output_rects = [block[:4] for block in text_blocks(output_page)]

        for x0, y0, x1, y1, text in text_blocks(source_page, MIN_BLOCK_CHARS):
            result["expected_units"] += 1
            if block_coverage((x0, y0, x1, y1), output_rects) >= MONO_BLOCK_MIN_COVERAGE:
                result["translated_units"] += 1
            else:
                result["findings"].append(
                    {
                        "page": page_number,
                        "source_chars": len(text),
                        "reason": _MISSING_BLOCK_REASON,
                        "kind": "block",
                    }
                )
    return result


def _check_dual(source, output, allowed: set[int] | None) -> dict:
    """Compare the left (original) and right (translation) halves of dual pages."""
    result = {"blank_pages": [], "findings": [], "expected_units": 0, "translated_units": 0}
    output_pages = _page_count(output)
    page_total = min(output_pages, MAX_PAGES)

    for index in range(page_total):
        page_number = index + 1
        if not _page_allowed(page_number, allowed):
            continue
        try:
            page = output[index]
            rect = page.rect
        except Exception:
            continue
        try:
            landscape = rect.width > rect.height * DUAL_PAGE_ASPECT
        except Exception:
            landscape = False
        if not landscape:
            continue  # portrait = alternating-page dual mode or a mono page

        source_chars = _source_page_chars(source, index)
        try:
            blank = bool(pdfqa._is_blank(page))
        except Exception:
            blank = False
        if blank:
            # A fully white dual page also lost its original half; only flag it
            # when the source page really had content to show.
            if source_chars > MIN_SOURCE_CHARS:
                result["blank_pages"].append(page_number)
                result["findings"].append(_blank_entry(page_number, source_chars))
                result["expected_units"] += 1
            continue

        try:
            left_area, right_area = pdfqa._half_text_areas(page)
        except Exception:
            continue
        if left_area < DUAL_LEFT_MIN_AREA:
            continue
        result["expected_units"] += 1
        if right_area < left_area * DUAL_RIGHT_RATIO:
            result["findings"].append(
                {
                    "page": page_number,
                    "source_chars": source_chars,
                    "reason": _MISSING_DUAL_REASON,
                    "kind": "dual",
                }
            )
        else:
            result["translated_units"] += 1

    # Dual output normally keeps one page per source page; missing trailing
    # pages are a lost translation, not an empty artifact.
    if source is not None:
        source_pages = min(_page_count(source), MAX_PAGES)
        for index in range(source_pages):
            page_number = index + 1
            if page_number <= output_pages or not _page_allowed(page_number, allowed):
                continue
            source_chars = _source_page_chars(source, index)
            if source_chars > MIN_SOURCE_CHARS:
                result["blank_pages"].append(page_number)
                result["findings"].append(_blank_entry(page_number, source_chars))
                result["expected_units"] += 1
    return result


# --- report / warnings ------------------------------------------------------


def _base_report() -> dict:
    return {
        "ok": False,
        "checked": False,
        "source_pages": 0,
        "output_pages": 0,
        "expected_paragraphs": 0,
        "translated_paragraphs": 0,
        "untranslated_paragraphs": 0,
        "missing": [],
        "untranslated": [],
        "blank_pages": [],
        "warnings": [],
        "guard": {"used": False, "counts": {}},
    }


def _unchecked(message: str) -> dict:
    report = _base_report()
    report["warnings"] = [_clip(message)]
    return report


def _group_by_page(entries: list) -> dict[int, list]:
    grouped: dict[int, list] = {}
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        page = _as_int(entry.get("page"))
        if page <= 0:
            continue
        grouped.setdefault(page, []).append(entry)
    return grouped


def _ids_of(entries: list) -> list[str]:
    ids: list[str] = []
    for entry in entries:
        paragraph_id = str(entry.get("paragraph_id") or "").strip()
        if paragraph_id and paragraph_id not in ids:
            ids.append(paragraph_id)
    return ids


def _id_text(ids: list[str]) -> str:
    text = "、".join(ids[:MAX_IDS_PER_WARNING])
    if len(ids) > MAX_IDS_PER_WARNING:
        text += " 等"
    return text


def _build_warnings(missing: list, untranslated: list, blank_pages: list) -> list[str]:
    """One short Chinese line per affected page (plus compressed summaries)."""
    lines: list[str] = []
    try:
        missing_pages = _group_by_page(missing)
        pages = sorted(missing_pages)
        for page in pages[:MAX_WARNING_PAGES]:
            entries = missing_pages[page]
            reasons = {str(entry.get("reason") or "") for entry in entries}
            ids = _ids_of(entries)
            if _MISSING_BLANK_REASON in reasons:
                lines.append(_clip(f"第 {page} 页译文几乎空白，原文内容未能出现在译文页面中。"))
            elif ids:
                lines.append(
                    _clip(
                        f"第 {page} 页有 {len(entries)} 个段落没有译文"
                        f"（{_id_text(ids)}），可能大面积空白。"
                    )
                )
            elif _MISSING_DUAL_REASON in reasons:
                lines.append(_clip(f"第 {page} 页右半页译文缺失，可能大面积空白。"))
            else:
                lines.append(
                    _clip(
                        f"第 {page} 页有 {len(entries)} 处区域没有检测到译文"
                        f"（页面区域无文字），可能大面积空白。"
                    )
                )
        if len(pages) > MAX_WARNING_PAGES:
            rest = pages[MAX_WARNING_PAGES:]
            lines.append(
                _clip(f"另有 {len(rest)} 页存在译文缺失（第 {pdfqa._format_ranges(rest)} 页）。")
            )

        # Blank pages already reported as lost above are not mentioned twice,
        # but a blank page can also come from the PDF check alone (e.g. guard
        # reported a paragraph on it) — surface it either way.
        blank_only = [page for page in blank_pages if page not in missing_pages]
        if blank_only:
            lines.append(
                _clip(f"检测到第 {pdfqa._format_ranges(sorted(blank_only))} 页几乎空白。")
            )

        untranslated_pages = _group_by_page(untranslated)
        pages = sorted(untranslated_pages)
        for page in pages[:MAX_UNTRANSLATED_WARNING_PAGES]:
            entries = untranslated_pages[page]
            ids = _ids_of(entries)
            if ids:
                lines.append(
                    _clip(f"第 {page} 页有 {len(entries)} 个段落保留原文未翻译（{_id_text(ids)}）。")
                )
            else:
                lines.append(_clip(f"第 {page} 页有 {len(entries)} 个段落保留原文未翻译。"))
        if len(pages) > MAX_UNTRANSLATED_WARNING_PAGES:
            rest = pages[MAX_UNTRANSLATED_WARNING_PAGES:]
            lines.append(
                _clip(f"另有 {len(rest)} 页存在保留原文的段落（第 {pdfqa._format_ranges(rest)} 页）。")
            )
    except Exception:
        # Warnings are cosmetic; never let them break the report.
        return []
    return lines


def _build_summary(report: dict) -> list[str]:
    """Short Chinese log lines for the job log / UI."""
    if not isinstance(report, dict):
        return ["译文完整性校验结果无效。"]
    if not report.get("checked"):
        warnings = report.get("warnings") or []
        first = warnings[0] if warnings else ""
        return [_clip(first or "译文完整性校验未能执行。")]

    expected = _as_int(report.get("expected_paragraphs"))
    translated = _as_int(report.get("translated_paragraphs"))
    untranslated_count = _as_int(report.get("untranslated_paragraphs"))
    missing = report.get("missing") or []
    untranslated = report.get("untranslated") or []

    lines = [
        _clip(
            f"译文完整性：应译 {expected} 段，已译 {translated} 段，"
            f"保留原文 {untranslated_count} 段，缺失 {len(missing)} 段。"
        )
    ]

    missing_pages = sorted(_group_by_page(missing))
    if missing_pages:
        lines.append(_clip(f"译文缺失页码：第 {pdfqa._format_ranges(missing_pages)} 页。"))
    untranslated_pages = sorted(_group_by_page(untranslated))
    if untranslated_pages:
        lines.append(_clip(f"保留原文页码：第 {pdfqa._format_ranges(untranslated_pages)} 页。"))

    blank_pages = sorted(
        {_as_int(page) for page in (report.get("blank_pages") or []) if _as_int(page) > 0}
    )
    if blank_pages:
        lines.append(_clip(f"几乎空白页面：第 {pdfqa._format_ranges(blank_pages)} 页。"))

    if missing:
        lines.append("建议在高级设置开启「兼容性优先（禁用富文本翻译）」后重译缺失页面。")
    elif report.get("ok"):
        if untranslated_count:
            # Nothing was lost, but do not claim a clean pass: kept-original
            # paragraphs are explicitly reported from the guard status.
            lines.append(
                _clip(f"译文完整性校验通过：无缺失段落，{untranslated_count} 段保留原文。")
            )
        else:
            lines.append("译文完整性校验通过。")
    return lines


# --- public API -------------------------------------------------------------


def verify(source_pdf, output_pdf, kind, guard_status=None, page_filter=None) -> dict:
    """Verify that every source paragraph reached the translated PDF.

    Parameters
    ----------
    source_pdf, output_pdf:
        Paths of the original PDF and the produced BabelDOC PDF.
    kind:
        Friendly result kind (``译文`` / ``双语对照``); ``mono``/``dual`` is
        accepted too.
    guard_status:
        Optional per-paragraph status written by ``core/babelguard``: either a
        dict, a path to the JSON file, or raw JSON text/bytes.  When absent or
        unusable the report is based on the PDF-level check alone.
    page_filter:
        Optional 1-based page subset (int, ``"1-3,5"``, or iterable of ints /
        ``(start, end)`` ranges).  Only these pages are counted and checked.

    Returns
    -------
    dict
        ``{"ok", "checked", "source_pages", "output_pages",
        "expected_paragraphs", "translated_paragraphs",
        "untranslated_paragraphs", "missing", "untranslated", "blank_pages",
        "warnings", "guard"}``.

    ``ok`` is True only when the check ran and no paragraph was lost;
    paragraphs kept in the original language are reported but are not losses.
    Never raises: on any failure the result has ``checked=False`` and a short
    Chinese warning.
    """
    try:
        return _verify(source_pdf, output_pdf, kind, guard_status, page_filter)
    except Exception as exc:  # QA must never break a translation job
        return _unchecked(f"译文完整性校验未能执行：{exc}")


def _verify(source_pdf, output_pdf, kind, guard_status, page_filter) -> dict:
    report = _base_report()
    if pymupdf is None:
        report["warnings"] = [_clip("译文完整性校验未能执行：缺少 PyMuPDF。")]
        return report

    allowed = _normalize_page_filter(page_filter)
    output = pdfqa._open(output_pdf)
    if output is None:
        report["warnings"] = [_clip("译文完整性校验未能执行：无法打开译文 PDF。")]
        return report

    source = pdfqa._open(source_pdf)
    guard, guard_error = _load_guard(guard_status)
    try:
        report["output_pages"] = _page_count(output)
        report["source_pages"] = _page_count(source)

        guard_used = guard is not None
        classified = _classify_guard(guard, allowed) if guard_used else None
        report["guard"] = {"used": guard_used, "counts": classified["counts"] if classified else {}}
        if guard_error:
            report["guard"]["error"] = _clip(guard_error, 160)

        dual = _is_dual(kind)
        if dual:
            pdf_check = _check_dual(source, output, allowed)
        elif source is not None:
            pdf_check = _check_mono(source, output, allowed)
        else:
            pdf_check = {
                "blank_pages": [],
                "findings": [],
                "expected_units": 0,
                "translated_units": 0,
            }

        if not dual and source is None and not guard_used:
            report["warnings"] = [_clip("译文完整性校验未能执行：缺少源文件，无法比对版面。")]
            return report

        blank_pages = sorted(
            {_as_int(page) for page in pdf_check["blank_pages"] if _as_int(page) > 0}
        )
        report["blank_pages"] = blank_pages

        if classified is not None:
            missing = list(classified["missing"])
            untranslated = list(classified["untranslated"])
            expected = classified["expected"]
            translated = classified["translated"]
            untranslated_count = classified["untranslated_count"]
            # The PDF check is a safety net: it only contributes findings for
            # pages the guard never reported, and never duplicates a page the
            # guard already flagged as missing (no double counting).
            for finding in pdf_check["findings"]:
                page = _as_int(finding.get("page"))
                if page <= 0 or page in classified["missing_pages"]:
                    continue
                if finding.get("kind") != "blank" and page in classified["seen_pages"]:
                    continue
                missing.append(
                    {
                        "page": page,
                        "paragraph_id": "",
                        "source_chars": _as_int(finding.get("source_chars")),
                        "reason": str(finding.get("reason") or _MISSING_BLOCK_REASON),
                    }
                )
                expected += 1
        else:
            found = []
            for finding in pdf_check["findings"]:
                page = _as_int(finding.get("page"))
                if page <= 0:
                    continue
                found.append(
                    {
                        "page": page,
                        "paragraph_id": "",
                        "source_chars": _as_int(finding.get("source_chars")),
                        "reason": str(finding.get("reason") or _MISSING_BLOCK_REASON),
                    }
                )
            missing = found
            untranslated = []
            expected = int(pdf_check["expected_units"])
            translated = int(pdf_check["translated_units"])
            untranslated_count = 0

        missing.sort(key=lambda entry: (entry["page"], entry["paragraph_id"], entry["reason"]))
        untranslated.sort(key=lambda entry: (entry["page"], entry["paragraph_id"], entry["reason"]))

        report["missing"] = missing
        report["untranslated"] = untranslated
        report["expected_paragraphs"] = int(expected)
        report["translated_paragraphs"] = int(translated)
        report["untranslated_paragraphs"] = int(untranslated_count)
        report["checked"] = True
        report["ok"] = not missing
        report["warnings"] = _build_warnings(missing, untranslated, blank_pages)
        return report
    finally:
        pdfqa._close(source)
        pdfqa._close(output)


def summarize(report) -> list[str]:
    """Short Chinese log lines describing *report* (never raises)."""
    try:
        return _build_summary(report)
    except Exception:
        return ["译文完整性校验结果无法汇总。"]
