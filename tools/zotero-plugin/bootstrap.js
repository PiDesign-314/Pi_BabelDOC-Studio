/*
 * ReadPI <-> Zotero bridge — Zotero 7 bootstrapped add-on.
 *
 * Click a paper's PDF in Zotero (item list right-click, reader toolbar button,
 * reader page context menu, or the Zotero top toolbar menu) and it opens in
 * ReadPI at the page you are reading.  The local app is a Flask server
 * that imports the PDF once and shows it in its own reader window; this file
 * only talks to it over http://127.0.0.1:<port>.
 *
 * Two newer responsibilities:
 *   - capability handshake: only a server whose /api/health reports the
 *     "zotero" feature is trusted, so a stale packaged app (which answers
 *     /api/health but has no /api/zotero/*) produces a clear "old version"
 *     error instead of an HTTP 404;
 *   - library snapshot: buildLibrarySnapshot() exports the Zotero libraries,
 *     collection tree and local-PDF items, pushed to /api/zotero/library so the
 *     app's results library can show them.
 *
 * Sources of truth for the Zotero APIs used here are documented in
 * docs/zotero-api-notes.md (Zotero 7.0.32 source + official docs).  Two rules
 * that shape the whole file:
 *   - Zotero 7 has no Zotero.MenuManager and no Zotero.Reader.getActiveReader:
 *     the item menu is DOM-injected into #zotero-itemmenu and the active reader
 *     is found through the window's Zotero_Tabs.  Zotero 8's MenuManager is
 *     feature-detected and used only when present (see registerMenuManagerMenu).
 *   - Only async/await and standard Promises are used.  Zotero 8 removed
 *     Zotero.spawn, bluebird instance methods, Services.appShell.hiddenDOMWindow
 *     and friends, so none of those appear below.
 *
 * The six lifecycle functions are exported as globals at the bottom of the
 * file; the BabelDOCBridge object is an additional, documented test/debug hook
 * (tests/zotero_plugin_harness.mjs drives the plugin through it).
 */

