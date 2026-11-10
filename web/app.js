/* ReadPI front-end — vanilla JS, no build step. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    boot: null,
    providers: {},
    files: [],
    jobId: null,
    cursor: 0,
    timer: null,
    running: false,
    glossaries: [],
    providerModels: {},
    saveTimer: null,
    stage: "entry",
    stageTimer: null,
    firstRun: false,
  };

  const el = {
    btnTheme: $("#btn-theme"),
    stageEntry: $("#stage-entry"),
    stageWork: $("#stage-work"),
    heroDrop: $("#hero-drop"),
    heroDropTitle: $("#hero-drop-title"),
    enginePill: $("#engine-pill"),
    engineText: $("#engine-text"),
    enginePath: $("#engine-path"),
    dropZone: $("#drop-zone"),
    fileInput: $("#file-input"),
    fileList: $("#file-list"),
    btnChoose: $("#btn-choose"),
    langOut: $("#lang-out"),
    langIn: $("#lang-in"),
    provider: $("#provider"),
    model: $("#model"),
    modelOptions: $("#model-options"),
    pageMode: $("#page-mode"),
    pageRange: $("#page-range"),
    dualMode: $("#dual-mode"),
    glossary: $("#glossary"),
    autoGlossary: $("#auto-glossary"),
    saveGlossary: $("#save-glossary"),
    skipReferences: $("#skip-references"),
    referencePage: $("#reference-page"),
    priceInput: $("#price-input"),
    priceOutput: $("#price-output"),
    priceCurrency: $("#price-currency"),
    usageLine: $("#usage-line"),
    outputDir: $("#output-dir"),
    btnOutput: $("#btn-output"),
    baseUrl: $("#base-url"),
    apiKey: $("#api-key"),
    btnReveal: $("#btn-reveal"),
    rememberKey: $("#remember-key"),
    qps: $("#qps"),
    watermark: $("#watermark"),
    termModel: $("#term-model"),
    customPrompt: $("#custom-prompt"),
    skipScanned: $("#skip-scanned"),
    ocrWorkaround: $("#ocr-workaround"),
    openWhenDone: $("#open-when-done"),
    btnTest: $("#btn-test"),
    testResult: $("#test-result"),
    btnAdvanced: $("#btn-advanced"),
    advanced: $("#advanced"),
    progressBlock: $("#progress-block"),
    jobCard: $("#job-card"),
    jobName: $("#job-name"),
    jobMeta: $("#job-meta"),
    jobNote: $("#job-note"),
    stage: $("#stage"),
    percent: $("#percent"),
    progressFill: $("#progress-fill"),
    btnLog: $("#btn-log"),
    log: $("#log"),
    summary: $("#summary"),
    btnStart: $("#btn-start"),
    btnCancel: $("#btn-cancel"),
    resultCard: $("#result-card"),
    resultList: $("#result-list"),
    btnQuit: $("#btn-quit"),
    toasts: $("#toasts"),
    glossaryModal: $("#glossary-modal"),
    glossaryList: $("#glossary-list"),
    presetList: $("#preset-list"),
    glossaryName: $("#glossary-name"),
    glossaryEntries: $("#glossary-entries"),
    glossaryCount: $("#glossary-count"),
    btnGlossary: $("#btn-glossary"),
    btnGlossaryClose: $("#btn-glossary-close"),
    btnGlossarySave: $("#btn-glossary-save"),
    glossaryImport: $("#glossary-import"),
    openSettings: $("#open-settings"),
    settingsModal: $("#settings-modal"),
    settingsClose: $("#settings-close"),
    settingsCancel: $("#settings-cancel"),
    settingsDone: $("#settings-done"),
    quickProvider: $("#quick-provider"),
    quickModel: $("#quick-model"),
    quickModelOptions: $("#quick-model-options"),
    quickModelToggle: $("#quick-model-toggle"),
    quickModelMenu: $("#quick-model-menu"),
    modelToggle: $("#model-toggle"),
    modelMenu: $("#model-menu"),
    quickLangIn: $("#quick-lang-in"),
    quickLangOut: $("#quick-lang-out"),
    quickDual: $("#quick-dual"),
    quickGlossary: $("#quick-glossary"),
    quickKey: $("#quick-key"),
    quickKeyState: $("#quick-key-state"),
    compatFirst: $("#compat-first"),
    longDocHint: $("#longdoc-hint"),
    helpTip: $("#help-tip"),
    btnSettingsEntry: $("#btn-settings-entry"),
    btnHeroSettings: $("#btn-hero-settings"),
    zoteroStatus: $("#zotero-status"),
    zoteroDownload: $("#zotero-download"),
  };

  /* ------------------------------------------------------------- theme -- */
  const THEME_KEY = "babeldoc-theme";
  const THEMES = ["auto", "light", "dark"];

  function initialTheme() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get("theme");
    if (fromUrl === "light" || fromUrl === "dark") return fromUrl;
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : "auto";
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    if (el.btnTheme) {
      el.btnTheme.title =
        theme === "auto" ? "外观：跟随系统" : theme === "dark" ? "外观：深色" : "外观：浅色";
    }
  }

  function cycleTheme() {
    const stored = localStorage.getItem(THEME_KEY) || "auto";
    const next = THEMES[(THEMES.indexOf(stored) + 1) % THEMES.length];
    applyTheme(next);
  }

  /* ----------------------------------------------------------- utilities -- */
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

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  function formatSize(bytes) {
    if (!bytes && bytes !== 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function totalPages() {
    return state.files.reduce((sum, item) => sum + (item.pages || 0), 0);
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function pulse(node) {
    if (!node || prefersReducedMotion()) return;
    node.classList.remove("bump");
    void node.offsetWidth;
    node.classList.add("bump");
    node.addEventListener("animationend", () => node.classList.remove("bump"), { once: true });
  }

  function spawnRipple(x, y) {
    if (prefersReducedMotion()) return;
    const node = document.createElement("span");
    node.className = "ripple";
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    document.body.appendChild(node);
    node.addEventListener("animationend", () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 1000);
  }

  /* ----------------------------------------------------------- tooltips --
   * One shared floating bubble for advanced-option explanations. The bubble
   * lives on <body> so neither the settings card's overflow nor the sheet's
   * scroll container can clip it; it is positioned in viewport coordinates
   * and clamped to the visible area. */
  const HELP_DELAY = 150;
  let helpTimer = null;
  let helpAnchor = null;

  function placeHelpTip() {
    if (!helpAnchor || !el.helpTip || el.helpTip.hidden) return;
    const anchorRect = helpAnchor.getBoundingClientRect();
    const tipRect = el.helpTip.getBoundingClientRect();
    const margin = 8;
    let top = anchorRect.top - tipRect.height - 8;
    if (top < margin) {
      const below = anchorRect.bottom + 8;
      top =
        below + tipRect.height <= window.innerHeight - margin
          ? below
          : Math.max(margin, window.innerHeight - tipRect.height - margin);
    }
    const centered = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
    const left = Math.max(margin, Math.min(centered, window.innerWidth - tipRect.width - margin));
    el.helpTip.style.top = `${Math.round(top)}px`;
    el.helpTip.style.left = `${Math.round(left)}px`;
  }

  function showHelpTip(anchor) {
    if (!anchor || !el.helpTip) return;
    const text = anchor.getAttribute("data-help");
    if (!text) return;
    clearTimeout(helpTimer);
    helpTimer = null;
    helpAnchor = anchor;
    el.helpTip.textContent = text;
    el.helpTip.hidden = false;
    placeHelpTip();
  }

  function hideHelpTip() {
    clearTimeout(helpTimer);
    helpTimer = null;
    helpAnchor = null;
    if (el.helpTip) el.helpTip.hidden = true;
  }

  function scheduleHelpTip(anchor) {
    clearTimeout(helpTimer);
    helpTimer = setTimeout(() => showHelpTip(anchor), HELP_DELAY);
  }

  function bindHelpTips() {
    $$("[data-help]").forEach((anchor) => {
      anchor.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "touch") return;
        scheduleHelpTip(anchor);
      });
      anchor.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "touch") return;
        hideHelpTip();
      });
      /* focusin/focusout bubble from the checkbox and the ? button. */
      anchor.addEventListener("focusin", () => scheduleHelpTip(anchor));
      anchor.addEventListener("focusout", () => hideHelpTip());
    });
    /* Touch / click affordance for the ? button (also stops the label from
       toggling its checkbox when the fact was asked for). */
    $$(".help-dot").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = button.closest("[data-help]");
        if (!el.helpTip.hidden && helpAnchor === anchor) hideHelpTip();
        else showHelpTip(anchor);
      });
    });
    window.addEventListener("scroll", placeHelpTip, true);
    window.addEventListener("resize", placeHelpTip);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && el.helpTip && !el.helpTip.hidden) {
          hideHelpTip();
          event.stopPropagation();
        }
      },
      true
    );
  }

  /* ------------------------------------------------------------- stages --
   * "entry"  — nothing uploaded yet, only the single drop target is shown.
   * "work"   — files present, the settings/action/results cards fade in.
   */
  const STAGE_OUT_MS = 190;
  const ENTRANCE_MS = 1100;
  let entranceTimer = null;
  let firstRunFocusTimer = null;

  function showStage(next, options = {}) {
    if (state.stage === next && !options.force) return;
    const animate = options.animate !== false;
    const target = next === "work" ? el.stageWork : el.stageEntry;
    const other = next === "work" ? el.stageEntry : el.stageWork;
    state.stage = next;
    document.body.dataset.stage = next;
    clearTimeout(state.stageTimer);

    const reveal = () => {
      other.hidden = true;
      other.classList.remove("stage-leaving", "stage-enter");
      target.hidden = false;
      target.classList.remove("stage-enter");
      void target.offsetWidth; /* restart the entrance animations */
      if (animate) {
        target.classList.add("stage-enter");
        clearTimeout(entranceTimer);
        entranceTimer = setTimeout(() => target.classList.remove("stage-enter"), ENTRANCE_MS);
      }
      if (next === "work") afterWorkReveal();
      window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    };

    if (!animate || prefersReducedMotion()) {
      reveal();
      return;
    }
    other.classList.remove("stage-enter");
    other.classList.add("stage-leaving");
    state.stageTimer = setTimeout(reveal, STAGE_OUT_MS);
  }

  function syncStage() {
    showStage(state.files.length ? "work" : "entry");
  }

  function openAdvanced() {
    el.advanced.hidden = false;
    el.btnAdvanced.setAttribute("aria-expanded", "true");
  }

  /* First run: the API key cannot be filled in before a file exists, so the
     advanced panel opens right after the first upload instead of on boot. */
  function afterWorkReveal() {
    if (state.firstRun || location.hash === "#advanced") {
      openAdvanced();
      if (state.firstRun) {
        clearTimeout(firstRunFocusTimer);
        firstRunFocusTimer = setTimeout(() => el.apiKey.focus(), 300);
      }
      state.firstRun = false;
    }
  }

  /* ------------------------------------------------------------- render -- */
  function renderLanguages() {
    const options = state.boot.languages
      .map((lang) => `<option value="${lang.code}">${lang.label}</option>`)
      .join("");
    el.langOut.innerHTML = options;
    el.langIn.innerHTML = options;
    el.quickLangOut.innerHTML = options;
    el.quickLangIn.innerHTML = options;
  }

  function renderProviders() {
    const providerOptions = state.boot.providers
      .map((item) => `<option value="${item.id}">${item.name}</option>`)
      .join("");
    el.provider.innerHTML = providerOptions;
    el.quickProvider.innerHTML = providerOptions;
    state.providerModels = {};
    state.boot.providers.forEach((item) => {
      state.providerModels[item.id] = { models: item.models, base_url: item.base_url, hint: item.hint };
    });
  }

  function renderModelOptions(providerId) {
    const preset = state.providerModels[providerId] || { models: [] };
    const modelOptions = preset.models
      .map((name) => `<option value="${name}"></option>`)
      .join("");
    el.modelOptions.innerHTML = modelOptions;
    el.quickModelOptions.innerHTML = modelOptions;
  }

  /* ---------------------------------------------------- model comboboxes --
   * Edge's app window often ignores the click target of a native datalist
   * arrow, so both model fields also get a real chevron + menu. The existing
   * <datalist> elements stay in the DOM as a fallback, and free typing keeps
   * working: the input remains the source of truth, options only fill it. */
  const modelCombos = [];

  function providerIdFor(select) {
    return (select && select.value) || el.provider.value;
  }

  function providerModelList(providerId) {
    const preset = state.providerModels[providerId] || {};
    return Array.isArray(preset.models) ? preset.models.slice() : [];
  }

  function closeAllCombos(except) {
    modelCombos.forEach((combo) => {
      if (combo !== except) combo.closeMenu();
    });
  }

  function refreshModelCombos() {
    modelCombos.forEach((combo) => combo.refresh());
  }

  function createModelCombo({ input, toggle, menu, providerSelect }) {
    if (!input || !toggle || !menu) return null;
    let open = false;
    let options = [];
    let activeIndex = -1;

    function build() {
      const models = providerModelList(providerIdFor(providerSelect));
      const current = input.value.trim();
      if (!models.length) {
        menu.innerHTML =
          '<p class="combo-empty" role="presentation">可直接输入自定义模型</p>';
      } else {
        const rows = models
          .map((name) => {
            const selected = name === current;
            return (
              `<button type="button" class="combo-option${selected ? " is-selected" : ""}"` +
              ` role="option" tabindex="-1" aria-selected="${selected}"` +
              ` data-value="${escapeHtml(name)}">` +
              `<span class="combo-option-text">${escapeHtml(name)}</span>` +
              `${selected ? '<span class="combo-check" aria-hidden="true">✓</span>' : ""}` +
              "</button>"
            );
          })
          .join("");
        menu.innerHTML =
          `${rows}<p class="combo-note" role="presentation">也可直接输入自定义模型</p>`;
      }
      options = $$(".combo-option", menu);
      options.forEach((option) => {
        option.addEventListener("click", () => choose(option.dataset.value || ""));
      });
      activeIndex = -1;
    }

    function place() {
      if (!open) return;
      const rect = input.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 180), 340);
      menu.style.width = `${Math.round(width)}px`;
      const menuRect = menu.getBoundingClientRect();
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(rect.left, window.innerWidth - width - margin)
      );
      let top = rect.bottom + 4;
      if (top + menuRect.height > window.innerHeight - margin) {
        const above = rect.top - menuRect.height - 4;
        top =
          above >= margin
            ? above
            : Math.max(margin, window.innerHeight - menuRect.height - margin);
      }
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(top)}px`;
    }

    function setActive(index, scroll = true) {
      if (!options.length) {
        activeIndex = -1;
        return;
      }
      activeIndex = ((index % options.length) + options.length) % options.length;
      options.forEach((option, i) =>
        option.classList.toggle("is-active", i === activeIndex)
      );
      if (scroll && options[activeIndex]) {
        options[activeIndex].scrollIntoView({ block: "nearest" });
      }
    }

    function closeMenu() {
      if (!open) return;
      open = false;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      input.setAttribute("aria-expanded", "false");
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    }

    function openMenu() {
      if (input.disabled || toggle.disabled) return;
      closeAllCombos(combo);
      build();
      open = true;
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-expanded", "true");
      place();
      const selected = options.findIndex((option) =>
        option.classList.contains("is-selected")
      );
      setActive(selected >= 0 ? selected : -1, false);
      window.addEventListener("scroll", place, true);
      window.addEventListener("resize", place);
    }

    function refresh() {
      build();
      if (open) place();
    }

    function choose(value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      closeMenu();
      input.focus();
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) {
          openMenu();
          return;
        }
        setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (event.key === "Enter" && open) {
        event.preventDefault();
        if (activeIndex >= 0 && options[activeIndex]) {
          choose(options[activeIndex].dataset.value || "");
        } else {
          closeMenu();
        }
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        return;
      }
      if (open && event.key === "Home") {
        event.preventDefault();
        setActive(0);
        return;
      }
      if (open && event.key === "End") {
        event.preventDefault();
        setActive(options.length - 1);
        return;
      }
      /* Tabbing out of the field should not leave a floating menu behind. */
      if (open && event.key === "Tab") closeMenu();
    });

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      if (open) {
        closeMenu();
      } else {
        openMenu();
        input.focus();
      }
    });

    /* A pointerdown outside both the field and the menu dismisses it. */
    document.addEventListener("pointerdown", (event) => {
      if (!open) return;
      const target = event.target;
      if (menu.contains(target) || input.contains(target) || toggle.contains(target)) {
        return;
      }
      closeMenu();
    });
    window.addEventListener("blur", closeMenu);

    const combo = { input, toggle, menu, build, refresh, openMenu, closeMenu };
    modelCombos.push(combo);
    return combo;
  }

  function bindModelCombos() {
    createModelCombo({
      input: el.quickModel,
      toggle: el.quickModelToggle,
      menu: el.quickModelMenu,
      providerSelect: el.quickProvider,
    });
    createModelCombo({
      input: el.model,
      toggle: el.modelToggle,
      menu: el.modelMenu,
      providerSelect: el.provider,
    });
  }

  /* Docs of 30+ pages are where upstream blank-output bugs surface; suggest
     the compat switch without ever turning it on for the user. */
  function updateLongDocHint() {
    if (!el.longDocHint) return;
    const pages = totalPages();
    if (pages >= 30) {
      el.longDocHint.innerHTML =
        `当前文档共 <strong>${pages}</strong> 页，属于长文档；` +
        "若译文出现空白，建议开启兼容性优先后重译";
      el.longDocHint.hidden = false;
    } else {
      el.longDocHint.hidden = true;
    }
  }

  function renderGlossarySelect() {
    const current = el.glossary.value;
    const options = ['<option value="">不使用术语库</option>']
      .concat(
        state.glossaries.map(
          (item) => `<option value="${item.id}">${item.name}（${item.count} 条）</option>`
        )
      )
      .join("");
    el.glossary.innerHTML = options;
    el.quickGlossary.innerHTML = options;
    if (current && state.glossaries.some((g) => g.id === current)) {
      el.glossary.value = current;
      el.quickGlossary.value = current;
    }
  }

  function renderPageModeOptions() {
    const pages = totalPages();
    const suffix = pages ? `（共 ${pages} 页）` : "";
    const current = el.pageMode.value;
    el.pageMode.innerHTML = [
      `<option value="all">全部页${suffix}</option>`,
      '<option value="custom">自定义范围…</option>',
    ].join("");
    if (current === "custom") el.pageMode.value = "custom";
  }

  function renderFiles() {
    el.dropZone.classList.toggle("compact", state.files.length > 0);
    if (!state.files.length) {
      el.fileList.hidden = true;
      el.fileList.innerHTML = "";
      return;
    }
    el.fileList.hidden = false;
    el.fileList.innerHTML = state.files
      .map(
        (file, index) => `
        <div class="file-row" data-path="${escapeHtml(file.path)}" style="--i:${index}">
          <div class="file-badge">PDF</div>
          <div class="file-body">
            <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</div>
            <div class="file-meta">${file.pages ? `${file.pages} 页` : "页数未知"} · ${formatSize(file.size)}</div>
          </div>
          <button class="file-remove" type="button" title="移除" aria-label="移除 ${escapeHtml(file.name)}">✕</button>
        </div>`
      )
      .join("");
    $$(".file-remove", el.fileList).forEach((button) => {
      button.addEventListener("click", () => removeFile(button.closest(".file-row")));
    });
  }

  function removeFile(row) {
    if (!row) return;
    if (state.running) {
      toast("翻译进行中，先取消任务再移除文件", "bad");
      return;
    }
    const path = row.dataset.path || "";
    if (!state.files.some((file) => file.path === path)) return;

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const index = state.files.findIndex((file) => file.path === path);
      if (index >= 0) state.files.splice(index, 1);
      renderFiles();
      refreshSummary();
      syncStage();
      persistFiles();
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }
    row.classList.add("removing");
    row.addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 260);
  }

  function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  function refreshSummary() {
    if (!state.files.length) {
      el.summary.textContent = "还没有添加文件";
    } else {
      const pages = totalPages();
      el.summary.innerHTML = `<strong>${state.files.length}</strong> 个文件${
        pages ? ` · 共 <strong>${pages}</strong> 页` : ""
      }`;
    }
    el.btnStart.disabled = !state.files.length || state.running;
    renderPageModeOptions();
    updateLongDocHint();
    if (state.files.length) pulse(el.summary);
  }

  function renderEngine(info) {
    if (info.available) {
      el.enginePill.classList.add("ok");
      el.enginePill.classList.remove("bad");
      el.engineText.textContent = info.version ? `BabelDOC ${info.version}` : "BabelDOC 已就绪";
      el.enginePath.textContent = info.path;
    } else {
      el.enginePill.classList.add("bad");
      el.enginePill.classList.remove("ok");
      el.engineText.textContent = "未检测到 BabelDOC";
      el.enginePath.textContent = "请先运行：uv tool install babeldoc";
    }
    /* Narrow toolbars hide the label but keep the status dot; the full text
       stays available as a tooltip / accessible name. */
    el.enginePill.title = el.engineText.textContent;
    el.enginePill.setAttribute("aria-label", el.engineText.textContent);
  }

  /* ------------------------------------------------------------ settings -- */
  function applySettings(settings) {
    const providerId = settings.active_provider || "zhipu";
    el.provider.value = providerId;
    renderModelOptions(providerId);

    const providerState = (settings.providers || {})[providerId] || {};
    const preset = state.providerModels[providerId] || {};

    el.langOut.value = settings.lang_out || "zh";
    el.langIn.value = settings.lang_in || "en";
    el.pageMode.value = settings.page_mode || "all";
    el.pageRange.value = settings.page_range || "";
    el.pageRange.hidden = el.pageMode.value !== "custom";
    el.dualMode.value = settings.dual_mode || "side";
    el.autoGlossary.checked = settings.auto_glossary !== false;
    el.saveGlossary.checked = settings.save_glossary !== false;
    el.skipReferences.checked = settings.skip_references !== false;
    el.referencePage.value = settings.reference_page || "";
    el.priceInput.value = settings.price_input || "";
    el.priceOutput.value = settings.price_output || "";
    el.priceCurrency.value = settings.price_currency || "";
    el.outputDir.value = settings.output_dir || "";
    el.watermark.value = settings.watermark || "no_watermark";
    el.qps.value = settings.qps || 4;
    el.termModel.value = settings.term_model || "";
    el.customPrompt.value = settings.custom_prompt || "";
    el.skipScanned.checked = !!settings.skip_scanned;
    el.ocrWorkaround.checked = !!settings.ocr_workaround;
    el.compatFirst.checked = !!settings.compat_first;
    el.openWhenDone.checked = settings.open_when_done !== false;
    el.rememberKey.checked = !!providerState.remember;
    el.baseUrl.value = providerState.base_url || preset.base_url || "";
    el.model.value = providerState.model || (preset.models && preset.models[0]) || "";
    el.apiKey.value = providerState.api_key || "";
    syncProviderFields(providerId);

    const ids = settings.glossary_ids || [];
    el.glossary.value = ids.length ? ids[0] : "";
    renderPageModeOptions();
    updateSettingsSummary();
  }

  function collectSettings() {
    const providerId = el.provider.value;
    const providers = JSON.parse(JSON.stringify(state.providers || {}));
    providers[providerId] = {
      base_url: el.baseUrl.value.trim(),
      model: el.model.value.trim(),
      api_key: el.apiKey.value,
      remember: el.rememberKey.checked,
    };
    const glossaryId = el.glossary.value;
    return {
      active_provider: providerId,
      providers,
      lang_in: el.langIn.value,
      lang_out: el.langOut.value,
      page_mode: el.pageMode.value,
      page_range: el.pageRange.value.trim(),
      dual_mode: el.dualMode.value,
      glossary_ids: glossaryId ? [glossaryId] : [],
      auto_glossary: el.autoGlossary.checked,
      save_glossary: el.saveGlossary.checked,
      skip_references: el.skipReferences.checked,
      reference_page: el.referencePage.value.trim(),
      price_input: el.priceInput.value.trim(),
      price_output: el.priceOutput.value.trim(),
      price_currency: el.priceCurrency.value,
      output_dir: el.outputDir.value.trim(),
      watermark: el.watermark.value,
      open_when_done: el.openWhenDone.checked,
      qps: Number(el.qps.value) || 4,
      custom_prompt: el.customPrompt.value,
      skip_scanned: el.skipScanned.checked,
      ocr_workaround: el.ocrWorkaround.checked,
      compat_first: el.compatFirst.checked,
      term_model: el.termModel.value.trim(),
      term_model_enabled: Boolean(el.termModel.value.trim()),
    };
  }

  function optionLabel(select) {
    const option = select.options[select.selectedIndex];
    return option ? option.textContent.trim() : "";
  }

  function updateSettingsSummary() {
    if (!el.quickProvider) return;
    el.quickProvider.value = el.provider.value;
    el.quickModel.value = el.model.value;
    el.quickModel.disabled = el.model.disabled;
    el.quickLangIn.value = el.langIn.value;
    el.quickLangOut.value = el.langOut.value;
    el.quickDual.value = el.dualMode.value;
    el.quickGlossary.value = el.glossary.value;
    updateKeyStatus();
  }

  /* Only the *state* of the active provider's key is surfaced here — never
     the key itself. */
  function activeKeyStatus() {
    const providerId = el.provider.value;
    if (providerId === "google_free") {
      return {
        label: "无需 Key",
        state: "free",
        title: "内置免费接口，无需填写 API Key",
      };
    }
    const key = (el.apiKey.value || "").trim();
    if (!key) {
      return { label: "未填写", state: "empty", title: "还没有填写 API Key，点击填写" };
    }
    if (!el.rememberKey.checked) {
      return {
        label: "未保存",
        state: "warn",
        title: "已填写但未勾选「记住 Key」，重启应用后需要重新填写",
      };
    }
    return { label: "已保存", state: "saved", title: "Key 已用 DPAPI 加密保存在本机" };
  }

  function updateKeyStatus() {
    if (!el.quickKey || !el.quickKeyState) return;
    const status = activeKeyStatus();
    el.quickKeyState.textContent = status.label;
    el.quickKeyState.dataset.state = status.state;
    el.quickKey.title = `API Key：${status.label} · ${status.title}`;
    el.quickKey.setAttribute("aria-label", `API Key：${status.label}，点击打开设置`);
  }

  /* Jump straight to the key field: open the existing sheet, reveal the
     advanced section and focus #api-key (autosave picks the edit up). */
  function openKeySettings() {
    openSettingsSheet();
    openAdvanced();
    el.apiKey.focus();
  }

  function syncProviderFields(providerId) {
    const free = providerId === "google_free";
    el.baseUrl.disabled = free;
    el.apiKey.disabled = free;
    el.model.disabled = free;
    if (el.quickModel) {
      el.quickModel.disabled = free;
      el.quickModel.placeholder = free ? "内置 Google 翻译" : "模型名称";
    }
    [el.modelToggle, el.quickModelToggle].forEach((node) => {
      if (node) node.disabled = free;
    });
    if (free) closeAllCombos(null);
    el.baseUrl.placeholder = free ? "内置免费接口，无需填写" : "https://…/v1";
    el.apiKey.placeholder = free ? "无需 API Key" : "sk-…";
    if (free) {
      el.baseUrl.value = "";
      el.apiKey.value = "";
      el.model.value = "google-translate";
    }
  }

  function openSettingsSheet() {
    updateSettingsSummary();
    updateLongDocHint();
    refreshZoteroStatus();
    el.settingsModal.hidden = false;
    document.body.classList.add("settings-open");
    if (el.btnSettingsEntry) el.btnSettingsEntry.setAttribute("aria-expanded", "true");
    el.settingsClose.focus();
  }

  /* Zotero add-on status: the download stays available even when the app is
     offline, but a missing add-on build must not show a dead button. */
  async function refreshZoteroStatus() {
    if (!el.zoteroStatus) return;
    try {
      const data = await api("/api/zotero/status");
      const plugin = (data && data.plugin) || {};
      const available = Boolean(plugin.available);
      const links = Number(data && data.link_count) || 0;
      if (available) {
        const version = plugin.version ? ` v${plugin.version}` : "";
        el.zoteroStatus.textContent = `插件${version} 可下载 · 已在 BabelDOC 中关联 ${links} 篇`;
      } else {
        el.zoteroStatus.textContent = "插件文件缺失，请重新安装 ReadPI";
      }
      if (el.zoteroDownload) {
        el.zoteroDownload.hidden = !available;
        if (plugin.version) {
          el.zoteroDownload.download = `babeldoc-zotero-${plugin.version}.xpi`;
        }
      }
    } catch (error) {
      el.zoteroStatus.textContent = `无法读取集成状态：${error.message}`;
      if (el.zoteroDownload) el.zoteroDownload.hidden = true;
    }
  }

  function closeSettingsSheet() {
    el.settingsModal.hidden = true;
    document.body.classList.remove("settings-open");
    if (el.btnSettingsEntry) el.btnSettingsEntry.setAttribute("aria-expanded", "false");
    updateSettingsSummary();
  }

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        const result = await api("/api/settings", { method: "POST", body: collectSettings() });
        if (result && result.settings && result.settings.providers) {
          state.providers = result.settings.providers;
        }
      } catch {
        /* settings are best-effort */
      }
    }, 600);
  }

  function switchProvider() {
    const providerId = el.provider.value;
    renderModelOptions(providerId);
    const saved = (state.providers || {})[providerId];
    const preset = state.providerModels[providerId] || { models: [], base_url: "" };
    el.baseUrl.value = (saved && saved.base_url) || preset.base_url || "";
    el.model.value = (saved && saved.model) || (preset.models[0] || "");
    el.apiKey.value = (saved && saved.api_key) || "";
    el.rememberKey.checked = Boolean(saved && saved.remember);
    syncProviderFields(providerId);
    updateSettingsSummary();
    refreshModelCombos();
    scheduleSave();
  }

  /* --------------------------------------------------------------- files -- */
  function addFiles(items) {
    let added = 0;
    for (const item of items || []) {
      if (!item || !item.path) continue;
      if (state.files.some((file) => file.path === item.path)) continue;
      if (!/\.pdf$/i.test(item.path)) continue;
      state.files.push(item);
      added += 1;
    }
    if (added) {
      renderFiles();
      refreshSummary();
      syncStage();
      persistFiles();
      toast(`已添加 ${added} 个文件`, "good");
    }
    return added;
  }

  /* ------------------------------------------------------ session restore --
   * Opening 结果库 / 阅读器 leaves this page; keep the chosen files so coming
   * back to the same window lands on the same work state. */
  const FILE_KEY = "babeldoc-open-files";

  function persistFiles() {
    try {
      sessionStorage.setItem(
        FILE_KEY,
        JSON.stringify(state.files.map((file) => file.path))
      );
    } catch {
      /* storage may be unavailable — restoring is only a convenience */
    }
  }

  async function restoreFiles() {
    if (state.files.length) return;
    let paths = [];
    try {
      const raw = JSON.parse(sessionStorage.getItem(FILE_KEY) || "[]");
      if (Array.isArray(raw)) paths = raw.filter((item) => typeof item === "string");
    } catch {
      return;
    }
    if (!paths.length) return;
    try {
      const result = await api("/api/inspect", { method: "POST", body: { paths } });
      const files = result.files || [];
      if (!files.length) return;
      state.files = files;
      renderFiles();
      refreshSummary();
      syncStage();
    } catch {
      /* ignore: the file may have moved away */
    }
  }

  /* The library hands a PDF over as /?prepare=<abs path> (the `file` alias is
     accepted too). Loading it only preselects the file: the user still has to
     confirm the settings and press 开始翻译, so this never starts a job. A
     `job` parameter means the job-resume flow owns the page instead. */
  async function prepareFileFromUrl() {
    const params = new URLSearchParams(location.search);
    if (params.has("job")) return;
    const request = params.get("prepare") ?? params.get("file");
    if (request === null) return;
    const path = request || "";

    /* Clean the URL right away so a refresh does not reopen the same PDF. */
    params.delete("prepare");
    params.delete("file");
    const query = params.toString();
    history.replaceState(
      null,
      "",
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`
    );

    let files = [];
    if (path) {
      try {
        const result = await api("/api/inspect", { method: "POST", body: { paths: [path] } });
        files = Array.isArray(result && result.files) ? result.files : [];
      } catch {
        files = [];
      }
    }
    if (!files.length) {
      toast("无法打开这篇 PDF，可能已被移动或删除", "bad");
      return;
    }

    /* Replace the restored session selection: the handed-over PDF wins. */
    state.files = files;
    /* The file was already chosen elsewhere, so reveal the work stage without
       the entry fade and keep the focus on 开始翻译 (this also skips the
       first-run API-key autofocus, which would otherwise steal it). */
    state.firstRun = false;
    clearTimeout(firstRunFocusTimer);
    showStage("work", { animate: false, force: true });
    renderFiles();
    refreshSummary();
    syncStage();
    persistFiles();
    toast("已载入 PDF，请确认翻译设置后点击「开始翻译」", "good");

    el.btnStart.scrollIntoView({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    el.btnStart.focus({ preventScroll: true });
  }

  async function pickFiles() {
    try {
      const result = await api("/api/pick", { method: "POST", body: { mode: "files" } });
      const added = addFiles(result.files || []);
      if (!added && (result.files || []).length === 0) {
        /* user cancelled the dialog — stay quiet */
      }
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function uploadFiles(fileList) {
    const pdfs = Array.from(fileList || []).filter((file) => /\.pdf$/i.test(file.name));
    if (!pdfs.length) {
      toast("只支持 PDF 文件", "bad");
      return;
    }
    const form = new FormData();
    pdfs.forEach((file) => form.append("files", file, file.name));
    try {
      const result = await api("/api/upload", { method: "POST", body: form });
      addFiles(result.files || []);
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* --------------------------------------------------------------- drag --
   * Dragging is tracked on the document so a file dropped anywhere over the
   * window still lands in whichever drop target is currently on screen. */
  let dragDepth = 0;
  let dragResetTimer = null;

  function endDrag() {
    dragDepth = 0;
    clearTimeout(dragResetTimer);
    setDragActive(false);
  }

  function hasFiles(event) {
    const transfer = event.dataTransfer;
    if (!transfer) return false;
    const types = transfer.types ? Array.from(transfer.types) : [];
    return types.includes("Files") || Boolean(transfer.files && transfer.files.length);
  }

  function setDragActive(active) {
    document.body.classList.toggle("is-drag", active);
    [el.heroDrop, el.dropZone].forEach((zone) => {
      if (zone) zone.classList.toggle("is-over", active);
    });
    if (el.heroDropTitle) {
      el.heroDropTitle.textContent = active ? "松开即可添加" : "拖拽 PDF 到此处";
    }
  }

  function activeDropZone() {
    return state.stage === "work" ? el.dropZone : el.heroDrop;
  }

  function handleDrop(event) {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (!files || !files.length) return;
    const zone = activeDropZone();
    if (zone) {
      zone.classList.add("is-accept");
      setTimeout(() => zone.classList.remove("is-accept"), 520);
    }
    if (event.clientX || event.clientY) spawnRipple(event.clientX, event.clientY);
    uploadFiles(files);
  }

  function bindDropTarget() {
    document.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      if (dragDepth === 1) setDragActive(true);
    });
    document.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      /* Fallback for dragleave not firing when the pointer leaves the window.
         Browsers re-fire dragover about every 350ms while a drag is active,
         so the window has to stay comfortably above that cadence. */
      clearTimeout(dragResetTimer);
      dragResetTimer = setTimeout(endDrag, 800);
    });
    document.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) {
        clearTimeout(dragResetTimer);
        setDragActive(false);
      }
    });
    document.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      endDrag();
      handleDrop(event);
    });
    window.addEventListener("dragend", endDrag);
    window.addEventListener("blur", endDrag);
  }

  async function chooseOutputDir() {
    try {
      const result = await api("/api/pick", { method: "POST", body: { mode: "dir" } });
      if (result.paths && result.paths.length) {
        el.outputDir.value = result.paths[0];
        scheduleSave();
      }
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function testConnection() {
    el.testResult.textContent = "正在测试…";
    el.testResult.className = "test-result";
    try {
      const result = await api("/api/test-connection", {
        method: "POST",
        body: {
          base_url: el.baseUrl.value.trim(),
          api_key: el.apiKey.value,
          model: el.model.value.trim(),
        },
      });
      if (result.ok) {
        el.testResult.textContent = `连接成功 · ${result.latency_ms} ms`;
        el.testResult.className = "test-result ok";
      } else {
        el.testResult.textContent = `连接失败：${result.message || result.status}`;
        el.testResult.className = "test-result bad";
      }
    } catch (error) {
      el.testResult.textContent = `连接失败：${error.message}`;
      el.testResult.className = "test-result bad";
    }
  }

  /* ---------------------------------------------------------------- jobs -- */
  function setRunning(running) {
    state.running = running;
    el.btnStart.disabled = running || !state.files.length;
    el.btnStart.textContent = running ? "翻译中…" : "开始翻译";
    el.btnCancel.hidden = !running;
    el.progressBlock.hidden = !running && !state.jobId;
  }

  function applyJob(job) {
    const progress = Number(job.progress) || 0;
    el.stage.textContent = job.stage || "运行中";
    el.percent.textContent = `${Math.round(progress)}%`;
    if (el.progressFill) el.progressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
    el.jobCard.dataset.state =
      job.status === "succeeded"
        ? "done"
        : job.status === "failed"
          ? "failed"
          : job.status === "cancelled"
            ? "cancelled"
            : "running";
    renderJobCard(job);
    if (job.logs && job.logs.length) {
      el.log.textContent += job.logs.join("\n") + "\n";
      el.log.scrollTop = el.log.scrollHeight;
    }
    renderUsage(job);
  }

  /* The card mirrors the file being translated: name, size, percent and how
     long it has been running. */
  function renderJobCard(job) {
    const files = state.files || [];
    if (!files.length && Array.isArray(job.files) && job.files.length) {
      el.jobName.textContent = job.files.length === 1 ? job.files[0] : `${job.files.length} 个文件`;
      el.jobName.title = job.files.join("\n");
    } else if (files.length === 1) {
      el.jobName.textContent = files[0].name;
    } else if (files.length > 1) {
      el.jobName.textContent = `${files.length} 个文件`;
    }
    el.jobName.title = files.map((file) => file.name).join("\n");

    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    const totalPages = files.reduce((sum, file) => sum + (Number(file.pages) || 0), 0);
    const bits = [];
    if (totalBytes) bits.push(formatSize(totalBytes));
    if (totalPages) bits.push(`${totalPages} 页`);
    el.jobMeta.textContent = bits.join(" · ");

    const seconds = jobSeconds(job);
    if (!seconds) {
      el.jobNote.textContent = "刚刚开始";
    } else {
      el.jobNote.textContent = `${job.finished_at ? "用时" : "已用"} ${formatDuration(seconds)}`;
    }
  }

  function jobSeconds(job) {
    const started = Number(job.started_at) || 0;
    if (!started) return 0;
    const end = job.finished_at ? Number(job.finished_at) : Date.now() / 1000;
    return Math.max(0, end - started);
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
  }

  function formatTokens(value) {
    const number = Number(value) || 0;
    if (number >= 10000) return `${(number / 1000).toFixed(1)}k`;
    if (number >= 1000) return `${(number / 1000).toFixed(2)}k`;
    return String(number);
  }

  function formatMoney(cost) {
    if (!cost || !cost.known) return "";
    const amount = Number(cost.amount) || 0;
    let text;
    if (amount >= 0.01) text = amount.toFixed(2);
    else if (amount >= 0.0001) text = amount.toFixed(4);
    else text = amount.toPrecision(2);
    return `${cost.symbol || ""}${text}`;
  }

  function renderUsage(job) {
    const usage = job.usage || {};
    if (!usage.total_tokens) {
      el.usageLine.hidden = true;
      return;
    }
    const money = formatMoney(job.cost);
    let html =
      `本次用量：输入 ${formatTokens(usage.prompt_tokens)} · ` +
      `输出 ${formatTokens(usage.completion_tokens)} tokens`;
    if (money) {
      const source = job.cost.source === "override" ? "自定义单价" : "参考价";
      html += ` · 预计花费 <span class="amount">${money}</span>` +
        ` <span class="muted">（${source}）</span>`;
    } else if (usage.total_tokens) {
      html += ' · <span class="muted">该模型未内置价格，可在高级设置填写单价</span>';
    }
    el.usageLine.innerHTML = html;
    el.usageLine.hidden = false;
  }

  /* "12,13,14,20" -> "12-14、20" for the blank-page advisory. */
  function formatPageRanges(pages) {
    const numbers = Array.from(
      new Set(
        (Array.isArray(pages) ? pages : [])
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      )
    ).sort((a, b) => a - b);
    if (!numbers.length) return "";
    const parts = [];
    let start = numbers[0];
    let prev = numbers[0];
    for (let i = 1; i <= numbers.length; i += 1) {
      const value = numbers[i];
      if (value === prev + 1) {
        prev = value;
        continue;
      }
      parts.push(start === prev ? String(start) : `${start}-${prev}`);
      start = value;
      prev = value;
    }
    return parts.join("、");
  }

  /* Results may carry the blank-output QA fields from the backend
     (`warning` string + `blank_pages` number[]); both are optional. */
  function resultAdvisory(item) {
    const warning = typeof item.warning === "string" ? item.warning.trim() : "";
    if (warning) return warning;
    const ranges = formatPageRanges(item.blank_pages);
    if (!ranges) return "";
    return (
      `检测到第 ${ranges} 页译文可能大面积空白，` +
      "可在高级设置开启「兼容性优先（禁用富文本翻译）」后重译。"
    );
  }

  function renderResults(results) {
    if (!results || !results.length) {
      el.resultCard.hidden = true;
      return;
    }
    el.resultCard.hidden = false;
    el.resultList.innerHTML = results
      .map((item, index) => {
        const advisory = resultAdvisory(item);
        const canRetry =
          Array.isArray(item.blank_pages) && item.blank_pages.length > 0;
        return `
        <div class="result-item">
          <div class="result-main">
            <span class="result-kind">${escapeHtml(item.kind)}</span>
            <span class="result-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
            <span class="result-size">${formatSize(item.size)}</span>
            <button class="btn btn-secondary" type="button" data-open="${index}">${
              /\.pdf$/i.test(item.name) ? "阅读" : "打开"
            }</button>
            <button class="btn btn-secondary" type="button" data-reveal="${index}">文件夹</button>
          </div>
          ${
            advisory
              ? `<p class="result-advisory"><span class="result-advisory-tag">提示</span>` +
                `<span class="result-advisory-text">${escapeHtml(advisory)}</span>` +
                (canRetry
                  ? '<button class="result-advisory-retry" type="button" data-retry="1">用兼容模式重译</button>'
                  : "") +
                "</p>"
              : ""
          }
        </div>`;
      })
      .join("");
    $$("[data-open]", el.resultList).forEach((button) => {
      button.addEventListener("click", () => {
        const item = results[Number(button.dataset.open)];
        if (/\.pdf$/i.test(item.name)) {
          location.href = `/viewer?from=app&path=${encodeURIComponent(item.path)}`;
          return;
        }
        api("/api/open", { method: "POST", body: { path: item.path } }).catch((error) =>
          toast(error.message, "bad")
        );
      });
    });
    $$("[data-reveal]", el.resultList).forEach((button) => {
      button.addEventListener("click", () => {
        const item = results[Number(button.dataset.reveal)];
        api("/api/open", { method: "POST", body: { path: item.path } }).catch((error) =>
          toast(error.message, "bad")
        );
      });
    });
    $$("[data-retry]", el.resultList).forEach((button) => {
      button.addEventListener("click", retryWithCompat);
    });
  }

  /* One-click remediation for a result whose translated pages came out blank:
     turn on the compatibility fallback and run the same files again. */
  function retryWithCompat() {
    if (state.running) {
      toast("已有任务在运行", "bad");
      return;
    }
    if (!state.files.length) {
      toast("源文件已不在列表中，请重新添加后再翻译", "bad");
      return;
    }
    el.compatFirst.checked = true;
    toast("已开启兼容性优先，正在重新翻译…", "good");
    void startJob();
  }

  async function startJob() {
    if (state.running) return;
    if (!state.files.length) {
      toast("请先添加 PDF 文件", "bad");
      return;
    }
    if (!el.model.value.trim()) {
      toast("请填写模型名称", "bad");
      el.advanced.hidden = false;
      return;
    }
    if (!el.apiKey.value.trim() && !["google_free", "ollama"].includes(el.provider.value)) {
      toast("请填写 API Key", "bad");
      el.advanced.hidden = false;
      el.apiKey.focus();
      return;
    }

    const payload = {
      ...collectSettings(),
      files: state.files.map((file) => file.path),
    };

    try {
      await api("/api/settings", { method: "POST", body: collectSettings() });
      const result = await api("/api/jobs", { method: "POST", body: payload });
      state.jobId = result.job.id;
      localStorage.setItem("readpi-active-job", state.jobId);
      state.cursor = 0;
      el.log.textContent = "";
      el.usageLine.hidden = true;
      el.resultCard.hidden = true;
      el.jobCard.dataset.state = "running";
      if (el.progressFill) el.progressFill.style.width = "0%";
      el.progressBlock.hidden = false;
      setRunning(true);
      poll();
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function poll() {
    if (!state.jobId) return;
    try {
      const job = await api(`/api/jobs/${state.jobId}?cursor=${state.cursor}`);
      state.cursor = job.cursor;
      applyJob(job);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        finishJob(job);
        return;
      }
      state.timer = setTimeout(poll, 700);
    } catch (error) {
      toast(`任务状态获取失败：${error.message}`, "bad");
      state.timer = setTimeout(poll, 2000);
    }
  }

  async function resumeJobFromUrl() {
    const jobId = new URLSearchParams(location.search).get("job");
    if (!jobId) return;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(jobId)}?cursor=0`);
      state.jobId = jobId;
      if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) {
        localStorage.setItem("readpi-active-job", jobId);
      }
      state.cursor = job.cursor;
      state.firstRun = false;
      el.log.textContent = "";
      showStage("work", { animate: false });
      applyJob(job);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        finishJob(job);
      } else {
        setRunning(true);
        poll();
      }
    } catch (error) {
      toast(`无法打开翻译任务：${error.message}`, "bad");
    }
  }

  function finishJob(job) {
    clearTimeout(state.timer);
    state.timer = null;
    setRunning(false);
    renderUsage(job);
    renderJobCard(job);
    if (job.status === "succeeded") {
      el.jobCard.dataset.state = "done";
      el.percent.textContent = "100%";
      el.stage.textContent = "翻译完成";
      toast("翻译完成", "good");
      renderResults(job.results);
    } else if (job.status === "cancelled") {
      el.jobCard.dataset.state = "cancelled";
      el.stage.textContent = "已取消";
      toast("任务已取消");
    } else {
      el.jobCard.dataset.state = "failed";
      el.stage.textContent = "翻译失败";
      toast(job.error || "翻译失败，请查看日志", "bad");
      if (!el.log.hidden) el.log.scrollTop = el.log.scrollHeight;
    }
  }

  async function cancelJob() {
    if (!state.jobId) return;
    try {
      await api(`/api/jobs/${state.jobId}/cancel`, { method: "POST" });
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  /* ----------------------------------------------------------- glossaries -- */
  async function loadGlossaries() {
    const result = await api("/api/glossaries");
    state.glossaries = result.glossaries || [];
    renderGlossarySelect();
    renderGlossaryList();
  }

  /* ------------------------------------------------------------ presets -- */
  async function loadPresets() {
    try {
      const data = await api("/api/presets");
      renderPresets(data.presets || []);
    } catch (error) {
      el.presetList.innerHTML = `<p class="hint">预设读取失败：${escapeHtml(error.message)}</p>`;
    }
  }

  function renderPresets(items) {
    if (!items.length) {
      el.presetList.innerHTML = '<p class="hint">暂时没有可用的预设术语库。</p>';
      return;
    }
    el.presetList.innerHTML = items
      .map(
        (item) => `
        <div class="preset-item">
          <div class="preset-main">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.description)}</span>
          </div>
          <span class="preset-count">${item.count} 条</span>
          <button class="btn btn-secondary small" type="button" data-preset="${escapeHtml(item.id)}"
                  ${item.installed ? "disabled" : ""}>${item.installed ? "已添加" : "添加"}</button>
        </div>`
      )
      .join("");
    $$("[data-preset]", el.presetList).forEach((button) => {
      button.addEventListener("click", () => installPreset(button.dataset.preset));
    });
  }

  async function installPreset(id) {
    try {
      const result = await api("/api/presets/install", { method: "POST", body: { id } });
      state.glossaries = result.glossaries || state.glossaries;
      renderGlossarySelect();
      renderGlossaryList();
      renderPresets(result.presets || []);
      if (result.glossary) {
        el.glossary.value = result.glossary.id;
        scheduleSave();
        toast(`已添加「${result.glossary.name}」${result.glossary.count} 条术语`, "good");
      }
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  function renderGlossaryList() {
    if (!state.glossaries.length) {
      el.glossaryList.innerHTML = '<p class="hint">还没有术语库，先在下面新建一个。</p>';
      return;
    }
    el.glossaryList.innerHTML = state.glossaries
      .map(
        (item, index) => `
        <div class="glossary-item">
          <span class="name">${escapeHtml(item.name)}</span>
          <span class="count">${item.count} 条</span>
          <button class="mini" type="button" data-edit="${index}">编辑</button>
          <button class="mini" type="button" data-delete="${index}">删除</button>
        </div>`
      )
      .join("");
    $$("[data-edit]", el.glossaryList).forEach((button) => {
      button.addEventListener("click", () => editGlossary(state.glossaries[Number(button.dataset.edit)]));
    });
    $$("[data-delete]", el.glossaryList).forEach((button) => {
      button.addEventListener("click", () => deleteGlossary(state.glossaries[Number(button.dataset.delete)]));
    });
  }

  async function editGlossary(item) {
    try {
      const detail = await api(`/api/glossaries/${encodeURIComponent(item.id)}`);
      el.glossaryName.value = detail.name;
      el.glossaryEntries.value = (detail.entries || [])
        .map((entry) => `${entry.source}\t${entry.target}`)
        .join("\n");
      updateGlossaryCount();
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function deleteGlossary(item) {
    if (!confirm(`删除术语库「${item.name}」？此操作不可撤销。`)) return;
    try {
      await api(`/api/glossaries/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      await loadGlossaries();
      toast("已删除术语库", "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  function parseGlossaryText(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\t|,|，/);
        return { source: (parts[0] || "").trim(), target: (parts[1] || "").trim() };
      })
      .filter((entry) => entry.source && entry.target);
  }

  function updateGlossaryCount() {
    const entries = parseGlossaryText(el.glossaryEntries.value);
    el.glossaryCount.textContent = `${entries.length} 条`;
  }

  async function saveGlossary() {
    const name = el.glossaryName.value.trim();
    const entries = parseGlossaryText(el.glossaryEntries.value);
    if (!name) {
      toast("请填写术语库名称", "bad");
      return;
    }
    if (!entries.length) {
      toast("请至少添加一条「原文<Tab>译文」", "bad");
      return;
    }
    try {
      const result = await api("/api/glossaries", { method: "POST", body: { name, entries } });
      await loadGlossaries();
      el.glossary.value = result.id;
      scheduleSave();
      toast(`已保存 ${result.count} 条术语`, "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  async function importGlossary(file) {
    if (!file) return;
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      const result = await api("/api/glossaries/import", { method: "POST", body: form });
      await loadGlossaries();
      el.glossary.value = result.id;
      scheduleSave();
      toast(`已导入「${result.name}」${result.count} 条`, "good");
    } catch (error) {
      toast(error.message, "bad");
    }
  }

  function openGlossaryModal() {
    el.glossaryModal.hidden = false;
    loadGlossaries().catch((error) => toast(error.message, "bad"));
    loadPresets();
  }

  function closeGlossaryModal() {
    el.glossaryModal.hidden = true;
  }

  /* --------------------------------------------------------------- events -- */
  function bindEvents() {
    el.btnTheme.addEventListener("click", cycleTheme);
    bindModelCombos();
    bindHelpTips();
    if (el.btnSettingsEntry) el.btnSettingsEntry.addEventListener("click", openSettingsSheet);
    if (el.btnHeroSettings) el.btnHeroSettings.addEventListener("click", openSettingsSheet);
    el.btnChoose.addEventListener("click", (event) => {
      event.stopPropagation();
      pickFiles();
    });
    [el.heroDrop, el.dropZone].forEach((zone) => {
      if (!zone) return;
      zone.addEventListener("click", () => el.fileInput.click());
      zone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          el.fileInput.click();
        }
      });
    });
    el.fileInput.addEventListener("change", () => {
      uploadFiles(el.fileInput.files);
      el.fileInput.value = "";
    });

    bindDropTarget();

    el.provider.addEventListener("change", switchProvider);
    el.quickProvider.addEventListener("change", () => {
      el.provider.value = el.quickProvider.value;
      switchProvider();
      el.quickModel.value = el.model.value;
      updateSettingsSummary();
    });
    el.quickModel.addEventListener("input", () => {
      el.model.value = el.quickModel.value;
      scheduleSave();
    });
    for (const [quick, modal] of [
      [el.quickLangIn, el.langIn],
      [el.quickLangOut, el.langOut],
      [el.quickDual, el.dualMode],
      [el.quickGlossary, el.glossary],
    ]) {
      quick.addEventListener("change", () => {
        modal.value = quick.value;
        scheduleSave();
        updateSettingsSummary();
      });
    }
    if (el.openSettings) el.openSettings.addEventListener("click", openSettingsSheet);
    if (el.quickKey) el.quickKey.addEventListener("click", openKeySettings);
    for (const node of [el.settingsClose, el.settingsCancel, el.settingsDone]) {
      if (node) node.addEventListener("click", closeSettingsSheet);
    }
    if (el.settingsModal) {
      const backdrop = el.settingsModal.querySelector("[data-settings-close]");
      if (backdrop) backdrop.addEventListener("click", closeSettingsSheet);
    }
    for (const control of [el.provider, el.langOut, el.langIn, el.dualMode, el.glossary]) {
      control.addEventListener("change", updateSettingsSummary);
    }
    el.model.addEventListener("input", updateSettingsSummary);
    el.model.addEventListener("change", updateSettingsSummary);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.settingsModal && !el.settingsModal.hidden) {
        closeSettingsSheet();
      }
    });
    el.model.addEventListener("change", scheduleSave);
    el.model.addEventListener("input", scheduleSave);
    el.baseUrl.addEventListener("input", scheduleSave);
    el.apiKey.addEventListener("input", () => {
      scheduleSave();
      updateKeyStatus();
    });
    el.rememberKey.addEventListener("change", () => {
      scheduleSave();
      updateKeyStatus();
    });
    el.langOut.addEventListener("change", scheduleSave);
    el.langIn.addEventListener("change", scheduleSave);
    el.dualMode.addEventListener("change", scheduleSave);
    el.watermark.addEventListener("change", scheduleSave);
    el.qps.addEventListener("change", scheduleSave);
    el.termModel.addEventListener("input", scheduleSave);
    el.customPrompt.addEventListener("input", scheduleSave);
    el.skipScanned.addEventListener("change", scheduleSave);
    el.ocrWorkaround.addEventListener("change", scheduleSave);
    el.compatFirst.addEventListener("change", scheduleSave);
    el.openWhenDone.addEventListener("change", scheduleSave);
    el.outputDir.addEventListener("input", scheduleSave);
    el.autoGlossary.addEventListener("change", scheduleSave);
    el.saveGlossary.addEventListener("change", scheduleSave);
    el.skipReferences.addEventListener("change", scheduleSave);
    el.referencePage.addEventListener("input", scheduleSave);
    el.priceInput.addEventListener("input", scheduleSave);
    el.priceOutput.addEventListener("input", scheduleSave);
    el.priceCurrency.addEventListener("change", scheduleSave);
    el.glossary.addEventListener("change", scheduleSave);

    el.pageMode.addEventListener("change", () => {
      el.pageRange.hidden = el.pageMode.value !== "custom";
      if (el.pageMode.value === "custom") el.pageRange.focus();
      scheduleSave();
    });
    el.pageRange.addEventListener("input", scheduleSave);

    el.btnOutput.addEventListener("click", chooseOutputDir);
    el.btnReveal.addEventListener("click", () => {
      const hidden = el.apiKey.type === "password";
      el.apiKey.type = hidden ? "text" : "password";
      el.btnReveal.textContent = hidden ? "隐藏" : "显示";
    });

    el.btnTest.addEventListener("click", testConnection);
    el.btnStart.addEventListener("click", startJob);
    el.btnCancel.addEventListener("click", cancelJob);

    el.btnAdvanced.addEventListener("click", () => {
      const expanded = el.btnAdvanced.getAttribute("aria-expanded") === "true";
      el.btnAdvanced.setAttribute("aria-expanded", String(!expanded));
      el.advanced.hidden = expanded;
    });

    el.btnLog.addEventListener("click", () => {
      const expanded = el.btnLog.getAttribute("aria-expanded") === "true";
      el.btnLog.setAttribute("aria-expanded", String(!expanded));
      el.log.hidden = expanded;
    });

    el.btnGlossary.addEventListener("click", openGlossaryModal);
    el.btnGlossaryClose.addEventListener("click", closeGlossaryModal);
    el.glossaryModal.addEventListener("click", (event) => {
      if (event.target === el.glossaryModal) closeGlossaryModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !el.glossaryModal.hidden) closeGlossaryModal();
    });
    el.btnGlossarySave.addEventListener("click", saveGlossary);
    el.btnQuit.addEventListener("click", async () => {
      if (state.running && !confirm("翻译仍在进行，退出会中断任务。确定退出吗？")) return;
      try {
        await api("/api/quit", { method: "POST" });
      } catch {
        /* server exits before replying sometimes */
      }
      toast("已退出，可关闭此窗口");
      setTimeout(() => window.close(), 400);
    });
    el.glossaryEntries.addEventListener("input", updateGlossaryCount);
    el.glossaryImport.addEventListener("change", () => {
      importGlossary(el.glossaryImport.files[0]);
      el.glossaryImport.value = "";
    });
  }

  /* ----------------------------------------------------------------- boot -- */
  async function boot() {
    applyTheme(initialTheme());
    try {
      const data = await api("/api/bootstrap");
      state.boot = data;
      state.providers = (data.settings && data.settings.providers) || {};
      state.glossaries = data.glossaries || [];

      renderLanguages();
      renderProviders();
      renderGlossariesIntoList();
      applySettings(data.settings);
      renderEngine(data.babeldoc);
      bindEvents();
      refreshSummary();
      renderFiles();

      /* First run settings are shown once a file exists (afterWorkReveal). */
      state.firstRun = Boolean(data.first_run);
      await restoreFiles();
      await resumeJobFromUrl();
      await prepareFileFromUrl();
      if (state.stage === "entry") {
        el.stageEntry.classList.add("stage-enter");
        clearTimeout(entranceTimer);
        entranceTimer = setTimeout(() => el.stageEntry.classList.remove("stage-enter"), ENTRANCE_MS);
      }
    } catch (error) {
      toast(`初始化失败：${error.message}`, "bad");
      el.enginePill.classList.add("bad");
      el.engineText.textContent = "服务未就绪";
    }
  }

  function renderGlossariesIntoList() {
    renderGlossarySelect();
    renderGlossaryList();
  }

  boot();
})();
