"""Offline tests for the post-translation blank-area QA.

Run:  python -m pytest tests/test_pdfqa.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import pdfqa  # noqa: E402

# Long enough to pass the "source page has substantial text" guard (> 400).
LONG_TEXT = ("The quick brown fox jumps over the lazy dog. " * 40).strip()


def write_pdf(path: Path, pages: list[dict]) -> Path:
    """Build a PDF from a compact page description.

    Each page spec accepts ``width``/``height`` and a ``boxes`` list of
    ``(rect, text)`` tuples; an empty ``boxes`` list produces a blank page.
    """
    document = pymupdf.open()
    try:
        for spec in pages:
            page = document.new_page(
                width=spec.get("width", 595), height=spec.get("height", 842)
            )
            for rect, text in spec.get("boxes", []):
                page.insert_textbox(
                    pymupdf.Rect(*rect), text, fontsize=spec.get("fontsize", 9)
                )
        document.save(str(path))
    finally:
        document.close()
    return path


def dual_page(left: str = "", right: str = "") -> dict:
    """One landscape side-by-side page: original left, translation right."""
    boxes = []
    if left:
        boxes.append(((40, 40, 560, 760), left))
    if right:
        boxes.append(((640, 40, 1160, 760), right))
    return {"width": 1200, "height": 800, "boxes": boxes}


def mono_page(text: str = "") -> dict:
    boxes = [((72, 72, 523, 770), text)] if text else []
    return {"width": 595, "height": 842, "boxes": boxes}


def test_clean_dual_pages_have_no_warning(tmp_path):
    source = write_pdf(
        tmp_path / "clean_src.pdf",
        [mono_page(LONG_TEXT) for _ in range(2)],
    )
    output = write_pdf(
        tmp_path / "clean_dual.pdf",
        [dual_page(LONG_TEXT, LONG_TEXT) for _ in range(2)],
    )

    result = pdfqa.inspect_translation(source, output, "双语对照")

    assert result["checked"] is True, result
    assert result["blank_pages"] == [], result
    assert result["warning"] == "", result


def test_clean_mono_pages_have_no_warning(tmp_path):
    source = write_pdf(tmp_path / "clean_mono_src.pdf", [mono_page(LONG_TEXT)])
    # Chinese output is shorter than English input, but far above 15%.
    output = write_pdf(
        tmp_path / "clean_mono.pdf",
        [mono_page("Translated Chinese text is shorter than the English source. " * 12)],
    )

    result = pdfqa.inspect_translation(source, output, "译文")

    assert result["checked"] is True, result
    assert result["blank_pages"] == [], result
    assert result["warning"] == "", result


def test_dual_left_only_flags_page(tmp_path):
    source = write_pdf(tmp_path / "dual_src.pdf", [mono_page(LONG_TEXT)])
    output = write_pdf(tmp_path / "dual_left_only.pdf", [dual_page(LONG_TEXT, "")])

    result = pdfqa.inspect_translation(source, output, "双语对照")

    assert result["checked"] is True, result
    assert result["blank_pages"] == [1], result
    assert "右半几乎无文字" in result["warning"], result
    assert len(result["warning"]) <= pdfqa.WARNING_MAX_CHARS, result


def test_dual_completely_blank_output_page_flags(tmp_path):
    source = write_pdf(tmp_path / "dual_blank_src.pdf", [mono_page(LONG_TEXT)])
    output = write_pdf(tmp_path / "dual_blank.pdf", [dual_page()])

    result = pdfqa.inspect_translation(source, output, "双语对照")

    assert result["blank_pages"] == [1], result
    assert "页面几乎空白" in result["warning"], result


def test_mono_near_empty_output_flags(tmp_path):
    source = write_pdf(tmp_path / "mono_src.pdf", [mono_page(LONG_TEXT)] * 2)
    output = write_pdf(
        tmp_path / "mono_sparse.pdf", [mono_page("Translated page."), mono_page("")]
    )

    result = pdfqa.inspect_translation(source, output, "译文")

    assert result["checked"] is True, result
    assert result["blank_pages"] == [1, 2], result
    assert result["warning"], result
    assert len(result["warning"]) <= pdfqa.WARNING_MAX_CHARS, result


def test_blank_source_pages_are_ignored(tmp_path):
    # A blank separator page in the source must never be reported as a failure,
    # neither for mono nor for dual output.
    source = write_pdf(tmp_path / "blank_src.pdf", [mono_page("")])
    mono_output = write_pdf(tmp_path / "blank_mono.pdf", [mono_page("")])
    dual_output = write_pdf(tmp_path / "blank_dual.pdf", [dual_page()])

    mono = pdfqa.inspect_translation(source, mono_output, "译文")
    dual = pdfqa.inspect_translation(source, dual_output, "双语对照")

    assert mono["checked"] is True and mono["blank_pages"] == [], mono
    assert dual["checked"] is True and dual["blank_pages"] == [], dual
    assert mono["warning"] == "" and dual["warning"] == ""


def test_groups_consecutive_pages_into_ranges(tmp_path):
    source = write_pdf(
        tmp_path / "range_src.pdf", [mono_page(LONG_TEXT) for _ in range(5)]
    )
    output = write_pdf(
        tmp_path / "range_dual.pdf",
        [
            dual_page(LONG_TEXT, LONG_TEXT),
            dual_page(LONG_TEXT, ""),
            dual_page(LONG_TEXT, ""),
            dual_page(LONG_TEXT, LONG_TEXT),
            dual_page(LONG_TEXT, ""),
        ],
    )

    result = pdfqa.inspect_translation(source, output, "双语对照")

    assert result["blank_pages"] == [2, 3, 5], result
    assert "2-3" in result["warning"] and "5" in result["warning"], result["warning"]
    assert len(result["warning"]) <= pdfqa.WARNING_MAX_CHARS


def test_missing_files_never_raise(tmp_path):
    missing_source = tmp_path / "nope.pdf"
    missing_output = tmp_path / "also_nope.pdf"

    for kind in ("译文", "双语对照"):
        result = pdfqa.inspect_translation(missing_source, missing_output, kind)
        assert result == {"blank_pages": [], "warning": "", "checked": False}, result

    # Output exists but cannot be opened by PyMuPDF.
    corrupt = tmp_path / "corrupt.pdf"
    corrupt.write_bytes(b"%PDF-1.4 this is not really a pdf")
    result = pdfqa.inspect_translation(missing_source, corrupt, "译文")
    assert result["checked"] is False and result["blank_pages"] == [], result
    assert result["warning"] == "", result


def test_source_missing_degrades_gracefully(tmp_path):
    # Mono needs the original to compare against, so QA reports "not checked".
    mono_output = write_pdf(tmp_path / "mono_only.pdf", [mono_page(LONG_TEXT)])
    result = pdfqa.inspect_translation("", mono_output, "译文")
    assert result["checked"] is False, result

    # Dual pages are self-contained (left = original, right = translation), so
    # a missing source still allows checking the output.
    dual_output = write_pdf(
        tmp_path / "dual_only.pdf", [dual_page(LONG_TEXT, LONG_TEXT), dual_page(LONG_TEXT, "")]
    )
    result = pdfqa.inspect_translation("", dual_output, "双语对照")
    assert result["checked"] is True, result
    assert result["blank_pages"] == [2], result


def test_runner_attaches_qa_fields_to_results(tmp_path):
    """collect_results() must expose blank_pages/warning without breaking."""
    from core import runner

    source = write_pdf(tmp_path / "paper.pdf", [mono_page(LONG_TEXT)])
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    # BabelDOC artefact naming: <stem>.no_watermark.<lang>.<kind>.pdf
    write_pdf(
        output_dir / "paper.no_watermark.zh.dual.pdf",
        [dual_page(LONG_TEXT, "")],
    )

    results = runner.collect_results(output_dir, {}, [str(source)], "zh")

    assert len(results) == 1, results
    item = results[0]
    assert item["kind"] == "双语对照"
    assert item["blank_pages"] == [1], item
    assert "大面积空白" in item["warning"], item
    assert Path(item["path"]).exists()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
