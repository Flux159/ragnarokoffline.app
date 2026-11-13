'use strict';
// Friends who bring their own game files (docs/FRIENDS_SHARING.md): the joining
// side (electron/join-assets.js, patches/client/JoinAssets.mjs and its hooks)
// and the host side (Send game files to friends -> REMOTE_GRF_DATA, and the
// gateway marking what it forwards).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const joinAssets = require('../electron/join-assets');
const clientModule = import(pathToFileURL(path.join(ROOT, 'patches/client/JoinAssets.mjs')).href);

test('a plan only for a joining player who chose their own files and has a client', () => {
	const ready = { era: 'renewal', client: 'iRO', clientComplete: true };
	assert.equal(joinAssets.plan({ mode: 'join' }, ready), null, 'off by default');
	assert.equal(joinAssets.plan({ mode: 'host', join_local_assets: true }, ready), null);
	assert.equal(joinAssets.plan({ mode: 'join', join_local_assets: true }, { ...ready, clientComplete: false }), null);
	assert.deepEqual({ ...joinAssets.plan({ mode: 'join', join_local_assets: true }, ready) },
		{ base: 'ro-local://assets/', mods: 'host', era: 'renewal', client: 'iRO' });
	assert.equal(joinAssets.plan({ mode: 'join', join_local_assets: true, join_mod_files: 'local' }, ready).mods, 'local');
});

test('the joining asset server is loopback only, and with the host\'s mods serves only GRFs', () => {
	const host = { HOST: '0.0.0.0', ENABLE_WSPROXY: 'true', WS_ALLOWED_TARGETS: '127.0.0.1:6900', SERVER_ROOT: '/state/assets',
		DATA_OVERRIDE_PATH: '/state/assets/.translation/data', APP_PROXY_PREFIX: '/_friend/remember/', APP_PROXY_TARGET: '127.0.0.1:1',
		WEB_SERVER_TARGET: '127.0.0.1:8888', CLIENT_PUBLIC_URL: 'http://192.168.1.2:3338', CLIENT_DATAINI: '/state/asset-config/DATA.INI' };
	const fromHost = joinAssets.environment(host, { mods: 'host', emptyRoot: '/state/join-assets' });
	assert.equal(fromHost.HOST, '127.0.0.1');
	assert.equal(fromHost.ENABLE_WSPROXY, 'false');
	assert.equal(fromHost.WS_ALLOWED_TARGETS, '');
	for (const key of ['APP_PROXY_PREFIX', 'APP_PROXY_TARGET', 'WEB_SERVER_TARGET', 'CLIENT_PUBLIC_URL', 'DATA_OVERRIDE_PATH']) assert.ok(!(key in fromHost), key);
	assert.equal(fromHost.SERVER_ROOT, '/state/join-assets', 'none of this player\'s own mods');
	assert.equal(fromHost.CLIENT_DATAINI, host.CLIENT_DATAINI, 'their own GRFs');
	const own = joinAssets.environment(host, { mods: 'local', emptyRoot: '/state/join-assets' });
	assert.equal(own.SERVER_ROOT, '/state/assets');
	assert.equal(own.DATA_OVERRIDE_PATH, host.DATA_OVERRIDE_PATH);
	assert.equal(host.HOST, '0.0.0.0', 'the host settings are not changed');
});

test('ro-local reaches the asset reads and nothing else on the asset server', () => {
	for (const [method, p] of [['GET', '/data/sprite/a.spr'], ['HEAD', '/BGM/01.mp3'], ['GET', '/System/itemInfo.lua'], ['POST', '/'], ['POST', '/batch']]) {
		assert.ok(joinAssets.allowed(method, p), `${method} ${p}`);
	}
	for (const [method, p] of [['GET', '/api/missing-files'], ['GET', '/ws/127.0.0.1:6900'], ['GET', '/list-files'], ['GET', '/Config.local.js'],
		['GET', '/'], ['GET', '/join.json'], ['GET', '/.translation/data/x.txt'], ['GET', '/logs/missing-files.log'], ['GET', '/resources/data.grf'],
		['GET', '/data/%2e%2e/x'], ['POST', '/search2'], ['PUT', '/data/a.txt'], ['GET', '/_friend/remember/x']]) {
		assert.ok(!joinAssets.allowed(method, p), `${method} ${p}`);
	}
});

