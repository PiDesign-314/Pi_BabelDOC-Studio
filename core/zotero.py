"""Zotero → ReadPI bridge.

A Zotero add-on hands one PDF attachment to the local app.  This module owns
everything that must survive between clicks:

* **one imported copy per attachment.**  Zotero keeps its files in
  ``Zotero/storage/…``; the reader only serves files inside folders it manages,
  so the first open copies the PDF into ``%APPDATA%\\BabelDOC-Studio\\zotero\\
  imports\\<link>\\``.  The copy is addressed by a stable link id built from
  ``libraryID + itemKey + attachmentKey`` (content SHA-256 as a fallback), never
  by the file name.  Opening the same attachment again reuses that path, so the
  annotation store, the notes and the reading position keep working.
* **linked metadata.**  Title / DOI / creators are kept with the link so the
  app can show what Zotero asked to open.
* **the last reading position per link and per artefact.**  Translation and
  dual-language PDFs are separate files; each gets its own page (see
  :func:`map_page` for the original → translated page mapping).  When Zotero
  comes from its PDF reader with a page number, that page wins; otherwise the
  position of the file last read is restored.
* **the Zotero add-on package.**  ``tools/zotero-plugin`` is zipped on demand by
  :func:`build_plugin_xpi`, so the app can serve an installable ``.xpi`` and the
  add-on never ships as a stale binary blob.

The module keeps its file access behind one re-entrant lock: Flask serves
requests from several threads, and the link registry is a small JSON file.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import sys
import threading
import time
import zipfile
from pathlib import Path

from . import config, pdfinfo

DATA_DIR_NAME = "zotero"
LINK_SCHEMA_VERSION = 1
MAX_LINKS = 500
MAX_POSITIONS = 12
# Re-scan the output folders for new translation artefacts at most this often
# per link; a translation finishes minutes after a Zotero open, not seconds.
ARTIFACT_SCAN_SECONDS = 12.0
MAX_TITLE = 300
MAX_DOI = 200
MAX_CREATORS = 400

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_DIR = ROOT / "tools" / "zotero-plugin"

_BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_ARTIFACT_KINDS = {"译文": "translation", "双语对照": "dual"}
_lock = threading.RLock()
_hash_cache: dict[tuple[str, int, int], str] = {}


class ZoteroError(Exception):
    """A failure that can be shown to the user as-is.

    ``code`` is stable for the add-on (``file_missing`` / ``not_pdf`` / …),
    ``retryable`` tells it whether a retry button makes sense and ``status`` is
    the HTTP status the API should return.
    """

    def __init__(
        self,
        message: str,
        code: str = "zotero_error",
        status: int = 400,
        retryable: bool = False,
        detail: str = "",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.retryable = retryable
        self.detail = detail

    def payload(self) -> dict:
        return {
            "ok": False,
            "error": self.message,
            "code": self.code,
            "retryable": self.retryable,
            "detail": self.detail,
        }


# --------------------------------------------------------------------------- #
# Paths (resolved on every call so tests can point config.APP_DIR elsewhere)
# --------------------------------------------------------------------------- #
def data_dir() -> Path:
    return config.APP_DIR / DATA_DIR_NAME


def imports_dir() -> Path:
    return data_dir() / "imports"


def links_file() -> Path:
    return data_dir() / "links.json"


def launch_file() -> Path:
    return data_dir() / "launch-info.json"


def _ensure_dirs() -> None:
    for folder in (data_dir(), imports_dir()):
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def _text(value, limit: int) -> str:
    text = str(value or "").strip()
    return text[:limit]


def _page_number(value, fallback: int = 0) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return number if number > 0 else fallback


def safe_pdf_name(name: str, fallback: str = "paper.pdf") -> str:
    """A file name that is safe on Windows and still recognisable."""
    stem = Path(str(name or "")).stem
    clean = _BAD_NAME.sub("_", stem).strip(" .")
    if len(clean) > 80:
        clean = clean[:80].rstrip(" .")
    return f"{clean or Path(fallback).stem}.pdf"


def _resolve(raw) -> Path | None:
    try:
        return Path(str(raw)).expanduser().resolve()
    except OSError:
        return None


def file_sha256(path: Path) -> str:
    """SHA-256 with a per-(path, mtime, size) memo.

    Re-opening the same 20 MB paper should not re-hash it; a changed file gets a
    new stamp and is hashed again.
    """
    try:
        stat = path.stat()
    except OSError as exc:
        raise ZoteroError(
            f"附件无法读取：{exc}", code="unreadable", status=422, retryable=True
        ) from exc
    key = (str(path), int(stat.st_mtime_ns), int(stat.st_size))
    cached = _hash_cache.get(key)
    if cached:
        return cached
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ZoteroError(
            f"附件无法读取：{exc}", code="unreadable", status=422, retryable=True
        ) from exc
    value = digest.hexdigest()
    if len(_hash_cache) > 64:
        _hash_cache.clear()
    _hash_cache[key] = value
    return value


def _same_path(left: str | Path, right: str | Path) -> bool:
    try:
        left_path = Path(str(left)).resolve()
        right_path = Path(str(right)).resolve()
    except OSError:
        return False
    return os.path.normcase(str(left_path)) == os.path.normcase(str(right_path))


# --------------------------------------------------------------------------- #
# Link registry
# --------------------------------------------------------------------------- #
def _blank_data() -> dict:
    return {"version": LINK_SCHEMA_VERSION, "links": {}}


def _clean_position(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None
    path = str(entry.get("path") or "")
    page = _page_number(entry.get("page"))
    if not path or not page:
        return None
    return {
        "path": path,
        "page": page,
        "pages": _page_number(entry.get("pages")),
        "variant": str(entry.get("variant") or "original"),
        "updated": float(entry.get("updated") or 0),
    }


def _clean_artifact(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None
    path = str(entry.get("path") or "")
    if not path:
        return None
    return {
        "path": path,
        "pages": _page_number(entry.get("pages")),
        "mtime": float(entry.get("mtime") or 0),
        "mode": str(entry.get("mode") or ""),
    }


def _clean_link(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    link_id = str(raw.get("id") or "")
    imported = str(raw.get("imported_path") or "")
    if not link_id or not imported:
        return None
    positions = {}
    stored_positions = raw.get("positions")
    if isinstance(stored_positions, dict):
        for key, value in stored_positions.items():
            cleaned = _clean_position(value)
            if cleaned:
                positions[str(key)] = cleaned
    artifacts = {}
    stored_artifacts = raw.get("artifacts")
    if isinstance(stored_artifacts, dict):
        for key, value in stored_artifacts.items():
            cleaned = _clean_artifact(value)
            if cleaned:
                artifacts[str(key)] = cleaned
    last_view = _clean_position(raw.get("last_view"))
    return {
        "id": link_id,
        "version": int(raw.get("version") or 1),
        "library_id": str(raw.get("library_id") or ""),
        "item_key": str(raw.get("item_key") or ""),
        "attachment_key": str(raw.get("attachment_key") or ""),
        "doi": _text(raw.get("doi"), MAX_DOI),
        "title": _text(raw.get("title"), MAX_TITLE),
        "creators": _text(raw.get("creators"), MAX_CREATORS),
        "year": _text(raw.get("year"), 12),
        "source_path": str(raw.get("source_path") or ""),
        "imported_path": imported,
        "content_sha256": str(raw.get("content_sha256") or ""),
        "size": int(raw.get("size") or 0),
        "created": float(raw.get("created") or 0) or time.time(),
        "updated": float(raw.get("updated") or 0) or time.time(),
        "open_count": int(raw.get("open_count") or 0),
        "artifacts_scanned": float(raw.get("artifacts_scanned") or 0),
        "positions": positions,
        "artifacts": artifacts,
        "last_view": last_view,
    }


def _load_locked() -> dict:
    try:
        data = json.loads(links_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _blank_data()
    if not isinstance(data, dict):
        return _blank_data()
    links = {}
    for key, value in (data.get("links") or {}).items():
        cleaned = _clean_link(value)
        if cleaned:
            links[str(key)] = cleaned
    return {"version": LINK_SCHEMA_VERSION, "links": links}


def _save_locked(data: dict) -> None:
    _ensure_dirs()
    links = list(data.get("links", {}).values())
    links.sort(key=lambda item: item.get("updated") or 0, reverse=True)
    kept = {item["id"]: item for item in links[:MAX_LINKS]}
    payload = json.dumps(
        {"version": LINK_SCHEMA_VERSION, "links": kept},
        ensure_ascii=False,
        indent=2,
    )
    target = links_file()
    temporary = target.with_suffix(".json.tmp")
    try:
        temporary.write_text(payload, encoding="utf-8")
        os.replace(temporary, target)
    except OSError as exc:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise ZoteroError(f"无法保存 Zotero 关联记录：{exc}", code="registry_error", status=500) from exc


# --------------------------------------------------------------------------- #
# Stable identifiers
# --------------------------------------------------------------------------- #
def link_id_for(
    library_id: str,
    item_key: str,
    attachment_key: str,
    content_sha256: str = "",
) -> str:
    """The stable id of one Zotero attachment link.

    ``attachmentKey`` is the primary identifier (it survives file renames and
    moves).  ``itemKey``/``libraryID`` make it unique across libraries, and the
    content hash is the last resort when an older add-on cannot send keys.
    """
    library = _text(library_id, 40)
    item = _text(item_key, 40)
    attachment = _text(attachment_key, 40)
    if attachment:
        raw = f"zotero|{library}|{item}|{attachment}"
    elif item:
        raw = f"zotero-item|{library}|{item}|{content_sha256[:20]}"
    else:
        raw = f"zotero-file|{content_sha256}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _import_target(link_id: str, source_name: str, digest: str) -> Path:
    return imports_dir() / link_id / safe_pdf_name(source_name)


def _copy_attachment(source: Path, link_id: str, digest: str) -> tuple[Path, bool]:
    """Copy ``source`` into the managed imports folder without duplicating it."""
    target = _import_target(link_id, source.name, digest)
    try:
        if target.is_file():
            # Same content already imported: reuse the exact path so the
            # annotation document id does not change.
            try:
                if file_sha256(target) == digest:
                    return target, False
            except ZoteroError:
                pass
            # Different content under the same name: keep both, addressable by
            # the content hash, instead of overwriting old annotations' file.
            target = target.with_name(f"{target.stem}~{digest[:8]}{target.suffix}")
            if target.is_file():
                return target, False
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    except OSError as exc:
        raise ZoteroError(
            f"无法把附件复制到 ReadPI 数据目录：{exc}",
            code="import_failed",
            status=500,
            retryable=True,
        ) from exc
    return target, True


# --------------------------------------------------------------------------- #
# Importing / linking
# --------------------------------------------------------------------------- #
def _clean_meta(payload: dict) -> dict:
    value = payload if isinstance(payload, dict) else {}
    raw_path = str(value.get("path") or value.get("file") or "").strip()
    if not raw_path:
        raise ZoteroError(
            "Zotero 没有提供附件路径。请先在 Zotero 中下载这个 PDF 附件。",
            code="missing_path",
            status=400,
            retryable=True,
        )
    source = _resolve(raw_path)
    if source is None:
        raise ZoteroError(
            "附件路径无法识别，请检查 Zotero 中的附件是否已经下载。",
            code="missing_path",
            status=400,
            retryable=True,
        )
    if not source.is_file():
        raise ZoteroError(
            f"附件尚未下载或文件已丢失：{source.name}。"
            "请先在 Zotero 中下载附件，再重试。",
            code="file_missing",
            status=404,
            retryable=True,
            detail=str(source),
        )
    if source.suffix.lower() != ".pdf":
        raise ZoteroError(
            "这个附件不是 PDF，只有 PDF 附件才能在 ReadPI 中阅读。",
            code="not_pdf",
            status=415,
            retryable=False,
        )
    return {
        "path": source,
        "library_id": _text(value.get("library_id"), 40),
        "item_key": _text(value.get("item_key") or value.get("itemID"), 40),
        "attachment_key": _text(value.get("attachment_key") or value.get("attachmentID"), 40),
        "doi": _text(value.get("doi"), MAX_DOI),
        "title": _text(value.get("title"), MAX_TITLE),
        "creators": _text(value.get("creators"), MAX_CREATORS),
        "year": _text(value.get("year"), 12),
    }


def import_attachment(payload: dict) -> tuple[dict, bool]:
    """Import (or re-link) one Zotero attachment.

    Returns ``(record, copied)``.  ``copied`` is False when the same content was
    already inside the app; callers can use it for a friendlier message.
    """
    meta = _clean_meta(payload)
    source: Path = meta["path"]
    digest = file_sha256(source)
    with _lock:
        data = _load_locked()
        link_id = link_id_for(
            meta["library_id"], meta["item_key"], meta["attachment_key"], digest
        )
        record = data["links"].get(link_id)
        # The same PDF may already be imported under another link (e.g. the
        # item was re-created in Zotero).  Reuse the managed copy, not the bytes.
        shared = None
        for other in data["links"].values():
            if other.get("content_sha256") != digest:
                continue
            candidate = _resolve(other.get("imported_path") or "")
            if candidate and candidate.is_file():
                shared = candidate
                break
        if (
            record
            and record.get("content_sha256") == digest
            and (_resolve(record.get("imported_path") or "") or Path()).is_file()
        ):
            imported = Path(record["imported_path"])
            copied = False
        elif shared is not None:
            imported = shared
            copied = False
        else:
            imported, copied = _copy_attachment(source, link_id, digest)
        now = time.time()
        previous = record or {}
        created = float(previous.get("created") or now)
        # The attachment content changed (same Zotero keys, a replaced PDF):
        # keep the link and its metadata, but start a fresh reading history so
        # the old page numbers cannot land on a different document.
        content_changed = bool(
            previous.get("content_sha256") and previous.get("content_sha256") != digest
        )
        record = {
            **(previous if isinstance(previous, dict) else {}),
            "id": link_id,
            "version": LINK_SCHEMA_VERSION,
            "library_id": meta["library_id"] or previous.get("library_id", ""),
            "item_key": meta["item_key"] or previous.get("item_key", ""),
            "attachment_key": meta["attachment_key"] or previous.get("attachment_key", ""),
            "doi": meta["doi"] or previous.get("doi", ""),
            "title": meta["title"] or previous.get("title", ""),
            "creators": meta["creators"] or previous.get("creators", ""),
            "year": meta["year"] or previous.get("year", ""),
            "source_path": str(source),
            "imported_path": str(imported),
            "content_sha256": digest,
            "size": int(source.stat().st_size if source.exists() else 0),
            "created": created,
            "updated": now,
            "open_count": int(previous.get("open_count") or 0),
            "artifacts_scanned": 0.0 if content_changed else float(previous.get("artifacts_scanned") or 0),
            "positions": {} if content_changed else (previous.get("positions") or {}),
            "artifacts": {} if content_changed else (previous.get("artifacts") or {}),
            "last_view": None if content_changed else previous.get("last_view"),
        }
        data["links"][link_id] = record
        _save_locked(data)
        return dict(record), copied


# --------------------------------------------------------------------------- #
# Artefacts (translation / dual-language PDFs) and reading positions
# --------------------------------------------------------------------------- #
def _artifact_regex(stem: str) -> re.Pattern:
    escaped = re.escape(stem)
    return re.compile(
        rf"^{escaped}_(?P<kind>译文|双语对照)(?:（无水印）)?\.pdf$", re.IGNORECASE
    )


# Any artefact name, for the one-pass folder index used by the library page.
_ARTIFACT_NAME_RE = re.compile(
    r"^(?P<stem>.+?)_(?P<kind>译文|双语对照)(?:（无水印）)?\.pdf$", re.IGNORECASE
)


def _iter_folder_files(folder: Path):
    """Artefacts directly in ``folder`` and in its per-paper subfolders."""
    for directory in (folder,):
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for path in entries:
            if path.is_file():
                yield path
            elif path.is_dir():
                try:
                    for child in sorted(path.iterdir()):
                        if child.is_file():
                            yield child
                except OSError:
                    continue


def discover_artifacts(record: dict, force: bool = False) -> dict:
    """Find the translation / dual PDFs produced for this imported paper."""
    if not force and time.time() - float(record.get("artifacts_scanned") or 0) < ARTIFACT_SCAN_SECONDS:
        return record
    imported = _resolve(record.get("imported_path") or "")
    if imported is None:
        return record
    pattern = _artifact_regex(imported.stem)
    found: dict[str, Path] = {}
    try:
        from . import library

        roots = [Path(item) for item in library.watched_dirs()]
    except Exception:
        roots = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in _iter_folder_files(root):
            match = pattern.match(path.name)
            if not match:
                continue
            variant = _ARTIFACT_KINDS.get(match.group("kind"))
            if not variant:
                continue
            previous = found.get(variant)
            try:
                stamp = path.stat().st_mtime
            except OSError:
                continue
            if previous is None or stamp > previous.stat().st_mtime:
                found[variant] = path
    original_pages = pdfinfo.page_count(imported) or 0
    artifacts = {}
    for variant, path in found.items():
        pages = pdfinfo.page_count(path) or 0
        mode = ""
        if variant == "dual" and original_pages and pages:
            mode = "alternate" if pages >= original_pages * 2 - 1 else "side"
        artifacts[variant] = {
            "path": str(path),
            "pages": pages,
            "mtime": path.stat().st_mtime,
            "mode": mode,
        }
    record["artifacts"] = artifacts
    record["artifacts_scanned"] = time.time()
    return record


def artifacts_index() -> dict[str, dict[str, str]]:
    """Map a paper's file stem to its translation / dual PDFs on disk.

    The link registry only knows about artefacts it scanned (on open or on a
    position report), while the library page has to show a paper translated
    from the main UI straight away.  One walk over the watched folders is much
    cheaper than calling :func:`discover_artifacts` for every link, so this is
    the bulk lookup used to join a Zotero snapshot with its results.
    """
    result: dict[str, dict[str, str]] = {}
    try:
        from . import library

        roots = [Path(item) for item in library.watched_dirs()]
    except Exception:
        roots = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in _iter_folder_files(root):
            match = _ARTIFACT_NAME_RE.match(path.name)
            if not match:
                continue
            variant = _ARTIFACT_KINDS.get(match.group("kind"))
            if not variant:
                continue
            # A re-run of the same paper may leave several files; the newest
            # one is the translation the user just produced.
            entry = result.setdefault(match.group("stem"), {})
            previous = entry.get(variant)
            try:
                stamp = path.stat().st_mtime
            except OSError:
                continue
            if previous is None:
                entry[variant] = str(path)
                continue
            try:
                previous_stamp = Path(previous).stat().st_mtime
            except OSError:
                previous_stamp = -1.0
            if stamp > previous_stamp:
                entry[variant] = str(path)
    return result


def variant_for_path(record: dict, path: str | Path) -> str:
    """Which file of the link is ``path``: original / translation / dual?"""
    imported = record.get("imported_path") or ""
    if imported and _same_path(path, imported):
        return "original"
    for variant, entry in (record.get("artifacts") or {}).items():
        if isinstance(entry, dict) and _same_path(path, entry.get("path") or ""):
            return variant
    # The link's artefacts may not have been scanned yet; recognise the naming
    # convention in the file name so a report from the reader still lands.
    imported_path = _resolve(imported)
    candidate = _resolve(path)
    if imported_path and candidate and candidate.stem.startswith(imported_path.stem + "_"):
        suffix = candidate.stem[len(imported_path.stem) + 1 :]
        if suffix.startswith("译文"):
            return "translation"
        if suffix.startswith("双语对照"):
            return "dual"
    return "unknown"


def _link_id_for_path(data: dict, path: str | Path) -> tuple[dict, str] | None:
    """Find the link a reader path belongs to, plus its variant."""
    for record in data["links"].values():
        variant = variant_for_path(record, path)
        if variant != "unknown":
            return record, variant
    # An artefact can be read from the result library before the link ever saw
    # it; match the `<stem>_译文` / `<stem>_双语对照` naming instead.
    candidate = _resolve(path)
    if candidate is None:
        return None
    for record in data["links"].values():
        imported = _resolve(record.get("imported_path") or "")
        if imported and candidate.stem.startswith(imported.stem + "_"):
            return record, variant_for_path(record, candidate)
    return None


def map_page(
    page,
    from_variant: str,
    to_variant: str,
    from_pages: int = 0,
    to_pages: int = 0,
    dual_mode: str = "side",
) -> int:
    """Map a 1-based page from one file of a paper to another.

    Original → translated / side-by-side dual is the identity (BabelDOC keeps
    the page structure).  Alternating-pages dual doubles the page count: the
    original page ``n`` sits on output page ``2n - 1``.  Anything the mapping
    cannot prove falls back to the same page number (the "回到原文对应页"
    requirement), clamped into the target document.
    """
    number = _page_number(page, 1)
    if from_pages:
        number = min(number, max(1, from_pages))
    if from_variant == to_variant:
        target = number
    elif from_variant == "original" and to_variant == "dual" and dual_mode == "alternate":
        target = number * 2 - 1
    elif from_variant == "dual" and to_variant == "original" and dual_mode == "alternate":
        target = (number + 1) // 2
    else:
        target = number
    if to_pages:
        target = min(max(1, target), max(1, to_pages))
    return max(1, target)


def _store_position(record: dict, path: str, page: int, pages: int) -> dict:
    variant = variant_for_path(record, path)
    entry = {
        "path": str(path),
        "page": max(1, int(page)),
        "pages": max(0, int(pages or 0)),
        "variant": variant,
        "updated": time.time(),
    }
    positions = record.get("positions") or {}
    key = str(path)
    # Case-insensitive duplicate keys on Windows: replace the old spelling.
    for existing in list(positions):
        if _same_path(existing, path):
            key = existing
            break
    positions[key] = entry
    if len(positions) > MAX_POSITIONS:
        ordered = sorted(
            positions.values(), key=lambda item: item.get("updated") or 0, reverse=True
        )[:MAX_POSITIONS]
        positions = {item["path"]: item for item in ordered}
    record["positions"] = positions
    record["last_view"] = entry
    if variant in {"translation", "dual"}:
        artifacts = record.get("artifacts") or {}
        if variant not in artifacts:
            artifacts[variant] = {
                "path": str(path),
                "pages": entry["pages"],
                "mtime": time.time(),
                "mode": "",
            }
            record["artifacts"] = artifacts
    record["updated"] = time.time()
    return entry


def report_position(path: str | Path, page, pages=None) -> dict | None:
    """Remember where the reader is; returns the updated link summary or None."""
    resolved = _resolve(path)
    if resolved is None or resolved.suffix.lower() != ".pdf":
        return None
    with _lock:
        data = _load_locked()
        match = _link_id_for_path(data, resolved)
        if match is None:
            return None
        record, _variant = match
        entry = _store_position(record, str(resolved), _page_number(page), _page_number(pages))
        record["updated"] = time.time()
        _save_locked(data)
        return _link_summary(record, entry)


def _link_summary(record: dict, entry: dict | None = None) -> dict:
    last = entry or record.get("last_view") or {}
    return {
        "link_id": record.get("id"),
        "title": record.get("title") or "",
        "imported_path": record.get("imported_path") or "",
        "path": last.get("path") or record.get("imported_path") or "",
        "variant": last.get("variant") or "original",
        "page": int(last.get("page") or 1),
        "pages": int(last.get("pages") or 0),
        "doi": record.get("doi") or "",
        "artifacts": sorted((record.get("artifacts") or {}).keys()),
        "open_count": int(record.get("open_count") or 0),
        "updated": float(record.get("updated") or 0),
    }


def link_records() -> list[dict]:
    """Every stored link in a flat, join-friendly shape (newest first).

    The Zotero library page has to join a snapshot item's attachment key with
    the reading / translation history this app already keeps.  Returning every
    link in one call keeps that join out of the per-item code path.
    """
    with _lock:
        data = _load_locked()
    result: list[dict] = []
    for record in data["links"].values():
        last = record.get("last_view") or {}
        artifacts = {}
        for variant, entry in (record.get("artifacts") or {}).items():
            if isinstance(entry, dict) and entry.get("path"):
                artifacts[str(variant)] = str(entry["path"])
        result.append(
            {
                "link_id": str(record.get("id") or ""),
                "library_id": str(record.get("library_id") or ""),
                "item_key": str(record.get("item_key") or ""),
                "attachment_key": str(record.get("attachment_key") or ""),
                "title": record.get("title") or "",
                "imported_path": record.get("imported_path") or "",
                "open_count": int(record.get("open_count") or 0),
                "artifacts": artifacts,
                "last_view": {
                    "path": str(last.get("path") or ""),
                    "page": _page_number(last.get("page")),
                    "pages": _page_number(last.get("pages")),
                    "variant": str(last.get("variant") or ""),
                },
                "updated": float(record.get("updated") or 0),
            }
        )
    result.sort(key=lambda entry: entry["updated"], reverse=True)
    return result


def _normalize_read_variant(value) -> str:
    """Map the optional API ``variant`` to auto/original/translation/dual."""
    variant = str(value or "").strip().lower()
    if variant in {"", "auto"}:
        return "auto"
    if variant in {"original", "translation", "dual"}:
        return variant
    raise ZoteroError(
        "不支持的阅读版本", code="bad_variant", status=400, retryable=False
    )


def _imported_missing_error(record: dict) -> ZoteroError:
    return ZoteroError(
        "ReadPI 中这个附件的副本已丢失。请从 Zotero 重新打开以恢复文件。",
        code="imported_missing",
        status=410,
        retryable=True,
        detail=str(record.get("imported_path") or ""),
    )


def _choose_target(
    record: dict, requested_variant: str | None = None
) -> tuple[str, str]:
    """The file to reopen.

    An explicit ``requested_variant`` ("original" / "translation" / "dual")
    opens exactly that file; when it does not exist yet the caller gets a 404
    ``variant_missing`` instead of a silently different document.  ``None``,
    "" and "auto" keep the resume preference: a previously read translated
    version, then the newest dual PDF, translation, and finally the original.
    Reading history of the original must not hide a translation created
    afterwards.
    """
    variant = _normalize_read_variant(requested_variant)
    artifacts = record.get("artifacts") or {}
    if variant == "original":
        imported = _resolve(record.get("imported_path") or "")
        if imported is not None and imported.is_file():
            return str(imported), "original"
        raise _imported_missing_error(record)
    if variant in {"translation", "dual"}:
        entry = artifacts.get(variant)
        candidate = _resolve(entry.get("path") or "") if isinstance(entry, dict) else None
        if candidate is not None and candidate.is_file():
            return str(candidate), variant
        raise ZoteroError(
            "这篇文献还没有该版本的译文",
            code="variant_missing",
            status=404,
            retryable=False,
            detail=str(entry.get("path") or "") if isinstance(entry, dict) else "",
        )
    last = record.get("last_view") or {}
    last_path = _resolve(last.get("path") or "")
    if last_path is not None and last_path.is_file() and last_path.suffix.lower() == ".pdf":
        variant = variant_for_path(record, last_path)
        if variant in {"dual", "translation"}:
            return str(last_path), variant
    for variant in ("dual", "translation"):
        entry = artifacts.get(variant)
        if not isinstance(entry, dict):
            continue
        candidate = _resolve(entry.get("path") or "")
        if candidate is not None and candidate.is_file():
            return str(candidate), variant
    imported = _resolve(record.get("imported_path") or "")
    if imported is not None and imported.is_file():
        return str(imported), "original"
    raise _imported_missing_error(record)


# --------------------------------------------------------------------------- #
# Opening
# --------------------------------------------------------------------------- #
def open_link(payload: dict) -> dict:
    """Import the attachment (if needed) and resolve where the reader should go.

    Returns everything the HTTP layer needs to build the viewer URL:
    ``path``, ``page``, ``pages``, ``variant``, ``link_id``, ``title``.

    An optional ``variant`` ("original" / "translation" / "dual") forces that
    exact file, so the library page's 阅读 menu can open each edition; without
    it the last read / newest translated file is preferred, as before.
    """
    value = payload if isinstance(payload, dict) else {}
    # Validate the requested variant before importing: a typo in the API call
    # must not copy a file into the managed folder.
    variant_request = _normalize_read_variant(value.get("variant"))
    record, copied = import_attachment(value)
    # New translations may have been produced since the last open; refresh so
    # the remembered "last read" variant is up to date.
    with _lock:
        data = _load_locked()
        current = data["links"].get(record["id"]) or record
        current = discover_artifacts(current, force=True)
        data["links"][current["id"]] = current
        _save_locked(data)
        record = dict(current)

    requested_page = _page_number(value.get("page"))
    requested_total = _page_number(value.get("page_total") or value.get("page_count"))
    target_path, variant = _choose_target(record, variant_request)
    target_pages = pdfinfo.page_count(Path(target_path)) or 0
    imported_pages = pdfinfo.page_count(Path(record["imported_path"])) or 0
    artifacts = record.get("artifacts") or {}
    dual_mode = ""
    if variant == "dual":
        dual_entry = artifacts.get("dual") or {}
        dual_mode = str(dual_entry.get("mode") or "")
        if not dual_mode and target_pages and imported_pages:
            # A dual file with (about) twice the pages alternates original and
            # translation; otherwise it is a side-by-side page.
            dual_mode = "alternate" if target_pages >= imported_pages * 2 - 1 else "side"

    if requested_page:
        original_pages = requested_total or imported_pages
        page = map_page(
            requested_page,
            "original",
            variant,
            original_pages,
            target_pages,
            dual_mode or "side",
        )
        source = "reader"
    elif variant_request != "auto":
        # An explicit variant opens that file from its first page: the resumed
        # position belongs to whichever file was read last, not to this one.
        page = 1
        source = "variant"
    else:
        last = record.get("last_view") or {}
        last_path = _resolve(last.get("path") or "")
        page = 0
        if last_path and _same_path(last_path, target_path):
            page = _page_number(last.get("page"))
        if not page:
            positions = record.get("positions") or {}
            for key, entry in positions.items():
                if _same_path(key, target_path):
                    page = _page_number(entry.get("page"))
                    break
        if not page and last_path and last_path.is_file():
            last_page = _page_number(last.get("page"))
            last_variant = variant_for_path(record, last_path)
            if last_page and last_variant != "unknown":
                page = map_page(
                    last_page, last_variant, variant,
                    _page_number(last.get("pages")) or imported_pages,
                    target_pages, dual_mode or "side",
                )
        page = page or 1
        source = "resume"
        if target_pages:
            page = min(page, target_pages)

    with _lock:
        data = _load_locked()
        current = data["links"].get(record["id"])
        if current is None:
            current = record
        entry = _store_position(current, target_path, page, target_pages)
        current["open_count"] = int(current.get("open_count") or 0) + 1
        current["updated"] = time.time()
        data["links"][current["id"]] = current
        _save_locked(data)
    return {
        "ok": True,
        "link_id": record["id"],
        "path": target_path,
        "page": page,
        "pages": target_pages,
        "variant": variant,
        "title": record.get("title") or Path(target_path).stem,
        "doi": record.get("doi") or "",
        "imported": copied,
        "source": source,
        "message": (
            "首次接入文件，已建立与 Zotero 文献的关联"
            if copied
            else "已复用 ReadPI 中已有的记录"
        ),
    }


# --------------------------------------------------------------------------- #
# Add-on package
# --------------------------------------------------------------------------- #
def plugin_manifest() -> dict:
    try:
        data = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def plugin_version() -> str:
    return str(plugin_manifest().get("version") or "")


def plugin_available() -> bool:
    return (PLUGIN_DIR / "manifest.json").is_file() and (PLUGIN_DIR / "bootstrap.js").is_file()


_SKIP_PLUGIN_DIRS = {"dist", "node_modules", ".git", "__pycache__", "tests"}


def build_plugin_xpi() -> tuple[bytes, str]:
    """Zip ``tools/zotero-plugin`` into an installable XPI (in memory)."""
    if not plugin_available():
        raise ZoteroError(
            "Zotero 插件源码缺失（tools/zotero-plugin），无法生成安装包。",
            code="plugin_missing",
            status=404,
        )
    version = plugin_version() or "0.0.0"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PLUGIN_DIR.rglob("*")):
            if path.is_dir():
                continue
            relative = path.relative_to(PLUGIN_DIR)
            if relative.parts and relative.parts[0] in _SKIP_PLUGIN_DIRS:
                continue
            if path.suffix.lower() in {".map", ".pyc"}:
                continue
            archive.write(path, relative.as_posix())
    return buffer.getvalue(), f"babeldoc-zotero-{version}.xpi"


# --------------------------------------------------------------------------- #
# App ↔ add-on discovery / status
# --------------------------------------------------------------------------- #
def write_launch_info(port: int, version: str = "") -> None:
    """Tell the Zotero add-on where this app is and how to start it.

    The file lives under ``%APPDATA%\\BabelDOC-Studio\\zotero\\launch-info.json``
    so the add-on can start the server when it is not running, without the user
    configuring a path.
    """
    executable = Path(sys.executable)
    pythonw = executable.with_name("pythonw.exe")
    payload = {
        "app": "BabelDOC Studio",
        "version": version,
        "port": int(port),
        "url": f"http://127.0.0.1:{int(port)}",
        "base_dir": str(ROOT),
        "python": str(executable),
        "pythonw": str(pythonw) if pythonw.exists() else "",
        "script": str(ROOT / "app.py"),
        "start_bat": str(ROOT / "Start.bat") if (ROOT / "Start.bat").is_file() else "",
        "launcher": str(ROOT / "BabelDOC Studio.exe") if (ROOT / "BabelDOC Studio.exe").is_file() else "",
        "started": time.time(),
    }
    _ensure_dirs()
    target = launch_file()
    temporary = target.with_suffix(".json.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)
    except OSError:
        pass


def launch_info() -> dict:
    try:
        data = json.loads(launch_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def status() -> dict:
    """Small status payload for the add-on / settings UI / tests."""
    with _lock:
        data = _load_locked()
    links = sorted(
        data["links"].values(), key=lambda item: item.get("updated") or 0, reverse=True
    )
    return {
        "ok": True,
        "enabled": True,
        "imports_dir": str(imports_dir()),
        "link_count": len(links),
        "links": [_link_summary(record) for record in links[:20]],
        "plugin": {
            "available": plugin_available(),
            "version": plugin_version(),
        },
        "launch": launch_info(),
    }
