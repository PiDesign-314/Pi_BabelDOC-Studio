"""Tests for AI reader retrieval, providers, citations and HTTP routes.

Everything runs offline: CLI calls are stubbed with ``monkeypatch`` and the
OpenAI-compatible adapter talks to a local ``http.server`` stub.
"""

from __future__ import annotations

import http.server
import json
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

pymupdf = pytest.importorskip("pymupdf")

import app as app_module  # noqa: E402
from core import ai_reader, config  # noqa: E402

REPO = Path(__file__).resolve().parents[1]
NIPS_PDF = REPO / "papers" / "NIPS-2017-attention-is-all-you-need-Paper.pdf"

QUOTE = "We compare self-attention layers with recurrent layers on translation tasks."
BODY = (
    "The Transformer connects all positions with a constant number of "
    "sequentially executed operations, which is faster than recurrent layers. "
    "Figure 1 shows the model architecture and Table 2 reports the experiments. "
    "The results show that self-attention improves the ablation baseline."
)


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    """Temp settings + cache folder and a cold provider probe cache."""
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "SETTINGS_FILE", tmp_path / "settings.json")
    ai_reader._VERSION_CACHE.clear()
    yield tmp_path
    ai_reader._VERSION_CACHE.clear()


def _make_paper(path: Path, pages: int = 10) -> Path:
    doc = pymupdf.open()
    for index in range(pages):
        page = doc.new_page(width=612, height=792)
        parts = [f"Page {index + 1}. {BODY}"]
        if index == 2:
            parts.append(QUOTE)
        if index in (4, 5, 6):
            parts.append(
                "Table 3 reports additional experiments and the ablation study. "
                "The results are compared against the recurrent baseline."
            )
        parts.append(BODY)
        page.insert_textbox(
            pymupdf.Rect(72, 90, 540, 700),
            "\n\n".join(parts),
            fontsize=10,
            fontname="helv",
        )
    doc.save(path)
    doc.close()
    return path


# --------------------------------------------------------------------------- #
# Retrieval + prompt
# --------------------------------------------------------------------------- #
def test_build_context_selects_quote_page_and_budget(isolated):
    pdf = _make_paper(isolated / "paper.pdf")
    context = ai_reader.build_context(
        pdf,
        "How does self-attention compare with recurrent layers?",
        {"text": QUOTE, "page": 3, "section": "2 Method"},
    )

    assert context["page_count"] == 10
    assert 6 <= len(context["chunks"]) <= 10
    assert context["total_chars"] <= ai_reader.MAX_CONTEXT_CHARS
    assert 3 in {chunk["page"] for chunk in context["chunks"]}
    assert "[p3]" in context["context"]
    assert all(chunk["page"] >= 1 for chunk in context["chunks"])
    assert all(context["context"].count(f"[p{chunk['page']}]") >= 1 for chunk in context["chunks"][:3])


def test_build_context_finds_quote_without_page(isolated):
    pdf = _make_paper(isolated / "paper.pdf")
    context = ai_reader.build_context(pdf, "explain", {"text": QUOTE})
    assert 3 in {chunk["page"] for chunk in context["chunks"]}


def test_build_prompt_contains_materials_and_rules():
    context = {
        "toc": [
            {"title": "1 Introduction", "page": 1, "level": 1},
            {"title": "2 Method", "page": 3, "level": 1},
        ],
        "context": "[p1]\nSome material text.",
    }
    prompt = ai_reader.build_prompt(
        context,
        "这个结论有实验支撑吗？",
        {"text": "选中的原文", "page": 2},
        [{"role": "user", "content": "上一轮问题"}],
    )
    assert "论文目录" in prompt
    assert "1 Introduction — p1" in prompt
    assert "[pN]" in prompt
    assert "论文中没有找到直接证据" in prompt
    assert "400 字" in prompt
    assert "这个结论有实验支撑吗？" in prompt
    assert "选中的原文" in prompt
    assert "上一轮问题" in prompt
    assert "Some material text." in prompt


