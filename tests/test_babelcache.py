"""Tests for the BabelDOC empty-translation cache cleanup."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import babelcache  # noqa: E402

SCHEMA = """
CREATE TABLE _translationcache (
    id INTEGER NOT NULL PRIMARY KEY,
    translate_engine VARCHAR(20) NOT NULL,
    translate_engine_params TEXT NOT NULL,
    original_text TEXT NOT NULL,
    translation TEXT NOT NULL
)
"""


def make_cache(path: Path, rows: list[tuple[str, str]]) -> Path:
    connection = sqlite3.connect(str(path))
    try:
        connection.execute(SCHEMA)
        connection.executemany(
            "INSERT INTO _translationcache "
            "(translate_engine, translate_engine_params, original_text, translation) "
            "VALUES ('openai', '{}', ?, ?)",
            rows,
        )
        connection.commit()
    finally:
        connection.close()
    return path


def test_clears_only_empty_translations(tmp_path):
    path = make_cache(
        tmp_path / "cache.v1.db",
        [
            ("You are a professional zh native translator. body one", ""),
            ("You are a professional zh native translator. body two", "   "),
            ("You are a professional zh native translator. body three", "译文"),
            ("You are an expert multilingual terminologist.", ""),
        ],
    )

    cleared = babelcache.clear_empty_translations(path)

    assert cleared == 3
    connection = sqlite3.connect(str(path))
    try:
        left = connection.execute(
            "SELECT original_text, translation FROM _translationcache"
        ).fetchall()
    finally:
        connection.close()
    assert left == [("You are a professional zh native translator. body three", "译文")]


def test_missing_cache_is_a_noop(tmp_path):
    assert babelcache.clear_empty_translations(tmp_path / "missing.db") == 0


def test_unfamiliar_schema_is_a_noop(tmp_path):
    path = tmp_path / "other.db"
    connection = sqlite3.connect(str(path))
    try:
        connection.execute("CREATE TABLE something_else (id INTEGER)")
        connection.commit()
    finally:
        connection.close()

    assert babelcache.clear_empty_translations(path) == 0


def test_corrupt_file_is_a_noop(tmp_path):
    path = tmp_path / "broken.db"
    path.write_bytes(b"not a sqlite database")
    assert babelcache.clear_empty_translations(path) == 0
