/* 阅读器笔记：悬浮式富文本编辑器（所见即所得），自动保存，兼容旧 Markdown 笔记。
   公开 API：window.ReaderNotes = { open, close, toggle, openNote,
   createFromSelection, createFromAI, refresh }。 */
(function () {
  "use strict";

  const STORE_GEOMETRY = "babeldoc-notes-window";
  const STORE_SCOPE = "babeldoc-notes-scope";
  const MIN_W = 380;
  const MIN_H = 300;
  const MAX_W = 1000;
  const MAX_H = 1000;

  const state = {
    open: false,
    loaded: false,
    loading: false,
    scope: "doc",
    notes: [],
    categories: [],
    current: null,
    dirty: false,
    saving: false,
    saveTimer: 0,
    query: "",
    stale: false,
    minimized: false,
    listOpen: false,
    revision: 0,
    serverBuild: 0,
    drag: null,
    resize: null,
    geometry: null,
  };

  const el = {};

  /* --------------------------------------------------------------- utils -- */
  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function toast(message, kind) {
    if (window.Studio && typeof window.Studio.toast === "function") {
      window.Studio.toast(message, kind || "");
      return;
    }
    const host = document.getElementById("toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast ${kind || ""}`;
    node.textContent = message;
    host.append(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function readStore(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : raw;
    } catch {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch { /* private mode */ }
  }

  function readJson(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || "null"); } catch { return null; }
  }

  function docPath() {
    if (window.ReaderBridge && typeof window.ReaderBridge.docPath === "string") {
      return window.ReaderBridge.docPath || "";
    }
    try { return new URLSearchParams(location.search).get("path") || ""; } catch { return ""; }
  }

  function docName() {
    const path = docPath();
    if (!path) return "";
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  function fileName(path) {
    const parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  function currentPage() {
    if (window.ReaderBridge && typeof window.ReaderBridge.currentPage === "function") {
      const page = Number(window.ReaderBridge.currentPage());
      if (Number.isFinite(page) && page > 0) return page;
    }
    return 1;
  }

  function whenReady() {
    if (window.ReaderBridge && typeof window.ReaderBridge.whenReady === "function") {
      return Promise.resolve(window.ReaderBridge.whenReady()).catch(() => undefined);
    }
    return Promise.resolve();
  }

  /* ----------------------------------------------------------------- api -- */
  async function api(path, options) {
    const init = Object.assign({}, options || {});
    init.headers = Object.assign({ Accept: "application/json" }, init.headers || {});
    if (init.body && typeof init.body !== "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      const error = new Error("无法连接本地服务，请确认应用仍在运行");
      error.status = 0;
      throw error;
    }
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error((data && data.error) || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  }

  /* ------------------------------------------------------------ markdown -- */
  function inlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" rel="noreferrer noopener">$1</a>'
    );
    return html;
  }

  function splitTableRow(line) {
    return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
  }

  function renderMarkdown(source) {
    const lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (/^\s*$/.test(line)) { index += 1; continue; }

      if (/^\s*```/.test(line)) {
        const buffer = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          buffer.push(lines[index]);
          index += 1;
        }
        index += 1;
        out.push(`<pre><code>${escapeHtml(buffer.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push("<hr>");
        index += 1;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const buffer = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          buffer.push(lines[index].replace(/^\s*>\s?/, ""));
          index += 1;
        }
        out.push(`<blockquote>${inlineMarkdown(buffer.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
        continue;
      }

      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
          items.push(lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
          index += 1;
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag}>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length &&
          /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
        const head = splitTableRow(line);
        index += 2;
        const rows = [];
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
          rows.push(splitTableRow(lines[index]));
          index += 1;
        }
        out.push(
          "<table><thead><tr>" +
          head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table>"
        );
        continue;
      }

      const paragraph = [];
      while (
        index < lines.length &&
        !/^\s*$/.test(lines[index]) &&
        !/^\s*(#{1,6})\s+/.test(lines[index]) &&
        !/^\s*```/.test(lines[index]) &&
        !/^\s*>\s?/.test(lines[index]) &&
        !/^\s*([-*+]|\d+\.)\s+/.test(lines[index]) &&
        !/^\s*\|.*\|\s*$/.test(lines[index])
      ) {
        paragraph.push(lines[index]);
        index += 1;
      }
      out.push(`<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    return out.join("");
  }

  /* ------------------------------------------------------------- sanitize -- */
  const ALLOWED_TAGS = new Set([
    "p", "div", "br", "span", "strong", "b", "em", "i", "u", "s", "strike",
    "del", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
    "hr", "a", "code", "pre", "table", "thead", "tbody", "tr", "td", "th", "mark",
  ]);
  const DROP_TAGS = new Set([
    "script", "style", "iframe", "object", "embed", "svg", "math", "template",
    "link", "meta", "base", "form", "input", "button", "textarea", "select",
  ]);
  const STYLE_ALLOWED = new Set([
    "color", "background-color", "font-weight", "font-style", "text-decoration",
    "text-align",
  ]);

  function cleanStyle(value) {
    const kept = [];
    for (const part of String(value || "").split(";")) {
      const split = part.indexOf(":");
      if (split < 0) continue;
      const prop = part.slice(0, split).trim().toLowerCase();
      const val = part.slice(split + 1).trim();
      if (!STYLE_ALLOWED.has(prop) || !val) continue;
      if (/url\(|expression|javascript:/i.test(val)) continue;
      kept.push(`${prop}: ${val}`);
    }
    return kept.join("; ");
  }

  function cleanAttributes(node, tag) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name === "style") {
        const style = cleanStyle(value);
        if (style) node.setAttribute("style", style);
        else node.removeAttribute("style");
        continue;
      }
      if (name === "href" && tag === "a") {
        if (/^(https?:|mailto:)/i.test(value.trim())) {
          node.setAttribute("href", value.trim());
          node.setAttribute("rel", "noreferrer noopener");
          node.setAttribute("target", "_blank");
        } else {
          node.removeAttribute("href");
        }
        continue;
      }
      if (name === "class" && tag === "ul" && value.trim() === "rn-todo") continue;
      if (name === "data-check" && tag === "li" && /^[01]$/.test(value)) continue;
      node.removeAttribute(name);
    }
  }

  function cleanTree(root) {
    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        cleanTree(child);
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      cleanAttributes(child, tag);
      cleanTree(child);
    }
  }

  function sanitizeHtml(html) {
    const box = document.createElement("div");
    box.innerHTML = String(html || "");
    cleanTree(box);
    return box.innerHTML;
  }

  /* ---------------------------------------------------------------- meta -- */
  function formatTime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds * 1000);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }

  function sourceLabel(source) {
    const data = source || {};
    const page = Number(data.page) || 0;
    if (page) return `第 ${page} 页`;
    if (data.location) return data.location;
    if (data.quote) return "原文引用";
    if (data.path) return fileName(data.path) || "文献";
    return "手动笔记";
  }

  function firstLine(text) {
    const line = String(text || "")
      .split("\n")
      .map((part) => part.replace(/[#>*_~`|-]/g, " ").replace(/\s+/g, " ").trim())
      .find((part) => part);
    return line ? line.slice(0, 60) : "";
  }

  function firstHeading(text) {
    const match = /^\s*#{1,6}\s+(.+)$/m.exec(String(text || ""));
    return match ? match[1].replace(/[*_`]/g, "").trim().slice(0, 60) : "";
  }

  function categoryName(id) {
    const found = state.categories.find((entry) => entry.id === id);
    return found ? found.name : "";
  }

  /* --------------------------------------------------------------- build -- */
  function build() {
    const host = document.getElementById("notes-drawer");
    if (!host) return false;
    if (el.host === host) return true;

    host.innerHTML =
      '<header class="rn-head" data-rn-drag>' +
      '  <span class="rn-lights">' +
      '    <button type="button" class="rn-light rn-close" data-rn-close aria-label="关闭" title="关闭"></button>' +
      '    <button type="button" class="rn-light rn-min" data-rn-min aria-label="最小化" title="最小化"></button>' +
      '  </span>' +
      '  <span class="rn-head-title">笔记</span>' +
      '  <span class="rn-head-count" data-rn-count></span>' +
      '  <span class="rn-head-gap"></span>' +
      '  <button type="button" class="rn-hbtn" data-rn-list title="显示 / 隐藏笔记列表" aria-label="笔记列表">☰</button>' +
      '  <button type="button" class="rn-hbtn rn-hbtn-plus" data-rn-new title="新建笔记" aria-label="新建笔记">＋</button>' +
      '</header>' +
      '<div class="rn-main">' +
      '  <section class="rn-list">' +
      '    <div class="rn-list-top">' +
      '      <label class="rn-search"><input type="search" data-rn-search placeholder="搜索笔记…" autocomplete="off"></label>' +
      '      <button type="button" class="rn-scope" data-rn-scope title="切换：只看本文 / 全部笔记">本文</button>' +
      '    </div>' +
      '    <div class="rn-items" data-rn-items></div>' +
      '  </section>' +
      '  <section class="rn-editor" data-rn-editor>' +
      '    <div class="rn-doc-head">' +
      '      <input class="rn-title-input" data-rn-title placeholder="无标题笔记" autocomplete="off">' +
      '      <select class="rn-cat" data-rn-category title="分类"></select>' +
      '    </div>' +
      '    <div class="rn-toolbar" data-rn-toolbar role="toolbar" aria-label="格式工具">' +
      '      <select class="rn-block" data-rn-block title="段落样式">' +
      '        <option value="p">正文</option>' +
      '        <option value="h1">标题 1</option>' +
      '        <option value="h2">标题 2</option>' +
      '        <option value="h3">标题 3</option>' +
      '        <option value="blockquote">引用</option>' +
      '        <option value="pre">代码块</option>' +
      '      </select>' +
      '      <span class="rn-tsep"></span>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="bold" title="加粗（Ctrl+B）"><b>B</b></button>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="italic" title="斜体（Ctrl+I）"><i>I</i></button>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="underline" title="下划线（Ctrl+U）"><u>U</u></button>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="strikeThrough" title="删除线"><s>S</s></button>' +
      '      <span class="rn-tsep"></span>' +
      '      <label class="rn-tbtn rn-color" title="文字颜色">A<input type="color" data-rn-forecolor value="#d1242f"></label>' +
      '      <span class="rn-swatches" data-rn-hilite role="group" aria-label="重点高亮">' +
      '        <button type="button" class="rn-swatch" data-rn-hilite-color="#fff3a3" style="--sw:#fff3a3" title="黄色高亮"></button>' +
      '        <button type="button" class="rn-swatch" data-rn-hilite-color="#b7efc5" style="--sw:#b7efc5" title="绿色高亮"></button>' +
      '        <button type="button" class="rn-swatch" data-rn-hilite-color="#bfdbfe" style="--sw:#bfdbfe" title="蓝色高亮"></button>' +
      '        <button type="button" class="rn-swatch" data-rn-hilite-color="#fbcfe8" style="--sw:#fbcfe8" title="粉色高亮"></button>' +
      '      </span>' +
      '      <span class="rn-tsep"></span>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="insertUnorderedList" title="无序列表">•≡</button>' +
      '      <button type="button" class="rn-tbtn" data-rn-cmd="insertOrderedList" title="有序列表">1≡</button>' +
      '      <button type="button" class="rn-tbtn" data-rn-todo title="待办事项">☑</button>' +
      '      <span class="rn-head-gap"></span>' +
      '      <button type="button" class="rn-tbtn" data-rn-more-btn title="更多格式" aria-haspopup="menu">⋯</button>' +
      '    </div>' +
      '    <div class="rn-more" data-rn-more-menu hidden>' +
      '      <button type="button" data-rn-more-act="link">插入链接</button>' +
      '      <button type="button" data-rn-more-act="hr">分割线</button>' +
      '      <button type="button" data-rn-more-act="clear">清除格式</button>' +
      '      <button type="button" data-rn-more-act="undo">撤销</button>' +
      '      <button type="button" data-rn-more-act="redo">重做</button>' +
      '    </div>' +
      '    <div class="rn-source" data-rn-source hidden>' +
      '      <button type="button" class="rn-source-tag" data-rn-goto title="回到原文"></button>' +
      '      <span class="rn-source-quote" data-rn-quote></span>' +
      '    </div>' +
      '    <div class="rn-scroll" data-rn-scroll>' +
      '      <div class="rn-rich" data-rn-rich contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-placeholder="直接在这里输入，像用 Word 一样排版…"></div>' +
      '      <div class="rn-blank" data-rn-blank hidden>' +
      '        <div class="rn-blank-card">' +
      '          <strong>还没有打开笔记</strong>' +
      '          <p>从左侧选择一条，或新建一条笔记。</p>' +
      '          <button type="button" class="rn-blank-new" data-rn-blank-new>＋ 新建笔记</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="rn-foot">' +
      '      <span class="rn-foot-meta" data-rn-meta></span>' +
      '      <span class="rn-foot-state" data-rn-state></span>' +
      '      <span class="rn-head-gap"></span>' +
      '      <button type="button" class="rn-foot-btn" data-rn-export aria-haspopup="menu">导出</button>' +
      '      <button type="button" class="rn-foot-btn danger" data-rn-delete disabled>删除</button>' +
      '    </div>' +
      '  </section>' +
      '</div>' +
      '<div class="rn-loading" data-rn-loading hidden><span class="rn-spinner"></span>正在读取笔记…</div>' +
      '<div class="rn-error" data-rn-error hidden>' +
      '  <div class="rn-error-card">' +
      '    <strong data-rn-error-title>笔记读取失败</strong>' +
      '    <p data-rn-error-text></p>' +
      '    <div class="rn-error-actions">' +
      '      <button type="button" class="rn-error-primary" data-rn-restart>重启应用</button>' +
      '      <button type="button" class="rn-error-ghost" data-rn-retry>重试</button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="rn-menu" data-rn-menu hidden>' +
      '  <button type="button" data-rn-export-kind="md">当前笔记 · Markdown</button>' +
      '  <button type="button" data-rn-export-kind="html">当前笔记 · HTML</button>' +
      '  <button type="button" data-rn-export-kind="all">全部笔记 · Markdown</button>' +
      '</div>' +
      '<div class="rn-seltool" data-rn-seltool hidden>' +
      '  <button type="button" data-rn-sel="bold" title="加粗"><b>B</b></button>' +
      '  <button type="button" data-rn-sel="italic" title="斜体"><i>I</i></button>' +
      '  <button type="button" data-rn-sel="underline" title="下划线"><u>U</u></button>' +
      '  <button type="button" data-rn-sel="strikeThrough" title="删除线"><s>S</s></button>' +
      '  <span class="rn-tsep"></span>' +
      '  <button type="button" class="rn-swatch" data-rn-sel-hilite="#fff3a3" style="--sw:#fff3a3" title="黄色高亮"></button>' +
      '  <button type="button" class="rn-swatch" data-rn-sel-hilite="#b7efc5" style="--sw:#b7efc5" title="绿色高亮"></button>' +
      '  <button type="button" class="rn-swatch" data-rn-sel-hilite="#fbcfe8" style="--sw:#fbcfe8" title="粉色高亮"></button>' +
      '</div>' +
      '<div class="rn-rz rn-rz-n" data-rn-resize="n"></div>' +
      '<div class="rn-rz rn-rz-s" data-rn-resize="s"></div>' +
      '<div class="rn-rz rn-rz-e" data-rn-resize="e"></div>' +
      '<div class="rn-rz rn-rz-w" data-rn-resize="w"></div>' +
      '<div class="rn-rz rn-rz-ne" data-rn-resize="ne"></div>' +
      '<div class="rn-rz rn-rz-nw" data-rn-resize="nw"></div>' +
      '<div class="rn-rz rn-rz-se" data-rn-resize="se"></div>' +
      '<div class="rn-rz rn-rz-sw" data-rn-resize="sw"></div>';

    el.host = host;
    el.button = document.getElementById("btn-notes");
    el.head = $("[data-rn-drag]", host);
    el.min = $("[data-rn-min]", host);
    el.count = $("[data-rn-count]", host);
    el.items = $("[data-rn-items]", host);
    el.search = $("[data-rn-search]", host);
    el.scope = $("[data-rn-scope]", host);
    el.title = $("[data-rn-title]", host);
    el.category = $("[data-rn-category]", host);
    el.toolbar = $("[data-rn-toolbar]", host);
    el.block = $("[data-rn-block]", host);
    el.forecolor = $("[data-rn-forecolor]", host);
    el.moreBtn = $("[data-rn-more-btn]", host);
    el.moreMenu = $("[data-rn-more-menu]", host);
    el.rich = $("[data-rn-rich]", host);
    el.scrollBox = $("[data-rn-scroll]", host);
    el.meta = $("[data-rn-meta]", host);
    el.footState = $("[data-rn-state]", host);
    el.delete = $("[data-rn-delete]", host);
    el.export = $("[data-rn-export]", host);
    el.menu = $("[data-rn-menu]", host);
    el.source = $("[data-rn-source]", host);
    el.sourceTag = $("[data-rn-goto]", host);
    el.sourceQuote = $("[data-rn-quote]", host);
    el.editor = $("[data-rn-editor]", host);
    el.blank = $("[data-rn-blank]", host);
    el.loading = $("[data-rn-loading]", host);
    el.error = $("[data-rn-error]", host);
    el.errorText = $("[data-rn-error-text]", host);
    el.errorTitle = $("[data-rn-error-title]", host);
    el.restart = $("[data-rn-restart]", host);
    el.retry = $("[data-rn-retry]", host);
    el.seltool = $("[data-rn-seltool]", host);
    el.handles = Array.from(host.querySelectorAll("[data-rn-resize]"));
    /* Selection toolbar is fixed to the viewport: keep it outside the window's
       overflow clipping so it can float above the PDF. */
    if (el.seltool && el.seltool.parentNode !== document.body) document.body.append(el.seltool);
    return true;
  }

  /* ---------------------------------------------------------------- list -- */
  function renderList() {
    if (!el.items) return;
    el.items.textContent = "";
    if (!state.notes.length) {
      const empty = document.createElement("div");
      empty.className = "rn-list-empty";
      empty.textContent = state.query
        ? "没有匹配的笔记。"
        : state.scope === "doc"
          ? "本文还没有笔记。选中原文点「存笔记」，或点右上角 ＋。"
          : "还没有笔记。";
      el.items.append(empty);
      return;
    }
    for (const note of state.notes) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = `rn-card${state.current && state.current.id === note.id ? " on" : ""}`;
      card.dataset.id = note.id;
      const title = document.createElement("span");
      title.className = "rn-card-title";
      title.textContent = note.title || "无标题笔记";
      const meta = document.createElement("span");
      meta.className = "rn-card-meta";
      const bits = [sourceLabel(note.source)];
      if (note.category_id) bits.push(categoryName(note.category_id));
      const updated = formatTime(note.updated);
      if (updated) bits.push(updated);
      meta.textContent = bits.filter(Boolean).join(" · ");
      card.append(title, meta);
      card.addEventListener("click", () => { void selectNote(note.id); });
      el.items.append(card);
    }
    if (el.count) el.count.textContent = state.notes.length ? String(state.notes.length) : "";
  }

  function renderCategories() {
    if (!el.category) return;
    const current = state.current ? state.current.category_id || "" : "";
    el.category.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "未分类";
    el.category.append(none);
    for (const category of state.categories) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      el.category.append(option);
    }
    const add = document.createElement("option");
    add.value = "__new";
    add.textContent = "＋ 新建分类…";
    el.category.append(add);
    const selected = state.categories.some((entry) => entry.id === current);
    el.category.value = selected ? current : "";
    el.category.disabled = !state.current;
  }

  /* -------------------------------------------------------------- editor -- */
  function applyIdle() {
    if (!el.editor) return;
    const idle = !state.current;
    el.editor.classList.toggle("is-idle", idle);
    el.blank.hidden = !idle;
    if (el.title) el.title.disabled = idle;
    if (el.category) el.category.disabled = idle;
    if (el.delete) el.delete.disabled = idle;
    if (el.rich) el.rich.setAttribute("contenteditable", idle ? "false" : "true");
    if (idle) {
      if (el.title) el.title.value = "";
      if (el.rich) el.rich.innerHTML = "";
      if (el.meta) el.meta.textContent = "";
      if (el.source) el.source.hidden = true;
    }
  }

  function renderSource() {
    if (!el.source) return;
    const source = (state.current && state.current.source) || {};
    const page = Number(source.page) || 0;
    const quote = String(source.quote || "").trim();
    if (!page && !quote) {
      el.source.hidden = true;
      return;
    }
    el.source.hidden = false;
    const where = page ? `第 ${page} 页` : "原文";
    el.sourceTag.textContent = `${where} · 回到原文`;
    el.sourceQuote.textContent = quote
      ? quote.replace(/\s+/g, " ").slice(0, 180)
      : "（这条笔记关联到原文位置）";
    el.sourceQuote.title = quote.slice(0, 800);
  }

  function renderMeta() {
    if (!el.meta) return;
    if (!state.current) { el.meta.textContent = ""; return; }
    const text = (el.rich.innerText || "").trim();
    const chars = Array.from(text.replace(/\s+/g, "")).length;
    const bits = [sourceLabel(state.current.source)];
    if (state.current.source && state.current.source.path && state.current.source.path !== docPath()) {
      bits.unshift(fileName(state.current.source.path) || "文献");
    }
    if (chars) bits.push(`${chars} 字`);
    const updated = formatTime(state.current.updated);
    if (updated) bits.push(`更新于 ${updated}`);
    el.meta.textContent = bits.filter(Boolean).join(" · ");
  }

  function fillEditor(note) {
    state.current = note;
    state.dirty = false;
    state.revision += 1;
    if (el.title) el.title.value = note.title || "";
    if (el.rich) {
      const html = String(note.body_html || "").trim();
      el.rich.innerHTML = html ? sanitizeHtml(html) : renderMarkdown(note.body || "");
    }
    if (el.category) el.category.value = note.category_id || "";
    applyIdle();
    renderSource();
    renderMeta();
    setStatus(note.updated ? "已保存" : "", "");
  }

  function setStatus(text, kind) {
    if (!el.footState) return;
    el.footState.textContent = text || "";
    el.footState.dataset.kind = kind || "";
  }

  function markDirty() {
    if (!state.current || state.stale) return;
    state.dirty = true;
    state.revision += 1;
    renderMeta();
    scheduleSave();
  }

  function scheduleSave() {
    if (state.saveTimer) window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      state.saveTimer = 0;
      void saveNow();
    }, 750);
  }

  function snapshot(note) {
    return {
      title: el.title ? el.title.value.trim() : "",
      body_html: sanitizeHtml(el.rich ? el.rich.innerHTML : ""),
      category_id: el.category ? (el.category.value === "__new" ? "" : el.category.value) : "",
      source: (note && note.source) || {},
    };
  }

  async function saveNow() {
    if (!state.current || state.stale || state.saving) return;
    if (!state.dirty) return;
    const note = state.current;
    const revision = state.revision;
    const payload = snapshot(note);
    state.dirty = false;
    state.saving = true;
    setStatus("保存中…", "saving");
    try {
      const data = await api(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PATCH",
        body: payload,
      });
      if (state.current && state.current.id === note.id) {
        state.current = Object.assign({}, state.current, data.note || {});
        const index = state.notes.findIndex((entry) => entry.id === note.id);
        if (index >= 0) state.notes[index] = state.current;
        renderList();
        renderMeta();
      }
      if (state.revision !== revision) {
        state.dirty = true;
        scheduleSave();
      }
      setStatus("已保存", "good");
    } catch (error) {
      if (state.current && state.current.id === note.id) state.dirty = true;
      setStatus("保存失败", "bad");
      handleError(error);
    } finally {
      state.saving = false;
    }
  }

  async function flush() {
    if (state.saveTimer) {
      window.clearTimeout(state.saveTimer);
      state.saveTimer = 0;
    }
    for (let attempt = 0; attempt < 8 && state.current; attempt += 1) {
      if (state.saving) {
        await sleep(120);
        continue;
      }
      if (!state.dirty) break;
      await saveNow();
    }
  }

  /* -------------------------------------------------------------- actions -- */
  async function selectNote(noteId) {
    await flush();
    const note = state.notes.find((entry) => entry.id === noteId);
    if (!note) return;
    fillEditor(note);
    renderList();
    renderCategories();
  }

  async function createNote(payload) {
    const data = await api("/api/notes", { method: "POST", body: payload });
    const note = data.note;
    if (!note) throw new Error("服务器没有返回笔记");
    const inScope =
      state.scope === "all" || !docPath() || (note.source && note.source.path === docPath());
    if (inScope) {
      state.notes.unshift(note);
      state.notes.sort((a, b) => Number(b.updated) - Number(a.updated));
    }
    return note;
  }

  async function newNote() {
    await flush();
    const page = currentPage();
    try {
      const note = await createNote({
        title: "",
        body: "",
        body_html: "",
        source: {
          path: docPath(),
          page,
          quote: "",
          location: page ? `第 ${page} 页` : "手动笔记",
        },
      });
      await selectNote(note.id);
      if (el.title) el.title.focus();
      setStatus("新笔记", "");
    } catch (error) {
      handleError(error);
    }
  }

  async function deleteCurrent() {
    if (!state.current) return;
    const note = state.current;
    if (!window.confirm("删除这条笔记？此操作不可撤销。")) return;
    try {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      state.notes = state.notes.filter((entry) => entry.id !== note.id);
      state.current = null;
      state.dirty = false;
      applyIdle();
      renderList();
      renderCategories();
      setStatus("已删除", "");
      toast("已删除笔记", "good");
    } catch (error) {
      handleError(error);
    }
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    if (el.loading) el.loading.hidden = false;
    try {
      const params = new URLSearchParams();
      if (state.query) params.set("q", state.query);
      if (state.scope === "doc" && docPath()) params.set("path", docPath());
      const suffix = params.toString();
      const data = await api(`/api/notes${suffix ? `?${suffix}` : ""}`);
      state.notes = Array.isArray(data.notes) ? data.notes : [];
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      state.loaded = true;
      state.stale = false;
      hideError();
      renderList();
      renderCategories();
      if (state.current) {
        const fresh = state.notes.find((entry) => entry.id === state.current.id);
        if (fresh && !state.dirty) fillEditor(fresh);
      } else if (state.notes.length) {
        await selectNote(state.notes[0].id);
      } else {
        applyIdle();
      }
    } catch (error) {
      handleError(error);
    } finally {
      state.loading = false;
      if (el.loading) el.loading.hidden = true;
    }
  }

  function handleError(error) {
    const status = Number(error && error.status) || 0;
    if (status === 404) {
      state.stale = true;
      showError("后端版本较旧，笔记接口还没有生效。重启应用后即可正常使用。");
      return;
    }
    if (status === 0) {
      showError("无法连接本地服务，请确认 BabelDOC Studio 仍在运行。");
      return;
    }
    toast((error && error.message) || "笔记请求失败", "bad");
  }

  function showError(message) {
    if (!el.error) return;
    el.error.hidden = false;
    if (el.errorText) el.errorText.textContent = message || "";
    if (el.errorTitle) el.errorTitle.textContent = "笔记读取失败";
    if (el.restart) el.restart.hidden = false;
    if (el.retry) el.retry.hidden = false;
  }

  function hideError() {
    if (el.error) el.error.hidden = true;
  }

  async function restartApp() {
    if (!el.restart) return;
    el.restart.disabled = true;
    el.restart.textContent = "正在重启…";
    const before = state.serverBuild;
    try {
      await api("/api/app/restart", { method: "POST" });
    } catch (error) {
      el.restart.disabled = false;
      el.restart.textContent = "重启应用";
      if (el.errorText) {
        el.errorText.textContent =
          "当前版本不支持一键重启，请关闭应用窗口后重新打开。";
      }
      return;
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(700);
      try {
        const response = await fetch("/api/health", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) continue;
        const health = await response.json();
        const features = Array.isArray(health.features) ? health.features : [];
        const build = Number(health.build) || 0;
        if (features.includes("notes") && (build !== before || !before)) {
          window.location.reload();
          return;
        }
      } catch {
        /* still restarting */
      }
    }
    el.restart.disabled = false;
    el.restart.textContent = "重启应用";
    if (el.errorText) {
      el.errorText.textContent = "重启超时，请关闭应用窗口后重新打开。";
    }
  }

  /* --------------------------------------------------------------- export -- */
  function liveNote() {
    const base = state.current || {};
    return Object.assign({}, base, {
      title: (el.title && el.title.value.trim()) || "无标题笔记",
      body_html: sanitizeHtml(el.rich ? el.rich.innerHTML : ""),
      body: el.rich ? el.rich.innerText : "",
      category_id: el.category ? el.category.value : "",
    });
  }

  function mdPath(path) {
    return fileName(path);
  }

  function noteMarkdown(note, heading) {
    const level = heading || "###";
    const lines = [`${level} ${note.title || "无标题笔记"}`];
    const meta = [];
    if (note.source && note.source.path) meta.push(`来源：${mdPath(note.source.path)}`);
    if (note.source && note.source.page) meta.push(`第 ${note.source.page} 页`);
    if (note.source && note.source.location) meta.push(note.source.location);
    const category = categoryName(note.category_id);
    if (category) meta.push(`分类：${category}`);
    if (meta.length) lines.push(`> ${meta.join(" · ")}`);
    if (note.source && note.source.quote) {
      lines.push("");
      lines.push(
        String(note.source.quote)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      );
    }
    const body = note.body_html
      ? htmlToMarkdown(note.body_html)
      : String(note.body || "").trim();
    if (body) {
      lines.push("");
      lines.push(body);
    }
    return lines.join("\n");
  }

  function mdInline(node) {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.nodeValue.replace(/\s+/g, " ");
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "br") { out += "\n"; continue; }
      if (tag === "strong" || tag === "b") { out += `**${mdInline(child).trim()}**`; continue; }
      if (tag === "em" || tag === "i") { out += `*${mdInline(child).trim()}*`; continue; }
      if (tag === "del" || tag === "s" || tag === "strike") { out += `~~${mdInline(child).trim()}~~`; continue; }
      if (tag === "u") { out += `<u>${mdInline(child).trim()}</u>`; continue; }
      if (tag === "mark") { out += `<mark>${mdInline(child).trim()}</mark>`; continue; }
      if (tag === "code") { out += `\`${child.textContent}\``; continue; }
      if (tag === "a") { out += `[${mdInline(child).trim()}](${child.getAttribute("href") || ""})`; continue; }
      if (tag === "span") {
        const style = child.getAttribute("style") || "";
        const highlighted = /background-color:\s*([^;]+)/i.exec(style);
        if (highlighted) {
          out += `<mark style="background-color:${highlighted[1].trim()}">${mdInline(child).trim()}</mark>`;
          continue;
        }
        out += mdInline(child);
        continue;
      }
      out += mdInline(child);
    }
    return out;
  }

  function htmlToMarkdown(html) {
    const box = document.createElement("div");
    box.innerHTML = String(html || "");
    return mdBlocks(box).replace(/\n{3,}/g, "\n\n").trim();
  }

  function mdBlocks(node) {
    let out = "";
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue.replace(/\s+/g, " ");
        if (text.trim()) out += `${text}\n`;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      if (tag === "p" || tag === "div") {
        const text = mdInline(child).trim();
        if (text) out += `${text}\n\n`;
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        out += `${"#".repeat(Number(tag[1]))} ${mdInline(child).trim()}\n\n`;
        continue;
      }
      if (tag === "blockquote") {
        const text = mdBlocks(child).trim();
        out += text.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        let index = 1;
        for (const li of Array.from(child.children)) {
          if (li.tagName.toLowerCase() !== "li") continue;
          const check = li.getAttribute("data-check");
          const box = check === "1" ? "[x] " : check === "0" ? "[ ] " : "";
          const bullet = tag === "ol" ? `${index}. ` : "- ";
          out += `${bullet}${box}${mdInline(li).trim()}\n`;
          index += 1;
        }
        out += "\n";
        continue;
      }
      if (tag === "pre") {
        out += "```\n" + (child.textContent || "").replace(/\n+$/, "") + "\n```\n\n";
        continue;
      }
      if (tag === "hr") { out += "---\n\n"; continue; }
      if (tag === "table") {
        const rows = Array.from(child.querySelectorAll("tr"));
        rows.forEach((row, rowIndex) => {
          const cells = Array.from(row.children).map((cell) => mdInline(cell).trim());
          out += `| ${cells.join(" | ")} |\n`;
          if (rowIndex === 0) out += `| ${cells.map(() => "---").join(" | ")} |\n`;
        });
        out += "\n";
        continue;
      }
      out += mdBlocks(child);
    }
    return out;
  }

  function safeName(text) {
    return String(text || "笔记")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60) || "笔记";
  }

  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function exportHtml(note) {
    const meta = [];
    if (note.source && note.source.path) meta.push(`来源：${fileName(note.source.path)}`);
    if (note.source && note.source.page) meta.push(`第 ${note.source.page} 页`);
    const category = categoryName(note.category_id);
    if (category) meta.push(`分类：${category}`);
    return (
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      `<title>${escapeHtml(note.title || "笔记")}</title>` +
      "<style>body{max-width:760px;margin:48px auto;padding:0 24px;" +
      "font:15px/1.75 -apple-system,'Segoe UI',system-ui,sans-serif;color:#1c1c1e}" +
      "h1,h2,h3{line-height:1.35}blockquote{margin:12px 0;padding:6px 14px;" +
      "border-left:3px solid #0a84ff;background:#f5f5f7;color:#3a3a3c}" +
      "mark{padding:0 2px;border-radius:3px}img{max-width:100%}" +
      ".meta{color:#6e6e73;font-size:13px}</style></head><body>" +
      `<h1>${escapeHtml(note.title || "无标题笔记")}</h1>` +
      (meta.length ? `<p class="meta">${escapeHtml(meta.join(" · "))}</p>` : "") +
      `<div>${sanitizeHtml(note.body_html || "")}</div></body></html>`
    );
  }

  async function exportNotes(kind) {
    if (kind === "all") {
      try {
        const data = await api("/api/notes");
        const notes = Array.isArray(data.notes) ? data.notes : [];
        if (!notes.length) { toast("还没有笔记可以导出", "bad"); return; }
        const body = notes
          .slice()
          .sort((a, b) => Number(b.updated) - Number(a.updated))
          .map((note) => noteMarkdown(note, "##"))
          .join("\n\n---\n\n");
        const header = `# BabelDOC Studio 笔记导出\n\n导出时间：${new Date().toLocaleString("zh-CN")}\n\n---\n\n`;
        download(header + body + "\n", "BabelDOC-notes.md", "text/markdown;charset=utf-8");
        toast(`已导出 ${notes.length} 条笔记`, "good");
      } catch (error) {
        handleError(error);
      }
      return;
    }
    if (!state.current) { toast("先打开一条笔记", "bad"); return; }
    const note = liveNote();
    if (kind === "html") {
      download(exportHtml(note), `${safeName(note.title)}.html`, "text/html;charset=utf-8");
    } else {
      download(noteMarkdown(note, "#"), `${safeName(note.title)}.md`, "text/markdown;charset=utf-8");
    }
    toast("已导出笔记", "good");
  }

  /* -------------------------------------------------------------- geometry -- */
  function defaultGeometry() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.round(Math.min(680, Math.max(440, vw * 0.44)));
    const height = Math.round(Math.min(700, Math.max(380, vh * 0.74)));
    const x = Math.max(8, vw - width - 28);
    const y = Math.max(58, Math.min(76, vh - height - 16));
    return { x, y, w: width, h: height };
  }

  function clampGeometry(raw) {
    const base = defaultGeometry();
    const width = Math.min(Math.max(Number(raw.w) || base.w, MIN_W), Math.min(MAX_W, window.innerWidth - 16));
    const height = Math.min(Math.max(Number(raw.h) || base.h, MIN_H), Math.min(MAX_H, window.innerHeight - 70));
    const x = Math.min(Math.max(Number(raw.x) || base.x, 8), Math.max(8, window.innerWidth - width - 8));
    const y = Math.min(Math.max(Number(raw.y) || base.y, 52), Math.max(8, window.innerHeight - height - 8));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) };
  }

  function applyGeometry(geometry) {
    if (!el.host) return;
    state.geometry = clampGeometry(geometry);
    el.host.style.left = `${state.geometry.x}px`;
    el.host.style.top = `${state.geometry.y}px`;
    el.host.style.width = `${state.geometry.w}px`;
    el.host.style.height = `${state.geometry.h}px`;
    applyCompact();
  }

  function saveGeometry() {
    if (!state.geometry) return;
    writeStore(STORE_GEOMETRY, JSON.stringify(state.geometry));
  }

  function applyCompact() {
    if (!el.host || !state.geometry) return;
    const compact = state.geometry.w < 520;
    el.host.classList.toggle("compact", compact);
    el.host.classList.toggle("list-open", state.listOpen);
    if (!compact) el.host.classList.remove("list-open");
  }

  function bindDrag() {
    if (!el.head) return;
    el.head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, a, .rn-hbtn")) return;
      if (state.minimized) return;
      const rect = el.host.getBoundingClientRect();
      state.drag = {
        startX: event.clientX,
        startY: event.clientY,
        x: rect.left,
        y: rect.top,
      };
      el.head.classList.add("dragging");
      try { el.head.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      event.preventDefault();
    });
    el.head.addEventListener("pointermove", (event) => {
      if (!state.drag) return;
      const dx = event.clientX - state.drag.startX;
      const dy = event.clientY - state.drag.startY;
      const width = state.geometry ? state.geometry.w : el.host.offsetWidth;
      const height = state.geometry ? state.geometry.h : el.host.offsetHeight;
      const x = Math.min(Math.max(state.drag.x + dx, 8), window.innerWidth - width - 8);
      const y = Math.min(Math.max(state.drag.y + dy, 8), window.innerHeight - height - 8);
      if (!state.geometry) state.geometry = { x, y, w: width, h: height };
      state.geometry.x = Math.round(x);
      state.geometry.y = Math.round(y);
      el.host.style.left = `${state.geometry.x}px`;
      el.host.style.top = `${state.geometry.y}px`;
    });
    const endDrag = () => {
      if (!state.drag) return;
      state.drag = null;
      el.head.classList.remove("dragging");
      saveGeometry();
    };
    el.head.addEventListener("pointerup", endDrag);
    el.head.addEventListener("pointercancel", endDrag);

    for (const handle of el.handles) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const rect = el.host.getBoundingClientRect();
        state.resize = {
          dir: handle.dataset.rnResize,
          startX: event.clientX,
          startY: event.clientY,
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
        };
        handle.classList.add("dragging");
        try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      });
      handle.addEventListener("pointermove", (event) => {
        if (!state.resize) return;
        const dir = state.resize.dir;
        const dx = event.clientX - state.resize.startX;
        const dy = event.clientY - state.resize.startY;
        let { x, y, w, h } = state.resize;
        if (dir.includes("e")) {
          w = Math.min(Math.max(state.resize.w + dx, MIN_W), window.innerWidth - x - 8);
        }
        if (dir.includes("s")) {
          h = Math.min(Math.max(state.resize.h + dy, MIN_H), window.innerHeight - y - 8);
        }
        if (dir.includes("w")) {
          const maxWidth = state.resize.x + state.resize.w - 8;
          w = Math.min(Math.max(state.resize.w - dx, MIN_W), maxWidth);
          x = state.resize.x + state.resize.w - w;
        }
        if (dir.includes("n")) {
          const maxHeight = state.resize.y + state.resize.h - 8;
          h = Math.min(Math.max(state.resize.h - dy, MIN_H), maxHeight);
          y = state.resize.y + state.resize.h - h;
        }
        state.geometry = {
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
        };
        el.host.style.left = `${state.geometry.x}px`;
        el.host.style.top = `${state.geometry.y}px`;
        el.host.style.width = `${state.geometry.w}px`;
        el.host.style.height = `${state.geometry.h}px`;
        applyCompact();
      });
      const endResize = () => {
        if (!state.resize) return;
        state.resize = null;
        handle.classList.remove("dragging");
        saveGeometry();
      };
      handle.addEventListener("pointerup", endResize);
      handle.addEventListener("pointercancel", endResize);
    }
  }

  /* --------------------------------------------------------------- editor -- */
  function exec(command, value) {
    if (!state.current || !el.rich || el.rich.getAttribute("contenteditable") === "false") return;
    el.rich.focus();
    try { document.execCommand("styleWithCSS", false, "true"); } catch { /* ignore */ }
    try { document.execCommand(command, false, value == null ? null : String(value)); } catch { /* ignore */ }
    markDirty();
    syncBlockSelect();
  }

  function blockTag() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return "p";
    let node = selection.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node !== el.rich) {
      const tag = node.tagName ? node.tagName.toLowerCase() : "";
      if (["p", "h1", "h2", "h3", "h4", "blockquote", "pre"].includes(tag)) return tag;
      node = node.parentNode;
    }
    return "p";
  }

  function syncBlockSelect() {
    if (!el.block) return;
    const tag = blockTag();
    const value = ["h1", "h2", "h3", "blockquote", "pre"].includes(tag) ? tag : "p";
    el.block.value = value;
  }

  function insertChecklist() {
    exec(
      "insertHTML",
      '<ul class="rn-todo"><li data-check="0">待办事项</li></ul><p><br></p>'
    );
  }

  function insertLink() {
    const url = window.prompt("链接地址", "https://");
    if (!url) return;
    const text = window.getSelection() ? String(window.getSelection()) : "";
    if (text) exec("createLink", url);
    else exec("insertHTML", `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
  }

  function toggleChecklistItem(li) {
    const next = li.getAttribute("data-check") === "1" ? "0" : "1";
    li.setAttribute("data-check", next);
    markDirty();
  }

  function bindToolbar() {
    el.toolbar.addEventListener("mousedown", (event) => {
      if (event.target.closest("button, select, input, label")) event.preventDefault();
    });
    for (const button of el.toolbar.querySelectorAll("[data-rn-cmd]")) {
      button.addEventListener("click", () => {
        const command = button.dataset.rnCmd;
        if (command === "undo" || command === "redo") {
          el.rich.focus();
          document.execCommand(command, false, null);
          markDirty();
          return;
        }
        exec(command);
      });
    }
    for (const button of el.toolbar.querySelectorAll("[data-rn-hilite-color]")) {
      button.addEventListener("click", () => exec("hiliteColor", button.dataset.rnHiliteColor));
    }
    const todo = el.toolbar.querySelector("[data-rn-todo]");
    if (todo) todo.addEventListener("click", insertChecklist);
    if (el.moreBtn && el.moreMenu) {
      el.moreBtn.addEventListener("click", () => {
        el.moreMenu.hidden = !el.moreMenu.hidden;
      });
      for (const item of el.moreMenu.querySelectorAll("[data-rn-more-act]")) {
        item.addEventListener("click", () => {
          el.moreMenu.hidden = true;
          const action = item.dataset.rnMoreAct;
          if (action === "link") {
            insertLink();
          } else if (action === "hr") {
            exec("insertHorizontalRule");
          } else if (action === "clear") {
            el.rich.focus();
            try { document.execCommand("removeFormat", false, null); } catch { /* ignore */ }
            exec("formatBlock", "<p>");
          } else if (action === "undo" || action === "redo") {
            el.rich.focus();
            document.execCommand(action, false, null);
            markDirty();
          }
        });
      }
    }
    if (el.block) {
      el.block.addEventListener("change", () => {
        exec("formatBlock", `<${el.block.value}>`);
        el.rich.focus();
      });
    }
    if (el.forecolor) {
      el.forecolor.addEventListener("input", () => exec("foreColor", el.forecolor.value));
    }
    el.rich.addEventListener("click", (event) => {
      const li = event.target.closest("li[data-check]");
      if (!li) return;
      const rect = li.getBoundingClientRect();
      if (event.clientX - rect.left > 28) return;
      toggleChecklistItem(li);
    });
    el.rich.addEventListener("keyup", syncBlockSelect);
    el.rich.addEventListener("mouseup", syncBlockSelect);
  }

  function bindSelectionTool() {
    let timer = 0;
    const hide = () => { if (el.seltool) el.seltool.hidden = true; };
    const update = () => {
      if (!state.open || !el.seltool || !el.rich) { hide(); return; }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { hide(); return; }
      const range = selection.getRangeAt(0);
      if (!el.rich.contains(range.commonAncestorContainer)) { hide(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hide(); return; }
      el.seltool.hidden = false;
      const top = Math.max(8, rect.top - 44);
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - 110),
        window.innerWidth - 230
      );
      el.seltool.style.top = `${Math.round(top)}px`;
      el.seltool.style.left = `${Math.round(left)}px`;
    };
    document.addEventListener("selectionchange", () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(update, 90);
    });
    if (!el.seltool) return;
    el.seltool.addEventListener("mousedown", (event) => event.preventDefault());
    for (const button of el.seltool.querySelectorAll("[data-rn-sel]")) {
      button.addEventListener("click", () => exec(button.dataset.rnSel));
    }
    for (const button of el.seltool.querySelectorAll("[data-rn-sel-hilite]")) {
      button.addEventListener("click", () => exec("hiliteColor", button.dataset.rnSelHilite));
    }
    document.addEventListener("mousedown", (event) => {
      if (el.seltool.hidden) return;
      if (event.target.closest("[data-rn-seltool]")) return;
      if (el.rich.contains(event.target)) return;
      hide();
    });
  }

  /* --------------------------------------------------------------- events -- */
  function bindEvents() {
    if (el.button) el.button.addEventListener("click", () => { void ReaderNotes.toggle(); });
    if (!el.host) return;

    el.host.addEventListener("mousedown", (event) => {
      if (el.menu && !el.menu.hidden) {
        if (!event.target.closest("[data-rn-menu]") && !event.target.closest("[data-rn-export]")) {
          el.menu.hidden = true;
        }
      }
      if (el.moreMenu && !el.moreMenu.hidden) {
        if (!event.target.closest("[data-rn-more-menu]") && !event.target.closest("[data-rn-more-btn]")) {
          el.moreMenu.hidden = true;
        }
      }
    });

    const close = el.host.querySelector("[data-rn-close]");
    if (close) close.addEventListener("click", () => ReaderNotes.close());
    const min = el.host.querySelector("[data-rn-min]");
    if (min) min.addEventListener("click", () => setMinimized(!state.minimized));
    const fresh = el.host.querySelector("[data-rn-new]");
    if (fresh) fresh.addEventListener("click", () => { void newNote(); });
    const blankNew = el.host.querySelector("[data-rn-blank-new]");
    if (blankNew) blankNew.addEventListener("click", () => { void newNote(); });
    const listToggle = el.host.querySelector("[data-rn-list]");
    if (listToggle) {
      listToggle.addEventListener("click", () => {
        state.listOpen = !state.listOpen;
        applyCompact();
      });
    }

    if (el.search) {
      let timer = 0;
      el.search.addEventListener("input", () => {
        state.query = el.search.value.trim();
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => { void refresh(); }, 260);
      });
    }
    if (el.scope) {
      el.scope.addEventListener("click", async () => {
        state.scope = state.scope === "doc" ? "all" : "doc";
        writeStore(STORE_SCOPE, state.scope);
        el.scope.textContent = state.scope === "doc" ? "本文" : "全部";
        state.current = null;
        applyIdle();
        await refresh();
      });
    }

    if (el.title) {
      el.title.addEventListener("input", markDirty);
      el.title.addEventListener("change", markDirty);
    }
    if (el.category) {
      el.category.addEventListener("change", async () => {
        if (el.category.value === "__new") {
          const name = window.prompt("新分类名称");
          if (!name || !name.trim()) { el.category.value = state.current ? state.current.category_id || "" : ""; return; }
          try {
            const data = await api("/api/notes/categories", {
              method: "POST",
              body: { name: name.trim() },
            });
            state.categories = Array.isArray(data.categories) ? data.categories : state.categories;
            renderCategories();
            const created = data.category;
            if (created && state.current) {
              el.category.value = created.id;
              markDirty();
            }
          } catch (error) {
            handleError(error);
          }
          return;
        }
        markDirty();
      });
    }
    if (el.rich) {
      el.rich.addEventListener("input", markDirty);
      el.rich.addEventListener("paste", (event) => {
        const data = event.clipboardData;
        if (!data) return;
        event.preventDefault();
        const html = data.getData("text/html");
        if (html && /<(p|h[1-6]|ul|ol|li|strong|em|blockquote|pre)\b/i.test(html)) {
          const clean = sanitizeHtml(html);
          if (clean) {
            document.execCommand("insertHTML", false, clean);
            markDirty();
            return;
          }
        }
        const text = data.getData("text/plain");
        if (text) document.execCommand("insertText", false, text);
        markDirty();
      });
    }
    if (el.sourceTag) {
      el.sourceTag.addEventListener("click", () => {
        const source = (state.current && state.current.source) || {};
        const page = Number(source.page) || 1;
        if (source.path && source.path !== docPath()) {
          window.location.href = `/viewer?path=${encodeURIComponent(source.path)}&page=${page}`;
          return;
        }
        if (window.ReaderBridge && typeof window.ReaderBridge.goToPage === "function") {
          window.ReaderBridge.goToPage(page);
        }
      });
    }
    if (el.delete) el.delete.addEventListener("click", () => { void deleteCurrent(); });
    if (el.export) {
      el.export.addEventListener("click", () => {
        if (!el.menu) return;
        el.menu.hidden = !el.menu.hidden;
      });
    }
    if (el.menu) {
      for (const button of el.menu.querySelectorAll("[data-rn-export-kind]")) {
        button.addEventListener("click", () => {
          el.menu.hidden = true;
          void exportNotes(button.dataset.rnExportKind);
        });
      }
    }
    if (el.restart) el.restart.addEventListener("click", () => { void restartApp(); });
    if (el.retry) {
      el.retry.addEventListener("click", () => {
        state.stale = false;
        hideError();
        void refresh();
      });
    }

    window.addEventListener("resize", () => {
      if (!state.open || !state.geometry) return;
      const geometry = clampGeometry(state.geometry);
      applyGeometry(geometry);
    });

    window.addEventListener("beforeunload", () => {
      if (!state.current || !state.dirty) return;
      try {
        fetch(`/api/notes/${encodeURIComponent(state.current.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot(state.current)),
          keepalive: true,
        });
      } catch { /* best effort */ }
    });
  }

  function setMinimized(value) {
    state.minimized = Boolean(value);
    if (el.host) el.host.classList.toggle("min", state.minimized);
    if (state.minimized && el.min) el.min.title = "展开";
  }

  /* ------------------------------------------------------------ public API -- */
  const ReaderNotes = {
    async open() {
      build();
      if (!el.host) return;
      if (state.open) {
        setMinimized(false);
        return;
      }
      el.host.hidden = false;
      state.open = true;
      if (el.button) el.button.setAttribute("aria-pressed", "true");
      applyGeometry(readJson(STORE_GEOMETRY) || defaultGeometry());
      setMinimized(false);
      if (!state.loaded) await refresh();
      if (!state.current) {
        if (state.notes.length) await selectNote(state.notes[0].id);
        else applyIdle();
      } else {
        applyIdle();
      }
    },
    close() {
      if (!el.host || !state.open) return;
      void flush();
      el.host.hidden = true;
      state.open = false;
      if (el.seltool) el.seltool.hidden = true;
      if (el.button) el.button.setAttribute("aria-pressed", "false");
      if (el.menu) el.menu.hidden = true;
    },
    toggle() {
      if (!state.open) { void this.open(); return; }
      if (state.minimized) { setMinimized(false); return; }
      this.close();
    },
    async openNote(noteId) {
      await this.open();
      if (!noteId) return;
      if (!state.notes.some((note) => note.id === noteId)) {
        state.scope = "all";
        writeStore(STORE_SCOPE, state.scope);
        if (el.scope) el.scope.textContent = "全部";
        await refresh();
      }
      await selectNote(noteId);
    },
    async createFromSelection(captured) {
      const text = String((captured && captured.text) || "").trim();
      if (!text) { toast("没有选中文字", "bad"); return; }
      const page =
        Number(captured && captured.parts && captured.parts[0] && captured.parts[0].page) ||
        currentPage();
      const quoted = text.split("\n").map((line) => escapeHtml(line)).join("<br>");
      try {
        const note = await createNote({
          title: firstLine(text) || `第 ${page} 页的笔记`,
          body: `> ${text.split("\n").join("\n> ")}\n\n`,
          body_html: `<blockquote>${quoted}</blockquote><p><br></p>`,
          source: {
            path: docPath(),
            page,
            quote: text.slice(0, 2000),
            location: `第 ${page} 页`,
          },
        });
        await this.open();
        await selectNote(note.id);
        toast("已存为笔记", "good");
      } catch (error) {
        handleError(error);
      }
    },
    async createFromAI(payload) {
      const markdown = String((payload && payload.markdown) || "").trim();
      if (!markdown) { toast("这条回答没有内容", "bad"); return; }
      const page = Number(payload && payload.page) || 0;
      try {
        const note = await createNote({
          title: firstHeading(markdown) || firstLine(markdown) || "AI 回答",
          body: markdown + "\n",
          body_html: renderMarkdown(markdown),
          source: {
            path: docPath(),
            page,
            quote: "",
            location: page ? `AI 助读 · p.${page}` : "AI 助读",
          },
        });
        await this.open();
        await selectNote(note.id);
        toast("已存为笔记", "good");
      } catch (error) {
        handleError(error);
      }
    },
    refresh,
    get openState() { return state.open; },
  };

  window.ReaderNotes = ReaderNotes;

  async function handleQuery() {
    let params;
    try { params = new URLSearchParams(location.search); } catch { return; }
    const page = Number(params.get("page"));
    if (Number.isFinite(page) && page > 0) {
      try { window.ReaderBridge.goToPage(page); } catch { /* ignore */ }
    }
    const noteId = params.get("note");
    if (noteId) {
      await ReaderNotes.openNote(noteId);
    }
  }

  function init() {
    if (!build()) return;
    state.scope = readStore(STORE_SCOPE, "doc");
    if (el.scope) el.scope.textContent = state.scope === "doc" ? "本文" : "全部";
    state.geometry = clampGeometry(readJson(STORE_GEOMETRY) || defaultGeometry());
    applyGeometry(state.geometry);
    bindDrag();
    bindToolbar();
    bindSelectionTool();
    bindEvents();
    if (el.host) el.host.hidden = true;
    applyIdle();
    fetch("/api/health", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((health) => {
        if (!health) return;
        state.serverBuild = Number(health.build) || 0;
      })
      .catch(() => {});
    whenReady().then(handleQuery);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