def test_build_context_on_nips_paper(isolated):
    if not NIPS_PDF.exists():
        pytest.skip("NIPS sample paper is missing")
    context = ai_reader.build_context(
        NIPS_PDF,
        "Why is self-attention faster than recurrent layers?",
        {"text": "self-attention layers connect all positions with a constant number of sequentially executed operations", "page": 6},
    )
    assert 6 <= len(context["chunks"]) <= 10
    assert context["total_chars"] <= ai_reader.MAX_CONTEXT_CHARS
    assert context["toc"], "expected a heuristic TOC"
    assert any("Self-Attention" in item["title"] for item in context["toc"])


# --------------------------------------------------------------------------- #
# Citations
# --------------------------------------------------------------------------- #
def test_parse_citations_dedupes_and_drops_invalid_pages():
    pages = [f"Page {index} discusses the Transformer results in detail. " * 10 for index in range(1, 13)]
    toc_items = [
        {"title": "1 Introduction", "page": 1, "level": 1},
        {"title": "2 Method", "page": 3, "level": 1},
    ]
    answer = "结论有实验支撑 [p2]，同一页再引用 [p2]，方法见 [p9]，错误页码 [p99]。"
    citations = ai_reader.parse_citations(
        answer, pages, toc_items, "实验支撑", "选中的原文"
    )

    assert [item["ref"] for item in citations] == ["p2", "p9"]
    assert [item["page"] for item in citations] == [2, 9]
    assert citations[0]["section"] == "1 Introduction"
    assert citations[1]["section"] == "2 Method"
    for item in citations:
        assert 150 <= len(item["snippet"]) <= 240


def test_parse_citations_handles_empty_text():
    assert ai_reader.parse_citations("no citations here", ["page"], [], "q") == []


# --------------------------------------------------------------------------- #
# Provider detection
# --------------------------------------------------------------------------- #
def test_detect_providers_and_version_cache(isolated, monkeypatch):
    probes: list[str] = []

    def fake_probe(command):
        probes.append(command)
        return "0.167.0" if "codex" in command else "2.1.120"

    monkeypatch.setattr(ai_reader, "_find_codex", lambda: r"C:\fake\codex.exe")
    monkeypatch.setattr(ai_reader, "_find_kimi", lambda: "")
    monkeypatch.setattr(ai_reader, "_find_claude", lambda: r"C:\fake\claude.exe")
    monkeypatch.setattr(ai_reader, "_codex_logged_in", lambda: True)
    monkeypatch.setattr(ai_reader, "_probe_version", fake_probe)

    providers = ai_reader.detect_providers()
    by_id = {provider["id"]: provider for provider in providers}
    assert set(by_id) == {"codex", "kimi", "claude"}
    assert by_id["codex"]["available"] is True
    assert by_id["codex"]["logged_in"] is True
    assert by_id["codex"]["version"] == "0.167.0"
    assert by_id["codex"]["command"].endswith("codex.exe")
    assert by_id["codex"]["hint"] == ""
    assert by_id["kimi"]["available"] is False
    assert by_id["kimi"]["hint"] == "未检测到 kimi 命令"
    assert by_id["claude"]["available"] is True
    assert by_id["claude"]["version"] == "2.1.120"

    calls_after_first = len(probes)
    ai_reader.detect_providers()
    assert len(probes) == calls_after_first, "version probes must be cached"
    assert ai_reader.default_provider(providers) == "codex"


def test_codex_not_logged_in_hint(isolated, monkeypatch):
    monkeypatch.setattr(ai_reader, "_find_codex", lambda: r"C:\fake\codex.exe")
    monkeypatch.setattr(ai_reader, "_find_kimi", lambda: "")
    monkeypatch.setattr(ai_reader, "_find_claude", lambda: "")
    monkeypatch.setattr(ai_reader, "_codex_logged_in", lambda: False)
    monkeypatch.setattr(ai_reader, "_probe_version", lambda command: "1.0.0")

    codex = ai_reader.detect_providers()[0]
    assert codex["available"] is True
    assert codex["logged_in"] is False
    assert "codex login" in codex["hint"]


