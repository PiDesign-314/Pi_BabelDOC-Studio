"""End-to-end regression tests for blank / missing translations.

These tests run the **real** BabelDOC CLI (resolved through
``core.runner.find_babeldoc``) against a local mock OpenAI server, so no
network, no API key and no paid calls are involved.  They reproduce the
production failures that made a translated paragraph disappear from the page:

1. ``normal``        every paragraph must reach the output page;
2. ``empty``         the model answers with an empty string for one long
                     paragraph -> the original text must be kept, the paragraph
                     must be explicitly reported, and the page must not go
                     blank (this is the actual blank-area bug);
3. resilience        in one compatibility-mode run: non-JSON answers for the
                     rich-text JSON batch (BabelDOC's fallback has to complete
                     the translation), HTTP 429 and HTTP 500 transient API
                     failures, and ``--disable-rich-text-translate`` itself.

The scenarios are grouped into three real ``babeldoc`` invocations because the
layout analysis alone takes ~25s per run on this machine; a fifth invocation
would push the suite well past its three-minute budget.  ``MockLLMServer``
still offers the focused ``invalid_json`` / ``rate_limit_once`` / ``error_once``
modes for debugging one failure at a time.

Every run uses the ``core/babelguard`` runtime guard injected through
``PYTHONPATH`` + ``BABELDOC_STUDIO_GUARD=1``, exactly like ``core/runner.py``.
The suite skips cleanly when the ``babeldoc`` executable or the guard package is
not available.

Run::

    cd E:\\01Projects\\02BabelDOC
    $env:PYTHONPATH=(Resolve-Path .lead).Path
    $env:TEMP=(Resolve-Path .lead\\run-tests).Path
    $env:TMP=$env:TEMP
    python -m pytest tests/test_translate_completeness.py -q -p no:cacheprovider -p nomode700

``pytest``'s ``tmp_path`` fixture is broken in this sandbox, so every test uses
a directory created with ``tempfile.mkdtemp(dir=TEMP)``.  One fixture PDF is
built once per module and reused; each run translates pages 1-2 only.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import pymupdf
import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

import translate_fixtures as fixtures  # noqa: E402
from core import runner, translate_qa  # noqa: E402

BABELDOC_EXE = runner.find_babeldoc("")
GUARD_DIR = REPO_ROOT / "core" / "babelguard"
BASE_TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or "."
PAGES = "1-2"
RUN_TIMEOUT = 300

pytestmark = [
    pytest.mark.skipif(
        not BABELDOC_EXE, reason="babeldoc executable is not installed"
    ),
    pytest.mark.skipif(
        not GUARD_DIR.is_dir(), reason="core/babelguard runtime guard is missing"
    ),
]


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def fixture_pdf():
    """One shared English fixture PDF: 2 pages, 4 paragraphs each."""
    work = Path(tempfile.mkdtemp(prefix="tce-fixture-", dir=BASE_TEMP))
    try:
        path = fixtures.build_fixture_pdf(work / "fixture.pdf", pages=2)
        pages = fixtures.fixture_pages(path)
        assert len(pages) == 2
        assert all(len(blocks) >= 3 for blocks in pages)
        marker_page, marker_block = fixtures.find_marker_block(path)
        assert marker_page == fixtures.LONG_PARAGRAPH_PAGE
        assert len(marker_block[4]) >= fixtures.LONG_PARAGRAPH_MIN_CHARS
        yield path
    finally:
        shutil.rmtree(work, ignore_errors=True)


@pytest.fixture()
def workdir():
    path = tempfile.mkdtemp(prefix="tce-", dir=BASE_TEMP)
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _read_status(path) -> dict | None:
    """Read the guard status JSON; missing/empty/broken files mean ``None``."""
    try:
        target = Path(path)
        if not target.is_file():
            return None
        raw = target.read_text(encoding="utf-8-sig")
        if not raw.strip():
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _run_babeldoc(
    work: Path,
    mock: fixtures.MockLLMServer,
    fixture: Path,
    *,
    compat: bool = False,
) -> SimpleNamespace:
    """Run the real babeldoc CLI once and collect its artefacts."""
    out_dir = work / "out"
    out_dir.mkdir(parents=True, exist_ok=True)
    status_path = work / "guard.json"

    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env["no_proxy"] = "127.0.0.1,localhost"
    previous = env.get("PYTHONPATH") or ""
    env["PYTHONPATH"] = str(GUARD_DIR) + (
        (os.pathsep + previous) if previous else ""
    )
    env["BABELDOC_STUDIO_GUARD"] = "1"
    env["BABELDOC_STUDIO_GUARD_STATUS"] = str(status_path)
    env["BABELDOC_STUDIO_GUARD_DOC"] = fixture.name
    # The guard retries empty answers; keep its backoff tiny so the E2E suite
    # stays fast (the production defaults are 1s/3s).
    env["BABELDOC_STUDIO_GUARD_RETRIES"] = "2"
    env["BABELDOC_STUDIO_GUARD_BACKOFF"] = "0.05,0.05"

    command = [
        BABELDOC_EXE,
        "--openai",
        "--openai-model",
        "mock",
        "--openai-base-url",
        mock.base_url,
        "--openai-api-key",
        "dummy",
        "--lang-in",
        "en",
        "--lang-out",
        "zh",
        "--output",
        str(out_dir),
        "--pages",
        PAGES,
        "--no-dual",
        "--watermark-output-mode",
        "no_watermark",
        "--no-auto-extract-glossary",
        "--ignore-cache",
        "--files",
        str(fixture),
    ]
    if compat:
        command.append("--disable-rich-text-translate")

    started = time.time()
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=RUN_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail(
            f"babeldoc did not finish within {RUN_TIMEOUT}s "
            f"(mode={mock.mode!r}); partial output: {exc.stdout!r}"
        )
    elapsed = time.time() - started

    log = (proc.stdout or "") + "\n--- stderr ---\n" + (proc.stderr or "")
    (work / "babeldoc.log").write_text(log, encoding="utf-8")

    produced = [
        path
        for path in sorted(out_dir.glob("*.pdf"))
        if not path.name.endswith(".decompressed.pdf")
    ]
    assert len(produced) == 1, (
        f"expected exactly one translated PDF, got {[p.name for p in produced]}; "
        f"babeldoc exit={proc.returncode}; log tail:\n{log[-4000:]}"
    )
    return SimpleNamespace(
        returncode=proc.returncode,
        output_dir=out_dir,
        pdf=produced[0],
        status_path=status_path,
        status=_read_status(status_path),
        log=log,
        elapsed=elapsed,
        command=command,
        mode=mock.mode,
    )


def _detail(run: SimpleNamespace) -> str:
    """Short failure context for assertions (guard counts + log tail)."""
    counts = (run.status or {}).get("counts") if run.status else None
    return (
        f"mode={run.mode!r} exit={run.returncode} guard_counts={counts} "
        f"elapsed={run.elapsed:.1f}s; log tail:\n{run.log[-3000:]}"
    )


def _assert_pages_complete(fixture: Path, out_pdf: Path, run: SimpleNamespace) -> None:
    """Every source paragraph block must have text in the output page."""
    source = pymupdf.open(str(fixture))
    output = pymupdf.open(str(out_pdf))
    try:
        assert output.page_count >= 2, _detail(run)
        for page_number in (1, 2):
            source_page = source[page_number - 1]
            output_page = output[page_number - 1]
            coverages = translate_qa.page_block_coverages(source_page, output_page)
            assert coverages, f"no source text blocks on page {page_number}"
            lost = [
                (block[:4], len(block[4]), round(coverage, 3))
                for block, coverage in coverages
                if coverage < translate_qa.MONO_BLOCK_MIN_COVERAGE
            ]
            assert not lost, (
                f"page {page_number} has paragraph regions without text "
                f"(coverage < {translate_qa.MONO_BLOCK_MIN_COVERAGE}): {lost}; "
                + _detail(run)
            )
    finally:
        source.close()
        output.close()


def _assert_guard_clean(status: dict | None, run: SimpleNamespace) -> None:
    assert status is not None, "the runtime guard did not write a status file; " + _detail(run)
    paragraphs = status.get("paragraphs") or []
    assert paragraphs, "guard status has no paragraph records; " + _detail(run)
    for record in paragraphs:
        status_name = str(record.get("status") or "").upper()
        render = str(record.get("render_status") or "").lower()
        assert status_name not in {"EMPTY", "RENDER_FAILED", "FAILED"}, (
            f"guard reported a lost paragraph: {record}; " + _detail(run)
        )
        assert render != "render_failed", (
            f"guard reported a render failure: {record}; " + _detail(run)
        )
    counts = status.get("counts") or {}
    assert int(counts.get("translated") or 0) > 0, _detail(run)
    assert int(counts.get("empty") or 0) == 0, (
        f"guard saw empty model answers in a normal run: {counts}; " + _detail(run)
    )


def _kept_original_record(
    status: dict | None, page: int, min_chars: int
) -> dict | None:
    """The guard record that proves the long paragraph was kept, not blanked."""
    for record in (status or {}).get("paragraphs") or []:
        try:
            same_page = int(record.get("page") or 0) == page
            long_enough = int(record.get("source_chars") or 0) >= min_chars
        except (TypeError, ValueError):
            continue
        if not (same_page and long_enough):
            continue
        status_name = str(record.get("status") or "").upper()
        layout = str(record.get("layout_status") or "").lower()
        if status_name in {"EMPTY", "KEPT_ORIGINAL", "FORCED"}:
            return record
        if layout in {"kept_original", "forced_kept_original"}:
            return record
    return None


def _normalized_text(path: Path) -> str:
    return " ".join(fixtures.pymupdf_text(path).split())


def _marker_is_kept(fixture: Path, out_pdf: Path, run: SimpleNamespace) -> None:
    """The long paragraph's original English must still be on the output page."""
    marker_page, marker_block = fixtures.find_marker_block(fixture)
    assert marker_page and marker_block, _detail(run)

    output = pymupdf.open(str(out_pdf))
    try:
        output_page = output[marker_page - 1]
        output_rects = [block[:4] for block in translate_qa.text_blocks(output_page)]
        coverage = translate_qa.block_coverage(marker_block[:4], output_rects)
    finally:
        output.close()
    assert coverage >= translate_qa.MONO_BLOCK_MIN_COVERAGE, (
        f"the long paragraph region on page {marker_page} has no text "
        f"(coverage={coverage:.3f}) - this is the blank-area bug; " + _detail(run)
    )
    assert "zebra" in _normalized_text(out_pdf).lower(), (
        "the original English of the paragraph was not kept on the page; "
        + _detail(run)
    )


