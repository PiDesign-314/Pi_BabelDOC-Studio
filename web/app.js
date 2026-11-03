/* BabelDOC Studio front-end — vanilla JS, no build step. */
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
  };

  const el = {
    btnTheme: $("#btn-theme"),
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
    stage: $("#stage"),
    percent: $("#percent"),
    barFill: $("#bar-fill"),
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
    glossaryName: $("#glossary-name"),
    glossaryEntries: $("#glossary-entries"),
    glossaryCount: $("#glossary-count"),
    btnGlossary: $("#btn-glossary"),
    btnGlossaryClose: $("#btn-glossary-close"),
    btnGlossarySave: $("#btn-glossary-save"),
    glossaryImport: $("#glossary-import"),
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

  /* ------------------------------------------------------------- render -- */
  function renderLanguages() {
    const options = state.boot.languages
      .map((lang) => `<option value="${lang.code}">${lang.label}</option>`)
      .join("");
    el.langOut.innerHTML = options;
    el.langIn.innerHTML = options;
  }

  function renderProviders() {
    el.provider.innerHTML = state.boot.providers
      .map((item) => `<option value="${item.id}">${item.name}</option>`)
      .join("");
    state.providerModels = {};
    state.boot.providers.forEach((item) => {
      state.providerModels[item.id] = { models: item.models, base_url: item.base_url, hint: item.hint };
    });
  }

  function renderModelOptions(providerId) {
    const preset = state.providerModels[providerId] || { models: [] };
    el.modelOptions.innerHTML = preset.models
      .map((name) => `<option value="${name}"></option>`)
      .join("");
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
    if (current && state.glossaries.some((g) => g.id === current)) {
      el.glossary.value = current;
    }
  }

  function renderPageModeOptions() {
    const pages = totalPages();
    const suffix = pages ? `（共 ${pages} 页）` : "";
    el.pageMode.innerHTML = [
      `<option value="all">全部页${suffix}</option>`,
      '<option value="custom">自定义范围…</option>',
    ].join("");
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
        <div class="file-row">
          <div class="file-badge">PDF</div>
          <div class="file-body">
            <div class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</div>
            <div class="file-meta">${file.pages ? `${file.pages} 页` : "页数未知"} · ${formatSize(file.size)}</div>
          </div>
          <button class="file-remove" type="button" data-index="${index}" title="移除">✕</button>
        </div>`
      )
      .join("");
    $$(".file-remove", el.fileList).forEach((button) => {
      button.addEventListener("click", () => {
        state.files.splice(Number(button.dataset.index), 1);
        renderFiles();
        refreshSummary();
      });
    });
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
    el.openWhenDone.checked = settings.open_when_done !== false;
    el.rememberKey.checked = !!providerState.remember;
    el.baseUrl.value = providerState.base_url || preset.base_url || "";
    el.model.value = providerState.model || (preset.models && preset.models[0]) || "";
    el.apiKey.value = providerState.api_key || "";

    const ids = settings.glossary_ids || [];
    el.glossary.value = ids.length ? ids[0] : "";
    renderPageModeOptions();
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
      term_model: el.termModel.value.trim(),
      term_model_enabled: Boolean(el.termModel.value.trim()),
    };
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
      toast(`已添加 ${added} 个文件`, "good");
    }
    return added;
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
    el.stage.textContent = job.stage || "运行中";
    const progress = Number(job.progress) || 0;
    el.percent.textContent = `${Math.round(progress)}%`;
    el.barFill.classList.toggle("indeterminate", progress <= 0 && job.status === "running");
    el.barFill.style.width = progress > 0 ? `${Math.min(progress, 100)}%` : "";
    if (job.logs && job.logs.length) {
      el.log.textContent += job.logs.join("\n") + "\n";
      el.log.scrollTop = el.log.scrollHeight;
    }
    renderUsage(job);
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

  function renderResults(results) {
    if (!results || !results.length) {
      el.resultCard.hidden = true;
      return;
    }
    el.resultCard.hidden = false;
    el.resultList.innerHTML = results
      .map(
        (item, index) => `
        <div class="result-item">
          <span class="result-kind">${escapeHtml(item.kind)}</span>
          <span class="result-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
          <span class="result-size">${formatSize(item.size)}</span>
          <button class="btn btn-secondary" type="button" data-open="${index}">打开</button>
          <button class="btn btn-secondary" type="button" data-reveal="${index}">文件夹</button>
        </div>`
      )
      .join("");
    $$("[data-open]", el.resultList).forEach((button) => {
      button.addEventListener("click", () => {
        const item = results[Number(button.dataset.open)];
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
    if (!el.apiKey.value.trim()) {
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
      state.cursor = 0;
      el.log.textContent = "";
      el.usageLine.hidden = true;
      el.resultCard.hidden = true;
      el.barFill.style.width = "0%";
      el.barFill.classList.add("indeterminate");
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

  function finishJob(job) {
    clearTimeout(state.timer);
    state.timer = null;
    setRunning(false);
    el.barFill.classList.remove("indeterminate");
    renderUsage(job);
    if (job.status === "succeeded") {
      el.barFill.style.width = "100%";
      el.percent.textContent = "100%";
      el.stage.textContent = "翻译完成";
      toast("翻译完成", "good");
      renderResults(job.results);
    } else if (job.status === "cancelled") {
      el.stage.textContent = "已取消";
      toast("任务已取消");
    } else {
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
  }

  function closeGlossaryModal() {
    el.glossaryModal.hidden = true;
  }

  /* --------------------------------------------------------------- events -- */
  function bindEvents() {
    el.btnTheme.addEventListener("click", cycleTheme);
    el.btnChoose.addEventListener("click", (event) => {
      event.stopPropagation();
      pickFiles();
    });
    el.dropZone.addEventListener("click", () => el.fileInput.click());
    el.dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        el.fileInput.click();
      }
    });
    el.fileInput.addEventListener("change", () => {
      uploadFiles(el.fileInput.files);
      el.fileInput.value = "";
    });

    let dragDepth = 0;
    el.dropZone.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragDepth += 1;
      el.dropZone.classList.add("dragging");
    });
    el.dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    el.dropZone.addEventListener("dragleave", (event) => {
      event.preventDefault();
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        el.dropZone.classList.remove("dragging");
      }
    });
    el.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dragDepth = 0;
      el.dropZone.classList.remove("dragging");
      if (event.dataTransfer && event.dataTransfer.files.length) {
        uploadFiles(event.dataTransfer.files);
      }
    });

    el.provider.addEventListener("change", switchProvider);
    el.model.addEventListener("change", scheduleSave);
    el.model.addEventListener("input", scheduleSave);
    el.baseUrl.addEventListener("input", scheduleSave);
    el.apiKey.addEventListener("input", scheduleSave);
    el.rememberKey.addEventListener("change", scheduleSave);
    el.langOut.addEventListener("change", scheduleSave);
    el.langIn.addEventListener("change", scheduleSave);
    el.dualMode.addEventListener("change", scheduleSave);
    el.watermark.addEventListener("change", scheduleSave);
    el.qps.addEventListener("change", scheduleSave);
    el.termModel.addEventListener("input", scheduleSave);
    el.customPrompt.addEventListener("input", scheduleSave);
    el.skipScanned.addEventListener("change", scheduleSave);
    el.ocrWorkaround.addEventListener("change", scheduleSave);
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

      if (location.hash === "#advanced") {
        el.advanced.hidden = false;
        el.btnAdvanced.setAttribute("aria-expanded", "true");
      } else if (data.first_run) {
        el.advanced.hidden = false;
        el.btnAdvanced.setAttribute("aria-expanded", "true");
        setTimeout(() => el.apiKey.focus(), 350);
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
