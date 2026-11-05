/* BabelDOC Studio — result library (browse, read, collections, clean up). */
(() => {
  "use strict";

  const { $, $$, api, toast, escapeHtml, formatSize, formatTime, bindTheme } = window.Studio;

  const el = {
    count: $("#lib-count"),
    title: $("#lib-title"),
    search: $("#search"),
    sort: $("#sort"),
    addDir: $("#btn-add-dir"),
    addDir2: $("#btn-add-dir-2"),
    dirs: $("#dirs"),
    grid: $("#grid"),
    empty: $("#empty"),
    emptyTitle: $("#empty-title"),
    emptyText: $("#empty-text"),
    rail: $("#rail"),
    railList: $("#rail-list"),
    railEmpty: $("#rail-empty"),
    railNew: $("#btn-new-collection"),
    countAll: $("#count-all"),
    countUnfiled: $("#count-unfiled"),
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
    sort: "recent",
    filter: "all",
    timer: null,
    collectId: null,
  };

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
    remove:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.8 4.4h10.4M6.4 4.4V3a.9.9 0 0 1 .9-.9h1.4a.9.9 0 0 1 .9.9v1.4"/>' +
      '<path d="m4.2 4.4.6 8.6a.9.9 0 0 0 .9.8h4.6a.9.9 0 0 0 .9-.8l.6-8.6"/>' +
      '<path d="M6.7 7v4.2M9.3 7v4.2"/></svg>',
  };

  /* -------------------------------------------------------------- load -- */
  async function load() {
    const params = new URLSearchParams({ q: state.query, sort: state.sort });
    try {
      const data = await api(`/api/library?${params.toString()}`);
      state.items = data.items || [];
      state.dirs = data.dirs || [];
      state.extraDirs = data.extra_dirs || [];
      state.collections = data.collections || [];
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
      const on = filter === state.filter;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
    }
    el.railEmpty.hidden = state.collections.length > 0;
    el.railList.innerHTML = state.collections
      .map((entry) => {
        const count = countIn(entry.id);
        return `<div class="rail-item${entry.id === state.filter ? " on" : ""}"
                    data-filter="${entry.id}" role="button" tabindex="0"
                    aria-pressed="${entry.id === state.filter}">
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
        text: "每篇论文都至少在一个合集里。点卡片上的「归类」可以调整。",
        actions: false,
      };
    }
    if (state.filter !== "all") {
      return {
        title: "这个合集还是空的",
        text: "点卡片上的「归类」把论文放进这个合集。",
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
    const items = visibleItems();
    el.title.textContent = currentTitle();
    el.count.textContent = String(items.length);
    renderRail();

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
              ? `<a class="lib-chip" href="${readerLink(file)}" title="在阅读器打开">${label}</a>`
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
          <article class="lib-card" data-id="${item.id}" style="--i:${index}">
            <a class="lib-thumb" href="${primary ? readerLink(primary) : "#"}"
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
              <button type="button" data-act="collect" title="归入合集" aria-label="归入合集">${ico.collect}</button>
              <button type="button" data-act="folder" title="在文件夹中显示"
                      aria-label="在文件夹中显示">${ico.reveal}</button>
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

  async function revealInFolder(item) {
    const target = primaryFile(item) || { path: item.dir };
    try {
      await api("/api/open", { method: "POST", body: { path: target.path } });
    } catch (error) {
      toast(error.message, "bad");
    }
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

  el.grid.addEventListener("click", (event) => {
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
      state.filter = row.dataset.filter;
      closeCollect();
      renderRail();
      render();
    }
  });

  el.rail.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".rail-item[data-filter]");
    if (!row) return;
    event.preventDefault();
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCollect();
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
  load();
})();
