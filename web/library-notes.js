/* BabelDOC Studio — notes view layered on top of the result library.
 *
 * Loaded after library.js. It only toggles a body class so the result grid /
 * controls are hidden while the notes view is shown; library.js keeps owning
 * its own state, listeners and rendering.
 *
 * All user supplied strings (titles, bodies, quotes, category names, search
 * text) reach the DOM through textContent — never innerHTML.
 */
(() => {
  "use strict";

  const { $, api, toast, formatTime, fileName } = window.Studio;

  const el = {
    switch: $("#view-switch"),
    view: $("#notes-view"),
    railBlock: $("#notes-rail-block"),
    railList: $("#notes-rail-list"),
    railEmpty: $("#notes-rail-empty"),
    title: $("#notes-title"),
    count: $("#notes-count"),
    search: $("#notes-search"),
    newCat: $("#notes-new-cat"),
    groups: $("#notes-groups"),
    empty: $("#notes-empty"),
    emptyTitle: $("#notes-empty-title"),
    emptyText: $("#notes-empty-text"),
    retry: $("#notes-retry"),
    loading: $("#notes-loading"),
  };

  /* The page is still rendered by older builds without the notes markup. */
  if (!el.switch || !el.view || !el.groups) return;

  const BODY_PREVIEW = 120;
  const QUOTE_PREVIEW = 72;

  const state = {
    view: "results",
    loaded: false,
    loading: false,
    snapshot: false,
    error: "",
    query: "",
    category: "all", // "all" | "uncategorized" | category id
    notes: [],
    allNotes: [],
    categories: [],
    scroll: { results: 0, notes: 0 },
    timer: null,
    seq: 0,
  };

  /* ---------------------------------------------------------- icons -- */
  const ico = {
    notes:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.2 1.9h9.6v12.2H3.2z"/><path d="M5.6 5.2h4.8M5.6 8h4.8M5.6 10.8h2.8"/></svg>',
    unfiled:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.1 4.6h4l1.3 1.5h6.5v5.6a1.5 1.5 0 0 1-1.5 1.5H3.6a1.5 1.5 0 0 1-1.5-1.5z"/>' +
      '<path d="M2.4 11.2h11.2"/></svg>',
    folder:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M1.9 4.3h4.2l1.2 1.4h6.8v6.4a1.1 1.1 0 0 1-1.1 1.1H3a1.1 1.1 0 0 1-1.1-1.1z"/></svg>',
  };

  /* ------------------------------------------------------- helpers -- */
  function sourceOf(note) {
    const raw = note && typeof note.source === "object" && note.source ? note.source : {};
    const page = Number(raw.page);
    return {
      path: typeof raw.path === "string" ? raw.path : "",
      page: Number.isFinite(page) && page > 0 ? String(Math.trunc(page)) : "",
      quote: typeof raw.quote === "string" ? raw.quote : "",
      docId: raw.doc_id != null ? raw.doc_id : "",
      location: typeof raw.location === "string" ? raw.location : "",
    };
  }

  function viewerLink(path, page) {
    let url = `/viewer?path=${encodeURIComponent(path)}`;
    if (page) url += `&page=${encodeURIComponent(page)}`;
    return url;
  }

  function noteTitle(note) {
    const title = String((note && note.title) || "").trim();
    return title || "无标题笔记";
  }

  /* Strip the most common Markdown markers so the preview reads like prose. */
  function stripMarkdown(value) {
    let text = String(value == null ? "" : value);
    text = text.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ");
    text = text.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ");
    text = text.replace(/`([^`]*)`/g, "$1");
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
    text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    text = text.replace(/^\s{0,3}>\s?/gm, "");
    text = text.replace(/^\s{0,3}([-*+]|\d+\s*[.)])\s+/gm, "");
    text = text.replace(/[*_~]{1,3}/g, "");
    text = text.replace(/\|/g, " ");
    text = text.replace(/<[^>]+>/g, " ");
    return text.replace(/\s+/g, " ").trim();
  }

  function summarize(value, limit) {
    const plain = stripMarkdown(value);
    if (!plain) return "";
    const chars = Array.from(plain);
    return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : plain;
  }

  /* The backend stores epoch seconds like the rest of the app; accept ISO too
     so the page keeps working if the notes API prints strings instead. */
  function noteTime(value) {
    if (!value) return "";
    let stamp = value;
    if (typeof stamp === "string") {
      const parsed = Date.parse(stamp);
      if (!Number.isFinite(parsed)) return stamp;
      stamp = parsed / 1000;
    }
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) return "";
    if (stamp > 1e12) stamp /= 1000;
    return formatTime(stamp);
  }

  function categoryName(id) {
    if (id == null || id === "") return "未分类";
    const entry = state.categories.find((cat) => String(cat.id) === String(id));
    return entry ? entry.name : "未分类";
  }

  function countIn(id) {
    return state.allNotes.filter((note) => String(note.category_id || "") === String(id)).length;
  }

  function currentTitle() {
    if (state.category === "all") return "全部笔记";
    if (state.category === "uncategorized") return "未分类笔记";
    const entry = state.categories.find((cat) => String(cat.id) === String(state.category));
    return entry ? entry.name : "全部笔记";
  }

  function findNote(id) {
    return (
      state.notes.find((note) => String(note.id) === String(id)) ||
      state.allNotes.find((note) => String(note.id) === String(id)) ||
      null
    );
  }

  function findCategory(id) {
    return state.categories.find((cat) => String(cat.id) === String(id)) || null;
  }

  function setLoading(on) {
    state.loading = on;
    el.loading.hidden = !on;
    if (on) el.empty.hidden = true;
  }

  /* --------------------------------------------------- data loading -- */
  async function load() {
    const seq = ++state.seq;
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.category !== "all") params.set("category", state.category);
    const query = params.toString();
    const full = !state.query && state.category === "all";
    setLoading(true);
    try {
      const data = await api(`/api/notes${query ? `?${query}` : ""}`);
      const notes = Array.isArray(data.notes) ? data.notes : [];
      const categories = Array.isArray(data.categories) ? data.categories : [];
      if (seq !== state.seq) {
        /* A newer request superseded this one, but a discarded full response is
           still the best source for the category counts. */
        if (full) {
          state.allNotes = notes;
          state.categories = categories;
          state.snapshot = true;
          renderRail();
        }
        return;
      }
      state.notes = notes;
      state.categories = categories;
      if (full) {
        state.allNotes = notes;
        state.snapshot = true;
      }
      state.loaded = true;
      state.error = "";
      render();
      /* The user may have started a search before the first full load landed. */
      if (!state.snapshot) ensureSnapshot();
    } catch (error) {
      if (seq !== state.seq) return;
      state.error = (error && error.message) || "请求失败";
      toast(`读取笔记失败：${state.error}`, "bad");
      if (!state.notes.length) {
        state.loaded = true;
        render();
      }
    } finally {
      if (seq === state.seq) setLoading(false);
    }
  }

  /* Fill the counts snapshot when the first full load lost the race against a
     search or a category filter. */
  async function ensureSnapshot() {
    if (state.snapshot) return;
    try {
      const data = await api("/api/notes");
      state.allNotes = Array.isArray(data.notes) ? data.notes : [];
      if (Array.isArray(data.categories)) state.categories = data.categories;
      state.snapshot = true;
      renderRail();
    } catch {
      /* Counts stay as-is; the visible list is unaffected. */
    }
  }

  /* After a mutation: refresh the full snapshot for the category counts, then
     the currently filtered list (or reuse the snapshot when no filter is on). */
  async function refreshAfterChange() {
    try {
      const data = await api("/api/notes");
      state.allNotes = Array.isArray(data.notes) ? data.notes : [];
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      state.snapshot = true;
      state.error = "";
      if (!state.query && state.category === "all") {
        state.notes = state.allNotes;
        state.loaded = true;
        render();
        return;
      }
    } catch (error) {
      toast(`刷新笔记失败：${(error && error.message) || "请求失败"}`, "bad");
      return;
    }
    await load();
  }

  /* ---------------------------------------------------- view switching -- */
  function setView(next) {
    if (next !== "notes" && next !== "results") return;
    if (next === state.view) return;
    state.scroll[state.view] = window.scrollY || 0;
    state.view = next;
    const notes = next === "notes";
    document.body.classList.toggle("lib-view-notes", notes);
    el.view.hidden = !notes;
    for (const button of el.switch.querySelectorAll("[data-view]")) {
      const on = button.dataset.view === next;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    if (notes && !state.loaded && !state.loading) load();
    const top = state.scroll[next] || 0;
    requestAnimationFrame(() => window.scrollTo({ top, left: 0, behavior: "auto" }));
  }

  /* ------------------------------------------------------ rail render -- */
  function railIcon(svg) {
    const node = document.createElement("span");
    node.className = "rail-ico";
    node.innerHTML = svg; // static icon markup only
    return node;
  }

  function filterRow(key, label, count, icon) {
    const on = state.category === key;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `rail-item${on ? " on" : ""}`;
    button.dataset.cat = key;
    button.setAttribute("aria-pressed", String(on));
    button.append(railIcon(icon));
    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = label;
    const em = document.createElement("em");
    em.textContent = String(count);
    button.append(name, em);
    return button;
  }

  function categoryRow(category) {
    const id = String(category.id);
    const on = String(state.category) === id;
    const row = document.createElement("div");
    row.className = `rail-item${on ? " on" : ""}`;
    row.dataset.cat = id;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(on));
    row.tabIndex = 0;
    row.title = `筛选分类「${category.name}」`;
    row.append(railIcon(ico.folder));
    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = category.name;
    name.title = category.name;
    const em = document.createElement("em");
    em.textContent = String(countIn(id));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "rail-tool";
    edit.dataset.editCat = id;
    edit.title = "重命名分类";
    edit.setAttribute("aria-label", `重命名分类 ${category.name}`);
    edit.textContent = "✎";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "rail-tool";
    remove.dataset.delCat = id;
    remove.title = "删除分类";
    remove.setAttribute("aria-label", `删除分类 ${category.name}`);
    remove.textContent = "✕";
    row.append(name, em, edit, remove);
    return row;
  }

  function renderRail() {
    const unfiled = state.allNotes.filter((note) => !note.category_id).length;
    el.railBlock.replaceChildren(
      filterRow("all", "全部笔记", state.allNotes.length, ico.notes),
      filterRow("uncategorized", "未分类", unfiled, ico.unfiled)
    );
    el.railList.replaceChildren(...state.categories.map(categoryRow));
    el.railEmpty.hidden = state.categories.length > 0;
  }

  /* -------------------------------------------------- notes rendering -- */
  function emptyCopy() {
    if (state.query) {
      return {
        title: "没有匹配的笔记",
        text: `没有包含「${state.query}」的笔记，换个关键词试试。`,
      };
    }
    if (state.category === "uncategorized") {
      return {
        title: "没有未分类的笔记",
        text: "所有笔记都已经归到分类里了。把笔记的「归类」改回「未分类」就能在这里看到。",
      };
    }
    if (state.category !== "all") {
      return {
        title: "这个分类还是空的",
        text: "在笔记卡片右侧的「归类」里选中这个分类，笔记就会出现在这里。",
      };
    }
    return {
      title: "还没有笔记",
      text: "在阅读器选中文字或 AI 回复里点「存为笔记」，之后会出现在这里；也可以用分类整理。",
    };
  }

  function renderNotes() {
    el.title.textContent = currentTitle();
    el.count.textContent = String(state.notes.length);

    if (state.error && !state.notes.length) {
      el.groups.replaceChildren();
      el.empty.hidden = false;
      el.emptyTitle.textContent = "无法读取笔记";
      el.emptyText.textContent = state.error;
      el.retry.hidden = false;
      return;
    }
    el.retry.hidden = true;

    if (!state.notes.length) {
      el.groups.replaceChildren();
      el.empty.hidden = false;
      const copy = emptyCopy();
      el.emptyTitle.textContent = copy.title;
      el.emptyText.textContent = copy.text;
      return;
    }

    el.empty.hidden = true;
    el.groups.replaceChildren(...groupNotes(state.notes));
  }

  function groupNotes(notes) {
    const groups = [];
    const index = new Map();
    for (const note of notes) {
      const path = sourceOf(note).path;
      let group = index.get(path);
      if (!group) {
        group = { path, notes: [] };
        index.set(path, group);
        groups.push(group);
      }
      group.notes.push(note);
    }
    return groups.map(groupSection);
  }

  function groupSection(group) {
    const section = document.createElement("section");
    section.className = "notes-group";

    const head = document.createElement("div");
    head.className = "notes-group-head";
    const name = document.createElement("h3");
    name.className = "notes-group-name";
    name.textContent = group.path ? fileName(group.path) : "手动笔记";
    if (group.path) name.title = group.path;
    const count = document.createElement("em");
    count.className = "notes-group-count";
    count.textContent = `${group.notes.length} 条`;
    head.append(name, count);
    if (group.path) {
      const source = group.notes.map(sourceOf).find((entry) => entry.page);
      const link = document.createElement("a");
      link.className = "notes-group-link";
      link.href = viewerLink(group.path, source ? source.page : "");
      link.textContent = "查看文献";
      head.append(link);
    }
    section.append(head);

    const list = document.createElement("div");
    list.className = "notes-list";
    for (const note of group.notes) list.append(noteCard(note));
    section.append(list);
    return section;
  }

  function noteCard(note) {
    const source = sourceOf(note);
    const card = document.createElement("article");
    card.className = "note-card";
    card.dataset.noteId = String(note.id);

    const main = document.createElement("div");
    main.className = "note-card-main";

    const title = document.createElement("h4");
    title.className = "note-title";
    title.textContent = noteTitle(note);
    main.append(title);

    const preview = summarize(note.body, BODY_PREVIEW);
    if (preview) {
      const body = document.createElement("p");
      body.className = "note-body";
      body.textContent = preview;
      main.append(body);
    }

    const meta = document.createElement("div");
    meta.className = "note-meta";

    const tag = document.createElement("span");
    tag.className = "note-cat";
    tag.textContent = categoryName(note.category_id);
    meta.append(tag);

    const quote = source.quote ? summarize(source.quote, QUOTE_PREVIEW) : "";
    if (source.page || quote) {
      const bits = [];
      if (source.page) bits.push(`p.${source.page}`);
      if (quote) bits.push(`“${quote}”`);
      const from = document.createElement("span");
      from.className = "note-src";
      from.textContent = bits.join(" · ");
      from.title = bits.join(" · ");
      meta.append(from);
    } else if (!source.path) {
      const from = document.createElement("span");
      from.className = "note-src";
      from.textContent = "手动笔记";
      meta.append(from);
    }

    const stamp = noteTime(note.updated || note.created);
    if (stamp) {
      const time = document.createElement("span");
      time.className = "note-time";
      time.textContent = `更新于 ${stamp}`;
      meta.append(time);
    }
    main.append(meta);
    card.append(main);

    const actions = document.createElement("div");
    actions.className = "note-actions";

    if (source.path) {
      const open = document.createElement("a");
      open.className = "note-act";
      open.href = viewerLink(source.path, source.page);
      open.textContent = "打开原文";
      actions.append(open);
    }

    const assign = document.createElement("label");
    assign.className = "note-assign";
    const assignLabel = document.createElement("span");
    assignLabel.className = "note-assign-label";
    assignLabel.textContent = "归类";
    const select = document.createElement("select");
    select.className = "note-select";
    select.dataset.noteCat = String(note.id);
    select.setAttribute("aria-label", `归类笔记「${noteTitle(note)}」`);
    const unfiled = document.createElement("option");
    unfiled.value = "";
    unfiled.textContent = "未分类";
    select.append(unfiled);
    for (const category of state.categories) {
      const option = document.createElement("option");
      option.value = String(category.id);
      option.textContent = category.name;
      select.append(option);
    }
    select.value = note.category_id ? String(note.category_id) : "";
    assign.append(assignLabel, select);
    actions.append(assign);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "note-act note-del";
    remove.dataset.noteDel = String(note.id);
    remove.textContent = "删除";
    actions.append(remove);

    card.append(actions);
    return card;
  }

  function render() {
    renderRail();
    renderNotes();
  }

  /* --------------------------------------------------------- actions -- */
  function selectCategory(key) {
    if (String(key) === String(state.category)) return;
    state.category = key;
    renderRail();
    load();
  }

  async function createCategory() {
    const answer = window.prompt("新建分类名称", "");
    if (answer == null) return;
    const name = answer.trim();
    if (!name) return;
    try {
      const data = await api("/api/notes/categories", { method: "POST", body: { name } });
      if (Array.isArray(data.categories)) state.categories = data.categories;
      renderRail();
      const created = data.category;
      toast(`已创建分类「${created && created.name ? created.name : name}」`, "good");
    } catch (error) {
      toast((error && error.message) || "新建分类失败", "bad");
    }
  }

  async function renameCategory(id) {
    const category = findCategory(id);
    if (!category) return;
    const answer = window.prompt(`重命名分类「${category.name}」`, category.name);
    if (answer == null) return;
    const name = answer.trim();
    if (!name || name === category.name) return;
    try {
      const data = await api(`/api/notes/categories/${encodeURIComponent(category.id)}`, {
        method: "PATCH",
        body: { name },
      });
      if (Array.isArray(data.categories)) state.categories = data.categories;
      render();
      toast("已重命名分类", "good");
    } catch (error) {
      toast((error && error.message) || "重命名分类失败", "bad");
    }
  }

  async function deleteCategory(id) {
    const category = findCategory(id);
    if (!category) return;
    const confirmed = window.confirm(
      `删除分类「${category.name}」？\n分类里的笔记会移到「未分类」，笔记本身不会被删除。`
    );
    if (!confirmed) return;
    try {
      const data = await api(`/api/notes/categories/${encodeURIComponent(category.id)}`, {
        method: "DELETE",
      });
      state.categories = Array.isArray(data.categories) ? data.categories : [];
      if (String(state.category) === String(category.id)) state.category = "all";
      await refreshAfterChange();
      toast("已删除分类", "good");
    } catch (error) {
      toast((error && error.message) || "删除分类失败", "bad");
    }
  }

  async function deleteNote(button, note) {
    const confirmed = window.confirm(`删除笔记「${noteTitle(note)}」？\n删除后无法恢复。`);
    if (!confirmed) return;
    button.disabled = true;
    try {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
      toast("已删除笔记", "good");
      await refreshAfterChange();
    } catch (error) {
      button.disabled = false;
      toast((error && error.message) || "删除笔记失败", "bad");
    }
  }

  async function assignNote(select, note) {
    const value = select.value;
    select.disabled = true;
    try {
      await api(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PATCH",
        body: { category_id: value === "" ? null : value },
      });
      toast(value === "" ? "已移出分类" : `已归入「${categoryName(value)}」`, "good");
      await refreshAfterChange();
    } catch (error) {
      select.disabled = false;
      toast((error && error.message) || "归类失败", "bad");
      renderNotes(); // put the select back on the stored value
    }
  }

  /* ---------------------------------------------------------- events -- */
  el.switch.addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });

  el.search.addEventListener("input", () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const query = el.search.value.trim();
      if (query === state.query) return;
      state.query = query;
      load();
    }, 200);
  });

  el.newCat.addEventListener("click", createCategory);
  el.retry.addEventListener("click", () => {
    state.loaded = false;
    state.error = "";
    load();
  });

  function onRailClick(event) {
    const edit = event.target.closest("[data-edit-cat]");
    if (edit) {
      event.stopPropagation();
      renameCategory(edit.dataset.editCat);
      return;
    }
    const remove = event.target.closest("[data-del-cat]");
    if (remove) {
      event.stopPropagation();
      deleteCategory(remove.dataset.delCat);
      return;
    }
    const row = event.target.closest("[data-cat]");
    if (row) selectCategory(row.dataset.cat);
  }

  function onRailKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-cat]");
    if (!row || row.tagName === "BUTTON") return; // native buttons already click
    event.preventDefault();
    selectCategory(row.dataset.cat);
  }

  el.railBlock.addEventListener("click", onRailClick);
  el.railList.addEventListener("click", onRailClick);
  el.railBlock.addEventListener("keydown", onRailKeydown);
  el.railList.addEventListener("keydown", onRailKeydown);

  el.groups.addEventListener("change", (event) => {
    const select = event.target.closest("[data-note-cat]");
    if (!select) return;
    const card = select.closest("[data-note-id]");
    const note = card ? findNote(card.dataset.noteId) : null;
    if (note) assignNote(select, note);
  });

  el.groups.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-del]");
    if (!button) return;
    const card = button.closest("[data-note-id]");
    const note = card ? findNote(card.dataset.noteId) : null;
    if (note) deleteNote(button, note);
  });

  /* Draw the empty rail immediately; the first switch loads real data. */
  renderRail();
})();
