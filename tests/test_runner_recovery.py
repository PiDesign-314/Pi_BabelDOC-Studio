"""Unit tests for the completeness-check / compat-retry wiring in core/runner.py.

These tests never launch BabelDOC: ``subprocess.Popen``, ``new_artifacts`` and
``_verify_artifact`` (or ``translate_qa``) are monkeypatched, and the few PDFs
they need are built with PyMuPDF.  They pin the recovery contract:

* every BabelDOC run is started with the ``core/babelguard`` environment
  (``BABELDOC_STUDIO_GUARD`` / ``BABELDOC_STUDIO_GUARD_STATUS``);
* after a run the produced PDFs are verified, and when paragraphs are lost the
  same page range is retried **once** in compatibility mode
  (``--disable-rich-text-translate``);
* the better result is copied over the artefact and reported;
* every result carries ``qc`` (the trimmed verification report), ``incomplete``
  and ``warning``, so a job can end successfully while still naming the pages
  that lost their translation -- never silently;
* a missing or malformed guard status file never breaks the check.

Run::

    cd E:\\01Projects\\02BabelDOC
    $env:PYTHONPATH=(Resolve-Path .lead).Path
    $env:TEMP=(Resolve-Path .lead\\run-tests).Path
    $env:TMP=$env:TEMP
    python -m pytest tests/test_runner_recovery.py -q -p no:cacheprovider -p nomode700

``pytest``'s ``tmp_path`` fixture is broken in this sandbox; every test uses a
directory created with ``tempfile.mkdtemp(dir=TEMP)``.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import runner  # noqa: E402

BASE_TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or "."

SOURCE_TEXT = (
    "A long English paragraph that BabelDOC has to translate. " * 10
).strip()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def workdir():
    """Temporary work directory (``tmp_path`` is unreliable in this sandbox)."""
    path = tempfile.mkdtemp(prefix="trr-", dir=BASE_TEMP)
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def write_pdf(path: Path, text: str) -> Path:
    """Minimal single-page PDF with *text*."""
    document = pymupdf.open()
    try:
        page = document.new_page(width=595, height=842)
        page.insert_textbox(pymupdf.Rect(72, 72, 523, 770), text, fontsize=9)
        document.save(str(path))
    finally:
        document.close()
    return path


def pdf_text(path) -> str:
    document = pymupdf.open(str(path))
    try:
        return "\n".join(page.get_text("text") or "" for page in document)
    finally:
        document.close()


def make_job(output_dir: Path, files: list[str] | None = None) -> runner.Job:
    config = {
        "model": "mock-model",
        "base_url": "http://127.0.0.1:1/v1",
        "api_key": "dummy",
        "lang_in": "en",
        "lang_out": "zh",
        "output_dir": str(output_dir),
        "dual_mode": "mono",
        "watermark": "no_watermark",
        "auto_glossary": False,
    }
    return runner.Job(
        id="testjob",
        config=config,
        files=list(files or ["source.pdf"]),
        command=["babeldoc.exe"],
        runs=[{"files": list(files or ["source.pdf"]), "pages": "1-2"}],
    )


def report(
    *,
    missing: list | None = None,
    untranslated: list | None = None,
    translated: int = 3,
    warnings: list | None = None,
    checked: bool = True,
) -> dict:
    """A translate_qa.verify()-shaped report for the monkeypatched verifier."""
    lost = list(missing or [])
    return {
        "ok": not lost and bool(checked),
        "checked": checked,
        "source_pages": 2,
        "output_pages": 2,
        "expected_paragraphs": 3,
        "translated_paragraphs": translated,
        "untranslated_paragraphs": len(untranslated or []),
        "missing": lost,
        "untranslated": list(untranslated or []),
        "blank_pages": sorted({int(item["page"]) for item in lost if item.get("page")}),
        "warnings": list(warnings or []),
        "guard": {"used": bool(checked), "counts": {}},
    }


def artifact(output_dir: Path, *, stem: str = "paper", source: str = "source.pdf") -> dict:
    return {
        "path": output_dir / f"{stem}.no_watermark.zh.mono.pdf",
        "name": f"{stem}_译文（无水印）.pdf",
        "kind": "译文",
        "paper_stem": stem,
        "source": source,
    }


def fake_process(lines: list[str] | None = None):
    """A stand-in for ``subprocess.Popen`` used by ``_spawn_babeldoc``."""

    class Process:
        def __init__(self) -> None:
            self.stdout = iter(lines or [])
            self.returncode = 0

        def wait(self) -> int:
            return 0

        def poll(self) -> int:
            return 0

    return Process()


# ---------------------------------------------------------------------------
# guard environment
# ---------------------------------------------------------------------------


@pytest.mark.skipif(not runner.GUARD_DIR.is_dir(), reason="core/babelguard is not installed")
def test_guard_environment_sets_path_and_status(workdir):
    status = workdir / "guard.json"
    env = runner.guard_environment(
        {"PYTHONPATH": "existing-dir"}, status, "paper.pdf"
    )
    assert env["BABELDOC_STUDIO_GUARD"] == "1"
    assert env["BABELDOC_STUDIO_GUARD_STATUS"] == str(status)
    assert env["BABELDOC_STUDIO_GUARD_DOC"] == "paper.pdf"
    parts = env["PYTHONPATH"].split(os.pathsep)
    assert parts[0] == str(runner.GUARD_DIR)
    assert "existing-dir" in parts[1:]


def test_spawn_babeldoc_enables_guard(workdir, monkeypatch):
    """Every babeldoc invocation must carry the guard env and status path."""
    captured: dict = {}

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured["env"] = kwargs.get("env") or {}
        return fake_process(["layout: start\n"])

    monkeypatch.setattr(runner.subprocess, "Popen", fake_popen)
    job = make_job(workdir)
    code, status_path = runner._spawn_babeldoc(
        job, {"files": ["source.pdf"]}, workdir, dict(os.environ), "1-2", compat=False
    )

    assert code == 0
    env = captured["env"]
    if runner.GUARD_DIR.is_dir():
        assert env["BABELDOC_STUDIO_GUARD"] == "1"
        assert env["BABELDOC_STUDIO_GUARD_STATUS"] == str(status_path)
        assert env["PYTHONPATH"].split(os.pathsep)[0] == str(runner.GUARD_DIR)
    assert status_path.name == "guard.json"
    # a first attempt must NOT be forced into compatibility mode
    assert "--disable-rich-text-translate" not in captured["command"]


def test_build_command_compat_adds_disable_rich_text(workdir):
    cfg = {
        "model": "mock",
        "base_url": "http://127.0.0.1:1/v1",
        "api_key": "k",
        "lang_in": "en",
        "lang_out": "zh",
        "output_dir": str(workdir / "out"),
        "dual_mode": "mono",
        "watermark": "no_watermark",
        "auto_glossary": False,
    }
    normal = runner.build_command(cfg, ["a.pdf"], "babeldoc.exe")
    compat = runner.build_command(cfg, ["a.pdf"], "babeldoc.exe", compat=True)
    assert "--disable-rich-text-translate" not in normal
    assert compat.count("--disable-rich-text-translate") == 1


# ---------------------------------------------------------------------------
# recovery: verify -> compat retry -> better output wins
# ---------------------------------------------------------------------------


def test_check_run_retries_in_compat_mode_and_keeps_better_output(workdir, monkeypatch):
    output_dir = workdir / "out"
    output_dir.mkdir()
    first_pdf = write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "WORSE output")
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)
    status_path = workdir / "guard.json"
    status_path.write_text(
        json.dumps(
            {
                "schema": 1,
                "paragraphs": [
                    {
                        "page": 2,
                        "paragraph_id": "pLost",
                        "source_chars": 500,
                        "translated_chars": 0,
                        "status": "EMPTY",
                    }
                ],
                "counts": {"paragraphs": 1, "translated": 0, "empty": 1},
            }
        ),
        encoding="utf-8",
    )

    spawn_calls: list[dict] = []
    verify_calls: list[dict] = []

    monkeypatch.setattr(
        runner,
        "new_artifacts",
        lambda directory, before, files, lang: [artifact(Path(directory), source=str(source_pdf))],
    )

    def fake_spawn(job, run, directory, env, pages, compat, status_dir=None):
        spawn_calls.append({"compat": compat, "directory": Path(directory), "pages": pages})
        retry_pdf = write_pdf(
            Path(directory) / "paper.no_watermark.zh.mono.pdf", "BETTER translated output"
        )
        assert retry_pdf.exists()
        return 0, (Path(directory) / "guard.json")

    def fake_verify(candidate, status):
        verify_calls.append({"path": Path(candidate["path"]), "status": status})
        text = pdf_text(candidate["path"])
        if "BETTER" in text:
            return report(translated=3)
        return report(
            missing=[{"page": 2, "paragraph_id": "pLost", "source_chars": 500, "reason": "空译文"}],
            translated=2,
            warnings=["第 2 页有 1 个段落没有译文（pLost），可能大面积空白。"],
        )

    monkeypatch.setattr(runner, "_spawn_babeldoc", fake_spawn)
    monkeypatch.setattr(runner, "_verify_artifact", fake_verify)

    job = make_job(output_dir)
    run = {"files": [str(source_pdf)], "pages": "1-2"}
    reports = runner._check_run(
        job, run, output_dir, {}, dict(os.environ), "1-2", status_path
    )

    # 1) a compat-mode retry happened exactly once, for the same pages
    assert len(spawn_calls) == 1
    assert spawn_calls[0]["compat"] is True
    assert spawn_calls[0]["pages"] == "1-2"

    # 2) the guard status was handed to the verifier for the first attempt
    statuses = [call["status"] for call in verify_calls]
    assert any(isinstance(item, dict) and item.get("schema") == 1 for item in statuses)
    assert statuses[-1] is None  # retry directory has no status file in this fake

    # 3) the better (complete) output replaced the first artefact
    assert "BETTER" in pdf_text(first_pdf)
    key = ("paper", "译文")
    assert key in reports
    assert reports[key]["missing"] == []
    assert reports[key]["translated_paragraphs"] == 3

    # 4) the recovery is explicit in the job log
    joined = "\n".join(job.logs)
    assert "兼容模式" in joined
    assert "译文更完整" in joined


def test_check_run_does_not_retry_clean_run(workdir, monkeypatch):
    output_dir = workdir / "out"
    output_dir.mkdir()
    write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "good translation")
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)

    monkeypatch.setattr(
        runner,
        "new_artifacts",
        lambda directory, before, files, lang: [artifact(Path(directory), source=str(source_pdf))],
    )
    monkeypatch.setattr(runner, "_verify_artifact", lambda candidate, status: report())
    monkeypatch.setattr(
        runner,
        "_spawn_babeldoc",
        lambda *args, **kwargs: pytest.fail("a clean run must not be retried"),
    )

    job = make_job(output_dir)
    reports = runner._check_run(
        job,
        {"files": [str(source_pdf)]},
        output_dir,
        {},
        dict(os.environ),
        "1-2",
        workdir / "missing-guard.json",
    )

    assert reports[("paper", "译文")]["ok"] is True
    assert any("译文完整性" in line for line in job.logs)


def test_check_run_survives_missing_and_malformed_guard_status(workdir, monkeypatch):
    output_dir = workdir / "out"
    output_dir.mkdir()
    write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "translated text")
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)

    monkeypatch.setattr(
        runner,
        "new_artifacts",
        lambda directory, before, files, lang: [artifact(Path(directory), source=str(source_pdf))],
    )
    seen_status: list = []

    def fake_verify(candidate, status):
        seen_status.append(status)
        return report()

    monkeypatch.setattr(runner, "_verify_artifact", fake_verify)
    monkeypatch.setattr(
        runner, "_spawn_babeldoc", lambda *a, **k: pytest.fail("no retry expected")
    )

    job = make_job(output_dir)
    missing_status = workdir / "does-not-exist.json"
    reports = runner._check_run(
        job, {"files": [str(source_pdf)]}, output_dir, {}, dict(os.environ), "1-2", missing_status
    )
    assert reports[("paper", "译文")]["checked"] is True
    assert seen_status == [None]  # missing file degrades to PDF-only QA, no crash

    broken_status = workdir / "broken.json"
    broken_status.write_text("{not valid json", encoding="utf-8")
    seen_status.clear()
    reports = runner._check_run(
        job, {"files": [str(source_pdf)]}, output_dir, {}, dict(os.environ), "1-2", broken_status
    )
    assert reports[("paper", "译文")]["checked"] is True
    assert seen_status == [None]  # malformed JSON is ignored, never raised

    empty_status = workdir / "empty.json"
    empty_status.write_text("", encoding="utf-8")
    seen_status.clear()
    reports = runner._check_run(
        job, {"files": [str(source_pdf)]}, output_dir, {}, dict(os.environ), "1-2", empty_status
    )
    assert seen_status == [None]


# ---------------------------------------------------------------------------
# results / job quality: incomplete is reported, never silent
# ---------------------------------------------------------------------------


def test_collect_results_attaches_qc_and_warning(workdir):
    output_dir = workdir / "out"
    output_dir.mkdir()
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)
    write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "翻译后的文本，已完整输出。")

    missing = [
        {
            "page": 2,
            "paragraph_id": "pLost",
            "source_chars": 500,
            "reason": "空译文",
        }
    ]
    warning = "第 2 页有 1 个段落没有译文（pLost），可能大面积空白。"
    qc = report(missing=missing, translated=2, warnings=[warning])

    results = runner.collect_results(
        output_dir,
        {},
        [str(source_pdf)],
        "zh",
        qc_by_key={("paper", "译文"): qc},
    )
    assert len(results) == 1
    result = results[0]
    assert result["kind"] == "译文"
    assert result["incomplete"] is True
    assert result["qc"]["missing"][0]["page"] == 2
    assert result["qc"]["missing_total"] == 1
    assert warning in result["warning"]
    assert 2 in result["blank_pages"]

    quality = runner._job_quality(results)
    assert quality["checked"] is True
    assert quality["ok"] is False
    assert quality["missing"] == 1
    assert quality["pages"] == [2]
    assert warning in quality["warnings"]


def test_collect_results_clean_report_is_not_incomplete(workdir):
    output_dir = workdir / "out"
    output_dir.mkdir()
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)
    write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "翻译后的文本，已完整输出。")

    results = runner.collect_results(
        output_dir,
        {},
        [str(source_pdf)],
        "zh",
        qc_by_key={("paper", "译文"): report()},
    )
    assert results[0]["incomplete"] is False
    assert results[0]["qc"]["missing"] == []
    assert runner._job_quality(results)["ok"] is True


def test_run_finishes_succeeded_but_names_lost_pages(workdir, monkeypatch):
    """A job with lost paragraphs still ends 'succeeded' and logs/warns about it."""
    output_dir = workdir / "out"
    output_dir.mkdir()
    source_pdf = write_pdf(workdir / "source.pdf", SOURCE_TEXT)
    output_pdf = write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "translated")

    monkeypatch.setattr(runner.babelcache, "clear_empty_translations", lambda *a, **k: 0)
    monkeypatch.setattr(
        runner,
        "_spawn_babeldoc",
        lambda job, run, directory, env, pages, compat: (0, Path(directory) / "guard.json"),
    )
    lost_report = report(
        missing=[{"page": 2, "paragraph_id": "pLost", "source_chars": 500, "reason": "空译文"}],
        translated=2,
        warnings=["第 2 页有 1 个段落没有译文（pLost），可能大面积空白。"],
    )
    monkeypatch.setattr(
        runner, "_check_run", lambda *args, **kwargs: {("paper", "译文"): lost_report}
    )
    monkeypatch.setattr(
        runner,
        "collect_results",
        lambda *args, **kwargs: [
            {
                "name": "paper_译文（无水印）.pdf",
                "path": str(output_pdf),
                "kind": "译文",
                "size": 1,
                "blank_pages": [2],
                "warning": "第 2 页有 1 个段落没有译文（pLost），可能大面积空白。",
                "incomplete": True,
                "qc": lost_report,
            }
        ],
    )

    job = make_job(output_dir, files=[str(source_pdf)])
    job.runs = [{"files": [str(source_pdf)], "pages": "1-2"}]
    manager = runner.JobManager()
    manager._run(job, output_dir)

    assert job.status == "succeeded"
    assert job.results and job.results[0]["incomplete"] is True
    assert job.quality["ok"] is False
    assert job.quality["pages"] == [2]
    joined = "\n".join(job.logs)
    assert "第 2 页" in joined
    assert "翻译完成" in joined
