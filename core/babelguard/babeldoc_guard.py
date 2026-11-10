"""Runtime guard that keeps BabelDOC from typesetting empty translations.

BabelDOC 0.6.x occasionally receives an empty model reply for a paragraph.  Its
fallback path applies the empty string without validation: the paragraph
``unicode`` becomes ``""``, typesetting then paints nothing and the output PDF
shows a large blank area.  The empty value may also be cached, so later runs
reproduce the same blank paragraph.

The app launches BabelDOC with this directory on ``PYTHONPATH`` and these
environment variables::

    BABELDOC_STUDIO_GUARD=1
    BABELDOC_STUDIO_GUARD_STATUS=<status.json>
    BABELDOC_STUDIO_GUARD_LOG=<events.jsonl>          # optional
    BABELDOC_STUDIO_GUARD_DOC=<document id>
    BABELDOC_STUDIO_GUARD_RETRIES=2                   # optional
    BABELDOC_STUDIO_GUARD_BACKOFF=1,3                 # optional seconds

``sitecustomize.py`` then calls :func:`install` at interpreter startup, before
BabelDOC imports anything.  All babeldoc imports happen lazily inside the patch
functions, so this module can be imported by an interpreter without BabelDOC
installed (the tests rely on that).

Every patch is defensive: any failure inside the guard is recorded and
swallowed.  A guard bug must never break a translation.

Status file (schema 1) written at process exit (the atexit hook)::

    {"schema": 1, "guard": "babeldoc-studio", "doc": "...",
     "started": <unix>, "finished": <unix>,
     "paragraphs": [{"page": 2, "paragraph_id": "pLf4x",
                     "source_chars": 699, "translated_chars": 0,
                     "status": "EMPTY", "retry_count": 2,
                     "error_reason": "...", "layout_status": "...",
                     "render_status": "..."}],
     "counts": {"paragraphs": N, "translated": N, "empty": N,
                "render_failed": N, "retried": N, "kept_original": N},
     "errors": ["..."]}

Paragraph records are deduplicated by page + paragraph id + source text hash;
a later phase supersedes the status of an earlier phase (EMPTY -> RENDERED)
while retry counts, the original source length and the last error reason are
preserved.  ``page`` is 1-based (BabelDOC's ``page.page_number`` is 0-based).

Two markers are kept for consumers:

* ``error_reason == "empty_translation_kept_original"`` plus
  ``layout_status == "kept_original"`` when an empty model reply was replaced by
  the source text (the paragraph still shows the source, not a translation);
* ``retry_count > 0`` when the model reply had to be retried.

A kept-original paragraph still renders, so a later typesetting observation
supersedes its status with RENDERED; ``translated_chars`` then holds the
*rendered* character count, not translated characters.  Consumers must use
:func:`is_kept_original_record` (or the markers above) rather than
``status == "RENDERED"`` to decide whether a paragraph was really translated.
That is why the summary keeps both counters:

* ``counts.translated`` -- status TRANSLATED/RENDERED with real text and no
  kept-original marker;
* ``counts.empty`` -- paragraphs left with an empty text (status EMPTY, not
  kept-original);
* ``counts.kept_original`` -- paragraphs whose empty reply was replaced by the
  source text.

BabelDOC's ``--debug`` mode appends its own label paragraphs ("pagenumber: 1",
"paragraph[...]-[...]", "formula", ...) that have no ``debug_id``; they are
bookkeeping and are deliberately ignored by the guard (no status record, no
rendering recovery, nothing in ``counts``).
"""

from __future__ import annotations

import atexit
import functools
import hashlib
import importlib
import inspect
import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

# --- environment / contract constants --------------------------------------

GUARD_ENV = "BABELDOC_STUDIO_GUARD"
STATUS_ENV = "BABELDOC_STUDIO_GUARD_STATUS"
LOG_ENV = "BABELDOC_STUDIO_GUARD_LOG"
DOC_ENV = "BABELDOC_STUDIO_GUARD_DOC"
RETRIES_ENV = "BABELDOC_STUDIO_GUARD_RETRIES"
BACKOFF_ENV = "BABELDOC_STUDIO_GUARD_BACKOFF"
OWNER_ENV = "BABELDOC_STUDIO_GUARD_OWNER"

SCHEMA = 1
GUARD_NAME = "babeldoc-studio"

#: Default number of retries after an empty model reply (total calls = 1 + this).
DEFAULT_RETRIES = 2
#: Default sleeps between retries, in seconds.
DEFAULT_BACKOFF = (1.0, 3.0)
DEFAULT_BACKOFF_TEXT = "1,3"

#: BabelDOC retypesets with scales down to 0.1; the guard forces this scale when
#: a paragraph rendered no characters at all.
MIN_FORCED_SCALE = 0.1

#: Cap on guard errors kept in the status file (one entry each).
MAX_ERRORS = 50

#: Statuses documented by the machine contract (plus the FORCED alias).
VALID_STATUSES = (
    "TRANSLATED",
    "EMPTY",
    "FAILED",
    "KEPT_ORIGINAL",
    "RENDER_FAILED",
    "RENDERED",
    "FORCED",
)
STATUS_ALIASES = {"FORCED_KEPT_ORIGINAL": "FORCED"}

#: Translate-time statuses that mean real translated text reached the paragraph.
TRANSLATED_STATUSES = ("TRANSLATED", "RENDERED")

#: Fallback statuses that count as "rendering needed help".
RENDER_FAILED_STATUSES = ("RENDER_FAILED", "FORCED")

#: ``error_reason`` written when an empty model reply was replaced by the source.
KEPT_ORIGINAL_REASON = "empty_translation_kept_original"

#: Minimum interval between mid-run status flushes (best-effort crash safety:
#: a cancelled job is terminated and never runs atexit).
STATUS_FLUSH_INTERVAL = 2.0

