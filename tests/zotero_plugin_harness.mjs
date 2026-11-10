#!/usr/bin/env node
/**
 * Deterministic Node harness for the BabelDOC Studio Zotero add-on.
 *
 * Zotero is not installed on the development machine, so `bootstrap.js` is
 * loaded into a `vm` context with mocked Zotero globals (Zotero, Services,
 * nsIFile, Zotero.HTTP, Zotero.ProgressWindow, Zotero.Reader, Zotero.Items,
 * Zotero.Prefs, Services.prompt, Zotero.Utilities.Internal.exec, ...) and the
 * add-on is driven exactly like Zotero would drive it.  There is no real HTTP,
 * no real process and no real file system access.
 *
 * Run:  node tests/zotero_plugin_harness.mjs
 * Exit code is non-zero when any assertion fails.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PLUGIN_DIR = path.join(ROOT, "tools", "zotero-plugin");
const BOOTSTRAP_PATH = path.join(PLUGIN_DIR, "bootstrap.js");
const BOOTSTRAP_SOURCE = fs.readFileSync(BOOTSTRAP_PATH, "utf8");
// Source without comments, for the "removed API" checks: the comments name the
// APIs on purpose, the executable code must not use them.
const BOOTSTRAP_CODE = BOOTSTRAP_SOURCE
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.replace(/(^|[^:])\/\/.*$/gm, "$1");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "manifest.json"), "utf8"));

const PLUGIN_ID = "babeldoc-studio@pidesign.local";
const APP_NAME = "BabelDOC Studio";
const ITEM_MENU_ID = "babeldoc-menuitem-open";
const ITEM_MENU_SEP_ID = "babeldoc-menuitem-open-separator";
const ROOT_URI = "file:///zotero/extensions/babeldoc-studio@pidesign.local/";
const APP_DATA = String.raw`C:\Users\Tester\AppData\Roaming`;
const LAUNCH_INFO_PATH = String.raw`C:\Users\Tester\AppData\Roaming\BabelDOC-Studio\zotero\launch-info.json`;

/* ------------------------------------------------------------------------- */
/* Generic helpers                                                           */
/* ------------------------------------------------------------------------- */

const win32 = path.win32;

function normPath(value) {
	return win32.normalize(String(value)).toLowerCase();
}

function winJoin(...parts) {
	return win32.join(...parts);
}

