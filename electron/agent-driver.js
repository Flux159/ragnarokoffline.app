'use strict';
// Plays the game in one window for an AI agent (#187).
//
// The commands are scripts/rotest's, moved from Playwright onto what Electron
// already has: executeJavaScript for page.evaluate, sendInputEvent for the
// mouse and keyboard (real input, so the client's own code paths run), and
// capturePage for screenshots. docs/AGENT_TESTING.md describes the harness
// these came from; resources/AGENT.md is what an agent reads.
//
// Deliberately missing next to rotest: `eval` and the GM helpers. The agent's
// window has no preload, so nothing in it can reach the app, and the agent's
// account is a player's; everything else it does, the server authorises.

const fs = require('node:fs');
const path = require('node:path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Shared page-side helpers, prepended to every script: a query that walks open
// shadow roots (roBrowser's windows are custom elements with one), and what
// counts as visible.
const PAGE_HELPERS = `
const __deep = (selector) => {
	const out = [];
	const walk = root => {
		root.querySelectorAll(selector).forEach(e => out.push(e));
		root.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); });
	};
	walk(document);
	return out;
};
const __visible = e => {
	if (!e || !e.isConnected) return false;
	const r = e.getBoundingClientRect();
	if (r.width <= 0 || r.height <= 0) return false;
	for (let n = e; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
		const s = getComputedStyle(n);
		if (s.display === 'none' || s.visibility === 'hidden') return false;
	}
	return true;
};
const __rect = e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
`;

// Electron's sendInputEvent key codes are accelerator names. The agent writes
// keys the way the harness did (Playwright's names: Enter, Escape, F1, Alt+E).
const KEY_ALIASES = { Esc: 'Escape', Return: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space' };
function parseKey(spec) {
	const parts = String(spec).split('+');
	const key = parts.pop();
	const modifiers = parts.map(m => ({ Control: 'control', Ctrl: 'control', Alt: 'alt', Shift: 'shift', Meta: 'meta', Cmd: 'meta' }[m] || m.toLowerCase()));
	return { keyCode: KEY_ALIASES[key] || (key.length === 1 ? key.toUpperCase() : key), char: key.length === 1 ? key : null, modifiers };
}

class AgentDriver {
	/**
	 * @param {Electron.WebContents} wc the agent's game page
	 * @param {object} opts { shotsDir, credentials: () => Promise<{user, pass}>,
	 *   commandPrefix?: () => string }
	 */
	constructor(wc, opts) {
		this.wc = wc;
		this.shotsDir = opts.shotsDir;
		this.credentials = opts.credentials;
		// Which character a server command starts with, for `state` to report.
		// A thunk so a change while an agent plays is picked up, and '@' when
		// nobody said -- what rAthena runs on unless the player chose otherwise.
		this.commandPrefix = opts.commandPrefix || (() => '@');
		this.errors = [];
		this.errorsSeen = 0;
		wc.on('console-message', (...a) => {
			// Electron 35 put the details on the event and deprecated the extra
			// arguments (level, message). Read the event, fall back to the arguments.
			const d = a[0] && typeof a[0].message === 'string' ? a[0] : { level: a[1], message: a[2] };
			const level = typeof d.level === 'number' ? d.level : { warning: 2, error: 3 }[d.level] || 0;
			// Warnings too: roBrowser reports an unhandled packet as a warning.
			if (level >= 2) this.record(level === 3 ? 'console' : 'warning', String(d.message).slice(0, 2000));
		});
		wc.on('render-process-gone', (_e, d) => this.record('crash', d.reason));
		wc.session.webRequest.onCompleted(details => {
			if (details.statusCode >= 400 && details.webContentsId === wc.id) {
				let p = details.url;
				try { p = new URL(details.url).pathname; } catch { /* keep the URL */ }
				this.record('http', `${details.statusCode} ${p}`);
			}
		});
	}
	record(kind, text) {
		this.errors.push({ at: Date.now(), kind, text });
		// A long session must not grow this without bound.
		if (this.errors.length > 2000) {
			this.errors.splice(0, 1000);
			this.errorsSeen = Math.max(0, this.errorsSeen - 1000);
		}
	}

	// ------------------------------------------------------------- the page

	eval(body, arg) {
		// `body` is one of ours, never the agent's: an async function body with
		// the helpers above in scope and `arg` as its argument.
		const src = `(async (arg) => { ${PAGE_HELPERS}\n${body}\n})(${JSON.stringify(arg ?? null)})`;
		return this.wc.executeJavaScript(src, true);
	}
	agent(fn, args = []) {
		return this.eval(`
			if (!window.roAgent) throw new Error('the game has not started yet (window.roAgent is missing)');
			return JSON.parse(JSON.stringify(window.roAgent[arg.fn](...arg.args) ?? null));`, { fn, args });
	}
	// What the client receives that the page does not keep in a readable
	// form: the character list (character select draws it on canvases) and
	// chat with who said it and on which channel. Both are taken from the
	// packets as the client logs them, and kept on the page. Idempotent; a
	// reloaded page needs it again.
	installHooks() {
		return this.eval(`
			if (window.__agentHooked) return;
			window.__agentHooked = true;
			window.__agentChars = {};
			window.__agentChat = [];
			const keep = c => { if (c && c.name !== undefined) window.__agentChars[c.CharNum ?? Object.keys(window.__agentChars).length] = { slot: c.CharNum ?? null, name: c.name, job: c.job, level: c.level ?? c.BaseLevel ?? null }; };
			const say = (channel, from, text) => {
				window.__agentChat.push({ at: Date.now(), channel, from, text });
				if (window.__agentChat.length > 500) window.__agentChat.splice(0, 100);
			};
			const split = msg => { const i = String(msg).indexOf(' : '); return i > 0 ? [msg.slice(0, i), msg.slice(i + 3)] : [null, String(msg)]; };
			const CHANNELS = [
				[/ZC_NOTIFY_PLAYERCHAT$/, 'local', true], [/ZC_NOTIFY_CHAT$/, 'local'], [/ZC_NOTIFY_CHAT_PARTY$/, 'party'],
				[/ZC_GUILD_CHAT$/, 'guild'], [/ZC_WHISPER[0-9]*$/, 'whisper'], [/ZC_BROADCAST[0-9]*$/, 'broadcast'], [/ZC_NPC_CHAT$/, 'npc'],
			];
			// What the client says by itself ("Insufficient SP", "You haven't
			// learned enough Basic Skills to Party.", item pickups), which never
			// comes as a chat packet: every line the chat box adds that a chat
			// packet did not just account for. Watched in the page because the
			// client's chat box is not reachable as an object from here.
			const watchBox = () => {
				const host = document.getElementById('ChatBox');
				const content = host?.shadowRoot?.querySelector('.content');
				if (!content) return false;
				new MutationObserver(records => {
					for (const r of records) for (const node of r.addedNodes) {
						const text = (node.textContent || '').trim();
						if (!text) continue;
						const recent = window.__agentChat.slice(-20).filter(m => Date.now() - m.at < 3000);
						if (recent.some(m => text === m.text || text === (m.from + ' : ' + m.text) || text.endsWith(m.text))) continue;
						say('client', null, text);
					}
				}).observe(content, { childList: true, subtree: false });
				return true;
			};
			if (!watchBox()) { const t = setInterval(() => { if (watchBox()) clearInterval(t); }, 1000); }
			const log = console.log;
			console.log = function (...args) {
				const p = args[2];
				if (typeof args[0] === 'string' && args[0].includes('Recv') && p) {
					try {
						if (Array.isArray(p.charInfo)) p.charInfo.forEach(keep);
						if (p.charinfo) keep(p.charinfo);
						const name = p.constructor?.name || '';
						const hit = CHANNELS.find(([re]) => re.test(name));
						if (hit && typeof p.msg === 'string') {
							if (hit[1] === 'whisper') say('whisper', p.sender || null, p.msg);
							else if (hit[1] === 'broadcast' || hit[1] === 'npc') say(hit[1], null, p.msg);
							else {
								const [from, text] = split(p.msg);
								// The server's own notices come on the player's chat
								// packet with no speaker.
								if (hit[2] && !from) say('system', null, text);
								else { say(hit[1], from, text); if (hit[2]) window.__agentChat[window.__agentChat.length - 1].self = true; }
							}
						}
					} catch { /* never break the client's own logging */ }
				}
				return log.apply(this, args);
			};`).catch(() => {});
	}
	// Chat since the agent last asked, oldest first.
	async newChat(all = false) {
		const since = all ? 0 : this.chatSeen || 0;
		const lines = await this.eval(`return (window.__agentChat || []).filter(m => m.at > arg);`, since).catch(() => []);
		if (lines.length) this.chatSeen = lines[lines.length - 1].at;
		return all ? lines.slice(-50) : lines;
	}
	// A box the game is waiting on: a yes/no question (WinPrompt: a party
	// invitation, a confirmation) or a message with one button (WinMSG:
	// "Disconnected from Server.").
	prompt() {
		return this.eval(`
			for (const id of ['WinPrompt', 'WinMSG']) {
				const host = __deep('#' + id).find(__visible);
				if (!host) continue;
				const buttons = [...host.shadowRoot.querySelectorAll('.btns > *')].filter(__visible);
				return { kind: buttons.length > 1 ? 'yes/no' : 'message', text: host.shadowRoot.querySelector('.text')?.innerText || '' };
			}
			return null;`).catch(() => null);
	}
	// Press a button on that box: the first (yes, ok) or the second (no).
	async pressPrompt(yes) {
		const at = await this.eval(`
			for (const id of ['WinPrompt', 'WinMSG']) {
				const host = __deep('#' + id).find(__visible);
				if (!host) continue;
				const buttons = [...host.shadowRoot.querySelectorAll('.btns > *')].filter(__visible);
				const b = buttons.length > 1 ? buttons[arg ? 0 : 1] : buttons[0];
				return b ? __rect(b) : null;
			}
			return null;`, yes);
		if (!at) return false;
		await this.click(at.x, at.y);
		await sleep(800);
		return true;
	}
	newErrors() { const e = this.errors.slice(this.errorsSeen); this.errorsSeen = this.errors.length; return e; }

	// Guarded: a settings.json the store refuses must not take `state` down
	// with it, and '@' is what the server falls back to in that case anyway.
	prefix() { try { return this.commandPrefix() || '@'; } catch { return '@'; } }
	async until(test, ms = 15000, step = 200) {
		const end = Date.now() + ms;
		while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(step); }
		return false;
	}
	inGame() {
		return this.eval(`const s = window.roClientDiagnostics?.snapshot();
			return Boolean(s?.map && s.input?.canMove && window.roAgent?.player());`).catch(() => false);
	}
	// In game and the camera set up: the player's own cell projects on screen.
	settled() {
		return this.until(async () => (await this.inGame()) && this.eval(`const me = window.roAgent.player();
			return Boolean(me && window.roAgent.project(Math.round(me.position[0]), Math.round(me.position[1])).onScreen);`), 60000, 300);
	}
	player() { return this.agent('player'); }

	// ------------------------------------------------------------- input

	async move(x, y) { this.wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) }); }
	async click(x, y, button = 'left', clickCount = 1) {
		x = Math.round(x); y = Math.round(y);
		this.wc.sendInputEvent({ type: 'mouseMove', x, y });
		await sleep(30);
		this.wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount });
		await sleep(30);
		this.wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount });
	}
	async dblclick(x, y) { await this.click(x, y, 'left', 1); await sleep(60); await this.click(x, y, 'left', 2); }
	async press(spec) {
		const { keyCode, char, modifiers } = parseKey(spec);
		this.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
		if (char && !modifiers.some(m => m === 'control' || m === 'alt' || m === 'meta')) this.wc.sendInputEvent({ type: 'char', keyCode: char, modifiers });
		await sleep(30);
		this.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
	}
	// Put text into the first visible element matching `selector`, the way
	// typing would leave it, and focus it for the Enter that follows.
	async fill(selector, text) {
		const ok = await this.eval(`
			const el = __deep(arg.selector).find(__visible);
			if (!el) return false;
			el.focus();
			if (el.isContentEditable) {
				// The chat line is an editable div, not an input.
				el.textContent = arg.text;
				const range = document.createRange();
				range.selectNodeContents(el);
				range.collapse(false);
				const sel = el.getRootNode().getSelection?.() || window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
			} else {
				const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
				setter ? setter.call(el, arg.text) : (el.value = arg.text);
			}
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return true;`, { selector, text });
		if (!ok) throw new Error(`nothing visible matches ${selector}`);
	}
	async clickSelector(selector, double = false) {
		const at = await this.eval(`const el = __deep(arg).find(__visible); return el ? __rect(el) : null;`, selector);
		if (!at) return false;
		if (double) await this.dblclick(at.x, at.y); else await this.click(at.x, at.y);
		return true;
	}
	// What a click at (x, y) lands on. The game canvas means the map; anything
	// else is a window in the way, and the client never sees the click.
	blocker(x, y) {
		return this.eval(`
			let el = document.elementFromPoint(arg.x, arg.y);
			while (el?.shadowRoot?.elementFromPoint(arg.x, arg.y) && el.shadowRoot.elementFromPoint(arg.x, arg.y) !== el) el = el.shadowRoot.elementFromPoint(arg.x, arg.y);
			if (!el || el.tagName === 'CANVAS') return null;
			const host = el.getRootNode()?.host;
			return (host?.id || el.closest('[id]')?.id || el.tagName) + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '');`, { x, y });
	}

	async shot(name, clip) {
		let image = await this.wc.capturePage(clip);
		// In page pixels, the ones `click` and `hover --px` take, rather than
		// the display's (twice as many on a Retina screen, and four times the
		// bytes for an agent to read).
		const width = clip ? clip.width : await this.eval(`return window.innerWidth;`).catch(() => 0);
		if (width && image.getSize().width > width) image = image.resize({ width, quality: 'good' });
		const png = image.toPNG();
		// For MCP, which hands the picture to the model: a JPEG is a tenth
		// the size and reads as well. The PNG on disk stays exact.
		const jpeg = typeof image.toJPEG === 'function' ? image.toJPEG(75) : null;
		fs.mkdirSync(this.shotsDir, { recursive: true });
		const file = path.join(this.shotsDir, `${String(name || 'shot').replace(/[^\w.-]+/g, '_')}-${Date.now()}.png`);
		fs.writeFileSync(file, png);
		this.pruneShots();
		return { file, png, jpeg };
	}
	// Screenshots are the agent's eyes, not a record: keep the last 200.
	pruneShots() {
		try {
			const files = fs.readdirSync(this.shotsDir).filter(f => f.endsWith('.png'))
				.map(f => ({ f, t: fs.statSync(path.join(this.shotsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
			for (const { f } of files.slice(200)) fs.rmSync(path.join(this.shotsDir, f), { force: true });
		} catch { /* best effort */ }
	}

	async findTarget(spec, types = ['MOB']) {
		const me = await this.player();
		if (spec === 'self' || String(spec) === String(me?.gid)) return me;
		const list = await this.agent('entities', [{ radius: 30 }]);
		// "nearest" is always a monster; players and NPCs are named by id or
		// name. Only one on screen and not behind a window can be clicked.
		if (!spec || spec === 'nearest') {
			const dist = e => Math.hypot(e.position[0] - me.position[0], e.position[1] - me.position[1]);
			const mobs = list.filter(e => e.type === 'MOB' && !e.dead && e.cell?.onScreen).sort((a, b) => dist(a) - dist(b));
			for (const m of mobs) if (!(await this.blocker(m.click.x, m.click.y))) return m;
			return null;
		}
		return list.find(e => String(e.gid) === String(spec)) || list.find(e => e.name && e.name.toLowerCase() === String(spec).toLowerCase()) || null;
	}
	// A skill still waiting for its target takes the next click on the map,
	// whatever that click was for. Right-click cancels it; Escape would open
	// the game menu instead.
	async cancelTargeting() {
		const mouse = await this.agent('mouse').catch(() => null);
		const useskill = await this.eval(`return window.roAgent.modules.Mouse.MOUSE_STATE.USESKILL;`).catch(() => null);
		if (mouse && useskill !== null && mouse.state === useskill) {
			const me = await this.player();
			await this.click(me.cell.x, me.cell.y, 'right');
			await sleep(200);
			return true;
		}
		return false;
	}
	// Hover first and let a frame run: the client only picks what is under
	// the cursor on its next frame, and a click before that lands on the map.
	// A monster moves between reading where it is and clicking it, so read
	// again and retry, clicking only once the client picks it.
	async clickEntity(target, button = 'left') {
		for (let attempt = 0; attempt < 4; attempt++) {
			const now = attempt ? (await this.agent('entities', [{ radius: 30 }])).find(e => e.gid === target.gid) : target;
			if (!now || !now.click) return false;
			await this.move(now.click.x, now.click.y);
			await sleep(150);
			const over = await this.agent('mouse');
			if (over?.over?.gid === target.gid) {
				await this.click(now.click.x, now.click.y, button);
				return true;
			}
		}
		return false;
	}
	// Type into the chat box and send. Only ever the visible input: with the
	// game menu or a dialog open, Enter would press *their* default button --
	// which is how a stray Enter logs a character out.
	async chatSend(text) {
		let has = await this.eval(`return Boolean(__deep('.input-chatbox').find(__visible));`);
		if (!has) {
			const blocked = await this.eval(`const s = window.roClientDiagnostics?.snapshot(); return Boolean(s?.input?.capturing || !s?.map);`).catch(() => true);
			if (blocked) throw new Error('chat is not reachable: a menu or dialog is open, or not in game (take a screenshot)');
			await this.press('Enter');
			await sleep(200);
		}
		await this.fill('.input-chatbox', text);
		await this.press('Enter');
		await sleep(700);
		return this.newChat();
	}
	dialog() {
		return this.eval(`
			const UI = window.roAgent?.modules?.UIManager;
			const box = UI?.getComponent('NpcBox'), menu = UI?.getComponent('NpcMenu');
			const shown = c => c && c._host && c._host.isConnected && getComputedStyle(c._host).display !== 'none';
			const out = { open: false };
			if (shown(box)) {
				const root = box.getRoot();
				out.open = true;
				out.text = root.querySelector('.content')?.innerText || '';
				out.next = __visible(root.querySelector('.next'));
				out.close = __visible(root.querySelector('.close'));
			}
			if (shown(menu)) {
				const root = menu.getRoot();
				out.open = true;
				out.menu = [...root.querySelectorAll('.content div[data-index]')].map((d, i) => ({ n: i + 1, text: d.innerText }));
			}
			return out;`);
	}

	// ------------------------------------------------------------- commands

	commands() {
		const c = {
			status: async () => ({ ok: true, url: this.wc.getURL(), inGame: await this.inGame(), errors: this.errors.length }),
			login: async () => {
				const { user, pass } = await this.credentials();
				await this.until(() => this.eval(`return Boolean(__deep('#user').find(__visible));`), 60000);
				await this.installHooks();
				// A session the server still holds -- the agent's window closed or
				// the app restarted while in game -- is kicked by the first
				// attempt, which then lands back on the login box; the next one
				// gets through. So try a few times before giving up.
				// Already there and still connected: nothing to do.
				const onSelect = () => this.eval(`return Boolean(__deep('#slot0').find(__visible));`);
				if (await onSelect() && !(await this.prompt())) {
					return { ok: true, screen: 'character select', account: user, already: true, errors: this.newErrors() };
				}
				let ok = false;
				for (let attempt = 0; attempt < 4 && !ok; attempt++) {
					if (attempt) await sleep(5000);
					// "Disconnected from Server." after a server restart sits in
					// front of everything until someone presses OK.
					if (await this.prompt()) { await this.pressPrompt(true); await sleep(1500); }
					if (!(await this.until(() => this.eval(`return Boolean(__deep('#user').find(__visible));`), attempt ? 20000 : 60000))) break;
					await this.fill('#user', user);
					await this.fill('#pass', pass);
					await this.clickSelector('.connect');
					ok = await this.until(() => this.eval(`return Boolean(__deep('#slot0').find(__visible));`), 20000);
				}
				return { ok, screen: ok ? 'character select' : 'still on login', account: user, errors: this.newErrors() };
			},
			characters: async () => {
				const known = await this.eval(`return Object.values(window.__agentChars || {});`);
				const slots = await this.eval(`return __deep('[id^=slot]').filter(__visible).map(e => Number(e.id.replace('slot', ''))).filter(n => !isNaN(n));`);
				if (!slots.length) return { ok: false, reason: 'not on character select (run login first)' };
				return { ok: true, characters: known, emptySlots: slots.filter(n => !known.some(k => k.slot === n)) };
			},
			char: async ([slot = '0']) => {
				if (!(await this.clickSelector(`#slot${Number(slot)}`, true))) return { ok: false, reason: 'not on character select (run login first)' };
				const ok = await this.settled();
				if (ok) await sleep(1000);
				return { ok, player: ok ? await this.player() : null, errors: this.newErrors() };
			},
			create: async ([slot = '0', ...name]) => {
				name = name.join(' ');
				if (!name) throw new Error('create <slot> <name>');
				if (!(await this.clickSelector(`#slot${Number(slot)}`, true))) return { ok: false, reason: 'not on character select (run login first)' };
				await sleep(1500);
				// The creation window's name box: the one text field showing.
				await this.fill('input[type=text]', name);
				await this.clickSelector('ui-button.make');
				const ok = await this.until(async () => !(await this.eval(`return Boolean(__deep('ui-button.make').find(__visible));`)), 15000);
				await sleep(1000);
				return { ok, next: `char ${slot}`, errors: this.newErrors() };
			},
			say: async args => {
				const text = args.join(' ');
				const chat = await this.chatSend(text);
				// A travel command reloads the map; wait for it rather than hand
				// back a half-loaded scene.
				if (/^[@#](warp|go|load)\b/i.test(text)) { await sleep(800); await this.settled(); }
				return { chat, player: await this.player().catch(() => null), errors: this.newErrors() };
			},
			chat: async ([which]) => ({ chat: await this.newChat(which === 'all'), prompt: await this.prompt() }),
			whisper: async ([to, ...words]) => {
				if (!to || !words.length) throw new Error('whisper <name> <text>');
				// The chat box's name field is who a line goes to; empty again after.
				const set = name => this.eval(`
					const el = __deep('.input .username, input.username').find(e => e.getRootNode()?.host?.id === 'ChatBox');
					if (!el) return false;
					el.value = arg; el.dispatchEvent(new Event('input', { bubbles: true })); return true;`, name);
				let has = await this.eval(`return Boolean(__deep('.input-chatbox').find(__visible));`);
				if (!has) { await this.press('Enter'); await sleep(200); }
				if (!(await set(to))) throw new Error('the chat box has no name field showing');
				try { return { chat: await this.chatSend(words.join(' ')), errors: this.newErrors() }; }
				finally { await set(''); }
			},
			party: async args => ({ chat: await this.chatSend('%' + args.join(' ')), errors: this.newErrors() }),
			guild: async args => ({ chat: await this.chatSend('$' + args.join(' ')), errors: this.newErrors() }),
			answer: async ([choice = 'ok']) => {
				const yes = /^(y|yes|ok|accept|1|true)$/i.test(String(choice));
				const box = await this.prompt();
				if (!box) return { ok: false, reason: 'the game is not asking anything' };
				await this.pressPrompt(yes);
				return { ok: true, box, answered: box.kind === 'message' ? 'ok' : yes ? 'yes' : 'no', chat: await this.newChat(), errors: this.newErrors() };
			},
			state: async ([radius = '15']) => ({
				commandPrefix: this.prefix(),
				player: await this.player().catch(e => ({ error: e.message })),
				entities: await this.agent('entities', [{ radius: Number(radius) }]).catch(e => ({ error: e.message })),
				chat: await this.newChat(),
				prompt: await this.prompt(),
				dialog: await this.dialog().catch(() => null),
				errors: this.newErrors(),
			}),
			skills: async ([filter]) => {
				const seen = new Set();
				return (await this.agent('skills')).filter(sk => !seen.has(sk.id) && seen.add(sk.id))
					.filter(sk => !filter || String(sk.id) === filter || sk.name.toLowerCase().includes(filter.toLowerCase()));
			},
			// The inventory's own equip path (what a double-click on the item runs).
			equip: async ([id]) => {
				const result = await this.eval(`
					const inv = window.roAgent.modules.UIManager.getComponent('Inventory');
					const item = inv?.getItemById(Number(arg));
					if (!item) return { ok: false, reason: 'item ' + arg + ' is not in the inventory' };
					inv.onEquipItem(item.index, item.location);
					return { ok: true, index: item.index, location: item.location };`, id);
				await sleep(800);
				return { ...result, chat: await this.newChat(), errors: this.newErrors() };
			},
			// Walk to a cell anywhere on this map. One click only reaches a cell
			// that is on screen, so a far one is reached in steps: each click
			// goes as far along the way as is visible and not behind a window.
			walk: async ([x, y]) => {
				x = Number(x); y = Number(y);
				if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('walk <x> <y>');
				await this.cancelTargeting();
				const near = p => Math.abs(p[0] - x) <= 1 && Math.abs(p[1] - y) <= 1;
				const FRACTIONS = [1, 0.8, 0.6, 0.45, 0.33, 0.22, 0.12];
				const started = Date.now();
				let steps = 0, stuck = 0, skip = 0;
				let me = await this.player();
				while (!near(me.position) && Date.now() - started < 120000 && steps < 30) {
					let aim = null;
					for (const f of FRACTIONS.slice(skip)) {
						const cx = Math.round(me.position[0] + (x - me.position[0]) * f);
						const cy = Math.round(me.position[1] + (y - me.position[1]) * f);
						if (cx === Math.round(me.position[0]) && cy === Math.round(me.position[1])) continue;
						const p = await this.agent('project', [cx, cy]);
						if (!p?.onScreen || await this.blocker(p.x, p.y)) continue;
						aim = { cx, cy, p };
						break;
					}
					if (!aim) break;
					await this.move(aim.p.x, aim.p.y);
					await sleep(120);
					await this.click(aim.p.x, aim.p.y);
					steps++;
					// This step is done when the player reaches its cell, or
					// started and then stood still for a second, or never
					// moved within three seconds.
					const from = me.position.join(',');
					const t0 = Date.now();
					let last = from, stillSince = Date.now(), moved = false;
					while (Date.now() - t0 < 30000) {
						await sleep(250);
						const pos = (await this.player()).position;
						const p = pos.join(',');
						if (Math.round(pos[0]) === aim.cx && Math.round(pos[1]) === aim.cy) break;
						if (p !== last) { moved = true; last = p; stillSince = Date.now(); }
						if (moved && Date.now() - stillSince > 1000) break;
						if (!moved && Date.now() - t0 > 3000) break;
					}
					me = await this.player();
					// No progress: that cell is likely not walkable; aim shorter.
					if (me.position.join(',') === from) { stuck++; skip = Math.min(skip + 2, FRACTIONS.length - 1); if (stuck >= 3) break; }
					else { stuck = 0; skip = 0; }
				}
				const ok = near(me.position);
				return { ok, position: me.position, steps, ...(ok ? {} : { reason: steps ? 'stopped short: the way may be blocked, or the cell is not walkable' : 'no visible cell toward that point is free to click (a window may be in the way)' }), errors: this.newErrors() };
			},
			attack: async ([spec]) => {
				const target = await this.findTarget(spec);
				if (!target) return { ok: false, reason: 'no such monster in range', nearby: (await this.agent('entities', [{ radius: 30 }])).slice(0, 8) };
				await this.cancelTargeting();
				const picked = await this.clickEntity(target);
				await sleep(2500);
				const after = (await this.agent('entities', [{ radius: 30 }])).find(e => e.gid === target.gid) || null;
				return { ok: picked, target, after, player: await this.player(), chat: await this.newChat(), errors: this.newErrors() };
			},
			// Talk to an NPC, open a Kafra, pick up an item: any entity, by id
			// or name.
			interact: async ([spec]) => {
				const target = await this.findTarget(spec, ['NPC', 'NPC2', 'ITEM', 'WARP']);
				if (!target) return { ok: false, reason: 'nothing by that id or name in range' };
				await this.cancelTargeting();
				const picked = await this.clickEntity(target);
				await sleep(1200);
				return { ok: picked, target, dialog: await this.dialog(), errors: this.newErrors() };
			},
			dialog: async () => this.dialog(),
			next: async () => {
				const ok = await this.eval(`const r = window.roAgent.modules.UIManager.getComponent('NpcBox').getRoot().querySelector('.next'); return __visible(r) ? __rect(r) : null;`);
				if (!ok) return { ok: false, reason: 'no Next button showing', dialog: await this.dialog() };
				await this.click(ok.x, ok.y);
				await sleep(600);
				return { ok: true, dialog: await this.dialog(), errors: this.newErrors() };
			},
			close: async () => {
				const ok = await this.eval(`const r = window.roAgent.modules.UIManager.getComponent('NpcBox').getRoot().querySelector('.close'); return __visible(r) ? __rect(r) : null;`);
				if (!ok) return { ok: false, reason: 'no Close button showing', dialog: await this.dialog() };
				await this.click(ok.x, ok.y);
				await sleep(600);
				return { ok: true, dialog: await this.dialog(), errors: this.newErrors() };
			},
			// Pick menu option n (1-based), as the list shows it.
			choose: async ([n]) => {
				const at = await this.eval(`
					const root = window.roAgent.modules.UIManager.getComponent('NpcMenu').getRoot();
					const item = root.querySelectorAll('.content div[data-index]')[Number(arg) - 1];
					return item && __visible(item) ? __rect(item) : null;`, n);
				if (!at) return { ok: false, reason: 'no such menu option', dialog: await this.dialog() };
				await this.dblclick(at.x, at.y);
				await sleep(800);
				// A menu choice that warps reloads the map.
				await this.until(() => this.inGame(), 5000);
				return { ok: true, dialog: await this.dialog(), player: await this.player().catch(() => null), errors: this.newErrors() };
			},
			skill: async args => {
				const id = Number(args[0]);
				const level = args[1] && !args[1].startsWith('--') ? Number(args[1]) : undefined;
				const t = args.indexOf('--target'), cell = args.indexOf('--cell');
				// A previous cast still waiting for a target would take this one's click.
				await this.cancelTargeting();
				// Found before the cast, so a missing target leaves nothing waiting.
				let target = null;
				if (t >= 0) {
					target = await this.findTarget(args[t + 1], ['MOB', 'PC', 'NPC', 'HOM', 'MERC', 'ELEM']);
					if (!target) return { ok: false, reason: 'target not found in range; walk closer or pick another', nearby: (await this.agent('entities', [{ radius: 20 }])).filter(e => e.type === 'MOB').slice(0, 6) };
				}
				const started = await this.agent('useSkill', [id, level]);
				let clicked = null;
				if (started.targeting && target) {
					clicked = { target, pickedByClient: await this.clickEntity(target) };
				} else if (started.targeting && cell >= 0) {
					const at = await this.agent('project', [Number(args[cell + 1]), Number(args[cell + 2])]);
					await this.click(at.x, at.y);
					clicked = { cell: at };
				} else if (started.targeting) {
					// A targeted skill with nothing to click: don't leave the game
					// waiting for one.
					await this.cancelTargeting();
					return { ok: false, reason: 'this skill needs --target <gid|nearest|self> or --cell <x> <y>', started };
				}
				await sleep(2000);
				return { started, clicked, player: await this.player(), chat: await this.newChat(), errors: this.newErrors() };
			},
			shot: async ([name]) => this.shot(name),
			click: async ([x, y, button]) => { await this.click(Number(x), Number(y), button === 'right' ? 'right' : 'left'); await sleep(300); return { ok: true, errors: this.newErrors() }; },
			hover: async ([x, y, flag]) => {
				const point = flag === '--px' ? { x: Number(x), y: Number(y) } : await this.agent('project', [Number(x), Number(y)]);
				await this.move(point.x, point.y);
				await sleep(150);
				return { point, coveredBy: await this.blocker(point.x, point.y), mouse: await this.agent('mouse') };
			},
			key: async ([key]) => { await this.press(key); await sleep(300); return { ok: true, errors: this.newErrors() }; },
			wait: async ([ms = '1000']) => { await sleep(Math.min(Number(ms) || 0, 60000)); return { ok: true }; },
			errors: async () => ({ errors: this.errors.slice(-200) }),
		};
		return c;
	}
}

// What the commands take, for the MCP tool list and the CLI's help. One entry
// per command; `args` are positional, in order.
const COMMANDS = {
	status: { description: 'Whether the agent\'s game window is up and in game.', args: [] },
	login: { description: 'Log in to the agent\'s own account. Lands on character select.', args: [] },
	characters: { description: 'The character slots on character select.', args: [] },
	create: { description: 'Make a character in an empty slot on character select.', args: [['slot', 'number', 'Slot number, from 0'], ['name', 'string', 'Character name']] },
	char: { description: 'Enter the game with the character in a slot.', args: [['slot', 'number', 'Slot number, from 0']] },
	state: { description: 'The player, what is nearby, recent chat, any NPC dialog, and new client errors.', args: [['radius', 'number', 'Cells around the player to list (default 15)', true]] },
	// The travel commands are named without their prefix on purpose. It is a
	// player setting (Settings -> Rates -> Command prefix, atcommand_symbol),
	// and a command typed with the wrong one is not refused -- rAthena does not
	// recognise it as a command at all and says it in local chat, so an agent
	// told to type "@warp" on a server running on "!" would announce its plans
	// and never move. The prefix `state` reports is the one to use.
	say: { description: 'Say something in local chat. Slash commands go here too (/organize <party name>, /invite <name>, /leave), and the travel commands warp, go and load, which you should use only when you need to. Those three are server commands and need the server\'s command prefix in front, which `state` gives as commandPrefix (usually @, so "@warp prontera"); without it they are only spoken aloud.', args: [['text', 'string', 'What to say']] },
	chat: { description: 'Chat you have not seen yet: channel (local, party, guild, whisper, broadcast, npc, system, client: the game\'s own notices and errors), who said it, and the text. "all" for the last 50.', args: [['which', 'string', '"all" for recent history instead of only new lines', true]] },
	whisper: { description: 'Send a private message to one character by name.', args: [['to', 'string', 'Character name'], ['text', 'string', 'What to say']] },
	party: { description: 'Say something in party chat.', args: [['text', 'string', 'What to say']] },
	guild: { description: 'Say something in guild chat.', args: [['text', 'string', 'What to say']] },
	answer: { description: 'Answer the box the game is showing: yes/no for a question such as a party invitation, or ok for a message. state shows it as prompt.', args: [['choice', 'string', 'yes, no or ok', true]] },
	walk: { description: 'Walk to a cell on this map. Far cells are reached in several steps automatically.', args: [['x', 'number', 'Cell x'], ['y', 'number', 'Cell y']] },
	attack: { description: 'Attack a monster by entity id, or the nearest one.', args: [['target', 'string', 'Entity gid, a name, or "nearest"', true]] },
	interact: { description: 'Click an NPC, Kafra, item or warp by entity id or name. NPC dialog shows in the result.', args: [['target', 'string', 'Entity gid or name']] },
	dialog: { description: 'The NPC dialog now showing: text, and menu options if any.', args: [] },
	next: { description: 'Press Next in an NPC dialog.', args: [] },
	close: { description: 'Press Close in an NPC dialog.', args: [] },
	choose: { description: 'Pick an NPC menu option by its number (1-based).', args: [['option', 'number', 'Option number']] },
	skills: { description: 'Skills the character has: id, name, level, SP, range.', args: [['filter', 'string', 'Id or part of a name', true]] },
	skill: { description: 'Use a skill. For a targeted one add --target <gid|nearest|self> or --cell <x> <y>.', args: [['id', 'number', 'Skill id'], ['rest', 'string', 'Level and flags, e.g. "5 --target nearest"', true]] },
	equip: { description: 'Equip an item from the inventory by item id.', args: [['item', 'number', 'Item id']] },
	shot: { description: 'Screenshot of the agent\'s game window.', args: [['name', 'string', 'Label for the file', true]] },
	hover: { description: 'Put the cursor on a cell (or pixels with --px) and report what the client sees there.', args: [['x', 'number', 'Cell x'], ['y', 'number', 'Cell y'], ['flag', 'string', '--px for page pixels', true]] },
	click: { description: 'A raw mouse click at page pixels.', args: [['x', 'number', 'Pixel x'], ['y', 'number', 'Pixel y'], ['button', 'string', 'left or right', true]] },
	key: { description: 'Press a key: Enter, Escape, F1, Alt+E ...', args: [['key', 'string', 'Key name']] },
	wait: { description: 'Wait up to 60 seconds.', args: [['ms', 'number', 'Milliseconds']] },
	errors: { description: 'Client errors and warnings seen so far.', args: [] },
};

module.exports = { AgentDriver, COMMANDS, parseKey };
