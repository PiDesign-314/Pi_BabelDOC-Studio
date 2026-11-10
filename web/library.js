/* BabelDOC Studio — result library (browse, read, collections, clean up). */
(() => {
  "use strict";

  const {
    $, $$, api, toast, escapeHtml, formatSize, formatTime, fileName, bindTheme,
  } = window.Studio;

  const el = {
    count: $("#lib-count"),
    title: $("#lib-title"),
    sub: $("#lib-sub"),
    search: $("#search"),
    sort: $("#sort"),
    addDir: $("#btn-add-dir"),
    addDir2: $("#btn-add-dir-2"),
    dirs: $("#dirs"),
    grid: $("#grid"),
    empty: $("#empty"),
    emptyTitle: $("#empty-title"),
    emptyText: $("#empty-text"),
    emptyActions: $("#empty-actions"),
    rail: $("#rail"),
    railList: $("#rail-list"),
    railEmpty: $("#rail-empty"),
    railNew: $("#btn-new-collection"),
    countAll: $("#count-all"),
    countUnfiled: $("#count-unfiled"),
    zoteroBlock: $("#zotero-block"),
    zoteroSynced: $("#zotero-synced"),
    zoteroAll: $("#zotero-all"),
    zoteroCountAll: $("#zotero-count-all"),
    zoteroTree: $("#zotero-tree"),
    zoteroHint: $("#zotero-hint"),
    zoteroRefresh: $("#btn-zotero-refresh"),
    pop: $("#collect-pop"),
    popList: $("#collect-list"),
    popTarget: $("#collect-target"),
    popForm: $("#collect-form"),
    popName: $("#collect-name"),
  };

  const state = {
    items: [],
    dirs: [],
    extraDirs: [],
    collections: [],
    query: "",
    resultsQuery: "",
    sort: "recent",
    filter: "all",
    timer: null,
    collectId: null,
    dragId: null,
    /* Zotero 文库 view: `view` switches the main list between BabelDOC results
       and Zotero items; `zfilter` is "all" or a collection id (string). */
    view: "results",
    zotero: null,
    zoteroMissing: true,
    zfilter: "all",
    zcollapsed: new Set(),
    zbusy: new Set(),
  };

  const VIEW_KEY = "readpi-library-view";
  let savedView = null;
  try {
    savedView = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
    if (savedView && typeof savedView === "object") {
      state.view = savedView.view === "zotero" ? "zotero" : "results";
      state.filter = String(savedView.filter || "all");
      state.zfilter = String(savedView.zfilter || "all");
      state.query = String(savedView.query || "");
      state.sort = ["recent", "name", "size"].includes(savedView.sort)
        ? savedView.sort : "recent";
      el.search.value = state.query;
    }
  } catch { savedView = null; }
  window.addEventListener("pagehide", () => {
    sessionStorage.setItem(VIEW_KEY, JSON.stringify({
      view: state.view, filter: state.filter, zfilter: state.zfilter,
      query: state.query, sort: state.sort, scrollY: window.scrollY,
    }));
  });

  const RESULTS_SUB = "同篇论文的译文、双语稿与术语表归在一起。";
  const ZOTERO_SUB = "Zotero 文库中的论文 PDF，可直接阅读或翻译。";
  const RESULTS_PLACEHOLDER = "搜索文件名…";
  const ZOTERO_PLACEHOLDER = "搜索标题、作者或 PDF 名…";

  bindTheme($("#btn-theme"));

  /* Inline icon set (SF-Symbols-like strokes, drawn locally — no assets). */
  const ico = {
    folder:
      '<svg class="rail-ico" viewBox="0 0 16 16" width="16" height="16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M1.9 4.3h4.2l1.2 1.4h6.8v6.4a1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1z"/></svg>',
    read:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2 3.4h3.2c.9 0 1.5.5 1.8 1 .3-.5.9-1 1.8-1H14v9H9c-.8 0-1.4.3-2 .9-.6-.6-1.2-.9-2-.9H2z"/>' +
      '<path d="M8 4.4v9"/></svg>',
    collect:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2 4.3h4l1.2 1.4h6.6v6a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.7z"/>' +
      '<path d="M7.9 7.4v4M5.9 9.4h4"/></svg>',
    reveal:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2 4.3h4l1.2 1.4h6.6v6a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.7z"/></svg>',
    rename:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M11.4 2.3 13.7 4.6 5.1 13.2H2.8v-2.3z"/><path d="m10 3.7 2.3 2.3"/></svg>',
    caret:
      '<svg viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m2.4 3.6 2.6 2.8 2.6-2.8"/></svg>',
    remove:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.8 4.4h10.4M6.4 4.4V3a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.4"/>' +
      '<path d="m4.2 4.4.6 8.6a.9.9 0 0 0 .9.8h4.6a.9.9 0 0 0 .9-.8l.6-8.6"/>' +
      '<path d="M6.7 7v4.2M9.3 7v4.2"/></svg>',
    check:
      '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.4 6.3 4.8 8.7 9.6 3.4"/></svg>',
  };

  /* ------------------------------------------------------- card menus -- */
  /* One floating menu serves the card context menu and both read drop-downs.
     It is appended to <body> (position:fixed), so the scrolling grid can never
     clip it; it closes on Escape, an outside press, a scroll or a resize. */
  let activeMenu = null;

  function closeCardMenu(options = {}) {
    if (!activeMenu) return;
    const { node, trigger } = activeMenu;
    activeMenu = null;
    node.remove();
    if (trigger && trigger.isConnected) {
      trigger.setAttribute("aria-expanded", "false");
      if (options.restoreFocus) trigger.focus({ preventScroll: true });
    }
  }

  function positionCardMenu(node, anchor) {
    const gap = 6;
    const margin = 8;
    const box = node.getBoundingClientRect();
    let left;
    let top;
    if (anchor.el) {
      const rect = anchor.el.getBoundingClientRect();
      left = rect.left;
      top = rect.bottom + gap;
      /* Anchor menus drop below the trigger, flipping above / left when the
         viewport edge is close (same idea as the collect popover). */
      if (left + box.width > window.innerWidth - margin) left = rect.right - box.width;
      if (top + box.height > window.innerHeight - margin) top = rect.top - box.height - gap;
    } else {
      const x = Number(anchor.x) || 0;
      const y = Number(anchor.y) || 0;
      left = x;
      top = y;
      if (left + box.width > window.innerWidth - margin) left = x - box.width;
      if (top + box.height > window.innerHeight - margin) top = y - box.height;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function onCardMenuKeydown(event, node) {
    const items = $$(".card-menu-item:not([disabled])", node);
    if (!items.length) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCardMenu({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      closeCardMenu({ restoreFocus: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" &&
        event.key !== "Home" && event.key !== "End") {
      return;
    }
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (index < 0) next = 0;
    else if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else next = (index - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  /* items: [{ label, hint, icon, checked, disabled, onSelect } | { separator }] */
  function openCardMenu(anchor, items) {
    closeCardMenu();
    closeCollect();
    const list = (items || []).filter(Boolean);
    if (!list.length) return null;

    const node = document.createElement("div");
    node.className = "card-menu";
    node.tabIndex = -1;
    node.setAttribute("role", "menu");
    node.setAttribute("aria-label", anchor.label || "卡片操作");
    node.style.visibility = "hidden";

    for (const item of list) {
      if (item.separator) {
        const line = document.createElement("div");
        line.className = "card-menu-sep";
        line.setAttribute("role", "separator");
        node.append(line);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-menu-item";
      button.tabIndex = -1;
      /* Variant lists are a single-choice set: mark the default with a radio
         role so the check mark is valid ARIA, not decoration on a plain item. */
      const radio = Boolean(item.radio || item.checked);
      button.setAttribute("role", radio ? "menuitemradio" : "menuitem");
      if (radio) button.setAttribute("aria-checked", String(Boolean(item.checked)));
      button.innerHTML =
        (item.icon ? `<span class="card-menu-ico" aria-hidden="true">${item.icon}</span>` : "") +
        `<span class="card-menu-label">${escapeHtml(item.label)}</span>` +
        (item.hint ? `<span class="card-menu-hint">${escapeHtml(item.hint)}</span>` : "") +
        (item.checked ? `<span class="card-menu-mark" aria-hidden="true">${ico.check}</span>` : "");
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
      }
      button.addEventListener("click", () => {
        if (button.disabled) return;
        const run = item.onSelect;
        closeCardMenu();
        if (run) run();
      });
      node.append(button);
    }

    document.body.append(node);
    positionCardMenu(node, anchor);
    node.style.visibility = "";
    node.addEventListener("keydown", (event) => onCardMenuKeydown(event, node));
    activeMenu = { node, trigger: anchor.trigger || null };
    if (activeMenu.trigger) activeMenu.trigger.setAttribute("aria-expanded", "true");
    ($$(".card-menu-item:not([disabled])", node)[0] || node).focus({ preventScroll: true });
    return node;
  }

  /* Toggle from a caret button: a second press closes the same menu. */
  function toggleCardMenu(trigger, buildItems, label) {
    if (activeMenu && activeMenu.trigger === trigger) {
      closeCardMenu({ restoreFocus: true });
      return;
    }
    const items = buildItems();
    if (!items || !items.length) return;
    openCardMenu({ el: trigger, trigger, label }, items);
  }

  document.addEventListener("pointerdown", (event) => {
    if (!activeMenu) return;
    if (activeMenu.node.contains(event.target)) return;
    /* The trigger toggles its own menu on click; closing here would reopen it. */
    if (activeMenu.trigger && activeMenu.trigger.contains(event.target)) return;
    closeCardMenu();
  }, true);

  /* A menu is anchored to viewport coordinates, so a real scroll invalidates
     it.  Programmatic scrolling of an `overflow: hidden` box (the card grid
     clips its children) is not a user scroll and must not close the menu. */
  function isUserScroll(target) {
    if (target === document || target === document.documentElement ||
        target === document.body || target === window) {
      return true;
    }
    if (!(target instanceof Element)) return false;
    const style = window.getComputedStyle(target);
    return /auto|scroll|overlay/.test(`${style.overflowY} ${style.overflowX}`);
  }

  window.addEventListener("scroll", (event) => {
    if (!activeMenu) return;
    if (activeMenu.node.contains(event.target)) return;
    if (!isUserScroll(event.target)) return;
    closeCardMenu();
  }, true);

  window.addEventListener("resize", () => closeCardMenu());

  /* -------------------------------------------------------------- load -- */
  async function load() {
    const params = new URLSearchParams({ q: state.query, sort: state.sort });
    try {
      const data = await api(`/api/library?${params.toString()}`);
      state.items = data.items || [];
      state.dirs = data.dirs || [];
      state.extraDirs = data.extra_dirs || [];
      state.collections = data.collections || [];
      state.resultsQuery = state.query;
      if (state.filter !== "all" && state.filter !== "unfiled") {
        if (!state.collections.some((entry) => entry.id === state.filter)) state.filter = "all";
      }
      renderDirs();
      renderRail();
      render();
    } catch (error) {
      toast(`读取结果库失败：${error.message}`, "bad");
    }
  }

  /* The Zotero 文库 snapshot is pushed by the add-on; this page only reads it.
     A missing snapshot is a normal state, a failed read must never break the
     result library. */
  async function loadZotero(options = {}) {
    try {
      const data = await api("/api/zotero/library");
      state.zotero = data && typeof data === "object" ? data : null;
      state.zoteroMissing = !state.zotero || Boolean(state.zotero.missing);
      const collections = (state.zotero && state.zotero.collections) || [];
      if (
        state.zfilter !== "all" &&
        !collections.some((entry) => String(entry.id) === String(state.zfilter))
      ) {
        state.zfilter = "all";
      }
      if (state.zoteroMissing && state.view === "zotero") {
        state.view = "results";
        state.filter = "all";
      }
      if (options.notify) toast("已更新 Zotero 文库", "good");
    } catch (error) {
      state.zotero = null;
      state.zoteroMissing = true;
      if (state.view === "zotero") {
        state.view = "results";
        state.filter = "all";
      }
      if (!options.silent) toast(`读取 Zotero 文库失败：${error.message}`, "bad");
    }
    renderZoteroRail();
    render();
  }

  async function addFolder() {
    try {
      const picked = await api("/api/pick", { method: "POST", body: { mode: "dir" } });
      const folder = (picked.paths || [])[0];
      if (!folder) return;
      await api("/api/library/dirs", { method: "POST", body: { path: folder } });
      await load();
      toast("已添加文件夹", "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function removeFolder(folder) {
    try {
      await api("/api/library/dirs", { method: "DELETE", body: { path: folder } });
      await load();
      toast("不再扫描这个文件夹");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ------------------------------------------------------- collections -- */
  function collectionById(id) {
    return state.collections.find((entry) => entry.id === id) || null;
  }

  function countIn(id) {
    return state.items.filter((item) => (item.collections || []).includes(id)).length;
  }

  function currentTitle() {
    if (state.filter === "all") return "全部结果";
    if (state.filter === "unfiled") return "未分类";
    const entry = collectionById(state.filter);
    return entry ? entry.name : "全部结果";
  }

  async function createCollection(name) {
    const data = await api("/api/collections", { method: "POST", body: { name } });
    state.collections = data.collections || state.collections;
    return data.collection;
  }

  async function deleteCollection(id) {
    const entry = collectionById(id);
    if (!entry) return;
    if (!window.confirm(`删除合集「${entry.name}」？\n论文本身不会被删除，只是不再归在这个合集里。`)) {
      return;
    }
    try {
      const data = await api(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.collections = data.collections || [];
      if (state.filter === id) state.filter = "all";
      await load();
      toast("已删除合集", "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function renameCollection(id, name) {
    try {
      const data = await api(`/api/collections/${encodeURIComponent(id)}`, {
        method: "POST",
        body: { name },
      });
      state.collections = data.collections || state.collections;
      await load();
      toast("已重命名合集", "good");
    } catch (error) {
      toast(error.message, "bad");
      await load();
    }
  }

  function startCollectionRename(row, entry) {
    const nameNode = row.querySelector(".rail-name");
    if (!nameNode) return;
    const input = document.createElement("input");
    input.className = "rail-input";
    input.value = entry.name;
    input.maxLength = 40;
    nameNode.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      if (!commit || !value || value === entry.name) {
        load();
        return;
      }
      renameCollection(entry.id, value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function startRailNew() {
    const existing = el.railList.querySelector(".rail-new");
    if (existing) {
      existing.querySelector("input").focus();
      return;
    }
    const row = document.createElement("div");
    row.className = "rail-new";
    row.innerHTML =
      '<input type="text" maxlength="40" placeholder="合集名称" autocomplete="off">' +
      '<button type="button" title="创建">✓</button>';
    el.railList.append(row);
    el.railEmpty.hidden = true;
    const input = row.querySelector("input");
    input.focus();
    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      const value = input.value.trim();
      if (!commit || !value) {
        settled = true;
        row.remove();
        el.railEmpty.hidden = state.collections.length > 0;
        return;
      }
      settled = true;
      try {
        const entry = await createCollection(value);
        row.remove();
        /* stay on the current view: the new collection is empty and the user
           needs to see the papers to file them */
        await load();
        toast(`已创建合集「${entry ? entry.name : value}」`, "good");
      } catch (error) {
        settled = false;
        input.focus();
        toast(error.message, "bad");
      }
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    row.querySelector("button").addEventListener("mousedown", (event) => {
      event.preventDefault();
      finish(true);
    });
  }

  /* ------------------------------------------------------------ render -- */
  function renderDirs() {
    if (!state.dirs.length) {
      el.dirs.hidden = true;
      return;
    }
    el.dirs.hidden = false;
    el.dirs.innerHTML = state.dirs
      .map((folder) => {
        const removable = state.extraDirs.some(
          (item) => item.toLowerCase() === folder.toLowerCase()
        );
        const label = folder.split(/[\\/]/).filter(Boolean).pop() || folder;
        return `<span class="lib-dir" title="${escapeHtml(folder)}">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.8 4.2h4l1.2 1.4h7.2v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>
          </svg>
          <span>${escapeHtml(label)}</span>
          ${
            removable
              ? `<button class="lib-dir-x" type="button" data-dir="${escapeHtml(folder)}"
                         title="不再扫描" aria-label="不再扫描 ${escapeHtml(label)}">✕</button>`
              : ""
          }
        </span>`;
      })
      .join("");
  }

  function renderRail() {
    el.countAll.textContent = String(state.items.length);
    el.countUnfiled.textContent = String(
      state.items.filter((item) => !(item.collections || []).length).length
    );
    for (const button of $$(".rail-item[data-filter]", el.rail)) {
      const filter = button.dataset.filter;
      const on = state.view === "results" && filter === state.filter;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    el.railEmpty.hidden = state.collections.length > 0;
    el.railList.innerHTML = state.collections
      .map((entry) => {
        const count = countIn(entry.id);
        const on = state.view === "results" && entry.id === state.filter;
        return `<div class="rail-item${on ? " on" : ""}"
                    data-filter="${entry.id}" role="button" tabindex="0"
                    title="拖拽论文到这里归入「${escapeHtml(entry.name)}」"
                    aria-pressed="${on}">
          ${ico.folder}
          <span class="rail-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</span>
          <em>${count}</em>
          <button class="rail-tool" type="button" data-edit="${entry.id}"
                  title="重命名合集" aria-label="重命名合集">✎</button>
          <button class="rail-tool" type="button" data-del="${entry.id}"
                  title="删除合集" aria-label="删除合集">✕</button>
        </div>`;
      })
      .join("");
  }

  /* ------------------------------------------------------- Zotero rail -- */
  function zoteroSnapshot() {
    return state.zoteroMissing ? null : state.zotero;
  }

  function zoteroCollections() {
    const snap = zoteroSnapshot();
    const list = (snap && snap.collections) || [];
    return list.filter((entry) => entry && entry.id !== undefined && entry.id !== null);
  }

  function zoteroCollectionById(id) {
    return zoteroCollections().find((entry) => String(entry.id) === String(id)) || null;
  }

  function zoteroTree() {
    const byId = new Map();
    const childrenOf = new Map();
    const roots = [];
    for (const entry of zoteroCollections()) byId.set(String(entry.id), entry);
    for (const entry of byId.values()) {
      const parent = String(entry.parent_id ?? 0);
      if (parent !== "0" && byId.has(parent)) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(entry);
      } else {
        roots.push(entry);
      }
    }
    const byName = (left, right) =>
      String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans");
    roots.sort(byName);
    for (const list of childrenOf.values()) list.sort(byName);
    return { roots, childrenOf };
  }

  function zoteroDescendantIds(id) {
    const ids = new Set([String(id)]);
    const { childrenOf } = zoteroTree();
    const walk = (current) => {
      for (const child of childrenOf.get(current) || []) {
        const key = String(child.id);
        if (ids.has(key)) continue;
        ids.add(key);
        walk(key);
      }
    };
    walk(String(id));
    return ids;
  }

  function zoteroCount(entry) {
    if (entry && Number.isFinite(Number(entry.count))) return Number(entry.count);
    const ids = zoteroDescendantIds(entry.id);
    const items = (zoteroSnapshot() && zoteroSnapshot().items) || [];
    return items.filter((item) =>
      (item.collections || []).some((id) => ids.has(String(id)))
    ).length;
  }

  function zoteroSyncLabel(snap) {
    const synced = Number(snap && snap.synced) || 0;
    if (!synced) return "";
    const date = new Date(synced * 1000);
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    let stamp;
    if (date.toDateString() === now.toDateString()) stamp = clock;
    else if (date.getFullYear() === now.getFullYear()) {
      stamp = `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
    } else {
      stamp = `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${clock}`;
    }
    return `同步于 ${stamp}`;
  }

  function zoteroRowHtml(entry, depth, childrenOf) {
    const id = String(entry.id);
    const children = childrenOf.get(id) || [];
    const hasChildren = children.length > 0;
    const expanded = hasChildren && !state.zcollapsed.has(id);
    const on = state.view === "zotero" && String(state.zfilter) === id;
    const caret = hasChildren
      ? `<button class="zot-caret" type="button" data-ztoggle="${escapeHtml(id)}"
                 aria-expanded="${expanded}" aria-label="${
                   expanded ? "收起" : "展开"
                 }「${escapeHtml(entry.name)}」" title="${
                   expanded ? "收起" : "展开"
                 }">${ico.caret}</button>`
      : '<span class="zot-caret-spacer" aria-hidden="true"></span>';
    return `<div class="rail-item zot-coll${on ? " on" : ""}" data-zfilter="${escapeHtml(id)}"
                 role="button" tabindex="0" style="--depth:${depth}" aria-pressed="${on}"
                 title="${escapeHtml(entry.name)}">
      ${caret}
      ${ico.folder}
      <span class="rail-name">${escapeHtml(entry.name)}</span>
      <em>${zoteroCount(entry)}</em>
    </div>`;
  }

  function zoteroTreeHtml() {
    const { roots, childrenOf } = zoteroTree();
    const parts = [];
    const walk = (entry, depth) => {
      const id = String(entry.id);
      const children = childrenOf.get(id) || [];
      parts.push(zoteroRowHtml(entry, depth, childrenOf));
      if (!children.length || state.zcollapsed.has(id)) return;
      for (const child of children) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    return parts.join("");
  }

  function renderZoteroRail() {
    const snap = zoteroSnapshot();
    el.zoteroBlock.hidden = !snap;
    el.zoteroHint.hidden = Boolean(snap);
    if (!snap) {
      el.zoteroTree.innerHTML = "";
      el.zoteroSynced.textContent = "";
      return;
    }
    const items = snap.items || [];
    el.zoteroCountAll.textContent = String(items.length);
    el.zoteroSynced.textContent = zoteroSyncLabel(snap);
    const allOn = state.view === "zotero" && String(state.zfilter) === "all";
    el.zoteroAll.classList.toggle("on", allOn);
    el.zoteroAll.setAttribute("aria-pressed", String(allOn));
    el.zoteroTree.innerHTML = zoteroTreeHtml();
  }

  function zoteroSelect(filter) {
    if (!zoteroSnapshot()) return;
    state.view = "zotero";
    state.zfilter = String(filter);
    closeCollect();
    renderZoteroRail();
    render();
  }

  function zoteroToggle(id) {
    const key = String(id);
    if (state.zcollapsed.has(key)) state.zcollapsed.delete(key);
    else state.zcollapsed.add(key);
    renderZoteroRail();
  }

  function primaryFile(item) {
    return (
      item.files.find((file) => file.name.toLowerCase().endsWith(".pdf")) ||
      item.files[0] ||
      null
    );
  }

  function readerLink(file) {
    return `/viewer?from=library&path=${encodeURIComponent(file.path)}`;
  }

  function visibleItems() {
    if (state.filter === "unfiled") {
      return state.items.filter((item) => !(item.collections || []).length);
    }
    if (state.filter !== "all") {
      return state.items.filter((item) => (item.collections || []).includes(state.filter));
    }
    return state.items;
  }

  function emptyCopy() {
    if (state.query) {
      return {
        title: "没有匹配的结果",
        text: `没有文件名包含「${state.query}」的结果，换个关键词试试。`,
        actions: false,
      };
    }
    if (state.filter === "unfiled") {
      return {
        title: "所有论文都已归类",
        text: "每篇论文都至少在一个合集里。把论文拖到左侧「未分类」，可以移出所有合集。",
        actions: false,
      };
    }
    if (state.filter !== "all") {
      return {
        title: "这个合集还是空的",
        text: "把论文拖到左侧合集，或点卡片上的「归类」把论文放进来。",
        actions: false,
      };
    }
    return {
      title: "还没有翻译结果",
      text: "翻译完成后，文件会自动出现在这里：可以阅读、做批注、重命名或清理。结果保存到别的文件夹时，也可以把它加进来。",
      actions: true,
    };
  }

  function render() {
    closeCardMenu();
    if (state.view === "zotero") {
      renderZotero();
      return;
    }
    renderResults();
  }

  function renderResults() {
    if (el.sub) el.sub.textContent = RESULTS_SUB;
    el.search.placeholder = RESULTS_PLACEHOLDER;
    el.addDir.hidden = false;
    renderDirs();
    renderRail();
    renderZoteroRail();
    if (el.emptyActions) el.emptyActions.hidden = false;

    const items = visibleItems();
    el.title.textContent = currentTitle();
    el.count.textContent = String(items.length);

    if (!items.length) {
      el.grid.innerHTML = "";
      el.grid.hidden = true;
      el.empty.hidden = false;
      const copy = emptyCopy();
      el.emptyTitle.textContent = copy.title;
      el.emptyText.textContent = copy.text;
      el.addDir2.hidden = !copy.actions;
      return;
    }

    el.empty.hidden = true;
    el.grid.hidden = false;
    el.grid.innerHTML = items
      .map((item, index) => {
        const primary = primaryFile(item);
        const pdfs = item.files.filter((file) => file.name.toLowerCase().endsWith(".pdf"));
        const thumb = primary
          ? `/api/library/thumb?w=420&path=${encodeURIComponent(primary.path)}`
          : "";
        const meta = [
          formatTime(item.updated),
          `${item.files.length} 个文件`,
          formatSize(item.size),
          item.pages ? `${item.pages} 页` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        const chips = item.files
          .map((file) => {
            const pdf = file.name.toLowerCase().endsWith(".pdf");
            const label = escapeHtml(file.kind);
            return pdf
              ? `<a class="lib-chip" href="${readerLink(file)}" draggable="false" title="在阅读器打开">${label}</a>`
              : `<span class="lib-chip" title="${escapeHtml(file.name)}">${label}</span>`;
          })
          .join("");
        const notes =
          item.annotations > 0
            ? `<span class="lib-chip notes">${item.annotations} 条批注</span>`
            : "";
        const tags = (item.collections || [])
          .map((id) => collectionById(id))
          .filter(Boolean)
          .map((entry) => `<span class="lib-tag">${escapeHtml(entry.name)}</span>`)
          .join("");
        return `
          <article class="lib-card" data-id="${item.id}" draggable="true" style="--i:${index}">
            <a class="lib-thumb" href="${primary ? readerLink(primary) : "#"}"
               draggable="false"
               title="${escapeHtml(item.name)}" aria-label="阅读 ${escapeHtml(item.name)}">
              <span class="lib-thumb-label" aria-hidden="true">PDF</span>
              ${
                thumb
                  ? `<img loading="lazy" src="${thumb}" alt="" onerror="this.remove()">`
                  : ""
              }
            </a>
            <div class="lib-body">
              <h3 class="lib-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
              <p class="lib-meta">${meta}</p>
              ${tags ? `<div class="lib-tags">${tags}</div>` : ""}
              <div class="lib-chips">${chips}${notes}</div>
            </div>
            <div class="lib-actions" role="group" aria-label="论文操作">
              <button type="button" data-act="read" title="阅读" aria-label="阅读">${ico.read}</button>
              ${
                pdfs.length > 1
                  ? `<button type="button" class="lib-caret" data-act="readmenu"
                             title="选择要阅读的版本" aria-label="选择要阅读的版本"
                             aria-haspopup="menu" aria-expanded="false">${ico.caret}</button>`
                  : ""
              }
              <button type="button" data-act="collect" title="归入合集" aria-label="归入合集">${ico.collect}</button>
              <button type="button" data-act="folder" title="打开源文件所在位置"
                      aria-label="打开源文件所在位置">${ico.reveal}</button>
              <button type="button" data-act="rename" title="重命名" aria-label="重命名">${ico.rename}</button>
              <button type="button" data-act="delete" title="删除" aria-label="删除">${ico.remove}</button>
            </div>
          </article>`;
      })
      .join("");

    /* Keep the selected row marked while its collect popover is open. */
    if (state.collectId) {
      const node = el.grid.querySelector(`.lib-card[data-id="${state.collectId}"]`);
      if (node) node.classList.add("on");
    }
  }

  /* ------------------------------------------------------ Zotero items -- */
  function zoteroKey(item) {
    return `${item.library_id ?? ""}:${item.key ?? ""}`;
  }

  function zoteroItemByKey(key) {
    const snap = zoteroSnapshot();
    const items = (snap && snap.items) || [];
    return items.find((item) => zoteroKey(item) === key) || null;
  }

  function zoteroHasPdf(item) {
    return Boolean(item && item.attachment && item.attachment.path);
  }

  function zoteroHaystack(item) {
    const attachment = item.attachment || {};
    const fileName = attachment.path
      ? String(attachment.path).split(/[\\/]/).pop()
      : "";
    return [item.title, item.creators, item.year, attachment.filename, fileName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function zoteroDate(item) {
    const text = String(item.date_added || "").trim();
    if (!text) return 0;
    const stamp = Date.parse(text.replace(" ", "T"));
    return Number.isFinite(stamp) ? stamp : 0;
  }

  function zoteroSortedItems(items) {
    const list = items.slice();
    if (state.sort === "name") {
      list.sort((left, right) =>
        String(left.title || "").localeCompare(String(right.title || ""), "zh-Hans")
      );
    } else if (state.sort === "size") {
      list.sort(
        (left, right) =>
          Number((right.attachment || {}).size || 0) -
          Number((left.attachment || {}).size || 0)
      );
    } else {
      list.sort((left, right) => zoteroDate(right) - zoteroDate(left));
    }
    return list;
  }

  function visibleZoteroItems() {
    const snap = zoteroSnapshot();
    let items = (snap && snap.items) || [];
    if (String(state.zfilter) !== "all") {
      const ids = zoteroDescendantIds(state.zfilter);
      items = items.filter((item) =>
        (item.collections || []).some((id) => ids.has(String(id)))
      );
    }
    const query = state.query.trim().toLowerCase();
    if (query) items = items.filter((item) => zoteroHaystack(item).includes(query));
    return zoteroSortedItems(items);
  }

  function zoteroCurrentTitle() {
    if (String(state.zfilter) === "all") return "全部文献";
    const entry = zoteroCollectionById(state.zfilter);
    return entry ? entry.name : "全部文献";
  }

  function zoteroBadge(item) {
    if (!zoteroHasPdf(item)) return '<span class="lib-badge warn">无 PDF</span>';
    const translated = item.translated || {};
    if (translated.dual) return '<span class="lib-badge dual">双语</span>';
    if (translated.translation) return '<span class="lib-badge translated">译文</span>';
    return '<span class="lib-badge muted">未翻译</span>';
  }

  function zoteroThumbUrl(item) {
    if (!zoteroHasPdf(item)) return "";
    const params = new URLSearchParams({
      library_id: String(item.library_id ?? ""),
      item_key: String(item.key ?? ""),
      attachment_key: String((item.attachment || {}).key ?? ""),
      w: "420",
    });
    return `/api/zotero/thumb?${params.toString()}`;
  }

  function zoteroCardHtml(item, index) {
    const title = item.title || "（无标题）";
    const hasPdf = zoteroHasPdf(item);
    const thumb = zoteroThumbUrl(item);
    const meta = [item.creators, item.year].filter(Boolean).join(" · ") || "未知作者";
    const pdfChip = hasPdf
      ? `<span class="lib-chip">PDF · ${formatSize((item.attachment || {}).size)}</span>`
      : "";
    const busy = state.zbusy.has(zoteroKey(item));
    return `
      <article class="lib-card zot-card" data-zk="${escapeHtml(zoteroKey(item))}"
               style="--i:${index}"${busy ? ' aria-busy="true"' : ""}>
        <button class="lib-thumb zot-thumb" type="button" data-zact="read"
                title="阅读 ${escapeHtml(title)}" aria-label="阅读 ${escapeHtml(title)}">
          <span class="lib-thumb-label" aria-hidden="true">PDF</span>
          ${
            thumb
              ? `<img loading="lazy" src="${escapeHtml(thumb)}" alt="" onerror="this.remove()">`
              : ""
          }
        </button>
        <div class="lib-body">
          <h3 class="lib-name" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
          <p class="lib-meta">${escapeHtml(meta)}</p>
          <div class="lib-chips">${pdfChip}${zoteroBadge(item)}</div>
        </div>
        <div class="zot-actions" role="group" aria-label="文献操作">
          ${
            hasPdf
              ? `<span class="zot-split">
                   <button class="zot-btn zot-btn-main" type="button" data-zact="read"
                           title="阅读 ${escapeHtml(title)}">阅读</button>
                   <button class="zot-btn zot-caret-btn" type="button" data-zact="readmenu"
                           title="选择阅读版本" aria-label="选择阅读版本"
                           aria-haspopup="menu" aria-expanded="false">${ico.caret}</button>
                 </span>`
              : `<button class="zot-btn" type="button" data-zact="read">阅读</button>`
          }
          <button class="zot-btn" type="button" data-zact="translate"
                  ${
                    hasPdf
                      ? ""
                      : 'aria-disabled="true" title="这篇文献没有本地 PDF"'
                  }>翻译</button>
        </div>
      </article>`;
  }

  function zoteroEmptyCopy() {
    if (!zoteroSnapshot()) {
      return {
        title: "还没有同步 Zotero 文库",
        text: "在 Zotero 里点顶部工具栏的 ReadPI 图标即可同步。",
      };
    }
    if (state.query) {
      return {
        title: "没有匹配的文献",
        text: `没有标题、作者或 PDF 名包含「${state.query}」的文献，换个关键词试试。`,
      };
    }
    if (String(state.zfilter) === "all") {
      return {
        title: "Zotero 里还没有带本地 PDF 的文献",
        text: "先在 Zotero 里给文献下载 PDF 附件，再点 Zotero 顶部工具栏的 ReadPI 图标同步。",
      };
    }
    return {
      title: "这个 Zotero 文件夹还是空的",
      text: "把文献拖进 Zotero 的这个文件夹后，再点顶部工具栏的 ReadPI 图标同步。",
    };
  }

  function renderZotero() {
    if (el.sub) el.sub.textContent = ZOTERO_SUB;
    el.search.placeholder = ZOTERO_PLACEHOLDER;
    el.addDir.hidden = true;
    el.dirs.hidden = true;
    renderRail();
    renderZoteroRail();

    const items = visibleZoteroItems();
    el.title.textContent = zoteroCurrentTitle();
    el.count.textContent = String(items.length);

    if (!items.length) {
      el.grid.innerHTML = "";
      el.grid.hidden = true;
      el.empty.hidden = false;
      const copy = zoteroEmptyCopy();
      el.emptyTitle.textContent = copy.title;
      el.emptyText.textContent = copy.text;
      el.addDir2.hidden = true;
      if (el.emptyActions) el.emptyActions.hidden = true;
      return;
    }

    el.empty.hidden = true;
    el.grid.hidden = false;
    el.grid.innerHTML = items.map(zoteroCardHtml).join("");
  }

  /* ``mode: "translate"`` only prepares the document: the home page loads the
     PDF, the user adjusts settings and presses 开始翻译 there.  Nothing is
     started from the library, so no job id ever comes back. */
  async function openZoteroItem(item, mode, options = {}) {
    if (!zoteroHasPdf(item)) {
      toast("这篇文献没有本地 PDF，请先在 Zotero 中下载 PDF 附件", "bad");
      return;
    }
    const key = zoteroKey(item);
    if (state.zbusy.has(key)) return;
    state.zbusy.add(key);
    const card = $$(".zot-card", el.grid).find((node) => node.dataset.zk === key) || null;
    if (card) card.setAttribute("aria-busy", "true");
    const attachment = item.attachment || {};
    const prepare = mode === "translate";
    const body = {
      path: attachment.path,
      library_id: String(item.library_id ?? ""),
      item_key: String(item.key ?? ""),
      attachment_key: String(attachment.key ?? ""),
      title: item.title || "",
      creators: item.creators || "",
      year: item.year || "",
      doi: item.doi || "",
      page: 0,
      mode: prepare ? "prepare" : mode,
      open_window: false,
    };
    /* Read drop-downs ask for one exact variant; the plain buttons keep the
       server's automatic preference. */
    if (options.variant) body.variant = options.variant;
    try {
      const result = await api("/api/zotero/open", { method: "POST", body });
      const target = String((result && result.url) || "");
      if (!target) throw new Error("服务器没有返回可打开的地址");
      location.assign(target);
    } catch (error) {
      state.zbusy.delete(key);
      if (card) card.removeAttribute("aria-busy");
      toast(error.message, "bad");
    }
  }

  /* The read drop-down lists only the files this paper actually has. */
  function zoteroReadItems(item) {
    const translated = item.translated || {};
    const read = (variant) => () => openZoteroItem(item, "read", { variant });
    const items = [{ label: "阅读原文", onSelect: read("original") }];
    if (translated.translation) items.push({ label: "仅译文", onSelect: read("translation") });
    if (translated.dual) items.push({ label: "左右排版译文", onSelect: read("dual") });
    return items;
  }

  /* Result cards: one entry per translated PDF, labelled by its kind. */
  function resultReadItems(item) {
    const primary = primaryFile(item);
    return item.files
      .filter((file) => file.name.toLowerCase().endsWith(".pdf"))
      .map((file) => ({
        label: file.kind || file.name,
        hint: formatSize(file.size),
        radio: true,
        checked: Boolean(primary && primary.path === file.path),
        onSelect: () => { location.assign(readerLink(file)); },
      }));
  }

  function handleZoteroClick(event) {
    const card = event.target.closest(".zot-card");
    if (!card) return;
    const item = zoteroItemByKey(card.dataset.zk || "");
    if (!item) return;
    const button = event.target.closest("[data-zact]");
    if (button) {
      const action = button.dataset.zact;
      if (action === "read") openZoteroItem(item, "read");
      else if (action === "readmenu") {
        toggleCardMenu(button, () => zoteroReadItems(item), "选择阅读版本");
      } else if (action === "translate") openZoteroItem(item, "translate");
      return;
    }
    if (event.target.closest("a, button, input, textarea, label, .zot-actions")) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    openZoteroItem(item, "read");
  }

  /* ------------------------------------------------------ collect pop -- */
  function openCollect(card, item, anchor) {
    state.collectId = item.id;
    el.popTarget.textContent = item.name;
    el.pop.hidden = false;
    renderCollectList();
    $$(".lib-card.on", el.grid).forEach((node) => node.classList.remove("on"));
    card.classList.add("on");
    const box = anchor.getBoundingClientRect();
    const popBox = el.pop.getBoundingClientRect();
    let left = box.left + box.width / 2 - popBox.width / 2;
    let top = box.bottom + 8;
    if (top + popBox.height > window.innerHeight - 10) top = box.top - popBox.height - 8;
    left = Math.max(10, Math.min(left, window.innerWidth - popBox.width - 10));
    top = Math.max(10, top);
    el.pop.style.left = `${left}px`;
    el.pop.style.top = `${top}px`;
    el.popName.value = "";
  }

  function closeCollect() {
    if (el.pop.hidden) return;
    el.pop.hidden = true;
    state.collectId = null;
    $$(".lib-card.on", el.grid).forEach((node) => node.classList.remove("on"));
  }

  function renderCollectList() {
    const item = state.items.find((entry) => entry.id === state.collectId);
    if (!item) {
      el.popList.innerHTML = "";
      return;
    }
    if (!state.collections.length) {
      el.popList.innerHTML = '<p class="lib-pop-empty">还没有合集，在下面新建一个。</p>';
      return;
    }
    el.popList.innerHTML = state.collections
      .map((entry) => {
        const checked = (item.collections || []).includes(entry.id);
        return `<label class="lib-pop-row">
          <input type="checkbox" data-cid="${entry.id}"${checked ? " checked" : ""}>
          <span>${escapeHtml(entry.name)}</span>
          <em>${countIn(entry.id)}</em>
        </label>`;
      })
      .join("");
  }

  async function applyCollect() {
    const item = state.items.find((entry) => entry.id === state.collectId);
    if (!item) return;
    const ids = $$("input[data-cid]", el.popList)
      .filter((input) => input.checked)
      .map((input) => input.dataset.cid);
    try {
      const data = await api("/api/collections/assign", {
        method: "POST",
        body: { item: item.id, collections: ids },
      });
      state.collections = data.collections || state.collections;
      item.collections = ids;
      render();
      renderCollectList();
    } catch (error) {
      toast(error.message, "bad");
      renderCollectList();
    }
  }

  /* ----------------------------------------------------------- actions -- */
  function itemById(id) {
    return state.items.find((item) => item.id === id) || null;
  }

  /* The file Explorer should select: the PDF itself, else the paper folder. */
  function resultSourcePath(item) {
    const primary = primaryFile(item);
    return String((primary && primary.path) || item.dir || "");
  }

  function cardSourcePath(card) {
    if (!card) return "";
    if (card.classList.contains("zot-card")) {
      const item = zoteroItemByKey(card.dataset.zk || "");
      return item && zoteroHasPdf(item) ? String(item.attachment.path || "") : "";
    }
    const item = itemById(card.dataset.id);
    return item ? resultSourcePath(item) : "";
  }

  /* POST the path instead of navigating: Explorer stays a local side effect. */
  async function openSourceLocation(path) {
    const target = String(path || "").trim();
    if (!target) {
      toast("找不到这个文件的位置", "bad");
      return;
    }
    try {
      await api("/api/open", { method: "POST", body: { path: target } });
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  function revealInFolder(item) {
    openSourceLocation(resultSourcePath(item));
  }

  /* Right-click a card: one "show the source file" entry, no native menu. */
  function handleGridContextMenu(event) {
    const card = event.target.closest(".lib-card");
    if (!card) return;
    event.preventDefault();
    /* Keep the app-wide shortcut menu (context-menu.js) from opening too. */
    event.stopPropagation();
    closeCollect();
    const path = cardSourcePath(card);
    if (!path) return;
    openCardMenu({ x: event.clientX, y: event.clientY, label: "卡片操作" }, [
      {
        label: "打开源文件所在位置",
        icon: ico.reveal,
        hint: fileName(path),
        onSelect: () => openSourceLocation(path),
      },
    ]);
  }

  function startRename(card, item) {
    const nameNode = card.querySelector(".lib-name");
    if (!nameNode) return;
    const input = document.createElement("input");
    input.className = "lib-rename";
    input.type = "text";
    input.value = item.name;
    input.spellcheck = false;
    nameNode.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const finish = async (commit) => {
      if (settled) return;
      settled = true;
      const value = input.value.trim();
      if (!commit || !value || value === item.name) {
        await load();
        return;
      }
      try {
        await api("/api/library/rename", {
          method: "POST",
          body: { dir: item.dir, name: item.name, new_name: value },
        });
        toast("已重命名", "good");
      } catch (error) {
        toast(error.message, "bad");
      }
      await load();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function removeItem(card, item) {
    const confirmed = window.confirm(
      `删除「${item.name}」的 ${item.files.length} 个文件？\n文件会移到 Windows 回收站，可以还原。`
    );
    if (!confirmed) return;
    try {
      await api("/api/library/delete", {
        method: "POST",
        body: { dir: item.dir, name: item.name },
      });
      card.classList.add("gone");
      toast("已移入回收站", "good");
      setTimeout(load, 230);
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ---------------------------------------------------- drag to collect -- */
  function clearDropTargets() {
    for (const node of $$(".rail-item.drop-target", el.rail)) {
      node.classList.remove("drop-target");
    }
    document.body.classList.remove("lib-dragging");
  }

  async function assignToCollection(item, filter) {
    const current = new Set(item.collections || []);
    let next;
    if (filter === "unfiled") {
      if (!current.size) {
        toast("这篇论文还没有归入任何合集", "good");
        return;
      }
      next = [];
    } else {
      const entry = collectionById(filter);
      if (!entry) return;
      if (current.has(filter)) {
        toast(`已在「${entry.name}」里`, "good");
        return;
      }
      next = [...current, filter];
    }
    try {
      const data = await api("/api/collections/assign", {
        method: "POST",
        body: { item: item.id, collections: next },
      });
      state.collections = data.collections || state.collections;
      item.collections = next;
      closeCollect();
      render();
      if (filter === "unfiled") {
        toast("已移出所有合集", "good");
      } else {
        toast(`已归入「${collectionById(filter).name}」`, "good");
      }
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  el.grid.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".lib-card");
    if (!card || event.target.closest("button, input, textarea")) {
      event.preventDefault();
      return;
    }
    const item = itemById(card.dataset.id);
    if (!item) return;
    state.dragId = item.id;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", item.id);
    card.classList.add("dragging");
    document.body.classList.add("lib-dragging");
    closeCollect();
  });

  el.grid.addEventListener("dragend", () => {
    state.dragId = null;
    for (const node of $$(".lib-card.dragging", el.grid)) node.classList.remove("dragging");
    clearDropTargets();
  });

  el.rail.addEventListener("dragover", (event) => {
    if (!state.dragId) return;
    const row = event.target.closest(".rail-item[data-filter]");
    if (!row) return;
    const filter = row.dataset.filter;
    if (filter !== "unfiled" && !collectionById(filter)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!row.classList.contains("drop-target")) {
      clearDropTargets();
      row.classList.add("drop-target");
      document.body.classList.add("lib-dragging");
    }
  });

  el.rail.addEventListener("dragleave", (event) => {
    const row = event.target.closest(".rail-item[data-filter]");
    if (row && !row.contains(event.relatedTarget)) row.classList.remove("drop-target");
  });

  el.rail.addEventListener("drop", async (event) => {
    const row = event.target.closest(".rail-item[data-filter]");
    if (!row || !state.dragId) return;
    event.preventDefault();
    const item = itemById(state.dragId);
    const filter = row.dataset.filter;
    state.dragId = null;
    clearDropTargets();
    if (item) await assignToCollection(item, filter);
  });

  el.grid.addEventListener("click", (event) => {
    if (state.view === "zotero") {
      handleZoteroClick(event);
      return;
    }
    const button = event.target.closest("[data-act]");
    if (button) {
      const card = button.closest(".lib-card");
      const item = card ? itemById(card.dataset.id) : null;
      if (!card || !item) return;

      if (button.dataset.act === "read") {
        const primary = primaryFile(item);
        if (primary) location.href = readerLink(primary);
        return;
      }
      if (button.dataset.act === "readmenu") {
        toggleCardMenu(button, () => resultReadItems(item), "选择阅读版本");
        return;
      }
      if (button.dataset.act === "collect") {
        openCollect(card, item, button);
        return;
      }
      if (button.dataset.act === "folder") {
        revealInFolder(item);
        return;
      }
      if (button.dataset.act === "rename") {
        startRename(card, item);
        return;
      }
      if (button.dataset.act === "delete") {
        removeItem(card, item);
      }
      return;
    }

    /* Clicking the row itself opens the paper, like a Finder list row. */
    if (event.target.closest("a, button, input, textarea, label, .lib-actions")) return;
    if (window.getSelection && String(window.getSelection()).length) return;
    const card = event.target.closest(".lib-card");
    const item = card ? itemById(card.dataset.id) : null;
    const primary = item ? primaryFile(item) : null;
    if (primary) location.href = readerLink(primary);
  });

  /* ---------------------------------------------------------- rail ops -- */
  el.rail.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      event.stopPropagation();
      const row = edit.closest(".rail-item");
      const entry = collectionById(edit.dataset.edit);
      if (row && entry) startCollectionRename(row, entry);
      return;
    }
    const remove = event.target.closest("[data-del]");
    if (remove) {
      event.stopPropagation();
      deleteCollection(remove.dataset.del);
      return;
    }
    const row = event.target.closest(".rail-item[data-filter]");
    if (row) {
      state.view = "results";
      state.filter = row.dataset.filter;
      closeCollect();
      renderRail();
      render();
    }
  });

  el.zoteroBlock.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-ztoggle]");
    if (toggle) {
      event.stopPropagation();
      zoteroToggle(toggle.dataset.ztoggle);
      return;
    }
    const row = event.target.closest("[data-zfilter]");
    if (row) zoteroSelect(row.dataset.zfilter);
  });
  el.zoteroBlock.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest("[data-ztoggle]")) return;
    const row = event.target.closest("[data-zfilter]");
    if (row) {
      event.preventDefault();
      zoteroSelect(row.dataset.zfilter);
    }
  });
  el.zoteroRefresh.addEventListener("click", () => loadZotero({ notify: true }));

  el.rail.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".rail-item[data-filter]");
    if (!row) return;
    event.preventDefault();
    state.view = "results";
    state.filter = row.dataset.filter;
    renderRail();
    render();
  });

  el.railNew.addEventListener("click", startRailNew);

  el.pop.addEventListener("change", (event) => {
    if (event.target.matches("input[data-cid]")) applyCollect();
  });

  el.popForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = el.popName.value.trim();
    if (!name) return;
    const item = state.items.find((entry) => entry.id === state.collectId);
    try {
      const entry = await createCollection(name);
      el.popName.value = "";
      if (item && entry) {
        const ids = [...(item.collections || []), entry.id];
        const data = await api("/api/collections/assign", {
          method: "POST",
          body: { item: item.id, collections: ids },
        });
        state.collections = data.collections || state.collections;
        item.collections = ids;
      }
      render();
      renderCollectList();
      toast(`已归入新合集「${entry ? entry.name : name}」`, "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (el.pop.hidden) return;
    if (event.target.closest("#collect-pop")) return;
    if (event.target.closest('[data-act="collect"]')) return;
    closeCollect();
  });

  el.grid.addEventListener("contextmenu", handleGridContextMenu);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeCollect();
      closeCardMenu({ restoreFocus: true });
    }
  });

  /* ------------------------------------------------------- search/sort -- */
  el.search.addEventListener("input", () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.query = el.search.value.trim();
      load();
    }, 260);
  });

  function syncSort() {
    for (const button of $$("[data-sort]", el.sort)) {
      const on = button.dataset.sort === state.sort;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
  }

  el.sort.addEventListener("click", (event) => {
    const button = event.target.closest("[data-sort]");
    if (!button) return;
    const next = button.dataset.sort;
    if (!next || next === state.sort) return;
    state.sort = next;
    syncSort();
    load();
  });

  el.dirs.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-dir]");
    if (remove) removeFolder(remove.dataset.dir);
  });

  el.addDir.addEventListener("click", addFolder);
  el.addDir2.addEventListener("click", addFolder);

  syncSort();
  Promise.all([load(), loadZotero()]).then(() => {
    const source = new URLSearchParams(location.search).get("source");
    if (!state.zoteroMissing && source === "zotero") zoteroSelect("all");
    else if (savedView && Number(savedView.scrollY) > 0) {
      requestAnimationFrame(() => window.scrollTo(0, Number(savedView.scrollY)));
    }
  });
  document.addEventListener("studio:job-complete", () => {
    load();
    loadZotero({ silent: true });
  });
})();
