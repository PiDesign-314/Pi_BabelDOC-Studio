"""Font registry for the reader's page-text tool.

The reader lets the user type on the page with any font installed on the
machine, plus fonts they import themselves (a hand-written Chinese face, for
example).  A browser can only use the fonts that are installed or loaded over
``@font-face``, so every font the reader knows about gets a stable id and is
served from ``/api/font-file/<id>``.  Local file paths never reach the page —
the id is a hash over the family name and the resolved path.

Three sources are merged:

* ``system``   — Windows fonts, read from the "Fonts" registry key;
* ``imported`` — files the user added through the reader (stored in APPDATA);
* ``bundled``  — optional fonts shipped inside ``web/fonts``.

Imported fonts are kept out of the repository on purpose: the user is the one
who accepted the font's licence, and the app only stores the file locally.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import time
from pathlib import Path

from . import config

BASE_DIR = Path(__file__).resolve().parent.parent
BUNDLED_DIR = BASE_DIR / "web" / "fonts"
IMPORT_DIR = config.APP_DIR / "fonts"

SUFFIXES = {".ttf", ".otf", ".ttc", ".otc"}
MIME = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".ttc": "font/collection",
    ".otc": "font/collection",
}
MAX_BYTES = 64 * 1024 * 1024
CACHE_SECONDS = 20.0
LABELS_FILE = IMPORT_DIR / "labels.json"

# The registry changes only when a font is installed, so the whole list is
# cached for a short while: the reader asks for it on every page load.
_cache_at = 0.0
_cache: list[dict] = []

_FONT_NAME = re.compile(r"\s*\((TrueType|OpenType|PostScript|Variable)\)\s*$", re.IGNORECASE)
_UNSAFE = re.compile(r"[^\w\u3400-\u9fff.-]+", re.UNICODE)


def _family(raw: str) -> str:
    name = _FONT_NAME.sub("", str(raw or "")).strip()
    # "Microsoft YaHei & Microsoft YaHei UI" describes one file with two faces.
    name = name.split(" & ")[0].strip()
    return name[:80]


def _entry(family: str, path: Path, source: str) -> dict:
    key = f"{source}|{family}|{str(path).lower()}".encode("utf-8", "surrogatepass")
    font_id = hashlib.sha1(key).hexdigest()[:16]
    return {
        "id": font_id,
        "family": family,
        "label": family,
        "source": source,
        "css": f"BDF{font_id}",
        "suffix": path.suffix.lower().lstrip("."),
        "file": path,
    }


def _windows_entries() -> list[dict]:
    if sys.platform != "win32":
        return []
    import winreg

    fonts_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    keys = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
    )
    found: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for hive, key_path in keys:
        try:
            key = winreg.OpenKey(hive, key_path)
        except OSError:
            continue
        try:
            count = winreg.QueryInfoKey(key)[1]
            for index in range(count):
                try:
                    name, value, _kind = winreg.EnumValue(key, index)
                except OSError:
                    break
                if not isinstance(value, str) or not value.strip():
                    continue
                path = Path(value)
                if not path.is_absolute():
                    path = fonts_dir / value
                if path.suffix.lower() not in SUFFIXES:
                    continue
                try:
                    if not path.is_file():
                        continue
                except OSError:
                    continue
                family = _family(name)
                if not family:
                    continue
                marker = (family.casefold(), str(path).casefold())
                if marker in seen:
                    continue
                seen.add(marker)
                found.append(_entry(family, path, "system"))
        finally:
            key.Close()
    return found


def _read_labels() -> dict[str, str]:
    try:
        import json

        data = json.loads(LABELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value)[:80] for key, value in data.items() if value}


def _write_labels(labels: dict[str, str]) -> None:
    import json

    try:
        IMPORT_DIR.mkdir(parents=True, exist_ok=True)
        LABELS_FILE.write_text(json.dumps(labels, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass


def _directory_entries(directory: Path, source: str) -> list[dict]:
    found: list[dict] = []
    labels = _read_labels() if directory == IMPORT_DIR else {}
    try:
        files = sorted(directory.iterdir(), key=lambda item: item.name.casefold())
    except OSError:
        return found
    for path in files:
        if path.suffix.lower() not in SUFFIXES:
            continue
        try:
            if not path.is_file():
                continue
        except OSError:
            continue
        family = _family(labels.get(path.name) or path.stem.replace("_", " "))
        if not family:
            continue
        entry = _entry(family, path.resolve(), source)
        entry["label"] = family
        found.append(entry)
    return found


def _collect() -> list[dict]:
    entries = _directory_entries(IMPORT_DIR, "imported")
    entries += _directory_entries(BUNDLED_DIR, "bundled")
    entries += _windows_entries()

    # One entry per family + file, imported/bundled first, then alphabetically.
    order = {"imported": 0, "bundled": 1, "system": 2}
    entries.sort(key=lambda item: (order.get(item["source"], 9), item["label"].casefold()))
    unique: list[dict] = []
    seen: set[str] = set()
    for entry in entries:
        if entry["id"] in seen:
            continue
        seen.add(entry["id"])
        unique.append(entry)
    return unique


def registry(refresh: bool = False) -> list[dict]:
    global _cache, _cache_at
    now = time.monotonic()
    if refresh or not _cache or now - _cache_at > CACHE_SECONDS:
        _cache = _collect()
        _cache_at = now
    return _cache


def public_fonts() -> list[dict]:
    """The list the reader gets: ids and labels, never local paths."""
    return [
        {
            "id": item["id"],
            "family": item["family"],
            "label": item["label"],
            "source": item["source"],
            "css": item["css"],
            "suffix": item["suffix"],
        }
        for item in registry()
    ]


def find(font_id: str) -> dict | None:
    key = str(font_id or "").strip()
    if not key or len(key) > 40:
        return None
    for item in registry():
        if item["id"] == key:
            return item
    # A font imported in another window may not be in the cached list yet.
    for item in registry(refresh=True):
        if item["id"] == key:
            return item
    return None


def font_file(font_id: str) -> tuple[Path, str] | None:
    item = find(font_id)
    if not item:
        return None
    path: Path = item["file"]
    try:
        if not path.is_file():
            return None
    except OSError:
        return None
    return path, MIME.get(path.suffix.lower(), "application/octet-stream")


def _safe_stem(raw: str) -> str:
    stem = _UNSAFE.sub("-", Path(str(raw or "")).stem).strip("-. ")
    stem = stem[:60] or "imported-font"
    return stem


def import_bytes(filename: str, data: bytes, label: str = "") -> dict:
    """Store an uploaded font in the per-user font folder and register it."""
    suffix = Path(str(filename or "")).suffix.lower()
    if suffix not in SUFFIXES:
        raise ValueError("只支持 .ttf / .otf / .ttc 字体文件")
    if not data:
        raise ValueError("字体文件是空的")
    if len(data) > MAX_BYTES:
        raise ValueError("字体文件太大（最大 64 MB）")

    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()[:8]
    target = IMPORT_DIR / f"{_safe_stem(filename)}-{digest}{suffix}"
    if not target.exists():
        target.write_bytes(data)

    family = _family(label or Path(str(filename)).stem.replace("_", " ")) or _safe_stem(filename)
    labels = _read_labels()
    labels[target.name] = family
    _write_labels(labels)

    global _cache_at
    _cache_at = 0.0
    registry(refresh=True)
    entry = next((item for item in registry() if item["file"] == target.resolve()), None)
    if entry is None:  # pragma: no cover - the file was just written
        entry = _entry(family, target.resolve(), "imported")
        entry["label"] = family
    return {key: value for key, value in entry.items() if key != "file"}


def import_path(path: str | Path, label: str = "") -> dict:
    source = Path(str(path)).expanduser()
    if not source.is_file():
        raise ValueError(f"找不到字体文件：{source}")
    return import_bytes(source.name, source.read_bytes(), label)
