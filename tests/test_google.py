from __future__ import annotations
import app
from core import providers


def test_free_provider_presets_exist():
    ids = {item["id"] for item in providers.PRESETS}
    assert {"google_free", "gemini", "openrouter_free", "ollama"} <= ids
    google = providers.get_preset("google_free")
    assert google["free"] is True
    assert google["models"] == ["google-translate"]


def test_google_source_extraction():
    llm_prompt = "## Rules\n\nNow translate the following text:\n\nHello world"
    assert app._google_source(llm_prompt) == "Hello world"
    simple_prompt = "translate\n\nInput:\n\nFoo bar"
    assert app._google_source(simple_prompt) == "Foo bar"
    assert app._google_source("nothing here") is None


def test_google_result_parser_drops_language_tag():
    assert app._google_result_text(["你好"]) == "你好"
    assert app._google_result_text([["你好", "en"]]) == "你好"
    assert app._google_result_text([["第一段", "en"], ["第二段", "en"]]) == "第一段第二段"
