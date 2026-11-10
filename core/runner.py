"""BabelDOC process runner: builds the CLI command, streams logs, tracks stage
and progress, and renames the produced PDFs into friendly Chinese names.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from . import babelcache, pdfqa, pricing

try:  # translation completeness verification (paragraph level)
    from . import translate_qa
except Exception:  # pragma: no cover - only while the module is absent
    translate_qa = None

#: Runtime guard injected into every BabelDOC child process (see core/babelguard).
GUARD_DIR = Path(__file__).resolve().parent / "babelguard"

#: Temporary directories created for guard status files / compat-mode retries.
QC_TEMP_PREFIX = "babeldoc-studio-qc-"

#: One automatic compatibility-mode retry per run when translations are lost.
QC_MAX_RETRIES = 1

BABELDOC_FALLBACKS = [
    Path.home() / ".local" / "bin" / "babeldoc.exe",
    Path.home() / ".local" / "bin" / "babeldoc",
]

STAGE_BOUNDS = [
    ("解析版面", 0, 12),
    ("提取术语", 12, 30),
    ("翻译正文", 30, 82),
    ("排版生成", 82, 97),
    ("收尾", 97, 100),
]

# BabelDOC logs its module path (…babeldoc.format.pdf…) on every line, so the
# stage rules match expressive message fragments instead of bare words.
STAGE_RULES = [
    (re.compile(r"translation completed|finish translate|total time", re.I), 4),
    (
        re.compile(
            r"typesetting|add fonts|generate drawing|subset font|save pdf|"
            r"peak memory|translation results|pdf save with clean",
            re.I,
        ),
        3,
    ),
    (
        re.compile(
            r"start to translate|translate paragraphs|error translating|"
            r"try fallback|rate limit|retrying",
            re.I,
        ),
        2,
    ),
    (re.compile(r"glossary|term extraction|extracting terms", re.I), 1),
    (
        re.compile(
            r"parse page layout|parse paragraphs|parse formulas|parse pdf|"
            r"doclayout|ocr|loading onnx",
            re.I,
        ),
        0,
    ),
]

RATIO_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def find_babeldoc(explicit: str = "") -> str | None:
    if explicit and Path(explicit).exists():
        return explicit
    bundled = Path(__file__).resolve().parents[1] / "runtime" / "python.exe"
    if bundled.exists():
        return str(bundled)
    found = shutil.which("babeldoc")
    if found:
        return found
    for candidate in BABELDOC_FALLBACKS:
        if candidate.exists():
            return str(candidate)
    return None


_VERSION_CACHE: dict[str, str] = {}


def _babeldoc_prefix(exe: str) -> list[str]:
    if Path(exe).name.lower() == "python.exe":
        return [exe, "-s", str(Path(__file__).resolve().parents[1] / "tools" / "babeldoc_cli.py")]
    return [exe]


def babeldoc_version(exe: str | None) -> str:
    if not exe:
        return ""
    cached = _VERSION_CACHE.get(exe)
    if cached is not None:
        return cached
    try:
        out = subprocess.run(
            _babeldoc_prefix(exe) + ["--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        text = (out.stdout or out.stderr).strip()
        match = re.search(r"\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?", text)
        version = match.group(0) if match else (text.splitlines()[0] if text else "")
    except Exception:
        version = ""
    _VERSION_CACHE[exe] = version
    return version


REFERENCE_RULE = (
    "Rules:\n"
    "1. Translate ordinary body text into {lang} faithfully, keeping formulas, "
    "citation markers and terminology intact.\n"
    "2. If the text is a bibliography or reference-list entry (for example "
    "\"[1] Smith J. A title. Journal, 2020.\" or \"Gan A, Ross A. ... arXiv:2208.10264\"), "
    "do NOT translate it: return the original text exactly as given.\n"
    "3. Never add notes, explanations or prefixes.\n"
    "Follow all rules strictly."
)


def reference_prompt(base_prompt: str, lang_out: str) -> str:
    role = base_prompt.strip() or (
        f"You are a professional {lang_out} native translator who needs to "
        f"fluently translate text into {lang_out}."
    )
    return f"{role}\n\n{REFERENCE_RULE.format(lang=lang_out)}"


def build_command(
    cfg: dict, files: list[str], exe: str, pages: str | None = None, compat: bool = False
) -> list[str]:
    cmd = _babeldoc_prefix(exe) + [
        "--openai",
        "--openai-model", cfg["model"],
        "--openai-base-url", cfg["base_url"],
    ]
    if cfg.get("api_key"):
        cmd += ["--openai-api-key", cfg["api_key"]]
    if cfg.get("google_free"):
        # The free Google endpoint has no LLM, so skip term extraction and
        # rich-text prompts that would need an instruction-following model.
        cmd += ["--no-auto-extract-glossary", "--disable-rich-text-translate"]
    elif cfg.get("compat_first"):
        # Rich-text placeholders are a common source of missing/blank
        # translated runs on long papers; this is the compatibility fallback
        # BabelDOC documents for such documents.
        cmd.append("--disable-rich-text-translate")
    if compat and "--disable-rich-text-translate" not in cmd:
        # Automatic recovery after a completeness check found lost
        # translations.  Note this does NOT switch BabelDOC to a different
        # translator: 0.6.4 still uses its JSON batch protocol for every
        # LLM-capable translator.  The flag only removes rich-text
        # placeholders, which is the documented compatibility knob for
        # paragraphs that typeset blank; the runtime guard in core/babelguard
        # is what actually prevents empty paragraphs.
        cmd.append("--disable-rich-text-translate")
    if cfg.get("term_model_enabled") and cfg.get("term_model"):
        cmd += ["--openai-term-extraction-model", cfg["term_model"]]

    cmd += [
        "--lang-in", cfg.get("lang_in") or "en",
        "--lang-out", cfg.get("lang_out") or "zh",
        "--output", cfg["output_dir"],
    ]
    for path in files:
        cmd += ["--files", path]

    if pages is None:
        pages = (cfg.get("page_range") or "").strip() if cfg.get("page_mode") == "custom" else ""
    if pages:
        cmd += ["--pages", pages]

    watermark = cfg.get("watermark") or "no_watermark"
    if watermark in {"watermarked", "no_watermark", "both"}:
        cmd += ["--watermark-output-mode", watermark]

    dual_mode = cfg.get("dual_mode") or "side"
    if dual_mode == "alternate":
        cmd.append("--use-alternating-pages-dual")
    elif dual_mode == "mono":
        cmd.append("--no-dual")

    if cfg.get("glossary_paths"):
        cmd += ["--glossary-files", ",".join(cfg["glossary_paths"])]

    if not cfg.get("auto_glossary", True):
        cmd.append("--no-auto-extract-glossary")
    if cfg.get("save_glossary", True):
        cmd.append("--save-auto-extracted-glossary")

    if cfg.get("qps"):
        cmd += ["--qps", str(int(cfg["qps"]))]

    prompt = (cfg.get("custom_prompt") or "").strip()
    if cfg.get("reference_prompt"):
        prompt = reference_prompt(prompt, cfg.get("lang_out") or "zh")
    if prompt:
        cmd += ["--custom-system-prompt", prompt]
    if cfg.get("reference_prompt"):
        # identical output is expected for preserved bibliography entries
        cmd.append("--disable-same-text-fallback")

    if cfg.get("skip_scanned"):
        cmd.append("--skip-scanned-detection")
    if cfg.get("ocr_workaround"):
        cmd.append("--auto-enable-ocr-workaround")

    return cmd


MAX_PAGES = 20000


def parse_page_spec(spec: str) -> list[int]:
    """Parse ``1-5,8`` into a sorted list of page numbers."""
    pages: set[int] = set()
    for chunk in (spec or "").replace("，", ",").split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            head, _, tail = chunk.partition("-")
            try:
                start = int(head) if head.strip() else 1
                end = int(tail) if tail.strip() else MAX_PAGES
            except ValueError:
                continue
            if end < start:
                start, end = end, start
            pages.update(range(max(1, start), min(end, MAX_PAGES) + 1))
        else:
            try:
                value = int(chunk)
            except ValueError:
                continue
            if value > 0:
                pages.add(value)
    return sorted(pages)


def format_page_spec(pages: list[int]) -> str:
    """Compress ``[1,2,3,7]`` back into ``1-3,7``."""
    values = sorted({p for p in pages if p > 0})
    if not values:
        return ""
    parts: list[str] = []
    start = previous = values[0]
    for value in values[1:]:
        if value == previous + 1:
            previous = value
            continue
        parts.append(f"{start}-{previous}" if previous > start else str(start))
        start = previous = value
    parts.append(f"{start}-{previous}" if previous > start else str(start))
    return ",".join(parts)


def plan_runs(cfg: dict, files: list[str]) -> list[dict]:
    """Split the job into babeldoc invocations.

    When 「不翻译参考文献」 is on, every file gets its own run with a page
    range that stops right before the detected bibliography, because the page
    limit is a per-invocation CLI flag.
    """
    custom_pages = (
        parse_page_spec(cfg.get("page_range") or "")
        if cfg.get("page_mode") == "custom"
        else None
    )

    if not cfg.get("skip_references"):
        return [
            {
                "files": list(files),
                "pages": format_page_spec(custom_pages) if custom_pages else "",
                "reference_page": None,
            }
        ]

    runs: list[dict] = []
    manual = cfg.get("reference_page")
    for path in files:
        heading: tuple[int, bool] | None = None
        if manual:
            try:
                heading = (int(manual), True)
            except (TypeError, ValueError):
                heading = None
        if heading is None:
            from . import pdfinfo

            heading = pdfinfo.find_references_heading(path)

        pages = custom_pages
        reference_page = heading[0] if heading else None
        at_top = bool(heading and heading[1])

        if reference_page and reference_page > 1 and at_top:
            limit = reference_page - 1
            selected = [p for p in (pages if pages is not None else range(1, limit + 1)) if p <= limit]
            runs.append(
                {
                    "files": [path],
                    "pages": format_page_spec(selected),
                    "reference_page": reference_page,
                    "skip": not selected,
                }
            )
        elif reference_page:
            # bibliography starts mid-page: keep the whole document but tell the
            # model to leave reference entries untouched
            runs.append(
                {
                    "files": [path],
                    "pages": format_page_spec(pages) if pages else "",
                    "reference_page": reference_page,
                    "prompt_mode": True,
                }
            )
        else:
            runs.append(
                {
                    "files": [path],
                    "pages": format_page_spec(pages) if pages else "",
                    "reference_page": None,
                }
            )
    return runs


def detect_stage(text: str) -> int | None:
    """Return the highest stage index whose pattern matches the log line."""
    best: int | None = None
    for pattern, index in STAGE_RULES:
        if pattern.search(text) and (best is None or index > best):
            best = index
    return best


def detect_ratio(text: str) -> float | None:
    matches = RATIO_RE.findall(text)
    if not matches:
        return None
    current, total = matches[-1]
    try:
        cur, tot = int(current), int(total)
    except ValueError:
        return None
    if tot <= 0 or cur < 0 or cur > tot or tot > 100000:
        return None
    return cur / tot


@dataclass
class Job:
    id: str
    config: dict
    files: list[str]
    command: list[str]
    status: str = "queued"  # queued | running | succeeded | failed | cancelled
    stage: str = "准备中"
    stage_index: int = -1
    progress: float = 0.0
    logs: list[str] = field(default_factory=list)
    seq: int = 0
    trimmed: int = 0
    results: list[dict] = field(default_factory=list)
    error: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    process: subprocess.Popen | None = None
    cancel_requested: bool = False
    runs: list[dict] = field(default_factory=list)
    usage_runs: list[dict] = field(default_factory=list)
    usage_current: dict = field(default_factory=dict)
    quality: dict = field(default_factory=dict)
    _pending_usage: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def add_log(self, line: str) -> None:
        line = line.rstrip("\r\n")
        if not line.strip():
            return
        with self._lock:
            self.logs.append(line)
            self.seq += 1
            if len(self.logs) > 6000:
                drop = 2000
                del self.logs[:drop]
                self.trimmed += drop

            index = detect_stage(line)
            if index is not None and index > self.stage_index:
                self.stage_index = index
                self.stage = STAGE_BOUNDS[index][0]
                self.progress = max(self.progress, float(STAGE_BOUNDS[index][1]))

            ratio = detect_ratio(line)
            if ratio is not None and self.stage_index >= 0:
                base, top = STAGE_BOUNDS[self.stage_index][1], STAGE_BOUNDS[self.stage_index][2]
                self.progress = max(self.progress, base + (top - base) * ratio)

            self._scan_usage(line)

    def _scan_usage(self, line: str) -> None:
        low = line.lower()

        if self._pending_usage:
            digits = re.fullmatch(r"[\d,]+", line.strip())
            if digits:
                self.usage_current[self._pending_usage] = int(
                    line.strip().replace(",", "")
                )
            self._pending_usage = None

        if "term extraction tokens" in low:
            match = re.search(
                r"term extraction tokens:.*?total=(\d+).*?prompt=(\d+).*?"
                r"completion=(\d+).*?cache_hit_prompt=(\d+)",
                line,
                re.I,
            )
            if match:
                self.usage_current["term_total_tokens"] = int(match.group(1))
                self.usage_current["term_prompt_tokens"] = int(match.group(2))
                self.usage_current["term_completion_tokens"] = int(match.group(3))
                self.usage_current["term_cached_tokens"] = int(match.group(4))
            return

        patterns = {
            "cache hit prompt tokens": "cached_tokens",
            "prompt tokens": "prompt_tokens",
            "completion tokens": "completion_tokens",
            "total tokens": "total_tokens",
        }
        for needle, key in patterns.items():
            position = low.find(needle)
            if position < 0:
                continue
            tail = line[position + len(needle):]
            match = re.search(r"[\s:]+([\d,]+)", tail)
            if match:
                self.usage_current[key] = int(match.group(1).replace(",", ""))
            else:
                self._pending_usage = key
            return

    def commit_usage(self) -> None:
        """Fold the current run's token counters into the job total."""
        with self._lock:
            if self.usage_current:
                self.usage_runs.append(dict(self.usage_current))
            self.usage_current = {}
            self._pending_usage = None

    def total_usage(self) -> dict:
        prompt = completion = cached = 0
        for item in list(self.usage_runs) + [self.usage_current]:
            prompt += int(item.get("prompt_tokens") or 0)
            prompt += int(item.get("term_prompt_tokens") or 0)
            completion += int(item.get("completion_tokens") or 0)
            completion += int(item.get("term_completion_tokens") or 0)
            cached += int(item.get("cached_tokens") or 0)
            cached += int(item.get("term_cached_tokens") or 0)
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cached_tokens": cached,
            "total_tokens": prompt + completion,
        }

    def snapshot(self, cursor: int = 0, log_limit: int = 800) -> dict:
        with self._lock:
            start = max(0, cursor - self.trimmed)
            new_lines = self.logs[start:]
            if len(new_lines) > log_limit:
                new_lines = new_lines[-log_limit:]
            usage = self.total_usage()
            cost = pricing.estimate(
                usage,
                self.config.get("model", ""),
                self.config.get("provider", ""),
                {
                    "input": self.config.get("price_input"),
                    "output": self.config.get("price_output"),
                    "currency": self.config.get("price_currency"),
                },
            )
            return {
                "id": self.id,
                "status": self.status,
                "stage": self.stage,
                "progress": round(min(self.progress, 100.0), 1),
                "cursor": self.seq,
                "logs": new_lines,
                "results": self.results,
                "error": self.error,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "usage": usage,
                "cost": cost,
                "quality": self.quality,
                "files": [Path(f).name for f in self.files],
            }


