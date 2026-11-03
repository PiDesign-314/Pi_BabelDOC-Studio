"""PDF metadata helpers (page count, size) used by the file list."""

from __future__ import annotations

import re
from pathlib import Path

REFERENCE_HEADING = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*\.?\s*)?"
    r"(references|bibliography|works\s+cited|literature\s+cited|"
    r"参考文献|參考文獻|引用文献|引用文獻)"
    r"\s*[:：]?\s*$",
    re.IGNORECASE,
)


def page_count(path: Path) -> int | None:
    try:
        import fitz  # PyMuPDF

        with fitz.open(path) as doc:
            return int(doc.page_count)
    except Exception:
        pass
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:
        return None


def find_references_heading(path: str | Path) -> tuple[int, bool] | None:
    """Locate the bibliography heading.

    Returns ``(page, starts_at_top)`` where ``starts_at_top`` is True when the
    heading sits near the top of its page (so the whole page can be left
    untranslated), or False when it begins mid-page (common in two-column
    papers).  Only the latter part of the document is scanned so that a table
    of contents or an in-text mention cannot trigger a false positive.
    """
    try:
        import fitz  # PyMuPDF

        with fitz.open(path) as doc:
            total = doc.page_count
            if total < 2:
                return None
            start = max(0, int(total * 0.35))
            for index in range(start, total):
                page = doc[index]
                height = page.rect.height or 1
                data = page.get_text("dict")
                for block in data.get("blocks", []):
                    for line in block.get("lines", []):
                        text = "".join(
                            span.get("text", "") for span in line.get("spans", [])
                        ).strip()
                        if REFERENCE_HEADING.match(text):
                            top = line.get("bbox", [0, height, 0, height])[1]
                            return index + 1, top < height * 0.18
    except Exception:
        return None
    return None


def find_references_page(path: str | Path) -> int | None:
    """Return the 1-based page where the bibliography starts, if detectable."""
    heading = find_references_heading(path)
    return heading[0] if heading else None


def inspect(path: str | Path) -> dict:
    pdf = Path(path)
    info = {
        "path": str(pdf),
        "name": pdf.name,
        "size": 0,
        "pages": None,
        "error": "",
    }
    try:
        info["size"] = pdf.stat().st_size
    except OSError as exc:
        info["error"] = f"无法读取文件：{exc}"
        return info
    info["pages"] = page_count(pdf)
    if not pdf.suffix.lower() == ".pdf":
        info["error"] = "不是 PDF 文件"
    return info
