"""Image attachments for ``POST /api/reader/ask`` (offline: no network/CLI).

Covers data-URL validation, the vision payload sent to the API provider, the
files + prompt note handed to CLI providers, and the Flask route contract.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
from core import ai_reader, config  # noqa: E402


def data_url(data: bytes, mime: str = "image/png") -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """Temp settings + cache folder and a cold provider probe cache."""
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    ai_reader._VERSION_CACHE.clear()
    yield tmp_path
    ai_reader._VERSION_CACHE.clear()


@pytest.fixture()
def tiny_pdf(tmp_path):
    """A stub file that passes the route's existence/suffix check."""
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\n% offline stub\n")
    return pdf


# --------------------------------------------------------------------------- #
# parse_image_payloads
# --------------------------------------------------------------------------- #
def test_parse_returns_empty_for_none_and_empty_list():
    assert ai_reader.parse_image_payloads(None) == []
    assert ai_reader.parse_image_payloads([]) == []


def test_parse_valid_data_url_keeps_bytes_and_name():
    images = ai_reader.parse_image_payloads(
        [{"data_url": data_url(b"\x01\x02\x03"), "name": "shot.png"}]
    )
    assert images == [
        {"mime": "image/png", "bytes": b"\x01\x02\x03", "name": "shot.png"}
    ]


def test_parse_name_falls_back_to_index_and_extension():
    images = ai_reader.parse_image_payloads(
        [
            {"data_url": data_url(b"a")},
            {"data_url": data_url(b"b", "image/jpeg"), "name": "   "},
            {"data_url": data_url(b"c", "image/gif")},
        ]
    )
    assert [image["name"] for image in images] == [
        "image-1.png",
        "image-2.jpg",
        "image-3.gif",
    ]


def test_parse_sanitizes_names():
    images = ai_reader.parse_image_payloads(
        [
            {"data_url": data_url(b"a"), "name": "a\x00b\x1f.png"},
            {"data_url": data_url(b"b"), "name": r"C:\tmp\..\evil.png"},
            {"data_url": data_url(b"c"), "name": "x" * 300},
        ]
    )
    assert images[0]["name"] == "ab.png"
    assert images[1]["name"] == "evil.png"
    assert len(images[2]["name"]) == 120


def test_parse_accepts_already_normalized_entries():
    first = ai_reader.parse_image_payloads(
        [{"data_url": data_url(b"abc"), "name": "a.png"}]
    )
    assert ai_reader.parse_image_payloads(first) == first


def test_parse_rejects_non_list():
    for raw in ({"data_url": data_url(b"a")}, data_url(b"a"), 42, "images"):
        with pytest.raises(ai_reader.ReaderError) as info:
            ai_reader.parse_image_payloads(raw)
        assert info.value.status == 400
        assert "图片格式不正确" in str(info.value)


def test_parse_rejects_too_many_images():
    raw = [{"data_url": data_url(bytes([index]))} for index in range(5)]
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.parse_image_payloads(raw)
    assert info.value.status == 400
    assert str(info.value) == "最多上传 4 张图片"


def test_parse_rejects_bad_mime():
    raw = [{"data_url": "data:image/svg+xml;base64,PHN2Zz4="}]
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.parse_image_payloads(raw)
    assert info.value.status == 400
    assert "图片格式不正确" in str(info.value)


def test_parse_rejects_invalid_base64():
    raw = [{"data_url": "data:image/png;base64,AAAAA"}]
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.parse_image_payloads(raw)
    assert info.value.status == 400
    assert str(info.value) == "图片数据无法识别"


def test_parse_rejects_non_dict_entries_and_bad_data_url_types():
    for raw in (
        ["data:image/png;base64,AAAA"],
        [{"data_url": 5}],
        [{"name": "no-data-url.png"}],
    ):
        with pytest.raises(ai_reader.ReaderError) as info:
            ai_reader.parse_image_payloads(raw)
        assert info.value.status == 400
        assert "图片格式不正确" in str(info.value)


def test_parse_rejects_oversize_single_image(monkeypatch):
    monkeypatch.setattr(ai_reader, "MAX_IMAGE_BYTES", 4)
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.parse_image_payloads([{"data_url": data_url(b"12345")}])
    assert info.value.status == 400
    assert "单张图片太大了" in str(info.value)


