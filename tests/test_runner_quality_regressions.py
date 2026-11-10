"""Regressions for issues found by the independent verifier.

These complement ``tests/test_runner_recovery.py`` and pin four details of the
completeness-check wiring in ``core/runner.py``:

* a failed process launch must not leave the per-run guard status directory;
* the compatibility retry respects ``QC_MAX_RETRIES``;
* ``quality`` counts each source document once even when BabelDOC emits both a
  mono and a dual PDF (otherwise every paragraph is counted twice);
* a guard record without a page number is still reported to the user.

Run::

    cd E:\\01Projects\\02BabelDOC
    $env:PYTHONPATH=(Resolve-Path .lead).Path
    $env:TEMP=(Resolve-Path .lead\\run-tests).Path
    $env:TMP=$env:TEMP
    python -m pytest tests/test_runner_quality_regressions.py -q -p no:cacheprovider -p nomode700

``pytest``'s ``tmp_path`` fixture is unreliable in this sandbox; every test uses
``tempfile.mkdtemp(dir=TEMP)``.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import runner  # noqa: E402

BASE_TEMP = os.environ.get("TEMP") or os.environ.get("TMP") or "."

SOURCE_TEXT = (
    "A long English paragraph that BabelDOC has to translate. " * 10
).strip()


@pytest.fixture()
def workdir():
    path = tempfile.mkdtemp(prefix="trq-", dir=BASE_TEMP)
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def make_job(output_dir: Path, files: list[str] | None = None) -> runner.Job:
    return runner.Job(
        id="qualityjob",
        config={
            "model": "mock-model",
            "base_url": "http://127.0.0.1:1/v1",
            "api_key": "dummy",
            "lang_in": "en",
            "lang_out": "zh",
            "output_dir": str(output_dir),
            "dual_mode": "mono",
            "watermark": "no_watermark",
            "auto_glossary": False,
        },
        files=list(files or ["source.pdf"]),
        command=["babeldoc.exe"],
        runs=[{"files": list(files or ["source.pdf"]), "pages": "1-2"}],
    )


def artifact(output_dir: Path, *, source: str, stem: str = "paper") -> dict:
    return {
        "path": output_dir / f"{stem}.no_watermark.zh.mono.pdf",
        "name": f"{stem}_译文（无水印）.pdf",
        "kind": "译文",
        "paper_stem": stem,
        "source": source,
    }


def write_pdf(path: Path, text: str) -> Path:
    import pymupdf

    document = pymupdf.open()
    try:
        page = document.new_page(width=595, height=842)
        page.insert_textbox(pymupdf.Rect(72, 72, 523, 770), text, fontsize=9)
        document.save(str(path))
    finally:
        document.close()
    return path


def missing_report(page: int = 2) -> dict:
    return {
        "ok": False,
        "checked": True,
        "source_pages": 2,
        "output_pages": 2,
        "expected_paragraphs": 5,
        "translated_paragraphs": 4,
        "untranslated_paragraphs": 0,
        "missing": [
            {
                "page": page,
                "paragraph_id": "pLost",
                "source_chars": 900,
                "reason": "空译文",
            }
        ],
        "untranslated": [],
        "blank_pages": [page] if page else [],
        "warnings": [],
        "guard": {"used": True, "counts": {}},
    }


def test_spawn_failure_removes_guard_status_dir(workdir, monkeypatch):
    qc_dir = workdir / "qc"
    qc_dir.mkdir()
    monkeypatch.setattr(runner.tempfile, "mkdtemp", lambda prefix="": str(qc_dir))

    def boom(command, **kwargs):
        raise OSError("cannot start")

    monkeypatch.setattr(runner.subprocess, "Popen", boom)
    job = make_job(workdir)
    with pytest.raises(OSError):
        runner._spawn_babeldoc(
            job, {"files": ["source.pdf"]}, workdir, dict(os.environ), "1-2", compat=False
        )
    assert not qc_dir.exists(), "a failed launch must clean up its guard status dir"


def test_compat_retry_respects_max_retries(workdir, monkeypatch):
    output_dir = workdir / "out"
    output_dir.mkdir()
    source = str(write_pdf(workdir / "source.pdf", SOURCE_TEXT))
    (output_dir / "paper.no_watermark.zh.mono.pdf").write_bytes(b"%PDF-1.4")
    monkeypatch.setattr(
        runner, "new_artifacts", lambda *a, **k: [artifact(output_dir, source=source)]
    )
    monkeypatch.setattr(
        runner, "_verify_artifact", lambda art, status: missing_report(2)
    )
    calls: list = []

    def fake_spawn(*args, **kwargs):
        calls.append(args)
        return 0, workdir / "guard.json"

    monkeypatch.setattr(runner, "_spawn_babeldoc", fake_spawn)
    status_path = workdir / "guard.json"
    status_path.write_text("{}", encoding="utf-8")
    job = make_job(output_dir)
    run = {
        "files": ["source.pdf"],
        "pages": "1-2",
        "compat_retries": runner.QC_MAX_RETRIES,
    }
    reports = runner._check_run(
        job, run, output_dir, {}, dict(os.environ), "1-2", status_path
    )
    assert reports, "the missing report must still be returned"
    assert calls == [], "no compatibility retry when the retry budget is used up"


def test_job_quality_counts_each_document_once():
    report = missing_report(2)
    report["missing_total"] = 1
    report["untranslated_total"] = 0
    report["warnings"] = ["第 2 页有 1 个段落没有译文（pLost）。"]
    results = [
        {
            "name": "paper_译文（无水印）.pdf",
            "source": "paper.pdf",
            "kind": "译文",
            "qc": dict(report),
        },
        {
            "name": "paper_双语对照（无水印）.pdf",
            "source": "paper.pdf",
            "kind": "双语对照",
            "qc": dict(report),
        },
    ]
    quality = runner._job_quality(results)
    assert quality["checked"] is True
    assert quality["ok"] is False
    assert quality["missing"] == 1, "mono+dual of one document must not double count"
    assert quality["pages"] == [2]
    assert quality["warnings"] == ["第 2 页有 1 个段落没有译文（pLost）。"]


def test_collect_results_reports_pageless_missing(workdir, monkeypatch):
    output_dir = workdir / "out"
    output_dir.mkdir()
    source = write_pdf(workdir / "paper.pdf", SOURCE_TEXT)
    write_pdf(output_dir / "paper.no_watermark.zh.mono.pdf", "translated page")
    monkeypatch.setattr(
        runner, "new_artifacts", lambda *a, **k: [artifact(output_dir, source=str(source))]
    )
    monkeypatch.setattr(
        runner.pdfqa,
        "inspect_translation",
        lambda *a, **k: {"blank_pages": [], "warning": ""},
    )
    qc = {
        ("paper", "译文"): {
            "ok": False,
            "checked": True,
            "expected_paragraphs": 3,
            "translated_paragraphs": 2,
            "untranslated_paragraphs": 0,
            "missing": [
                {
                    "page": 0,
                    "paragraph_id": "p0",
                    "source_chars": 500,
                    "reason": "空译文",
                }
            ],
            "untranslated": [],
            "blank_pages": [],
            "warnings": [],
            "guard": {"used": True, "counts": {}},
        }
    }
    results = runner.collect_results(
        output_dir, {}, [str(source)], "zh", qc_by_key=qc
    )
    assert results, "the produced PDF must be reported"
    payload = results[0]
    assert payload["incomplete"] is True
    assert "页码未知" in payload["warning"], payload["warning"]
