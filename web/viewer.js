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
    toggleOriginal: $("#toggle-original"),
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
      const ghost = document.createElement("div");
      ghost.className = "r-ghost";
      const anno = document.createElement("div");
      anno.className = "r-anno";
      box.append(canvas, text, ghost, anno);
      section.append(box);
      fragment.append(section);

      state.sheets.push({
        no: number,
        el: section,
        box,
        canvas,
        text,
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
    try {
      analyseLayout(sheet, content.items, viewport);
    } catch {
      sheet.dual = false;
    }
    sheet.textReady = true;
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

  /* While the pointer is still dragging the selection has no text spans yet,
     so the counterpart is recomputed from the live client rects: the same
     geometry captureSelection() stores, without walking the text nodes. */
  function syncSelectionLive() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      clearSync();
      return;
    }
    const range = selection.getRangeAt(0);
    const byPage = new Map();
    for (const sheet of state.sheets) {
      if (!sheet.dual || !sheet.textReady) continue;
      let touches = false;
      try {
        touches = range.intersectsNode(sheet.text);
      } catch {
        touches = false;
      }
      if (!touches) continue;
      const box = sheet.box.getBoundingClientRect();
      const rects = [];
      for (const rect of range.getClientRects()) {
        if (rect.width < 0.5 || rect.height < 0.5) continue;
        rects.push({
          x: (rect.left - box.left) / state.scale,
          y: (rect.top - box.top) / state.scale,
          w: rect.width / state.scale,
          h: rect.height / state.scale,
        });
      }
      if (rects.length) byPage.set(sheet.no, legacyBands(rects));
    }
    renderSync(byPage);
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
    sheet.ghost.innerHTML = "";
    sheet.anno.innerHTML = "";
    sheet.lines = null;
    sheet.blocks = null;
    sheet.dual = false;
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
    clearSync();
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
          mark.dataset.style = item.style || "marker";
          mark.style.setProperty("--mark-color", COLOR_HEX[item.color]);
          mark.style.left = `${rect.x * scale}px`;
          mark.style.top = `${rect.y * scale}px`;
          mark.style.width = `${rect.w * scale}px`;
          mark.style.height = `${rect.h * scale}px`;
          fragment.appendChild(mark);
        }
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
  }

  /* --------------------------------------------------------- note preview -- */
  function scheduleTip(item, target) {
    window.clearTimeout(state.tipTimer);
    state.tipTimer = window.setTimeout(() => showTip(item, target), TIP_DELAY);
  }

  function showTip(item, target) {
    const label = ({note:"便签",highlight:"高亮",text:"文字",ink:"画笔"}[item.type] || "批注");
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
            <span class="r-badge-page">第 ${item.page} 页 · ${({note:"便签",highlight:"高亮",text:"文字",ink:"画笔"}[item.type] || "批注")}</span>
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
            el.saved.textContent = "部分未保存";
            el.saved.classList.remove("ok");
            toast("有批注没能保存：请重启应用后再试", "bad");
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
    renderNotesList();
    /* Pages may already be painted by the time annotations arrive, so repaint
       the marks instead of waiting for the next scroll or zoom. */
    refreshAnnotations();
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
    refreshDock();
  }

  function hideSelectionToolbar() {
    if (el.selToolbar.hidden) return;
    el.selToolbar.hidden = true;
    state.pending = null;
    clearSync();
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

  function highlightSelection(color) {
    const captured = state.pending;
    if (!captured) return null;
    const item = addAnnotation({
      type: "highlight",
      page: captured.parts[0].page,
      color,
      style: document.querySelector("#highlight-style").value,
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
    loadDrawingControls(item);
    el.editor.hidden = false;
    el.editorStyles.hidden = item.type !== "highlight";
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
        item.comment = text;
        item.updated = Date.now() / 1000;
        persist();
        refreshAnnotations(pagesOfItem(item));
        renderNotesList();
      }
    }
    state.activeId = null;
    el.editor.hidden = true;
    /* An empty text box would be invisible and un-clickable: drop it instead
       of leaving a stray annotation on the page. */
    if (item && item.type === "text" && !item.comment) {
      removeAnnotation(item.id);
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
    /* Live counterpart while the pointer is still dragging out a selection. */
    document.addEventListener("selectionchange", scheduleLiveSync);


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
  const control = id => document.getElementById(id);
  function storePrefs() { try { localStorage.setItem('babeldoc-reader', JSON.stringify(readerPrefs)); } catch {} }
  function cropSheet(sheet) {
    const dims = state.dims.get(sheet.no) || state.base;
    const crop = !originalVisible && dims.w > dims.h * 1.2;
    sheet.el.classList.toggle('translation-only', crop);
    sheet.el.style.width = crop ? `${sheet.width / 2}px` : '';
  }
  function setDrawingTool(tool) {
    if (tool === "note") {
      closeEditor();
      if (!state.noteTool) el.noteTool.click();
      refreshDock();
      return;
    }
    drawingTool = tool;
    control("draw-tool").value = tool;
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
    for (const button of $$("button[data-style]")) {
      const on = button.dataset.style === style;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    const dot = control("dock-ink-dot");
    if (dot) dot.style.background = control("ink-color").value;
    const paper = control("dock-paper");
    if (paper) paper.classList.toggle("on", (control("paper-theme").value || "white") !== "white");
    const original = control("toggle-original");
    if (original) {
      original.setAttribute("aria-pressed", String(originalVisible));
      const title = originalVisible ? "隐藏左侧原文（适用于左右对照 PDF）" : "显示左侧原文";
      original.title = title;
      original.setAttribute("aria-label", title);
    }
  }

  function setHighlightStyle(style) {
    if (!["marker", "underline", "pencil"].includes(style)) return;
    control("highlight-style").value = style;
    control("highlight-style").dispatchEvent(new Event("input", { bubbles: true }));
    refreshDock();
  }

  function drawingOptions() {
    return {inkColor:control('ink-color').value, width:clamp(+control('ink-width').value || 2,.5,30),
      opacity:+control('ink-opacity').value / 100, fontFamily:control('text-font').value,
      fontSize:clamp(+control('text-size').value || 18,8,96)};
  }
  function loadDrawingControls(item) {
    if (item.type === 'highlight') control('highlight-style').value = item.style || 'marker';
    if (['ink','text'].includes(item.type)) {
      control('ink-color').value = item.inkColor || '#30343b';
      control('ink-width').value = item.width || 2;
      control('ink-opacity').value = (item.opacity ?? 1)*100;
      control('text-size').value = item.fontSize || 18;
      if (![...control('text-font').options].some(o => o.value === item.fontFamily)) {
        control('text-font').add(new Option(item.fontFamily || 'sans-serif'));
      }
      control('text-font').value = item.fontFamily || 'sans-serif';
    }
    refreshDock();
  }
  function commitDrawing(item) {
    item.updated = Date.now()/1000;
    reindex(); refreshAnnotations([item.page]); renderNotesList(); persist();
  }
  function renderDrawing(item, sheet) {
    const scale = state.scale;
    if (item.type === 'text') {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'r-page-text'; node.dataset.id = item.id;
      node.textContent = item.comment || '点击编辑文字';
      node.title = '拖动移动 · 点击编辑';
      Object.assign(node.style, {left:`${item.point.x*scale}px`,top:`${item.point.y*scale}px`,color:item.inkColor,
        opacity:item.opacity ?? 1,fontFamily:item.fontFamily || 'sans-serif',fontSize:`${(item.fontSize || 18)*scale}px`});
      bindMovable(node,item,sheet);
      node.addEventListener('click',event=>{event.stopPropagation();openEditor(item.id,event);});
      return node;
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.classList.add('r-ink'); svg.setAttribute('width',sheet.width); svg.setAttribute('height',sheet.height);
    const path = document.createElementNS(svg.namespaceURI,'path');
    path.dataset.id = item.id;
    path.setAttribute('d',(item.points || []).map((p,i)=>`${i?'L':'M'}${p.x*scale},${p.y*scale}`).join(' '));
    path.setAttribute('fill','none');path.setAttribute('stroke',item.inkColor || '#30343b');
    path.setAttribute('stroke-width',(item.width || 2)*scale);path.setAttribute('stroke-opacity',item.opacity ?? 1);
    path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');
    path.addEventListener('click',event=>{event.stopPropagation(); if(drawingTool==='select')openEditor(item.id,event);});
    svg.append(path); return svg;
  }
  function bindMovable(node,item,sheet) {
    node.addEventListener('pointerdown',event=>{
      if (event.button !== 0 || drawingTool !== 'select' || state.noteTool) return;
      event.stopPropagation(); event.preventDefault();
      const start = {x:event.clientX,y:event.clientY}; const point = {...item.point}; let moved=false;
      node.setPointerCapture(event.pointerId);
      const move = e => {
        if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<4 && !moved)return;
        moved=true; hideTip();
        item.point={x:clamp(point.x+(e.clientX-start.x)/state.scale,0,sheet.width/state.scale-8),
          y:clamp(point.y+(e.clientY-start.y)/state.scale,0,sheet.height/state.scale-8)};
        node.style.left=`${item.point.x*state.scale}px`;node.style.top=`${item.point.y*state.scale}px`;
      };
      const end = e => {
        node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);
        if(e.type==='pointercancel') {item.point=point;refreshAnnotations([item.page]);return;}
        if(moved) {node.addEventListener('click',e=>{e.stopImmediatePropagation();e.preventDefault();},{once:true,capture:true});commitDrawing(item);}
      };
      node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);
    });
  }
  function setupReaderTools() {
    window.addEventListener("beforeunload", (event) => {
      const active = state.items.find((item) => item.id === state.activeId);
      if (savedRevision !== saveRevision || (active && el.editorText.value.trim() !== active.comment)) {
        event.preventDefault();
        event.returnValue = "";
      }
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
    control("paper-theme").onchange = applyPaper;
    control("paper-color").oninput = () => {
      control("paper-theme").value = "custom";
      applyPaper();
    };
    applyPaper();

    el.toggleOriginal.addEventListener("click", () => {
      if (!state.pdf || state.base.w <= state.base.h * 1.2) {
        toast("此开关适用于原文在左、译文在右的左右对照 PDF");
        return;
      }
      originalVisible = !originalVisible;
      clearSync();
      closeEditor();
      hideSelectionToolbar();
      relayout(scrollAnchor());
      refreshDock();
    });

    /* ----------------------------------------------------- colour tags -- */
    const labels = {
      yellow: "疑问",
      green: "结论",
      red: "重点",
      blue: "证据",
      pink: "灵感",
      orange: "待办",
      purple: "定义",
      teal: "方法",
      ...readerPrefs.labels,
    };
    control("color-hints").checked = readerPrefs.hints !== false;
    function updateHints() {
      document.querySelectorAll(".r-dot[data-color]").forEach((dot) => {
        const label = `${COLOR_LABEL[dot.dataset.color]} · ${labels[dot.dataset.color]}`;
        dot.title = control("color-hints").checked ? label : COLOR_LABEL[dot.dataset.color];
        dot.setAttribute("aria-label", label);
        if (control("color-hints").checked) dot.dataset.hint = labels[dot.dataset.color];
        else delete dot.dataset.hint;
      });
      readerPrefs.labels = labels;
      readerPrefs.hints = control("color-hints").checked;
      storePrefs();
    }
    control("color-hints").onchange = updateHints;
    updateHints();

    api("/api/fonts")
      .then((data) => {
        for (const font of data.fonts || []) {
          if (![...control("text-font").options].some((o) => o.value === font)) {
            control("text-font").add(new Option(font));
          }
        }
      })
      .catch(() => {});

    control("draw-tool").onchange = () => {
      closeEditor();
      setDrawingTool(control("draw-tool").value);
    };
    for (const id of ["ink-color", "ink-width", "ink-opacity", "text-font", "text-size", "highlight-style"]) {
      control(id).oninput = () => {
        const item = state.items.find((a) => a.id === state.activeId);
        if (!item) return;
        if (item.type === "highlight") item.style = control("highlight-style").value;
        else if (["text", "ink"].includes(item.type)) Object.assign(item, drawingOptions());
        commitDrawing(item);
      };
    }
    control("ink-color").addEventListener("input", refreshDock);
    el.noteTool.addEventListener("click", refreshDock);

    /* ------------------------------------------------------ popovers -- */
    let popAnchor = null;
    function closePopover() {
      if (!el.pop || el.pop.hidden) return;
      el.pop.hidden = true;
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
    function openPopover(kind, anchor) {
      if (!el.pop || !anchor) return;
      if (popAnchor === anchor && !el.pop.hidden) {
        closePopover();
        return;
      }
      if (popAnchor) popAnchor.setAttribute("aria-expanded", "false");
      popAnchor = anchor;
      anchor.setAttribute("aria-expanded", "true");
      renderPopover(kind);
      el.pop.hidden = false;
      positionPopover(anchor);
    }
    function renderPopover(kind) {
      if (kind === "ink") return renderInkPopover();
      if (kind === "text") return renderTextPopover();
      if (kind === "paper") return renderPaperPopover();
      return renderLegendPopover();
    }

    const INK_COLORS = ["#30343b", "#6b7280", "#0a84ff", "#30b158", "#ff9f0a", "#ff375f", "#bf5af2", "#00c7be"];
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

    function renderTextPopover() {
      el.pop.innerHTML =
        '<p class="r-pop-title">字体与字号</p>' +
        '<p class="r-pop-sub">用于「页面文字」工具输入的文字。</p>' +
        '<label class="r-pop-row"><span>字体</span><select id="pop-font"></select></label>' +
        '<label class="r-pop-row"><span>字号</span><input id="pop-size" type="number" min="8" max="96"></label>';
      const select = el.pop.querySelector("#pop-font");
      select.replaceChildren(...[...control("text-font").options].map((option) => new Option(option.value, option.value)));
      select.value = control("text-font").value;
      select.addEventListener("change", () => {
        control("text-font").value = select.value;
        control("text-font").dispatchEvent(new Event("input", { bubbles: true }));
      });
      const size = el.pop.querySelector("#pop-size");
      size.value = control("text-size").value;
      size.addEventListener("input", () => {
        if (!size.value) return;
        control("text-size").value = size.value;
        control("text-size").dispatchEvent(new Event("input", { bubbles: true }));
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

    function renderLegendPopover() {
      const rows = Object.keys(COLOR_HEX)
        .map(
          (key) =>
            `<label class="r-pop-item"><span class="r-dotview" style="background:${COLOR_HEX[key]}"></span>` +
            `<span>${COLOR_LABEL[key]}</span>` +
            `<input data-legend="${key}" maxlength="12" value="${escapeHtml(labels[key])}"></label>`
        )
        .join("");
      el.pop.innerHTML =
        '<p class="r-pop-title">颜色标签</p>' +
        '<p class="r-pop-sub">给每种颜色写一句用途说明，鼠标停在色点上就能看到。</p>' +
        `<div class="r-pop-list">${rows}</div>` +
        '<label class="r-pop-check"><input type="checkbox" id="pop-hints"> 显示功能提示</label>';
      for (const input of el.pop.querySelectorAll("[data-legend]")) {
        input.addEventListener("input", () => {
          labels[input.dataset.legend] = input.value;
          updateHints();
        });
      }
      const hints = el.pop.querySelector("#pop-hints");
      hints.checked = control("color-hints").checked;
      hints.addEventListener("change", () => {
        control("color-hints").checked = hints.checked;
        updateHints();
      });
    }

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!popAnchor || el.pop.hidden) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && (target.closest("#r-pop") || target === popAnchor)) return;
        closePopover();
      },
      true
    );

    /* ------------------------------------------------------------ dock -- */
    if (el.dock) {
      el.dock.addEventListener("mousedown", (event) => event.stopPropagation());
      for (const button of el.dock.querySelectorAll("[data-tool]")) {
        button.addEventListener("click", () => {
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
        });
      }
      control("dock-ink").addEventListener("click", () => openPopover("ink", control("dock-ink")));
      control("dock-text").addEventListener("click", () => openPopover("text", control("dock-text")));
      control("dock-paper").addEventListener("click", () => openPopover("paper", control("dock-paper")));
      control("dock-legend").addEventListener("click", () => openPopover("legend", control("dock-legend")));
    }
    el.pop.addEventListener("mousedown", (event) => event.stopPropagation());
    for (const button of $$("button[data-style]")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setHighlightStyle(button.dataset.style);
      });
    }
    refreshDock();

    /* ----------------------------------------------------------- page -- */
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
    el.pages.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0 || drawingTool === "select") return;
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
          /* Placing text must never leave the sticky-note tool armed. */
          state.noteTool = false;
          el.noteTool.setAttribute("aria-pressed", "false");
          el.pages.classList.remove("note-mode");
          const item = addAnnotation({ type: "text", page: sheet.no, point: start, ...drawingOptions() });
          commitDrawing(item);
          setDrawingTool("select");
          suppressPageClick = true;
          openEditor(item.id, event);
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

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closePopover();
        if (state.noteTool) el.noteTool.click();
        setDrawingTool("select");
      }
    });
    document.addEventListener("contextmenu", (event) => {
      if (event.target.closest("input,textarea,[contenteditable=true]")) return;
      event.preventDefault();
      closeMenu();
      closePopover();
      const choices = [
        ["select", "选择 / 移动"],
        ["note", "便签"],
        ["text", "页面文字"],
        ["pen", "自由画"],
        ["line", "直线"],
        ["erase", "橡皮擦（整笔）"],
      ];
      el.menu.replaceChildren();
      for (const [tool, label] of choices) {
        const button = document.createElement("button");
        button.textContent = label;
        button.type = "button";
        button.onclick = () => {
          closeMenu();
          if (tool === "note") {
            if (!state.noteTool) el.noteTool.click();
          } else {
            setDrawingTool(tool);
          }
        };
        el.menu.append(button);
      }
      el.menu.hidden = false;
      const box = el.menu.getBoundingClientRect();
      el.menu.style.left = `${clamp(event.clientX, 8, innerWidth - box.width - 8)}px`;
      el.menu.style.top = `${clamp(event.clientY, 8, innerHeight - box.height - 8)}px`;
    });
  }

  bindEvents();
  setupReaderTools();
  boot();
})();
