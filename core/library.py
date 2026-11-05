"""Result library: find translated artefacts, group them and manage the files.

A document produced by BabelDOC shows up as a set of siblings:

   论文_译文.pdf     论文_双语对照.pdf     论文_术语表.csv

They are grouped by their shared base name and their folder, which gives the UI
one card per translated paper.  Newer results live in a per-paper folder
(``论文/论文_译文.pdf``) while older flat results are still picked up.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
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
# Watched folders and paper collections
# --------------------------------------------------------------------------- #
def _load_data() -> dict:
    """The library's own JSON: extra watched folders and paper collections."""
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"dirs": [], "collections": []}
    if not isinstance(data, dict):
        return {"dirs": [], "collections": []}
    dirs = [item for item in (data.get("dirs") or []) if isinstance(item, str)]
    collections = []
    for entry in data.get("collections") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        collections.append(
            {
                "id": str(entry.get("id") or _collection_id(name)),
                "name": name,
                "items": [str(item) for item in (entry.get("items") or []) if isinstance(item, str)],
                "created": float(entry.get("created") or 0) or time.time(),
            }
        )
    return {"dirs": dirs, "collections": collections}


def _save_data(data: dict) -> None:
    config.APP_DIR.mkdir(parents=True, exist_ok=True)
    LIBRARY_FILE.write_text(
        json.dumps(
            {
                "dirs": data.get("dirs") or [],
                "collections": data.get("collections") or [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _load_extra_dirs() -> list[str]:
    return _load_data()["dirs"]


def _save_extra_dirs(dirs: list[str]) -> None:
    data = _load_data()
    data["dirs"] = dirs
    _save_data(data)


def _collection_id(name: str) -> str:
    return hashlib.sha1(f"collection|{name}|{time.time()}".encode("utf-8")).hexdigest()[:10]


def _check_collection_name(raw: str, collections: list[dict], skip_id: str = "") -> str:
    name = (raw or "").strip()
    if not name:
        raise ValueError("合集名称不能为空")
    if len(name) > 40:
        raise ValueError("合集名称最多 40 个字符")
    if any(char in name for char in BAD_NAME_CHARS):
        raise ValueError('合集名称不能包含 \\ / : * ? " < > |')
    lowered = name.lower()
    if any(entry["name"].lower() == lowered and entry["id"] != skip_id for entry in collections):
        raise ValueError(f"已经有叫「{name}」的合集了")
    return name


def collections() -> list[dict]:
    """User defined groups of papers, in creation order."""
    items = _load_data()["collections"]
    return sorted(items, key=lambda entry: entry.get("created") or 0)


def create_collection(name: str) -> dict:
    data = _load_data()
    label = _check_collection_name(name, data["collections"])
    entry = {
        "id": _collection_id(label),
        "name": label,
        "items": [],
        "created": time.time(),
    }
    data["collections"].append(entry)
    _save_data(data)
    return entry


def rename_collection(collection_id: str, name: str) -> dict:
    data = _load_data()
    entry = next((item for item in data["collections"] if item["id"] == collection_id), None)
    if entry is None:
        raise FileNotFoundError("合集不存在")
    entry["name"] = _check_collection_name(name, data["collections"], entry["id"])
    _save_data(data)
    return entry


def delete_collection(collection_id: str) -> bool:
    data = _load_data()
    kept = [item for item in data["collections"] if item["id"] != collection_id]
    if len(kept) == len(data["collections"]):
        raise FileNotFoundError("合集不存在")
    data["collections"] = kept
    _save_data(data)
    return True


def assign_collections(item_id: str, collection_ids: list[str]) -> list[dict]:
    """Put a paper into exactly the given collections (removed from the rest)."""
    data = _load_data()
    known = {entry["id"] for entry in data["collections"]}
    wanted = {cid for cid in collection_ids if cid in known}
    for entry in data["collections"]:
        members = entry["items"]
        if entry["id"] in wanted:
            if item_id not in members:
                members.append(item_id)
        elif item_id in members:
            entry["items"] = [value for value in members if value != item_id]
    _save_data(data)
    return data["collections"]


def _remap_collection_ids(old_id: str, new_id: str) -> None:
    """Keep a paper's collections after it is renamed (its id changes)."""
    if not old_id or old_id == new_id:
        return
    data = _load_data()
    changed = False
    for entry in data["collections"]:
        if old_id in entry["items"]:
            entry["items"] = [new_id if value == old_id else value for value in entry["items"]]
            changed = True
    if changed:
        _save_data(data)


def _drop_collection_items(item_id: str) -> None:
    data = _load_data()
    changed = False
    for entry in data["collections"]:
        if item_id in entry["items"]:
            entry["items"] = [value for value in entry["items"] if value != item_id]
            changed = True
    if changed:
        _save_data(data)


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


def _parse_artifact(path: Path) -> tuple[str, str, Path] | None:
    match = _ARTIFACT_RE.match(path.name)
    if match:
        label = match.group("kind") + (match.group("wm") or "")
        return match.group("base"), label, path
    glossary = _GLOSSARY_RE.match(path.name)
    if glossary:
        return glossary.group("base"), "术语表", path
    return None


def _iter_artifacts(folder: Path):
    """Artefacts sitting directly inside ``folder`` (no recursion)."""
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return
    for path in entries:
        if not path.is_file():
            continue
        parsed = _parse_artifact(path)
        if parsed:
            yield parsed


def _scan_artifacts(folder: Path):
    """Artefacts in the watched folder plus each per-paper subfolder."""
    yield from _iter_artifacts(folder)
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return
    for path in entries:
        if path.is_dir():
            yield from _iter_artifacts(path)


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
        for base, kind, path in _scan_artifacts(folder):
            try:
                parent = str(path.parent.resolve())
            except OSError:
                parent = str(path.parent)
            key = (parent, base)
            item = items.get(key)
            if item is None:
                item = {
                    "id": _item_id(parent, base),
                    "name": base,
                    "dir": parent,
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
    membership: dict[str, list[str]] = {}
    for entry in collections():
        for item_id in entry["items"]:
            membership.setdefault(item_id, []).append(entry["id"])
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
        item["collections"] = membership.get(item["id"], [])
        result.append(item)
    result.sort(key=lambda entry: entry["updated"], reverse=True)
    return result


# --------------------------------------------------------------------------- #
# Mutations
# --------------------------------------------------------------------------- #
def _artifacts_for(folder: Path, base: str) -> list[tuple[str, str, Path]]:
    return [entry for entry in _iter_artifacts(folder) if entry[0] == base]


def _folder_key(folder: Path) -> str:
    try:
        return str(folder.resolve())
    except OSError:
        return str(folder)


def _is_watched_root(folder: Path) -> bool:
    """True for a folder the user watches itself (not one of our paper folders)."""
    key = _folder_key(folder).lower()
    for raw in watched_dirs():
        if str(Path(raw)).lower() == key:
            return True
        try:
            if _folder_key(Path(raw)).lower() == key:
                return True
        except OSError:
            continue
    return False


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

    # Annotation files are keyed by the full path, so remember where each file
    # was before the folder (and the files) are moved.
    origins = {source.name: source for source, _destination in plans}

    # A paper produced by this app lives in its own folder, so renaming the
    # paper should rename that folder too — everything about it stays together.
    old_dir = target_dir
    move_folder = target_dir.name == base and not _is_watched_root(target_dir)
    if move_folder:
        destination_dir = target_dir.with_name(new_name)
        if destination_dir.exists():
            raise FileExistsError(destination_dir.name)

    done: list[tuple[Path, Path]] = []
    try:
        if move_folder:
            old_dir.rename(target_dir.with_name(new_name))
            target_dir = old_dir.with_name(new_name)
            plans = [(target_dir / source.name, target_dir / destination.name) for source, destination in plans]
        for source, destination in plans:
            source.rename(destination)
            done.append((source, destination))
    except OSError:
        for source, destination in reversed(done):
            try:
                destination.rename(source)
            except OSError:
                pass
        if move_folder and target_dir != old_dir and target_dir.exists():
            try:
                target_dir.rename(old_dir)
            except OSError:
                pass
        raise

    for source, destination in plans:
        if destination.suffix.lower() == ".pdf":
            annotations.migrate(origins.get(source.name, source), destination)
    _remap_collection_ids(
        _item_id(_folder_key(old_dir), base),
        _item_id(_folder_key(target_dir), new_name),
    )
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
    key = _folder_key(target_dir)
    removed = 0
    for _old_base, _kind, path in artefacts:
        _recycle(path)
        if path.suffix.lower() == ".pdf":
            annotations.forget(path)
        removed += 1
    # Our own per-paper folder becomes empty: take it away as well.
    if target_dir.name == base and not _is_watched_root(target_dir):
        try:
            target_dir.rmdir()
        except OSError:
            pass
    _drop_collection_items(_item_id(key, base))
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
