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


# --------------------------------------------------------------------------- #
# 富文本 body_html
# --------------------------------------------------------------------------- #
def test_sanitize_html_strips_dangerous_content():
    html = (
        '<p onclick="steal()">Hello</p>'
        '<script>alert("xss")</script>'
        '<img src="x" onerror="alert(1)">'
        '<a href="javascript:alert(1)">坏链接</a>'
        '<a href="https://example.com" title="安全">好链接</a>'
        '<iframe src="https://evil.example"></iframe>'
        "<style>p{color:red}</style>"
        '<object data="x">对象</object>'
        '<svg><circle onload="x"/></svg>'
        "<math><mi>x</mi></math>"
        "<template><p>模板</p></template>"
        '<embed src="x">'
    )
    clean = notes.sanitize_html(html)

    assert "script" not in clean.lower()
    assert "alert" not in clean  # 脚本内容与 javascript: 链接都不剩
    assert "onerror" not in clean and "onclick" not in clean
    for tag in ("iframe", "style", "object", "svg", "math", "template", "embed"):
        assert f"<{tag}" not in clean.lower()
    assert "<p>Hello</p>" in clean
    assert "<a>坏链接</a>" in clean
    assert (
        '<a href="https://example.com" title="安全">好链接</a>' in clean
    )


def test_sanitize_html_keeps_formatting_and_styles():
    html = (
        "<h1>标题</h1>"
        "<p><strong>粗体</strong><em>斜体</em><u>下划线</u></p>"
        "<ul><li>一</li><li>二</li></ul>"
        "<blockquote>引用</blockquote>"
        '<span style="color: red; background-color: yellow; '
        'font-size: 30px; text-align: center">样式</span>'
        '<a href="mailto:a@b.com" style="color: blue" title="邮件">联系</a>'
        '<hr style="text-align: center">'
    )
    clean = notes.sanitize_html(html)

    for fragment in (
        "<h1>标题</h1>",
        "<strong>粗体</strong>",
        "<em>斜体</em>",
        "<ul><li>一</li><li>二</li></ul>",
        "<blockquote>引用</blockquote>",
    ):
        assert fragment in clean
    assert (
        'style="color: red; background-color: yellow; text-align: center"' in clean
    )
    assert "font-size" not in clean
    assert (
        '<a href="mailto:a@b.com" style="color: blue" title="邮件">联系</a>' in clean
    )
    assert '<hr style="text-align: center">' in clean


def test_sanitize_html_escapes_and_balances():
    clean = notes.sanitize_html("<p>a &lt; b &amp; c &gt; d</p><p><strong>未闭合")
    assert "a &lt; b &amp; c &gt; d" in clean
    assert clean.endswith("</strong></p>")  # 自动补齐结束标签

    attr = notes.sanitize_html('<a title=\'a"b&c\'>x</a>')
    assert 'title="a&quot;b&amp;c"' in attr

    assert notes.sanitize_html(None) == ""
    assert notes.sanitize_html("<span/>") == "<span></span>"
    assert notes.sanitize_html("<br/>") == "<br>"
    assert notes.sanitize_html("<p>a</div></p>") == "<p>a</p>"


def test_sanitize_html_length_limit():
    huge = "<p>" + "x" * (notes.MAX_HTML + 1000) + "</p>"
    clean = notes.sanitize_html(huge)
    assert len(clean) <= notes.MAX_HTML
    assert clean.startswith("<p>") and clean.endswith("</p>")

    # 转义会变长，截断不能留下半个实体。
    entity = notes.sanitize_html("<p>" + "&" * notes.MAX_HTML + "</p>")
    assert len(entity) <= notes.MAX_HTML
    assert entity.endswith("</p>")
    text_part = entity[3:-4]
    assert text_part.endswith(";")  # 最后一个 &amp; 是完整的


def test_html_to_text_extracts_searchable_plain_text():
    html = (
        "<h1>标题</h1><p>第一段&nbsp;<strong>重点</strong></p>"
        "<ul><li>甲</li><li>乙</li></ul><blockquote>引用</blockquote>"
        "<script>不该出现</script>"
    )
    text = notes.html_to_text(html)
    assert text == "标题\n第一段 重点\n· 甲\n· 乙\n引用"
    assert notes.html_to_text("<p>a &amp; b &lt; c</p>") == "a & b < c"
    assert notes.html_to_text("<p>  a\n\tb  </p>") == "a b"
    assert notes.html_to_text("") == ""

    long_text = notes.html_to_text("<p>" + "x" * (notes.MAX_BODY + 10) + "</p>")
    assert len(long_text) <= notes.MAX_BODY


