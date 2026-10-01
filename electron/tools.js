'use strict';
// Settings -> Tools (#195): small pages that help while making mods, opened
// in their own windows and fed from the running server.
//
// The pages are self-contained HTML (tools/<id>/), written to work from a
// folder with files dropped on them. Here they are served from the app under
// ro-tool://<id>/, and the files they would look for next to themselves are
// answered from the server instead, so nothing needs extracting by hand and
// nothing needs Python:
//
//   ro-tool://mob-browser/mob_db.yml        ragnarok-stack export-table mob_db
//   ro-tool://mob-browser/item_db_*.yml     ... item_db_equip / _etc / _usable
//   ro-tool://item-browser/itemInfo.lua     the client's item table, as served
//   http://127.0.0.1:3338/item-icons.js     AegisName -> icon, built here
//   ro-tool://mob-browser/monster-sprites.json  monster id -> sprite name
//   ro-tool://mob-browser/sprite/<name>.spr|act the monster's sprite, from the
//                                            asset server (so it is same-origin)
//   ro-tool://db-browser/api/<call>          the database browser's bridge,
//                                            see db-bridge.js
//
// The tables come with the mods' db/import laid over them, so a mod's
// monsters and items show up too. Each window has its own session and no
// preload: a tool page cannot reach the app.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// A client table, as text: the translation's are UTF-8, older ones and many
// a mod's are CP949 (EUC-KR). Decoded one file at a time, since the item
// tables below mix the two.
function decode(buf) {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}

const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]);

// What the generated client config says -- the same lists the game reads.
function clientConfig(web) {
	try { return fs.readFileSync(path.join(web, 'Config.local.js'), 'utf8'); } catch { return ''; }
}

/**
 * The client's item tables, mods' included, as one text. The client lists
 * them newest mod first and base last, and keeps the *first* definition of an
 * item; the Tools pages keep the *last* one they parse. So they are joined in
 * the reverse order, and a mod's item -- new or renamed -- shows as it does in
 * game. `web` is the served asset root (state/assets).
 */
function clientItemInfo(web) {
	const listed = /customItemInfo:\s*\[([^\]]*)\]/.exec(clientConfig(web));
	// With no mod item tables the config names none, and the client reads the
	// first base table it finds.
	const base = ['System/itemInfo.lua', 'System/itemInfo.lub', 'System/itemInfo_true.lua', 'System/itemInfo_true.lub'];
	const exists = rel => fs.existsSync(path.join(web, rel));
	const tables = listed ? quoted(listed[1]).filter(exists) : base.filter(exists).slice(0, 1);
	if (tables.length === 0) throw new Error('The client\'s item table is not there yet. Start the game once, then try again.');
	return Buffer.from(tables.reverse().map(rel => decode(fs.readFileSync(path.join(web, rel)))).join('\n'), 'utf8');
}

/**
 * Mods' monster sprite tables (customLuaTables.monster: an npcidentity-style
 * id file and a jobname-style name file each), as id -> sprite name, later
 * mods over earlier ones as the client merges them.
 */
function clientMonsterSprites(web) {
	const tables = /customLuaTables:\s*\{([^\n]*)\}/.exec(clientConfig(web));
	const listed = tables && /monster:\s*\[((?:\s*\[[^\]]*\]\s*,?)*)\]/.exec(tables[1]);
	const out = {};
	if (!listed) return out;
	const read = f => { try { return decode(fs.readFileSync(f)); } catch { return ''; } };
	for (const pair of listed[1].matchAll(/\[([^\]]*)\]/g)) {
		const [idFile, nameFile] = quoted(pair[1]).map(rel => path.join(web, rel));
		const ids = {};
		for (const m of read(idFile).matchAll(/\b(JT_[A-Za-z0-9_]+)\s*=\s*(\d+)/g)) ids[m[1]] = m[2];
		for (const m of read(nameFile).matchAll(/\[\s*(?:jobtbl\.)?([A-Za-z0-9_]+)\s*\]\s*=\s*"([^"]+)"/g)) {
			const id = /^\d+$/.test(m[1]) ? m[1] : ids[m[1]];
			if (id) out[id] = m[2];
		}
	}
	return out;
}

