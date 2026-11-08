"""笔记与笔记分类的本地存储。

数据保存在 ``config.APP_DIR / "notes.json"``。``config.APP_DIR`` 在每次调用时
读取，测试可以用 monkeypatch 把它指向临时目录。写入使用「临时文件 +
``os.replace``」原子替换，并用模块级锁串行化并发访问。
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from html.parser import HTMLParser
from pathlib import Path

from . import config

MAX_NOTES = 5000
MAX_CATEGORIES = 200
MAX_TITLE = 200
MAX_BODY = 200_000
MAX_HTML = 400_000
MAX_QUOTE = 4000
MAX_LOCATION = 300
MAX_PATH = 4096
MAX_DOC_ID = 64
MAX_ID = 64
MAX_CATEGORY_NAME = 40

_LOCK = threading.Lock()

EMPTY_SOURCE = {"path": "", "doc_id": "", "page": 0, "quote": "", "location": ""}


# --------------------------------------------------------------------------- #
# 清洗工具
# --------------------------------------------------------------------------- #
def _file() -> Path:
    """每次调用都取当前 APP_DIR，避免缓存测试替换后的路径。"""
    return config.APP_DIR / "notes.json"


def _text(value, limit: int) -> str | None:
    """只接受字符串；类型不对返回 None，由调用方决定忽略还是报错。"""
    if not isinstance(value, str):
        return None
    return value[:limit]


def _epoch(value) -> float:
    """时间戳：非法值按 0 处理。"""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    if not math.isfinite(number) or number < 0:
        return 0.0
    return min(number, 4e9)


def _page(value) -> int:
    """页码：非数字按 0，超出范围截断。"""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return 0
    if not math.isfinite(number):
        return 0
    return max(0, min(1_000_000, int(number)))


def _source(value) -> dict:
    """清洗来源信息；不是 dict 时返回全空结构。"""
    cleaned = dict(EMPTY_SOURCE)
    if not isinstance(value, dict):
        return cleaned
    path = _text(value.get("path"), MAX_PATH)
    if path is not None:
        cleaned["path"] = path.strip()
    doc_id = _text(value.get("doc_id"), MAX_DOC_ID)
    if doc_id is not None:
        cleaned["doc_id"] = doc_id.strip()
    cleaned["page"] = _page(value.get("page"))
    quote = _text(value.get("quote"), MAX_QUOTE)
    if quote is not None:
        cleaned["quote"] = quote
    location = _text(value.get("location"), MAX_LOCATION)
    if location is not None:
        cleaned["location"] = location.strip()
    return cleaned


def _new_id(prefix: str, used: set[str]) -> str:
    """生成 ``n_xxxxxxxx`` / ``c_xxxxxxxx`` 形式的唯一 id。"""
    for _ in range(100):
        candidate = f"{prefix}_{uuid.uuid4().hex[:8]}"
        if candidate not in used:
            return candidate
    return f"{prefix}_{uuid.uuid4().hex}"


def _clean_title(value) -> str:
    text = _text(value, MAX_TITLE)
    return (text or "").strip()


def _clean_body(value) -> str:
    return _text(value, MAX_BODY) or ""


def _clean_category(value, categories: list[dict]) -> str:
    """校验分类 id：空字符串表示未分类，其它必须是已存在的分类。"""
    if value is None:
        return ""
    text = _text(value, MAX_ID)
    if text is None:
        raise ValueError("分类不存在")
    text = text.strip()
    if not text:
        return ""
    if not any(entry["id"] == text for entry in categories):
        raise ValueError("分类不存在")
    return text


def _check_category_name(raw, categories: list[dict], skip_id: str = "") -> str:
    """分类名去空白、限长、拒绝重名（忽略大小写）；skip_id 用于重命名自己。"""
    if not isinstance(raw, str):
        raise ValueError("分类名称不能为空")
    name = raw.strip()
    if not name:
        raise ValueError("分类名称不能为空")
    if len(name) > MAX_CATEGORY_NAME:
        raise ValueError(f"分类名称最多 {MAX_CATEGORY_NAME} 个字符")
    lowered = name.casefold()
    if any(
        entry["name"].casefold() == lowered and entry["id"] != skip_id
        for entry in categories
    ):
        raise ValueError(f"已经有叫「{name}」的分类了")
    return name


# --------------------------------------------------------------------------- #
# HTML 清洗（白名单 + 转义，供富文本编辑器使用）
# --------------------------------------------------------------------------- #
ALLOWED_TAGS = frozenset(
    {
        "p", "div", "br", "span", "strong", "b", "em", "i", "u", "s",
        "strike", "del", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "blockquote", "hr", "a", "code", "pre", "table", "thead", "tbody",
        "tr", "td", "th", "mark",
    }
)
# 这些标签连同内部文本一起丢弃，避免脚本 / 外部资源 / 模板注入。
DROP_CONTENT_TAGS = frozenset(
    {"script", "style", "iframe", "object", "embed", "svg", "math", "template"}
)
VOID_TAGS = frozenset({"br", "hr"})
VOID_DROP_TAGS = frozenset({"embed"})
BLOCK_TAGS = frozenset(
    {
        "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "blockquote", "hr", "pre", "table", "thead", "tbody", "tr", "td", "th",
    }
)
ALLOWED_CSS = frozenset(
    {
        "color", "background-color", "font-weight", "font-style",
        "text-decoration", "text-align",
    }
)


def _escape(value: str, quote: bool = False) -> str:
    """转义文本 / 属性值中的 & < >（属性值再转义双引号）。"""
    value = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if quote:
        value = value.replace('"', "&quot;")
    return value


def _safe_href(value: str) -> bool:
    """只允许 http / https / mailto 链接。"""
    lowered = value.strip().casefold()
    return (
        lowered.startswith("http://")
        or lowered.startswith("https://")
        or lowered.startswith("mailto:")
    )


def _clean_style(raw: str) -> str:
    """只保留白名单 CSS 属性，危险值整条丢弃。"""
    kept: list[str] = []
    for declaration in raw.split(";"):
        if ":" not in declaration:
            continue
        name, value = declaration.split(":", 1)
        name = name.strip().lower()
        value = value.strip()
        if name not in ALLOWED_CSS or not value:
            continue
        lowered = value.casefold()
        if (
            "javascript:" in lowered
            or "expression" in lowered
            or re.search(r"url\s*\(", lowered)
        ):
            continue
        value = re.sub(r"[\x00-\x1f\x7f]", "", value)  # 去掉控制字符
        if value:
            kept.append(f"{name}: {value}")
    return "; ".join(kept)


class _Sanitizer(HTMLParser):
    """把任意 HTML 收敛成只含白名单标签 / 属性的闭合片段。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tokens: list[tuple] = []
        self._stack: list[str] = []
        self._dropping: list[str] = []

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            if tag not in VOID_DROP_TAGS:
                self._dropping.append(tag)
            return
        if self._dropping or tag not in ALLOWED_TAGS:
            return
        if tag in VOID_TAGS:
            self.tokens.append(("void", tag, self._attributes(tag, attrs)))
            return
        self.tokens.append(("open", tag, self._attributes(tag, attrs)))
        self._stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            if tag in self._dropping:
                while self._dropping:
                    if self._dropping.pop() == tag:
                        break
            return
        if self._dropping or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag not in self._stack:
            return
        # 顺手补上没写结束标签的内层标签，保证输出闭合良好。
        while self._stack:
            open_tag = self._stack.pop()
            self.tokens.append(("close", open_tag))
            if open_tag == tag:
                break

    def handle_data(self, data):
        if self._dropping or not data:
            return
        self.tokens.append(("text", _escape(data)))

    def _attributes(self, tag: str, attrs) -> str:
        rendered: list[str] = []
        seen: set[str] = set()
        for name, value in attrs:
            name = str(name or "").lower()
            if not name or name in seen:
                continue
            value = value if isinstance(value, str) else ""
            if name == "style":
                style = _clean_style(value)
                if style:
                    rendered.append(f' style="{_escape(style, True)}"')
                    seen.add(name)
            elif tag == "a" and name in {"href", "title"}:
                if name == "href" and not _safe_href(value):
                    continue
                rendered.append(f' {name}="{_escape(value, True)}"')
                seen.add(name)
            elif tag == "ul" and name == "class" and value.strip() == "rn-todo":
                rendered.append(' class="rn-todo"')
                seen.add(name)
            elif tag == "li" and name == "data-check" and value.strip() in {"0", "1"}:
                rendered.append(f' data-check="{value.strip()}"')
                seen.add(name)
        return "".join(rendered)