/** Let every already-resolved promise / setImmediate continuation run. */
async function settle(rounds = 250) {
	for (let index = 0; index < rounds; index++) {
		await Promise.resolve();
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function lastProgressWindow(world) {
	return world.progressWindows[world.progressWindows.length - 1] || null;
}

function progressText(progress) {
	if (!progress) return "";
	return [progress.headline, ...progress.lines.map((line) => line.text), ...progress.descriptions].join(" | ");
}

function menuItems(world) {
	return world.mainWindow.document.getElementsByTagName("menuitem")
		.filter((element) => element.id === ITEM_MENU_ID);
}

function parsePrefDefaults() {
	const text = fs.readFileSync(path.join(PLUGIN_DIR, "prefs.js"), "utf8");
	const defaults = new Map();
	const pattern = /^\s*pref\(\s*"([^"]+)"\s*,\s*(.+?)\s*\);\s*$/gm;
	let match;
	while ((match = pattern.exec(text))) {
		const raw = match[2].trim();
		let value;
		if (raw === "true") value = true;
		else if (raw === "false") value = false;
		else if (/^-?\d+$/.test(raw)) value = Number(raw);
		else if (raw.startsWith('"') && raw.endsWith('"')) value = raw.slice(1, -1);
		else continue;
		defaults.set(match[1], value);
	}
	return defaults;
}

const PREF_DEFAULTS = parsePrefDefaults();

/* ------------------------------------------------------------------------- */
/* Minimal DOM (only what bootstrap.js touches)                              */
/* ------------------------------------------------------------------------- */

class MockClassList {
	constructor() {
		this._names = new Set();
	}
	add(...names) {
		for (const name of names) this._names.add(String(name));
	}
	remove(...names) {
		for (const name of names) this._names.delete(String(name));
	}
	contains(name) {
		return this._names.has(String(name));
	}
	get value() {
		return [...this._names].join(" ");
	}
}

function matchesSelector(element, selector) {
	const text = String(selector).trim();
	let match = /^#([\w@.-]+)$/.exec(text);
	if (match) return element.id === match[1];
	match = /^([a-zA-Z]+)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(text);
	if (match) {
		const [, tag, attribute, value] = match;
		if (tag && element.tagName !== tag.toUpperCase()) return false;
		const actual = element.getAttribute(attribute);
		if (actual === null) return false;
		return value === undefined ? true : actual === value;
	}
	match = /^([a-zA-Z]+)$/.exec(text);
	if (match) return element.tagName === match[1].toUpperCase();
	return false;
}

class MockElement {
	constructor(tagName, ownerDocument) {
		this.tagName = String(tagName).toUpperCase();
		this.ownerDocument = ownerDocument;
		this.children = [];
		this.parentNode = null;
		this.classList = new MockClassList();
		this.attributes = new Map();
		this.style = {};
		this.hidden = false;
		this.textContent = "";
		this.title = "";
		this.checked = false;
		this._id = "";
		this._listeners = new Map();
	}
	set id(value) {
		this._id = String(value);
		if (this.ownerDocument) this.ownerDocument.registerId(this._id, this);
	}
	get id() {
		return this._id;
	}
	setAttribute(name, value) {
		const key = String(name).toLowerCase();
		this.attributes.set(key, String(value));
		if (key === "id") this.id = String(value);
	}
	getAttribute(name) {
		const value = this.attributes.get(String(name).toLowerCase());
		return value === undefined ? null : value;
	}
	hasAttribute(name) {
		return this.attributes.has(String(name).toLowerCase());
	}
	appendChild(node) {
		if (node.parentNode) node.parentNode.removeChildNode(node);
		node.parentNode = this;
		this.children.push(node);
		return node;
	}
	insertBefore(node, reference) {
		if (!reference || !this.children.includes(reference)) return this.appendChild(node);
		if (node.parentNode) node.parentNode.removeChildNode(node);
		node.parentNode = this;
		this.children.splice(this.children.indexOf(reference), 0, node);
		return node;
	}
	append(...nodes) {
		for (const node of nodes) this.appendChild(node);
	}
	removeChildNode(node) {
		const index = this.children.indexOf(node);
		if (index >= 0) this.children.splice(index, 1);
	}
	remove() {
		if (this.parentNode) {
			this.parentNode.removeChildNode(this);
			this.parentNode = null;
		}
		if (this.ownerDocument) {
			this.ownerDocument.unregisterId(this.id, this);
			this.ownerDocument.untrack(this);
		}
	}
	addEventListener(type, handler) {
		const key = String(type);
		if (!this._listeners.has(key)) this._listeners.set(key, []);
		this._listeners.get(key).push(handler);
	}
	removeEventListener(type, handler) {
		const list = this._listeners.get(String(type)) || [];
		const index = list.indexOf(handler);
		if (index >= 0) list.splice(index, 1);
	}
	listenerCount(type) {
		return (this._listeners.get(String(type)) || []).length;
	}
	dispatchEvent(type) {
		const event = { type: String(type), target: this, currentTarget: this, preventDefault() {} };
		for (const handler of [...(this._listeners.get(String(type)) || [])]) handler(event);
		return true;
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
	querySelectorAll(selector) {
		return this.ownerDocument._elements.filter((element) => matchesSelector(element, selector));
	}
	get ownerGlobal() {
		return this.ownerDocument ? this.ownerDocument.defaultView : null;
	}
}

class MockDocument {
	constructor() {
		this._byId = new Map();
		this._elements = [];
		this.documentElement = new MockElement("window", this);
		this.defaultView = null;
		this.l10nCalls = [];
		this.l10n = {
			setAttributes: (element, id) => {
				this.l10nCalls.push({ element, id });
				element.setAttribute("data-l10n-id", id);
			}
		};
	}
	_track(element) {
		this._elements.push(element);
		return element;
	}
	registerId(id, element) {
		if (id) this._byId.set(String(id), element);
	}
	unregisterId(id, element) {
		if (id && this._byId.get(String(id)) === element) this._byId.delete(String(id));
	}
	untrack(element) {
		const index = this._elements.indexOf(element);
		if (index >= 0) this._elements.splice(index, 1);
	}
	getElementById(id) {
		return this._byId.get(String(id)) || null;
	}
	createElement(tagName) {
		return this._track(new MockElement(tagName, this));
	}
	createXULElement(tagName) {
		return this.createElement(tagName);
	}
	getElementsByTagName(tagName) {
		const upper = String(tagName).toUpperCase();
		return this._elements.filter((element) => element.tagName === upper);
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
	querySelectorAll(selector) {
		return this._elements.filter((element) => matchesSelector(element, selector));
	}
}

function makeMainWindow(world) {
	const doc = new MockDocument();
	const win = {
		document: doc,
		MozXULElement: {
			insertFTLIfNeeded(href) {
				world.ftlInserted.push(String(href));
				const link = doc.createElement("link");
				link.setAttribute("rel", "localization");
				link.setAttribute("href", String(href));
				doc.documentElement.appendChild(link);
			}
		},
		Zotero_Tabs: {
			selectedID: "zotero-pane",
			selectedType: "library",
			getTabIDByItemID(itemID) {
				return world.tabByItem.get(itemID) || "";
			}
		},
		ZoteroPane: {
			getSelectedItems() {
				return world.selection;
			}
		}
	};
	doc.defaultView = win;
	const tabsToolbar = doc.createXULElement("toolbar");
	tabsToolbar.id = "zotero-tabs-toolbar";
	doc.documentElement.appendChild(tabsToolbar);
	const itemsToolbar = doc.createXULElement("hbox");
	itemsToolbar.id = "zotero-items-toolbar";
	doc.documentElement.appendChild(itemsToolbar);
	const spacer = doc.createXULElement("spacer");
	spacer.setAttribute("flex", "1");
	itemsToolbar.appendChild(spacer);
	const popup = doc.createXULElement("menupopup");
	popup.id = "zotero-itemmenu";
	doc.documentElement.appendChild(popup);
	return win;
}

function makeAuxDocument(world, defaultView) {
	const doc = new MockDocument();
	doc.defaultView = defaultView || world.mainWindow;
	return doc;
}

/* ------------------------------------------------------------------------- */
/* Progress window                                                           */
/* ------------------------------------------------------------------------- */

function makeProgressWindowClass(world) {
	class ItemProgress {
		constructor(icon, text) {
			this.icon = icon;
			this.text = String(text || "");
			this.progress = 0;
			this.error = false;
			this.history = [];
		}
		setText(text) {
			this.text = String(text);
			this.history.push(this.text);
		}
		setProgress(value) {
			this.progress = value;
		}
		setError() {
			this.error = true;
		}
	}

	return class ProgressWindow {
		constructor(options) {
			this.options = options;
			this.headline = "";
			this.lines = [];
			this.descriptions = [];
			this.shown = false;
			this.closed = false;
			this.closeTimer = null;
			world.progressWindows.push(this);
			// `new progress.ItemProgress(...)` must return a line *and* show up in
			// this.lines, exactly like Zotero's ProgressWindow.ItemProgress(parent).
			const lines = this.lines;
			this.ItemProgress = class extends ItemProgress {
				constructor(icon, text) {
					super(icon, text);
					lines.push(this);
				}
			};
		}
		changeHeadline(text) {
			this.headline = String(text);
		}
		addDescription(text) {
			this.descriptions.push(String(text));
		}
		show() {
			this.shown = true;
		}
		startCloseTimer(milliseconds) {
			this.closeTimer = milliseconds;
		}
		close() {
			this.closed = true;
		}
	};
}

/* ------------------------------------------------------------------------- */
/* Zotero / Services mocks                                                   */
/* ------------------------------------------------------------------------- */

function makeNsIFile(world, rawPath) {
	const file = {
		path: String(rawPath),
		exists() {
			return world.files.has(normPath(file.path)) || world.dirs.has(normPath(file.path));
		},
		isFile() {
			return world.files.has(normPath(file.path));
		},
		isDirectory() {
			return world.dirs.has(normPath(file.path));
		},
		append(part) {
			file.path = winJoin(file.path, String(part));
		},
		clone() {
			return makeNsIFile(world, file.path);
		}
	};
	return file;
}

function makePrompt(world) {
	return {
		BUTTON_POS_0: 1,
		BUTTON_POS_1: 256,
		BUTTON_POS_2: 65536,
		BUTTON_TITLE_OK: 1,
		BUTTON_TITLE_CANCEL: 2,
		BUTTON_TITLE_IS_STRING: 127,
		select(parent, title, text, list, out) {
			world.selectCalls.push({ parent, title, text, list: Array.from(list || []) });
			const response = world.selectResponse;
			if (response === "throw") throw new Error("nsIPromptService.select is unavailable");
			if (response === null || response === undefined || response === "cancel") return false;
			if (out && typeof out === "object") out.value = response;
			return true;
		},
		confirmEx(parent, title, text, flags, button0, button1, button2, checkMessage, checkState) {
			world.confirmCalls.push({ parent, title, text, flags, button0, checkMessage });
			if (typeof world.onConfirm === "function") world.onConfirm();
			return typeof world.confirmResponse === "number" ? world.confirmResponse : 1;
		},
		alert(parent, title, text) {
			world.alerts.push({ title, text });
		}
	};
}

function makeReaderApi(world) {
	return {
		listeners: [],
		registerEventListener(type, handler, pluginID) {
			this.listeners.push({ type, handler, pluginID });
		},
		// Mirrors Zotero 7.0.32, whose implementation keeps the matching
		// listener instead of removing it.  The add-on must never call this;
		// Zotero removes listeners by pluginID through its shutdown observer.
		unregisterEventListener(type, handler) {
			this.listeners = this.listeners.filter((x) => x.type === type && x.handler === handler);
			world.unregisterEventListenerCalls.push({ type, handler });
		},
		_unregisterEventListenerByPluginID(pluginID) {
			const before = this.listeners.length;
			this.listeners = this.listeners.filter((listener) => listener.pluginID !== pluginID);
			return before - this.listeners.length;
		},
		getByTabID(tabID) {
			return world.readers.get(String(tabID)) || null;
		},
		_dispatch(type, event) {
			for (const listener of [...this.listeners]) {
				if (listener.type === type) listener.handler(event);
			}
		}
	};
}

function makeWorld(options = {}) {
	const world = {
		options,
		logs: [],
		ftlInserted: [],
		httpCalls: [],
		healthCalls: [],
		postCalls: [],
		execCalls: [],
		selectCalls: [],
		confirmCalls: [],
		alerts: [],
		progressWindows: [],
		paneRegistrations: [],
		paneUnregistrations: [],
		unregisterEventListenerCalls: [],
		launches: [],
		prefs: new Map(),
		prefDefaults: new Map(PREF_DEFAULTS),
		files: new Map(),
		dirs: new Set(),
		items: new Map(),
		readers: new Map(),
		tabByItem: new Map(),
		lastPage: new Map(),
		selection: [],
		appData: APP_DATA,
		serverUp: true,
		serverPort: 8765,
		locale: "zh-CN",
		isWin: true,
		selectResponse: "cancel",
		confirmResponse: 1,
		onConfirm: null,
		execHandler: null,
		healthHandler: null,
		postHandler: null,
		httpHandler: null,
		menuManager: null,
		mainWindow: null
	};
	world.dirs.add(normPath(world.appData));
	world.prompt = makePrompt(world);
	world.readerApi = makeReaderApi(world);

	const Zotero = {
		locale: world.locale,
		isWin: world.isWin,
		debug(message) {
			world.logs.push(String(message));
		},
		logError(error) {
			world.logs.push("ERROR " + String(error && error.message ? error.message : error));
		},
		Prefs: {
			// Faithful to Zotero 7's prefs.js: without global=true the key is
			// prefixed with "extensions.zotero.".  Plugin prefs (extensions.babeldoc.*)
			// only work with global=true, which is exactly what this checks.
			get(key, global) {
				const full = global ? String(key) : "extensions.zotero." + String(key);
				if (world.prefs.has(full)) return world.prefs.get(full);
				if (world.prefDefaults.has(full)) return world.prefDefaults.get(full);
				return undefined;
			},
			set(key, value, global) {
				const full = global ? String(key) : "extensions.zotero." + String(key);
				world.prefs.set(full, value);
			},
			registerObserver() {
				return "pref-observer";
			},
			unregisterObserver() {}
		},
		Promise: {
			delay() {
				return Promise.resolve();
			}
		},
		HTTP: {
			async request(method, url, requestOptions = {}) {
				const record = {
					method: String(method),
					url: String(url),
					options: { ...requestOptions },
					body: requestOptions.body
				};
				world.httpCalls.push(record);
				const handler = world.httpHandler;
				const result = handler
					? await handler(record, world)
					: await defaultHttpHandler(record, world);
				if (!result) return { status: 200, responseText: "", response: "" };
				if (result.error) {
					throw result.error instanceof Error ? result.error : new Error(String(result.error));
				}
				const text = result.responseText === undefined ? "" : String(result.responseText);
				return { status: result.status === undefined ? 200 : result.status, responseText: text, response: text };
			}
		},
		File: {
			pathToFile(rawPath) {
				return makeNsIFile(world, rawPath);
			},
			async getContentsAsync(rawPath) {
				const key = normPath(rawPath);
				if (!world.files.has(key)) throw new Error("NS_ERROR_FILE_NOT_FOUND: " + rawPath);
				return world.files.get(key);
			}
		},
		Items: {
			get(id) {
				return world.items.get(id) || undefined;
			},
			exists(id) {
				return world.items.has(id);
			}
		},
		ProgressWindow: makeProgressWindowClass(world),
		Reader: world.readerApi,
		Utilities: {
			Internal: {
				exec(command, args) {
					const record = {
						command: String(command),
						args: Array.isArray(args) ? args.slice() : []
					};
					world.execCalls.push(record);
					const outcome = world.execHandler ? world.execHandler(record, world) : null;
					if (outcome && outcome.throws) {
						throw new Error(outcome.error || "not an executable");
					}
					// A real long-lived process only settles when it exits: never
					// resolving here proves the add-on does not await exec().
					return new Promise(() => {});
				}
			}
		},
		PreferencePanes: {
			register(paneOptions) {
				world.paneRegistrations.push(paneOptions);
				return Promise.resolve("pane-1");
			},
			unregister(paneID) {
				world.paneUnregistrations.push(paneID);
			}
		},
		getMainWindow() {
			return world.mainWindow;
		},
		getMainWindows() {
			return world.mainWindow ? [world.mainWindow] : [];
		},
		getActiveZoteroPane() {
			return world.mainWindow ? world.mainWindow.ZoteroPane : null;
		},
		launchURL(url) {
			world.launches.push(String(url));
		}
	};
	const Services = {
		dirsvc: {
			get(key) {
				if (String(key) === "AppData" && world.appData) return makeNsIFile(world, world.appData);
				throw new Error("directory service unavailable: " + key);
			}
		},
		prompt: world.prompt,
		env: {
			get(name) {
				return world.env && world.env[name] !== undefined ? world.env[name] : undefined;
			}
		},
		appinfo: { OS: world.isWin ? "WINNT" : "Darwin" },
		locale: { appLocaleAsBCP47: world.locale }
	};

	world.Zotero = Zotero;
	world.Services = Services;
	world.globals = {
		Zotero,
		Services,
		Ci: { nsIFile: function nsIFile() {} },
		Cc: {},
		Components: {},
		XPCOMUtils: { generateQI() {} },
		// Present for API-completeness of the mocked environment.  bootstrap.js
		// must not touch them: they are not guaranteed in the bootstrap scope
		// (docs/zotero-api-notes.md §13 row 11); nsIFile is used instead.
		IOUtils: {
			exists: async () => false,
			readUTF8: async () => "",
			readJSON: async () => null,
			writeJSON: async () => {},
			writeUTF8: async () => {}
		},
		PathUtils: {
			join: (...parts) => win32.join(...parts),
			parent: (value) => win32.dirname(String(value)),
			filename: (value) => win32.basename(String(value))
		},
		setTimeout,
		clearTimeout,
		console: { log() {}, warn() {}, error() {} }
	};
	return world;
}

function healthOK() {
	return {
		status: 200,
		responseText: JSON.stringify({
			ok: true,
			app: APP_NAME,
			version: "9.9.9",
			features: ["zotero", "zotero-library", "zotero-translate"],
			build: "harness"
		})
	};
}

function downloadError(code, message) {
	const statusByCode = { missing_path: 400, file_missing: 404, not_pdf: 415 };
	return {
		status: statusByCode[code] || 400,
		responseText: JSON.stringify({
			ok: false,
			error: message,
			code,
			retryable: code !== "not_pdf",
			detail: code === "file_missing" ? String.raw`C:\Zotero\storage\ATTACH01\paper.pdf` : ""
		})
	};
}

async function defaultHttpHandler(record, world) {
	const url = new URL(record.url);
	if (record.method === "GET" && url.pathname === "/api/health") {
		world.healthCalls.push(record.url);
		const port = Number(url.port || 80);
		if (world.healthHandler) {
			const answer = await world.healthHandler(
				{ port, call: world.healthCalls.length, url: record.url },
				world
			);
			if (answer === "up") return healthOK();
			if (answer === "down") return { error: "NetworkError: connection refused" };
			if (answer) return answer;
		}
		if (world.serverUp && port === world.serverPort) return healthOK();
		return { error: "NetworkError: connection refused" };
	}
	if (record.method === "POST" && url.pathname === "/api/zotero/open") {
		let body = null;
		try {
			body = record.body ? JSON.parse(record.body) : null;
		}
		catch (error) {
			body = null;
		}
		const entry = { url: record.url, body, options: record.options };
		world.postCalls.push(entry);
		if (world.postHandler) {
			const answer = await world.postHandler(
				{ call: world.postCalls.length, body, entry },
				world
			);
			if (answer) return answer;
		}
		return {
			status: 200,
			responseText: JSON.stringify({
				ok: true,
				link_id: "L1",
				path: String.raw`C:\Users\Tester\AppData\Roaming\BabelDOC-Studio\zotero\imports\L1\paper.pdf`,
				page: body && Number.isInteger(body.page) ? body.page : 1,
				pages: 20,
				variant: "original",
				title: (body && body.title) || "Paper",
				doi: (body && body.doi) || "",
				imported: true,
				source: "reader",
				message: "首次接入文件，已建立与 Zotero 文献的关联"
			})
		};
	}
	return {
		status: 404,
		responseText: JSON.stringify({ ok: false, error: "not found", code: "missing_path", retryable: false })
	};
}

/* ------------------------------------------------------------------------- */
/* Items / readers                                                           */
/* ------------------------------------------------------------------------- */

function addRegularItem(world, spec) {
	const item = {
		id: spec.id,
		key: spec.key || ("ITEM" + spec.id),
		libraryID: spec.libraryID === undefined ? 1 : spec.libraryID,
		isAttachment() {
			return false;
		},
		isRegularItem() {
			return true;
		},
		getAttachments() {
			return (spec.attachments || []).slice();
		},
		getField(name) {
			const key = String(name);
			if (key === "title") return spec.title || "";
			if (key === "DOI") return spec.doi || "";
			if (key === "year") return spec.year || "";
			if (key === "date") return spec.date || (spec.year ? spec.year + "-01-01" : "");
			return "";
		},
		getCreators() {
			return (spec.creators || []).map((creator) => ({
				firstName: creator.firstName || "",
				lastName: creator.lastName || "",
				name: creator.name || ""
			}));
		}
	};
	world.items.set(item.id, item);
	return item;
}

function addAttachment(world, spec) {
	const item = {
		id: spec.id,
		key: spec.key || ("ATT" + spec.id),
		libraryID: spec.libraryID === undefined ? 1 : spec.libraryID,
		parentItem: spec.parentID ? (world.items.get(spec.parentID) || false) : false,
		getFilePathAsyncCalls: 0,
		isAttachment() {
			return true;
		},
		isRegularItem() {
			return false;
		},
		isFileAttachment() {
			return spec.pdf !== false;
		},
		isPDFAttachment() {
			return spec.pdf !== false;
		},
		getFilePath() {
			return spec.path || false;
		},
		async getFilePathAsync() {
			item.getFilePathAsyncCalls++;
			return spec.path || false;
		},
		getField(name) {
			const key = String(name);
			if (key === "title") return spec.title || "";
			if (key === "DOI") return spec.doi || "";
			return "";
		},
		getAttachmentLastPageIndex() {
			if (spec.lastPageThrows) throw new Error("last page index unavailable");
			if (world.lastPage.has(item.id)) return world.lastPage.get(item.id);
			return false;
		}
	};
	if (spec.parentID && !item.parentItem) {
		throw new Error("addAttachment: parent item " + spec.parentID + " does not exist");
	}
	world.items.set(item.id, item);
	return item;
}

function addReader(world, spec) {
	const tabID = spec.tabID || "reader-tab-1";
	const mode = spec.mode || "internal";
	const target = {
		itemID: spec.itemID,
		tabID,
		type: spec.type || "pdf"
	};
	if (mode === "internal") {
		// ReaderInstance is a Proxy: unknown props are forwarded to _internalReader.
		target._internalReader = { _state: { pageIndex: spec.pageIndex } };
	}
	else if (mode === "live") {
		target._state = { pageIndex: spec.pageIndex };
	}
	else if (mode === "getState") {
		target._getState = async () => ({ pageIndex: spec.pageIndex });
	}
	else if (mode === "lastPage") {
		world.lastPage.set(spec.itemID, spec.pageIndex);
	}
	else if (mode === "throwing") {
		Object.defineProperty(target, "_state", {
			get() {
				throw new Error("reader state unavailable");
			}
		});
		target._getState = async () => {
			throw new Error("persisted reader state unavailable");
		};
	}
	const reader = new Proxy(target, {
		get(object, property) {
			if (property in object) return object[property];
			if (object._internalReader && property in object._internalReader) {
				return object._internalReader[property];
			}
			return undefined;
		}
	});
	world.readers.set(tabID, reader);
	world.tabByItem.set(spec.itemID, tabID);
	return reader;
}

/* ------------------------------------------------------------------------- */
/* World builders used by the tests                                          */
/* ------------------------------------------------------------------------- */

function paperWorld(options = {}) {
	const world = makeWorld(options);
	world.mainWindow = makeMainWindow(world);
	const item = addRegularItem(world, {
		id: 1,
		key: "ITEM0001",
		title: "面向家庭社交机器人的空闲行为设计",
		doi: "10.1145/1234567.7654321",
		year: "2026",
		creators: [
			{ firstName: "John", lastName: "Smith" },
			{ firstName: "小明", lastName: "王" }
		],
		attachments: [2]
	});
	const attachment = addAttachment(world, {
		id: 2,
		key: "ATTACH01",
		parentID: 1,
		path: String.raw`C:\Zotero\storage\ATTACH01\paper.pdf`,
		title: "paper.pdf",
		pdf: options.pdf !== false,
		lastPageThrows: !!options.lastPageThrows
	});
	world.files.set(normPath(attachment.getFilePath()), "%PDF-1.7");
	world.selection = [item];
	return { world, item, attachment };
}

function multiPdfWorld(selectResponse) {
	const world = makeWorld();
	world.mainWindow = makeMainWindow(world);
	const item = addRegularItem(world, {
		id: 1,
		key: "ITEM0001",
		title: "多附件文献",
		attachments: [11, 12, 13]
	});
	const paths = [
		String.raw`C:\Zotero\storage\ATT11\first.pdf`,
		String.raw`C:\Zotero\storage\ATT12\second.pdf`,
		String.raw`C:\Zotero\storage\ATT13\third.pdf`
	];
	paths.forEach((pdfPath, index) => {
		addAttachment(world, {
			id: 11 + index,
			key: "ATT1" + (index + 1),
			parentID: 1,
			path: pdfPath,
			title: pdfPath.split("\\").pop()
		});
	});
	world.selection = [item];
	world.selectResponse = selectResponse;
	return { world, item, paths };
}

const LAUNCH_INFO = {
	app: APP_NAME,
	version: "1.2.3",
	port: 8765,
	url: "http://127.0.0.1:8765",
	base_dir: String.raw`E:\Apps\BabelDOC`,
	python: String.raw`E:\Apps\BabelDOC\python.exe`,
	pythonw: String.raw`E:\Apps\BabelDOC\pythonw.exe`,
	script: String.raw`E:\Apps\BabelDOC\app.py`,
	start_bat: String.raw`E:\Apps\BabelDOC\Start.bat`,
	launcher: String.raw`E:\Apps\BabelDOC\BabelDOC Studio.exe`,
	started: 1730000000
};

function launchWorld(options = {}) {
	const { world, item, attachment } = paperWorld();
	world.serverUp = options.serverUp === undefined ? false : options.serverUp;
	if (options.autoLaunch === false) {
		world.prefs.set("extensions.babeldoc.autoLaunch", false);
	}
	if (options.info !== null) {
		world.files.set(
			normPath(options.launchInfoPath || LAUNCH_INFO_PATH),
			JSON.stringify(options.info || LAUNCH_INFO)
		);
	}
	return { world, item, attachment };
}

function loadPlugin(world) {
	const context = vm.createContext(world.globals);
	vm.runInContext(BOOTSTRAP_SOURCE, context, { filename: "bootstrap.js" });
	assert.ok(context.BabelDOCBridge, "bootstrap.js must define the BabelDOCBridge hook");
	return {
		context,
		bridge: context.BabelDOCBridge,
		internals: context.BabelDOCBridge.internals,
		startup() {
			context.startup({ id: PLUGIN_ID, version: MANIFEST.version, rootURI: ROOT_URI }, "ADDON_ENABLE");
			return this;
		},
		shutdown() {
			context.shutdown({ id: PLUGIN_ID, version: MANIFEST.version, rootURI: ROOT_URI }, "ADDON_DISABLE");
			return this;
		}
	};
}

/* ------------------------------------------------------------------------- */
/* Test registry                                                             */
/* ------------------------------------------------------------------------- */

const tests = [];

function test(name, fn) {
	tests.push({ name, fn });
}

/* ------------------------------------------------------------------------- */
/* Tests: manifest + bootstrap contract                                      */
/* ------------------------------------------------------------------------- */

test("manifest includes the mandatory update manifest for Zotero 10", () => {
	assert.equal(MANIFEST.manifest_version, 2);
	assert.equal(MANIFEST.version, "1.0.6");
	assert.equal(MANIFEST.applications.zotero.id, PLUGIN_ID);
	assert.equal(MANIFEST.applications.zotero.strict_min_version, "7.0");
	assert.equal(MANIFEST.applications.zotero.strict_max_version, "10.*");
	assert.ok(MANIFEST.applications.zotero.update_url.startsWith("https://"));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "updates.json"), "utf8")), {
		addons: { [PLUGIN_ID]: { updates: [] } }
	});
	assert.equal(MANIFEST.icons["48"], "icons/icon-48.png");
	assert.equal(MANIFEST.icons["96"], "icons/icon-96.png");
	for (const relative of Object.values(MANIFEST.icons)) {
		assert.ok(fs.existsSync(path.join(PLUGIN_DIR, relative)), "missing icon " + relative);
	}
});