const SCHEME = 'ro-tool';
const PARTITION = 'persist:ro-tools';
const ROOT = path.join(__dirname, '..', 'tools');

const TOOLS = [
	{
		id: 'item-browser',
		name: 'Item browser',
		description: 'Every item the game client knows: names, descriptions, icons and slots, grouped by type.',
		page: 'item-browser.html',
		author: 'BlaXun',
	},
	{
		id: 'mob-browser',
		name: 'Monster browser',
		description: 'Every monster on your server, mods included: stats, skills, drops with their icons, MVPs.',
		page: 'mob-browser.html',
		author: 'BlaXun',
		needsServer: true,
	},
	{
		id: 'log-viewer',
		name: 'Log viewer',
		description: 'The game client, the servers, the app and the engine, logging live as you play: for debugging a mod or an NPC script.',
		page: 'log-viewer.html',
		author: 'Ragnarok Offline',
	},
	{
		id: 'db-browser',
		name: 'Database',
		description: 'Browse the server\'s database table by table, and edit rows: characters, inventories, accounts. Saving stops the game for a few seconds and takes a backup first.',
		page: 'db-browser.html',
		needsServer: true,
	},
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.lua': 'application/octet-stream', '.png': 'image/png', '.json': 'application/json' };

// Registered before the app is ready: a standard, secure scheme, so relative
// URLs and fetch() work in the pages the way they would over HTTP.
const schemePrivileges = { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } };

/**
 * @param {object} deps
 *   BrowserWindow, session, net, shell, stackBin(), stackEnv(), stateDir(), runtimeDir(), log(text), icon
 *   and, for the log viewer: nebulaLogsDir(), redact(text), openGameDevTools()
 */
// The asset origin the tool pages name (ASSET_ORIGIN in tools/*/*.html). A
// copy whose asset server was moved (electron/ports.js) answers somewhere
// else, so requests to this one are sent on to wherever that is.
const PAGE_ASSET_HOST = '127.0.0.1:3338';