#: babeldoc module names touched by the patches (kept as strings: lazy imports).
CACHE_MODULE = "babeldoc.translator.cache"
TRANSLATOR_MODULE = "babeldoc.translator.translator"
IL_TRANSLATOR_MODULE = "babeldoc.format.pdf.document_il.midend.il_translator"
IL_LLM_ONLY_MODULE = (
    "babeldoc.format.pdf.document_il.midend.il_translator_llm_only"
)
TYPESETTING_MODULE = "babeldoc.format.pdf.document_il.midend.typesetting"
PDF_CREATER_MODULE = "babeldoc.format.pdf.document_il.backend.pdf_creater"
IL_MODEL_MODULE = "babeldoc.format.pdf.document_il.il_version_1"

#: Marker written on every patched function so install() stays idempotent.
_GUARD_MARK = "_babeldoc_studio_guard"

#: Per-thread state: retries of the paragraph currently being translated and
#: whether an empty reply was already turned into "keep the original".
_LOCAL = threading.local()


# --- small helpers ----------------------------------------------------------


def env_truthy(value) -> bool:
    """True for the usual truthy env spellings ("1", "true", "yes", "on")."""
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def guard_enabled() -> bool:
    """True when the app asked for the guard in this process."""
    return env_truthy(os.environ.get(GUARD_ENV))


def is_empty_translation(value) -> bool:
    """True for ``None``, non-strings and whitespace-only translations."""
    if not isinstance(value, str):
        return True
    return not value.strip()


def text_length(value) -> int:
    """Stripped character count of *value* (0 for missing values)."""
    if value is None or not isinstance(value, str):
        return 0
    return len(value.strip())


def parse_backoff(spec) -> list[float]:
    """Parse ``"1,3"`` into ``[1.0, 3.0]``; negative values are clamped to 0.

    ``None`` / an empty string means the default backoff.  Invalid tokens are
    ignored, so a typo in the environment never breaks a translation.
    """
    if isinstance(spec, (list, tuple)):
        delays = []
        for item in spec:
            try:
                delays.append(max(0.0, float(item)))
            except (TypeError, ValueError):
                continue
        return delays
    if spec is None:
        return list(DEFAULT_BACKOFF)
    text = str(spec).strip()
    if not text:
        return list(DEFAULT_BACKOFF)
    delays = []
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            delays.append(max(0.0, float(token)))
        except ValueError:
            continue
    return delays


def plan_retries(
    attempt: int,
    retries: int | None = None,
    backoff=None,
) -> float | None:
    """Delay before retry *attempt* (0-based), or ``None`` when done retrying.

    The last backoff value is reused for retries beyond the configured list.
    """
    limit = DEFAULT_RETRIES if retries is None else max(0, int(retries))
    attempt = int(attempt)
    if attempt < 0 or attempt >= limit:
        return None
    delays = parse_backoff(backoff) if backoff is not None else list(DEFAULT_BACKOFF)
    if not delays:
        return 0.0
    return delays[min(attempt, len(delays) - 1)]


def make_retry_wrapper(
    call,
    sleep=time.sleep,
    retries: int | None = None,
    backoff=None,
    should_retry=None,
    on_retry=None,
):
    """Wrap *call* so an empty result is retried with a fixed backoff.

    ``retries`` is the number of *additional* calls (0 means no retry).  The
    last result is returned even when it is still empty; the retry counter is
    reported through ``on_retry(attempt, delay)`` so the caller can attribute
    it to the paragraph being translated.
    """
    limit = DEFAULT_RETRIES if retries is None else max(0, int(retries))
    delays = parse_backoff(backoff) if backoff is not None else list(DEFAULT_BACKOFF)
    retry_test = should_retry or is_empty_translation

    def invoke(*args, **kwargs):
        result = call(*args, **kwargs)
        attempt = 0
        while retry_test(result):
            delay = plan_retries(attempt, limit, delays)
            if delay is None:
                break
            try:
                sleep(delay)
            except Exception:
                pass
            if on_retry is not None:
                try:
                    on_retry(attempt, delay)
                except Exception:
                    pass
            attempt += 1
            result = call(*args, **kwargs)
        return result

    return invoke


def _safe_signature(function):
    """``inspect.signature`` that never raises (builtins have no signature)."""
    try:
        return inspect.signature(function)
    except (TypeError, ValueError):
        return None


def _bind(signature, args, kwargs):
    """Bind call arguments to parameter names, or ``None`` when it cannot."""
    if signature is None:
        return None
    try:
        bound = signature.bind(*args, **kwargs)
    except TypeError:
        return None
    try:
        bound.apply_defaults()
    except Exception:
        pass
    return bound.arguments


def _page_number(page) -> int:
    """1-based page number for a BabelDOC ``Page`` (0 when unavailable)."""
    value = getattr(page, "page_number", None)
    try:
        if value is None:
            return 0
        return int(value) + 1
    except (TypeError, ValueError):
        return 0


def _last_llm_tracker(tracker):
    """``tracker.last_llm_translate_tracker()`` or ``None`` (never raises)."""
    if tracker is None:
        return None
    getter = getattr(tracker, "last_llm_translate_tracker", None)
    if not callable(getter):
        return None
    try:
        return getter()
    except Exception:
        return None


def _same_text(first, second) -> bool:
    return str(first or "").strip() == str(second or "").strip()


def _has_debug_id(paragraph) -> bool:
    """True for real document paragraphs (BabelDOC's internal labels have none).

    ``--debug`` makes BabelDOC append its own label paragraphs ("pagenumber: 1",
    "paragraph[...]-[...]", "formula", ...) without a ``debug_id``.  They are
    bookkeeping, never translated, and its PDF writer ignores them, so the guard
    must not record or try to repair them.
    """
    try:
        return bool(getattr(paragraph, "debug_id", None))
    except Exception:
        return False


def is_kept_original_record(record) -> bool:
    """True when a paragraph had an empty reply and kept its source text.

    Such a paragraph renders normally, so its status becomes RENDERED and
    ``translated_chars`` reflects the source text length.  Consumers must use
    this predicate (or the two markers) instead of the status alone.
    """
    if not record:
        return False
    return (
        record.get("status") == "KEPT_ORIGINAL"
        or record.get("layout_status") == "kept_original"
        or record.get("error_reason") == KEPT_ORIGINAL_REASON
    )