test("bootstrap exports the six lifecycle functions and avoids Zotero-8-removed APIs", () => {
	const world = makeWorld();
	const { context } = loadPlugin(world);
	for (const name of [
		"startup",
		"shutdown",
		"install",
		"uninstall",
		"onMainWindowLoad",
		"onMainWindowUnload"
	]) {
		assert.equal(typeof context[name], "function", name + " must be a bootstrap-scope function");
	}
	assert.ok(!/\bZotero\.spawn\s*\(/.test(BOOTSTRAP_CODE), "must not use Zotero.spawn");
	assert.ok(!/hiddenDOMWindow/.test(BOOTSTRAP_CODE), "must not use hiddenDOMWindow");
	assert.ok(!/\bIOUtils\./.test(BOOTSTRAP_CODE),
		"bootstrap scope is not guaranteed to expose IOUtils; use nsIFile/Zotero.File");
	assert.ok(!/\bPathUtils\./.test(BOOTSTRAP_CODE),
		"bootstrap scope is not guaranteed to expose PathUtils; use nsIFile");
	assert.ok(!/unregisterEventListener\s*\(/.test(BOOTSTRAP_CODE),
		"Zotero 7.0.x unregisterEventListener has a keep-instead-of-drop bug; rely on pluginID cleanup");
	assert.ok(!/open_window/.test(BOOTSTRAP_CODE), "open_window must not be sent (app defaults to true)");
	assert.ok(!/\.each\s*\(/.test(BOOTSTRAP_CODE), "bluebird instance methods must not be used");
});

/* ------------------------------------------------------------------------- */
/* Tests: lifecycle, item menu, visibility                                   */
/* ------------------------------------------------------------------------- */

test("startup installs menu/reader/prefs-pane once; shutdown cleans everything; re-enable does not duplicate", async () => {
	const { world, item } = paperWorld();
	const loaded = loadPlugin(world).startup();
	const doc = world.mainWindow.document;
	const popup = doc.getElementById("zotero-itemmenu");

	// Preference pane
	assert.equal(world.paneRegistrations.length, 1, "preferences pane registered once");
	const pane = world.paneRegistrations[0];
	assert.equal(pane.pluginID, PLUGIN_ID);
	assert.equal(pane.src, "prefs.xhtml");
	assert.deepEqual([...pane.scripts], ["prefsPane.js"]);
	assert.equal(pane.image, "icons/icon-20.png");
	await settle(4);
	assert.equal(loaded.bridge.state.prefPaneID, "pane-1");

	// Reader hooks carry the pluginID (that is how Zotero cleans them up)
	assert.equal(world.readerApi.listeners.length, 2);
	const listenerTypes = world.readerApi.listeners.map((listener) => listener.type).sort();
	assert.deepEqual(listenerTypes, ["createViewContextMenu", "renderToolbar"]);
	for (const listener of world.readerApi.listeners) {
		assert.equal(listener.pluginID, PLUGIN_ID, "reader listeners must be registered with the pluginID");
	}
	// The plugin's own shutdown must not use the buggy per-listener API
	assert.equal(world.unregisterEventListenerCalls.length, 0);

	// Item menu: exactly one separator + one item, labelled through Fluent
	assert.equal(menuItems(world).length, 1);
	assert.ok(doc.getElementById(ITEM_MENU_SEP_ID), "separator installed");
	const menuItem = doc.getElementById(ITEM_MENU_ID);
	assert.equal(menuItem.getAttribute("data-l10n-id"), "babeldoc-menu-open");
	assert.equal(menuItem.getAttribute("label"), "在 ReadPI 中阅读");
	assert.ok(menuItem.getAttribute("image").endsWith("icons/icon-16.svg"));
	assert.ok(world.ftlInserted.includes("babeldoc.ftl"), "FTL registered in the window");

	// Idempotency: a second onMainWindowLoad must not add another item
	loaded.context.onMainWindowLoad({ window: world.mainWindow });
	assert.equal(menuItems(world).length, 1);
	assert.equal(popup.listenerCount("popupshowing"), 1);

	// Visibility: selected paper with a local PDF -> visible
	world.selection = [item];
	popup.dispatchEvent("popupshowing");
	assert.equal(menuItem.hidden, false);
	assert.equal(doc.getElementById(ITEM_MENU_SEP_ID).hidden, false);

	// ... no selection / no local PDF -> hidden
	world.selection = [];
	popup.dispatchEvent("popupshowing");
	assert.equal(menuItem.hidden, true);
	assert.equal(doc.getElementById(ITEM_MENU_SEP_ID).hidden, true);

	// ... but a PDF reader tab always gets the entry, even with no selection
	const reader = addReader(world, { tabID: "reader-tab-1", itemID: 2, pageIndex: 1 });
	world.mainWindow.Zotero_Tabs.selectedType = "reader";
	world.mainWindow.Zotero_Tabs.selectedID = reader.tabID;
	popup.dispatchEvent("popupshowing");
	assert.equal(menuItem.hidden, false);

	// An EPUB/snapshot reader has no PDF to hand over: normal selection rules apply.
	reader.type = "epub";
	popup.dispatchEvent("popupshowing");
	assert.equal(menuItem.hidden, true);
	reader.type = "pdf";

	// Shutdown removes DOM, listeners, FTL link and window references
	loaded.shutdown();
	assert.equal(doc.getElementById(ITEM_MENU_ID), null, "menu item removed");
	assert.equal(doc.getElementById(ITEM_MENU_SEP_ID), null, "separator removed");
	assert.equal(popup.listenerCount("popupshowing"), 0, "popupshowing listener removed");
	assert.equal(doc.getElementsByTagName("link").filter((link) => link.getAttribute("href") === "babeldoc.ftl").length, 0,
		"FTL link removed");
	assert.equal(loaded.bridge.state.menus.size, 0, "window references dropped");

	// Re-enable in the same scope: still exactly one menu item
	loaded.startup();
	assert.equal(menuItems(world).length, 1, "no duplicate menu item after disable/enable");
	assert.equal(popup.listenerCount("popupshowing"), 1);
});

test("item-menu POST carries 1-based page and metadata; open_window is never sent", async () => {
	const { world, item, attachment } = paperWorld();
	// The same PDF has a (background) reader tab: its page must travel with the request.
	addReader(world, { tabID: "reader-tab-1", itemID: 2, pageIndex: 2, mode: "internal" });
	loadPlugin(world).startup();

	const menuItem = world.mainWindow.document.getElementById(ITEM_MENU_ID);
	menuItem.dispatchEvent("command");
	await settle();

	assert.equal(world.postCalls.length, 1, "exactly one POST");
	assert.equal(world.postCalls[0].url, "http://127.0.0.1:8765/api/zotero/open");
	const body = world.postCalls[0].body;
	assert.equal(body.path, attachment.getFilePath());
	assert.equal(body.page, 3, "pageIndex 2 must be sent as page 3");
	assert.equal(body.library_id, "1");
	assert.equal(body.item_key, "ITEM0001");
	assert.equal(body.attachment_key, "ATTACH01");
	assert.equal(body.title, "面向家庭社交机器人的空闲行为设计");
	assert.equal(body.doi, "10.1145/1234567.7654321");
	assert.equal(body.creators, "John Smith, 小明 王");
	assert.equal(body.year, "2026");
	assert.ok(!("open_window" in body), "open_window must not be set");
	assert.ok(!("page_total" in body), "page_total is derived server-side");

	// Request options: fast failure, 4xx body readable, JSON content type
	const postRecord = world.httpCalls.find((call) => call.method === "POST");
	assert.ok(postRecord, "POST was issued through Zotero.HTTP");
	assert.equal(postRecord.options.errorDelayMax, 0);
	assert.equal(postRecord.options.successCodes, false);
	assert.equal(postRecord.options.headers["Content-Type"], "application/json");
	assert.equal(postRecord.options.timeout, 20000);
	const healthRecord = world.httpCalls.find((call) => call.url.endsWith("/api/health"));
	assert.ok(healthRecord, "health probed before POST");
	assert.deepEqual([...healthRecord.options.successCodes], [200]);
	assert.equal(healthRecord.options.errorDelayMax, 0);
	assert.ok(world.httpCalls.indexOf(healthRecord) < world.httpCalls.indexOf(postRecord), "health before POST");

	// Success feedback closes itself after ~3 s
	const progress = lastProgressWindow(world);
	assert.ok(progress && progress.shown);
	assert.equal(progress.headline, "ReadPI");
	assert.equal(progress.closeTimer, 3000);
	const line = progress.lines[progress.lines.length - 1];
	assert.equal(line.progress, 100);
	assert.match(line.text, /已在 ReadPI 中打开（第 3 页）/);
	assert.ok(progress.descriptions.includes("首次接入文件，已建立与 Zotero 文献的关联"));
});

test("item-menu without a reader tab lets the app resume (no page field); passPage=false wins over a reader", async () => {
	{
		const { world } = paperWorld();
		loadPlugin(world).startup();
		world.mainWindow.document.getElementById(ITEM_MENU_ID).dispatchEvent("command");
		await settle();
		assert.equal(world.postCalls.length, 1);
		assert.ok(!("page" in world.postCalls[0].body), "resume mode must not pass a page");
	}
	{
		const { world } = paperWorld();
		world.prefs.set("extensions.babeldoc.passPage", false);
		addReader(world, { tabID: "reader-tab-1", itemID: 2, pageIndex: 9, mode: "internal" });
		loadPlugin(world).startup();
		world.mainWindow.document.getElementById(ITEM_MENU_ID).dispatchEvent("command");
		await settle();
		assert.equal(world.postCalls.length, 1);
		assert.ok(!("page" in world.postCalls[0].body), "passPage=false must not pass a page");
	}
});

test("item menu reports missing local PDFs instead of posting", async () => {
	const { world, item } = paperWorld({ pdf: false });
	const loaded = loadPlugin(world).startup();
	const menuItem = world.mainWindow.document.getElementById(ITEM_MENU_ID);
	world.selection = [item];
	world.mainWindow.document.getElementById("zotero-itemmenu").dispatchEvent("popupshowing");
	assert.equal(menuItem.hidden, true, "no local PDF -> hidden");
	const result = await loaded.internals.openSelectedItems(world.mainWindow);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "no_local_pdf");
	assert.equal(world.postCalls.length, 0);
	const progress = lastProgressWindow(world);
	assert.ok(progress, "a progress window explains the problem");
	assert.match(progressText(progress), /没有 PDF 附件/);
});

/* ------------------------------------------------------------------------- */
/* Tests: reader toolbar + context menu                                      */
/* ------------------------------------------------------------------------- */

test("reader toolbar button and view context menu pass the current page (Proxy, state, last-page fallbacks)", async () => {
	const cases = [
		{ mode: "internal", pageIndex: 7, expected: 8, note: "ReaderInstance Proxy -> _internalReader._state" },
		{ mode: "live", pageIndex: 3, expected: 4, note: "live reader._state" },
		{ mode: "getState", pageIndex: 1, expected: 2, note: "_getState() persisted state" },
		{ mode: "lastPage", pageIndex: 4, expected: 5, note: "getAttachmentLastPageIndex" },
		{ mode: "none", expected: 1, note: "no page information -> page 1" },
		{ mode: "throwing", expected: 1, note: "internal fields throw -> page 1" }
	];
	for (const testCase of cases) {
		const { world } = paperWorld({ lastPageThrows: testCase.mode === "throwing" });
		const reader = addReader(world, {
			tabID: "reader-tab-1",
			itemID: 2,
			pageIndex: testCase.pageIndex,
			mode: testCase.mode
		});
		world.mainWindow.Zotero_Tabs.selectedType = "reader";
		world.mainWindow.Zotero_Tabs.selectedID = reader.tabID;
		const loaded = loadPlugin(world).startup();

		const toolbarDoc = makeAuxDocument(world);
		const appended = [];
		world.readerApi._dispatch("renderToolbar", {
			reader,
			doc: toolbarDoc,
			params: {},
			append(node) {
				appended.push(node);
			}
		});
		assert.equal(appended.length, 1, "toolbar button appended (" + testCase.note + ")");
		const button = appended[0];
		assert.equal(button.tagName, "BUTTON");
		assert.equal(button.textContent, "ReadPI");
		assert.equal(button.title, "在 ReadPI 中阅读");
		assert.equal(button.getAttribute("aria-label"), "在 ReadPI 中阅读");
		assert.equal(button.getAttribute("data-l10n-id"), "babeldoc-toolbar-open");
		button.dispatchEvent("click");
		await settle();
		assert.equal(world.postCalls.length, 1, "toolbar click posts (" + testCase.note + ")");
		assert.equal(world.postCalls[0].body.page, testCase.expected, "toolbar page (" + testCase.note + ")");

		// The reader page context menu passes the same page.
		appended.length = 0;
		world.readerApi._dispatch("createViewContextMenu", {
			reader,
			params: {},
			append(node) {
				appended.push(node);
			}
		});
		assert.equal(appended.length, 1, "context menu entry appended");
		assert.equal(appended[0].label, "在 ReadPI 中阅读");
		appended[0].onCommand();
		await settle();
		assert.equal(world.postCalls.length, 2, "context menu command posts");
		assert.equal(world.postCalls[1].body.page, testCase.expected);
		assert.equal(loaded.bridge.state.readerHooks, true);
	}
});

test("Zotero removes reader listeners by pluginID on shutdown (contract)", async () => {
	const { world } = paperWorld();
	loadPlugin(world).startup();
	assert.equal(world.readerApi.listeners.length, 2);
	const removed = world.readerApi._unregisterEventListenerByPluginID(PLUGIN_ID);
	assert.equal(removed, 2, "pluginID cleanup drops both listeners");
	assert.equal(world.readerApi.listeners.length, 0);
});

/* ------------------------------------------------------------------------- */
/* Tests: multiple PDFs                                                      */
/* ------------------------------------------------------------------------- */

test("multiple PDFs: Services.prompt.select chooses the picked attachment", async () => {
	const { world, paths } = multiPdfWorld(2);
	loadPlugin(world).startup();
	const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
	assert.equal(result.ok, true);
	assert.equal(world.selectCalls.length, 1, "the chooser was shown once");
	const call = world.selectCalls[0];
	assert.equal(call.list.length, 3);
	assert.match(call.text, /3 个/);
	assert.match(call.list[0], /1\. 多附件文献 — first\.pdf/);
	assert.match(call.list[2], /third\.pdf/);
	assert.equal(world.postCalls.length, 1);
	assert.equal(world.postCalls[0].body.path, paths[2], "the third picked attachment is opened");
});

test("multiple PDFs: cancel opens nothing; missing/throwing select falls back with a visible note", async () => {
	// Cancel: nothing is opened, no progress window.
	{
		const { world } = multiPdfWorld("cancel");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "cancelled");
		assert.equal(world.postCalls.length, 0);
		assert.equal(world.progressWindows.length, 0);
	}
	// Services.prompt.select missing entirely -> first PDF, explicit note.
	{
		const { world, paths } = multiPdfWorld("cancel");
		delete world.prompt.select;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.selectCalls.length, 0);
		assert.equal(world.postCalls[0].body.path, paths[0]);
		const text = progressText(lastProgressWindow(world));
		assert.match(text, /3 个 PDF/);
		assert.match(text, /已打开第 1 个/);
	}
	// select() throwing -> same documented fallback, no crash.
	{
		const { world, paths } = multiPdfWorld("throw");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.postCalls[0].body.path, paths[0]);
		assert.match(progressText(lastProgressWindow(world)), /已打开第 1 个/);
		assert.ok(world.logs.some((line) => line.includes("Services.prompt.select failed")));
	}
	// Out-of-range index from the platform -> first PDF + note, never a random pick.
	{
		const { world, paths } = multiPdfWorld(99);
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.postCalls[0].body.path, paths[0]);
		assert.match(progressText(lastProgressWindow(world)), /无法识别的编号/);
	}
});