def _snapshot_dir(directory: Path) -> dict[str, float]:
    snapshot: dict[str, float] = {}
    try:
        for path in directory.iterdir():
            if path.is_file():
                snapshot[str(path)] = path.stat().st_mtime_ns
    except OSError:
        pass
    return snapshot


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    index = 2
    while True:
        candidate = path.with_name(f"{path.stem} ({index}){path.suffix}")
        if not candidate.exists():
            return candidate
        index += 1


_BAD_FOLDER_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def paper_folder(stem: str) -> str:
    """The per-paper folder name used inside the output directory.

    One paper can produce several files (译文 / 双语对照 / 术语表), so they are
    kept together in a folder named after the source document instead of being
    scattered across the output directory.
    """
    name = _BAD_FOLDER_CHARS.sub("_", str(stem or "").strip()).strip(" .")
    if len(name) > 80:
        name = name[:80].rstrip(" .")
    return name or "未命名文稿"


def _pretty_target(
    filename: str, source_stems: dict[str, str], lang_out: str
) -> tuple[str, str, str] | None:
    """Map BabelDOC's artefact name to (friendly name, kind, paper stem)."""
    lowered = filename.lower()
    if not lowered.endswith(".pdf"):
        return None
    stem = filename[:-4]
    parts = stem.split(".")
    if len(parts) < 3:
        return None

    kind = parts[-1].lower()
    if kind not in {"mono", "dual"}:
        return None
    if parts[-2].lower() != (lang_out or "").lower():
        return None

    no_watermark = len(parts) >= 4 and parts[-3].lower() == "no_watermark"
    base = ".".join(parts[: -3 if no_watermark else -2])
    if not base:
        return None

    known = source_stems.get(base.lower())
    stem_name = known or base
    label = "译文" if kind == "mono" else "双语对照"
    suffix = "（无水印）" if no_watermark else ""
    return f"{stem_name}_{label}{suffix}.pdf", label, stem_name


