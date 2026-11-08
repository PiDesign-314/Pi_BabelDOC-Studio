/* BabelDOC Studio — reader table of contents.
 *
 * The 目录 tab of the left sidebar shows the paper's structure: the PDF
 * bookmarks when the document has them, otherwise the headings detected on the
 * server. viewer.js owns the reader; this script only talks to it through
 * window.ReaderBridge and the reader:pagechange event, so the two stay
 * independent and either can change without touching the other.
 *
 * Loading, empty and error states all render inside #panel-toc, so a PDF
 * without an outline still gets an explanation instead of an empty column.
 */
(() => {
  "use strict";

  const panel = document.getElementById("panel-toc");
  if (!panel) return;

  const SOURCE_LABEL = { outline: "PDF 大纲", heuristic: "自动识别", none: "未识别" };
  const MIN_LEVEL = 1;
  const MAX_LEVEL = 6;

  const params = new URLSearchParams(location.search);
  const docPath =
    params.get("path") ||
    (window.ReaderBridge && window.ReaderBridge.docPath) ||
    "";

  const state = {
    items: [], /* [{ title, page, level }] */
    buttons: [], /* rendered .r-toc-item nodes, same order as items */
    source: "none",
    query: "",
    active: -1, /* highlighted index, -1 = none */
    pinned: -1, /* item the reader clicked; its own pagechange must not steal it */
    token: 0, /* guards against out-of-order responses */
    list: null,
    nomatch: null,
  };

  const el = {};

  /* ------------------------------------------------------------- helpers -- */
  function normalize(text) {
    /* Filtering ignores case and every kind of whitespace: "1intro" matches
       "1  Introduction" and "方法" matches "方 法". */
    return String(text ?? "").toLowerCase().replace(/\s+/g, "");
  }

  function cleanTitle(raw, page) {
    const title = String(raw ?? "").replace(/\s+/g, " ").trim();
    return title || `第 ${page} 页`;
  }

  function pageOf(raw) {
    const page = Math.round(Number(raw && raw.page));
    return Number.isFinite(page) && page > 0 ? page : 0;
  }

  function levelOf(raw) {
    const level = Math.round(Number(raw && raw.level));
    if (!Number.isFinite(level) || level < MIN_LEVEL) return MIN_LEVEL;
    return Math.min(level, MAX_LEVEL);
  }

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function bridge() {
    return window.ReaderBridge || null;
  }

  function currentPage() {
    const reader = bridge();
    const page = reader && typeof reader.currentPage === "function" ? reader.currentPage() : 1;
    return Number(page) > 0 ? Number(page) : 1;
  }

  function toast(message, kind = "") {
    const studio = window.Studio;
    if (studio && typeof studio.toast === "function") studio.toast(message, kind);
  }

  /* ----------------------------------------------------------- tool panel -- */
  function mount() {
    panel.innerHTML = `
      <div class="r-toc-head">
        <div class="r-toc-meta">
          <span class="r-toc-source" data-source="loading">识别中…</span>
          <span class="r-toc-count" hidden></span>
          <button class="r-toc-refresh" type="button" title="重新识别目录" aria-label="重新识别目录">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
                 stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M13.3 6.4A5.5 5.5 0 1 0 13.4 9"/>
              <path d="M13.2 2.8v3.8H9.4"/>
            </svg>
          </button>
        </div>
        <div class="r-toc-search">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
               stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4"/>
            <path d="m10.4 10.4 3 3"/>
          </svg>
          <input class="r-toc-filter" type="search" placeholder="过滤标题…"
                 aria-label="过滤目录标题" autocomplete="off" spellcheck="false" disabled>
        </div>
      </div>
      <div class="r-toc-body"></div>`;

    el.source = panel.querySelector(".r-toc-source");
    el.count = panel.querySelector(".r-toc-count");
    el.refresh = panel.querySelector(".r-toc-refresh");
    el.filter = panel.querySelector(".r-toc-filter");
    el.body = panel.querySelector(".r-toc-body");

    el.refresh.addEventListener("click", () => load({ force: true }));
    el.filter.addEventListener("input", () => {
      state.query = el.filter.value;
      applyFilter();
    });
    el.filter.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !el.filter.value) return;
      event.preventDefault();
      el.filter.value = "";
      state.query = "";
      applyFilter();
    });
    el.body.addEventListener("click", onListClick);

    document.addEventListener("reader:pagechange", onPageChange);
    document.addEventListener("reader:ready", onReaderReady);

    setupTabs();
    load();
  }

  function setHead(source, countText) {
    el.source.dataset.source = source;
    el.source.textContent = SOURCE_LABEL[source] || (source === "loading" ? "识别中…" : "读取失败");
    if (countText === null || countText === undefined) {
      el.count.hidden = true;
    } else {
      el.count.hidden = false;
      el.count.textContent = countText;
    }
  }

  function setBusy(busy) {
    panel.setAttribute("aria-busy", String(Boolean(busy)));
    el.refresh.disabled = Boolean(busy);
    el.refresh.classList.toggle("spin", Boolean(busy));
    el.filter.disabled = Boolean(busy) || !state.items.length;
  }

  /* ------------------------------------------------------------- states -- */
  function showLoading(force) {
    setHead("loading", null);
    el.source.textContent = force ? "重新识别中" : "识别中…";
    setBusy(true);
    el.body.innerHTML = `
      <div class="r-toc-loading" role="status">
        <span class="r-spinner" aria-hidden="true"></span>
        <span>${force ? "正在重新识别目录…" : "正在识别目录…"}</span>
      </div>
      <div class="r-toc-skeleton" aria-hidden="true">${"<i></i>".repeat(6)}</div>`;
    state.list = null;
    state.nomatch = null;
    state.buttons = [];
    state.active = -1;
  }

  function showEmpty() {
    setHead(state.source, "0 条");
    setBusy(false);
    el.body.innerHTML = `
      <div class="r-toc-empty" role="status">
        <p>这个 PDF 没有内置目录，也没识别到标题。</p>
        <p class="r-toc-empty-hint">可以点右上角的重新识别再试一次。</p>
      </div>`;
    state.list = null;
    state.nomatch = null;
    state.buttons = [];
    state.active = -1;
  }

  function showError(reason) {
    setHead("error", null);
    setBusy(false);
    el.body.innerHTML = `
      <div class="r-toc-error" role="alert">
        <p class="r-toc-error-title">目录读取失败</p>
        <p class="r-toc-error-msg">${esc(reason)}</p>
        <button class="r-toc-retry" type="button">重试</button>
      </div>`;
    state.items = [];
    state.list = null;
    state.nomatch = null;
    state.buttons = [];
    state.active = -1;
    const retry = el.body.querySelector(".r-toc-retry");
    if (retry) retry.addEventListener("click", () => load({ force: true }));
  }

  /* ------------------------------------------------------------- render -- */
  function render() {
    if (!state.items.length) {
      showEmpty();
      return;
    }
    setHead(state.source, `${state.items.length} 条`);

    const list = document.createElement("div");
    list.className = "r-toc-list";
    state.buttons = state.items.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "r-toc-item";
      button.dataset.page = String(item.page);
      button.dataset.level = String(item.level);
      button.dataset.index = String(index);
      /* Indentation is a style detail, so keep it in CSS via a custom
         property instead of hard-coding padding here. */
      button.style.setProperty("--lv", String(item.level - 1));
      button.title = item.title;

      const title = document.createElement("span");
      title.className = "r-toc-title";
      title.textContent = item.title;
      const page = document.createElement("span");
      page.className = "r-toc-page";
      page.textContent = String(item.page);
      button.append(title, page);
      list.append(button);
      return button;
    });

    const nomatch = document.createElement("div");
    nomatch.className = "r-toc-empty r-toc-nomatch";
    nomatch.setAttribute("role", "status");
    nomatch.hidden = true;

    el.body.replaceChildren(list, nomatch);
    state.list = list;
    state.nomatch = nomatch;
    state.active = -1;
    setBusy(false);
    applyFilter();
    setActiveIndex(nearestIndex(currentPage()), { scroll: false });
  }

  function applyFilter() {
    if (!state.list) return;
    const query = normalize(state.query);
    let visible = 0;
    state.buttons.forEach((button, index) => {
      const match = !query || normalize(state.items[index].title).includes(query);
      button.hidden = !match;
      if (match) visible += 1;
    });
    el.count.hidden = false;
    el.count.textContent = query
      ? `${visible} / ${state.items.length} 条`
      : `${state.items.length} 条`;
    if (state.nomatch) {
      state.nomatch.hidden = !(query && visible === 0);
      if (query && visible === 0) {
        state.nomatch.textContent = `没有匹配「${state.query.trim()}」的条目。`;
      }
    }
  }

  function nearestIndex(page) {
    /* The last section that starts at or before the current page is the one
       being read. Outlines are document-ordered, so a backward scan is right
       even when several chapters share a page. */
    let index = -1;
    for (let i = 0; i < state.items.length; i += 1) {
      if (state.items[i].page <= page) index = i;
    }
    return index;
  }

  function reveal(button) {
    if (panel.hidden || button.hidden) return;
    button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function setActiveIndex(index, opts = {}) {
    if (!state.buttons.length) return;
    const next = index >= 0 && index < state.buttons.length ? index : -1;
    if (next === state.active) {
      if (opts.scroll && next >= 0) reveal(state.buttons[next]);
      return;
    }
    if (state.active >= 0 && state.buttons[state.active]) {
      state.buttons[state.active].classList.remove("on");
      state.buttons[state.active].removeAttribute("aria-current");
    }
    state.active = next;
    if (next >= 0) {
      const button = state.buttons[next];
      button.classList.add("on");
      button.setAttribute("aria-current", "true");
      if (opts.scroll) reveal(button);
    }
  }

  /* ------------------------------------------------------------ jumping -- */
  function jump(item) {
    const reader = bridge();
    if (!reader) {
      toast("阅读器还没有载入完成，请稍后再试", "bad");
      return;
    }
    /* Jump first, then ask the reader to flash the heading text. Both calls
       are fire-and-forget: flashText may wait for the text layer, and the
       scroll must never be held back by that wait. */
    if (typeof reader.goToPage === "function") {
      try {
        reader.goToPage(item.page);
      } catch {
        /* the bridge is best effort */
      }
    }
    if (typeof reader.flashText === "function") {
      try {
        Promise.resolve(reader.flashText(item.page, item.title)).catch(() => {});
      } catch {
        /* older bridge builds may throw synchronously */
      }
    }
  }

  function onListClick(event) {
    const button = event.target.closest ? event.target.closest(".r-toc-item") : null;
    if (!button || !state.list || !state.list.contains(button)) return;
    const index = Number(button.dataset.index);
    const item = state.items[index];
    if (!item) return;
    state.pinned = index;
    setActiveIndex(index, { scroll: true });
    jump(item);
  }

  function onPageChange(event) {
    const page = Number(event.detail && event.detail.page);
    if (!Number.isFinite(page) || page <= 0 || !state.buttons.length) return;
    const pinned = state.pinned;
    if (pinned >= 0 && state.items[pinned] && state.items[pinned].page === page) {
      /* Caused by our own jump: keep the entry the reader clicked on. */
      setActiveIndex(pinned, { scroll: true });
      return;
    }
    state.pinned = -1;
    setActiveIndex(nearestIndex(page), { scroll: true });
  }

  function onReaderReady() {
    state.pinned = -1;
    setActiveIndex(nearestIndex(currentPage()), { scroll: false });
  }

  /* --------------------------------------------------------- data loading -- */
  async function load(opts = {}) {
    const force = Boolean(opts.force);
    const token = (state.token += 1);
    state.query = el.filter.value;
    state.pinned = -1;
    showLoading(force);

    if (!docPath) {
      if (token === state.token) showError("地址里缺少 PDF 路径（path 参数），无法读取目录。");
      return;
    }

    const query = new URLSearchParams({ path: docPath });
    if (force) query.set("force", "1");
    try {
      const response = await fetch(`/api/reader/toc?${query.toString()}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (token !== state.token) return;
      if (!response.ok) {
        throw new Error((data && (data.error || data.message)) || `请求失败（${response.status}）`);
      }
      if (!data || !Array.isArray(data.items)) {
        throw new Error("目录接口返回的数据不完整。");
      }
      applyData(data, force);
    } catch (error) {
      if (token !== state.token) return;
      let message = error && error.message ? error.message : "未知错误";
      if (error instanceof TypeError) message = "无法连接本地服务，请确认应用正在运行。";
      showError(message);
    }
  }

  function applyData(data, force) {
    const source = ["outline", "heuristic", "none"].includes(data.source)
      ? data.source
      : data.items.length
        ? "heuristic"
        : "none";
    const items = [];
    for (const raw of data.items) {
      const page = pageOf(raw);
      if (!page) continue; /* an entry without a destination cannot jump */
      items.push({
        title: cleanTitle(raw && raw.title, page),
        page,
        level: levelOf(raw),
      });
    }
    /* Some outlines start at level 2; shift them so the top chapter is flush
       left and the sidebar stays usable at its 178px default width. */
    const topLevel = items.reduce((min, item) => Math.min(min, item.level), MAX_LEVEL);
    if (topLevel > MIN_LEVEL) {
      for (const item of items) item.level = Math.max(MIN_LEVEL, item.level - topLevel + 1);
    }

    state.source = items.length ? source : "none";
    state.items = items;
    state.pinned = -1;
    render();

    if (force) {
      toast(
        state.items.length ? `目录已更新：${state.items.length} 条` : "没有识别到目录",
        state.items.length ? "good" : ""
      );
    }
  }

  /* ---------------------------------------------------------------- tabs -- */
  function setupTabs() {
    const tabs = Array.from(document.querySelectorAll(".r-tab"));
    const thumbs = document.getElementById("panel-thumbs");
    const notes = document.getElementById("panel-notes");
    if (!tabs.length) return;

    const panelFor = (name) => (name === "thumbs" ? thumbs : name === "notes" ? notes : panel);

    for (const tab of tabs) {
      const name = tab.dataset.tab || "";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panelFor(name) ? panelFor(name).id : "");
      tab.setAttribute("aria-selected", String(tab.classList.contains("on")));
      tab.addEventListener("click", () => {
        const onToc = tab.dataset.tab === "toc";
        /* viewer.js keeps handling thumbs / notes. This listener only owns the
           toc panel; hiding the other two here keeps a single visible panel
           regardless of listener order. */
        if (onToc) {
          if (thumbs) thumbs.hidden = true;
          if (notes) notes.hidden = true;
          panel.hidden = false;
        } else {
          panel.hidden = true;
        }
        for (const other of tabs) {
          other.setAttribute("aria-selected", String(other === tab));
        }
        if (!onToc) return;
        /* Opening the tab should show where reading stopped. */
        const page = currentPage();
        let index = nearestIndex(page);
        if (state.pinned >= 0 && state.items[state.pinned] && state.items[state.pinned].page === page) {
          index = state.pinned;
        }
        setActiveIndex(index, { scroll: true });
      });
    }
  }

  mount();
})();
