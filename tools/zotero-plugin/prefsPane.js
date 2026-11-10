/*
 * ReadPI preference pane logic (loaded with prefs.xhtml).
 *
 * This file runs in the preferences window scope, not in the add-on bootstrap
 * scope, so it cannot reach bootstrap.js.  It only needs to read/write prefs,
 * probe /api/health and open file pickers.
 *
 * Zotero 7 loads pane scripts into the window scope (so `var BabeldocPrefs` and
 * window.BabeldocPrefs both work for the inline oncommand handlers).  Zotero 8
 * runs pane scripts in a separate global, hence the explicit window assignment.
 */

var BabeldocPrefs = {
	PREF: {
		launchInfoPath: "extensions.babeldoc.launchInfoPath",
		appPath: "extensions.babeldoc.appPath",
		port: "extensions.babeldoc.port",
		autoLaunch: "extensions.babeldoc.autoLaunch",
		passPage: "extensions.babeldoc.passPage"
	},
	APP_NAME: "BabelDOC Studio",
	DEFAULT_PORT: 8765,
	PORT_SCAN_COUNT: 40,

	_log(message) {
		try {
			Zotero.debug("[BabelDOC prefs] " + message);
		}
		catch (e) {
			// ignore
		}
	},

	_status(message) {
		try {
			const element = document.getElementById("babeldoc-status");
			if (element) element.textContent = String(message);
		}
		catch (e) {
			// ignore
		}
	},

	_prefString(key) {
		try {
			// Zotero.Prefs prefixes non-global keys with "extensions.zotero.";
			// plugin prefs are at extensions.babeldoc.*, hence global = true.
			const value = Zotero.Prefs.get(this.PREF[key], true);
			return value === undefined || value === null ? "" : String(value).trim();
		}
		catch (e) {
			return "";
		}
	},

	_prefInt(key, fallback) {
		const value = parseInt(this._prefString(key), 10);
		return Number.isFinite(value) ? value : fallback;
	},

	async _pickFile(title, filters) {
		try {
			const { FilePicker } = ChromeUtils.importESModule(
				"chrome://zotero/content/modules/filePicker.mjs"
			);
			const picker = new FilePicker();
			picker.init(window, title, picker.modeOpen);
			for (const filter of filters) picker.appendFilter(filter[0], filter[1]);
			const result = await picker.show();
			if (result === picker.returnOK && picker.file) return String(picker.file);
		}
		catch (e) {
			this._log("file picker failed: " + e);
		}
		return "";
	},

	/* -------------------------------------------------------------- */
	/* Buttons                                                         */
	/* -------------------------------------------------------------- */

	async browseLauncher() {
		this._status("请选择 ReadPI 的启动器…");
		const file = await this._pickFile("选择 ReadPI 启动器", [
			["可执行文件", "*.exe;*.bat"],
			["所有文件", "*"]
		]);
		if (!file) {
			this._status("未选择启动器。");
			return;
		}
		try {
			Zotero.Prefs.set(this.PREF.appPath, file, true);
		}
		catch (e) {
			this._log("set appPath failed: " + e);
		}
		this._status("已设置启动器：" + file);
	},

	async browseLaunchInfo() {
		this._status("请选择 launch-info.json…");
		const file = await this._pickFile("选择 ReadPI 的 launch-info.json", [
			["launch-info.json", "*.json"],
			["所有文件", "*"]
		]);
		if (!file) {
			this._status("未选择文件。");
			return;
		}
		try {
			Zotero.Prefs.set(this.PREF.launchInfoPath, file, true);
		}
		catch (e) {
			this._log("set launchInfoPath failed: " + e);
		}
		this._status("已设置 launch-info.json：" + file);
	},

	/** "检测" button: find the app, then fetch /api/zotero/status for details. */
	async test() {
		this._status("正在检测…");
		let info = null;
		try {
			info = await this._readLaunchInfo();
		}
		catch (e) {
			this._log("read launch-info failed: " + e);
		}
		const ports = this._candidatePorts(info);
		for (const port of ports) {
			const health = await this._getJSON("http://127.0.0.1:" + port + "/api/health", 900);
			if (!health || health.app !== this.APP_NAME) continue;
			const status = await this._getJSON("http://127.0.0.1:" + port + "/api/zotero/status", 2000);
			let detail = "已连接 · 端口 " + port;
			if (status) {
				const count = typeof status.link_count === "number" ? status.link_count : "?";
				const version = status.plugin && status.plugin.version ? status.plugin.version : "未打包";
				detail += " · 链接数 " + count + " · 插件版本 " + version;
			}
			this._status(detail);
			return;
		}
		const hint = info
			? ""
			: "（没有找到 launch-info.json：" + (this._launchInfoPath() || "路径未知") + "）";
		this._status("未连接" + hint + "。请先启动 ReadPI，再点「检测」。");
	},

	/** "打开 ReadPI" button: open the running app, or start it. */
	async openApp() {
		this._status("正在打开 ReadPI…");
		const info = await this._readLaunchInfo();
		for (const port of this._candidatePorts(info)) {
			const health = await this._getJSON("http://127.0.0.1:" + port + "/api/health", 800);
			if (health && health.app === this.APP_NAME) {
				try {
					Zotero.launchURL("http://127.0.0.1:" + port + "/");
				}
				catch (e) {
					this._log("launchURL failed: " + e);
				}
				this._status("已在浏览器中打开 ReadPI（端口 " + port + "）。");
				return;
			}
		}
		const launched = this._launch(info);
		if (!launched.ok) {
			this._status("无法启动：" + launched.error);
			return;
		}
		this._status("已通过「" + launched.method + "」启动，稍等几秒后点「检测」确认连接。");
	},

	/* -------------------------------------------------------------- */
	/* Helpers                                                         */
	/* -------------------------------------------------------------- */

	_launchInfoPath() {
		const custom = this._prefString("launchInfoPath");
		if (custom) {
			if (/\.json$/i.test(custom)) return custom;
			return this._join(custom, "launch-info.json");
		}
		return this._defaultLaunchInfoPath();
	},

	_defaultLaunchInfoPath() {
		try {
			const appData = Services.dirsvc.get("AppData", Ci.nsIFile);
			if (!appData || !appData.path) return "";
			return this._join(String(appData.path), "BabelDOC-Studio", "zotero", "launch-info.json");
		}
		catch (e) {
			return "";
		}
	},

	_join(base, ...parts) {
		try {
			const file = Zotero.File.pathToFile(String(base));
			for (const part of parts) {
				if (part) file.append(String(part));
			}
			return file.path ? String(file.path) : "";
		}
		catch (e) {
			return "";
		}
	},

	async _readLaunchInfo() {
		const candidates = [];
		const custom = this._prefString("launchInfoPath");
		if (custom) {
			// The preference may be the file itself or a folder containing it.
			if (/\.json$/i.test(custom)) {
				candidates.push(custom);
			}
			else {
				candidates.push(this._join(custom, "launch-info.json"));
				candidates.push(this._join(custom, "zotero", "launch-info.json"));
			}
		}
		const fallback = this._defaultLaunchInfoPath();
		if (fallback) candidates.push(fallback);
		for (const path of candidates) {
			try {
				const file = Zotero.File.pathToFile(path);
				if (!file || !file.exists()) continue;
				const data = JSON.parse(await Zotero.File.getContentsAsync(path));
				if (!data || typeof data !== "object") continue;
				if (data.app && data.app !== this.APP_NAME) continue;
				return data;
			}
			catch (e) {
				this._log("launch-info read failed (" + path + "): " + e);
			}
		}
		return null;
	},

	_candidatePorts(info) {
		const ports = [];
		const add = (value) => {
			const port = parseInt(value, 10);
			if (!Number.isFinite(port) || port <= 0 || port >= 65536) return;
			if (ports.indexOf(port) === -1) ports.push(port);
		};
		const override = this._prefInt("port", 0);
		if (override > 0) {
			add(override);
			return ports;
		}
		if (info && info.port) add(info.port);
		for (let index = 0; index < this.PORT_SCAN_COUNT; index++) add(this.DEFAULT_PORT + index);
		return ports;
	},

	_cmdExe() {
		try {
			if (Services && Services.env && typeof Services.env.get === "function") {
				const comspec = Services.env.get("COMSPEC");
				if (comspec) return String(comspec);
			}
		}
		catch (e) {
			// fall through
		}
		return "C:\\Windows\\System32\\cmd.exe";
	},

	_launch(info) {
		const errors = [];
		const attempts = [];
		const custom = this._prefString("appPath");
		if (custom) attempts.push({ method: "自定义启动器", path: custom });
		if (info && info.launcher) attempts.push({ method: "应用启动器", path: info.launcher });
		if (info && info.start_bat) attempts.push({ method: "Start.bat", path: info.start_bat });
		for (const attempt of attempts) {
			try {
				if (/\.bat$/i.test(attempt.path)) {
					Zotero.Utilities.Internal.exec(
						this._cmdExe(),
						["/c", "start", "", attempt.path]
					).catch((error) => this._log("bat exited: " + error));
				}
				else {
					Zotero.Utilities.Internal.exec(attempt.path, [])
						.catch((error) => this._log("launcher exited: " + error));
				}
				return { ok: true, method: attempt.method };
			}
			catch (e) {
				errors.push(attempt.method + ": " + e);
			}
		}
		if (info && info.pythonw && info.script) {
			try {
				const port = (info.port || this.DEFAULT_PORT);
				Zotero.Utilities.Internal.exec(
					info.pythonw,
					[info.script, "--server-only", "--port", String(port)]
				).catch((error) => this._log("pythonw exited: " + error));
				return { ok: true, method: "pythonw" };
			}
			catch (e) {
				errors.push("pythonw: " + e);
			}
		}
		if (!attempts.length) {
			return {
				ok: false,
				error: "没有找到可用的启动方式：launch-info.json 不存在，偏好里也没有设置启动器路径。"
			};
		}
		return { ok: false, error: errors.join("；") || "启动失败" };
	},

	async _getJSON(url, timeout) {
		try {
			const xhr = await Zotero.HTTP.request("GET", url, {
				timeout: timeout,
				responseType: "text",
				noCache: true,
				errorDelayMax: 0,
				successCodes: [200]
			});
			return JSON.parse(xhr.responseText);
		}
		catch (e) {
			return null;
		}
	}
};

if (typeof window !== "undefined") {
	window.BabeldocPrefs = BabeldocPrefs;
}