def _glossary_target(filename: str, lang_out: str) -> tuple[str, str] | None:
    """(friendly name, paper stem) for BabelDOC's auto-extracted glossary."""
    suffix = ".glossary.csv"
    if not filename.lower().endswith(suffix):
        return None
    stem = filename[: -len(suffix)]
    if lang_out and stem.lower().endswith(f".{lang_out.lower()}"):
        stem = stem[: -(len(lang_out) + 1)]
    if stem.lower().endswith(".no_watermark"):
        stem = stem[: -len(".no_watermark")]
    if not stem:
        return None
    return f"{stem}_术语表.csv", stem


def _move_into_paper(output_dir: Path, stem: str, name: str, path: Path) -> Path:
    """Move one artefact into ``<output>/<paper>/`` and return its new path.

    Folders are reused for the same paper, so translating a document again
    keeps its files together; the file itself gets a ``(2)`` suffix instead of
    overwriting the earlier result.
    """
    try:
        folder = output_dir / paper_folder(stem)
        folder.mkdir(parents=True, exist_ok=True)
        target = _unique_path(folder / name)
        if target != path:
            path.replace(target)
        return target
    except OSError:
        return path


def _read_json(path: Path | None) -> dict | None:
    if path is None:
        return None
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def guard_environment(env: dict, status_path: Path, doc: str) -> dict:
    """Return *env* with the BabelDOC runtime guard enabled for one run.

    The guard lives in ``core/babelguard`` and is imported by the child
    interpreter as ``sitecustomize``; it never touches the installed BabelDOC
    package.  When the guard directory is missing the environment is returned
    unchanged so translation still works.
    """
    if not GUARD_DIR.is_dir():
        return env
    env = dict(env)
    existing = env.get("PYTHONPATH") or ""
    env["PYTHONPATH"] = str(GUARD_DIR) + (
        (os.pathsep + existing) if existing else ""
    )
    env["BABELDOC_STUDIO_GUARD"] = "1"
    env["BABELDOC_STUDIO_GUARD_STATUS"] = str(status_path)
    env["BABELDOC_STUDIO_GUARD_DOC"] = str(doc)
    return env


