'use strict';
// "Let an AI agent play with me" (#187): everything the setting turns on.
//
//   - the local API (agent-api.js), on while the setting is;
//   - <state>/agent/: connection.json (port + token, readable only by the
//     user), a `ragnarok-agent` launcher for the CLI, and AGENT.md, the guide
//     an agent is pointed at;
//   - one game window per agent, made the first time a command for that agent
//     arrives, logged in as its own account on the player's own server.
//
// Up to four agents can play at once, so a player can party with several.
// Each is a slot: agent 1 is the account `aiagent` at /mcp, agent n is
// `aiagent<n>` at /mcp/<n>. They share one token and one listener.
//
// The windows have no preload and each its own session, so the page in one
// cannot reach the app, and its client cache and settings are its own. They
// are muted: the player hears their own game.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AgentDriver } = require('./agent-driver');
const { createAgentApi } = require('./agent-api');

const PARTITION = 'persist:ai-agent';
const DEFAULT_PORT = 7490;
const MAX_AGENTS = 4;

const accountName = n => (n === 1 ? 'aiagent' : `aiagent${n}`);
const mcpPath = n => (n === 1 ? '/mcp' : `/mcp/${n}`);

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

// A file only the user can read. POSIX mode bits; on Windows the state folder
// is under the user's own profile, whose ACL already says the same.
function writePrivate(file, text) {
	const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, text, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

/**
 * @param {object} deps
 *   BrowserWindow, stateDir(), stackBin(), gameBase() -> 'http://127.0.0.1:3338',
 *   port() -> the agent API's preferred port (7490 unless overridden),
 *   gamePath, runAccount(request) -> Promise, era() -> 'renewal'|'prerenewal',
 *   hosting() -> bool (false when this app joins someone else's server),
 *   icon, log(text)
 */
function createAgentPlay(deps) {
	const dir = () => path.join(deps.stateDir(), 'agent');
	const connectionFile = () => path.join(dir(), 'connection.json');
	let api = null, port = null, token = null;
	let visible = true, count = 1;
	// n -> { win, driver, credentials, opening }
	const slots = new Map();
	const slot = n => { if (!slots.has(n)) slots.set(n, {}); return slots.get(n); };
	const open = s => Boolean(s.win && !s.win.isDestroyed());

	function readConnection() {
		try { return JSON.parse(fs.readFileSync(connectionFile(), 'utf8')); } catch { return null; }
	}

	function launcher() {
		const bin = deps.stackBin();
		if (process.platform === 'win32') {
			const file = path.join(dir(), 'ragnarok-agent.cmd');
			fs.writeFileSync(file, `@echo off\r\nset "RAGNAROKMAC_STATE=${deps.stateDir()}"\r\n"${bin}" agent %*\r\n`);
			return file;
		}
		const file = path.join(dir(), 'ragnarok-agent');
		fs.writeFileSync(file, `#!/bin/sh\n# Ragnarok Offline's AI agent command line. See AGENT.md beside this file.\nRAGNAROKMAC_STATE=${shellQuote(deps.stateDir())} exec ${shellQuote(bin)} agent "$@"\n`, { mode: 0o755 });
		try { fs.chmodSync(file, 0o755); } catch { /* ignore */ }
		return file;
	}

	function writeConnection() {
		writePrivate(connectionFile(), JSON.stringify({
			port, token,
			mcp: `http://127.0.0.1:${port}/mcp`,
			agents: Array.from({ length: count }, (_, i) => ({ agent: i + 1, account: accountName(i + 1), mcp: `http://127.0.0.1:${port}${mcpPath(i + 1)}` })),
			command: launcher(),
			guide: path.join(dir(), 'AGENT.md'),
		}, null, 2) + '\n');
	}

	async function start({ show = true, agents = 1 } = {}) {
		visible = show;
		const wanted = Math.max(1, Math.min(MAX_AGENTS, Number(agents) || 1));
		// Fewer agents than before: close the ones no longer wanted.
		for (const [n, s] of slots) if (n > wanted) { if (open(s)) s.win.destroy(); slots.delete(n); }
		count = wanted;
		for (const s of slots.values()) if (open(s)) { if (visible) s.win.show(); else s.win.hide(); }
		if (api) { writeConnection(); return info(); }
		fs.mkdirSync(dir(), { recursive: true });
		const previous = readConnection();
		// The same token and port as last time, so an agent set up once keeps
		// working across restarts; replaceToken() is how to revoke it.
		token = previous?.token && /^[0-9a-f]{64}$/.test(previous.token) ? previous.token : crypto.randomBytes(32).toString('hex');
		const make = () => createAgentApi({ run, token, agents: () => count, log: deps.log });
		api = make();
		port = null;
		// A port set for this copy (RAGNAROK_OFFLINE_AGENT_PORT) comes first;
		// otherwise last time's, then the usual one, then any free one.
		const configured = deps.port ? deps.port() : DEFAULT_PORT;
		const candidates = configured !== DEFAULT_PORT ? [configured, previous?.port, 0] : [previous?.port, DEFAULT_PORT, 0];
		for (const candidate of candidates.filter(p => p !== undefined && p !== null)) {
			try { port = await api.listen(candidate); break; } catch { api.server.close(); api = make(); }
		}
		if (!port) { api = null; throw new Error('Could not open a local port for the agent.'); }
		writeConnection();
		try { fs.copyFileSync(path.join(__dirname, 'AGENT.md'), path.join(dir(), 'AGENT.md')); } catch (e) { deps.log(`agent: could not write AGENT.md: ${e.message}`); }
		deps.log(`agent play on: ${count} agent(s), listening on 127.0.0.1:${port}`);
		return info();
	}

	async function stop({ disableAccount = true } = {}) {
		for (const s of slots.values()) if (open(s)) s.win.destroy();
		slots.clear();
		if (api) { await api.close().catch(() => {}); api = null; }
		// The file is how the CLI knows the agent is on; the token stays valid
		// only while it is there.
		fs.rmSync(connectionFile(), { force: true });
		if (disableAccount && deps.hosting()) {
			await deps.runAccount({ action: 'agent-disable', era: deps.era() }).catch(e => deps.log(`agent: could not disable the accounts: ${e.message}`));
		}
		deps.log('agent play off');
	}

	async function replaceToken() {
		const show = visible, agents = count;
		await stop({ disableAccount: false });
		fs.mkdirSync(dir(), { recursive: true });
		writePrivate(connectionFile(), JSON.stringify({ port }, null, 2));
		return start({ show, agents });
	}

	function info() {
		const c = readConnection() || {};
		const agents = (c.agents || []).map(a => ({
			...a,
			playing: open(slot(a.agent)),
			claudeCommand: `claude mcp add --transport http ${a.agent === 1 ? 'ragnarok-offline' : `ragnarok-offline-${a.agent}`} ${a.mcp} --header "Authorization: Bearer ${c.token}"`,
		}));
		return {
			on: Boolean(api),
			port: c.port, mcp: c.mcp, command: c.command, guide: c.guide, folder: dir(), connection: connectionFile(),
			token: c.token, agents, count,
			windowOpen: agents.some(a => a.playing),
			claudeCommand: agents[0]?.claudeCommand || null,
		};
	}

	// An agent's window, made on first use. Its account is (re)keyed each
	// time with a fresh password that is never written down.
	async function ensureWindow(n) {
		const s = slot(n);
		if (open(s) && s.driver) return s.driver;
		if (s.opening) return s.opening;
		s.opening = (async () => {
			if (!deps.hosting()) throw new Error('The player is joining someone else\'s server; an AI agent can only play on the player\'s own server.');
			const base = deps.gameBase();
			const up = await fetch(base, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false);
			if (!up) throw new Error('The game server is not running. Ask the player to press Play in Ragnarok Offline, then try again.');
			const password = crypto.randomBytes(12).toString('hex');
			// The account change queues behind anything else the supervisor is
			// doing (a start, a backup); wait for it rather than fail.
			for (let attempt = 0; ; attempt++) {
				try { await deps.runAccount({ action: 'agent', agent: String(n), era: deps.era(), password }); break; } catch (e) {
					if (!/operation is in progress/i.test(e.message) || attempt >= 24) throw e;
					await new Promise(r => setTimeout(r, 5000));
				}
			}
			s.credentials = { user: accountName(n), pass: password };

			const win = new deps.BrowserWindow({
				width: 1280, height: 800, useContentSize: true,
				show: visible,
				title: `AI agent${n > 1 ? ` ${n}` : ''} — Ragnarok Offline`,
				icon: deps.icon,
				webPreferences: {
					partition: n === 1 ? PARTITION : `${PARTITION}-${n}`,
					contextIsolation: true,
					nodeIntegration: false,
					sandbox: true,
					// The agent plays whether or not its window is in front, or
					// shown at all.
					backgroundThrottling: false,
				},
			});
			s.win = win;
			// Muted: the player hears their own game, not another copy of its
			// music and sounds from a window they may not even see.
			win.webContents.setAudioMuted(true);
			win.on('page-title-updated', e => e.preventDefault());
			win.webContents.on('will-prevent-unload', e => e.preventDefault());
			win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			const allowed = new URL(base).origin;
			const guard = event => {
				try { if (new URL(event.url).origin !== allowed) event.preventDefault(); } catch { event.preventDefault(); }
			};
			win.webContents.on('will-navigate', guard);
			win.webContents.on('will-redirect', guard);
			win.on('closed', () => { if (slots.get(n) === s) { s.win = null; s.driver = null; } });
			const driver = new AgentDriver(win.webContents, { shotsDir: path.join(dir(), 'screenshots', `agent${n}`), credentials: async () => s.credentials });

			await win.loadURL(base + deps.gamePath);
			// The client's agent hook (window.roAgent) installs only when the
			// page opted in before it booted. This session is the agent's
			// own, so set the switch once and boot again; it persists.
			const hooked = await win.webContents.executeJavaScript(`localStorage.getItem('roAgent') === '1'`).catch(() => false);
			if (!hooked) {
				await win.webContents.executeJavaScript(`localStorage.setItem('roAgent', '1')`);
				await win.loadURL(base + deps.gamePath);
			}
			await driver.installHooks();
			// A reload (the player pressing F5 in a visible window) loses them.
			win.webContents.on('did-finish-load', () => driver.installHooks());
			s.driver = driver;
			deps.log(`agent ${n}: game window open`);
			return driver;
		})();
		try { return await s.opening; } catch (e) {
			if (open(s)) s.win.destroy();
			s.win = null; s.driver = null;
			throw e;
		} finally { s.opening = null; }
	}

	async function run(cmd, args, n = 1) {
		if (!(n >= 1 && n <= count)) throw new Error(`there is no agent ${n}; the player allowed ${count}`);
		if (cmd === 'status' && !open(slot(n))) return { ok: true, agent: n, account: accountName(n), window: false, next: 'login opens this agent\'s game window' };
		const d = await ensureWindow(n);
		return d.commands()[cmd](args);
	}

	function setVisible(show) {
		visible = show;
		for (const s of slots.values()) if (open(s)) { if (show) s.win.show(); else s.win.hide(); }
	}

	return { start, stop, info, replaceToken, setVisible, running: () => Boolean(api) };
}

module.exports = { createAgentPlay, accountName, MAX_AGENTS };
