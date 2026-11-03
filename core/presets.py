"""Bundled starter glossaries.

The CSVs in ``presets/`` are copied into the user's glossary folder so they can
be picked from the translation form.  Installed presets are tracked in
``%APPDATA%\\BabelDOC-Studio\\presets.json`` so deleting one is not undone on the
next start.
"""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from . import config, glossary

PRESET_DIR = Path(__file__).resolve().parents[1] / "presets"
MARKER_FILE = config.APP_DIR / "presets.json"


def _metadata() -> list[dict]:
    try:
        data = json.loads((PRESET_DIR / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict) and item.get("file")]


def _entries(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return []
    rows: list[dict] = []
    for row in csv.DictReader(io.StringIO(text)):
        source = (row.get("source") or "").strip()
        target = (row.get("target") or "").strip()
        if not source or not target:
            continue
        rows.append(
            {
                "source": source,
                "target": target,
                "tgt_lng": (row.get("tgt_lng") or "").strip(),
            }
        )
    return rows


def list_presets() -> list[dict]:
    installed = {item["name"] for item in glossary.list_glossaries()}
    result: list[dict] = []
    for meta in _metadata():
        path = PRESET_DIR / str(meta["file"])
        if not path.exists():
            continue
        name = str(meta.get("name") or path.stem)
        entries = _entries(path)
        result.append(
            {
                "id": str(meta.get("id") or path.stem),
                "name": name,
                "description": str(meta.get("description") or ""),
                "source": str(meta.get("source") or ""),
                "count": len(entries),
                "installed": name in installed,
            }
        )
    return result


def install(preset_id: str) -> dict:
    for meta in _metadata():
        if str(meta.get("id")) != preset_id:
            continue
        path = PRESET_DIR / str(meta["file"])
        entries = _entries(path)
        if not entries:
            raise ValueError("预设术语库是空的")
        name = str(meta.get("name") or path.stem)
        return glossary.write_glossary(name, entries)
    raise ValueError("没有这个预设术语库")


def ensure_seeded() -> None:
    """Install every bundled preset once per installation."""
    try:
        marker = json.loads(MARKER_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        marker = {}
    seeded = set(marker.get("seeded") or []) if isinstance(marker, dict) else set()

    changed = False
    for preset in list_presets():
        if preset["id"] in seeded:
            continue
        if not preset["installed"]:
            try:
                install(preset["id"])
            except (OSError, ValueError):
                continue
        seeded.add(preset["id"])
        changed = True

    if changed:
        try:
            config.APP_DIR.mkdir(parents=True, exist_ok=True)
            MARKER_FILE.write_text(
                json.dumps({"seeded": sorted(seeded)}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except OSError:
            pass
