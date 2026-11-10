"""Offline tests for the annotated-PDF export and its round trip."""

from __future__ import annotations

import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import annotations, pdfexport  # noqa: E402


@pytest.fixture()
def annotation_dir(tmp_path, monkeypatch):
    target = tmp_path / "annotations"
    monkeypatch.setattr(annotations, "ANNOTATION_DIR", target)
    return target


def make_pdf(path: Path, pages: int = 2) -> Path:
    document = pymupdf.open()
    for number in range(pages):
        page = document.new_page(width=600, height=800)
        page.insert_text((72, 100), f"page {number + 1}", fontsize=16)
    document.save(str(path))
    document.close()
    return path


ITEMS = [
    {
        "type": "highlight",
        "page": 1,
        "color": "green",
        "rects": [
            {"x": 70, "y": 86, "w": 120, "h": 14},
            {"x": 70, "y": 106, "w": 90, "h": 14},
        ],
        "text": "page 1",
        "comment": "第一条批注",
    },
    {
        "type": "note",
        "page": 2,
        "color": "pink",
        "point": {"x": 300, "y": 400},
        "comment": "便签内容",
    },
]


def test_default_target_appends_suffix(tmp_path):
    source = tmp_path / "论文_译文.pdf"
    assert pdfexport.default_target(source).name == "论文_译文_批注.pdf"