/* ------------------------------------------------------------------------- */
/* Tests: server error / retry handling                                      */
/* ------------------------------------------------------------------------- */

test("server errors show data.error, honour retryable and use confirmEx's 重试", async () => {
	const message = "附件尚未下载或文件已丢失：paper.pdf。请先在 Zotero 中下载附件，再重试。";
	// retryable error, user cancels the retry
	{
		const { world } = paperWorld();
		world.postHandler = () => downloadError("file_missing", message);
		world.confirmResponse = 1;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(result.retryable, true);
		assert.equal(result.code, "file_missing");
		assert.equal(world.postCalls.length, 1);
		assert.equal(world.confirmCalls.length, 1, "retryable error offers 重试");
		assert.equal(world.confirmCalls[0].button0, "重试");
		assert.equal(world.confirmCalls[0].text, message, "the real server message is shown");
		const progress = lastProgressWindow(world);
		const line = progress.lines[progress.lines.length - 1];
		assert.equal(line.error, true);
		assert.equal(line.text, message);
		assert.ok(progress.descriptions.some((text) => text.includes("可以重试")));
		assert.equal(progress.closeTimer, null, "an error window stays open");
	}
	// retryable error, user retries -> second POST succeeds
	{
		const { world } = paperWorld();
		world.postHandler = ({ call }) => (call === 1 ? downloadError("file_missing", message) : null);
		world.confirmResponse = 0;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.postCalls.length, 2, "retry issues a second POST");
		assert.equal(world.confirmCalls.length, 1);
		const progress = lastProgressWindow(world);
		assert.equal(progress.closeTimer, 3000, "success closes itself after ~3 s");
		assert.match(progress.lines[progress.lines.length - 1].text, /已在 ReadPI 中打开/);
	}
	// not retryable (not PDF): no retry prompt, just the error
	{
		const { world } = paperWorld();
		world.postHandler = () => downloadError("not_pdf", "这个附件不是 PDF，只有 PDF 附件才能在 ReadPI 中阅读。");
		world.confirmResponse = 0;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(result.retryable, false);
		assert.equal(world.confirmCalls.length, 0, "non-retryable error must not offer 重试");
		assert.equal(lastProgressWindow(world).lines.at(-1).text, "这个附件不是 PDF，只有 PDF 附件才能在 ReadPI 中阅读。");
	}
	// POST itself fails (network): retryable, error details shown
	{
		const { world } = paperWorld();
		world.httpHandler = async (record, innerWorld) => {
			if (record.method === "POST") return { error: "NetworkError: connection refused" };
			return defaultHttpHandler(record, innerWorld);
		};
		world.confirmResponse = 1;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(result.code, "connection_failed");
		assert.equal(result.message, "无法连接 ReadPI。");
		assert.match(lastProgressWindow(world).descriptions.join(" "), /connection refused/);
		assert.ok(world.httpCalls.some((call) => call.method === "POST"), "the failing POST was attempted");
	}
});