# --------------------------------------------------------------------------- #
# CLI adapters (subprocess stubbed)
# --------------------------------------------------------------------------- #
def test_codex_command_and_jsonl_parsing(isolated, monkeypatch):
    captured: dict = {}
    stdout = "\n".join(
        [
            '{"type":"thread.started"}',
            '{"type":"item.completed","item":{"type":"reasoning","text":"think"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"first partial"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":"最终答案 [p2]"}}',
            '{"type":"turn.completed","usage":{"input_tokens":123,"output_tokens":45}}',
            "websocket reconnect warning on stdout (ignored)",
        ]
    )

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="websocket warning")

    monkeypatch.setattr(ai_reader, "_cli_info", lambda kind: {"command": r"C:\fake\codex.exe", "version": "0.167.0", "ts": 0})
    monkeypatch.setattr(ai_reader, "_find_codex", lambda: r"C:\fake\codex.exe")
    monkeypatch.setattr(ai_reader, "_codex_logged_in", lambda: True)
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_codex("回答这个问题", "gpt-6-sol")

    cmd = captured["cmd"]
    assert cmd[0] == r"C:\fake\codex.exe"
    assert cmd[1] == "exec"
    for flag in ("--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--json", "-o"):
        assert flag in cmd
    tmp_dir = cmd[cmd.index("-C") + 1]
    assert cmd[cmd.index("-o") + 1] == str(Path(tmp_dir) / "last.txt")
    assert cmd[cmd.index("-m") + 1] == "gpt-6-sol"
    assert cmd[-1] == "回答这个问题"
    assert captured["kwargs"]["stdin"] is ai_reader.subprocess.DEVNULL
    assert captured["kwargs"]["timeout"] == ai_reader.CLI_TIMEOUT
    assert captured["kwargs"]["cwd"] == tmp_dir
    assert result["text"] == "最终答案 [p2]"
    assert result["provider"] == "codex"
    assert result["source"] == "cli"
    assert result["usage"] == {"input_tokens": 123, "output_tokens": 45}


def test_codex_falls_back_to_last_txt(isolated, monkeypatch):
    def fake_run(cmd, **kwargs):
        last = Path(cmd[cmd.index("-o") + 1])
        last.write_text("来自 last.txt 的回答 [p4]", encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(ai_reader, "_cli_info", lambda kind: {"command": r"C:\fake\codex.exe", "version": "", "ts": 0})
    monkeypatch.setattr(ai_reader, "_codex_logged_in", lambda: True)
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_codex("prompt")
    assert result["text"] == "来自 last.txt 的回答 [p4]"


def test_kimi_command_assembly(isolated, monkeypatch):
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return SimpleNamespace(returncode=0, stdout="Kimi 答案 [p3]\n", stderr="")

    monkeypatch.setattr(ai_reader, "_find_kimi", lambda: r"C:\fake\kimi.exe")
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_kimi("问题文本", "kimi-model")
    assert captured["cmd"] == [
        r"C:\fake\kimi.exe",
        "-p",
        "问题文本",
        "-m",
        "kimi-model",
        "--output-format",
        "text",
    ]
    assert result["text"] == "Kimi 答案 [p3]"
    assert result["provider"] == "kimi"


def test_claude_json_parsing(isolated, monkeypatch):
    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "type": "result",
                    "result": "Claude 回答 [p1]",
                    "usage": {"input_tokens": 9, "output_tokens": 4},
                }
            ),
            stderr="",
        )

    monkeypatch.setattr(ai_reader, "_find_claude", lambda: r"C:\fake\claude.exe")
    monkeypatch.setattr(ai_reader.subprocess, "run", fake_run)

    result = ai_reader._run_claude("问题", "sonnet")
    assert captured["cmd"] == [
        r"C:\fake\claude.exe",
        "-p",
        "问题",
        "--output-format",
        "json",
        "-m",
        "sonnet",
    ]
    assert result["text"] == "Claude 回答 [p1]"
    assert result["usage"] == {"input_tokens": 9, "output_tokens": 4}


def test_missing_cli_gives_actionable_error(isolated, monkeypatch):
    monkeypatch.setattr(ai_reader, "_find_kimi", lambda: "")
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader._run_kimi("prompt")
    assert info.value.status == 503
    assert "Kimi" in str(info.value)


