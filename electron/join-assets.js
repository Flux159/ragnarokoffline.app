'use strict';
//
// Joining a friend with your own game files (docs/FRIENDS_SHARING.md, "Friends
// who bring their own game files").
//
// The game page, its client code, the sign-in and the game connection still
// come from the host, exactly as for any other joining player; only what the
// client reads out of the GRFs comes from this machine. The host's page asks
// for those at `ro-local://assets/...`, a scheme this app answers from its own
// asset server on loopback. That keeps three things true:
//
//  - the host's page never learns a port on this machine and cannot reach the
//    asset server's other routes (its API, its socket proxy): only the asset
//    reads below are passed through;
//  - nothing on this machine listens beyond loopback for it;
//  - Chromium sees no request from a public page to a private address, so
//    there is no local-network permission to ask for.
//
// What the host adds on top of the GRFs -- its mods, the translation, the
// merged System tables -- is listed in its join.json. With mods from the host
// (the default) the client fetches those paths from the host and the rest from
// here, and this machine's asset server is started on an empty root so that
// none of this player's own mods leak in. With mods from this machine, the
// asset server serves this player's own overlay, the same as when they host.

const SCHEME = 'ro-local';
const BASE = `${SCHEME}://assets/`;
const MOD_SOURCES = ['host', 'local'];

const schemePrivileges = {
	scheme: SCHEME,
	privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true },
};

/** 'host' unless the player chose their own mods. */
function modSource(paths) {
	return paths && paths.join_mod_files === 'local' ? 'local' : 'host';
}

/**
 * What the client is told when it boots on the host's page, or null to use the
 * host's files as before. `era` and `client` are this machine's, for the client
 * to compare with the host's join.json.
 */
function plan(paths, { era, client, clientComplete }) {
	if (!paths || paths.mode !== 'join' || paths.join_local_assets !== true || !clientComplete) return null;
	return Object.freeze({ base: BASE, mods: modSource(paths), era, client: client || null });
}

/**
 * The asset server's settings for a joining player: loopback only, no socket
 * proxy, no app or web-server routes. With the host's mods, an empty root and
 * no translation, so it serves nothing but this player's GRFs and client
 * folders.
 */
function environment(host, { mods, emptyRoot }) {
	const env = { ...host, HOST: '127.0.0.1', ENABLE_WSPROXY: 'false', WS_ALLOWED_TARGETS: '', ENABLE_COMPRESSION: 'false' };
	delete env.APP_PROXY_PREFIX;
	delete env.APP_PROXY_TARGET;
	delete env.WEB_SERVER_TARGET;
	delete env.CLIENT_PUBLIC_URL;
	if (mods !== 'local') {
		env.SERVER_ROOT = emptyRoot;
		delete env.DATA_OVERRIDE_PATH;
	}
	return env;
}

// The asset reads the client makes: a file, a batch of them, and the search it
// posts to the base URL. Nothing else on the asset server is reachable this way.
const PRIVATE_FIRST = new Set(['api', 'ws', 'list-files', 'logs', 'resources', '_friend', '_control', 'control']);
const GENERATED = new Set(['', 'index.html', 'config.local.js', 'overlay.id', 'join.json']);

function allowed(method, pathname) {
	let decoded;
	try { decoded = decodeURIComponent(pathname); } catch { return false; }
	if (/[\\\x00-\x1f\x7f]/.test(decoded)) return false;
	const pieces = decoded.split('/').filter(Boolean);
	if (pieces.some(p => p.startsWith('.'))) return false;
	if (method === 'POST') return pathname === '/' || pathname === '/batch';
	if (method !== 'GET' && method !== 'HEAD') return false;
	if (PRIVATE_FIRST.has((pieces[0] || '').toLowerCase())) return false;
	if (pieces.length <= 1 && GENERATED.has((pieces[0] || '').toLowerCase())) return false;
	return !/\.(grf|gpf|ini)$/i.test(decoded);
}

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, HEAD, POST',
	'access-control-allow-headers': 'content-type, range',
};

/**
 * The `ro-local` protocol handler. `active()` says whether this player is
 * joined with their own files right now; `port()` is the asset server's.
 * `fetchImpl` is Electron's net.fetch in the app and a stub in the tests.
 */
function handler({ active, port, fetchImpl }) {
	return async request => {
		const url = new URL(request.url);
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
		if (!active() || url.host !== 'assets' || !allowed(request.method, url.pathname)) {
			return new Response('Not found', { status: 404, headers: CORS });
		}
		const headers = {};
		// No accept-encoding: compressing a loopback hop gains nothing, and a
		// body net.fetch has already inflated must not be labelled gzip.
		for (const name of ['content-type', 'range', 'if-none-match']) {
			const value = request.headers.get(name);
			if (value) headers[name] = value;
		}
		const init = { method: request.method, headers };
		if (request.method === 'POST') init.body = await request.arrayBuffer();
		let upstream;
		try {
			upstream = await fetchImpl(`http://127.0.0.1:${port()}${url.pathname}${url.search}`, init);
		} catch {
			return new Response('Your asset server is not answering', { status: 502, headers: CORS });
		}
		const out = new Headers(CORS);
		for (const name of ['content-type', 'content-range', 'accept-ranges', 'etag', 'cache-control']) {
			const value = upstream.headers.get(name);
			if (value) out.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: out });
	};
}

module.exports = { SCHEME, BASE, MOD_SOURCES, schemePrivileges, modSource, plan, environment, allowed, handler };
