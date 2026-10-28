'use strict';
//
// Discord Rich Presence: "Playing Ragnarok Offline -- Lv 99/50 Assassin Cross,
// Prontera" on the player's Discord profile.
//
// Discord's desktop app listens on a local socket (a named pipe on Windows)
// called discord-ipc-0..9. A program says who it is with a handshake carrying
// the Discord application id, then sends SET_ACTIVITY whenever its status
// changes. That is the whole protocol we need: framed JSON, no library, in
// keeping with the app's no-runtime-dependencies rule.
//
//   frame = int32le op | int32le length | UTF-8 JSON
//   op 0 HANDSHAKE { v: 1, client_id }   op 1 FRAME (commands and replies)
//   op 2 CLOSE    op 3 PING -> answer op 4 PONG with the same body
//
// Only this computer's Discord is reachable, so this is presence for whoever
// plays in this app's game window: the host, or a friend who joined through
// the app. A player in a browser tab gets none (see docs/DISCORD_PRESENCE.md).
//
// Nothing here throws to the caller. No Discord, an old Discord, a closed
// socket: the status just isn't shown, and we try again a little later.

const net = require('node:net');
const path = require('node:path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
// rAthena's MAX_PARTY.
const PARTY_MAX = 12;
// Discord allows SET_ACTIVITY about five times in twenty seconds. A warp
// followed by a level-up is two calls; anything closer together is merged.
const MIN_GAP_MS = 5000;
const RETRY_MS = 30000;

// Where Discord's socket can be. Linux puts it in $XDG_RUNTIME_DIR, and the
// Flatpak and Snap builds of Discord put it one folder further down. Vesktop
// (with its arRPC option on) and Vencord use the plain path.
function socketPaths({ platform = process.platform, env = process.env } = {}) {
	const out = [];
	if (platform === 'win32') {
		for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
		return out;
	}
	const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean);
	const subdirs = ['', 'app/com.discordapp.Discord', 'app/com.discordapp.DiscordCanary', 'snap.discord', 'snap.discord-canary', '.flatpak/dev.vencord.Vesktop/xdg-run'];
	const seen = new Set();
	for (let i = 0; i < 10; i++) {
		for (const base of bases) {
			for (const sub of subdirs) {
				const p = path.posix.join(base, sub, `discord-ipc-${i}`);
				if (!seen.has(p)) { seen.add(p); out.push(p); }
			}
		}
	}
	return out;
}

function encode(op, payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	const header = Buffer.alloc(8);
	header.writeInt32LE(op, 0);
	header.writeInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}

// Splits a byte stream into frames. Returns the frames and what is left over.
function decode(buffer) {
	const frames = [];
	let rest = buffer;
	while (rest.length >= 8) {
		const op = rest.readInt32LE(0);
		const length = rest.readInt32LE(4);
		if (length < 0 || length > 1 << 20) throw new Error('bad Discord frame');
		if (rest.length < 8 + length) break;
		let data = null;
		try { data = JSON.parse(rest.subarray(8, 8 + length).toString('utf8')); } catch { /* ignored */ }
		frames.push({ op, data });
		rest = rest.subarray(8 + length);
	}
	return { frames, rest };
}

// Discord refuses a field shorter than 2 or longer than 128 characters.
function text(value) {
	if (typeof value !== 'string') return undefined;
	const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
	if (clean.length < 2) return undefined;
	return clean.length > 128 ? clean.slice(0, 127) + '…' : clean;
}

// A client-side map name is shown only when it reads as text. mapnametable
// can be Korean bytes decoded in the wrong code page on an untranslated client.
function mapLabel(state) {
	const name = typeof state.mapName === 'string' ? state.mapName.trim() : '';
	if (name && /^[\x20-\x7e]+$/.test(name)) return name;
	return typeof state.map === 'string' && /^[A-Za-z0-9_@-]{1,32}$/.test(state.map) ? state.map : '';
}

