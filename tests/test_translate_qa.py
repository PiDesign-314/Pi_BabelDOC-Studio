"""Offline tests for the paragraph-level translation completeness QA.

Run::

    cd E:\\01Projects\\02BabelDOC
    $env:PYTHONPATH=(Resolve-Path .lead).Path
    $env:TEMP=(Resolve-Path .lead\\run-qa).Path
    $env:TMP=$env:TEMP
    python -m pytest tests/test_translate_qa.py -q -p no:cacheprovider -p nomode700

``pytest``'s ``tmp_path`` fixture is broken in this sandbox, so every test
builds its PDFs in a directory created with ``tempfile.mkdtemp(dir=TEMP)``.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import translate_qa  # noqa: E402

# Long enough to pass the "source page has substantial text" guard (> 400) and
# to be one real source paragraph block (>= 25 chars).
LONG_TEXT = ("The quick brown fox jumps over the lazy dog. " * 40).strip()
# A healthy translation is shorter than the English source but still covers
# roughly 29% of the source paragraph box.
SHORT_TEXT = ("Translated text that is noticeably shorter than the source prose. " * 8).strip()
# 24 chars: above the 15-char blank threshold, but it covers none of the source
# paragraph box, which is exactly the "paragraph was erased" shape.
MARKER_TEXT = "Chapter Two page marker"

BASE_TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or "."


# --- fixtures / synthetic PDF helpers ---------------------------------------


@pytest.fixture()
def workdir():
    path = tempfile.mkdtemp(prefix="tqa-", dir=BASE_TEMP)
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def write_pdf(path: Path, pages: list[dict]) -> Path:
    """Build a PDF from page specs (``width``/``height`` + ``boxes``)."""
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


def mono_page(text: str = "") -> dict:
    boxes = [((72, 72, 523, 770), text)] if text else []
    return {"width": 595, "height": 842, "boxes": boxes}


def dual_page(left: str = "", right: str = "") -> dict:
    boxes = []
    if left:
        boxes.append(((40, 40, 560, 760), left))
    if right:
        boxes.append(((640, 40, 1160, 760), right))
    return {"width": 1200, "height": 800, "boxes": boxes}


def mono_pair(workdir: Path, output_pages: list[dict], source_pages: list[dict] | None = None):
    source = write_pdf(workdir / "source.pdf", source_pages or [mono_page(LONG_TEXT)])
    output = write_pdf(workdir / "output.pdf", output_pages)
    return source, output


def mixed_guard() -> dict:
    """Guard status with every status class, a duplicate and a SKIPPED record."""
    return {
        "schema": 1,
        "guard": "babeldoc-studio",
        "doc": "paper",
        "paragraphs": [
            # earlier FAILED attempt for pA, superseded by the TRANSLATED record
            # at the end of the list (a later status always wins).
            {
                "page": 1,
                "paragraph_id": "pA",
                "source_chars": 100,
                "translated_chars": 0,
                "status": "FAILED",
            },
            {
                "page": 1,
                "paragraph_id": "pB",
                "source_chars": 50,
                "translated_chars": 0,
                "status": "EMPTY",
                "retry_count": 2,
                "error_reason": "empty llm answer",
            },
            {
                "page": 2,
                "paragraph_id": "pC",
                "source_chars": 80,
                "translated_chars": 0,
                "status": "KEPT_ORIGINAL",
            },
            {
                "page": 2,
                "paragraph_id": "pD",
                "source_chars": 60,
                "translated_chars": 0,
                "status": "RENDER_FAILED",
                "render_status": "RENDER_FAILED",
            },
            {
                "page": 1,
                "paragraph_id": "pE",
                "source_chars": 30,
                "translated_chars": 20,
                "status": "RENDERED",
                "render_status": "RENDERED",
            },
            {
                "page": 2,
                "paragraph_id": "pF",
                "source_chars": 40,
                "translated_chars": 20,
                "status": "EMPTY",
                "retry_count": 1,
            },
            {
                "page": 2,
                "paragraph_id": "pG",
                "source_chars": 120,
                "translated_chars": 0,
                "status": "SKIPPED",
            },
            {
                "page": 1,
                "paragraph_id": "pA",
                "source_chars": 100,
                "translated_chars": 40,
                "status": "TRANSLATED",
            },
        ],
        "counts": {
            "paragraphs": 7,
            "translated": 2,
            "empty": 2,
            "render_failed": 1,
            "retried": 2,
        },
        "errors": [],
    }


# --- PDF-level mono check ---------------------------------------------------


def test_mono_healthy_output_is_ok(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT), mono_page(SHORT_TEXT)],
                               [mono_page(LONG_TEXT), mono_page(LONG_TEXT)])

    report = translate_qa.verify(source, output, "译文")

    assert report["checked"] is True, report
    assert report["ok"] is True, report
    assert report["missing"] == [] and report["untranslated"] == [], report
    assert report["blank_pages"] == [], report
    assert report["warnings"] == [], report
    assert report["guard"] == {"used": False, "counts": {}}, report
    assert report["source_pages"] == 2 and report["output_pages"] == 2, report
    # PDF-only mode estimates one paragraph per long source text block.
    assert report["expected_paragraphs"] == 2, report
    assert report["translated_paragraphs"] == 2, report


def test_mono_erased_paragraph_is_reported(workdir):
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page(MARKER_TEXT)],
        [mono_page(LONG_TEXT), mono_page(LONG_TEXT)],
    )

    report = translate_qa.verify(source, output, "译文")

    assert report["checked"] is True, report
    assert report["ok"] is False, report
    assert [entry["page"] for entry in report["missing"]] == [2], report
    assert report["missing"][0]["reason"] == "页面区域无文字", report
    assert report["missing"][0]["source_chars"] == len(LONG_TEXT), report
    assert report["warnings"], report
    assert all(len(line) <= 120 for line in report["warnings"]), report["warnings"]
    assert any("第 2 页" in line for line in report["warnings"]), report["warnings"]


def test_mono_blank_page_is_flagged_with_reason(workdir):
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page("")],
        [mono_page(LONG_TEXT), mono_page(LONG_TEXT)],
    )

    report = translate_qa.verify(source, output, "译文")

    assert report["blank_pages"] == [2], report
    assert [entry["page"] for entry in report["missing"]] == [2], report
    assert report["missing"][0]["reason"] == "页面几乎空白", report
    assert any("几乎空白" in line for line in report["warnings"]), report["warnings"]


def test_blank_page_detection_needs_substantial_source(workdir):
    # Page 2 of the source is a separator with one character: a blank output
    # page next to it is normal and must not be reported.
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page("")],
        [mono_page(LONG_TEXT), mono_page("x")],
    )

    report = translate_qa.verify(source, output, "译文")

    assert report["checked"] is True, report
    assert report["ok"] is True, report
    assert report["blank_pages"] == [], report
    assert report["missing"] == [], report
    assert report["warnings"] == [], report


# --- PDF-level dual check ---------------------------------------------------


def test_dual_healthy_page_is_ok(workdir):
    source = write_pdf(workdir / "source.pdf", [mono_page(LONG_TEXT)])
    output = write_pdf(workdir / "dual.pdf", [dual_page(LONG_TEXT, LONG_TEXT)])

    report = translate_qa.verify(source, output, "双语对照")

    assert report["checked"] is True, report
    assert report["ok"] is True, report
    assert report["missing"] == [], report
    assert report["blank_pages"] == [], report
    assert report["expected_paragraphs"] == 1, report
    assert report["translated_paragraphs"] == 1, report


def test_dual_wiped_right_half_is_reported(workdir):
    source = write_pdf(workdir / "source.pdf", [mono_page(LONG_TEXT)])
    output = write_pdf(
        workdir / "dual.pdf",
        [dual_page(LONG_TEXT, LONG_TEXT), dual_page(LONG_TEXT, "")],
    )

    report = translate_qa.verify(source, output, "双语对照")

    assert report["checked"] is True, report
    assert report["ok"] is False, report
    assert [entry["page"] for entry in report["missing"]] == [2], report
    assert report["missing"][0]["reason"] == "右半页译文缺失", report
    assert report["warnings"], report
    assert any("第 2 页" in line for line in report["warnings"]), report["warnings"]


def test_dual_blank_page_needs_source_content(workdir):
    long_source = write_pdf(workdir / "long.pdf", [mono_page(LONG_TEXT)])
    empty_source = write_pdf(workdir / "empty.pdf", [mono_page("")])
    output = write_pdf(workdir / "dual.pdf", [dual_page()])

    warned = translate_qa.verify(long_source, output, "双语对照")
    assert warned["blank_pages"] == [1], warned
    assert warned["missing"][0]["reason"] == "页面几乎空白", warned

    ignored = translate_qa.verify(empty_source, output, "双语对照")
    assert ignored["checked"] is True, ignored
    assert ignored["blank_pages"] == [] and ignored["missing"] == [], ignored
    assert ignored["ok"] is True, ignored


def test_dual_alternating_mode_pages_are_ignored(workdir):
    # Alternating dual mode uses portrait pages: the right-half heuristic does
    # not apply and must not invent missing translations.
    source = write_pdf(workdir / "source.pdf", [mono_page(LONG_TEXT)])
    output = write_pdf(workdir / "alternating.pdf", [mono_page(LONG_TEXT), mono_page("")])

    report = translate_qa.verify(source, output, "双语对照")

    assert report["checked"] is True, report
    assert report["ok"] is True, report
    assert report["missing"] == [], report
    assert report["blank_pages"] == [], report


# --- guard status driven counts --------------------------------------------


def test_guard_status_mixed_records_are_counted_once(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT), mono_page(SHORT_TEXT)],
                               [mono_page(LONG_TEXT), mono_page(LONG_TEXT)])
    guard = mixed_guard()

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["checked"] is True, report
    assert report["guard"]["used"] is True, report
    # The guard summary is recomputed from the classification, so it can never
    # contradict the report (the file's own counts are only a fallback).
    counts = report["guard"]["counts"]
    assert counts["paragraphs"] == report["expected_paragraphs"] == 6, report["guard"]
    assert counts["translated"] == report["translated_paragraphs"] == 2, report["guard"]
    # pB/pF (EMPTY) and pC (KEPT_ORIGINAL) are all "empty answer fallbacks".
    assert counts["empty"] == 3, report["guard"]
    assert counts["render_failed"] == 1, report["guard"]
    assert counts["retried"] == 2, report["guard"]

    # pG is SKIPPED and pA appears twice (later TRANSLATED supersedes FAILED).
    assert report["expected_paragraphs"] == 6, report
    assert report["translated_paragraphs"] == 2, report
    assert report["untranslated_paragraphs"] == 2, report

    missing_ids = {entry["paragraph_id"] for entry in report["missing"]}
    untranslated_ids = {entry["paragraph_id"] for entry in report["untranslated"]}
    assert missing_ids == {"pB", "pD"}, report
    assert untranslated_ids == {"pC", "pF"}, report
    assert missing_ids.isdisjoint(untranslated_ids), report

    # No double counting anywhere.
    assert len(report["missing"]) == 2, report
    assert len(report["untranslated"]) == 2, report
    assert report["expected_paragraphs"] == (
        report["translated_paragraphs"]
        + report["untranslated_paragraphs"]
        + len(report["missing"])
    ), report

    assert report["ok"] is False, report
    assert all(len(line) <= 120 for line in report["warnings"]), report["warnings"]
    assert any("pB" in line for line in report["warnings"]), report["warnings"]
    assert any("pC" in line for line in report["warnings"]), report["warnings"]


def test_guard_prevents_pdf_double_counting(workdir):
    # The guard reports page 2 as a lost paragraph and the page is blank too:
    # the page lands in blank_pages but the paragraph is counted exactly once.
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page("")],
        [mono_page(LONG_TEXT), mono_page(LONG_TEXT)],
    )
    guard = {
        "schema": 1,
        "paragraphs": [
            {
                "page": 2,
                "paragraph_id": "pLost",
                "source_chars": 800,
                "translated_chars": 0,
                "status": "EMPTY",
            }
        ],
        "counts": {},
    }

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["blank_pages"] == [2], report
    assert len(report["missing"]) == 1, report
    assert report["missing"][0]["paragraph_id"] == "pLost", report
    assert report["expected_paragraphs"] == 1, report
    assert report["translated_paragraphs"] == 0, report
    assert report["untranslated_paragraphs"] == 0, report
    assert report["ok"] is False, report


def test_guard_rendered_but_kept_original_is_untranslated(workdir):
    """babelguard supersedes an empty answer with RENDERED but keeps the markers.

    A paragraph whose empty model reply was replaced by the SOURCE text has text
    on the page (so it is not a blank) but was never translated: it must be
    explicitly reported as untranslated and never counted as translated.
    """
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page(SHORT_TEXT)],
        [mono_page(LONG_TEXT), mono_page(LONG_TEXT)],
    )
    guard = {
        "schema": 1,
        "paragraphs": [
            {
                "page": 1,
                "paragraph_id": "pKept",
                "source_chars": 1442,
                "translated_chars": 1442,  # source length, not a translation
                "status": "RENDERED",
                "render_status": "rendered",
                "layout_status": "kept_original",
                "error_reason": "empty_translation_kept_original",
                "retry_count": 2,
            },
            {
                "page": 2,
                "paragraph_id": "pReal",
                "source_chars": 300,
                "translated_chars": 120,
                "status": "RENDERED",
                "render_status": "rendered",
            },
        ],
        # A stale guard summary that would call both paragraphs translated.
        "counts": {
            "paragraphs": 2,
            "translated": 2,
            "empty": 1,
            "render_failed": 0,
            "retried": 1,
        },
    }

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["translated_paragraphs"] == 1, report
    assert report["untranslated_paragraphs"] == 1, report
    assert [entry["paragraph_id"] for entry in report["untranslated"]] == ["pKept"], report
    assert report["untranslated"][0]["reason"] == "保留原文", report
    # Kept original is not a blank: the paragraph has text on the page.
    assert report["missing"] == [], report
    assert report["ok"] is True, report
    assert report["expected_paragraphs"] == 2, report

    counts = report["guard"]["counts"]
    assert counts["translated"] == report["translated_paragraphs"] == 1, report["guard"]
    assert counts["paragraphs"] == report["expected_paragraphs"] == 2, report["guard"]
    assert counts["empty"] == 1, report["guard"]

    # expected == translated + untranslated + missing
    assert report["expected_paragraphs"] == (
        report["translated_paragraphs"]
        + report["untranslated_paragraphs"]
        + len(report["missing"])
    ), report

    warnings = report["warnings"]
    assert any("pKept" in line and "保留原文" in line for line in warnings), warnings
    assert all(len(line) <= 120 for line in warnings), warnings

    summary = translate_qa.summarize(report)
    assert any("保留原文" in line for line in summary), summary
    assert all(len(line) <= 120 for line in summary), summary


@pytest.mark.parametrize(
    "markers",
    [
        {"layout_status": "kept_original"},
        {"layout_status": "FORCED_KEPT_ORIGINAL"},
        {"render_status": "kept_original"},
        {"render_status": "FORCED_KEPT_ORIGINAL"},
        {"error_reason": "empty_translation_kept_original"},
        {"status": "FORCED_KEPT_ORIGINAL"},
    ],
)
def test_kept_original_marker_variants_are_untranslated(workdir, markers):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])
    record = {
        "page": 1,
        "paragraph_id": "pVariant",
        "source_chars": 500,
        "translated_chars": 500,
        "status": "RENDERED",
        "render_status": "rendered",
    }
    record.update(markers)
    guard = {"schema": 1, "paragraphs": [record], "counts": {}}

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["translated_paragraphs"] == 0, (markers, report)
    assert report["untranslated_paragraphs"] == 1, (markers, report)
    assert report["untranslated"][0]["reason"] == "保留原文", (markers, report)
    assert report["missing"] == [], (markers, report)


def test_guard_rendered_without_marker_stays_translated(workdir):
    """Guard against over-reporting: plain RENDERED paragraphs are translations."""
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT), mono_page(SHORT_TEXT)])
    guard = {
        "schema": 1,
        "paragraphs": [
            {
                "page": 1,
                "paragraph_id": "p1",
                "source_chars": 400,
                "translated_chars": 180,
                "status": "RENDERED",
                "render_status": "rendered",
            },
            {
                "page": 2,
                "paragraph_id": "p2",
                "source_chars": 350,
                "translated_chars": 150,
                "status": "RENDERED",
                "render_status": "rendered",
                "layout_status": "",
                "error_reason": "",
            },
        ],
        "counts": {},
    }

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["translated_paragraphs"] == 2, report
    assert report["untranslated_paragraphs"] == 0, report
    assert report["missing"] == [], report
    assert report["warnings"] == [], report
    assert report["guard"]["counts"]["translated"] == 2, report["guard"]
    assert report["guard"]["counts"]["empty"] == 0, report["guard"]


def test_guard_same_paragraph_on_page_zero_counts_once(workdir):
    """A page-0 record and its paged twin are one paragraph, not two."""
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT), mono_page(SHORT_TEXT)])
    guard = {
        "schema": 1,
        "paragraphs": [
            {
                "page": 0,
                "paragraph_id": "pX",
                "source_chars": 500,
                "translated_chars": 0,
                "status": "EMPTY",
            },
            {
                "page": 2,
                "paragraph_id": "pX",
                "source_chars": 500,
                "translated_chars": 0,
                "status": "EMPTY",
            },
        ],
        "counts": {},
    }

    report = translate_qa.verify(source, output, "译文", guard_status=guard)

    assert report["expected_paragraphs"] == 1, report
    assert len(report["missing"]) == 1, report
    assert report["missing"][0]["page"] == 2, report
    assert report["guard"]["counts"]["paragraphs"] == 1, report["guard"]


def test_guard_status_accepts_path_and_json_text(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])
    guard = mixed_guard()
    guard_path = workdir / "guard_status.json"
    guard_path.write_text(json.dumps(guard), encoding="utf-8")

    from_path = translate_qa.verify(source, output, "译文", guard_status=str(guard_path))
    from_text = translate_qa.verify(source, output, "译文", guard_status=json.dumps(guard))

    for report in (from_path, from_text):
        assert report["guard"]["used"] is True, report
        assert report["expected_paragraphs"] == 6, report


def test_guard_status_none_keeps_pdf_only_result(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])

    report = translate_qa.verify(source, output, "译文", guard_status=None)

    assert report["checked"] is True, report
    assert report["guard"] == {"used": False, "counts": {}}, report
    assert report["ok"] is True, report


def test_corrupt_guard_status_falls_back_to_pdf_check(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])
    corrupt = workdir / "guard_status.json"
    corrupt.write_text("{this is not json", encoding="utf-8")

    report = translate_qa.verify(source, output, "译文", guard_status=str(corrupt))

    # Either checked=False or a PDF-only result is acceptable; raising is not.
    assert isinstance(report, dict), report
    assert report["guard"]["used"] is False, report
    assert report.get("checked") is True, report
    assert report["ok"] is True, report

    # A guard file created but never written (empty) is treated as absent.
    empty = workdir / "empty_guard.json"
    empty.write_text("", encoding="utf-8")
    empty_report = translate_qa.verify(source, output, "译文", guard_status=str(empty))
    assert empty_report["checked"] is True, empty_report
    assert empty_report["guard"] == {"used": False, "counts": {}}, empty_report


def test_missing_guard_file_is_not_an_error(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])

    report = translate_qa.verify(
        source, output, "译文", guard_status=str(workdir / "not-written.json")
    )

    assert report["checked"] is True, report
    assert report["guard"] == {"used": False, "counts": {}}, report


# --- page filter ------------------------------------------------------------


def test_page_filter_limits_the_check(workdir):
    source, output = mono_pair(
        workdir,
        [mono_page(SHORT_TEXT), mono_page(MARKER_TEXT)],
        [mono_page(LONG_TEXT), mono_page(LONG_TEXT)],
    )

    everything = translate_qa.verify(source, output, "译文")
    first_only = translate_qa.verify(source, output, "译文", page_filter=[1])
    second_text = translate_qa.verify(source, output, "译文", page_filter="2")

    assert everything["ok"] is False and [e["page"] for e in everything["missing"]] == [2]
    assert first_only["ok"] is True, first_only
    assert first_only["expected_paragraphs"] == 1, first_only
    assert second_text["ok"] is False, second_text
    assert [e["page"] for e in second_text["missing"]] == [2], second_text


# --- summarize --------------------------------------------------------------


def test_summarize_returns_short_chinese_lines(workdir):
    source, output = mono_pair(workdir, [mono_page(SHORT_TEXT)])
    guard = mixed_guard()

    report = translate_qa.verify(source, output, "译文", guard_status=guard)
    lines = translate_qa.summarize(report)

    assert isinstance(lines, list) and lines, lines
    assert all(isinstance(line, str) and line for line in lines), lines
    assert all(len(line) <= 120 for line in lines), lines
    assert any("应译" in line for line in lines), lines
    assert any("缺失" in line for line in lines), lines
    assert "兼容性优先" in lines[-1], lines

    healthy = translate_qa.verify(source, output, "译文")
    healthy_lines = translate_qa.summarize(healthy)
    assert healthy_lines[-1] == "译文完整性校验通过。", healthy_lines
    assert any("应译" in line for line in healthy_lines), healthy_lines


def test_summarize_handles_unchecked_and_invalid_reports():
    unchecked = translate_qa._unchecked("译文完整性校验未能执行：无法打开译文 PDF。")
    lines = translate_qa.summarize(unchecked)

    assert len(lines) == 1, lines
    assert "未能执行" in lines[0], lines
    assert len(lines[0]) <= 120, lines

    assert translate_qa.summarize(None) == ["译文完整性校验结果无效。"], translate_qa.summarize(None)
    assert isinstance(translate_qa.summarize({}), list)


# --- robustness -------------------------------------------------------------


def test_missing_source_and_corrupt_output_never_raise(workdir):
    output = write_pdf(workdir / "output.pdf", [mono_page(SHORT_TEXT)])

    no_source = translate_qa.verify(workdir / "nope.pdf", output, "译文")
    assert no_source["checked"] is False, no_source
    assert no_source["ok"] is False, no_source
    assert any("译文完整性校验未能执行" in line for line in no_source["warnings"]), no_source

    source = write_pdf(workdir / "source.pdf", [mono_page(LONG_TEXT)])
    corrupt = workdir / "corrupt.pdf"
    corrupt.write_bytes(b"%PDF-1.4 this is not really a pdf")
    broken_output = translate_qa.verify(source, corrupt, "译文")
    assert broken_output["checked"] is False, broken_output

    # Dual pages carry their original half, so a missing source still allows
    # the right-half check (same policy as core/pdfqa.py).
    dual_output = write_pdf(workdir / "dual.pdf", [dual_page(LONG_TEXT, "")])
    dual_report = translate_qa.verify("", dual_output, "双语对照")
    assert dual_report["checked"] is True, dual_report
    assert [entry["page"] for entry in dual_report["missing"]] == [1], dual_report


def test_kind_aliases_are_accepted(workdir):
    source = write_pdf(workdir / "source.pdf", [mono_page(LONG_TEXT)])
    dual_output = write_pdf(workdir / "dual.pdf", [dual_page(LONG_TEXT, "")])

    for kind in ("双语对照", "dual", "bilingual"):
        report = translate_qa.verify(source, dual_output, kind)
        assert report["ok"] is False, (kind, report)

    mono_source = write_pdf(workdir / "mono_source.pdf", [mono_page(LONG_TEXT)])
    mono_output = write_pdf(workdir / "mono_output.pdf", [mono_page(SHORT_TEXT)])
    for kind in ("译文", "mono", None):
        report = translate_qa.verify(mono_source, mono_output, kind)
        assert report["checked"] is True and report["ok"] is True, (kind, report)


# --- block helpers (reused by sibling tests) --------------------------------


def test_block_helpers_expose_geometry(workdir):
    # Build ("flush") a real PDF first: text extraction on an in-memory page
    # that was never saved is not reliable in PyMuPDF.
    path = write_pdf(
        workdir / "helpers.pdf",
        [mono_page(LONG_TEXT), mono_page(SHORT_TEXT)],
    )
    document = pymupdf.open(str(path))
    try:
        source_page = document[0]
        short_page = document[1]

        blocks = translate_qa.text_blocks(source_page, 25)
        assert len(blocks) == 1, blocks
        assert blocks[0][4].startswith("The quick brown fox"), blocks[0]
        assert len(blocks[0][4]) == len(LONG_TEXT), blocks[0]

        assert translate_qa.block_coverage(blocks[0][:4], [blocks[0][:4]]) == 1.0
        assert translate_qa.block_coverage(blocks[0][:4], []) == 0.0
        assert translate_qa.block_coverage(
            pymupdf.Rect(0, 0, 10, 10), [pymupdf.Rect(0, 0, 5, 10)]
        ) == pytest.approx(0.5)

        pairs = translate_qa.page_block_coverages(source_page, short_page)
        assert len(pairs) == 1, pairs
        assert 0.0 < pairs[0][1] < 1.0, pairs
        assert pairs[0][1] >= translate_qa.MONO_BLOCK_MIN_COVERAGE, pairs

        assert translate_qa.text_blocks(source_page, 10_000) == []
    finally:
        document.close()


def test_thresholds_reuse_pdfqa():
    from core import pdfqa

    assert translate_qa.MIN_SOURCE_CHARS == pdfqa.MIN_SOURCE_CHARS
    assert translate_qa.MAX_PAGES == pdfqa.MAX_PAGES
    assert translate_qa.WARNING_MAX_CHARS == pdfqa.WARNING_MAX_CHARS
    assert translate_qa.DUAL_RIGHT_RATIO == pdfqa.DUAL_RIGHT_RATIO
    assert translate_qa.MONO_BLOCK_MIN_COVERAGE == 0.12
    assert translate_qa.MIN_BLOCK_CHARS == 25


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
