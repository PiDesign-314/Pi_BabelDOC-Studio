"""Offline tests for the Zotero prepare mode and the explicit read variants.

The results library's 翻译 action opens the translation page with the PDF
already loaded (no job), and its 阅读 menu opens the original, the translation
or the dual-language PDF explicitly.  Both are served by
``POST /api/zotero/open``; these tests drive that route end to end with a real
(tiny) PDF and an isolated ``config.APP_DIR``.

Run:  python -m pytest tests/test_zotero_prepare.py -q
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as studio_app  # noqa: E402
from core import config, library, zotero  # noqa: E402

# pytest's tmp_path is unusable under some sandboxes; the suite already points
# TEMP at a writable run folder, so scratch files go there explicitly.
_TEMP_ROOT = Path(os.environ.get("TEMP") or tempfile.gettempdir())


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #
@pytest.fixture()
def studio(monkeypatch):
    """Isolated APP_DIR + result folder + Flask client; never opens a window."""
    folder = Path(tempfile.mkdtemp(dir=str(_TEMP_ROOT), prefix="zotero-prepare-"))
    appdata = folder / "appdata"
    output = folder / "out"
    output.mkdir(parents=True)
    monkeypatch.setattr(config, "APP_DIR", appdata)
    monkeypatch.setattr(library, "watched_dirs", lambda: [str(output)])
    zotero._hash_cache.clear()
    windows: list[str] = []
    monkeypatch.setattr(
        studio_app, "_open_app_window", lambda url, size="1240,960": windows.append(url)
    )
    monkeypatch.setattr(studio_app, "_open_reader_window", lambda url: windows.append(url))
    try:
        yield {
            "root": folder,
            "output": output,
            "client": studio_app.app.test_client(),
            "app": studio_app,
            "windows": windows,
        }
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def make_pdf(path: Path, pages: int = 3, text: str = "Paper page") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    for index in range(pages):
        page = document.new_page(width=595, height=842)
        page.insert_text((72, 100), f"{text} {index + 1}", fontsize=14)
    document.save(path)
    document.close()
    return path


def source_pdf(studio: dict, name: str = "zotero-paper.pdf", pages: int = 3) -> Path:
    """A PDF in a fake Zotero storage folder, outside the app's managed roots."""
    return make_pdf(studio["root"] / "zotero-storage" / "ABCD1234" / name, pages=pages)


def open_payload(path: Path, **extra) -> dict:
    payload = {
        "path": str(path),
        "library_id": "1",
        "item_key": "ITEM0001",
        "attachment_key": "ATTACH01",
        "title": "面向家庭社交机器人的空闲行为设计",
        "doi": "10.1145/1234567.7654321",
        "creators": "Arias 等",
        "year": "2026",
        "open_window": False,
    }
    payload.update(extra)
    return payload


def artifact(studio: dict, imported: Path, kind: str, pages: int = 3) -> Path:
    """Write a translation / dual PDF beside the paper's result folder."""
    return make_pdf(
        studio["output"] / imported.stem / f"{imported.stem}_{kind}（无水印）.pdf",
        pages=pages,
    )


def post_open(studio: dict, path: Path, **extra):
    return studio["client"].post(
        "/api/zotero/open", json=open_payload(path, **extra)
    )


def viewer_path(url: str) -> str:
    """The ``path`` query parameter of a returned viewer URL."""
    return parse_qs(urlparse(url).query)["path"][0]


def _fail_job_start(*_args, **_kwargs):
    raise AssertionError("prepare mode must not start a translation job")


# --------------------------------------------------------------------------- #
# mode "prepare": import only, no job
# --------------------------------------------------------------------------- #
def test_prepare_returns_a_translation_draft_without_a_job(studio, monkeypatch):
    source = source_pdf(studio)
    # No provider configured at all: prepare must still answer.
    monkeypatch.setattr(config, "public_settings", lambda: {})
    monkeypatch.setattr(studio["app"], "_start_job", _fail_job_start)
    assert studio["app"].manager.current is None

    response = post_open(studio, source, mode="prepare")
    assert response.status_code == 200, response.get_json()
    data = response.get_json()
    assert data["ok"] is True
    assert data["mode"] == "prepare"
    assert data["link_id"]
    imported = Path(data["path"])
    assert imported.is_file()
    assert imported.suffix.lower() == ".pdf"
    # The Zotero storage file is copied into the managed imports folder.
    assert imported != source
    assert source.is_file()
    assert data["title"] == "面向家庭社交机器人的空闲行为设计"
    assert data["url"].startswith("/?prepare=")
    assert parse_qs(urlparse(data["url"]).query)["prepare"] == [str(imported)]
    # The library page passes open_window: false; nothing may be launched.
    assert studio["windows"] == []
    assert studio["app"].manager.current is None

    # Clicking 翻译 again reuses the same managed copy.
    again = post_open(studio, source, mode="prepare").get_json()
    assert again["path"] == data["path"]
    assert again["link_id"] == data["link_id"]
    assert studio["app"].manager.current is None

    # Only an explicit open_window: true may launch an app window.
    opened = post_open(studio, source, mode="prepare", open_window=True).get_json()
    assert studio["windows"] == [opened["url"]]