function createTools(deps) {
	const assetHost = () => `127.0.0.1:${deps.assetPort ? deps.assetPort() : 3338}`;
	const isAsset = url => url.host === PAGE_ASSET_HOST || url.host === assetHost();
	const toAsset = href => { const url = new URL(href); url.host = assetHost(); return url.toString(); };
	const windows = new Map();
	// Converted icons, by path: the item list asks for hundreds at a time.
	const pngCache = new Map();
	let handlersReady = false;
	const dbBridge = require('./db-bridge').createDbBridge(deps);

	function exportTable(name) {
		const { cwd, env } = deps.stackEnv();
		return new Promise((resolve, reject) => {
			execFile(deps.stackBin(), ['export-table', name], { cwd, env, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (error) reject(new Error((stderr || '').trim() || error.message));
				else resolve(stdout);
			});
		});
	}

	const itemInfo = () => clientItemInfo(path.join(deps.stateDir(), 'assets'));
	const modMonsterSprites = () => clientMonsterSprites(path.join(deps.stateDir(), 'assets'));

	// AegisName -> icon name, for the monster browser's drops: the server's
	// item tables give AegisName -> id, the client's gives id -> icon.
	async function itemIcons() {
		const ids = new Map();
		for (const table of ['item_db_equip', 'item_db_etc', 'item_db_usable']) {
			const text = await exportTable(table);
			for (const m of text.matchAll(/(?:^|\n) {2}- Id:\s*(\d+)([\s\S]*?)(?=\n {2}- Id:|\n\S|$)/g)) {
				const aegis = /\bAegisName:\s*(\S+)/.exec(m[2]);
				if (aegis) ids.set(aegis[1], Number(m[1]));
			}
		}
		const raw = itemInfo();
		let text;
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { text = new TextDecoder('euc-kr').decode(raw); }
		const icons = new Map();
		for (const m of text.matchAll(/\[\s*(\d+)\s*\]\s*=\s*\{/g)) {
			const chunk = text.slice(m.index, m.index + 4000);
			const res = /\bidentifiedResourceName\s*=\s*"([^"]*)"/.exec(chunk);
			if (res && res[1]) icons.set(Number(m[1]), res[1]);
		}
		const out = {};
		for (const [aegis, id] of ids) if (icons.has(id)) out[aegis] = icons.get(id);
		return 'window.__mobItemIcons=' + JSON.stringify(out) + ';if(window.__mobItemIconsReady)window.__mobItemIconsReady();\n';
	}

	// The client's monster id -> sprite name table (roBrowser's
	// DB/Monsters/MonsterTable.js, shipped beside the client by package.sh).
	let monsterSprites = null;
	function monsterTable() {
		if (monsterSprites) return { ...monsterSprites, ...modMonsterSprites() };
		const candidates = [
			path.join(deps.runtimeDir(), 'client-tables', 'MonsterTable.js'),
			// Running from source before package.sh has been run.
			path.join(__dirname, '..', 'vendor', 'roBrowserLegacy', 'src', 'DB', 'Monsters', 'MonsterTable.js'),
		];
		const file = candidates.find(f => fs.existsSync(f));
		if (!file) throw new Error('The client\'s monster table is missing from this build.');
		const out = {};
		for (const m of fs.readFileSync(file, 'utf8').matchAll(/^\s*(\d+)\s*:\s*'([^']+)'/gm)) out[m[1]] = m[2];
		// Mods' new monsters over the built-in table, as the client merges them.
		// Not cached with the built-ins: a mod can be switched on while the
		// window is open.
		monsterSprites = out;
		return { ...out, ...modMonsterSprites() };
	}

	// The log viewer (#202): its stream, and the two things it may ask of the
	// app. See log-stream.js.
	let logStreams = null;
	async function logViewerRoute(name, url, request) {
		if (name === 'stream') {
			if (!logStreams) {
				logStreams = require('./log-stream').createLogStreams({
					stateDir: deps.stateDir, nebulaLogsDir: deps.nebulaLogsDir,
					stackBin: deps.stackBin, stackEnv: deps.stackEnv, redact: deps.redact,
				});
			}
			return logStreams.response(url);
		}
		if (name === 'sources.json') return respond(JSON.stringify(require('./log-stream').SOURCES.map(({ id, name }) => ({ id, name }))), TYPES['.json']);
		if (name === 'mods.json') {
			// The enabled mods' names, for the badges on lines that name one.
			const { cwd, env } = deps.stackEnv();
			const rows = await new Promise(resolve => execFile(deps.stackBin(), ['mods'], { cwd, env, timeout: 30000 }, (error, stdout) => resolve(error ? '' : stdout)));
			const on = rows.split('\n').map(l => l.split('\t')).filter(r => r[0] === 'on' && r[1]).map(r => r[1]);
			return respond(JSON.stringify(on), TYPES['.json']);
		}
		if (name === 'api/devtools') {
			if (request.method !== 'POST') return respond('POST only', 'text/plain', 405);
			deps.openGameDevTools();
			return respond('{}', TYPES['.json']);
		}
		return null;
	}

	function respond(body, type, status = 200) {
		return new Response(body, { status, headers: { 'content-type': type, 'cache-control': 'no-store' } });
	}

	function setupSession() {
		if (handlersReady) return;
		const ses = deps.session.fromPartition(PARTITION);
		ses.protocol.handle(SCHEME, async request => {
			const url = new URL(request.url);
			const tool = TOOLS.find(t => t.id === url.hostname);
			if (!tool) return respond('no such tool', 'text/plain', 404);
			const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
			try {
				if (tool.id === 'log-viewer') {
					const answer = await logViewerRoute(name, url, request);
					if (answer) return answer;
				}
				if (tool.id === 'db-browser' && name.startsWith('api/')) return await dbBridge(request, name.slice(4));
				if (name === 'mob_db.yml' || /^item_db_(equip|etc|usable)\.yml$/.test(name)) {
					return respond(await exportTable(name.replace(/\.yml$/, '')), TYPES['.yml']);
				}
				if (name === 'itemInfo.lua') return respond(itemInfo(), TYPES['.lua']);
				if (name === 'monster-sprites.json') return respond(JSON.stringify(monsterTable()), TYPES['.json']);
				const sprite = /^sprite\/([^/]+)\.(spr|act)$/.exec(name);
				if (sprite) {
					// data/sprite/몬스터/ ("monster"): the asset server resolves the
					// Korean folder and the GRFs' lowercase names.
					const url = `http://${assetHost()}/data/sprite/${encodeURIComponent('몬스터')}/${encodeURIComponent(sprite[1].toLowerCase())}.${sprite[2]}`;
					const res = await deps.net.fetch(url, { bypassCustomProtocolHandlers: true });
					if (!res.ok) return respond(`no sprite ${sprite[1]}`, 'text/plain', 404);
					return respond(Buffer.from(await res.arrayBuffer()), 'application/octet-stream');
				}
				// The tool's own files, and nothing outside its folder.
				const dir = path.join(ROOT, tool.id);
				const file = path.resolve(dir, name || tool.page);
				if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return respond('not found', 'text/plain', 404);
				return respond(fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
			} catch (e) {
				deps.log(`tools: ${tool.id} ${name}: ${e.message}`);
				return respond(e.message, 'text/plain', 503);
			}
		});
		// The monster browser loads its icon map from the asset server, where
		// the old extraction script used to leave it. Answer that one URL here
		// and let everything else through.
		ses.protocol.handle('http', async request => {
			const url = new URL(request.url);
			if (isAsset(url) && url.pathname === '/item-icons.js') {
				try { return respond(await itemIcons(), TYPES['.js']); } catch (e) {
					deps.log(`tools: item icons: ${e.message}`);
					return respond('/* ' + e.message.replace(/\*\//g, '') + ' */', TYPES['.js'], 503);
				}
			}
			// The game's .bmp pictures, with their magenta turned transparent.
			if (isAsset(url) && /\.bmp$/i.test(url.pathname)) {
				const key = url.pathname;
				if (!pngCache.has(key)) {
					const res = await deps.net.fetch(toAsset(request.url), { bypassCustomProtocolHandlers: true });
					if (!res.ok) return res;
					const original = Buffer.from(await res.arrayBuffer());
					const png = require('./bmp').bmpToPng(original);
					if (pngCache.size > 5000) pngCache.clear();
					pngCache.set(key, png ? { body: png, type: 'image/png' } : { body: original, type: 'image/bmp' });
				}
				const hit = pngCache.get(key);
				return new Response(hit.body, { headers: { 'content-type': hit.type, 'cache-control': 'max-age=3600' } });
			}
			// The pages only read from the asset server, so a moved one is a GET.
			if (isAsset(url) && url.host !== assetHost()) return deps.net.fetch(toAsset(request.url), { bypassCustomProtocolHandlers: true });
			return deps.net.fetch(request, { bypassCustomProtocolHandlers: true });
		});
		handlersReady = true;
	}

	async function open(id) {
		const tool = TOOLS.find(t => t.id === id);
		if (!tool) throw new Error(`No tool called ${id}`);
		const existing = windows.get(id);
		if (existing && !existing.isDestroyed()) { existing.focus(); return; }
		setupSession();
		const ses = deps.session.fromPartition(PARTITION);
		// The pages cache what they parsed and restore it before looking for
		// anything newer. Start them clean, so a mod added since shows up.
		await ses.clearStorageData({ storages: ['indexdb'] }).catch(() => {});
		const win = new deps.BrowserWindow({
			width: 1280, height: 860,
			title: `${tool.name} — Ragnarok Offline`,
			icon: deps.icon,
			webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
		});
		windows.set(id, win);
		win.on('closed', () => {
			windows.delete(id);
			// Stop following logs with no viewer left to show them.
			if (id === 'log-viewer' && logStreams) logStreams.stopAll();
		});
		win.on('page-title-updated', e => e.preventDefault());
		win.webContents.setWindowOpenHandler(({ url }) => {
			// Links out (rAthena docs, GitHub) open in the browser, not here.
			if (/^https?:\/\//.test(url)) deps.shell.openExternal(url);
			return { action: 'deny' };
		});
		win.webContents.on('will-navigate', event => {
			if (!event.url.startsWith(`${SCHEME}://${id}/`)) event.preventDefault();
		});
		await win.loadURL(`${SCHEME}://${id}/${tool.page}`);
	}

	return {
		list: () => TOOLS.map(({ id, name, description, author, needsServer }) => ({ id, name, description, author, needsServer: !!needsServer })),
		open,
	};
}

module.exports = { createTools, schemePrivileges, SCHEME, TOOLS, clientItemInfo, clientMonsterSprites };
