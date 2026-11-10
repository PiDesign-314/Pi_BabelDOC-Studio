"""Post-translation QA: detect large blank / near-invisible translated areas.

BabelDOC 0.6.4 occasionally finishes a long document with pages whose translated
text never made it onto the page (an upstream typesetting failure).  The output
PDF then looks "mostly white" and the user only notices after the job is done.
This module inspects a produced PDF against its source and returns a small,
user-facing warning the UI can show next to the result.

It is deliberately best-effort and read-only: every failure mode (missing or
corrupt file, encrypted PDF, missing PyMuPDF, unexpected layout) is swallowed
and reported as ``checked=False`` so QA can never break a translation job.

Public API::

    inspect_translation(source_path, output_path, kind) -> {
        "blank_pages": list[int],   # 1-based page numbers
        "warning": str,             # "" when clean
        "checked": bool,            # False when QA could not run
    }
"""

from __future__ import annotations

try:  # the app degrades gracefully when PyMuPDF is absent
    import pymupdf
except Exception:  # pragma: no cover - exercised on machines without the extra
    pymupdf = None

# --- thresholds -------------------------------------------------------------

#: Never inspect more than this many pages (a 400 page paper already takes
#: less than a second; the cap only guards pathological documents).
MAX_PAGES = 400

#: A source page must carry at least this much text before a sparse output page
#: next to it is considered suspicious.  Sparse source pages are figures, covers,
#: blank separators etc. and must never be flagged.
MIN_SOURCE_CHARS = 400

#: 译文 (mono): output text length below this share of the source page means the
#: translation is effectively missing.  Chinese is shorter than English, but the
#: real outputs we measured sit at 20%-40%, so 15% leaves comfortable headroom.
MONO_MIN_RATIO = 0.15

#: 双语对照 (dual side-by-side): a page wider than ``height * 1.2`` is the
#: landscape canvas BabelDOC uses for original | translation.
DUAL_PAGE_ASPECT = 1.2

#: The original (left) half must carry a real amount of text before the
#: translation (right) half is judged.
DUAL_LEFT_MIN_AREA = 5000.0

#: Flag when the translated (right) text-block area is below this share of the
#: original (left) area.  Measured real outputs: ~0.65-0.94 when healthy,
#: 0.10-0.14 for the blank-layout fixture, and ~0.23 for a page whose long
#: paragraphs silently lost their translation.  0.35 keeps a wide margin below
#: the healthy range while catching the partially-blank pages 0.20 missed.
DUAL_RIGHT_RATIO = 0.35

#: A page with at most this much text (stray page numbers) and no images and
#: almost no vector drawings is considered blank.
BLANK_MAX_CHARS = 15
BLANK_MAX_DRAWINGS = 3

#: ``warning`` must stay short enough for a one-line UI notice.
WARNING_MAX_CHARS = 120


# --- helpers ----------------------------------------------------------------


def _open(path: object):
    """Open *path* with PyMuPDF, or return ``None`` on any failure."""
    if pymupdf is None or not path:
        return None
    try:
        document = pymupdf.open(str(path))
        if getattr(document, "needs_pass", False):  # encrypted: cannot read
            document.close()
            return None
        return document
    except Exception:
        return None


def _close(document) -> None:
    if document is None:
        return
    try:
        document.close()
    except Exception:
        pass


def _page_text(document, index: int) -> str:
    try:
        return document[index].get_text("text") or ""
    except Exception:
        return ""


def _is_blank(page, text: str | None = None) -> bool:
    """True for an output page with no visible content worth reading."""
    try:
        if text is None:
            text = page.get_text("text") or ""
        if len(text.strip()) > BLANK_MAX_CHARS:
            return False
        if page.get_images(full=True):
            return False
        if len(page.get_drawings()) >= BLANK_MAX_DRAWINGS:
            return False
    except Exception:
        return False
    return True


def _half_text_areas(page) -> tuple[float, float]:
    """Summed text-block area in the left and right half of *page* (pt²)."""
    try:
        rect = page.rect
        blocks = page.get_text("blocks")
    except Exception:
        return 0.0, 0.0

    middle = (rect.x0 + rect.x1) / 2.0
    left = right = 0.0
    for block in blocks:
        try:
            x0, y0, x1, y1 = float(block[0]), float(block[1]), float(block[2]), float(block[3])
            text = block[4]
        except (IndexError, TypeError, ValueError):
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        area = max(0.0, x1 - x0) * max(0.0, y1 - y0)
        if (x0 + x1) / 2.0 < middle:
            left += area
        else:
            right += area
    return left, right