/* ------------------------------------------------------------------------- */
/* Tests: app discovery, launch chain, health polling                        */
/* ------------------------------------------------------------------------- */

test("app running: launch-info port is probed, then the port scan finds a moved app", async () => {
	// launch-info says 8765 but the app moved to 8769: the scan must find it.
	const { world } = paperWorld();
	world.serverUp = true;
	world.serverPort = 8769;
	world.files.set(normPath(LAUNCH_INFO_PATH), JSON.stringify(LAUNCH_INFO));
	loadPlugin(world).startup();
	const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
	assert.equal(result.ok, true);
	assert.equal(world.postCalls.length, 1);
	assert.equal(new URL(world.postCalls[0].url).port, "8769");
	assert.equal(world.execCalls.length, 0, "no launch needed");
	assert.ok(world.healthCalls.some((url) => url.includes(":8765")), "launch-info port probed first");
});

test("app not running: launch chain launcher -> Start.bat -> pythonw, ~25 s health polling", async () => {
	// launcher exists: used, and exec()'s never-resolving promise is not awaited
	{
		const { world } = launchWorld();
		world.healthHandler = ({ port, call }) => (port === 8765 && call >= 3 ? "up" : "down");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true, "flow completed even though exec() never resolves");
		assert.equal(world.execCalls.length, 1);
		assert.equal(world.execCalls[0].command, LAUNCH_INFO.launcher);
		assert.deepEqual([...world.execCalls[0].args], []);
		assert.equal(world.postCalls.length, 1);
		assert.ok(world.healthCalls.length > 3, "health polled repeatedly");
		const progress = lastProgressWindow(world);
		assert.equal(progress.closeTimer, 3000);
	}
	// launcher rejects (missing/not executable): fall back to Start.bat via cmd.exe /c start
	{
		const { world } = launchWorld();
		const comspec = String.raw`D:\Windows\System32\cmd.exe`;
		world.env = { COMSPEC: comspec };
		world.execHandler = (record) => (
			record.command === LAUNCH_INFO.launcher ? { throws: true, error: "not an executable" } : null
		);
		world.healthHandler = ({ port, call }) => (port === 8765 && call >= 3 ? "up" : "down");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.execCalls.length, 2);
		assert.equal(world.execCalls[0].command, LAUNCH_INFO.launcher);
		assert.equal(world.execCalls[1].command, comspec, "cmd.exe comes from COMSPEC when available");
		assert.deepEqual([...world.execCalls[1].args], ["/c", "start", "", LAUNCH_INFO.start_bat]);
	}
	// no COMSPEC: the standard system location is used
	{
		const { world } = launchWorld({ info: { ...LAUNCH_INFO, launcher: "" } });
		world.execHandler = (record) => (
			record.command === LAUNCH_INFO.start_bat ? { throws: true, error: "not an executable" } : null
		);
		world.healthHandler = ({ port, call }) => (port === 8765 && call >= 3 ? "up" : "down");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.execCalls[0].command, "C:\\Windows\\System32\\cmd.exe");
	}
	// no launcher/start_bat in launch-info: pythonw app.py --server-only --port N
	{
		const info = { ...LAUNCH_INFO };
		delete info.launcher;
		delete info.start_bat;
		const { world } = launchWorld({ info });
		world.healthHandler = ({ port, call }) => (port === 8765 && call >= 3 ? "up" : "down");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.execCalls.length, 1);
		assert.equal(world.execCalls[0].command, info.pythonw);
		assert.deepEqual([...world.execCalls[0].args], [info.script, "--server-only", "--port", "8765"]);
	}
	// preference launchInfoPath override is read before %APPDATA%
	{
		const { world } = paperWorld();
		world.serverUp = true;
		world.serverPort = 8791;
		const customPath = String.raw`C:\custom\li.json`;
		world.files.set(normPath(customPath), JSON.stringify({ ...LAUNCH_INFO, port: 8791 }));
		world.prefs.set("extensions.babeldoc.launchInfoPath", customPath);
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(new URL(world.postCalls[0].url).port, "8791");
		assert.ok(world.healthCalls[0].includes(":8791"), "custom launch-info port probed first");
	}
	// invalid custom launch-info falls back to the AppData file
	{
		const { world } = paperWorld();
		world.serverUp = true;
		world.serverPort = 8765;
		world.files.set(normPath(String.raw`C:\custom\li.json`), "{not json");
		world.files.set(normPath(LAUNCH_INFO_PATH), JSON.stringify(LAUNCH_INFO));
		world.prefs.set("extensions.babeldoc.launchInfoPath", String.raw`C:\custom\li.json`);
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(new URL(world.postCalls[0].url).port, "8765");
	}
});