def test_body_is_derived_from_body_html(store):
    html = (
        "<h1>报告</h1><p>结论 <strong>有效</strong></p>"
        "<ul><li>证据一</li><li>证据二</li></ul>"
    )
    note = notes.create_note(title="富文本", body="旧正文", body_html=html)

    assert note["body_html"] == notes.sanitize_html(html)
    assert note["body"] == "报告\n结论 有效\n· 证据一\n· 证据二"
    assert note["body"] != "旧正文"
    # 搜索走派生出来的 body。
    assert [item["id"] for item in notes.list_notes(query="证据二")["notes"]] == [
        note["id"]
    ]

    # 危险内容在保存前就被清掉，body 也不含脚本。
    unsafe = notes.create_note(body_html="<p>安全</p><script>alert(1)</script>")
    assert unsafe["body_html"] == "<p>安全</p>"
    assert unsafe["body"] == "安全"

    # 空 body_html 时沿用 body（旧行为）。
    plain = notes.create_note(body="普通正文", body_html="")
    assert plain["body_html"] == "" and plain["body"] == "普通正文"


def test_update_note_body_html_semantics(store):
    note = notes.create_note(body="原始正文")
    assert note["body_html"] == ""

    # 只传 body：保持旧行为，body_html 不变。
    note = notes.update_note(note["id"], body="新正文")
    assert note["body"] == "新正文" and note["body_html"] == ""

    # 非空 body_html：保存清洗后的 HTML 并同步 body。
    note = notes.update_note(note["id"], body_html="<p>富文本</p>")
    assert note["body_html"] == "<p>富文本</p>"
    assert note["body"] == "富文本"

    # 同时传 body 和 body_html：body_html 优先，body 由它派生。
    note = notes.update_note(
        note["id"], body="被忽略", body_html="<p><strong>再次</strong></p>"
    )
    assert note["body_html"] == "<p><strong>再次</strong></p>"
    assert note["body"] == "再次"

    # 显式空字符串：清空 body_html，且未传 body 时 body 也清空。
    note = notes.update_note(note["id"], body_html="")
    assert note["body_html"] == "" and note["body"] == ""

    # 显式空 body_html 同时传 body：保留新 body。
    note = notes.update_note(note["id"], body="保留正文", body_html="")
    assert note["body_html"] == "" and note["body"] == "保留正文"

    # 危险 HTML 清洗为空等价于清空。
    note = notes.update_note(note["id"], body_html="<script>alert(1)</script>")
    assert note["body_html"] == "" and note["body"] == ""


def test_old_note_without_body_html_still_loads(store):
    _seed(
        store,
        [
            {
                "id": "n_old",
                "title": "旧笔记",
                "body": "# Markdown 正文\n\n旧内容",
                "category_id": "",
                "source": {
                    "path": r"C:\old.pdf",
                    "doc_id": "",
                    "page": 1,
                    "quote": "",
                    "location": "",
                },
                "created": 1.0,
                "updated": 2.0,
            }
        ],
    )
    item = notes.get_note("n_old")
    assert item is not None
    assert item["body"] == "# Markdown 正文\n\n旧内容"
    assert item["body_html"] == ""  # 旧数据自动补空字段
    assert [entry["id"] for entry in notes.list_notes(query="markdown")["notes"]] == [
        "n_old"
    ]
    # 保存（例如改标题）后仍兼容旧数据。
    item = notes.update_note("n_old", title="改名")
    assert item["body_html"] == ""
    assert item["body"].startswith("# Markdown")


def test_api_body_html_roundtrip(store):
    import app as studio

    client = studio.app.test_client()

    created = client.post(
        "/api/notes",
        json={
            "title": "富文本笔记",
            "body": "旧的纯文本",
            "body_html": '<h1>标题</h1><p onclick="x">正文</p><script>x</script>',
        },
    )
    assert created.status_code == 200
    note = created.get_json()["note"]
    assert note["body_html"] == "<h1>标题</h1><p>正文</p>"
    assert note["body"] == "标题\n正文"

    listed = client.get("/api/notes").get_json()["notes"]
    assert listed[0]["body_html"] == note["body_html"]
    assert listed[0]["body"] == "标题\n正文"

    patched = client.patch(
        f"/api/notes/{note['id']}",
        json={"body_html": "<p><strong>新</strong>内容</p>"},
    )
    assert patched.status_code == 200
    patched_note = patched.get_json()["note"]
    assert patched_note["body_html"] == "<p><strong>新</strong>内容</p>"
    assert patched_note["body"] == "新内容"

    cleared = client.patch(f"/api/notes/{note['id']}", json={"body_html": ""})
    assert cleared.status_code == 200
    cleared_note = cleared.get_json()["note"]
    assert cleared_note["body_html"] == "" and cleared_note["body"] == ""

    plain = client.post("/api/notes", json={"body": "纯文本"}).get_json()["note"]
    assert plain["body_html"] == "" and plain["body"] == "纯文本"
