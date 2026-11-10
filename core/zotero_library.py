"""Zotero library snapshot: the Zotero collection tree in the results library.

The Zotero add-on pushes a snapshot of the user's Zotero library — every
collection plus the regular items that have a local PDF — to
``config.APP_DIR/zotero/library.json``.  The results library page then shows
that tree next to BabelDOC's own output, so a paper can be read or translated
without switching back to Zotero.

* :func:`store` validates and persists one snapshot (atomic write, one lock).
* :func:`payload` is the enriched view served by ``GET /api/zotero/library``:
  recursive collection counts, the first attachment, and the reading /
  translation state already stored by :mod:`core.zotero`.
* :func:`attachment_path` is the allow-list behind the thumbnail endpoint: it
  only returns a path the *stored* snapshot named, never a path from the query.

A missing snapshot is not an error: :func:`payload` then has ``missing: true``
and the page shows a "sync from Zotero" hint instead of a 404.

Paths are resolved through functions on every call (like :mod:`core.zotero`) so
tests can point ``config.APP_DIR`` at an isolated folder.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import config, zotero

SNAPSHOT_SCHEMA = 1
MAX_ITEMS = 3000
MAX_COLLECTIONS = 2000
MAX_LIBRARIES = 200
MAX_ATTACHMENTS = 3
MAX_TITLE = 500
MAX_CREATORS = 400
MAX_DOI = 200
MAX_ITEM_TYPE = 60
MAX_DATE = 40
MAX_NAME = 200
MAX_PATH = 4000
MAX_VERSION = 40

_lock = threading.RLock()


# --------------------------------------------------------------------------- #
# Paths (resolved on every call so tests can point config.APP_DIR elsewhere)
# --------------------------------------------------------------------------- #
def data_dir() -> Path:
    return config.APP_DIR / zotero.DATA_DIR_NAME


def library_file() -> Path:
    return data_dir() / "library.json"


# --------------------------------------------------------------------------- #
# Small cleaning helpers
# --------------------------------------------------------------------------- #
def _text(value, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def _integer(value, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _clean_library(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    library_id = _integer(raw.get("id"))
    if library_id <= 0:
        return None
    return {
        "id": library_id,
        "name": _text(raw.get("name"), MAX_NAME) or f"文库 {library_id}",
        "type": _text(raw.get("type"), 20) or "user",
    }


def _clean_collection(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    collection_id = _integer(raw.get("id"))
    if collection_id <= 0:
        return None
    parent_id = _integer(raw.get("parent_id"))
    return {
        "id": collection_id,
        "library_id": _integer(raw.get("library_id")),
        "name": _text(raw.get("name"), MAX_NAME),
        "parent_id": parent_id if parent_id > 0 else 0,
    }


def _clean_attachment(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    path = _text(raw.get("path"), MAX_PATH)
    if not path:
        # Without a path the attachment can be neither read nor thumbnailed.
        return None
    filename = _text(raw.get("filename"), MAX_NAME) or Path(path).name
    return {
        "key": _text(raw.get("key"), 40),
        "title": _text(raw.get("title"), MAX_NAME),
        "filename": filename,
        "path": path,
        "size": max(0, _integer(raw.get("size"))),
    }


def _clean_item(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    key = _text(raw.get("key"), 40)
    if not key:
        return None
    attachments: list[dict] = []
    for entry in raw.get("attachments") or []:
        cleaned = _clean_attachment(entry)
        if cleaned is not None:
            attachments.append(cleaned)
        if len(attachments) >= MAX_ATTACHMENTS:
            break
    # A paper without a usable local PDF cannot be read or translated.  The
    # add-on already drops those, so this only catches stale/partial data.
    if not attachments:
        return None
    collections: list[int] = []
    for value in raw.get("collections") or []:
        collection_id = _integer(value)
        if collection_id > 0 and collection_id not in collections:
            collections.append(collection_id)
    return {
        "key": key,
        "library_id": _integer(raw.get("library_id")),
        "title": _text(raw.get("title"), MAX_TITLE),
        "creators": _text(raw.get("creators"), MAX_CREATORS),
        "year": _text(raw.get("year"), 12),
        "doi": _text(raw.get("doi"), MAX_DOI),
        "item_type": _text(raw.get("item_type"), MAX_ITEM_TYPE),
        "date_added": _text(raw.get("date_added"), MAX_DATE),
        "collections": collections,
        "attachments": attachments,
    }


def _clean_snapshot(raw) -> dict:
    """Validate one pushed snapshot and return the compact stored shape."""
    if not isinstance(raw, dict):
        raise zotero.ZoteroError(
            "Zotero 文库快照格式不正确（不是 JSON 对象）。",
            code="invalid_snapshot",
            status=400,
        )
    schema = _integer(raw.get("schema"), SNAPSHOT_SCHEMA)
    if schema != SNAPSHOT_SCHEMA:
        raise zotero.ZoteroError(
            f"Zotero 插件推送的文库快照版本是 {schema}，"
            f"当前 ReadPI 只支持版本 {SNAPSHOT_SCHEMA}。请更新 ReadPI。",
            code="snapshot_schema",
            status=400,
        )
    raw_items = raw.get("items")
    raw_collections = raw.get("collections")
    if not isinstance(raw_items, list) or not isinstance(raw_collections, list):
        raise zotero.ZoteroError(
            "Zotero 文库快照缺少 items / collections 列表。",
            code="invalid_snapshot",
            status=400,
        )

    libraries: list[dict] = []
    seen_libraries: set[int] = set()
    for entry in (raw.get("libraries") or [])[:MAX_LIBRARIES]:
        cleaned = _clean_library(entry)
        if cleaned is None or cleaned["id"] in seen_libraries:
            continue
        seen_libraries.add(cleaned["id"])
        libraries.append(cleaned)

    collections: list[dict] = []
    seen_collections: set[tuple[int, int]] = set()
    for entry in raw_collections:
        cleaned = _clean_collection(entry)
        if cleaned is None:
            continue
        key = (cleaned["library_id"], cleaned["id"])
        if key in seen_collections:
            # A later duplicate is the fresher entry: keep only that one.
            collections = [
                item
                for item in collections
                if (item["library_id"], item["id"]) != key
            ]
        seen_collections.add(key)
        collections.append(cleaned)
    dropped_collections = max(0, len(collections) - MAX_COLLECTIONS)
    if dropped_collections:
        collections = collections[:MAX_COLLECTIONS]

    items: list[dict] = []
    seen_items: set[tuple[int, str]] = set()
    dropped_items = 0
    for entry in raw_items:
        cleaned = _clean_item(entry)
        if cleaned is None:
            dropped_items += 1
            continue
        key = (cleaned["library_id"], cleaned["key"])
        if key in seen_items:
            items = [
                item
                for item in items
                if (item["library_id"], item["key"]) != key
            ]
        seen_items.add(key)
        items.append(cleaned)
    dropped_by_cap = max(0, len(items) - MAX_ITEMS)
    if dropped_by_cap:
        items = items[:MAX_ITEMS]

    raw_stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    stats = {
        "items": len(items),
        "collections": len(collections),
        # Rejected items are papers the page cannot use, which is exactly what
        # the add-on counts as "no local PDF".
        "skipped_no_pdf": max(
            0, _integer(raw_stats.get("skipped_no_pdf")) + dropped_items
        ),
        "truncated": bool(raw_stats.get("truncated"))
        or dropped_by_cap > 0
        or dropped_collections > 0,
    }
    synced = 0.0
    try:
        synced = float(raw.get("synced") or 0)
    except (TypeError, ValueError):
        synced = 0.0
    return {
        "schema": SNAPSHOT_SCHEMA,
        "synced": synced if synced > 0 else time.time(),
        "zotero_version": _text(raw.get("zotero_version"), MAX_VERSION),
        "libraries": libraries,
        "collections": collections,
        "items": items,
        "stats": stats,
    }


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #
def store(raw) -> dict:
    """Validate and persist one snapshot; returns the push response body."""
    data = _clean_snapshot(raw)
    with _lock:
        target = library_file()
        temporary = target.with_suffix(".json.tmp")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(temporary, target)
        except OSError as exc:
            try:
                temporary.unlink()
            except OSError:
                pass
            raise zotero.ZoteroError(
                f"无法保存 Zotero 文库快照：{exc}",
                code="snapshot_write_failed",
                status=500,
                retryable=True,
            ) from exc
    return {
        "ok": True,
        "synced": data["synced"],
        "items": len(data["items"]),
        "collections": len(data["collections"]),
    }


def snapshot() -> dict | None:
    """The stored snapshot, or ``None`` when there is none / it is unreadable."""
    with _lock:
        try:
            raw = json.loads(library_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
    try:
        return _clean_snapshot(raw)
    except zotero.ZoteroError:
        # A half-written or newer-schema file must not break the page; the
        # add-on will push a fresh snapshot on its next sync.
        return None


# --------------------------------------------------------------------------- #
# Joining the snapshot with the link registry
# --------------------------------------------------------------------------- #
def _index_keys(record: dict) -> list[tuple[str, str, str]]:
    library = record["library_id"]
    keys: list[tuple[str, str, str]] = []
    for kind, value in (
        ("attachment", record["attachment_key"]),
        ("item", record["item_key"]),
    ):
        if not value:
            continue
        keys.append((kind, library, value))
        # Older links may not carry a library id; match them by bare key.
        if library:
            keys.append((kind, "", value))
    return keys


def _link_index() -> dict[tuple[str, str, str], list[dict]]:
    index: dict[tuple[str, str, str], list[dict]] = {}
    for record in zotero.link_records():
        for key in _index_keys(record):
            index.setdefault(key, []).append(record)
    return index


def _find_link(item: dict, links: dict) -> dict | None:
    """The newest link that describes this item (attachment key, else item key)."""
    library = str(item["library_id"])
    attachments = item["attachments"]
    exact = ("attachment", library, attachments[0]["key"]) if attachments else None
    candidates = []
    if exact:
        candidates.append(exact)
        candidates.append(("attachment", "", attachments[0]["key"]))
    candidates.append(("item", library, item["key"]))
    candidates.append(("item", "", item["key"]))
    for key in candidates:
        matches = links.get(key)
        if not matches:
            continue
        if key[0] == "item":
            # Item-key matches are only a fallback for links that predate
            # attachment keys; a link for a *different* PDF of the same item
            # must not fake a translation badge on this attachment.
            matches = [record for record in matches if not record["attachment_key"]]
        if matches:
            return matches[0]
    return None


def _variants_on_disk(link: dict, artifacts: dict) -> dict[str, str]:
    """Which artefact files of a link actually exist right now."""
    found: dict[str, str] = {}
    for variant, path in (link.get("artifacts") or {}).items():
        if not path:
            continue
        try:
            if Path(path).is_file():
                found[str(variant)] = str(path)
        except OSError:
            continue
    stem = Path(link.get("imported_path") or "").stem
    if not stem:
        return found
    for variant, path in (artifacts.get(stem) or {}).items():
        if variant in found:
            continue
        try:
            if Path(path).is_file():
                found[str(variant)] = str(path)
        except OSError:
            continue
    return found


def _preferred_variant(link: dict, found: dict[str, str]) -> str:
    """The file a Zotero read would open, including a newly finished translation."""
    last = link.get("last_view") or {}
    variant = str(last.get("variant") or "")
    path = str(last.get("path") or "")
    if path and variant in {"translation", "dual"}:
        try:
            candidate = Path(path)
            if candidate.is_file() and candidate.suffix.lower() == ".pdf":
                return variant
        except OSError:
            pass
    for candidate in ("dual", "translation"):
        if candidate in found:
            return candidate
    return "original"


def _last_page(link: dict) -> int:
    last = link.get("last_view") or {}
    page = int(last.get("page") or 0)
    if page <= 0:
        return 0
    try:
        if not Path(str(last.get("path") or "")).is_file():
            return 0
    except OSError:
        return 0
    return page


def _enrich_item(item: dict, links: dict, artifacts: dict) -> dict:
    attachment = item["attachments"][0] if item["attachments"] else None
    link = _find_link(item, links)
    translated = {"translation": False, "dual": False}
    preferred = "original"
    last_page = 0
    open_count = 0
    link_id = ""
    if link is not None:
        link_id = link["link_id"]
        open_count = int(link.get("open_count") or 0)
        found = _variants_on_disk(link, artifacts)
        translated["translation"] = "translation" in found
        translated["dual"] = "dual" in found
        preferred = _preferred_variant(link, found)
        last_page = _last_page(link)
    title = item["title"]
    if not title and attachment is not None:
        title = Path(attachment["filename"]).stem
    return {
        "key": item["key"],
        "library_id": item["library_id"],
        "title": title,
        "creators": item["creators"],
        "year": item["year"],
        "doi": item["doi"],
        "item_type": item["item_type"],
        "date_added": item["date_added"],
        "collections": item["collections"],
        "attachment": dict(attachment) if attachment else None,
        "attachments_count": len(item["attachments"]),
        "translated": translated,
        "preferred_variant": preferred,
        "last_page": last_page,
        "open_count": open_count,
        "link_id": link_id,
    }


def _collection_counts(
    collections: list[dict], items: list[dict]
) -> tuple[dict[int, int], dict[int, int]]:
    """Recursive and direct item counts per collection.

    Counts are accumulated per membership instead of recursing over the tree,
    so a malformed ``parent_id`` cycle cannot hang the page.
    """
    parents = {entry["id"]: entry["parent_id"] for entry in collections}
    totals = {entry["id"]: 0 for entry in collections}
    direct = {entry["id"]: 0 for entry in collections}
    for item in items:
        for collection_id in item["collections"]:
            if collection_id not in direct:
                continue
            direct[collection_id] += 1
            current = collection_id
            seen: set[int] = set()
            while current in totals and current not in seen:
                seen.add(current)
                totals[current] += 1
                current = parents.get(current, 0)
    return totals, direct


# --------------------------------------------------------------------------- #
# Read model
# --------------------------------------------------------------------------- #
def _empty_payload() -> dict:
    return {
        "ok": True,
        "synced": 0,
        "zotero_version": "",
        "age_hours": 0,
        "libraries": [],
        "collections": [],
        "items": [],
        "stats": {
            "items": 0,
            "collections": 0,
            "skipped_no_pdf": 0,
            "truncated": False,
        },
        "missing": True,
    }


def payload() -> dict:
    """The enriched library view served by ``GET /api/zotero/library``."""
    data = snapshot()
    if data is None:
        return _empty_payload()
    links = _link_index()
    artifacts = zotero.artifacts_index() if links else {}
    totals, direct = _collection_counts(data["collections"], data["items"])
    synced = float(data["synced"] or 0)
    return {
        "ok": True,
        "synced": synced,
        "zotero_version": data["zotero_version"],
        "age_hours": round(max(0.0, time.time() - synced) / 3600.0, 2)
        if synced
        else 0,
        "libraries": data["libraries"],
        "collections": [
            {
                **entry,
                "count": totals.get(entry["id"], 0),
                "direct_count": direct.get(entry["id"], 0),
            }
            for entry in data["collections"]
        ],
        "items": [
            _enrich_item(item, links, artifacts) for item in data["items"]
        ],
        "stats": data["stats"],
        "missing": False,
    }


def attachment_path(library_id, item_key, attachment_key) -> Path | None:
    """The stored snapshot's path for one attachment (thumbnail allow-list).

    The query picks an item and an attachment; it never supplies a path, so the
    endpoint cannot be used to read an arbitrary file.  Returns ``None`` when
    there is no snapshot or the keys are unknown.
    """
    data = snapshot()
    if data is None:
        return None
    library = _integer(library_id)
    item_key = str(item_key or "").strip()
    attachment_key = str(attachment_key or "").strip()
    if not item_key or not attachment_key:
        return None
    for item in data["items"]:
        if item["key"] != item_key:
            continue
        if library and item["library_id"] != library:
            continue
        for attachment in item["attachments"]:
            if attachment["key"] == attachment_key:
                return Path(attachment["path"])
    return None