def new_artifacts(
    output_dir: Path,
    before: dict[str, float],
    source_files: list[str],
    lang_out: str,
) -> list[dict]:
    """PDF artefacts produced since *before*, without moving them yet."""
    source_stems: dict[str, str] = {}
    source_paths: dict[str, str] = {}
    for path in source_files:
        stem = Path(path).stem
        source_stems[stem.lower()] = stem
        source_paths[stem.lower()] = str(path)

    found: list[dict] = []
    try:
        entries = sorted(output_dir.iterdir())
    except OSError:
        return found
    lang = (lang_out or "").lower()
    for path in entries:
        if not path.is_file() or not path.name.lower().endswith(".pdf"):
            continue
        key = str(path)
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            continue
        if key in before and before[key] == mtime:
            continue
        mapping = _pretty_target(path.name, source_stems, lang)
        if not mapping:
            continue
        new_name, kind, paper_stem = mapping
        found.append(
            {
                "path": path,
                "name": new_name,
                "kind": kind,
                "paper_stem": paper_stem,
                "source": source_paths.get(paper_stem.lower(), ""),
            }
        )
    return found


def _verify_artifact(artifact: dict, guard_status: dict | None) -> dict:
    if translate_qa is None:
        return {"ok": True, "checked": False, "missing": [], "warnings": []}
    return translate_qa.verify(
        artifact.get("source", ""),
        artifact["path"],
        artifact["kind"],
        guard_status=guard_status,
    )