# --------------------------------------------------------------------------- #
# OpenAI-compatible API adapter (local http.server stub)
# --------------------------------------------------------------------------- #
class _StubHandler(http.server.BaseHTTPRequestHandler):
    received: dict = {}

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {}
        _StubHandler.received = {
            "path": self.path,
            "headers": dict(self.headers),
            "body": body,
        }
        if "fail-401" in json.dumps(body):
            payload = {"error": {"message": "invalid key sk-leak-secret-123456"}}
            status = 401
        else:
            payload = {
                "choices": [
                    {"message": {"role": "assistant", "content": "API 回答 [p1][p2]"}}
                ],
                "usage": {"prompt_tokens": 123, "completion_tokens": 45},
            }
            status = 200
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence the stub server
        return


@pytest.fixture()
def stub_api():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        yield f"http://127.0.0.1:{port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_api_adapter_uses_openai_compatible_endpoint(isolated, stub_api):
    result = ai_reader._run_api(
        "请回答问题",
        {"base_url": stub_api, "model": "stub-model", "api_key": "sk-test-key"},
    )
    assert result["text"] == "API 回答 [p1][p2]"
    assert result["provider"] == "api"
    assert result["source"] == "api"
    assert result["model"] == "stub-model"
    assert result["usage"] == {"input_tokens": 123, "output_tokens": 45}

    received = _StubHandler.received
    assert received["path"] == "/v1/chat/completions"
    assert received["headers"].get("Authorization") == "Bearer sk-test-key"
    assert received["body"]["model"] == "stub-model"
    assert received["body"]["messages"][0]["role"] == "user"
    assert "请回答问题" in received["body"]["messages"][0]["content"]


def test_api_adapter_works_without_api_key(isolated, stub_api):
    ai_reader._run_api(
        "prompt", {"base_url": stub_api, "model": "ollama-model", "api_key": ""}
    )
    assert "Authorization" not in _StubHandler.received["headers"]


def test_api_error_does_not_leak_key(isolated, stub_api):
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader._run_api(
            "fail-401 prompt",
            {"base_url": stub_api, "model": "stub-model", "api_key": "sk-test-key"},
        )
    message = str(info.value)
    assert info.value.status == 503
    assert "sk-test-key" not in message
    assert "sk-leak-secret" not in message
    assert "HTTP 401" in message


# --------------------------------------------------------------------------- #
# answer() orchestration
# --------------------------------------------------------------------------- #
def test_answer_returns_spec_shape(isolated, monkeypatch):
    pdf = _make_paper(isolated / "paper.pdf", pages=6)
    captured: dict = {}

    def fake_invoke(prompt, cfg):
        captured["prompt"] = prompt
        captured["cfg"] = cfg
        return {
            "text": "有实验支撑 [p2]，表格见 [p3]，重复 [p2]。",
            "provider": "codex",
            "model": "test-model",
            "source": "cli",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }

    monkeypatch.setattr(ai_reader, "_invoke", fake_invoke)
    result = ai_reader.answer(
        pdf,
        "这个结论有实验支撑吗？",
        {"text": QUOTE, "page": 3, "section": "2 Method"},
        [{"role": "user", "content": "上一轮"}],
        {"id": "codex", "model": "test-model"},
    )

    assert set(result) == {
        "answer", "citations", "provider", "model", "elapsed", "source", "usage",
    }
    assert result["provider"] == "codex"
    assert result["model"] == "test-model"
    assert result["source"] == "cli"
    assert result["elapsed"] >= 0
    assert [item["page"] for item in result["citations"]] == [2, 3]
    assert result["citations"][0]["ref"] == "p2"
    assert "这个结论有实验支撑吗？" in captured["prompt"]
    assert "[p3]" in captured["prompt"]


def test_answer_rejects_empty_question(isolated):
    pdf = _make_paper(isolated / "paper.pdf", pages=2)
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.answer(pdf, "  ")
    assert info.value.status == 400


def test_answer_missing_file(isolated):
    with pytest.raises(ai_reader.ReaderError) as info:
        ai_reader.answer(isolated / "missing.pdf", "问题")
    assert info.value.status == 404


