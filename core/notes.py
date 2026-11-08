"""笔记与笔记分类的本地存储。

数据保存在 ``config.APP_DIR / "notes.json"``。``config.APP_DIR`` 在每次调用时
读取，测试可以用 monkeypatch 把它指向临时目录。写入使用「临时文件 +
``os.replace``」原子替换，并用模块级锁串行化并发访问。
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
import uuid
from pathlib import Path

from . import config

MAX_NOTES = 5000
MAX_CATEGORIES = 200
MAX_TITLE = 200
MAX_BODY = 200_000
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
    category_id: str = "",
    source=None,
) -> dict:
    with _LOCK:
        data = _read()
        if len(data["notes"]) >= MAX_NOTES:
            raise ValueError(f"笔记最多 {MAX_NOTES} 条")
        category = _clean_category(category_id, data["categories"])
        now = time.time()
        used = {item["id"] for item in data["notes"]}
        note = {
            "id": _new_id("n", used),
            "title": _clean_title(title),
            "body": _clean_body(body),
            "category_id": category,
            "source": _source(source),
            "created": now,
            "updated": now,
        }
        data["notes"].append(note)
        data["updated"] = _write(data["categories"], data["notes"])
    return note


def update_note(note_id: str, **fields) -> dict:
    """只允许修改 title / body / category_id / source，其它字段忽略。"""
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