def _report_score(report: dict) -> tuple[int, int, int]:
    """Sort key: fewer lost paragraphs, then more translated, then fewer kept."""
    return (
        -len(report.get("missing") or []),
        int(report.get("translated_paragraphs") or 0),
        -len(report.get("untranslated") or []),
    )


def _report_better(candidate: dict, current: dict) -> bool:
    return _report_score(candidate) > _report_score(current)


def _trim_report(report: dict, limit: int = 50) -> dict:
    """Cap long paragraph lists so job snapshots stay small for the UI."""
    trimmed = dict(report)
    for key in ("missing", "untranslated"):
        items = list(report.get(key) or [])
        trimmed[key] = items[:limit]
        trimmed[f"{key}_total"] = len(items)
    warnings = [str(line) for line in report.get("warnings") or []]
    trimmed["warnings"] = warnings[:10]
    return trimmed


def _artifact_key(paper_stem: str, kind: str) -> tuple[str, str]:
    return ((paper_stem or "").lower(), kind or "")


def _spawn_babeldoc(
    job: "Job",
    run: dict,
    output_dir: Path,
    env: dict,
    pages: str,
    compat: bool,
    status_dir: Path | None = None,
) -> tuple[int, Path]:
    """Run one babeldoc invocation and stream its log into the job."""
    directory = status_dir
    if directory is None:
        directory = Path(tempfile.mkdtemp(prefix=QC_TEMP_PREFIX))
    status_path = directory / "guard.json"
    doc = "、".join(Path(f).name for f in run["files"]) or "document"
    run_env = guard_environment(env, status_path, doc)
    command = build_command(
        job.config, run["files"], job.command[0], pages, compat=compat
    )
    job.process = None
    try:
        job.process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=run_env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        assert job.process.stdout is not None
        for line in job.process.stdout:
            job.add_log(line)
        code = job.process.wait()
        job.commit_usage()
    except BaseException:
        # A failed launch must not leave the guard status directory behind.
        shutil.rmtree(directory, ignore_errors=True)
        raise
    return code, status_path


