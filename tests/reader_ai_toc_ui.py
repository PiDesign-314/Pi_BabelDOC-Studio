"""Browser smoke test for the two new reader features.

Covers:
  * the auto-detected table of contents (sidebar tab, jump, active section)
  * AI reading: select text -> right click -> quote & ask -> grounded answer
    with [pN] chips that jump back to the quoted page.

Run:  python tests/reader_ai_toc_ui.py          (needs playwright + msedge)

The AI request itself is stubbed in-process, so the test never spends model
quota; only the HTTP plumbing and the UI are exercised.
"""

import base64
import sys
import threading
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server

import app
from core import ai_reader, annotations, config

root = Path(".tmp/ui-ai-toc-" + uuid.uuid4().hex[:6]).resolve()
root.mkdir(parents=True, exist_ok=True)
config.UPLOAD_DIR = root
annotations.ANNOTATION_DIR = root / "annotations"

pdf = root / "toc-paper.pdf"
doc = pymupdf.open()
sections = [
    (1, "Abstract", 1),
    (1, "1 Introduction", 1),
    (2, "1.1 Motivation", 2),
    (1, "2 Method", 3),
    (2, "2.1 Sentence Alignment", 4),
    (1, "3 Evaluation", 5),
    (2, "3.2 Ablations", 6),
    (1, "4 Conclusion", 7),
    (1, "References", 8),
]
for page_no in range(1, 9):
    page = doc.new_page(width=595, height=842)
    heading = next((title for level, title, no in sections if no == page_no), f"Page {page_no}")
    page.insert_text((60, 90), heading, fontsize=18)
    for index in range(9):
        y = 130 + index * 26
        page.insert_text(
            (60, y),
            f"Page {page_no} paragraph {index + 1}. "
            "The method links every answer to the sentence that supports it.",
            fontsize=11,
        )
doc.set_toc(sections)
doc.save(pdf)
doc.close()

FAKE_ANSWER = (
    "这段结论有实验支撑 [p2]。\n\n"
    "- 论文在第 2 页给出了对照实验 [p2]\n"
    "- 第 5 页的评测表复现了同样的结论 [p5]\n\n"
    "> 原文：The method links every answer to the sentence that supports it."
)
FAKE_CITATIONS = [
    {"ref": "p2", "page": 2, "section": "1.1 Motivation",
     "snippet": "The method links every answer to the sentence that supports it."},
    {"ref": "p5", "page": 5, "section": "3 Evaluation",
     "snippet": "Page 5 paragraph 1. The method links every answer to the sentence."},
]


captured_requests = []


def fake_answer(path, question, quote, history, provider, images=None):
    captured_requests.append({"question": question, "quote": quote, "images": images or []})
    return {
        "answer": FAKE_ANSWER,
        "citations": FAKE_CITATIONS,
        "provider": "codex",
        "model": "test-model",
        "elapsed": 0.2,
        "source": "cli",
    }


ai_reader.answer = fake_answer

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
shot_path = root / "shot.png"
shot_path.write_bytes(PNG_BYTES)
shot2_path = root / "shot2.png"
shot2_path.write_bytes(PNG_BYTES)