# --------------------------------------------------------------------------- #
# Flask routes
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(tmp_path, isolated, monkeypatch):
    pdf = _make_paper(tmp_path / "route.pdf", pages=4)
    monkeypatch.setattr(app_module, "_allowed_roots", lambda: [pdf.parent.resolve()])
    return app_module.app.test_client(), pdf


def test_route_reader_toc(client):
    http, pdf = client
    response = http.get("/api/reader/toc", query_string={"path": str(pdf)})
    assert response.status_code == 200
    data = response.get_json()
    assert set(data) >= {"path", "source", "items", "count", "cached"}
    assert data["path"] == str(pdf)
    assert data["source"] in {"outline", "heuristic", "none"}
    assert data["count"] == len(data["items"])
    assert data["cached"] is False

    cached = http.get("/api/reader/toc", query_string={"path": str(pdf), "force": "0"})
    assert cached.get_json()["cached"] is True
    forced = http.get("/api/reader/toc", query_string={"path": str(pdf), "force": "1"})
    assert forced.get_json()["cached"] is False


def test_route_reader_toc_rejects_unknown_path(client):
    http, _pdf = client
    response = http.get("/api/reader/toc", query_string={"path": str(Path("C:/nope.pdf"))})
    assert response.status_code == 404
    assert response.get_json()["error"]


def test_route_reader_ask(client, monkeypatch):
    http, pdf = client
    monkeypatch.setattr(
        ai_reader,
        "answer",
        lambda *args, **kwargs: {
            "answer": "固定答案 [p1]",
            "citations": [{"ref": "p1", "page": 1, "section": "1 Introduction", "snippet": "片段"}],
            "provider": "codex",
            "model": "test",
            "elapsed": 0.2,
            "source": "cli",
            "usage": {"input_tokens": 1, "output_tokens": 2},
        },
    )
    response = http.post(
        "/api/reader/ask",
        json={
            "path": str(pdf),
            "question": "问题",
            "quote": {"text": "原文", "page": 1},
            "history": [{"role": "user", "content": "hi"}],
            "provider": {"id": "codex"},
        },
    )
    assert response.status_code == 200
    data = response.get_json()
    assert data["answer"] == "固定答案 [p1]"
    assert data["citations"][0]["ref"] == "p1"

    empty = http.post("/api/reader/ask", json={"path": str(pdf), "question": ""})
    assert empty.status_code == 400

    bad_path = http.post(
        "/api/reader/ask", json={"path": "C:/nope.pdf", "question": "问题"}
    )
    assert bad_path.status_code == 404


def test_route_reader_ask_propagates_reader_error(client, monkeypatch):
    http, pdf = client

    def boom(*args, **kwargs):
        raise ai_reader.ReaderError("Codex 未登录：在终端运行 codex login", 503)

    monkeypatch.setattr(ai_reader, "answer", boom)
    response = http.post(
        "/api/reader/ask", json={"path": str(pdf), "question": "问题"}
    )
    assert response.status_code == 503
    assert "codex login" in response.get_json()["error"]


def test_route_ai_status(client, monkeypatch):
    http, _pdf = client
    fake_providers = [
        {
            "id": "codex",
            "name": "Codex CLI",
            "available": True,
            "logged_in": True,
            "version": "0.167.0",
            "command": r"C:\fake\codex.exe",
            "hint": "",
        },
        {
            "id": "kimi",
            "name": "Kimi Code CLI",
            "available": False,
            "logged_in": False,
            "version": "",
            "command": "",
            "hint": "未检测到 kimi 命令",
        },
        {
            "id": "claude",
            "name": "Claude Code",
            "available": False,
            "logged_in": False,
            "version": "",
            "command": "",
            "hint": "未检测到 claude 命令",
        },
    ]
    monkeypatch.setattr(ai_reader, "detect_providers", lambda: fake_providers)
    monkeypatch.setattr(ai_reader, "default_provider", lambda providers=None: "codex")

    response = http.get("/api/ai/status")
    assert response.status_code == 200
    data = response.get_json()
    assert [item["id"] for item in data["providers"]] == ["codex", "kimi", "claude"]
    assert data["default"] == "codex"
    assert set(data["configured"]) == {
        "provider", "model", "base_url", "preset", "api_key_set",
    }
    assert data["configured"]["api_key_set"] is False