test('the handler forwards to loopback, answers CORS, and is closed while not joined', async () => {
	let active = true;
	const seen = [];
	const handle = joinAssets.handler({
		active: () => active, port: () => 3338,
		fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response('bytes', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' } }); },
	});
	const ok = await handle(new Request('ro-local://assets/data/a.spr?x=1', { headers: { 'accept-encoding': 'gzip', range: 'bytes=0-1' } }));
	assert.equal(ok.status, 200);
	assert.equal(await ok.text(), 'bytes');
	assert.equal(ok.headers.get('access-control-allow-origin'), '*');
	assert.equal(ok.headers.get('content-encoding'), null, 'net.fetch has already inflated it');
	assert.equal(seen[0].url, 'http://127.0.0.1:3338/data/a.spr?x=1');
	assert.equal(seen[0].init.headers.range, 'bytes=0-1');
	assert.ok(!('accept-encoding' in seen[0].init.headers));
	assert.equal((await handle(new Request('ro-local://assets/api/health'))).status, 404);
	assert.equal((await handle(new Request('ro-local://other/data/a.spr'))).status, 404);
	assert.equal((await handle(new Request('ro-local://assets/batch', { method: 'OPTIONS' }))).status, 204);
	active = false;
	assert.equal((await handle(new Request('ro-local://assets/data/a.spr'))).status, 404);
	assert.equal(seen.length, 1);
});

const server = { format: 1, era: 'renewal', client: 'iRO', mods: [], files: ['data/Mod.txt', 'System\\itemInfo.lua'] };

test('the client keeps the host\'s files when this player\'s would not suit the world', async () => {
	const { decide } = await clientModule;
	const plan = { base: 'ro-local://assets/', mods: 'host', era: 'pre-renewal', client: 'iRO' };
	assert.deepEqual(decide(server, plan), { use: 'local' }, 'the era is the host\'s business when mods come from it');
	assert.equal(decide(null, plan).use, 'host', 'an older host');
	assert.equal(decide({ ...server, client: 'kRO' }, plan).use, 'host');
	assert.equal(decide({ ...server, client: null }, plan).use, 'local', 'an undetected client is not refused');
	assert.equal(decide(server, { ...plan, mods: 'local' }).use, 'host', 'own mods need the host\'s era');
	assert.equal(decide(server, { ...plan, mods: 'local', era: 'renewal' }).use, 'local');
});

test('with a plan the client reads its own files, and the host\'s added ones from the host', async () => {
	const { joinAssets: choose } = await clientModule;
	const sent = [];
	const thread = { send: (type, data) => sent.push({ type, data }) };
	const here = 'https://play.example.com/api.html?app=ONLINE';
	const told = [];
	const opts = extra => ({ here, tell: m => told.push(m), get: () => JSON.stringify(server), ...extra });
	assert.equal(choose('/', thread, opts({ plan: null })), '/', 'no plan, nothing changes');
	assert.equal(sent.length, 0);
	const plan = { base: 'ro-local://assets/', mods: 'host', era: 'renewal', client: 'iRO' };
	assert.equal(choose('/', thread, opts({ plan })), 'ro-local://assets/');
	assert.deepEqual(sent, [{ type: 'SET_OVERLAY_HOST', data: { base: 'https://play.example.com/', files: ['data/mod.txt', 'system/iteminfo.lua'] } }]);
	sent.length = 0;
	assert.equal(choose('/', thread, opts({ plan: { ...plan, mods: 'local' } })), 'ro-local://assets/');
	assert.equal(sent.length, 0, 'own mods: everything from this machine');
	assert.equal(choose('/', thread, opts({ plan, get: () => { throw new Error('404'); } })), '/');
	assert.equal(told.length, 1, 'the player is told why');
});

test('the client hooks are installed by the patch script', () => {
	const script = read('scripts/patch-client-controls.py');
	assert.match(script, /const remoteClient = joinAssets\(Configs\.get\('remoteClient'\), Thread\);/);
	assert.match(script, /url = FileManager\.hostFor\(filename\) \+ url;/);
	assert.match(script, /case 'SET_OVERLAY_HOST':/);
	assert.match(read('electron/preload.js'), /exposeInMainWorld\('__RAGNAROK_JOIN_ASSETS__', joinAssets\)/);
});

test('a host can keep its game files, and the gateway says what it forwards is remote', () => {
	const main = read('electron/main.js');
	assert.match(main, /share_game_files: true,/);
	assert.match(main, /REMOTE_GRF_DATA: getSettings\(\)\.share_game_files === false \? 'false' : 'true',/);
	assert.match(main, /require\('\.\/join-assets'\)\.schemePrivileges\]\);/, 'registered with the other privileged schemes');
	assert.match(read('electron/sharing/gateway.js'), /'x-ragnarok-remote': '1'/);
	const settings = read('src/settings.html');
	for (const id of ['mp-share-files', 'mp-own-files', 'mp-mod-files']) assert.match(settings, new RegExp(`id="${id}"`));
});