def test_prepare_explains_a_missing_attachment(studio):
    missing = studio["root"] / "zotero-storage" / "not-downloaded.pdf"
    response = post_open(studio, missing, mode="prepare")
    assert response.status_code == 404, response.get_json()
    data = response.get_json()
    assert data["ok"] is False
    assert data["code"] == "file_missing"
    assert data["retryable"] is True
    assert studio["windows"] == []
    assert studio["app"].manager.current is None


# --------------------------------------------------------------------------- #
# mode "read": explicit variants
# --------------------------------------------------------------------------- #
def test_explicit_variant_opens_that_edition(studio):
    source = source_pdf(studio)
    original = post_open(studio, source, mode="read", variant="original").get_json()
    imported = Path(original["path"])
    assert original["variant"] == "original"
    assert imported.is_file()
    assert imported != source
    assert viewer_path(original["url"]) == str(imported)
    assert original["page"] == 1

    translation = artifact(studio, imported, "译文")
    dual = artifact(studio, imported, "双语对照")
    for variant, expected in (("translation", translation), ("dual", dual)):
        response = post_open(studio, source, mode="read", variant=variant)
        assert response.status_code == 200, response.get_json()
        data = response.get_json()
        assert data["variant"] == variant
        assert Path(data["path"]) == expected
        assert viewer_path(data["url"]) == str(expected)
        assert data["page"] == 1
        assert data["pages"] == 3

    # An explicit variant wins over the automatic newest-translation pick...
    automatic = post_open(studio, source, mode="read").get_json()
    assert automatic["variant"] == "dual"
    forced = post_open(studio, source, mode="read", variant="original").get_json()
    assert forced["variant"] == "original"
    assert Path(forced["path"]) == imported


def test_read_without_variant_keeps_the_auto_preference(studio):
    source = source_pdf(studio)
    opened = post_open(studio, source, mode="read", variant="original").get_json()
    imported = Path(opened["path"])
    translation = artifact(studio, imported, "译文")

    resumed = post_open(studio, source, mode="read").get_json()
    assert resumed["ok"] is True
    assert resumed["variant"] == "translation"
    assert Path(resumed["path"]) == translation
    assert viewer_path(resumed["url"]) == str(translation)


def test_explicit_variant_maps_the_reader_page(studio):
    source = source_pdf(studio)
    opened = post_open(studio, source, mode="read", variant="original").get_json()
    # Alternating dual: twice the pages, original page n on output page 2n-1.
    dual = artifact(studio, Path(opened["path"]), "双语对照", pages=6)

    response = post_open(
        studio, source, mode="read", variant="dual", page=2, page_total=3
    )
    assert response.status_code == 200, response.get_json()
    data = response.get_json()
    assert data["variant"] == "dual"
    assert Path(data["path"]) == dual
    assert data["pages"] == 6
    assert data["page"] == 3


# --------------------------------------------------------------------------- #
# mode "read": errors
# --------------------------------------------------------------------------- #
def test_unavailable_variant_is_a_404(studio):
    source = source_pdf(studio)
    post_open(studio, source, mode="read", variant="original")

    for variant in ("translation", "dual"):
        response = post_open(studio, source, mode="read", variant=variant)
        assert response.status_code == 404, response.get_json()
        data = response.get_json()
        assert data["ok"] is False
        assert data["code"] == "variant_missing"
        assert data["retryable"] is False
        assert data["error"] == "这篇文献还没有该版本的译文"


@pytest.mark.parametrize("variant", ["pdf", "pdfs", "译文", "0"])
def test_bad_variant_is_a_400(studio, variant):
    source = source_pdf(studio)
    response = post_open(studio, source, mode="read", variant=variant)
    assert response.status_code == 400, response.get_json()
    data = response.get_json()
    assert data["ok"] is False
    assert data["code"] == "bad_variant"
    assert data["error"] == "不支持的阅读版本"
    # The value is rejected before the attachment is imported.
    assert zotero.status()["link_count"] == 0


def main() -> None:
    """Allow ``python tests/test_zotero_prepare.py`` without pytest flags."""
    raise SystemExit(pytest.main([__file__, "-q"]))


if __name__ == "__main__":
    main()
