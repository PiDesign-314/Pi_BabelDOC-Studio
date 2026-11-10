"""Offline fixtures for the translation-completeness regression suite.

Two building blocks are shared by ``tests/test_translate_completeness.py``:

* :func:`build_fixture_pdf` -- a small, deterministic English PDF (one heading
  plus a few prose paragraphs per page, no images).  One paragraph on the second
  page is longer than 900 characters and contains
  :data:`LONG_PARAGRAPH_MARKER`: it mirrors the long paragraphs that BabelDOC's
  rich-text path failed to translate when the model returned invalid JSON or an
  empty answer.
* :class:`MockLLMServer` -- a local OpenAI-compatible ``/v1/chat/completions``
  endpoint (``127.0.0.1``, ephemeral port) so the real BabelDOC CLI can run
  end-to-end with **no network and no API key**.  It understands BabelDOC
  0.6.4's two prompt shapes:

  - the per-paragraph prompt, whose text follows the last
    ``"Now translate the following text:"`` line;
  - the JSON batch prompt of the rich-text path, whose JSON array follows
    ``"Here is the input:"``.

  Modes let a test inject the exact failures observed in production:

  ``normal``          deterministic pseudo-Chinese for everything (the batch
                      request gets a valid JSON array back);
  ``empty``           an empty answer whenever the request text contains
                      ``marker`` (both for the batch request -- which then fails
                      to parse, exactly like deepseek-flash -- and for the
                      per-paragraph fallback request of that paragraph);
  ``invalid_json``    non-JSON text for batch requests only, so the fallback
                      path has to complete the translation;
  ``rate_limit_once`` the first ``fail_first`` requests get HTTP 429 with
                      ``Retry-After``;
  ``error_once``      the first ``fail_first`` requests get HTTP 500;
  ``flaky_once``      the first request gets HTTP 429 and the second HTTP 500
                      (both transient failures in one run);
  ``flaky_invalid_json``
                      like ``flaky_once``, and every batch request gets
                      non-JSON text afterwards: one short run exercises
                      transient HTTP failures and the JSON-batch fallback;
  ``timeout_once``    the first request stalls for ``timeout_delay`` seconds.
                      This mode exists for completeness; the E2E suite does not
                      exercise it because the OpenAI client timeout is far
                      larger than a test may wait.

Every request is recorded (prompt snippet, character count, whether it was a
batch request, and the reply length) and exposed through :attr:`MockLLMServer.requests`.

The fixture PDF is intentionally simple: every paragraph is one uniform text
style, so BabelDOC's rich-text placeholders are never needed and the mock can
answer with plain translated text.
"""

from __future__ import annotations

import itertools
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pymupdf

#: Prompt fragment of the per-paragraph (fallback) translation request.
SIMPLE_MARKER = "Now translate the following text:"
#: Prompt fragment of the rich-text JSON batch request.
BATCH_MARKER = "Here is the input:"

#: Sentence placed only in the long second-page paragraph.  Tests use it to
#: target the "empty model answer" scenario and to prove that the original
#: English text is still on the page.
LONG_PARAGRAPH_MARKER = (
    "The quiet zebra protocol marker appears only in this single long paragraph."
)

#: The long paragraph must be at least this long (BabelDOC's failing case was
#: a 699-character paragraph).
LONG_PARAGRAPH_MIN_CHARS = 900
#: Page on which :data:`LONG_PARAGRAPH_MARKER` lives (1-based).
LONG_PARAGRAPH_PAGE = 2

PAGE_WIDTH = 595.0
PAGE_HEIGHT = 842.0
MARGIN = 56.0
TEXT_WIDTH = PAGE_WIDTH - 2 * MARGIN
BODY_FONT = "helv"
BODY_SIZE = 9.5
HEADING_FONT = "hebo"
HEADING_SIZE = 14.0
#: Vertical gap between two paragraphs.  Two body line heights keep BabelDOC's
#: paragraph finder from merging them into one paragraph.
PARAGRAPH_GAP = 22.0

#: Deterministic pseudo-Chinese used for "translations".  No real model call.
_TRANSLATION_UNITS = "汉语言文字翻译内容测试段落"


# ---------------------------------------------------------------------------
# fixture PDF
# ---------------------------------------------------------------------------

