"""Result library: find translated artefacts, group them and manage the files.

A document produced by BabelDOC shows up as a set of siblings:

   论文_译文.pdf     论文_双语对照.pdf     论文_术语表.csv

They are grouped by their shared base name inside each watched folder, which
gives the UI one card per translated paper.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from . import annotations, config, pdfinfo

LIBRARY_FILE = config.APP_DIR / "library.json"
THUMB_DIR = config.APP_DIR / "thumbs"

_ARTIFACT_RE = re.compile(r"^(?P<base>.+?)_(?P<kind>译文|双语对照)(?P<wm>（无水印）)?\.pdf$")
_GLOSSARY_RE = re.compile(r"^(?P<base>.+?)_术语表\.csv$")

KIND_ORDER = {"译文": 0, "双语对照": 1, "术语表": 2}
BAD_NAME_CHARS = '\\/:*?"<>|'

# page counts are cheap but not free; cache them per (path, mtime)
_PAGE_CACHE: dict[tuple[str, float], int | None] = {}


# --------------------------------------------------------------------------- #
# Watched folders
# --------------------------------------------------------------------------- #
def _load_extra_dirs() -> list[str]:
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    dirs = data.get("dirs") if isinstance(data, dict) else None
    return [item for item in (dirs or []) if isinstance(item, str)]


def _save_extra_dirs(dirs: list[str]) -> None:
    config.APP_DIR.mkdir(parents=True, exist_ok=True)
    LIBRARY_FILE.write_text(
        json.dumps({"dirs": dirs}, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def watched_dirs() -> list[str]:
    """Output folder from settings, the default one, plus user-added folders."""
    settings = config.load_raw()
    result: list[str] = []
    candidates = [
        settings.get("output_dir"),
        config.DEFAULTS["output_dir"],
        *_load_extra_dirs(),
    ]
    for raw in candidates:
        if not raw:
            continue
        try:
            folder = str(Path(str(raw)).expanduser().resolve())
        except OSError:
            continue
        if folder not in result:
            result.append(folder)
    return result


def extra_dirs() -> list[str]:
    return _load_extra_dirs()


def add_dir(path: str | Path) -> list[str]:
    folder = Path(str(path)).expanduser()
    if not folder.is_dir():
        raise ValueError("文件夹不存在")
    extra = _load_extra_dirs()
    resolved = str(folder.resolve())
    if resolved not in extra:
        extra.append(resolved)
        _save_extra_dirs(extra)
    return watched_dirs()


def remove_dir(path: str | Path) -> list[str]:
    folder = str(Path(str(path)).expanduser())
    extra = _load_extra_dirs()
    kept = [item for item in extra if item.lower() != folder.lower()]
    if kept != extra:
        _save_extra_dirs(kept)
    return watched_dirs()


# --------------------------------------------------------------------------- #
# Scanning
# --------------------------------------------------------------------------- #
def page_count(path: str | Path) -> int | None:
    try:
        stamp = Path(path).stat().st_mtime
    except OSError:
        return None
    key = (str(path), stamp)
    if key in _PAGE_CACHE:
        return _PAGE_CACHE[key]
    pages = pdfinfo.page_count(Path(path))
    _PAGE_CACHE[key] = pages
    return pages


def _iter_artifacts(folder: Path):
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return
    for path in entries:
        if not path.is_file():
            continue
        match = _ARTIFACT_RE.match(path.name)
        if match:
            label = match.group("kind") + (match.group("wm") or "")
            yield match.group("base"), label, path
            continue
        glossary = _GLOSSARY_RE.match(path.name)
        if glossary:
            yield glossary.group("base"), "术语表", path


def _item_id(folder: str, base: str) -> str:
    return hashlib.sha1(f"{folder.lower()}|{base}".encode("utf-8")).hexdigest()[:16]


def _sort_key(file: dict) -> tuple[int, str]:
    label = file["kind"].split("（")[0]
    return (KIND_ORDER.get(label, 9), file["name"])


def scan() -> list[dict]:
    items: dict[tuple[str, str], dict] = {}
    for raw in watched_dirs():
        folder = Path(raw)
        if not folder.is_dir():
            continue
        try:
            folder_key = str(folder.resolve())
        except OSError:
            folder_key = raw
        for base, kind, path in _iter_artifacts(folder):
            key = (folder_key, base)
            item = items.get(key)
            if item is None:
                item = {
                    "id": _item_id(folder_key, base),
                    "name": base,
                    "dir": folder_key,
                    "files": [],
                    "annotations": 0,
                }
                items[key] = item
            try:
                stat = path.stat()
            except OSError:
                continue
            item["files"].append(
                {
                    "kind": kind,
                    "name": path.name,
                    "path": str(path),
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                }
            )
    result: list[dict] = []
    for item in items.values():
        item["files"].sort(key=_sort_key)
        item["updated"] = max((file["mtime"] for file in item["files"]), default=0.0)
        item["size"] = sum(file["size"] for file in item["files"])
        primary = next((file for file in item["files"] if file["name"].endswith(".pdf")), None)
        item["primary"] = primary["path"] if primary else ""
        item["pages"] = page_count(primary["path"]) if primary else None
        item["annotations"] = sum(
            annotations.count(file["path"])
            for file in item["files"]
            if file["name"].lower().endswith(".pdf")
        )
        result.append(item)
    result.sort(key=lambda entry: entry["updated"], reverse=True)
    return result


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #
def _artifacts_for(folder: Path, base: str) -> list[tuple[str, str, Path]]:
    return [entry for entry in _iter_artifacts(folder) if entry[0] == base]


def _check_name(name: str) -> str:
    value = (name or "").strip()
    if not value:
        raise ValueError("名称不能为空")
    if any(char in value for char in BAD_NAME_CHARS):
        raise ValueError('名称不能包含 \\ / : * ? " < > |')
    if value.endswith("."):
        raise ValueError("名称不能以句点结尾")
    return value


def rename(folder: str | Path, base: str, new_base: str) -> dict:
    target_dir = Path(str(folder))
    new_name = _check_name(new_base)
    if new_name == base:
        return {"base": base, "dir": str(target_dir), "name": new_name, "renamed": 0}

    artefacts = _artifacts_for(target_dir, base)
    if not artefacts:
        raise FileNotFoundError("没有找到这个文件的产物")

    plans: list[tuple[Path, Path]] = []
    for old_base, _kind, path in artefacts:
        suffix = path.name[len(old_base):]
        destination = target_dir / f"{new_name}{suffix}"
        if destination.exists():
            raise FileExistsError(destination.name)
        plans.append((path, destination))

    done: list[tuple[Path, Path]] = []
    try:
        for source, destination in plans:
            source.rename(destination)
            done.append((source, destination))
    except OSError:
        for source, destination in reversed(done):
            try:
                destination.rename(source)
            except OSError:
                pass
        raise

    for source, destination in plans:
        if source.suffix.lower() == ".pdf":
            annotations.migrate(source, destination)
    return {"base": base, "dir": str(target_dir), "name": new_name, "renamed": len(plans)}


def _recycle(path: Path) -> None:
    """Send a file to the Windows Recycle Bin instead of deleting it outright."""
    import ctypes
    from ctypes import wintypes

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_uint16),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

    FO_DELETE = 0x0003
    FOF_SILENT = 0x0004
    FOF_NOCONFIRMATION = 0x0010
    FOF_ALLOWUNDO = 0x0040
    FOF_NOERRORUI = 0x0400

    source = ctypes.c_wchar_p(str(path) + "\0")
    operation = SHFILEOPSTRUCTW(
        None,
        FO_DELETE,
        source,
        None,
        FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        False,
        None,
        None,
    )
    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if code != 0 or operation.fAnyOperationsAborted:
        raise OSError(code, "无法移入回收站")


def delete(folder: str | Path, base: str) -> dict:
    target_dir = Path(str(folder))
    artefacts = _artifacts_for(target_dir, base)
    if not artefacts:
        raise FileNotFoundError("没有找到这个文件的产物")
    removed = 0
    for _old_base, _kind, path in artefacts:
        _recycle(path)
        if path.suffix.lower() == ".pdf":
            annotations.forget(path)
        removed += 1
    return {"base": base, "dir": str(target_dir), "removed": removed}


# --------------------------------------------------------------------------- #
# Thumbnails
# --------------------------------------------------------------------------- #
def thumbnail(path: str | Path, width: int = 420) -> bytes | None:
    document = Path(str(path))
    try:
        stamp = int(document.stat().st_mtime)
    except OSError:
        return None
    key = f"{annotations.document_id(document)}-{stamp}-{width}.png"
    cached = THUMB_DIR / key
    if cached.exists():
        try:
            return cached.read_bytes()
        except OSError:
            pass
    try:
        import fitz  # PyMuPDF
    except Exception:
        return None
    try:
        with fitz.open(document) as pdf:
            if pdf.page_count < 1:
                return None
            page = pdf[0]
            zoom = max(0.1, min(4.0, width / max(page.rect.width, 1)))
            pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            data = pixmap.tobytes("png")
    except Exception:
        return None
    try:
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(data)
    except OSError:
        pass
    return data
