/* 阅读器笔记：悬浮式富文本编辑器（所见即所得），自动保存，兼容旧 Markdown 笔记。
   公开 API：window.ReaderNotes = { open, close, toggle, openNote,
   createFromSelection, createFromAI, refresh }。 */
(function () {
  "use strict";

  const STORE_GEOMETRY = "babeldoc-notes-window";
  const STORE_SCOPE = "babeldoc-notes-scope";
  const STORE_LIST = "babeldoc-notes-list";
  const MIN_W = 380;
  const MIN_H = 300;
  const MAX_W = 1000;
  const MAX_H = 1000;
  const MIN_HEAD = 44;

  /* AI 帮写的固定动作；「自定义要求」走单独的输入框。 */
  const AI_MODES = [
    { id: "polish", label: "润色表达", hint: "更通顺、更有逻辑" },
    { id: "academic", label: "学术化表达", hint: "严谨规范的书面语" },
    { id: "concise", label: "精简内容", hint: "删掉重复和冗余" },
    { id: "expand", label: "扩展内容", hint: "补充解释，不虚构事实" },
    { id: "structure", label: "整理结构", hint: "多级标题、列表、重点" },
    { id: "fix", label: "纠正语病", hint: "错别字与不通顺" },
  ];

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
    listOpen: true,
    revision: 0,
    serverBuild: 0,
    drag: null,
    resize: null,
    geometry: null,
    pdfSelection: null,
    selectionTimer: 0,
    selAnchor: null,
    selPromptOpen: false,
    selPromptRange: null,
    selPromptText: "",
    ai: null,
    aiUndo: null,
    aiSeq: 0,
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
    const path = String(data.path || "");
    if (path && path !== docPath()) return page ? `第 ${page} 页` : "其他文献";
    if (page) return `第 ${page} 页`;
    if (data.location) return data.location;
    if (data.quote) return "原文引用";
    if (path) return fileName(path) || "文献";
    return "独立笔记";
  }

  function currentSource() {
    const raw = (state.current && state.current.source) || {};
    return {
      path: String(raw.path || ""),
      page: Number(raw.page) || 0,
      quote: String(raw.quote || ""),
      location: String(raw.location || ""),
      doc_id: String(raw.doc_id || ""),
    };
  }

  function isLinked(source) {
    const data = source || currentSource();
    return Boolean(data.path || data.page || data.quote || data.location);
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
      '  <span class="rn-head-mark" aria-hidden="true">' +
      '    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '      <path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 12h7M9 16h5"/>' +
      '    </svg>' +
      '  </span>' +
      '  <span class="rn-head-title">笔记</span>' +
      '  <span class="rn-head-count" data-rn-count></span>' +
      '  <span class="rn-head-gap"></span>' +
      '  <button type="button" class="rn-hbtn rn-list-toggle" data-rn-list aria-pressed="true" title="收起笔记列表" aria-label="笔记列表">' +
      '    <span class="rn-hbtn-ico">☰</span><span class="rn-hbtn-label">列表</span>' +
      '  </button>' +
      '  <button type="button" class="rn-hbtn rn-hbtn-plus" data-rn-new title="新建笔记" aria-label="新建笔记">＋</button>' +
      '  <span class="rn-win-sep"></span>' +
      '  <button type="button" class="rn-win-btn" data-rn-min title="最小化笔记窗口" aria-label="最小化">—</button>' +
      '  <button type="button" class="rn-win-btn rn-win-close" data-rn-close title="关闭笔记" aria-label="关闭">×</button>' +
      '</header>' +
      '<div class="rn-main">' +
      '  <section class="rn-list">' +
      '    <div class="rn-list-top">' +
      '      <label class="rn-search"><input type="search" data-rn-search placeholder="搜索笔记…" autocomplete="off"></label>' +
      '      <button type="button" class="rn-scope" data-rn-scope title="切换：只看本文 / 全部笔记">本文</button>' +
      '    </div>' +
      '    <div class="rn-items" data-rn-items></div>' +
      '    <div class="rn-list-foot"><button type="button" class="rn-list-new" data-rn-list-new>＋ 新建独立笔记</button></div>' +
      '  </section>' +
      '  <section class="rn-editor" data-rn-editor>' +
      '    <div class="rn-doc-head">' +
      '      <input class="rn-title-input" data-rn-title placeholder="无标题笔记" autocomplete="off">' +
      '      <select class="rn-cat" data-rn-category title="分类"></select>' +
      '    </div>' +
      '    <div class="rn-toolbar" data-rn-toolbar role="toolbar" aria-label="格式工具">' +
      '      <div class="rn-tools" data-rn-tools>' +
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
      '      </div>' +
      '      <button type="button" class="rn-tbtn rn-ai-btn" data-rn-ai title="AI 帮写：润色、精简、整理结构" aria-haspopup="menu">' +
      '        <span class="rn-ai-ico" aria-hidden="true">✦</span><span class="rn-ai-text">AI 帮写</span>' +
      '      </button>' +
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
      '      <span class="rn-head-gap"></span>' +
      '      <button type="button" class="rn-source-act" data-rn-relink title="修改来源位置">修改</button>' +
      '      <button type="button" class="rn-source-act danger" data-rn-unlink title="只解除关联，不删除笔记内容">解除关联</button>' +
      '    </div>' +
      '    <div class="rn-linkbar" data-rn-linkbar hidden>' +
      '      <button type="button" class="rn-linkbtn" data-rn-link title="把这条笔记关联到当前文献的某一页或选中的文字">🔗 关联原文</button>' +
      '      <span class="rn-linkhint">独立笔记 · 不关联任何文献</span>' +
      '    </div>' +
      '    <div class="rn-ai-menu" data-rn-ai-menu hidden>' +
      '      <div class="rn-ai-menu-head"><span>AI 帮写</span>' +
      '        <button type="button" class="rn-ai-scope" data-rn-ai-scope title="切换处理范围：选中文本 / 整篇笔记">整篇笔记</button>' +
      '      </div>' +
      '      <div class="rn-ai-menu-list">' +
      AI_MODES.map(
        (mode) =>
          `        <button type="button" class="rn-ai-mode" data-rn-ai-mode="${mode.id}">` +
          `<span class="rn-ai-mode-label">${mode.label}</span>` +
          `<span class="rn-ai-mode-hint">${mode.hint}</span></button>`
      ).join("") +
      '      </div>' +
      '      <div class="rn-ai-custom">' +
      '        <input type="text" class="rn-ai-input" data-rn-ai-instruction maxlength="500" placeholder="自定义要求，例如：改成课堂讲解的口吻">' +
      '        <button type="button" class="rn-ai-custom-run" data-rn-ai-custom-run>执行</button>' +
      '      </div>' +
      '      <button type="button" class="rn-ai-undo" data-rn-ai-undo hidden>撤销上次 AI 修改</button>' +
      '    </div>' +
      '    <div class="rn-scroll" data-rn-scroll>' +
      '      <div class="rn-rich" data-rn-rich contenteditable="true" spellcheck="false" role="textbox" aria-multiline="true" data-placeholder="直接在这里输入，像用 Word 一样排版…"></div>' +
      '      <div class="rn-ai-panel" data-rn-ai-panel hidden>' +
      '        <div class="rn-ai-panel-head">' +
      '          <span class="rn-ai-panel-title"><span class="rn-ai-ico" aria-hidden="true">✦</span>' +
      '            <span data-rn-ai-panel-mode>AI 建议</span></span>' +
      '          <span class="rn-ai-panel-meta" data-rn-ai-panel-meta></span>' +
      '          <span class="rn-head-gap"></span>' +
      '          <span class="rn-ai-tabs" role="tablist">' +
      '            <button type="button" role="tab" data-rn-ai-tab="suggest" class="on">建议</button>' +
      '            <button type="button" role="tab" data-rn-ai-tab="diff">对比</button>' +
      '            <button type="button" role="tab" data-rn-ai-tab="origin">原文</button>' +
      '          </span>' +
      '          <button type="button" class="rn-ai-icon-btn" data-rn-ai-close title="收起建议" aria-label="收起建议">×</button>' +
      '        </div>' +
      '        <div class="rn-ai-panel-body" data-rn-ai-panel-body>' +
      '          <div class="rn-ai-view" data-rn-ai-view="suggest"></div>' +
      '          <div class="rn-ai-view" data-rn-ai-view="diff" hidden></div>' +
      '          <div class="rn-ai-view" data-rn-ai-view="origin" hidden></div>' +
      '          <div class="rn-ai-state" data-rn-ai-state hidden></div>' +
      '        </div>' +
      '        <div class="rn-ai-panel-foot">' +
      '          <button type="button" class="rn-ai-primary" data-rn-ai-accept disabled>替换原文</button>' +
      '          <button type="button" class="rn-ai-act" data-rn-ai-insert disabled>插入到下方</button>' +
      '          <button type="button" class="rn-ai-act" data-rn-ai-retry disabled>重新生成</button>' +
      '          <button type="button" class="rn-ai-act" data-rn-ai-cancel>取消</button>' +
      '          <span class="rn-head-gap"></span>' +
      '          <span class="rn-ai-note">确认后写入</span>' +
      '        </div>' +
      '      </div>' +
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
      '<div class="rn-linkmenu" data-rn-linkmenu hidden>' +
      '  <div class="rn-linkmenu-head">关联原文</div>' +
      '  <button type="button" data-rn-link-act="page">关联当前文献 · 第 <span data-rn-link-page>1</span> 页</button>' +
      '  <button type="button" data-rn-link-act="quote">关联选中的原文</button>' +
      '  <button type="button" data-rn-link-act="pick">指定页码…</button>' +
      '  <button type="button" class="danger" data-rn-link-act="unlink" hidden>解除关联</button>' +
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
      '  <div class="rn-seltool-main" data-rn-sel-main>' +
      '    <button type="button" data-rn-sel="bold" title="加粗"><b>B</b></button>' +
      '    <button type="button" data-rn-sel="italic" title="斜体"><i>I</i></button>' +
      '    <button type="button" data-rn-sel="underline" title="下划线"><u>U</u></button>' +
      '    <button type="button" data-rn-sel="strikeThrough" title="删除线"><s>S</s></button>' +
      '    <span class="rn-tsep"></span>' +
      '    <button type="button" class="rn-swatch" data-rn-sel-hilite="#fff3a3" style="--sw:#fff3a3" title="黄色高亮"></button>' +
      '    <button type="button" class="rn-swatch" data-rn-sel-hilite="#b7efc5" style="--sw:#b7efc5" title="绿色高亮"></button>' +
      '    <button type="button" class="rn-swatch" data-rn-sel-hilite="#fbcfe8" style="--sw:#fbcfe8" title="粉色高亮"></button>' +
      '    <span class="rn-tsep"></span>' +
      '    <button type="button" class="rn-sel-ai" data-rn-sel-ai-btn title="用 AI 改写选中的文字">' +
      '      <span class="rn-sel-ai-ico" aria-hidden="true">✦</span><span class="rn-sel-ai-label">AI</span>' +
      '    </button>' +
      '  </div>' +
      '  <form class="rn-seltool-prompt" data-rn-sel-prompt hidden>' +
      '    <span class="rn-seltool-prompt-ico" aria-hidden="true">✦</span>' +
      '    <input type="text" class="rn-seltool-input" data-rn-sel-input maxlength="500" autocomplete="off" placeholder="使用 AI 编辑…" title="描述你想怎么改写选中的文字">' +
      '    <button type="submit" class="rn-seltool-run" data-rn-sel-run title="执行" aria-label="执行">↑</button>' +
      '    <button type="button" class="rn-seltool-back" data-rn-sel-back title="返回格式工具" aria-label="返回格式工具">×</button>' +
      '  </form>' +
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
    el.listToggle = $("[data-rn-list]", host);
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
    el.linkbar = $("[data-rn-linkbar]", host);
    el.linkBtn = $("[data-rn-link]", host);
    el.linkMenu = $("[data-rn-linkmenu]", host);
    el.linkPage = $("[data-rn-link-page]", host);
    el.editor = $("[data-rn-editor]", host);
    el.blank = $("[data-rn-blank]", host);
    el.loading = $("[data-rn-loading]", host);
    el.error = $("[data-rn-error]", host);
    el.errorText = $("[data-rn-error-text]", host);
    el.errorTitle = $("[data-rn-error-title]", host);
    el.restart = $("[data-rn-restart]", host);
    el.retry = $("[data-rn-retry]", host);
    el.seltool = $("[data-rn-seltool]", host);
    el.selMain = $("[data-rn-sel-main]", host);
    el.selPrompt = $("[data-rn-sel-prompt]", host);
    el.selInput = $("[data-rn-sel-input]", host);
    el.selAiBtn = $("[data-rn-sel-ai-btn]", host);
    el.aiBtn = $("[data-rn-ai]", host);
    el.aiMenu = $("[data-rn-ai-menu]", host);
    el.aiScope = $("[data-rn-ai-scope]", host);
    el.aiInstruction = $("[data-rn-ai-instruction]", host);
    el.aiUndo = $("[data-rn-ai-undo]", host);
    el.aiPanel = $("[data-rn-ai-panel]", host);
    el.aiPanelMode = $("[data-rn-ai-panel-mode]", host);
    el.aiPanelMeta = $("[data-rn-ai-panel-meta]", host);
    el.aiState = $("[data-rn-ai-state]", host);
    el.aiViews = {
      suggest: $('[data-rn-ai-view="suggest"]', host),
      diff: $('[data-rn-ai-view="diff"]', host),
      origin: $('[data-rn-ai-view="origin"]', host),
    };
    el.aiTabs = Array.from(host.querySelectorAll("[data-rn-ai-tab]"));
    el.aiAccept = $("[data-rn-ai-accept]", host);
    el.aiInsert = $("[data-rn-ai-insert]", host);
    el.aiRetry = $("[data-rn-ai-retry]", host);
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
      const bits = [];
      if (note.source && note.source.path && note.source.path !== docPath()) {
        bits.push(fileName(note.source.path) || "其他文献");
      }
      bits.push(sourceLabel(note.source));
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
    if (el.aiBtn) el.aiBtn.disabled = idle;
    if (el.rich) el.rich.setAttribute("contenteditable", idle ? "false" : "true");
    if (idle) {
      if (el.title) el.title.value = "";
      if (el.rich) el.rich.innerHTML = "";
      if (el.meta) el.meta.textContent = "";
      if (el.source) el.source.hidden = true;
      if (el.linkbar) el.linkbar.hidden = true;
      closeAiPanel();
      closeLinkMenu();
    }
  }

  /* 来源信息单独放在正文上方的信息条里，避免和笔记正文混在一起。
     已关联：显示“来源：第 N 页 · 回到原文”+ 修改 / 解除关联。
     未关联：只保留一个低干扰的「关联原文」入口。 */
  function renderSource() {
    if (!el.source || !el.linkbar) return;
    if (!state.current) {
      el.source.hidden = true;
      el.linkbar.hidden = true;
      return;
    }
    const source = currentSource();
    const linked = isLinked(source);
    el.source.hidden = !linked;
    el.linkbar.hidden = linked;
    if (!linked) return;

    const where = [];
    if (source.path && source.path !== docPath()) where.push(fileName(source.path) || "文献");
    if (source.page) where.push(`第 ${source.page} 页`);
    if (!where.length && source.location) where.push(source.location);
    if (!where.length && source.path) where.push(fileName(source.path) || "文献");
    const label = where.length ? `来源：${where.join(" · ")}` : "来源：原文";
    const sameDoc = !source.path || source.path === docPath();
    const action = sameDoc
      ? (source.page ? "回到原文" : "查看原文")
      : "打开原文";
    el.sourceTag.textContent = `${label} · ${action}`;
    el.sourceTag.title = source.page ? `回到第 ${source.page} 页原文` : "打开来源文献";
    const quote = String(source.quote || "").trim();
    if (el.sourceQuote) {
      el.sourceQuote.textContent = quote
        ? quote.replace(/\s+/g, " ").slice(0, 180)
        : (source.location || "");
      el.sourceQuote.title = quote.slice(0, 800);
      el.sourceQuote.hidden = !quote;
    }
    const unlink = el.source.querySelector("[data-rn-unlink]");
    if (unlink) unlink.hidden = false;
    const relink = el.source.querySelector("[data-rn-relink]");
    if (relink) relink.hidden = false;
  }

  function renderMeta() {
    if (!el.meta) return;
    if (!state.current) { el.meta.textContent = ""; return; }
    const text = (el.rich.innerText || "").trim();
    const chars = Array.from(text.replace(/\s+/g, "")).length;
    const source = currentSource();
    const bits = [];
    if (source.path && source.path !== docPath()) {
      bits.push(fileName(source.path) || "文献");
      if (source.page) bits.push(`第 ${source.page} 页`);
    } else {
      bits.push(sourceLabel(source));
    }
    if (chars) bits.push(`${chars} 字`);
    const updated = formatTime(state.current.updated);
    if (updated) bits.push(`更新于 ${updated}`);
    el.meta.textContent = bits.filter(Boolean).join(" · ");
  }

  function fillEditor(note) {
    if (state.ai && (!note || !state.current || state.current.id !== note.id)) {
      closeAiPanel();
    }
    closeAiMenu();
    closeLinkMenu();
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
        renderSource();
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
    let failures = 0;
    for (let attempt = 0; attempt < 8 && state.current; attempt += 1) {
      if (state.saving) {
        await sleep(120);
        continue;
      }
      if (!state.dirty) break;
      await saveNow();
      if (state.dirty) {
        /* 连续失败时别在几毫秒内重试 8 次、弹一串错误提示。 */
        failures += 1;
        if (failures >= 3) break;
        await sleep(200);
      }
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
    /* 窄窗口下列表是浮层：选中后自动收起，把编辑区让出来（不改变记住的偏好）。 */
    if (isCompact() && state.listOpen) setListOpen(false, { persist: false });
  }

  async function createNote(payload) {
    const data = await api("/api/notes", { method: "POST", body: payload });
    const note = data.note;
    if (!note) throw new Error("服务器没有返回笔记");
    const linkedPath = note.source && note.source.path;
    /* 独立笔记没有来源路径，任何列表范围里都应该能看到它。 */
    const inScope =
      state.scope === "all" || !docPath() || !linkedPath || linkedPath === docPath();
    if (inScope) {
      state.notes.unshift(note);
      state.notes.sort((a, b) => Number(b.updated) - Number(a.updated));
    }
    return note;
  }

  /* 手动新建 = 独立笔记：不自动绑定当前 PDF 页面，需要时再手动关联。 */
  async function newNote() {
    await flush();
    try {
      const note = await createNote({
        title: "",
        body: "",
        body_html: "",
        source: {},
      });
      await selectNote(note.id);
      if (el.title) el.title.focus();
      setStatus("新笔记", "");
      toast("已新建独立笔记，可点「关联原文」绑定文献", "good");
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
      state.aiUndo = null;
      applyIdle();
      refreshAiUndo();
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
      const suffix = params.toString();
      const data = await api(`/api/notes${suffix ? `?${suffix}` : ""}`);
      const all = Array.isArray(data.notes) ? data.notes : [];
      /* 「本文」范围 = 关联到当前文献的笔记 + 独立笔记（没有来源，属于个人笔记）。 */
      const doc = docPath();
      state.notes =
        state.scope === "doc" && doc
          ? all.filter((note) => !note.source || !note.source.path || note.source.path === doc)
          : all;
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
      showError("无法连接本地服务，请确认 ReadPI 仍在运行。");
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
        const header = `# ReadPI 笔记导出\n\n导出时间：${new Date().toLocaleString("zh-CN")}\n\n---\n\n`;
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

  function isCompact() {
    if (!state.geometry) return false;
    return state.geometry.w < 520;
  }

  function applyCompact() {
    if (!el.host || !state.geometry) return;
    el.host.classList.toggle("compact", isCompact());
  }

  /* 左侧笔记列表：默认展开，可手动收起并记住状态；收起后编辑区占满窗口。 */
  function applyListState() {
    if (!el.host) return;
    el.host.classList.toggle("list-closed", !state.listOpen);
    if (el.listToggle) {
      el.listToggle.classList.toggle("on", state.listOpen);
      el.listToggle.setAttribute("aria-pressed", state.listOpen ? "true" : "false");
      el.listToggle.title = state.listOpen ? "收起笔记列表" : "展开笔记列表";
      el.listToggle.setAttribute("aria-label", state.listOpen ? "收起笔记列表" : "展开笔记列表");
    }
  }

  function setListOpen(open, options) {
    const opts = options || {};
    const next = Boolean(open);
    if (state.listOpen === next) return;
    state.listOpen = next;
    /* 自动收起（窄窗口选中笔记后）不覆盖用户记住的偏好。 */
    if (opts.persist !== false) writeStore(STORE_LIST, next ? "1" : "0");
    applyListState();
    if (next && opts.focus) {
      const card = el.items && el.items.querySelector(".rn-card");
      if (card) window.setTimeout(() => { try { card.focus(); } catch { /* ignore */ } }, 30);
    }
  }

  function bindDrag() {
    if (!el.head) return;
    el.head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button, input, select, a, .rn-hbtn, .rn-win-btn")) return;
      const rect = el.host.getBoundingClientRect();
      state.drag = {
        startX: event.clientX,
        startY: event.clientY,
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      };
      el.head.classList.add("dragging");
      try { el.head.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      event.preventDefault();
    });
    el.head.addEventListener("pointermove", (event) => {
      if (!state.drag) return;
      const dx = event.clientX - state.drag.startX;
      const dy = event.clientY - state.drag.startY;
      /* 最小化时只按 44px 的标题栏高度限制，保证紧凑条也能拖到窗口底部。 */
      const width = state.drag.w;
      const height = state.minimized ? MIN_HEAD : state.drag.h;
      const x = Math.min(Math.max(state.drag.x + dx, 8), Math.max(8, window.innerWidth - width - 8));
      const y = Math.min(Math.max(state.drag.y + dy, 8), Math.max(8, window.innerHeight - height - 8));
      if (!state.geometry) state.geometry = { x, y, w: width, h: state.drag.h };
      state.geometry.x = Math.round(x);
      state.geometry.y = Math.round(y);
      if (!state.minimized) {
        state.geometry.w = Math.round(width);
        state.geometry.h = Math.round(state.drag.h);
      }
      el.host.style.left = `${state.geometry.x}px`;
      el.host.style.top = `${state.geometry.y}px`;
    });
    const endDrag = () => {
      if (!state.drag) return;
      state.drag = null;
      el.head.classList.remove("dragging");
      if (state.geometry) {
        /* 拖动后确保窗口至少留一块可操作区域在屏幕内；最小化时按标题栏高度算。 */
        const height = state.minimized ? MIN_HEAD : state.geometry.h;
        const width = state.geometry.w;
        state.geometry.x = Math.min(
          Math.max(state.geometry.x, 8),
          Math.max(8, window.innerWidth - width - 8)
        );
        state.geometry.y = Math.min(
          Math.max(state.geometry.y, 8),
          Math.max(8, window.innerHeight - height - 8)
        );
        el.host.style.left = `${state.geometry.x}px`;
        el.host.style.top = `${state.geometry.y}px`;
      }
      saveGeometry();
    };
    el.head.addEventListener("pointerup", endDrag);
    el.head.addEventListener("pointercancel", endDrag);
    /* 标题栏双击 = 最小化 / 展开，省一次瞄准。 */
    el.head.addEventListener("dblclick", (event) => {
      if (event.target.closest("button, input, select, a, .rn-hbtn, .rn-win-btn")) return;
      setMinimized(!state.minimized);
    });

    for (const handle of el.handles) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || state.minimized) return;
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
    const hide = () => {
      if (!el.seltool) return;
      el.seltool.hidden = true;
      if (state.selPromptOpen) resetSelPrompt();
    };
    const update = () => {
      if (!state.open || !el.seltool || !el.rich) { hide(); return; }
      /* 正在输入 AI 要求时不跟随选区变化，否则输入框一获焦就消失。 */
      if (state.selPromptOpen) return;
      /* AI 菜单 / 建议面板打开时不再浮出格式栏，避免遮挡操作。 */
      if ((el.aiPanel && !el.aiPanel.hidden) || (el.aiMenu && !el.aiMenu.hidden)) {
        hide();
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { hide(); return; }
      const range = selection.getRangeAt(0);
      if (!el.rich.contains(range.commonAncestorContainer)) { hide(); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hide(); return; }
      resetSelPrompt();
      state.selAnchor = {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
      el.seltool.hidden = false;
      window.requestAnimationFrame(placeSelTool);
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
    if (el.selAiBtn) el.selAiBtn.addEventListener("click", openSelPrompt);
    if (el.selPrompt) {
      el.selPrompt.addEventListener("submit", (event) => {
        event.preventDefault();
        void submitSelPrompt();
      });
    }
    if (el.selInput) {
      el.selInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeSelPrompt(true);
          return;
        }
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          void submitSelPrompt();
        }
      });
    }
    const back = el.seltool.querySelector("[data-rn-sel-back]");
    if (back) back.addEventListener("click", () => closeSelPrompt(true));
    document.addEventListener("mousedown", (event) => {
      if (el.seltool.hidden) return;
      if (event.target.closest("[data-rn-seltool]")) return;
      if (el.rich.contains(event.target)) return;
      hide();
    });
  }

  /* 浮动格式栏用固定定位：按当前工具栏宽度重新夹取，避免跑到屏幕外。 */
  function placeSelTool() {
    if (!el.seltool || el.seltool.hidden) return;
    const anchor = state.selAnchor;
    if (!anchor) return;
    const width = el.seltool.offsetWidth || 220;
    const height = el.seltool.offsetHeight || 36;
    let left = anchor.left + anchor.width / 2 - width / 2;
    let top = anchor.top - height - 10;
    if (top < 8) top = anchor.bottom + 10;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));
    el.seltool.style.left = `${Math.round(left)}px`;
    el.seltool.style.top = `${Math.round(top)}px`;
  }

  function resetSelPrompt() {
    state.selPromptOpen = false;
    state.selPromptRange = null;
    state.selPromptText = "";
    if (el.selPrompt) el.selPrompt.hidden = true;
    if (el.selMain) el.selMain.hidden = false;
  }

  function openSelPrompt() {
    if (!el.rich || !el.selPrompt) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      toast("先选中要改写的文字", "bad");
      return;
    }
    const range = selection.getRangeAt(0);
    if (!el.rich.contains(range.commonAncestorContainer)) return;
    const text = String(selection.toString() || "").trim();
    if (!text) { toast("先选中要改写的文字", "bad"); return; }
    state.selPromptRange = range.cloneRange();
    state.selPromptText = text;
    state.selPromptOpen = true;
    if (el.selMain) el.selMain.hidden = true;
    el.selPrompt.hidden = false;
    if (el.selInput) {
      el.selInput.value = "";
      el.selInput.focus();
    }
    window.requestAnimationFrame(placeSelTool);
  }

  function closeSelPrompt(restoreFocus) {
    resetSelPrompt();
    if (restoreFocus && el.rich) el.rich.focus();
    window.requestAnimationFrame(placeSelTool);
  }

  async function submitSelPrompt() {
    const instruction = el.selInput ? String(el.selInput.value || "").trim() : "";
    if (!instruction) {
      toast("写一句修改要求再执行", "bad");
      if (el.selInput) el.selInput.focus();
      return;
    }
    const range = state.selPromptRange;
    const selText = state.selPromptText;
    if (!range || !selText) {
      toast("选中区域已失效，请重新选择", "bad");
      closeSelPrompt();
      return;
    }
    if (el.seltool) el.seltool.hidden = true;
    resetSelPrompt();
    state.ai = {
      scope: "selection",
      originalText: selText,
      selectionText: selText,
      selectionRange: range,
      noteText: noteMarkdownText(),
      range,
      mode: "custom",
      instruction,
      modeLabel: "自定义要求",
      result: "",
      provider: "",
      model: "",
      loading: false,
      error: "",
      tab: "suggest",
    };
    await runAi("custom", instruction);
  }

  /* ------------------------------------------------------------- AI 帮写 -- */
  function notePlainText() {
    if (!el.rich) return "";
    return String(el.rich.innerText || "").replace(/\u00a0/g, " ").trim();
  }

  function noteMarkdownText() {
    const html = sanitizeHtml(el.rich ? el.rich.innerHTML : "");
    const markdown = htmlToMarkdown(html).trim();
    return markdown || notePlainText();
  }

  function plainFromMarkdown(markdown) {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;left:-9999px;top:0;width:600px;";
    box.innerHTML = sanitizeHtml(renderMarkdown(String(markdown || "")));
    /* 只有挂在文档里，innerText 才会保留块级元素之间的换行。 */
    document.body.append(box);
    const text = String(box.innerText || box.textContent || "").replace(/\u00a0/g, " ");
    box.remove();
    return text.trim();
  }

  function plainToHtml(text) {
    return String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => escapeHtml(line))
      .join("<br>");
  }

  /* 选中文本优先只改选中部分；没有选中时才处理整篇。 */
  function editorSelectionRange() {
    if (!el.rich || el.rich.getAttribute("contenteditable") === "false") return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!el.rich.contains(range.commonAncestorContainer)) return null;
    const text = String(selection.toString() || "").trim();
    if (!text) return null;
    return { range: range.cloneRange(), text };
  }

  function aiModeLabel(id) {
    const found = AI_MODES.find((mode) => mode.id === id);
    return found ? found.label : "自定义要求";
  }

  function refreshAiUndo() {
    if (el.aiUndo) el.aiUndo.hidden = !state.aiUndo;
  }

  function closeAiMenu() {
    if (el.aiMenu) el.aiMenu.hidden = true;
    if (el.aiBtn) el.aiBtn.classList.remove("on");
  }

  function openAiMenu() {
    if (!state.current) { toast("先打开或新建一条笔记", "bad"); return; }
    const selection = editorSelectionRange();
    const selectionText = selection ? selection.text : "";
    const noteText = noteMarkdownText();
    const scope = selection ? "selection" : "note";
    const text = selection ? selectionText : noteText;
    if (!text.trim()) { toast("笔记还是空的，先写点内容吧", "bad"); return; }
    /* 浮出的划词格式栏会挡住 AI 菜单，打开时先收起。 */
    if (el.seltool) el.seltool.hidden = true;
    state.ai = {
      scope,
      originalText: text,
      selectionText,
      selectionRange: selection ? selection.range : null,
      noteText,
      range: selection ? selection.range : null,
      mode: "",
      instruction: "",
      modeLabel: "",
      result: "",
      provider: "",
      model: "",
      loading: false,
      error: "",
      tab: "suggest",
    };
    renderAiScope();
    if (el.aiInstruction) el.aiInstruction.value = "";
    refreshAiUndo();
    if (el.aiMenu) el.aiMenu.hidden = false;
    if (el.aiBtn) el.aiBtn.classList.add("on");
  }

  /* 处理范围默认由选区决定，也可以在菜单里点一下在「选中文本 / 整篇笔记」之间切换。 */
  function renderAiScope() {
    if (!el.aiScope || !state.ai) return;
    const ai = state.ai;
    const chars = Array.from(String(ai.originalText || "").replace(/\s+/g, "")).length;
    const canSwitch = ai.scope === "selection"
      ? Boolean(String(ai.noteText || "").trim())
      : Boolean(String(ai.selectionText || "").trim());
    el.aiScope.textContent = ai.scope === "selection" ? `选中文本 · ${chars} 字` : "整篇笔记";
    el.aiScope.title = canSwitch
      ? "点击切换处理范围：选中文本 / 整篇笔记"
      : ai.scope === "selection"
        ? "只处理选中的文字"
        : "处理整篇笔记";
    el.aiScope.classList.toggle("switchable", canSwitch);
    el.aiScope.disabled = !canSwitch;
  }

  function toggleAiScope() {
    const ai = state.ai;
    if (!ai) return;
    if (ai.scope === "selection") {
      if (!String(ai.noteText || "").trim()) return;
      ai.scope = "note";
      ai.originalText = ai.noteText;
    } else {
      if (!String(ai.selectionText || "").trim()) return;
      ai.scope = "selection";
      ai.originalText = ai.selectionText;
      ai.range = ai.selectionRange;
    }
    renderAiScope();
    if (el.aiInstruction) el.aiInstruction.focus();
  }

  function closeAiPanel() {
    state.ai = null;
    state.aiSeq += 1;
    if (el.host) el.host.classList.remove("ai-open");
    if (el.aiPanel) el.aiPanel.hidden = true;
    if (el.aiState) el.aiState.hidden = true;
    if (el.aiPanelMeta) el.aiPanelMeta.textContent = "";
    for (const view of Object.values(el.aiViews || {})) {
      if (view) { view.hidden = true; view.textContent = ""; }
    }
    for (const button of el.aiTabs || []) button.classList.toggle("on", button.dataset.rnAiTab === "suggest");
    refreshAiUndo();
  }

  function setAiTab(tab) {
    if (!state.ai) return;
    state.ai.tab = tab;
    for (const button of el.aiTabs || []) {
      button.classList.toggle("on", button.dataset.rnAiTab === tab);
    }
    for (const [name, node] of Object.entries(el.aiViews || {})) {
      if (node) node.hidden = name !== tab;
    }
    renderAiViews();
  }

  function renderAiViews() {
    const ai = state.ai;
    if (!ai || ai.loading || ai.error) return;
    const result = String(ai.result || "");
    const noteScope = ai.scope !== "selection";
    const originPlain = noteScope ? plainFromMarkdown(ai.originalText) || ai.originalText : ai.originalText;
    const resultPlain = noteScope ? plainFromMarkdown(result) : result;
    const suggest = el.aiViews && el.aiViews.suggest;
    if (suggest) {
      if (noteScope) {
        suggest.innerHTML = sanitizeHtml(renderMarkdown(result));
      } else {
        suggest.textContent = result;
        suggest.classList.add("is-plain");
      }
      if (noteScope) suggest.classList.remove("is-plain");
    }
    const origin = el.aiViews && el.aiViews.origin;
    if (origin) origin.textContent = originPlain;
    const diff = el.aiViews && el.aiViews.diff;
    if (diff) diff.innerHTML = diffMarkup(originPlain, resultPlain);
  }

  function renderAiPanel() {
    if (!el.aiPanel) return;
    const ai = state.ai;
    if (!ai) {
      el.aiPanel.hidden = true;
      return;
    }
    const wasHidden = el.aiPanel.hidden;
    el.aiPanel.hidden = false;
    if (el.host) el.host.classList.add("ai-open");
    /* 建议块内联在正文末尾：第一次出现时滚动到可见位置，
       避免用户以为「点了没反应」。 */
    if (wasHidden) {
      window.requestAnimationFrame(() => {
        try {
          if (el.aiPanel && !el.aiPanel.hidden) {
            el.aiPanel.scrollIntoView({ block: "nearest" });
          }
        } catch { /* ignore */ }
      });
    }
    if (el.aiPanelMode) {
      el.aiPanelMode.textContent = `${ai.modeLabel || "AI 建议"}${ai.scope === "selection" ? " · 选中文本" : " · 整篇笔记"}`;
    }
    if (el.aiPanelMeta) {
      el.aiPanelMeta.textContent = ai.loading
        ? "生成中…"
        : ai.error
          ? "生成失败"
          : [ai.provider, ai.model].filter(Boolean).join(" · ");
    }
    const busy = Boolean(ai.loading);
    const failed = Boolean(ai.error);
    const ready = Boolean(ai.result) && !failed && !busy;
    if (el.aiAccept) el.aiAccept.disabled = !ready;
    if (el.aiInsert) el.aiInsert.disabled = !ready;
    if (el.aiRetry) el.aiRetry.disabled = busy || !ai.mode;
    for (const button of el.aiTabs || []) button.disabled = busy || failed;
    for (const [name, node] of Object.entries(el.aiViews || {})) {
      if (node) node.hidden = busy || failed || name !== (ai.tab || "suggest");
    }
    if (el.aiState) {
      el.aiState.hidden = !(busy || failed);
      el.aiState.textContent = "";
      if (busy) {
        const spinner = document.createElement("span");
        spinner.className = "rn-spinner";
        el.aiState.append(spinner);
        el.aiState.append(document.createTextNode(" AI 正在生成建议…"));
      } else if (failed) {
        const title = document.createElement("strong");
        title.textContent = "AI 帮写失败";
        const text = document.createElement("p");
        text.textContent = ai.error;
        el.aiState.append(title, text);
      }
    }
    if (ready) renderAiViews();
  }

  async function runAi(mode, instruction) {
    const ai = state.ai;
    if (!ai || !state.current) return;
    if (mode) ai.mode = mode;
    if (instruction !== undefined) ai.instruction = String(instruction || "");
    if (ai.mode === "custom" && !ai.instruction.trim()) {
      toast("先填写自定义要求", "bad");
      return;
    }
    ai.modeLabel = ai.mode === "custom" ? "自定义要求" : aiModeLabel(ai.mode);
    ai.loading = true;
    ai.error = "";
    ai.result = "";
    ai.tab = "suggest";
    closeAiMenu();
    if (el.seltool) el.seltool.hidden = true;
    renderAiPanel();
    const seq = ++state.aiSeq;
    const noteId = state.current.id;
    try {
      const data = await api("/api/notes/ai/polish", {
        method: "POST",
        body: {
          text: ai.originalText,
          mode: ai.mode,
          instruction: ai.instruction,
          scope: ai.scope,
          title: (el.title && el.title.value.trim()) || "",
        },
      });
      if (seq !== state.aiSeq || !state.ai || !state.current || state.current.id !== noteId) return;
      ai.result = String(data.result || "").trim();
      ai.provider = String(data.provider || "");
      ai.model = String(data.model || "");
      if (!ai.result) throw new Error("AI 没有返回内容，请换一种方式重试");
    } catch (error) {
      if (seq !== state.aiSeq || !state.ai) return;
      const status = Number(error && error.status) || 0;
      if (status === 404) {
        ai.error = "当前后端版本还不支持 AI 帮写，请重启应用后再试";
      } else if (error && error.message) {
        ai.error = error.message;
      } else {
        ai.error = "AI 帮写失败，请稍后重试";
      }
    } finally {
      if (seq === state.aiSeq && state.ai) {
        state.ai.loading = false;
        renderAiPanel();
      }
    }
  }

  /* 把 AI 结果写回编辑器；写入前先留一份快照，方便一键撤销。 */
  function applyAi(where) {
    const ai = state.ai;
    if (!ai || !ai.result || !state.current || !el.rich) return;
    const snapshot = { html: el.rich.innerHTML, noteId: state.current.id };
    if (where === "replace" && ai.scope === "selection") {
      const range = ai.range;
      if (!range || !range.commonAncestorContainer.isConnected) {
        toast("原来的选中区域已失效，请重新选择后重试", "bad");
        return;
      }
      const holder = document.createElement("div");
      holder.innerHTML = plainToHtml(ai.result);
      const fragment = document.createDocumentFragment();
      while (holder.firstChild) fragment.append(holder.firstChild);
      range.deleteContents();
      range.insertNode(fragment);
    } else if (where === "replace") {
      el.rich.innerHTML = sanitizeHtml(renderMarkdown(ai.result));
    } else if (ai.scope === "selection" && ai.range) {
      /* 插到选中内容所在段落的后面，保持正文层次。 */
      const block = blockElementFor(ai.range.endContainer);
      if (block && block.parentNode) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = plainToHtml(ai.result);
        const paragraph = document.createElement("p");
        while (wrapper.firstChild) paragraph.append(wrapper.firstChild);
        block.insertAdjacentElement("afterend", paragraph);
      } else {
        el.rich.insertAdjacentHTML("beforeend", `<p>${plainToHtml(ai.result)}</p>`);
      }
    } else {
      el.rich.insertAdjacentHTML("beforeend", sanitizeHtml(renderMarkdown(ai.result)));
    }
    state.aiUndo = snapshot;
    closeAiPanel();
    markDirty();
    renderMeta();
    toast(where === "replace" ? "已替换原文，可从「AI 帮写」菜单撤销" : "已插入到下方", "good");
  }

  function blockElementFor(node) {
    let current = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
    while (current && current !== el.rich) {
      const tag = current.tagName ? current.tagName.toLowerCase() : "";
      if (tag === "li") {
        const list = current.parentNode;
        if (list && list.tagName && (list.tagName.toLowerCase() === "ul" || list.tagName.toLowerCase() === "ol")) {
          return list;
        }
      }
      if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"].includes(tag)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  }

  function undoAi() {
    if (!state.aiUndo || !el.rich || !state.current) return;
    if (state.aiUndo.noteId && state.current.id !== state.aiUndo.noteId) {
      toast("这条撤销记录属于另一条笔记", "bad");
      return;
    }
    el.rich.innerHTML = sanitizeHtml(state.aiUndo.html);
    state.aiUndo = null;
    refreshAiUndo();
    markDirty();
    renderMeta();
    toast("已撤销上次 AI 修改", "good");
  }

  /* 轻量差异对比：CJK 按字、西文按词做 LCS；超长文本退到句子级。 */
  function diffTokens(text) {
    return String(text || "").match(/[\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+|\r?\n|[^\S\r\n]+|[\s\S]/g) || [];
  }

  function sentenceTokens(text) {
    return String(text || "").match(/[^\n。！？!?;；]+[。！？!?;；]?|\n/g) || [];
  }

  function diffMarkup(oldText, newText) {
    let a = diffTokens(oldText);
    let b = diffTokens(newText);
    if (a.length * b.length > 1_200_000) {
      a = sentenceTokens(oldText);
      b = sentenceTokens(newText);
    }
    if (!a.length || !b.length || a.length * b.length > 1_200_000) {
      return `<del>${escapeHtml(oldText)}</del><ins>${escapeHtml(newText)}</ins>`;
    }
    const width = b.length + 1;
    const dir = new Uint8Array((a.length + 1) * width);
    let prev = new Uint32Array(b.length + 1);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      const cur = new Uint32Array(b.length + 1);
      for (let j = b.length - 1; j >= 0; j -= 1) {
        if (a[i] === b[j]) {
          cur[j] = prev[j + 1] + 1;
          dir[i * width + j] = 1;
        } else if (prev[j] >= cur[j + 1]) {
          cur[j] = prev[j];
          dir[i * width + j] = 2;
        } else {
          cur[j] = cur[j + 1];
          dir[i * width + j] = 3;
        }
      }
      prev = cur;
    }
    const pieces = [];
    let kind = "";
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      if (kind === "del") pieces.push(`<del class="rn-del">${escapeHtml(buffer)}</del>`);
      else if (kind === "ins") pieces.push(`<ins class="rn-ins">${escapeHtml(buffer)}</ins>`);
      else pieces.push(escapeHtml(buffer));
      buffer = "";
    };
    const push = (next, text) => {
      if (next !== kind) { flush(); kind = next; }
      buffer += text;
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      const choice = dir[i * width + j];
      if (choice === 1) { push("eq", a[i]); i += 1; j += 1; }
      else if (choice === 2) { push("del", a[i]); i += 1; }
      else { push("ins", b[j]); j += 1; }
    }
    while (i < a.length) { push("del", a[i]); i += 1; }
    while (j < b.length) { push("ins", b[j]); j += 1; }
    flush();
    return pieces.join("");
  }

  /* ------------------------------------------------------- 原文关联 -- */
  function closeLinkMenu() {
    if (el.linkMenu) el.linkMenu.hidden = true;
  }

  function openLinkMenu() {
    if (!state.current || !el.linkMenu) return;
    const source = currentSource();
    if (el.linkPage) el.linkPage.textContent = String(currentPage() || 1);
    const quoteBtn = el.linkMenu.querySelector('[data-rn-link-act="quote"]');
    if (quoteBtn) {
      const hasSelection = Boolean(state.pdfSelection && state.pdfSelection.text);
      quoteBtn.disabled = !hasSelection;
      quoteBtn.title = hasSelection
        ? `关联到选中的原文（第 ${state.pdfSelection.page || currentPage()} 页）`
        : "先在 PDF 里选中一段原文，再回来关联";
    }
    const unlink = el.linkMenu.querySelector('[data-rn-link-act="unlink"]');
    if (unlink) unlink.hidden = !isLinked(source);
    el.linkMenu.hidden = false;
    const anchor = el.linkBtn && !el.linkbar.hidden ? el.linkBtn : el.sourceTag;
    const hostRect = el.host.getBoundingClientRect();
    const rect = anchor ? anchor.getBoundingClientRect() : hostRect;
    const width = el.linkMenu.offsetWidth || 220;
    const left = Math.min(
      Math.max(10, rect.left - hostRect.left),
      Math.max(10, hostRect.width - width - 10)
    );
    const top = Math.min(
      Math.max(50, rect.bottom - hostRect.top + 6),
      Math.max(50, hostRect.height - 40)
    );
    el.linkMenu.style.left = `${Math.round(left)}px`;
    el.linkMenu.style.top = `${Math.round(top)}px`;
  }

  async function applyLink(action) {
    if (!state.current) return;
    closeLinkMenu();
    if (action === "unlink") {
      state.current.source = {};
      state.dirty = true;
      state.revision += 1;
      renderSource();
      renderMeta();
      scheduleSave();
      await flush();
      toast("已解除关联，笔记内容保持不变", "good");
      return;
    }
    const source = currentSource();
    const next = {
      path: source.path,
      page: source.page,
      quote: source.quote,
      location: source.location,
      doc_id: source.doc_id,
    };
    if (action === "page") {
      next.path = docPath();
      next.page = currentPage() || 1;
      next.quote = "";
      next.location = `第 ${next.page} 页`;
    } else if (action === "quote") {
      const selection = state.pdfSelection;
      if (!selection || !selection.text) {
        toast("先在 PDF 里选中一段原文再来关联", "bad");
        return;
      }
      next.path = docPath();
      next.page = Number(selection.page) || currentPage() || 1;
      next.quote = String(selection.text).slice(0, 2000);
      next.location = `第 ${next.page} 页`;
    } else if (action === "pick") {
      const raw = window.prompt("要关联到第几页？", String(source.page || currentPage() || 1));
      const page = Number(String(raw || "").trim());
      if (!Number.isFinite(page) || page <= 0) return;
      next.path = docPath();
      next.page = Math.round(page);
      next.quote = "";
      next.location = `第 ${next.page} 页`;
    } else {
      return;
    }
    state.current.source = next;
    renderSource();
    renderMeta();
    markDirty();
    await flush();
    toast("已关联原文，可随时修改或解除", "good");
  }

  function rememberPdfSelection() {
    if (!window.ReaderBridge || typeof window.ReaderBridge.getSelection !== "function") return;
    let captured = null;
    try { captured = window.ReaderBridge.getSelection(); } catch { captured = null; }
    if (!captured || !captured.text) return;
    const page = Number(captured.parts && captured.parts[0] && captured.parts[0].page) || 0;
    state.pdfSelection = { text: String(captured.text), page, at: Date.now() };
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
      if (el.aiMenu && !el.aiMenu.hidden) {
        if (!event.target.closest("[data-rn-ai-menu]") && !event.target.closest("[data-rn-ai]")) {
          closeAiMenu();
        }
      }
      if (el.linkMenu && !el.linkMenu.hidden) {
        if (!event.target.closest("[data-rn-linkmenu]") && !event.target.closest("[data-rn-link]")) {
          closeLinkMenu();
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
    const listNew = el.host.querySelector("[data-rn-list-new]");
    if (listNew) listNew.addEventListener("click", () => { void newNote(); });
    if (el.listToggle) {
      el.listToggle.addEventListener("click", () => {
        setListOpen(!state.listOpen, { focus: true });
      });
    }

    /* 原文关联：未关联笔记的入口 / 已关联笔记的修改与解除。 */
    if (el.linkBtn) el.linkBtn.addEventListener("click", () => openLinkMenu());
    const relink = el.host.querySelector("[data-rn-relink]");
    if (relink) relink.addEventListener("click", () => openLinkMenu());
    const unlink = el.host.querySelector("[data-rn-unlink]");
    if (unlink) unlink.addEventListener("click", () => { void applyLink("unlink"); });
    if (el.linkMenu) {
      for (const button of el.linkMenu.querySelectorAll("[data-rn-link-act]")) {
        button.addEventListener("click", () => { void applyLink(button.dataset.rnLinkAct); });
      }
    }

    /* AI 帮写：只有用户主动点按钮 / 选动作时才发请求。 */
    if (el.aiBtn) {
      el.aiBtn.addEventListener("click", () => {
        if (el.aiMenu && !el.aiMenu.hidden) { closeAiMenu(); return; }
        openAiMenu();
      });
    }
    if (el.aiMenu) {
      for (const button of el.aiMenu.querySelectorAll("[data-rn-ai-mode]")) {
        button.addEventListener("click", () => { void runAi(button.dataset.rnAiMode, ""); });
      }
      if (el.aiScope) {
        el.aiScope.addEventListener("click", (event) => {
          event.preventDefault();
          toggleAiScope();
        });
      }
      const customRun = el.aiMenu.querySelector("[data-rn-ai-custom-run]");
      if (customRun) {
        customRun.addEventListener("click", () => {
          void runAi("custom", el.aiInstruction ? el.aiInstruction.value : "");
        });
      }
      if (el.aiInstruction) {
        el.aiInstruction.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void runAi("custom", el.aiInstruction.value);
        });
      }
      if (el.aiUndo) el.aiUndo.addEventListener("click", () => { closeAiMenu(); undoAi(); });
    }
    if (el.aiPanel) {
      const panelClose = el.aiPanel.querySelector("[data-rn-ai-close]");
      if (panelClose) panelClose.addEventListener("click", closeAiPanel);
      const cancel = el.aiPanel.querySelector("[data-rn-ai-cancel]");
      if (cancel) cancel.addEventListener("click", closeAiPanel);
      for (const button of el.aiTabs || []) {
        button.addEventListener("click", () => setAiTab(button.dataset.rnAiTab));
      }
      if (el.aiAccept) el.aiAccept.addEventListener("click", () => applyAi("replace"));
      if (el.aiInsert) el.aiInsert.addEventListener("click", () => applyAi("insert"));
      if (el.aiRetry) {
        el.aiRetry.addEventListener("click", () => {
          if (state.ai) void runAi(state.ai.mode, state.ai.instruction);
        });
      }
    }
    document.addEventListener("mousedown", (event) => {
      if (!state.open) return;
      if (el.host && el.host.contains(event.target)) return;
      if (el.aiMenu && !el.aiMenu.hidden) closeAiMenu();
      if (el.linkMenu && !el.linkMenu.hidden) closeLinkMenu();
      if (el.moreMenu && !el.moreMenu.hidden) el.moreMenu.hidden = true;
      if (el.menu && !el.menu.hidden) el.menu.hidden = true;
    });
    document.addEventListener("selectionchange", () => {
      /* 笔记本窗口没打开时也记住最近一次 PDF 选中文字，
         这样先划词再打开笔记，仍然可以「关联选中的原文」。 */
      if (el.rich && (document.activeElement === el.rich || el.rich.contains(document.activeElement))) return;
      if (state.selectionTimer) window.clearTimeout(state.selectionTimer);
      state.selectionTimer = window.setTimeout(rememberPdfSelection, 200);
    });

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
        /* 切换范围会清空编辑器，先把还没落盘的输入保存掉。 */
        await flush();
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
        const source = currentSource();
        if (source.path && source.path !== docPath()) {
          window.location.href = `/viewer?path=${encodeURIComponent(source.path)}&page=${source.page || 1}`;
          return;
        }
        const page = source.page || 1;
        /* 有选中的原文片段时尽量定位到具体段落，否则退回整页跳转。 */
        if (
          source.quote &&
          window.ReaderBridge &&
          typeof window.ReaderBridge.flashText === "function"
        ) {
          Promise.resolve(window.ReaderBridge.flashText(page, source.quote)).then((found) => {
            if (found === false && window.ReaderBridge.goToPage) {
              window.ReaderBridge.goToPage(page);
            }
          }).catch(() => {
            if (window.ReaderBridge && typeof window.ReaderBridge.goToPage === "function") {
              window.ReaderBridge.goToPage(page);
            }
          });
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
      if (state.minimized) {
        state.geometry.x = Math.min(
          Math.max(state.geometry.x, 8),
          Math.max(8, window.innerWidth - state.geometry.w - 8)
        );
        state.geometry.y = Math.min(
          Math.max(state.geometry.y, 8),
          Math.max(8, window.innerHeight - MIN_HEAD - 8)
        );
        el.host.style.left = `${state.geometry.x}px`;
        el.host.style.top = `${state.geometry.y}px`;
        return;
      }
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
    const next = Boolean(value);
    state.minimized = next;
    if (el.host) el.host.classList.toggle("min", next);
    if (next) {
      closeAiMenu();
      closeLinkMenu();
      if (el.menu) el.menu.hidden = true;
      if (el.moreMenu) el.moreMenu.hidden = true;
      if (el.seltool) el.seltool.hidden = true;
    } else if (state.geometry) {
      /* 展开时回到之前的尺寸；窗口可能被拖到边缘，重新夹回可视区域。 */
      applyGeometry(state.geometry);
    }
    if (el.min) {
      el.min.textContent = next ? "▢" : "—";
      el.min.title = next ? "展开笔记窗口" : "最小化笔记窗口";
      el.min.setAttribute("aria-label", next ? "展开笔记窗口" : "最小化笔记窗口");
    }
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
      applyListState();
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
      closeAiMenu();
      closeLinkMenu();
      if (el.moreMenu) el.moreMenu.hidden = true;
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
        toast("已存为笔记（已带入原文位置，可随时解除）", "good");
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
        toast("已存为笔记（已带入原文位置，可随时解除）", "good");
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
    /* 默认显示笔记列表；记住用户上次的选择。 */
    state.listOpen = readStore(STORE_LIST, "1") !== "0";
    if (el.scope) el.scope.textContent = state.scope === "doc" ? "本文" : "全部";
    state.geometry = clampGeometry(readJson(STORE_GEOMETRY) || defaultGeometry());
    applyGeometry(state.geometry);
    applyListState();
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