def _check_run(
    job: "Job",
    run: dict,
    output_dir: Path,
    before: dict[str, float],
    env: dict,
    pages: str,
    status_path: Path,
) -> dict:
    """Verify one run's PDFs and recover once in compatibility mode.

    Returns a mapping ``(paper stem, kind) -> verification report`` so the
    final results can carry the report next to the produced file.
    """
    lang_out = job.config.get("lang_out") or "zh"
    reports: dict[tuple[str, str], dict] = {}
    try:
        artifacts = new_artifacts(output_dir, before, run["files"], lang_out)
    except Exception as exc:  # pragma: no cover - defensive
        job.add_log(f"[studio] 译文完整性校验跳过：{exc}")
        return reports
    if not artifacts:
        return reports

    single_file = len(run["files"]) == 1
    status = _read_json(status_path) if single_file else None
    for artifact in artifacts:
        report = _verify_artifact(artifact, status)
        reports[_artifact_key(artifact["paper_stem"], artifact["kind"])] = report
        for line in (translate_qa.summarize(report) if translate_qa else []):
            job.add_log(f"[studio] {line}")

    lost = [r for r in reports.values() if r.get("missing")]
    retries_done = int(run.get("compat_retries") or 0)
    if not lost or job.cancel_requested or retries_done >= QC_MAX_RETRIES:
        if lost:
            job.add_log(
                "[studio] 仍有段落缺译文，任务结果已标记为“译文不完整”，请查看结果提示。"
            )
        return reports

    run["compat_retries"] = retries_done + 1
    job.add_log(
        "[studio] 完整性校验发现缺译文，正在用兼容模式（禁用富文本翻译）重译一次…"
    )
    retry_dir = Path(tempfile.mkdtemp(prefix=QC_TEMP_PREFIX))
    try:
        code, retry_status_path = _spawn_babeldoc(
            job, run, retry_dir, env, pages, compat=True, status_dir=retry_dir
        )
        if code != 0:
            job.add_log(f"[studio] 兼容模式重译失败（退出码 {code}），保留第一次结果。")
            return reports
        retry_status = _read_json(retry_status_path) if single_file else None
        retry_artifacts = new_artifacts(retry_dir, {}, run["files"], lang_out)
        improved = False
        for retry_artifact in retry_artifacts:
            key = _artifact_key(retry_artifact["paper_stem"], retry_artifact["kind"])
            candidate = _verify_artifact(retry_artifact, retry_status)
            current = reports.get(key)
            if current is None or _report_better(candidate, current):
                target = output_dir / retry_artifact["path"].name
                try:
                    shutil.copy2(retry_artifact["path"], target)
                except OSError as exc:  # pragma: no cover - unexpected
                    job.add_log(f"[studio] 无法替换重译结果：{exc}")
                    continue
                reports[key] = candidate
                improved = True
                job.add_log(
                    "[studio] 兼容模式重译后译文更完整："
                    f"缺失 {len(current['missing']) if current else 0} → "
                    f"{len(candidate['missing'])} 段"
                )
        if not improved:
            job.add_log("[studio] 兼容模式重译未改善译文完整性，保留第一次结果。")
    except Exception as exc:  # pragma: no cover - defensive
        job.add_log(f"[studio] 兼容模式重译出错：{exc}")
    finally:
        shutil.rmtree(retry_dir, ignore_errors=True)
    return reports