def test_route_ai_settings_roundtrip(client):
    http, _pdf = client

    initial = http.get("/api/ai/settings").get_json()
    assert initial == {
        "provider": "auto",
        "model": "",
        "base_url": "",
        "preset": "moonshot",
        "api_key_set": False,
    }
    assert "api_key" not in initial

    saved = http.post(
        "/api/ai/settings",
        json={
            "provider": "api",
            "model": "kimi-k2",
            "base_url": "https://api.moonshot.cn/v1",
            "preset": "moonshot",
            "api_key": "sk-secret-value",
        },
    )
    assert saved.status_code == 200
    body = saved.get_json()
    assert body["provider"] == "api"
    assert body["model"] == "kimi-k2"
    assert body["api_key_set"] is True
    assert "api_key" not in body
    assert "sk-secret-value" not in json.dumps(body)

    raw = config.load_raw()
    assert raw["ai"]["api_key_enc"]
    assert "sk-secret-value" not in json.dumps(raw)

    # empty string keeps the stored key
    http.post("/api/ai/settings", json={"api_key": ""})
    assert config.public_ai_settings()["api_key_set"] is True

    # null clears it
    cleared = http.post("/api/ai/settings", json={"api_key": None})
    assert cleared.get_json()["api_key_set"] is False
    assert config.ai_api_key() == ""


def test_main_settings_save_keeps_ai_fields(client):
    http, _pdf = client
    http.post(
        "/api/ai/settings",
        json={"provider": "api", "model": "kimi-k2", "api_key": "sk-secret-value"},
    )
    config.save_public({"lang_in": "en", "lang_out": "zh", "providers": {}})
    raw = config.load_raw()
    assert raw["ai"]["provider"] == "api"
    assert raw["ai"]["model"] == "kimi-k2"
    assert raw["ai"]["api_key_enc"]

    public = config.public_settings()
    assert "api_key_enc" not in public["ai"]
    assert public["ai"]["api_key_set"] is True


def test_saved_api_model_is_not_forwarded_to_cli(isolated, monkeypatch):
    config.save_ai_settings(
        {
            "provider": "auto",
            "model": "moonshot-saved-model",
            "base_url": "https://api.moonshot.cn/v1",
            "api_key": "",
        }
    )
    captured: dict = {}

    def fake_codex(prompt, model):
        captured["model"] = model
        return {
            "text": "ok [p1]",
            "provider": "codex",
            "model": model or "default",
            "source": "cli",
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }

    monkeypatch.setattr(ai_reader, "_resolve_auto", lambda: "codex")
    monkeypatch.setattr(ai_reader, "_run_codex", fake_codex)
    ai_reader._invoke("prompt", ai_reader._normalize_provider(None))
    assert captured["model"] == ""

    def fake_api(prompt, cfg):
        captured["api_model"] = cfg["model"]
        return {
            "text": "ok [p1]",
            "provider": "api",
            "model": cfg["model"],
            "source": "api",
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }

    monkeypatch.setattr(ai_reader, "_run_api", fake_api)
    ai_reader._invoke("prompt", ai_reader._normalize_provider({"id": "api"}))
    assert captured["api_model"] == "moonshot-saved-model"


# --------------------------------------------------------------------------- #
# Live smoke test (opt-in, skipped by default)
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(
    not NIPS_PDF.exists(), reason="NIPS sample paper is missing"
)
def test_codex_live_smoke(isolated):
    """Optional: only runs with BABELDOC_LIVE_AI=1 (spends real quota)."""
    import os

    if os.environ.get("BABELDOC_LIVE_AI") != "1":
        pytest.skip("set BABELDOC_LIVE_AI=1 to run the real Codex smoke test")
    result = ai_reader.answer(
        NIPS_PDF,
        "这篇论文的核心贡献是什么？请一句话回答。",
        None,
        [],
        {"id": "codex"},
    )
    assert result["provider"] == "codex"
    assert result["answer"].strip()