def _inspect_mono(source, output) -> dict[int, str]:
    """Flag mono pages whose translation all but vanished."""
    marks: dict[int, str] = {}
    page_count = min(source.page_count, output.page_count, MAX_PAGES)
    for index in range(page_count):
        source_chars = len(_page_text(source, index).strip())
        if source_chars <= MIN_SOURCE_CHARS:
            continue  # cover, figure page, intentionally blank page…
        output_page = output[index]
        output_text = _page_text(output, index)
        if _is_blank(output_page, output_text):
            marks[index + 1] = "页面几乎空白"
            continue
        output_chars = len(output_text.strip())
        if output_chars < source_chars * MONO_MIN_RATIO:
            marks[index + 1] = "译文几乎为空"
    return marks


def _inspect_dual(source, output) -> dict[int, str]:
    """Flag dual pages whose translated (right) half is almost empty."""
    marks: dict[int, str] = {}
    page_count = min(output.page_count, MAX_PAGES)
    for index in range(page_count):
        page = output[index]
        try:
            rect = page.rect
        except Exception:
            continue
        if not (rect.width > rect.height * DUAL_PAGE_ASPECT):
            continue  # not a side-by-side page (e.g. alternating dual mode)

        if _is_blank(page):
            # A dual page that is completely white also lost the original half.
            # Only flag it when the source page really had content to show.
            if source is not None and index < source.page_count:
                if len(_page_text(source, index).strip()) > MIN_SOURCE_CHARS:
                    marks[index + 1] = "页面几乎空白"
            continue

        left_area, right_area = _half_text_areas(page)
        if left_area >= DUAL_LEFT_MIN_AREA and right_area < left_area * DUAL_RIGHT_RATIO:
            marks[index + 1] = "右半几乎无文字"
    return marks


def _format_ranges(pages: list[int], max_ranges: int = 4) -> str:
    """``[3, 4, 7]`` -> ``"3-4、7"`` (long lists are shortened)."""
    groups: list[tuple[int, int]] = []
    start = previous = pages[0]
    for page in pages[1:]:
        if page == previous + 1:
            previous = page
            continue
        groups.append((start, previous))
        start = previous = page
    groups.append((start, previous))

    parts = [str(a) if a == b else f"{a}-{b}" for a, b in groups[:max_ranges]]
    text = "、".join(parts)
    if len(groups) > max_ranges:
        text += " 等"
    return text


def _build_warning(pages: list[int], marks: dict[int, str]) -> str:
    label = _format_ranges(pages)
    reason = marks.get(pages[0], "")
    detail = f"（第 {pages[0]} 页{reason}）" if reason else ""
    warning = (
        f"检测到第 {label} 页译文可能大面积空白{detail}。"
        "可在高级设置开启「兼容性优先（禁用富文本翻译）」后重译，"
        "或把原 PDF 发给我们复现。"
    )
    if len(warning) > WARNING_MAX_CHARS:
        warning = (
            f"检测到第 {label} 页译文可能大面积空白。"
            "可在高级设置开启「兼容性优先（禁用富文本翻译）」后重译。"
        )
    if len(warning) > WARNING_MAX_CHARS:
        warning = warning[: WARNING_MAX_CHARS - 1] + "…"
    return warning


def _is_dual(kind: object) -> bool:
    text = str(kind or "").strip().lower()
    return "双" in text or text in {"dual", "bilingual", "side-by-side", "side"}


# --- public API -------------------------------------------------------------


def inspect_translation(source_path, output_path, kind) -> dict:
    """Compare a translated PDF with its source and report blank areas.

    ``kind`` is the friendly result kind used by the UI (``译文`` / ``双语对照``),
    but ``mono``/``dual`` style values are accepted too.

    Never raises: any failure returns ``{"blank_pages": [], "warning": "",
    "checked": False}``.
    """
    clean = {"blank_pages": [], "warning": "", "checked": False}
    if pymupdf is None:
        return clean

    output = _open(output_path)
    if output is None:
        return clean

    source = _open(source_path)
    try:
        if _is_dual(kind):
            marks = _inspect_dual(source, output)
        else:
            if source is None:
                return clean  # cannot compare mono pages without the original
            marks = _inspect_mono(source, output)
        pages = sorted(marks)
        result = {"blank_pages": pages, "warning": "", "checked": True}
        if pages:
            result["warning"] = _build_warning(pages, marks)
        return result
    except Exception:
        # QA must never break a job.
        return clean
    finally:
        _close(source)
        _close(output)