var BabelDOCBridge = (function () {
	"use strict";

	const PLUGIN_ID = "babeldoc-studio@pidesign.local";
	const APP_NAME = "BabelDOC Studio";
	const DISPLAY_NAME = "ReadPI";
	const ITEM_MENU_ID = "babeldoc-menuitem-open";
	const ITEM_MENU_SEP_ID = "babeldoc-menuitem-open-separator";
	const FTL_FILE = "babeldoc.ftl";
	const PREF_PREFIX = "extensions.babeldoc.";

	// The item-tree toolbar is the left-hand action row above the paper list.
	// Insert before its flexible spacer so the icon stays with the other tools.
	const TOOLBAR_BUTTON_ID = "babeldoc-toolbar-button";
	const TOOLBAR_MENU_ID = "babeldoc-toolbar-menu";
	const TOOLBAR_TRANSLATE_ID = "babeldoc-toolbar-translate";
	const TOOLBAR_READ_ID = "babeldoc-toolbar-read";
	const TOOLBAR_LIBRARY_ID = "babeldoc-toolbar-library";
	const TOOLBAR_SEPARATOR_ID = "babeldoc-toolbar-separator";
	const TOOLBAR_CONTAINER_IDS = ["zotero-items-toolbar", "zotero-toolbar-item-tree", "zotero-items-toolbar-left"];

	// Capability handshake (contract §1): "zotero" is required for every
	// /api/zotero/* call; the newer library/translate endpoints have their own
	// feature flags so an older-but-capable app degrades with a message instead
	// of an HTTP 404.
	const FEATURE_ZOTERO = "zotero";
	const FEATURE_LIBRARY = "zotero-library";
	const FEATURE_TRANSLATE = "zotero-translate";

	// app.py binds 8765 and walks upwards until it finds a free port
	// (app.py:_free_port -> range(8765, 8805)), so the scan window is fixed.
	const DEFAULT_PORT = 8765;
	const PORT_SCAN_COUNT = 40;

	// Library snapshot (contract §2): never launch the app for a sync, debounce
	// Notifier bursts, throttle pushes and cap the payload.
	const SNAPSHOT_STARTUP_DELAY_MS = 2500;
	const SNAPSHOT_DEBOUNCE_MS = 2000;
	const SNAPSHOT_THROTTLE_MS = 10000;
	const SNAPSHOT_MAX_ITEMS = 3000;
	const SNAPSHOT_MAX_COLLECTIONS = 2000;
	const SNAPSHOT_MAX_ATTACHMENTS = 3;
	const LIBRARY_POST_TIMEOUT_MS = 15000;

	const HEALTH_TIMEOUT_MS = 900;
	const HEALTH_TIMEOUT_FAST_MS = 600;
	const POST_TIMEOUT_MS = 20000;
	// Auto-launch: poll every 500 ms for ~25 s before giving up.
	const LAUNCH_POLL_MS = 500;
	const LAUNCH_ATTEMPTS = 50;
	// Every N polls look at the whole port range again: if 8765 was taken the
	// freshly started app may have moved to the next free port.
	const LAUNCH_SCAN_EVERY = 10;
	// One user click may retry twice (server error, cold start, attachment
	// downloaded in the meantime).  More than that turns into a modal loop.
	const MAX_OPEN_ATTEMPTS = 3;
	const SUCCESS_CLOSE_MS = 3000;
	const NOTICE_CLOSE_MS = 8000;

	const PREF_LAUNCH_INFO_PATH = "launchInfoPath";
	const PREF_APP_PATH = "appPath";
	const PREF_PORT = "port";
	const PREF_AUTO_LAUNCH = "autoLaunch";
	const PREF_PASS_PAGE = "passPage";

	const state = {
		id: PLUGIN_ID,
		version: "",
		rootURI: "",
		started: false,
		prefPaneID: "",
		readerHooks: false,
		menuManagerID: "",
		// window -> { popup, separator, menuItem, onShowing, onCommand }
		// A Map keeps the window references in one place so shutdown() can drop
		// every one of them (a leaked window reference keeps a whole main window
		// alive after it is closed).
		menus: new Map(),
		// window -> { button, popup, items, onShowing, onCommand }
		toolbars: new Map()
	};

	// Library snapshot scheduling.  `hooks` exists for the Node harness, which
	// drives time deterministically instead of sleeping: only tests replace it,
	// production always uses the values above and Date.now().
	const snapshot = {
		observerID: "",
		// Bumped on every Notifier event / shutdown so a debounce continuation
		// that lost its race becomes a no-op.
		debounceToken: 0,
		lastPushAt: 0,
		inFlight: false,
		rerunRequested: false,
		startupTimer: null,
		pushing: false,
		hooks: {
			now: null,
			debounceMs: SNAPSHOT_DEBOUNCE_MS,
			throttleMs: SNAPSHOT_THROTTLE_MS,
			startupDelayMs: SNAPSHOT_STARTUP_DELAY_MS
		}
	};

	function snapshotNow() {
		try {
			if (typeof snapshot.hooks.now === "function") return Number(snapshot.hooks.now());
		}
		catch (e) {
			// fall back to the clock
		}
		return Date.now();
	}

	/* ------------------------------------------------------------------ */
	/* Logging and small helpers                                          */
	/* ------------------------------------------------------------------ */

	function log(message) {
		try {
			if (typeof Zotero !== "undefined" && Zotero && typeof Zotero.debug === "function") {
				Zotero.debug("[BabelDOC] " + message);
			}
		}
		catch (e) {
			// Logging must never break the feature.
		}
	}

	function logError(error) {
		log("error: " + (error && error.message ? error.message : error));
		try {
			if (Zotero && typeof Zotero.logError === "function") {
				Zotero.logError(error);
			}
		}
		catch (e) {
			// ignore
		}
	}

	function prefGet(key, fallback) {
		try {
			// Second argument (global) is required: without it Zotero.Prefs
			// prefixes the key with "extensions.zotero." (see prefs.js in
			// Zotero 7.0.32), and our prefs live at extensions.babeldoc.*.
			const value = Zotero.Prefs.get(PREF_PREFIX + key, true);
			return value === undefined || value === null ? fallback : value;
		}
		catch (e) {
			return fallback;
		}
	}

	function prefString(key, fallback) {
		const value = prefGet(key, fallback);
		if (typeof value === "string") return value;
		if (value === undefined || value === null) return fallback;
		return String(value);
	}

	function prefInt(key, fallback) {
		const value = parseInt(prefGet(key, fallback), 10);
		return Number.isFinite(value) ? value : fallback;
	}

	function prefBool(key, fallback) {
		const value = prefGet(key, fallback);
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value !== 0;
		if (typeof value === "string") {
			const text = value.trim().toLowerCase();
			if (text === "true" || text === "1" || text === "yes" || text === "on") return true;
			if (text === "false" || text === "0" || text === "no" || text === "off" || text === "") return false;
		}
		return !!fallback;
	}

	function delay(ms) {
		try {
			if (Zotero && Zotero.Promise && typeof Zotero.Promise.delay === "function") {
				return Zotero.Promise.delay(ms);
			}
		}
		catch (e) {
			// fall through to the timer
		}
		return new Promise(function (resolve) {
			setTimeout(resolve, ms);
		});
	}

	function parseJSON(text) {
		if (!text) return null;
		try {
			return JSON.parse(String(text));
		}
		catch (e) {
			return null;
		}
	}

	function localeText(chinese, english) {
		try {
			const locale = String(
				(Zotero && Zotero.locale)
				|| (Services && Services.locale && Services.locale.appLocaleAsBCP47)
				|| ""
			);
			if (/^en/i.test(locale)) return english;
		}
		catch (e) {
			// default to Chinese, the app's primary language
		}
		return chinese;
	}

	/* ------------------------------------------------------------------ */
	/* Files: launch-info.json is how the app tells us where it is         */
	/* ------------------------------------------------------------------ */

	function pathToFile(path) {
		return Zotero.File.pathToFile(String(path));
	}

	function fileExists(path) {
		if (!path) return false;
		try {
			const file = pathToFile(path);
			return !!(file && typeof file.exists === "function" && file.exists());
		}
		catch (e) {
			return false;
		}
	}

	async function readTextFile(path) {
		return Zotero.File.getContentsAsync(String(path));
	}

	function appDataDir() {
		try {
			const dir = Services.dirsvc.get("AppData", Ci.nsIFile);
			return dir && dir.path ? String(dir.path) : "";
		}
		catch (e) {
			log("AppData lookup failed: " + e);
			return "";
		}
	}

	// Build a path with nsIFile.append(): PathUtils/IOUtils are not guaranteed
	// in the bootstrap scope (docs/zotero-api-notes.md §8.1), while nsIFile is.
	function joinPath(base, ...parts) {
		if (!base) return "";
		try {
			let file = pathToFile(base);
			for (const part of parts) {
				if (part) file.append(String(part));
			}
			return file.path ? String(file.path) : "";
		}
		catch (e) {
			log("join path failed: " + e);
			return "";
		}
	}

	function isWindows() {
		try {
			if (typeof Zotero.isWin === "boolean") return Zotero.isWin;
			return String(Services.appinfo.OS || "").toUpperCase() === "WINNT";
		}
		catch (e) {
			return false;
		}
	}

	function defaultLaunchInfoPath() {
		const appData = appDataDir();
		return appData ? joinPath(appData, "BabelDOC-Studio", "zotero", "launch-info.json") : "";
	}

	/** Where launch-info.json may live, most specific first (pref -> AppData). */
	function launchInfoCandidates() {
		const candidates = [];
		const custom = prefString(PREF_LAUNCH_INFO_PATH, "").trim();
		if (custom) {
			if (/\.json$/i.test(custom)) {
				candidates.push(custom);
			}
			else {
				// The preference may point at the app's folder or at %APPDATA%.
				candidates.push(joinPath(custom, "launch-info.json"));
				candidates.push(joinPath(custom, "zotero", "launch-info.json"));
			}
		}
		const fallback = defaultLaunchInfoPath();
		if (fallback) candidates.push(fallback);
		return candidates.filter(function (path) { return !!path; });
	}

	async function readLaunchInfo() {
		const candidates = launchInfoCandidates();
		for (const path of candidates) {
			try {
				if (!fileExists(path)) continue;
				const data = parseJSON(await readTextFile(path));
				if (!data || typeof data !== "object") continue;
				// A launch-info.json from another app (or half-written) is useless.
				if (data.app && String(data.app) !== APP_NAME) {
					log("ignoring launch-info.json for " + data.app + ": " + path);
					continue;
				}
				data.launchInfoPath = path;
				return data;
			}
			catch (e) {
				log("launch-info read failed (" + path + "): " + e);
			}
		}
		return null;
	}

	/* ------------------------------------------------------------------ */
	/* HTTP: /api/health and /api/zotero/open                             */
	/* ------------------------------------------------------------------ */

	function effectivePort(info) {
		const override = prefInt(PREF_PORT, 0);
		if (override > 0) return override;
		const port = parseInt(info && info.port, 10);
		if (Number.isFinite(port) && port > 0 && port < 65536) return port;
		return DEFAULT_PORT;
	}

	/**
	 * Candidate base URLs, most likely first.
	 *
	 * A port preference > 0 is an explicit user choice and is tried alone; with
	 * 0 ("auto") the launch-info port is tried first and then the whole
	 * 8765..8804 window, so an app that had to move ports is still found.
	 */
	function serverURLs(info) {
		const override = prefInt(PREF_PORT, 0);
		const ports = [];
		const add = function (value) {
			const port = parseInt(value, 10);
			if (!Number.isFinite(port) || port <= 0 || port >= 65536) return;
			if (ports.indexOf(port) === -1) ports.push(port);
		};
		if (override > 0) {
			add(override);
		}
		else {
			add(info && info.port);
			for (let index = 0; index < PORT_SCAN_COUNT; index++) {
				add(DEFAULT_PORT + index);
			}
		}
		return ports.map(function (port) { return "http://127.0.0.1:" + port; });
	}

	/**
	 * Parse a /api/health body.
	 *
	 * The handshake (contract §1) needs more than "the app answered": the
	 * `features` array is what tells a current build from a stale packaged app
	 * that still owns 127.0.0.1:8765 but has no /api/zotero/* routes.
	 * Returns null for anything that is not ReadPI at all.
	 */
	function healthServer(baseURL, data) {
		if (!data || typeof data !== "object") return null;
		if (String(data.app || "") !== APP_NAME) return null;
		let port = 0;
		try {
			port = parseInt(new URL(baseURL).port, 10) || DEFAULT_PORT;
		}
		catch (e) {
			port = DEFAULT_PORT;
		}
		const features = Array.isArray(data.features)
			? data.features.filter(function (name) { return typeof name === "string" && !!name; })
			: [];
		return {
			url: baseURL,
			port: port,
			version: data.version === undefined || data.version === null ? "" : String(data.version),
			features: features,
			capable: features.indexOf(FEATURE_ZOTERO) !== -1
		};
	}

	async function probeHealth(baseURL, timeout) {
		try {
			const xhr = await Zotero.HTTP.request("GET", baseURL + "/api/health", {
				timeout: timeout || HEALTH_TIMEOUT_MS,
				responseType: "text",
				noCache: true,
				// Never let Zotero retry a 5xx for up to an hour: a local server
				// that is down must fail fast (http.js default is 1 hour).
				errorDelayMax: 0,
				successCodes: [200]
			});
			return healthServer(baseURL, parseJSON(xhr && xhr.responseText));
		}
		catch (e) {
			return null;
		}
	}

	function hasFeature(server, feature) {
		if (!server || !Array.isArray(server.features)) return false;
		return server.features.indexOf(String(feature)) !== -1;
	}

	/**
	 * Walk the whole port window and prefer a capable server anywhere in it.
	 *
	 * Returns { server, stale }: `server` is the first server whose features
	 * include "zotero"; `stale` lists ReadPI servers that answered but
	 * are too old (used for the app_outdated message).  Servers of other apps
	 * are ignored entirely.
	 */
	async function discoverServer(info, timeout) {
		const stale = [];
		for (const url of serverURLs(info)) {
			const server = await probeHealth(url, timeout);
			if (!server) continue;
			if (server.capable) return { server: server, stale: stale };
			stale.push(server);
		}
		return { server: null, stale: stale };
	}

	async function findServer(info, timeout) {
		const discovered = await discoverServer(info, timeout);
		return discovered.server ? discovered.server.url : "";
	}

	/**
	 * POST JSON and resolve for 4xx/5xx too, so the app's error body
	 * (error/code/retryable) survives; a transport error still rejects.
	 */
	async function postJSON(baseURL, pathName, body, timeout) {
		const xhr = await Zotero.HTTP.request("POST", baseURL + pathName, {
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
			timeout: timeout || POST_TIMEOUT_MS,
			errorDelayMax: 0,
			successCodes: false
		});
		return {
			status: (xhr && xhr.status) || 0,
			data: parseJSON(xhr && xhr.responseText)
		};
	}

	async function postOpen(baseURL, payload) {
		return postJSON(baseURL, "/api/zotero/open", payload, POST_TIMEOUT_MS);
	}

	async function postLibrary(baseURL, body) {
		return postJSON(baseURL, "/api/zotero/library", body, LIBRARY_POST_TIMEOUT_MS);
	}

	async function postPanel(baseURL, body) {
		return postJSON(baseURL, "/api/zotero/panel", body, POST_TIMEOUT_MS);
	}


	/* ------------------------------------------------------------------ */
	/* Launching the app when it is not running                            */
	/* ------------------------------------------------------------------ */

	function execNoWait(command, args, label) {
		try {
			const utils = Zotero && Zotero.Utilities && Zotero.Utilities.Internal;
			if (!utils || typeof utils.exec !== "function") {
				return { ok: false, error: "当前 Zotero 版本不支持启动本地应用（缺少 Zotero.Utilities.Internal.exec）。" };
			}
			const pending = utils.exec(command, args || []);
			if (pending && typeof pending.catch === "function") {
				// A long-lived app only settles when it exits, so never await this
				// Promise: the health polling below is what decides success.
				pending.catch(function (error) {
					log(label + " process ended with an error: " + error);
				});
			}
			return { ok: true, command: String(command), label: label };
		}
		catch (e) {
			return { ok: false, error: label + " 启动失败：" + (e && e.message ? e.message : e) };
		}
	}

	function cmdExePath() {
		try {
			if (Services && Services.env && typeof Services.env.get === "function") {
				const comspec = Services.env.get("COMSPEC");
				if (comspec) return String(comspec);
			}
		}
		catch (e) {
			// fall through to the default location
		}
		return "C:\\Windows\\System32\\cmd.exe";
	}

	function execBatch(batPath) {
		if (!isWindows()) {
			// `cmd.exe /c start` is Windows-only; on other platforms the .bat is
			// not executable anyway, so report it instead of failing obscurely.
			return { ok: false, error: "只有 Windows 支持通过 cmd.exe 启动 .bat：" + batPath };
		}
		// .bat is not an executable for nsIProcess; cmd.exe /c start is the
		// documented workaround (docs/zotero-api-notes.md §6.3).
		return execNoWait(cmdExePath(), ["/c", "start", "", batPath], "Start.bat");
	}

	function execLauncher(path) {
		const text = String(path || "").trim();
		if (!text) return { ok: false, error: "启动器路径为空。" };
		if (/\.bat$/i.test(text)) return execBatch(text);
		if (/\.exe$/i.test(text)) return execNoWait(text, [], "应用启动器");
		try {
			const file = pathToFile(text);
			if (file && typeof file.isDirectory === "function" && file.isDirectory()) {
				const inside = [joinPath(text, "BabelDOC Studio.exe"), joinPath(text, "Start.bat")];
				for (const candidate of inside) {
					if (!fileExists(candidate)) continue;
					return /\.bat$/i.test(candidate) ? execBatch(candidate) : execNoWait(candidate, [], "应用启动器");
				}
				return { ok: false, error: "所选目录中找不到 BabelDOC Studio.exe 或 Start.bat。" };
			}
		}
		catch (e) {
			// Not a directory (or not inspectable): let exec() produce the error.
		}
		return execNoWait(text, [], "应用启动器");
	}

	/**
	 * Try the launch chain: preference path -> launcher -> Start.bat -> pythonw.
	 * Only the first accepted command is used; exec() rejecting synchronously
	 * (missing file, not executable) moves on to the next fallback.
	 */
	function launchApp(info) {
		const methods = [];
		const custom = prefString(PREF_APP_PATH, "").trim();
		if (custom) {
			methods.push({ label: "自定义启动器", run: function () { return execLauncher(custom); } });
		}
		if (info && info.launcher) {
			methods.push({ label: "应用启动器", run: function () { return execNoWait(info.launcher, [], "应用启动器"); } });
		}
		if (info && info.start_bat) {
			methods.push({ label: "Start.bat", run: function () { return execBatch(info.start_bat); } });
		}
		if (info && info.pythonw && info.script) {
			methods.push({
				label: "pythonw",
				run: function () {
					// --server-only keeps the app from opening its own library window;
					// the POST below opens the reader window.  The app rewrites
					// launch-info.json if it has to bind another port.
					return execNoWait(
						info.pythonw,
						[info.script, "--server-only", "--port", String(effectivePort(info))],
						"pythonw"
					);
				}
			});
		}
		if (!methods.length) {
			return {
				ok: false,
				method: "",
				error: "没有找到可用的启动方式：launch-info.json 不存在，偏好里也没有设置启动器路径。",
				attempts: []
			};
		}
		const attempts = [];
		const errors = [];
		for (const method of methods) {
			let result;
			try {
				result = method.run();
			}
			catch (e) {
				result = { ok: false, error: String(e) };
			}
			attempts.push({ method: method.label, ok: !!(result && result.ok), error: (result && result.error) || "" });
			if (result && result.ok) {
				return { ok: true, method: method.label, error: "", attempts: attempts };
			}
			errors.push(method.label + ": " + ((result && result.error) || "未知错误"));
		}
		return { ok: false, method: "", error: errors.join("；"), attempts: attempts };
	}

	/**
	 * Poll until a *capable* server answers (or the ~25 s window elapses).
	 * Returns the health descriptor or null; only servers with the "zotero"
	 * feature are accepted, so a stale server cannot satisfy the wait.
	 */
	async function waitForServer(info, onAttempt) {
		const urls = serverURLs(info);
		const preferred = urls[0] || ("http://127.0.0.1:" + DEFAULT_PORT);
		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			if (typeof onAttempt === "function") {
				try {
					onAttempt(attempt);
				}
				catch (e) {
					// progress display must not break the poll loop
				}
			}
			let server = null;
			if (attempt % LAUNCH_SCAN_EVERY === 0) {
				server = await discoverServer(info, HEALTH_TIMEOUT_FAST_MS).then(function (result) {
					return result.server;
				});
			}
			else {
				const probed = await probeHealth(preferred, HEALTH_TIMEOUT_FAST_MS);
				if (probed && probed.capable) server = probed;
			}
			if (server) return server;
			await delay(LAUNCH_POLL_MS);
		}
		return null;
	}

	function launchFailureDetail(launch, info) {
		const parts = [];
		if (launch) {
			if (launch.ok) {
				parts.push(
					"已尝试通过「" + launch.method + "」启动 ReadPI，但 "
					+ Math.round((LAUNCH_ATTEMPTS * LAUNCH_POLL_MS) / 1000) + " 秒内没有等到服务就绪。"
				);
			}
			else {
				parts.push("自动启动失败：" + launch.error);
			}
		}
		if (!info) {
			const candidates = launchInfoCandidates();
			parts.push("没有找到 launch-info.json（查找位置：" + (candidates.join("；") || "无") + "）。");
		}
		parts.push("请手动启动 ReadPI 后点「重试」，或在 Zotero 设置 → ReadPI 中填写启动器路径、launch-info.json 路径或端口。");
		return parts.join("");
	}

	/** Progress text is decoration: a failing line must never break a flow. */
	function setLine(line, text) {
		if (!line) return;
		try {
			line.setText(String(text));
		}
		catch (e) {
			// ignore
		}
	}

	function uniqueStaleVersions(stale) {
		const versions = [];
		for (const server of stale) {
			const version = server.version || "未知版本";
			if (versions.indexOf(version) === -1) versions.push(version);
		}
		return versions;
	}

	function staleServerDetail(stale) {
		return stale.map(function (server) {
			return "127.0.0.1:" + server.port + "（版本 " + (server.version || "未知版本") + "）";
		}).join("；");
	}

	/**
	 * Old-but-alive app: it answers /api/health yet has no /api/zotero/* routes
	 * (contract §1).  The message names the version the user has to close, and
	 * the detail lists every stale port that was seen.
	 */
	function appOutdatedFailure(stale, launch) {
		const versions = uniqueStaleVersions(stale);
		const versionText = versions.length ? versions.join("、") : "未知版本";
		const message = "检测到旧版本 BabelDOC Studio（" + versionText + "）正在运行，该版本没有 Zotero 接口。"
			+ "请关闭它并启动新版本后重试。";
		const detail = ["检测到的服务：" + staleServerDetail(stale) + "。"];
		if (launch) {
			if (launch.ok) {
				detail.push(
					"已尝试通过「" + launch.method + "」自动启动新版本，但 "
					+ Math.round((LAUNCH_ATTEMPTS * LAUNCH_POLL_MS) / 1000) + " 秒内没有等到支持 Zotero 接口的服务。"
				);
			}
			else {
				detail.push("自动启动新版本失败：" + launch.error);
			}
		}
		detail.push("请关闭旧版本（必要时在任务管理器里结束残留的 BabelDOC Studio / python 进程），再启动新版后点「重试」。");
		return {
			ok: false,
			retryable: true,
			code: "app_outdated",
			message: message,
			detail: detail.join(""),
			stale: stale,
			launch: launch || null,
			url: stale.length ? stale[0].url : ""
		};
	}

	function appNotRunningFailure(code, message, detail, launch) {
		return {
			ok: false,
			retryable: true,
			code: code || "app_not_running",
			message: message,
			detail: detail || "",
			launch: launch || null,
			url: ""
		};
	}

	/**
	 * Find a capable server, starting the app when allowed.
	 *
	 * Order of preference (contract §1): a capable server anywhere in the port
	 * window wins over a stale one; if only stale servers answer, auto-launch
	 * once (when the preference allows it) and scan again; if the stale server
	 * is all that is left, report `app_outdated` instead of letting the request
	 * hit a 404.
	 */
	async function ensureCapableServer(options) {
		const opts = options || {};
		const line = opts.line || null;
		let info = null;
		try {
			info = await readLaunchInfo();
		}
		catch (e) {
			logError(e);
		}
		const discovered = await discoverServer(info, HEALTH_TIMEOUT_MS);
		if (discovered.server) return { ok: true, server: discovered.server, info: info, launch: null };

		const autoLaunch = opts.allowLaunch === false ? false : prefBool(PREF_AUTO_LAUNCH, true);

		if (discovered.stale.length) {
			if (!autoLaunch) return appOutdatedFailure(discovered.stale, null);
			setLine(line, "检测到旧版本，正在启动新版本 ReadPI…");
			const launch = launchApp(info);
			if (!launch.ok) log("launch failed: " + launch.error);
			const server = await waitForServer(info, launchProgressReporter(line));
			if (server) return { ok: true, server: server, info: info, launch: launch };
			// One rescan decides between "old app still there" and "nothing at all".
			const after = await discoverServer(info, HEALTH_TIMEOUT_FAST_MS);
			if (after.server) return { ok: true, server: after.server, info: info, launch: launch };
			if (after.stale.length) return appOutdatedFailure(after.stale, launch);
			return appNotRunningFailure(
				"app_not_running",
				"ReadPI 没有响应。",
				launchFailureDetail(launch, info),
				launch
			);
		}

		if (!autoLaunch) {
			return appNotRunningFailure(
				"app_not_running",
				"ReadPI 没有在运行（自动启动已关闭）。",
				"请先启动 ReadPI，然后点「重试」；也可以在 Zotero 设置 → ReadPI 中打开自动启动。",
				null
			);
		}

		setLine(line, "正在启动 ReadPI…");
		const launch = launchApp(info);
		if (!launch.ok) log("launch failed: " + launch.error);
		const server = await waitForServer(info, launchProgressReporter(line));
		if (server) return { ok: true, server: server, info: info, launch: launch };
		const after = await discoverServer(info, HEALTH_TIMEOUT_FAST_MS);
		if (after.server) return { ok: true, server: after.server, info: info, launch: launch };
		if (after.stale.length) return appOutdatedFailure(after.stale, launch);
		return appNotRunningFailure(
			"app_not_running",
			"ReadPI 没有响应。",
			launchFailureDetail(launch, info),
			launch
		);
	}

	function launchProgressReporter(line) {
		return function (attempt) {
			if (attempt > 0 && attempt % 10 === 5) {
				setLine(line, "正在等待 ReadPI 启动…（约 " + Math.round((attempt * LAUNCH_POLL_MS) / 1000) + " 秒）");
			}
		};
	}


	/* ------------------------------------------------------------------ */
	/* Progress window feedback                                           */
	/* ------------------------------------------------------------------ */

	function noopProgressWindow() {
		const line = {
			setText: function () {},
			setProgress: function () {},
			setError: function () {}
		};
		return {
			changeHeadline: function () {},
			addDescription: function () {},
			show: function () {},
			startCloseTimer: function () {},
			close: function () {},
			ItemProgress: function () { return line; }
		};
	}

	function createProgressWindow() {
		try {
			if (Zotero && typeof Zotero.ProgressWindow === "function") {
				const progress = new Zotero.ProgressWindow({ closeOnClick: false });
				progress.changeHeadline(DISPLAY_NAME);
				return progress;
			}
		}
		catch (e) {
			log("progress window failed: " + e);
		}
		return noopProgressWindow();
	}

	function addProgressLine(progress, icon, text) {
		try {
			return new progress.ItemProgress(icon, text);
		}
		catch (e) {
			log("progress line failed: " + e);
			return { setText: function () {}, setProgress: function () {}, setError: function () {} };
		}
	}

	function showProgress(progress) {
		try {
			progress.show();
		}
		catch (e) {
			log("progress.show failed: " + e);
		}
	}

	function addDescription(progress, text) {
		if (!text) return;
		try {
			progress.addDescription(String(text));
		}
		catch (e) {
			// ignore
		}
	}

	function showSuccess(progress, line, data) {
		const page = data && Number.isInteger(data.page) ? data.page : 0;
		try {
			line.setProgress(100);
		}
		catch (e) {
			// ignore
		}
		try {
			line.setText("已在 ReadPI 中打开" + (page > 0 ? "（第 " + page + " 页）" : ""));
		}
		catch (e) {
			// ignore
		}
		if (data && data.message) addDescription(progress, data.message);
		if (data && data.variant && data.variant !== "original") {
			addDescription(progress, "打开的版本：" + (data.variant === "dual" ? "双语对照" : "译文"));
		}
		try {
			progress.startCloseTimer(SUCCESS_CLOSE_MS);
		}
		catch (e) {
			// ignore
		}
	}

	function showFailure(progress, line, failure) {
		try {
			line.setError();
		}
		catch (e) {
			// ignore
		}
		try {
			line.setText(failure.message || "无法打开 ReadPI");
		}
		catch (e) {
			// ignore
		}
		if (failure.detail) addDescription(progress, failure.detail);
		if (failure.retryable) {
			addDescription(progress, "这一步可以重试：处理好上面的问题后点「重试」，或再次点击菜单。");
		}
	}

	function notifyNothing(message) {
		const progress = createProgressWindow();
		const line = addProgressLine(progress, "dialog-error", "找不到可用的本地 PDF");
		try {
			line.setError();
		}
		catch (e) {
			// ignore
		}
		addDescription(progress, message);
		showProgress(progress);
		try {
			progress.startCloseTimer(NOTICE_CLOSE_MS);
		}
		catch (e) {
			// ignore
		}
	}

	function getMainWindow() {
		try {
			return Zotero.getMainWindow ? (Zotero.getMainWindow() || null) : null;
		}
		catch (e) {
			return null;
		}
	}

	async function confirmRetry(failure) {
		try {
			const prompt = Services && Services.prompt;
			if (!prompt || typeof prompt.confirmEx !== "function") return false;
			// Values verified against nsIPromptService.idl (Firefox ESR 115 /
			// Zotero 7); the numeric fallbacks keep this working if constants move.
			const pos0 = prompt.BUTTON_POS_0 || 1;
			const pos1 = prompt.BUTTON_POS_1 || 256;
			const titleString = prompt.BUTTON_TITLE_IS_STRING || 127;
			const titleCancel = prompt.BUTTON_TITLE_CANCEL || 2;
			const flags = pos0 * titleString + pos1 * titleCancel;
			const checkState = { value: false };
			const index = prompt.confirmEx(
				getMainWindow(),
				DISPLAY_NAME,
				failure.message || "无法打开 ReadPI",
				flags,
				"重试",
				"",
				"",
				null,
				checkState
			);
			return index === 0;
		}
		catch (e) {
			log("confirmEx failed: " + e);
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Items: finding PDF attachments, page number, metadata              */
	/* ------------------------------------------------------------------ */

	function getMainWindows() {
		try {
			if (Zotero.getMainWindows) return Zotero.getMainWindows() || [];
		}
		catch (e) {
			// fall through
		}
		const win = getMainWindow();
		return win ? [win] : [];
	}

	function getZoteroPane(win) {
		try {
			if (win && win.ZoteroPane && typeof win.ZoteroPane.getSelectedItems === "function") {
				return win.ZoteroPane;
			}
		}
		catch (e) {
			// fall through
		}
		try {
			return Zotero.getActiveZoteroPane ? Zotero.getActiveZoteroPane() : null;
		}
		catch (e) {
			return null;
		}
	}

	function getSelectedItems(win) {
		try {
			const pane = getZoteroPane(win);
			return pane ? (pane.getSelectedItems() || []) : [];
		}
		catch (e) {
			log("getSelectedItems failed: " + e);
			return [];
		}
	}

	/**
	 * The reader shown by this window, if the selected tab is a reader tab.
	 * Zotero 7 has no Zotero.Reader.getActiveReader(); this is the official
	 * pattern (Zotero_Tabs.selectedType + getByTabID).
	 */
	function getActiveReader(win) {
		try {
			const target = win || getMainWindow();
			const tabs = target && target.Zotero_Tabs;
			if (!tabs || tabs.selectedType !== "reader") return null;
			const readerAPI = Zotero.Reader;
			if (readerAPI && typeof readerAPI.getByTabID === "function") {
				return readerAPI.getByTabID(tabs.selectedID) || null;
			}
			if (readerAPI && typeof readerAPI.getActiveReader === "function") {
				return readerAPI.getActiveReader() || null;
			}
		}
		catch (e) {
			log("active reader lookup failed: " + e);
		}
		return null;
	}

	/** A reader tab that has this attachment open, even if another tab is shown. */
	function findReaderForItem(itemID, win) {
		try {
			const target = win || getMainWindow();
			const tabs = target && target.Zotero_Tabs;
			const readerAPI = Zotero.Reader;
			if (!tabs || !readerAPI || itemID === undefined || itemID === null) return null;
			let tabID = "";
			if (typeof tabs.getTabIDByItemID === "function") {
				tabID = tabs.getTabIDByItemID(itemID) || "";
			}
			if (tabID && typeof readerAPI.getByTabID === "function") {
				return readerAPI.getByTabID(tabID) || null;
			}
		}
		catch (e) {
			log("reader lookup for item failed: " + e);
		}
		return null;
	}

	/**
	 * Current page index (0-based) of a reader.
	 *
	 * `reader._state.pageIndex` is the live value (the ReaderInstance proxy
	 * forwards it to _internalReader), but it is internal: every step is guarded
	 * and the Zotero-persisted "last page" is the fallback.  The HTTP API wants
	 * a 1-based page, so callers add one.
	 */
	async function getReaderPageIndex(reader) {
		if (!reader) return 0;
		try {
			const live = reader._state;
			if (live && Number.isInteger(live.pageIndex) && live.pageIndex >= 0) {
				return live.pageIndex;
			}
		}
		catch (e) {
			log("reader._state unavailable: " + e);
		}
		try {
			if (typeof reader._getState === "function") {
				const persisted = await reader._getState();
				if (persisted && Number.isInteger(persisted.pageIndex) && persisted.pageIndex >= 0) {
					return persisted.pageIndex;
				}
			}
		}
		catch (e) {
			log("reader._getState failed: " + e);
		}
		try {
			const item = Zotero.Items.get(reader.itemID);
			if (item && typeof item.getAttachmentLastPageIndex === "function") {
				const last = item.getAttachmentLastPageIndex();
				if (Number.isInteger(last) && last >= 0) return last;
			}
		}
		catch (e) {
			log("last page index failed: " + e);
		}
		return 0;
	}

	function pdfAttachmentsOf(item) {
		const attachments = [];
		try {
			if (!item) return attachments;
			if (item.isAttachment && item.isAttachment()) {
				if (item.isPDFAttachment && item.isPDFAttachment()) attachments.push(item);
				return attachments;
			}
			if (item.isRegularItem && item.isRegularItem()) {
				const ids = item.getAttachments ? (item.getAttachments() || []) : [];
				for (const id of ids) {
					const attachment = Zotero.Items.get(id);
					if (attachment && attachment.isPDFAttachment && attachment.isPDFAttachment()) {
						attachments.push(attachment);
					}
				}
			}
		}
		catch (e) {
			log("pdfAttachmentsOf failed: " + e);
		}
		return attachments;
	}

	/** Sync check used by popupshowing: menus cannot wait for a Promise. */
	function hasLocalPDFSync(items) {
		if (!items || !items.length) return false;
		for (const item of items) {
			try {
				if (item.isAttachment && item.isAttachment()) {
					if (item.isPDFAttachment && item.isPDFAttachment() && item.getFilePath()) return true;
					continue;
				}
				if (item.isRegularItem && item.isRegularItem()) {
					const ids = item.getAttachments ? (item.getAttachments() || []) : [];
					for (const id of ids) {
						const attachment = Zotero.Items.get(id);
						if (
							attachment
							&& attachment.isPDFAttachment && attachment.isPDFAttachment()
							&& attachment.getFilePath()
						) {
							return true;
						}
					}
				}
			}
			catch (e) {
				log("hasLocalPDFSync failed: " + e);
			}
		}
		return false;
	}

	function fieldOf(item, name) {
		try {
			if (!item || typeof item.getField !== "function") return "";
			const value = item.getField(name);
			return value === undefined || value === null ? "" : String(value);
		}
		catch (e) {
			return "";
		}
	}

	function yearOf(item) {
		const year = fieldOf(item, "year").trim();
		if (year) return year.slice(0, 12);
		const match = /(\d{4})/.exec(fieldOf(item, "date"));
		return match ? match[1] : "";
	}

	function creatorsOf(item) {
		try {
			if (!item || typeof item.getCreators !== "function") return "";
			const creators = item.getCreators() || [];
			return creators
				.map(function (creator) {
					if (!creator) return "";
					const last = String(creator.lastName || creator.name || "").trim();
					const first = String(creator.firstName || "").trim();
					return (first + " " + last).trim();
				})
				.filter(function (name) { return !!name; })
				.join(", ");
		}
		catch (e) {
			return "";
		}
	}

	async function attachmentPath(attachment) {
		try {
			const path = await attachment.getFilePathAsync();
			return path ? String(path) : "";
		}
		catch (e) {
			log("getFilePathAsync failed: " + e);
			return "";
		}
	}

	/**
	 * The POST body for /api/zotero/open.
	 *
	 * `open_window` is deliberately absent: the app opens the reader window
	 * itself when the request succeeds.  `page` is 1-based (reader pageIndex+1).
	 */
	async function buildPayload(attachment, parentItem, pageIndex, withPage) {
		if (!attachment) {
			return { error: "missing_attachment", message: "没有找到可用的 PDF 附件。" };
		}
		const path = await attachmentPath(attachment);
		if (!path) {
			return {
				error: "file_missing",
				message: "附件尚未下载或文件已丢失。请先在 Zotero 中下载这个 PDF 附件，然后重试。"
			};
		}
		const meta = parentItem || attachment.parentItem || attachment;
		const payload = { path: path };
		if (withPage && Number.isInteger(pageIndex) && pageIndex >= 0) {
			payload.page = pageIndex + 1;
		}
		payload.title = fieldOf(meta, "title") || fieldOf(attachment, "title");
		payload.doi = fieldOf(meta, "DOI");
		payload.year = yearOf(meta);
		payload.creators = creatorsOf(meta).slice(0, 400);
		payload.library_id = String((meta && meta.libraryID) || (attachment && attachment.libraryID) || "");
		payload.item_key = String((meta && meta.key) || "");
		payload.attachment_key = String((attachment && attachment.key) || "");
		return { payload: payload, attachment: attachment, item: meta };
	}

	/* ------------------------------------------------------------------ */
	/* Multiple attachments: ask the user                                 */
	/* ------------------------------------------------------------------ */

	function candidateLabel(candidate) {
		const attachment = candidate.attachment;
		const fileName = candidate.path
			? String(candidate.path).split(/[\\/]/).pop()
			: (fieldOf(attachment, "title") || "PDF");
		const title = fieldOf(candidate.parent || attachment, "title");
		return title ? (title + " — " + fileName) : fileName;
	}

	/**
	 * Pick one of several local PDFs.
	 *
	 * Services.prompt.select is preferred: its signature is
	 *   boolean select(in nsIDOMWindowProxy aParent, in wstring aDialogTitle,
	 *                  in wstring aText, in Array<AString> aSelectList,
	 *                  out long aOutSelection);
	 * (verified in nsIPromptService.idl for Firefox ESR 115, the Zotero 7
	 * platform).  The `out long` arrives as { value } in JS.
	 *
	 * If the prompt is unavailable (platform/API change) the first local PDF is
	 * opened, and the returned note tells the progress window about the other
	 * attachments — never a silent pick.
	 */
	async function chooseCandidate(candidates, win) {
		if (!candidates || !candidates.length) return { status: "none" };
		if (candidates.length === 1) {
			return { status: "selected", candidate: candidates[0], chooser: "single" };
		}
		const labels = candidates.map(function (candidate, index) {
			return (index + 1) + ". " + candidateLabel(candidate);
		});
		const prompt = Services && Services.prompt;
		if (prompt && typeof prompt.select === "function") {
			const selected = { value: 0 };
			try {
				const accepted = prompt.select(
					win || getMainWindow(),
					DISPLAY_NAME,
					"这个文献有 " + candidates.length + " 个本地 PDF 附件，请选择要在 ReadPI 中打开的一个：",
					labels,
					selected
				);
				if (!accepted) return { status: "cancelled", chooser: "select" };
				const raw = selected && typeof selected === "object" ? selected.value : selected;
				const index = parseInt(raw, 10);
				if (Number.isFinite(index) && index >= 0 && index < candidates.length) {
					return { status: "selected", candidate: candidates[index], chooser: "select" };
				}
				return {
					status: "selected",
					candidate: candidates[0],
					chooser: "select",
					note: true,
					noteText: "选择框返回了无法识别的编号（" + raw + "），已打开第 1 个：" + candidateLabel(candidates[0]) + "。"
				};
			}
			catch (e) {
				log("Services.prompt.select failed: " + e);
				return {
					status: "selected",
					candidate: candidates[0],
					chooser: "fallback",
					note: true,
					noteText: "这个文献有 " + candidates.length + " 个 PDF 附件，但当前 Zotero 无法显示选择框，已打开第 1 个："
						+ candidateLabel(candidates[0]) + "。"
				};
			}
		}
		return {
			status: "selected",
			candidate: candidates[0],
			chooser: "fallback",
			note: true,
			noteText: "这个文献有 " + candidates.length + " 个 PDF 附件，当前 Zotero 版本不支持选择框，已打开第 1 个："
				+ candidateLabel(candidates[0])
				+ "。要打开其他附件，请先双击目标 PDF 打开阅读器，再使用阅读器工具栏的 ReadPI 按钮。"
		};
	}

	/* ------------------------------------------------------------------ */
	/* Main flow: open one attachment                                     */
	/* ------------------------------------------------------------------ */

	/**
	 * One open attempt: find the app (or start it), then POST the payload.
	 * Returns { ok, data, ... } or a failure with { retryable, message, detail }.
	 */
	async function attemptOpen(payload, line) {
		try {
			line.setText("正在连接 ReadPI…");
		}
		catch (e) {
			// ignore
		}
		const ready = await ensureCapableServer({ line: line });
		if (!ready.ok) return ready;
		if (payload.mode === "translate" && !hasFeature(ready.server, FEATURE_TRANSLATE)) {
			return { ok: false, retryable: false, code: "app_outdated",
				message: "请启动支持 Zotero 翻译的新版 ReadPI。", detail: "" };
		}
		const url = ready.server.url;
		try {
			line.setText("正在把 PDF 交给 ReadPI…");
		}
		catch (e) {
			// ignore
		}
		try {
			const response = await postOpen(url, payload);
			const data = response.data;
			if (data && data.ok) {
				return { ok: true, data: data, url: url, status: response.status };
			}
			return {
				ok: false,
				retryable: !!(data && data.retryable),
				code: (data && data.code) || "server_error",
				status: response.status,
				message: (data && data.error) || ("ReadPI 返回了 HTTP " + response.status),
				detail: (data && data.detail) || "",
				data: data,
				url: url
			};
		}
		catch (e) {
			logError(e);
			return {
				ok: false,
				retryable: true,
				code: "connection_failed",
				message: "无法连接 ReadPI。",
				detail: String(e && e.message ? e.message : e),
				url: url
			};
		}
	}

	async function openPayload(payload, options) {
		const opts = options || {};
		const progress = createProgressWindow();
		let line = addProgressLine(progress, "document", "正在准备…");
		showProgress(progress);
		if (opts.note) addDescription(progress, opts.note);

		let failure = null;
		for (let attempt = 1; attempt <= MAX_OPEN_ATTEMPTS; attempt++) {
			failure = await attemptOpen(payload, line);
			if (failure.ok) {
				showSuccess(progress, line, failure.data);
				return failure;
			}
			showFailure(progress, line, failure);
			if (!failure.retryable) return failure;
			const retry = await confirmRetry(failure);
			if (!retry) return failure;
			line = addProgressLine(progress, "document", "正在重试…");
		}
		return failure;
	}

	async function openAttachment(attachment, parentItem, pageIndex, withPage, note, mode) {
		const built = await buildPayload(attachment, parentItem, pageIndex, withPage);
		if (built.error) {
			notifyNothing(built.message || "找不到可用的本地 PDF。");
			return { ok: false, reason: built.error };
		}
		if (mode === "translate") built.payload.mode = "translate";
		return await openPayload(built.payload, { note: note || "" });
	}

	async function openReaderAttachment(reader, mode) {
		try {
			const attachment = Zotero.Items.get(reader.itemID);
			if (!attachment) {
				notifyNothing("找不到这个阅读器对应的附件。");
				return { ok: false, reason: "missing_attachment" };
			}
			const pageIndex = await getReaderPageIndex(reader);
			const parent = attachment.parentItem || null;
			return await openAttachment(attachment, parent, pageIndex, prefBool(PREF_PASS_PAGE, true), "", mode);
		}
		catch (e) {
			logError(e);
			notifyNothing("打开阅读器 PDF 时出错：" + (e && e.message ? e.message : e));
			return { ok: false, reason: "error" };
		}
	}

	/**
	 * The item-list menu entry.
	 *
	 * In a reader tab the active PDF wins (with its page).  Otherwise the
	 * selected items are inspected; when a PDF of an item already has a reader
	 * tab open, its page is passed too, otherwise the app resumes where the user
	 * left off in BabelDOC.
	 */
	async function openSelectedItems(win, mode) {
		const reader = getActiveReader(win);
		if (isPDFReader(reader)) return await openReaderAttachment(reader, mode);

		const items = getSelectedItems(win);
		if (!items.length) {
			notifyNothing("没有选中的条目。请先在 Zotero 中选择一篇文献或它的 PDF 附件。");
			return { ok: false, reason: "no_selection" };
		}
		const candidates = [];
		for (const item of items) {
			for (const attachment of pdfAttachmentsOf(item)) {
				const path = await attachmentPath(attachment);
				candidates.push({
					attachment: attachment,
					parent: (item.isRegularItem && item.isRegularItem()) ? item : (attachment.parentItem || null),
					path: path
				});
			}
		}
		const local = candidates.filter(function (candidate) { return !!candidate.path; });
		if (!local.length) {
			notifyNothing(
				candidates.length
					? "选中的 PDF 附件还没有下载到本地，或链接文件已经失效。请先在 Zotero 中下载附件，然后再试一次。"
					: "所选条目没有 PDF 附件。请先添加或下载 PDF，再使用此菜单。"
			);
			return { ok: false, reason: "no_local_pdf" };
		}
		const choice = await chooseCandidate(local, win);
		if (choice.status !== "selected" || !choice.candidate) {
			return { ok: false, reason: choice.status };
		}
		const attachment = choice.candidate.attachment;
		let pageIndex = 0;
		let withPage = false;
		try {
			const openReader = findReaderForItem(attachment.id, win);
			if (openReader) {
				pageIndex = await getReaderPageIndex(openReader);
				withPage = prefBool(PREF_PASS_PAGE, true);
			}
		}
		catch (e) {
			log("page lookup for selected item failed: " + e);
		}
		return await openAttachment(
			attachment,
			choice.candidate.parent,
			pageIndex,
			withPage,
			choice.note ? choice.noteText : "",
			mode
		);
	}

	async function buildLibrarySnapshot() {
		const libraries = [], collections = [], items = [];
		if (!Zotero.Libraries || !Zotero.Collections || !Zotero.Items) return null;
		for (const lib of await Zotero.Libraries.getAll()) {
			libraries.push({ id: lib.libraryID, name: lib.name || "我的文库", type: lib.libraryType || "user" });
			// Zotero 10 exposes getByLibrary(libraryID, recursive), not getAll().
			const libCollections = typeof Zotero.Collections.getByLibrary === "function"
				? Zotero.Collections.getByLibrary(lib.libraryID, true)
				: (typeof Zotero.Collections.getAll === "function" ? Zotero.Collections.getAll(lib.libraryID) : []);
			for (const coll of await libCollections || []) {
				if (collections.length >= SNAPSHOT_MAX_COLLECTIONS) break;
				collections.push({ id: coll.id, library_id: lib.libraryID, name: coll.name,
					parent_id: coll.parentID || 0 });
			}
			for (const item of await Zotero.Items.getAll(lib.libraryID) || []) {
				if (items.length >= SNAPSHOT_MAX_ITEMS) break;
				if (!(item.isRegularItem && item.isRegularItem())) continue;
				const attachments = [];
				for (const attachment of pdfAttachmentsOf(item).slice(0, SNAPSHOT_MAX_ATTACHMENTS)) {
					const path = await attachmentPath(attachment);
					if (!path) continue;
					attachments.push({ key: attachment.key, title: fieldOf(attachment, "title"),
						filename: String(path).split(/[\\/]/).pop(), path: path,
						size: attachment.attachmentSize || 0 });
				}
				if (!attachments.length) continue;
				items.push({ key: item.key, library_id: lib.libraryID,
					title: fieldOf(item, "title"), creators: creatorsOf(item), year: yearOf(item),
					doi: fieldOf(item, "DOI"), item_type: item.itemType || "",
					date_added: item.dateAdded || "", collections: item.getCollections ? item.getCollections() : [],
					attachments: attachments });
			}
		}
		return { schema: 1, synced: Date.now() / 1000, zotero_version: Zotero.version || "",
			libraries: libraries, collections: collections, items: items,
			stats: { items: items.length, collections: collections.length,
				truncated: items.length >= SNAPSHOT_MAX_ITEMS || collections.length >= SNAPSHOT_MAX_COLLECTIONS } };
	}

	async function syncLibrary(force) {
		if (!state.started || snapshot.inFlight) return;
		if (!force && snapshotNow() - snapshot.lastPushAt < SNAPSHOT_THROTTLE_MS) return;
		snapshot.inFlight = true;
		try {
			const info = await readLaunchInfo();
			const found = await discoverServer(info, HEALTH_TIMEOUT_FAST_MS);
			if (!found.server || !hasFeature(found.server, FEATURE_LIBRARY)) return;
			const body = await buildLibrarySnapshot();
			if (!body) return;
			const reply = await postLibrary(found.server.url, body);
			if (reply.status !== 200 || !reply.data || !reply.data.ok) {
				log("library sync failed: HTTP " + reply.status);
				return;
			}
			snapshot.lastPushAt = snapshotNow();
		} catch (e) { logError(e); }
		finally { snapshot.inFlight = false; }
	}

	function scheduleLibrarySync() {
		const token = ++snapshot.debounceToken;
		setTimeout(function () {
			if (state.started && token === snapshot.debounceToken) syncLibrary(false);
		}, SNAPSHOT_DEBOUNCE_MS);
	}

	function installMainToolbar(win) {
		if (!win || !win.document) return;
		const doc = win.document;
		const container = TOOLBAR_CONTAINER_IDS.map(id => doc.getElementById(id)).find(Boolean);
		const existing = Array.from(doc.getElementsByTagName("toolbarbutton"))
			.filter(node => node.id === TOOLBAR_BUTTON_ID);
		const tracked = state.toolbars.get(win);
		if (container && tracked && tracked.parentNode === container
			&& existing.length === 1 && existing[0] === tracked) return;
		// A same-version XPI reinstall can leave a button from the previous
		// bootstrap context behind. Remove every instance before injecting one.
		for (const node of existing) node.remove();
		state.toolbars.delete(win);
		if (!container) return;
		const make = name => doc.createXULElement ? doc.createXULElement(name) : doc.createElement(name);
		const button = make("toolbarbutton");
		button.id = TOOLBAR_BUTTON_ID;
		button.setAttribute("type", "menu");
		button.setAttribute("aria-label", "ReadPI");
		button.setAttribute("tooltiptext", "ReadPI：翻译、阅读、结果库");
		button.setAttribute("class", "zotero-tb-button");
		button.setAttribute("tabindex", "-1");
		button.setAttribute("image", iconURI("icons/icon-20.png"));
		const popup = make("menupopup"); popup.id = TOOLBAR_MENU_ID;
		const actions = [
			[TOOLBAR_TRANSLATE_ID, "翻译", "translate"],
			[TOOLBAR_READ_ID, "阅读", "read"],
			[TOOLBAR_LIBRARY_ID, "打开结果库", "library"]
		];
		for (const [id, label, action] of actions) {
			const entry = make("menuitem"); entry.id = id; entry.setAttribute("label", label);
			entry.addEventListener("command", function () {
				if (action === "library") openLibraryPanel().catch(logError);
				else openSelectedItems(win, action).catch(logError);
			});
			popup.appendChild(entry);
		}
		popup.addEventListener("popupshowing", function () {
			const available = shouldShowItemMenu(win);
			for (const id of [TOOLBAR_TRANSLATE_ID, TOOLBAR_READ_ID]) {
				const entry = doc.getElementById(id);
				if (entry) entry.disabled = !available;
			}
			syncLibrary(true);
		});
		button.appendChild(popup);
		const spacer = Array.from(container.children || [])
			.find(node => String(node.tagName || "").toLowerCase() === "spacer"
				&& node.getAttribute("flex") === "1");
		if (spacer && typeof container.insertBefore === "function") container.insertBefore(button, spacer);
		else container.appendChild(button);
		state.toolbars.set(win, button);
	}

	function uninstallMainToolbar(win) {
		if (win && win.document) {
			for (const node of Array.from(win.document.getElementsByTagName("toolbarbutton"))) {
				if (node.id === TOOLBAR_BUTTON_ID) node.remove();
			}
		}
		state.toolbars.delete(win);
	}

	async function openLibraryPanel() {
		const ready = await ensureCapableServer({});
		if (!ready.ok) { notifyNothing(ready.message); return ready; }
		if (!hasFeature(ready.server, FEATURE_LIBRARY)) {
			notifyNothing("请启动支持 Zotero 文库的新版 ReadPI。"); return { ok: false };
		}
		await syncLibrary(true);
		return postPanel(ready.server.url, { route: "library" });
	}

	/* ------------------------------------------------------------------ */
	/* UI: item menu, reader entries, preference pane                     */
	/* ------------------------------------------------------------------ */

	function hasMenuManager() {
		try {
			return !!(Zotero && Zotero.MenuManager && typeof Zotero.MenuManager.registerMenu === "function");
		}
		catch (e) {
			return false;
		}
	}

	function iconURI(relative) {
		const root = state.rootURI;
		if (!root) return "";
		return String(root).replace(/\/?$/, "/") + relative;
	}

	function rootURIText(rootURI) {
		if (!rootURI) return "";
		if (typeof rootURI === "string") return rootURI;
		if (typeof rootURI.spec === "string") return rootURI.spec;
		return String(rootURI);
	}

	function insertFTL(win) {
		try {
			if (win && win.MozXULElement && typeof win.MozXULElement.insertFTLIfNeeded === "function") {
				win.MozXULElement.insertFTLIfNeeded(FTL_FILE);
				return true;
			}
		}
		catch (e) {
			log("insertFTL failed: " + e);
		}
		return false;
	}

	function removeFTL(win) {
		try {
			const doc = win && win.document;
			if (!doc || typeof doc.getElementsByTagName !== "function") return;
			const links = doc.getElementsByTagName("link");
			const doomed = [];
			for (let index = 0; index < links.length; index++) {
				const link = links[index];
				const href = String((link.getAttribute && link.getAttribute("href")) || "");
				const rel = String((link.getAttribute && link.getAttribute("rel")) || "");
				if (href !== FTL_FILE && href.slice(-(FTL_FILE.length + 1)) !== "/" + FTL_FILE) continue;
				if (rel && rel !== "localization") continue;
				doomed.push(link);
			}
			for (const link of doomed) link.remove();
		}
		catch (e) {
			log("removeFTL failed: " + e);
		}
	}

	/** A reader tab is only useful here when it shows a PDF (not EPUB/snapshot). */
	function isPDFReader(reader) {
		if (!reader) return false;
		try {
			const type = reader.type;
			if (typeof type === "string" && type) return type === "pdf";
		}
		catch (e) {
			// Unknown/Proxy shape: assume PDF so the entry keeps working.
		}
		return true;
	}

	/** Show the entry when a local PDF is selected; always for a PDF reader tab. */
	function shouldShowItemMenu(win) {
		if (isPDFReader(getActiveReader(win))) return true;
		return hasLocalPDFSync(getSelectedItems(win));
	}

	function installItemMenu(win) {
		if (!win || !win.document) return false;
		// Zotero 8+: MenuManager already owns the item menu; a DOM copy would
		// show the entry twice (and #zotero-itemmenu may not even exist there).
		if (hasMenuManager() && state.menuManagerID) return false;
		const doc = win.document;
		const popup = doc.getElementById("zotero-itemmenu");
		if (!popup) {
			log("no #zotero-itemmenu in this window");
			return false;
		}
		if (state.menus.has(win) || doc.getElementById(ITEM_MENU_ID)) return true;

		insertFTL(win);

		const separator = doc.createXULElement("menuseparator");
		separator.id = ITEM_MENU_SEP_ID;
		separator.classList.add("babeldoc-menu-separator");

		const menuItem = doc.createXULElement("menuitem");
		menuItem.id = ITEM_MENU_ID;
		menuItem.classList.add("menuitem-iconic", "babeldoc-menu-item");
		// Hard-coded fallback until Fluent resolves (and on Zotero builds that do
		// not pick up the FTL file).
		menuItem.setAttribute("label", "在 ReadPI 中阅读");
		const icon = iconURI("icons/icon-16.svg");
		if (icon) {
			menuItem.setAttribute("image", icon);
			try {
				menuItem.style.listStyleImage = 'url("' + icon + '")';
			}
			catch (e) {
				// ignore
			}
		}
		try {
			if (doc.l10n && typeof doc.l10n.setAttributes === "function") {
				doc.l10n.setAttributes(menuItem, "babeldoc-menu-open");
			}
		}
		catch (e) {
			log("menu l10n failed: " + e);
		}

		const onShowing = function () {
			const visible = shouldShowItemMenu(win);
			menuItem.hidden = !visible;
			separator.hidden = !visible;
		};
		const onCommand = function () {
			// The event handler itself cannot be async; keep the rejection visible.
			openSelectedItems(win).catch(function (error) {
				logError(error);
			});
		};
		popup.addEventListener("popupshowing", onShowing);
		menuItem.addEventListener("command", onCommand);
		popup.appendChild(separator);
		popup.appendChild(menuItem);
		state.menus.set(win, {
			popup: popup,
			separator: separator,
			menuItem: menuItem,
			onShowing: onShowing,
			onCommand: onCommand
		});
		return true;
	}

	function uninstallItemMenu(win) {
		if (!win || !win.document) return;
		const doc = win.document;
		const entry = state.menus.get(win);
		if (entry) {
			try { entry.popup.removeEventListener("popupshowing", entry.onShowing); }
			catch (e) { /* ignore */ }
			try { entry.menuItem.removeEventListener("command", entry.onCommand); }
			catch (e) { /* ignore */ }
			try { entry.menuItem.remove(); }
			catch (e) { /* ignore */ }
			try { entry.separator.remove(); }
			catch (e) { /* ignore */ }
			state.menus.delete(win);
		}
		// Safety net for a shutdown that raced a half-finished install.
		const leftoverItem = doc.getElementById(ITEM_MENU_ID);
		if (leftoverItem) {
			try { leftoverItem.remove(); }
			catch (e) { /* ignore */ }
		}
		const leftoverSeparator = doc.getElementById(ITEM_MENU_SEP_ID);
		if (leftoverSeparator) {
			try { leftoverSeparator.remove(); }
			catch (e) { /* ignore */ }
		}
	}

	/** Zotero 8+ only: register the item menu through the official API. */
	function registerMenuManagerMenu() {
		if (!hasMenuManager()) return false;
		if (state.menuManagerID) return true;
		const icon = iconURI("icons/icon-16.svg");
		const option = {
			menuID: "babeldoc-menu-open",
			pluginID: state.id || PLUGIN_ID,
			target: "main/library/item",
			menus: [{
				menuType: "menuitem",
				l10nID: "babeldoc-menu-open",
				icon: icon || undefined,
				onShowing: function (event, context) {
					try {
						let items = context && context.items;
						if (!Array.isArray(items) || !items.length) items = getSelectedItems(getMainWindow());
						const visible = hasLocalPDFSync(items);
						if (context && typeof context.setVisible === "function") context.setVisible(visible);
						// The MenuManager does not load plugin FTL files itself, so
						// load it here and set a readable label in the meantime.
						const menuElem = context && context.menuElem;
						if (menuElem) {
							try {
								if (!menuElem.getAttribute("label")) {
									menuElem.setAttribute("label", localeText("在 ReadPI 中阅读", "Read in ReadPI"));
								}
							}
							catch (e) {
								// ignore
							}
							if (visible && menuElem.ownerGlobal) insertFTL(menuElem.ownerGlobal);
						}
					}
					catch (e) {
						log("MenuManager onShowing failed: " + e);
					}
				},
				onCommand: function () {
					openSelectedItems(getMainWindow()).catch(function (error) {
						logError(error);
					});
				}
			}]
		};
		try {
			const result = Zotero.MenuManager.registerMenu(option);
			if (typeof result === "string" && result) {
				state.menuManagerID = result;
				return true;
			}
			if (result === false) log("Zotero.MenuManager rejected the menu");
			return false;
		}
		catch (e) {
			logError(e);
			return false;
		}
	}

	function registerReaderHooks() {
		if (state.readerHooks) return true;
		try {
			const readerAPI = Zotero && Zotero.Reader;
			if (!readerAPI || typeof readerAPI.registerEventListener !== "function") {
				log("Zotero.Reader.registerEventListener unavailable");
				return false;
			}
			// The pluginID lets Zotero remove these listeners on shutdown itself
			// (Reader registers a Zotero.Plugins shutdown observer).  On Zotero
			// 7.0.x do not call unregisterEventListener(): its filter keeps the
			// matching listener instead of dropping it.
			readerAPI.registerEventListener("renderToolbar", onRenderToolbar, state.id || PLUGIN_ID);
			readerAPI.registerEventListener("createViewContextMenu", onCreateViewContextMenu, state.id || PLUGIN_ID);
			state.readerHooks = true;
			return true;
		}
		catch (e) {
			logError(e);
			return false;
		}
	}

	function onRenderToolbar(event) {
		try {
			const reader = event && event.reader;
			const doc = event && event.doc;
			const append = event && event.append;
			if (!reader || !doc || typeof append !== "function") return;
			if (typeof doc.getElementById === "function" && doc.getElementById("babeldoc-reader-toolbar-button")) return;
			const button = doc.createElement("button");
			button.id = "babeldoc-reader-toolbar-button";
			button.type = "button";
			button.className = "toolbar-button babeldoc-toolbar-button";
			// Reader UI is not part of the main window's Fluent bundle; try the
			// bundle and keep readable text as the fallback.
			button.textContent = "ReadPI";
			button.title = localeText("在 ReadPI 中阅读", "Read in ReadPI");
			try {
				button.setAttribute("aria-label", button.title);
			}
			catch (e) {
				// ignore
			}
			try {
				const readerWindow = doc.defaultView;
				if (readerWindow && readerWindow.MozXULElement
					&& typeof readerWindow.MozXULElement.insertFTLIfNeeded === "function") {
					readerWindow.MozXULElement.insertFTLIfNeeded(FTL_FILE);
				}
				if (doc.l10n && typeof doc.l10n.setAttributes === "function") {
					doc.l10n.setAttributes(button, "babeldoc-toolbar-open");
				}
			}
			catch (e) {
				log("reader toolbar l10n failed: " + e);
			}
			button.addEventListener("click", function () {
				openReaderAttachment(reader).catch(function (error) {
					logError(error);
				});
			});
			append(button);
		}
		catch (e) {
			logError(e);
		}
	}

	function onCreateViewContextMenu(event) {
		try {
			const reader = event && event.reader;
			const append = event && event.append;
			if (!reader || typeof append !== "function") return;
			append({
				label: localeText("在 ReadPI 中阅读", "Read in ReadPI"),
				onCommand: function () {
					openReaderAttachment(reader).catch(function (error) {
						logError(error);
					});
				}
			});
		}
		catch (e) {
			logError(e);
		}
	}

	function registerPreferencePane() {
		try {
			const panes = Zotero && Zotero.PreferencePanes;
			if (!panes || typeof panes.register !== "function") {
				log("Zotero.PreferencePanes unavailable");
				return false;
			}
			const pending = panes.register({
				pluginID: state.id || PLUGIN_ID,
				src: "prefs.xhtml",
				scripts: ["prefsPane.js"],
				label: "ReadPI",
				image: "icons/icon-20.png"
			});
			if (pending && typeof pending.then === "function") {
				pending.then(function (paneID) {
					const id = typeof paneID === "string" ? paneID : "";
					if (!state.started) {
						// The plugin was disabled before the async registration
						// finished; drop the pane instead of leaving a ghost.
						try {
							if (typeof panes.unregister === "function") panes.unregister(id);
						}
						catch (e) {
							// ignore
						}
						return;
					}
					state.prefPaneID = id;
				}).catch(function (error) {
					log("preference pane registration failed: " + error);
				});
			}
			else if (typeof pending === "string") {
				state.prefPaneID = pending;
			}
			return true;
		}
		catch (e) {
			logError(e);
			return false;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Lifecycle (the six functions Zotero's bootstrap loader requires)   */
	/* ------------------------------------------------------------------ */

	function startup({ id, version, rootURI } = {}, reason) {
		state.id = id || PLUGIN_ID;
		state.version = version || "";
		state.rootURI = rootURIText(rootURI);
		state.started = true;
		log("startup " + state.id + " " + state.version + " (" + reason + ")");
		registerPreferencePane();
		registerReaderHooks();
		registerMenuManagerMenu();
		try {
			if (Zotero.Notifier && typeof Zotero.Notifier.registerObserver === "function") {
				snapshot.observerID = Zotero.Notifier.registerObserver({ notify: scheduleLibrarySync },
					["item", "collection", "collection-item", "file"], PLUGIN_ID);
			}
		} catch (e) { logError(e); }
		snapshot.startupTimer = setTimeout(function () { syncLibrary(false); }, SNAPSHOT_STARTUP_DELAY_MS);
		// Enabling a plugin while a window is already open must not require a
		// restart; onMainWindowLoad runs for existing windows too on most
		// versions, and installItemMenu() is idempotent either way.
		for (const win of getMainWindows()) {
			try {
				// The MenuManager path has no DOM item to insert the FTL from, but
				// its l10nID still needs the bundle in the window.
				if (hasMenuManager()) insertFTL(win);
				installItemMenu(win);
				installMainToolbar(win);
			}
			catch (e) {
				logError(e);
			}
		}
	}

	function shutdown({ id, version, rootURI } = {}, reason) {
		state.started = false;
		++snapshot.debounceToken;
		if (snapshot.startupTimer) clearTimeout(snapshot.startupTimer);
		snapshot.startupTimer = null;
		if (snapshot.observerID && Zotero.Notifier) {
			try { Zotero.Notifier.unregisterObserver(snapshot.observerID); } catch (e) { logError(e); }
			snapshot.observerID = "";
		}
		log("shutdown " + (id || state.id) + " (" + reason + ")");
		if (state.menuManagerID) {
			try {
				if (Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
					Zotero.MenuManager.unregisterMenu(state.menuManagerID);
				}
			}
			catch (e) {
				log("unregister MenuManager menu failed: " + e);
			}
			state.menuManagerID = "";
		}
		const windows = [];
		for (const win of getMainWindows()) {
			if (windows.indexOf(win) === -1) windows.push(win);
		}
		// Windows that disappeared without onMainWindowUnload (e.g. app quit):
		// their references are still in the Map and have to be dropped too.
		for (const win of state.menus.keys()) {
			if (windows.indexOf(win) === -1) windows.push(win);
		}
		for (const win of windows) {
			try {
				uninstallItemMenu(win);
				uninstallMainToolbar(win);
			}
			catch (e) {
				logError(e);
			}
			try {
				removeFTL(win);
			}
			catch (e) {
				logError(e);
			}
		}
		state.menus.clear();
		state.toolbars.clear();
		state.prefPaneID = "";
		state.readerHooks = false;
		state.rootURI = "";
	}

	function install(data, reason) {
		log("install (" + reason + ")");
	}

	function uninstall(data, reason) {
		log("uninstall (" + reason + ")");
	}

	function onMainWindowLoad({ window } = {}) {
		if (!window) return;
		try {
			if (hasMenuManager()) insertFTL(window);
			installItemMenu(window);
			installMainToolbar(window);
		}
		catch (e) {
			logError(e);
		}
	}

	function onMainWindowUnload({ window } = {}) {
		if (!window) return;
		try {
			uninstallItemMenu(window);
			uninstallMainToolbar(window);
		}
		catch (e) {
			logError(e);
		}
		try {
			removeFTL(window);
		}
		catch (e) {
			logError(e);
		}
	}

	return {
		PLUGIN_ID: PLUGIN_ID,
		APP_NAME: APP_NAME,
		FTL_FILE: FTL_FILE,
		PREF_PREFIX: PREF_PREFIX,
		ITEM_MENU_ID: ITEM_MENU_ID,
		ITEM_MENU_SEP_ID: ITEM_MENU_SEP_ID,
		DEFAULT_PORT: DEFAULT_PORT,
		state: state,
		startup: startup,
		shutdown: shutdown,
		install: install,
		uninstall: uninstall,
		onMainWindowLoad: onMainWindowLoad,
		onMainWindowUnload: onMainWindowUnload,
		// Documented hooks used by tests/zotero_plugin_harness.mjs and handy from
		// Zotero's Run JavaScript window while debugging.
		internals: {
			log: log,
			logError: logError,
			prefGet: prefGet,
			prefString: prefString,
			prefInt: prefInt,
			prefBool: prefBool,
			delay: delay,
			launchInfoCandidates: launchInfoCandidates,
			defaultLaunchInfoPath: defaultLaunchInfoPath,
			readLaunchInfo: readLaunchInfo,
			effectivePort: effectivePort,
			serverURLs: serverURLs,
			probeHealth: probeHealth,
			findServer: findServer,
			postOpen: postOpen,
			execNoWait: execNoWait,
			execBatch: execBatch,
			execLauncher: execLauncher,
			launchApp: launchApp,
			waitForServer: waitForServer,
			buildPayload: buildPayload,
			getReaderPageIndex: getReaderPageIndex,
			getActiveReader: getActiveReader,
			isPDFReader: isPDFReader,
			findReaderForItem: findReaderForItem,
			pdfAttachmentsOf: pdfAttachmentsOf,
			hasLocalPDFSync: hasLocalPDFSync,
			fieldOf: fieldOf,
			yearOf: yearOf,
			creatorsOf: creatorsOf,
			shouldShowItemMenu: shouldShowItemMenu,
			chooseCandidate: chooseCandidate,
			candidateLabel: candidateLabel,
			openSelectedItems: openSelectedItems,
			openReaderAttachment: openReaderAttachment,
			openAttachment: openAttachment,
			openPayload: openPayload,
			buildLibrarySnapshot: buildLibrarySnapshot,
			syncLibrary: syncLibrary,
			openLibraryPanel: openLibraryPanel,
			attemptOpen: attemptOpen,
			confirmRetry: confirmRetry,
			notifyNothing: notifyNothing,
			installItemMenu: installItemMenu,
			uninstallItemMenu: uninstallItemMenu,
			registerReaderHooks: registerReaderHooks,
			onRenderToolbar: onRenderToolbar,
			onCreateViewContextMenu: onCreateViewContextMenu,
			registerPreferencePane: registerPreferencePane,
			registerMenuManagerMenu: registerMenuManagerMenu,
			hasMenuManager: hasMenuManager,
			insertFTL: insertFTL,
			removeFTL: removeFTL,
			iconURI: iconURI,
			localeText: localeText
		}
	};
})();

// Zotero's bootstrapped-add-on loader looks these up by name in the bootstrap
// scope, so they have to be globals of this script, not only object members.
var startup = BabelDOCBridge.startup;
var shutdown = BabelDOCBridge.shutdown;
var install = BabelDOCBridge.install;
var uninstall = BabelDOCBridge.uninstall;
var onMainWindowLoad = BabelDOCBridge.onMainWindowLoad;
var onMainWindowUnload = BabelDOCBridge.onMainWindowUnload;
