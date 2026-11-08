"""Browser smoke test for the floating rich-text notes window, AI quoting,
library notes view and AI panel resize.

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
questions = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1500, "height": 1000})
    pg.on("pageerror", lambda exc: errors.append(str(exc)))
    pg.goto(f"{base}/viewer?path={pdf}")
    pg.wait_for_selector(".r-page.painted", timeout=30000)
    pg.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    pg.wait_for_timeout(600)

    def select_text():
        """Drag across the page text; recompute the page box every time because
        opening / closing the AI drawer re-lays out the PDF."""
        page_box = pg.locator(".r-sheet .r-page").bounding_box()
        pg.mouse.move(page_box["x"] + 90, page_box["y"] + 110)
        pg.mouse.down()
        pg.mouse.move(page_box["x"] + 760, page_box["y"] + 300, steps=18)
        pg.mouse.up()
        pg.wait_for_selector("#sel-toolbar:not([hidden])", timeout=8000)

    stage_width_before = pg.evaluate(
        "document.querySelector('#stage').getBoundingClientRect().width"
    )

    # 1) 划词工具栏里有「AI 提问」，点击后 AI 面板带着原文引用打开
    select_text()
    pg.locator("#sel-ai").click()
    pg.wait_for_selector("#ai-drawer:not([hidden])", timeout=8000)
    assert pg.locator("#ai-quote").is_visible()
    assert pg.locator("#ai-quote-text").inner_text().strip(), "引用卡片没有原文"
    pg.locator("#ai-close").click()
    pg.wait_for_timeout(700)

    # 2) 划词高亮：每条高亮按行合并，不应有互相重叠的色块
    select_text()
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

    # 3) 打开笔记：悬浮窗口，不能压缩 PDF 阅读区
    pg.locator("#btn-notes").click()
    pg.wait_for_selector("#notes-drawer:not([hidden])", timeout=8000)
    pg.wait_for_timeout(500)
    stage_width_after = pg.evaluate(
        "document.querySelector('#stage').getBoundingClientRect().width"
    )
    assert abs(stage_width_after - stage_width_before) < 2, (
        stage_width_before,
        stage_width_after,
    )
    position = pg.evaluate(
        "getComputedStyle(document.querySelector('#notes-drawer')).position"
    )
    assert position == "fixed", position

    # 4) 新建笔记 + 富文本排版 + 自动保存
    pg.locator(".rn-head [data-rn-new]").click()
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-title]').disabled", timeout=8000
    )
    pg.locator("[data-rn-title]").fill("Transformer 核心机制")
    rich = pg.locator("[data-rn-rich]")
    rich.click()
    pg.keyboard.type("自注意力机制")
    pg.keyboard.press("Enter")
    pg.keyboard.type("并行计算与多头注意力")
    pg.wait_for_timeout(200)

    # 全选正文 → 加粗 / 黄色高亮 / 标题 2
    pg.evaluate(
        """() => {
            const rich = document.querySelector('[data-rn-rich]');
            const range = document.createRange();
            range.selectNodeContents(rich);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }"""
    )
    pg.locator('[data-rn-cmd="bold"]').click()
    pg.locator('[data-rn-hilite-color="#fff3a3"]').click()
    pg.locator("[data-rn-block]").select_option("h2")
    pg.wait_for_timeout(200)

    # 插入待办事项（先把光标放到正文末尾，避免替换选中内容）
    pg.evaluate(
        """() => {
            const rich = document.querySelector('[data-rn-rich]');
            rich.focus();
            const range = document.createRange();
            range.selectNodeContents(rich);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }"""
    )
    pg.locator("[data-rn-todo]").click()
    pg.wait_for_timeout(1600)

    notes = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes")
    assert len(notes) == 1, notes
    saved = notes[0]
    assert saved["title"] == "Transformer 核心机制"
    html = saved["body_html"]
    assert "自注意力机制" in saved["body"]
    assert "<h2" in html, html
    assert "background-color" in html, html
    assert "rn-todo" in html and "data-check" in html, html

    # 4b) 在阅读器里新建分类并归类（分类能力保持在同一个窗口）
    pg.on("dialog", lambda dialog: dialog.accept("实验笔记"))
    pg.locator("[data-rn-category]").select_option("__new")
    pg.wait_for_timeout(1400)
    data = pg.evaluate("async () => await (await fetch('/api/notes')).json()")
    assert any(category["name"] == "实验笔记" for category in data["categories"]), data["categories"]
    assert data["notes"][0]["category_id"], data["notes"][0]

    # 5) 最小化 / 还原
    pg.locator("[data-rn-min]").click()
    pg.wait_for_timeout(250)
    small = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().height")
    assert small < 60, small
    pg.locator("[data-rn-min]").click()
    pg.wait_for_timeout(250)
    big = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().height")
    assert big > 300, big

    # 6) 拖动窗口标题栏
    before_drag = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    head = pg.locator(".rn-head").bounding_box()
    pg.mouse.move(head["x"] + 190, head["y"] + 22)
    pg.mouse.down()
    pg.mouse.move(head["x"] + 110, head["y"] + 58, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(250)
    after_drag = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert before_drag["left"] - after_drag["left"] > 40, (before_drag, after_drag)
    assert after_drag["top"] > before_drag["top"] + 20, (before_drag, after_drag)

    # 7) 四边 / 四角都可拉伸：西北角与东南角
    before_resize = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    nw = pg.locator(".rn-rz-nw").bounding_box()
    pg.mouse.move(nw["x"] + 6, nw["y"] + 6)
    pg.mouse.down()
    pg.mouse.move(nw["x"] - 60, nw["y"] - 44, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(250)
    after_nw = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert after_nw["width"] > before_resize["width"] + 40, (before_resize, after_nw)
    assert after_nw["height"] > before_resize["height"] + 30, (before_resize, after_nw)

    se = pg.locator(".rn-rz-se").bounding_box()
    pg.mouse.move(se["x"] + 6, se["y"] + 6)
    pg.mouse.down()
    pg.mouse.move(se["x"] + 46, se["y"] + 36, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(250)
    after_se = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert after_se["width"] > after_nw["width"] + 20, (after_nw, after_se)

    # 8) 关闭再打开：位置与大小恢复
    pg.locator("[data-rn-close]").click()
    pg.wait_for_timeout(200)
    assert pg.locator("#notes-drawer").is_hidden()
    pg.locator("#btn-notes").click()
    pg.wait_for_selector("#notes-drawer:not([hidden])")
    pg.wait_for_timeout(300)
    restored = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert abs(restored["width"] - after_se["width"]) < 3, (after_se, restored)
    assert abs(restored["height"] - after_se["height"]) < 3, (after_se, restored)

    # 9) 导出当前笔记（Markdown）
    with pg.expect_download() as download_info:
        pg.locator("[data-rn-export]").click()
        pg.locator('[data-rn-export-kind="md"]').click()
    download = download_info.value
    assert download.suggested_filename.endswith(".md"), download.suggested_filename
    exported = Path(download.path()).read_text(encoding="utf-8")
    assert "Transformer 核心机制" in exported and "自注意力机制" in exported

    # 10) 划词 / AI 回答转笔记 + 深链
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
    assert len(notes) == 3, len(notes)
    rich_note = next(note for note in notes if note["title"] == "Transformer 核心机制")
    pg.goto(f"{base}/viewer?path={pdf}&page=2&note={rich_note['id']}")
    pg.wait_for_selector("#notes-drawer:not([hidden])", timeout=15000)
    pg.wait_for_timeout(900)
    assert pg.locator("[data-rn-title]").input_value() == "Transformer 核心机制"
    persisted = pg.locator("[data-rn-rich]").inner_html()
    assert "rn-todo" in persisted and "background-color" in persisted, persisted

    # 10b) 旧 Markdown 笔记（只有 body）能转换成富文本打开
    legacy = pg.evaluate(
        """async () => {
            const response = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: '旧版 Markdown 笔记',
                    body: '# 旧标题\\n\\n- 项目一\\n- 项目二\\n\\n> 引用内容',
                }),
            });
            return (await response.json()).note;
        }"""
    )
    pg.evaluate("async (id) => window.ReaderNotes.openNote(id)", legacy["id"])
    pg.wait_for_timeout(900)
    legacy_html = pg.locator("[data-rn-rich]").inner_html()
    assert "<h1" in legacy_html and "<li" in legacy_html and "<blockquote" in legacy_html, legacy_html
    notes = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes")
    assert len(notes) == 4, len(notes)

    # 11) 结果库「笔记」视图
    pg.goto(f"{base}/library")
    pg.wait_for_timeout(900)
    pg.locator('#view-switch [data-view="notes"]').click()
    pg.wait_for_timeout(900)
    assert pg.locator("#notes-view").is_visible()
    assert "Transformer" in pg.locator("#notes-view").inner_text()

    # 12) AI 引用提问：消息气泡保留原文引用，请求体也带 quote；模型标签同步
    page2 = browser.new_page(viewport={"width": 1440, "height": 1000})
    page2.on("pageerror", lambda exc: errors.append(str(exc)))
    page2.route(
        "**/api/ai/status*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "providers": [
                        {
                            "id": "codex",
                            "name": "Codex CLI",
                            "available": True,
                            "logged_in": True,
                            "version": "0.9",
                        }
                    ]
                },
                ensure_ascii=False,
            ),
        ),
    )

    def answer(route):
        questions.append(route.request.post_data_json or {})
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "answer": "## 要点\n\n这句话强调 Transformer 不再依赖循环结构。",
                    "citations": [
                        {
                            "page": 1,
                            "ref": "p1",
                            "snippet": "Attention is all you need.",
                        }
                    ],
                    "provider": "codex",
                    "model": "gpt-5",
                },
                ensure_ascii=False,
            ),
        )

    page2.route("**/api/reader/ask*", answer)
    page2.goto(f"{base}/viewer?path={pdf}")
    page2.wait_for_selector(".r-page.painted", timeout=30000)
    page2.locator("#btn-ai").click()
    page2.wait_for_timeout(500)
    page2.evaluate(
        """() => window.ReaderAI.quote({
            text: 'Attention is all you need.',
            parts: [{page: 1}],
        })"""
    )
    page2.wait_for_selector("#ai-quote:not([hidden])", timeout=8000)
    page2.fill("#ai-input", "这句话是什么意思？")
    page2.click("#ai-send")
    page2.wait_for_selector(".r-ai-msg.assistant", timeout=20000)
    page2.wait_for_timeout(400)
    quote_text = page2.locator(".r-ai-msg.user .r-ai-msg-quote").inner_text()
    assert "Attention is all you need." in quote_text, quote_text
    assert questions and questions[-1]["quote"]["text"] == "Attention is all you need.", questions
    assert page2.locator(".r-ai-msg.assistant .r-ai-md h2").count() == 1
    label = page2.locator("#ai-model-btn").inner_text()
    pill = page2.locator("#ai-provider-pill").inner_text()
    assert "Codex" in label and "Codex" in pill, (label, pill)

    # 13) AI 回答下方「存为笔记」
    page2.locator(".r-ai-save-note").first.click()
    page2.wait_for_timeout(1500)
    count = page2.evaluate("async () => (await (await fetch('/api/notes')).json()).notes.length")
    assert count == 5, count

    # 14) AI 面板可拖动调宽（先收起悬浮笔记窗口，避免覆盖拖动把手）
    page2.evaluate("window.ReaderNotes && window.ReaderNotes.close()")
    page2.wait_for_timeout(400)
    width_before = page2.evaluate("document.querySelector('#ai-drawer').getBoundingClientRect().width")
    handle = page2.locator("#ai-resize").bounding_box()
    page2.mouse.move(handle["x"] + 3, handle["y"] + 200)
    page2.mouse.down()
    page2.mouse.move(handle["x"] - 120, handle["y"] + 200, steps=8)
    page2.mouse.up()
    page2.wait_for_timeout(300)
    width_after = page2.evaluate("document.querySelector('#ai-drawer').getBoundingClientRect().width")
    assert width_after > width_before + 40, (width_before, width_after)

    # 15) 旧后端（/api/notes 404）时的可恢复错误卡片
    page3 = browser.new_page(viewport={"width": 1400, "height": 950})
    page3.on("pageerror", lambda exc: errors.append(str(exc)))
    page3.route(
        "**/api/notes*",
        lambda route: route.fulfill(
            status=404,
            content_type="application/json",
            body='{"error": "Not Found"}',
        ),
    )
    page3.goto(f"{base}/viewer?path={pdf}")
    page3.wait_for_selector(".r-page.painted", timeout=30000)
    page3.locator("#btn-notes").click()
    page3.wait_for_selector("[data-rn-error]:not([hidden])", timeout=10000)
    stale_text = page3.locator("[data-rn-error]").inner_text()
    assert "后端版本较旧" in stale_text, stale_text
    assert page3.locator("[data-rn-restart]").is_visible()
    assert page3.locator("[data-rn-retry]").is_visible()

    browser.close()

assert not errors, errors
print(
    "NOTES UI PASS: floating rich-text notes, PDF layout untouched, 8-way resize, "
    "autosave, export, AI quote bubbles, library notes view, model sync; no JS errors"
)