def _has_renderable(paragraph) -> bool:
    """True when the paragraph has characters or formulas for the PDF writer.

    BabelDOC's writer only understands ``pdf_character`` and ``pdf_formula``
    compositions; a leftover ``pdf_same_style_unicode_characters`` composition
    is not painted and must be treated as "nothing rendered".
    """
    for composition in getattr(paragraph, "pdf_paragraph_composition", None) or []:
        if composition is None:
            continue
        if getattr(composition, "pdf_character", None) is not None:
            return True
        if getattr(composition, "pdf_formula", None) is not None:
            return True
    return False


# --- status store -----------------------------------------------------------


class GuardStatus:
    """Thread-safe per-paragraph status store with dedup and a JSON writer."""

    def __init__(self, doc: str = "", status_path: str = ""):
        self.doc = str(doc or "")
        self.status_path = str(status_path or "")
        self.started = time.time()
        self.finished: float | None = None
        self.errors: list[str] = []
        self._records: dict[str, dict] = {}
        self._sources: dict[str, int] = {}
        self._lock = threading.RLock()
        self._io_lock = threading.Lock()
        self._next_flush = 0.0

    # -- keys ---------------------------------------------------------------

    @staticmethod
    def _key(page, paragraph_id, source_text) -> str:
        """Dedup key.

        The contract is (page, paragraph id, source text hash).  BabelDOC's
        ``debug_id`` is a unique base58 id per paragraph, so the id alone
        identifies a paragraph across translation and typesetting even though
        its text has changed by then; the hash is used when there is no id.
        """
        pid = str(paragraph_id).strip() if paragraph_id not in (None, "") else ""
        if pid:
            return "p:" + pid
        digest = hashlib.sha1(
            str(source_text or "").encode("utf-8", "surrogatepass")
        ).hexdigest()[:12]
        return "n:%s|%s" % (page, digest)

    def remember_source(self, page, paragraph_id, text) -> None:
        """Remember the original source length of a paragraph (first value wins)."""
        if text is None:
            return
        key = self._key(page, paragraph_id, text)
        with self._lock:
            self._sources.setdefault(key, text_length(text))

    def _source_chars(self, page, paragraph_id, source_text, explicit) -> int:
        if explicit is not None:
            try:
                return max(0, int(explicit))
            except (TypeError, ValueError):
                pass
        with self._lock:
            remembered = self._sources.get(self._key(page, paragraph_id, source_text))
        if remembered is not None:
            return int(remembered)
        if source_text is not None:
            return text_length(source_text)
        return 0

    def page_for(self, paragraph_id) -> int:
        """Page already recorded for *paragraph_id*, or 0."""
        pid = str(paragraph_id or "").strip()
        if not pid:
            return 0
        with self._lock:
            record = self._records.get("p:" + pid)
            if not record:
                return 0
            try:
                return int(record.get("page") or 0)
            except (TypeError, ValueError):
                return 0

    # -- writing ------------------------------------------------------------

    def add_error(self, message) -> None:
        text = str(message or "")[:300]
        if not text:
            return
        with self._lock:
            if len(self.errors) < MAX_ERRORS:
                self.errors.append(text)

    def _normalize(self, status, merge_only: bool) -> str:
        if merge_only:
            return str(status or "")
        value = str(status or "FAILED").strip().upper()
        value = STATUS_ALIASES.get(value, value)
        return value if value in VALID_STATUSES else "FAILED"

    def record(
        self,
        page=None,
        paragraph_id=None,
        source_text=None,
        translated_text=None,
        status="TRANSLATED",
        retry_count: int = 0,
        error_reason=None,
        layout_status=None,
        render_status=None,
        source_chars=None,
        merge_only: bool = False,
    ) -> dict:
        """Insert or update one paragraph record; a later status supersedes."""
        page_no = 0
        try:
            page_no = max(0, int(page or 0))
        except (TypeError, ValueError):
            page_no = 0
        pid = "" if paragraph_id in (None, "") else str(paragraph_id)
        key = self._key(page_no, pid, source_text)
        try:
            retry = max(0, int(retry_count or 0))
        except (TypeError, ValueError):
            retry = 0
        new = {
            "page": page_no,
            "paragraph_id": pid,
            "source_chars": self._source_chars(page_no, pid, source_text, source_chars),
            "translated_chars": 0 if translated_text is None else text_length(translated_text),
            "status": self._normalize(status, merge_only),
            "retry_count": retry,
            "error_reason": str(error_reason or "")[:500],
            "layout_status": str(layout_status or "")[:200],
            "render_status": str(render_status or "")[:200],
        }
        with self._lock:
            if new["source_chars"]:
                # A record that carried the source text also seeds the source
                # length for later phases (which only see the translation).
                self._sources.setdefault(key, new["source_chars"])
            existing = self._records.get(key)
            if existing is None:
                record = new
            else:
                record = dict(existing)
                if new["status"]:
                    record["status"] = new["status"]
                if new["page"]:
                    record["page"] = new["page"]
                if new["source_chars"] or not record.get("source_chars"):
                    record["source_chars"] = new["source_chars"]
                if translated_text is not None:
                    record["translated_chars"] = new["translated_chars"]
                record["retry_count"] = max(
                    int(record.get("retry_count") or 0), new["retry_count"]
                )
                for field in ("error_reason", "layout_status", "render_status"):
                    if new[field]:
                        record[field] = new[field]
            self._records[key] = record
            self.finished = time.time()
        self._maybe_flush()
        return dict(record)

    def merge_error(self, page, paragraph_id, source_text, error_reason) -> dict:
        """Attach *error_reason* without changing an existing status.

        Creates a ``FAILED`` placeholder when the paragraph has no record yet;
        the real translation/rendering record supersedes it later.
        """
        key = self._key(page, paragraph_id, source_text)
        with self._lock:
            existing = self._records.get(key)
            if existing is not None:
                existing["error_reason"] = str(error_reason or "")[:500]
                self.finished = time.time()
                record = dict(existing)
            else:
                record = None
        if record is None:
            return self.record(
                page=page,
                paragraph_id=paragraph_id,
                source_text=source_text,
                status="FAILED",
                error_reason=error_reason,
            )
        self._maybe_flush()
        return record

    # -- serialization ------------------------------------------------------

    def to_dict(self) -> dict:
        with self._lock:
            records = sorted(
                self._records.values(),
                key=lambda item: (
                    int(item.get("page") or 0),
                    str(item.get("paragraph_id") or ""),
                ),
            )
            paragraphs = [dict(item) for item in records]
            finished = self.finished if self.finished is not None else time.time()
            return {
                "schema": SCHEMA,
                "guard": GUARD_NAME,
                "doc": self.doc,
                "started": round(float(self.started), 3),
                "finished": round(float(finished), 3),
                "paragraphs": paragraphs,
                "counts": {
                    "paragraphs": len(paragraphs),
                    "translated": sum(
                        1
                        for item in paragraphs
                        if item["status"] in TRANSLATED_STATUSES
                        and item["translated_chars"] > 0
                        and not is_kept_original_record(item)
                    ),
                    "empty": sum(
                        1
                        for item in paragraphs
                        if item["status"] == "EMPTY"
                        and not is_kept_original_record(item)
                    ),
                    "render_failed": sum(
                        1
                        for item in paragraphs
                        if item["status"] in RENDER_FAILED_STATUSES
                    ),
                    "retried": sum(
                        1 for item in paragraphs if item["retry_count"] > 0
                    ),
                    "kept_original": sum(
                        1 for item in paragraphs if is_kept_original_record(item)
                    ),
                },
                "errors": list(self.errors[:MAX_ERRORS]),
            }

    def write(self, path=None) -> bool:
        """Write the status JSON atomically; returns False on any failure."""
        target = str(path or self.status_path or "").strip()
        if not target:
            return False
        try:
            data = json.dumps(self.to_dict(), ensure_ascii=False, indent=1)
            target_path = Path(target)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = target_path.with_name(target_path.name + ".tmp")
            temporary.write_text(data, encoding="utf-8")
            os.replace(str(temporary), str(target_path))
            return True
        except Exception as exc:  # pragma: no cover - depends on the filesystem
            self.add_error(f"status write failed: {exc}")
            return False

    def _maybe_flush(self, interval: float | None = None) -> None:
        """Best-effort mid-run flush so a killed process still leaves data."""
        if not self.status_path:
            return
        try:
            now = time.time()
            if now < self._next_flush:
                return
            self._next_flush = now + (
                STATUS_FLUSH_INTERVAL if interval is None else float(interval)
            )
            self.write()
        except Exception:
            pass