// Art on the status. These are keys of pictures uploaded to the Discord
// application (Rich Presence -> Art Assets); docs/DISCORD_PRESENCE.md lists
// them. A map shows its region's picture: the town, its fields and dungeons.
const REGIONS = [
	['prontera', /^(prontera|prt_|prt\d|mjolnir_|ordeal|valkyrie)/],
	['izlude', /^(izlude|iz_|izlu)/],
	['geffen', /^(geffen|gef_|gefenia|geffen_)/],
	['payon', /^(payon|pay_|payg|pay\d)/],
	['morocc', /^(morocc|moc_|anthell|in_moc|morocc_|que_sign)/],
	['alberta', /^(alberta|alb_|alb2trea|treasure|tur_dun)/],
	['aldebaran', /^(aldebaran|alde_|c_tower|clock|aldeg)/],
	['comodo', /^(comodo|cmd_|beach_dun|kh_)/],
	['juno', /^(yuno|juperos|jupe_|mag_dun|yuno_)/],
	['einbroch', /^(einbroch|einbech|ein_)/],
	['lighthalzen', /^(lighthalzen|lhz_)/],
	['rachel', /^(rachel|ra_|ice_dun)/],
	['veins', /^(veins|ve_|thor_v)/],
	['hugel', /^(hugel|hu_|odin_tem|abbey)/],
	['glastheim', /^(glast_|gl_)/],
	['niflheim', /^(niflheim|nif_)/],
	['amatsu', /^(amatsu|ama_)/],
	['gonryun', /^(gonryun|gon_)/],
	['louyang', /^(louyang|lou_)/],
	['ayothaya', /^(ayothaya|ayo_)/],
	['umbala', /^(umbala|um_|yggdrasil)/],
	['moscovia', /^(moscovia|mosk_)/],
	['brasilis', /^(brasilis|bra_)/],
	['dewata', /^(dewata|dew_)/],
	['malangdo', /^(malangdo|mal_)/],
	['eclage', /^(eclage|ecl_)/],
	['splendide', /^(splendide|spl_|manuk|man_|mid_camp)/],
	['guild', /^(prtg_cas|payg_cas|gefg_cas|aldeg_cas|schg_cas|arug_cas)/],
	['pvp', /^(pvp_|guild_vs)/],
];
function regionOf(map) {
	const id = typeof map === 'string' ? map.toLowerCase() : '';
	if (!id) return '';
	// Castles first: their names start like their towns'.
	for (const [key, re] of [REGIONS.at(-2), REGIONS.at(-1), ...REGIONS.slice(0, -2)]) if (re.test(id)) return key;
	return '';
}

// A job's line, for its small icon: every job of the Swordsman tree shows the
// swordsman icon, and so on. Matched on rAthena's English names.
const FAMILIES = {
	novice: ['Novice', 'Super Novice', 'Super Baby', 'Expanded Super Novice', 'Expanded Super Baby', 'Hyper Novice'],
	swordman: ['Swordsman', 'Knight', 'Crusader', 'Lord Knight', 'Paladin', 'Rune Knight', 'Royal Guard', 'Dragon Knight', 'Imperial Guard'],
	mage: ['Magician', 'Wizard', 'Sage', 'High Wizard', 'Professor', 'Warlock', 'Sorcerer', 'Arch Mage', 'Elemental Master'],
	archer: ['Archer', 'Hunter', 'Bard', 'Dancer', 'Sniper', 'Clown', 'Gypsy', 'Ranger', 'Minstrel', 'Wanderer', 'Windhawk', 'Troubadour', 'Trouvere'],
	acolyte: ['Acolyte', 'Priest', 'Monk', 'High Priest', 'Champion', 'Arch Bishop', 'Sura', 'Cardinal', 'Inquisitor'],
	merchant: ['Merchant', 'Blacksmith', 'Alchemist', 'Whitesmith', 'Creator', 'Mechanic', 'Genetic', 'Meister', 'Biolo'],
	thief: ['Thief', 'Assassin', 'Rogue', 'Assassin Cross', 'Stalker', 'Guillotine Cross', 'Shadow Chaser', 'Shadow Cross', 'Abyss Chaser'],
	taekwon: ['Taekwon', 'Star Gladiator', 'Soul Linker', 'Star Emperor', 'Soul Reaper', 'Sky Emperor', 'Soul Ascetic'],
	gunslinger: ['Gunslinger', 'Rebellion', 'Night Watch'],
	ninja: ['Ninja', 'Kagerou', 'Oboro', 'Shinkiro', 'Shiranui'],
	summoner: ['Summoner', 'Spirit Handler'],
	druid: ['Druid', 'Karnos', 'Alitea'],
};
const FAMILY_OF = new Map(Object.entries(FAMILIES).flatMap(([key, names]) => names.map(n => [n, key])));
function familyOf(jobName) {
	const name = String(jobName || '').replace(/^(Baby|High) /, '').replace(/ T$/, '');
	return FAMILY_OF.get(name) || (name === 'Novice' ? 'novice' : '');
}

