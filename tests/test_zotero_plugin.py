"""Checks for the Zotero 7 add-on under ``tools/zotero-plugin``.

Two layers:

* static checks (manifest fields, bootstrap contract, locales, preference pane,
  XPI layout) that do not need Zotero;
* a wrapper around ``tests/zotero_plugin_harness.mjs``, which loads bootstrap.js
  into a ``vm`` context with mocked Zotero globals and exercises the add-on
  (menus, reader hooks, payload, chooser, launch chain, retry, cleanup).

Zotero itself is not installed on the development machine, so nothing here
talks to a real Zotero.  The behaviour proof is the Node harness.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.dom import minidom

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import zotero  # noqa: E402

PLUGIN_DIR = ROOT / "tools" / "zotero-plugin"
BUILD_SCRIPT = ROOT / "tools" / "build_zotero_plugin.py"
HARNESS = ROOT / "tests" / "zotero_plugin_harness.mjs"
BOOTSTRAP = PLUGIN_DIR / "bootstrap.js"

PLUGIN_ID = "babeldoc-studio@pidesign.local"
EXPECTED_VERSION = "1.0.6"
PREF_KEYS = {
    "extensions.babeldoc.launchInfoPath": "",
    "extensions.babeldoc.appPath": "",
    "extensions.babeldoc.port": "",
    "extensions.babeldoc.autoLaunch": True,
    "extensions.babeldoc.passPage": True,
}
REQUIRED_XPI_FILES = (
    "manifest.json",
    "bootstrap.js",
    "prefs.js",
    "prefs.xhtml",
    "prefsPane.js",
    "README.md",
    "icons/icon-16.svg",
    "icons/icon-20.png",
    "icons/icon-48.png",
    "icons/icon-96.png",
    "locale/zh-CN/babeldoc.ftl",
    "locale/en-US/babeldoc.ftl",
)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _read(relative: str) -> str:
    return (PLUGIN_DIR / relative).read_text(encoding="utf-8")


def _strip_js_comments(source: str) -> str:
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    return re.sub(r"(?<!:)//[^\n]*", "", source)


def _ftl_message_ids(source: str) -> list[str]:
    return re.findall(r"^([a-zA-Z][\w-]*)\s*=", source, flags=re.M)


# --------------------------------------------------------------------------- #
# Manifest / packaging contract
# --------------------------------------------------------------------------- #
def test_manifest_fields():
    manifest = json.loads(_read("manifest.json"))
    assert manifest["manifest_version"] == 2
    assert manifest["version"] == EXPECTED_VERSION
    assert manifest["name"]
    assert manifest["description"]
    assert manifest["author"]

    applications = manifest.get("applications")
    assert isinstance(applications, dict), "Zotero 7 requires applications.zotero"
    zotero_block = applications.get("zotero")
    assert isinstance(zotero_block, dict)
    assert zotero_block["id"] == PLUGIN_ID
    assert zotero_block["strict_min_version"] == "7.0"
    # Zotero 8 moved the item menu to Zotero.MenuManager; the add-on
    # feature-detects it, including the Zotero 10 multi-collection context.
    # Zotero's native loader requires an HTTPS update_url even for manual releases.
    assert zotero_block["strict_max_version"] == "10.*"
    assert zotero_block["update_url"].startswith("https://")
    assert json.loads(_read("updates.json")) == {
        "addons": {PLUGIN_ID: {"updates": []}}
    }

    for size, relative in manifest["icons"].items():
        assert (PLUGIN_DIR / relative).is_file(), f"missing icon {size}: {relative}"


def test_plugin_is_available_to_the_app():
    # This is what activates the /api/zotero/plugin.xpi test in test_zotero.py.
    assert zotero.plugin_available() is True
    assert zotero.plugin_version() == EXPECTED_VERSION


def test_xpi_layout():
    data, name = zotero.build_plugin_xpi()
    assert name == f"babeldoc-zotero-{EXPECTED_VERSION}.xpi"
    archive = zipfile.ZipFile(io.BytesIO(data))
    names = set(archive.namelist())

    # Zotero only installs an XPI whose manifest.json is at the zip root.
    assert "manifest.json" in names
    assert not any(n.startswith(("tools/", "zotero-plugin/")) for n in names)
    for required in REQUIRED_XPI_FILES:
        assert required in names, f"missing from XPI: {required}"
    assert not any("__pycache__" in n or n.endswith((".pyc", ".map")) for n in names)

    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    assert manifest["version"] == zotero.plugin_version()
    assert manifest["applications"]["zotero"]["id"] == PLUGIN_ID

    # bootstrap.js must be a classic script: Zotero evaluates it in the
    # bootstrap scope, so import/export statements make it fail to load.
    bootstrap = archive.read("bootstrap.js").decode("utf-8")
    assert not re.search(r"^\s*(import|export)\s", bootstrap, flags=re.M)


# --------------------------------------------------------------------------- #
# bootstrap.js contract
# --------------------------------------------------------------------------- #
def test_bootstrap_exports_lifecycle_functions():
    source = _read("bootstrap.js")
    for function in (
        "startup",
        "shutdown",
        "install",
        "uninstall",
        "onMainWindowLoad",
        "onMainWindowUnload",
    ):
        pattern = rf"^\s*(?:async\s+)?function\s+{function}\s*\("
        assert re.search(pattern, source, flags=re.M), f"bootstrap.js must define {function}()"
        # ... and export it as a bootstrap-scope global at the bottom of the file.
        assert re.search(rf"^var\s+{function}\s*=\s*BabelDOCBridge\.{function};", source, flags=re.M)


def test_bootstrap_uses_the_documented_api_surface():
    code = _strip_js_comments(_read("bootstrap.js"))

    # Zotero 7 paths
    assert 'getElementById("zotero-itemmenu")' in code
    assert "popupshowing" in code
    assert 'registerEventListener("renderToolbar"' in code
    assert 'registerEventListener("createViewContextMenu"' in code
    assert "Zotero.MenuManager" in code  # feature detection for Zotero 8

    # HTTP contract: fast failure + readable error bodies.
    assert "errorDelayMax: 0" in code
    assert "successCodes: false" in code
    assert "/api/zotero/open" in code
    assert "/api/health" in code
    # The app opens the reader window itself; the add-on must not disable it.
    assert "open_window" not in code

    # Page numbers are converted to the server's 1-based scheme.
    assert "pageIndex + 1" in code
    assert "getFilePathAsync" in code
    assert "getAttachmentLastPageIndex" in code

    # Launch chain and retry UI
    assert "Zotero.Utilities.Internal.exec" in code
    assert '"/c", "start"' in code
    assert "--server-only" in code
    assert "confirmEx" in code
    assert "Services.prompt.select" in code or "prompt.select" in code

    # Lifecycle hygiene
    assert "removeEventListener" in code
    assert 'removeFTL' in code

    # APIs removed in Zotero 8 must not be used (the comments name them).
    for removed in ("Zotero.spawn", "hiddenDOMWindow"):
        assert removed not in code, f"Zotero 8 removed {removed}"
    assert "unregisterEventListener(" not in code, (
        "Zotero 7.0.x unregisterEventListener() keeps the matching listener; "
        "rely on Zotero's pluginID cleanup instead"
    )


# --------------------------------------------------------------------------- #
# Localisation + preference pane
# --------------------------------------------------------------------------- #
def test_fluent_locales():
    zh = _read("locale/zh-CN/babeldoc.ftl")
    en = _read("locale/en-US/babeldoc.ftl")
    assert "在 ReadPI 中阅读" in zh
    assert "Read in ReadPI" in en
    assert ".label =" in zh and ".label =" in en
    zh_ids = _ftl_message_ids(zh)
    en_ids = _ftl_message_ids(en)
    assert zh_ids, "no Fluent messages found"
    assert zh_ids == en_ids, "zh-CN and en-US must expose the same message ids"
    assert all(message_id.startswith("babeldoc-") for message_id in zh_ids), (
        "Fluent ids live in a shared namespace and need the plugin prefix"
    )


def test_preference_defaults():
    source = _read("prefs.js")
    found: dict[str, object] = {}
    for key, raw in re.findall(r'pref\(\s*"([^"]+)"\s*,\s*(.+?)\s*\);', source):
        raw = raw.strip()
        if raw == "true":
            value: object = True
        elif raw == "false":
            value = False
        elif re.fullmatch(r"-?\d+", raw):
            value = int(raw)
        elif raw.startswith('"') and raw.endswith('"'):
            value = raw[1:-1]
        else:  # pragma: no cover - defensive
            raise AssertionError(f"unsupported default value: {raw}")
        found[key] = value
    assert found == PREF_KEYS


def test_preference_pane_fragment_and_script():
    fragment = _read("prefs.xhtml")
    # The comment at the top explains the rule and therefore names it; only the
    # real markup matters.
    markup = re.sub(r"<!--.*?-->", "", fragment, flags=re.S)
    assert "<!DOCTYPE" not in markup, "preference pane fragments must not contain a DOCTYPE"
    # Well-formed XML (Zotero parses the fragment as XML with XUL + HTML namespaces).
    minidom.parseString(fragment)

    for key in PREF_KEYS:
        assert f'preference="{key}"' in fragment, f"pane does not bind {key}"
    assert "<checkbox" in fragment
    assert "<html:input" in fragment
    assert 'id="babeldoc-status"' in fragment
    assert "BabeldocPrefs.test()" in fragment, "the 检测 button must call the pane script"
    assert "检测" in fragment

    script = _read("prefsPane.js")
    assert "var BabeldocPrefs" in script
    assert "window.BabeldocPrefs" in script, "Zotero 8 runs pane scripts in a separate global"
    assert re.search(r"async\s+test\s*\(", script), "the pane needs a connection test"
    assert re.search(r"async\s+browseLauncher\s*\(", script)
    assert re.search(r"async\s+browseLaunchInfo\s*\(", script)
    assert "/api/health" in script
    assert "/api/zotero/status" in script


def test_readme_documents_install_and_risks():
    readme = _read("README.md")
    assert "Tools → Plugins" in readme
    assert "launch-info.json" in readme
    assert "已知风险" in readme


# --------------------------------------------------------------------------- #
# Build script
# --------------------------------------------------------------------------- #
def test_build_script_writes_xpi(tmp_path):
    result = subprocess.run(
        [sys.executable, str(BUILD_SCRIPT), "--out-dir", str(tmp_path)],
        cwd=str(tmp_path),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    target = tmp_path / f"babeldoc-zotero-{EXPECTED_VERSION}.xpi"
    assert target.is_file(), f"expected {target}"
    assert str(target) in result.stdout
    with zipfile.ZipFile(target) as archive:
        assert "manifest.json" in archive.namelist()
        assert archive.read("manifest.json")


def test_build_script_check_mode():
    result = subprocess.run(
        [sys.executable, str(BUILD_SCRIPT), "--check"],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert "manifest.json is at the zip root" in result.stdout


@pytest.mark.parametrize("url", [None, "", "http://localhost/updates.json", "data:application/json,{}"])
def test_build_rejects_missing_or_insecure_update_url(url):
    from tools.build_zotero_plugin import verify_archive
    data, _ = zotero.build_plugin_xpi()
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(output, "w") as target:
        for name in source.namelist():
            content = source.read(name)
            if name == "manifest.json":
                metadata = json.loads(content)
                block = metadata["applications"]["zotero"]
                if url is None:
                    del block["update_url"]
                else:
                    block["update_url"] = url
                content = json.dumps(metadata).encode()
            target.writestr(name, content)
    assert any("update_url" in problem for problem in verify_archive(output.getvalue()))


# --------------------------------------------------------------------------- #
# Node harness (mocked Zotero)
# --------------------------------------------------------------------------- #
def _node_executable() -> str | None:
    return shutil.which("node") or shutil.which("node.exe")


def test_node_harness_passes():
    node = _node_executable()
    if not node:
        pytest.skip("Node.js is not installed; the mocked-Zotero harness cannot run")
    assert HARNESS.is_file(), "tests/zotero_plugin_harness.mjs is missing"
    result = subprocess.run(
        [node, str(HARNESS)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    output = (result.stdout or "") + (result.stderr or "")
    assert result.returncode == 0, f"Zotero add-on harness failed:\n{output}"
    assert "harness checks passed" in output
    assert "not ok -" not in output


def test_javascript_files_parse():
    node = _node_executable()
    if not node:
        pytest.skip("Node.js is not installed; cannot syntax-check the add-on scripts")
    for name in ("bootstrap.js", "prefsPane.js"):
        result = subprocess.run(
            [node, "--check", str(PLUGIN_DIR / name)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        assert result.returncode == 0, f"{name} has a syntax error:\n{result.stderr}"


def main() -> None:
    raise SystemExit(pytest.main([__file__, "-q"]))


if __name__ == "__main__":
    main()