test("no launch-info + app down: no launch attempt, clear reason, retry path; autoLaunch=false respects the pref", async () => {
	// no launch-info.json at all, nothing to launch
	{
		const { world } = launchWorld({ info: null });
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(result.code, "app_not_running");
		assert.equal(world.execCalls.length, 0);
		assert.equal(world.postCalls.length, 0);
		assert.match(result.detail, /没有找到 launch-info\.json/);
		assert.equal(world.confirmCalls.length, 1, "a retry path is offered");
		const progress = lastProgressWindow(world);
		assert.equal(progress.lines.at(-1).error, true);
		assert.match(progress.descriptions.join(" "), /launch-info\.json/);
	}
	// auto launch disabled: no exec at all, message says so
	{
		const { world } = launchWorld({ autoLaunch: false });
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(world.execCalls.length, 0, "autoLaunch=false must not launch anything");
		assert.match(result.message, /自动启动已关闭/);
		assert.equal(world.confirmCalls.length, 1);
	}
});

test("app never becomes ready: real reason shown, confirmEx retry re-probes and succeeds", async () => {
	const { world } = launchWorld();
	world.healthUnlocked = false;
	world.healthHandler = ({ port }) => (port === 8765 && world.healthUnlocked ? "up" : "down");
	world.confirmResponse = 0;
	// The user fixes the app while the confirmEx dialog is open.
	world.onConfirm = () => {
		world.healthUnlocked = true;
	};
	loadPlugin(world).startup();
	const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
	assert.equal(result.ok, true);
	assert.equal(world.confirmCalls.length, 1);
	assert.equal(world.postCalls.length, 1, "retry posted after the app came up");
	assert.ok(world.healthCalls.length > 10, "25 s polling window actually polls");
	const progress = lastProgressWindow(world);
	assert.ok(
		progress.descriptions.some((text) => /已尝试通过「应用启动器」启动/.test(text) && /25 秒/.test(text)),
		"the real reason (launched but not ready) is shown: " + progress.descriptions.join(" | ")
	);
	assert.equal(progress.closeTimer, 3000);
});