def collect_results(
    output_dir: Path,
    before: dict[str, float],
    source_files: list[str],
    lang_out: str,
    qc_by_key: dict | None = None,
) -> list[dict]:
    source_paths: dict[str, str] = {}
    for path in source_files:
        source_paths[Path(path).stem.lower()] = str(path)

    results: list[dict] = []
    try:
        entries = list(output_dir.iterdir())
    except OSError:
        entries = []

    # Glossaries keep their own scan: they are not PDF artefacts.
    for path in sorted(entries):
        if not path.is_file() or not path.name.lower().endswith(".glossary.csv"):
            continue
        key = str(path)
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            continue
        if key in before and before[key] == mtime:
            continue
        glossary = _glossary_target(path.name, lang_out)
        if glossary:
            glossary_name, glossary_stem = glossary
            path = _move_into_paper(output_dir, glossary_stem, glossary_name, path)
        results.append(
            {
                "name": path.name,
                "path": str(path),
                "kind": "术语表",
                "size": path.stat().st_size,
                # keep the same result shape as the PDF artefacts
                "blank_pages": [],
                "warning": "",
                "incomplete": False,
            }
        )

    for artifact in new_artifacts(output_dir, before, source_files, lang_out):
        source = artifact.get("source") or source_paths.get(
            artifact["paper_stem"].lower(), ""
        )
        target = _move_into_paper(
            output_dir, artifact["paper_stem"], artifact["name"], artifact["path"]
        )

        # Post-translation quality check: upstream BabelDOC can leave large
        # blank areas.  Best-effort only — a QA failure must never fail the job.
        try:
            qa = pdfqa.inspect_translation(source, target, artifact["kind"])
        except Exception:
            qa = {"blank_pages": [], "warning": ""}
        report = (qc_by_key or {}).get(
            _artifact_key(artifact["paper_stem"], artifact["kind"])
        ) or {}

        missing_pages = sorted(
            {
                int(item.get("page") or 0)
                for item in report.get("missing") or []
                if item.get("page")
            }
        )
        blank_pages = sorted(set(qa.get("blank_pages") or []) | set(missing_pages))
        warnings = [str(line) for line in report.get("warnings") or [] if line]
        if report.get("missing") and not missing_pages:
            # A record without a page number must still be visible to the user.
            warnings.append(
                f"检测到 {len(report['missing'])} 个段落没有译文（页码未知），请检查结果。"
            )
        warning = "；".join(warnings) if warnings else (qa.get("warning") or "")

        payload = {
            "name": target.name,
            "path": str(target),
            "source": source,
            "kind": artifact["kind"],
            "size": target.stat().st_size,
            "blank_pages": blank_pages,
            "warning": warning[:300],
            "incomplete": bool(report.get("missing")),
        }
        if report:
            payload["qc"] = _trim_report(report)
        results.append(payload)
    return results


def _job_quality(results: list[dict]) -> dict:
    """Aggregate the per-result completeness reports for the job snapshot.

    BabelDOC emits both a mono and a dual PDF for the same source document by
    default; both carry the same verification report, so reports are grouped by
    source and the most complete one represents the document instead of being
    summed (which would double count every paragraph).
    """
    groups: dict[str, list[dict]] = {}
    for result in results:
        report = result.get("qc") or {}
        if not report:
            continue
        key = str(result.get("source") or result.get("name") or "")
        groups.setdefault(key, []).append(report)

    missing = untranslated = 0
    checked = False
    pages: set[int] = set()
    warnings: list[str] = []
    for reports in groups.values():
        report = max(
            reports,
            key=lambda item: (
                int(item.get("expected_paragraphs") or 0),
                int(item.get("translated_paragraphs") or 0),
            ),
        )
        if report.get("checked"):
            checked = True
        missing += int(
            report.get("missing_total", len(report.get("missing") or []))
        )
        untranslated += int(
            report.get("untranslated_total", len(report.get("untranslated") or []))
        )
        pages.update(
            int(item.get("page") or 0) for item in report.get("missing") or []
        )
        warnings.extend(str(line) for line in report.get("warnings") or [] if line)
    pages.discard(0)
    return {
        "checked": checked,
        "ok": checked and missing == 0,
        "missing": missing,
        "untranslated": untranslated,
        "pages": sorted(pages),
        "warnings": list(dict.fromkeys(warnings))[:12],
    }


