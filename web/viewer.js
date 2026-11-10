/* ReadPI — built-in PDF reader.
 *
 * The document scrolls continuously, page after page, so reading never stops
 * at a page boundary and a selection can run from one page into the next.
 *
 * Performance notes (long translated papers used to stutter while scrolling):
 *  - page offsets live in a cached layout model, so a scroll frame never reads
 *    the DOM geometry of every page;
 *  - highlights are painted from the line bands stored with the annotation,
 *    not recomputed from live text ranges on every repaint;
 *  - PDF.js text layers are skipped off-screen (content-visibility) and built
 *    only for the page being read, once scrolling has paused;
 *  - thumbnails are rendered only while the reader is idle;
 *  - every page is paint-contained, so one page never repaints another.
 */
(() => {
  "use strict";

  const { $, $$, api, toast, escapeHtml, fileName, download, bindTheme } = window.Studio;

  const params = new URLSearchParams(location.search);
  const docPath = params.get("path") || "";
  const origin = params.get("from") || "library";
  /* Zotero (and notes) may ask for a specific page: `page` is 1-based and wins
     over the locally remembered position.  `from=zotero` only changes the
     toast, the reader stays the same reader. */
  const requestedPage = Math.max(0, Math.round(Number(params.get("page")) || 0));

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdfjs/build/pdf.worker.min.js";
  }

  const AHEAD = 900; /* px of pages kept rendered above / below the viewport */
  const KEEP = 4; /* pages kept in memory on either side of the reader */
  const TIP_DELAY = 160; /* ms of hover before the note preview opens */
  const POSITION_KEY = "babeldoc-pos:";
  const COLOR_PALETTE = {
    yellow: "#ffd54a",
    green: "#74dc9e",
    blue: "#7cc4ff",
    pink: "#ff9ec7",
    orange: "#ffb066",
    purple: "#b79bff",
    teal: "#4fd6c6",
    red: "#ff8a80",
  };
  /* Colour tags may use a custom #rrggbb value, which is not a palette key.
     Every paint site indexes COLOR_HEX with the stored colour, so a hex key
     resolves to itself here: marks, badges, margin cards, leader lines and
     note dots stay correct for custom colours without a lookup at each call. */
  const COLOR_HEX = new Proxy(COLOR_PALETTE, {
    get(target, key) {
      if (typeof key !== "string") return target[key];
      return target[key] || (/^#[0-9a-f]{6}$/i.test(key) ? key.toLowerCase() : undefined);
    },
  });
  const COLOR_LABEL = {
    yellow: "黄色",
    green: "绿色",
    blue: "蓝色",
    pink: "粉色",
    orange: "橙色",
    purple: "紫色",
    teal: "青色",
    red: "红色",
  };
  const DEFAULT_COLOR_LABELS = {
    yellow: "疑问",
    green: "结论",
    red: "重点",
    blue: "证据",
    pink: "灵感",
    orange: "待办",
    purple: "定义",
    teal: "方法",
  };

  /* Freehand strokes and lines default to a clear red so a sketch is visible
     on the page immediately; page text keeps its dark default. */
  const DEFAULT_INK = "#ff375f";
  const LEGACY_INK = "#30343b";
  const INK_VALUE = /^#[0-9a-f]{6}$/i;
  function savedInkColor() {
    const value = String(readerPrefs.inkColor || "").toLowerCase();
    /* #30343b was the old automatic default, not a deliberate pick. */
    return INK_VALUE.test(value) && value !== LEGACY_INK ? value : DEFAULT_INK;
  }
  function savedTextColor() {
    const value = String(readerPrefs.textColor || "").toLowerCase();
    return INK_VALUE.test(value) ? value : LEGACY_INK;
  }
  /* ------------------------------------------------------- colour tags -- */
  /* A colour value is either a palette key or a custom #rrggbb tag colour. */
  const COLOR_VALUE = /^#[0-9a-f]{6}$/i;
  function colorValue(value) {
    const key = String(value == null ? "" : value).trim().toLowerCase();
    if (COLOR_PALETTE[key]) return key;
    return COLOR_VALUE.test(key) ? key : "";
  }
  /* The one colour resolver: palette key -> hex, #rrggbb -> itself, else the
     yellow fallback.  An annotation whose tag was deleted keeps rendering in
     the colour value stored with it. */
  function colorHex(value) {
    const key = String(value == null ? "" : value).trim().toLowerCase();
    return COLOR_HEX[key] || COLOR_PALETTE.yellow;
  }
  function colorName(value) {
    return COLOR_LABEL[colorValue(value)] || "";
  }
  function paletteKey(value) {
    return COLOR_PALETTE[colorValue(value)] ? colorValue(value) : "";
  }
  /* A tag whose custom hex happens to be an exact palette colour is stored as
     that palette key again, so re-adding green restores the green palette dot
     (and keeps the pastel CSS band) instead of a second, lookalike tag. */
  function normalizeTagColor(value) {
    const color = colorValue(value);
    if (!color) return "";
    const exact = Object.keys(COLOR_PALETTE).find(
      (key) => COLOR_PALETTE[key].toLowerCase() === color
    );
    return exact || color;
  }

  /* The single ordered source of truth: readerPrefs.colorTags =
     [{ id, color, name }], color a palette key or a custom #rrggbb.
     Annotations store their own colour value, so tag edits never touch them. */
  let colorTagsCache = null;
  function defaultColorTags() {
    const labels =
      readerPrefs.labels && typeof readerPrefs.labels === "object" ? readerPrefs.labels : {};
    return Object.keys(COLOR_PALETTE).map((key) => ({
      id: key,
      color: key,
      name: String(labels[key] || DEFAULT_COLOR_LABELS[key] || COLOR_LABEL[key] || key),
    }));
  }
  function newColorTagId() {
    return `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function readColorTags() {
    if (colorTagsCache) return colorTagsCache;
    const stored = Array.isArray(readerPrefs.colorTags) ? readerPrefs.colorTags : [];
    const seen = new Set();
    const clean = [];
    for (const entry of stored) {
      if (!entry || typeof entry !== "object") continue;
      const color = normalizeTagColor(entry.color);
      if (!color) continue;
      let id = typeof entry.id === "string" && entry.id ? entry.id : color;
      while (seen.has(id)) id = `${color}-${clean.length + 1}`;
      seen.add(id);
      clean.push({
        id,
        color,
        name: String(entry.name == null ? "" : entry.name) || colorName(color) || colorHex(color),
      });
    }
    colorTagsCache = clean.length ? clean : defaultColorTags();
    /* First run (or unusable stored data): persist the migration once, keeping
       the names the reader already gave the palette colours. */
    readerPrefs.colorTags = colorTagsCache;
    storePrefs();
    return colorTagsCache;
  }
  function writeColorTags(tags) {
    colorTagsCache = tags;
    readerPrefs.colorTags = tags;
    /* Keep the old labels map in step: builds that predate colour tags still
       read it, and a later migration finds the current palette names. */
    const labels = { ...(readerPrefs.labels || {}) };
    for (const tag of tags) if (COLOR_PALETTE[tag.color]) labels[tag.color] = tag.name;
    readerPrefs.labels = labels;
    storePrefs();
  }
  /* tagFor matches a palette key or an #rrggbb value, case-insensitively. */
  function tagFor(value) {
    const color = colorValue(value);
    if (!color) return null;
    return readColorTags().find((tag) => tag.color === color) || null;
  }
  /* tagName: the tag's name, else the palette name, else the hex itself.  A
     deleted tag therefore degrades to 蓝色 / #3aa0ff instead of breaking. */
  function tagName(value) {
    const tag = tagFor(value);
    if (tag && tag.name) return tag.name;
    return colorName(value) || colorHex(value);
  }
  /* The selection toolbar's style buttons create a highlight immediately, so
     they need a colour: remember the last one the reader picked.  A colour
     whose tag was deleted falls back to the first tag still in the list. */
  function savedHighlightColor() {
    const remembered = colorValue(readerPrefs.highlightColor);
    const tags = readColorTags();
    if (remembered && tags.some((tag) => tag.color === remembered)) return remembered;
    return tags.length ? tags[0].color : "yellow";
  }
  function rememberHighlightColor(color) {
    const value = colorValue(color);
    if (!value) return;
    if (readerPrefs.highlightColor === value) return;
    readerPrefs.highlightColor = value;
    storePrefs();
  }

  /* The selection toolbar carries a "+" dot: pick a colour and it becomes a tag,
     then the current selection is highlighted with it.  Keeping this path
     independent from the dock popover means a user who is mid-selection never
     has to leave the selection, open the colour tag manager and select again. */
  function addColorTagQuick(value) {
    const color = normalizeTagColor(value);
    if (!color) {
      toast("请选择一个颜色", "bad");
      return null;
    }
    const name = colorName(color) || colorHex(color);
    const tags = readColorTags();
    const twin = tags.find((tag) => tag.color === color && tag.name === name);
    if (twin) {
      rememberHighlightColor(twin.color);
      return twin;
    }
    const tag = { id: newColorTagId(), color, name };
    writeColorTags([...tags, tag]);
    rememberHighlightColor(tag.color);
    renderColorDots();
    renderNotesList();
    return tag;
  }

  /* Every colour affordance (toolbar, editor, right-click menu, sidebar filter)
     describes the same colour tag when hints are on. */
  function colorHint(value) {    const base = colorName(value);
    const box = document.getElementById("color-hints");
    const on = !box || box.checked;
    const name = tagName(value);
    if (!on) return base || name;
    return base && name && base !== name ? `${base} · ${name}` : name || base;
  }
  function colorHintLabel(value) {
    const box = document.getElementById("color-hints");
    if (box && !box.checked) return "";
    const base = colorName(value);
    const name = tagName(value);
    return base && name && base !== name ? name : "";
  }
  /* One colour dot, tag-driven.  A palette tag keeps its palette class (the
     smoke tests click .r-dot.yellow / .blue / ...); a custom #rrggbb dot gets
     its colour inline and only the base class. */
  function colorDotHtml(value, attr = "data-color") {
    const color = colorValue(value) || "yellow";
    const palette = paletteKey(color);
    const label = colorHint(color);
    return (
      `<button class="r-dot${palette ? ` ${palette}` : ""}" type="button" ${attr}="${escapeHtml(
        color
      )}" style="background:${colorHex(color)}" title="${escapeHtml(label)}"` +
      `${colorHintLabel(color) ? ` data-hint="${escapeHtml(colorHintLabel(color))}"` : ""}` +
      ` aria-label="${escapeHtml(label)}"></button>`
    );
  }
  /* The selection toolbar and the annotation editor render one dot per tag in
     tag order; their static containers hold nothing of their own.  The
     selection toolbar additionally ends with a "+" dot that opens a native
     colour picker for a brand-new emphasis colour. */
  function renderColorDots() {
    const markup = readColorTags()
      .map((tag) => colorDotHtml(tag.color))
      .join("");
    if (el.selColors) {
      el.selColors.innerHTML =
        markup +
        '<button class="r-dot r-dot-add" type="button" data-add-tag="1"' +
        ' title="新增重点色" aria-label="新增重点色">＋</button>';
    }
    if (el.editorColors) el.editorColors.innerHTML = markup;
    syncColorDotSelection();
  }
  function syncColorDotSelection() {
    if (!el.editorColors) return;
    const item = state.items.find((entry) => entry.id === state.activeId);
    for (const dot of $$(".r-dot", el.editorColors)) {
      dot.classList.toggle("on", Boolean(item) && dot.dataset.color === colorValue(item.color));
    }
  }

  const el = {
    back: $("#back-link"),
    backLabel: $("#back-label"),
    docName: $("#doc-name"),
    docSub: $("#doc-sub"),
    prev: $("#btn-prev"),
    next: $("#btn-next"),
    pageInput: $("#page-input"),
    pageTotal: $("#page-total"),
    zoomOut: $("#btn-zoom-out"),
    zoomIn: $("#btn-zoom-in"),
    zoomLabel: $("#zoom-label"),
    fit: $("#btn-fit"),
    noteTool: $("#btn-note-tool"),
    exportBtn: $("#btn-export"),
    saved: $("#save-state"),
    sidebarBtn: $("#btn-sidebar"),
    sidebar: $("#sidebar"),
    sideHandle: $("#side-handle"),
    sideExpand: $("#side-expand"),
    tabs: $$(".r-tab"),
    panelThumbs: $("#panel-thumbs"),
    panelNotes: $("#panel-notes"),
    annoCount: $("#anno-count"),
    stage: $("#stage"),
    scroll: $("#scroll"),
    pages: $("#pages"),
    loading: $("#loading"),
    error: $("#error"),
    selToolbar: $("#sel-toolbar"),
    selNote: $("#sel-note"),
    selAi: $("#sel-ai"),
    selNotebook: $("#sel-notebook"),
    selCopy: $("#sel-copy"),
    editor: $("#editor"),
    editorPage: $("#editor-page"),
    selColors: $("#sel-toolbar .r-sel-colors"),
    selColorPicker: $("#sel-color-picker"),
    editorColors: $("#editor-colors"),
    editorStyles: $("#editor-styles"),
    editorQuote: $("#editor-quote"),
    editorText: $("#editor-text"),
    editorClose: $("#editor-close"),
    editorDelete: $("#editor-delete"),
    editorDone: $("#editor-done"),
    tip: $("#tip"),
    menu: $("#menu"),
    dock: $("#reader-dock"),
    pop: $("#r-pop"),
    selStyles: $("#sel-styles"),
    sideResize: $("#side-resize"),
    textbar: $("#textbar"),
    textbarFont: $("#textbar-font"),
    textbarFontName: $("#textbar-font-name"),
    textbarSize: $("#textbar-size"),
    textbarDone: $("#textbar-done"),
    banner: $("#server-banner"),
    bannerRestart: $("#banner-restart"),
    bannerClose: $("#banner-close"),
    fontUpload: $("#font-upload"),
  };

  const state = {
    pdf: null,
    pages: 0,
    page: 1,
    scale: 1,
    fit: "width",
    base: { w: 595, h: 842 },
    dims: new Map(),
    sheets: [],
    items: [],
    byPage: new Map(),
    activeId: null,
    editingId: null,
    flashId: null,
    noteTool: false,
    marginMode: false,
    serverStale: false,
    colorFilter: new Set(),
    pending: null,
    saveTimer: null,
    observer: null,
    raf: 0,
    thumbObserver: null,
    thumbQueue: [],
    thumbBusy: false,
    currentThumb: 0,
    tops: null,
    textQueue: new Set(),
    textTimer: 0,
    tipId: null,
    tipTimer: 0,
    scrollAt: 0,
    marginLeft: false,
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));  const reduceMotion = () =>
    Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const uid = () =>
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ------------------------------------------------------------- boot -- */
  async function boot() {
    bindTheme($("#btn-theme"));
    /* One diagnostic line if the hand-underline module did not load: hand marks
       still paint (CSS underline fallback), but this makes the cause obvious. */
    if (!handUnderlineApi()) {
      console.warn("[BabelDoc Studio] 未加载 hand-underline.js：手绘下划线将降级为 CSS 下划线。");
    }
    el.back.href = origin === "app" ? "/" : "/library";
    el.backLabel.textContent = origin === "app" ? "翻译" : "结果库";

    if (!docPath) {
      showError("没有指定要打开的文件");
      return;
    }
    const name = fileName(docPath);
    el.docName.textContent = name;
    el.docSub.textContent = "载入中…";
    document.title = `${name} · ReadPI`;

    await loadAnnotations();

    if (!window.pdfjsLib) {
      showError("PDF 组件加载失败，请重新启动应用");
      return;
    }

    try {
      const pdf = await window.pdfjsLib
        .getDocument({
          url: `/api/file?${new URLSearchParams({ path: docPath }).toString()}`,
          cMapUrl: "/assets/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/assets/pdfjs/standard_fonts/",
        })
        .promise;
      state.pdf = pdf;
      state.pages = pdf.numPages;
      el.pageTotal.textContent = `/ ${state.pages}`;
      el.pageInput.max = String(state.pages);
      el.docSub.textContent = `${state.pages} 页 · 连续滚动`;

      const first = await pdf.getPage(1);
      const base = first.getViewport({ scale: 1 });
      state.base = { w: base.width, h: base.height };
      state.dims.set(1, { w: base.width, h: base.height });

      computeScale();
      buildSheets();
      observeSheets();

      el.loading.hidden = true;
      el.pages.hidden = false;
      /* Page offsets can only be read once the stack is actually laid out. */
      measureLayout();
      buildThumbs();
      const resume = storedPosition();
      const startPage = requestedPage
        ? Math.min(requestedPage, state.pages)
        : resume && resume <= state.pages
          ? resume
          : 0;
      if (startPage > 1) {
        goToPage(startPage, false);
        toast(
          origin === "zotero"
            ? `已从 Zotero 打开 · 第 ${startPage} 页`
            : `已回到上次读到的第 ${startPage} 页`,
          "good"
        );
      } else {
        goToPage(1, false);
        if (origin === "zotero") toast("已从 Zotero 打开", "good");
      }
      document.dispatchEvent(
        new CustomEvent("reader:ready", { detail: { pages: state.pages } })
      );
      resolveReaderReady();
    } catch (error) {
      showError(`无法打开这个 PDF：${error.message || error}`);
    }
  }

  function showError(message) {
    el.loading.hidden = true;
    el.pages.hidden = true;
    resolveReaderReady();
    el.error.hidden = false;
    const back = origin === "app" ? "/" : "/library";
    el.error.innerHTML =
      `<p>${escapeHtml(message)}</p>` +
      `<a class="btn btn-secondary small" href="${back}">返回</a>`;
  }

  /* ------------------------------------------------------------- layout -- */
  function computeScale() {
    if (!state.fit) return;
    /* Margin notes sit beside the page, so the page has to give those gutters
       back before the zoom is calculated.  Cards may sit on both sides. */
    const gutter = state.marginMode ? 288 : 0;
    const leftGutter = state.marginMode && state.marginLeft ? 288 : 0;
    const width = Math.max(240, el.stage.clientWidth - 48 - gutter - leftGutter);
    const height = Math.max(240, el.stage.clientHeight - 44);
    const widthScale = width / (state.base.w * (!originalVisible && state.base.w > state.base.h * 1.2 ? 0.5 : 1));
    const heightScale = height / state.base.h;
    state.scale = clamp(
      state.fit === "width" ? widthScale : Math.min(widthScale, heightScale),
      0.3,
      5
    );
  }

  function buildSheets() {
    el.pages.innerHTML = "";
    state.sheets = [];
    const fragment = document.createDocumentFragment();
    for (let number = 1; number <= state.pages; number += 1) {
      const section = document.createElement("section");
      section.className = "r-sheet";
      section.dataset.page = String(number);

      const box = document.createElement("div");
      box.className = "r-page";
      const canvas = document.createElement("canvas");
      const text = document.createElement("div");
      text.className = "r-text";
      /* Selection is painted by the app as one band per text line: the native
         per-span ::selection paint is fragmented on CJK lines. */
      const select = document.createElement("div");
      select.className = "r-select";
      const ghost = document.createElement("div");
      ghost.className = "r-ghost";
      const anno = document.createElement("div");
      anno.className = "r-anno";
      box.append(canvas, text, select, ghost, anno);
      section.append(box);
      fragment.append(section);

      state.sheets.push({
        no: number,
        el: section,
        box,
        canvas,
        text,
        select,
        ghost,
        anno,
        top: 0,
        painted: false,
        textReady: false,
        renderScale: null,
        textScale: null,
        busy: false,
        dirty: false,
        task: null,
        nodes: null,
        textCache: null,
        fontLines: null,
      });
    }
    el.pages.append(fragment);
    sizeSheets();
    measureLayout();
  }

  function sizeSheets() {
    for (const sheet of state.sheets) {
      const dims = state.dims.get(sheet.no) || state.base;
      const width = Math.round(dims.w * state.scale);
      const height = Math.round(dims.h * state.scale);
      sheet.box.style.width = `${width}px`;
      sheet.box.style.height = `${height}px`;
      sheet.width = width;
      sheet.height = height;
      cropSheet(sheet);
    }
  }

  /* Page offsets in the scroller's content space.  A scroll frame must know
     which page sits under the viewport; measuring every page with
     getBoundingClientRect on each frame caused layout thrash, so the offsets are
     read once per layout and then only nudged when a page repaints at a
     different height. */
  function measureLayout() {
    if (!state.sheets.length) return;
    const tops = new Float64Array(state.sheets.length);
    for (let index = 0; index < state.sheets.length; index += 1) {
      tops[index] = state.sheets[index].el.offsetTop;
    }
    /* Nothing is laid out yet (the stack is still hidden); keep the old model
       and let the next scroll re-measure. */
    if (!(tops[tops.length - 1] > 0)) return;
    for (let index = 0; index < state.sheets.length; index += 1) {
      state.sheets[index].top = tops[index];
    }
    state.tops = tops;
  }

  function shiftAfter(index, delta) {
    if (!state.tops || !delta) return;
    for (let cursor = index + 1; cursor < state.tops.length; cursor += 1) {
      state.tops[cursor] += delta;
      state.sheets[cursor].top = state.tops[cursor];
    }
  }

  function sheetHeight(sheet) {
    return sheet.height || sheet.el.offsetHeight || 1;
  }

  function pageAt(contentY) {
    const tops = state.tops;
    if (!tops || !tops.length || !(tops[tops.length - 1] > 0)) {
      /* Measured while the stack was still hidden, or never measured: rebuild
         the model once and continue with it. */
      measureLayout();
      if (!state.tops || !state.tops.length) return 1;
    }
    const model = state.tops;
    let low = 0;
    let high = model.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (model[mid] <= contentY) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }

  function observeSheets() {
    if (state.observer) state.observer.disconnect();
    state.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const sheet = state.sheets[Number(entry.target.dataset.page) - 1];
          if (sheet) paint(sheet);
        }
      },
      { root: el.stage, rootMargin: `${AHEAD}px 0px ${AHEAD}px 0px` }
    );
    for (const sheet of state.sheets) state.observer.observe(sheet.el);
  }

  function visibleSheets() {
    if (!state.tops) return [];
    const top = el.stage.scrollTop - AHEAD;
    const bottom = el.stage.scrollTop + el.stage.clientHeight + AHEAD;
    const out = [];
    for (const sheet of state.sheets) {
      const start = state.tops[sheet.no - 1];
      if (start > bottom) break;
      if (start + sheetHeight(sheet) < top) continue;
      out.push(sheet);
    }
    return out;
  }

  function scrollAnchor() {
    const y = el.stage.scrollTop;
    if (!state.tops) return { page: 1, frac: 0 };
    const number = pageAt(y + 1);
    const sheet = state.sheets[number - 1];
    if (!sheet || !state.tops) return { page: 1, frac: 0 };
    const start = state.tops[number - 1];
    return {
      page: number,
      frac: clamp((y - start) / Math.max(1, sheetHeight(sheet)), 0, 1),
    };
  }

  function restoreAnchor(anchor) {
    const sheet = state.sheets[anchor.page - 1];
    if (!sheet || !state.tops) return;
    el.stage.scrollTop = Math.max(
      0,
      state.tops[anchor.page - 1] + anchor.frac * sheetHeight(sheet) - 12
    );
  }

  /* -------------------------------------------------------------- paint -- */
  async function paint(sheet) {
    if (!state.pdf || !sheet) return;
    if (sheet.busy) {
      sheet.dirty = true;
      return;
    }
    const scale = state.scale;
    if (sheet.painted && sheet.renderScale === scale) {
      renderSheetAnnotations(sheet);
      return;
    }
    sheet.busy = true;
    try {
      const page = await state.pdf.getPage(sheet.no);
      if (state.scale !== scale) {
        sheet.dirty = true;
        return;
      }
      const base = page.getViewport({ scale: 1 });
      state.dims.set(sheet.no, { w: base.width, h: base.height });
      const viewport = page.getViewport({ scale });

      const width = Math.round(viewport.width);
      const height = Math.round(viewport.height);
      const delta = sheet.height ? height - sheet.height : 0;
      sheet.box.style.width = `${width}px`;
      sheet.box.style.height = `${height}px`;
      sheet.width = width;
      sheet.height = height;
      cropSheet(sheet);
      if (delta) shiftAfter(sheet.no - 1, delta);

      if (sheet.task) {
        try {
          sheet.task.cancel();
        } catch {
          /* already finished */
        }
        try {
          await sheet.task.promise;
        } catch {
          /* cancelled */
        }
        sheet.task = null;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = sheet.canvas;
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const context = canvas.getContext("2d", { alpha: false });
      const task = page.render({
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      });
      sheet.task = task;
      try {
        await task.promise;
      } catch (error) {
        if (!error || error.name !== "RenderingCancelledException") throw error;
        return;
      }
      sheet.task = null;
      if (state.scale !== scale) {
        sheet.dirty = true;
        return;
      }

      sheet.painted = true;
      sheet.renderScale = scale;
      sheet.box.classList.add("painted");
      renderSheetAnnotations(sheet);
      scheduleText(sheet, page, viewport);
    } catch (error) {
      console.warn("第", sheet.no, "页渲染失败", error);
    } finally {
      sheet.busy = false;
      if (sheet.dirty) {
        sheet.dirty = false;
        setTimeout(() => paint(sheet), 0);
      }
    }
  }

  /* The text layer only powers selection, so it is built after the page is
     already readable, for pages the reader is actually looking at, and only
     once scrolling has paused — building it mid-scroll cost ~60 ms per page. */
  function scheduleText(sheet, page, viewport) {
    if (sheet.textReady && sheet.textScale === state.scale) return;
    sheet.textArgs = { page, viewport, scale: state.scale };
    state.textQueue.add(sheet);
    schedulePump(150);
  }

  function schedulePump(delay = 160) {
    if (state.textTimer) return;
    state.textTimer = window.setTimeout(pumpText, delay);
  }

  function pumpText() {
    state.textTimer = 0;
    if (!state.textQueue.size) return;
    if (performance.now() - state.scrollAt < 260) {
      schedulePump(180);
      return;
    }
    const stage = el.stage.getBoundingClientRect();
    let next = null;
    for (const sheet of state.textQueue) {
      const box = sheet.el.getBoundingClientRect();
      if (box.bottom < stage.top - 80 || box.top > stage.bottom + 80) continue;
      next = sheet;
      break;
    }
    /* Nothing on screen needs it; the next scroll or resize asks again. */
    if (!next) return;
    state.textQueue.delete(next);
    buildQueuedText(next);
    if (state.textQueue.size) schedulePump(90);
  }

  async function buildQueuedText(sheet) {
    const args = sheet.textArgs;
    if (!args) return;
    if (!sheet.painted || state.scale !== args.scale) {
      sheet.textArgs = null;
      return;
    }
    sheet.textArgs = null;
    await buildText(sheet, args.page, args.viewport);
    if (state.scale !== args.scale) {
      sheet.dirty = true;
      return;
    }
    sheet.textScale = args.scale;
    migrateLegacy();
    renderSheetAnnotations(sheet);
  }

  async function buildText(sheet, page, viewport) {
    let content;
    try {
      content = await page.getTextContent();
    } catch {
      return;
    }
    sheet.text.innerHTML = "";
    sheet.text.style.width = `${viewport.width}px`;
    sheet.text.style.height = `${viewport.height}px`;
    sheet.text.style.setProperty("--scale-factor", String(viewport.scale));
    try {
      await window.pdfjsLib.renderTextLayer({
        textContentSource: content,
        container: sheet.text,
        viewport,
        textDivs: [],
      }).promise;
    } catch {
      /* the text layer only powers selection; the canvas is still readable */
    }
    sheet.nodes = null;
    sheet.textCache = null;
    sheet.fontLines = buildFontLines(sheet) || [];
    try {
      analyseLayout(sheet, content.items, viewport);
    } catch {
      sheet.dual = false;
    }
    sheet.textReady = true;
  }

  /* A live range reports two boxes per glyph (the font box and the taller span
     box), so the preview cannot size a band from the rect alone.  PDF.js lays
     each glyph span out with a percentage ``top`` and a font size of
     ``calc(var(--scale-factor) * N px)``; reading those inline values gives a
     page-top -> font-size index without a layout pass.  Sizing the preview from
     the glyph height then matches what the committed highlight paints. */
  function buildFontLines(sheet) {
    /* read the layer height from layout: PDF.js overwrites the inline height
       with a round(calc(...)) expression, so it cannot be parsed as px */
    const height = sheet.text.clientHeight;
    const spans = sheet.text.querySelectorAll("span");
    if (!(height > 0) || !spans.length) return null;
    const lines = [];
    for (const span of spans) {
      const top = parseFloat(span.style.top);
      const font = /([\d.]+)px/.exec(span.style.fontSize || "");
      if (!Number.isFinite(top) || !font) continue;
      lines.push({ top: (top / 100) * height, em: parseFloat(font[1]) });
    }
    lines.sort((a, b) => a.top - b.top);
    return lines.length ? lines : null;
  }

  /* Nearest line entry, in page-local client pixels; every selection rect sits
     a little below the span top it belongs to. */
  function fontEmAt(sheet, offsetTop) {
    const lines = sheet.fontLines;
    if (!lines || !lines.length) return 0;
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (lines[mid].top < offsetTop) low = mid + 1;
      else high = mid;
    }
    let best = lines[low];
    let bestDist = Math.abs(best.top - offsetTop);
    const previous = lines[low - 1];
    if (previous && Math.abs(previous.top - offsetTop) < bestDist) {
      best = previous;
      bestDist = Math.abs(best.top - offsetTop);
    }
    const next = lines[low + 1];
    if (next && Math.abs(next.top - offsetTop) < bestDist) best = next;
    return best.em;
  }

  /* ------------------------------------------------------ bilingual sync -- */
  /* A side-by-side dual page carries the original on the left and the
     translation on the right, with no machine-readable link between them.
     BabelDOC keeps the layout, so paragraphs sit at roughly the same height on
     both sides: selecting text on one side can therefore point at the
     paragraph occupying the same vertical band on the other side. */
  function analyseLayout(sheet, items, viewport) {
    const scale = viewport.scale || 1;
    const rows = [];
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]) / scale;
      const width = item.width || 0;
      if (!(size > 0) || !(width > 0)) continue;
      rows.push({
        x: tx[4] / scale,
        right: tx[4] / scale + width,
        baseline: tx[5] / scale,
        size,
      });
    }
    if (!rows.length) {
      sheet.dual = false;
      sheet.blocks = null;
      return;
    }
    /* Lines are per column: text at the same baseline but far apart (the two
       halves of a dual page) becomes two separate line boxes. */
    rows.sort((a, b) => a.baseline - b.baseline || a.x - b.x);

    const lines = [];
    for (const row of rows) {
      const last = lines[lines.length - 1];
      const sameBaseline =
        last &&
        Math.abs(last.baseline - row.baseline) <= Math.max(1.2, Math.min(last.size, row.size) * 0.5);
      const near =
        last && row.x - last.right <= Math.max(last.size * 2.4, 12) && last.x - row.right <= Math.max(last.size * 2.4, 12);
      if (sameBaseline && near) {
        last.x = Math.min(last.x, row.x);
        last.right = Math.max(last.right, row.right);
        last.size = Math.max(last.size, row.size);
        continue;
      }
      lines.push({
        x: row.x,
        right: row.right,
        baseline: row.baseline,
        size: row.size,
      });
    }

    const width = (viewport.width || 0) / scale;
    const height = (viewport.height || 0) / scale;
    const boxes = lines.map((line) => ({
      x: line.x,
      right: line.right,
      top: line.baseline - line.size * 0.92,
      bottom: line.baseline + line.size * 0.28,
    }));
    sheet.pageWidth = width;

    /* Two columns of text with a clean gutter in the middle: that is what a
       "原文 | 译文" page looks like. */
    const mid = width / 2;
    const crossing = boxes.filter((box) => box.x < mid - 1 && box.right > mid + 1).length;
    const left = boxes.filter((box) => box.right <= mid + 2).length;
    const right = boxes.filter((box) => box.x >= mid - 2).length;
    sheet.layout = { crossing, left, right, total: boxes.length };
    sheet.dual =
      width / Math.max(height, 1) > 1.05 &&
      crossing === 0 &&
      left >= 3 &&
      right >= 3 &&
      left + right >= boxes.length * 0.9;
    if (!sheet.dual) {
      sheet.lines = null;
      sheet.blocks = null;
      return;
    }

    sheet.lines = boxes.map((box) => ({
      x: box.x,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      side: (box.x + box.right) / 2 < mid ? "L" : "R",
    }));
    const half = width / 2;
    sheet.blocks = [
      ...buildBlocks(sheet.lines.filter((line) => line.side === "L"), "L", 0, half),
      ...buildBlocks(sheet.lines.filter((line) => line.side === "R"), "R", half, half),
    ];
  }

  /* Paragraph blocks: lines stacked with normal line spacing inside one
     column.  Lines are attached to the block they overlap horizontally, so
     two columns of the same paragraph (or a three-author header grid) never
     merge into one block. */
  function buildBlocks(lines, side, halfStart, halfWidth) {
    if (!lines.length) return [];
    const sorted = lines.slice().sort((a, b) => a.top - b.top || a.x - b.x);
    const blocks = [];
    for (const line of sorted) {
      const height = Math.max(1, line.bottom - line.top);
      let best = null;
      let bestOverlap = 0;
      for (let index = blocks.length - 1; index >= 0 && index >= blocks.length - 40; index -= 1) {
        const block = blocks[index];
        if (line.top - block.bottom > Math.max(3, height * 0.8)) continue;
        const shared = Math.min(block.right, line.right) - Math.max(block.left, line.x);
        const narrow = Math.min(block.right - block.left, line.right - line.x);
        if (shared < Math.max(2, narrow * 0.3)) continue;
        /* A full-width caption must not swallow the narrower column below it. */
        const widest = Math.max(block.right - block.left, line.right - line.x);
        if (widest > narrow * 1.8) continue;
        if (shared > bestOverlap) {
          bestOverlap = shared;
          best = block;
        }
      }
      if (best) {
        best.left = Math.min(best.left, line.x);
        best.right = Math.max(best.right, line.right);
        best.bottom = Math.max(best.bottom, line.bottom);
        best.lines.push(line);
      } else {
        blocks.push({
          side,
          top: line.top,
          bottom: line.bottom,
          left: line.x,
          right: line.right,
          lines: [line],
        });
      }
    }
    /* Where the block sits inside its half (0…1): the translation keeps the
       original layout, so matching blocks sit at the same horizontal spot. */
    for (const block of blocks) {
      block.fx = ((block.left + block.right) / 2 - halfStart) / Math.max(1, halfWidth);
    }
    return blocks;
  }

  /* The block of the other half that belongs to ``source``: it sits at the
     same horizontal position and at the same height, ideally overlapping it. */
  function counterpartBlock(blocks, side, source) {
    const centre = (source.top + source.bottom) / 2;
    let best = null;
    let bestScore = -Infinity;
    for (const block of blocks) {
      if (block.side !== side) continue;
      const overlap = Math.min(block.bottom, source.bottom) - Math.max(block.top, source.top);
      const distance = Math.abs((block.top + block.bottom) / 2 - centre);
      const column = Math.abs((block.fx || 0.5) - (source.fx || 0.5));
      const score =
        (overlap > 0 ? 1000 + Math.min(overlap, 200) : 0) -
        distance +
        Math.max(0, 160 - column * 480);
      if (score > bestScore) {
        bestScore = score;
        best = block;
      }
    }
    return best;
  }

  /* Counterpart of the selection on the other half of a side-by-side page:
     find the paragraph holding the selection, then the paragraph on the other
     half, and finally the lines at the same relative position inside it. */
  function counterpartBands(sheet, rects) {
    if (!sheet.dual || !sheet.lines || !rects.length) return [];
    const mid = (sheet.pageWidth || 0) / 2;
    const first = rects[0];
    const side = first.x + first.w / 2 < mid ? "L" : "R";
    const other = side === "L" ? "R" : "L";
    const top = Math.min(...rects.map((rect) => rect.y));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
    const left = Math.min(...rects.map((rect) => rect.x));
    const right = Math.max(...rects.map((rect) => rect.x + rect.w));

    const chosen = new Set();
    for (const block of sheet.blocks || []) {
      if (block.side !== side) continue;
      if (block.bottom <= top || block.top >= bottom) continue;
      if (block.right <= left || block.left >= right) continue;
      const span = Math.max(1, block.bottom - block.top);
      const from = Math.min(1, Math.max(0, (top - block.top) / span));
      const to = Math.min(1, Math.max(0, (bottom - block.top) / span));
      const match = counterpartBlock(sheet.blocks, other, block);
      if (!match) continue;
      const target = Math.max(1, match.bottom - match.top);
      const start = match.top + from * target;
      const end = match.top + Math.max(to, from) * target;
      const pad = Math.max(1.5, Math.min(4, (end - start) * 0.3));
      let picked = match.lines.filter((line) => {
        const centre = (line.top + line.bottom) / 2;
        return centre >= start - pad && centre <= end + pad;
      });
      if (!picked.length) {
        let nearest = null;
        for (const line of match.lines) {
          const distance = Math.abs((line.top + line.bottom) / 2 - (start + end) / 2);
          if (!nearest || distance < nearest.distance) nearest = { line, distance };
        }
        if (nearest) picked = [nearest.line];
      }
      for (const line of picked) chosen.add(line);
    }

    let bands = [...chosen];
    if (!bands.length) {
      /* No paragraph matched: fall back to the same vertical band. */
      const lineHeight = (bottom - top) / Math.max(1, rects.length);
      const pad = Math.max(2, lineHeight * 0.45);
      bands = sheet.lines.filter((line) => {
        if (line.side !== other) return false;
        const centre = (line.top + line.bottom) / 2;
        return centre >= top - pad && centre <= bottom + pad;
      });
    }
    return bands.sort((a, b) => a.top - b.top || a.x - b.x);
  }

  function renderSync(byPage) {
    clearSync();
    for (const [page, rects] of byPage) {
      const sheet = state.sheets[page - 1];
      if (!sheet || !sheet.dual) continue;
      const bands = counterpartBands(sheet, rects);
      const scale = state.scale;
      for (const band of bands) {
        const mark = document.createElement("div");
        mark.className = "r-sync";
        mark.style.left = `${band.x * scale}px`;
        mark.style.top = `${band.top * scale}px`;
        mark.style.width = `${(band.right - band.x) * scale}px`;
        mark.style.height = `${(band.bottom - band.top) * scale}px`;
        sheet.ghost.appendChild(mark);
      }
    }
  }

  function showSync(captured) {
    if (!captured || !captured.rects || !captured.rects.length) {
      clearSync();
      return;
    }
    const byPage = new Map();
    for (const rect of captured.rects) {
      const page = rect.page || captured.parts[0].page;
      const bucket = byPage.get(page);
      if (bucket) bucket.push(rect);
      else byPage.set(page, [rect]);
    }
    renderSync(byPage);
  }

  /* --------------------------------------------------- selection paint -- */
  /* The native ::selection background is transparent (see viewer.css), so the
     selection is painted here as one translucent band per visual line.  The
     bands are built with the same line-band builder the committed highlight is
     painted from, so picking a colour does not move or resize the preview. */
  function clearPickBands() {
    for (const sheet of state.sheets) {
      if (sheet.select && sheet.select.childElementCount) sheet.select.innerHTML = "";
    }
  }

  /* ``byPage`` maps a page number to page-space bands ({x, y, w, h}); the
     scale is applied here exactly like renderSync and the annotation marks.
     Band nodes are reused between frames: re-creating the whole layer on every
     pointer move dirtied the page's style/layout while the selection was being
     dragged. */
  function renderPickBands(byPage) {
    const scale = state.scale;
    for (const sheet of state.sheets) {
      const layer = sheet.select;
      if (!layer) continue;
      const bands = (byPage && byPage.get(sheet.no)) || [];
      while (layer.childElementCount > bands.length) layer.lastElementChild.remove();
      while (layer.childElementCount < bands.length) {
        const pick = document.createElement("div");
        pick.className = "r-pick";
        layer.append(pick);
      }
      for (let index = 0; index < bands.length; index += 1) {
        const band = bands[index];
        const pick = layer.children[index];
        pick.style.left = `${band.x * scale}px`;
        pick.style.top = `${band.y * scale}px`;
        pick.style.width = `${band.w * scale}px`;
        pick.style.height = `${band.h * scale}px`;
      }
    }
  }

  /* While the pointer is still dragging the selection has no text spans yet,
     so the counterpart is recomputed from the live client rects and the
     selection preview is rebuilt with the same band builder the committed
     highlight uses, without walking the text nodes. */
  function syncSelectionLive() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      clearSync();
      clearPickBands();
      return;
    }
    const range = selection.getRangeAt(0);
    const live = [];
    const seen = new Set();
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) continue;
      /* The same glyph can report two identical rects; the band builder only
         needs one of them. */
      const key = `${Math.round(rect.left * 10)},${Math.round(rect.top * 10)},` +
        `${Math.round(rect.width * 10)},${Math.round(rect.height * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      live.push(rect);
    }
    const sync = new Map();
    const picks = new Map();
    for (const sheet of state.sheets) {
      if (!sheet.textReady) continue;
      let touches = false;
      try {
        touches = range.intersectsNode(sheet.text);
      } catch {
        touches = false;
      }
      if (!touches) continue;
      if (!sheet.fontLines) sheet.fontLines = buildFontLines(sheet) || [];
      const box = sheet.box.getBoundingClientRect();
      const scale = state.scale;
      const pieces = [];
      const plain = [];
      for (const rect of live) {
        /* A selection can run from one page into the next.  Only the rects
           that fall inside this sheet's own box belong to it, otherwise every
           page in the selection would paint all pages' rectangles. */
        if (rect.right <= box.left || rect.left >= box.right) continue;
        if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
        const em = fontEmAt(sheet, rect.top - box.top) * scale;
        pieces.push({ rect, em });
        /* The dual-page counterpart keeps its old input: the raw line boxes. */
        plain.push({
          x: (rect.left - box.left) / scale,
          y: (rect.top - box.top) / scale,
          w: rect.width / scale,
          h: rect.height / scale,
        });
      }
      if (!pieces.length) continue;
      /* Same band builder as the committed highlight: glyph-height bands with
         the paint padding, so the preview is exactly the mark that will stay. */
      picks.set(sheet.no, bandsFromRects(pieces, sheet));
      /* The counterpart bands on dual pages keep consuming the per-page
         rects, exactly as before. */
      if (sheet.dual) sync.set(sheet.no, plain);
    }
    renderSync(sync);
    renderPickBands(picks);
  }

  let syncFrame = 0;

  function scheduleLiveSync() {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0;
      syncSelectionLive();
    });
  }

  function clearSync() {
    for (const sheet of state.sheets) {
      if (sheet.ghost && sheet.ghost.childElementCount) sheet.ghost.innerHTML = "";
    }
  }

  window.__readerDebug = () => ({
    scale: state.scale,
    sheets: state.sheets.slice(0, 4).map((sheet) => ({
      no: sheet.no,
      dual: sheet.dual,
      layout: sheet.layout || null,
      pageWidth: sheet.pageWidth,
      lines: sheet.lines ? sheet.lines.length : 0,
      blocks: sheet.blocks
        ? sheet.blocks.map((block) => ({
            side: block.side,
            fx: Math.round((block.fx || 0) * 100) / 100,
            top: Math.round(block.top),
            bottom: Math.round(block.bottom),
            lines: block.lines.length,
          }))
        : 0,
      ghost: sheet.ghost ? sheet.ghost.childElementCount : -1,
      textReady: sheet.textReady,
    })),
    pending: state.pending
      ? { rects: state.pending.rects.length, pages: state.pending.parts.map((p) => p.page) }
      : null,
  });

  function release(sheet) {
    if (!sheet.painted && !sheet.textReady) return false;
    if (sheet.task) {
      try {
        sheet.task.cancel();
      } catch {
        /* already finished */
      }
      sheet.task = null;
    }
    sheet.canvas.width = 0;
    sheet.canvas.height = 0;
    sheet.text.innerHTML = "";
    sheet.select.innerHTML = "";
    sheet.ghost.innerHTML = "";
    sheet.anno.innerHTML = "";
    /* The margin rails are siblings of .r-anno, so a released page must drop
       them explicitly or stale cards would float over the empty sheet. */
    const leftRail = sheet.el.querySelector(":scope > .r-margin-left");
    const rightRail = sheet.el.querySelector(":scope > .r-margin-right");
    if (leftRail) leftRail.remove();
    if (rightRail) rightRail.remove();
    sheet.lines = null;
    sheet.blocks = null;
    sheet.dual = false;
    sheet.nodes = null;
    sheet.textCache = null;
    sheet.fontLines = null;
    sheet.textArgs = null;
    state.textQueue.delete(sheet);
    sheet.painted = false;
    sheet.textReady = false;
    sheet.renderScale = null;
    sheet.textScale = null;
    sheet.box.classList.remove("painted");
    return true;
  }

  function prune() {
    for (const sheet of state.sheets) {
      if (Math.abs(sheet.no - state.page) <= KEEP) continue;
      release(sheet);
    }
  }

  function resetSheets() {
    for (const sheet of state.sheets) release(sheet);
  }

  function repaintVisible() {
    for (const sheet of visibleSheets()) paint(sheet);
  }

  function relayout(anchor) {
    clearSync();
    resetSheets();
    syncMarginColumns();
    computeScale();
    sizeSheets();
    measureLayout();
    if (anchor) restoreAnchor(anchor);
    repaintVisible();
    syncPageUI();
  }

  /* ---------------------------------------------------------------- nav -- */
  function goToPage(number, smooth = true) {
    if (!state.pages) return;
    const target = clamp(Math.round(Number(number)) || 1, 1, state.pages);
    const sheet = state.sheets[target - 1];
    if (!sheet) return;
    const top = Math.max(0, (state.tops ? state.tops[target - 1] : 0) - 12);
    el.stage.scrollTo({
      top,
      behavior: smooth && !reduceMotion() ? "smooth" : "auto",
    });
    state.page = target;
    syncPageUI();
    paint(sheet);
  }

  function onScroll() {
    state.scrollAt = performance.now();
    hideTip();
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      if (!state.pages) return;
      const probe = el.stage.scrollTop + Math.min(el.stage.clientHeight * 0.35, 280);
      const number = pageAt(probe);
      if (number !== state.page) {
        state.page = number;
        syncPageUI();
      }
      prune();
      /* Pages that scrolled into view get their text layer once the reader
         stops moving. */
      if (state.textQueue.size) schedulePump(200);
    });
  }

  function zoom(factor) {
    const anchor = scrollAnchor();
    state.fit = null;
    state.scale = clamp(state.scale * factor, 0.3, 5);
    relayout(anchor);
  }

  function syncPageUI() {
    el.pageInput.value = String(state.page);
    el.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
    el.fit.textContent = state.fit === "width" ? "适应页面" : "适应宽度";
    updateThumbSelection();
    rememberPosition();
    document.dispatchEvent(
      new CustomEvent("reader:pagechange", { detail: { page: state.page } })
    );
  }

  /* Reopening a paper should land where reading stopped, not on page 1. */
  function rememberPosition() {
    try {
      window.localStorage.setItem(POSITION_KEY + docPath, String(state.page));
    } catch {
      /* private mode / quota — reading position is only a convenience */
    }
    reportReadingPosition(false);
  }

  /* Zotero resumes from the server side, so the position is mirrored to
     /api/zotero/position.  The endpoint ignores documents that are not linked
     to a Zotero attachment; the call is throttled and best effort, because a
     reading position must never break the reader or slow scrolling down. */
  let positionReportAt = 0;
  let positionReportPage = 0;

  function reportReadingPosition(flush) {
    if (!docPath || !state.pages) return;
    const now = Date.now();
    if (!flush && positionReportPage === state.page) return;
    if (!flush && now - positionReportAt < 3000) return;
    positionReportAt = now;
    positionReportPage = state.page;
    const body = JSON.stringify({
      path: docPath,
      page: state.page,
      pages: state.pages,
    });
    try {
      if (flush && navigator.sendBeacon) {
        navigator.sendBeacon(
          "/api/zotero/position",
          new Blob([body], { type: "application/json" })
        );
        return;
      }
      fetch("/api/zotero/position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* the next page change retries */
    }
  }

  function storedPosition() {
    try {
      const value = Number(window.localStorage.getItem(POSITION_KEY + docPath) || 0);
      return Number.isFinite(value) && value > 1 ? Math.round(value) : 0;
    } catch {
      return 0;
    }
  }

  /* Only the thumbnails whose state changes are touched: walking the whole list
     on every page change forced a layout pass per page while scrolling. */
  function updateThumbSelection() {
    const list = el.panelThumbs;
    if (!list || !list.children.length) return;
    const next = Number(state.page);
    if (next === state.currentThumb) return;
    const previous = state.currentThumb;
    state.currentThumb = next;
    if (previous) {
      const old = list.children[previous - 1];
      if (old) old.classList.remove("current");
    }
    const thumb = list.children[next - 1];
    if (!thumb) return;
    thumb.classList.add("current");
    if (!list.offsetParent) return;
    const top = thumb.offsetTop;
    const bottom = top + thumb.offsetHeight;
    if (top < list.scrollTop + 8) {
      list.scrollTop = Math.max(0, top - 8);
    } else if (bottom > list.scrollTop + list.clientHeight - 8) {
      list.scrollTop = bottom - list.clientHeight + 8;
    }
  }

  /* -------------------------------------------------------- thumbnails -- */
  function buildThumbs() {
    el.panelThumbs.innerHTML = "";
    state.currentThumb = 0;
    const fragment = document.createDocumentFragment();
    for (let index = 1; index <= state.pages; index += 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "r-thumb";
      button.dataset.page = String(index);
      button.innerHTML = `<canvas width="1" height="1"></canvas><span>${index}</span>`;
      button.addEventListener("click", () => goToPage(index));
      fragment.appendChild(button);
    }
    el.panelThumbs.appendChild(fragment);
    updateThumbSelection();

    if (!state.thumbObserver) {
      state.thumbObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const target = entry.target;
            state.thumbObserver.unobserve(target);
            if (!target.dataset.done) state.thumbQueue.push(target);
          }
          pumpThumbs();
        },
        { root: el.panelThumbs, rootMargin: "240px" }
      );
    }
    for (const thumb of $$(".r-thumb", el.panelThumbs)) state.thumbObserver.observe(thumb);
  }

  async function pumpThumbs() {
    if (state.thumbBusy) return;
    state.thumbBusy = true;
    try {
      while (state.thumbQueue.length) {
        /* Rendering a thumbnail decodes a whole page, so it waits until the
           reader has stopped moving — otherwise every scroll ticks stalled. */
        if (performance.now() - state.scrollAt < 240) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          continue;
        }
        const button = state.thumbQueue.shift();
        if (!button.dataset.done) await renderThumb(button);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      state.thumbBusy = false;
    }
  }

  async function renderThumb(button) {
    const number = Number(button.dataset.page);
    const canvas = button.querySelector("canvas");
    if (!canvas || !state.pdf) return;
    try {
      const page = await state.pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 118 / base.width });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.height = `${Math.round(viewport.height)}px`;
      await page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      }).promise;
      button.dataset.done = "1";
    } catch {
      /* a broken thumbnail should not break the sidebar */
    }
  }

  /* ------------------------------------------------------------- text -- */
  function nodesOf(sheet) {
    if (!sheet.nodes) {
      const nodes = [];
      const walker = document.createTreeWalker(sheet.text, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        nodes.push(node);
        node = walker.nextNode();
      }
      sheet.nodes = nodes;
    }
    return sheet.nodes;
  }

  function sheetText(sheet) {
    if (sheet.textCache == null) {
      sheet.textCache = nodesOf(sheet)
        .map((node) => node.data)
        .join("");
    }
    return sheet.textCache;
  }

  /* The character span of `range` inside one page, plus the line boxes it
     covers.  Cross-page selections are simply the union of these per page. */
  function spanOffsets(sheet, range) {
    let start = null;
    let end = null;
    let offset = 0;
    const rects = [];
    for (const node of nodesOf(sheet)) {
      const length = node.data.length;
      const nodeStart = offset;
      offset += length;
      if (!length) continue;

      const bounds = document.createRange();
      bounds.selectNodeContents(node);
      /* END_TO_START compares this range's start with the node's end, and
         START_TO_END compares this range's end with the node's start. */
      if (range.compareBoundaryPoints(Range.START_TO_END, bounds) < 0) break;
      if (range.compareBoundaryPoints(Range.END_TO_START, bounds) > 0) continue;

      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : length;
      if (to <= from) continue;

      if (start === null) start = nodeStart + from;
      end = nodeStart + to;

      const piece = document.createRange();
      piece.setStart(node, from);
      piece.setEnd(node, to);
      const em = parseFloat(getComputedStyle(node.parentElement).fontSize) || 0;
      for (const rect of piece.getClientRects()) rects.push({ rect, em });
    }
    if (start === null || end === null || end <= start) return null;
    return { start, end, rects };
  }

  function foldChar(ch) {
    if (!ch || /\s/.test(ch)) return "";
    if (ch.normalize) {
      const folded = ch.normalize("NFKC");
      if (folded.length === 1) return folded;
    }
    return ch;
  }

  function fold(text) {
    let value = "";
    for (const ch of text) value += foldChar(ch);
    return value;
  }

  function foldWithMap(text) {
    let value = "";
    const starts = [];
    const widths = [];
    let index = 0;
    for (const ch of text) {
      const width = ch.length;
      const folded = foldChar(ch);
      if (folded) {
        value += folded;
        starts.push(index);
        widths.push(width);
      }
      index += width;
    }
    return { value, starts, widths };
  }

  /* Find an annotation's quoted text in a page so rectangles captured by older
     versions can be upgraded to character ranges. */
  function findOffsets(sheet, needle) {
    const target = fold(needle);
    if (target.length < 2) return null;
    const hay = foldWithMap(sheetText(sheet));
    const at = hay.value.indexOf(target);
    if (at < 0) return null;
    const last = at + target.length - 1;
    return { start: hay.starts[at], end: hay.starts[last] + hay.widths[last] };
  }

  function migrateLegacy() {
    let changed = false;
    for (const item of state.items) {
      if (item.type !== "highlight") continue;
      if (item.ranges && item.ranges.length) continue;
      if (!item.text) continue;
      const sheet = state.sheets[item.page - 1];
      if (!sheet || !sheet.textReady) continue;
      const found = findOffsets(sheet, item.text);
      if (!found) continue;
      item.ranges = [{ page: item.page, start: found.start, end: found.end }];
      changed = true;
    }
    if (changed) {
      refreshAnnotations();
      persist();
    }
  }

  /* -------------------------------------------------------- highlights -- */
  /* Highlights are drawn as bands derived from the live text ranges: one band
     per line, spanning from the first to the last glyph of that line.  The
     rectangles therefore line up with the text exactly, are continuous even
     when PDF.js splits the line into per-character spans, and never spill
     into the neighbouring line. */
  function annotationRects(sheet, item) {
    const rects = [];
    for (const part of item.ranges || []) {
      if (part.page !== sheet.no) continue;
      let offset = 0;
      for (const node of nodesOf(sheet)) {
        const length = node.data.length;
        const from = Math.max(part.start, offset);
        const to = Math.min(part.end, offset + length);
        offset += length;
        if (to <= from) continue;
        const range = document.createRange();
        range.setStart(node, from - (offset - length));
        range.setEnd(node, to - (offset - length));
        const em = parseFloat(getComputedStyle(node.parentElement).fontSize) || 0;
        for (const rect of range.getClientRects()) {
          if (rect.width < 0.4 || rect.height < 0.4) continue;
          rects.push({ rect, em });
        }
      }
    }
    return rects;
  }

  function bandsFromRects(rects, sheet) {
    const box = sheet.box.getBoundingClientRect();
    const scale = state.scale;
    /* A live range reports *two* boxes for every glyph:
       - PDF.js's span box, exactly one em tall, which is where the glyph is;
       - the browser's font box (ascent+descent, ~1.33em), taller and not
         perfectly concentric with the em box.
       Building the band from both inflated it: the union started ~0.17em above
       the glyphs and ended ~0.6em past them once the page-space padding was
       re-scaled by the zoom factor (measured 1.25em tall at 100%, 1.28em at
       400%: the user's "the selection band hangs past the text" report).
       Keep the box whose height is closest to the em size and centre the band
       on it, so the band is exactly the PDF.js em box + a hair of padding. */
    const chosen = [];
    for (const entry of rects) {
      const { rect, em } = entry;
      const score = em ? Math.abs(rect.height - em) : rect.height;
      /* The two boxes of one glyph share x/width and overlap vertically; the
         same x/width on another visual line does not overlap. */
      const hit = chosen.find(
        (candidate) =>
          Math.abs(candidate.rect.left - rect.left) < 0.5 &&
          Math.abs(candidate.rect.width - rect.width) < 0.5 &&
          rect.top < candidate.rect.bottom &&
          candidate.rect.top < rect.bottom
      );
      if (!hit) {
        chosen.push({ rect, em, score });
      } else if (score < hit.score) {
        hit.rect = rect;
        hit.em = em;
        hit.score = score;
      }
    }
    const pieces = chosen.map(({ rect, em }) => {
      const glyph = em ? Math.min(rect.height, em) : rect.height;
      return {
        x: (rect.left - box.left) / scale,
        y: (rect.top + (rect.height - glyph) / 2 - box.top) / scale,
        w: rect.width / scale,
        h: glyph / scale,
      };
    });
    const lines = [];
    for (const piece of pieces.sort((a, b) => a.y - b.y || a.x - b.x)) {
      const centre = piece.y + piece.h / 2;
      const line = lines.find(
        (entry) =>
          Math.abs(entry.centre - centre) <= Math.max(1, Math.min(entry.h, piece.h) * 0.45)
      );
      if (!line) {
        lines.push({
          left: piece.x,
          right: piece.x + piece.w,
          top: piece.y,
          bottom: piece.y + piece.h,
          h: piece.h,
          centre,
        });
        continue;
      }
      line.left = Math.min(line.left, piece.x);
      line.right = Math.max(line.right, piece.x + piece.w);
      line.top = Math.min(line.top, piece.y);
      line.bottom = Math.max(line.bottom, piece.y + piece.h);
      line.h = line.bottom - line.top;
      line.centre = (line.top + line.bottom) / 2;
    }
    /* A hair of vertical padding keeps ascenders and descenders inside the
       band without letting two lines touch.  It is a fraction of the em box
       (and the band is painted in page space, so it is multiplied by the zoom
       like the glyphs themselves): a fixed pixel pad used to grow with the
       zoom and, together with the font-box height, made the band read as a
       tall tinted strip at 150-400%. */
    const bands = lines.map((line) => {
      const pad = Math.max(0.15, line.h * 0.06);
      return {
        x: line.left,
        y: line.top - pad,
        w: line.right - line.left,
        h: line.h + pad * 2,
      };
    });
    /* Line boxes from adjacent lines can overlap by a pixel or two; trim the
       lower band instead of letting the two multiply into a darker stripe. */
    bands.sort((a, b) => a.y - b.y);
    for (let index = 1; index < bands.length; index += 1) {
      const previous = bands[index - 1];
      const band = bands[index];
      const below = previous.y + previous.h + 0.35;
      if (band.y < below) {
        const overlap = below - band.y;
        band.y += overlap;
        band.h = Math.max(2, band.h - overlap);
      }
    }
    return mergeLineBands(bands);
  }

  function legacyBands(rects) {
    const bands = [];
    for (const rect of rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
      const centre = rect.y + rect.h / 2;
      const band = bands.find(
        (entry) => Math.abs(entry.centre - centre) <= Math.min(entry.h, rect.h) * 0.5
      );
      if (!band) {
        bands.push({
          x: rect.x,
          right: rect.x + rect.w,
          top: rect.y,
          bottom: rect.y + rect.h,
          h: rect.h,
          centre,
        });
        continue;
      }
      band.x = Math.min(band.x, rect.x);
      band.right = Math.max(band.right, rect.x + rect.w);
      band.top = Math.min(band.top, rect.y);
      band.bottom = Math.max(band.bottom, rect.y + rect.h);
      band.centre = (band.top + band.bottom) / 2;
    }
    return bands.map((band) => {
      const height = band.bottom - band.top;
      const pad = height * 0.07;
      return {
        x: band.x,
        y: band.top + pad,
        w: band.right - band.x,
        h: Math.max(2, height - pad * 2),
      };
    });
  }

  /* Stored rectangles can contain several overlapping boxes per text line (a
     selection made across spans, or a highlight created before the text layer
     was ready).  Painting each box separately lets the translucent marks
     multiply into darker patches; merge every line into exactly one band
     first, then trim the tiny vertical overlaps between neighbouring lines. */
  function mergeLineBands(bands) {
    const pieces = (bands || [])
      .map((band) => ({
        x: Number(band.x) || 0,
        y: Number(band.y) || 0,
        w: Number(band.w) || 0,
        h: Number(band.h) || 0,
      }))
      .filter((band) => band.w > 0.2 && band.h > 0.2)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const piece of pieces) {
      const top = piece.y;
      const bottom = piece.y + piece.h;
      const line = lines.find((entry) => {
        const overlap = Math.min(entry.bottom, bottom) - Math.max(entry.top, top);
        return overlap > Math.min(entry.bottom - entry.top, piece.h) * 0.5;
      });
      if (!line) {
        lines.push({ left: piece.x, right: piece.x + piece.w, top, bottom });
        continue;
      }
      line.left = Math.min(line.left, piece.x);
      line.right = Math.max(line.right, piece.x + piece.w);
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
    }
    const merged = lines
      .map((line) => ({
        x: line.left,
        y: line.top,
        w: line.right - line.left,
        h: line.bottom - line.top,
      }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (let index = 1; index < merged.length; index += 1) {
      const previous = merged[index - 1];
      const band = merged[index];
      const below = previous.y + previous.h + 0.35;
      if (band.y < below) {
        const overlap = below - band.y;
        band.y += overlap;
        band.h = Math.max(1.5, band.h - overlap);
      }
    }
    return merged;
  }

  /* Annotation geometry is cached per item: ``legacyBands`` merges the stored
     rectangles into one band per text line, and that never changes until the
     annotation itself is replaced. */
  const BANDS = new WeakMap();
  const LIVE_BANDS = new WeakMap();
  const NOTE_GLYPH =
    '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
    '<path d="M3.7 4.5h6.6M3.7 7h6.6M3.7 9.5h4" stroke="currentColor" ' +
    'stroke-width="1.35" stroke-linecap="round"/></svg>';

  function bandsOf(item) {
    let bands = BANDS.get(item);
    if (!bands) {
      bands = mergeLineBands(legacyBands(item.rects || []));
      BANDS.set(item, bands);
    }
    return bands;
  }

  /* Line bands for one page.  Annotations created by this version tag every
     rectangle with its page; older ones fall back to character ranges (which
     need the live text layer) only when the highlight actually spans pages. */
  function bandsFor(item, sheet) {
    /* The live text layer knows the exact glyph boxes; prefer it over stored
       rectangles so old highlights (which may carry taller line boxes) render
       as clean, non-overlapping bands too. */
    if (item.ranges && item.ranges.length && sheet.textReady) {
      const cached = LIVE_BANDS.get(item);
      if (
        cached &&
        cached.page === sheet.no &&
        cached.scale === state.scale &&
        cached.updated === item.updated
      ) {
        return cached.bands;
      }
      const live = bandsFromRects(annotationRects(sheet, item), sheet);
      if (live.length) {
        LIVE_BANDS.set(item, {
          page: sheet.no,
          scale: state.scale,
          updated: item.updated,
          bands: live,
        });
        return live;
      }
    }
    const rects = item.rects || [];
    if (rects.length) {
      if (rects[0].page != null) {
        const out = [];
        for (const rect of rects) {
          if ((rect.page || item.page) === sheet.no) out.push(rect);
        }
        if (out.length) return mergeLineBands(out);
      } else if (item.page === sheet.no) {
        const pages = pagesOfItem(item);
        if (pages.length === 1 || !(item.ranges && item.ranges.length)) {
          return bandsOf(item);
        }
      }
    }
    if (item.ranges && item.ranges.length && sheet.textReady) {
      const bands = bandsFromRects(annotationRects(sheet, item), sheet);
      if (bands.length) return bands;
    }
    return null;
  }

  /* Where the note badge sits: just past the end of the last highlighted line
     of the page the highlight finishes on. */
  function badgeAnchor(item, sheet) {
    if (!item.comment) return null;
    const pages = pagesOfItem(item);
    if (!pages.length || pages[pages.length - 1] !== sheet.no) return null;
    const bands = bandsFor(item, sheet);
    if (!bands || !bands.length) return null;
    const last = bands[bands.length - 1];
    return { x: last.x + last.w, y: last.y + last.h / 2 };
  }

  function makeBadge(item, anchor, sheet) {
    const scale = state.scale;
    const badge = document.createElement("button");
    badge.type = "button";
    badge.className = `r-note-badge${state.flashId === item.id ? " flash" : ""}`;
    badge.dataset.id = item.id;
    badge.style.setProperty("--badge-tint", colorHex(item.color));
    badge.innerHTML = NOTE_GLYPH;
    badge.setAttribute("aria-label", `第 ${item.page} 页的批注：${item.comment.slice(0, 40)}`);
    const half = 8.5;
    const width = sheet.width || sheet.box.offsetWidth || 600;
    const height = sheet.height || sheet.box.offsetHeight || 800;
    /* The badge lives in the page's own margin, aligned with the last band.
       Sitting right after the last glyph used to cover the next characters. */
    const pageWidth = width / (scale || 1);
    const onRight = anchor.x >= pageWidth / 2;
    badge.style.left = `${onRight ? width - half - 3 : half + 3}px`;
    badge.style.top = `${clamp(anchor.y * scale, half, height - half)}px`;
    badge.addEventListener("pointerenter", () => scheduleTip(item, badge));
    badge.addEventListener("pointerleave", () => hideTip(true));
    badge.addEventListener("focus", () => scheduleTip(item, badge));
    badge.addEventListener("blur", () => hideTip());
    badge.addEventListener("click", (event) => {
      event.stopPropagation();
      hideTip();
      openEditor(item.id, event);
    });
    return badge;
  }

  function renderSheetAnnotations(sheet) {
    sheet.anno.innerHTML = "";
    const scale = state.scale;
    const items = state.byPage.get(sheet.no) || [];
    if (!items.length) {
      renderMarginCards(sheet);
      return;
    }
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      if (item.type === "highlight") {
        const bands = bandsFor(item, sheet);
        if (!bands) continue;
        bands.forEach((rect, lineIndex) => {
          const mark = document.createElement("div");
          /* Palette colours keep their pastel CSS band class; a custom #rrggbb
             tag has no class of its own and is painted inline. */
          const palette = paletteKey(item.color);
          mark.className = `r-mark${palette ? ` ${palette}` : ""}${
            state.flashId === item.id ? " flash" : ""
          }`;
          mark.dataset.id = item.id;
          mark.dataset.style = item.style || "marker";
          mark.style.setProperty("--mark-color", colorHex(item.color));
          mark.style.left = `${rect.x * scale}px`;
          mark.style.top = `${rect.y * scale}px`;
          mark.style.width = `${rect.w * scale}px`;
          mark.style.height = `${rect.h * scale}px`;
          paintMarkFinish(mark, item, lineIndex, sheet);
          fragment.appendChild(mark);
        });
        const anchor = badgeAnchor(item, sheet);
        if (anchor) fragment.appendChild(makeBadge(item, anchor, sheet));
      } else if (["ink", "text"].includes(item.type) && item.page === sheet.no) {
        fragment.appendChild(renderDrawing(item, sheet));
      } else if (item.type === "note" && item.page === sheet.no) {
        const marker = document.createElement("button");
        marker.type = "button";
        marker.className = `r-note${item.comment ? "" : " empty"}${
          state.flashId === item.id ? " flash" : ""
        }`;
        marker.dataset.id = item.id;
        marker.style.left = `${item.point.x * scale}px`;
        marker.style.top = `${item.point.y * scale}px`;
        marker.textContent = "✎";
        marker.addEventListener("pointerenter", () => scheduleTip(item, marker));
        marker.addEventListener("pointerleave", () => hideTip(true));
        marker.addEventListener("focus", () => scheduleTip(item, marker));
        marker.addEventListener("blur", () => hideTip());
        marker.addEventListener("click", (event) => {
          event.stopPropagation();
          hideTip();
          openEditor(item.id, event);
        });
        bindMovable(marker, item, sheet);
        fragment.appendChild(marker);
      }
    }
    sheet.anno.appendChild(fragment);
    /* A repaint replaces the badge the pointer was resting on, so drop a
       preview that no longer has anything to point at. */
    if (state.tipId && !sheet.anno.querySelector(`[data-id="${state.tipId}"]`)) hideTip();
    renderMarginCards(sheet);
  }

  /* Hand-drawn / crayon marks get an irregular edge; the deterministic jitter
     keeps a mark stable across repaints and zoom changes.  The hand-underline
     module is resolved at paint time on purpose: a module that failed to load
     must degrade to a CSS underline, never to a filled colour band. */
  function handUnderlineApi() {
    const api = window.StudioHandUnderline;
    return api && typeof api.render === "function" ? api : null;
  }

  const MARK_WARNINGS = new Set();
  function warnMarkPaint(key, error) {
    if (MARK_WARNINGS.has(key)) return;
    MARK_WARNINGS.add(key);
    console.warn(
      `[BabelDoc Studio] 高亮样式绘制失败（${key}），已降级为可视线条：`,
      error && error.message ? error.message : error
    );
  }

  /* Strip every inline decoration a previous paint attempt may have left, so
     the CSS band of the mark's style is all that remains. */
  function resetMarkDecorations(mark) {
    mark.style.background = "";
    mark.style.backgroundImage = "";
    mark.style.backgroundRepeat = "";
    mark.style.backgroundPosition = "";
    mark.style.backgroundSize = "";
    mark.style.border = "";
    mark.style.borderBottom = "";
    mark.style.borderRadius = "";
    mark.style.clipPath = "";
    mark.style.opacity = "";
    while (mark.firstChild) mark.firstChild.remove();
    mark.dataset.finish = "band";
  }

  /* A hand mark always has to read as an underline, even when the SVG module
     is missing or its geometry cannot be used. */
  function paintHandFallback(mark) {
    while (mark.firstChild) mark.firstChild.remove();
    mark.style.background = "none";
    mark.style.backgroundImage = "none";
    mark.style.border = "0";
    mark.style.borderBottom = "2px solid var(--mark-color, currentColor)";
    mark.style.borderRadius = "0";
    mark.style.opacity = "1";
    mark.dataset.finish = "hand-fallback";
  }

  /* One independent hand-drawn underline per text line.  The shape only
     depends on the annotation id, the page and the line index, so a repaint,
     zoom or reload draws exactly the same stroke. */
  function paintHandUnderline(mark, item, lineIndex, sheet) {
    const api = handUnderlineApi();
    const width = parseFloat(mark.style.width) || mark.offsetWidth || 0;
    const height = parseFloat(mark.style.height) || mark.offsetHeight || 0;
    if (!api || width < 2 || height < 2) {
      paintHandFallback(mark);
      return;
    }
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("hand-underline");
    const path = api.render(svg, {
      width,
      height,
      style: api.normalizeStyle(item.style) || api.DEFAULT_STYLE,
      seed: `${item.id}@p${sheet ? sheet.no : item.page}`,
      lineIndex,
      color: colorHex(item.color),
    });
    if (!path || !svg.querySelector("path.hand-underline-ink")) {
      throw new Error("hand underline produced no ink path");
    }
    mark.appendChild(svg);
    mark.dataset.finish = "hand";
  }

  function paintWavyMark(mark, item) {
    mark.style.background = "none";
    mark.style.backgroundImage = wavyStrip(colorHex(item.color));
    mark.style.backgroundRepeat = "repeat-x";
    mark.style.backgroundPosition = "left bottom";
    mark.style.backgroundSize = "12px 6px";
    mark.dataset.finish = "wavy";
  }

  function paintCrayonMark(mark, item) {
    let seed = 2166136261;
    for (const ch of String(item.id || "")) {
      seed ^= ch.charCodeAt(0);
      seed = Math.imul(seed, 16777619) >>> 0;
    }
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const points = [];
    const steps = 7;
    for (let index = 0; index <= steps; index += 1) {
      const x = (index / steps) * 100;
      const y = 1 + random() * 15;
      points.push(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
    }
    for (let index = steps; index >= 0; index -= 1) {
      const x = (index / steps) * 100;
      const y = 84 + random() * 15;
      points.push(`${x.toFixed(1)}% ${y.toFixed(1)}%`);
    }
    mark.style.clipPath = `polygon(${points.join(",")})`;
    mark.dataset.finish = "crayon";
  }

  /* The render family comes from the single HIGHLIGHT_FAMILIES table; a style
     the table does not know is a plain colour band.  A failure in one family
     degrades inside its own lane (hand -> CSS underline, other -> band) and can
     never break the rest of the page repaint. */
  function paintMarkFinish(mark, item, lineIndex = 0, sheet = null) {
    const style = item.style || "marker";
    const family = highlightFamily(style);
    mark.dataset.family = family;
    /* A custom #rrggbb tag has no pastel CSS band of its own: paint the stored
       colour inline so marker / crayon look like any other colour band. */
    const custom = !paletteKey(item.color);
    const paintCustomBand = () => {
      if (custom && (family === "band" || family === "crayon")) {
        mark.style.backgroundColor = colorHex(item.color);
      }
    };
    paintCustomBand();
    try {
      if (family === "hand") {
        paintHandUnderline(mark, item, lineIndex, sheet);
        return;
      }
      if (family === "wavy") {
        paintWavyMark(mark, item);
        return;
      }
      if (family === "crayon") {
        paintCrayonMark(mark, item);
        return;
      }
      /* band / underline / pencil are pure CSS keyed by data-style */
    } catch (error) {
      warnMarkPaint(style, error);
      if (family === "hand") paintHandFallback(mark);
      else {
        resetMarkDecorations(mark);
        paintCustomBand();
      }
    }
  }

  function wavyStrip(color) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="6">` +
      `<path d="M0 4.4q3-4 6 0t6 0" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  /* --------------------------------------------------------- note preview -- */
  function scheduleTip(item, target) {
    window.clearTimeout(state.tipTimer);
    state.tipTimer = window.setTimeout(() => showTip(item, target), TIP_DELAY);
  }

  function showTip(item, target) {
    const label = ({note:"便签",highlight:"高亮",text:"文字",ink:"画笔"}[item.type] || "批注");
    el.tip.innerHTML =
      `<div class="r-tip-head"><span class="r-dotview" style="background:${colorHex(
        item.color
      )}"></span>第 ${item.page} 页 · ${label}</div>` +
      (item.text ? `<p class="r-tip-quote">${escapeHtml(item.text.slice(0, 240))}</p>` : "") +
      `<p class="r-tip-note">${escapeHtml(item.comment || "（没有写备注）")}</p>` +
      `<div class="r-tip-foot">点击打开批注</div>`;
    el.tip.dataset.id = item.id;
    el.tip.hidden = false;
    state.tipId = item.id;
    positionTip(target);
  }

  function positionTip(target) {
    const box = target.getBoundingClientRect();
    const tip = el.tip.getBoundingClientRect();
    let left = box.left + box.width / 2 - tip.width / 2;
    let top = box.top - tip.height - 10;
    if (top < 8) top = box.bottom + 10;
    left = clamp(left, 10, Math.max(10, window.innerWidth - tip.width - 10));
    top = clamp(top, 10, Math.max(10, window.innerHeight - tip.height - 10));
    el.tip.style.left = `${left}px`;
    el.tip.style.top = `${top}px`;
  }

  function hideTip(delayed = false) {
    window.clearTimeout(state.tipTimer);
    if (delayed) {
      state.tipTimer = window.setTimeout(() => {
        el.tip.hidden = true;
        state.tipId = null;
      }, 90);
      return;
    }
    el.tip.hidden = true;
    state.tipId = null;
  }

  /* Every page an annotation touches, so a repaint only touches those. */
  function pagesOfItem(item) {
    const rects = item.rects || [];
    if (rects.length && rects[0].page != null) {
      return [...new Set(rects.map((rect) => rect.page || item.page))];
    }
    if (item.ranges && item.ranges.length) {
      return [...new Set(item.ranges.map((part) => part.page))];
    }
    return [item.page];
  }

  function reindex() {
    const map = new Map();
    for (const item of state.items) {
      for (const page of pagesOfItem(item)) {
        const list = map.get(page);
        if (list) list.push(item);
        else map.set(page, [item]);
      }
    }
    state.byPage = map;
  }

  function refreshAnnotations(pageList) {
    const pages = pageList && pageList.length ? new Set(pageList) : null;
    const editing = state.editingId
      ? state.items.find((item) => item.id === state.editingId)
      : null;
    for (const sheet of state.sheets) {
      if (!sheet.painted && !sheet.textReady) continue;
      if (pages && !pages.has(sheet.no)) continue;
      /* Never wipe the contenteditable while the user is typing in it. */
      if (editing && editing.page === sheet.no) {
        renderMarginCards(sheet);
        continue;
      }
      renderSheetAnnotations(sheet);
    }
  }

  function renderNotesList() {
    /* Page text is content on the page, not a review note: keep it out of the
       sidebar (and its count) so the list stays about highlights/notes. */
    const all = [...state.items]
      .filter((item) => item.type !== "text")
      .sort((a, b) => a.page - b.page || a.created - b.created);
    const active = state.colorFilter;
    const visible = active.size ? all.filter((item) => active.has(item.color)) : all;
    el.annoCount.textContent = active.size ? `${visible.length}/${all.length}` : String(all.length);
    const chips =
      '<div class="r-filter" role="group" aria-label="按颜色筛选">' +
      `<button type="button" class="r-filter-chip${active.size ? "" : " on"}" data-filter="all">全部</button>` +
      readColorTags()
        .map((tag) => {
          const label = colorHint(tag.color);
          return (
            `<button type="button" class="r-filter-chip${active.has(tag.color) ? " on" : ""}" data-filter="${escapeHtml(
              tag.color
            )}" title="${escapeHtml(label)}"` +
            `${colorHintLabel(tag.color) ? ` data-hint="${escapeHtml(colorHintLabel(tag.color))}"` : ""}>` +
            `<span class="r-dotview" style="background:${colorHex(tag.color)}"></span></button>`
          );
        })
        .join("") +
      "</div>";
    if (!all.length) {
      el.panelNotes.innerHTML =
        chips +
        '<p class="r-empty">还没有批注。<br>选中正文即可高亮，<br>或用「便签」工具在页面上做便签。<br>' +
        "带备注的批注会在行尾出现小旗标，<br>鼠标悬停即可预览。</p>";
      return;
    }
    if (!visible.length) {
      el.panelNotes.innerHTML =
        chips + '<p class="r-empty">没有这个颜色的批注。<br>点「全部」查看所有批注。</p>';
      return;
    }
    el.panelNotes.innerHTML =
      chips +
      visible
        .map(
          (item) => `
        <article class="r-card" data-id="${item.id}">
          <div class="r-card-top">
            <span class="r-badge-page">第 ${item.page} 页 · ${
              { note: "便签", highlight: "高亮", text: "文字", ink: "画笔" }[item.type] || "批注"
            }</span>
            <span class="r-dotview${
              paletteKey(item.color) ? ` ${paletteKey(item.color)}` : ""
            }" style="background:${colorHex(item.color)}"></span>
            <span class="r-card-color">${escapeHtml(tagName(item.color))}</span>
            <button class="r-card-del" type="button" data-del="${item.id}" title="删除">✕</button>
          </div>
          ${item.text ? `<p class="r-card-quote">${escapeHtml(item.text.slice(0, 180))}</p>` : ""}
          <p class="r-card-note${item.comment ? "" : " muted"}">${
            item.comment ? escapeHtml(item.comment.slice(0, 400)) : "（无批注文字）"
          }</p>
        </article>`
        )
        .join("");
  }

  /* ------------------------------------------------------ undo history -- */
  /* Ctrl+Z takes back the last annotation change.  Every user-visible mutation
     records a deep copy of the list just before it happens; 60 snapshots cover
     a normal editing burst while staying cheap to hold. */
  const HISTORY_LIMIT = 60;
  const undoStack = [];
  const redoStack = [];
  let textEditHistory = null;

  function historySnapshot() {
    return { items: JSON.parse(JSON.stringify(state.items)) };
  }

  /* Timestamps change on every touch, so an undo step only counts as new when
     the actual annotation content differs. */
  function historyItemsEqual(a, b) {
    const strip = (list) =>
      (list || []).map((item) => {
        const copy = { ...item };
        delete copy.updated;
        return copy;
      });
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }

  function pushHistory(before) {
    const entry = before || historySnapshot();
    const top = undoStack[undoStack.length - 1];
    /* A no-op mutation (same list as the last snapshot) must not add a step. */
    if (top && historyItemsEqual(top.items, entry.items)) return;
    undoStack.push(entry);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  /* Drop an open editor without committing it: the restored snapshot is the
     source of truth, and a half-typed comment must not leak into it. */
  function cancelEditorForHistory() {
    textEditHistory = null;
    if (state.editingId) {
      hideTextFrame();
      state.editingId = null;
      document.body.classList.remove("editing-text");
      updateTextbar();
    }
    el.editor.hidden = true;
    state.activeId = null;
    hideSelectionToolbar();
    hideTip();
    closeMenu();
  }

  function applyHistory(entry) {
    state.items = JSON.parse(JSON.stringify(entry.items || []));
    state.activeId = null;
    state.editingId = null;
    reindex();
    persist();
    if (!refreshMarginColumns()) refreshAnnotations();
    renderNotesList();
    refreshDock();
    updateTextbar();
  }

  function undoAnnotation() {
    if (!undoStack.length) {
      toast("没有可撤回的批注");
      return;
    }
    /* Close open editors first: a committed comment (or finished text edit)
       becomes the step that the undo takes back, so no draft is dropped. */
    if (state.editingId) endTextEdit();
    if (!el.editor.hidden) closeEditor();
    cancelEditorForHistory();
    const entry = undoStack.pop();
    redoStack.push(historySnapshot());
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
    applyHistory(entry);
    toast("已撤回上一步批注", "good");
  }

  function redoAnnotation() {
    if (!redoStack.length) {
      toast("没有可重做的批注");
      return;
    }
    cancelEditorForHistory();
    const entry = redoStack.pop();
    undoStack.push(historySnapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    applyHistory(entry);
    toast("已重做批注", "good");
  }

  let saveRevision = 0;
  let savedRevision = 0;
  let saveQueue = Promise.resolve();
  function persist() {
    const revision = ++saveRevision;
    el.saved.textContent = "保存中…";
    el.saved.classList.remove("ok");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const snapshot = JSON.parse(JSON.stringify(state.items));
      saveQueue = saveQueue.then(async () => {
      try {
        const result = await api("/api/annotations", {
          method: "POST",
          body: { path: docPath, items: snapshot },
        });
        /* A slower response must not overwrite edits made while it was in
           flight; those already have their own save queued. */
        let partial = false;
        if (saveRevision === revision) {
          const saved = Array.isArray(result.items) ? result.items : [];
          const byId = new Map(saved.map((entry) => [entry.id, entry]));
          /* Merge instead of replacing: a server that does not understand a
             newer annotation type must not make it vanish from the page. Keep
             the local copy and warn, rather than silently losing the work. */
          state.items = state.items.map((item) => {
            const fresh = byId.get(item.id);
            if (!fresh) {
              partial = true;
              return item;
            }
            return { ...item, ...fresh };
          });
          /* The response carries fresh item objects, so the per-page index has
             to be rebuilt — otherwise marks keep painting from stale copies. */
          reindex();
          renderNotesList();
          refreshAnnotations();
        }
        if (!partial) savedRevision = revision;
        if (saveRevision === revision) {
          if (partial) {
            el.saved.textContent = "需重启应用";
            el.saved.classList.remove("ok");
            showStaleBanner();
          } else {
            el.saved.textContent = "已保存";
            el.saved.classList.add("ok");
          }
        }
      } catch (error) {
        el.saved.textContent = "保存失败";
        toast(error.message, "bad");
      }
      });
    }, 450);
  }

  async function loadAnnotations() {
    let items = [];
    try {
      const data = await api(`/api/annotations?${new URLSearchParams({ path: docPath })}`);
      items = data.items || [];
    } catch (error) {
      toast(`批注读取失败：${error.message}`, "bad");
    }

    let imported = false;
    if (!items.length) {
      /* A PDF saved by this app carries its highlights and notes; adopt them
         when the local store knows nothing about this file (a shared copy, or
         the same paper opened on another machine). */
      try {
        const data = await api(`/api/annotations/pdf?${new URLSearchParams({ path: docPath })}`);
        const found = (data.items || []).map((item) => ({
          ...item,
          id: uid(),
          created: Date.now() / 1000,
          updated: Date.now() / 1000,
        }));
        if (found.length) {
          items = found;
          imported = true;
        }
      } catch {
        /* no embedded annotations, or the file is not readable by PyMuPDF */
      }
    }

    state.items = items;
    reindex();
    syncMarginColumns();
    renderNotesList();
    /* Pages may already be painted by the time annotations arrive, so repaint
       the marks instead of waiting for the next scroll or zoom. */
    refreshAnnotations();
    if (imported) {
      toast(`已从 PDF 读取 ${items.length} 条批注`, "good");
      persist();
    }
  }

  function addAnnotation(patch, before) {
    pushHistory(before);
    const now = Date.now() / 1000;
    const item = {
      id: uid(),
      type: "highlight",
      page: state.page,
      color: "yellow",
      rects: [],
      ranges: [],
      point: { x: 0, y: 0 },
      text: "",
      comment: "",
      created: now,
      updated: now,
      ...patch,
    };
    state.items.push(item);
    reindex();
    refreshMarginColumns();
    persist();
    return item;
  }

  function removeAnnotation(id, record = true) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    if (record) pushHistory();
    const [item] = state.items.splice(index, 1);
    if (state.activeId === id) closeEditor(true);
    reindex();
    persist();
    if (!refreshMarginColumns()) refreshAnnotations(pagesOfItem(item));
    renderNotesList();
  }

  /* --------------------------------------------------------- selection -- */
  function captureSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);

    const parts = [];
    const rects = [];
    const texts = [];
    for (const sheet of state.sheets) {
      if (!sheet.textReady) continue;
      let touches = false;
      try {
        touches = range.intersectsNode(sheet.text);
      } catch {
        touches = false;
      }
      if (!touches) continue;

      const span = spanOffsets(sheet, range);
      if (!span) continue;
      parts.push({ page: sheet.no, start: span.start, end: span.end });
      texts.push(sheetText(sheet).slice(span.start, span.end));

      const box = sheet.box.getBoundingClientRect();
      const pageRects = [];
      for (const { rect, em } of span.rects) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        /* Client rects are line boxes; store glyph-height bands so adjacent
           lines never overlap and the mark lines up with the text. */
        const glyph = em ? Math.min(rect.height, em * 1.12) : rect.height;
        pageRects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top + (rect.height - glyph) / 2 - box.top) / state.scale,
          w: rect.width / state.scale,
          h: glyph / state.scale,
        });
      }
      /* One band per text line, tagged with its page: painting then needs no
         access to the text layer at all, and a highlight may start on one page
         and end on the next. */
      for (const band of legacyBands(pageRects)) {
        rects.push({ ...band, page: sheet.no });
      }
    }
    if (!parts.length) return null;

    const clientRects = range.getClientRects();
    const last = clientRects[clientRects.length - 1];
    return {
      parts,
      rects,
      text: cleanText(texts.join("\n")).slice(0, 3000),
      anchor: last
        ? { x: last.left + last.width / 2, y: last.bottom }
        : { x: window.innerWidth / 2, y: 140 },
    };
  }

  /* PDF.js splits CJK runs into spans, which leaves spaces between words. */
  function cleanText(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(
        /([\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef])[ ]+(?=[\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef])/g,
        "$1"
      )
      .trim();
  }

  function showSelectionToolbar(anchor) {
    el.selToolbar.hidden = false;
    const box = el.selToolbar.getBoundingClientRect();
    let left = anchor.x - box.width / 2;
    let top = anchor.y + 12;
    if (top + box.height > window.innerHeight - 12) top = anchor.y - box.height - 16;
    left = clamp(left, 12, window.innerWidth - box.width - 12);
    top = clamp(top, 12, window.innerHeight - box.height - 12);
    el.selToolbar.style.left = `${left}px`;
    el.selToolbar.style.top = `${top}px`;
    refreshDock();
  }

  function hideSelectionToolbar() {
    if (el.selToolbar.hidden) return;
    el.selToolbar.hidden = true;
    state.pending = null;
    clearSync();
    /* Hiding the toolbar must not clear the preview while the native selection
       is still alive (it may be hidden for a menu or a tool switch). */
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) clearPickBands();
  }

  function onMouseUp(event) {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    /* A drag may well end on a note badge, so only the chrome is excluded. */
    if (target && target.closest(".r-sel, .r-editor, .r-side, .r-top")) return;
    window.setTimeout(() => {
      const captured = captureSelection();
      if (!captured) {
        hideSelectionToolbar();
        clearSync();
        return;
      }
      state.pending = captured;
      showSelectionToolbar(captured.anchor);
      showSync(captured);
    }, 0);
  }

  /* -------------------------------------------------- overlapping marks -- */
  /* A second highlight over the same words multiplies into a darker, choppy
     patch (the reported “blue over orange”).  Creating one therefore takes the
     overlap out of the older highlights: pieces fully covered disappear, a
     partly covered highlight keeps only its untouched ranges.  addAnnotation
     snapshots the list *before* this runs, so one Ctrl+Z restores the previous
     highlight(s) and removes the new one. */
  function rangeInside(coverParts, part) {
    const cover = (coverParts || []).find((entry) => entry.page === part.page);
    return Boolean(cover && cover.start <= part.start && part.end <= cover.end);
  }

  function subtractRange(part, cut) {
    if (cut.page !== part.page || cut.end <= part.start || cut.start >= part.end) return [part];
    const pieces = [];
    if (cut.start > part.start) {
      pieces.push({ page: part.page, start: part.start, end: Math.min(cut.start, part.end) });
    }
    if (cut.end < part.end) {
      pieces.push({ page: part.page, start: Math.max(cut.end, part.start), end: part.end });
    }
    return pieces;
  }

  /* Recompute an annotation's stored rectangles and quote from its ranges.
     Live text layers are used where available; a page without one keeps no
     stale rectangles, because bandsFor rebuilds them from the ranges. */
  function refreshHighlightGeometry(item) {
    const parts = item.ranges || [];
    const rects = [];
    const texts = [];
    let complete = true;
    for (const part of parts) {
      const sheet = state.sheets[part.page - 1];
      if (!sheet || !sheet.textReady) {
        complete = false;
        continue;
      }
      const box = sheet.box.getBoundingClientRect();
      const pageRects = [];
      for (const { rect, em } of annotationRects(sheet, { ranges: [part] })) {
        const glyph = em ? Math.min(rect.height, em * 1.12) : rect.height;
        pageRects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top + (rect.height - glyph) / 2 - box.top) / state.scale,
          w: rect.width / state.scale,
          h: glyph / state.scale,
        });
      }
      for (const band of legacyBands(pageRects)) rects.push({ ...band, page: part.page });
      texts.push(sheetText(sheet).slice(part.start, part.end));
    }
    item.rects = rects;
    if (complete && texts.length) item.text = cleanText(texts.join("\n")).slice(0, 3000);
    item.updated = Date.now() / 1000;
  }

  /* Trim/remove the older highlights the new selection overlaps.  Returns the
     number of annotations that changed, so the caller can toast once. */
  function mergeOverlappingHighlights(captured) {
    const cuts = (captured && captured.parts) || [];
    if (!cuts.length) return 0;
    const replaced = [];
    let changed = 0;
    for (const item of state.items) {
      if (item.type !== "highlight") continue;
      const parts = item.ranges || [];
      if (!parts.length) continue;
      if (parts.every((part) => rangeInside(cuts, part))) {
        replaced.push(item);
        changed += 1;
        continue;
      }
      const kept = [];
      let touched = false;
      for (const part of parts) {
        let pieces = [part];
        for (const cut of cuts) pieces = pieces.flatMap((piece) => subtractRange(piece, cut));
        if (!pieces.length) {
          touched = true;
        } else if (
          pieces.length !== 1 ||
          pieces[0].start !== part.start ||
          pieces[0].end !== part.end
        ) {
          touched = true;
        }
        kept.push(...pieces);
      }
      if (!touched) continue;
      if (!kept.length) {
        replaced.push(item);
      } else {
        item.ranges = kept;
        refreshHighlightGeometry(item);
      }
      changed += 1;
    }
    if (!changed) return 0;
    if (state.activeId && replaced.some((item) => item.id === state.activeId)) closeEditor(true);
    if (replaced.length) {
      state.items = state.items.filter((item) => !replaced.includes(item));
    }
    return changed;
  }

  function highlightSelection(color, style) {
    const captured = state.pending;
    if (!captured) return null;
    /* The single hand button and every entry point resolve through the style
       table, so the stored style and the painted family always agree. */
    const requested = resolveHighlightStyle(style || control("highlight-style").value || "marker");
    const resolvedStyle = HIGHLIGHT_FAMILIES[requested] ? requested : "marker";
    /* Snapshot, then take the overlap out of the older highlights, then add the
       new one: all of it is a single undo step. */
    const before = historySnapshot();
    const merged = mergeOverlappingHighlights(captured);
    const item = addAnnotation(
      {
        type: "highlight",
        page: captured.parts[0].page,
        color,
        style: resolvedStyle,
        rects: captured.rects,
        ranges: captured.parts,
        text: captured.text,
      },
      before
    );
    rememberHighlightColor(color);
    rememberHighlightStyle(resolvedStyle);
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    /* The selection has been consumed by the new mark; drop its preview. */
    clearPickBands();
    hideSelectionToolbar();
    if (!refreshMarginColumns()) {
      refreshAnnotations(captured.parts.map((part) => part.page));
    }
    renderNotesList();
    if (merged) {
      persist();
      toast("已合并重叠高亮", "good");
    }
    return item;
  }

  function pointToPage(sheet, clientX, clientY) {
    const rect = sheet.box.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / state.scale,
      y: (clientY - rect.top) / state.scale,
    };
  }

  function offsetAtPoint(sheet, clientX, clientY) {
    let caret = null;
    if (document.caretRangeFromPoint) {
      caret = document.caretRangeFromPoint(clientX, clientY);
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      if (position) {
        caret = document.createRange();
        caret.setStart(position.offsetNode, position.offset);
        caret.collapse(true);
      }
    }
    if (!caret || !sheet.text.contains(caret.startContainer)) return null;
    if (caret.startContainer.nodeType !== Node.TEXT_NODE) return null;
    let offset = 0;
    for (const node of nodesOf(sheet)) {
      if (node === caret.startContainer) return offset + caret.startOffset;
      offset += node.data.length;
    }
    return null;
  }

  function hitTest(sheet, clientX, clientY) {
    const items = state.byPage.get(sheet.no) || [];
    const offset = offsetAtPoint(sheet, clientX, clientY);
    if (offset != null) {
      let hit = null;
      for (const item of items) {
        if (item.type !== "highlight") continue;
        if (
          (item.ranges || []).some(
            (part) => part.page === sheet.no && offset >= part.start && offset <= part.end
          )
        ) {
          hit = item;
        }
      }
      if (hit) return hit;
    }
    /* The text layer may not be built yet (or is hidden while scrolling), so
       fall back to the stored line bands. */
    const point = pointToPage(sheet, clientX, clientY);
    let fallback = null;
    for (const item of items) {
      if (item.type !== "highlight") continue;
      const inside = (item.rects || []).some((rect) => {
        const page = rect.page || item.page;
        return (
          page === sheet.no &&
          point.x >= rect.x &&
          point.x <= rect.x + rect.w &&
          point.y >= rect.y &&
          point.y <= rect.y + rect.h
        );
      });
      if (inside) fallback = item;
    }
    return fallback;
  }

  /* ------------------------------------------------------------ editor -- */
  function openEditor(id, event) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    /* Page text edits in place; the floating editor is only for notes,
       highlights and ink sketches. */
    if (item.type === "text") {
      beginTextEdit(id);
      return;
    }
    state.activeId = id;
    loadDrawingControls(item);
    el.editor.hidden = false;
    el.editorStyles.hidden = item.type !== "highlight";
    syncHandPresetChips(item);
    el.editorPage.textContent = `第 ${item.page} 页 · ${({note:"便签",highlight:"高亮",text:"文字",ink:"画笔"}[item.type] || "批注")}`;
    el.editorQuote.textContent = item.text || "";
    el.editorQuote.hidden = !item.text;
    el.editorText.value = item.comment || "";
    for (const dot of $$(".r-dot", el.editorColors)) {
      dot.classList.toggle("on", dot.dataset.color === item.color);
    }
    positionEditor(event);
    el.editorText.focus();
    el.editorText.setSelectionRange(el.editorText.value.length, el.editorText.value.length);
  }

  function positionEditor(event) {
    const box = el.editor.getBoundingClientRect();
    let left = event ? event.clientX + 14 : window.innerWidth - box.width - 60;
    let top = event ? event.clientY + 14 : 120;
    left = clamp(left, 12, window.innerWidth - box.width - 12);
    top = clamp(top, 12, window.innerHeight - box.height - 12);
    el.editor.style.left = `${left}px`;
    el.editor.style.top = `${top}px`;
  }

  function closeEditor(skipCommit = false) {
    if (el.editor.hidden) return;
    const item = state.items.find((entry) => entry.id === state.activeId);
    if (item && !skipCommit) {
      const text = el.editorText.value.trim();
      if (text !== item.comment) {
        pushHistory();
        item.comment = text;
        item.updated = Date.now() / 1000;
        persist();
        if (!refreshMarginColumns()) refreshAnnotations(pagesOfItem(item));
        renderNotesList();
      }
    }
    state.activeId = null;
    el.editor.hidden = true;
    /* An empty text box would be invisible and un-clickable: drop it instead
       of leaving a stray annotation on the page. */
    if (item && item.type === "text" && !item.comment) {
      removeAnnotation(item.id, false);
      toast("空文字已移除", "good");
    }
  }

  function deleteActive() {
    if (!state.activeId) return;
    removeAnnotation(state.activeId);
  }

  /* Clicking a card in the sidebar should land on the highlighted sentence,
     not on the top of the page. */
  async function focusAnnotation(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) return;
    const card = el.panelNotes.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 800);
    }

    /* Marks are rebuilt whenever a page repaints, so the "look here" state is
       kept on the reader and re-applied instead of being set once on the DOM. */
    state.flashId = id;
    setTimeout(() => {
      if (state.flashId === id) state.flashId = null;
    }, 1700);

    const sheet = state.sheets[item.page - 1];
    if (!sheet) return;
    await ensurePainted(sheet);
    if (state.flashId === id) refreshAnnotations();

    const bounds = annotationBounds(sheet, item);
    if (!bounds) {
      goToPage(item.page);
      return;
    }

    const pageBox = sheet.box.getBoundingClientRect();
    const stageBox = el.stage.getBoundingClientRect();
    const scale = state.scale;
    const width = Math.max(4, bounds.w * scale);
    const height = Math.max(4, bounds.h * scale);
    const centreX = pageBox.left + (bounds.x + bounds.w / 2) * scale - stageBox.left;
    const centreY = pageBox.top + (bounds.y + bounds.h / 2) * scale - stageBox.top;

    const top = clamp(
      el.stage.scrollTop + centreY - el.stage.clientHeight / 2,
      0,
      Math.max(0, el.stage.scrollHeight - el.stage.clientHeight)
    );
    /* only pull horizontally when the page is wider than the viewport */
    const left =
      width > el.stage.clientWidth * 0.75
        ? el.stage.scrollLeft
        : clamp(
            el.stage.scrollLeft + centreX - el.stage.clientWidth / 2,
            0,
            Math.max(0, el.stage.scrollWidth - el.stage.clientWidth)
          );

    const far = Math.abs(top - el.stage.scrollTop) > el.stage.clientHeight * 1.5;
    el.stage.scrollTo({
      top,
      left,
      behavior: reduceMotion() || far ? "auto" : "smooth",
    });

    state.page = sheet.no;
    syncPageUI();
  }

  async function ensurePainted(sheet) {
    let guard = 0;
    while (sheet.busy && guard < 80) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      guard += 1;
    }
    if (!sheet.painted) await paint(sheet);
  }

  /* Where an annotation sits on its page, in PDF units.  Long highlights use
     their first line so the reader lands on readable text. */
  function annotationBounds(sheet, item) {
    if (["note", "text", "ink"].includes(item.type)) {
      const { x, y } = item.point || { x: 0, y: 0 };
      return { x: x - 6, y: y - 6, w: 12, h: 12 };
    }
    const bands = bandsFor(item, sheet) || [];
    if (!bands.length) return null;

    const first = bands[0];
    let left = first.x;
    let right = first.x + first.w;
    let top = first.y;
    let bottom = first.y + first.h;
    for (const band of bands) {
      left = Math.min(left, band.x);
      right = Math.max(right, band.x + band.w);
      top = Math.min(top, band.y);
      bottom = Math.max(bottom, band.y + band.h);
    }
    const limit = (el.stage.clientHeight * 0.55) / state.scale;
    if (bottom - top > limit) return first;
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /* ------------------------------------------------------------ export -- */
  function exportMarkdown() {
    if (!state.items.length) {
      toast("还没有批注可以导出", "bad");
      return;
    }
    const sorted = [...state.items].sort((a, b) => a.page - b.page || a.created - b.created);
    const lines = [
      `# ${fileName(docPath).replace(/\.pdf$/i, "")} · 阅读批注`,
      "",
      `> ${sorted.length} 条批注`,
      "",
    ];
    let page = 0;
    for (const item of sorted) {
      if (item.page !== page) {
        page = item.page;
        lines.push(`## 第 ${page} 页`, "");
      }
      if (["note", "text", "ink"].includes(item.type)) {
        lines.push(`- **${{note:"便签",text:"页面文字",ink:"笔迹（请导出 PDF 查看）"}[item.type]}**：${item.comment || "（空）"}`);
      } else {
        lines.push(`- **高亮（${tagName(item.color)}）**：${item.text || "（无选中文字）"}`);
        if (item.comment) lines.push(`  > ${item.comment.replace(/\n+/g, " ")}`);
      }
      lines.push("");
    }
    download(`${fileName(docPath).replace(/\.pdf$/i, "")}_批注.md`, lines.join("\n"));
    toast("已导出批注", "good");
  }

  /* Write the notes into a copy of the PDF so they survive leaving the app:
     the file opens with the highlights visible in any PDF reader, and this
     reader adopts them again if the local store is empty. */
  async function savePdf() {
    if (!state.items.length) {
      toast("还没有批注可以保存", "bad");
      return;
    }
    el.saved.textContent = "正在生成…";
    el.saved.classList.remove("ok");
    try {
      const result = await api("/api/annotations/export", {
        method: "POST",
        body: { path: docPath, items: state.items },
      });
      state.lastExport = result.path || "";
      el.saved.textContent = "已保存";
      el.saved.classList.add("ok");
      toastAction(`已保存 ${result.name}（${result.count} 条批注）`, "打开", () =>
        revealPath(result.path)
      );
    } catch (error) {
      el.saved.textContent = "保存失败";
      const message = String(error.message || error);
      /* A 404 here means the page is newer than the running backend (the app
         was not restarted after an update). */
      toast(
        /404/.test(message)
          ? "导出接口不可用：请用右下角「退出应用」退出后，重新双击「启动.bat」再试"
          : message,
        "bad"
      );
    }
  }

  function toastAction(message, label, onClick) {
    const host = $("#toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = "toast good action";
    const text = document.createElement("span");
    text.textContent = message;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      onClick();
      node.remove();
    });
    node.append(text, button);
    host.appendChild(node);
    setTimeout(() => node.remove(), 9000);
  }

  async function revealPath(path) {
    if (!path) return;
    try {
      await api("/api/open", { method: "POST", body: { path } });
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ------------------------------------------------------------- menu -- */
  function openMenu() {
    if (!state.items.length) {
      toast("还没有批注可以导出", "bad");
      return;
    }
    el.menu.classList.remove("r-menu-rich");
    el.menu.onclick = null;
    el.menu.innerHTML =
      '<button type="button" data-act="md">导出 Markdown<span class="r-menu-hint">.md</span></button>' +
      '<button type="button" data-act="pdf">保存带批注的 PDF<span class="r-menu-hint">.pdf</span></button>' +
      "<hr>" +
      '<button type="button" data-act="folder">在文件夹中显示</button>';
    el.menu.hidden = false;
    const box = el.exportBtn.getBoundingClientRect();
    const menu = el.menu.getBoundingClientRect();
    el.menu.style.left = `${clamp(box.right - menu.width, 10, window.innerWidth - menu.width - 10)}px`;
    el.menu.style.top = `${Math.min(box.bottom + 6, window.innerHeight - menu.height - 10)}px`;
    el.exportBtn.setAttribute("aria-expanded", "true");
    for (const button of $$("[data-act]", el.menu)) {
      button.addEventListener("click", () => {
        const action = button.dataset.act;
        closeMenu();
        if (action === "md") exportMarkdown();
        else if (action === "pdf") savePdf();
        else if (action === "folder") revealPath(state.lastExport || docPath);
      });
    }
  }

  function closeMenu() {
    if (el.menu.hidden) return;
    el.menu.hidden = true;
    el.menu.onclick = null;
    el.exportBtn.setAttribute("aria-expanded", "false");
  }

  /* ---------------------------------------------------- text layer arm -- */
  /* PDF.js text layers are skipped off-screen by CSS (content-visibility), but
     they stay live on the page being read, so text is always selectable. */

  /* ------------------------------------------------------------ events -- */
  function bindEvents() {
    el.prev.addEventListener("click", () => goToPage(state.page - 1));
    el.next.addEventListener("click", () => goToPage(state.page + 1));
    el.pageInput.addEventListener("change", () => goToPage(Number(el.pageInput.value) || 1));
    el.zoomOut.addEventListener("click", () => zoom(1 / 1.15));
    el.zoomIn.addEventListener("click", () => zoom(1.15));
    el.fit.addEventListener("click", () => {
      const anchor = scrollAnchor();
      state.fit = state.fit === "width" ? "page" : "width";
      relayout(anchor);
    });

    el.stage.addEventListener("scroll", onScroll, { passive: true });
    el.stage.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false }
    );

    el.noteTool.addEventListener("click", () => {
      setDrawingTool("select");
      state.noteTool = !state.noteTool;
      el.noteTool.setAttribute("aria-pressed", String(state.noteTool));
      el.pages.classList.toggle("note-mode", state.noteTool);
      if (state.noteTool) {
        hideSelectionToolbar();
        toast("点击页面任意位置添加便签");
      }
    });

    el.exportBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (el.menu.hidden) openMenu();
      else closeMenu();
    });

    document.addEventListener("mousedown", (event) => {
      if (el.menu.hidden) return;
      if (event.target.closest(".r-menu")) return;
      if (event.target.closest("#btn-export")) return;
      closeMenu();
    });

    document.addEventListener("mousedown", (event) => {
      if (event.target instanceof Element && event.target.closest(".r-sel")) return;
      clearSync();
    });

    el.sidebarBtn.addEventListener("click", () => {
      setSidebarCollapsed(!el.sidebar.hidden);
    });

    for (const tab of el.tabs) {
      tab.addEventListener("click", () => {
        const name = tab.dataset.tab;
        for (const other of el.tabs) other.classList.toggle("on", other === tab);
        el.panelThumbs.hidden = name !== "thumbs";
        el.panelNotes.hidden = name !== "notes";
      });
    }

    el.pages.addEventListener("click", (event) => {
      const section = event.target.closest(".r-sheet");
      if (!section) return;
      const sheet = state.sheets[Number(section.dataset.page) - 1];
      if (!sheet) return;
      if (event.target.closest(".r-page-text, .r-ink, .r-margin, .r-text-frame")) return;
      if (window.getSelection() && !window.getSelection().isCollapsed) return;
      if (event.target.closest(".r-note")) return;
      if (state.editingId) endTextEdit();

      if (state.noteTool) {
        const item = addAnnotation({
          type: "note",
          page: sheet.no,
          color: "pink",
          point: pointToPage(sheet, event.clientX, event.clientY),
        });
        /* one note per activation keeps plain clicks useful afterwards */
        state.noteTool = false;
        el.noteTool.setAttribute("aria-pressed", "false");
        el.pages.classList.remove("note-mode");
        refreshAnnotations([sheet.no]);
        openEditor(item.id, event);
        return;
      }
      const hit = hitTest(sheet, event.clientX, event.clientY);
      if (hit) openEditor(hit.id, event);
    });

    document.addEventListener("mouseup", onMouseUp);
    /* Live counterpart while the pointer is still dragging out a selection. */
    document.addEventListener("selectionchange", scheduleLiveSync);


    el.selToolbar.addEventListener("mousedown", (event) => event.preventDefault());
    /* Delegated: the toolbar dots are re-rendered from readerPrefs.colorTags
       whenever a tag is added, deleted or reordered. */
    el.selToolbar.addEventListener("click", (event) => {
      const add = event.target.closest("[data-add-tag]");
      if (add) {
        event.stopPropagation();
        /* The picker lives off-screen; `state.pending` keeps the selection
           alive while the native colour dialog is open. */
        if (el.selColorPicker) el.selColorPicker.click();
        return;
      }
      const dot = event.target.closest(".r-dot[data-color]");
      if (!dot) return;
      event.stopPropagation();
      rememberHighlightColor(dot.dataset.color);
      highlightSelection(dot.dataset.color);
    });
    if (el.selColorPicker) {
      el.selColorPicker.addEventListener("change", () => {
        const tag = addColorTagQuick(el.selColorPicker.value);
        if (!tag) return;
        const item = highlightSelection(tag.color);
        if (!item) toast("选区已失效，请在正文里重新选中文字", "bad");
      });
    }
    el.selNote.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = highlightSelection("pink");
      if (item) openEditor(item.id, event);
    });
    el.selAi.addEventListener("click", (event) => {
      event.stopPropagation();
      const captured = state.pending || captureSelection();
      if (!captured || !String(captured.text || "").trim()) {
        toast("先选中一段原文", "bad");
        return;
      }
      if (window.ReaderAI && typeof window.ReaderAI.quote === "function") {
        window.ReaderAI.quote(captured);
      } else {
        toast("AI 脚本没有加载，请刷新重试", "bad");
      }
      window.getSelection().removeAllRanges();
      hideSelectionToolbar();
    });
    el.selNotebook.addEventListener("click", (event) => {
      event.stopPropagation();
      const captured = state.pending || captureSelection();
      if (!captured) return;
      if (window.ReaderNotes && typeof window.ReaderNotes.createFromSelection === "function") {
        window.ReaderNotes.createFromSelection(captured);
      } else {
        toast("笔记脚本没有加载，请刷新重试", "bad");
      }
      window.getSelection().removeAllRanges();
      hideSelectionToolbar();
    });
    el.selCopy.addEventListener("click", async (event) => {
      event.stopPropagation();
      const captured = state.pending;
      if (!captured) return;
      try {
        await navigator.clipboard.writeText(captured.text);
        toast("已复制选中文字", "good");
      } catch {
        toast("复制失败，请使用 Ctrl+C", "bad");
      }
      window.getSelection().removeAllRanges();
      hideSelectionToolbar();
    });

    document.addEventListener("mousedown", (event) => {
      if (el.editor.hidden) return;
      if (event.target.closest(".r-editor")) return;
      if (event.target.closest(".r-note")) return;
      if (event.target.closest(".r-note-badge")) return;
      if (event.target.closest(".r-menu")) return;
      closeEditor();
    });

    el.editorClose.addEventListener("click", () => closeEditor());
    el.editorDone.addEventListener("click", () => closeEditor());
    el.editorDelete.addEventListener("click", deleteActive);
    /* Delegated: the editor dots are re-rendered from readerPrefs.colorTags. */
    el.editorColors.addEventListener("click", (event) => {
      const dot = event.target.closest(".r-dot[data-color]");
      if (!dot) return;
      rememberHighlightColor(dot.dataset.color);
      const item = state.items.find((entry) => entry.id === state.activeId);
      if (!item || item.color === dot.dataset.color) return;
      pushHistory();
      item.color = dot.dataset.color;
      item.updated = Date.now() / 1000;
      for (const other of $$(".r-dot", el.editorColors)) {
        other.classList.toggle("on", other === dot);
      }
      persist();
      refreshAnnotations(pagesOfItem(item));
      renderNotesList();
    });

    el.panelNotes.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-del]");
      if (remove) {
        event.stopPropagation();
        removeAnnotation(remove.dataset.del);
        return;
      }
      const card = event.target.closest(".r-card");
      if (card) focusAnnotation(card.dataset.id);
    });

    document.addEventListener("keydown", (event) => {
      const tag = (event.target.tagName || "").toLowerCase();
      if (event.key === "Escape") {
        if (state.editingId) {
          event.preventDefault();
          endTextEdit();
          return;
        }
        hideSelectionToolbar();
        hideTip();
        closeMenu();
        closeEditor();
        if (state.noteTool) {
          state.noteTool = false;
          el.noteTool.setAttribute("aria-pressed", "false");
          el.pages.classList.remove("note-mode");
        }
        return;
      }
      const typing =
        ["input", "textarea", "select"].includes(tag) || event.target.isContentEditable;
      if (typing) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey) {
        const pressed = String(event.key || "").toLowerCase();
        if (pressed === "z") {
          /* Ctrl+Shift+Z redoes, like Ctrl+Y on Windows. */
          event.preventDefault();
          if (event.shiftKey) redoAnnotation();
          else undoAnnotation();
          return;
        }
        if (pressed === "y") {
          event.preventDefault();
          redoAnnotation();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        savePdf();
        return;
      }
      if (["input", "textarea", "select"].includes(tag)) return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goToPage(state.page - 1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        goToPage(state.page + 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoom(1.15);
      } else if (event.key === "-") {
        event.preventDefault();
        zoom(1 / 1.15);
      } else if (event.key === "Home") {
        event.preventDefault();
        goToPage(1);
      } else if (event.key === "End") {
        event.preventDefault();
        goToPage(state.pages);
      }
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (state.fit) relayout(scrollAnchor());
      }, 170);
    });
  }

  // Persisted reader preferences are independent of PDF annotations.
  let readerPrefs = {};
  try { readerPrefs = JSON.parse(localStorage.getItem('babeldoc-reader') || '{}') || {}; } catch {}
  let drawingTool = 'select';
  let originalVisible = true;
  const control = (id) => document.getElementById(id);
  function storePrefs() {
    try { localStorage.setItem('babeldoc-reader', JSON.stringify(readerPrefs)); } catch {}
  }
  function cropSheet(sheet) {
    const dims = state.dims.get(sheet.no) || state.base;
    const crop = !originalVisible && dims.w > dims.h * 1.2;
    sheet.el.classList.toggle('translation-only', crop);
    sheet.el.style.width = crop ? `${sheet.width / 2}px` : '';
  }

  /* ------------------------------------------------------ icon artwork -- */
  /* Hand-drawn SF-Symbols-like glyphs: 20×20 grid, 1.5px rounded strokes. */
  const ICONS = {
    select: '<path d="M5.4 3.3v11.2l3-2.7 1.9 4.2 2.2-.9-1.9-4.2h4.1z"/>',
    text: '<path d="M4 5.3V3.7h12v1.6M10 3.7v12.2M7.4 15.9h5.2"/>',
    note: '<path d="M4.2 3.7h11.6v8.3l-3.8 3.8H4.2z"/><path d="M15.8 12h-3.8v3.8"/>',
    pen: '<path d="M13.5 3.4 16.6 6.5l-8.7 8.7-4 .9.9-4z"/><path d="m11.7 5.2 3.1 3.1"/>',
    line: '<path d="M4.4 15.6 15.6 4.4"/><circle cx="4.4" cy="15.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.6" cy="4.4" r="1.15" fill="currentColor" stroke="none"/>',
    erase: '<path d="m8.7 15.7-4.9-4.9a1.5 1.5 0 0 1 0-2.1l5.2-5.2a1.5 1.5 0 0 1 2.1 0l4 4a1.5 1.5 0 0 1 0 2.1l-6.4 6.1z"/><path d="M6.1 7.2 12.7 13.8M4 16.4h12.2"/>',
    highlighter: '<path d="M12.4 3.3 16.7 7.6 9.3 15H4.5v-4.8z"/><path d="M10.7 5 15 9.3M3.5 16.5h13"/>',
    crayon: '<path d="M7.6 15.6 4.4 12.4l6.9-8.8 3.1 3.1z"/><path d="m11.8 4.4 3.2 3.2M3.8 16.5h12.4"/>',
    hand: '<path d="M3.6 13.9c1.3-3.6 2.7-3.8 3.4-.9.7 2.9 2.1 3 3.2.5 1-2.4 2.4-2.6 3-.6.4 1.4 1.3 1.8 2.6 1.3"/>',
    handSoft: '<path d="M3.7 12.7c2.7-1.5 5.2-1.5 7.9-.4 1.7.7 3.2.6 4.7-.2"/>',
    handStrong: '<path d="M3.4 13.4c1.1-3 2.4-3.1 3.5-.5 1.1 2.7 2.4 2.8 3.5.2 1.1-2.7 2.4-2.8 3.5-.2 1.1 2.5 2.3 2.4 3.3.2"/>',
    underline: '<path d="M6.3 3.8v6.1a3.7 3.7 0 0 0 7.4 0V3.8M4.6 16.2h10.8"/>',
    pencil: '<path d="M14.1 3.6 16.4 5.9 7.4 14.9H5.1v-2.3z"/><path d="M4.2 17h6.4" stroke-dasharray="1.6 1.6"/>',
    wavy: '<path d="M3.4 10.6c1.6-2.4 3.2-2.4 4.8 0s3.2 2.4 4.8 0 3.2-2.4 4.6-.3"/>',
    font: '<path d="M3.3 15.8 7 5.2h1.2l3.7 10.6M4.9 12h6.1M14.4 15.8v-5.2M13 10.6h2.8"/>',
    paper: '<rect x="4.2" y="2.9" width="11.6" height="14.2" rx="1.7"/><path d="M7.2 6.4h5.6M7.2 9.2h5.6M7.2 12h3.2"/>',
    original: '<rect x="2.7" y="3.8" width="14.6" height="12.4" rx="1.8"/><path d="M10 3.8v12.4M17.3 6.4h-2.6M17.3 10h-2.6M17.3 13.6h-2.6"/>',
    legend: '<path d="M3.6 10.2V4.1h6.1l6.7 6.7-6.1 6.1z"/><circle cx="6.6" cy="7.1" r="1" fill="currentColor" stroke="none"/>',
    layout: '<rect x="2.6" y="3.8" width="14.8" height="12.4" rx="1.8"/><path d="M12.8 3.8v12.4"/>',
    settings: '<path d="M4 6.4h12M4 13.6h12"/><circle cx="8" cy="6.4" r="1.9" fill="currentColor" stroke="none"/><circle cx="12.8" cy="13.6" r="1.9" fill="currentColor" stroke="none"/>',
    up: '<path d="M10 15V5M6 9l4-4 4 4"/>',
    down: '<path d="M10 5v10M6 11l4 4 4-4"/>',
    copy: '<rect x="6.5" y="6.5" width="9" height="9" rx="1.6"/><path d="M4.5 12.5H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7.5a1 1 0 0 1 1 1v.5"/>',
    spark: '<path d="M10 2.6l1.55 4.25L15.8 8.4l-4.25 1.55L10 14.2 8.45 9.95 4.2 8.4l4.25-1.55z"/><path d="M15.4 13.2l.65 1.75 1.75.65-1.75.65-.65 1.75-.65-1.75-1.75-.65 1.75-.65z"/>',
    trash: '<path d="M4.5 6h11M8 6V4.2h4V6M6.2 6l.7 10h6.2l.7-10M8.6 9v4M11.4 9v4"/>',
    edit: '<path d="M13.6 3.4 16.6 6.4 7.8 15.2l-4 1 1-4z"/>',
    search: '<circle cx="8.6" cy="8.6" r="4.6"/><path d="m12.2 12.2 4 4"/>',
  };
  function icon(name, size = 19) {
    return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  /* ------------------------------------------------------ style catalogue -- */
  /* One explicit style id -> render-family table.  Every consumer (paint path,
     toolbar/editor/menu buttons, labels, remembered style) reads this table,
     so no style can accidentally fall through to a filled highlighter band and
     an unknown id always renders as a plain colour band. */
  const HIGHLIGHT_FAMILIES = {
    marker: "band",
    crayon: "crayon",
    wavy: "wavy",
    underline: "underline",
    pencil: "pencil",
    hand: "hand",
    "hand-natural": "hand",
    "hand-soft": "hand",
    "hand-strong": "hand",
  };
  const HIGHLIGHT_STYLE_LABELS = {
    marker: "荧光笔",
    crayon: "蜡笔",
    hand: "手绘下划线",
    "hand-natural": "手绘下划线 · 自然",
    "hand-soft": "手绘下划线 · 轻微",
    "hand-strong": "手绘下划线 · 明显",
    underline: "实线划线",
    pencil: "铅笔划线",
    wavy: "波浪线",
  };
  const HIGHLIGHT_STYLE_IDS = Object.keys(HIGHLIGHT_FAMILIES);
  /* The one hand button applies the remembered preset; the presets themselves
     live as chips in the annotation editor and the dock settings popover. */
  const HAND_PRESETS = ["hand-soft", "hand", "hand-strong"];
  const HAND_PRESET_LABELS = { "hand-soft": "轻微", hand: "自然", "hand-strong": "明显" };

  function highlightFamily(style) {
    return HIGHLIGHT_FAMILIES[String(style || "").toLowerCase()] || "band";
  }

  function highlightStyleLabel(style) {
    const key = String(style || "").toLowerCase();
    return HIGHLIGHT_STYLE_LABELS[key] || HIGHLIGHT_STYLE_LABELS[highlightFamily(key)] || "荧光笔";
  }

  function savedHandStyle() {
    const value = String(readerPrefs.handStyle || "");
    return HAND_PRESETS.includes(value) ? value : "hand";
  }

  function rememberHandStyle(style) {
    if (!HAND_PRESETS.includes(style) || readerPrefs.handStyle === style) return;
    readerPrefs.handStyle = style;
    storePrefs();
  }

  function handPresetOf(style) {
    const key = String(style || "").toLowerCase();
    return key === "hand-soft" || key === "hand-strong" ? key : "hand";
  }

  function savedHighlightStyle() {
    const value = String(readerPrefs.highlightStyle || "").toLowerCase();
    return HIGHLIGHT_STYLE_IDS.includes(value) ? value : "marker";
  }

  function rememberHighlightStyle(style) {
    const key = String(style || "").toLowerCase();
    if (!HIGHLIGHT_FAMILIES[key] || readerPrefs.highlightStyle === key) return;
    readerPrefs.highlightStyle = key;
    storePrefs();
  }

  /* The single "hand" entry resolves to the remembered preset at creation time;
     every other id is used verbatim. */
  function resolveHighlightStyle(style) {
    const key = String(style || "").toLowerCase();
    return key === "hand" ? savedHandStyle() : key;
  }

  /* ------------------------------------------------------ dock catalogue -- */
  const DOCK_ITEMS = {
    select: { kind: "tool", label: "选择 / 移动", icon: "select", hint: "V" },
    text: { kind: "tool", label: "页面文字", icon: "text", hint: "T" },
    note: { kind: "tool", label: "便签", icon: "note", hint: "N" },
    pen: { kind: "tool", label: "自由画", icon: "pen", hint: "P" },
    line: { kind: "tool", label: "直线", icon: "line", hint: "L" },
    erase: { kind: "tool", label: "橡皮擦：整笔删除", icon: "erase", hint: "E" },
    marker: { kind: "style", label: "荧光笔", icon: "highlighter" },
    crayon: { kind: "style", label: "蜡笔", icon: "crayon" },
    hand: { kind: "style", label: "手绘下划线", icon: "hand" },
    underline: { kind: "style", label: "实线划线", icon: "underline" },
    ink: { kind: "action", label: "墨色、粗细与不透明度", icon: "swatch" },
    font: { kind: "action", label: "字体与字号", icon: "font" },
    paper: { kind: "action", label: "纸面颜色", icon: "paper" },
    original: { kind: "action", label: "隐藏左侧原文", icon: "original" },
    legend: { kind: "action", label: "颜色标签", icon: "legend" },
    layout: { kind: "action", label: "批注显示：页面内 / 页边距", icon: "layout" },
    settings: { kind: "action", label: "自定义工具栏", icon: "settings" },
  };
  const DOCK_DEFAULT = [
    "select", "text", "note", "pen", "line", "erase", "|",
    "marker", "crayon", "hand", "underline", "|",
    "ink", "font", "paper", "original", "legend", "layout", "settings",
  ];
  /* What the three style hosts show.  One hand entry only; its three presets
     are chips in the annotation editor and the dock settings popover. */
  const HIGHLIGHT_STYLES = [
    { id: "marker", icon: "highlighter" },
    { id: "crayon", icon: "crayon" },
    { id: "hand", icon: "hand" },
    { id: "underline", icon: "underline" },
    { id: "pencil", icon: "pencil" },
    { id: "wavy", icon: "wavy" },
  ].map((entry) => ({
    ...entry,
    label: highlightStyleLabel(entry.id),
    family: highlightFamily(entry.id),
  }));
  const BUILTIN_FONTS = [
    { css: "sans-serif", label: "系统黑体" },
    { css: "serif", label: "系统宋体" },
    { css: '"KaiTi","STKaiti","楷体",serif', label: "楷体" },
    { css: '"FangSong","STFangsong","仿宋",serif', label: "仿宋" },
    { css: "monospace", label: "等宽" },
  ];

  function dockState() {
    const prefs = readerPrefs.dock && typeof readerPrefs.dock === "object" ? readerPrefs.dock : {};
    const order = Array.isArray(prefs.order)
      ? prefs.order.filter((id) => id === "|" || DOCK_ITEMS[id])
      : [...DOCK_DEFAULT];
    for (const id of DOCK_DEFAULT) if (!order.includes(id)) order.push(id);
    const hidden = Array.isArray(prefs.hidden) ? prefs.hidden.filter((id) => DOCK_ITEMS[id]) : [];
    readerPrefs.dock = { order, hidden };
    return readerPrefs.dock;
  }

  function renderDock() {
    if (!el.dock) return;
    const prefs = dockState();
    const hidden = new Set(prefs.hidden);
    const fragment = document.createDocumentFragment();
    for (const id of prefs.order) {
      if (id === "|") {
        const sep = document.createElement("span");
        sep.className = "r-dock-sep";
        sep.setAttribute("aria-hidden", "true");
        fragment.append(sep);
        continue;
      }
      if (hidden.has(id)) continue;
      const item = DOCK_ITEMS[id];
      if (!item) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "r-dock-btn";
      button.dataset.item = id;
      if (item.kind === "tool") button.dataset.tool = id;
      else if (item.kind === "style") button.dataset.style = id;
      else button.dataset.action = id;
      const title = item.hint ? `${item.label}（${item.hint}）` : item.label;
      button.title = title;
      button.setAttribute("aria-label", item.label);
      if (id === "ink") {
        button.classList.add("r-dock-swatch");
        button.innerHTML = '<span class="r-dock-dot" id="dock-ink-dot"></span>';
      } else {
        button.innerHTML = icon(item.icon);
      }
      fragment.append(button);
    }
    el.dock.replaceChildren(fragment);
    refreshDock();
  }

  function setDrawingTool(tool) {
    if (tool === "note") {
      closeEditor();
      endTextEdit();
      el.noteTool.click();
      refreshDock();
      return;
    }
    if (state.editingId) endTextEdit();
    drawingTool = tool;
    control("draw-tool").value = tool;
    if (tool === "pen" || tool === "line") {
      /* Red is the automatic ink colour; a colour picked from the popover is
         remembered and comes back here. */
      control("ink-color").value = savedInkColor();
    } else if (tool === "text") {
      control("ink-color").value = savedTextColor();
    }
    el.pages.classList.toggle("drawing", tool !== "select");
    if (tool !== "select") {
      state.noteTool = false;
      el.noteTool.setAttribute("aria-pressed", "false");
      el.pages.classList.remove("note-mode");
      window.getSelection()?.removeAllRanges();
      hideSelectionToolbar();
    }
    refreshDock();
  }

  function refreshDock() {
    if (!el.dock) return;
    const active = state.noteTool ? "note" : drawingTool;
    for (const button of el.dock.querySelectorAll("[data-tool]")) {
      const on = button.dataset.tool === active;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    const style = control("highlight-style").value || "marker";
    const styleFamily = highlightFamily(style);
    const handLabel = `手绘下划线 · ${HAND_PRESET_LABELS[savedHandStyle()]}`;
    for (const button of el.dock.querySelectorAll("[data-style]")) {
      const on = button.dataset.style === style || (button.dataset.style === "hand" && styleFamily === "hand");
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      if (button.dataset.style === "hand") {
        /* The entry is called 手绘下划线; only the tooltip names the preset. */
        button.title = handLabel;
        button.setAttribute("aria-label", "手绘下划线");
      }
    }
    for (const button of $$("button.r-style-btn[data-style]")) {
      const on = button.dataset.style === style || (button.dataset.style === "hand" && styleFamily === "hand");
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      if (button.dataset.style === "hand") {
        /* The entry is called 手绘下划线; only the tooltip names the preset. */
        button.title = handLabel;
        button.setAttribute("aria-label", "手绘下划线");
      }
    }
    const dot = control("dock-ink-dot");
    if (dot) {
      dot.style.background = control("ink-color").value;
      dot.style.opacity = String((+control("ink-opacity").value || 100) / 100);
    }
    const inkButton = el.dock.querySelector('[data-action="ink"]');
    if (inkButton) {
      const inkOn = drawingTool === "pen" || drawingTool === "line";
      inkButton.classList.toggle("on", inkOn);
      inkButton.setAttribute("aria-pressed", String(inkOn));
    }
    const paper = el.dock.querySelector('[data-action="paper"]');
    if (paper) paper.classList.toggle("on", (control("paper-theme").value || "white") !== "white");
    const original = el.dock.querySelector('[data-action="original"]');
    if (original) {
      original.setAttribute("aria-pressed", String(originalVisible));
      const title = originalVisible ? "隐藏左侧原文（适用于左右对照 PDF）" : "显示左侧原文";
      original.title = title;
      original.setAttribute("aria-label", title);
    }
    const layout = el.dock.querySelector('[data-action="layout"]');
    if (layout) {
      layout.classList.toggle("on", state.marginMode);
      layout.setAttribute("aria-pressed", String(state.marginMode));
    }
    const fontName = control("text-font").value || "sans-serif";
    const fontBtn = el.dock.querySelector('[data-action="font"]');
    if (fontBtn) fontBtn.title = `字体与字号 · ${fontLabel(fontName)}`;
  }

  function setHighlightStyle(style) {
    const key = String(style || "").toLowerCase();
    if (!HIGHLIGHT_FAMILIES[key]) return;
    const resolved = resolveHighlightStyle(key);
    control("highlight-style").value = resolved;
    rememberHighlightStyle(resolved);
    control("highlight-style").dispatchEvent(new Event("input", { bubbles: true }));
    refreshDock();
  }

  /* The 轻微 / 自然 / 明显 chips: the editor row (for an open hand highlight)
     and the dock settings row both write the remembered preset. */
  function handPresetChipsHtml() {
    return HAND_PRESETS.map(
      (id) =>
        `<button type="button" class="r-hand-chip${savedHandStyle() === id ? " on" : ""}" ` +
        `data-hand-preset="${id}" title="${HAND_PRESET_LABELS[id]}" ` +
        `aria-label="${HAND_PRESET_LABELS[id]}" ` +
        `aria-pressed="${savedHandStyle() === id}">${HAND_PRESET_LABELS[id]}</button>`
    ).join("");
  }

  function syncHandPresetChips(item) {
    const row = el.editorStyles ? el.editorStyles.querySelector("#editor-hand-presets") : null;
    if (!row) return;
    const target = item || state.items.find((entry) => entry.id === state.activeId) || null;
    const show = Boolean(target && target.type === "highlight" && highlightFamily(target.style) === "hand");
    row.hidden = !show;
    if (!show) return;
    const preset = handPresetOf(target.style);
    for (const chip of row.querySelectorAll("[data-hand-preset]")) {
      const on = chip.dataset.handPreset === preset;
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", String(on));
    }
  }

  function syncHandSettingsRow() {
    const row = document.getElementById("pop-hand-style");
    if (!row) return;
    for (const chip of row.querySelectorAll("[data-hand-preset]")) {
      const on = chip.dataset.handPreset === savedHandStyle();
      chip.classList.toggle("on", on);
      chip.setAttribute("aria-pressed", String(on));
    }
  }

  /* Choosing a preset restyles the open hand highlight (when there is one) and
     remembers the preset for the next hand mark. */
  function applyHandPreset(preset) {
    if (!HAND_PRESETS.includes(preset)) return;
    rememberHandStyle(preset);
    const item = state.items.find((entry) => entry.id === state.activeId);
    if (item && item.type === "highlight" && highlightFamily(item.style) === "hand") {
      if (item.style !== preset) {
        pushHistory();
        item.style = preset;
        control("highlight-style").value = preset;
        rememberHighlightStyle(preset);
        commitDrawing(item);
      }
    } else if (highlightFamily(control("highlight-style").value) === "hand") {
      control("highlight-style").value = preset;
      rememberHighlightStyle(preset);
    }
    syncHandPresetChips(item);
    syncHandSettingsRow();
    refreshDock();
  }

  function applyMarginMode(enabled) {
    state.marginMode = Boolean(enabled);
    readerPrefs.marginNotes = state.marginMode;
    storePrefs();
    document.body.classList.toggle("margin-notes", state.marginMode);
    syncMarginColumns();
    if (!state.marginMode) {
      /* Off-screen pages are not repainted, so clear their rails here. */
      for (const sheet of state.sheets) {
        removeMarginLayer(sheet, "left");
        removeMarginLayer(sheet, "right");
      }
    }
    if (state.fit) relayout(scrollAnchor());
    else refreshAnnotations();
    refreshDock();
  }

  function toggleMarginMode() {
    applyMarginMode(!state.marginMode);
    toast(state.marginMode ? "批注显示在页边距" : "批注显示在页面内", "good");
  }

  function drawingOptions() {
    return {
      inkColor: control("ink-color").value,
      width: clamp(+control("ink-width").value || 2, 0.5, 30),
      opacity: +control("ink-opacity").value / 100,
      fontFamily: control("text-font").value || "sans-serif",
      fontSize: clamp(+control("text-size").value || 18, 8, 96),
    };
  }

  function loadDrawingControls(item) {
    if (item.type === "highlight") control("highlight-style").value = item.style || "marker";
    if (item.type === "ink") {
      control("ink-color").value = item.inkColor || DEFAULT_INK;
      control("ink-width").value = item.width || 2;
      control("ink-opacity").value = (item.opacity ?? 1) * 100;
    } else if (item.type === "text") {
      /* Page text stays dark unless its own colour was chosen. */
      control("ink-color").value = item.inkColor || LEGACY_INK;
      control("ink-width").value = item.width || 2;
      control("ink-opacity").value = (item.opacity ?? 1) * 100;
      control("text-size").value = item.fontSize || 18;
      control("text-font").value = item.fontFamily || "sans-serif";
    }
    refreshDock();
  }

  function commitDrawing(item, before) {
    /* Gestures and style edits pass the pre-change snapshot; a brand new
       annotation has already recorded its history in addAnnotation. */
    if (before) pushHistory(before);
    item.updated = Date.now() / 1000;
    reindex();
    refreshAnnotations([item.page]);
    renderNotesList();
    persist();
  }

  /* ----------------------------------------------------------- fonts -- */
  const FONTS = { list: [], byCss: new Map(), ready: false };
  async function loadFonts() {
    try {
      const data = await api("/api/fonts");
      const list = Array.isArray(data.fonts) ? data.fonts.filter((f) => f && f.css) : [];
      if (!list.length) return;
      FONTS.list = list;
      FONTS.byCss = new Map(list.map((font) => [font.css, font]));
      let sheet = document.getElementById("bdf-fonts");
      if (!sheet) {
        sheet = document.createElement("style");
        sheet.id = "bdf-fonts";
        document.head.append(sheet);
      }
      sheet.textContent = list
        .map(
          (font) =>
            `@font-face{font-family:"${font.css}";src:url("/api/font-file/${encodeURIComponent(
              font.id
            )}");font-display:swap}`
        )
        .join("\n");
      FONTS.ready = true;
      refreshAnnotations();
      updateTextbar();
      if (el.pop && !el.pop.hidden && el.pop.dataset.kind === "font") renderFontPopover();
    } catch {
      /* an older server simply has no font registry */
    }
  }
  function fontStack(value) {
    const css = String(value || "sans-serif");
    if (["sans-serif", "serif", "monospace", "cursive"].includes(css)) return css;
    if (FONTS.byCss.has(css)) return `"${css}", "PingFang SC", "Microsoft YaHei", sans-serif`;
    return css;
  }
  function fontLabel(value) {
    const font = FONTS.byCss.get(value);
    if (font) return font.label || font.family || value;
    const builtin = BUILTIN_FONTS.find((item) => item.css === value);
    return builtin ? builtin.label : value;
  }
  function applyTextStyle(node, item) {
    node.style.color = item.inkColor || "#1d1d1f";
    node.style.fontFamily = fontStack(item.fontFamily || "sans-serif");
    node.style.fontSize = `${(item.fontSize || 18) * state.scale}px`;
    node.style.opacity = String(item.opacity ?? 1);
  }

  /* ------------------------------------------------------ text editing -- */
  function textNode(id) {
    return document.querySelector(`.r-page-text[data-id="${id}"]`);
  }

  /* Editing a text item shows a light frame with a move grip and a resize
     grip.  Both write straight to PDF units, so the position/size survives
     zoom and a reload. */
  let textFrame = null;
  function hideTextFrame() {
    if (textFrame) textFrame.remove();
    textFrame = null;
  }
  function positionTextFrame(id) {
    if (!textFrame || textFrame.dataset.id !== id) return;
    const node = textNode(id);
    if (!node) return;
    textFrame.style.left = `${node.offsetLeft}px`;
    textFrame.style.top = `${node.offsetTop}px`;
    textFrame.style.width = `${node.offsetWidth}px`;
    textFrame.style.height = `${node.offsetHeight}px`;
  }
  function showTextFrame(item) {
    hideTextFrame();
    const sheet = state.sheets[item.page - 1];
    if (!sheet) return;
    const frame = document.createElement("div");
    frame.className = "r-text-frame";
    frame.dataset.id = item.id;
    frame.innerHTML =
      '<button class="r-text-move" type="button" title="拖动移动文字" aria-label="拖动移动文字"></button>' +
      '<button class="r-text-resize" type="button" title="拖动调整文字大小" aria-label="拖动调整文字大小"></button>';
    sheet.anno.append(frame);
    textFrame = frame;
    positionTextFrame(item.id);
    const node = textNode(item.id);
    if (!node) return;
    const move = frame.querySelector(".r-text-move");
    const resize = frame.querySelector(".r-text-resize");
    for (const button of [move, resize]) {
      button.addEventListener("mousedown", (event) => event.preventDefault());
    }

    move.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { ...item.point };
      move.setPointerCapture(event.pointerId);
      const onMove = (e) => {
        item.point = {
          x: clamp(origin.x + (e.clientX - startX) / state.scale, 0, sheet.width / state.scale - 8),
          y: clamp(origin.y + (e.clientY - startY) / state.scale, 0, sheet.height / state.scale - 8),
        };
        node.style.left = `${item.point.x * state.scale}px`;
        node.style.top = `${item.point.y * state.scale}px`;
        positionTextFrame(item.id);
      };
      const onUp = () => {
        move.removeEventListener("pointermove", onMove);
        move.removeEventListener("pointerup", onUp);
        move.removeEventListener("pointercancel", onUp);
        item.updated = Date.now() / 1000;
        persist();
      };
      move.addEventListener("pointermove", onMove);
      move.addEventListener("pointerup", onUp);
      move.addEventListener("pointercancel", onUp);
    });

    resize.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startY = event.clientY;
      const startSize = item.fontSize || 18;
      resize.setPointerCapture(event.pointerId);
      const onMove = (e) => {
        const delta = (e.clientY - startY) / state.scale;
        const next = clamp(Math.round(startSize + delta * 0.62), 8, 96);
        if (next === item.fontSize) return;
        item.fontSize = next;
        node.style.fontSize = `${next * state.scale}px`;
        positionTextFrame(item.id);
        updateTextbar();
      };
      const onUp = () => {
        resize.removeEventListener("pointermove", onMove);
        resize.removeEventListener("pointerup", onUp);
        resize.removeEventListener("pointercancel", onUp);
        item.updated = Date.now() / 1000;
        persist();
      };
      resize.addEventListener("pointermove", onMove);
      resize.addEventListener("pointerup", onUp);
      resize.addEventListener("pointercancel", onUp);
    });
  }
  function beginTextEdit(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || item.type !== "text") return;
    if (state.editingId === id) {
      focusText(id);
      return;
    }
    closeEditor(true);
    hideSelectionToolbar();
    if (state.editingId) endTextEdit();
    textEditHistory = historySnapshot();
    state.activeId = id;
    /* Render the plain version first, then flip the node itself into edit
       mode: re-rendering afterwards would drop the caret. */
    state.editingId = null;
    refreshAnnotations([item.page]);
    state.editingId = id;
    const node = textNode(id);
    if (!node) return;
    node.classList.add("editing");
    node.contentEditable = "plaintext-only";
    node.spellcheck = false;
    node.textContent = item.comment || "";
    updateTextbar();
    showTextFrame(item);
    requestAnimationFrame(() => focusText(id));
  }
  function focusText(id) {
    const node = textNode(id);
    if (!node) return;
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function endTextEdit() {
    if (!state.editingId) return;
    const id = state.editingId;
    const before = textEditHistory;
    textEditHistory = null;
    const item = state.items.find((entry) => entry.id === id);
    const node = textNode(id);
    if (item && node) {
      item.comment = node.innerText.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trimEnd();
      item.updated = Date.now() / 1000;
    }
    hideTextFrame();
    state.editingId = null;
    state.activeId = null;
    document.body.classList.remove("editing-text");
    updateTextbar();
    if (marginRelayoutPending) {
      marginRelayoutPending = false;
      queueMarginRelayout();
    }
    if (!item) return;
    if (!item.comment.trim()) {
      /* Clearing an older text box is undoable; cancelling a brand new empty
         one is not worth a history entry. */
      const existed =
        before &&
        before.items.some((entry) => entry.id === id && String(entry.comment || "").trim());
      if (existed) pushHistory(before);
      removeAnnotation(id, false);
      return;
    }
    if (before && !historyItemsEqual(before.items, state.items)) pushHistory(before);
    reindex();
    if (!refreshMarginColumns()) refreshAnnotations([item.page]);
    renderNotesList();
    persist();
  }
  function updateTextbar() {
    if (!el.textbar) return;
    const item = state.items.find((entry) => entry.id === state.activeId);
    const on = Boolean(state.editingId) && Boolean(item) && item.type === "text";
    el.textbar.hidden = !on;
    document.body.classList.toggle("editing-text", on);
    if (!on) return;
    for (const dot of $$("#textbar-colors .r-tdot[data-text-color]")) {
      dot.classList.toggle(
        "on",
        String(item.inkColor || "#1d1d1f").toLowerCase() === dot.dataset.textColor.toLowerCase()
      );
    }
    el.textbarFontName.textContent = fontLabel(item.fontFamily || "sans-serif");
    el.textbarSize.textContent = String(Math.round(item.fontSize || 18));
    el.textbarFont.title = `选择字体 · ${fontLabel(item.fontFamily || "sans-serif")}`;
  }
  function styleTextItem(patch) {
    const item = state.items.find((entry) => entry.id === state.activeId);
    if (!item || item.type !== "text") return;
    Object.assign(item, patch);
    item.updated = Date.now() / 1000;
    const node = textNode(item.id);
    if (node) applyTextStyle(node, item);
    positionTextFrame(item.id);
    updateTextbar();
    persist();
  }

  function renderTextItem(item, sheet) {
    const node = document.createElement("div");
    node.className = "r-page-text";
    node.dataset.id = item.id;
    node.textContent = item.comment || "";
    if (!item.comment) node.dataset.placeholder = "输入文字";
    node.style.left = `${item.point.x * state.scale}px`;
    node.style.top = `${item.point.y * state.scale}px`;
    applyTextStyle(node, item);
    if (state.editingId === item.id) {
      node.classList.add("editing");
      node.contentEditable = "plaintext-only";
      node.spellcheck = false;
    } else {
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        beginTextEdit(item.id);
      });
      bindMovable(node, item, sheet);
    }
    return node;
  }

  function renderDrawing(item, sheet) {
    const scale = state.scale;
    if (item.type === "text") return renderTextItem(item, sheet);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("r-ink");
    svg.setAttribute("width", sheet.width);
    svg.setAttribute("height", sheet.height);
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.dataset.id = item.id;
    path.setAttribute(
      "d",
      (item.points || []).map((p, i) => `${i ? "L" : "M"}${p.x * scale},${p.y * scale}`).join(" ")
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", item.inkColor || DEFAULT_INK);
    path.setAttribute("stroke-width", (item.width || 2) * scale);
    path.setAttribute("stroke-opacity", item.opacity ?? 1);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.addEventListener("click", (event) => {
      event.stopPropagation();
      if (drawingTool === "select" && !state.editingId) openEditor(item.id, event);
    });
    svg.append(path);
    return svg;
  }

  function bindMovable(node, item, sheet) {
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || drawingTool !== "select" || state.noteTool) return;
      if (state.editingId === item.id) return;
      event.stopPropagation();
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY };
      const point = { ...item.point };
      /* Snapshot before the drag: the commit only records one undo step. */
      const historyBefore = historySnapshot();
      let moved = false;
      node.setPointerCapture(event.pointerId);
      const move = (e) => {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4 && !moved) return;
        moved = true;
        hideTip();
        item.point = {
          x: clamp(point.x + (e.clientX - start.x) / state.scale, 0, sheet.width / state.scale - 8),
          y: clamp(point.y + (e.clientY - start.y) / state.scale, 0, sheet.height / state.scale - 8),
        };
        node.style.left = `${item.point.x * state.scale}px`;
        node.style.top = `${item.point.y * state.scale}px`;
      };
      const end = (e) => {
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", end);
        node.removeEventListener("pointercancel", end);
        if (e.type === "pointercancel") {
          item.point = point;
          refreshAnnotations([item.page]);
          return;
        }
        if (moved) {
          node.addEventListener("click", (e) => { e.stopImmediatePropagation(); e.preventDefault(); }, { once: true, capture: true });
          commitDrawing(item, historyBefore);
        }
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", end);
      node.addEventListener("pointercancel", end);
    });
  }

  /* ----------------------------------------------------- margin cards -- */
  function itemAnchorY(item, sheet) {
    if (item.type === "highlight") {
      const bands = bandsFor(item, sheet);
      if (bands && bands.length) return bands[0].y;
    }
    return (item.point && item.point.y) || 0;
  }

  /* Where the connector should touch the page: the end of the highlighted
     sentence for a highlight, the marker / text origin for the rest. */
  function itemAnchor(item, sheet) {
    if (item.type === "highlight") {
      const bands = bandsFor(item, sheet);
      if (bands && bands.length) {
        const band = bands[0];
        return { x: band.x + band.w, y: band.y + band.h / 2 };
      }
    }
    const point = item.point || { x: 0, y: 0 };
    if (item.type === "text") {
      /* Start after the text, not on top of its first glyph. */
      const node = textNode(item.id);
      const width = node ? node.offsetWidth / state.scale : 0;
      return { x: point.x + width, y: point.y + (item.fontSize || 18) * 0.55 };
    }
    return { x: point.x, y: point.y };
  }

  /* A "card" is any annotation with narrative text.  It belongs to the rail on
     the side of the page its anchor sits on, so a note about the left column no
     longer points across the whole spread. */
  function hasMarginCard(item) {
    return Boolean(
      (item.comment && item.comment.trim()) || item.type === "note" || item.type === "text"
    );
  }

  /* Stored geometry is enough to decide the side (live bands are not available
     for pages that have not been painted yet). */
  function itemSideX(item) {
    if (item.type === "highlight") {
      const rects = (item.rects || []).filter((rect) => Number(rect.w) > 0);
      if (rects.length) {
        const first = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x)[0];
        return first.x + first.w / 2;
      }
    }
    return (item.point && item.point.x) || 0;
  }

  function marginSideOf(item) {
    const page = item.page || 1;
    const dims = state.dims.get(page) || state.base;
    /* With the original half hidden the left column is off screen; keep the
       pre-round-2 behaviour and use the right rail for everything. */
    if (!originalVisible && dims.w > dims.h * 1.2) return "right";
    return itemSideX(item) < dims.w / 2 ? "left" : "right";
  }

  /* The left rail only exists while a left-side card does, and the page has to
     give that gutter back before the zoom is computed.  One function owns the
     body class and the state flag so every mutation path stays consistent. */
  function syncMarginColumns() {
    const left = Boolean(
      state.marginMode &&
        state.items.some((item) => hasMarginCard(item) && marginSideOf(item) === "left")
    );
    const changed = left !== Boolean(state.marginLeft);
    state.marginLeft = left;
    document.body.classList.toggle("margin-left", left);
    return changed;
  }

  /* A change of rail means a change of effective page width; the repaint is
     deferred a frame so the caller can finish creating an annotation (and open
     its editor) before pages are reset.  While page text is being edited the
     repaint would recreate the contenteditable and drop the caret, so it waits
     until the edit is committed. */
  let marginRelayoutTimer = 0;
  let marginRelayoutPending = false;
  function queueMarginRelayout() {
    if (!state.fit) return;
    window.clearTimeout(marginRelayoutTimer);
    marginRelayoutTimer = window.setTimeout(() => {
      marginRelayoutTimer = 0;
      if (state.editingId) {
        marginRelayoutPending = true;
        return;
      }
      relayout(scrollAnchor());
    }, 40);
  }

  function refreshMarginColumns() {
    if (!syncMarginColumns()) return false;
    queueMarginRelayout();
    return true;
  }

  function marginLayer(sheet, side) {
    const cls = side === "left" ? "r-margin-left" : "r-margin-right";
    let layer = sheet.el.querySelector(`:scope > .${cls}`);
    if (!layer) {
      layer = document.createElement("div");
      layer.className = `r-margin ${cls}`;
      sheet.el.append(layer);
    }
    return layer;
  }

  function removeMarginLayer(sheet, side) {
    const cls = side === "left" ? "r-margin-left" : "r-margin-right";
    const layer = sheet.el.querySelector(`:scope > .${cls}`);
    if (layer) layer.remove();
  }

  function renderMarginCards(sheet) {
    if (!state.marginMode) {
      removeMarginLayer(sheet, "left");
      removeMarginLayer(sheet, "right");
      return;
    }
    const items = (state.byPage.get(sheet.no) || []).filter(hasMarginCard);
    if (!items.length) {
      removeMarginLayer(sheet, "left");
      removeMarginLayer(sheet, "right");
      return;
    }
    const sides = { left: [], right: [] };
    for (const item of items) sides[marginSideOf(item)].push(item);
    for (const side of ["left", "right"]) {
      if (!sides[side].length) {
        removeMarginLayer(sheet, side);
        continue;
      }
      placeMarginCards(sheet, marginLayer(sheet, side), side, sides[side]);
    }
  }

  /* Left-side cards connect from the start of the first annotated line, so the
     leader never crosses the highlighted sentence itself. */
  function leftAnchor(item, sheet) {
    if (item.type === "highlight") {
      const bands = bandsFor(item, sheet);
      if (bands && bands.length) return { x: bands[0].x, y: bands[0].y + bands[0].h / 2 };
    }
    return itemAnchor(item, sheet);
  }

  /* Leader lanes inside the 18px rail gutter, ordered from the card edge (15)
     back to the page edge (3).  Cards are laid out top to bottom, so a leader
     whose anchor is higher always gets a lane closer to the card: the parallel
     runs stay apart and never have to cross each other. */
  const MLINK_CHANNELS = [15, 12, 9, 6, 3];
  const MLINK_CORNER = 6;

  /* Orthogonal polyline with rounded corners.  Every interior vertex becomes a
     quadratic turn whose radius is clamped to half of the shorter neighbour, so
     an almost straight pair of turns still yields a valid path (only a
     byte-identical duplicate vertex is dropped). */
  function roundedLeaderPath(points, radius) {
    const pts = [];
    for (const point of points) {
      const last = pts[pts.length - 1];
      if (last && last.x === point.x && last.y === point.y) continue;
      pts.push(point);
    }
    const round = (value) => Math.round(value * 100) / 100;
    let d = `M${round(pts[0].x)} ${round(pts[0].y)}`;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = pts[i - 1];
      const cur = pts[i];
      const next = pts[i + 1];
      const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
      const r = Math.min(radius, inLen / 2, outLen / 2);
      const beforeX = cur.x + ((prev.x - cur.x) / inLen) * r;
      const beforeY = cur.y + ((prev.y - cur.y) / inLen) * r;
      const afterX = cur.x + ((next.x - cur.x) / outLen) * r;
      const afterY = cur.y + ((next.y - cur.y) / outLen) * r;
      d += ` L${round(beforeX)} ${round(beforeY)} Q${round(cur.x)} ${round(cur.y)} ${round(
        afterX
      )} ${round(afterY)}`;
    }
    const end = pts[pts.length - 1];
    d += ` L${round(end.x)} ${round(end.y)}`;
    return d;
  }

  function placeMarginCards(sheet, layer, side, items) {
    layer.replaceChildren();
    const mirror = side === "left";
    const scale = state.scale;
    const pageWidth = sheet.width;
    const layerWidth = layer.offsetWidth || 238;
    const sorted = items.slice().sort((a, b) => itemAnchorY(a, sheet) - itemAnchorY(b, sheet));
    /* One distinct gutter lane per leader, following the sorted (top to bottom)
       card order; the offsets repeat when there are more leaders than lanes. */
    const lanes = new Map();
    sorted.forEach((item, index) => {
      lanes.set(item, MLINK_CHANNELS[index % MLINK_CHANNELS.length]);
    });
    let bottom = -Infinity;
    for (const item of sorted) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "r-mcard";
      card.dataset.id = item.id;
      card.style.setProperty("--mc", COLOR_HEX[item.color] || COLOR_HEX.yellow);
      const top = Math.max(itemAnchorY(item, sheet) * scale - 10, bottom + 8, 2);
      card.style.top = `${top}px`;
      const kindLabel = { highlight: "高亮", note: "便签", text: "文字", ink: "画笔" }[item.type] || "批注";
      const styleLabel =
        item.type === "highlight" ? ` · ${highlightStyleLabel(item.style)}` : "";
      card.innerHTML =
        `<span class="r-mcard-top"><span class="r-dotview" style="background:${
          COLOR_HEX[item.color] || COLOR_HEX.yellow
        }"></span>第 ${item.page} 页 · ${kindLabel}${styleLabel}</span>` +
        (item.text ? `<p class="r-mcard-quote">${escapeHtml(item.text.slice(0, 120))}</p>` : "") +
        (item.comment ? `<p class="r-mcard-note">${escapeHtml(item.comment.slice(0, 260))}</p>` : "");
      card.addEventListener("click", () => focusAnnotation(item.id));
      layer.append(card);

      /* Leader from the sentence to its card: a horizontal exit at the anchor's
         own y, a vertical run inside the 18px gutter (one lane per card, so the
         parallel runs cannot overlap) and a horizontal run into the card's
         connection point.  Corners are rounded; the left rail mirrors the right
         one: the dot sits on the annotation, the line ends at the card. */
      const anchor = mirror ? leftAnchor(item, sheet) : itemAnchor(item, sheet);
      const x1 = anchor.x * scale;
      const y1 = anchor.y * scale;
      const y2 = top + 17;
      /* Convert page coordinates into the rail's own coordinate space: the
         right rail starts at the page's right edge, the left rail at the
         sheet's left edge minus its width.  In translation-only mode the page
         is shifted left by half its width, which the right formula already
         absorbs; left cards are never used in that mode. */
      const x1Local = mirror ? x1 + layerWidth : x1 - pageWidth;
      const x2Local = mirror ? layerWidth - 18 : 18;
      /* Local x of the vertical lane: [0, 18) is the gutter on the right rail,
         mirrored around the rail width on the left one, so a lane is always
         between the page edge and the cards. */
      const laneX = mirror ? layerWidth - lanes.get(item) : lanes.get(item);
      const corners = [
        { x: x1Local, y: y1 },
        { x: laneX, y: y1 },
        { x: laneX, y: y2 },
        { x: x2Local, y: y2 },
      ];
      const xs = corners.map((point) => point.x);
      const ys = corners.map((point) => point.y);
      const boxLeft = Math.min(...xs);
      const boxTop = Math.min(...ys);
      const width = Math.max(2, Math.max(...xs) - boxLeft);
      const height = Math.max(2, Math.max(...ys) - boxTop);
      const link = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      link.classList.add("r-mlink");
      link.setAttribute("width", String(width));
      link.setAttribute("height", String(height));
      link.style.left = `${boxLeft}px`;
      link.style.top = `${boxTop}px`;
      const local = corners.map((point) => ({ x: point.x - boxLeft, y: point.y - boxTop }));
      /* The first turn must not round back over the page edge, so its radius is
         capped by the lane's distance from the page (3px for the last lane). */
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        roundedLeaderPath(local, Math.min(MLINK_CORNER, lanes.get(item)))
      );
      path.setAttribute("stroke", COLOR_HEX[item.color] || COLOR_HEX.yellow);
      link.append(path);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(local[0].x));
      dot.setAttribute("cy", String(local[0].y));
      dot.setAttribute("r", "2.8");
      dot.setAttribute("fill", COLOR_HEX[item.color] || COLOR_HEX.yellow);
      link.append(dot);
      layer.append(link);
      card.addEventListener("pointerenter", () => link.classList.add("on"));
      card.addEventListener("pointerleave", () => link.classList.remove("on"));

      bottom = top + card.offsetHeight + 6;
    }
  }

  /* --------------------------------------------------- sidebar resize -- */
  /* The top bar has a toggle, but the sidebar itself also needs an obvious way
     out: a slim handle on its right edge collapses it, and a floating tab at
     the stage's left edge brings it back.  Both drive this one function so the
     top-bar button, the handle and the stored preference never disagree. */
  function setSidebarCollapsed(hidden, remember = true) {
    const value = Boolean(hidden);
    el.sidebar.hidden = value;
    document.body.classList.toggle("side-collapsed", value);
    if (el.sidebarBtn) {
      el.sidebarBtn.setAttribute("aria-pressed", String(!value));
      el.sidebarBtn.title = value ? "显示侧栏" : "隐藏侧栏";
    }
    if (el.sideHandle) el.sideHandle.setAttribute("aria-expanded", String(!value));
    if (el.sideExpand) el.sideExpand.hidden = !value;
    if (remember) {
      readerPrefs.sidebarHidden = value;
      storePrefs();
    }
    if (state.fit && state.sheets.length) {
      window.setTimeout(() => relayout(scrollAnchor()), 30);
    }
  }

  function setupSidebarResize() {
    const width = clamp(Number(readerPrefs.sidebarWidth) || 178, 160, 440);
    el.sidebar.style.width = `${width}px`;
    if (el.sideHandle) el.sideHandle.addEventListener("click", () => setSidebarCollapsed(true));
    if (el.sideExpand) el.sideExpand.addEventListener("click", () => setSidebarCollapsed(false));
    setSidebarCollapsed(readerPrefs.sidebarHidden === true, false);
    const handle = el.sideResize;
    if (!handle) return;
    let startX = 0;
    let startWidth = 0;
    let dragging = false;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = el.sidebar.offsetWidth;
      handle.classList.add("dragging");
      document.body.classList.add("side-dragging");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      el.sidebar.style.width = `${clamp(startWidth + event.clientX - startX, 160, 440)}px`;
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.classList.remove("side-dragging");
      readerPrefs.sidebarWidth = el.sidebar.offsetWidth;
      storePrefs();
      if (state.fit) relayout(scrollAnchor());
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("dblclick", () => {
      el.sidebar.style.width = "178px";
      readerPrefs.sidebarWidth = 178;
      storePrefs();
      if (state.fit) relayout(scrollAnchor());
    });
  }

  /* ------------------------------------------------------ stale server -- */
  let serverBuild = 0;
  function showStaleBanner() {
    state.serverStale = true;
    if (!el.banner) return;
    if (localStorage.getItem("babeldoc-reader-banner") === "off") return;
    el.banner.hidden = false;
  }
  function pollRestart() {
    let tries = 0;
    const baseline = serverBuild;
    const tick = async () => {
      tries += 1;
      try {
        const health = await api("/api/health");
        if (health && health.ok) {
          /* The restarted process recomputes BUILD_ID from the source on disk,
             so a different build means the new code is really serving. */
          if (!baseline || Number(health.build) !== baseline || tries >= 3) {
            window.location.reload();
            return;
          }
        }
      } catch {
        /* the server is still down while it restarts */
      }
      if (tries < 40) window.setTimeout(tick, 700);
      else toast("重启超时，请关闭应用窗口后重新打开", "bad");
    };
    window.setTimeout(tick, 900);
  }

  /* ------------------------------------------------------ reader tools -- */
  function setupReaderTools() {
    dockState();
    state.marginMode = readerPrefs.marginNotes === true;
    document.body.classList.toggle("margin-notes", state.marginMode);
    state.colorFilter = new Set(Array.isArray(readerPrefs.colorFilter) ? readerPrefs.colorFilter : []);

    /* Restore the remembered ink colour; red is the automatic default. */
    control("ink-color").value = savedInkColor();

    window.addEventListener("beforeunload", (event) => {
      const active = state.items.find((item) => item.id === state.activeId);
      if (
        savedRevision !== saveRevision ||
        (active && el.editorText.value.trim() !== (active.comment || "")) ||
        state.editingId
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    });

    renderDock();
    renderStyleButtons();
    setupSidebarResize();

    el.panelNotes.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-filter]");
      if (!chip) return;
      event.stopPropagation();
      const value = chip.dataset.filter;
      if (value === "all") state.colorFilter.clear();
      else if (state.colorFilter.has(value)) state.colorFilter.delete(value);
      else state.colorFilter.add(value);
      readerPrefs.colorFilter = [...state.colorFilter];
      storePrefs();
      renderNotesList();
    });

    /* ------------------------------------------------------------ paper -- */
    const themes = {
      white: "#ffffff",
      cream: "#f3ecda",
      sage: "#e4eddf",
      blue: "#e4ecf3",
      rose: "#f3e6e4",
      ink: "#e8e8e2",
    };
    function applyPaper() {
      const theme = control("paper-theme").value;
      document.body.dataset.paper = theme;
      document.body.style.setProperty("--paper-color", themes[theme] || control("paper-color").value);
      readerPrefs.paper = theme;
      readerPrefs.paperColor = control("paper-color").value;
      storePrefs();
      refreshDock();
    }
    control("paper-theme").value = readerPrefs.paper || "white";
    control("paper-color").value = readerPrefs.paperColor || "#f3ecda";
    /* Restore the last highlight style so a colour-dot highlight after a reload
       keeps the style the reader chose (hand preset included). */
    control("highlight-style").value = savedHighlightStyle();
    control("paper-theme").onchange = applyPaper;
    control("paper-color").oninput = () => {
      control("paper-theme").value = "custom";
      applyPaper();
    };
    applyPaper();

    function toggleOriginal() {
      if (!state.pdf || state.base.w <= state.base.h * 1.2) {
        toast("此开关适用于原文在左、译文在右的左右对照 PDF");
        return;
      }
      originalVisible = !originalVisible;
      clearSync();
      closeEditor();
      endTextEdit();
      hideSelectionToolbar();
      relayout(scrollAnchor());
      refreshDock();
    }

    /* ----------------------------------------------------- colour tags -- */
    control("color-hints").checked = readerPrefs.hints !== false;
    function updateHints() {
      const on = control("color-hints").checked;
      document
        .querySelectorAll(".r-dot[data-color], [data-menu-color], .r-filter-chip[data-filter]")
        .forEach((node) => {
          const value = node.dataset.color || node.dataset.menuColor || node.dataset.filter;
          const color = colorValue(value);
          if (!color) return;
          const base = colorName(color);
          const semantic = tagName(color);
          const showHint = on && base && semantic && base !== semantic;
          const label = on && showHint ? `${base} · ${semantic}` : base || semantic;
          node.title = label;
          node.setAttribute("aria-label", label);
          if (showHint) node.dataset.hint = semantic;
          else delete node.dataset.hint;
        });
      readerPrefs.hints = on;
      storePrefs();
    }
    control("color-hints").onchange = updateHints;
    /* The toolbar / editor dot rows are containers: render them from the tags. */
    renderColorDots();
    updateHints();

    /* ------------------------------------------------------- controls -- */
    function applyControlChange(id) {
      if (id === "ink-color") {
        /* Remember the pick per surface: ink strokes and page text each keep
           their own last colour. */
        const editing = state.items.find((entry) => entry.id === state.activeId);
        const slot =
          drawingTool === "text" || (editing && editing.type === "text")
            ? "textColor"
            : "inkColor";
        readerPrefs[slot] = control("ink-color").value.toLowerCase();
        storePrefs();
      }
      if (id === "highlight-style") rememberHighlightStyle(control("highlight-style").value);
      refreshDock();
      const item = state.items.find((entry) => entry.id === state.activeId);
      if (!item) {
        if (id === "highlight-style") syncHandPresetChips(null);
        return;
      }
      if (item.type === "highlight") {
        const style = control("highlight-style").value;
        if (item.style === style) return;
        pushHistory();
        item.style = style;
        commitDrawing(item);
        syncHandPresetChips(item);
        return;
      }
      if (!["text", "ink"].includes(item.type)) return;
      /* Text edits take one property at a time: assigning every drawing option
         would reset the text colour from the ink swatch. */
      if (item.type === "text" && state.editingId === item.id) {
        if (id === "text-font") item.fontFamily = control("text-font").value;
        else if (id === "text-size") item.fontSize = clamp(+control("text-size").value || 18, 8, 96);
        else if (id === "ink-color") item.inkColor = control("ink-color").value;
        else if (id === "ink-opacity") item.opacity = +control("ink-opacity").value / 100;
        else if (id === "ink-width") item.width = clamp(+control("ink-width").value || 2, 0.5, 30);
        const node = textNode(item.id);
        if (node) applyTextStyle(node, item);
        positionTextFrame(item.id);
        item.updated = Date.now() / 1000;
        updateTextbar();
        persist();
        return;
      }
      const patch = drawingOptions();
      const changed = Object.keys(patch).some((key) => item[key] !== patch[key]);
      if (!changed) return;
      pushHistory();
      Object.assign(item, patch);
      commitDrawing(item);
    }
    for (const id of ["ink-color", "ink-width", "ink-opacity", "text-font", "text-size", "highlight-style"]) {
      control(id).addEventListener("input", () => applyControlChange(id));
    }
    control("draw-tool").onchange = () => {
      closeEditor();
      setDrawingTool(control("draw-tool").value);
    };
    el.noteTool.addEventListener("click", refreshDock);

    /* ------------------------------------------------------ text bar -- */
    setupTextbar();

    /* ------------------------------------------------------ popovers -- */
    let popAnchor = null;
    function closePopover() {
      if (!el.pop || el.pop.hidden) return;
      el.pop.hidden = true;
      delete el.pop.dataset.kind;
      if (popAnchor) popAnchor.setAttribute("aria-expanded", "false");
      popAnchor = null;
    }
    function positionPopover(anchor) {
      const rect = anchor.getBoundingClientRect();
      const box = el.pop.getBoundingClientRect();
      let left = rect.left + rect.width / 2 - box.width / 2;
      let top = rect.top - box.height - 12;
      if (top < 12) top = rect.bottom + 12;
      left = clamp(left, 12, Math.max(12, window.innerWidth - box.width - 12));
      top = clamp(top, 12, Math.max(12, window.innerHeight - box.height - 12));
      el.pop.style.left = `${left}px`;
      el.pop.style.top = `${top}px`;
    }
    /* Popover content can grow while it is open (a tag is added, a long list
       finishes rendering).  Growing downwards is positioned from the top, so the
       box would start covering the dock button that toggles it — re-anchor it
       whenever its size changes. */
    if (typeof ResizeObserver === "function") {
      const popResize = new ResizeObserver(() => {
        if (popAnchor && el.pop && !el.pop.hidden) positionPopover(popAnchor);
      });
      popResize.observe(el.pop);
    }
    function openPopover(kind, anchor) {
      if (!el.pop || !anchor) return;
      if (popAnchor === anchor && !el.pop.hidden && el.pop.dataset.kind === kind) {
        closePopover();
        return;
      }
      if (popAnchor) popAnchor.setAttribute("aria-expanded", "false");
      popAnchor = anchor;
      anchor.setAttribute("aria-expanded", "true");
      el.pop.dataset.kind = kind;
      renderPopover(kind);
      el.pop.hidden = false;
      el.pop.scrollTop = 0;
      positionPopover(anchor);
    }
    function renderPopover(kind) {
      if (kind === "ink") return renderInkPopover();
      if (kind === "font") return renderFontPopover();
      if (kind === "paper") return renderPaperPopover();
      if (kind === "settings") return renderSettingsPopover();
      return renderLegendPopover();
    }

    const INK_COLORS = [DEFAULT_INK, LEGACY_INK, "#6b7280", "#0a84ff", "#30b158", "#ff9f0a", "#bf5af2", "#00c7be"];
    function renderInkPopover() {
      const current = control("ink-color").value.toLowerCase();
      el.pop.innerHTML =
        '<p class="r-pop-title">墨色</p>' +
        '<p class="r-pop-sub">用于自由画、直线与页面文字。</p>' +
        '<div class="r-pop-swatches">' +
        INK_COLORS.map(
          (color) =>
            `<button type="button" class="r-pop-swatch r-pop-ink${
              color.toLowerCase() === current ? " on" : ""
            }" data-ink="${color}" style="background:${color}" aria-label="${color}"></button>`
        ).join("") +
        "</div>" +
        '<label class="r-pop-row"><span>粗细</span><input id="pop-width" type="range" min="0.5" max="30" step="0.5"><span class="r-pop-value" id="pop-width-v"></span></label>' +
        '<label class="r-pop-row"><span>不透明度</span><input id="pop-opacity" type="range" min="5" max="100" step="5"><span class="r-pop-value" id="pop-opacity-v"></span></label>' +
        '<label class="r-pop-row"><span>自定义</span><input id="pop-ink-color" type="color"></label>';
      for (const swatch of el.pop.querySelectorAll("[data-ink]")) {
        swatch.addEventListener("click", () => {
          control("ink-color").value = swatch.dataset.ink;
          control("ink-color").dispatchEvent(new Event("input", { bubbles: true }));
          for (const other of el.pop.querySelectorAll("[data-ink]")) other.classList.toggle("on", other === swatch);
          refreshDock();
        });
      }
      const width = el.pop.querySelector("#pop-width");
      const widthValue = el.pop.querySelector("#pop-width-v");
      width.value = String(control("ink-width").value);
      const showWidth = () => {
        widthValue.textContent = `${(+width.value).toFixed(1).replace(/\.0$/, "")} pt`;
      };
      showWidth();
      width.addEventListener("input", () => {
        control("ink-width").value = width.value;
        control("ink-width").dispatchEvent(new Event("input", { bubbles: true }));
        showWidth();
      });
      const opacity = el.pop.querySelector("#pop-opacity");
      const opacityValue = el.pop.querySelector("#pop-opacity-v");
      opacity.value = String(control("ink-opacity").value);
      const showOpacity = () => {
        opacityValue.textContent = `${opacity.value}%`;
      };
      showOpacity();
      opacity.addEventListener("input", () => {
        control("ink-opacity").value = opacity.value;
        control("ink-opacity").dispatchEvent(new Event("input", { bubbles: true }));
        showOpacity();
      });
      const custom = el.pop.querySelector("#pop-ink-color");
      custom.value = control("ink-color").value;
      custom.addEventListener("input", () => {
        control("ink-color").value = custom.value;
        control("ink-color").dispatchEvent(new Event("input", { bubbles: true }));
        for (const other of el.pop.querySelectorAll("[data-ink]")) other.classList.remove("on");
        refreshDock();
      });
    }

    const FONT_SOURCE = { imported: "我安装的", bundled: "内置", system: "系统" };
    function renderFontPopover() {
      const current = control("text-font").value || "sans-serif";
      el.pop.innerHTML =
        '<p class="r-pop-title">字体</p>' +
        '<p class="r-pop-sub">按来源分类；也可以导入自己的 .ttf / .otf / .ttc。</p>' +
        '<div class="r-font-tabs" id="pop-font-tabs" role="tablist" aria-label="字体来源">' +
        '<button type="button" data-group="all" class="on">全部</button>' +
        '<button type="button" data-group="installed">我安装的</button>' +
        '<button type="button" data-group="system">系统</button>' +
        "</div>" +
        '<div class="r-pop-search"><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
        ICONS.search +
        '</svg><input id="pop-font-search" placeholder="搜索字体" spellcheck="false"></div>' +
        '<div class="r-pop-fontlist" id="pop-fontlist"></div>' +
        '<button class="r-pop-btn" id="pop-font-import" type="button">导入字体文件（.ttf / .otf / .ttc）</button>';
      const list = el.pop.querySelector("#pop-fontlist");
      const search = el.pop.querySelector("#pop-font-search");
      const tabs = el.pop.querySelector("#pop-font-tabs");
      const rows = [];
      for (const font of BUILTIN_FONTS) rows.push({ css: font.css, label: font.label, source: "builtin" });
      for (const font of FONTS.list) rows.push(font);
      const groups = [
        { id: "installed", label: "我安装的", fonts: rows.filter((font) => font.source === "imported") },
        { id: "builtin", label: "内置", fonts: rows.filter((font) => font.source === "builtin") },
        { id: "system", label: "系统字体", fonts: rows.filter((font) => font.source === "system") },
      ];
      let group = "all";
      const rowHtml = (font) =>
        `<button type="button" class="r-font-row${font.css === current ? " on" : ""}" data-css="${escapeHtml(
          font.css
        )}" data-source="${font.source}"><span>${escapeHtml(font.label || font.family)}</span></button>`;
      const paint = (query) => {
        const needle = query.trim().toLowerCase();
        const limit = 60;
        let used = 0;
        const parts = [];
        for (const entry of groups) {
          if (group !== "all" && group !== entry.id) continue;
          const matches = entry.fonts.filter(
            (font) => !needle || String(font.label || font.family || "").toLowerCase().includes(needle)
          );
          if (!matches.length) continue;
          const take = matches.slice(0, Math.max(0, limit - used));
          used += take.length;
          if (!take.length) continue;
          parts.push(`<p class="r-font-group">${entry.label}<span>${matches.length}</span></p>`);
          parts.push(take.map(rowHtml).join(""));
        }
        if (!parts.length) {
          list.innerHTML =
            group === "installed"
              ? '<p class="r-pop-note">还没有导入字体。用下面的按钮添加本机字体文件。</p>'
              : '<p class="r-pop-note">没有匹配的字体</p>';
        } else {
          list.innerHTML =
            parts.join("") +
            (used >= limit ? `<p class="r-pop-note">只显示前 ${limit} 个字体，输入名称可搜索全部。</p>` : "");
        }
        for (const row of list.querySelectorAll(".r-font-row")) {
          row.style.fontFamily = fontStack(row.dataset.css);
        }
      };
      paint("");
      search.addEventListener("input", () => paint(search.value));
      tabs.addEventListener("click", (event) => {
        const button = event.target.closest("[data-group]");
        if (!button) return;
        group = button.dataset.group;
        for (const other of tabs.querySelectorAll("[data-group]")) other.classList.toggle("on", other === button);
        paint(search.value);
        list.scrollTop = 0;
      });
      list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-css]");
        if (!row) return;
        control("text-font").value = row.dataset.css;
        control("text-font").dispatchEvent(new Event("input", { bubbles: true }));
        for (const other of list.querySelectorAll(".r-font-row")) other.classList.toggle("on", other === row);
        updateTextbar();
        if (state.editingId) focusText(state.editingId);
      });
      el.pop.querySelector("#pop-font-import").addEventListener("click", () => el.fontUpload.click());
      el.pop.querySelector("#pop-fontlist").addEventListener("mousedown", (event) => {
        if (event.target.closest("button")) event.preventDefault();
      });
    }

    const PAPERS = [
      ["white", "原色", "#ffffff"],
      ["cream", "暖米", "#f3ecda"],
      ["sage", "浅绿", "#e4eddf"],
      ["blue", "雾蓝", "#e4ecf3"],
      ["rose", "浅粉", "#f3e6e4"],
      ["ink", "水墨屏", "#e8e8e2"],
    ];
    function renderPaperPopover() {
      const current = control("paper-theme").value;
      el.pop.innerHTML =
        '<p class="r-pop-title">纸面</p>' +
        '<p class="r-pop-sub">只换纸张底色；高亮与墨迹保持原色，水墨屏下也不会变灰。</p>' +
        '<div class="r-pop-choices">' +
        PAPERS.map(
          ([id, label, color]) =>
            `<button type="button" class="r-pop-choice${id === current ? " on" : ""}" data-paper="${id}">` +
            `<span class="r-pop-choice-dot" style="background:${color}"></span>` +
            `<span>${label}</span>` +
            '<svg class="r-pop-choice-check" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 8.4 3.2 3.2L13 4.8"/></svg>' +
            "</button>"
        ).join("") +
        "</div>" +
        '<label class="r-pop-row" style="margin-top:12px"><span>自定义</span><input id="pop-paper-color" type="color"></label>';
      for (const button of el.pop.querySelectorAll("[data-paper]")) {
        button.addEventListener("click", () => {
          control("paper-theme").value = button.dataset.paper;
          control("paper-theme").dispatchEvent(new Event("change"));
          for (const other of el.pop.querySelectorAll("[data-paper]")) other.classList.toggle("on", other === button);
        });
      }
      const custom = el.pop.querySelector("#pop-paper-color");
      custom.value = control("paper-color").value;
      custom.addEventListener("input", () => {
        control("paper-color").value = custom.value;
        control("paper-color").dispatchEvent(new Event("input"));
        for (const other of el.pop.querySelectorAll("[data-paper]")) other.classList.remove("on");
      });
    }

    /* ------------------------------------------------ colour tag manager -- */
    /* One row per tag: drag handle, colour swatch, editable name, delete.  The
       row order is the persisted tag order; pointer-drag reorders the DOM and
       persists on drop. */
    function tagRowHtml(tag, current) {
      return (
        `<div class="r-tag-row${tag.color === current ? " on" : ""}" data-tag-id="${escapeHtml(
          tag.id
        )}" data-tag-color="${escapeHtml(tag.color)}">` +
        `<span class="r-tag-grip" data-tag-grip="${escapeHtml(
          tag.id
        )}" title="拖动排序" aria-hidden="true">⋮⋮</span>` +
        `<span class="r-tag-swatch" style="background:${colorHex(
          tag.color
        )}" aria-hidden="true"></span>` +
        `<input class="r-tag-name" data-legend="${escapeHtml(
          tag.id
        )}" data-tag-name="${escapeHtml(tag.id)}" maxlength="12" value="${escapeHtml(
          tag.name
        )}" spellcheck="false" aria-label="${escapeHtml(tag.color)}标签名称">` +
        `<button class="r-tag-del" type="button" data-tag-delete="${escapeHtml(
          tag.id
        )}" title="删除标签（批注保留原颜色）" aria-label="删除标签">×</button>` +
        "</div>"
      );
    }
    function nextTagColor() {
      const used = new Set(readColorTags().map((tag) => tag.color));
      return Object.keys(COLOR_PALETTE).find((key) => !used.has(key)) || "#3aa0ff";
    }
    /* Every tag edit is saved immediately and refreshes the colour affordances
       (toolbar dots, editor dots, hints, sidebar chips) in tag order. */
    function refreshColorTagUi() {
      renderColorDots();
      updateHints();
      renderNotesList();
    }
    function paintTagSelection() {
      const current = savedHighlightColor();
      for (const row of el.pop.querySelectorAll(".r-tag-row")) {
        row.classList.toggle("on", row.dataset.tagColor === current);
      }
    }
    function addColorTag(value, name) {
      const color = normalizeTagColor(value);
      if (!color) {
        toast("请选择一个颜色", "bad");
        return null;
      }
      const tags = readColorTags();
      const trimmed = String(name == null ? "" : name).trim().slice(0, 12);
      const finalName = trimmed || colorName(color) || colorHex(color);
      const twin = tags.find((tag) => tag.color === color && tag.name === finalName);
      if (twin) {
        /* Same colour + same name: just select it instead of a duplicate dot. */
        rememberHighlightColor(color);
        refreshColorTagUi();
        return twin;
      }
      const tag = { id: newColorTagId(), color, name: finalName };
      writeColorTags([...tags, tag]);
      rememberHighlightColor(color);
      refreshColorTagUi();
      return tag;
    }
    function deleteColorTag(id) {
      const tags = readColorTags();
      const tag = tags.find((entry) => entry.id === id);
      if (!tag) return;
      /* Only the tag goes away: annotations keep the colour value they stored. */
      writeColorTags(tags.filter((entry) => entry.id !== id));
      if (!readColorTags().some((entry) => entry.color === tag.color)) {
        state.colorFilter.delete(tag.color);
        readerPrefs.colorFilter = [...state.colorFilter];
        storePrefs();
      }
      refreshColorTagUi();
      renderLegendPopover();
      toast(`已删除标签「${tag.name}」；已有批注保留原颜色`, "good");
    }
    function commitTagOrder(list) {
      const order = [...list.querySelectorAll(".r-tag-row")].map((row) => row.dataset.tagId);
      const tags = readColorTags();
      const byId = new Map(tags.map((tag) => [tag.id, tag]));
      const ordered = order.map((id) => byId.get(id)).filter(Boolean);
      for (const tag of tags) if (!ordered.includes(tag)) ordered.push(tag);
      writeColorTags(ordered);
      refreshColorTagUi();
    }
    function bindTagDrag(list) {
      list.addEventListener("pointerdown", (event) => {
        const grip = event.target.closest("[data-tag-grip]");
        if (!grip) return;
        const row = grip.closest(".r-tag-row");
        if (!row) return;
        event.preventDefault();
        row.classList.add("dragging");
        const move = (moveEvent) => {
          const under = document
            .elementFromPoint(moveEvent.clientX, moveEvent.clientY)
            ?.closest?.(".r-tag-row");
          if (!under || under === row || !list.contains(under)) return;
          const rect = under.getBoundingClientRect();
          const after = moveEvent.clientY > rect.top + rect.height / 2;
          list.insertBefore(row, after ? under.nextSibling : under);
        };
        const stop = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", stop);
          document.removeEventListener("pointercancel", stop);
          row.classList.remove("dragging");
          commitTagOrder(list);
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", stop);
        document.addEventListener("pointercancel", stop);
      });
    }

    function renderLegendPopover() {
      const tags = readColorTags();
      const current = savedHighlightColor();
      const rows = tags.map((tag) => tagRowHtml(tag, current)).join("");
      el.pop.innerHTML =
        '<p class="r-pop-title">颜色标签</p>' +
        '<p class="r-pop-sub">拖动 ⋮⋮ 调整顺序；改名、删除只影响标签，已有批注保留原颜色。</p>' +
        '<div class="r-tag-add">' +
        '<input id="pop-tag-color" type="color" aria-label="新标签颜色" title="新标签颜色">' +
        '<input id="pop-tag-name" maxlength="12" placeholder="新标签名称" spellcheck="false" aria-label="新标签名称">' +
        '<button id="pop-tag-add" type="button">＋ 新增标签</button>' +
        "</div>" +
        `<div class="r-tag-list" id="pop-tags">${rows}</div>` +
        '<label class="r-pop-check"><input type="checkbox" id="pop-hints"> 显示功能提示</label>' +
        '<div class="r-settings-block"><span class="r-settings-label">批注显示</span>' +
        '<div class="r-segmented" id="pop-layout">' +
        `<button type="button" data-layout="page" class="${state.marginMode ? "" : "on"}">页面内</button>` +
        `<button type="button" data-layout="margin" class="${state.marginMode ? "on" : ""}">页边距</button>` +
        "</div></div>";
      const list = el.pop.querySelector("#pop-tags");
      const colorInput = el.pop.querySelector("#pop-tag-color");
      const nameInput = el.pop.querySelector("#pop-tag-name");
      colorInput.value = nextTagColor();
      bindTagDrag(list);
      list.addEventListener("input", (event) => {
        const input = event.target.closest("[data-tag-name]");
        if (!input) return;
        const tag = readColorTags().find((entry) => entry.id === input.dataset.tagName);
        if (!tag || tag.name === input.value) return;
        tag.name = input.value;
        writeColorTags(readColorTags());
        updateHints();
        renderNotesList();
      });
      list.addEventListener("click", (event) => {
        const button = event.target.closest("[data-tag-delete]");
        if (!button) return;
        event.stopPropagation();
        deleteColorTag(button.dataset.tagDelete);
      });
      const add = () => {
        const tag = addColorTag(colorInput.value, nameInput.value);
        if (!tag) return;
        if (!list.querySelector(`[data-tag-id="${tag.id}"]`)) {
          list.insertAdjacentHTML("beforeend", tagRowHtml(tag, savedHighlightColor()));
        }
        paintTagSelection();
        /* The new tag is selected: the next highlight uses its colour. */
        nameInput.value = "";
        colorInput.value = nextTagColor();
      };
      el.pop.querySelector("#pop-tag-add").addEventListener("click", add);
      nameInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        add();
      });
      const hints = el.pop.querySelector("#pop-hints");
      hints.checked = control("color-hints").checked;
      hints.addEventListener("change", () => {
        control("color-hints").checked = hints.checked;
        updateHints();
      });
      el.pop.querySelector("#pop-layout").addEventListener("click", (event) => {
        const button = event.target.closest("[data-layout]");
        if (!button) return;
        state.marginMode = button.dataset.layout === "margin";
        applyMarginMode(button.dataset.layout === "margin");
        for (const other of el.pop.querySelectorAll("[data-layout]")) other.classList.toggle("on", other === button);
      });
    }

    function renderSettingsPopover() {
      const prefs = dockState();
      const hidden = new Set(prefs.hidden);
      const seen = new Set();
      const short = {
        erase: "橡皮擦",
        ink: "墨色与粗细",
        paper: "纸面颜色",
        original: "左侧原文",
        legend: "颜色标签",
        settings: "工具栏设置",
      };
      const rows = [];
      for (const id of prefs.order) {
        if (id === "|" || seen.has(id) || !DOCK_ITEMS[id]) continue;
        seen.add(id);
        const item = DOCK_ITEMS[id];
        rows.push(
          `<div class="r-settings-row" data-row="${id}">` +
            `<span class="r-settings-icon">${icon(item.icon, 16)}</span>` +
            `<span class="r-settings-name">${short[id] || item.label}</span>` +
            `<button class="r-settings-move" type="button" data-move="${id}" data-dir="-1" title="上移" aria-label="上移">↑</button>` +
            `<button class="r-settings-move" type="button" data-move="${id}" data-dir="1" title="下移" aria-label="下移">↓</button>` +
            `<label class="r-switch"><input type="checkbox" data-visible="${id}" ${
              hidden.has(id) ? "" : "checked"
            }><i></i></label>` +
            "</div>"
        );
      }
      el.pop.innerHTML =
        '<p class="r-settings-title">工具栏</p>' +
        '<p class="r-settings-sub">用 ↑ ↓ 调整顺序，开关控制显示。设置只保存在这台设备上。</p>' +
        `<div class="r-settings-list">${rows.join("")}</div>` +
        '<div class="r-settings-block"><span class="r-settings-label">批注显示</span>' +
        '<div class="r-segmented" id="pop-layout">' +
        `<button type="button" data-layout="page" class="${state.marginMode ? "" : "on"}">页面内</button>` +
        `<button type="button" data-layout="margin" class="${state.marginMode ? "on" : ""}">页边距</button>` +
        "</div></div>" +
        '<div class="r-settings-block"><span class="r-settings-label">手绘下划线笔触</span>' +
        '<div class="r-segmented" id="pop-hand-style">' +
        HAND_PRESETS.map(
          (id) =>
            `<button type="button" data-hand-preset="${id}" class="${
              savedHandStyle() === id ? "on" : ""
            }" aria-pressed="${savedHandStyle() === id}">${HAND_PRESET_LABELS[id]}</button>`
        ).join("") +
        "</div></div>" +
        '<button class="r-pop-btn" type="button" id="pop-dock-reset">恢复默认工具栏</button>';
      el.pop.querySelector(".r-settings-list").addEventListener("click", (event) => {
        const move = event.target.closest("[data-move]");
        if (move) {
          moveDockItem(move.dataset.move, Number(move.dataset.dir));
          return;
        }
      });
      for (const input of el.pop.querySelectorAll("[data-visible]")) {
        input.addEventListener("change", () => {
          const id = input.dataset.visible;
          const set = new Set(dockState().hidden);
          if (input.checked) set.delete(id);
          else set.add(id);
          readerPrefs.dock.hidden = [...set];
          storePrefs();
          renderDock();
        });
      }
      el.pop.querySelector("#pop-layout").addEventListener("click", (event) => {
        const button = event.target.closest("[data-layout]");
        if (!button) return;
        state.marginMode = button.dataset.layout === "margin";
        applyMarginMode(button.dataset.layout === "margin");
        for (const other of el.pop.querySelectorAll("[data-layout]")) other.classList.toggle("on", other === button);
      });
      const handRow = el.pop.querySelector("#pop-hand-style");
      if (handRow) {
        handRow.addEventListener("click", (event) => {
          const button = event.target.closest("[data-hand-preset]");
          if (!button) return;
          applyHandPreset(button.dataset.handPreset);
          for (const other of handRow.querySelectorAll("[data-hand-preset]")) {
            other.classList.toggle("on", other === button);
          }
        });
      }
      el.pop.querySelector("#pop-dock-reset").addEventListener("click", () => {
        readerPrefs.dock = { order: [...DOCK_DEFAULT], hidden: [] };
        storePrefs();
        renderDock();
        renderSettingsPopover();
      });
    }

    function moveDockItem(id, direction) {
      const order = dockState().order;
      const items = order.filter((entry) => entry !== "|");
      const from = items.indexOf(id);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= items.length) return;
      const other = items[to];
      const a = order.indexOf(id);
      const b = order.indexOf(other);
      order[a] = other;
      order[b] = id;
      storePrefs();
      renderDock();
      renderSettingsPopover();
    }

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!popAnchor || el.pop.hidden) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && (target.closest("#r-pop") || (popAnchor && popAnchor.contains(target)))) return;
        closePopover();
      },
      true
    );
    el.pop.addEventListener("mousedown", (event) => event.stopPropagation());

    /* ------------------------------------------------------------ dock -- */
    if (el.dock) {
      el.dock.addEventListener("mousedown", (event) => event.stopPropagation());
      el.dock.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.tool) {
          closePopover();
          const tool = button.dataset.tool;
          if (tool === "note") {
            closeEditor();
            el.noteTool.click();
            refreshDock();
            return;
          }
          closeEditor();
          if (tool === "select" && state.noteTool) {
            el.noteTool.click();
            return;
          }
          setDrawingTool(tool);
          return;
        }
        if (button.dataset.style) {
          setHighlightStyle(button.dataset.style);
          return;
        }
        if (button.dataset.action) {
          const action = button.dataset.action;
          if (action === "original") {
            toggleOriginal();
            return;
          }
          if (action === "layout") {
            toggleMarginMode();
            return;
          }
          if (action === "ink" || action === "font" || action === "paper" || action === "legend" || action === "settings") {
            openPopover(action, button);
          }
        }
      });
    }

    /* ---------------------------------------------------- text bar UI -- */
    function setupTextbar() {
      if (!el.textbar) return;
      el.textbar.addEventListener("mousedown", (event) => event.preventDefault());
      const colors = el.textbar.querySelectorAll("[data-text-color]");
      for (const dot of colors) {
        dot.addEventListener("click", () => {
          styleTextItem({ inkColor: dot.dataset.textColor });
          for (const other of colors) other.classList.toggle("on", other === dot);
        });
      }
      el.textbar.querySelector("#textbar-custom").addEventListener("input", (event) => {
        styleTextItem({ inkColor: event.target.value });
        for (const other of colors) other.classList.remove("on");
      });
      for (const button of el.textbar.querySelectorAll("[data-size]")) {
        button.addEventListener("click", () => {
          const item = state.items.find((entry) => entry.id === state.activeId);
          if (!item) return;
          styleTextItem({ fontSize: clamp(Math.round((item.fontSize || 18) + Number(button.dataset.size)), 8, 96) });
        });
      }
      el.textbarFont.addEventListener("click", () => openPopover("font", el.textbarFont));
      el.textbarDone.addEventListener("click", () => endTextEdit());
    }

    /* ----------------------------------------------------- page tools -- */
    let suppressPageClick = false;
    el.pages.addEventListener(
      "click",
      (event) => {
        if (drawingTool !== "select" || suppressPageClick) {
          suppressPageClick = false;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true
    );
    el.pages.addEventListener("input", (event) => {
      const node = event.target.closest?.(".r-page-text.editing");
      if (!node) return;
      const item = state.items.find((entry) => entry.id === node.dataset.id);
      if (!item) return;
      item.comment = node.innerText;
      item.updated = Date.now() / 1000;
      node.dataset.placeholder = "";
      positionTextFrame(item.id);
      persist();
    });
    el.pages.addEventListener("focusout", (event) => {
      const node = event.target.closest?.(".r-page-text.editing");
      if (!node) return;
      window.setTimeout(() => {
        if (!state.editingId || state.editingId !== node.dataset.id) return;
        if (document.activeElement === node) return;
        if (el.textbar && el.textbar.contains(document.activeElement)) return;
        /* The font/colour popover and the move/resize grips belong to the
           text editor: using them must not commit and close the text. */
        if (el.pop && !el.pop.hidden) return;
        if (textFrame && textFrame.contains(document.activeElement)) return;
        endTextEdit();
      }, 0);
    });
    el.pages.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (state.editingId && target && (target.closest(".r-page-text.editing") || target.closest(".r-text-frame"))) return;
        if (state.editingId) endTextEdit();
        if (drawingTool === "select") return;
        const section = event.target.closest(".r-sheet");
        if (!section) return;
        const sheet = state.sheets[+section.dataset.page - 1];
        if (!sheet) return;
        event.preventDefault();
        event.stopPropagation();
        closePopover();
        closeEditor();
        const start = pointToPage(sheet, event.clientX, event.clientY);
        if (drawingTool === "text") {
          state.noteTool = false;
          el.noteTool.setAttribute("aria-pressed", "false");
          el.pages.classList.remove("note-mode");
          const item = addAnnotation({ type: "text", page: sheet.no, point: start, ...drawingOptions() });
          commitDrawing(item);
          setDrawingTool("select");
          suppressPageClick = true;
          beginTextEdit(item.id);
          return;
        }
        if (drawingTool === "erase") {
          const erase = (e) => {
            const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-id]");
            if (hit && state.items.some((a) => a.id === hit.dataset.id && a.type === "ink")) removeAnnotation(hit.dataset.id);
          };
          erase(event);
          el.pages.setPointerCapture(event.pointerId);
          const done = () => {
            el.pages.removeEventListener("pointermove", erase);
            el.pages.removeEventListener("pointerup", done);
            el.pages.removeEventListener("pointercancel", done);
          };
          el.pages.addEventListener("pointermove", erase);
          el.pages.addEventListener("pointerup", done);
          el.pages.addEventListener("pointercancel", done);
          return;
        }
        const tool = drawingTool;
        const item = { type: "ink", page: sheet.no, point: start, points: [start], ...drawingOptions() };
        let preview = renderDrawing(item, sheet);
        sheet.anno.append(preview);
        el.pages.setPointerCapture(event.pointerId);
        let frame = 0;
        const move = (e) => {
          const p = pointToPage(sheet, e.clientX, e.clientY);
          p.x = clamp(p.x, 0, sheet.width / state.scale);
          p.y = clamp(p.y, 0, sheet.height / state.scale);
          if (tool === "line") item.points = [start, p];
          else if (item.points.length < 12000) item.points.push(p);
          if (!frame) {
            frame = requestAnimationFrame(() => {
              frame = 0;
              const next = renderDrawing(item, sheet);
              preview.replaceWith(next);
              preview = next;
            });
          }
        };
        const done = (e) => {
          el.pages.removeEventListener("pointermove", move);
          el.pages.removeEventListener("pointerup", done);
          el.pages.removeEventListener("pointercancel", done);
          cancelAnimationFrame(frame);
          preview.remove();
          if (e.type !== "pointercancel" && item.points.length > 1) commitDrawing(addAnnotation(item));
        };
        el.pages.addEventListener("pointermove", move);
        el.pages.addEventListener("pointerup", done);
        el.pages.addEventListener("pointercancel", done);
      },
      true
    );

    /* --------------------------------------------------- context menu -- */
    function menuAt(event) {
      el.menu.hidden = false;
      const box = el.menu.getBoundingClientRect();
      let top = event.clientY;
      if (top + box.height > window.innerHeight - 8) top = event.clientY - box.height;
      el.menu.style.left = `${clamp(event.clientX, 8, window.innerWidth - box.width - 8)}px`;
      el.menu.style.top = `${clamp(top, 8, window.innerHeight - box.height - 8)}px`;
    }
    function styleMenuHtml() {
      return HIGHLIGHT_STYLES.map(
        (style) =>
          `<button type="button" class="r-menu-style" data-menu-style="${style.id}" data-family="${style.family}">${icon(
            style.icon,
            15
          )}<span>${style.label}</span></button>`
      ).join("");
    }
    function showSelectionMenu(event, captured) {
      el.menu.className = "r-menu r-menu-rich";
      el.menu.innerHTML =
        `<div class="r-menu-title"><span>标记所选文字</span><span>${captured.text.length} 字</span></div>` +
        `<div class="r-menu-styles">${styleMenuHtml()}</div>` +
        `<div class="r-menu-colors">${readColorTags()
          .map((tag) => colorDotHtml(tag.color, "data-menu-color"))
          .join("")}</div>` +
        '<hr class="r-menu-hr">' +
        `<button type="button" class="r-menu-item" data-menu-act="note-save">${icon("note", 14)}存为笔记</button>` +
        `<button type="button" class="r-menu-item" data-menu-act="note">${icon("note", 14)}写批注…</button>` +
        `<button type="button" class="r-menu-item" data-menu-act="ai-ask">${icon("spark", 14)}引用提问…</button>` +
        `<button type="button" class="r-menu-item" data-menu-act="ai-explain">${icon("spark", 14)}解释这段</button>` +
        `<button type="button" class="r-menu-item" data-menu-act="copy">${icon("copy", 14)}复制文字</button>`;
      menuAt(event);
      el.menu.onclick = (click) => {
        const styleButton = click.target.closest("[data-menu-style]");
        const colorButton = click.target.closest("[data-menu-color]");
        const action = click.target.closest("[data-menu-act]");
        if (styleButton) {
          const style = styleButton.dataset.menuStyle;
          setHighlightStyle(style);
          const item = highlightSelection(savedHighlightColor(), resolveHighlightStyle(style));
          if (item) {
            el.menu.hidden = true;
            toast("已高亮所选文字", "good");
          }
          return;
        }
        if (colorButton) {
          rememberHighlightColor(colorButton.dataset.menuColor);
          const item = highlightSelection(colorButton.dataset.menuColor);
          if (item) {
            el.menu.hidden = true;
            toast("已高亮所选文字", "good");
          }
          return;
        }
        if (!action) return;
        const act = action.dataset.menuAct;
        if (act === "ai-ask" || act === "ai-explain") {
          el.menu.hidden = true;
          const question =
            act === "ai-explain"
              ? "请解释这段在论文里是什么意思，以及它和上下文的关系。"
              : "";
          if (window.ReaderAI && typeof window.ReaderAI.quote === "function") {
            window.ReaderAI.quote(captured, { question });
          } else {
            toast("AI 助读脚本没有加载，请刷新重试", "bad");
          }
          return;
        }
        if (act === "note-save") {
          el.menu.hidden = true;
          if (window.ReaderNotes && typeof window.ReaderNotes.createFromSelection === "function") {
            window.ReaderNotes.createFromSelection(captured);
          } else {
            toast("笔记脚本没有加载，请刷新重试", "bad");
          }
          return;
        }
        if (act === "copy") {
          navigator.clipboard.writeText(captured.text).then(
            () => toast("已复制选中文字", "good"),
            () => toast("复制失败，请使用 Ctrl+C", "bad")
          );
          el.menu.hidden = true;
          return;
        }
        const item = highlightSelection("pink");
        el.menu.hidden = true;
        if (item) openEditor(item.id, event);
      };
    }
    function showAnnotationMenu(event, item) {
      el.menu.className = "r-menu r-menu-rich";
      el.menu.innerHTML =
        `<div class="r-menu-title"><span>第 ${item.page} 页 · ${
          { highlight: "高亮", note: "便签", text: "文字", ink: "画笔" }[item.type] || "批注"
        }</span></div>` +
        (item.type === "text"
          ? `<button type="button" class="r-menu-item" data-menu-act="edit">${icon("edit", 14)}编辑文字</button>`
          : `<button type="button" class="r-menu-item" data-menu-act="edit">${icon("edit", 14)}打开批注</button>`) +
        (item.type === "highlight"
          ? `<div class="r-menu-colors">${readColorTags()
              .map((tag) => colorDotHtml(tag.color, "data-menu-color"))
              .join("")}</div>`
          : "") +
        `<button type="button" class="r-menu-item" data-menu-act="delete">${icon("trash", 14)}删除</button>`;
      menuAt(event);
      el.menu.onclick = (click) => {
        const color = click.target.closest("[data-menu-color]");
        if (color) {
          if (item.color !== color.dataset.menuColor) {
            pushHistory();
            item.color = color.dataset.menuColor;
            item.updated = Date.now() / 1000;
            persist();
            refreshAnnotations(pagesOfItem(item));
            renderNotesList();
          }
          el.menu.hidden = true;
          return;
        }
        const action = click.target.closest("[data-menu-act]");
        if (!action) return;
        el.menu.hidden = true;
        if (action.dataset.menuAct === "delete") removeAnnotation(item.id);
        else if (item.type === "text") beginTextEdit(item.id);
        else openEditor(item.id, event);
      };
    }
    function showToolMenu(event) {
      el.menu.className = "r-menu r-menu-rich";
      el.menu.innerHTML =
        '<div class="r-menu-title"><span>工具</span></div>' +
        ["select", "text", "note", "pen", "line"]
          .map((id) => {
            const item = DOCK_ITEMS[id];
            return `<button type="button" class="r-menu-item" data-menu-tool="${id}">${icon(
              item.icon,
              14
            )}${item.label}</button>`;
          })
          .join("") +
        '<hr class="r-menu-hr">' +
        `<button type="button" class="r-menu-item" data-menu-tool="ai-page">${icon("spark", 14)}总结这一页（AI）</button>`;
      menuAt(event);
      el.menu.onclick = (click) => {
        const button = click.target.closest("[data-menu-tool]");
        if (!button) return;
        el.menu.hidden = true;
        const tool = button.dataset.menuTool;
        if (tool === "ai-page") {
          if (window.ReaderAI && typeof window.ReaderAI.open === "function") {
            window.ReaderAI.open({ page: state.page });
          } else {
            toast("AI 助读脚本没有加载，请刷新重试", "bad");
          }
          return;
        }
        if (tool === "note") {
          if (!state.noteTool) el.noteTool.click();
        } else setDrawingTool(tool);
      };
    }

    document.addEventListener("contextmenu", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("input, textarea, [contenteditable=true], .r-page-text.editing")) return;
      if (!target.closest(".r-page, .r-anno, .r-note, .r-note-badge, .r-ink")) return;
      event.preventDefault();
      closeMenu();
      closePopover();
      const selection = window.getSelection();
      const captured =
        selection && !selection.isCollapsed && selection.rangeCount ? captureSelection() : null;
      if (captured) {
        state.pending = captured;
        if (el.selToolbar && !el.selToolbar.hidden) el.selToolbar.hidden = true;
        showSelectionMenu(event, captured);
        return;
      }
      const hit = target.closest("[data-id]");
      if (hit) {
        const item = state.items.find((entry) => entry.id === hit.dataset.id);
        if (item) {
          showAnnotationMenu(event, item);
          return;
        }
      }
      showToolMenu(event);
    });
    el.menu.addEventListener("mousedown", (event) => event.preventDefault());
    document.addEventListener("mousedown", (event) => {
      if (el.menu.hidden) return;
      if (event.target.closest(".r-menu")) return;
      if (event.target.closest("#btn-export")) return;
      closeMenu();
    });

    /* -------------------------------------------------------- toolbar -- */
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.editingId) {
        event.preventDefault();
        endTextEdit();
        return;
      }
      if (state.editingId) return;
      const tag = (event.target.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || event.target.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const map = { v: "select", t: "text", n: "note", p: "pen", l: "line", e: "erase" };
      const tool = map[event.key.toLowerCase()];
      if (!tool) return;
      event.preventDefault();
      if (tool === "note") {
        if (!state.noteTool) el.noteTool.click();
      } else setDrawingTool(tool);
    });

    /* ------------------------------------------------------- banner -- */
    if (el.banner) {
      el.bannerClose.addEventListener("click", () => {
        el.banner.hidden = true;
        localStorage.setItem("babeldoc-reader-banner", "off");
      });
      el.bannerRestart.addEventListener("click", async () => {
        el.bannerRestart.disabled = true;
        el.bannerRestart.textContent = "正在重启…";
        try {
          await api("/api/app/restart", { method: "POST" });
          pollRestart();
        } catch {
          el.bannerRestart.disabled = false;
          el.bannerRestart.textContent = "重启应用";
          toast("当前正在运行的版本不支持一键重启，请关闭应用窗口后重新打开", "bad");
        }
      });
    }
    api("/api/health")
      .then((health) => {
        serverBuild = Number(health.build) || 0;
        const features = Array.isArray(health.features) ? health.features : [];
        if (!features.includes("ink") || !features.includes("notes")) showStaleBanner();
      })
      .catch(() => {});

    if (el.fontUpload) {
      el.fontUpload.addEventListener("change", async () => {
        const file = el.fontUpload.files && el.fontUpload.files[0];
        if (!file) return;
        const form = new FormData();
        form.append("file", file);
        try {
          const response = await fetch("/api/fonts/upload", { method: "POST", body: form });
          const data = await response.json().catch(() => null);
          if (!response.ok) throw new Error((data && data.error) || "导入字体失败");
          await loadFonts();
          if (data && data.font && data.font.css) {
            control("text-font").value = data.font.css;
            control("text-font").dispatchEvent(new Event("input", { bubbles: true }));
          }
          toast(`已导入字体：${(data && data.font && data.font.label) || file.name}`, "good");
          if (el.pop && !el.pop.hidden && el.pop.dataset.kind === "font") renderFontPopover();
        } catch (error) {
          toast(error.message || "导入字体失败", "bad");
        } finally {
          el.fontUpload.value = "";
        }
      });
    }

    loadFonts();
    setupPageNoteTool();
    refreshDock();
  }

  function renderStyleButtons() {
    const markup = HIGHLIGHT_STYLES.map(
      (style) =>
        `<button type="button" class="r-style-btn" data-style="${style.id}" data-family="${style.family}" title="${style.label}" aria-label="${style.label}" aria-pressed="false">${icon(style.icon, 13)}</button>`
    ).join("");
    /* The three hand presets are chips next to the editor's style buttons and
       only appear while a hand highlight is open. */
    const handChips =
      '<div class="r-editor-hand" id="editor-hand-presets" hidden>' +
      '<span class="r-editor-hand-label">笔触</span>' +
      handPresetChipsHtml() +
      "</div>";
    if (el.selStyles) el.selStyles.innerHTML = markup;
    if (el.editorStyles) el.editorStyles.innerHTML = markup + handChips;
    for (const host of [el.selStyles, el.editorStyles]) {
      if (!host) continue;
      /* Picking a style with text selected must leave a mark right away; in the
         annotation editor the same buttons restyle the open annotation. */
      const appliesToSelection = host === el.selStyles;
      host.addEventListener("click", (event) => {
        const button = event.target.closest("[data-style]");
        if (!button) return;
        event.stopPropagation();
        const style = button.dataset.style;
        setHighlightStyle(style);
        if (!appliesToSelection) return;
        if (!state.pending) return;
        const item = highlightSelection(savedHighlightColor(), style);
        if (!item) return;
        hideSelectionToolbar();
        toast("已标记所选文字", "good");
      });
    }
    const chips = el.editorStyles ? el.editorStyles.querySelector("#editor-hand-presets") : null;
    if (chips) {
      chips.addEventListener("click", (event) => {
        const chip = event.target.closest("[data-hand-preset]");
        if (!chip) return;
        event.stopPropagation();
        applyHandPreset(chip.dataset.handPreset);
      });
    }
  }

  function setupPageNoteTool() {
    /* The hidden #btn-note-tool keeps the original toggling logic alive for
       both the dock and the keyboard shortcut. */
    el.noteTool.addEventListener("click", () => {
      if (state.noteTool) endTextEdit();
    });
  }

  /* ---------------------------------------------------- AI reader bridge -- */
  /* The AI panel and the table-of-contents panel live in their own scripts.
     They get exactly the reader internals they need through this small bridge
     instead of reaching into the closure. */
  let readyResolve = null;
  const readerReady = new Promise((resolve) => {
    readyResolve = resolve;
  });
  function resolveReaderReady() {
    if (!readyResolve) return;
    const done = readyResolve;
    readyResolve = null;
    done();
  }

  async function ensureTextReady(sheet) {
    if (!sheet || !state.pdf) return false;
    if (sheet.textReady && sheet.textScale === state.scale) return true;
    const page = await state.pdf.getPage(sheet.no);
    const viewport = page.getViewport({ scale: state.scale });
    if (!sheet.painted) await paint(sheet);
    await buildText(sheet, page, viewport);
    sheet.textScale = state.scale;
    return Boolean(sheet.textReady);
  }

  function rectsForOffsets(sheet, start, end) {
    const box = sheet.box.getBoundingClientRect();
    const rects = [];
    let offset = 0;
    for (const node of nodesOf(sheet)) {
      const length = node.data.length;
      const nodeStart = offset;
      offset += length;
      const from = Math.max(start, nodeStart);
      const to = Math.min(end, nodeStart + length);
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(node, from - nodeStart);
      range.setEnd(node, to - nodeStart);
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        rects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top - box.top) / state.scale,
          w: rect.width / state.scale,
          h: rect.height / state.scale,
        });
      }
    }
    return rects;
  }

  const FLASH_STYLE_ID = "r-flash-style";
  function installFlashStyle() {
    if (document.getElementById(FLASH_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = FLASH_STYLE_ID;
    style.textContent =
      "@keyframes r-flash-fade{0%{opacity:0}12%{opacity:1}70%{opacity:1}100%{opacity:0}}" +
      ".r-flash-layer{position:absolute;inset:0;pointer-events:none;z-index:6}" +
      ".r-flash-mark{position:absolute;border-radius:3px;background:rgba(255,196,66,.55);" +
      "box-shadow:0 0 0 2px rgba(255,170,0,.35);animation:r-flash-fade 2.6s ease forwards}";
    document.head.append(style);
  }

  /* Jump to a page and highlight the quoted text for a couple of seconds.
     Used by AI citations and the table of contents; it never writes an
     annotation, so browsing an answer leaves the document untouched. */
  async function flashText(page, text, opts = {}) {
    const target = clamp(Math.round(Number(page)) || 1, 1, state.pages || 1);
    const sheet = state.sheets[target - 1];
    if (!sheet) return false;
    installFlashStyle();
    goToPage(target, false);
    const needle = String(text || "").trim();
    if (!needle) return true;
    try {
      await ensureTextReady(sheet);
    } catch {
      return false;
    }
    let span = findOffsets(sheet, needle);
    if (!span && needle.length > 28) span = findOffsets(sheet, needle.slice(0, 28));
    if (!span && opts.fallbackText) span = findOffsets(sheet, String(opts.fallbackText));
    const rects = span ? rectsForOffsets(sheet, span.start, span.end) : [];
    if (!rects.length) return false;
    const layer = document.createElement("div");
    layer.className = "r-flash-layer";
    for (const rect of rects) {
      const mark = document.createElement("span");
      mark.className = "r-flash-mark";
      mark.style.left = `${rect.x * state.scale}px`;
      mark.style.top = `${rect.y * state.scale}px`;
      mark.style.width = `${rect.w * state.scale}px`;
      mark.style.height = `${rect.h * state.scale}px`;
      layer.append(mark);
    }
    sheet.box.append(layer);
    const top =
      (state.tops ? state.tops[target - 1] : 0) +
      (rects[0].y + rects[0].h) * state.scale -
      el.stage.clientHeight * 0.32;
    el.stage.scrollTo({
      top: Math.max(0, top),
      behavior: reduceMotion() ? "auto" : "smooth",
    });
    window.setTimeout(() => layer.remove(), 2800);
    return true;
  }

  window.ReaderBridge = {
    docPath,
    pageCount: () => state.pages,
    currentPage: () => state.page,
    goToPage: (number, smooth = true) => goToPage(number, smooth),
    getPdf: () => state.pdf || null,
    getPageText: (page) => {
      const sheet = state.sheets[Number(page) - 1];
      return sheet && sheet.textReady ? sheetText(sheet) : "";
    },
    getSelection: () => {
      try {
        return captureSelection();
      } catch {
        return null;
      }
    },
    flashText: (page, text, opts) => flashText(page, text, opts || {}),
    refit: () => {
      if (state.fit) relayout(scrollAnchor());
    },
    whenReady: () => readerReady,
    onPageChange: (callback) => {
      const handler = (event) => callback(event.detail.page);
      document.addEventListener("reader:pagechange", handler);
      return () => document.removeEventListener("reader:pagechange", handler);
    },
    version: 1,
  };

  /* Closing the tab must flush the last page even inside the 3 s throttle. */
  window.addEventListener("pagehide", () => reportReadingPosition(true));

  bindEvents();
  setupReaderTools();
  boot();
})();
