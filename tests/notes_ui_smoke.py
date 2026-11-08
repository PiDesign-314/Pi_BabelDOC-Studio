"""Browser smoke test for the notes panel, library notes view and AI panel resize.

Run:  python tests/notes_ui_smoke.py        (needs playwright + msedge)
"""

import json
import sys
import threading
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import annotations, config

root = Path(".tmp/ui-notes-" + uuid.uuid4().hex[:6]).resolve()
root.mkdir(parents=True, exist_ok=True)
config.APP_DIR = root
config.UPLOAD_DIR = root / "uploads"
annotations.ANNOTATION_DIR = root / "annotations"

pdf = root / "paper.pdf"
doc = pymupdf.open()
page = doc.new_page(width=1000, height=800)
for y in range(80, 720, 26):
    page.insert_text((60, y), "Attention is all you need. Transformer uses self attention.", fontsize=14)
doc.save(pdf)
doc.close()

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1500, "height": 1000})
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    pg.goto(f"{base}/viewer?path={pdf}")
    pg.wait_for_selector(".r-page.painted", timeout=30000)
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(600)

    # 1) 划词高亮：每条高亮按行合并，不应有互相重叠的色块
    box = pg.locator(".r-sheet .r-page").bounding_box()
    pg.mouse.move(box["x"] + 90, box["y"] + 110)
    pg.mouse.down()
    pg.mouse.move(box["x"] + 760, box["y"] + 300, steps=18)
    pg.mouse.up()
    pg.wait_for_selector("#sel-toolbar:not([hidden])", timeout=8000)
    pg.locator('#sel-toolbar .r-dot[data-color="yellow"]').click()
    pg.wait_for_timeout(700)
    stats = pg.evaluate(
        """() => {
            const marks = [...document.querySelectorAll('.r-mark')].map(m => m.getBoundingClientRect());
            let overlaps = 0;
            for (let i = 0; i < marks.length; i += 1) {
              for (let j = i + 1; j < marks.length; j += 1) {
                const a = marks[i], b = marks[j];
                const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (w > 0 && h > 0 && w * h > 4) overlaps += 1;
              }
            }
            return { count: marks.length, overlaps };
        }"""
    )
    assert stats["count"] >= 4, stats
    assert stats["overlaps"] == 0, stats

    # 2) 笔记面板：新建 + 自动保存 + Markdown 预览
    pg.locator("#btn-notes").click()
    pg.wait_for_selector("#notes-drawer:not([hidden])")
    pg.locator("[data-rn-new]").click()
    pg.locator("[data-rn-title]").fill("Transformer 核心机制")
    pg.locator("[data-rn-body]").fill(
        "# 自注意力\n\n- 并行计算\n- 多头注意力\n\n| 组件 | 作用 |\n| --- | --- |\n| QKV | 投影 |"
    )
    pg.wait_for_timeout(1500)
    notes = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes")
    assert len(notes) == 1 and notes[0]["title"] == "Transformer 核心机制"
    assert "自注意力" in notes[0]["body"]
    pg.locator("[data-rn-view=preview]").click()
    pg.wait_for_timeout(200)
    assert pg.locator("[data-rn-preview] table").count() == 1
    assert pg.locator("[data-rn-preview] ul li").count() == 2

    # 3) 右侧 AI 面板可拖动调宽
    pg.locator("#btn-ai").click()
    pg.wait_for_selector("#ai-drawer:not([hidden])")
    pg.wait_for_timeout(300)
    width_before = pg.evaluate("document.querySelector('#ai-drawer').getBoundingClientRect().width")
    handle = pg.locator("#ai-resize").bounding_box()
    pg.mouse.move(handle["x"] + 3, handle["y"] + 200)
    pg.mouse.down()
    pg.mouse.move(handle["x"] - 120, handle["y"] + 200, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(300)
    width_after = pg.evaluate("document.querySelector('#ai-drawer').getBoundingClientRect().width")
    assert width_after > width_before + 40

    # 4) 划词 / AI 回答转笔记 + 深链
    pg.evaluate(
        """() => window.ReaderNotes.createFromSelection({
            text: 'Attention is all you need. Transformer uses self attention.',
            parts: [{page: 1, start: 0, end: 10}],
        })"""
    )
    pg.wait_for_timeout(1200)
    pg.evaluate(
        """() => window.ReaderNotes.createFromAI({
            markdown: '## 结论\\n\\nTransformer 完全基于注意力机制。',
            page: 2,
        })"""
    )
    pg.wait_for_timeout(1200)
    notes = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes")
    assert len(notes) == 3
    note_id = notes[0]["id"]
    pg.goto(f"{base}/viewer?path={pdf}&page=2&note={note_id}")
    pg.wait_for_selector("#notes-drawer:not([hidden])", timeout=15000)
    pg.wait_for_timeout(700)
    assert pg.locator("[data-rn-title]").input_value()

    # 5) 结果库「笔记」视图
    pg.goto(f"{base}/library")
    pg.wait_for_timeout(900)
    pg.locator('#view-switch [data-view="notes"]').click()
    pg.wait_for_timeout(900)
    assert pg.locator("#notes-view").is_visible()
    assert "Transformer" in pg.locator("#notes-view").inner_text()

    # 6) 「自动」模型与顶部 Codex 状态同步
    page2 = browser.new_page(viewport={"width": 1440, "height": 1000})
    page2.route(
        "**/api/ai/status*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "providers": [
                        {"id": "codex", "name": "Codex CLI", "available": True, "logged_in": True, "version": "0.9"}
                    ]
                },
                ensure_ascii=False,
            ),
        ),
    )
    page2.on("pageerror", lambda exc: errors.append(str(exc)))
    page2.goto(f"{base}/viewer?path={pdf}")
    page2.wait_for_selector(".r-page.painted", timeout=30000)
    page2.locator("#btn-ai").click()
    page2.wait_for_timeout(900)
    label = page2.locator("#ai-model-btn").inner_text()
    pill = page2.locator("#ai-provider-pill").inner_text()
    assert "Codex" in label and "Codex" in pill

    # 7) AI 回答下方「存为笔记」按钮
    page2.route(
        "**/api/reader/ask*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "answer": "Transformer 完全基于注意力机制，不再依赖循环结构。",
                    "citations": [{"page": 1, "ref": "p1", "snippet": "Attention is all you need."}],
                    "provider": "codex",
                    "model": "gpt-5",
                },
                ensure_ascii=False,
            ),
        ),
    )
    page2.fill("#ai-input", "Transformer 的核心是什么？")
    page2.click("#ai-send")
    page2.wait_for_selector(".r-ai-save-note", timeout=20000)
    page2.locator(".r-ai-save-note").first.click()
    page2.wait_for_timeout(1400)
    count = page2.evaluate("async () => (await (await fetch('/api/notes')).json()).notes.length")
    assert count == 4, count
    browser.close()

assert not errors, errors
print("NOTES UI PASS: markdown notes, library notes view, highlight merge, AI resize, model sync; no JS errors")