# ---------------------------------------------------------------------------
# scenarios
# ---------------------------------------------------------------------------


def test_normal_mode_translates_every_paragraph(fixture_pdf, workdir):
    """All paragraphs reach the page; the guard reports nothing lost."""
    with fixtures.MockLLMServer("normal") as mock:
        run = _run_babeldoc(workdir, mock, fixture_pdf)

    assert run.returncode == 0, _detail(run)
    assert mock.request_count > 0, "the mock server received no request"
    _assert_pages_complete(fixture_pdf, run.pdf, run)
    _assert_guard_clean(run.status, run)

    report = translate_qa.verify(
        fixture_pdf, run.pdf, "译文", guard_status=run.status_path
    )
    assert report["checked"] is True, report.get("warnings")
    assert report["ok"] is True, report.get("warnings")
    assert report["missing"] == [], report.get("warnings")
    assert report["translated_paragraphs"] > 0


def test_empty_model_answer_keeps_original_and_is_reported(fixture_pdf, workdir):
    """Empty answer -> original text kept, explicitly reported, never silent.

    This is the production blank-area bug: without the guard the long
    paragraph's text is wiped from the page while babeldoc still exits 0.
    """
    with fixtures.MockLLMServer("empty") as mock:
        run = _run_babeldoc(workdir, mock, fixture_pdf)

    assert run.returncode == 0, _detail(run)
    # the mock really answered empty for the targeted paragraph request
    assert mock.request_count > 0, _detail(run)

    # 1. no large blank area: the original English is still on the page
    _assert_pages_complete(fixture_pdf, run.pdf, run)
    _marker_is_kept(fixture_pdf, run.pdf, run)

    # 2. the guard status explicitly reports the empty answer / kept original
    status = run.status
    assert status is not None, "the runtime guard did not write a status file; " + _detail(run)
    counts = status.get("counts") or {}
    record = _kept_original_record(
        status, fixtures.LONG_PARAGRAPH_PAGE, fixtures.LONG_PARAGRAPH_MIN_CHARS
    )
    assert record is not None, (
        "guard status does not name the long paragraph whose answer was empty; "
        + _detail(run)
    )
    assert int(record.get("retry_count") or 0) >= 1, (
        f"the empty answer was not retried: {record}; " + _detail(run)
    )
    assert int(counts.get("empty") or 0) >= 1 or int(counts.get("retried") or 0) >= 1, (
        f"guard counts hide the empty answer: {counts}; " + _detail(run)
    )

    # 3. QA reports the completeness honestly: nothing is *missing* (the
    #    original was kept), but the paragraph is surfaced either as
    #    "untranslated" or through the guard's empty count.
    report = translate_qa.verify(
        fixture_pdf, run.pdf, "译文", guard_status=run.status_path
    )
    assert report["checked"] is True, report.get("warnings")
    reported = [
        entry
        for entry in report["untranslated"] + report["missing"]
        if entry.get("page") == fixtures.LONG_PARAGRAPH_PAGE
    ]
    guard_counts = (report.get("guard") or {}).get("counts") or {}
    assert reported or int(guard_counts.get("empty") or 0) >= 1, (
        "the empty answer is not exposed by QA/guard at all; "
        f"report={report}; " + _detail(run)
    )
    assert all(
        entry.get("page") != fixtures.LONG_PARAGRAPH_PAGE
        for entry in report["missing"]
    ), (
        "the kept-original paragraph was reported as lost: "
        f"{report['missing']}; " + _detail(run)
    )


