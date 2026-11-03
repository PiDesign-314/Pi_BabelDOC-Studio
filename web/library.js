/* BabelDOC Studio — result library (browse, read, rename, clean up). */
(() => {
  "use strict";

  const { $, api, toast, escapeHtml, formatSize, formatTime, bindTheme } = window.Studio;

  const el = {
    count: $("#lib-count"),
    search: $("#search"),
    sort: $("#sort"),
    addDir: $("#btn-add-dir"),
    addDir2: $("#btn-add-dir-2"),
    dirs: $("#dirs"),
    grid: $("#grid"),
    empty: $("#empty"),
    emptyTitle: $("#empty-title"),
    emptyText: $("#empty-text"),
  };

  const state = {
    items: [],
    dirs: [],
    extraDirs: [],
    query: "",
    sort: "recent",
    timer: null,
  };

  bindTheme($("#btn-theme"));

  /* -------------------------------------------------------------- load -- */
  async function load() {
    const params = new URLSearchParams({ q: state.query, sort: state.sort });
    try {
      const data = await api(`/api/library?${params.toString()}`);
      state.items = data.items || [];
      state.dirs = data.dirs || [];
      state.extraDirs = data.extra_dirs || [];
      renderDirs();
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
              ? `<button class="lib-dir-x" type="button" data-dir="${escapeHtml(folder)}" title="不再扫描">✕</button>`
              : ""
          }
        </span>`;
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

  function render() {
    el.count.textContent = String(state.items.length);

    if (!state.items.length) {
      el.grid.innerHTML = "";
      el.empty.hidden = false;
      if (state.query) {
        el.emptyTitle.textContent = "没有匹配的结果";
        el.emptyText.textContent = `没有文件名包含「${state.query}」的结果，换个关键词试试。`;
        el.addDir2.hidden = true;
      } else {
        el.emptyTitle.textContent = "还没有翻译结果";
        el.emptyText.textContent =
          "翻译完成后，文件会自动出现在这里：可以阅读、做批注、重命名或清理。结果保存到别的文件夹时，也可以把它加进来。";
        el.addDir2.hidden = false;
      }
      return;
    }

    el.empty.hidden = true;
    el.grid.innerHTML = state.items
      .map((item, index) => {
        const primary = primaryFile(item);
        const thumb = primary
          ? `/api/library/thumb?w=420&path=${encodeURIComponent(primary.path)}`
          : "";
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
        const pages = item.pages ? `<span class="lib-pages">${item.pages} 页</span>` : "";
        return `
          <article class="lib-card" data-id="${item.id}" style="--i:${index}">
            <a class="lib-thumb" href="${primary ? readerLink(primary) : "#"}"
               title="${escapeHtml(item.name)}">
              ${
                thumb
                  ? `<img loading="lazy" src="${thumb}" alt="" onerror="this.style.visibility='hidden'">`
                  : ""
              }
              ${pages}
            </a>
            <div class="lib-body">
              <h3 class="lib-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</h3>
              <p class="lib-meta">${formatTime(item.updated)} · ${item.files.length} 个文件 · ${formatSize(
                item.size
              )}</p>
              <div class="lib-chips">${chips}${notes}</div>
              <div class="lib-actions">
                <button type="button" data-act="read">阅读</button>
                <button type="button" data-act="folder">文件夹</button>
                <button type="button" data-act="rename">重命名</button>
                <button type="button" data-act="delete">删除</button>
              </div>
            </div>
          </article>`;
      })
      .join("");
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
    if (!button) return;
    const card = button.closest(".lib-card");
    const item = card ? itemById(card.dataset.id) : null;
    if (!card || !item) return;

    if (button.dataset.act === "read") {
      const primary = primaryFile(item);
      if (primary) location.href = readerLink(primary);
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
  });

  el.dirs.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-dir]");
    if (remove) removeFolder(remove.dataset.dir);
  });

  el.search.addEventListener("input", () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.query = el.search.value.trim();
      load();
    }, 260);
  });

  el.sort.addEventListener("change", () => {
    state.sort = el.sort.value;
    load();
  });

  el.addDir.addEventListener("click", addFolder);
  el.addDir2.addEventListener("click", addFolder);

  load();
})();
