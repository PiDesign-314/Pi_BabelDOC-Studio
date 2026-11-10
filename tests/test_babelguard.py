"""Offline tests for the BabelDOC Studio runtime guard.

No real BabelDOC is needed: the guard imports babeldoc modules lazily, so the
tests build a small fake module tree and drive the patched classes.

Run:
    cd E:\\01Projects\\02BabelDOC
    $env:PYTHONPATH=(Resolve-Path .lead).Path
    $env:TEMP=(Resolve-Path .lead\\run-guard).Path
    $env:TMP=$env:TEMP
    python -m pytest tests/test_babelguard.py -q -p no:cacheprovider -p nomode700
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import sys
import tempfile
import types
from pathlib import Path

import pytest

GUARD_DIR = Path(__file__).resolve().parents[1] / "core" / "babelguard"
if str(GUARD_DIR) not in sys.path:
    sys.path.insert(0, str(GUARD_DIR))

import babeldoc_guard as guard_module  # noqa: E402

PACKAGE = "babeldoc.format.pdf.document_il"
MODEL = PACKAGE + ".il_version_1"
CACHE = "babeldoc.translator.cache"
TRANSLATOR = "babeldoc.translator.translator"
IL_TRANSLATOR = PACKAGE + ".midend.il_translator"
IL_LLM_ONLY = PACKAGE + ".midend.il_translator_llm_only"
TYPESETTING = PACKAGE + ".midend.typesetting"
PDF_CREATER = PACKAGE + ".backend.pdf_creater"

ALL_MODULES = (MODEL, CACHE, TRANSLATOR, IL_TRANSLATOR, IL_LLM_ONLY, TYPESETTING, PDF_CREATER)

ENV_NAMES = (
    "BABELDOC_STUDIO_GUARD",
    "BABELDOC_STUDIO_GUARD_STATUS",
    "BABELDOC_STUDIO_GUARD_LOG",
    "BABELDOC_STUDIO_GUARD_DOC",
    "BABELDOC_STUDIO_GUARD_RETRIES",
    "BABELDOC_STUDIO_GUARD_BACKOFF",
    "BABELDOC_STUDIO_GUARD_OWNER",
)

PARAGRAPH_KEYS = {
    "page",
    "paragraph_id",
    "source_chars",
    "translated_chars",
    "status",
    "retry_count",
    "error_reason",
    "layout_status",
    "render_status",
}


# --- fixtures ---------------------------------------------------------------


@pytest.fixture
def workspace(monkeypatch):
    """Fresh guard module, clean environment and a temp directory."""
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    base = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    directory = Path(tempfile.mkdtemp(prefix="babelguard-", dir=base))
    module = importlib.reload(guard_module)
    yield module, directory
    os.environ.pop(module.OWNER_ENV, None)


def enable_guard(
    module,
    monkeypatch,
    status_path=None,
    log_path=None,
    doc="doc-1",
    retries=None,
    backoff=None,
):
    monkeypatch.setenv(module.GUARD_ENV, "1")
    monkeypatch.setenv(module.DOC_ENV, doc)
    if status_path is not None:
        monkeypatch.setenv(module.STATUS_ENV, str(status_path))
    if log_path is not None:
        monkeypatch.setenv(module.LOG_ENV, str(log_path))
    if retries is not None:
        monkeypatch.setenv(module.RETRIES_ENV, str(retries))
    if backoff is not None:
        monkeypatch.setenv(module.BACKOFF_ENV, backoff)


def read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# --- small fakes ------------------------------------------------------------


class FakeParagraph:
    def __init__(
        self,
        unicode="source paragraph",
        debug_id="pTest1",
        composition=None,
        box=None,
        pdf_style=None,
    ):
        self.unicode = unicode
        self.debug_id = debug_id
        self.pdf_paragraph_composition = list(composition or [])
        self.box = box if box is not None else types.SimpleNamespace(x=0, y=0, x2=100, y2=20)
        self.pdf_style = pdf_style


class FakePage:
    def __init__(self, page_number=1):
        self.page_number = page_number
        self.pdf_curve = []
        self.pdf_form = []


class FakeLLMTracker:
    def __init__(
        self,
        output="",
        error_message="",
        has_error=False,
        fallback_to_translate=False,
    ):
        self.output = output
        self.error_message = error_message
        self.has_error = has_error
        self.fallback_to_translate = fallback_to_translate
        self.placeholder_full_match = False


class FakeParagraphTracker:
    _MISSING = object()

    def __init__(self, output=_MISSING, llm_trackers=None):
        if output is not self._MISSING:
            self.output = output
        self.llm = list(llm_trackers or [])
        self.input = "prompt"

    def last_llm_translate_tracker(self):
        return self.llm[-1] if self.llm else None


def build_fakes(monkeypatch, module):
    """Install a minimal fake babeldoc package tree into sys.modules."""
    created = {}

    class FakePdfStyle:
        def __init__(self, font_id=None, font_size=None, graphic_state=None):
            self.font_id = font_id
            self.font_size = font_size
            self.graphic_state = graphic_state

    class FakeSameStyleUnicode:
        def __init__(self, unicode=None, pdf_style=None, debug_info=None):
            self.unicode = unicode
            self.pdf_style = pdf_style
            self.debug_info = debug_info

    class FakeComposition:
        def __init__(
            self,
            pdf_character=None,
            pdf_formula=None,
            pdf_same_style_unicode_characters=None,
            pdf_line=None,
            pdf_same_style_characters=None,
        ):
            self.pdf_character = pdf_character
            self.pdf_formula = pdf_formula
            self.pdf_same_style_unicode_characters = pdf_same_style_unicode_characters
            self.pdf_line = pdf_line
            self.pdf_same_style_characters = pdf_same_style_characters

    model_module = types.ModuleType(MODEL)
    model_module.PdfStyle = FakePdfStyle
    model_module.PdfSameStyleUnicodeCharacters = FakeSameStyleUnicode
    model_module.PdfParagraphComposition = FakeComposition
    created[MODEL] = model_module

    class FakeTranslationCache:
        def __init__(self):
            self.entries = {}
            self.get_calls = []
            self.set_calls = []

        def get(self, original_text):
            self.get_calls.append(original_text)
            return self.entries.get(original_text)

        def set(self, original_text, translation):
            self.set_calls.append((original_text, translation))
            self.entries[original_text] = translation

    cache_module = types.ModuleType(CACHE)
    cache_module.TranslationCache = FakeTranslationCache
    created[CACHE] = cache_module

    class FakeBaseTranslator:
        def __init__(self, outputs=None):
            self.outputs = list(outputs or [])
            self.calls = []

        def translate(self, text, ignore_cache=False, rate_limit_params=None):
            self.calls.append(("translate", text))
            return self.outputs.pop(0) if self.outputs else "translated text"

        def llm_translate(self, text, ignore_cache=False, rate_limit_params=None):
            self.calls.append(("llm_translate", text))
            return self.outputs.pop(0) if self.outputs else "translated text"

    translator_module = types.ModuleType(TRANSLATOR)
    translator_module.BaseTranslator = FakeBaseTranslator
    created[TRANSLATOR] = translator_module

    class FakeILTranslator:
        """Mimics ILTranslator with an engine call, like the real fallback path."""

        def __init__(self, engine=None, output="translated text"):
            self.engine = engine
            self.output = output
            self.post_calls = []
            self.translate_calls = []

        def post_translate_paragraph(
            self, paragraph, tracker, translate_input, translated_text
        ):
            self.post_calls.append((paragraph, translate_input, translated_text))
            paragraph.unicode = translated_text
            paragraph.pdf_paragraph_composition = [
                FakeComposition(pdf_character=types.SimpleNamespace())
            ]
            if tracker is not None:
                tracker.output = translated_text
            return True

        def translate_paragraph(
            self,
            paragraph,
            page,
            pbar=None,
            tracker=None,
            page_font_map=None,
            xobj_font_map=None,
            paragraph_token_count=0,
            title_paragraph=None,
            local_title_paragraph=None,
        ):
            self.translate_calls.append(paragraph)
            source = paragraph.unicode or ""
            if self.engine is not None:
                translated = self.engine.translate(source)
            else:
                translated = self.output
            self.post_translate_paragraph(
                paragraph,
                tracker,
                types.SimpleNamespace(unicode=source),
                translated,
            )
            return None

    il_translator_module = types.ModuleType(IL_TRANSLATOR)
    il_translator_module.ILTranslator = FakeILTranslator
    created[IL_TRANSLATOR] = il_translator_module

    class FakeBatchParagraph:
        def __init__(self, paragraphs, pages, trackers):
            self.paragraphs = list(paragraphs)
            self.pages = list(pages)
            self.trackers = list(trackers)

    class FakeILTranslatorLLMOnly:
        def __init__(self, error=None):
            self.error = error
            self.calls = []

        def translate_paragraph(self, batch_paragraph, **kwargs):
            self.calls.append(batch_paragraph)
            if self.error:
                raise RuntimeError(self.error)
            return None

    llm_only_module = types.ModuleType(IL_LLM_ONLY)
    llm_only_module.ILTranslatorLLMOnly = FakeILTranslatorLLMOnly
    llm_only_module.BatchParagraph = FakeBatchParagraph
    created[IL_LLM_ONLY] = llm_only_module

    class FakeRenderedChar:
        def __init__(self, text):
            self.char_unicode = text

    class FakeTypesettingUnit:
        def __init__(self, text):
            self.text = text

        def render(self):
            return ([FakeRenderedChar(self.text)], [], [])

    class FakeTypesetting:
        def __init__(self, cjk=False, make_units=True, renders=False):
            self.is_cjk = cjk
            self.make_units = make_units
            self.renders = renders
            self.render_calls = []

        def create_typesetting_units(self, paragraph, fonts):
            if not self.make_units:
                return []
            units = []
            for composition in paragraph.pdf_paragraph_composition or []:
                if getattr(composition, "pdf_character", None) is not None:
                    return [FakeTypesettingUnit("x")]
                same = getattr(composition, "pdf_same_style_unicode_characters", None)
                if same is not None and getattr(same, "unicode", None):
                    units.extend(FakeTypesettingUnit(char) for char in same.unicode)
            return units

        def _layout_typesetting_units(
            self,
            units,
            box,
            scale,
            line_skip,
            paragraph,
            use_english_line_break=True,
        ):
            return (list(units), True)

        def render_paragraph(self, paragraph, page, fonts):
            self.render_calls.append(paragraph)
            if self.renders:
                paragraph.pdf_paragraph_composition = [
                    FakeComposition(pdf_character=types.SimpleNamespace())
                ]
            else:
                # Simulate the bug: typesetting produced no renderable composition.
                paragraph.pdf_paragraph_composition = []
            return None

    typesetting_module = types.ModuleType(TYPESETTING)
    typesetting_module.Typesetting = FakeTypesetting
    created[TYPESETTING] = typesetting_module

    class FakePDFCreater:
        def __init__(self):
            self.calls = []

        def render_paragraph_to_char(self, paragraph):
            self.calls.append(paragraph)
            return []

    pdf_creater_module = types.ModuleType(PDF_CREATER)
    pdf_creater_module.PDFCreater = FakePDFCreater
    created[PDF_CREATER] = pdf_creater_module

    for name, fake in created.items():
        monkeypatch.setitem(sys.modules, name, fake)
    return types.SimpleNamespace(
        model=model_module,
        cache=cache_module,
        translator=translator_module,
        il_translator=il_translator_module,
        llm_only=llm_only_module,
        typesetting=typesetting_module,
        pdf_creater=pdf_creater_module,
    )


def load_sitecustomize():
    path = GUARD_DIR / "sitecustomize.py"
    spec = importlib.util.spec_from_file_location(
        "babelguard_sitecustomize_under_test", path
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- pure policy helpers ----------------------------------------------------


def test_is_empty_translation():
    assert guard_module.is_empty_translation(None) is True
    assert guard_module.is_empty_translation("") is True
    assert guard_module.is_empty_translation("   ") is True
    assert guard_module.is_empty_translation("\n\t\r") is True
    assert guard_module.is_empty_translation(b"") is True  # non-str is never valid
    assert guard_module.is_empty_translation("translated") is False
    assert guard_module.is_empty_translation(" x ") is False


def test_text_length():
    assert guard_module.text_length(None) == 0
    assert guard_module.text_length("") == 0
    assert guard_module.text_length("  abc  ") == 3
    assert guard_module.text_length(object()) == 0


def test_parse_backoff():
    assert guard_module.parse_backoff(None) == [1.0, 3.0]
    assert guard_module.parse_backoff("") == [1.0, 3.0]
    assert guard_module.parse_backoff("1,3") == [1.0, 3.0]
    assert guard_module.parse_backoff(" 0.5 , 0 , -2 ") == [0.5, 0.0, 0.0]
    assert guard_module.parse_backoff("abc") == []
    assert guard_module.parse_backoff("0.1,junk,2") == [0.1, 2.0]
    assert guard_module.parse_backoff([2, -1, "x"]) == [2.0, 0.0]


def test_plan_retries():
    assert guard_module.plan_retries(0, 2, [1, 3]) == 1
    assert guard_module.plan_retries(1, 2, [1, 3]) == 3
    assert guard_module.plan_retries(2, 2, [1, 3]) is None
    assert guard_module.plan_retries(0, 0, [1, 3]) is None
    # The last value repeats when more retries than backoff entries are used.
    assert guard_module.plan_retries(3, 5, [0.5]) == 0.5
    # An explicitly empty backoff means "retry without sleeping".
    assert guard_module.plan_retries(0, 2, []) == 0.0
    # Defaults apply when not given.
    assert guard_module.plan_retries(2) is None


def test_make_retry_wrapper_retries_until_success():
    results = ["", "  ", "done"]
    calls = []
    sleeps = []

    def call():
        calls.append(1)
        return results.pop(0)

    def sleep(seconds):
        sleeps.append(seconds)

    wrapper = guard_module.make_retry_wrapper(
        call, sleep=sleep, retries=2, backoff=[1, 3]
    )
    assert wrapper() == "done"
    assert len(calls) == 3
    assert sleeps == [1, 3]


def test_make_retry_wrapper_returns_last_empty_result():
    calls = []
    sleeps = []

    def call():
        calls.append(1)
        return ""

    wrapper = guard_module.make_retry_wrapper(
        call, sleep=sleeps.append, retries=2, backoff="0,0"
    )
    assert wrapper() == ""
    assert len(calls) == 3
    assert sleeps == [0.0, 0.0]


def test_make_retry_wrapper_zero_retries_calls_once():
    calls = []

    def call():
        calls.append(1)
        return ""

    wrapper = guard_module.make_retry_wrapper(call, sleep=lambda _s: None, retries=0)
    assert wrapper() == ""
    assert len(calls) == 1


def test_make_retry_wrapper_custom_should_retry():
    calls = []

    def call():
        calls.append(1)
        return "ok"

    wrapper = guard_module.make_retry_wrapper(
        call,
        sleep=lambda _s: None,
        retries=1,
        backoff=[0],
        should_retry=lambda value: value != "ok",
    )
    assert wrapper() == "ok"
    assert len(calls) == 1


# --- status store -----------------------------------------------------------


def test_status_record_shape_and_counts(workspace):
    module, _tmp = workspace
    status = module.GuardStatus(doc="stein")
    status.record(
        page=2,
        paragraph_id="pLf4x",
        source_text="Considering the social quality",
        translated_text="",
        status="EMPTY",
        retry_count=2,
        error_reason="empty_translation_kept_original",
        layout_status="kept_original",
    )
    data = status.to_dict()
    assert set(data) == {
        "schema",
        "guard",
        "doc",
        "started",
        "finished",
        "paragraphs",
        "counts",
        "errors",
    }
    assert data["schema"] == 1
    assert data["guard"] == "babeldoc-studio"
    assert data["doc"] == "stein"
    assert isinstance(data["started"], float)
    assert isinstance(data["finished"], float)
    assert len(data["paragraphs"]) == 1
    record = data["paragraphs"][0]
    assert set(record) == PARAGRAPH_KEYS
    assert record["page"] == 2
    assert record["paragraph_id"] == "pLf4x"
    assert record["source_chars"] == len("Considering the social quality")
    assert record["translated_chars"] == 0
    assert record["status"] == "EMPTY"
    assert record["retry_count"] == 2
    assert record["error_reason"] == "empty_translation_kept_original"
    assert data["counts"] == {
        "paragraphs": 1,
        "translated": 0,
        "empty": 0,  # kept-original is not a genuinely empty paragraph
        "render_failed": 0,
        "retried": 1,
        "kept_original": 1,
    }
    assert data["errors"] == []


def test_status_dedup_and_supersede(workspace):
    module, _tmp = workspace
    status = module.GuardStatus(doc="doc")
    status.record(
        page=2,
        paragraph_id="pA",
        source_text="source text here",
        translated_text="",
        status="EMPTY",
        retry_count=2,
        error_reason="empty_translation_kept_original",
        layout_status="kept_original",
    )
    status.record(
        page=2,
        paragraph_id="pA",
        translated_text="translated text here",
        status="RENDERED",
        render_status="rendered",
    )
    data = status.to_dict()
    assert len(data["paragraphs"]) == 1
    record = data["paragraphs"][0]
    assert record["status"] == "RENDERED"
    assert record["translated_chars"] == len("translated text here")
    # Original source length, retry count and the error reason survive.
    assert record["source_chars"] == len("source text here")
    assert record["retry_count"] == 2
    assert record["error_reason"] == "empty_translation_kept_original"
    assert record["render_status"] == "rendered"
    # "kept_original" survives a later RENDERED supersede so QA can still tell
    # that this paragraph shows the source text instead of a translation.
    assert record["layout_status"] == "kept_original"
    assert data["counts"]["empty"] == 0
    assert data["counts"]["translated"] == 0  # NOT translated, despite RENDERED
    assert data["counts"]["retried"] == 1
    assert data["counts"]["kept_original"] == 1


def test_status_counts_separate_kept_original_from_translated(workspace):
    module, _tmp = workspace
    status = module.GuardStatus(doc="doc")
    # A normally translated paragraph that rendered fine.
    status.record(
        page=2,
        paragraph_id="pGood",
        source_text="source",
        translated_text="translated text",
        status="TRANSLATED",
    )
    status.record(
        page=2,
        paragraph_id="pGood",
        status="RENDERED",
        render_status="rendered",
    )
    # A paragraph whose empty reply was replaced by the source text.
    status.record(
        page=2,
        paragraph_id="pKept",
        source_text="original source",
        translated_text="",
        status="EMPTY",
        retry_count=2,
        error_reason="empty_translation_kept_original",
        layout_status="kept_original",
    )
    status.record(
        page=2,
        paragraph_id="pKept",
        translated_text="original source",
        status="RENDERED",
        render_status="rendered",
    )
    data = status.to_dict()
    counts = data["counts"]
    assert counts["paragraphs"] == 2
    assert counts["translated"] == 1  # kept-original must NOT count as translated
    assert counts["empty"] == 0
    assert counts["kept_original"] == 1
    assert counts["retried"] == 1
    records = {item["paragraph_id"]: item for item in data["paragraphs"]}
    assert module.is_kept_original_record(records["pKept"]) is True
    assert module.is_kept_original_record(records["pGood"]) is False
    # The kept-original record keeps its marker and the rendered character count
    # is deliberately not translated_chars in any downstream calculation.
    assert records["pKept"]["status"] == "RENDERED"
    assert records["pKept"]["layout_status"] == "kept_original"
    assert records["pKept"]["error_reason"] == "empty_translation_kept_original"


def test_status_dedup_keeps_unknown_page_then_fills_it(workspace):
    module, _tmp = workspace
    status = module.GuardStatus(doc="doc")
    status.record(paragraph_id="pB", source_text="abc", status="EMPTY")
    status.record(page=7, paragraph_id="pB", translated_text="xyz", status="RENDERED")
    data = status.to_dict()
    assert len(data["paragraphs"]) == 1
    assert data["paragraphs"][0]["page"] == 7


def test_status_merge_error_does_not_change_status(workspace):
    module, _tmp = workspace
    status = module.GuardStatus(doc="doc")
    status.record(
        page=3, paragraph_id="pC", source_text="abc", status="TRANSLATED",
        translated_text="xyz",
    )
    status.merge_error(3, "pC", None, "json protocol failed")
    record = status.to_dict()["paragraphs"][0]
    assert record["status"] == "TRANSLATED"
    assert record["error_reason"] == "json protocol failed"
    # Unknown paragraph: a FAILED placeholder is created.
    status.merge_error(4, "pD", "def", "batch exception")
    records = {item["paragraph_id"]: item for item in status.to_dict()["paragraphs"]}
    assert records["pD"]["status"] == "FAILED"
    assert records["pD"]["error_reason"] == "batch exception"


def test_status_write_json(workspace):
    module, tmp = workspace
    status = module.GuardStatus(doc="d", status_path=str(tmp / "status.json"))
    status.record(
        page=2,
        paragraph_id="pE",
        source_text="hello",
        translated_text="world",
        status="TRANSLATED",
    )
    assert status.write() is True
    target = tmp / "status.json"
    assert target.is_file()
    assert not (tmp / "status.json.tmp").exists()
    data = json.loads(target.read_text(encoding="utf-8"))
    assert data["doc"] == "d"
    assert data["paragraphs"][0]["status"] == "TRANSLATED"
    # Writing twice (atexit after a mid-run flush) is fine.
    assert status.write() is True
    assert json.loads(target.read_text(encoding="utf-8"))["schema"] == 1


def test_status_page_for(workspace):
    module, _tmp = workspace
    status = module.GuardStatus()
    status.record(page=5, paragraph_id="pF", source_text="abc", status="RENDERED")
    assert status.page_for("pF") == 5
    assert status.page_for("unknown") == 0
    assert status.write() is False  # no status path configured


# --- configuration ---------------------------------------------------------


def test_read_config_defaults(workspace):
    module, _tmp = workspace
    config = module.read_config({})
    assert config.enabled is False
    assert config.status_path == ""
    assert config.log_path == ""
    assert config.doc == ""
    assert config.retries == 2
    assert config.backoff == [1.0, 3.0]


def test_read_config_from_env(workspace):
    module, _tmp = workspace
    config = module.read_config(
        {
            module.GUARD_ENV: "true",
            module.STATUS_ENV: " C:\\tmp\\status.json ",
            module.LOG_ENV: "C:\\tmp\\events.jsonl",
            module.DOC_ENV: "stein",
            module.RETRIES_ENV: "3",
            module.BACKOFF_ENV: "0.5, -1, 2",
        }
    )
    assert config.enabled is True
    assert config.status_path == "C:\\tmp\\status.json"
    assert config.log_path == "C:\\tmp\\events.jsonl"
    assert config.doc == "stein"
    assert config.retries == 3
    assert config.backoff == [0.5, 0.0, 2.0]
    # Invalid retry values fall back to the default instead of raising.
    assert module.read_config({module.RETRIES_ENV: "many"}).retries == 2
    assert module.read_config({module.RETRIES_ENV: "-4"}).retries == 0


# --- installation / activation ----------------------------------------------


def test_install_noop_without_env(workspace, monkeypatch):
    module, _tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    monkeypatch.delenv(module.GUARD_ENV, raising=False)
    assert module.install() is False
    cache = fakes.cache.TranslationCache()
    cache.entries[""] = " "
    assert cache.get("") == " "  # not patched
    assert module.status_snapshot() is None


def test_sitecustomize_noop_without_env(workspace, monkeypatch):
    module, _tmp = workspace
    calls = []
    monkeypatch.setattr(module, "install", lambda *a, **k: calls.append(1) or True)
    monkeypatch.delenv(module.GUARD_ENV, raising=False)
    load_sitecustomize()
    assert calls == []


def test_sitecustomize_installs_when_enabled(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    load_sitecustomize()
    cache = fakes.cache.TranslationCache()
    cache.entries["poison"] = "   "
    assert cache.get("poison") is None  # empty cache entry now a miss
    assert module.flush_status() is True
    assert (tmp / "status.json").is_file()


def test_install_patches_cache(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json", log_path=tmp / "events.jsonl")
    assert module.install() is True
    cache = fakes.cache.TranslationCache()
    cache.entries[""] = ""
    cache.entries["blank"] = "  \n "
    cache.entries["good"] = "translated"
    assert cache.get("") is None
    assert cache.get("blank") is None
    assert cache.get("good") == "translated"
    cache.set("source", "")
    cache.set("source2", " ok ")
    assert cache.set_calls == [("source2", " ok ")]
    events = read_jsonl(tmp / "events.jsonl")
    assert any(item["event"] == "cache_empty_miss" for item in events)
    assert any(item["event"] == "cache_empty_set_skipped" for item in events)


def test_install_is_idempotent(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    assert module.install() is True
    cache = fakes.cache.TranslationCache()
    cache.entries[""] = ""
    assert cache.get("") is None


def test_install_without_babeldoc_is_safe(workspace, monkeypatch):
    module, tmp = workspace
    for name in ALL_MODULES:
        monkeypatch.setitem(sys.modules, name, None)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is False  # nothing could be patched
    snapshot = module.status_snapshot()
    assert snapshot is not None
    assert snapshot["paragraphs"] == []
    assert snapshot["errors"]
    assert module.flush_status() is True
    data = json.loads((tmp / "status.json").read_text(encoding="utf-8"))
    assert data["counts"]["paragraphs"] == 0
    assert data["errors"]


def test_install_skips_non_owner_process(workspace, monkeypatch):
    """BabelDOC's child processes inherit the env but must stay untouched.

    A child (e.g. multiprocessing font subsetting) inherits ``OWNER=parent pid``
    with ``BABELDOC_STUDIO_GUARD=1`` and its own different pid.  install() must
    then do nothing at all: no duplicate patches (no double retries), no atexit
    writer (no status clobbering), and it must return immediately (no hang).
    """
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    monkeypatch.setenv(module.OWNER_ENV, "999999")
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is False
    assert module.status_snapshot() is None
    # No patch was applied in this process: an empty cache value is still
    # returned verbatim instead of being treated as a miss.
    cache = fakes.cache.TranslationCache()
    cache.entries[""] = ""
    assert cache.get("") == ""
    # No atexit writer was registered: flushing does nothing and no file appears.
    assert module.flush_status() is False
    assert not (tmp / "status.json").exists()


def test_install_runs_in_owner_process(workspace, monkeypatch):
    """A process whose OWNER env matches its own pid does install the guard."""
    module, tmp = workspace
    build_fakes(monkeypatch, module)
    monkeypatch.setenv(module.OWNER_ENV, str(os.getpid()))
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    assert module.status_snapshot() is not None


# --- translator retry patch -------------------------------------------------


def test_translator_retries_empty_results(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module,
        monkeypatch,
        status_path=tmp / "status.json",
        log_path=tmp / "events.jsonl",
        retries=2,
        backoff="0,0",
    )
    assert module.install() is True
    engine = fakes.translator.BaseTranslator(outputs=["", "  ", "ok"])
    assert engine.translate("hello") == "ok"
    assert [call[0] for call in engine.calls] == ["translate"] * 3
    engine = fakes.translator.BaseTranslator(outputs=["", "ok"])
    assert engine.llm_translate("hello") == "ok"
    assert [call[0] for call in engine.calls] == ["llm_translate"] * 2
    events = read_jsonl(tmp / "events.jsonl")
    retries = [item for item in events if item["event"] == "retry"]
    assert len(retries) == 3
    assert retries[0]["attempt"] == 1
    assert retries[-1]["function"] == "llm_translate"


def test_translator_returns_last_empty_after_retries(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module,
        monkeypatch,
        status_path=tmp / "status.json",
        log_path=tmp / "events.jsonl",
        retries=2,
        backoff="0,0",
    )
    assert module.install() is True
    engine = fakes.translator.BaseTranslator(outputs=["", "", ""])
    assert engine.llm_translate("hello") == ""
    assert len(engine.calls) == 3
    events = read_jsonl(tmp / "events.jsonl")
    assert any(item["event"] == "empty_after_retries" for item in events)


# --- post_translate_paragraph patch ----------------------------------------


def test_post_translate_keeps_original_on_empty_translation(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module,
        monkeypatch,
        status_path=tmp / "status.json",
        log_path=tmp / "events.jsonl",
        doc="stein",
    )
    assert module.install() is True
    translator = fakes.il_translator.ILTranslator()
    paragraph = FakeParagraph(unicode="original source")
    tracker = FakeParagraphTracker()
    translate_input = types.SimpleNamespace(unicode="original source")

    result = translator.post_translate_paragraph(
        paragraph, tracker, translate_input, ""
    )
    assert result is False
    assert translator.post_calls == []  # the blanking original was NOT called
    assert paragraph.unicode == "original source"
    snapshot = module.status_snapshot()
    record = snapshot["paragraphs"][0]
    assert record["status"] == "EMPTY"
    assert record["paragraph_id"] == "pTest1"
    assert record["source_chars"] == len("original source")
    assert record["translated_chars"] == 0
    assert record["layout_status"] == "kept_original"
    assert "empty_translation_kept_original" in record["error_reason"]
    events = read_jsonl(tmp / "events.jsonl")
    assert any(item["event"] == "empty_kept_original" for item in events)


def test_post_translate_calls_original_for_real_translation(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    translator = fakes.il_translator.ILTranslator()
    paragraph = FakeParagraph(unicode="original source")
    tracker = FakeParagraphTracker()
    translate_input = types.SimpleNamespace(unicode="original source")
    assert (
        translator.post_translate_paragraph(paragraph, tracker, translate_input, "new text")
        is True
    )
    assert len(translator.post_calls) == 1
    assert paragraph.unicode == "new text"


def test_post_translate_calls_original_when_source_empty(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    translator = fakes.il_translator.ILTranslator()
    paragraph = FakeParagraph(unicode="")
    tracker = FakeParagraphTracker()
    translate_input = types.SimpleNamespace(unicode="")
    assert (
        translator.post_translate_paragraph(paragraph, tracker, translate_input, "")
        is True
    )
    assert len(translator.post_calls) == 1


# --- translate_paragraph bookkeeping ---------------------------------------


def test_translate_paragraph_records_translated_status(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json", doc="stein")
    assert module.install() is True
    engine = fakes.translator.BaseTranslator(outputs=["translated text"])
    translator = fakes.il_translator.ILTranslator(engine=engine)
    paragraph = FakeParagraph(unicode="source paragraph", debug_id="pLf4x")
    page = FakePage(page_number=1)  # BabelDOC is 0-based -> page 2
    tracker = FakeParagraphTracker()
    translator.translate_paragraph(paragraph, page, tracker=tracker)
    snapshot = module.status_snapshot()
    record = snapshot["paragraphs"][0]
    assert record["page"] == 2
    assert record["paragraph_id"] == "pLf4x"
    assert record["status"] == "TRANSLATED"
    assert record["source_chars"] == len("source paragraph")
    assert record["translated_chars"] == len("translated text")


def test_translate_paragraph_counts_retries_per_paragraph(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module,
        monkeypatch,
        status_path=tmp / "status.json",
        retries=2,
        backoff="0,0",
    )
    assert module.install() is True
    engine = fakes.translator.BaseTranslator(outputs=["", "", "translated"])
    translator = fakes.il_translator.ILTranslator(engine=engine)
    paragraph = FakeParagraph(unicode="source", debug_id="pRetry")
    page = FakePage(page_number=0)
    translator.translate_paragraph(paragraph, page, tracker=FakeParagraphTracker())
    record = module.status_snapshot()["paragraphs"][0]
    assert record["status"] == "TRANSLATED"
    assert record["retry_count"] == 2
    assert record["translated_chars"] == len("translated")


def test_translate_paragraph_records_empty_kept_original(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module,
        monkeypatch,
        status_path=tmp / "status.json",
        retries=0,
        backoff="0,0",
    )
    assert module.install() is True
    engine = fakes.translator.BaseTranslator(outputs=[""])
    translator = fakes.il_translator.ILTranslator(engine=engine)
    paragraph = FakeParagraph(unicode="original text", debug_id="pEmpty")
    translator.translate_paragraph(paragraph, FakePage(1), tracker=FakeParagraphTracker())
    assert paragraph.unicode == "original text"
    record = module.status_snapshot()["paragraphs"][0]
    assert record["status"] == "EMPTY"
    assert record["page"] == 2
    assert record["retry_count"] == 0


def test_translate_paragraph_skips_unattempted_paragraphs(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    translator = fakes.il_translator.ILTranslator()
    # No ``input`` attribute: pre_translate_paragraph never handed it to the LLM.
    tracker = types.SimpleNamespace(pdf_unicode="x")
    translator.translate_paragraph(
        FakeParagraph(unicode="x", debug_id="pSkip"), FakePage(0), tracker=tracker
    )
    assert module.status_snapshot()["paragraphs"] == []


# --- ILTranslatorLLMOnly batch bookkeeping ---------------------------------


def test_llm_only_records_fallback_events(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json", log_path=tmp / "events.jsonl")
    assert module.install() is True
    ok_paragraph = FakeParagraph(unicode="ok source", debug_id="pOk")
    bad_paragraph = FakeParagraph(unicode="bad source", debug_id="pBad")
    ok_tracker = FakeParagraphTracker(
        llm_trackers=[FakeLLMTracker(output="ok translated")]
    )
    bad_tracker = FakeParagraphTracker(
        llm_trackers=[
            FakeLLMTracker(
                output="",
                error_message="Error Expecting value: line 1 column 1",
                has_error=True,
                fallback_to_translate=True,
            )
        ]
    )
    batch = fakes.llm_only.BatchParagraph(
        [ok_paragraph, bad_paragraph],
        [FakePage(1), FakePage(1)],
        [ok_tracker, bad_tracker],
    )
    llm_only = fakes.llm_only.ILTranslatorLLMOnly()
    llm_only.translate_paragraph(batch)
    records = {item["paragraph_id"]: item for item in module.status_snapshot()["paragraphs"]}
    assert "pOk" not in records
    assert records["pBad"]["status"] == "FAILED"
    assert "Expecting value" in records["pBad"]["error_reason"]
    events = read_jsonl(tmp / "events.jsonl")
    fallbacks = [item for item in events if item["event"] == "fallback"]
    assert len(fallbacks) == 1
    assert fallbacks[0]["paragraph_id"] == "pBad"


def test_llm_only_records_batch_exception(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    paragraph = FakeParagraph(unicode="source", debug_id="pBoom")
    batch = fakes.llm_only.BatchParagraph(
        [paragraph], [FakePage(2)], [FakeParagraphTracker()]
    )
    llm_only = fakes.llm_only.ILTranslatorLLMOnly(error="protocol broken")
    with pytest.raises(RuntimeError):
        llm_only.translate_paragraph(batch)
    record = module.status_snapshot()["paragraphs"][0]
    assert record["status"] == "FAILED"
    assert "protocol broken" in record["error_reason"]
    assert record["page"] == 3


# --- typesetting recovery ---------------------------------------------------


def test_typesetting_recovers_blank_paragraph(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json", log_path=tmp / "events.jsonl")
    assert module.install() is True
    typesetting = fakes.typesetting.Typesetting()
    style = fakes.model.PdfStyle(font_id="base", font_size=10)
    paragraph = FakeParagraph(
        unicode="translated text", debug_id="pBlank", pdf_style=style
    )
    typesetting.render_paragraph(paragraph, FakePage(4), {"base": object()})
    assert paragraph.pdf_paragraph_composition  # text objects were restored
    assert any(
        composition.pdf_character is not None
        for composition in paragraph.pdf_paragraph_composition
    )
    record = module.status_snapshot()["paragraphs"][0]
    assert record["status"] == "FORCED"
    assert record["layout_status"] == "forced_min_scale"
    assert record["page"] == 5
    events = read_jsonl(tmp / "events.jsonl")
    assert any(item["event"] == "render_failed" for item in events)
    assert any(item["event"] == "forced" for item in events)


def test_typesetting_kept_original_composition_last_resort(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    typesetting = fakes.typesetting.Typesetting(make_units=False)
    style = fakes.model.PdfStyle(font_id="base", font_size=10)
    paragraph = FakeParagraph(unicode="text", debug_id="pKeep", pdf_style=style)
    typesetting.render_paragraph(paragraph, FakePage(0), {"base": object()})
    compositions = paragraph.pdf_paragraph_composition
    assert len(compositions) == 1
    same = compositions[0].pdf_same_style_unicode_characters
    assert same is not None and same.unicode == "text"
    record = module.status_snapshot()["paragraphs"][0]
    assert record["status"] == "FORCED"
    assert record["layout_status"] == "kept_original_composition"


def test_typesetting_skips_empty_unicode(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    typesetting = fakes.typesetting.Typesetting()
    paragraph = FakeParagraph(unicode="", debug_id="pNothing")
    typesetting.render_paragraph(paragraph, FakePage(0), {})
    # No record is created for an empty paragraph; an earlier EMPTY record,
    # if any, must not be overwritten.
    assert module.status_snapshot()["paragraphs"] == []


def test_typesetting_records_rendered_status(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    # Seed the translate-phase EMPTY record for the same paragraph.
    module._GUARD.status.record(
        page=1,
        paragraph_id="pHealthy",
        source_text="source",
        translated_text="",
        status="EMPTY",
        retry_count=2,
        error_reason="empty_translation_kept_original",
        layout_status="kept_original",
    )
    typesetting = fakes.typesetting.Typesetting(renders=True)
    paragraph = FakeParagraph(unicode="translated", debug_id="pHealthy")
    typesetting.render_paragraph(paragraph, FakePage(0), {})
    snapshot = module.status_snapshot()
    record = snapshot["paragraphs"][0]
    assert record["status"] == "RENDERED"
    assert record["render_status"] == "rendered"
    # The kept-original marker and retry count survive the supersede.
    assert record["layout_status"] == "kept_original"
    assert record["retry_count"] == 2
    assert record["source_chars"] == len("source")
    assert snapshot["counts"]["empty"] == 0
    assert snapshot["counts"]["translated"] == 0
    assert snapshot["counts"]["kept_original"] == 1


# --- pdf_creater safety net -------------------------------------------------


def test_pdf_creater_records_render_failed(workspace, monkeypatch):
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    # Seed the page for this paragraph, as typesetting would have done.
    module._GUARD.status.record(
        page=6, paragraph_id="pLost", source_text="abc", status="RENDERED"
    )
    creater = fakes.pdf_creater.PDFCreater()
    paragraph = FakeParagraph(unicode="unrendered text", debug_id="pLost")
    assert creater.render_paragraph_to_char(paragraph) == []  # behaviour unchanged
    record = module.status_snapshot()["paragraphs"][0]
    assert record["page"] == 6
    assert record["status"] == "RENDER_FAILED"
    assert record["render_status"] == "pdf_no_characters"


# --- BabelDOC --debug bookkeeping paragraphs (no debug_id) ------------------


def test_debug_label_paragraphs_are_never_recorded(workspace, monkeypatch):
    """BabelDOC's debug-only label paragraphs must not pollute the status file."""
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(
        module, monkeypatch, status_path=tmp / "status.json", log_path=tmp / "events.jsonl"
    )
    assert module.install() is True

    # 1) Typesetting: no record, no recovery attempt.
    typesetting = fakes.typesetting.Typesetting(make_units=False)
    label = FakeParagraph(unicode="pagenumber: 1", debug_id=None)
    typesetting.render_paragraph(label, FakePage(0), {})
    assert label.pdf_paragraph_composition == []  # original result, not repaired
    assert module.status_snapshot()["paragraphs"] == []
    assert module.status_snapshot()["counts"]["paragraphs"] == 0

    # 2) PDF writer safety net: no record.
    creater = fakes.pdf_creater.PDFCreater()
    assert creater.render_paragraph_to_char(label) == []
    assert module.status_snapshot()["paragraphs"] == []

    # 3) Translation wrappers: original behaviour, no record.
    translator = fakes.il_translator.ILTranslator()
    tracker = types.SimpleNamespace(pdf_unicode="pagenumber: 1")
    translator.translate_paragraph(label, FakePage(0), tracker=tracker)
    assert module.status_snapshot()["paragraphs"] == []
    label2 = FakeParagraph(unicode="paragraph[p1]-[title]", debug_id=None)
    assert (
        translator.post_translate_paragraph(
            label2, FakeParagraphTracker(), types.SimpleNamespace(unicode="source"), ""
        )
        is True
    )
    assert len(translator.post_calls) == 2  # translate_paragraph + this call
    assert translator.post_calls[-1][2] == ""  # original was called, not the guard
    assert module.status_snapshot()["counts"]["paragraphs"] == 0

    # 4) LLM-only batch: a label member never gets a FAILED/fallback record.
    failed_tracker = FakeParagraphTracker(
        llm_trackers=[
            FakeLLMTracker(output="", has_error=True, fallback_to_translate=True)
        ]
    )
    batch = fakes.llm_only.BatchParagraph(
        [label], [FakePage(1)], [failed_tracker]
    )
    fakes.llm_only.ILTranslatorLLMOnly().translate_paragraph(batch)
    assert module.status_snapshot()["paragraphs"] == []
    events = read_jsonl(tmp / "events.jsonl")
    assert not any(item["event"] == "fallback" for item in events)


def test_real_paragraph_with_debug_id_still_records_render_failure(workspace, monkeypatch):
    """Control case: the same unpaintable paragraph WITH a debug_id is recorded."""
    module, tmp = workspace
    fakes = build_fakes(monkeypatch, module)
    enable_guard(module, monkeypatch, status_path=tmp / "status.json")
    assert module.install() is True
    typesetting = fakes.typesetting.Typesetting(make_units=False)
    paragraph = FakeParagraph(unicode="real paragraph", debug_id="pReal")
    paragraph.pdf_style = fakes.model.PdfStyle(font_id="base", font_size=10)
    typesetting.render_paragraph(paragraph, FakePage(0), {"base": object()})
    record = module.status_snapshot()["paragraphs"][0]
    assert record["paragraph_id"] == "pReal"
    assert record["status"] == "FORCED"
    assert record["layout_status"] == "kept_original_composition"
    assert module.status_snapshot()["counts"]["paragraphs"] == 1
