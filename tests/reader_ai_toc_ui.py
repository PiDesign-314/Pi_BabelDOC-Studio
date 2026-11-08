"""Browser smoke test for the two new reader features.

Covers:
  * the auto-detected table of contents (sidebar tab, jump, active section)
  * AI reading: select text -> right click -> quote & ask -> grounded answer
    with [pN] chips that jump back to the quoted page.

Run:  python tests/reader_ai_toc_ui.py          (needs playwright + msedge)

The AI request itself is stubbed in-process, so the test never spends model
quota; only the HTTP plumbing and the UI are exercised.
"""

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


def fake_answer(path, question, quote, history, provider):
    return {
        "answer": FAKE_ANSWER,
        "citations": FAKE_CITATIONS,
        "provider": "codex",
        "model": "test-model",
        "elapsed": 0.2,
        "source": "cli",
    }


ai_reader.answer = fake_answer

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
    cited_pages = page.eval_on_selector_all(
        ".r-ai-cite", "els => els.map((el) => Number(el.dataset.page))"
    )
    assert 2 in cited_pages and 5 in cited_pages, cited_pages
    page.click('.r-ai-cite[data-page="2"]')
    page.wait_for_function("() => document.querySelector('#page-input').value === '2'")
    page.wait_for_timeout(600)

    # ----------------------------------------------------------- dark theme sanity
    page.click("#btn-theme")
    page.wait_for_timeout(300)
    page.screenshot(path=str(root / "ai-answer-dark.png"))

    assert not errors, errors
    print("AI + TOC UI PASS: toc jump, quote menu, grounded answer, citation jump; no JS errors")
    browser.close()
server.shutdown()