def test_export_writes_standard_pdf_annotations(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf")
    result = pdfexport.export(source, ITEMS)

    target = Path(result["path"])
    assert target.exists()
    assert target.name == "doc_批注.pdf"
    assert result["highlights"] == 1 and result["notes"] == 1 and result["skipped"] == 0

    with pymupdf.open(target) as document:
        assert document.page_count == 2
        kinds = [annot.type[1] for page in document for annot in page.annots()]
        assert kinds.count("Highlight") == 1
        assert kinds.count("Text") == 1
        highlight = next(document[0].annots())
        assert highlight.info["content"] == "第一条批注"
        assert highlight.info["subject"] == pdfexport.SUBJECT
        assert [round(value, 1) for value in highlight.colors["stroke"]] == [0.4, 0.9, 0.5]


def test_export_and_read_roundtrip(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf")
    result = pdfexport.export(source, ITEMS)
    items = pdfexport.read(result["path"])

    assert [item["type"] for item in items] == ["highlight", "note"]
    assert items[0]["page"] == 1
    assert items[0]["comment"] == "第一条批注"
    assert len(items[0]["rects"]) == 2
    assert items[0]["rects"][0]["x"] == pytest.approx(70, abs=0.5)
    assert items[1]["page"] == 2
    assert items[1]["point"]["x"] == pytest.approx(300, abs=1)
    assert items[1]["point"]["y"] == pytest.approx(400, abs=1)


def test_exported_items_survive_the_annotation_store(tmp_path, annotation_dir):
    source = make_pdf(tmp_path / "doc.pdf")
    exported = pdfexport.export(source, ITEMS)
    imported = pdfexport.read(exported["path"])

    saved = annotations.save(source, imported)
    assert len(saved["items"]) == 2
    loaded = annotations.load(source)
    assert loaded["items"][0]["comment"] == "第一条批注"
    assert loaded["items"][1]["comment"] == "便签内容"


def test_export_skips_impossible_items(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf", pages=1)
    result = pdfexport.export(
        source,
        [
            {"type": "highlight", "page": 9, "rects": [{"x": 1, "y": 1, "w": 9, "h": 9}]},
            {"type": "highlight", "page": 1, "rects": []},
            {"type": "bogus", "page": 1},
        ],
    )
    assert result["count"] == 0
    assert result["skipped"] == 2


def test_read_ignores_foreign_annotations(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf")
    with pymupdf.open(source) as document:
        page = document[0]
        annot = page.add_highlight_annot(pymupdf.Rect(72, 86, 180, 100))
        annot.set_info(title="Someone else", subject="Other tool", content="外部批注")
        annot.update()
        document.save(str(tmp_path / "foreign.pdf"))
    assert pdfexport.read(tmp_path / "foreign.pdf") == []


def test_rect_pages_survive_sanitising(tmp_path, annotation_dir):
    source = make_pdf(tmp_path / "doc.pdf")
    saved = annotations.save(
        source,
        [
            {
                "type": "highlight",
                "page": 1,
                "rects": [
                    {"x": 1, "y": 2, "w": 30, "h": 8, "page": 1},
                    {"x": 3, "y": 300, "w": 40, "h": 8, "page": 2},
                ],
            }
        ],
    )
    rects = saved["items"][0]["rects"]
    assert [rect.get("page") for rect in rects] == [1, 2]


def test_export_api(tmp_path, monkeypatch, annotation_dir):
    import app as studio

    monkeypatch.setattr(studio, "_allowed_roots", lambda: [tmp_path.resolve()])
    source = make_pdf(tmp_path / "doc.pdf")
    annotations.save(source, ITEMS)
    client = studio.app.test_client()

    exported = client.post("/api/annotations/export", json={"path": str(source)})
    assert exported.status_code == 200
    payload = exported.get_json()
    assert payload["count"] == 2
    assert Path(payload["path"]).name == "doc_批注.pdf"

    read = client.get("/api/annotations/pdf", query_string={"path": payload["path"]})
    assert read.status_code == 200
    assert read.get_json()["count"] == 2

    blocked = client.post(
        "/api/annotations/export", json={"path": str(tmp_path.parent / "nope.pdf")}
    )
    assert blocked.status_code == 404


def test_re_export_replaces_our_annotations(tmp_path):
    """Saving again from the exported file overwrites it without duplicating."""
    source = make_pdf(tmp_path / "doc.pdf")
    first = pdfexport.export(source, ITEMS)

    again = pdfexport.export(
        first["path"],
        ITEMS + [{"type": "note", "page": 1, "point": {"x": 200, "y": 200}, "comment": "补充"}],
    )

    assert again["path"] == first["path"]
    assert Path(again["path"]).name == "doc_批注.pdf"
    items = pdfexport.read(again["path"])
    assert [item["type"] for item in items] == ["highlight", "note", "note"]
    assert sum(1 for item in items if item["comment"] == "便签内容") == 1


def test_export_keeps_annotations_from_other_tools(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf")
    with pymupdf.open(source) as document:
        annot = document[0].add_text_annot(pymupdf.Point(300, 300), "外部批注", icon="Comment")
        annot.set_info(title="Other", subject="Other tool")
        annot.update()
        document.save(str(tmp_path / "with-foreign.pdf"))

    result = pdfexport.export(tmp_path / "with-foreign.pdf", ITEMS)
    with pymupdf.open(result["path"]) as document:
        texts = [
            annot.info.get("content", "")
            for page in document
            for annot in (page.annots() or [])
            if annot.type[1] == "Text"
        ]
    assert "外部批注" in texts
    assert "便签内容" in texts


def test_palette_matches_the_reader():
    """Every colour the reader offers must be known to the PDF exporter."""
    assert set(pdfexport.COLORS) == set(annotations.COLORS)
    assert len(annotations.COLORS) == 8


def test_every_palette_colour_survives_the_store_and_the_export(tmp_path, annotation_dir):
    source = make_pdf(tmp_path / "doc.pdf")
    items = [
        {
            "type": "highlight",
            "page": 1,
            "color": colour,
            "rects": [{"x": 70, "y": 86 + index * 20, "w": 120, "h": 14}],
            "comment": colour,
        }
        for index, colour in enumerate(sorted(annotations.COLORS))
    ]
    saved = annotations.save(source, items)
    assert [item["color"] for item in saved["items"]] == sorted(annotations.COLORS)

    result = pdfexport.export(source, saved["items"])
    with pymupdf.open(result["path"]) as document:
        strokes = [
            tuple(round(value, 2) for value in annot.colors.get("stroke", []))
            for page in document
            for annot in (page.annots() or [])
        ]
    assert len(strokes) == 8
    assert all(len(stroke) == 3 for stroke in strokes), strokes
    assert len(set(strokes)) == 8


def test_unknown_colour_falls_back_to_yellow(tmp_path):
    source = make_pdf(tmp_path / "doc.pdf")
    result = pdfexport.export(
        source,
        [{"type": "highlight", "page": 1, "color": "chartreuse", "rects": [{"x": 70, "y": 86, "w": 90, "h": 14}]}],
    )
    with pymupdf.open(result["path"]) as document:
        annot = next(document[0].annots())
        stroke = tuple(round(value, 2) for value in annot.colors["stroke"])
    assert stroke == (1.0, 0.84, 0.1)


def test_custom_hex_colour_tags_survive_the_store_and_the_export(tmp_path, annotation_dir):
    """User-managed colour tags may use a custom #rrggbb colour."""
    source = make_pdf(tmp_path / "doc-hex.pdf")
    item = {
        "type": "highlight",
        "page": 1,
        "color": "#3AA0FF",
        "rects": [{"x": 70, "y": 86, "w": 120, "h": 14}],
        "comment": "待核",
    }
    saved = annotations.save(source, [item])
    assert saved["items"][0]["color"] == "#3aa0ff"

    result = pdfexport.export(source, saved["items"])
    with pymupdf.open(result["path"]) as document:
        annot = next(document[0].annots())
        stroke = tuple(round(value, 3) for value in annot.colors["stroke"])
    assert stroke == (round(0x3A / 255, 3), round(0xA0 / 255, 3), round(0xFF / 255, 3))


def test_drawing_roundtrip(tmp_path, annotation_dir):
    source = make_pdf(tmp_path / 'drawing.pdf')
    items = [
        {'type':'text','page':1,'point':{'x':90,'y':120},'comment':'中文批注 Hello',
         'inkColor':'#126634','fontFamily':'Microsoft YaHei','fontSize':22,'opacity':0.6},
        {'type':'ink','page':1,'point':{'x':30,'y':40},'points':[{'x':30,'y':40},{'x':80,'y':90},{'x':150,'y':40}],
         'inkColor':'#ff0000','width':5,'opacity':0.4},
        {'type':'highlight','page':2,'color':'red','style':'pencil',
         'rects':[{'x':70,'y':86,'w':120,'h':14}]},
    ]
    stored = annotations.save(source, items)['items']
    result = pdfexport.export(source, stored)
    assert result['count'] == 3 and result['skipped'] == 0
    restored = pdfexport.read(result['path'])
    assert restored == stored
    with pymupdf.open(result['path']) as doc:
        assert [a.type[0] for a in doc[0].annots()] == [2,15]
        page = doc[1]
        assert next(page.annots()).type[0] == 9


def test_drawing_fields_are_bounded():
    item = annotations._sanitize([{'type':'ink','page':1,'width':999,'opacity':-3,
        'inkColor':'javascript:bad','fontSize':999,'points':[{'x':-1,'y':float('nan')}]}])[0]
    assert item['width'] == 30 and item['opacity'] == .05
    assert item['inkColor'] == '#30343b' and item['fontSize'] == 96
    assert item['points'] == [{'x':0,'y':0}]


def test_new_highlight_styles_roundtrip(tmp_path, annotation_dir):
    source = make_pdf(tmp_path / 'styles.pdf')
    items = [
        {'type':'highlight','page':1,'color':'green','style':'crayon',
         'rects':[{'x':70,'y':86,'w':120,'h':14}]},
        {'type':'highlight','page':1,'color':'blue','style':'wavy',
         'rects':[{'x':70,'y':120,'w':120,'h':14}]},
        {'type':'highlight','page':1,'color':'red','style':'hand',
         'rects':[{'x':70,'y':154,'w':120,'h':14}]},
        {'type':'highlight','page':1,'color':'pink','style':'hand-soft',
         'rects':[{'x':70,'y':188,'w':120,'h':14}]},
        {'type':'highlight','page':1,'color':'orange','style':'hand-strong',
         'rects':[{'x':70,'y':222,'w':120,'h':14}]},
    ]
    stored = annotations.save(source, items)['items']
    assert [item['style'] for item in stored] == [
        'crayon', 'wavy', 'hand', 'hand-soft', 'hand-strong'
    ]
    # An unknown style must fall back instead of reaching the page.
    assert annotations._sanitize([{'type':'highlight','page':1,'style':'sparkle',
                                  'rects':[{'x':1,'y':1,'w':2,'h':2}]}])[0]['style'] == 'marker'

    result = pdfexport.export(source, stored)
    with pymupdf.open(result['path']) as document:
        types = [annot.type[0] for annot in document[0].annots()]
    # marker-like styles export as highlights, hand/underline styles as underlines
    assert types == [8, 9, 9, 9, 9]
