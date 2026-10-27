'use strict';
//
// Where a mod's host handler runs: a hidden, sandboxed renderer of its own.
//
// This is the Electron half of host routes, kept apart from manager.js (the
// limits) so that what gives the handler its powers can be read in one place:
//
//   - a renderer with sandbox, context isolation and no Node, in a window that
//     is never shown and cannot open, navigate, download or ask permission;
//   - a non-persistent session per mod, so nothing it stores survives a
//     restart and no two mods share cookies, caches or storage;
//   - its own scheme, mod-host://mod/, answered only on that session and only
//     with files inside the mod's host/ folder (after following links);
//   - a network filter on that session that cancels every request except that
//     scheme and the exact origins the host consented to (`connect`), and a
//     Content-Security-Policy saying the same thing a second time;
//   - one bridge (preload.js): receive a request, send back its answer, log.
//
// Nothing here can be exercised by node:test; manager.js's tests use a fake
// transport in its place.
//
const fs = require('node:fs');
const path = require('node:path');

const SCHEME = 'mod-host';
const ORIGIN = `${SCHEME}://mod`;
// The page and its loader are made here, under a name a mod's own files are
// never served at.
const RESERVED = '__ragnarok__';
const schemePrivileges = { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } };

const TYPES = {
	'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
	'.wasm': 'application/wasm',
};

// Every handler window, so the app can tell them from its own: they are never
// shown, and must not keep the app open or be brought to the front.
const hostWindows = new WeakSet();
const isHostWindow = win => hostWindows.has(win);