server = make_server("127.0.0.1", 0, app.app, threaded=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"

with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True, args=["--no-proxy-server"])
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(f"{base}/viewer?path=" + str(pdf))
    page.wait_for_selector(".r-page.painted")
    page.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    page.wait_for_timeout(600)

    # ------------------------------------------------------------- table of contents
    page.click('.r-tab[data-tab="toc"]')
    page.wait_for_selector("#panel-toc .r-toc-item", timeout=15000)
    source_text = page.inner_text("#panel-toc .r-toc-source")
    assert "大纲" in source_text or "识别" in source_text, source_text
    items = page.locator("#panel-toc .r-toc-item")
    assert items.count() >= 5, items.count()
    page.click('#panel-toc .r-toc-item[data-page="3"]')
    page.wait_for_function("() => document.querySelector('#page-input').value === '3'")
    page.wait_for_timeout(700)
    assert page.locator('#panel-toc .r-toc-item[data-page="3"]').get_attribute("aria-current") in (
        "true",
        None,
    )
    page.screenshot(path=str(root / "toc.png"))

    # --------------------------------------------------------------- AI quote & ask
    page.wait_for_selector(".r-sheet .r-text span", timeout=30000)
    box = page.evaluate(
        """() => {
          const spans = [...document.querySelectorAll('.r-sheet .r-text span')]
            .map((s) => ({ s, r: s.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 8 && r.top > 0 && r.top < window.innerHeight - 100);
          if (spans.length < 2) return null;
          const first = spans[0].s.firstChild;
          const last = spans[Math.min(3, spans.length - 1)];
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(last.s.firstChild, last.s.firstChild.data.length);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          const r = last.r;
          const ev = new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, button: 2,
            clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
          });
          last.s.dispatchEvent(ev);
          return { text: sel.toString(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }"""
    )
    assert box and box["text"].strip(), "selection failed"
    page.wait_for_selector('#menu [data-menu-act="ai-ask"]', timeout=5000)
    page.click('#menu [data-menu-act="ai-ask"]')
    page.wait_for_selector("#ai-drawer:not([hidden])")
    page.wait_for_selector("#ai-quote:not([hidden])")
    assert page.inner_text("#ai-quote-text").strip()
    page.fill("#ai-input", "这个结论有实验支撑吗？")
    page.click("#ai-send")
    page.wait_for_selector(".r-ai-msg.assistant", timeout=30000)
    page.wait_for_selector('.r-ai-cite[data-page="2"]', timeout=10000)
    page.screenshot(path=str(root / "ai-answer.png"))

    # 消息层级：用户气泡右对齐且与 AI 卡片不同底色；AI 回复有身份标识
    layout = page.evaluate(
        """() => {
          const user = document.querySelector('.r-ai-msg.user');
          const assistant = document.querySelector('.r-ai-msg.assistant');
          const who = assistant ? assistant.querySelector('.r-ai-who') : null;
          const box = document.querySelector('#ai-form .r-ai-box');
          const send = document.querySelector('#ai-send');
          const ur = user.getBoundingClientRect();
          const ar = assistant.getBoundingClientRect();
          const us = getComputedStyle(user);
          const as = getComputedStyle(assistant);
          const bs = box ? getComputedStyle(box) : null;
          const ss = send ? getComputedStyle(send) : null;
          return {
            userBg: us.backgroundColor,
            assistantBg: as.backgroundColor,
            userLeft: ur.left,
            assistantLeft: ar.left,
            userWidth: ur.width,
            assistantWidth: ar.width,
            who: who ? who.textContent : '',
            radius: bs ? parseFloat(bs.borderTopLeftRadius) : 0,
            placeholder: document.querySelector('#ai-input').placeholder,
            sendWidth: ss ? parseFloat(ss.width) : 0,
            sendRadius: ss ? ss.borderTopLeftRadius : '',
            mic: document.querySelectorAll('#ai-form [title*="语音"], #ai-form [data-mic], #ai-form [aria-label*="语音"]').length,
            attach: Boolean(document.querySelector('#ai-attach')),
          };
        }"""
    )
    assert layout["userBg"] != layout["assistantBg"], layout
    assert layout["userLeft"] > layout["assistantLeft"] + 24, layout
    assert layout["userWidth"] < layout["assistantWidth"] * 0.95, layout
    assert "AI 助读" in layout["who"], layout
    assert "Codex" in layout["who"], layout
    assert layout["radius"] >= 20, layout
    assert layout["placeholder"] == "向 AI 提问，或上传图片…", layout
    assert layout["sendWidth"] >= 28 and layout["sendWidth"] <= 34, layout
    assert layout["mic"] == 0 and layout["attach"], layout
    assert captured_requests[-1]["images"] == [], captured_requests[-1]

    cited_pages = page.eval_on_selector_all(
        ".r-ai-cite", "els => els.map((el) => Number(el.dataset.page))"
    )
    assert 2 in cited_pages and 5 in cited_pages, cited_pages
    page.click('.r-ai-cite[data-page="2"]')
    page.wait_for_function("() => document.querySelector('#page-input').value === '2'")
    page.wait_for_timeout(600)

    # 图片附件：上传 → 缩略图预览 → 随问题一起发送 → 发送后清空
    page.set_input_files("#ai-image-file", str(shot_path))
    page.wait_for_selector(".r-ai-attach-item img", timeout=8000)
    assert page.locator(".r-ai-attach-item").count() == 1
    page.fill("#ai-input", "这张截图说明了什么？")
    page.click("#ai-send")
    page.wait_for_function(
        "() => document.querySelectorAll('.r-ai-msg.assistant').length >= 2", timeout=30000
    )
    sent = captured_requests[-1]
    assert sent["images"] and len(sent["images"]) == 1, sent
    assert sent["images"][0]["mime"] == "image/png", sent
    assert page.locator("#ai-attachments").is_hidden(), "发送后应清空图片预览"
    assert page.locator(".r-ai-msg.user").last.locator(".r-ai-msg-images").count() == 1
    page.wait_for_timeout(300)
    page.screenshot(path=str(root / "ai-answer-image.png"))

    # 多图预览 / 单张删除 / 拖拽上传
    page.set_input_files("#ai-image-file", [str(shot_path), str(shot2_path)])
    page.wait_for_function(
        "() => document.querySelectorAll('.r-ai-attach-item').length === 2", timeout=8000
    )
    page.locator(".r-ai-attach-x").first.click()
    page.wait_for_function(
        "() => document.querySelectorAll('.r-ai-attach-item').length === 1", timeout=8000
    )
    page.locator(".r-ai-attach-x").first.click()
    page.wait_for_function(
        "() => document.querySelector('#ai-attachments').hidden", timeout=8000
    )
    page.evaluate(
        """(b64) => {
            const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
            const file = new File([bytes], 'drag.png', { type: 'image/png' });
            const data = new DataTransfer();
            data.items.add(file);
            const form = document.querySelector('#ai-form');
            form.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
            form.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        }""",
        base64.b64encode(PNG_BYTES).decode("ascii"),
    )
    page.wait_for_function(
        "() => document.querySelectorAll('.r-ai-attach-item').length === 1", timeout=8000
    )
    page.locator(".r-ai-attach-x").first.click()
    page.wait_for_function(
        "() => document.querySelector('#ai-attachments').hidden", timeout=8000
    )

    # ----------------------------------------------------------- dark theme sanity
    page.click("#btn-theme")
    page.wait_for_timeout(300)
    page.screenshot(path=str(root / "ai-answer-dark.png"))

    # ------------------------------------------------------- stop generation
    page2 = browser.new_page(viewport={"width": 1400, "height": 1000})
    page2.on("pageerror", lambda exc: errors.append(str(exc)))
    page2.add_init_script(
        """
        var __origFetch = window.fetch.bind(window);
        window.fetch = function (url, options) {
          if (String(url).indexOf('/api/reader/ask') !== -1) {
            return new Promise(function (resolve, reject) {
              var timer = setTimeout(function () {
                __origFetch(url, options).then(resolve, reject);
              }, 6000);
              var signal = options && options.signal;
              if (signal) {
                var abort = function () {
                  clearTimeout(timer);
                  reject(new DOMException('Aborted', 'AbortError'));
                };
                if (signal.aborted) abort();
                else signal.addEventListener('abort', abort);
              }
            });
          }
          return __origFetch(url, options);
        };
        """
    )
    page2.goto(f"{base}/viewer?path=" + str(pdf))
    page2.wait_for_selector(".r-page.painted", timeout=30000)
    page2.wait_for_timeout(400)
    page2.evaluate(
        "() => window.ReaderAI.quote({ text: 'Page 1 paragraph 1.', parts: [{ page: 1 }] })"
    )
    page2.wait_for_selector("#ai-drawer:not([hidden])")
    page2.fill("#ai-input", "慢慢回答一下")
    page2.click("#ai-send")
    page2.wait_for_selector("#ai-send.is-stop", timeout=8000)
    page2.click("#ai-send")
    page2.wait_for_selector(".r-ai-msg.stopped", timeout=10000)
    assert "已停止生成" in page2.locator(".r-ai-msg.stopped").inner_text()
    assert page2.locator(".r-ai-msg.pending").count() == 0
    page2.wait_for_timeout(300)

    assert not errors, errors
    print(
        "AI + TOC UI PASS: toc jump, quote menu, grounded answer, citation jump, "
        "message hierarchy, Claude-style composer, image upload, stop generation; no JS errors"
    )
    browser.close()
server.shutdown()