def test_parse_rejects_oversize_total(monkeypatch):
    monkeypatch.setattr(ai_reader, "MAX_IMAGES_TOTAL_BYTES", 6)
    raw = [{"data_url": data_url(b"1234")}, {"data_url": data_url(b"5678")}]
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.parse_image_payloads(raw)
    assert info.value.status == 400
    assert str(info.value) == "图片总大小超出限制"


# --------------------------------------------------------------------------- #
# answer() orchestration
# --------------------------------------------------------------------------- #
def _fake_context() -> dict:
    return {
        "chunks": [{"page": 1, "text": "x"}],
        "_pages": ["x"],
        "toc": [],
        "context": "[p1]\nx",
    }


def _fake_result() -> dict:
    return {
        "text": "答案 [p1]",
        "provider": "api",
        "model": "vision-model",
        "source": "api",
        "usage": {"input_tokens": 1, "output_tokens": 2},
    }


def test_answer_forwards_parsed_images_to_invoke(isolated, tiny_pdf, monkeypatch):
    captured: dict = {}

    def fake_invoke(prompt, cfg, images=None):
        captured["prompt"] = prompt
        captured["images"] = images
        return _fake_result()

    monkeypatch.setattr(ai_reader, "build_context", lambda *args, **kwargs: _fake_context())
    monkeypatch.setattr(ai_reader, "_normalize_provider", lambda provider: {"id": "api"})
    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)

    result = ai_reader.answer(
        tiny_pdf,
        "图里是什么？",
        None,
        [],
        {"id": "api"},
        images=[{"data_url": data_url(b"abc"), "name": "shot.png"}],
    )

    assert set(result) == {
        "answer", "citations", "provider", "model", "elapsed", "source", "usage",
    }
    assert result["answer"] == "答案 [p1]"
    assert len(captured["images"]) == 1
    assert captured["images"][0]["mime"] == "image/png"
    assert captured["images"][0]["bytes"] == b"abc"
    assert captured["images"][0]["name"] == "shot.png"


def test_answer_accepts_pre_parsed_images(isolated, tiny_pdf, monkeypatch):
    parsed = ai_reader.parse_image_payloads([{"data_url": data_url(b"xyz")}])
    captured: dict = {}

    def fake_invoke(prompt, cfg, images=None):
        captured["images"] = images
        return _fake_result()

    monkeypatch.setattr(ai_reader, "build_context", lambda *args, **kwargs: _fake_context())
    monkeypatch.setattr(ai_reader, "_normalize_provider", lambda provider: {"id": "api"})
    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)

    ai_reader.answer(tiny_pdf, "问题", images=parsed)
    assert captured["images"] == parsed


def test_answer_without_images_keeps_two_argument_invoke(isolated, tiny_pdf, monkeypatch):
    captured: dict = {}

    def fake_invoke(prompt, cfg):
        captured["args"] = (prompt, cfg)
        return _fake_result()

    monkeypatch.setattr(ai_reader, "build_context", lambda *args, **kwargs: _fake_context())
    monkeypatch.setattr(ai_reader, "_normalize_provider", lambda provider: {"id": "api"})
    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)

    ai_reader.answer(tiny_pdf, "问题")
    assert len(captured["args"]) == 2
    assert isinstance(captured["args"][0], str)
    assert "问题" in captured["args"][0]
    assert captured["args"][1]["id"] == "api"


def test_answer_rejects_invalid_images_before_building_context(isolated, tiny_pdf, monkeypatch):
    called: list[int] = []
    monkeypatch.setattr(
        ai_reader, "build_context", lambda *args, **kwargs: called.append(1) or _fake_context()
    )
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.answer(
            tiny_pdf, "问题", images=[{"data_url": "data:text/plain;base64,AAAA"}]
        )
    assert info.value.status == 400
    assert called == []


def test_invoke_forwards_images_to_api_runner(isolated, monkeypatch):
    captured: dict = {}

    def fake_api(prompt, cfg, images=None):
        captured["images"] = images
        return _fake_result()

    monkeypatch.setattr(ai_reader, "_run_api", fake_api)
    parsed = ai_reader.parse_image_payloads([{"data_url": data_url(b"z")}])
    ai_reader._invoke("p", {"id": "api", "model": "m", "saved_model": ""}, parsed)
    assert captured["images"] == parsed