// Links anyone can follow: nothing in them leads into the player's world.
const BUTTONS = [
	{ label: 'Get Ragnarok Offline', url: 'https://github.com/Flux159/ragnarokoffline.app' },
	{ label: 'Join the Discord', url: 'https://discord.gg/jUYC9dMbu5' },
];

// What the player chose to show, applied to what the game page reported.
// `state` is null outside the game (login, character select).
//
// state: { map, mapName, name, job, baseLevel, jobLevel, partySize }
// prefs: { name, map, party } booleans
// context: { joined, startedAt, jobName(id), assets }
//   assets: the art keys the Discord application has (fetchAssetNames), or
//   null when unknown. A picture it lacks is left out, so the status shows the
//   logo instead of a blank square.
function buildActivity(state, prefs = {}, context = {}) {
	const activity = {
		assets: { large_image: 'logo', large_text: context.joined ? 'Playing on a friend\'s world' : 'Playing on their own world' },
		instance: false,
	};
	if (Number.isFinite(context.startedAt)) activity.timestamps = { start: Math.floor(context.startedAt) };
	if (prefs.buttons) activity.buttons = BUTTONS.map(b => ({ ...b }));
	if (!state) {
		activity.details = 'Choosing a character';
		return activity;
	}
	const level = Number.isInteger(state.baseLevel) && state.baseLevel > 0
		? `Lv ${state.baseLevel}${Number.isInteger(state.jobLevel) && state.jobLevel > 0 ? `/${state.jobLevel}` : ''}` : '';
	const job = (context.jobName && Number.isInteger(state.job) && context.jobName(state.job)) || '';
	const who = [level, job].filter(Boolean).join(' ');
	const name = prefs.name && typeof state.name === 'string' ? state.name.trim() : '';
	activity.details = text(name && who ? `${name} · ${who}` : name || who) || 'In game';
	const where = prefs.map ? mapLabel(state) : '';
	const has = key => !(context.assets instanceof Set) || context.assets.has(key);
	const region = prefs.map ? regionOf(state.map) : '';
	if (region && has(`map_${region}`)) {
		activity.assets.large_image = `map_${region}`;
		activity.assets.large_text = text(where) || activity.assets.large_text;
	}
	const family = familyOf(job);
	if (family && has(`job_${family}`)) {
		activity.assets.small_image = `job_${family}`;
		activity.assets.small_text = text(job);
	}
	const size = Number.isInteger(state.partySize) ? Math.min(Math.max(state.partySize, 0), PARTY_MAX) : 0;
	if (prefs.party && size > 0) {
		activity.state = text(where ? `${where} · In a party` : 'In a party');
		activity.party = { size: [size, PARTY_MAX] };
	} else {
		activity.state = text(where) || undefined;
	}
	if (activity.state === undefined) delete activity.state;
	return activity;
}

