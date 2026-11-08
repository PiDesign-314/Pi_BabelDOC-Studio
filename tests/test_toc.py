"""Tests for outline reading, heuristic TOC detection and its cache."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pymupdf = pytest.importorskip("pymupdf")

from core import config, toc  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
NIPS_PDF = REPO / "papers" / "NIPS-2017-attention-is-all-you-need-Paper.pdf"

BODY = (
    "The dominant sequence transduction models are based on complex recurrent "
    "or convolutional neural networks that include an encoder and a decoder. "
    "The best performing models also connect the encoder and decoder through "
    "an attention mechanism. We propose a new simple network architecture, "
    "the Transformer, based solely on attention mechanisms."
)


@pytest.fixture()
def cache_env(tmp_path, monkeypatch):
    """Send the TOC cache to a temp APPDATA-style folder."""
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    return tmp_path


def _make_pdf(path: Path, outline: bool = False, pages: int = 4) -> Path:
    doc = pymupdf.open()
    headings = ["Introduction", "Method", "Results", "References"]
    for index in range(pages):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 90), f"Section heading {index + 1}", fontsize=16, fontname="hebo")
        page.insert_textbox(
            pymupdf.Rect(72, 110, 540, 700),
            "\n".join(BODY for _ in range(6)),
            fontsize=10,
            fontname="helv",
        )
    if outline:
        doc.set_toc(
            [
                [1, "Introduction", 1],
                [1, "Method", 2],
                [2, "Details", 3],
                [1, "References", 4],
            ]
        )
    doc.save(path)
    doc.close()
    return path


def _make_heuristic_pdf(path: Path) -> Path:
    """A paper without outline; headings are bold and larger than body."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "A Study of Attention", fontsize=22, fontname="hebo")
    page.insert_text((72, 130), "Abstract", fontsize=15, fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(72, 145, 540, 230), BODY, fontsize=10, fontname="helv"
    )
    page.insert_text((72, 270), "1 Introduction", fontsize=15, fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(72, 285, 540, 380), BODY, fontsize=10, fontname="helv"
    )
    page.insert_text((72, 420), "2 Method", fontsize=15, fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(72, 435, 540, 530), BODY, fontsize=10, fontname="helv"
    )

    page2 = doc.new_page(width=612, height=792)
    page2.insert_text((72, 90), "3 Results", fontsize=15, fontname="hebo")
    page2.insert_textbox(
        pymupdf.Rect(72, 105, 540, 220), BODY, fontsize=10, fontname="helv"
    )
    page2.insert_text((72, 300), "References", fontsize=15, fontname="hebo")
    page2.insert_textbox(
        pymupdf.Rect(72, 315, 540, 500),
        "\n".join(
            f"[{index}] A. Author. A cited paper number {index}. 2020."
            for index in range(1, 8)
        ),
        fontsize=10,
        fontname="helv",
    )
    doc.save(path)
    doc.close()
    return path


def _make_empty_pdf(path: Path) -> Path:
    doc = pymupdf.open()
    doc.new_page()
    doc.save(path)
    doc.close()
    return path


def _make_two_column_pdf(path: Path) -> Path:
    """Left column holds the abstract; the introduction starts in column 2."""
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((54, 100), "ABSTRACT", fontsize=12, fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(54, 115, 295, 640),
        "\n".join(
            [
                "We present a two column layout test with long enough body lines "
                "so that the gutter can be detected reliably on the page.",
                "The results show that the left column is read before the right "
                "column even when the right column starts a little higher.",
            ]
            * 6
        ),
        fontsize=10,
        fontname="helv",
    )
    page.insert_text((320, 95), "1 INTRODUCTION", fontsize=12, fontname="hebo")
    page.insert_textbox(
        pymupdf.Rect(320, 110, 560, 640),
        "\n".join(
            [
                "The introduction lives in the right column of this page and "
                "must be ordered after the abstract in the detected table of contents.",
                "Long body lines on this side make the two column detection work.",
            ]
            * 6
        ),
        fontsize=10,
        fontname="helv",
    )
    doc.save(path)
    doc.close()
    return path


# --------------------------------------------------------------------------- #
# Outline
# --------------------------------------------------------------------------- #
def test_outline_is_used_and_cached(tmp_path, cache_env):
    pdf = _make_pdf(tmp_path / "outline.pdf", outline=True)

    first = toc.read_toc(pdf)
    assert first["source"] == "outline"
    assert first["count"] == 4
    assert first["cached"] is False
    assert first["path"] == str(pdf)
    titles = [item["title"] for item in first["items"]]
    assert titles == ["Introduction", "Method", "Details", "References"]
    assert [item["level"] for item in first["items"]] == [1, 1, 2, 1]
    assert first["items"][0]["y"] is None
    assert all(item["score"] == 1.0 for item in first["items"])

    second = toc.read_toc(pdf)
    assert second["cached"] is True
    assert second["items"] == first["items"]

    forced = toc.read_toc(pdf, force=True)
    assert forced["cached"] is False
    assert forced["items"] == first["items"]


