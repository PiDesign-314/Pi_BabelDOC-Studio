"""Font registry tests: imported fonts stay local and are served by id."""

from __future__ import annotations

import pytest

from core import fonts


@pytest.fixture()
def font_dir(tmp_path, monkeypatch):
    import_dir = tmp_path / "fonts"
    monkeypatch.setattr(fonts, "IMPORT_DIR", import_dir)
    monkeypatch.setattr(fonts, "LABELS_FILE", import_dir / "labels.json")
    monkeypatch.setattr(fonts, "MAX_BYTES", 1024)
    monkeypatch.setattr(fonts, "_cache", [])
    monkeypatch.setattr(fonts, "_cache_at", 0.0)
    yield import_dir
    monkeypatch.setattr(fonts, "_cache", [])
    monkeypatch.setattr(fonts, "_cache_at", 0.0)


def test_imported_font_is_listed_and_served(font_dir):
    entry = fonts.import_bytes("夏日手写.ttf", b"fake-ttf-bytes", "夏日手写（测试）")
    assert entry["source"] == "imported"
    assert entry["label"] == "夏日手写（测试）"
    assert entry["suffix"] == "ttf"
    # The page never receives a local path.
    assert "file" not in entry
    assert list(font_dir.iterdir())

    listed = [item for item in fonts.public_fonts() if item["id"] == entry["id"]]
    assert listed and listed[0]["label"] == "夏日手写（测试）"
    assert all("file" not in item for item in fonts.public_fonts())

    found = fonts.font_file(entry["id"])
    assert found is not None
    path, mimetype = found
    assert path.exists() and mimetype == "font/ttf"


def test_reimporting_the_same_bytes_is_idempotent(font_dir):
    first = fonts.import_bytes("hand.ttf", b"same-font-data", "手写")
    second = fonts.import_bytes("hand.ttf", b"same-font-data", "手写")
    assert first["id"] == second["id"]
    assert len(list(font_dir.glob("*.ttf"))) == 1


def test_bad_font_names_are_rejected(font_dir):
    with pytest.raises(ValueError):
        fonts.import_bytes("notes.txt", b"hello")
    with pytest.raises(ValueError):
        fonts.import_bytes("font.ttf", b"")


def test_oversized_font_is_rejected(font_dir, monkeypatch):
    monkeypatch.setattr(fonts, "MAX_BYTES", 8)
    with pytest.raises(ValueError):
        fonts.import_bytes("font.ttf", b"x" * 9)


def test_family_names_are_cleaned():
    assert fonts._family("Microsoft YaHei (TrueType)") == "Microsoft YaHei"
    assert fonts._family("Arial & Arial Black") == "Arial"
    assert fonts._family("") == ""
    assert fonts._safe_stem("夏日手写 v1.0.ttf") == "夏日手写-v1.0"
    assert fonts._safe_stem("../../evil.ttf") == "evil"