class JobManager:
    """Only one translation runs at a time; new starts are rejected politely."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._current: Job | None = None
        self._lock = threading.Lock()

    @property
    def current(self) -> Job | None:
        return self._current

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def start(self, cfg: dict, files: list[str], exe: str) -> Job:
        with self._lock:
            if self._current and self._current.status in {"queued", "running"}:
                raise RuntimeError("已有翻译任务在运行，请先等待完成或取消。")
            output_dir = Path(cfg["output_dir"])
            output_dir.mkdir(parents=True, exist_ok=True)
            runs = plan_runs(cfg, files)
            if any(run.get("prompt_mode") for run in runs):
                cfg = {**cfg, "reference_prompt": True}
            job = Job(
                id=uuid.uuid4().hex[:12],
                config=dict(cfg),
                files=list(files),
                command=build_command(cfg, files, exe),
                runs=runs,
            )
            job.results = []
            self._jobs[job.id] = job
            self._current = job
            thread = threading.Thread(
                target=self._run, args=(job, output_dir), daemon=True
            )
            thread.start()
            return job

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or not job.process or job.process.poll() is not None:
            return False
        job.cancel_requested = True
        job.add_log("[studio] 正在取消任务…")
        try:
            job.process.terminate()
        except OSError:
            return False
        return True

    def _run(self, job: Job, output_dir: Path) -> None:
        job.status = "running"
        job.stage = "启动 babeldoc"
        # A cached empty model answer is applied without validation by
        # BabelDOC's fallback path and shows up as a blank paragraph; drop
        # those poisoned rows before every run.
        cleared = babelcache.clear_empty_translations()
        if cleared:
            job.add_log(
                f"[studio] 已清理 {cleared} 条空译文缓存（避免再次出现空白译文）"
            )
        before = _snapshot_dir(output_dir)
        env = dict(os.environ)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        env.setdefault("PYTHONUTF8", "1")
        # wide terminal + no colour keeps the captured log readable in the UI
        env["COLUMNS"] = env.get("COLUMNS") or "200"
        env["NO_COLOR"] = "1"
        env["TERM"] = "dumb"
        # BabelDOC may call the local Google-translate shim; never let a system
        # proxy intercept 127.0.0.1.
        env["NO_PROXY"] = "127.0.0.1,localhost"
        env["no_proxy"] = "127.0.0.1,localhost"

        failed_code: int | None = None
        for run in job.runs:
            if job.cancel_requested:
                break
            names = "、".join(Path(f).name for f in run["files"])
            if run.get("skip"):
                job.add_log(
                    f"[studio] {names}：参考文献从第 {run['reference_page']} 页开始，"
                    "前面没有可翻译页面，已跳过。"
                )
                continue

            pages = run.get("pages") or ""
            reference = run.get("reference_page")
            if run.get("prompt_mode"):
                note = f"（第 {reference} 页起为参考文献，改用提示词保留原文）"
            elif reference:
                note = f"（第 {reference} 页起为参考文献，保留原文）"
            else:
                note = ""
            job.add_log(
                f"[studio] 开始处理 {names} · 页面 {pages or '全部'}{note}"
            )
            run_before = _snapshot_dir(output_dir)
            try:
                code, status_path = _spawn_babeldoc(
                    job, run, output_dir, env, pages, compat=False
                )
            except Exception as exc:
                job.status = "failed"
                job.error = f"启动失败：{exc}"
                job.add_log(f"[studio] {job.error}")
                job.finished_at = time.time()
                return

            if job.cancel_requested:
                shutil.rmtree(status_path.parent, ignore_errors=True)
                break
            if code != 0:
                shutil.rmtree(status_path.parent, ignore_errors=True)
                failed_code = code
                break

            # Completeness check after every invocation: lost translations are
            # recovered once in compatibility mode and reported otherwise.
            try:
                run["qc"] = _check_run(
                    job, run, output_dir, run_before, env, pages, status_path
                )
            except Exception as exc:  # pragma: no cover - defensive
                run["qc"] = {}
                job.add_log(f"[studio] 译文完整性校验出错：{exc}")
            finally:
                shutil.rmtree(status_path.parent, ignore_errors=True)

        if job.cancel_requested:
            job.status = "cancelled"
            job.stage = "已取消"
            job.progress = 0.0
            job.add_log("[studio] 任务已取消")
            job.finished_at = time.time()
            return

        if failed_code is None:
            qc_by_key: dict[tuple[str, str], dict] = {}
            for run in job.runs:
                qc_by_key.update(run.get("qc") or {})
            job.results = collect_results(
                output_dir,
                before,
                job.files,
                job.config.get("lang_out", "zh"),
                qc_by_key=qc_by_key,
            )
            job.quality = _job_quality(job.results)
            for line in job.quality.get("warnings") or []:
                job.add_log(f"[studio] {line}")
            job.status = "succeeded"
            job.add_log("[studio] 翻译完成")
            job.stage = "完成"
            job.stage_index = len(STAGE_BOUNDS) - 1
            job.progress = 100.0
            if job.config.get("open_when_done"):
                try:
                    os.startfile(str(output_dir))  # type: ignore[attr-defined]
                except Exception:
                    pass
        else:
            job.status = "failed"
            job.error = f"babeldoc 退出码 {failed_code}"
            job.add_log(f"[studio] 翻译失败，退出码 {failed_code}")
            job.stage = "翻译失败"
        job.finished_at = time.time()

    def mark_cancelled(self, job: Job) -> None:
        job.status = "cancelled"
        job.stage = "已取消"
        job.finished_at = time.time()
