'use strict';
//
// A mod's own settings window.
//
// A mod that declares `"settingsPage": "settings/index.html"` gets a Settings…
// button in the Mods tab, and the page opens here: a window the mod owns, in
// which it can lay out its options however it likes. What it may *do* is kept
// small on purpose. The page is somebody else's code, so it gets:
//
//   window.modSettings.get()        its declared settings with the values in
//                                   force, plus read-only context (era, app
//                                   version, which mods are on)
//   window.modSettings.set(values)  write some of its own settings; the
//                                   supervisor validates them against mod.json
//                                   exactly as it does for the Mods tab
//   window.modSettings.apply()      restart the server, as Apply in Settings
//
// and nothing else: its own preload rather than the app's (which exposes every
// handler), a sandboxed renderer, no navigation, no new windows, no
// permissions, and a session of its own. The page is served from a private
// scheme (ragnarok-mod://mod/...) that only answers with files inside the
// mod's folder, under a Content-Security-Policy with no network at all, and
// the session cancels anything that is not that scheme, data: or blob:. So the
// page cannot reach the internet, and cannot read the rest of the disk.
// Which mod a call belongs to is decided from the window it came from, never
// from anything the page sends.
//
const fs = require('node:fs');
const path = require('node:path');

function isInside(root, candidate) {
	const rel = path.relative(root, candidate);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The page a mod declared, as a real file inside the mod's real folder.
// Checked again here although the supervisor already checked it: the path came
// back through a tab-separated line, and a link inside the mod folder could
// still point anywhere.
function settingsPageFile(modDir, page) {
	if (typeof modDir !== 'string' || !path.isAbsolute(modDir)) throw new Error('This mod has no settings page.');
	if (typeof page !== 'string' || !page || page.length > 200 || page.startsWith('/')
		|| /[\\:\0]/.test(page) || page.split('/').some(p => !p || p === '.' || p === '..')
		|| !/\.html?$/.test(page)) {
		throw new Error('This mod\'s settings page is not a file inside its folder.');
	}
	let root, file;
	try {
		root = fs.realpathSync(modDir);
		file = fs.realpathSync(path.join(root, ...page.split('/')));
	} catch {
		throw new Error('This mod\'s settings page is missing. Reinstalling the mod may bring it back.');
	}
	if (!isInside(root, file) || !fs.statSync(file).isFile()) {
		throw new Error('This mod\'s settings page is not a file inside its folder.');
	}
	return { root, file };
}

const SCHEME = 'ragnarok-mod';
const ORIGIN = `${SCHEME}://mod`;
// Scripts and styles from the mod's folder (inline too, since a one-file page
// is the common case), images and fonts from it or made by the page, and
// fetch() only back into the mod's own folder.
const CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"form-action 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
].join('; ');
const TYPES = {
	'.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
	'.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
	'.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

// The file a ragnarok-mod:// URL names, if it is a real file inside the mod
// folder; otherwise null.
function fileFor(root, url) {
	let parsed;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'mod') return null;
	let parts;
	try { parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
	if (!parts.length || parts.some(p => p === '.' || p === '..' || /[\\/:\0]/.test(p))) return null;
	let file;
	try { file = fs.realpathSync(path.join(root, ...parts)); } catch { return null; }
	if (!isInside(root, file)) return null;
	try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
	return file;
}

// Whether the window may make a request at all: its own scheme, and things the
// page made itself. The protocol handler then decides which files exist.
function allowedRequest(url) {
	let parsed;
	try { parsed = new URL(url); } catch { return false; }
	if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
	return parsed.protocol === `${SCHEME}:` && parsed.host === 'mod';
}

function pageUrl(root, file) {
	return `${ORIGIN}/${path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')}`;
}

// Must run before the app is ready: a standard, secure scheme gets relative
// URLs and its own origin, so the page cannot read file:// or anything else.
function registerScheme(protocol) {
	protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

// The values to hand the supervisor: every declared setting, with the ones the
// page sent laid over the ones in force. The supervisor stores a mod's answers
// as a whole, so sending only the changed keys would reset the rest.
function mergedValues(declared, given) {
	if (!given || typeof given !== 'object' || Array.isArray(given)) {
		throw new Error('modSettings.set expects an object like { "key": value }.');
	}
	const known = new Map(declared.map(s => [s.key, s]));
	const out = Object.fromEntries(declared.map(s => [s.key, s.value]));
	for (const [key, value] of Object.entries(given)) {
		const setting = known.get(key);
		if (!setting) throw new Error(`This mod declares no setting called "${key}".`);
		const type = value === null ? 'null' : typeof value;
		const expected = setting.type === 'boolean' ? 'boolean' : setting.type === 'number' ? 'number' : 'string';
		if (type !== expected) throw new Error(`"${key}" expects a ${expected}, not a ${type}.`);
		out[key] = value;
	}
	return out;
}

// Wiring. Electron and the app's own handlers come in as arguments, so the
// checks above can be tested without starting Electron.
function create({ BrowserWindow, session, ipcMain, preload, listMods, saveSettings, apply, context, log }) {
	const open = new Map();   // mod name -> BrowserWindow
	const owners = new Map(); // webContents id -> { name, root }
	let applying = null;
	let writes = Promise.resolve();

	function ownerOf(event) {
		if (!event || !event.sender || event.senderFrame !== event.sender.mainFrame) return null;
		const owner = owners.get(event.sender.id);
		if (!owner || !String(event.senderFrame.url || '').startsWith(`${ORIGIN}/`)) return null;
		return owner;
	}
	function caller(event, what) {
		const owner = ownerOf(event);
		if (!owner) {
			log(`refused ${what} from ${(event && event.senderFrame && event.senderFrame.url) || 'unknown'}`);
			throw new Error(`${what} is only available to a mod's settings window.`);
		}
		return owner.name;
	}
	async function installed(name) {
		const mods = await listMods();
		const mod = mods.find(m => m.name === name);
		if (!mod || mod.refused) throw new Error(`${name} is not installed and loaded any more.`);
		return { mod, mods };
	}

	ipcMain.handle('mod-settings:get', async event => {
		const name = caller(event, 'modSettings.get');
		const { mod, mods } = await installed(name);
		return {
			name,
			version: mod.version,
			enabled: mod.enabled,
			settings: mod.settings,
			context: { ...context(), enabledMods: mods.filter(m => m.enabled).map(m => m.name) },
		};
	});
	ipcMain.handle('mod-settings:set', async (event, given) => {
		const name = caller(event, 'modSettings.set');
		const job = writes.then(async () => {
			const { mod } = await installed(name);
			await saveSettings(name, mergedValues(mod.settings, given));
			log(`mod ${name} changed its settings from its settings window`);
			return { saved: true };
		});
		writes = job.catch(() => {});
		return job;
	});
	// One restart at a time: a second call while one is running shares it
	// rather than queueing another, so a page cannot loop the server.
	ipcMain.handle('mod-settings:apply', async event => {
		const name = caller(event, 'modSettings.apply');
		if (!applying) {
			log(`mod ${name} asked for Apply from its settings window`);
			applying = writes.then(() => apply()).finally(() => { applying = null; });
		}
		await applying;
		return { applied: true };
	});

	return {
		async open(name, parent) {
			const existing = open.get(name);
			if (existing && !existing.isDestroyed()) { existing.focus(); return `${name} settings are already open.`; }
			const { mod } = await installed(name);
			if (!mod.settingsPage) throw new Error(`${name} has no settings page.`);
			const { root, file } = settingsPageFile(mod.dir, mod.settingsPage);

			const partition = `mod-settings:${name}`;
			const ses = session.fromPartition(partition);
			if (ses.protocol.isProtocolHandled(SCHEME)) ses.protocol.unhandle(SCHEME);
			ses.protocol.handle(SCHEME, async request => {
				const found = fileFor(root, request.url);
				if (!found) return new Response('Not found', { status: 404 });
				const type = TYPES[path.extname(found).toLowerCase()] || 'application/octet-stream';
				return new Response(await fs.promises.readFile(found), {
					headers: { 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
				});
			});
			ses.webRequest.onBeforeRequest((details, callback) => {
				const ok = allowedRequest(details.url);
				if (!ok) log(`mod ${name} settings window: blocked ${details.url}`);
				callback({ cancel: !ok });
			});
			ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
			ses.setPermissionCheckHandler(() => false);

			const win = new BrowserWindow({
				width: 560,
				height: 680,
				title: `${name} — settings`,
				parent: parent && !parent.isDestroyed() ? parent : undefined,
				autoHideMenuBar: true,
				webPreferences: {
					preload,
					partition,
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					webviewTag: false,
					navigateOnDragDrop: false,
					spellcheck: false,
				},
			});
			const id = win.webContents.id;
			owners.set(id, { name, root });
			open.set(name, win);
			// The title says whose window this is; the page does not get to
			// change it into something that looks like the app's own.
			win.on('page-title-updated', e => e.preventDefault());
			win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			win.webContents.on('will-navigate', e => e.preventDefault());
			win.webContents.on('will-redirect', e => e.preventDefault());
			win.webContents.on('will-attach-webview', e => e.preventDefault());
			win.on('closed', () => {
				owners.delete(id);
				if (open.get(name) === win) open.delete(name);
			});
			await win.loadURL(pageUrl(root, file));
			log(`opened settings window for mod ${name}`);
			return `Opened ${name} settings.`;
		},
	};
}

module.exports = { create, registerScheme, settingsPageFile, fileFor, allowedRequest, pageUrl, mergedValues, CSP };