// The connection. `clientId` is the Discord application id; without one the
// whole thing stays off.
function createPresence({ clientId, log = () => {}, connect = p => net.createConnection(p), paths = socketPaths(), now = Date.now, timers = { setTimeout, clearTimeout } } = {}) {
	let socket = null;
	let ready = false;
	let connecting = false;
	let stopped = false;
	let wanted;          // the activity to show, or null to clear; undefined = nothing to say
	let sentJson = null; // what Discord has now
	let lastSentAt = 0;
	let flushTimer = null;
	let retryTimer = null;
	let nonce = 0;
	let loggedMissing = false;
	let shownLogged = false;

	function reset() {
		ready = false;
		shownLogged = false;
		sentJson = null;
		if (socket) { try { socket.destroy(); } catch { /* ignored */ } }
		socket = null;
	}

	function scheduleRetry() {
		if (stopped || retryTimer || wanted === undefined || wanted === null) return;
		retryTimer = timers.setTimeout(() => { retryTimer = null; open(); }, RETRY_MS);
	}

	function tryPath(index) {
		if (stopped) { connecting = false; return; }
		if (index >= paths.length) {
			connecting = false;
			if (!loggedMissing) { log('discord: not running (no discord-ipc socket); will keep looking'); loggedMissing = true; }
			scheduleRetry();
			return;
		}
		let s;
		try { s = connect(paths[index]); } catch { tryPath(index + 1); return; }
		let opened = false;
		s.once('error', () => {
			if (!opened) { try { s.destroy(); } catch { /* ignored */ } tryPath(index + 1); }
		});
		s.once('connect', () => {
			opened = true;
			connecting = false;
			socket = s;
			let pending = Buffer.alloc(0);
			s.on('data', chunk => {
				let frames;
				try { ({ frames, rest: pending } = decode(Buffer.concat([pending, chunk]))); }
				catch { reset(); scheduleRetry(); return; }
				for (const frame of frames) receive(frame);
			});
			s.on('error', () => {});
			s.on('close', () => {
				if (socket !== s) return;
				log('discord: connection closed');
				reset();
				scheduleRetry();
			});
			s.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
		});
	}

	function receive({ op, data }) {
		if (op === OP.PING) { socket?.write(encode(OP.PONG, data)); return; }
		if (op === OP.CLOSE) {
			log(`discord: closed by Discord (${data?.message || data?.code || 'no reason'})`);
			reset();
			scheduleRetry();
			return;
		}
		if (op !== OP.FRAME || !data) return;
		if (data.cmd === 'DISPATCH' && data.evt === 'READY') {
			ready = true;
			loggedMissing = false;
			log('discord: connected');
			flush();
		} else if (data.evt === 'ERROR') {
			log(`discord: ${data.cmd || 'command'} refused: ${data.data?.message || 'no reason'}`);
		} else if (data.cmd === 'SET_ACTIVITY' && !shownLogged) {
			// Once per connection: Discord took it. If nothing shows on the
			// profile after this, the cause is on Discord's side (Activity
			// Privacy, or a client that ignores RPC).
			shownLogged = true;
			log(`discord: status accepted (${data.data ? `"${data.data.details || ''}"` : 'cleared'})`);
		}
	}

	function open() {
		if (stopped || socket || connecting || !clientId) return;
		connecting = true;
		tryPath(0);
	}

	function flush() {
		if (flushTimer) { timers.clearTimeout(flushTimer); flushTimer = null; }
		if (stopped || wanted === undefined) return;
		if (!ready) { open(); return; }
		const json = JSON.stringify(wanted);
		if (json === sentJson) return;
		const wait = lastSentAt + MIN_GAP_MS - now();
		if (wait > 0) { flushTimer = timers.setTimeout(flush, wait); return; }
		lastSentAt = now();
		sentJson = json;
		socket.write(encode(OP.FRAME, {
			cmd: 'SET_ACTIVITY',
			args: { pid: process.pid, activity: wanted },
			nonce: `ro-${++nonce}`,
		}));
	}

	return {
		// activity: an object from buildActivity, or null to clear.
		set(activity) {
			if (!clientId) return;
			wanted = activity;
			// Nothing on show and nothing connected: no reason to go looking.
			if (activity === null && !socket) return;
			flush();
		},
		stop() {
			stopped = true;
			if (flushTimer) timers.clearTimeout(flushTimer);
			if (retryTimer) timers.clearTimeout(retryTimer);
			if (socket && ready) {
				try { socket.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: `ro-${++nonce}` })); } catch { /* ignored */ }
			}
			if (socket) { try { socket.end(); } catch { /* ignored */ } }
			socket = null;
			ready = false;
		},
		status: () => ({ enabled: Boolean(clientId), connected: ready }),
	};
}

// The art keys an application has uploaded. Discord lists them for anyone
// (no sign-in), the same list the developer portal shows. Null on failure.
async function fetchAssetNames(clientId, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
	if (!/^\d{15,25}$/.test(String(clientId || ''))) return null;
	try {
		const res = await fetchImpl(`https://discord.com/api/v10/oauth2/applications/${clientId}/assets`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		const list = await res.json();
		if (!Array.isArray(list)) return null;
		return new Set(list.map(a => a && typeof a.name === 'string' ? a.name : '').filter(Boolean));
	} catch {
		return null;
	}
}

module.exports = { fetchAssetNames, socketPaths, encode, decode, buildActivity, createPresence, regionOf, familyOf, REGIONS, FAMILIES, PARTY_MAX, MIN_GAP_MS };
