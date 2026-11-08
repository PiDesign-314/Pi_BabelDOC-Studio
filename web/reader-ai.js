/* AI 助读面板 —— 引用原文提问，回答带 [pN] 出处，点出处跳回原文。
 *
 * 只依赖 viewer.html 里的骨架与 window.ReaderBridge：
 *   ReaderAI.open({page})          打开面板（可选：总结该页）
 *   ReaderAI.quote(captured, opts) 打开面板并填入引用卡片
 *   ReaderAI.focusInput()          打开面板并聚焦输入框
 *
 * 后端接口见 docs/AI-READER-SPEC.md 第 2 节；任何接口失败都只是降级，
 * 不会阻塞提问（模型来源默认 auto）。
 */
(() => {
  "use strict";

  if (window.ReaderAI && typeof window.ReaderAI.quote === "function") return;

  const HISTORY_LIMIT = 40;
  const REQUEST_TIMEOUT = 240000;
  const SETTINGS_TIMEOUT = 20000;
  const SUGGESTIONS = [
    "这个结论有实验支撑吗？",
    "解释这段",
    "它和上下文矛盾吗？",
    "这段的假设是什么？",
  ];
  const PROVIDER_NAMES = { auto: "自动", codex: "Codex CLI", kimi: "Kimi Code CLI", claude: "Claude Code", api: "API" };
  const PROVIDER_SHORT = { auto: "自动", codex: "Codex", kimi: "Kimi", claude: "Claude", api: "API" };
  const PRESETS = [
    { id: "moonshot", label: "Moonshot（Kimi）", base_url: "https://api.moonshot.cn/v1", model: "kimi-k2-0905-preview" },
    { id: "zhipu", label: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
    { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
    { id: "qwen", label: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "" },
    { id: "custom", label: "自定义", base_url: "", model: "" },
  ];
  const INSTALL_HINTS = {
    codex: "未检测到 codex 命令，可在终端运行 npm i -g @openai/codex 安装。",
    kimi: "未检测到 kimi 命令，请先安装 Kimi Code CLI。",
    claude: "未检测到 claude 命令，可在终端运行 npm i -g @anthropic-ai/claude-code 安装。",
  };
  const LOGIN_HINTS = {
    codex: "在终端运行 codex login 完成登录。",
    kimi: "在终端运行 kimi 完成登录。",
    claude: "在终端运行 claude 完成登录。",
  };

  const state = {
    open: false,
    busy: false,
    settingsOpen: false,
    ready: false,
    loaded: false,
    quote: null,
    messages: [],
    settings: { provider: "auto", model: "", base_url: "", preset: "moonshot", api_key_set: false },
    status: null,
    closeTimer: 0,
    refitFrame: 0,
    statusNote: "",
  };

  const els = {};
  const cache = {};

  const $ = (selector, root = document) => root.querySelector(selector);

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function toast(message, kind) {
    if (window.Studio && typeof window.Studio.toast === "function") {
      window.Studio.toast(message, kind || "");
      return;
    }
    const host = document.getElementById("toasts");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast ${kind || ""}`;
    node.textContent = message;
    host.append(node);
    window.setTimeout(() => node.remove(), 4200);
  }

  function truncate(text, limit) {
    const value = String(text || "");
    if (value.length <= limit) return value;
    return value.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
  }

  /* ------------------------------------------------------------- paths -- */
  function docPath() {
    const bridge = window.ReaderBridge;
    if (bridge && typeof bridge.docPath === "string" && bridge.docPath) return bridge.docPath;
    try {
      return new URLSearchParams(location.search).get("path") || "";
    } catch {
      return "";
    }
  }

  function storageKey() {
    return `babeldoc-ai:${docPath()}`;
  }

  /* ---------------------------------------------------------- bootstrap -- */
  function boot() {
    els.drawer = $("#ai-drawer");
    if (!els.drawer) return;
    els.toggle = $("#btn-ai");
    els.close = $("#ai-close");
    els.pill = $("#ai-provider-pill");
    els.settingsBtn = $("#ai-settings-btn");
    els.messages = $("#ai-messages");
    els.quote = $("#ai-quote");
    els.quoteTag = $("#ai-quote-tag");
    els.quoteText = $("#ai-quote-text");
    els.quoteClear = $("#ai-quote [data-ai-quote-clear]");
    els.suggest = $("#ai-suggest");
    els.form = $("#ai-form");
    els.input = $("#ai-input");
    els.send = $("#ai-send");
    els.modelBtn = $("#ai-model-btn");
    els.settings = $("#ai-settings");

    installChrome();
    bindEvents();
    updateProviderUI();
    renderSuggest();
    loadHistory();
    renderThread();
    renderQuote();

    whenReady().then(() => {
      state.ready = true;
      if (!state.loaded) {
        loadHistory();
        state.loaded = true;
        renderThread();
      }
      refreshSettings();
      refreshStatus();
    });
  }

  function whenReady() {
    const bridge = window.ReaderBridge;
    if (!bridge || typeof bridge.whenReady !== "function") return Promise.resolve();
    let ready;
    try {
      ready = bridge.whenReady();
    } catch {
      return Promise.resolve();
    }
    if (!ready || typeof ready.then !== "function") return Promise.resolve();
    return Promise.race([
      ready.catch(() => {}),
      new Promise((resolve) => window.setTimeout(resolve, 20000)),
    ]);
  }

  /* Elements the page skeleton does not provide are injected from here so the
     HTML stays owned by viewer.html. */
  function installChrome() {
    if (els.messages) {
      els.messages.setAttribute("role", "log");
      els.messages.setAttribute("aria-live", "polite");
    }
    if (els.input) els.input.setAttribute("aria-label", "向 AI 提问");

    if (!cache.historyBar) {
      const bar = document.createElement("div");
      bar.className = "r-ai-history";
      bar.hidden = true;
      bar.innerHTML =
        '<span class="r-ai-history-count" data-ai-count></span>' +
        '<button type="button" class="r-ai-history-clear" data-ai-clear>清空</button>';
      if (els.messages && els.messages.parentNode === els.drawer) {
        els.drawer.insertBefore(bar, els.messages);
      } else {
        els.drawer.append(bar);
      }
      cache.historyBar = bar;
      cache.historyCount = $("[data-ai-count]", bar);
    }
  }

  function bindEvents() {
    if (els.toggle) els.toggle.addEventListener("click", () => (state.open ? closeDrawer() : openDrawer()));
    if (els.close) els.close.addEventListener("click", closeDrawer);
    if (els.settingsBtn) els.settingsBtn.addEventListener("click", () => {
      if (state.settingsOpen) closeSettings();
      else openSettings();
    });
    if (els.modelBtn) els.modelBtn.addEventListener("click", openSettings);
    if (els.quoteClear) els.quoteClear.addEventListener("click", () => {
      setQuote(null);
      if (els.input) els.input.focus();
    });

    if (els.form) {
      els.form.addEventListener("submit", (event) => {
        event.preventDefault();
        send(null);
      });
    }

    if (els.input) {
      els.input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        if (event.isComposing) return;
        if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        send(null);
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (state.settingsOpen) {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (state.open) {
        event.preventDefault();
        closeDrawer();
      }
    });

    /* Citations and history cleaning are delegated: the message list is
       re-rendered whenever history is restored. */
    els.drawer.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-ai-clear]")) {
        clearHistory();
        return;
      }
      const settingsClose = target.closest("[data-ai-settings-close]");
      if (settingsClose) {
        closeSettings();
        return;
      }
      const save = target.closest("[data-ai-save]");
      if (save) {
        saveSettings();
        return;
      }
      const test = target.closest("[data-ai-test]");
      if (test) {
        testConnection();
        return;
      }
      const rescan = target.closest("[data-ai-rescan]");
      if (rescan) {
        showNote("正在重新检测本机模型…", "");
        refreshStatus(true);
        return;
      }
      const cite = target.closest(".r-ai-cite, .r-ai-cites-item");
      if (cite) {
        const page = Number(cite.dataset.page);
        const ref = cite.dataset.ref || "";
        jumpToCite(page, ref, cite.closest(".r-ai-msg"));
      }
    });

    els.drawer.addEventListener("change", (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.name === "ai-provider") {
        for (const label of els.settings.querySelectorAll(".r-ai-provider-opt")) {
          const input = label.querySelector("input");
          label.classList.toggle("on", Boolean(input && input.checked));
        }
        return;
      }
      if (!(target instanceof HTMLSelectElement)) return;
      if (target.dataset.aiOpt === "preset") {
        const preset = PRESETS.find((item) => item.id === target.value);
        const base = $('[data-ai-opt="base_url"]', els.settings);
        if (preset && base && preset.base_url) base.value = preset.base_url;
        const model = $('[data-ai-opt="model"]', els.settings);
        if (preset && model) model.placeholder = preset.model ? `例如 ${preset.model}` : "例如 gpt-4.1-mini";
      }
    });
  }

  /* --------------------------------------------------------- open/close -- */
  function scheduleRefit() {
    const bridge = window.ReaderBridge;
    if (!bridge || typeof bridge.refit !== "function") return;
    if (state.refitFrame) return;
    state.refitFrame = window.requestAnimationFrame(() => {
      state.refitFrame = 0;
      try {
        bridge.refit();
      } catch {
        /* the reader may still be loading */
      }
    });
  }

  function openDrawer() {
    if (!els.drawer) return;
    if (state.closeTimer) {
      window.clearTimeout(state.closeTimer);
      state.closeTimer = 0;
    }
    els.drawer.classList.remove("out");
    const wasHidden = els.drawer.hidden;
    els.drawer.hidden = false;
    state.open = true;
    if (els.toggle) els.toggle.setAttribute("aria-pressed", "true");
    if (wasHidden) {
      renderThread();
      renderQuote();
      /* A prefilled question (e.g. 「解释这段」) means the user is about to
         send, so the suggested chips would just be noise. */
      renderSuggest(Boolean(els.input && els.input.value.trim()));
    }
    scheduleRefit();
    window.setTimeout(scheduleRefit, 200);
  }

  function closeDrawer() {
    if (!els.drawer || !state.open) return;
    state.open = false;
    if (els.toggle) els.toggle.setAttribute("aria-pressed", "false");
    closeSettings();
    els.drawer.classList.add("out");
    if (state.closeTimer) window.clearTimeout(state.closeTimer);
    state.closeTimer = window.setTimeout(() => {
      state.closeTimer = 0;
      els.drawer.hidden = true;
      els.drawer.classList.remove("out");
      scheduleRefit();
    }, 180);
  }

  function focusInputSoon() {
    window.setTimeout(() => {
      if (!els.input) return;
      try {
        els.input.focus();
        const length = els.input.value.length;
        els.input.setSelectionRange(length, length);
      } catch {
        /* selection ranges can be unavailable while hidden */
      }
    }, 200);
  }

  /* -------------------------------------------------------------- quote -- */
  function normalizeCaptured(captured) {
    if (!captured) return null;
    const text = String(captured.text || "").trim();
    if (!text) return null;
    let page = 0;
    if (Array.isArray(captured.parts) && captured.parts.length) {
      page = Number(captured.parts[0].page) || 0;
    }
    if (!page && captured.page) page = Number(captured.page) || 0;
    return { text, page, section: String(captured.section || "") };
  }

  function setQuote(quote) {
    state.quote = quote
      ? { text: String(quote.text || ""), page: Number(quote.page) || 0, section: String(quote.section || "") }
      : null;
    renderQuote();
  }

  function renderQuote() {
    if (!els.quote) return;
    const quote = state.quote;
    if (!quote || !quote.text) {
      els.quote.hidden = true;
      if (els.quoteTag) els.quoteTag.textContent = "";
      if (els.quoteText) els.quoteText.textContent = "";
      return;
    }
    els.quote.hidden = false;
    const chars = Array.from(String(quote.text).replace(/\s+/g, "")).length;
    if (els.quoteTag) {
      els.quoteTag.textContent = quote.page ? `第 ${quote.page} 页 · ${chars} 字` : `引用 · ${chars} 字`;
    }
    if (els.quoteText) {
      els.quoteText.textContent = truncate(quote.text, 160);
      els.quoteText.title = truncate(quote.text, 1200);
    }
  }

  /* --------------------------------------------------------- suggestions -- */
  function renderSuggest(hide) {
    if (!els.suggest) return;
    if (hide || state.busy) {
      els.suggest.textContent = "";
      return;
    }
    els.suggest.textContent = "";
    for (const text of SUGGESTIONS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "r-ai-chip";
      chip.textContent = text;
      chip.addEventListener("click", () => {
        if (state.busy) return;
        send(text, { quote: state.quote });
      });
      els.suggest.append(chip);
    }
  }

  /* -------------------------------------------------------- markdown -- */
  function inline(raw) {
    const text = String(raw == null ? "" : raw);
    const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[p(\d+)\]/g;
    let out = "";
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
      out += escapeHtml(text.slice(last, match.index));
      if (match[1] !== undefined) {
        out += `<strong>${escapeHtml(match[1])}</strong>`;
      } else if (match[2] !== undefined) {
        out += `<code>${escapeHtml(match[2])}</code>`;
      } else {
        const page = match[3];
        out += `<button type="button" class="r-ai-cite" data-page="${page}" data-ref="p${page}">p.${page}</button>`;
      }
      last = match.index + match[0].length;
    }
    out += escapeHtml(text.slice(last));
    return out;
  }

  function renderMarkdown(raw) {
    const lines = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    const blank = (line) => !line.trim();
    const bullet = (line) => /^[-*•]\s+/.test(line.trim());
    const ordered = (line) => /^\d+[.)]\s+/.test(line.trim());
    const quoted = (line) => /^>\s?/.test(line.trim());
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (blank(line)) {
        index += 1;
        continue;
      }
      if (quoted(line)) {
        const buffer = [];
        while (index < lines.length && quoted(lines[index])) {
          buffer.push(lines[index].trim().replace(/^>\s?/, ""));
          index += 1;
        }
        html.push(`<blockquote>${inline(buffer.join(" "))}</blockquote>`);
        continue;
      }
      if (bullet(line)) {
        const buffer = [];
        while (index < lines.length && bullet(lines[index])) {
          buffer.push(lines[index].trim().replace(/^[-*•]\s+/, ""));
          index += 1;
        }
        html.push(`<ul>${buffer.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
        continue;
      }
      if (ordered(line)) {
        const buffer = [];
        while (index < lines.length && ordered(lines[index])) {
          buffer.push(lines[index].trim().replace(/^\d+[.)]\s+/, ""));
          index += 1;
        }
        html.push(`<ol>${buffer.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
        continue;
      }
      const paragraph = [];
      while (
        index < lines.length &&
        !blank(lines[index]) &&
        !quoted(lines[index]) &&
        !bullet(lines[index]) &&
        !ordered(lines[index])
      ) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      if (!paragraph.length) {
        index += 1;
        continue;
      }
      html.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    }
    return html.join("");
  }

  /* --------------------------------------------------------- messages -- */
  function removeEmptyState() {
    const empty = els.messages ? $(".r-ai-empty", els.messages) : null;
    if (empty) empty.remove();
  }

  function scrollBottom() {
    if (!els.messages) return;
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function emptyCard() {
    const node = document.createElement("div");
    node.className = "r-ai-empty";
    node.innerHTML =
      '<p class="r-ai-empty-title">对着原文提问，答案带出处</p>' +
      '<p>在正文里选中文字 → 右键 →「引用提问…」。回答里的 <b>p.N</b> 可以点回原文，末尾还有「依据」列表。</p>';
    return node;
  }

  function updateHistoryBar() {
    if (!cache.historyBar) return;
    const turns = state.messages.filter((message) => message.role === "user").length;
    cache.historyBar.hidden = turns === 0;
    if (cache.historyCount) cache.historyCount.textContent = `对话记录 · ${turns} 轮`;
  }

  function renderThread() {
    if (!els.messages) return;
    els.messages.textContent = "";
    if (!state.messages.length) {
      els.messages.append(emptyCard());
    } else {
      for (const message of state.messages) {
        els.messages.append(messageNode(message));
      }
    }
    updateHistoryBar();
    scrollBottom();
  }

  function messageNode(message) {
    if (message.role === "user") {
      const node = document.createElement("div");
      node.className = "r-ai-msg user";
      node.textContent = String(message.content || "");
      return node;
    }
    return assistantNode(message);
  }

  function providerLabel(id) {
    const key = String(id || "").toLowerCase();
    return PROVIDER_NAMES[key] || (key ? String(id) : "");
  }

  function metaLine(message) {
    const bits = [];
    if (message.provider) bits.push(providerLabel(message.provider));
    if (message.model) bits.push(String(message.model));
    if (message.elapsed) {
      const seconds = Number(message.elapsed);
      if (Number.isFinite(seconds) && seconds > 0) bits.push(`${seconds.toFixed(1)}s`);
    }
    if (!bits.length) return null;
    const node = document.createElement("div");
    node.className = "r-ai-meta";
    node.textContent = bits.join(" · ");
    return node;
  }

  function citesBlock(citations) {
    const wrap = document.createElement("div");
    wrap.className = "r-ai-cites";
    const title = document.createElement("div");
    title.className = "r-ai-cites-title";
    title.textContent = "依据";
    wrap.append(title);
    for (const citation of citations) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "r-ai-cites-item";
      item.dataset.page = String(citation.page);
      item.dataset.ref = citation.ref;
      const top = document.createElement("span");
      top.className = "r-ai-cites-top";
      const page = document.createElement("span");
      page.className = "r-ai-cites-page";
      page.textContent = `p.${citation.page}`;
      top.append(page);
      if (citation.section) {
        const section = document.createElement("span");
        section.className = "r-ai-cites-sec";
        section.textContent = citation.section;
        top.append(section);
      }
      item.append(top);
      if (citation.snippet) {
        const snippet = document.createElement("span");
        snippet.className = "r-ai-cites-snip";
        snippet.textContent = truncate(citation.snippet, 110);
        item.append(snippet);
      }
      wrap.append(item);
    }
    return wrap;
  }

  function assistantNode(message) {
    const node = document.createElement("div");
    node.className = "r-ai-msg assistant";
    node.__citations = normalizeCitations(message.citations);
    const body = document.createElement("div");
    body.className = "r-ai-md";
    body.innerHTML = renderMarkdown(message.content || "（模型没有返回内容）");
    node.append(body);
    const meta = metaLine(message);
    if (meta) node.append(meta);
    if (node.__citations.length) node.append(citesBlock(node.__citations));
    return node;
  }

  function normalizeCitations(raw) {
    if (!Array.isArray(raw)) return [];
    const list = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const page = Number(entry.page);
      if (!Number.isFinite(page) || page <= 0) continue;
      list.push({
        ref: String(entry.ref || `p${page}`),
        page,
        section: String(entry.section || ""),
        snippet: String(entry.snippet || ""),
      });
    }
    return list;
  }

  function appendUser(text) {
    if (!els.messages) return null;
    removeEmptyState();
    const node = document.createElement("div");
    node.className = "r-ai-msg user";
    node.textContent = String(text || "");
    els.messages.append(node);
    scrollBottom();
    return node;
  }

  function appendPending(quote) {
    if (!els.messages) return null;
    removeEmptyState();
    const node = document.createElement("div");
    node.className = "r-ai-msg pending";
    node.innerHTML =
      '<span class="r-ai-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      `<span class="r-ai-pending-label">${quote && quote.text ? "正在结合所引原文…" : "正在读论文…"}</span>`;
    els.messages.append(node);
    scrollBottom();
    return node;
  }

  function appendAssistant(message) {
    if (!els.messages) return;
    removeEmptyState();
    els.messages.append(assistantNode(message));
    updateHistoryBar();
    scrollBottom();
  }

  function errorHint(message, status) {
    const text = String(message || "");
    if (/codex/i.test(text) && /(登录|login|auth|凭证)/i.test(text)) {
      return "在终端运行 codex login 完成登录后重试，或在「模型设置」里改用 API。";
    }
    if (/kimi/i.test(text) && /(登录|login|auth|凭证)/i.test(text)) {
      return "在终端运行 kimi 完成登录后重试，或在「模型设置」里改用 API。";
    }
    if (/claude/i.test(text) && /(登录|login|auth|凭证)/i.test(text)) {
      return "在终端运行 claude 完成登录后重试，或在「模型设置」里改用 API。";
    }
    if (/(未安装|not found|找不到|ENOENT|command not found)/i.test(text)) {
      return "这个命令行工具还没安装：安装并登录后重试，或在「模型设置」里选择 API。";
    }
    if (/(api[_ ]?key|密钥|401|403|unauthorized|invalid api)/i.test(text)) {
      return "在「模型设置」里填写 API Key（只加密保存在本机）后重试。";
    }
    if (/(超时|timeout|timed out)/i.test(text)) {
      return "模型响应太慢：可以重试，或在「模型设置」里换更快的模型。";
    }
    if (/(没有找到|材料不足|证据不足|无法回答)/i.test(text)) {
      return "试试选中相关段落后用「引用提问」，把检索范围集中到那一页。";
    }
    if (status === 404) return "后端版本可能较旧：退出应用后重新启动再试。";
    if (status === 503 || status === 504) return "模型服务暂时不可用：稍后重试，或换一个模型来源。";
    return "点「模型设置」检查模型来源 / API 地址 / Key，或换一个 provider 重试。";
  }

  function appendError(message, status, retry) {
    if (!els.messages) return;
    removeEmptyState();
    const node = document.createElement("div");
    node.className = "r-ai-msg error";
    const title = document.createElement("div");
    title.className = "r-ai-error-title";
    title.textContent = status ? `请求失败（HTTP ${status}）` : "请求失败";
    const body = document.createElement("div");
    body.className = "r-ai-error-body";
    body.textContent = String(message || "未知错误");
    const hint = document.createElement("div");
    hint.className = "r-ai-error-hint";
    hint.textContent = errorHint(message, status);
    const actions = document.createElement("div");
    actions.className = "r-ai-error-actions";
    if (typeof retry === "function") {
      const again = document.createElement("button");
      again.type = "button";
      again.className = "r-ai-btn primary";
      again.textContent = "重试";
      again.addEventListener("click", () => {
        node.remove();
        retry();
      });
      actions.append(again);
    }
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "r-ai-btn";
    settings.textContent = "模型设置";
    settings.addEventListener("click", openSettings);
    actions.append(settings);
    node.append(title, body, hint, actions);
    els.messages.append(node);
    scrollBottom();
  }

  /* ------------------------------------------------------------- ask -- */
  function providerPayload() {
    const settings = state.settings;
    return {
      id: settings.provider || "auto",
      model: String(settings.model || "").trim(),
      base_url: String(settings.base_url || "").trim(),
      api_key: "",
    };
  }

  function historyForRequest(prior) {
    return prior.slice(-6).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "").slice(0, 4000),
    }));
  }

  async function request(url, body, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs || 30000) : 0;
    try {
      const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const message =
          (data && (data.error || data.message)) || `请求失败（HTTP ${response.status}）`;
        return { ok: false, status: response.status, data, error: String(message) };
      }
      return { ok: true, status: response.status, data };
    } catch (error) {
      const aborted = error && error.name === "AbortError";
      return {
        ok: false,
        status: 0,
        error: aborted
          ? "请求超时：模型太久没有响应，请重试"
          : `无法连接应用后端（${(error && error.message) || "网络错误"}）`,
      };
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  function setComposing(active) {
    state.busy = active;
    if (els.send) els.send.disabled = active;
    if (els.input) els.input.setAttribute("aria-busy", active ? "true" : "false");
    if (els.drawer) els.drawer.classList.toggle("busy", active);
  }

  async function send(question, options = {}) {
    if (!els.input || state.busy) return;
    const text = String(question == null ? els.input.value : question).trim();
    if (!text) {
      toast("先写一个问题再发送", "bad");
      els.input.focus();
      return;
    }
    const quote = Object.prototype.hasOwnProperty.call(options, "quote") ? options.quote : state.quote;
    /* Page-only quotes are meaningful: the backend focuses retrieval on that
       page even when no excerpt could be extracted (e.g. page summaries). */
    const quotePayload = quote
      ? { text: String(quote.text || ""), page: Number(quote.page) || 0 }
      : null;
    const prior = state.messages.slice();
    const fromComposer = question == null;

    if (!options.silent) {
      appendUser(text);
    }
    if (fromComposer && !options.silent) els.input.value = "";
    renderSuggest(true);
    setComposing(true);
    const pending = appendPending(quotePayload);

    const result = await request(
      "/api/reader/ask",
      {
        path: docPath(),
        question: text,
        quote: quotePayload,
        history: historyForRequest(prior),
        provider: providerPayload(),
      },
      REQUEST_TIMEOUT
    );

    if (pending) pending.remove();
    setComposing(false);

    if (!result.ok) {
      renderSuggest();
      appendError(result.error, result.status, () => send(text, { quote: quotePayload, silent: true }));
      return;
    }

    const data = result.data || {};
    const answer = String(data.answer || "").trim();
    const citations = normalizeCitations(data.citations);
    const assistant = {
      role: "assistant",
      content: answer || "（模型没有返回内容）",
      citations,
      provider: data.provider || "",
      model: data.model || "",
      elapsed: data.elapsed || 0,
      ts: Date.now(),
    };
    if (!options.silent) {
      state.messages.push({ role: "user", content: text, ts: Date.now() });
    }
    state.messages.push(assistant);
    trimHistory();
    persist();
    /* A retry may already have its user bubble on screen; re-render keeps the
       stored history and the visible thread in sync. */
    renderThread();
    renderSuggest();
    scrollBottom();
    updateProviderUI();
  }

  function trimHistory() {
    if (state.messages.length > HISTORY_LIMIT) {
      state.messages = state.messages.slice(-HISTORY_LIMIT);
    }
  }

  function persist() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(state.messages.slice(-HISTORY_LIMIT)));
    } catch {
      /* private mode / quota: history is a convenience, never fatal */
    }
  }

  function isEntry(message) {
    return (
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string"
    );
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(storageKey());
      const parsed = raw ? JSON.parse(raw) : [];
      state.messages = Array.isArray(parsed)
        ? parsed.filter(isEntry).slice(-HISTORY_LIMIT).map((message) => ({
            ...message,
            citations: message.role === "assistant" ? normalizeCitations(message.citations) : undefined,
          }))
        : [];
    } catch {
      state.messages = [];
    }
    state.loaded = true;
  }

  function clearHistory() {
    state.messages = [];
    persist();
    renderThread();
    toast("已清空这篇论文的对话", "good");
  }

  /* -------------------------------------------------------- citations -- */
  async function jumpToCite(page, ref, messageNode) {
    const target = Math.round(Number(page));
    if (!Number.isFinite(target) || target <= 0) return;
    const citations = (messageNode && messageNode.__citations) || [];
    const match =
      citations.find((citation) => ref && citation.ref === ref) ||
      citations.find((citation) => citation.page === target);
    const snippet = match ? match.snippet : "";
    const bridge = window.ReaderBridge || {};
    let located = false;
    if (typeof bridge.flashText === "function") {
      try {
        located = await bridge.flashText(target, snippet, {});
      } catch {
        located = false;
      }
    } else if (typeof bridge.goToPage === "function") {
      try {
        bridge.goToPage(target, true);
      } catch {
        /* nothing else we can do */
      }
    }
    if (!located) {
      toast(`没定位到原文，已跳到第 ${target} 页`, "bad");
    }
  }

  /* ---------------------------------------------------------- status -- */
  function mergeSettings(base, patch) {
    const out = { ...base };
    if (!patch || typeof patch !== "object") return out;
    if (typeof patch.provider === "string" && patch.provider) out.provider = patch.provider;
    if (typeof patch.model === "string") out.model = patch.model;
    if (typeof patch.base_url === "string") out.base_url = patch.base_url;
    if (typeof patch.preset === "string" && patch.preset) out.preset = patch.preset;
    if (typeof patch.api_key_set === "boolean") out.api_key_set = patch.api_key_set;
    return out;
  }

  function statusProviders() {
    return state.status && Array.isArray(state.status.providers) ? state.status.providers : [];
  }

  function findProvider(id) {
    return statusProviders().find((item) => item && item.id === id) || null;
  }

  function providerStatus(id) {
    const found = findProvider(id);
    if (!found) {
      return { state: "unknown", label: "未检测", hint: "打开面板时会自动检测本机命令行工具。" };
    }
    if (found.available && found.logged_in) return { state: "ok", label: "已登录", hint: "" };
    if (found.available) {
      return {
        state: "warn",
        label: "未登录",
        hint: found.hint || LOGIN_HINTS[found.id] || "",
      };
    }
    return {
      state: "bad",
      label: "未安装",
      hint: found.hint || INSTALL_HINTS[found.id] || "未检测到命令行工具。",
    };
  }

  function effectiveLabel() {
    const settings = state.settings;
    const id = settings.provider || "auto";
    if (id === "api") {
      const model = String(settings.model || "").trim();
      if (model) return `API · ${model}`;
      return settings.api_key_set ? "API · 已存密钥" : "API · 待配置";
    }
    if (id === "auto") {
      const providers = statusProviders();
      if (!providers.length) return "自动";
      const ready = providers.filter((item) => item.available && item.logged_in);
      if (ready.length) return `${PROVIDER_SHORT[ready[0].id] || ready[0].name} · 已登录`;
      const usable = providers.find((item) => item.available);
      if (usable) return `${PROVIDER_SHORT[usable.id] || usable.name} · 未登录`;
      return "未检测到可用模型";
    }
    const found = findProvider(id);
    const name = PROVIDER_SHORT[id] || (found && found.name) || providerLabel(id);
    const info = providerStatus(id);
    if (info.state === "unknown") return `${name} · 未检测`;
    return `${name} · ${info.label}`;
  }

  function effectiveTitle() {
    const settings = state.settings;
    const bits = [`模型来源：${PROVIDER_NAMES[settings.provider || "auto"] || settings.provider}`];
    if (settings.provider === "api") {
      bits.push(settings.base_url || "未填 API 地址");
      if (settings.model) bits.push(settings.model);
      bits.push(settings.api_key_set ? "API Key 已保存" : "API Key 未保存");
      return bits.join(" · ");
    }
    const providers = statusProviders();
    if (providers.length) {
      bits.push(
        providers
          .map((item) => {
            const info = providerStatus(item.id);
            return `${PROVIDER_SHORT[item.id] || item.name} ${info.label}${
              item.version ? ` ${item.version}` : ""
            }`;
          })
          .join(" / ")
      );
    } else {
      bits.push("未检测到本机 CLI（使用自动时会回落到 API 配置）");
    }
    return bits.join(" · ");
  }

  function updateProviderUI() {
    if (els.pill) {
      const label = effectiveLabel();
      els.pill.textContent = label;
      els.pill.title = effectiveTitle();
      els.pill.dataset.state = pillState();
    }
    if (els.modelBtn) {
      const settings = state.settings;
      let label;
      if (settings.provider === "api") {
        label = String(settings.model || "").trim() || "API";
      } else if (settings.provider === "auto") {
        label = "自动";
      } else {
        label = PROVIDER_SHORT[settings.provider] || providerLabel(settings.provider);
      }
      els.modelBtn.textContent = `模型：${label}`;
      els.modelBtn.title = "打开模型设置";
    }
  }

  function pillState() {
    const id = state.settings.provider || "auto";
    if (id === "api") return state.settings.api_key_set ? "ok" : "warn";
    if (id === "auto") {
      const providers = statusProviders();
      if (!providers.length) return "unknown";
      if (providers.some((item) => item.available && item.logged_in)) return "ok";
      return providers.some((item) => item.available) ? "warn" : "bad";
    }
    return providerStatus(id).state;
  }

  async function refreshStatus(manual) {
    const result = await request("/api/ai/status", undefined, SETTINGS_TIMEOUT);
    if (!result.ok) {
      state.status = null;
      state.statusNote = result.error || "";
      updateProviderUI();
      if (state.settingsOpen) {
        renderProbe();
        showNote(`检测失败：${result.error}（仍可用「自动」默认配置提问）`, "bad");
      }
      if (manual) toast("检测失败，稍后再试", "bad");
      return;
    }
    state.status = result.data && typeof result.data === "object" ? result.data : null;
    state.statusNote = "";
    if (state.status && state.status.configured) {
      state.settings = mergeSettings(state.settings, state.status.configured);
    }
    updateProviderUI();
    if (state.settingsOpen) {
      renderProbe();
      if (manual) {
        const ready = statusProviders().filter((item) => item.available && item.logged_in).length;
        toast(ready ? `已检测到 ${ready} 个可用模型来源` : "没有检测到已登录的 CLI", ready ? "good" : "bad");
      }
    }
  }

  async function refreshSettings() {
    const result = await request("/api/ai/settings", undefined, SETTINGS_TIMEOUT);
    if (!result.ok) return;
    state.settings = mergeSettings(state.settings, result.data || {});
    updateProviderUI();
    if (state.settingsOpen) renderProbe();
  }

  /* --------------------------------------------------------- settings -- */
  function openSettings() {
    if (!els.settings || !els.drawer) return;
    state.settingsOpen = true;
    renderSettings();
    els.settings.hidden = false;
  }

  function closeSettings() {
    state.settingsOpen = false;
    if (els.settings) els.settings.hidden = true;
  }

  function providerOptionsHtml() {
    const current = state.settings.provider || "auto";
    return Object.keys(PROVIDER_NAMES)
      .map((id) => {
        const info = providerStatus(id);
        const dot = id === "api" || id === "auto" ? "" : `<i class="r-ai-probe-dot ${info.state}"></i>`;
        return (
          `<label class="r-ai-provider-opt${id === current ? " on" : ""}">` +
          `<input type="radio" name="ai-provider" value="${id}"${id === current ? " checked" : ""}>` +
          `${dot}<span>${escapeHtml(PROVIDER_NAMES[id])}</span></label>`
        );
      })
      .join("");
  }

  function presetOptionsHtml() {
    const current = state.settings.preset || "custom";
    const known = PRESETS.some((item) => item.id === current);
    return PRESETS.map(
      (preset) =>
        `<option value="${preset.id}"${preset.id === current ? " selected" : ""}>${escapeHtml(
          preset.label
        )}</option>`
    ).join("") + (known ? "" : `<option value="${escapeHtml(current)}" selected>自定义</option>`);
  }

  function noteHtml() {
    if (!state.settings.api_key_set) return "尚未保存 API Key；只用本机 CLI 时可以不填。";
    return "API Key 已加密保存在本机。";
  }

  function renderSettings() {
    if (!els.settings) return;
    const settings = state.settings;
    els.settings.innerHTML =
      '<div class="r-ai-settings-head">' +
      "<span>模型设置</span>" +
      '<button type="button" class="r-ai-iconbtn" data-ai-settings-close aria-label="关闭设置">✕</button>' +
      "</div>" +
      '<div class="r-ai-settings-body">' +
      '<div class="r-ai-field">' +
      '<span class="r-ai-field-label">模型来源</span>' +
      `<div class="r-ai-providers">${providerOptionsHtml()}</div>` +
      "</div>" +
      '<div class="r-ai-field">' +
      '<label class="r-ai-field-label" for="ai-opt-preset">API 预设</label>' +
      `<select id="ai-opt-preset" data-ai-opt="preset">${presetOptionsHtml()}</select>` +
      "</div>" +
      '<div class="r-ai-field">' +
      '<label class="r-ai-field-label" for="ai-opt-model">模型名</label>' +
      `<input id="ai-opt-model" data-ai-opt="model" type="text" autocomplete="off" ` +
      `placeholder="例如 gpt-4.1-mini" value="${escapeHtml(settings.model || "")}">` +
      "</div>" +
      '<div class="r-ai-field">' +
      '<label class="r-ai-field-label" for="ai-opt-base">API 地址（base_url）</label>' +
      `<input id="ai-opt-base" data-ai-opt="base_url" type="text" autocomplete="off" ` +
      `placeholder="https://api.moonshot.cn/v1" value="${escapeHtml(settings.base_url || "")}">` +
      "</div>" +
      '<div class="r-ai-field">' +
      '<label class="r-ai-field-label" for="ai-opt-key">API Key</label>' +
      `<input id="ai-opt-key" data-ai-opt="api_key" type="password" autocomplete="off" ` +
      `placeholder="${settings.api_key_set ? "已保存，留空不修改" : "sk-…"}">` +
      "</div>" +
      '<div class="r-ai-settings-actions">' +
      '<button type="button" class="r-ai-btn primary" data-ai-save>保存</button>' +
      '<button type="button" class="r-ai-btn" data-ai-test>测试连接</button>' +
      "</div>" +
      '<div class="r-ai-settings-note" data-ai-note hidden></div>' +
      '<div class="r-ai-probe" data-ai-probe></div>' +
      "</div>";
    cache.note = $("[data-ai-note]", els.settings);
    renderProbe();
  }

  function renderProbe() {
    if (!els.settings) return;
    const host = $("[data-ai-probe]", els.settings);
    if (!host) return;
    const providers = statusProviders();
    const rows = providers
      .map((provider) => {
        const info = providerStatus(provider.id);
        const hint =
          info.state === "ok"
            ? ""
            : info.hint || (typeof provider.hint === "string" ? provider.hint : "");
        const version = provider.version ? `<span class="r-ai-probe-ver">${escapeHtml(provider.version)}</span>` : "";
        const hintText = hint ? `<div class="r-ai-probe-hint">${escapeHtml(hint)}</div>` : "";
        return (
          '<div class="r-ai-probe-item">' +
          `<i class="r-ai-probe-dot ${info.state}"></i>` +
          '<div class="r-ai-probe-main">' +
          `<div class="r-ai-probe-name">${escapeHtml(provider.name || PROVIDER_NAMES[provider.id] || provider.id)} ${version}</div>` +
          hintText +
          "</div>" +
          `<span class="r-ai-badge ${info.state}">${escapeHtml(info.label)}</span>` +
          "</div>"
        );
      })
      .join("");
    const apiState = state.settings.api_key_set ? "ok" : "warn";
    const apiRow =
      '<div class="r-ai-probe-item">' +
      `<i class="r-ai-probe-dot ${apiState}"></i>` +
      '<div class="r-ai-probe-main">' +
      '<div class="r-ai-probe-name">API（OpenAI 兼容）</div>' +
      `<div class="r-ai-probe-hint">${noteHtml()}</div>` +
      "</div>" +
      `<span class="r-ai-badge ${apiState}">${state.settings.api_key_set ? "已配置" : "未配置"}</span>` +
      "</div>";
    host.innerHTML =
      '<div class="r-ai-probe-head"><span>本机模型探测</span>' +
      '<button type="button" class="r-ai-linkbtn" data-ai-rescan>重新检测</button></div>' +
      (rows || `<div class="r-ai-probe-empty">${escapeHtml(state.statusNote || "还没有检测结果。")}</div>`) +
      apiRow +
      '<p class="r-ai-probe-foot">检测结果缓存约 1 分钟；提示安装或登录时，在终端完成后再点「重新检测」。</p>';
  }

  function collectSettingsForm() {
    const providerInput = $('input[name="ai-provider"]:checked', els.settings);
    const model = $('[data-ai-opt="model"]', els.settings);
    const base = $('[data-ai-opt="base_url"]', els.settings);
    const key = $('[data-ai-opt="api_key"]', els.settings);
    const preset = $('[data-ai-opt="preset"]', els.settings);
    return {
      provider: providerInput ? providerInput.value : state.settings.provider || "auto",
      model: model ? model.value.trim() : "",
      base_url: base ? base.value.trim() : "",
      preset: preset ? preset.value : state.settings.preset || "custom",
      api_key: key ? key.value : "",
    };
  }

  function showNote(text, kind) {
    if (!cache.note) return;
    if (!text) {
      cache.note.hidden = true;
      cache.note.textContent = "";
      return;
    }
    cache.note.hidden = false;
    cache.note.textContent = text;
    cache.note.className = `r-ai-settings-note ${kind || ""}`;
  }

  function setSettingsBusy(active) {
    if (!els.settings) return;
    for (const button of els.settings.querySelectorAll("[data-ai-save], [data-ai-test]")) {
      button.disabled = active;
    }
  }

  async function saveSettings() {
    if (!els.settings) return;
    const form = collectSettingsForm();
    setSettingsBusy(true);
    showNote("保存中…", "");
    const result = await request(
      "/api/ai/settings",
      {
        provider: form.provider,
        model: form.model,
        base_url: form.base_url,
        preset: form.preset,
        api_key: form.api_key,
      },
      SETTINGS_TIMEOUT
    );
    setSettingsBusy(false);
    if (!result.ok) {
      showNote(`保存失败：${result.error}`, "bad");
      return;
    }
    const data = result.data && typeof result.data === "object" ? result.data : {};
    const next = mergeSettings(state.settings, data);
    next.provider = form.provider;
    next.model = form.model;
    next.base_url = form.base_url;
    next.preset = form.preset;
    if (form.api_key) next.api_key_set = true;
    state.settings = next;
    updateProviderUI();
    renderSettings();
    showNote("已保存", "ok");
    toast("模型设置已保存", "good");
  }

  async function testConnection() {
    if (!els.settings) return;
    const form = collectSettingsForm();
    if (!form.base_url || !form.model) {
      showNote("测试连接需要先填 base_url 与模型名", "bad");
      return;
    }
    setSettingsBusy(true);
    showNote("正在测试连接…", "");
    const result = await request(
      "/api/test-connection",
      { base_url: form.base_url, model: form.model, api_key: form.api_key || "" },
      30000
    );
    setSettingsBusy(false);
    if (!result.ok) {
      showNote(`测试失败：${result.error}`, "bad");
      return;
    }
    const data = result.data || {};
    if (data.ok) {
      const latency = Number(data.latency_ms);
      showNote(`连接成功 · ${Number.isFinite(latency) ? `${latency} ms` : "响应正常"}`, "ok");
    } else {
      const detail = data.message || data.error || (data.status ? `HTTP ${data.status}` : "未知错误");
      showNote(`连接失败：${String(detail).slice(0, 300)}`, "bad");
    }
  }

  /* ------------------------------------------------------------- api -- */
  function open(options) {
    openDrawer();
    closeSettings();
    const page = Number(options && (options.page || (options.quote && options.quote.page))) || 0;
    if (page) {
      const question = `请总结第 ${page} 页的主要内容，并用 [pN] 标注依据。`;
      setQuote(null);
      pageExcerpt(page).then((text) => {
        if (!state.open) return;
        send(question, { quote: text ? { text, page } : { text: "", page } });
      });
      return;
    }
    if (els.input) els.input.focus();
  }

  /* Text layer of far-away pages may not be built yet, so fall back to pdf.js
     directly — the page-summary request should still be grounded. */
  async function pageExcerpt(page) {
    const bridge = window.ReaderBridge;
    if (!bridge) return "";
    try {
      if (typeof bridge.getPageText === "function") {
        const ready = String(bridge.getPageText(page) || "").replace(/\s+/g, " ").trim();
        if (ready) return ready.slice(0, 600);
      }
    } catch {
      /* fall through to the PDF proxy */
    }
    const pdf = typeof bridge.getPdf === "function" ? bridge.getPdf() : null;
    if (!pdf || typeof pdf.getPage !== "function") return "";
    try {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      const text = (content.items || [])
        .map((item) => (item && item.str) || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return text.slice(0, 600);
    } catch {
      return "";
    }
  }

  function quote(captured, options = {}) {
    openDrawer();
    closeSettings();
    const info = normalizeCaptured(captured);
    setQuote(info);
    const question = String((options && options.question) || "").trim();
    if (question) {
      if (els.input) els.input.value = question;
      renderSuggest(true);
    } else {
      if (els.input) els.input.value = "";
      renderSuggest();
    }
    focusInputSoon();
  }

  function focusInput() {
    openDrawer();
    focusInputSoon();
  }

  window.ReaderAI = { open, quote, focusInput, version: 1 };

  boot();
})();
