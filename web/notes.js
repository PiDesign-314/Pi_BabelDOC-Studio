/* 阅读器笔记面板：Markdown 记录、自动保存、停靠 / 悬浮两种模式。
   与 AI 助读、PDF 划词共享同一份数据（/api/notes），不依赖任何框架。
   公开 API：window.ReaderNotes = { open, close, toggle, createFromSelection,
   createFromAI, openNote, refresh }。 */
(function () {
  "use strict";

  const STORE_WIDTH = "babeldoc-notes-width";
  const STORE_MODE = "babeldoc-notes-mode";
  const STORE_FLOAT = "babeldoc-notes-float";
  const STORE_SCOPE = "babeldoc-notes-scope";

  const state = {
    open: false,
    loaded: false,
    loading: false,
    mode: "dock",
    scope: "doc",
    notes: [],
    categories: [],
    current: null,
    dirty: false,
    saving: false,
    saveTimer: 0,
    view: "edit",
    query: "",
    listScroll: 0,
  };

  const el = {};

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

  function refit() {
    if (window.ReaderBridge && typeof window.ReaderBridge.refit === "function") {
      try { window.ReaderBridge.refit(); } catch { /* reader not ready */ }
    }
  }

  /* ----------------------------------------------------------------- api -- */
  async function api(path, options) {
    const init = Object.assign({}, options || {});
    init.headers = Object.assign({ Accept: "application/json" }, init.headers || {});
    if (init.body && typeof init.body !== "string") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(path, init);
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      throw new Error((data && data.error) || `请求失败（${response.status}）`);
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
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
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
        const language = line.replace(/^\s*```/, "").trim();
        const buffer = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          buffer.push(lines[index]);
          index += 1;
        }
        index += 1;
        out.push(
          `<pre><code${language ? ` data-lang="${escapeHtml(language)}"` : ""}>` +
          `${escapeHtml(buffer.join("\n"))}</code></pre>`
        );
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

  function stripMarkdown(text, limit) {
    const plain = String(text || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[#>*_~|-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return limit && plain.length > limit ? plain.slice(0, limit - 1).trimEnd() + "…" : plain;
  }

  function firstLine(text) {
    const line = String(text || "")
      .split("\n")
      .map((part) => stripMarkdown(part, 0))
      .find((part) => part);
    return line ? line.slice(0, 60) : "";
  }

  function firstHeading(text) {
    const match = /^\s*#{1,6}\s+(.+)$/m.exec(String(text || ""));
    return match ? stripMarkdown(match[1], 60) : "";
  }

  function formatTime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const date = new Date(seconds * 1000);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  function sourceLabel(source) {
    const data = source || {};
    const page = Number(data.page) || 0;
    if (data.location) return data.location;
    if (page) return `第 ${page} 页`;
    if (data.quote) return "原文引用";
    if (data.path) return docName() || "文献";
    return "手动笔记";
  }

  /* --------------------------------------------------------------- build -- */
  function build() {
    const host = document.getElementById("notes-drawer");
    if (!host) return false;
    if (el.drawer === host) return true;
    host.innerHTML =
      '<div class="rn-resize" data-rn-resize-dock role="separator" aria-orientation="vertical" title="拖动调整笔记宽度"></div>' +
      '<header class="rn-head" data-rn-drag>' +
      '  <span class="rn-title">笔记</span>' +
      '  <span class="rn-state" data-rn-state></span>' +
      '  <div class="rn-actions">' +
      '    <button type="button" class="rn-iconbtn" data-rn-mode="dock" title="停靠在右侧">停靠</button>' +
      '    <button type="button" class="rn-iconbtn" data-rn-mode="float" title="切换为悬浮窗口">悬浮</button>' +
      '    <button type="button" class="rn-iconbtn" data-rn-new title="新建笔记">＋</button>' +
      '    <button type="button" class="rn-iconbtn" data-rn-close title="关闭">✕</button>' +
      '  </div>' +
      '</header>' +
      '<div class="rn-body">' +
      '  <section class="rn-list">' +
      '    <div class="rn-list-top">' +
      '      <label class="rn-search"><input type="search" data-rn-search placeholder="搜索笔记…" autocomplete="off"></label>' +
      '      <button type="button" class="rn-scope" data-rn-scope title="切换：只看本文 / 全部笔记">本文</button>' +
      '    </div>' +
      '    <div class="rn-items" data-rn-items></div>' +
      '  </section>' +
      '  <section class="rn-editor">' +
      '    <div class="rn-editor-top">' +
      '      <input class="rn-title-input" data-rn-title placeholder="笔记标题" autocomplete="off">' +
      '      <select class="rn-cat" data-rn-category title="分类"></select>' +
      '      <div class="rn-viewseg">' +
      '        <button type="button" data-rn-view="edit" class="on">编辑</button>' +
      '        <button type="button" data-rn-view="preview">预览</button>' +
      '      </div>' +
      '    </div>' +
      '    <textarea class="rn-textarea" data-rn-body placeholder="用 Markdown 记录…支持标题、列表、引用、代码块、表格和链接。"></textarea>' +
      '    <div class="rn-preview" data-rn-preview hidden></div>' +
      '    <div class="rn-editor-foot">' +
      '      <span class="rn-grow" data-rn-meta></span>' +
      '      <button type="button" class="rn-danger" data-rn-goto hidden>回到原文</button>' +
      '      <button type="button" class="rn-danger" data-rn-delete disabled>删除</button>' +
      '    </div>' +
      '  </section>' +
      '</div>' +
      '<div class="rn-float-resize" data-rn-resize-float title="拖动调整大小"></div>';

    el.drawer = host;
    el.button = document.getElementById("btn-notes");
    el.state = $("[data-rn-state]", host);
    el.items = $("[data-rn-items]", host);
    el.search = $("[data-rn-search]", host);
    el.scope = $("[data-rn-scope]", host);
    el.title = $("[data-rn-title]", host);
    el.category = $("[data-rn-category]", host);
    el.body = $("[data-rn-body]", host);
    el.preview = $("[data-rn-preview]", host);
    el.meta = $("[data-rn-meta]", host);
    el.delete = $("[data-rn-delete]", host);
    el.goto = $("[data-rn-goto]", host);
    el.viewButtons = Array.from(host.querySelectorAll("[data-rn-view]"));
    el.dockResize = $("[data-rn-resize-dock]", host);
    el.floatResize = $("[data-rn-resize-float]", host);
    el.drag = $("[data-rn-drag]", host);
    return true;
  }

  function setStatus(text, kind) {
    if (!el.state) return;
    el.state.textContent = text || "";
    el.state.dataset.kind = kind || "";
  }

  /* ---------------------------------------------------------------- list -- */
  function renderList() {
    if (!el.items) return;
    el.items.innerHTML = "";
    if (!state.notes.length) {
      const empty = document.createElement("div");
      empty.className = "rn-empty";
      empty.textContent = state.query
        ? "没有匹配的笔记。"
        : "还没有笔记。在 PDF 里选中文字点「存笔记」，或在 AI 回答下点「存为笔记」。";
      el.items.append(empty);
      return;
    }
    for (const note of state.notes) {
      const card = document.createElement("div");
      card.className = `rn-card${state.current && state.current.id === note.id ? " on" : ""}`;
      card.dataset.id = note.id;
      const title = document.createElement("div");
      title.className = "rn-card-title";
      title.textContent = note.title || "未命名笔记";
      const meta = document.createElement("div");
      meta.className = "rn-card-meta";
      meta.textContent = `${sourceLabel(note.source)}${note.updated ? " · " + formatTime(note.updated) : ""}`;
      card.append(title, meta);
      card.addEventListener("click", () => { void selectNote(note.id); });
      el.items.append(card);
    }
    if (el.items.scrollTop !== state.listScroll) el.items.scrollTop = state.listScroll;
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
    el.category.value = current;
    el.category.disabled = !state.current;
  }

  /* -------------------------------------------------------------- editor -- */
  function applyView() {
    const preview = state.view === "preview";
    if (el.body) el.body.hidden = preview;
    if (el.preview) el.preview.hidden = !preview;
    if (preview && el.preview) el.preview.innerHTML = renderMarkdown(el.body ? el.body.value : "");
    for (const button of el.viewButtons) {
      button.classList.toggle("on", button.dataset.rnView === state.view);
    }
  }

  function fillEditor() {
    const note = state.current;
    if (el.title) el.title.value = note ? note.title || "" : "";
    if (el.body) el.body.value = note ? note.body || "" : "";
    if (el.title) el.title.disabled = !note;
    if (el.body) el.body.disabled = !note;
    if (el.delete) el.delete.disabled = !note || !note.id;
    renderCategories();
    applyView();
    updateMeta();
    if (note && state.view === "preview" && el.preview) {
      el.preview.innerHTML = renderMarkdown(note.body || "");
    }
  }

  function updateMeta() {
    if (!el.meta) return;
    const note = state.current;
    if (!note) { el.meta.textContent = "选择或新建一条笔记"; return; }
    const bits = [sourceLabel(note.source)];
    if (note.updated) bits.push(`更新于 ${formatTime(note.updated)}`);
    if (state.dirty) bits.push("未保存");
    el.meta.textContent = bits.join(" · ");
    if (el.goto) {
      const page = Number((note.source && note.source.page) || 0);
      el.goto.hidden = !page;
      el.goto.title = page ? `跳回第 ${page} 页` : "";
    }
  }

  function scheduleSave() {
    if (!state.current) return;
    state.dirty = true;
    setStatus("未保存", "dirty");
    updateMeta();
    if (state.saveTimer) window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => { void saveNow(); }, 700);
  }

  async function flush() {
    if (state.saveTimer) {
      window.clearTimeout(state.saveTimer);
      state.saveTimer = 0;
    }
    let guard = 0;
    while (state.dirty && state.current && guard < 3) {
      guard += 1;
      await saveNow();
    }
  }

  async function saveNow() {
    if (!state.current || state.saving) return;
    const draft = state.current;
    const title = String(draft.title || "").trim();
    const body = String(draft.body || "");
    if (!draft.id && !title && !body.trim()) return;
    const payload = {
      title,
      body,
      category_id: draft.category_id || "",
      source: draft.source || {},
    };
    state.saving = true;
    state.dirty = false;
    setStatus("保存中…", "saving");
    try {
      const data = draft.id
        ? await api(`/api/notes/${encodeURIComponent(draft.id)}`, { method: "PATCH", body: payload })
        : await api("/api/notes", { method: "POST", body: payload });
      const note = data.note;
      if (!note) throw new Error("服务器没有返回笔记");
      const changed = state.dirty;
      if (!changed) {
        state.current = Object.assign({}, note);
      } else {
        /* 保存请求发出后用户又改了字：保留编辑器里的新内容，只把 id/时间带回来，
           等这一轮结束后立刻再存一次。 */
        state.current.id = note.id;
        state.current.updated = note.updated;
        state.current.created = note.created || state.current.created;
      }
      const index = state.notes.findIndex((entry) => entry.id === note.id);
      if (index >= 0) state.notes[index] = note;
      else state.notes.unshift(note);
      state.notes.sort((a, b) => Number(b.updated) - Number(a.updated));
      setStatus(`已保存 ${formatTime(note.updated)}`, "ok");
      if (el.delete) el.delete.disabled = false;
      renderList();
      renderCategories();
      updateMeta();
    } catch (error) {
      state.dirty = true;
      setStatus("保存失败", "bad");
      toast(error.message || "保存失败", "bad");
    } finally {
      state.saving = false;
      if (state.dirty && state.current) {
        if (state.saveTimer) window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(() => { void saveNow(); }, 250);
      }
    }
  }

  /* ----------------------------------------------------------- selection -- */
  function cloneNote(note) {
    return Object.assign({}, note, { source: Object.assign({}, note.source || {}) });
  }

  async function refresh() {
    state.loading = true;
    setStatus("加载中…", "");
    try {
      const params = new URLSearchParams();
      if (state.query) params.set("q", state.query);
      if (state.scope === "doc" && docPath()) params.set("path", docPath());
      const data = await api(`/api/notes?${params.toString()}`);
      state.notes = Array.isArray(data.notes) ? data.notes : [];
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      state.loaded = true;
      renderList();
      renderCategories();
      setStatus("", "");
    } catch (error) {
      setStatus("加载失败", "bad");
      toast(error.message || "加载笔记失败", "bad");
    } finally {
      state.loading = false;
    }
  }

  async function selectNote(noteId) {
    if (!noteId) return;
    const found = state.notes.find((note) => note.id === noteId);
    if (!found) return;
    if (state.current && state.current.id === found.id) return;
    await flush();
    state.current = cloneNote(found);
    state.dirty = false;
    state.view = "edit";
    fillEditor();
    renderList();
    setStatus(found.updated ? `已保存 ${formatTime(found.updated)}` : "", "ok");
  }

  function newNote() {
    void (async () => {
      await flush();
      state.current = {
        id: "",
        title: "",
        body: "",
        category_id: "",
        source: {
          path: docPath(),
          page: currentPage(),
          quote: "",
          location: docPath() ? `第 ${currentPage()} 页` : "手动笔记",
        },
        created: 0,
        updated: 0,
      };
      state.dirty = false;
      state.view = "edit";
      fillEditor();
      renderList();
      setStatus("新笔记", "");
      if (el.title) el.title.focus();
    })();
  }

  async function deleteCurrent() {
    const note = state.current;
    if (!note) return;
    if (!note.id) {
      state.current = null;
      state.dirty = false;
      fillEditor();
      renderList();
      return;
    }
    if (!window.confirm(`删除笔记「${note.title || "未命名笔记"}」？`)) return;
    try {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      state.notes = state.notes.filter((entry) => entry.id !== note.id);
      state.current = null;
      state.dirty = false;
      fillEditor();
      renderList();
      setStatus("已删除", "");
      toast("已删除笔记", "good");
    } catch (error) {
      toast(error.message || "删除失败", "bad");
    }
  }

  async function createNote(payload) {
    const data = await api("/api/notes", { method: "POST", body: payload });
    const note = data.note;
    if (!note) throw new Error("服务器没有返回笔记");
    state.notes.unshift(note);
    state.notes.sort((a, b) => Number(b.updated) - Number(a.updated));
    return note;
  }

  const ReaderNotes = {
    async open() {
      build();
      if (!el.drawer) return;
      if (state.closeTimer) { window.clearTimeout(state.closeTimer); state.closeTimer = 0; }
      el.drawer.hidden = false;
      state.open = true;
      if (el.button) el.button.setAttribute("aria-pressed", "true");
      if (!state.loaded) await refresh();
      applyMode();
      refit();
    },
    close() {
      if (!el.drawer) return;
      void flush();
      el.drawer.hidden = true;
      state.open = false;
      if (el.button) el.button.setAttribute("aria-pressed", "false");
      refit();
    },
    toggle() {
      if (state.open) this.close();
      else void this.open();
    },
    async openNote(noteId) {
      await this.open();
      if (!noteId) return;
      if (!state.notes.some((note) => note.id === noteId)) {
        state.scope = "all";
        persistScope();
        await refresh();
      }
      await selectNote(noteId);
    },
    async createFromSelection(captured) {
      const text = String((captured && captured.text) || "").trim();
      if (!text) { toast("没有选中文字", "bad"); return; }
      const page = Number(captured && captured.parts && captured.parts[0] && captured.parts[0].page) || currentPage();
      try {
        const note = await createNote({
          title: firstLine(text) || `第 ${page} 页的笔记`,
          body: `> ${text.split("\n").join("\n> ")}\n\n`,
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
        toast(error.message || "创建笔记失败", "bad");
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
        toast(error.message || "创建笔记失败", "bad");
      }
    },
    refresh,
    get openState() { return state.open; },
  };

  window.ReaderNotes = ReaderNotes;

  /* -------------------------------------------------------------- layout -- */
  function persistScope() {
    writeStore(STORE_SCOPE, state.scope);
  }

  function applyMode() {
    if (!el.drawer) return;
    const floating = state.mode === "float";
    el.drawer.classList.toggle("floating", floating);
    document.body.classList.toggle("rn-floating", floating);
    for (const button of el.drawer.querySelectorAll("[data-rn-mode]")) {
      button.classList.toggle("on", button.dataset.rnMode === state.mode);
    }
    if (floating) applyFloatGeometry();
    else applyDockWidth();
    refit();
  }

  function applyDockWidth() {
    const saved = Number(readStore(STORE_WIDTH, "0"));
    if (saved >= 360) el.drawer.style.setProperty("--rn-w", `${saved}px`);
    el.drawer.style.left = "";
    el.drawer.style.top = "";
    el.drawer.style.right = "";
    el.drawer.style.width = "";
    el.drawer.style.height = "";
  }

  function applyFloatGeometry() {
    const fallback = { x: Math.max(16, window.innerWidth - 500), y: 74, w: 470, h: Math.round(window.innerHeight * 0.72) };
    const saved = readJson(STORE_FLOAT) || {};
    const width = Math.min(Math.max(Number(saved.w) || fallback.w, 380), window.innerWidth - 32);
    const height = Math.min(Math.max(Number(saved.h) || fallback.h, 320), window.innerHeight - 96);
    const x = Math.min(Math.max(Number(saved.x) || fallback.x, 8), window.innerWidth - width - 8);
    const y = Math.min(Math.max(Number(saved.y) || fallback.y, 56), window.innerHeight - height - 8);
    el.drawer.style.right = "auto";
    el.drawer.style.left = `${Math.round(x)}px`;
    el.drawer.style.top = `${Math.round(y)}px`;
    el.drawer.style.setProperty("--rn-fw", `${Math.round(width)}px`);
    el.drawer.style.setProperty("--rn-fh", `${Math.round(height)}px`);
    el.drawer.style.width = `${Math.round(width)}px`;
    el.drawer.style.height = `${Math.round(height)}px`;
  }

  function saveFloatGeometry(x, y, w, h) {
    writeStore(STORE_FLOAT, JSON.stringify({ x, y, w, h }));
  }

  function bindLayout() {
    if (el.button) {
      el.button.addEventListener("click", () => { void ReaderNotes.toggle(); });
    }
    if (!el.drawer) return;

    for (const button of el.drawer.querySelectorAll("[data-rn-mode]")) {
      button.addEventListener("click", () => {
        state.mode = button.dataset.rnMode;
        writeStore(STORE_MODE, state.mode);
        applyMode();
      });
    }
    const close = $("[data-rn-close]", el.drawer);
    if (close) close.addEventListener("click", () => ReaderNotes.close());
    const fresh = $("[data-rn-new]", el.drawer);
    if (fresh) fresh.addEventListener("click", newNote);

    /* 停靠：拖动左边缘调宽 */
    let dockDrag = null;
    if (el.dockResize) {
      el.dockResize.addEventListener("pointerdown", (event) => {
        if (state.mode !== "dock" || event.button !== 0) return;
        event.preventDefault();
        dockDrag = { startX: event.clientX, startWidth: el.drawer.getBoundingClientRect().width };
        el.dockResize.classList.add("dragging");
        document.body.classList.add("rn-resizing");
        try { el.dockResize.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      });
      el.dockResize.addEventListener("pointermove", (event) => {
        if (!dockDrag) return;
        const max = Math.max(420, window.innerWidth - 420);
        const width = Math.min(max, Math.max(360, dockDrag.startWidth - (event.clientX - dockDrag.startX)));
        el.drawer.style.setProperty("--rn-w", `${Math.round(width)}px`);
      });
      const endDock = () => {
        if (!dockDrag) return;
        dockDrag = null;
        el.dockResize.classList.remove("dragging");
        document.body.classList.remove("rn-resizing");
        const width = parseFloat(el.drawer.style.getPropertyValue("--rn-w")) || 480;
        writeStore(STORE_WIDTH, String(Math.round(width)));
        refit();
      };
      el.dockResize.addEventListener("pointerup", endDock);
      el.dockResize.addEventListener("pointercancel", endDock);
    }

    /* 悬浮：拖动标题栏移动，右下角调大小 */
    let moveDrag = null;
    if (el.drag) {
      el.drag.addEventListener("pointerdown", (event) => {
        if (state.mode !== "float" || event.button !== 0) return;
        if (event.target.closest("button, input, select, textarea")) return;
        const rect = el.drawer.getBoundingClientRect();
        moveDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, w: rect.width, h: rect.height };
        document.body.classList.add("rn-resizing");
        try { el.drag.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      });
      el.drag.addEventListener("pointermove", (event) => {
        if (!moveDrag) return;
        const x = Math.min(Math.max(event.clientX - moveDrag.dx, 8), window.innerWidth - moveDrag.w - 8);
        const y = Math.min(Math.max(event.clientY - moveDrag.dy, 56), window.innerHeight - moveDrag.h - 8);
        el.drawer.style.left = `${Math.round(x)}px`;
        el.drawer.style.top = `${Math.round(y)}px`;
      });
      const endMove = () => {
        if (!moveDrag) return;
        const rect = el.drawer.getBoundingClientRect();
        moveDrag = null;
        document.body.classList.remove("rn-resizing");
        saveFloatGeometry(rect.left, rect.top, rect.width, rect.height);
        refit();
      };
      el.drag.addEventListener("pointerup", endMove);
      el.drag.addEventListener("pointercancel", endMove);
    }

    let sizeDrag = null;
    if (el.floatResize) {
      el.floatResize.addEventListener("pointerdown", (event) => {
        if (state.mode !== "float" || event.button !== 0) return;
        event.preventDefault();
        const rect = el.drawer.getBoundingClientRect();
        sizeDrag = { startX: event.clientX, startY: event.clientY, w: rect.width, h: rect.height, x: rect.left, y: rect.top };
        document.body.classList.add("rn-resizing");
        try { el.floatResize.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      });
      el.floatResize.addEventListener("pointermove", (event) => {
        if (!sizeDrag) return;
        const maxW = window.innerWidth - sizeDrag.x - 8;
        const maxH = window.innerHeight - sizeDrag.y - 8;
        const width = Math.min(maxW, Math.max(380, sizeDrag.w + (event.clientX - sizeDrag.startX)));
        const height = Math.min(maxH, Math.max(320, sizeDrag.h + (event.clientY - sizeDrag.startY)));
        el.drawer.style.setProperty("--rn-fw", `${Math.round(width)}px`);
        el.drawer.style.setProperty("--rn-fh", `${Math.round(height)}px`);
        el.drawer.style.width = `${Math.round(width)}px`;
        el.drawer.style.height = `${Math.round(height)}px`;
      });
      const endSize = () => {
        if (!sizeDrag) return;
        const rect = el.drawer.getBoundingClientRect();
        sizeDrag = null;
        document.body.classList.remove("rn-resizing");
        saveFloatGeometry(rect.left, rect.top, rect.width, rect.height);
        refit();
      };
      el.floatResize.addEventListener("pointerup", endSize);
      el.floatResize.addEventListener("pointercancel", endSize);
    }

    if (el.search) {
      let timer = 0;
      el.search.addEventListener("input", () => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          state.query = el.search.value.trim();
          void refresh();
        }, 200);
      });
    }
    if (el.scope) {
      el.scope.addEventListener("click", () => {
        state.scope = state.scope === "doc" ? "all" : "doc";
        persistScope();
        el.scope.textContent = state.scope === "doc" ? "本文" : "全部";
        void refresh();
      });
    }
    if (el.items) {
      el.items.addEventListener("scroll", () => { state.listScroll = el.items.scrollTop; }, { passive: true });
    }

    function bindEditor() {
      if (el.title) {
        el.title.addEventListener("input", () => { state.current.title = el.title.value; scheduleSave(); });
        el.title.addEventListener("blur", () => { void flush(); });
      }
      if (el.body) {
        el.body.addEventListener("input", () => {
          state.current.body = el.body.value;
          scheduleSave();
          if (state.view === "preview" && el.preview) el.preview.innerHTML = renderMarkdown(el.body.value);
        });
        el.body.addEventListener("blur", () => { void flush(); });
        el.body.addEventListener("keydown", (event) => {
          if (event.key !== "Tab") return;
          event.preventDefault();
          const start = el.body.selectionStart;
          const end = el.body.selectionEnd;
          el.body.value = `${el.body.value.slice(0, start)}  ${el.body.value.slice(end)}`;
          el.body.selectionStart = el.body.selectionEnd = start + 2;
          state.current.body = el.body.value;
          scheduleSave();
        });
      }
      if (el.category) {
        el.category.addEventListener("change", () => {
          state.current.category_id = el.category.value;
          scheduleSave();
          renderList();
        });
      }
      for (const button of el.viewButtons) {
        button.addEventListener("click", () => {
          state.view = button.dataset.rnView;
          applyView();
        });
      }
      if (el.delete) el.delete.addEventListener("click", () => { void deleteCurrent(); });
      if (el.goto) {
        el.goto.addEventListener("click", () => {
          const page = Number((state.current && state.current.source && state.current.source.page) || 0);
          if (page && window.ReaderBridge && typeof window.ReaderBridge.goToPage === "function") {
            window.ReaderBridge.goToPage(page);
          }
        });
      }
    }
    bindEditor();

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void flush();
    });
    window.addEventListener("beforeunload", () => {
      if (!state.dirty || !state.current) return;
      const draft = state.current;
      const payload = {
        title: draft.title || "",
        body: draft.body || "",
        category_id: draft.category_id || "",
        source: draft.source || {},
      };
      try {
        const url = draft.id ? `/api/notes/${encodeURIComponent(draft.id)}` : "/api/notes";
        fetch(url, {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch { /* best effort */ }
    });
  }

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
    state.mode = readStore(STORE_MODE, "dock");
    state.scope = readStore(STORE_SCOPE, "doc");
    if (el.scope) el.scope.textContent = state.scope === "doc" ? "本文" : "全部";
    applyMode();
    bindLayout();
    if (el.drawer) el.drawer.hidden = true;
    whenReady().then(handleQuery);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