# --- event log --------------------------------------------------------------


class EventLog:
    """Optional JSONL debug log (one object per event); never raises."""

    def __init__(self, path: str = ""):
        self.path = str(path or "").strip()
        self._lock = threading.Lock()
        self._dir_ready = False

    def emit(self, event, **fields) -> None:
        if not self.path:
            return
        try:
            record = {"ts": round(time.time(), 3), "event": str(event)}
            for key, value in fields.items():
                if value is None or isinstance(value, (str, int, float, bool)):
                    record[key] = value
                else:
                    record[key] = str(value)[:200]
            line = json.dumps(record, ensure_ascii=False)
            with self._lock:
                if not self._dir_ready:
                    Path(self.path).parent.mkdir(parents=True, exist_ok=True)
                    self._dir_ready = True
                with open(self.path, "a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
        except Exception:
            pass


# --- configuration ----------------------------------------------------------


@dataclass
class GuardConfig:
    """Guard settings read from the environment once per process."""

    enabled: bool = False
    status_path: str = ""
    log_path: str = ""
    doc: str = ""
    retries: int = DEFAULT_RETRIES
    backoff: list[float] = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.backoff is None:
            self.backoff = list(DEFAULT_BACKOFF)


def _env_int(environ, name: str, default: int) -> int:
    raw = str(environ.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        return default


def read_config(environ=None) -> GuardConfig:
    """Read the guard configuration from *environ* (defaults to os.environ)."""
    env = os.environ if environ is None else environ
    return GuardConfig(
        enabled=env_truthy(env.get(GUARD_ENV)),
        status_path=str(env.get(STATUS_ENV) or "").strip(),
        log_path=str(env.get(LOG_ENV) or "").strip(),
        doc=str(env.get(DOC_ENV) or ""),
        retries=_env_int(env, RETRIES_ENV, DEFAULT_RETRIES),
        backoff=parse_backoff(env.get(BACKOFF_ENV, DEFAULT_BACKOFF_TEXT)),
    )


# --- guard core -------------------------------------------------------------


class _Guard:
    """Owns the status store, the event log and all patch callbacks."""

    def __init__(self, config: GuardConfig):
        self.config = config
        self.status = GuardStatus(config.doc, config.status_path)
        self.events = EventLog(config.log_path)

    def add_error(self, message) -> None:
        self.status.add_error(message)
        self.events.emit("guard_error", message=str(message or "")[:300])

    def log_event(self, event, **fields) -> None:
        self.events.emit(event, **fields)

    def flush(self) -> bool:
        return self.status.write()

    # -- helpers used by the patched methods --------------------------------

    @staticmethod
    def page_number(page) -> int:
        return _page_number(page)

    @staticmethod
    def paragraph_id(paragraph) -> str:
        pid = getattr(paragraph, "debug_id", None)
        return "" if pid is None else str(pid)

    @staticmethod
    def retry_count() -> int:
        return int(getattr(_LOCAL, "retries", 0) or 0)

    def note_retry(self, function: str, attempt: int, delay: float) -> None:
        _LOCAL.retries = self.retry_count() + 1
        self.log_event(
            "retry",
            function=function,
            attempt=int(attempt) + 1,
            delay=round(float(delay), 3),
        )

    def remember_source(self, page, paragraph, text=None) -> None:
        try:
            source = getattr(paragraph, "unicode", None) if text is None else text
            if source is None:
                return
            self.status.remember_source(
                page, self.paragraph_id(paragraph), source
            )
        except Exception:
            pass

    def mark_empty_translation(self, paragraph, source) -> None:
        """Empty model reply: keep the original paragraph instead of blanking it."""
        pid = self.paragraph_id(paragraph)
        retry = self.retry_count()
        _LOCAL.empty_kept = True
        try:
            self.status.record(
                page=0,
                paragraph_id=pid,
                source_text=source,
                translated_text="",
                status="EMPTY",
                retry_count=retry,
                error_reason=KEPT_ORIGINAL_REASON,
                layout_status="kept_original",
            )
        except Exception as exc:
            self.add_error(f"record empty translation: {exc}")
        self.log_event(
            "empty_kept_original",
            paragraph_id=pid,
            source_chars=text_length(source),
            retry_count=retry,
        )

    # -- ILTranslator.translate_paragraph bookkeeping -----------------------

    def record_translate_result(
        self,
        paragraph,
        page,
        source,
        tracker,
        retry_count: int,
        empty_kept: bool,
    ) -> None:
        if tracker is not None and not hasattr(tracker, "input"):
            return  # paragraph skipped before translation (short/vertical/...)
        tracker_error = ""
        tracker_output = None
        last = _last_llm_tracker(tracker)
        if last is not None:
            tracker_error = str(getattr(last, "error_message", "") or "")
            tracker_output = getattr(last, "output", None)
        has_output = tracker is not None and hasattr(tracker, "output")
        final_text = getattr(paragraph, "unicode", None)
        final = final_text if isinstance(final_text, str) else ""
        source_text = source if isinstance(source, str) else ""
        if is_empty_translation(final):
            status = "EMPTY"
            reason = tracker_error or "empty_paragraph_after_translation"
        elif empty_kept:
            status = "EMPTY"
            # Keep the exact marker: consumers classify this paragraph as
            # untranslated, and it must not be hidden by a batch error string.
            reason = KEPT_ORIGINAL_REASON
        elif not has_output and _same_text(final, source_text):
            status = "FAILED"
            reason = tracker_error or "translation_exception"
        elif is_empty_translation(tracker_output) and _same_text(final, source_text):
            status = "FAILED"
            reason = tracker_error or "empty_model_reply"
        elif tracker_error and _same_text(final, source_text):
            status = "FAILED"
            reason = tracker_error
        else:
            status = "TRANSLATED"
            reason = tracker_error
        self.status.remember_source(page, self.paragraph_id(paragraph), source_text)
        self.status.record(
            page=page,
            paragraph_id=self.paragraph_id(paragraph),
            source_text=source_text,
            translated_text=final,
            status=status,
            retry_count=retry_count,
            error_reason=reason,
        )

    def record_translate_failure(
        self, paragraph, page, source, retry_count: int, reason: str
    ) -> None:
        pid = self.paragraph_id(paragraph)
        try:
            self.status.record(
                page=page,
                paragraph_id=pid,
                source_text=source,
                translated_text=getattr(paragraph, "unicode", None),
                status="FAILED",
                retry_count=retry_count,
                error_reason=reason,
            )
        except Exception as exc:
            self.add_error(f"record translate failure: {exc}")
        self.log_event("translate_failed", paragraph_id=pid, page=page, error_reason=reason)

    # -- ILTranslatorLLMOnly batch bookkeeping ------------------------------

    def record_batch_failure(self, members, reason: str) -> None:
        for page, paragraph, _tracker in members:
            try:
                self.status.merge_error(
                    page,
                    self.paragraph_id(paragraph),
                    getattr(paragraph, "unicode", None),
                    reason,
                )
            except Exception as exc:
                self.add_error(f"record batch failure: {exc}")
        self.log_event("batch_failed", error_reason=reason, paragraphs=len(members))

    def record_batch_fallbacks(self, members) -> None:
        for page, paragraph, tracker in members:
            last = _last_llm_tracker(tracker)
            if last is None:
                continue
            failed = bool(
                getattr(last, "has_error", False)
                or getattr(last, "fallback_to_translate", False)
            )
            if not failed:
                continue
            pid = self.paragraph_id(paragraph)
            reason = str(getattr(last, "error_message", "") or "fallback_to_translate")
            try:
                self.status.merge_error(
                    page, pid, getattr(paragraph, "unicode", None), reason
                )
            except Exception as exc:
                self.add_error(f"record fallback: {exc}")
            self.log_event("fallback", paragraph_id=pid, page=page, error_reason=reason)

    # -- Typesetting.render_paragraph bookkeeping ---------------------------

    def after_render(
        self,
        typesetting,
        paragraph,
        page,
        fonts,
        pre_text,
        page_no: int,
        pid: str,
    ) -> None:
        final_text = getattr(paragraph, "unicode", None)
        if is_empty_translation(pre_text):
            # Nothing was supposed to be painted; an earlier EMPTY record (the
            # original blank-area bug) must stay visible in the status file.
            return
        if _has_renderable(paragraph):
            # layout_status is intentionally left empty so a "kept_original"
            # marker recorded by post_translate_paragraph survives the
            # supersede: the paragraph rendered, but its text is the source.
            self.status.record(
                page=page_no,
                paragraph_id=pid,
                source_text=pre_text,
                translated_text=final_text,
                status="RENDERED",
                render_status="rendered",
            )
            return
        self.status.record(
            page=page_no,
            paragraph_id=pid,
            source_text=pre_text,
            translated_text=final_text,
            status="RENDER_FAILED",
            render_status="no_characters",
            layout_status="failed",
        )
        self.log_event(
            "render_failed",
            paragraph_id=pid,
            page=page_no,
            unicode_chars=text_length(pre_text),
        )
        mode = ""
        try:
            mode = self.recover_render(typesetting, paragraph, page, fonts, pre_text)
        except Exception as exc:
            self.add_error(f"render recovery: {exc}")
        if mode == "forced":
            self.status.record(
                page=page_no,
                paragraph_id=pid,
                translated_text=getattr(paragraph, "unicode", None),
                status="FORCED",
                layout_status="forced_min_scale",
                render_status="forced",
            )
            self.log_event("forced", paragraph_id=pid, page=page_no)
        elif mode == "kept_original":
            self.status.record(
                page=page_no,
                paragraph_id=pid,
                translated_text=getattr(paragraph, "unicode", None),
                status="FORCED",
                layout_status="kept_original_composition",
                render_status="forced_unicode_composition",
            )
            self.log_event("forced_kept_original", paragraph_id=pid, page=page_no)
        else:
            self.log_event("recovery_failed", paragraph_id=pid, page=page_no)

    def recover_render(self, typesetting, paragraph, page, fonts, pre_text) -> str:
        """Force characters into a paragraph whose render produced none.

        Returns ``"forced"`` when characters were produced by a minimum-scale
        layout, ``"kept_original"`` when only a plain unicode composition could
        be restored, and ``""`` when even that was impossible.
        """
        if typesetting is None or paragraph is None:
            return ""
        text = pre_text
        if is_empty_translation(text):
            text = getattr(paragraph, "unicode", None)
        if is_empty_translation(text):
            return ""
        try:
            if is_empty_translation(getattr(paragraph, "unicode", None)):
                paragraph.unicode = text
            units = []
            try:
                units = typesetting.create_typesetting_units(paragraph, fonts) or []
            except Exception:
                units = []
            if not units:
                _install_unicode_composition(paragraph, fonts, text)
                try:
                    units = typesetting.create_typesetting_units(paragraph, fonts) or []
                except Exception:
                    units = []
            if not units:
                _install_unicode_composition(paragraph, fonts, text)
                return "kept_original"
            box = getattr(paragraph, "box", None)
            if box is None:
                _install_unicode_composition(paragraph, fonts, text)
                return "kept_original"
            line_skip = 1.5 if getattr(typesetting, "is_cjk", False) else 1.3
            try:
                layouted, _all_fit = typesetting._layout_typesetting_units(
                    units, box, MIN_FORCED_SCALE, line_skip, paragraph
                )
            except Exception:
                layouted = []
            compositions = []
            for unit in layouted or []:
                try:
                    chars, curves, forms = unit.render()
                except Exception:
                    continue
                for char in chars:
                    composition = _composition_for_character(char)
                    if composition is not None:
                        compositions.append(composition)
                if page is not None:
                    for curve in curves or []:
                        try:
                            page.pdf_curve.append(curve)
                        except Exception:
                            pass
                    for form in forms or []:
                        try:
                            page.pdf_form.append(form)
                        except Exception:
                            pass
            if compositions:
                paragraph.pdf_paragraph_composition = compositions
                paragraph.scale = MIN_FORCED_SCALE
                paragraph.unicode = text
                return "forced"
            _install_unicode_composition(paragraph, fonts, text)
            return "kept_original"
        except Exception as exc:
            self.add_error(f"recover_render: {exc}")
            try:
                _install_unicode_composition(paragraph, fonts, pre_text)
            except Exception:
                pass
            return "kept_original" if not is_empty_translation(pre_text) else ""


# --- IL model helpers (lazy import; used only during recovery) --------------


def _il_model():
    return importlib.import_module(IL_MODEL_MODULE)


def _composition_for_character(char):
    """Wrap one rendered ``PdfCharacter`` in a ``PdfParagraphComposition``."""
    try:
        model = _il_model()
        return model.PdfParagraphComposition(pdf_character=char)
    except Exception:
        return None


def _fallback_style(model, fonts):
    """Pick any usable ``PdfStyle`` for the plain-unicode last resort."""
    font_id = None
    try:
        for key in fonts or {}:
            if isinstance(key, str) and key:
                font_id = key
                break
    except Exception:
        font_id = None
    if not font_id:
        font_id = "base"
    return model.PdfStyle(font_id=font_id, font_size=10)


def _install_unicode_composition(paragraph, fonts, text) -> bool:
    """Restore a plain ``pdf_same_style_unicode_characters`` composition."""
    if paragraph is None or is_empty_translation(text):
        return False
    try:
        model = _il_model()
        style = getattr(paragraph, "pdf_style", None)
        if style is None:
            style = _fallback_style(model, fonts)
        composition = model.PdfParagraphComposition(
            pdf_same_style_unicode_characters=model.PdfSameStyleUnicodeCharacters(
                unicode=str(text),
                pdf_style=style,
            ),
        )
        paragraph.pdf_paragraph_composition = [composition]
        paragraph.unicode = str(text)
        return True
    except Exception:
        return False


# --- patching ---------------------------------------------------------------


def _load(module_name: str):
    """Import a babeldoc module lazily (keeps this module importable without it)."""
    return importlib.import_module(module_name)


def _wrap_method(target, name: str, factory) -> bool:
    """Replace ``target.name`` with ``factory(original, signature)(...)``."""
    try:
        original = getattr(target, name, None)
    except Exception:
        return False
    if original is None:
        return False
    if getattr(original, _GUARD_MARK, False):
        return False
    signature = _safe_signature(original)
    wrapper = factory(original, signature)
    try:
        setattr(wrapper, _GUARD_MARK, True)
    except Exception:
        pass
    setattr(target, name, wrapper)
    return True


def _make_cache_get(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def get(*args, **kwargs):
            result = original(*args, **kwargs)
            if result is None or not is_empty_translation(result):
                return result
            guard.log_event("cache_empty_miss", cached_chars=text_length(result))
            return None

        return get

    return factory


def _make_cache_set(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def set_translation(*args, **kwargs):
            bound = _bind(signature, args, kwargs)
            translation = bound.get("translation") if bound else None
            if bound is not None and is_empty_translation(translation):
                guard.log_event(
                    "cache_empty_set_skipped",
                    text_chars=text_length(bound.get("original_text")),
                )
                return None
            return original(*args, **kwargs)

        return set_translation

    return factory


def _make_retry_method(guard: _Guard, function_name: str):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            def on_retry(attempt, delay):
                guard.note_retry(function_name, attempt, delay)

            invoke = make_retry_wrapper(
                lambda: original(*args, **kwargs),
                sleep=time.sleep,
                retries=guard.config.retries,
                backoff=guard.config.backoff,
                on_retry=on_retry,
            )
            result = invoke()
            if is_empty_translation(result):
                guard.log_event(
                    "empty_after_retries",
                    function=function_name,
                    retries=guard.config.retries,
                )
            return result

        return wrapper

    return factory


def _make_post_translate(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            bound = _bind(signature, args, kwargs)
            if bound is None:
                return original(*args, **kwargs)
            paragraph = bound.get("paragraph")
            translate_input = bound.get("translate_input")
            translated_text = bound.get("translated_text")
            if paragraph is None or not _has_debug_id(paragraph):
                return original(*args, **kwargs)
            source = getattr(translate_input, "unicode", None)
            if (
                paragraph is not None
                and not is_empty_translation(source)
                and is_empty_translation(translated_text)
            ):
                # Applying this empty value is exactly what blanks the paragraph.
                guard.mark_empty_translation(paragraph, source)
                return False
            return original(*args, **kwargs)

        return wrapper

    return factory


def _make_translate_paragraph(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            bound = _bind(signature, args, kwargs)
            if bound is None:
                return original(*args, **kwargs)
            paragraph = bound.get("paragraph")
            page = bound.get("page")
            tracker = bound.get("tracker")
            if paragraph is None or not _has_debug_id(paragraph):
                return original(*args, **kwargs)
            page_no = guard.page_number(page)
            pid = guard.paragraph_id(paragraph)
            source = getattr(paragraph, "unicode", None)
            try:
                guard.status.remember_source(page_no, pid, source)
            except Exception:
                pass
            previous_retries = getattr(_LOCAL, "retries", 0)
            previous_empty = getattr(_LOCAL, "empty_kept", False)
            _LOCAL.retries = 0
            _LOCAL.empty_kept = False
            try:
                result = original(*args, **kwargs)
            except BaseException:
                retry = guard.retry_count()
                _LOCAL.retries = previous_retries
                _LOCAL.empty_kept = previous_empty
                try:
                    guard.record_translate_failure(
                        paragraph, page_no, source, retry, "translation_exception"
                    )
                except Exception:
                    pass
                raise
            retry = guard.retry_count()
            empty_kept = bool(getattr(_LOCAL, "empty_kept", False))
            _LOCAL.retries = previous_retries
            _LOCAL.empty_kept = previous_empty
            try:
                guard.record_translate_result(
                    paragraph, page_no, source, tracker, retry, empty_kept
                )
            except Exception as exc:
                guard.add_error(f"translate_paragraph record: {exc}")
            return result

        return wrapper

    return factory


def _batch_members(batch):
    """[(page_number, paragraph, tracker)] for a ``BatchParagraph``."""
    if batch is None:
        return []
    try:
        paragraphs = list(getattr(batch, "paragraphs", None) or [])
        pages = list(getattr(batch, "pages", None) or [])
        trackers = list(getattr(batch, "trackers", None) or [])
    except Exception:
        return []
    members = []
    for index, paragraph in enumerate(paragraphs):
        page = pages[index] if index < len(pages) else None
        tracker = trackers[index] if index < len(trackers) else None
        members.append((_page_number(page), paragraph, tracker))
    return members


def _make_llm_only_translate(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            bound = _bind(signature, args, kwargs)
            if bound is None:
                return original(*args, **kwargs)
            members = _batch_members(bound.get("batch_paragraph"))
            # BatchParagraph members are real paragraphs; keep the filter
            # defensive so debug labels never enter the status file.
            members = [item for item in members if _has_debug_id(item[1])]
            for page, paragraph, _tracker in members:
                try:
                    guard.status.remember_source(
                        page, guard.paragraph_id(paragraph),
                        getattr(paragraph, "unicode", None),
                    )
                except Exception:
                    pass
            previous_retries = getattr(_LOCAL, "retries", 0)
            previous_empty = getattr(_LOCAL, "empty_kept", False)
            _LOCAL.retries = 0
            _LOCAL.empty_kept = False
            try:
                result = original(*args, **kwargs)
            except BaseException as exc:
                _LOCAL.retries = previous_retries
                _LOCAL.empty_kept = previous_empty
                try:
                    guard.record_batch_failure(
                        members, f"{type(exc).__name__}: {exc}"
                    )
                except Exception:
                    pass
                raise
            _LOCAL.retries = previous_retries
            _LOCAL.empty_kept = previous_empty
            try:
                guard.record_batch_fallbacks(members)
            except Exception as exc:
                guard.add_error(f"llm_only record: {exc}")
            return result

        return wrapper

    return factory


def _make_render_paragraph(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            bound = _bind(signature, args, kwargs)
            if bound is None:
                return original(*args, **kwargs)
            paragraph = bound.get("paragraph")
            page = bound.get("page")
            fonts = bound.get("fonts")
            typesetting = args[0] if args else None
            if paragraph is None or not _has_debug_id(paragraph):
                # BabelDOC's --debug bookkeeping labels: never record/recover.
                return original(*args, **kwargs)
            page_no = guard.page_number(page)
            pid = guard.paragraph_id(paragraph)
            pre_text = getattr(paragraph, "unicode", None)
            try:
                guard.status.remember_source(page_no, pid, pre_text)
            except Exception:
                pass
            try:
                result = original(*args, **kwargs)
            except BaseException as exc:
                mode = ""
                try:
                    mode = guard.recover_render(
                        typesetting, paragraph, page, fonts, pre_text
                    )
                except Exception as recovery_exc:
                    guard.add_error(f"render exception recovery: {recovery_exc}")
                if mode:
                    try:
                        guard.status.record(
                            page=page_no,
                            paragraph_id=pid,
                            translated_text=pre_text,
                            status="FORCED",
                            layout_status="forced_after_exception",
                            render_status="forced",
                        )
                    except Exception:
                        pass
                    guard.log_event(
                        "render_exception_recovered",
                        paragraph_id=pid,
                        page=page_no,
                        error=str(exc)[:200],
                        mode=mode,
                    )
                    return None
                raise
            try:
                guard.after_render(
                    typesetting, paragraph, page, fonts, pre_text, page_no, pid
                )
            except Exception as exc:
                guard.add_error(f"typesetting record: {exc}")
            return result

        return wrapper

    return factory


def _make_render_paragraph_to_char(guard: _Guard):
    def factory(original, signature):
        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            result = original(*args, **kwargs)
            try:
                bound = _bind(signature, args, kwargs)
                paragraph = bound.get("paragraph") if bound else None
                if paragraph is None or not _has_debug_id(paragraph):
                    return result
                text = getattr(paragraph, "unicode", None)
                if not is_empty_translation(text) and not result:
                    pid = guard.paragraph_id(paragraph)
                    page = guard.status.page_for(pid)
                    guard.status.record(
                        page=page,
                        paragraph_id=pid,
                        translated_text=text,
                        status="RENDER_FAILED",
                        render_status="pdf_no_characters",
                    )
                    guard.log_event(
                        "render_failed_pdf", paragraph_id=pid, page=page
                    )
            except Exception as exc:
                guard.add_error(f"pdf_creater record: {exc}")
            return result

        return wrapper

    return factory


def _patch_translation_cache(guard: _Guard) -> bool:
    cache_class = getattr(_load(CACHE_MODULE), "TranslationCache")
    patched = _wrap_method(cache_class, "get", _make_cache_get(guard))
    patched = _wrap_method(cache_class, "set", _make_cache_set(guard)) or patched
    return patched


def _patch_translator(guard: _Guard) -> bool:
    translator_class = getattr(_load(TRANSLATOR_MODULE), "BaseTranslator")
    patched = _wrap_method(
        translator_class, "translate", _make_retry_method(guard, "translate")
    )
    patched = (
        _wrap_method(
            translator_class, "llm_translate", _make_retry_method(guard, "llm_translate")
        )
        or patched
    )
    return patched


def _patch_il_translator(guard: _Guard) -> bool:
    translator_class = getattr(_load(IL_TRANSLATOR_MODULE), "ILTranslator")
    patched = _wrap_method(
        translator_class, "post_translate_paragraph", _make_post_translate(guard)
    )
    patched = (
        _wrap_method(
            translator_class, "translate_paragraph", _make_translate_paragraph(guard)
        )
        or patched
    )
    return patched


def _patch_il_translator_llm_only(guard: _Guard) -> bool:
    translator_class = getattr(_load(IL_LLM_ONLY_MODULE), "ILTranslatorLLMOnly")
    return _wrap_method(
        translator_class, "translate_paragraph", _make_llm_only_translate(guard)
    )


def _patch_typesetting(guard: _Guard) -> bool:
    typesetting_class = getattr(_load(TYPESETTING_MODULE), "Typesetting")
    return _wrap_method(
        typesetting_class, "render_paragraph", _make_render_paragraph(guard)
    )


def _patch_pdf_creater(guard: _Guard) -> bool:
    creater_class = getattr(_load(PDF_CREATER_MODULE), "PDFCreater")
    return _wrap_method(
        creater_class, "render_paragraph_to_char", _make_render_paragraph_to_char(guard)
    )


#: (name, patch function) in execution order.  Cache first, rendering last.
_PATCHERS = (
    ("translation_cache", _patch_translation_cache),
    ("translator_retry", _patch_translator),
    ("il_translator", _patch_il_translator),
    ("il_translator_llm_only", _patch_il_translator_llm_only),
    ("typesetting", _patch_typesetting),
    ("pdf_creater", _patch_pdf_creater),
)


# --- installation -----------------------------------------------------------

_LOCK = threading.RLock()
_INSTALLED = False
_GUARD: _Guard | None = None
_ATEXIT_REGISTERED = False


def _claim_owner() -> bool:
    """Only the process the app started owns the status file.

    BabelDOC spawns short-lived python children for font subsetting / saving;
    they inherit this environment variable and skip the guard so that their
    atexit hook cannot overwrite the real status file.
    """
    owner = os.environ.get(OWNER_ENV)
    if owner and owner != str(os.getpid()):
        return False
    os.environ[OWNER_ENV] = str(os.getpid())
    return True


def _register_atexit() -> None:
    global _ATEXIT_REGISTERED
    if _ATEXIT_REGISTERED:
        return
    _ATEXIT_REGISTERED = True
    atexit.register(_atexit_flush)


def _atexit_flush() -> None:
    """Write the final status file; never raises."""
    try:
        guard = _GUARD
        if guard is None:
            return
        guard.log_event("exited")
        guard.flush()
    except Exception:
        pass


def install(force: bool = False) -> bool:
    """Install the runtime guard; returns True when at least one patch applied.

    Safe to call more than once and from a process without BabelDOC: missing
    modules are recorded in the status errors instead of raising.
    """
    global _INSTALLED, _GUARD
    config = read_config()
    if not config.enabled:
        return False
    with _LOCK:
        if _INSTALLED and not force:
            return True
        if not _claim_owner():
            return False
        guard = _Guard(config)
        _GUARD = guard
        applied: list[str] = []
        for name, patcher in _PATCHERS:
            try:
                if patcher(guard):
                    applied.append(name)
            except Exception as exc:
                guard.add_error(f"install {name}: {type(exc).__name__}: {exc}")
        _INSTALLED = bool(applied)
        _register_atexit()
        guard.log_event("installed", patched=applied, errors=len(guard.status.errors))
        return bool(applied)


def flush_status() -> bool:
    """Write the status file now (used by atexit and by the tests)."""
    guard = _GUARD
    if guard is None:
        return False
    try:
        return guard.flush()
    except Exception:
        return False


def status_snapshot() -> dict | None:
    """Current status as a dict, or ``None`` when the guard never installed."""
    guard = _GUARD
    if guard is None:
        return None
    try:
        return guard.status.to_dict()
    except Exception:
        return None