def test_resilience_compat_invalid_json_and_transient_errors(fixture_pdf, workdir):
    """One run covering items 3-5 of the contract to keep the suite fast.

    The mock injects HTTP 429 then HTTP 500, and answers every JSON batch
    request with plain text (the deepseek-flash failure).  BabelDOC must retry
    the transient failures, fall back to the per-paragraph prompt when the JSON
    batch cannot be parsed, and still translate every paragraph -- with
    ``--disable-rich-text-translate`` (compatibility mode) enabled as well.

    ``MockLLMServer`` also supports the focused ``rate_limit_once``,
    ``error_once`` and ``invalid_json`` modes for debugging a single failure.
    """
    with fixtures.MockLLMServer("flaky_invalid_json") as mock:
        run = _run_babeldoc(workdir, mock, fixture_pdf, compat=True)

    assert run.returncode == 0, _detail(run)
    assert "--disable-rich-text-translate" in run.command

    # 1. transient HTTP failures were injected and survived
    failures = [
        request
        for request in mock.requests
        if int(request.get("response_chars") or 0) < 0
    ]
    assert len(failures) >= 2, (
        f"the transient failures were not injected: {mock.requests}; " + _detail(run)
    )

    # 2. the JSON batch protocol was exercised and the per-paragraph fallback
    #    translated the paragraphs after the invalid batch answer
    assert mock.request_texts(batch=True), "no JSON batch request was made; " + _detail(run)
    assert mock.request_texts(batch=False), (
        "no per-paragraph fallback request was made; " + _detail(run)
    )

    # 3. nothing was lost
    _assert_pages_complete(fixture_pdf, run.pdf, run)
    _assert_guard_clean(run.status, run)
    counts = (run.status or {}).get("counts") or {}
    assert int(counts.get("translated") or 0) > 0, _detail(run)

    report = translate_qa.verify(
        fixture_pdf, run.pdf, "译文", guard_status=run.status_path
    )
    assert report["checked"] is True, report.get("warnings")
    assert report["ok"] is True, report.get("warnings")
