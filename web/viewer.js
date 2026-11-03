/* BabelDOC Studio — built-in PDF reader.
 *
 * The document scrolls continuously, page after page, so reading never stops
 * at a page boundary and a selection can run from one page into the next.
 * Highlights are painted from character ranges over the PDF.js text layer
 * (CSS Custom Highlight API) rather than approximated with rectangles, so they
 * follow the glyphs exactly, never leave gaps between characters and never
 * bleed onto the neighbouring line.
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

  const AHEAD = 1100; /* px of pages kept rendered above / below the viewport */
  const KEEP = 6; /* pages kept in memory on either side of the reader */

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
      buildThumbs();
      goToPage(1, false);
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
  }

  function sizeSheets() {
    for (const sheet of state.sheets) {
      if (sheet.painted) continue;
      const dims = state.dims.get(sheet.no) || state.base;
      sheet.box.style.width = `${Math.round(dims.w * state.scale)}px`;
      sheet.box.style.height = `${Math.round(dims.h * state.scale)}px`;
    }
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
    const stageTop = el.stage.getBoundingClientRect().top;
    const top = -AHEAD;
    const bottom = el.stage.clientHeight + AHEAD;
    const out = [];
    for (const sheet of state.sheets) {
      const rect = sheet.el.getBoundingClientRect();
      if (rect.bottom - stageTop < top) continue;
      if (rect.top - stageTop > bottom) continue;
      out.push(sheet);
    }
    return out;
  }

  function scrollAnchor() {
    const stageTop = el.stage.getBoundingClientRect().top;
    for (const sheet of state.sheets) {
      const rect = sheet.el.getBoundingClientRect();
      if (rect.bottom > stageTop + 1) {
        return {
          page: sheet.no,
          frac: clamp((stageTop - rect.top) / Math.max(1, rect.height), 0, 1),
        };
      }
    }
    return { page: 1, frac: 0 };
  }

  function restoreAnchor(anchor) {
    const sheet = state.sheets[anchor.page - 1];
    if (!sheet) return;
    const stageTop = el.stage.getBoundingClientRect().top;
    const top = sheet.el.getBoundingClientRect().top - stageTop + el.stage.scrollTop;
    el.stage.scrollTop = Math.max(0, top + anchor.frac * sheet.el.getBoundingClientRect().height - 12);
  }

  /* -------------------------------------------------------------- paint -- */
  async function paint(sheet) {
    if (!state.pdf || !sheet) return;
    if (sheet.busy) {
      sheet.dirty = true;
      return;
    }
    const scale = state.scale;
    if (sheet.painted && sheet.renderScale === scale && sheet.textReady && sheet.textScale === scale) {
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

      sheet.box.style.width = `${viewport.width}px`;
      sheet.box.style.height = `${viewport.height}px`;

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

      if (!sheet.textReady || sheet.textScale !== scale) {
        await buildText(sheet, page, viewport);
        if (state.scale !== scale) {
          sheet.dirty = true;
          return;
        }
        sheet.textScale = scale;
        migrateLegacy();
      }
      renderSheetAnnotations(sheet);
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
    const stageTop = el.stage.getBoundingClientRect().top;
    const top = sheet.el.getBoundingClientRect().top - stageTop + el.stage.scrollTop - 12;
    el.stage.scrollTo({
      top: Math.max(0, top),
      behavior: smooth && !reduceMotion() ? "smooth" : "auto",
    });
    state.page = target;
    syncPageUI();
    paint(sheet);
  }

  function currentSheet() {
    const stageTop = el.stage.getBoundingClientRect().top;
    const probe = stageTop + Math.min(el.stage.clientHeight * 0.35, 280);
    let best = state.sheets[0];
    for (const sheet of state.sheets) {
      if (sheet.el.getBoundingClientRect().bottom >= probe) return sheet;
      best = sheet;
    }
    return best;
  }

  function onScroll() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      const sheet = currentSheet();
      if (sheet && sheet.no !== state.page) {
        state.page = sheet.no;
        syncPageUI();
      }
      prune();
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
  }

  function updateThumbSelection() {
    for (const thumb of $$(".r-thumb", el.panelThumbs)) {
      const current = Number(thumb.dataset.page) === state.page;
      thumb.classList.toggle("current", current);
      if (current && el.panelThumbs.offsetParent) {
        const panel = el.panelThumbs.getBoundingClientRect();
        const box = thumb.getBoundingClientRect();
        if (box.top < panel.top + 8 || box.bottom > panel.bottom - 8) {
          el.panelThumbs.scrollTop += box.top - panel.top - panel.height / 2 + box.height / 2;
        }
      }
    }
  }

  /* -------------------------------------------------------- thumbnails -- */
  function buildThumbs() {
    el.panelThumbs.innerHTML = "";
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
    while (state.thumbQueue.length) {
      const button = state.thumbQueue.shift();
      if (!button.dataset.done) await renderThumb(button);
    }
    state.thumbBusy = false;
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

  function renderSheetAnnotations(sheet) {
    sheet.anno.innerHTML = "";
    const scale = state.scale;
    for (const item of state.items) {
      if (item.type === "highlight") {
        let bands;
        if (item.ranges && item.ranges.length) {
          if (!item.ranges.some((part) => part.page === sheet.no)) continue;
          bands = bandsFromRects(annotationRects(sheet, item), sheet);
        } else {
          if (item.page !== sheet.no) continue;
          bands = legacyBands(item.rects || []);
        }
        for (const rect of bands) {
          const mark = document.createElement("div");
          mark.className = `r-mark ${item.color}${state.flashId === item.id ? " flash" : ""}`;
          mark.dataset.id = item.id;
          mark.style.left = `${rect.x * scale}px`;
          mark.style.top = `${rect.y * scale}px`;
          mark.style.width = `${rect.w * scale}px`;
          mark.style.height = `${rect.h * scale}px`;
          sheet.anno.appendChild(mark);
        }
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
        marker.title = item.comment || "空便签";
        marker.addEventListener("click", (event) => {
          event.stopPropagation();
          openEditor(item.id, event);
        });
        sheet.anno.appendChild(marker);
      }
    }
  }

  /* A highlight may run across pages, so colour/comment changes have to
     repaint every page it touches. */
  function pagesOf(item) {
    if (item.ranges && item.ranges.length) {
      return [...new Set(item.ranges.map((part) => part.page))];
    }
    return [item.page];
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
        '<p class="r-empty">还没有批注。<br>选中正文即可高亮，<br>或用「批注」工具在页面上做便签。</p>';
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
              { yellow: "#ffd54a", green: "#74dc9e", blue: "#7cc4ff", pink: "#ff9ec7" }[item.color]
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
      try {
        const result = await api("/api/annotations", {
          method: "POST",
          body: { path: docPath, items: state.items },
        });
        state.items = result.items || state.items;
        el.saved.textContent = "已保存";
        el.saved.classList.add("ok");
        renderNotesList();
        refreshAnnotations();
      } catch (error) {
        el.saved.textContent = "保存失败";
        toast(error.message, "bad");
      }
    }, 450);
  }

  async function loadAnnotations() {
    try {
      const data = await api(`/api/annotations?${new URLSearchParams({ path: docPath })}`);
      state.items = data.items || [];
    } catch (error) {
      toast(`批注读取失败：${error.message}`, "bad");
    }
    renderNotesList();
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
    persist();
    return item;
  }

  function removeAnnotation(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.items.splice(index, 1);
    if (state.activeId === id) closeEditor(true);
    persist();
    refreshAnnotations(pagesOf(item));
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
      for (const rect of span.rects) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        rects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top - box.top) / state.scale,
          w: rect.width / state.scale,
          h: rect.height / state.scale,
        });
      }
    }
    if (!parts.length) return null;

    const clientRects = range.getClientRects();
    const last = clientRects[clientRects.length - 1];
    return {
      parts,
      rects: legacyBands(rects),
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
    const offset = offsetAtPoint(sheet, clientX, clientY);
    if (offset != null) {
      const hits = state.items.filter(
        (item) =>
          item.type === "highlight" &&
          (item.ranges || []).some(
            (part) => part.page === sheet.no && offset >= part.start && offset <= part.end
          )
      );
      if (hits.length) return hits[hits.length - 1];
    }
    const point = pointToPage(sheet, clientX, clientY);
    const legacy = state.items.filter(
      (item) =>
        item.type === "highlight" &&
        !(item.ranges && item.ranges.length) &&
        item.page === sheet.no &&
        (item.rects || []).some(
          (rect) =>
            point.x >= rect.x &&
            point.x <= rect.x + rect.w &&
            point.y >= rect.y &&
            point.y <= rect.y + rect.h
        )
    );
    return legacy.length ? legacy[legacy.length - 1] : null;
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
        refreshAnnotations(pagesOf(item));
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
    if (!sheet.painted || !sheet.textReady) await paint(sheet);
  }

  /* Where an annotation sits on its page, in PDF units.  Long highlights use
     their first line so the reader lands on readable text. */
  function annotationBounds(sheet, item) {
    if (item.type === "note") {
      const { x, y } = item.point || { x: 0, y: 0 };
      return { x: x - 6, y: y - 6, w: 12, h: 12 };
    }
    let bands = [];
    if (item.ranges && item.ranges.length) {
      bands = bandsFromRects(annotationRects(sheet, item), sheet);
    }
    if (!bands.length) bands = legacyBands(item.rects || []);
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
    const label = { yellow: "黄色", green: "绿色", blue: "蓝色", pink: "粉色" };
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
        lines.push(`- **高亮（${label[item.color] || ""}）**：${item.text || "（无选中文字）"}`);
        if (item.comment) lines.push(`  > ${item.comment.replace(/\n+/g, " ")}`);
      }
      lines.push("");
    }
    download(`${fileName(docPath).replace(/\.pdf$/i, "")}_批注.md`, lines.join("\n"));
    toast("已导出批注", "good");
  }

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

    el.exportBtn.addEventListener("click", exportMarkdown);

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
        refreshAnnotations(pagesOf(item));
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
        closeEditor();
        if (state.noteTool) {
          state.noteTool = false;
          el.noteTool.setAttribute("aria-pressed", "false");
          el.pages.classList.remove("note-mode");
        }
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