def _token_html(token: tuple) -> str:
    kind = token[0]
    if kind == "void":
        return f"<{token[1]}{token[2]}>"
    if kind == "open":
        return f"<{token[1]}{token[2]}>"
    return f"</{token[1]}>"


def _cut_escaped(text: str, room: int) -> str:
    """按字符预算截断已转义文本，避免留下半个实体。"""
    cut = text[:room]
    amp = cut.rfind("&")
    if amp >= 0 and ";" not in cut[amp:]:
        cut = cut[:amp]
    return cut


def _render(tokens: list[tuple], limit: int) -> str:
    """把 token 流渲染成不超长、闭合良好的 HTML。"""
    if limit <= 0:
        return ""
    parts: list[str] = []
    used = 0
    stack: list[str] = []
    for token in tokens:
        closing = sum(len(tag) + 3 for tag in stack)  # 已打开标签的闭合开销
        if token[0] == "text":
            room = limit - used - closing
            if room <= 0:
                break
            text = token[1]
            if len(text) > room:
                piece = _cut_escaped(text, room)
                if piece:
                    parts.append(piece)
                break
            parts.append(text)
            used += len(text)
            continue

        chunk = _token_html(token)
        if token[0] == "open":
            closing_after = closing + len(token[1]) + 3
        elif token[0] == "close":
            closing_after = max(0, closing - (len(stack[-1]) + 3)) if stack else closing
        else:
            closing_after = closing
        if used + len(chunk) + closing_after > limit:
            break
        parts.append(chunk)
        used += len(chunk)
        if token[0] == "open":
            stack.append(token[1])
        elif token[0] == "close" and stack:
            stack.pop()

    for tag in reversed(stack):
        parts.append(f"</{tag}>")
    return "".join(parts)