_SENTENCES = [
    "Reliable document translation requires that every paragraph keeps its "
    "meaning after the layout has been rebuilt.",
    "The research group collected measurements from two hundred participants "
    "over the course of a full semester.",
    "A careful reader notices when a single sentence disappears from an "
    "otherwise complete page of translated text.",
    "Machine translation systems have improved quickly, but the surrounding "
    "software that extracts and re-typesets a document still matters a lot.",
    "Each experiment was repeated three times and the average result was "
    "reported with its standard deviation in the appendix.",
    "Long paragraphs are especially fragile because the model may return a "
    "truncated answer or no answer at all for the whole batch.",
    "The authors thank the anonymous reviewers for their detailed comments, "
    "which substantially improved the clarity of this work.",
    "We therefore recommend checking the finished document page by page "
    "before publishing it or sending it to a colleague.",
]


def _prose(min_chars: int, seed: int, tail: str = "") -> str:
    """Deterministic English prose of at least *min_chars* characters."""
    parts: list[str] = []
    index = seed
    while sum(len(part) + 1 for part in parts) < min_chars:
        parts.append(_SENTENCES[index % len(_SENTENCES)])
        index += 1
    text = " ".join(parts)
    if tail and tail not in text:
        text = f"{text} {tail}"
    return text


def _font_height(fontname: str, size: float) -> float:
    """Approximate line height used by PyMuPDF's ``insert_textbox``."""
    return float(size) * 1.25


def _wrap_line_count(text: str, fontname: str, size: float, width: float) -> int:
    """Number of lines *text* needs in *width* at *size* (greedy word wrap)."""
    font = pymupdf.Font(fontname=fontname)
    limit = font.text_length("x", fontsize=size)
    usable = width - 2 * limit  # keep a small inner margin
    lines = 0
    for block in (text or "").split("\n"):
        line = ""
        for word in block.split():
            candidate = f"{line} {word}".strip()
            if line and font.text_length(candidate, fontsize=size) > usable:
                lines += 1
                line = word
            else:
                line = candidate
        lines += 1
    return max(1, lines)


def _draw_block(page, x: float, y: float, width: float, text: str, font: str, size: float) -> float:
    """Insert one text block at *y* and return the new y (with paragraph gap)."""
    # One extra line of slack: insert_textbox wraps slightly more
    # conservatively than the measuring font, and a block that does not fit is
    # silently skipped (which would break the fixture).
    lines = _wrap_line_count(text, font, size, width) + 1
    height = lines * _font_height(font, size) + 8.0
    rect = pymupdf.Rect(x, y, x + width, y + height + 8.0)
    leftover = page.insert_textbox(rect, text, fontname=font, fontsize=size)
    if leftover is not None and leftover < 0:
        raise RuntimeError(
            f"fixture layout error: text does not fit ({text[:40]!r}...)"
        )
    return y + height


