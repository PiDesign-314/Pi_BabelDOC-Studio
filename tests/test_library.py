"""Offline tests for the result library and the annotation store."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import annotations, library  # noqa: E402


@pytest.fixture()
def output_dir(tmp_path, monkeypatch):
    """Point the library at a temporary folder instead of the real settings."""
    monkeypatch.setattr(library, "watched_dirs", lambda: [str(tmp_path)])
    monkeypatch.setattr(library, "_load_extra_dirs", lambda: [])
    return tmp_path


@pytest.fixture()
def annotation_dir(tmp_path, monkeypatch):
    target = tmp_path / "annotations"
    monkeypatch.setattr(annotations, "ANNOTATION_DIR", target)
    return target


def make(path: Path, payload: bytes = b"%PDF-1.4\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def test_scan_groups_artifacts(output_dir):
    make(output_dir / "论文A_译文.pdf")
    make(output_dir / "论文A_双语对照.pdf")
    make(output_dir / "论文A_术语表.csv", b"a,b\n")
    make(output_dir / "论文B_译文（无水印）.pdf")
    make(output_dir / "unrelated.pdf")

    items = library.scan()
    by_name = {item["name"]: item for item in items}

    assert set(by_name) == {"论文A", "论文B"}
    assert [file["kind"] for file in by_name["论文A"]["files"]] == ["译文", "双语对照", "术语表"]
    assert by_name["论文B"]["files"][0]["kind"] == "译文（无水印）"
    assert by_name["论文A"]["size"] > 0
    assert by_name["论文A"]["primary"].endswith("论文A_译文.pdf")


def test_scan_reads_per_paper_folders(output_dir):
    make(output_dir / "论文A" / "论文A_译文.pdf")
    make(output_dir / "论文A" / "论文A_双语对照.pdf")
    make(output_dir / "论文B" / "论文B_术语表.csv", b"a,b\n")

    items = {item["name"]: item for item in library.scan()}

    assert set(items) == {"论文A", "论文B"}
    assert items["论文A"]["dir"] == str((output_dir / "论文A").resolve())
    assert [file["kind"] for file in items["论文A"]["files"]] == ["译文", "双语对照"]
    assert items["论文B"]["files"][0]["kind"] == "术语表"
    assert items["论文A"]["primary"].endswith("论文A_译文.pdf")


def test_rename_renames_the_paper_folder(output_dir, annotation_dir, library_file):
    source = make(output_dir / "旧名" / "旧名_译文.pdf")
    make(output_dir / "旧名" / "旧名_双语对照.pdf")
    annotations.save(str(source), [{"type": "note", "page": 1, "comment": "hi"}])

    result = library.rename(str(source.parent), "旧名", "新名")

    assert result["dir"] == str((output_dir / "新名").resolve())
    assert (output_dir / "新名" / "新名_译文.pdf").exists()
    assert not (output_dir / "旧名").exists()
    # annotations follow the file into the renamed folder
    assert annotations.count(str(output_dir / "新名" / "新名_译文.pdf")) == 1
    assert annotations.count(str(source)) == 0
    assert [item["name"] for item in library.scan()] == ["新名"]


def test_delete_removes_the_empty_paper_folder(output_dir, library_file):
    make(output_dir / "论文A" / "论文A_译文.pdf")

    library.delete(str(output_dir / "论文A"), "论文A")

    assert not (output_dir / "论文A").exists()
    assert library.scan() == []


def test_flat_and_folder_results_coexist(output_dir, library_file):
    make(output_dir / "论文A_译文.pdf")  # result of an older version
    make(output_dir / "论文A" / "论文A_译文.pdf")

    items = library.scan()

    assert len(items) == 2
    assert {item["dir"] for item in items} == {
        str(output_dir.resolve()),
        str((output_dir / "论文A").resolve()),
    }


def test_rename_moves_every_artifact(output_dir, annotation_dir):
    make(output_dir / "旧名_译文.pdf")
    make(output_dir / "旧名_双语对照.pdf")
    annotations.save(str(output_dir / "旧名_译文.pdf"), [{"type": "note", "page": 1, "comment": "hi"}])

    result = library.rename(str(output_dir), "旧名", "新名")

    assert result["renamed"] == 2
    assert (output_dir / "新名_译文.pdf").exists()
    assert (output_dir / "新名_双语对照.pdf").exists()
    assert not (output_dir / "旧名_译文.pdf").exists()
    # annotations follow the file
    moved = annotations.load(str(output_dir / "新名_译文.pdf"))
    assert len(moved["items"]) == 1
    assert annotations.count(str(output_dir / "旧名_译文.pdf")) == 0


def test_rename_rejects_conflicts_and_bad_names(output_dir, annotation_dir):
    make(output_dir / "A_译文.pdf")
    make(output_dir / "B_译文.pdf")

    with pytest.raises(FileExistsError):
        library.rename(str(output_dir), "A", "B")
    with pytest.raises(ValueError):
        library.rename(str(output_dir), "A", "x/y")
    with pytest.raises(ValueError):
        library.rename(str(output_dir), "A", "   ")


def test_annotations_roundtrip_and_sanitising(annotation_dir, tmp_path):
    pdf = make(tmp_path / "doc.pdf")

    saved = annotations.save(
        str(pdf),
        [
            {
                "id": "a1",
                "type": "highlight",
                "page": 2,
                "color": "blue",
                "rects": [{"x": 10, "y": 20, "w": 30, "h": 5}],
                "text": "hello",
                "comment": "note",
            },
            {"type": "highlight", "page": 1, "rects": []},  # dropped: no rects
            {"type": "bogus", "page": 1},  # dropped: unknown kind
        ],
    )

    assert len(saved["items"]) == 1
    loaded = annotations.load(str(pdf))
    assert loaded["items"][0]["color"] == "blue"
    assert loaded["items"][0]["rects"][0]["w"] == 30
    assert annotations.count(str(pdf)) == 1

    annotations.forget(str(pdf))
    assert annotations.count(str(pdf)) == 0


def test_annotations_keep_text_ranges(annotation_dir, tmp_path):
    """Highlights are anchored to character ranges so they survive zooming and
    can run from one page into the next."""
    pdf = make(tmp_path / "ranges.pdf")

    saved = annotations.save(
        str(pdf),
        [
            {
                "type": "highlight",
                "page": 1,
                "color": "pink",
                "ranges": [
                    {"page": 1, "start": 120, "end": 180},
                    {"page": 2, "start": 4, "end": 40},
                    {"page": 3, "start": 9, "end": 9},  # dropped: empty span
                ],
                "text": "跨页高亮",
            }
        ],
    )

    items = saved["items"]
    assert len(items) == 1
    assert [part["page"] for part in items[0]["ranges"]] == [1, 2]
    assert items[0]["ranges"][1]["start"] == 4
    assert items[0]["rects"] == []

    loaded = annotations.load(str(pdf))
    assert loaded["items"][0]["text"] == "跨页高亮"
    assert len(loaded["items"][0]["ranges"]) == 2


def test_document_id_is_stable(annotation_dir, tmp_path):
    pdf = make(tmp_path / "x.pdf")
    first = annotations.document_id(str(pdf))
    second = annotations.document_id(pdf)
    assert first == second and len(first) == 40


def test_library_json_dirs(tmp_path, monkeypatch):
    store = tmp_path / "library.json"
    monkeypatch.setattr(library, "LIBRARY_FILE", store)
    monkeypatch.setattr(library.config, "load_raw", lambda: {"output_dir": str(tmp_path)})

    watched = library.add_dir(str(tmp_path))
    assert str(tmp_path.resolve()) in [str(Path(item)) for item in watched]
    assert json.loads(store.read_text(encoding="utf-8"))["dirs"]

    library.remove_dir(str(tmp_path))
    assert json.loads(store.read_text(encoding="utf-8"))["dirs"] == []


def test_allowed_file_only_inside_watched_folders(tmp_path, monkeypatch):
    import app as studio

    monkeypatch.setattr(studio, "_allowed_roots", lambda: [tmp_path.resolve()])
    inside = make(tmp_path / "a.pdf")
    outside = make(tmp_path.parent / "outside.pdf")

    assert studio._allowed_file(str(inside), (".pdf",)) == inside.resolve()
    assert studio._allowed_file(str(outside), (".pdf",)) is None
    assert studio._allowed_file(str(inside), (".csv",)) is None
    assert studio._allowed_file("", (".pdf",)) is None


def test_watched_folder_accepts_a_paper_subfolder(tmp_path, monkeypatch):
    import app as studio

    monkeypatch.setattr(studio, "_allowed_roots", lambda: [tmp_path.resolve()])
    paper = tmp_path / "论文A"
    paper.mkdir()

    assert studio._is_watched_folder(str(paper)) is True
    assert studio._is_watched_folder(str(paper / "deeper")) is False
    assert studio._is_watched_folder(str(tmp_path)) is True
    assert studio._is_watched_folder("") is False


def test_annotations_api_roundtrip(tmp_path, monkeypatch, annotation_dir):
    import app as studio

    monkeypatch.setattr(studio, "_allowed_roots", lambda: [tmp_path.resolve()])
    pdf = make(tmp_path / "doc.pdf")
    client = studio.app.test_client()

    created = client.post(
        "/api/annotations",
        json={"path": str(pdf), "items": [{"type": "note", "page": 1, "comment": "hi"}]},
    )
    assert created.status_code == 200

    loaded = client.get("/api/annotations", query_string={"path": str(pdf)})
    assert loaded.status_code == 200
    data = loaded.get_json()
    assert len(data["items"]) == 1
    assert data["items"][0]["comment"] == "hi"

    blocked = client.get(
        "/api/annotations", query_string={"path": str(tmp_path.parent / "nope.pdf")}
    )
    assert blocked.status_code == 404


# --------------------------------------------------------------------------- #
# Collections
# --------------------------------------------------------------------------- #
@pytest.fixture()
def library_file(tmp_path, monkeypatch):
    target = tmp_path / "library.json"
    monkeypatch.setattr(library, "LIBRARY_FILE", target)
    return target


def test_collection_lifecycle(library_file):
    entry = library.create_collection("FDM 声学研究")
    assert entry["name"] == "FDM 声学研究"
    assert entry["items"] == []
    assert [item["id"] for item in library.collections()] == [entry["id"]]

    renamed = library.rename_collection(entry["id"], "声学与制造")
    assert renamed["name"] == "声学与制造"

    assert library.delete_collection(entry["id"]) is True
    assert library.collections() == []

    with pytest.raises(FileNotFoundError):
        library.delete_collection(entry["id"])


def test_collection_name_rules(library_file):
    with pytest.raises(ValueError):
        library.create_collection("   ")
    library.create_collection("论文")
    with pytest.raises(ValueError):
        library.create_collection("论文")
    with pytest.raises(ValueError):
        library.create_collection("a/b")
    with pytest.raises(ValueError):
        library.create_collection("x" * 41)


def test_assign_collections_is_exclusive(library_file):
    first = library.create_collection("第一组")
    second = library.create_collection("第二组")

    library.assign_collections("paper-1", [first["id"], second["id"]])
    stored = {entry["name"]: entry["items"] for entry in library.collections()}
    assert stored == {"第一组": ["paper-1"], "第二组": ["paper-1"]}

    library.assign_collections("paper-1", [second["id"]])
    stored = {entry["name"]: entry["items"] for entry in library.collections()}
    assert stored == {"第一组": [], "第二组": ["paper-1"]}

    known = library.assign_collections("paper-1", [])
    assert all(not entry["items"] for entry in known)


def test_scan_exposes_membership(output_dir, library_file):
    make(output_dir / "论文A_译文.pdf")
    make(output_dir / "论文B_译文.pdf")
    entry = library.create_collection("合集")
    item_id = library._item_id(str(output_dir.resolve()), "论文A")
    library.assign_collections(item_id, [entry["id"]])

    items = {item["name"]: item for item in library.scan()}
    assert items["论文A"]["collections"] == [entry["id"]]
    assert items["论文B"]["collections"] == []


def test_rename_keeps_collections(output_dir, annotation_dir, library_file):
    make(output_dir / "旧名_译文.pdf")
    entry = library.create_collection("合集")
    old_id = library._item_id(str(output_dir.resolve()), "旧名")
    library.assign_collections(old_id, [entry["id"]])

    library.rename(str(output_dir), "旧名", "新名")

    items = library.scan()
    assert items[0]["name"] == "新名"
    assert items[0]["collections"] == [entry["id"]]


def test_delete_drops_collections(output_dir, library_file):
    make(output_dir / "论文A_译文.pdf")
    entry = library.create_collection("合集")
    item_id = library._item_id(str(output_dir.resolve()), "论文A")
    library.assign_collections(item_id, [entry["id"]])

    library.delete(str(output_dir), "论文A")

    assert library.collections()[0]["items"] == []


def test_collections_api(tmp_path, monkeypatch, library_file, output_dir):
    import app as studio

    client = studio.app.test_client()

    created = client.post("/api/collections", json={"name": "FDM"})
    assert created.status_code == 200
    collection = created.get_json()["collection"]

    duplicated = client.post("/api/collections", json={"name": "FDM"})
    assert duplicated.status_code == 400

    make(output_dir / "论文A_译文.pdf")
    item_id = library._item_id(str(output_dir.resolve()), "论文A")
    assigned = client.post(
        "/api/collections/assign", json={"item": item_id, "collections": [collection["id"]]}
    )
    assert assigned.status_code == 200
    assert assigned.get_json()["collections"][0]["items"] == [item_id]

    missing = client.post("/api/collections/assign", json={"item": "", "collections": []})
    assert missing.status_code == 400

    renamed = client.post(f"/api/collections/{collection['id']}", json={"name": "FDM 声学"})
    assert renamed.status_code == 200

    deleted = client.delete(f"/api/collections/{collection['id']}")
    assert deleted.status_code == 200
    assert deleted.get_json()["collections"] == []


def test_library_api_includes_collections(output_dir, library_file):
    import app as studio

    make(output_dir / "论文A_译文.pdf")
    entry = library.create_collection("合集")
    item_id = library._item_id(str(output_dir.resolve()), "论文A")
    library.assign_collections(item_id, [entry["id"]])

    client = studio.app.test_client()
    data = client.get("/api/library").get_json()
    assert [item["id"] for item in data["collections"]] == [entry["id"]]
    assert data["items"][0]["collections"] == [entry["id"]]
