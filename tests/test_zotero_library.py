"""Zotero snapshot, folder tree, attachment thumbnail and open mode integration."""
from pathlib import Path

import pymupdf
import pytest

import app
from core import config, zotero_library


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "APP_DIR", tmp_path / "app")
    monkeypatch.setattr(config, "UPLOAD_DIR", tmp_path / "uploads")
    return app.app.test_client(), tmp_path


def sample(tmp_path):
    pdf = tmp_path / "zotero" / "storage" / "PAPER" / "paper.pdf"
    pdf.parent.mkdir(parents=True)
    doc = pymupdf.open()
    doc.new_page().insert_text((50, 50), "Zotero paper")
    doc.save(pdf)
    doc.close()
    return pdf, {
        "schema": 1,
        "zotero_version": "10.0.8",
        "libraries": [{"id": 1, "name": "My Library"}],
        "collections": [
            {"id": 7, "library_id": 1, "name": "Robots", "parent_id": 0},
            {"id": 8, "library_id": 1, "name": "Social", "parent_id": 7},
        ],
        "items": [{
            "key": "ITEM0001", "library_id": 1, "title": "Robot study",
            "creators": "Alice Example", "year": "2024", "collections": [8],
            "attachments": [{"key": "PAPER001", "path": str(pdf), "filename": "paper.pdf"}],
        }],
    }


def test_snapshot_roundtrip_and_thumbnail(client):
    browser, folder = client
    pdf, body = sample(folder)
    assert browser.get("/api/zotero/library").json["missing"] is True
    saved = browser.post("/api/zotero/library", json=body)
    assert saved.status_code == 200, saved.json
    assert saved.json["items"] == 1
    view = browser.get("/api/zotero/library").json
    assert view["items"][0]["title"] == "Robot study"
    assert view["items"][0]["attachment"]["path"] == str(pdf)
    assert {row["id"]: row["count"] for row in view["collections"]} == {7: 1, 8: 1}
    thumb = browser.get("/api/zotero/thumb?library_id=1&item_key=ITEM0001&attachment_key=PAPER001")
    assert thumb.status_code == 200
    assert thumb.data.startswith(b"\x89PNG")
    assert browser.get("/api/zotero/thumb?library_id=1&item_key=OTHER&attachment_key=PAPER001").status_code == 404
    assert browser.post("/api/zotero/panel", json={"route": "library", "open_window": False}).json["route"] == "/library?source=zotero"


def test_read_imports_and_translate_requires_settings(client, monkeypatch):
    browser, folder = client
    pdf, body = sample(folder)
    browser.post("/api/zotero/library", json=body)
    request = {"path": str(pdf), "library_id": "1", "item_key": "ITEM0001",
               "attachment_key": "PAPER001", "open_window": False}
    read = browser.post("/api/zotero/open", json={**request, "mode": "read"})
    assert read.status_code == 200, read.json
    assert read.json["url"].startswith("/viewer?")
    monkeypatch.setattr(app, "_start_job", lambda settings: (_ for _ in ()).throw(
        app._JobStartError("No provider", code="provider_not_configured")))
    translate = browser.post("/api/zotero/open", json={**request, "mode": "translate"})
    assert translate.status_code == 400
    assert translate.json["code"] == "provider_not_configured"
    assert browser.post("/api/zotero/open", json={**request, "mode": "other"}).status_code == 400


def test_translate_returns_progress_url(client, monkeypatch):
    browser, folder = client
    pdf, body = sample(folder)
    browser.post("/api/zotero/library", json=body)
    monkeypatch.setattr(app, "_start_job", lambda settings: type("Job", (), {"id": "test-job-1"})())
    result = browser.post("/api/zotero/open", json={
        "path": str(pdf), "library_id": "1", "item_key": "ITEM0001",
        "attachment_key": "PAPER001", "mode": "translate", "open_window": False,
    })
    assert result.status_code == 200, result.json
    assert result.json["job_id"] == "test-job-1"
    assert result.json["url"] == "/?job=test-job-1"