def sanitize_html(raw) -> str:
    """白名单清洗 HTML：危险标签连内容丢弃，其它未知标签丢弃但保留文字。"""
    if not isinstance(raw, str):
        return ""
    parser = _Sanitizer()
    try:
        parser.feed(raw[:MAX_HTML])
        parser.close()
    except Exception:  # 解析器不应对用户内容抛错；万一抛了就用已解析部分
        pass
    return _render(parser.tokens, MAX_HTML)


class _TextExtractor(HTMLParser):
    """把 HTML 变成可搜索的纯文本。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._dropping: list[str] = []

    def _block(self) -> None:
        self.parts.append("\n")

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            if tag not in VOID_DROP_TAGS:
                self._dropping.append(tag)
            return
        if self._dropping:
            return
        if tag == "li":
            self._block()
            self.parts.append("· ")
        elif tag == "br" or tag in BLOCK_TAGS:
            self._block()

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in DROP_CONTENT_TAGS:
            if tag in self._dropping:
                while self._dropping:
                    if self._dropping.pop() == tag:
                        break
            return
        if self._dropping:
            return
        if tag in BLOCK_TAGS:
            self._block()

    def handle_data(self, data):
        if self._dropping or not data:
            return
        # HTML 源码里的换行 / 制表符在渲染时就是空格，只让块级边界产生换行。
        self.parts.append(re.sub(r"\s+", " ", data))


def html_to_text(value) -> str:
    """HTML → 纯文本：块级元素换行、li 加“· ”、实体反转义、压缩空白。"""
    raw = _text(value, MAX_HTML)
    if not raw:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(raw)
        parser.close()
    except Exception:
        pass
    text = "".join(parser.parts)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+", " ", text)  # 行内空白（含 &nbsp;）压成一个空格
    text = re.sub(r" *\n *", "\n", text)  # 行首尾空白去掉
    text = re.sub(r"\n+", "\n", text)
    return text.strip()[:MAX_BODY]


# --------------------------------------------------------------------------- #
# 读写
# --------------------------------------------------------------------------- #
def _entries(value) -> list:
    return value if isinstance(value, list) else []


def _category(value, used: set[str]) -> dict | None:
    """清洗一条分类记录；坏数据直接丢弃。"""
    if not isinstance(value, dict):
        return None
    name = _text(value.get("name"), MAX_CATEGORY_NAME)
    if name is None:
        return None
    name = name.strip()
    if not name:
        return None
    raw_id = _text(value.get("id"), MAX_ID)
    category_id = (raw_id or "").strip()
    if not category_id or category_id in used:
        category_id = _new_id("c", used)
    used.add(category_id)
    return {
        "id": category_id,
        "name": name,
        "created": _epoch(value.get("created")),
    }


def _note(value, category_ids: set[str], used: set[str]) -> dict | None:
    """清洗一条笔记记录；坏数据直接丢弃。"""
    if not isinstance(value, dict):
        return None
    raw_id = _text(value.get("id"), MAX_ID)
    note_id = (raw_id or "").strip()
    if not note_id or note_id in used:
        note_id = _new_id("n", used)
    used.add(note_id)
    category_id = _text(value.get("category_id"), MAX_ID)
    category_id = (category_id or "").strip()
    if category_id not in category_ids:
        category_id = ""
    created = _epoch(value.get("created"))
    updated = _epoch(value.get("updated")) or created
    return {
        "id": note_id,
        "title": _clean_title(value.get("title")),
        "body": _clean_body(value.get("body")),
        # 旧笔记没有这个字段，补空字符串保持结构一致。
        "body_html": sanitize_html(value.get("body_html")),
        "category_id": category_id,
        "source": _source(value.get("source")),
        "created": created,
        "updated": updated,
    }


def _read() -> dict:
    """读取整份存储；文件缺失或损坏时返回空结构。"""
    try:
        data = json.loads(_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        return {"updated": 0.0, "categories": [], "notes": []}

    categories: list[dict] = []
    category_ids: set[str] = set()
    for entry in _entries(data.get("categories"))[:MAX_CATEGORIES]:
        cleaned = _category(entry, category_ids)
        if cleaned:
            categories.append(cleaned)
    categories.sort(key=lambda entry: entry["created"])

    notes: list[dict] = []
    used: set[str] = set()
    for entry in _entries(data.get("notes"))[:MAX_NOTES]:
        cleaned = _note(entry, category_ids, used)
        if cleaned:
            notes.append(cleaned)
    return {
        "updated": _epoch(data.get("updated")),
        "categories": categories,
        "notes": notes,
    }


def _write(categories: list[dict], notes: list[dict]) -> float:
    """原子写入整份存储，返回本次更新时间。"""
    target = _file()
    updated = time.time()
    payload = {"updated": updated, "categories": categories, "notes": notes}
    target.parent.mkdir(parents=True, exist_ok=True)
    # 同目录临时文件保证 os.replace 在同一文件系统内原子完成。
    temp = target.with_name(f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(temp, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(temp, target)
    finally:
        try:
            temp.unlink()
        except OSError:
            pass
    return updated


# --------------------------------------------------------------------------- #
# 笔记
# --------------------------------------------------------------------------- #
def list_notes(
    query: str = "",
    category_id: str | None = None,
    path: str | None = None,
) -> dict:
    """列出笔记：支持全文 / 分类 / 来源路径过滤，按更新时间倒序。"""
    with _LOCK:
        data = _read()

    needle = str(query or "").strip().lower()
    category = category_id if isinstance(category_id, str) else None
    wanted_path = path if isinstance(path, str) and path else None

    items = data["notes"]
    if needle:
        items = [
            item
            for item in items
            if needle in item["title"].lower()
            or needle in item["body"].lower()
            or needle in item["source"]["quote"].lower()
        ]
    if category == "uncategorized":
        items = [item for item in items if not item["category_id"]]
    elif category:
        items = [item for item in items if item["category_id"] == category]
    if wanted_path is not None:
        items = [item for item in items if item["source"]["path"] == wanted_path]

    items = sorted(
        items,
        key=lambda item: (item["updated"], item["created"]),
        reverse=True,
    )
    return {
        "notes": items,
        "categories": data["categories"],
        "updated": data["updated"],
    }


def get_note(note_id: str) -> dict | None:
    with _LOCK:
        data = _read()
    return next((item for item in data["notes"] if item["id"] == note_id), None)


def create_note(
    title: str = "",
    body: str = "",
    body_html: str = "",
    category_id: str = "",
    source=None,
) -> dict:
    with _LOCK:
        data = _read()
        if len(data["notes"]) >= MAX_NOTES:
            raise ValueError(f"笔记最多 {MAX_NOTES} 条")
        category = _clean_category(category_id, data["categories"])
        # 富文本优先：清洗后非空时保存 HTML，并让 body 成为可搜索的纯文本。
        cleaned_html = sanitize_html(body_html)
        clean_body = html_to_text(cleaned_html) if cleaned_html else _clean_body(body)
        now = time.time()
        used = {item["id"] for item in data["notes"]}
        note = {
            "id": _new_id("n", used),
            "title": _clean_title(title),
            "body": clean_body,
            "body_html": cleaned_html,
            "category_id": category,
            "source": _source(source),
            "created": now,
            "updated": now,
        }
        data["notes"].append(note)
        data["updated"] = _write(data["categories"], data["notes"])
    return note


def update_note(note_id: str, **fields) -> dict:
    """只允许修改 title / body / body_html / category_id / source。"""
    with _LOCK:
        data = _read()
        note = next((item for item in data["notes"] if item["id"] == note_id), None)
        if note is None:
            raise LookupError("笔记不存在")

        if "title" in fields:
            title = _text(fields["title"], MAX_TITLE)
            if title is not None:  # 类型不对则保持原值
                note["title"] = title.strip()
        if "body" in fields:
            body = _text(fields["body"], MAX_BODY)
            if body is not None:
                note["body"] = body
        if "body_html" in fields:
            raw_html = _text(fields["body_html"], MAX_HTML)
            if raw_html is not None:
                cleaned_html = sanitize_html(raw_html)
                note["body_html"] = cleaned_html
                if cleaned_html:
                    # 富文本优先，body 始终是它的纯文本派生。
                    note["body"] = html_to_text(cleaned_html)
                elif "body" not in fields:
                    # 显式清空 body_html 时，没同时给 body 就一起清空。
                    note["body"] = ""
        if "category_id" in fields:
            note["category_id"] = _clean_category(
                fields["category_id"], data["categories"]
            )
        if "source" in fields and isinstance(fields["source"], dict):
            note["source"] = _source(fields["source"])

        note["updated"] = time.time()
        data["updated"] = _write(data["categories"], data["notes"])
    return note


def delete_note(note_id: str) -> bool:
    with _LOCK:
        data = _read()
        kept = [item for item in data["notes"] if item["id"] != note_id]
        if len(kept) == len(data["notes"]):
            raise LookupError("笔记不存在")
        data["notes"] = kept
        data["updated"] = _write(data["categories"], kept)
    return True


# --------------------------------------------------------------------------- #
# 分类
# --------------------------------------------------------------------------- #
def list_categories() -> list[dict]:
    with _LOCK:
        return _read()["categories"]


def create_category(name: str) -> dict:
    with _LOCK:
        data = _read()
        if len(data["categories"]) >= MAX_CATEGORIES:
            raise ValueError(f"分类最多 {MAX_CATEGORIES} 个")
        label = _check_category_name(name, data["categories"])
        used = {item["id"] for item in data["categories"]}
        entry = {
            "id": _new_id("c", used),
            "name": label,
            "created": time.time(),
        }
        data["categories"].append(entry)
        data["updated"] = _write(data["categories"], data["notes"])
    return entry


def rename_category(category_id: str, name: str) -> dict:
    with _LOCK:
        data = _read()
        entry = next(
            (item for item in data["categories"] if item["id"] == category_id), None
        )
        if entry is None:
            raise LookupError("分类不存在")
        entry["name"] = _check_category_name(
            name, data["categories"], entry["id"]
        )
        data["updated"] = _write(data["categories"], data["notes"])
    return entry


def delete_category(category_id: str) -> None:
    """删除分类，并把属于它的笔记改为未分类。"""
    with _LOCK:
        data = _read()
        kept = [item for item in data["categories"] if item["id"] != category_id]
        if len(kept) == len(data["categories"]):
            raise LookupError("分类不存在")
        for item in data["notes"]:
            if item["category_id"] == category_id:
                item["category_id"] = ""
        data["categories"] = kept
        data["updated"] = _write(kept, data["notes"])
    return None
