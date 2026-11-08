"""笔记存储与 /api/notes 路由的单元测试。

所有测试都通过 monkeypatch 把 ``config.APP_DIR`` 指向临时目录，不会碰到真实
的用户数据；HTTP 测试直接复用 ``app.py`` 里的 Flask 应用对象。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import config, notes  # noqa: E402


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """临时 APP_DIR，模拟一台干净的机器。"""
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    return tmp_path


def _read_json(store: Path) -> dict:
    return json.loads((store / "notes.json").read_text(encoding="utf-8"))


def _seed(store: Path, notes_payload: list[dict], categories: list[dict] | None = None) -> None:
    """直接写一份 notes.json，用固定的时间戳验证排序。"""
    (store / "notes.json").write_text(
        json.dumps(
            {
                "updated": 42.5,
                "categories": categories or [],
                "notes": notes_payload,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


# --------------------------------------------------------------------------- #
# 笔记 CRUD
# --------------------------------------------------------------------------- #
def test_create_get_update_delete(store):
    note = notes.create_note(
        title="第一篇",
        body="# 正文\n内容",
        source={
            "path": r"C:\papers\a.pdf",
            "doc_id": "abcdef",
            "page": 3,
            "quote": "原文",
            "location": "第 3 节 · p.3",
        },
    )
    assert note["id"].startswith("n_") and len(note["id"]) == 10
    assert note["category_id"] == ""
    assert note["title"] == "第一篇"
    assert note["created"] > 0 and note["updated"] == note["created"]
    assert note["source"] == {
        "path": r"C:\papers\a.pdf",
        "doc_id": "abcdef",
        "page": 3,
        "quote": "原文",
        "location": "第 3 节 · p.3",
    }

    assert notes.get_note(note["id"]) == note
    assert notes.get_note("n_missing") is None

    updated = notes.update_note(note["id"], title="改过的标题", body="")
    assert updated["title"] == "改过的标题"
    assert updated["body"] == ""
    assert updated["created"] == note["created"]
    assert updated["updated"] >= updated["created"]
    # 没有传入的字段保持不变。
    assert updated["source"] == note["source"]

    assert notes.delete_note(note["id"]) is True
    assert notes.get_note(note["id"]) is None
    with pytest.raises(LookupError):
        notes.delete_note(note["id"])
    with pytest.raises(LookupError):
        notes.update_note("n_missing", title="x")

    data = _read_json(store)
    assert data["notes"] == [] and data["categories"] == []
    assert isinstance(data["updated"], float)
    # UTF-8 + 缩进 2。
    raw = (store / "notes.json").read_text(encoding="utf-8")
    assert raw.startswith('{\n  "updated":')


def test_field_sanitizing_and_limits(store):
    note = notes.create_note(
        title="标" * 300,
        body="正" * 200_001,
        source={
            "path": "  C:\\x.pdf  ",
            "doc_id": "d" * 100,
            "page": "12",
            "quote": "引" * 5000,
            "location": "位" * 400,
        },
    )
    assert len(note["title"]) == 200
    assert len(note["body"]) == 200_000
    assert note["source"]["path"] == r"C:\x.pdf"
    assert len(note["source"]["doc_id"]) == 64
    assert note["source"]["page"] == 12
    assert len(note["source"]["quote"]) == 4000
    assert len(note["source"]["location"]) == 300

    # 标题去掉首尾空白，正文保留原样；正文允许为空。
    title = notes.create_note(title="  标题  ", body="  保留空格  ")
    assert title["title"] == "标题"
    assert title["body"] == "  保留空格  "
    assert notes.create_note(body="")["body"] == ""

    # 类型不对的字段直接忽略，使用默认值。
    plain = notes.create_note(title=123, body=None, source="not-a-dict")
    assert plain["title"] == "" and plain["body"] == ""
    assert plain["source"] == {
        "path": "",
        "doc_id": "",
        "page": 0,
        "quote": "",
        "location": "",
    }
    # 非法页码归零。
    assert notes.create_note(source={"page": "abc"})["source"]["page"] == 0

    # 更新时坏类型不覆盖旧值。
    assert notes.update_note(note["id"], title=None)["title"] == "标" * 200


def test_notes_and_categories_have_hard_limits(store, monkeypatch):
    monkeypatch.setattr(notes, "MAX_NOTES", 2)
    notes.create_note("a")
    notes.create_note("b")
    with pytest.raises(ValueError):
        notes.create_note("c")

    monkeypatch.setattr(notes, "MAX_CATEGORIES", 2)
    notes.create_category("一")
    notes.create_category("二")
    with pytest.raises(ValueError):
        notes.create_category("三")


def test_missing_or_corrupt_store_reads_empty(store):
    assert notes.list_notes() == {"notes": [], "categories": [], "updated": 0.0}
    assert notes.list_categories() == []

    (store / "notes.json").write_text("{not json", encoding="utf-8")
    assert notes.list_notes()["notes"] == []

    # 坏文件会在下一次写入时被修复。
    note = notes.create_note("ok")
    assert _read_json(store)["notes"][0]["id"] == note["id"]


def test_broken_records_are_dropped_on_load(store):
    (store / "notes.json").write_text(
        json.dumps(
            {
                "updated": "bad",
                "categories": "oops",
                "notes": [
                    "text",
                    42,
                    {
                        "title": 5,
                        "body": "正文",
                        "category_id": "c_missing",
                        "source": {"page": 1e999},
                    },
                    {"id": "n_ok", "title": "good", "updated": 1e999},
                ],
            }
        ),
        encoding="utf-8",
    )

    data = notes.list_notes()
    assert data["updated"] == 0.0 and data["categories"] == []
    assert [item["title"] for item in data["notes"]] == ["", "good"]
    first, second = data["notes"]
    assert first["id"].startswith("n_")
    assert first["body"] == "正文"
    assert first["category_id"] == ""  # 悬空分类归为未分类
    assert first["source"]["page"] == 0  # Infinity 归零
    assert second["id"] == "n_ok" and second["updated"] == 0.0


# --------------------------------------------------------------------------- #
# 列表排序与过滤
# --------------------------------------------------------------------------- #
def test_list_sorting_and_filters(store):
    category = {"id": "c_method", "name": "方法", "created": 1.0}
    _seed(
        store,
        [
            {
                "id": "n_one",
                "title": "Alpha",
                "body": "first body",
                "category_id": "c_method",
                "source": {
                    "path": r"C:\a.pdf",
                    "doc_id": "",
                    "page": 1,
                    "quote": "Quote One",
                    "location": "",
                },
                "created": 1.0,
                "updated": 10.0,
            },
            {
                "id": "n_two",
                "title": "beta",
                "body": "Second BODY",
                "category_id": "",
                "source": {
                    "path": r"C:\b.pdf",
                    "doc_id": "",
                    "page": 2,
                    "quote": "Q2",
                    "location": "",
                },
                "created": 2.0,
                "updated": 30.0,
            },
            {
                "id": "n_three",
                "title": "Gamma",
                "body": "third",
                "category_id": "c_method",
                "source": {
                    "path": r"C:\a.pdf",
                    "doc_id": "",
                    "page": 3,
                    "quote": "目标原文",
                    "location": "",
                },
                "created": 3.0,
                "updated": 20.0,
            },
            "not-a-dict",
        ],
        [category],
    )

    everything = notes.list_notes()
    assert [item["id"] for item in everything["notes"]] == ["n_two", "n_three", "n_one"]
    assert everything["categories"] == [category]
    assert everything["updated"] == 42.5

    # 标题 / 正文 / 原文引用都支持忽略大小写匹配。
    assert [item["id"] for item in notes.list_notes(query="alpha")["notes"]] == ["n_one"]
    assert [item["id"] for item in notes.list_notes(query="second")["notes"]] == ["n_two"]
    assert [item["id"] for item in notes.list_notes(query="目标")["notes"]] == ["n_three"]
    assert notes.list_notes(query="  ALPHA  ")["notes"][0]["id"] == "n_one"
    assert notes.list_notes(query="没有这个词")["notes"] == []

    # 分类 / 未分类 / 来源路径过滤。
    assert [item["id"] for item in notes.list_notes(category_id="c_method")["notes"]] == [
        "n_three",
        "n_one",
    ]
    assert [
        item["id"] for item in notes.list_notes(category_id="uncategorized")["notes"]
    ] == ["n_two"]
    assert [item["id"] for item in notes.list_notes(path=r"C:\a.pdf")["notes"]] == [
        "n_three",
        "n_one",
    ]
    assert [item["id"] for item in notes.list_notes(path=r"C:\missing.pdf")["notes"]] == []

    # 组合过滤。
    assert [
        item["id"]
        for item in notes.list_notes(query="gamma", path=r"C:\a.pdf")["notes"]
    ] == ["n_three"]


# --------------------------------------------------------------------------- #
# 分类 CRUD
# --------------------------------------------------------------------------- #
def test_category_lifecycle(store):
    category = notes.create_category("  方法  ")
    assert category["id"].startswith("c_")
    assert category["name"] == "方法"
    assert notes.list_categories() == [category]

    with pytest.raises(ValueError):
        notes.create_category("方法")  # 同名（忽略大小写）拒绝
    with pytest.raises(ValueError):
        notes.create_category("   ")
    with pytest.raises(ValueError):
        notes.create_category("长" * 41)

    other = notes.create_category("Other")
    with pytest.raises(ValueError):
        notes.create_category("other")

    renamed = notes.rename_category(category["id"], "方法论")
    assert renamed["name"] == "方法论"
    # 重命名允许改成自己（大小写也不必相同）。
    assert notes.rename_category(category["id"], "方法论")["name"] == "方法论"
    assert notes.rename_category(category["id"], "方法论 ")["name"] == "方法论"
    with pytest.raises(ValueError):
        notes.rename_category(category["id"], "OTHER")
    with pytest.raises(LookupError):
        notes.rename_category("c_missing", "x")

    note = notes.create_note("标题", category_id=category["id"])
    assert note["category_id"] == category["id"]

    notes.delete_category(category["id"])
    assert notes.get_note(note["id"])["category_id"] == ""
    assert notes.list_categories() == [other]
    with pytest.raises(LookupError):
        notes.delete_category(category["id"])


def test_note_rejects_unknown_category(store):
    with pytest.raises(ValueError):
        notes.create_note("x", category_id="c_missing")
    note = notes.create_note("x")
    with pytest.raises(ValueError):
        notes.update_note(note["id"], category_id="c_missing")
    with pytest.raises(ValueError):
        notes.update_note(note["id"], category_id=123)
    # 改成空字符串表示移出分类。
    assert notes.update_note(note["id"], category_id="")["category_id"] == ""


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #
def test_api_note_lifecycle(store):
    import app as studio

    client = studio.app.test_client()
    assert "notes" in client.get("/api/health").get_json()["features"]

    created = client.post(
        "/api/notes",
        json={
            "title": "API 笔记",
            "body": "正文",
            "source": {"path": r"C:\papers\a.pdf", "page": 2, "quote": "原文"},
        },
    )
    assert created.status_code == 200
    note = created.get_json()["note"]
    assert note["title"] == "API 笔记"
    assert note["source"]["page"] == 2

    listed = client.get(
        "/api/notes", query_string={"q": "api", "path": r"C:\papers\a.pdf"}
    )
    assert listed.status_code == 200
    payload = listed.get_json()
    assert [item["id"] for item in payload["notes"]] == [note["id"]]
    assert payload["updated"] > 0
    assert payload["categories"] == []

    # category 为空参数时不过滤。
    assert [item["id"] for item in client.get("/api/notes", query_string={"category": ""}).get_json()["notes"]] == [note["id"]]

    patched = client.patch(f"/api/notes/{note['id']}", json={"title": "新标题"})
    assert patched.status_code == 200
    assert patched.get_json()["note"]["title"] == "新标题"

    bad_category = client.patch(
        f"/api/notes/{note['id']}", json={"category_id": "c_missing"}
    )
    assert bad_category.status_code == 400
    assert bad_category.get_json()["error"] == "分类不存在"

    missing = client.patch("/api/notes/n_missing", json={"title": "x"})
    assert missing.status_code == 404
    assert missing.get_json() == {"error": "笔记不存在"}

    deleted = client.delete(f"/api/notes/{note['id']}")
    assert deleted.status_code == 200 and deleted.get_json() == {"ok": True}

    again = client.delete(f"/api/notes/{note['id']}")
    assert again.status_code == 404
    assert again.get_json() == {"error": "笔记不存在"}


def test_api_category_lifecycle(store):
    import app as studio

    client = studio.app.test_client()

    created = client.post("/api/notes/categories", json={"name": " 方法 "})
    assert created.status_code == 200
    data = created.get_json()
    category = data["category"]
    assert category["name"] == "方法"
    assert data["categories"] == [category]

    assert client.post("/api/notes/categories", json={"name": "方法"}).status_code == 400
    assert client.post("/api/notes/categories", json={"name": "  "}).status_code == 400

    note = client.post(
        "/api/notes", json={"title": "带分类", "category_id": category["id"]}
    ).get_json()["note"]
    assert note["category_id"] == category["id"]

    renamed = client.patch(
        f"/api/notes/categories/{category['id']}", json={"name": "方法论"}
    )
    assert renamed.status_code == 200
    assert renamed.get_json()["category"]["name"] == "方法论"

    missing = client.patch("/api/notes/categories/c_missing", json={"name": "x"})
    assert missing.status_code == 404
    assert missing.get_json() == {"error": "分类不存在"}

    uncategorized = client.get(
        "/api/notes", query_string={"category": "uncategorized"}
    ).get_json()["notes"]
    assert uncategorized == []

    deleted = client.delete(f"/api/notes/categories/{category['id']}")
    assert deleted.status_code == 200
    assert deleted.get_json()["categories"] == []

    # 分类删除后，原来的笔记变成未分类。
    assert client.get("/api/notes").get_json()["notes"][0]["category_id"] == ""
    assert [item["id"] for item in client.get(
        "/api/notes", query_string={"category": "uncategorized"}
    ).get_json()["notes"]] == [note["id"]]

    again = client.delete(f"/api/notes/categories/{category['id']}")
    assert again.status_code == 404
    assert again.get_json() == {"error": "分类不存在"}
