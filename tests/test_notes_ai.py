"""Tests for the note "AI 帮写" backend (``ai_reader.rewrite_note`` + route).

Everything is offline: ``ai_reader._invoke`` is always monkeypatched, so no
network request and no CLI process is ever started.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
from core import ai_reader, config  # noqa: E402

NOTE_TEXT = "本文提出了一种新的注意力机制。实验结果显示效果更好。"
CANNED_TEXT = "  改写后的正文  \n"


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """Temp APP_DIR so nothing touches the real user settings."""
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    return tmp_path


@pytest.fixture()
def stub(monkeypatch):
    """Stub ``_invoke`` and expose the captured prompt / cfg / call count."""
    box: dict = {"calls": 0}

    def fake_invoke(prompt, cfg):
        box["calls"] += 1
        box["prompt"] = prompt
        box["cfg"] = cfg
        return {
            "text": CANNED_TEXT,
            "provider": "codex",
            "model": "test-model",
            "source": "cli",
            "usage": {"input_tokens": 12, "output_tokens": 34},
        }

    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)
    return box


@pytest.fixture()
def client(isolated):
    return app_module.app.test_client()


# --------------------------------------------------------------------------- #
# Constants + result shape
# --------------------------------------------------------------------------- #
def test_constants():
    assert ai_reader.NOTE_AI_MODES == (
        "polish", "academic", "concise", "expand", "structure", "fix", "custom",
    )
    assert ai_reader.NOTE_AI_MAX_CHARS == 20000
    assert ai_reader.NOTE_AI_MAX_INSTRUCTION == 500


def test_rewrite_note_result_shape(isolated, stub):
    result = ai_reader.rewrite_note(NOTE_TEXT, mode="concise")

    assert set(result) == {
        "result", "mode", "provider", "model", "elapsed", "source", "usage",
    }
    assert result["result"] == "改写后的正文"  # stripped
    assert result["mode"] == "concise"
    assert result["provider"] == "codex"
    assert result["model"] == "test-model"
    assert result["source"] == "cli"
    assert result["usage"] == {"input_tokens": 12, "output_tokens": 34}
    assert isinstance(result["elapsed"], float) and result["elapsed"] >= 0
    assert round(result["elapsed"], 1) == result["elapsed"]
    assert NOTE_TEXT in stub["prompt"]
    assert stub["calls"] == 1


def test_rewrite_note_falls_back_to_empty_usage(isolated, monkeypatch):
    def fake_invoke(prompt, cfg):
        return {
            "text": "ok",
            "provider": "api",
            "model": "m",
            "source": "api",
            "usage": {},
        }

    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)
    result = ai_reader.rewrite_note("一句话笔记")
    assert result["usage"] == {"input_tokens": 0, "output_tokens": 0}


def test_rewrite_note_normalizes_mode_and_passes_provider(isolated, stub):
    result = ai_reader.rewrite_note(
        NOTE_TEXT, mode="  FIX  ", provider={"id": "kimi"}
    )
    assert result["mode"] == "fix"
    assert stub["cfg"]["id"] == "kimi"
    assert "纠错" in stub["prompt"]
    assert "错别字" in stub["prompt"]


def test_rewrite_note_defaults_to_polish(isolated, stub):
    result = ai_reader.rewrite_note(NOTE_TEXT)
    assert result["mode"] == "polish"
    assert "润色" in stub["prompt"]
    assert ai_reader.rewrite_note(NOTE_TEXT, mode="")["mode"] == "polish"


def test_rewrite_note_unknown_scope_falls_back_to_note(isolated, stub):
    ai_reader.rewrite_note(NOTE_TEXT, scope="whatever")
    assert "Markdown" in stub["prompt"]
    assert "纯文本段落" not in stub["prompt"]


# --------------------------------------------------------------------------- #
# Prompt content
# --------------------------------------------------------------------------- #
def test_prompt_contains_hard_rules(isolated, stub):
    ai_reader.rewrite_note(NOTE_TEXT)
    prompt = stub["prompt"]
    for fragment in (
        "禁止编造事实、数据、结论、文献引用或页码",
        "保留原语言",
        "只输出改写后的正文",
        "不要用 ``` 代码块包裹",
    ):
        assert fragment in prompt, fragment


def test_prompt_contains_title_original_and_custom_instruction(isolated, stub):
    ai_reader.rewrite_note(
        NOTE_TEXT,
        mode="custom",
        instruction="改成第三人称，语气更克制",
        title="注意力机制笔记",
    )
    prompt = stub["prompt"]
    assert "笔记标题：注意力机制笔记" in prompt
    assert "原文：" in prompt
    assert NOTE_TEXT in prompt
    assert "自定义要求：改成第三人称，语气更克制" in prompt


def test_prompt_omits_empty_title_and_instruction(isolated, stub):
    ai_reader.rewrite_note(NOTE_TEXT)
    assert "笔记标题：" not in stub["prompt"]
    assert "自定义要求：" not in stub["prompt"]


@pytest.mark.parametrize(
    ("mode", "expected"),
    [
        ("polish", "保留原意"),
        ("academic", "术语准确"),
        ("concise", "删除重复"),
        ("expand", "不虚构事实"),
        ("structure", "多级标题"),
        ("fix", "不改变信息量"),
        ("custom", "自定义要求"),
    ],
)
def test_prompt_mode_rules(isolated, stub, mode, expected):
    ai_reader.rewrite_note(NOTE_TEXT, mode=mode, instruction="随便改改")
    assert expected in stub["prompt"], mode


def test_scope_guidance_differs(isolated, stub):
    ai_reader.rewrite_note(NOTE_TEXT, scope="note")
    note_prompt = stub["prompt"]
    ai_reader.rewrite_note(NOTE_TEXT, scope="selection")
    selection_prompt = stub["prompt"]

    assert "Markdown" in note_prompt
    assert "标题层级" in note_prompt
    assert "纯文本段落" not in note_prompt

    assert "纯文本段落" in selection_prompt
    assert "不要使用任何 Markdown 语法" in selection_prompt
    assert "长度与原文大致相当" in selection_prompt
    assert "标题层级" not in selection_prompt
    assert note_prompt != selection_prompt


def test_overlong_instruction_is_truncated(isolated, stub):
    instruction = "甲" * 400 + "乙" * 400
    ai_reader.rewrite_note(NOTE_TEXT, mode="custom", instruction=instruction)
    prompt = stub["prompt"]
    assert prompt.count("甲") == 400
    assert "乙" * 100 in prompt
    assert "乙" * 101 not in prompt


def test_title_is_trimmed(isolated, stub):
    ai_reader.rewrite_note(NOTE_TEXT, title="  " + "标" * 300 + "  ")
    assert "标" * 200 in stub["prompt"]
    assert "标" * 201 not in stub["prompt"]


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("text", "mode", "instruction", "message"),
    [
        ("", "polish", "", "没有可以处理的文字"),
        ("   \n\t ", "polish", "", "没有可以处理的文字"),
        (None, "polish", "", "没有可以处理的文字"),
        ("正文", "translate", "", "不支持的 AI 操作"),
        ("正文", "custom", "   ", "请填写自定义要求"),
        ("正文", "custom", "", "请填写自定义要求"),
    ],
)
def test_validation_errors(isolated, stub, text, mode, instruction, message):
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.rewrite_note(text, mode=mode, instruction=instruction)
    assert info.value.status == 400
    assert str(info.value) == message
    assert stub["calls"] == 0, "invalid input must not call the model"


def test_text_longer_than_limit_is_rejected(isolated, stub):
    oversized = "字" * (ai_reader.NOTE_AI_MAX_CHARS + 1)
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.rewrite_note(oversized)
    assert info.value.status == 400
    assert "笔记内容太长了（最多 20000 字）" == str(info.value)
    assert stub["calls"] == 0


def test_text_at_limit_is_accepted(isolated, stub):
    result = ai_reader.rewrite_note("字" * ai_reader.NOTE_AI_MAX_CHARS)
    assert result["result"] == "改写后的正文"
    assert stub["calls"] == 1


# --------------------------------------------------------------------------- #
# Flask route POST /api/notes/ai/polish
# --------------------------------------------------------------------------- #
def test_route_polish_returns_rewrite(client, stub):
    response = client.post(
        "/api/notes/ai/polish",
        json={"text": NOTE_TEXT, "mode": "academic", "title": "标题"},
    )
    assert response.status_code == 200
    data = response.get_json()
    assert set(data) == {
        "result", "mode", "provider", "model", "elapsed", "source", "usage",
    }
    assert data["result"] == "改写后的正文"
    assert data["mode"] == "academic"
    assert NOTE_TEXT in stub["prompt"]
    assert "笔记标题：标题" in stub["prompt"]


def test_route_polish_custom_scope_and_instruction(client, stub):
    response = client.post(
        "/api/notes/ai/polish",
        json={
            "text": NOTE_TEXT,
            "mode": "custom",
            "instruction": "拆成两步",
            "scope": "selection",
        },
    )
    assert response.status_code == 200
    assert "纯文本段落" in stub["prompt"]
    assert "自定义要求：拆成两步" in stub["prompt"]


def test_route_polish_propagates_reader_error(client, monkeypatch):
    def boom(prompt, cfg):
        raise ai_reader.ReaderError("Codex 未登录：在终端运行 codex login", 503)

    monkeypatch.setattr(ai_reader, "_invoke", boom)
    response = client.post("/api/notes/ai/polish", json={"text": NOTE_TEXT})
    assert response.status_code == 503
    data = response.get_json()
    assert "codex login" in data["error"]
    assert "result" not in data


def test_route_polish_requires_text(client, stub):
    response = client.post("/api/notes/ai/polish", json={})
    assert response.status_code == 400
    assert response.get_json() == {"error": "没有可以处理的文字"}

    blank = client.post("/api/notes/ai/polish", json={"text": "   "})
    assert blank.status_code == 400
    assert blank.get_json()["error"] == "没有可以处理的文字"
    assert stub["calls"] == 0


def test_route_polish_rejects_unknown_mode(client, stub):
    response = client.post(
        "/api/notes/ai/polish", json={"text": NOTE_TEXT, "mode": "poetry"}
    )
    assert response.status_code == 400
    assert response.get_json() == {"error": "不支持的 AI 操作"}


def test_route_polish_custom_needs_instruction(client, stub):
    response = client.post(
        "/api/notes/ai/polish", json={"text": NOTE_TEXT, "mode": "custom"}
    )
    assert response.status_code == 400
    assert response.get_json() == {"error": "请填写自定义要求"}


def test_route_polish_unexpected_error_is_wrapped(client, monkeypatch):
    def boom(prompt, cfg):
        raise RuntimeError("adapter exploded")

    monkeypatch.setattr(ai_reader, "_invoke", boom)
    response = client.post("/api/notes/ai/polish", json={"text": NOTE_TEXT})
    assert response.status_code == 500
    assert response.get_json() == {"error": "AI 帮写失败：adapter exploded"}


def test_route_polish_accepts_missing_json_body(client, stub):
    response = client.post("/api/notes/ai/polish")
    assert response.status_code == 400
    assert response.get_json() == {"error": "没有可以处理的文字"}
    assert stub["calls"] == 0


# --------------------------------------------------------------------------- #
# Health advertises the feature
# --------------------------------------------------------------------------- #
def test_health_features_include_notes_ai(client):
    features = client.get("/api/health").get_json()["features"]
    assert "notes-ai" in features
    for feature in ("notes", "ai-reader", "text"):
        assert feature in features
