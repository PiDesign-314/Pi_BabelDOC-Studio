/* Helpers shared by the result library and the built-in reader. */
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  async function api(path, options = {}) {
    const opts = { ...options };
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch(path, opts);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error((data && data.error) || `请求失败（${response.status}）`);
    }
    return data;
  }

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function toast(message, kind = "") {
    const host = $("#toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatTime(seconds) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000);
    const now = new Date();
    const clock = `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes()
    ).padStart(2, "0")}`;
    if (date.toDateString() === now.toDateString()) return `今天 ${clock}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function fileName(path) {
    const parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  function download(name, text, mimetype = "text/markdown") {
    const blob = new Blob([text], { type: `${mimetype};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ------------------------------------------------------------- theme -- */
  const THEME_KEY = "babeldoc-theme";

  function applyTheme(theme, persist = false) {
    const root = document.documentElement;
    if (theme === "dark" || theme === "light") root.dataset.theme = theme;
    else {
      root.removeAttribute("data-theme");
      theme = "auto";
    }
    if (persist) localStorage.setItem(THEME_KEY, theme);
  }

  function initTheme() {
    const fromUrl = new URLSearchParams(location.search).get("theme");
    if (fromUrl === "dark" || fromUrl === "light") {
      applyTheme(fromUrl);
      return;
    }
    const stored = localStorage.getItem(THEME_KEY) || "auto";
    applyTheme(stored);
  }

  function bindTheme(button) {
    if (!button) return;
    button.addEventListener("click", () => {
      const order = ["auto", "light", "dark"];
      const current = localStorage.getItem(THEME_KEY) || "auto";
      const next = order[(order.indexOf(current) + 1) % order.length];
      applyTheme(next, true);
    });
  }

  initTheme();

  window.Studio = {
    $, $$, api, toast, escapeHtml, formatSize, formatTime, fileName, download,
    initTheme, bindTheme,
  };
})();
