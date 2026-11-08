"""Grounded AI reading for PDF papers.

The reader extracts page text with PyMuPDF, picks the pages that matter for a
question (quote page ±1, keyword hits, pages with tables/figures/experiments)
and asks a locally installed CLI (Codex / Kimi / Claude) or an OpenAI
compatible HTTP API to answer **with ``[pN]`` citations only**.

No network access happens unless the caller explicitly configures the ``api``
provider; CLI adapters run in a temporary empty directory and never print API
keys.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from core import config, toc

CLI_TIMEOUT = 180
API_TIMEOUT = 180
MAX_TEXT_PAGES = 600
CHUNK_CHARS = 1100
MIN_CHUNKS = 6
MAX_CHUNKS = 10
MAX_CONTEXT_CHARS = 16000
VERSION_TTL = 60.0

AI_PRESETS = {
    "moonshot": {
        "name": "Moonshot Kimi",
        "base_url": "https://api.moonshot.cn/v1",
        "models": ["kimi-k2-0905-preview", "moonshot-v1-32k"],
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o-mini", "gpt-4o"],
    },
    "deepseek": {
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "models": ["deepseek-chat"],
    },
    "ollama": {
        "name": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "models": ["qwen2.5:7b", "llama3.1:8b"],
    },
}

SYSTEM_PROMPT = (
    "你是 BabelDOC Studio 里的论文助读老师。读者正在读论文，问题可能附有一段选中的原文。\n"
    "回答原则：\n"
    "1. 先讲清楚：用你自己的知识把概念、背景和直觉讲明白，必要时给出直观类比、小例子或分步骤解释。\n"
    "2. 再对论文：用下面提供的论文材料核对、补充或限定你的解释；引用论文内容时在句末用 [pN] "
    "标注材料里给出的页码（例如 [p3]）。论文没有直接讲到的内容，明确说「论文没有直接展开」，"
    "不要编造页码或文献。\n"
    "3. 如果用户附了选中的原文，先解释这段话在说什么、为什么这么说，再联系上下文和论文整体。\n"
    "写作要求：用中文；用 Markdown 小标题（##）、要点列表、加粗和引用块组织内容，"
    "但不要输出表格、链接或参考文献条目；回答要有信息量，不要只复述摘要或一句话结论，"
    "概念解释通常 400–900 字，简单问题可以更短；不要使用「结论：」「依据：」这类模板标签，"
    "自然地讲解；不确定的地方直说。"
)

_EVIDENCE_RE = re.compile(
    r"\b(table|figure|fig\.|experiment(?:s|al)?|results?|ablation|evaluation|"
    r"benchmark|comparison|baseline)\b",
    re.IGNORECASE,
)
_CITE_RE = re.compile(r"\[p(\d{1,5})\]", re.IGNORECASE)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。！？])\s+|\n+")
_LATIN_TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9]{1,}")
_CJK_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")

# provider -> {"ts", "command", "version"}; version probing is slow on Windows
_VERSION_CACHE: dict[str, dict] = {}


class ReaderError(RuntimeError):
    """Error with an HTTP status the Flask route can pass through."""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = int(status)


def _fitz():
    try:
        import pymupdf  # type: ignore[import-not-found]
        return pymupdf
    except ImportError:  # pragma: no cover - older PyMuPDF only exposes fitz
        import fitz  # type: ignore[import-not-found]
        return fitz


def _no_window() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _home() -> Path:
    return Path.home()


def _localappdata() -> Path:
    raw = os.environ.get("LOCALAPPDATA")
    return Path(raw) if raw else _home() / "AppData" / "Local"


def _scrub(text: str, secret: str = "") -> str:
    """Short error text with credentials removed."""
    value = str(text or "")
    if secret:
        value = value.replace(secret, "***")
    value = re.sub(r"(sk-[A-Za-z0-9_\-]{6,})", "sk-***", value)
    return re.sub(r"\s+", " ", value).strip()[:600]


def _tail(text: str, limit: int = 400) -> str:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    return value[-limit:] if len(value) > limit else value


# --------------------------------------------------------------------------- #
# Page text + cache
# --------------------------------------------------------------------------- #
def ai_dir() -> Path:
    return Path(config.APP_DIR) / "ai"


def _signature(pdf: Path) -> str:
    stat = pdf.stat()
    raw = f"{pdf.resolve()}|{int(stat.st_mtime_ns)}|{stat.st_size}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def page_texts(path: str | Path, force: bool = False) -> list[str]:
    """Text of every page (1-based page ``i`` is ``result[i - 1]``)."""
    pdf = Path(path).expanduser()
    if not pdf.is_file():
        raise ReaderError(f"文件不存在：{pdf}", 404)

    cache = ai_dir() / f"text-{_signature(pdf)}.json"
    if not force:
        try:
            raw = json.loads(cache.read_text(encoding="utf-8"))
            pages = raw.get("pages") if isinstance(raw, dict) else None
            if isinstance(pages, list) and pages:
                return [str(page or "") for page in pages]
        except (OSError, ValueError, TypeError):
            pass

    fitz = _fitz()
    pages: list[str] = []
    with fitz.open(pdf) as doc:
        total = min(int(doc.page_count), MAX_TEXT_PAGES)
        for index in range(total):
            try:
                pages.append(doc[index].get_text("text") or "")
            except Exception:
                pages.append("")
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(
            json.dumps({"pages": pages}, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass
    return pages


# --------------------------------------------------------------------------- #
# Retrieval
# --------------------------------------------------------------------------- #
def _clean_page_text(text: str) -> str:
    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def _split_chunks(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    cleaned = _clean_page_text(text)
    if not cleaned:
        return []
    if len(cleaned) <= limit:
        return [cleaned]
    parts: list[str] = []
    buffer = ""
    for paragraph in re.split(r"\n\s*\n", cleaned):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        while len(paragraph) > limit:
            cut = paragraph.rfind(" ", 0, limit)
            if cut < limit // 2:
                cut = limit
            piece = paragraph[:cut].strip()
            if piece:
                parts.append(piece)
            paragraph = paragraph[cut:].strip()
        if len(buffer) + len(paragraph) + 2 <= limit:
            buffer = f"{buffer}\n\n{paragraph}" if buffer else paragraph
        else:
            if buffer:
                parts.append(buffer)
            buffer = paragraph
    if buffer:
        parts.append(buffer)
    return [part for part in parts if part.strip()]


def _tokens(text: str) -> list[str]:
    lowered = str(text or "").lower()
    tokens = _LATIN_TOKEN_RE.findall(lowered)
    cjk = _CJK_CHAR_RE.findall(lowered)
    tokens.extend(cjk)
    tokens.extend("".join(cjk[index:index + 2]) for index in range(len(cjk) - 1))
    return tokens


def _bm25_scores(chunks: list[dict], query: str) -> list[float]:
    """Plain BM25 over page chunks; enough for picking 6–10 pages."""
    if not chunks:
        return []
    docs = [_tokens(chunk["text"]) for chunk in chunks]
    total = len(docs)
    average = sum(len(doc) for doc in docs) / max(1, total)
    doc_freq: dict[str, int] = {}
    for doc in docs:
        for term in set(doc):
            doc_freq[term] = doc_freq.get(term, 0) + 1
    scores = [0.0] * total
    k1, b = 1.5, 0.75
    terms = set(_tokens(query))
    for term in terms:
        frequency = doc_freq.get(term)
        if not frequency:
            continue
        idf = math.log(1.0 + (total - frequency + 0.5) / (frequency + 0.5))
        for index, doc in enumerate(docs):
            count = doc.count(term)
            if not count:
                continue
            length = len(doc) or 1
            denominator = count + k1 * (1.0 - b + b * length / max(average, 1.0))
            scores[index] += idf * (count * (k1 + 1.0)) / denominator
    return scores


def _quote_page(quote: dict, pages: list[str]) -> int:
    try:
        page = int(quote.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    if 1 <= page <= len(pages):
        return page
    needle = re.sub(r"\s+", " ", str(quote.get("text") or "")).strip()[:80].lower()
    if len(needle) >= 12:
        for index, text in enumerate(pages):
            if needle in re.sub(r"\s+", " ", text).lower():
                return index + 1
    return 0


def _safe_toc(pdf: Path) -> list[dict]:
    try:
        items = toc.read_toc(pdf).get("items") or []
    except Exception:
        return []
    cleaned = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            cleaned.append(
                {
                    "title": str(item.get("title") or ""),
                    "page": int(item.get("page") or 1),
                    "level": int(item.get("level") or 1),
                }
            )
        except (TypeError, ValueError):
            continue
    return cleaned


def _select_chunks(chunks: list[dict], quote_page: int) -> list[dict]:
    chosen: list[dict] = []
    used: set[tuple[int, int]] = set()

    def add(chunk: dict) -> bool:
        if len(chosen) >= MAX_CHUNKS:
            return False
        key = (int(chunk["page"]), int(chunk["index"]))
        if key in used:
            return False
        used_chars = sum(len(item["text"]) + 12 for item in chosen)
        remaining = MAX_CONTEXT_CHARS - used_chars
        text = str(chunk["text"])
        if len(text) + 12 > remaining:
            if len(chosen) >= MIN_CHUNKS or remaining < 400:
                return False
            text = text[: remaining - 12].strip()
            if len(text) < 200:
                return False
        used.add(key)
        item = dict(chunk)
        item["text"] = text
        chosen.append(item)
        return True

    if quote_page:
        for distance, page in enumerate(
            (quote_page, quote_page - 1, quote_page + 1, quote_page - 2, quote_page + 2)
        ):
            if page < 1:
                continue
            page_chunks = sorted(
                (chunk for chunk in chunks if int(chunk["page"]) == page),
                key=lambda chunk: -chunk["_score"],
            )
            limit = 2 if distance == 0 else 1
            for chunk in page_chunks[:limit]:
                add(chunk)

    evidence = [chunk for chunk in chunks if _EVIDENCE_RE.search(chunk["text"])]
    evidence.sort(key=lambda chunk: -chunk["_score"])
    for chunk in evidence:
        if len(chosen) >= MIN_CHUNKS + 1:
            break
        add(chunk)

    for chunk in sorted(chunks, key=lambda item: -item["_score"]):
        if len(chosen) >= MAX_CHUNKS:
            break
        add(chunk)
    return chosen


def build_context(path: str | Path, question: str = "", quote: dict | None = None) -> dict:
    """Retrieve up to 10 relevant page chunks (≤16000 chars) for a question."""
    pdf = Path(path).expanduser()
    pages = page_texts(pdf)
    quote = quote if isinstance(quote, dict) else {}
    quote_text = str(quote.get("text") or "").strip()
    quote_page = _quote_page(quote, pages)
    toc_items = _safe_toc(pdf)

    chunks: list[dict] = []
    for index, text in enumerate(pages):
        for order, part in enumerate(_split_chunks(text)):
            chunks.append({"page": index + 1, "index": order, "text": part})

    scores = _bm25_scores(chunks, f"{question} {quote_text}")
    for index, chunk in enumerate(chunks):
        score = scores[index] if index < len(scores) else 0.0
        if quote_page:
            distance = abs(int(chunk["page"]) - quote_page)
            if distance == 0:
                score += 6.0
            elif distance == 1:
                score += 4.0
            elif distance == 2:
                score += 1.0
        score += min(len(_EVIDENCE_RE.findall(chunk["text"])), 4) * 0.7
        chunk["_score"] = score

    selected = _select_chunks(chunks, quote_page)
    selected.sort(key=lambda chunk: (int(chunk["page"]), int(chunk["index"])))
    context_text = "\n\n".join(
        f"[p{chunk['page']}]\n{chunk['text']}" for chunk in selected
    )
    return {
        "path": str(pdf),
        "question": str(question or ""),
        "quote": quote,
        "page_count": len(pages),
        "toc": toc_items,
        "chunks": [
            {
                "page": int(chunk["page"]),
                "text": chunk["text"],
                "score": round(float(chunk["_score"]), 3),
            }
            for chunk in selected
        ],
        "context": context_text,
        "total_chars": len(context_text),
        "_pages": pages,
    }


# --------------------------------------------------------------------------- #
# Prompt
# --------------------------------------------------------------------------- #
def build_prompt(
    context: dict,
    question: str,
    quote: dict | None = None,
    history: list | None = None,
) -> str:
    quote = quote if isinstance(quote, dict) else {}
    history = history if isinstance(history, list) else []
    sections: list[str] = [SYSTEM_PROMPT]

    toc_items = context.get("toc") or []
    if toc_items:
        lines = []
        for item in toc_items[:60]:
            try:
                indent = "  " * max(0, min(3, int(item.get("level") or 1) - 1))
                lines.append(f"{indent}{item.get('title', '')} — p{item.get('page', '?')}")
            except (TypeError, ValueError):
                continue
        if lines:
            sections.append("论文目录（章节 → 页码）：\n" + "\n".join(lines))

    quote_text = str(quote.get("text") or "").strip()
    if quote_text:
        try:
            page = int(quote.get("page") or 0)
        except (TypeError, ValueError):
            page = 0
        where = f"（第 {page} 页）" if page else ""
        sections.append(f'用户选中的原文{where}：\n"""\n{quote_text[:1200]}\n"""')

    dialogue: list[str] = []
    for message in history[-6:]:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "")
        content = str(message.get("content") or "").strip()
        if not content or role not in {"user", "assistant"}:
            continue
        dialogue.append(f"{'用户' if role == 'user' else '助手'}：{content[:800]}")
    if dialogue:
        sections.append("最近的对话：\n" + "\n".join(dialogue))

    material = str(context.get("context") or "").strip()
    if not material:
        material = "（没有检索到可用文本）"
    sections.append("论文材料（用来核对/补充回答，每段前的 [pN] 是该段所在页码）：\n" + material)
    sections.append("问题：" + str(question or "").strip())
    sections.append(
        "请直接回答：先用自己的知识把概念、背景和直觉讲清楚，再用 [pN] 标注论文里的依据。"
    )
    return "\n\n".join(sections)


# --------------------------------------------------------------------------- #
# Citations
# --------------------------------------------------------------------------- #
def _sentences(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_SPLIT_RE.split(text or "") if part.strip()]


def _snippet_for_page(page_text: str, question: str, quote_text: str = "") -> str:
    text = re.sub(r"\s+", " ", str(page_text or "")).strip()
    if not text:
        return ""
    wanted = set(_tokens(f"{question} {quote_text}"))
    best = ""
    best_score = 0.0
    for sentence in _sentences(text):
        tokens = _tokens(sentence)
        if not tokens:
            continue
        overlap = sum(1 for token in tokens if token in wanted)
        score = overlap / math.sqrt(len(tokens))
        if score > best_score:
            best, best_score = sentence, score
    if not best:
        return text[:180]
    if len(best) < 150:
        position = text.find(best)
        if position >= 0:
            best = text[position:position + 240]
    snippet = best.strip()
    if len(snippet) > 240:
        cut = snippet[:239].rfind(" ")
        snippet = snippet[:(cut if cut > 120 else 239)].rstrip() + "…"
    return snippet or text[:180]


def _section_for_page(toc_items: list[dict], page: int) -> str:
    section = ""
    for item in toc_items or []:
        if not isinstance(item, dict):
            continue
        try:
            item_page = int(item.get("page") or 0)
        except (TypeError, ValueError):
            continue
        if item_page <= page:
            section = str(item.get("title") or "")
    return section


def parse_citations(
    answer_text: str,
    pages: list[str],
    toc_items: list[dict] | None = None,
    question: str = "",
    quote_text: str = "",
) -> list[dict]:
    """Turn ``[pN]`` markers into a de-duplicated, page-valid citation list."""
    page_count = len(pages or [])
    refs: list[int] = []
    for match in _CITE_RE.finditer(str(answer_text or "")):
        page = int(match.group(1))
        if 1 <= page <= page_count and page not in refs:
            refs.append(page)
    citations = []
    for page in refs:
        citations.append(
            {
                "ref": f"p{page}",
                "page": page,
                "section": _section_for_page(toc_items or [], page),
                "snippet": _snippet_for_page(
                    pages[page - 1] if page - 1 < len(pages) else "",
                    question,
                    quote_text,
                ),
            }
        )
    return citations


# --------------------------------------------------------------------------- #
# Provider discovery
# --------------------------------------------------------------------------- #
def _find_which(names: tuple[str, ...]) -> str:
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return ""


def _find_codex() -> str:
    found = _find_which(("codex", "codex.exe", "codex.cmd", "codex.bat"))
    if found:
        return found
    root = _localappdata() / "OpenAI" / "Codex" / "bin"
    try:
        candidates = [path for path in root.glob("*/codex.exe") if path.is_file()]
    except OSError:
        return ""
    if not candidates:
        return ""

    def sort_key(path: Path):
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    candidates.sort(key=sort_key, reverse=True)
    return str(candidates[0])


def _find_kimi() -> str:
    return _find_which(("kimi", "kimi.exe", "kimi.cmd", "kimi.bat"))


def _find_claude() -> str:
    return _find_which(("claude", "claude.exe", "claude.cmd", "claude.bat"))


def _probe_version(command: str) -> str:
    if not command:
        return ""
    try:
        proc = subprocess.run(
            [command, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            creationflags=_no_window(),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    output = f"{proc.stdout or ''} {proc.stderr or ''}"
    match = re.search(r"\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?", output)
    return match.group(0) if match else ""


def _cli_info(kind: str) -> dict:
    now = time.monotonic()
    cached = _VERSION_CACHE.get(kind)
    if cached and now - float(cached.get("ts") or 0.0) < VERSION_TTL:
        return cached
    if kind == "codex":
        command = _find_codex()
    elif kind == "kimi":
        command = _find_kimi()
    elif kind == "claude":
        command = _find_claude()
    else:
        command = ""
    info = {
        "ts": now,
        "command": command,
        "version": _probe_version(command) if command else "",
    }
    _VERSION_CACHE[kind] = info
    return info


def _codex_logged_in() -> bool:
    try:
        auth = _home() / ".codex" / "auth.json"
        return auth.is_file() and auth.stat().st_size > 0
    except OSError:
        return False


def _kimi_logged_in() -> bool:
    try:
        return (_home() / ".kimi-code").exists()
    except OSError:
        return False


def detect_providers() -> list[dict]:
    """Status of the local CLI providers, with version probes cached 60 s."""
    codex = _cli_info("codex")
    kimi = _cli_info("kimi")
    claude = _cli_info("claude")

    codex_available = bool(codex["command"])
    codex_logged = codex_available and _codex_logged_in()
    kimi_available = bool(kimi["command"])
    kimi_logged = kimi_available and _kimi_logged_in()
    claude_available = bool(claude["command"])

    codex_hint = ""
    if not codex_available:
        codex_hint = "未检测到 codex 命令，请先安装 Codex CLI"
    elif not codex_logged:
        codex_hint = "Codex 未登录：在终端运行 codex login"

    kimi_hint = ""
    if not kimi_available:
        kimi_hint = "未检测到 kimi 命令"
    elif not kimi_logged:
        kimi_hint = "未检测到 Kimi 登录信息，首次使用请在终端登录 kimi"

    claude_hint = ""
    if not claude_available:
        claude_hint = "未检测到 claude 命令"

    return [
        {
            "id": "codex",
            "name": "Codex CLI",
            "available": codex_available,
            "logged_in": codex_logged,
            "version": str(codex["version"]),
            "command": str(codex["command"]),
            "hint": codex_hint,
        },
        {
            "id": "kimi",
            "name": "Kimi Code CLI",
            "available": kimi_available,
            "logged_in": kimi_logged,
            "version": str(kimi["version"]),
            "command": str(kimi["command"]),
            "hint": kimi_hint,
        },
        {
            "id": "claude",
            "name": "Claude Code",
            "available": claude_available,
            "logged_in": claude_available,
            "version": str(claude["version"]),
            "command": str(claude["command"]),
            "hint": claude_hint,
        },
    ]


def default_provider(providers: list[dict] | None = None) -> str:
    providers = providers if providers is not None else detect_providers()
    for provider in providers:
        if provider.get("available") and provider.get("logged_in"):
            return str(provider["id"])
    for provider in providers:
        if provider.get("available"):
            return str(provider["id"])
    configured = config.public_ai_settings()
    if configured.get("base_url") and configured.get("model"):
        return "api"
    return "codex"


# --------------------------------------------------------------------------- #
# Invocation
# --------------------------------------------------------------------------- #
def _normalize_provider(provider) -> dict:
    ai = config.load_raw().get("ai") or {}
    provider_id = ""
    explicit_model = ""
    base_url = ""
    api_key = ""
    if isinstance(provider, str):
        provider_id = provider
    elif isinstance(provider, dict):
        provider_id = str(provider.get("id") or "")
        explicit_model = str(provider.get("model") or "")
        base_url = str(provider.get("base_url") or "")
        api_key = str(provider.get("api_key") or "")
    provider_id = (provider_id or str(ai.get("provider") or "auto")).strip().lower()
    if provider_id not in {"auto", "codex", "kimi", "claude", "api"}:
        provider_id = "auto"
    base_url = (base_url or str(ai.get("base_url") or "")).strip()
    if not base_url:
        preset = AI_PRESETS.get(str(ai.get("preset") or "").strip().lower())
        if preset:
            base_url = str(preset.get("base_url") or "")
    if not api_key:
        api_key = config.ai_api_key()
    return {
        "id": provider_id,
        "model": explicit_model.strip(),
        # Saved model belongs to the API provider; it must not leak into a CLI
        # command (e.g. a Moonshot model name passed to Codex would fail).
        "saved_model": str(ai.get("model") or "").strip(),
        "base_url": base_url,
        "api_key": api_key,
    }


def _resolve_auto() -> str:
    for provider_id in ("codex", "kimi", "claude"):
        if _cli_info(provider_id)["command"]:
            return provider_id
    return "api"


def _usage_from(raw) -> dict:
    data = raw if isinstance(raw, dict) else {}

    def pick(*keys: str) -> int:
        for key in keys:
            value = data.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return int(value)
        return 0

    return {
        "input_tokens": pick("input_tokens", "prompt_tokens", "inputTokens"),
        "output_tokens": pick("output_tokens", "completion_tokens", "outputTokens"),
    }


def _parse_codex_stdout(stdout: str) -> tuple[str, dict]:
    answer = ""
    usage: dict = {"input_tokens": 0, "output_tokens": 0}
    for line in str(stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        item = event.get("item") if isinstance(event.get("item"), dict) else {}
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            text = item.get("text") or item.get("content") or ""
            if str(text).strip():
                answer = str(text)
        if isinstance(event.get("usage"), dict):
            usage = _usage_from(event["usage"])
    return answer, usage


def _run_codex(prompt: str, model: str = "") -> dict:
    info = _cli_info("codex")
    command = str(info.get("command") or _find_codex())
    if not command:
        raise ReaderError(
            "未检测到 Codex CLI：请先安装 Codex CLI，或在 AI 设置中改用其他提供方",
            503,
        )
    if not _codex_logged_in():
        raise ReaderError("Codex 未登录：在终端运行 codex login 后再试", 503)

    tmp = tempfile.mkdtemp(prefix="babeldoc-ai-")
    last = Path(tmp) / "last.txt"
    cmd = [
        command,
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "read-only",
        "-C",
        tmp,
        "--json",
        "-o",
        str(last),
    ]
    if model:
        cmd.extend(["-m", model])
    cmd.append(prompt)
    try:
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=CLI_TIMEOUT,
                cwd=tmp,
                creationflags=_no_window(),
            )
        except subprocess.TimeoutExpired as exc:
            raise ReaderError(
                f"Codex 响应超时（{CLI_TIMEOUT} 秒），请重试或换用其他提供方", 504
            ) from exc
        except FileNotFoundError as exc:
            raise ReaderError("未检测到 Codex CLI，请先安装后在终端运行 codex login", 503) from exc
        except OSError as exc:
            raise ReaderError(f"无法启动 Codex：{_scrub(str(exc))}", 503) from exc

        answer, usage = _parse_codex_stdout(proc.stdout or "")
        if not answer:
            try:
                if last.is_file():
                    answer = last.read_text(encoding="utf-8", errors="replace").strip()
            except OSError:
                answer = ""
        if not answer:
            detail = _tail(proc.stderr or proc.stdout)
            raise ReaderError(
                f"Codex 没有返回答案：{_scrub(detail) or '请检查 codex login 与网络连接'}",
                503,
            )
        return {
            "text": answer,
            "provider": "codex",
            "model": model or "default",
            "source": "cli",
            "usage": usage,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _run_kimi(prompt: str, model: str = "") -> dict:
    command = _find_kimi()
    if not command:
        raise ReaderError(
            "未检测到 Kimi Code CLI：请先安装 kimi 命令，或在 AI 设置中改用其他提供方",
            503,
        )
    tmp = tempfile.mkdtemp(prefix="babeldoc-ai-")
    cmd = [command, "-p", prompt]
    if model:
        cmd.extend(["-m", model])
    cmd.extend(["--output-format", "text"])
    try:
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=CLI_TIMEOUT,
                cwd=tmp,
                creationflags=_no_window(),
            )
        except subprocess.TimeoutExpired as exc:
            raise ReaderError(
                f"Kimi 响应超时（{CLI_TIMEOUT} 秒），请重试或换用其他提供方", 504
            ) from exc
        except OSError as exc:
            raise ReaderError(f"无法启动 Kimi：{_scrub(str(exc))}", 503) from exc
        answer = (proc.stdout or "").strip()
        if not answer:
            detail = _tail(proc.stderr)
            raise ReaderError(
                f"Kimi 没有返回答案：{_scrub(detail) or '请检查 kimi 是否已登录'}", 503
            )
        return {
            "text": answer,
            "provider": "kimi",
            "model": model or "default",
            "source": "cli",
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _run_claude(prompt: str, model: str = "") -> dict:
    command = _find_claude()
    if not command:
        raise ReaderError(
            "未检测到 Claude Code：请先安装 claude 命令，或在 AI 设置中改用其他提供方",
            503,
        )
    tmp = tempfile.mkdtemp(prefix="babeldoc-ai-")
    cmd = [command, "-p", prompt, "--output-format", "json"]
    if model:
        cmd.extend(["-m", model])
    try:
        try:
            proc = subprocess.run(
                cmd,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=CLI_TIMEOUT,
                cwd=tmp,
                creationflags=_no_window(),
            )
        except subprocess.TimeoutExpired as exc:
            raise ReaderError(
                f"Claude 响应超时（{CLI_TIMEOUT} 秒），请重试或换用其他提供方", 504
            ) from exc
        except OSError as exc:
            raise ReaderError(f"无法启动 Claude：{_scrub(str(exc))}", 503) from exc
        raw = (proc.stdout or "").strip()
        answer = ""
        usage = {"input_tokens": 0, "output_tokens": 0}
        if raw:
            try:
                data = json.loads(raw)
            except ValueError:
                answer = raw
            else:
                if isinstance(data, dict):
                    if data.get("is_error"):
                        detail = _tail(data.get("result") or data.get("error") or raw)
                        raise ReaderError(
                            f"Claude 返回错误：{_scrub(detail)}", 503
                        )
                    answer = str(data.get("result") or data.get("text") or "").strip()
                    usage = _usage_from(data.get("usage") or {})
                else:
                    answer = raw
        if not answer:
            detail = _tail(proc.stderr)
            raise ReaderError(
                f"Claude 没有返回答案：{_scrub(detail) or '请检查 claude 是否已登录'}", 503
            )
        return {
            "text": answer,
            "provider": "claude",
            "model": model or "default",
            "source": "cli",
            "usage": usage,
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _run_api(prompt: str, cfg: dict) -> dict:
    base_url = str(cfg.get("base_url") or "").strip().rstrip("/")
    model = str(cfg.get("model") or "").strip()
    api_key = str(cfg.get("api_key") or "").strip()
    if not base_url or not model:
        raise ReaderError(
            "未配置 API：请在 AI 设置中填写 API 地址与模型，或登录 Codex/Kimi/Claude CLI",
            503,
        )
    url = (
        base_url
        if base_url.endswith("/chat/completions")
        else f"{base_url}/chat/completions"
    )
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
            "stream": False,
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request_ = urllib.request.Request(url, data=body, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(request_, timeout=API_TIMEOUT) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
        except Exception:
            pass
        raise ReaderError(
            f"API 请求失败（HTTP {exc.code}）：{_scrub(detail, api_key)}", 503
        ) from exc
    except TimeoutError as exc:
        raise ReaderError(f"API 响应超时（{API_TIMEOUT} 秒），请重试", 504) from exc
    except urllib.error.URLError as exc:
        raise ReaderError(
            f"无法连接 API：{_scrub(str(exc.reason), api_key)}", 503
        ) from exc
    except OSError as exc:
        raise ReaderError(f"API 请求失败：{_scrub(str(exc), api_key)}", 503) from exc

    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise ReaderError("API 返回的不是 JSON，请检查 API 地址是否正确", 503) from exc
    choices = data.get("choices") if isinstance(data, dict) else None
    answer = ""
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else {}
        if isinstance(message, dict):
            answer = str(message.get("content") or "")
        if not answer and isinstance(choices[0], dict):
            answer = str(choices[0].get("text") or "")
    if not answer.strip():
        detail = _tail(json.dumps(data, ensure_ascii=False) if isinstance(data, dict) else raw)
        raise ReaderError(f"API 没有返回内容：{_scrub(detail)}", 503)
    return {
        "text": answer.strip(),
        "provider": "api",
        "model": model,
        "source": "api",
        "usage": _usage_from(data.get("usage") if isinstance(data, dict) else {}),
    }


def _invoke(prompt: str, cfg: dict) -> dict:
    provider_id = cfg["id"]
    if provider_id == "auto":
        provider_id = _resolve_auto()
    model = str(cfg.get("model") or "")
    if provider_id == "api":
        model = model or str(cfg.get("saved_model") or "")
    if provider_id == "codex":
        return _run_codex(prompt, model)
    if provider_id == "kimi":
        return _run_kimi(prompt, model)
    if provider_id == "claude":
        return _run_claude(prompt, model)
    api_cfg = dict(cfg)
    api_cfg["model"] = model
    return _run_api(prompt, api_cfg)


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def answer(
    path: str | Path,
    question: str,
    quote: dict | None = None,
    history: list | None = None,
    provider=None,
) -> dict:
    """Answer a question about a PDF, grounded in retrieved pages."""
    pdf = Path(path).expanduser()
    if not pdf.is_file():
        raise ReaderError(f"文件不存在：{pdf}", 404)
    question = str(question or "").strip()
    if not question:
        raise ReaderError("请输入问题", 400)
    quote = quote if isinstance(quote, dict) else {}
    history = history if isinstance(history, list) else []

    context = build_context(pdf, question, quote)
    if not context["chunks"]:
        raise ReaderError(
            "无法从 PDF 中提取文本（可能是扫描件），请先 OCR 或换一个文件", 400
        )

    prompt = build_prompt(context, question, quote, history)
    cfg = _normalize_provider(provider)
    started = time.time()
    result = _invoke(prompt, cfg)
    elapsed = round(time.time() - started, 1)
    citations = parse_citations(
        result["text"],
        context.get("_pages") or [],
        context.get("toc") or [],
        question,
        str(quote.get("text") or ""),
    )
    return {
        "answer": str(result["text"]).strip(),
        "citations": citations,
        "provider": str(result["provider"]),
        "model": str(result["model"]),
        "elapsed": elapsed,
        "source": str(result["source"]),
        "usage": result.get("usage") or {"input_tokens": 0, "output_tokens": 0},
    }