def build_fixture_pdf(path, pages: int = 2) -> Path:
    """Create the deterministic English fixture PDF at *path*.

    Each page has a bold heading and three prose paragraphs.  The second page
    also has the long paragraph (>= 900 characters) containing
    :data:`LONG_PARAGRAPH_MARKER`.  There are no images.

    Returns *path*.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    try:
        for page_index in range(max(1, int(pages))):
            page = document.new_page(width=PAGE_WIDTH, height=PAGE_HEIGHT)
            y = MARGIN
            heading = (
                "1 Introduction"
                if page_index == 0
                else f"{page_index + 1} Method and Results"
            )
            y = _draw_block(
                page, MARGIN, y, TEXT_WIDTH, heading, HEADING_FONT, HEADING_SIZE
            )
            y += PARAGRAPH_GAP

            lengths = [520, 380, 440]
            if page_index == 1:
                # second page: body paragraph, the fragile long paragraph,
                # then one more body paragraph
                lengths = [430, LONG_PARAGRAPH_MIN_CHARS + 40, 360]

            for slot, goal in enumerate(lengths):
                tail = ""
                if page_index == 1 and slot == 1:
                    tail = LONG_PARAGRAPH_MARKER
                    goal = max(goal, LONG_PARAGRAPH_MIN_CHARS + 1)
                    while len(_prose(goal, seed=page_index * 10 + slot, tail=tail)) < LONG_PARAGRAPH_MIN_CHARS:
                        goal += 60
                text = _prose(goal, seed=page_index * 10 + slot, tail=tail)
                y = _draw_block(page, MARGIN, y, TEXT_WIDTH, text, BODY_FONT, BODY_SIZE)
                y += PARAGRAPH_GAP
                if y > PAGE_HEIGHT - MARGIN:
                    raise RuntimeError("fixture layout error: page overflow")
        document.save(str(target))
    finally:
        document.close()
    return target


def fixture_pages(path) -> list[list[tuple[float, float, float, float, str]]]:
    """Text blocks per page, as ``[(x0, y0, x1, y1, text), ...]``."""
    result: list[list[tuple[float, float, float, float, str]]] = []
    document = pymupdf.open(str(path))
    try:
        for index in range(document.page_count):
            page = document[index]
            blocks = []
            for block in page.get_text("blocks") or []:
                text = (block[4] or "").strip()
                if len(text) < 10:
                    continue
                blocks.append((float(block[0]), float(block[1]), float(block[2]), float(block[3]), text))
            result.append(blocks)
    finally:
        document.close()
    return result


def _normalized(text: str) -> str:
    return " ".join(str(text or "").split())


def find_marker_block(path, marker: str = LONG_PARAGRAPH_MARKER):
    """Return ``(page_number, (x0, y0, x1, y1, text))`` for the block with *marker*.

    Line wrapping in the PDF inserts newlines, so both sides are whitespace
    normalized before matching.
    """
    needle = _normalized(marker)
    for page_number, blocks in enumerate(fixture_pages(path), start=1):
        for block in blocks:
            if needle in _normalized(block[4]):
                return page_number, block
    return None, None


def find_long_source_block(path, min_chars: int = LONG_PARAGRAPH_MIN_CHARS):
    """Return ``(page_number, block)`` of the longest source paragraph."""
    best = None
    for page_number, blocks in enumerate(fixture_pages(path), start=1):
        for block in blocks:
            if len(block[4]) >= min_chars and (best is None or len(block[4]) > len(best[1][4])):
                best = (page_number, block)
    return best if best is not None else (None, None)


# ---------------------------------------------------------------------------
# mock OpenAI-compatible server
# ---------------------------------------------------------------------------


def fake_translation(text: str, ratio: float = 0.5) -> str:
    """Deterministic pseudo-Chinese of roughly ``ratio`` x the source length."""
    source = (text or "").strip()
    if not source:
        return ""
    target_len = max(6, int(len(source) * max(0.1, min(1.0, ratio))))
    unit = itertools.cycle(_TRANSLATION_UNITS)
    body = "".join(next(unit) for _ in range(target_len))
    return f"（译文）{body}"


def _message_text(payload: dict) -> tuple[str, bool]:
    """Extract the text BabelDOC asked to translate from an API payload.

    Returns ``(text, is_batch)``.  The last message containing one of the
    BabelDOC prompt markers wins (the system message carries the rules, the
    user message carries the actual input).
    """
    messages = payload.get("messages") or []
    last_text = ""
    for message in reversed(messages):
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict)
            )
        if not isinstance(content, str) or not content:
            continue
        if BATCH_MARKER in content:
            return content.rsplit(BATCH_MARKER, 1)[1].strip(), True
        if SIMPLE_MARKER in content:
            return content.rsplit(SIMPLE_MARKER, 1)[1].strip(), False
        last_text = content
    return last_text.strip(), False


def _parse_batch_input(text: str) -> list[dict]:
    """Parse the JSON array that follows ``Here is the input:``."""
    start = (text or "").find("[")
    if start < 0:
        return []
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


class MockLLMServer:
    """Local OpenAI-compatible chat-completions server for offline E2E tests.

    Parameters
    ----------
    mode:
        One of ``normal``, ``empty``, ``invalid_json``, ``rate_limit_once``,
        ``error_once``, ``timeout_once``.
    marker:
        Text fragment that triggers the ``empty`` behaviour.
    fail_first:
        Number of requests that fail for the ``rate_limit_once`` /
        ``error_once`` modes (default 1).
    timeout_delay:
        Seconds to stall once in ``timeout_once`` mode (default 2.0).
    ratio:
        Length ratio of the pseudo translation.
    """

    MODES = {
        "normal",
        "empty",
        "invalid_json",
        "rate_limit_once",
        "error_once",
        "flaky_once",
        "flaky_invalid_json",
        "timeout_once",
    }

    def __init__(
        self,
        mode: str = "normal",
        marker: str = LONG_PARAGRAPH_MARKER,
        fail_first: int = 1,
        timeout_delay: float = 2.0,
        ratio: float = 0.5,
    ) -> None:
        if mode not in self.MODES:
            raise ValueError(f"unknown mock mode: {mode!r}")
        self.mode = mode
        self.marker = marker
        self.fail_first = max(1, int(fail_first))
        self.timeout_delay = float(timeout_delay)
        self.ratio = float(ratio)

        self.requests: list[dict] = []
        self.errors: list[str] = []
        self._lock = threading.Lock()
        self._seen = 0
        self._timed_out = False
        self._server = ThreadingHTTPServer(
            ("127.0.0.1", 0), self._make_handler()
        )
        self._server.daemon_threads = True
        self._thread: threading.Thread | None = None

    # -- lifecycle ---------------------------------------------------------

    @property
    def port(self) -> int:
        return int(self._server.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def start(self) -> "MockLLMServer":
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._server.serve_forever, name="mock-llm", daemon=True
            )
            self._thread.start()
        return self

    def stop(self) -> None:
        try:
            self._server.shutdown()
        except Exception:
            pass
        try:
            self._server.server_close()
        except Exception:
            pass
        if self._thread is not None:
            self._thread.join(timeout=3.0)
            self._thread = None

    def __enter__(self) -> "MockLLMServer":
        return self.start()

    def __exit__(self, *exc_info) -> None:
        self.stop()

    # -- request inspection ------------------------------------------------

    def request_texts(self, batch: bool | None = None) -> list[str]:
        with self._lock:
            items = list(self.requests)
        if batch is None:
            return [item["text"] for item in items]
        return [item["text"] for item in items if item["batch"] is batch]

    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self.requests)

    # -- HTTP --------------------------------------------------------------

    def _decide(self, text: str, batch: bool) -> tuple[str, bytes]:
        """Return ``(kind, body)`` where kind is ``ok``, ``empty`` or ``raw``."""
        if self.mode == "empty" and self.marker and self.marker in text:
            return "empty", b""
        if batch and self.mode in {"invalid_json", "flaky_invalid_json"}:
            # exactly what a chatty model returns for the JSON batch prompt
            return "raw", b"Sure! Here are the translations you requested."
        if batch:
            items = _parse_batch_input(text)
            if not items:
                with self._lock:
                    self.errors.append("mock could not parse batch input")
                return "raw", b"Mock could not parse the batch input."
            replies = [
                {
                    "id": item.get("id"),
                    "output": fake_translation(
                        str(item.get("input") or ""), self.ratio
                    ),
                }
                for item in items
            ]
            return "ok", json.dumps(replies, ensure_ascii=False).encode("utf-8")
        return "ok", fake_translation(text, self.ratio).encode("utf-8")

    def _make_handler(self):
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep pytest output clean
                pass

            def _send(self, status: int, body: bytes, headers: dict | None = None) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def _error(self, status: int, message: str, headers: dict | None = None) -> None:
                body = json.dumps({"error": {"message": message}}).encode("utf-8")
                self._send(status, body, headers)

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = {}

                text, batch = _message_text(payload)
                with mock._lock:
                    index = len(mock.requests) + 1
                    mock.requests.append(
                        {
                            "index": index,
                            "path": self.path,
                            "model": payload.get("model", ""),
                            "text": text,
                            "chars": len(text),
                            "batch": bool(batch),
                            "response_chars": 0,
                        }
                    )

                # failure injection comes first: it applies to any request
                if mock.mode in {"rate_limit_once", "error_once"} and index <= mock.fail_first:
                    with mock._lock:
                        mock.requests[-1]["response_chars"] = -1
                    if mock.mode == "rate_limit_once":
                        self._error(429, "mock rate limit", {"Retry-After": "1"})
                    else:
                        self._error(500, "mock upstream failure")
                    return
                if mock.mode == "flaky_once" and index <= 2:
                    # one rate limit, then one server error: both must be
                    # retried by BabelDOC's OpenAI client without losing text
                    with mock._lock:
                        mock.requests[-1]["response_chars"] = -1
                    if index == 1:
                        self._error(429, "mock rate limit", {"Retry-After": "1"})
                    else:
                        self._error(500, "mock upstream failure")
                    return
                if mock.mode == "flaky_invalid_json" and index <= 2:
                    with mock._lock:
                        mock.requests[-1]["response_chars"] = -1
                    if index == 1:
                        self._error(429, "mock rate limit", {"Retry-After": "1"})
                    else:
                        self._error(500, "mock upstream failure")
                    return
                if mock.mode == "timeout_once" and not mock._timed_out:
                    with mock._lock:
                        mock._timed_out = True
                        mock.requests[-1]["response_chars"] = -2
                    time.sleep(mock.timeout_delay)
                    self._error(504, "mock timeout")
                    return

                kind, body = mock._decide(text, batch)
                with mock._lock:
                    mock.requests[-1]["response_chars"] = len(body)
                    mock.requests[-1]["kind"] = kind

                content = body.decode("utf-8") if body else ""
                response = {
                    "id": f"mock-{index}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": payload.get("model", "mock"),
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": len(text),
                        "completion_tokens": len(content),
                        "total_tokens": len(text) + len(content),
                    },
                }
                self._send(200, json.dumps(response, ensure_ascii=False).encode("utf-8"))

        return Handler


def pymupdf_text(path) -> str:
    """All text of *path* (for assertions on kept original text)."""
    document = pymupdf.open(str(path))
    try:
        return "\n".join(page.get_text("text") or "" for page in document)
    finally:
        document.close()