# --------------------------------------------------------------------------- #
# API provider: OpenAI-compatible vision content blocks
# --------------------------------------------------------------------------- #
class _FakeResponse:
    def __init__(self, payload: dict):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_run_api_sends_vision_content_blocks(isolated, monkeypatch):
    captured: dict = {}

    def fake_urlopen(request_, timeout=None):
        captured["request"] = request_
        return _FakeResponse(
            {
                "choices": [{"message": {"role": "assistant", "content": "vision 回答 [p1]"}}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 3},
            }
        )

    monkeypatch.setattr(ai_reader.urllib.request, "urlopen", fake_urlopen)
    result = ai_reader._run_api(
        "看图回答",
        {"base_url": "http://stub.invalid/v1", "model": "vision-model", "api_key": "k"},
        [{"mime": "image/png", "bytes": b"x", "name": "a.png"}],
    )

    assert result["text"] == "vision 回答 [p1]"
    body = json.loads(captured["request"].data.decode("utf-8"))
    assert body["model"] == "vision-model"
    assert body["temperature"] == 0.2
    assert body["stream"] is False
    message = body["messages"][0]
    assert message["role"] == "user"
    content = message["content"]
    assert content[0] == {"type": "text", "text": "看图回答"}
    assert content[1]["type"] == "image_url"
    url = content[1]["image_url"]["url"]
    assert url.startswith("data:image/png;base64,")
    assert url.split(",", 1)[1] == base64.b64encode(b"x").decode("ascii")


def test_run_api_without_images_keeps_string_content(isolated, monkeypatch):
    captured: dict = {}

    def fake_urlopen(request_, timeout=None):
        captured["request"] = request_
        return _FakeResponse({"choices": [{"message": {"content": "ok [p1]"}}]})

    monkeypatch.setattr(ai_reader.urllib.request, "urlopen", fake_urlopen)
    ai_reader._run_api("hi", {"base_url": "http://stub.invalid/v1", "model": "m", "api_key": ""})

    body = json.loads(captured["request"].data.decode("utf-8"))
    assert body["messages"] == [{"role": "user", "content": "hi"}]


# --------------------------------------------------------------------------- #
# CLI providers: images written into the existing temp cwd + prompt note
# --------------------------------------------------------------------------- #
def test_codex_receives_images_in_temp_cwd(isolated, monkeypatch):
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        cwd = Path(kwargs["cwd"])
        captured["files"] = sorted(path.name for path in cwd.iterdir())
        captured["bytes"] = (cwd / "image-1.png").read_bytes()
        captured["prompt"] = cmd[-1]
        stdout = (
            '{"type":"item.completed","item":{"type":"agent_message",'
            '"text":"看到图片了 [p1]"}}'
        )
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    monkeypatch.setattr(
        ai_reader,
        "_cli_info",
        lambda kind: {"command": r"C:\fake\codex.exe", "version": "0.1.0", "ts": 0},
    )
    monkeypatch.setattr(ai_reader, "_codex_logged_in", lambda: True)
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_codex(
        "原问题", "", [{"mime": "image/png", "bytes": b"png-bytes", "name": "shot.png"}]
    )

    assert result["text"] == "看到图片了 [p1]"
    assert captured["files"] == ["image-1.png"]
    assert captured["bytes"] == b"png-bytes"
    assert "原问题" in captured["prompt"]
    assert "image-1.png" in captured["prompt"]
    assert "已保存在当前工作目录" in captured["prompt"]


def test_kimi_receives_images_in_temp_cwd(isolated, monkeypatch):
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        cwd = Path(kwargs["cwd"])
        captured["files"] = sorted(path.name for path in cwd.iterdir())
        captured["prompt"] = cmd[2]
        return SimpleNamespace(returncode=0, stdout="Kimi 看到了 [p1]\n", stderr="")

    monkeypatch.setattr(ai_reader, "_find_kimi", lambda: r"C:\fake\kimi.exe")
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_kimi(
        "原问题",
        "",
        [
            {"mime": "image/png", "bytes": b"a", "name": "a.png"},
            {"mime": "image/jpeg", "bytes": b"bb", "name": "b.jpg"},
        ],
    )

    assert result["text"] == "Kimi 看到了 [p1]"
    assert captured["files"] == ["image-1.png", "image-2.jpg"]
    assert "用户随问题上传了 2 张图片" in captured["prompt"]
    assert "image-1.png、image-2.jpg" in captured["prompt"]


