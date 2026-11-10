"""Offline tests for the Zotero → BabelDOC Studio bridge.

Run:  python -m pytest tests/test_zotero.py -q
       (or python tests/test_zotero.py for a plain run)

The tests never launch a browser window, a real Zotero or an Edge process:
they exercise the link registry, the import/dedupe rules, the page mapping and
the HTTP API that the add-on calls.
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

import pymupdf
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import config, library, zotero  # noqa: E402


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def studio(tmp_path, monkeypatch):
    """Isolated APP_DIR + output folder, so no real user data is touched."""
    appdata = tmp_path / "appdata"
    output = tmp_path / "out"
    output.mkdir(parents=True)
    monkeypatch.setattr(config, "APP_DIR", appdata)
    monkeypatch.setattr(library, "watched_dirs", lambda: [str(output)])
    zotero._hash_cache.clear()
    return {"appdata": appdata, "output": output, "tmp": tmp_path}


def make_pdf(path: Path, pages: int = 4, text: str = "Paper page") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    for index in range(pages):
        page = document.new_page(width=595, height=842)
        page.insert_text((72, 100), f"{text} {index + 1}", fontsize=14)
    document.save(path)
    document.close()
    return path


def source_pdf(tmp_path: Path, name: str = "zotero-paper.pdf", pages: int = 4) -> Path:
    return make_pdf(tmp_path / "zotero-storage" / "ABCD1234" / name, pages=pages)


def open_payload(path: Path, **extra) -> dict:
    payload = {
        "path": str(path),
        "library_id": "1",
        "item_key": "ITEM0001",
        "attachment_key": "ATTACH01",
        "title": "面向家庭社交机器人的空闲行为设计",
        "doi": "10.1145/1234567.7654321",
        "creators": "Arias 等",
        "year": "2026",
    }
    payload.update(extra)
    return payload


# --------------------------------------------------------------------------- #
# Import / dedupe
# --------------------------------------------------------------------------- #
def test_first_import_copies_once_and_reuses_path(studio):
    source = source_pdf(studio["tmp"])
    record, copied = zotero.import_attachment(open_payload(source))
    assert copied is True
    imported = Path(record["imported_path"])
    assert imported.is_file()
    assert imported.suffix.lower() == ".pdf"
    assert not str(imported).startswith(str(source.parent))

    again, copied_again = zotero.import_attachment(open_payload(source))
    assert copied_again is False
    assert again["imported_path"] == record["imported_path"]

    opened = zotero.open_link(open_payload(source))
    assert Path(opened["path"]) == imported
    assert opened["variant"] == "original"
    assert opened["page"] == 1
    assert opened["imported"] is False


def test_same_content_under_new_attachment_keys_shares_managed_copy(studio):
    source = source_pdf(studio["tmp"])
    first, _ = zotero.import_attachment(open_payload(source))
    second, _ = zotero.import_attachment(
        open_payload(source, attachment_key="ATTACH02", item_key="ITEM0002")
    )
    assert first["id"] != second["id"]
    # Same bytes: one managed copy, two links pointing at it.
    assert first["imported_path"] == second["imported_path"]


def test_changed_content_does_not_overwrite_previous_copy(studio):
    source = source_pdf(studio["tmp"], pages=2)
    first, _ = zotero.import_attachment(open_payload(source))
    zotero.report_position(first["imported_path"], 2, 2)
    make_pdf(source, pages=3, text="Replaced paper")
    second, copied = zotero.import_attachment(open_payload(source))
    assert copied is True
    assert second["imported_path"] != first["imported_path"]
    assert Path(first["imported_path"]).is_file()
    assert Path(second["imported_path"]).is_file()
    # A replaced attachment starts a new reading history: the old page cannot
    # be trusted against a different document.
    resumed = zotero.open_link(open_payload(source))
    assert resumed["page"] == 1
    assert Path(resumed["path"]) == Path(second["imported_path"])


def test_metadata_is_kept_and_names_are_windows_safe(studio):
    source = source_pdf(studio["tmp"])
    record, _ = zotero.import_attachment(
        open_payload(source, title="T" * 1000, doi="10.1/x", creators="A; B", year="2026")
    )
    assert len(record["title"]) <= zotero.MAX_TITLE
    assert record["doi"] == "10.1/x"
    imported = Path(record["imported_path"])
    assert imported.is_file()
    # Windows itself rejects these characters in a file name; the sanitiser is
    # also what keeps a Zotero attachment name from escaping our imports folder.
    assert zotero.safe_pdf_name('weird:name*with?"chars.pdf') == "weird_name_with__chars.pdf"
    assert zotero.safe_pdf_name(" ....pdf ") == "paper.pdf"


# --------------------------------------------------------------------------- #
# Missing / invalid attachments
# --------------------------------------------------------------------------- #
def test_missing_attachment_is_retryable(studio):
    missing = studio["tmp"] / "zotero-storage" / "not-downloaded.pdf"
    with pytest.raises(zotero.ZoteroError) as info:
        zotero.import_attachment(open_payload(missing))
    error = info.value
    assert error.code == "file_missing"
    assert error.retryable is True
    assert error.status == 404


def test_missing_path_and_non_pdf_are_explained(studio):
    with pytest.raises(zotero.ZoteroError) as info:
        zotero.import_attachment({"path": ""})
    assert info.value.code == "missing_path"

    not_pdf = studio["tmp"] / "notes.html"
    not_pdf.write_text("<html></html>", encoding="utf-8")
    with pytest.raises(zotero.ZoteroError) as info:
        zotero.import_attachment(open_payload(not_pdf))
    assert info.value.code == "not_pdf"


# --------------------------------------------------------------------------- #
# Reading position + artefact page mapping
# --------------------------------------------------------------------------- #
def test_position_round_trip_on_imported_original(studio):
    source = source_pdf(studio["tmp"], pages=6)
    opened = zotero.open_link(open_payload(source))
    assert opened["page"] == 1

    summary = zotero.report_position(opened["path"], 5, 6)
    assert summary is not None
    assert summary["page"] == 5

    resumed = zotero.open_link(open_payload(source))
    assert resumed["variant"] == "original"
    assert resumed["page"] == 5


def test_translation_artifact_is_remembered_and_reader_page_maps(studio):
    source = source_pdf(studio["tmp"], pages=6)
    opened = zotero.open_link(open_payload(source))
    imported = Path(opened["path"])
    translation = make_pdf(
        studio["output"] / imported.stem / f"{imported.stem}_译文（无水印）.pdf", pages=6
    )

    # Reading the translation from the result library is enough for the next
    # Zotero open to resume there, with no extra user step.
    summary = zotero.report_position(translation, 4, 6)
    assert summary is not None and summary["variant"] == "translation"

    resumed = zotero.open_link(open_payload(source))
    assert Path(resumed["path"]) == translation
    assert resumed["variant"] == "translation"
    assert resumed["page"] == 4

    # Coming from Zotero's own reader: the page number is the *original* one
    # and has to be carried to the translation file (page structure is equal).
    from_reader = zotero.open_link(open_payload(source, page=2, page_total=6))
    assert from_reader["page"] == 2
    assert from_reader["pages"] == 6


def test_alternating_dual_page_mapping_and_clamping(studio):
    source = source_pdf(studio["tmp"], pages=3)
    opened = zotero.open_link(open_payload(source))
    imported = Path(opened["path"])
    dual = make_pdf(
        studio["output"] / imported.stem / f"{imported.stem}_双语对照（无水印）.pdf",
        pages=6,
    )
    zotero.report_position(dual, 3, 6)

    from_reader = zotero.open_link(open_payload(source, page=2, page_total=3))
    assert Path(from_reader["path"]) == dual
    assert from_reader["variant"] == "dual"
    # Alternating dual: original page 2 -> output page 3.
    assert from_reader["page"] == 3

    clamped = zotero.open_link(open_payload(source, page=99, page_total=3))
    assert 1 <= clamped["page"] <= clamped["pages"] == 6


def test_new_translation_overrides_last_read_original(studio):
    source = source_pdf(studio["tmp"], pages=2)
    opened = zotero.open_link(open_payload(source))
    imported = Path(opened["path"])
    zotero.report_position(imported, 2, 2)
    dual = make_pdf(
        studio["output"] / imported.stem / f"{imported.stem}_双语对照.pdf", pages=4
    )
    again = zotero.open_link(open_payload(source))
    assert Path(again["path"]) == dual
    assert again["variant"] == "dual"
    assert again["page"] == 3
    status = zotero.status()
    assert "dual" in status["links"][0]["artifacts"]
    assert Path(dual).is_file()


# --------------------------------------------------------------------------- #
# HTTP API used by the add-on
# --------------------------------------------------------------------------- #
def _test_client(monkeypatch):
    import app as studio

    calls: list[str] = []
    monkeypatch.setattr(studio, "_open_reader_window", lambda url: calls.append(url))
    return studio.app.test_client(), calls


def test_zotero_http_open_position_and_status(studio, monkeypatch):
    source = source_pdf(studio["tmp"], pages=5)
    client, calls = _test_client(monkeypatch)

    response = client.post("/api/zotero/open", json=open_payload(source))
    assert response.status_code == 200, response.get_json()
    data = response.get_json()
    assert data["ok"] is True
    assert data["imported"] is True
    assert data["page"] == 1
    assert data["url"].startswith("/viewer?")
    assert "from=zotero" in data["url"]
    assert calls and calls[0].startswith("/viewer?")

    # The imported copy is inside the folders the app is allowed to serve.
    served = client.get(f"/api/file?path={data['path']}")
    assert served.status_code == 200
    assert served.mimetype == "application/pdf"
    annotations = client.get(f"/api/annotations?path={data['path']}")
    assert annotations.status_code == 200

    position = client.post(
        "/api/zotero/position", json={"path": data["path"], "page": 4, "pages": 5}
    )
    assert position.status_code == 200
    assert position.get_json()["link"]["page"] == 4

    status = client.get("/api/zotero/status").get_json()
    assert status["enabled"] is True
    assert status["link_count"] == 1
    assert status["links"][0]["page"] == 4


def test_zotero_http_open_explains_missing_attachment(studio, monkeypatch):
    client, calls = _test_client(monkeypatch)
    missing = studio["tmp"] / "zotero-storage" / "missing.pdf"
    response = client.post("/api/zotero/open", json=open_payload(missing))
    assert response.status_code == 404
    data = response.get_json()
    assert data["ok"] is False
    assert data["code"] == "file_missing"
    assert data["retryable"] is True
    assert calls == []


def test_zotero_http_position_rejects_unknown_file(studio, monkeypatch):
    client, _calls = _test_client(monkeypatch)
    response = client.post(
        "/api/zotero/position", json={"path": str(studio["tmp"] / "nope.pdf"), "page": 2}
    )
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Launch discovery + add-on package
# --------------------------------------------------------------------------- #
def test_launch_info_is_written_for_the_add_on(studio):
    zotero.write_launch_info(8765, "9.9.9")
    info = zotero.launch_info()
    assert info["port"] == 8765
    assert info["url"] == "http://127.0.0.1:8765"
    assert info["version"] == "9.9.9"
    assert info["script"].endswith("app.py")
    assert zotero.launch_file().is_file()


def test_plugin_xpi_contains_manifest_and_bootstrap(studio, monkeypatch):
    if not zotero.plugin_available():
        pytest.skip("Zotero add-on sources are not present yet")
    client, _calls = _test_client(monkeypatch)
    response = client.get("/api/zotero/plugin.xpi")
    assert response.status_code == 200
    assert response.mimetype == "application/x-xpinstall"
    archive = zipfile.ZipFile(io.BytesIO(response.data))
    names = set(archive.namelist())
    assert "manifest.json" in names
    assert "bootstrap.js" in names
    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    assert manifest["version"] == zotero.plugin_version()
    assert "applications" in manifest


def test_status_reports_plugin_availability(studio):
    status = zotero.status()
    assert status["plugin"]["available"] == zotero.plugin_available()


def main() -> None:
    """Allow ``python tests/test_zotero.py`` without remembering the pytest flag."""
    raise SystemExit(pytest.main([__file__, "-q"]))


if __name__ == "__main__":
    main()
