"""Build the BabelDOC Studio Zotero add-on into an installable XPI.

The archive is produced by :func:`core.zotero.build_plugin_xpi`, i.e. exactly the
bytes the running app serves from ``GET /api/zotero/plugin.xpi``; this CLI only
writes them to ``dist/`` and verifies the layout Zotero requires (``manifest.json``
at the zip root).

Usage:
    python tools/build_zotero_plugin.py
    python tools/build_zotero_plugin.py --out-dir .tmp/dist
    python tools/build_zotero_plugin.py --check        # verify only, write nothing
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import zotero  # noqa: E402

REQUIRED_ROOT_FILES = (
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "prefs.xhtml",
    "prefsPane.js",
)


def verify_archive(data: bytes) -> list[str]:
    """Return a list of layout problems; empty means the XPI looks installable."""
    problems: list[str] = []
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:  # pragma: no cover - defensive
        return [f"not a valid zip: {exc}"]
    with archive:
        names = archive.namelist()
        for required in REQUIRED_ROOT_FILES:
            if required not in names:
                problems.append(f"missing at zip root: {required}")
        if any(name.startswith("tools/") or name.startswith("zotero-plugin/") for name in names):
            problems.append("archive has an extra leading directory (manifest.json must be at root)")
        if not any(name.startswith("icons/") for name in names):
            problems.append("missing icons/")
        if not any(name.startswith("locale/") for name in names):
            problems.append("missing locale/")
        if "manifest.json" in names:
            try:
                manifest = archive.read("manifest.json").decode("utf-8")
            except (UnicodeDecodeError, KeyError) as exc:  # pragma: no cover - defensive
                problems.append(f"manifest.json is unreadable: {exc}")
            else:
                try:
                    metadata = json.loads(manifest)
                    target = metadata.get("applications", {}).get("zotero", {})
                    for field in ("id", "update_url", "strict_max_version"):
                        if not isinstance(target.get(field), str) or not target[field].strip():
                            problems.append(f"manifest.json requires applications.zotero.{field}")
                    update_url = target.get("update_url", "")
                    if isinstance(update_url, str) and update_url and not update_url.startswith("https://"):
                        problems.append("applications.zotero.update_url must use HTTPS (otherwise Zotero disables the add-on)")
                    if metadata.get("manifest_version") != 2:
                        problems.append("manifest.json requires manifest_version 2")
                except (ValueError, AttributeError, TypeError) as exc:
                    problems.append(f"invalid manifest.json: {exc}")
        for name in names:
            if name.endswith((".pyc", ".map")) or "__pycache__" in name:
                problems.append(f"build artefact leaked into the XPI: {name}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--out-dir",
        default=str(ROOT / "dist"),
        help="directory for the .xpi (default: dist/)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="only verify the generated archive, do not write a file",
    )
    args = parser.parse_args(argv)

    if not zotero.plugin_available():
        print(
            "error: tools/zotero-plugin is incomplete (manifest.json and bootstrap.js are required)",
            file=sys.stderr,
        )
        return 2
    try:
        data, name = zotero.build_plugin_xpi()
    except zotero.ZoteroError as exc:
        print(f"error: {exc.message}", file=sys.stderr)
        return 2

    problems = verify_archive(data)
    if problems:
        print("error: the generated XPI is not installable:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1

    if args.check:
        print(f"ok: {name} ({len(data)} bytes), manifest.json is at the zip root")
        return 0

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / name
    target.write_bytes(data)
    print(target)
    print(f"version {zotero.plugin_version()} | {len(data)} bytes | manifest.json at zip root")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