def test_claude_receives_images_in_temp_cwd(isolated, monkeypatch):
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        cwd = Path(kwargs["cwd"])
        captured["files"] = sorted(path.name for path in cwd.iterdir())
        captured["prompt"] = cmd[2]
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"type": "result", "result": "Claude 看到了 [p1]"}),
            stderr="",
        )

    monkeypatch.setattr(ai_reader, "_find_claude", lambda: r"C:\fake\claude.exe")
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_claude(
        "原问题", "", [{"mime": "image/webp", "bytes": b"w", "name": "w.webp"}]
    )

    assert result["text"] == "Claude 看到了 [p1]"
    assert captured["files"] == ["image-1.webp"]
    assert "已保存在当前工作目录" in captured["prompt"]


# --------------------------------------------------------------------------- #
# Flask route
# --------------------------------------------------------------------------- #
ROUTE_RESULT = {
    "answer": "固定答案 [p1]",
    "citations": [{"ref": "p1", "page": 1, "section": "1 Introduction", "snippet": "片段"}],
    "provider": "codex",
    "model": "test",
    "elapsed": 0.1,
    "source": "cli",
    "usage": {"input_tokens": 1, "output_tokens": 2},
}


@pytest.fixture()
def client(tmp_path, isolated, monkeypatch, tiny_pdf):
    monkeypatch.setattr(app_module, "_allowed_roots", lambda: [tmp_path.resolve()])
    return app_module.app.test_client(), tiny_pdf


def test_route_passes_parsed_images_to_answer(client, monkeypatch):
    http, pdf = client
    captured: dict = {}

    def fake_answer(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return dict(ROUTE_RESULT)

    monkeypatch.setattr(app_module.ai_reader, "answer", fake_answer)
    response = http.post(
        "/api/reader/ask",
        json={
            "path": str(pdf),
            "question": "图里是什么？",
            "quote": {"text": "原文", "page": 1},
            "history": [{"role": "user", "content": "hi"}],
            "provider": {"id": "codex"},
            "images": [{"data_url": data_url(b"abc"), "name": "shot.png"}],
        },
    )

    assert response.status_code == 200
    assert response.get_json()["answer"] == "固定答案 [p1]"
    assert captured["args"][0] == str(pdf.resolve())
    assert captured["args"][1] == "图里是什么？"
    assert captured["args"][2] == {"text": "原文", "page": 1}
    images = captured["kwargs"]["images"]
    assert len(images) == 1
    assert images[0]["mime"] == "image/png"
    assert images[0]["bytes"] == b"abc"
    assert images[0]["name"] == "shot.png"


def test_route_without_images_keeps_five_positional_args(client, monkeypatch):
    http, pdf = client
    captured: dict = {}

    def fake_answer(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return dict(ROUTE_RESULT)

    monkeypatch.setattr(app_module.ai_reader, "answer", fake_answer)
    response = http.post(
        "/api/reader/ask", json={"path": str(pdf), "question": "普通问题"}
    )

    assert response.status_code == 200
    assert len(captured["args"]) == 5
    assert captured["kwargs"] == {}


def test_route_rejects_invalid_images(client, monkeypatch):
    http, pdf = client
    called: list[int] = []

    def fake_answer(*args, **kwargs):
        called.append(1)
        return dict(ROUTE_RESULT)

    monkeypatch.setattr(app_module.ai_reader, "answer", fake_answer)

    bad = http.post(
        "/api/reader/ask",
        json={
            "path": str(pdf),
            "question": "问题",
            "images": [{"data_url": "data:text/plain;base64,AAAA"}],
        },
    )
    assert bad.status_code == 400
    assert bad.get_json()["error"] == "图片格式不正确"

    too_many = http.post(
        "/api/reader/ask",
        json={
            "path": str(pdf),
            "question": "问题",
            "images": [{"data_url": data_url(bytes([index]))} for index in range(5)],
        },
    )
    assert too_many.status_code == 400
    assert too_many.get_json()["error"] == "最多上传 4 张图片"
    assert called == []
