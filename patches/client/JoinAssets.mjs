// Joining a friend with your own game files (the app's electron/join-assets.js,
// docs/FRIENDS_SHARING.md).
//
// This page and its client come from the host. When the joining player's app
// says they play with their own files, the client reads its assets from their
// machine (ro-local://assets/) instead of the host -- after checking the host's
// join.json says their files suit this world. What the host adds on top of the
// GRFs (its mods, the translation, the merged System tables) is listed there,
// and with mods from the host those paths are still fetched from the host.
//
// Without a plan from the app (a browser, the host's own window, an older app)
// nothing here changes anything.

const ERAS = { renewal: 'Renewal', 'pre-renewal': 'Pre-Renewal' };

/** The spelling both sides compare: forward slashes, lower case. */
export const key = name => String(name).replace(/\\/g, '/').toLowerCase();

/**
 * Whether this player's own files can be used with this host: `{ use: 'local' }`,
 * or `{ use: 'host', reason }` to keep reading the host's files.
 */
export function decide(server, plan) {
	if (!server || server.format !== 1 || !Array.isArray(server.files)) {
		return { use: 'host', reason: 'This host’s app is too old to say which game files its world needs, so its own files are used.' };
	}
	if (server.client && plan.client && server.client !== plan.client) {
		return { use: 'host', reason: `This world is played with ${server.client} game files and yours are ${plan.client}, so the host’s files are used.` };
	}
	if (plan.mods === 'local' && server.era !== plan.era) {
		return {
			use: 'host',
			reason: `This world is ${ERAS[server.era] || server.era} and your own mods are set up for ${ERAS[plan.era] || plan.era}. `
				+ 'Switch your era in Settings, or take mods from the host. Using the host’s files for now.',
		};
	}
	return { use: 'local' };
}

function getSync(url) {
	const xhr = new XMLHttpRequest();
	xhr.open('GET', url, false);
	xhr.send(null);
	if (xhr.status !== 200) throw new Error(`${url}: ${xhr.status}`);
	return xhr.responseText;
}

/**
 * The asset base the client should use. `configured` is the host's own
 * (remoteClient in its Config.local.js); `thread` is the client's worker.
 */
export function joinAssets(configured, thread, {
	plan = globalThis.__RAGNAROK_JOIN_ASSETS__,
	get = getSync,
	here = globalThis.location?.href,
	tell = message => globalThis.alert?.(message),
} = {}) {
	if (!plan || !plan.base) return configured;
	const host = new URL(configured || '/', here).href;
	let server = null;
	try { server = JSON.parse(get(host + 'join.json')); } catch { /* an older host */ }
	const choice = decide(server, plan);
	if (choice.use !== 'local') {
		console.warn(`[join] ${choice.reason}`);
		tell(`${choice.reason}\n\nIf this host does not send game files, the game cannot load them until that is fixed.`);
		return configured;
	}
	if (plan.mods !== 'local') thread.send('SET_OVERLAY_HOST', { base: host, files: server.files.map(key) });
	console.log(`[join] your own game files, ${plan.mods === 'local' ? 'with your own mods' : `with the host’s ${server.files.length} added files`}`);
	return plan.base;
}
