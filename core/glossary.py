"""Glossary (术语库) management.

BabelDOC accepts one or more CSV files via ``--glossary-files``.  Each file
needs a header with at least ``source,target`` (an optional ``tgt_lng`` column
restricts a row to one target language).
"""

from __future__ import annotations

import csv
import io
import re
from pathlib import Path

from .config import GLOSSARY_DIR

HEADER = ["source", "target", "tgt_lng"]


def _safe_name(name: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]+', "-", (name or "").strip())
    cleaned = cleaned.strip(" .-")
    return cleaned[:60] or "未命名术语库"


def _path_of(name: str) -> Path:
    return GLOSSARY_DIR / f"{_safe_name(name)}.csv"


def list_glossaries() -> list[dict]:
    GLOSSARY_DIR.mkdir(parents=True, exist_ok=True)
    items: list[dict] = []
    for path in sorted(GLOSSARY_DIR.glob("*.csv")):
        rows = _read_rows(path)
        items.append(
            {
                "id": path.stem,
                "name": path.stem,
                "count": len(rows),
                "path": str(path),
                "updated": path.stat().st_mtime,
                "preview": rows[:4],
            }
        )
    return items


def _read_rows(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return []
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict] = []
    for row in reader:
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


def get_glossary(name: str) -> dict | None:
    path = _path_of(name)
    if not path.exists():
        return None
    return {
        "id": path.stem,
        "name": path.stem,
        "path": str(path),
        "entries": _read_rows(path),
    }


def write_glossary(name: str, entries: list[dict]) -> dict:
    GLOSSARY_DIR.mkdir(parents=True, exist_ok=True)
    path = _path_of(name)
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=HEADER, extrasaction="ignore")
    writer.writeheader()
    written = 0
    for entry in entries or []:
        source = (entry.get("source") or "").strip()
        target = (entry.get("target") or "").strip()
        if not source or not target:
            continue
        writer.writerow(
            {
                "source": source,
                "target": target,
                "tgt_lng": (entry.get("tgt_lng") or "").strip(),
            }
        )
        written += 1
    path.write_text(buffer.getvalue(), encoding="utf-8", newline="")
    return {"id": path.stem, "name": path.stem, "count": written, "path": str(path)}


def import_csv(filename: str, content: bytes) -> dict:
    """Import an uploaded CSV file (source,target[,tgt_lng])."""
    text = _decode(content)
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = [f.strip().lower() for f in (reader.fieldnames or [])]
    if "source" not in fieldnames or "target" not in fieldnames:
        # permit header-less two-column files
        rows = [row for row in csv.reader(io.StringIO(text)) if len(row) >= 2]
        entries = [{"source": r[0], "target": r[1]} for r in rows]
    else:
        entries = [
            {
                "source": row.get("source", ""),
                "target": row.get("target", ""),
                "tgt_lng": row.get("tgt_lng", "") or "",
            }
            for row in reader
        ]
    name = Path(filename).stem or "导入的术语库"
    return write_glossary(name, entries)


def _decode(content: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gbk", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def delete_glossary(name: str) -> bool:
    path = _path_of(name)
    if path.exists():
        try:
            path.unlink()
            return True
        except OSError:
            return False
    return False


def resolve_paths(names: list[str]) -> list[str]:
    paths: list[str] = []
    for name in names or []:
        path = _path_of(name)
        if path.exists():
            paths.append(str(path))
    return paths
