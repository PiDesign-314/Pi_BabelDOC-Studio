"""Maintenance for BabelDOC's translation cache.

BabelDOC 0.6.x caches the raw model response **before** validating it.  When a
long paragraph hits a transient API failure the model can answer with an empty
string, and that empty answer is stored in ``cache.v1.db``.  Later runs then
read the empty translation from the cache, the fallback path applies it without
re-checking, and the paragraph is typeset with no text at all -- a large blank
area in the translated PDF that is reproducible from then on.

Clearing rows whose translation is empty is safe: they contain no usable
translation, so the next run asks the model again instead of painting a blank
paragraph.  This is best-effort and must never break a translation job.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

#: BabelDOC's cache location (``babeldoc.const.CACHE_FOLDER``).
CACHE_FILE = Path.home() / ".cache" / "babeldoc" / "cache.v1.db"

_TABLE = "_translationcache"


def cache_path() -> Path:
    return CACHE_FILE


def clear_empty_translations(path: str | Path | None = None) -> int:
    """Delete cache rows with an empty translation and return how many went away.

    Returns 0 when the cache does not exist, the schema is unfamiliar, the DB
    is locked by a running BabelDOC process, or anything else goes wrong.
    """
    target = Path(path) if path is not None else CACHE_FILE
    if not target.is_file():
        return 0
    try:
        connection = sqlite3.connect(str(target), timeout=3)
        try:
            connection.execute("PRAGMA busy_timeout = 3000")
            row = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (_TABLE,),
            ).fetchone()
            if not row:
                return 0
            cursor = connection.execute(
                f"DELETE FROM {_TABLE} WHERE trim(translation) = ''"
            )
            connection.commit()
            return max(0, int(cursor.rowcount or 0))
        finally:
            connection.close()
    except (sqlite3.Error, OSError, ValueError):
        return 0
