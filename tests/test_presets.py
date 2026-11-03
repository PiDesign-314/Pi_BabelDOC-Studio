"""Tests for the bundled preset glossaries."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import glossary, presets  # noqa: E402


@pytest.fixture()
def preset_env(tmp_path, monkeypatch):
    monkeypatch.setattr(presets, "PRESET_DIR", Path(__file__).resolve().parents[1] / "presets")
    monkeypatch.setattr(presets, "MARKER_FILE", tmp_path / "presets.json")
    monkeypatch.setattr(presets, "config", type("Cfg", (), {"APP_DIR": tmp_path}))
    monkeypatch.setattr(glossary, "GLOSSARY_DIR", tmp_path / "glossaries")
    return tmp_path


def test_presets_are_listed_with_counts(preset_env):
    items = presets.list_presets()
    ids = {item["id"] for item in items}
    assert {"ai-ml", "hci-ux"} <= ids
    for item in items:
        assert item["count"] > 40
        assert item["name"]


def test_install_writes_a_glossary(preset_env):
    info = presets.install("ai-ml")
    assert info["count"] > 40
    names = {item["name"] for item in glossary.list_glossaries()}
    assert info["name"] in names

    after = {item["id"]: item for item in presets.list_presets()}
    assert after["ai-ml"]["installed"] is True
    assert after["hci-ux"]["installed"] is False


def test_install_rejects_unknown_id(preset_env):
    with pytest.raises(ValueError):
        presets.install("does-not-exist")


def test_ensure_seeded_runs_once(preset_env):
    presets.ensure_seeded()
    seeded = {item["name"] for item in glossary.list_glossaries()}
    assert len(seeded) >= 2
    assert (preset_env / "presets.json").exists()

    # a deleted preset must not come back on the next start
    first = sorted(seeded)[0]
    glossary.delete_glossary(first)
    presets.ensure_seeded()
    assert first not in {item["name"] for item in glossary.list_glossaries()}


def test_preset_entries_are_usable(preset_env):
    presets.install("hci-ux")
    detail = glossary.get_glossary("交互设计 · 人机交互")
    assert detail is not None
    entries = detail["entries"]
    assert len(entries) > 40
    assert all(entry["source"] and entry["target"] for entry in entries)
    assert entries[0]["tgt_lng"] == "zh"