test("port preference overrides auto discovery; wrong app identity is not accepted", async () => {
	// explicit port: only that port is probed
	{
		const { world } = paperWorld();
		world.prefs.set("extensions.babeldoc.port", 8790);
		world.serverUp = true;
		world.serverPort = 8790;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(new URL(world.postCalls[0].url).port, "8790");
		assert.ok(world.healthCalls.every((url) => url.includes(":8790")), "override probes only 8790");
	}
	// /api/health answering for a different app must be rejected
	{
		const { world } = paperWorld();
		world.healthHandler = () => ({
			status: 200,
			responseText: JSON.stringify({ ok: true, app: "Some Other App", version: "1.0" })
		});
		world.prefs.set("extensions.babeldoc.autoLaunch", false);
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, false);
		assert.equal(world.postCalls.length, 0, "must not POST to a foreign local server");
	}
});

test("plugin preferences are read with global=true (extensions.babeldoc.*, not extensions.zotero.*)", async () => {
	// The appPath override must win over launch-info's launcher.
	{
		const { world } = launchWorld();
		const custom = String.raw`D:\Custom\BabelDOC Studio.exe`;
		world.prefs.set("extensions.babeldoc.appPath", custom);
		world.healthHandler = ({ port, call }) => (port === 8765 && call >= 3 ? "up" : "down");
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(world.execCalls[0].command, custom, "appPath preference must be honoured");
	}
	// A value stored under the prefixed namespace is a different pref and must
	// not be picked up (Zotero.Prefs prefixes keys unless global=true).
	{
		const { world } = paperWorld();
		world.prefs.set("extensions.zotero.extensions.babeldoc.port", 8799);
		world.serverUp = true;
		world.serverPort = 8765;
		loadPlugin(world).startup();
		const result = await loadPlugin(world).internals.openSelectedItems(world.mainWindow);
		assert.equal(result.ok, true);
		assert.equal(new URL(world.postCalls[0].url).port, "8765");
		assert.ok(world.healthCalls.every((url) => !url.includes(":8799")), "prefixed key must not be read");
	}
});

/* ------------------------------------------------------------------------- */
/* Tests: Zotero 8 MenuManager + preference pane robustness                  */
/* ------------------------------------------------------------------------- */