def test_cache_is_keyed_by_mtime_and_size(tmp_path, cache_env):
    pdf = _make_pdf(tmp_path / "paper.pdf", outline=True)
    toc.read_toc(pdf)
    cache_files = list(cache_env.glob("ai/toc-*.json"))
    assert len(cache_files) == 1

    later = time.time() + 5
    os.utime(pdf, (later, later))
    refreshed = toc.read_toc(pdf)
    assert refreshed["cached"] is False
    assert len(list(cache_env.glob("ai/toc-*.json"))) == 2


def test_missing_file_raises(tmp_path, cache_env):
    with pytest.raises(FileNotFoundError):
        toc.read_toc(tmp_path / "nope.pdf")


def test_cache_write_failure_does_not_break_result(tmp_path, cache_env, monkeypatch):
    pdf = _make_pdf(tmp_path / "paper.pdf", outline=True)

    def broken(*args, **kwargs):
        raise OSError("disk is full")

    monkeypatch.setattr(toc, "_write_cache", broken)
    result = toc.read_toc(pdf)
    assert result["source"] == "outline"
    assert result["count"] == 4


def test_corrupt_cache_is_ignored(tmp_path, cache_env):
    pdf = _make_pdf(tmp_path / "paper.pdf", outline=True)
    cache = toc.cache_path(pdf)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text("this is not json", encoding="utf-8")

    result = toc.read_toc(pdf)
    assert result["source"] == "outline"
    assert result["cached"] is False
    assert result["count"] == 4


# --------------------------------------------------------------------------- #
# Heuristic
# --------------------------------------------------------------------------- #
def test_heuristic_finds_common_headings(tmp_path, cache_env):
    pdf = _make_heuristic_pdf(tmp_path / "heuristic.pdf")
    result = toc.read_toc(pdf)

    assert result["source"] == "heuristic"
    assert result["count"] >= 5
    titles = [item["title"] for item in result["items"]]
    joined = " | ".join(titles)
    for expected in ("Abstract", "Introduction", "Method", "Results", "References"):
        assert expected.lower() in joined.lower()
    for item in result["items"]:
        assert 1 <= item["page"] <= 2
        assert item["level"] >= 1
        assert item["y"] is not None and item["y"] > 0
        assert 0.0 <= item["score"] <= 1.0
    pages = [item["page"] for item in result["items"]]
    assert pages == sorted(pages)


def test_heuristic_reads_two_column_pages_in_reading_order(tmp_path, cache_env):
    pdf = _make_two_column_pdf(tmp_path / "twocol.pdf")
    result = toc.read_toc(pdf)

    assert result["source"] == "heuristic"
    titles = [item["title"] for item in result["items"]]
    assert titles[:2] == ["ABSTRACT", "1 INTRODUCTION"]
    assert result["items"][0]["y"] > result["items"][1]["y"], (
        "right column starts higher but must still be read second"
    )


def test_empty_pdf_reports_none(tmp_path, cache_env):
    pdf = _make_empty_pdf(tmp_path / "empty.pdf")
    result = toc.read_toc(pdf)
    assert result["source"] == "none"
    assert result["items"] == []
    assert result["count"] == 0
    assert toc.read_toc(pdf)["cached"] is True


def test_heuristic_is_cached(tmp_path, cache_env):
    pdf = _make_heuristic_pdf(tmp_path / "paper.pdf")
    first = toc.read_toc(pdf)
    assert first["cached"] is False
    second = toc.read_toc(pdf)
    assert second["cached"] is True
    assert second["items"] == first["items"]


@pytest.mark.skipif(not NIPS_PDF.exists(), reason="NIPS sample paper is missing")
def test_nips_attention_paper_heuristic(cache_env):
    """The acceptance target: a paper with no outline still gets a real TOC."""
    result = toc.read_toc(NIPS_PDF, force=True)

    assert result["source"] == "heuristic"
    assert result["count"] >= 6
    titles = " | ".join(item["title"] for item in result["items"])
    for expected in (
        "Abstract",
        "Introduction",
        "Background",
        "Model Architecture",
        "Why Self-Attention",
        "Training",
        "Results",
        "Conclusion",
        "References",
    ):
        assert expected.lower() in titles.lower(), f"missing section: {expected}"

    items = result["items"]
    pages = [item["page"] for item in items]
    assert pages == sorted(pages)
    assert all(1 <= page <= 11 for page in pages)
    assert all(item["y"] is not None for item in items)
    assert all(0.0 <= item["score"] <= 1.0 for item in items)

    cached = toc.read_toc(NIPS_PDF)
    assert cached["cached"] is True
    assert cached["items"] == items