function isInside(root, candidate) {
	const rel = path.relative(root, candidate);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The file a mod-host:// URL names, if it is a real file inside `root`.
function fileFor(root, url) {
	let parsed;
	try { parsed = new URL(url); } catch { return null; }
	if (parsed.protocol !== `${SCHEME}:` || parsed.host !== 'mod') return null;
	let parts;
	try { parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
	if (!parts.length || parts[0] === RESERVED || parts.some(p => p === '.' || p === '..' || /[\\/:\0]/.test(p))) return null;
	let file;
	try { file = fs.realpathSync(path.join(root, ...parts)); } catch { return null; }
	if (!isInside(root, file)) return null;
	try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
	return file;
}

// The network allow-list, as the session filter applies it to every request
// the renderer makes, redirects included: the mod's own scheme, and http(s)
// URLs whose origin is exactly one the host consented to. Everything else --
// other hosts and ports, ws:/wss:, file:, data:, blob:, ftp: -- is cancelled.
function allowedRequest(url, connect) {
	let parsed;
	try { parsed = new URL(url); } catch { return false; }
	if (parsed.protocol === `${SCHEME}:`) return parsed.host === 'mod';
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
	return connect.includes(parsed.origin);
}

function csp(connect) {
	return [
		"default-src 'none'",
		"script-src 'self'",
		`connect-src 'self' ${connect.join(' ')}`.trim(),
		"base-uri 'none'",
		"form-action 'none'",
		"frame-src 'none'",
		"worker-src 'none'",
		"object-src 'none'",
	].join('; ');
}

// The loader: takes requests from the bridge before the mod's module has even
// started loading, so none is dropped, and hands each to its default export.
function bootScript(decl) {
	const entry = `${ORIGIN}/${decl.entry.split('/').map(encodeURIComponent).join('/')}`;
	return `const bridge = globalThis.ragnarokModHost;
const host = Object.freeze({
	name: ${JSON.stringify(decl.name)},
	connect: Object.freeze(${JSON.stringify(decl.connect)}),
	log: (...parts) => bridge.log(parts.map(part => typeof part === 'string' ? part : (() => { try { return JSON.stringify(part); } catch { return String(part); } })()).join(' ')),
});
let handle = null, failure = null;
const loaded = import(${JSON.stringify(entry)}).then(module => {
	if (typeof module.default !== 'function') throw new Error('the host entry must default-export a function');
	handle = module.default;
}).catch(error => { failure = error; bridge.log('could not load: ' + (error && error.stack || error)); });
bridge.onRequest(async (id, request) => {
	await loaded;
	try {
		if (failure) throw failure;
		bridge.respond(id, await handle(request, host));
	} catch (error) { bridge.fail(id, String(error && error.stack || error)); }
});
bridge.ready();
`;
}

function create({ BrowserWindow, session, preload, log }) {
	// One runner per mod: the manager asks for a new one after a crash, a hang,
	// or a change to the mod or its consent, and destroys the old one.
	return function transport(decl) {
		const note = text => log(decl.name, text);
		const partition = `mod-host:${decl.name}`; // no "persist:": in memory only
		const ses = session.fromPartition(partition);
		const page = csp(decl.connect);
		if (ses.protocol.isProtocolHandled(SCHEME)) ses.protocol.unhandle(SCHEME);
		ses.protocol.handle(SCHEME, async request => {
			const headers = { 'content-security-policy': page, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
			const url = new URL(request.url);
			if (url.host === 'mod' && url.pathname === `/${RESERVED}/index.html`) {
				return new Response(`<!doctype html><meta charset="utf-8"><script type="module" src="/${RESERVED}/boot.js"></script>`,
					{ headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
			}
			if (url.host === 'mod' && url.pathname === `/${RESERVED}/boot.js`) {
				return new Response(bootScript(decl), { headers: { ...headers, 'content-type': 'text/javascript; charset=utf-8' } });
			}
			const found = fileFor(decl.root, request.url);
			if (!found) return new Response('Not found', { status: 404, headers });
			const type = TYPES[path.extname(found).toLowerCase()] || 'application/octet-stream';
			return new Response(await fs.promises.readFile(found), { headers: { ...headers, 'content-type': type } });
		});
		ses.webRequest.onBeforeRequest((details, callback) => {
			const ok = allowedRequest(details.url, decl.connect);
			if (!ok) note(`blocked ${details.url.slice(0, 200)}`);
			callback({ cancel: !ok });
		});
		// The page is mod-host://mod, so every request to a consented origin is
		// cross-origin, and a local service such as llama.cpp's need not send
		// CORS headers. The filter above has already decided this request may
		// be made; the browser is told so, for those origins only.
		ses.webRequest.onHeadersReceived((details, callback) => {
			let origin = null;
			try { origin = new URL(details.url).origin; } catch { /* not a URL */ }
			if (!origin || !decl.connect.includes(origin)) return callback({});
			const responseHeaders = Object.fromEntries(Object.entries(details.responseHeaders || {})
				.filter(([name]) => !name.toLowerCase().startsWith('access-control-') && name.toLowerCase() !== 'set-cookie'));
			responseHeaders['access-control-allow-origin'] = ['*'];
			responseHeaders['access-control-allow-headers'] = ['content-type, accept, authorization'];
			responseHeaders['access-control-allow-methods'] = ['GET, POST, PUT, DELETE'];
			callback(details.method === 'OPTIONS' ? { responseHeaders, statusLine: 'HTTP/1.1 204 No Content' } : { responseHeaders });
		});
		ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
		ses.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });

		const win = new BrowserWindow({
			show: false,
			width: 200,
			height: 200,
			webPreferences: {
				preload,
				partition,
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				nodeIntegrationInWorker: false,
				nodeIntegrationInSubFrames: false,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				navigateOnDragDrop: false,
				spellcheck: false,
				devTools: false,
				// Hidden, so Chromium would otherwise slow its timers right down.
				backgroundThrottling: false,
			},
		});
		hostWindows.add(win);
		const contents = win.webContents;
		contents.setAudioMuted(true);
		contents.setWindowOpenHandler(() => ({ action: 'deny' }));
		for (const event of ['will-navigate', 'will-redirect', 'will-attach-webview']) contents.on(event, e => e.preventDefault());
		contents.on('will-frame-navigate', e => e.preventDefault());

		let dead = false, seq = 0, markReady;
		const ready = new Promise(resolve => { markReady = resolve; });
		const pending = new Map(); // id -> { resolve, reject, timer }
		const settle = (id, fn) => {
			const call = pending.get(id);
			if (!call) return;
			pending.delete(id); clearTimeout(call.timer); fn(call);
		};
		const end = reason => {
			if (dead) return;
			dead = true;
			markReady(); // a call still waiting for the page now fails at once
			for (const id of [...pending.keys()]) settle(id, call => call.reject(new Error(reason)));
			if (!win.isDestroyed()) win.destroy();
			if (ses.protocol.isProtocolHandled(SCHEME)) ses.protocol.unhandle(SCHEME);
			ses.clearStorageData().catch(() => {});
		};
		// Only the window's own main frame may answer; anything sent from
		// elsewhere is ignored.
		const own = event => event.senderFrame && event.senderFrame === contents.mainFrame;
		contents.ipc.on('mod-host:ready', event => { if (own(event)) markReady(); });
		contents.ipc.on('mod-host:response', (event, id, response) => { if (own(event)) settle(id, call => call.resolve(response)); });
		contents.ipc.on('mod-host:fail', (event, id, message) => { if (own(event)) settle(id, call => call.reject(new Error(String(message).slice(0, 2000)))); });
		contents.ipc.on('mod-host:log', (event, text) => { if (own(event)) note(String(text)); });
		// The page's CSP refuses an undeclared address before the session filter
		// ever sees it, and says so only on the page's console. Carried to the
		// log, so the host can see what a handler tried to reach.
		// Chromium words each refusal twice; one line is enough.
		let lastRefused = '';
		contents.on('console-message', (event, _level, message) => {
			// The event carries the message since Electron 35; the argument is the deprecated form.
			const text = String(typeof event?.message === 'string' ? event.message : message || '');
			const refused = /^Refused to (?:connect to|load) '([^']{1,300})'.*Content Security Policy/.exec(text);
			if (!refused || refused[1] === lastRefused) return;
			lastRefused = refused[1];
			setTimeout(() => { if (lastRefused === refused[1]) lastRefused = ''; }, 1000);
			note(`blocked ${refused[1]} (Content-Security-Policy)`);
		});
		contents.on('render-process-gone', (_e, details) => { note(`renderer stopped (${details.reason}); it restarts on the next request`); end('the renderer stopped'); });
		contents.on('unresponsive', () => { note('renderer stopped responding; it restarts on the next request'); end('the renderer stopped responding'); });
		win.on('closed', () => end('closed'));

		contents.loadURL(`${ORIGIN}/${RESERVED}/index.html`).catch(error => { note(`could not load: ${error.message}`); end('could not load'); });
		note(`started; may connect to ${decl.connect.join(', ') || 'nothing'}`);

		return {
			alive: () => !dead,
			destroy: () => end('stopped'),
			async call(request) {
				await ready;
				if (dead) throw new Error('the renderer stopped');
				const id = ++seq;
				return new Promise((resolve, reject) => {
					// The manager answers 504 at its own deadline; this only
					// makes sure a request never answered is not kept forever.
					const timer = setTimeout(() => settle(id, call => call.reject(new Error('no answer'))), 60000);
					pending.set(id, { resolve, reject, timer });
					contents.send('mod-host:request', id, request);
				});
			},
		};
	};
}

module.exports = { create, isHostWindow, schemePrivileges, allowedRequest, fileFor, csp, bootScript, SCHEME, ORIGIN };
