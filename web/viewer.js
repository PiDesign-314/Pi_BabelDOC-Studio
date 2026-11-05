/* BabelDOC Studio — built-in PDF reader.
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

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdfjs/build/pdf.worker.min.js";
  }

  const AHEAD = 900; /* px of pages kept rendered above / below the viewport */
  const KEEP = 4; /* pages kept in memory on either side of the reader */
  const TIP_DELAY = 160; /* ms of hover before the note preview opens */
  const POSITION_KEY = "babeldoc-pos:";
  const COLOR_HEX = {
    yellow: "#ffd54a",
    green: "#74dc9e",
    blue: "#7cc4ff",
    pink: "#ff9ec7",
    orange: "#ffb066",
    purple: "#b79bff",
    teal: "#4fd6c6",
    red: "#ff8a80",
  };
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
    selCopy: $("#sel-copy"),
    editor: $("#editor"),
    editorPage: $("#editor-page"),
    editorColors: $("#editor-colors"),
    editorQuote: $("#editor-quote"),
    editorText: $("#editor-text"),
    editorClose: $("#editor-close"),
    editorDelete: $("#editor-delete"),
    editorDone: $("#editor-done"),
    tip: $("#tip"),
    menu: $("#menu"),
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
    flashId: null,
    noteTool: false,
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
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const reduceMotion = () =>
    Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const uid = () =>
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ------------------------------------------------------------- boot -- */
  async function boot() {
    bindTheme($("#btn-theme"));
    el.back.href = origin === "app" ? "/" : "/library";
    el.backLabel.textContent = origin === "app" ? "翻译" : "结果库";

    if (!docPath) {
      showError("没有指定要打开的文件");
      return;
    }
    const name = fileName(docPath);
    el.docName.textContent = name;
    el.docSub.textContent = "载入中…";
    document.title = `${name} · BabelDOC Studio`;

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
      if (resume && resume <= state.pages) {
        goToPage(resume, false);
        toast(`已回到上次读到的第 ${resume} 页`);
      } else {
        goToPage(1, false);
      }
    } catch (error) {
      showError(`无法打开这个 PDF：${error.message || error}`);
    }
  }

  function showError(message) {
    el.loading.hidden = true;
    el.pages.hidden = true;
    el.error.hidden = false;
    const back = origin === "app" ? "/" : "/library";
    el.error.innerHTML =
      `<p>${escapeHtml(message)}</p>` +
      `<a class="btn btn-secondary small" href="${back}">返回</a>`;
  }

  /* ------------------------------------------------------------- layout -- */
  function computeScale() {
    if (!state.fit) return;
    const width = Math.max(240, el.stage.clientWidth - 48);
    const height = Math.max(240, el.stage.clientHeight - 44);
    const widthScale = width / state.base.w;
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
      const anno = document.createElement("div");
      anno.className = "r-anno";
      box.append(canvas, text, anno);
      section.append(box);
      fragment.append(section);

      state.sheets.push({
        no: number,
        el: section,
        box,
        canvas,
        text,
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
    sheet.textReady = true;
  }

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
    sheet.anno.innerHTML = "";
    sheet.nodes = null;
    sheet.textCache = null;
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
    resetSheets();
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
  }

  /* Reopening a paper should land where reading stopped, not on page 1. */
  function rememberPosition() {
    try {
      window.localStorage.setItem(POSITION_KEY + docPath, String(state.page));
    } catch {
      /* private mode / quota — reading position is only a convenience */
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
      rects.push(...piece.getClientRects());
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
    const pieces = rects.map(({ rect, em }) => {
      /* A range's client rect is the line box, which is taller than the
         glyphs; the span's font size is the actual height of the text, so
         size the band from that and keep it centred on the line box. */
      const glyph = em ? Math.min(rect.height, em * 1.12) : rect.height;
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
       band without letting two lines touch. */
    return lines.map((line) => {
      const pad = Math.min(0.6, line.h * 0.08);
      return {
        x: line.left,
        y: line.top - pad,
        w: line.right - line.left,
        h: line.h + pad * 2,
      };
    });
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

  /* Annotation geometry is cached per item: ``legacyBands`` merges the stored
     rectangles into one band per text line, and that never changes until the
     annotation itself is replaced. */
  const BANDS = new WeakMap();
  const NOTE_GLYPH =
    '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
    '<path d="M3.7 4.5h6.6M3.7 7h6.6M3.7 9.5h4" stroke="currentColor" ' +
    'stroke-width="1.35" stroke-linecap="round"/></svg>';

  function bandsOf(item) {
    let bands = BANDS.get(item);
    if (!bands) {
      bands = legacyBands(item.rects || []);
      BANDS.set(item, bands);
    }
    return bands;
  }

  /* Line bands for one page.  Annotations created by this version tag every
     rectangle with its page; older ones fall back to character ranges (which
     need the live text layer) only when the highlight actually spans pages. */
  function bandsFor(item, sheet) {
    const rects = item.rects || [];
    if (rects.length) {
      if (rects[0].page != null) {
        const out = [];
        for (const rect of rects) {
          if ((rect.page || item.page) === sheet.no) out.push(rect);
        }
        if (out.length) return out;
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
    badge.style.setProperty("--badge-tint", COLOR_HEX[item.color] || COLOR_HEX.yellow);
    badge.innerHTML = NOTE_GLYPH;
    badge.setAttribute("aria-label", `第 ${item.page} 页的批注：${item.comment.slice(0, 40)}`);
    const half = 8.5;
    const width = sheet.width || sheet.box.offsetWidth || 600;
    const height = sheet.height || sheet.box.offsetHeight || 800;
    badge.style.left = `${clamp(anchor.x * scale + half + 1, half, width - half)}px`;
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
    if (!items.length) return;
    const fragment = document.createDocumentFragment();

    for (const item of items) {
      if (item.type === "highlight") {
        const bands = bandsFor(item, sheet);
        if (!bands) continue;
        for (const rect of bands) {
          const mark = document.createElement("div");
          mark.className = `r-mark ${item.color}${state.flashId === item.id ? " flash" : ""}`;
          mark.dataset.id = item.id;
          mark.style.left = `${rect.x * scale}px`;
          mark.style.top = `${rect.y * scale}px`;
          mark.style.width = `${rect.w * scale}px`;
          mark.style.height = `${rect.h * scale}px`;
          fragment.appendChild(mark);
        }
        const anchor = badgeAnchor(item, sheet);
        if (anchor) fragment.appendChild(makeBadge(item, anchor, sheet));
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
        fragment.appendChild(marker);
      }
    }
    sheet.anno.appendChild(fragment);
    /* A repaint replaces the badge the pointer was resting on, so drop a
       preview that no longer has anything to point at. */
    if (state.tipId && !sheet.anno.querySelector(`[data-id="${state.tipId}"]`)) hideTip();
  }

  /* --------------------------------------------------------- note preview -- */
  function scheduleTip(item, target) {
    window.clearTimeout(state.tipTimer);
    state.tipTimer = window.setTimeout(() => showTip(item, target), TIP_DELAY);
  }

  function showTip(item, target) {
    const label = item.type === "note" ? "便签" : "高亮";
    el.tip.innerHTML =
      `<div class="r-tip-head"><span class="r-dotview" style="background:${
        COLOR_HEX[item.color] || COLOR_HEX.yellow
      }"></span>第 ${item.page} 页 · ${label}</div>` +
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
    for (const sheet of state.sheets) {
      if (!sheet.painted && !sheet.textReady) continue;
      if (pages && !pages.has(sheet.no)) continue;
      renderSheetAnnotations(sheet);
    }
  }

  function renderNotesList() {
    el.annoCount.textContent = String(state.items.length);
    if (!state.items.length) {
      el.panelNotes.innerHTML =
        '<p class="r-empty">还没有批注。<br>选中正文即可高亮，<br>或用「批注」工具在页面上做便签。<br>' +
        "划线带备注时行尾会出现便签标志，<br>鼠标悬停即可预览。</p>";
      return;
    }
    const sorted = [...state.items].sort((a, b) => a.page - b.page || a.created - b.created);
    el.panelNotes.innerHTML = sorted
      .map(
        (item) => `
        <article class="r-card" data-id="${item.id}">
          <div class="r-card-top">
            <span class="r-badge-page">第 ${item.page} 页 · ${item.type === "note" ? "便签" : "高亮"}</span>
            <span class="r-dotview ${item.color}" style="background:${
              COLOR_HEX[item.color] || COLOR_HEX.yellow
            }"></span>
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

  function persist() {
    el.saved.textContent = "保存中…";
    el.saved.classList.remove("ok");
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      const sent = state.items;
      try {
        const result = await api("/api/annotations", {
          method: "POST",
          body: { path: docPath, items: state.items },
        });
        /* A slower response must not overwrite edits made while it was in
           flight; those already have their own save queued. */
        if (state.items === sent) {
          state.items = result.items || state.items;
          /* The response carries fresh item objects, so the per-page index has
             to be rebuilt — otherwise marks keep painting from stale copies. */
          reindex();
          renderNotesList();
          refreshAnnotations();
        }
        el.saved.textContent = "已保存";
        el.saved.classList.add("ok");
      } catch (error) {
        el.saved.textContent = "保存失败";
        toast(error.message, "bad");
      }
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
    renderNotesList();
    if (imported) {
      toast(`已从 PDF 读取 ${items.length} 条批注`, "good");
      persist();
    }
  }

  function addAnnotation(patch) {
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
    persist();
    return item;
  }

  function removeAnnotation(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.items.splice(index, 1);
    if (state.activeId === id) closeEditor(true);
    reindex();
    persist();
    refreshAnnotations(pagesOfItem(item));
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
      for (const rect of span.rects) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        pageRects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top - box.top) / state.scale,
          w: rect.width / state.scale,
          h: rect.height / state.scale,
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
  }

  function hideSelectionToolbar() {
    if (el.selToolbar.hidden) return;
    el.selToolbar.hidden = true;
    state.pending = null;
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
        return;
      }
      state.pending = captured;
      showSelectionToolbar(captured.anchor);
    }, 0);
  }

  function highlightSelection(color) {
    const captured = state.pending;
    if (!captured) return null;
    const item = addAnnotation({
      type: "highlight",
      page: captured.parts[0].page,
      color,
      rects: captured.rects,
      ranges: captured.parts,
      text: captured.text,
    });
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    hideSelectionToolbar();
    refreshAnnotations(captured.parts.map((part) => part.page));
    renderNotesList();
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
    state.activeId = id;
    el.editor.hidden = false;
    el.editorPage.textContent = `第 ${item.page} 页 · ${item.type === "note" ? "便签" : "高亮"}`;
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
        item.comment = text;
        item.updated = Date.now() / 1000;
        persist();
        refreshAnnotations(pagesOfItem(item));
        renderNotesList();
      }
    }
    state.activeId = null;
    el.editor.hidden = true;
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
    if (item.type === "note") {
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
      if (item.type === "note") {
        lines.push(`- **便签**：${item.comment || "（空）"}`);
      } else {
        lines.push(`- **高亮（${COLOR_LABEL[item.color] || ""}）**：${item.text || "（无选中文字）"}`);
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

    el.sidebarBtn.addEventListener("click", () => {
      const hidden = el.sidebar.hidden;
      el.sidebar.hidden = !hidden;
      el.sidebarBtn.setAttribute("aria-pressed", String(hidden));
      if (state.fit) setTimeout(() => relayout(scrollAnchor()), 30);
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
      if (window.getSelection() && !window.getSelection().isCollapsed) return;
      if (event.target.closest(".r-note")) return;

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


    el.selToolbar.addEventListener("mousedown", (event) => event.preventDefault());
    for (const dot of $$(".r-dot[data-color]", el.selToolbar)) {
      dot.addEventListener("click", (event) => {
        event.stopPropagation();
        highlightSelection(dot.dataset.color);
      });
    }
    el.selNote.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = highlightSelection("pink");
      if (item) openEditor(item.id, event);
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
    for (const dot of $$(".r-dot", el.editorColors)) {
      dot.addEventListener("click", () => {
        const item = state.items.find((entry) => entry.id === state.activeId);
        if (!item) return;
        item.color = dot.dataset.color;
        item.updated = Date.now() / 1000;
        for (const other of $$(".r-dot", el.editorColors)) {
          other.classList.toggle("on", other === dot);
        }
        persist();
        refreshAnnotations(pagesOfItem(item));
        renderNotesList();
      });
    }

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
      if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        savePdf();
        return;
      }
      if (tag === "input" || tag === "textarea") return;
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

  bindEvents();
  boot();
})();