test("Zotero 8: MenuManager is used when present, no DOM duplicate, unregister on shutdown", async () => {
	const { world, item } = paperWorld();
	const menuManager = {
		registrations: [],
		unregistrations: [],
		registerMenu(options) {
			this.registrations.push(options);
			return "menu-key-1";
		},
		unregisterMenu(id) {
			this.unregistrations.push(id);
			return true;
		}
	};
	world.Zotero.MenuManager = menuManager;
	const loaded = loadPlugin(world).startup();
	assert.equal(menuManager.registrations.length, 1);
	const option = menuManager.registrations[0];
	assert.equal(option.menuID, "babeldoc-menu-open");
	assert.equal(option.pluginID, PLUGIN_ID);
	assert.equal(option.target, "main/library/item");
	assert.equal(option.menus.length, 1);
	const entry = option.menus[0];
	assert.equal(entry.menuType, "menuitem");
	assert.equal(entry.l10nID, "babeldoc-menu-open");
	assert.match(entry.icon, /icons\/icon-16\.svg$/);

	// No DOM injection on the 8 path (a duplicated entry would be visible twice).
	assert.equal(menuItems(world).length, 0, "MenuManager path must not inject #zotero-itemmenu");

	// onShowing visibility from context.items
	const contextElement = world.mainWindow.document.createElement("menuitem");
	let visible = null;
	const menuContext = {
		items: [item],
		menuElem: contextElement,
		setVisible(value) {
			visible = value;
		}
	};
	// Zotero 10 permits multiple collection rows; the singular getter throws.
	// The bridge must work from selected items without touching that getter.
	Object.defineProperty(menuContext, "collectionTreeRow", {
		get() { throw new Error("Zotero 10: use collectionTreeRows"); }
	});
	menuContext.collectionTreeRows = [{}, {}];
	entry.onShowing({ type: "popupshowing" }, menuContext);
	assert.equal(visible, true);
	const noPdf = addRegularItem(world, { id: 90, key: "ITEM0090", title: "No PDF" });
	const hiddenContext = { ...menuContext, items: [noPdf] };
	entry.onShowing({ type: "popupshowing" }, hiddenContext);
	assert.equal(visible, false);

	// onCommand opens through the same code path
	entry.onCommand();
	await settle();
	assert.equal(world.postCalls.length, 1);

	loaded.shutdown();
	assert.deepEqual(menuManager.unregistrations, ["menu-key-1"]);
});

test("Zotero 8: a rejected MenuManager registration falls back to the Zotero 7 DOM menu", async () => {
	const { world } = paperWorld();
	world.Zotero.MenuManager = {
		registerMenu() {
			return false;
		},
		unregisterMenu() {}
	};
	loadPlugin(world).startup();
	assert.equal(menuItems(world).length, 1, "DOM fallback keeps the entry available");
});

test("preference pane: async registration after shutdown is dropped; missing pane API does not break startup", async () => {
	{
		const { world } = paperWorld();
		let resolvePane = null;
		world.Zotero.PreferencePanes.register = (paneOptions) => {
			world.paneRegistrations.push(paneOptions);
			return new Promise((resolve) => {
				resolvePane = resolve;
			});
		};
		const loaded = loadPlugin(world).startup();
		loaded.shutdown();
		resolvePane("pane-late");
		await settle(4);
		assert.deepEqual(world.paneUnregistrations, ["pane-late"], "a pane registered after shutdown is removed");
	}
	{
		const { world } = paperWorld();
		delete world.Zotero.PreferencePanes;
		const loaded = loadPlugin(world).startup();
		assert.equal(menuItems(world).length, 1, "menu still installed without PreferencePanes");
		assert.equal(world.readerApi.listeners.length, 2);
		loaded.shutdown();
	}
});

test("main toolbar offers translate, read and library; stale server never receives an open", async () => {
	const { world } = paperWorld();
	const doc = world.mainWindow.document;
	const tabs = doc.getElementById("zotero-tabs-toolbar");
	for (let index = 0; index < 2; index++) {
		const stale = doc.createXULElement("toolbarbutton");
		stale.id = "babeldoc-toolbar-button";
		tabs.appendChild(stale);
	}
	const plugin = loadPlugin(world).startup();
	const button = doc.getElementById("babeldoc-toolbar-button");
	assert.ok(button);
	assert.equal(button.parentNode.id, "zotero-items-toolbar");
	assert.equal(button.parentNode.children[0], button, "button is before the flexible spacer");
	assert.equal(doc.getElementsByTagName("toolbarbutton").filter(node => node.id === button.id).length, 1);
	assert.equal(button.getAttribute("label"), null, "item-tree toolbar icon has no visible text label");
	plugin.bridge.onMainWindowLoad({ window: world.mainWindow });
	assert.equal(doc.getElementsByTagName("toolbarbutton").filter(node => node.id === button.id).length, 1);
	const menu = doc.getElementById("babeldoc-toolbar-menu");
	menu.dispatchEvent("popupshowing");
	for (const id of ["babeldoc-toolbar-translate", "babeldoc-toolbar-read", "babeldoc-toolbar-library"])
		assert.ok(doc.getElementById(id));
	doc.getElementById("babeldoc-toolbar-translate").dispatchEvent("command");
	await settle();
	assert.equal(world.postCalls.length, 1);
	assert.equal(world.postCalls[0].body.mode, "translate");
	plugin.shutdown();
	assert.equal(doc.getElementById("babeldoc-toolbar-button"), null);

	const stale = paperWorld().world;
	stale.prefs.set("extensions.babeldoc.autoLaunch", false);
	stale.healthHandler = () => ({ status: 200, responseText: JSON.stringify({
		ok: true, app: APP_NAME, version: "1.7.0", features: ["text"] }) });
	const old = loadPlugin(stale).startup();
	const result = await old.internals.openSelectedItems(stale.mainWindow);
	assert.equal(result.ok, false);
	assert.equal(result.code, "app_outdated");
	assert.match(result.message, /旧版本/);
	assert.equal(stale.postCalls.length, 0);
	old.shutdown();
});

test("a Zotero-capable server wins over an old Studio on 8765", async () => {
	const { world } = paperWorld();
	world.healthHandler = ({ port }) => {
		if (port === 8765) return { status: 200, responseText: JSON.stringify({
			ok: true, app: APP_NAME, version: "1.7.0", features: ["text"] }) };
		if (port === 8766) return "up";
		return "down";
	};
	const plugin = loadPlugin(world).startup();
	const result = await plugin.internals.openSelectedItems(world.mainWindow);
	assert.equal(result.ok, true);
	assert.equal(new URL(world.postCalls[0].url).port, "8766");
	plugin.shutdown();
});

test("library snapshot sends nested collections and local PDF; toolbar opens the library panel", async () => {
	const { world, item } = paperWorld();
	item.getCollections = () => [8];
	world.Zotero.version = "10.0.8";
	world.Zotero.Libraries = { getAll: async () => [{ libraryID: 1, name: "My Library", libraryType: "user" }] };
	world.Zotero.Collections = { getByLibrary: async (_libraryID, recursive) => {
		assert.equal(recursive, true);
		return [
		{ id: 7, name: "Robots", parentID: 0 },
		{ id: 8, name: "Social", parentID: 7 }
		];
	} };
	world.Zotero.Items.getAll = async () => [item];
	const payloads = [];
	world.httpHandler = async (record, current) => {
		if (record.method === "POST" && /\/api\/zotero\/(library|panel)$/.test(record.url)) {
			payloads.push({ path: new URL(record.url).pathname, body: JSON.parse(record.body) });
			return { status: 200, responseText: JSON.stringify({ ok: true, route: "/library?source=zotero" }) };
		}
		return defaultHttpHandler(record, current);
	};
	const plugin = loadPlugin(world).startup();
	const snapshot = await plugin.internals.buildLibrarySnapshot();
	assert.equal(snapshot.items.length, 1);
	assert.deepEqual(Array.from(snapshot.items[0].collections), [8]);
	assert.equal(snapshot.items[0].attachments[0].key, "ATTACH01");
	assert.equal(snapshot.collections[1].parent_id, 7);
	await plugin.internals.syncLibrary(true);
	assert.equal(payloads[0].path, "/api/zotero/library");
	assert.equal(payloads[0].body.items[0].title, item.getField("title"));
	world.mainWindow.document.getElementById("babeldoc-toolbar-library").dispatchEvent("command");
	await settle();
	assert.ok(payloads.some(entry => entry.path === "/api/zotero/panel"));
	plugin.shutdown();
});

/* ------------------------------------------------------------------------- */
/* Runner                                                                    */
/* ------------------------------------------------------------------------- */

async function main() {
	let failed = 0;
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log("ok - " + name);
		}
		catch (error) {
			failed++;
			console.error("not ok - " + name);
			const details = error && error.stack ? error.stack : String(error);
			console.error(details.split("\n").map((line) => "    " + line).join("\n"));
		}
	}
	console.log("");
	console.log(`${tests.length - failed}/${tests.length} harness checks passed`);
	if (failed > 0) {
		console.error(`${failed} harness check(s) failed`);
		process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error("harness crashed:");
	console.error(error && error.stack ? error.stack : error);
	process.exit(1);
});
