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
ai_requests = []

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    pg = browser.new_page(viewport={"width": 1500, "height": 1000})
    pg.on("pageerror", lambda exc: errors.append(str(exc)))

    def ai_polish(route):
        """Fake the note AI endpoint: records every request so the test can
        prove nothing is sent until the user clicks an AI action."""
        ai_requests.append(route.request.post_data_json or {})
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(
                {
                    "result": "Transformer 通过自注意力机制并行处理序列。",
                    "mode": "polish",
                    "provider": "codex",
                    "model": "gpt-5",
                    "elapsed": 0.4,
                },
                ensure_ascii=False,
            ),
        )

    pg.route("**/api/notes/ai/polish*", ai_polish)
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

    # 3b) 笔记列表默认展开；点击「列表」收起后编辑区自动变宽，再点恢复
    assert pg.locator(".rn-list").is_visible()
    editor_open = pg.evaluate(
        "document.querySelector('[data-rn-editor]').getBoundingClientRect().width"
    )
    pg.locator("[data-rn-list]").click()
    pg.wait_for_timeout(220)
    assert pg.locator(".rn-list").is_hidden()
    editor_closed = pg.evaluate(
        "document.querySelector('[data-rn-editor]').getBoundingClientRect().width"
    )
    assert editor_closed > editor_open + 100, (editor_open, editor_closed)
    pg.locator("[data-rn-list]").click()
    pg.wait_for_timeout(220)
    assert pg.locator(".rn-list").is_visible()

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

    # 4a) 手动新建 = 独立笔记：不强制绑定当前 PDF 页面
    assert saved["source"]["path"] == "", saved["source"]
    assert saved["source"]["page"] == 0, saved["source"]
    assert pg.locator("[data-rn-linkbar]").is_visible()
    assert pg.locator("[data-rn-source]").is_hidden()
    # 用户输入 / 自动保存不会偷偷调用 AI
    assert ai_requests == [], ai_requests

    # 4a2) 关联原文 → 回到原文 → 改页码 → 解除关联（内容不丢）
    pg.locator("[data-rn-link]").click()
    pg.wait_for_selector("[data-rn-linkmenu]:not([hidden])", timeout=4000)
    pg.locator('[data-rn-link-act="page"]').click()
    pg.wait_for_timeout(1300)
    linked = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes[0]")
    assert linked["source"]["path"].endswith("paper.pdf"), linked["source"]
    assert linked["source"]["page"] == 1, linked["source"]
    assert pg.locator("[data-rn-source]").is_visible()
    assert "来源：" in pg.locator("[data-rn-goto]").inner_text()
    assert "回到原文" in pg.locator("[data-rn-goto]").inner_text()
    pg.locator("[data-rn-goto]").click()
    pg.wait_for_timeout(700)

    # 修改关联位置：指定页码（用一次性的 prompt stub，之后还原，避免影响分类用例）
    pg.evaluate("() => { window.__origPrompt = window.prompt; window.prompt = () => '2'; }")
    pg.locator("[data-rn-relink]").click()
    pg.wait_for_selector("[data-rn-linkmenu]:not([hidden])", timeout=4000)
    pg.locator('[data-rn-link-act="pick"]').click()
    pg.wait_for_timeout(1300)
    pg.evaluate("() => { window.prompt = window.__origPrompt; }")
    relinked = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes[0]")
    assert relinked["source"]["page"] == 2, relinked["source"]

    # 解除关联：只删关联，不删正文
    pg.locator("[data-rn-unlink]").click()
    pg.wait_for_timeout(1300)
    unlinked = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes[0]")
    assert unlinked["source"] == {
        "path": "", "doc_id": "", "page": 0, "quote": "", "location": "",
    }, unlinked["source"]
    assert "自注意力机制" in unlinked["body"], unlinked["body"]
    assert pg.locator("[data-rn-linkbar]").is_visible()

    # 4b) 在阅读器里新建分类并归类（分类能力保持在同一个窗口）
    pg.on("dialog", lambda dialog: dialog.accept("实验笔记"))
    pg.locator("[data-rn-category]").select_option("__new")
    pg.wait_for_timeout(1400)
    data = pg.evaluate("async () => await (await fetch('/api/notes')).json()")
    assert any(category["name"] == "实验笔记" for category in data["categories"]), data["categories"]
    assert data["notes"][0]["category_id"], data["notes"][0]

    # 5) 最小化 / 还原：紧凑标题栏仍可拖动，一键恢复完整窗口
    pg.locator("[data-rn-min]").click()
    pg.wait_for_timeout(250)
    small = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert small["height"] < 60, small
    # 最小化后不应出现被裁切的正文区域
    assert pg.locator(".rn-main").is_hidden()
    min_head = pg.locator(".rn-head").bounding_box()
    pg.mouse.move(min_head["x"] + 200, min_head["y"] + 22)
    pg.mouse.down()
    pg.mouse.move(min_head["x"] + 140, min_head["y"] + 62, steps=10)
    pg.mouse.up()
    pg.wait_for_timeout(250)
    moved = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert small["left"] - moved["left"] > 40, (small, moved)
    assert moved["top"] > small["top"] + 20, (small, moved)
    assert moved["height"] < 60, moved
    pg.locator("[data-rn-min]").click()
    pg.wait_for_timeout(250)
    big = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().height")
    assert big > 300, big
    assert pg.locator(".rn-main").is_visible()

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

    # 8) 关闭按钮：右上角「×」，悬停提示；关闭只隐藏不删除
    close_box = pg.locator("[data-rn-close]").bounding_box()
    host_box = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert close_box["x"] + close_box["width"] > host_box["left"] + host_box["width"] - 46, (
        close_box,
        host_box,
    )
    assert pg.locator("[data-rn-close]").inner_text().strip() == "×"
    assert pg.locator("[data-rn-close]").get_attribute("title") == "关闭笔记"
    assert pg.locator(".rn-light").count() == 0, "macOS 红黄绿圆点应已移除"

    # 8b) 收起列表 → 关闭 → 重新打开：列表状态被记住，选中笔记与编辑内容保持
    # 关闭前留下未保存的编辑，关闭应先把内容落盘
    pg.locator("[data-rn-rich]").click()
    pg.keyboard.press("Control+End")
    pg.keyboard.type(" 关闭前补充的一句。")
    pg.locator("[data-rn-list]").click()
    pg.wait_for_timeout(220)
    pg.locator("[data-rn-close]").click()
    pg.wait_for_timeout(250)
    assert pg.locator("#notes-drawer").is_hidden()
    pg.wait_for_timeout(1400)
    draft = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes[0]")
    assert "关闭前补充的一句" in draft["body"], draft["body"]
    pg.locator("#btn-notes").click()
    pg.wait_for_selector("#notes-drawer:not([hidden])")
    pg.wait_for_timeout(350)
    assert pg.locator(".rn-list").is_hidden(), "重新打开时应记住列表已收起"
    assert pg.locator("[data-rn-title]").input_value() == "Transformer 核心机制"
    assert "自注意力机制" in pg.locator("[data-rn-rich]").inner_text()
    restored = pg.evaluate("document.querySelector('#notes-drawer').getBoundingClientRect().toJSON()")
    assert abs(restored["width"] - after_se["width"]) < 3, (after_se, restored)
    assert abs(restored["height"] - after_se["height"]) < 3, (after_se, restored)
    pg.locator("[data-rn-list]").click()
    pg.wait_for_timeout(220)
    assert pg.locator(".rn-list").is_visible()

    # 9) 导出当前笔记（Markdown）
    with pg.expect_download() as download_info:
        pg.locator("[data-rn-export]").click()
        pg.locator('[data-rn-export-kind="md"]').click()
    download = download_info.value
    assert download.suggested_filename.endswith(".md"), download.suggested_filename
    exported = Path(download.path()).read_text(encoding="utf-8")
    assert "Transformer 核心机制" in exported and "自注意力机制" in exported

    # 9b) AI 帮写：选中文本 → 建议 / 对比 / 替换 / 撤销
    pg.evaluate(
        """() => {
            const rich = document.querySelector('[data-rn-rich]');
            rich.focus();
            const range = document.createRange();
            range.selectNodeContents(rich);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }"""
    )
    pg.locator("[data-rn-ai]").click()
    pg.wait_for_selector("[data-rn-ai-menu]:not([hidden])", timeout=4000)
    assert "选中文本" in pg.locator("[data-rn-ai-scope]").inner_text()
    # 处理范围可显式切换：选中文本 ⇄ 整篇笔记
    pg.locator("[data-rn-ai-scope]").click()
    assert pg.locator("[data-rn-ai-scope]").inner_text().strip() == "整篇笔记"
    pg.locator("[data-rn-ai-scope]").click()
    assert "选中文本" in pg.locator("[data-rn-ai-scope]").inner_text()
    assert ai_requests == [], "打开菜单 / 输入笔记时不应自动发送内容"
    pg.locator('[data-rn-ai-mode="polish"]').click()
    pg.wait_for_selector("[data-rn-ai-panel]:not([hidden])", timeout=8000)
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-ai-accept]').disabled", timeout=15000
    )
    assert ai_requests and ai_requests[-1]["scope"] == "selection", ai_requests
    assert ai_requests[-1]["mode"] == "polish", ai_requests[-1]
    assert "Transformer 通过自注意力机制" in pg.locator('[data-rn-ai-view="suggest"]').inner_text()
    pg.locator('[data-rn-ai-tab="diff"]').click()
    assert pg.locator('[data-rn-ai-view="diff"] .rn-ins').count() >= 1
    assert pg.locator('[data-rn-ai-view="diff"] .rn-del').count() >= 1
    pg.locator('[data-rn-ai-tab="origin"]').click()
    assert "自注意力机制" in pg.locator('[data-rn-ai-view="origin"]').inner_text()
    pg.locator("[data-rn-ai-accept]").click()
    pg.wait_for_timeout(400)
    replaced = pg.locator("[data-rn-rich]").inner_text()
    assert "Transformer 通过自注意力机制" in replaced, replaced
    # 撤销 AI 修改
    pg.locator("[data-rn-ai]").click()
    pg.wait_for_selector("[data-rn-ai-undo]:not([hidden])", timeout=4000)
    pg.locator("[data-rn-ai-undo]").click()
    pg.wait_for_timeout(400)
    restored_text = pg.locator("[data-rn-rich]").inner_text()
    assert "Transformer 通过自注意力机制" not in restored_text, restored_text
    assert "自注意力机制" in restored_text

    # 9c) 整篇笔记：重新生成 / 插入到下方 / 取消不写入
    pg.evaluate("() => window.getSelection().removeAllRanges()")
    pg.locator("[data-rn-ai]").click()
    pg.wait_for_selector("[data-rn-ai-menu]:not([hidden])", timeout=4000)
    assert "整篇笔记" in pg.locator("[data-rn-ai-scope]").inner_text()
    pg.locator('[data-rn-ai-mode="concise"]').click()
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-ai-accept]').disabled", timeout=15000
    )
    assert ai_requests[-1]["scope"] == "note", ai_requests[-1]
    before_retry = len(ai_requests)
    pg.locator("[data-rn-ai-retry]").click()
    pg.wait_for_timeout(900)
    assert len(ai_requests) > before_retry, ai_requests
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-ai-accept]').disabled", timeout=15000
    )
    pg.locator("[data-rn-ai-insert]").click()
    pg.wait_for_timeout(1600)
    inserted = pg.locator("[data-rn-rich]").inner_text()
    assert inserted.rstrip().endswith("Transformer 通过自注意力机制并行处理序列。"), inserted

    # 取消：不修改正文
    pg.locator("[data-rn-ai]").click()
    pg.locator('[data-rn-ai-mode="fix"]').click()
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-ai-accept]').disabled", timeout=15000
    )
    before_cancel = pg.locator("[data-rn-rich]").inner_text()
    pg.locator("[data-rn-ai-cancel]").click()
    pg.wait_for_timeout(300)
    assert pg.locator("[data-rn-ai-panel]").is_hidden()
    assert pg.locator("[data-rn-rich]").inner_text() == before_cancel

    # 9e) 划词工具栏：高亮色点可见 + AI 入口 → 内联输入要求 → 自定义 AI 建议
    pg.evaluate(
        """() => {
            const rich = document.querySelector('[data-rn-rich]');
            rich.focus();
            const walker = document.createTreeWalker(rich, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            while (node && !node.data.trim()) node = walker.nextNode();
            if (!node) return;
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, Math.min(8, node.data.length));
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }"""
    )
    pg.wait_for_selector(".rn-seltool:not([hidden])", timeout=5000)
    swatches = pg.evaluate(
        """() => [...document.querySelectorAll('.rn-seltool .rn-swatch')]
            .map((el) => getComputedStyle(el).backgroundColor)"""
    )
    assert len(swatches) == 3, swatches
    assert all(color not in ("rgba(0, 0, 0, 0)", "transparent") for color in swatches), swatches
    pg.locator("[data-rn-sel-ai-btn]").click()
    pg.wait_for_selector("[data-rn-sel-prompt]:not([hidden])", timeout=4000)
    pg.fill("[data-rn-sel-input]", "改得更学术一些")
    before_sel_ai = pg.locator("[data-rn-rich]").inner_text()
    pg.locator("[data-rn-sel-run]").click()
    pg.wait_for_selector("[data-rn-ai-panel]:not([hidden])", timeout=8000)
    pg.wait_for_function(
        "() => !document.querySelector('[data-rn-ai-accept]').disabled", timeout=15000
    )
    sel_request = ai_requests[-1]
    assert sel_request["scope"] == "selection", sel_request
    assert sel_request["mode"] == "custom", sel_request
    assert "学术" in sel_request["instruction"], sel_request
    assert pg.locator(".rn-seltool").is_hidden(), "执行后浮动工具栏应收起"
    assert "自定义要求" in pg.locator("[data-rn-ai-panel-mode]").inner_text()
    pg.locator("[data-rn-ai-cancel]").click()
    pg.wait_for_timeout(300)
    assert pg.locator("[data-rn-rich]").inner_text() == before_sel_ai

    # 9d) 切换「本文 / 全部」前会先落盘未保存的输入（不丢 750ms 节流窗口内的文字）
    pg.locator("[data-rn-rich]").click()
    pg.keyboard.press("Control+End")
    pg.keyboard.type(" 切范围前的一句。")
    pg.locator("[data-rn-scope]").click()
    pg.wait_for_timeout(1300)
    scoped = pg.evaluate("async () => (await (await fetch('/api/notes')).json()).notes")
    scoped_note = next(n for n in scoped if n["title"] == "Transformer 核心机制")
    assert "切范围前的一句" in scoped_note["body"], scoped_note["body"]

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
    "NOTES UI PASS: floating rich-text notes, list show/hide + persistence, independent/"
    "linked notes (link / relink / unlink / 回到原文), right-top minimize+close, minimized "
    "drag, drag & 8-way resize, autosave, export, AI 帮写 (selection & whole note, diff, "
    "replace/insert/retry/cancel/undo), AI quote bubbles, library notes view, model sync; "
    "no JS errors"
)
