'use strict';
// Remembered logins for LAN players: the loopback endpoint
// (electron/sharing/lan-remember.js) on its own, and -- with REMOTECLIENT_BIN
// set to a RemoteClient that has APP_PROXY_PREFIX/APP_PROXY_TARGET -- reached
// the way a LAN player reaches it, through the asset server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { LanRemember } = require('../electron/sharing/lan-remember');
const { createRememberLogin } = require('../electron/remember-login');
const { SHAPE } = require('../electron/sharing/login-token');
const { AssetServer } = require('../electron/asset-server');
const grf = require('./fixtures/grf.cjs');

const WEB_TOKEN = 'a1b2c3d4e5f60718';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fakeSupervisor() {
  const db = { remembered: new Map(), tokens: [] };
  const run = async request => {
    if (request.action === 'remember-issue') {
      if (request.id !== '2000001' || request.webToken !== WEB_TOKEN) throw Error('This login could not be remembered: the game server no longer has this session. Log in again.');
      db.remembered.set(request.credentialHash, request.id);
      if (request.replacesHash) db.remembered.delete(request.replacesHash);
      return { username: 'lan_player' };
    }
    if (request.action === 'remember-resume') {
      if (!db.remembered.has(request.credentialHash)) throw Error('The remembered login is no longer valid. Log in again.');
      db.tokens.push(request.tokenHash);
      return { username: 'lan_player' };
    }
    db.remembered.delete(request.credentialHash);
    return {};
  };
  return { db, remember: createRememberLogin({ run }) };
}

const post = (port, route, { host, origin, cookie, body = {}, forwarded = '192.168.1.30', type = 'application/json', method = 'POST' } = {}) => new Promise((resolve, reject) => {
  const headers = { host, 'content-type': type, 'x-forwarded-for': forwarded };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  const req = http.request({ host: '127.0.0.1', port, path: '/_friend/remember/' + route, method, headers }, res => {
    let text = ''; res.on('data', c => text += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(text) }));
  });
  req.on('error', error => reject(Object.assign(error, { message: `${route} (${method}, ${origin}): ${error.message}` }))); req.end(JSON.stringify(body));
});

test('a LAN player: same routes as the gateway, in a plain-HTTP cookie scoped to the asset port and path', async t => {
  const { db, remember } = fakeSupervisor();
  let lan = true;
  const server = new LanRemember({ remember, enabled: () => lan });
  const port = await server.start();
  t.after(() => server.stop());
  const page = { host: '192.168.1.20:3390', origin: 'http://192.168.1.20:3390' };
  assert.deepEqual((await post(port, 'status', page)).json(), { ok: true, available: true, remembered: false });
  const issued = await post(port, 'issue', { ...page, body: { accountId: '2000001', webToken: WEB_TOKEN } });
  assert.deepEqual(issued.json(), { ok: true, username: 'lan_player' });
  const set = issued.headers['set-cookie'][0];
  // No Secure and no __Host- over HTTP; named for the port, sent only to this path.
  assert.match(set, /^ro-remember-3390=[A-Za-z0-9_-]{43}; Path=\/_friend\/remember\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  const cookie = set.split(';')[0], credential = cookie.split('=')[1];
  assert.ok(db.remembered.has(sha(credential)));
  const resumed = (await post(port, 'resume', { ...page, cookie })).json();
  assert.equal(resumed.username, 'lan_player'); assert.match(resumed.token, SHAPE);
  assert.equal(db.tokens.at(-1), sha(resumed.token));
  // Another port's cookie on the same host is not this world's.
  assert.equal((await post(port, 'status', { ...page, cookie: cookie.replace('3390', '3338') })).json().remembered, false);
  const forgot = await post(port, 'forget', { ...page, cookie });
  assert.match(forgot.headers['set-cookie'][0], /^ro-remember-3390=; .*Max-Age=0$/);
  assert.equal(db.remembered.size, 0);
  // Never the tunnel's cookie, whatever the request claims about its scheme.
  const claimed = await post(port, 'issue', { ...page, body: { accountId: '2000001', webToken: WEB_TOKEN }, forwarded: '192.168.1.33' });
  assert.ok(!/__Host-|Secure/.test(claimed.headers['set-cookie'][0]));
  await post(port, 'forget', { ...page, cookie: claimed.headers['set-cookie'][0].split(';')[0] });
  // HTTPS this app does not terminate (a proxy in front of the LAN port):
  // refused, not given a cookie whose safety would rest on a header.
  const https = await post(port, 'status', { host: page.host, origin: 'https://192.168.1.20:3390' });
  assert.equal(https.status, 403);
  assert.match(https.json().error, /sharing link/);
  // Cross-origin, wrong type, wrong method: refused before anything is asked.
  assert.equal((await post(port, 'status', { ...page, origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(port, 'status', { host: page.host })).status, 403);
  assert.equal((await post(port, 'status', { ...page, type: 'text/plain' })).status, 403);
  assert.equal((await post(port, 'status', { ...page, method: 'GET' })).status, 404);
  assert.equal((await post(port, 'nonsense', page)).status, 404);
  // Ten a minute per LAN address, like the gateway's per session.
  let last;
  for (let i = 0; i < 11; i++) last = await post(port, 'resume', { ...page, cookie, forwarded: '192.168.1.31' });
  assert.equal(last.status, 429);
  assert.equal((await post(port, 'resume', { ...page, cookie, forwarded: '192.168.1.32' })).status, 200, 'another player is not limited');
  // LAN switched off: gone, checked on every request.
  lan = false;
  assert.equal((await post(port, 'status', page)).status, 404);
});

test('api.account: the app window on any loopback port uses IPC, a LAN page posts to its own origin', async () => {
  const { createAccount } = await import('../patches/client/RememberLogin.mjs');
  const invoked = [], fetched = [];
  const invoke = async (name, args) => { invoked.push(args.action); return { ok: true, available: true, remembered: false }; };
  const fetch = async url => { fetched.push(url); return { status: 200, json: async () => ({ ok: true, available: true, remembered: true }) }; };
  for (const origin of ['http://127.0.0.1:3338', 'http://127.0.0.1:3390', 'http://localhost:4000']) {
    await createAccount({ invoke, fetch, origin: () => origin }).status();
  }
  assert.equal(invoked.length, 3);
  assert.equal(fetched.length, 0);
  // A LAN join in the app has `invoke` too; it is not used.
  assert.deepEqual(await createAccount({ invoke, fetch, origin: () => 'http://192.168.1.20:3338' }).status(), { available: true, remembered: true });
  assert.deepEqual(fetched, ['/_friend/remember/status']);
  // Loopback in a plain browser (no invoke): its own origin, like anyone.
  await createAccount({ fetch, origin: () => 'http://127.0.0.1:3338' }).status();
  assert.equal(fetched.length, 2);
});

const executable = process.env.REMOTECLIENT_BIN;
test('through the real asset server: a LAN page reaches the endpoint on its own origin', { skip: !executable && 'set REMOTECLIENT_BIN to a RemoteClient with APP_PROXY_PREFIX' }, async t => {
  const { db, remember } = fakeSupervisor();
  const lan = new LanRemember({ remember });
  const lanPort = await lan.start();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-lan-remember-'));
  const assets = path.join(stateRoot, 'assets');
  fs.mkdirSync(path.join(assets, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'resources', 'data.grf'), grf());
  fs.writeFileSync(path.join(assets, 'resources', 'DATA.INI'), '[Data]\n0=data.grf\n');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = new AssetServer();
  t.after(async () => {
    await server.stop(); await lan.stop();
    await fs.promises.rm(stateRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await server.start({ executable, cwd: stateRoot, stateRoot, environment: {
    PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', SERVER_ROOT: assets, CLIENT_PUBLIC_URL: `http://127.0.0.1:${port}`,
    CLIENT_AUTOEXTRACT: 'false', CLIENT_RESPATH: 'resources/', CLIENT_DATAINI: 'DATA.INI',
    APP_PROXY_PREFIX: '/_friend/remember/', APP_PROXY_TARGET: `127.0.0.1:${lanPort}`,
  } });
  // The browser's Host and Origin: what a LAN player would send.
  const page = { host: `192.168.1.20:${port}`, origin: `http://192.168.1.20:${port}`, forwarded: 'spoofed' };
  const issued = await post(port, 'issue', { ...page, body: { accountId: '2000001', webToken: WEB_TOKEN } });
  assert.equal(issued.status, 200);
  assert.deepEqual(issued.json(), { ok: true, username: 'lan_player' });
  const cookie = issued.headers['set-cookie'][0].split(';')[0];
  assert.match(cookie, new RegExp(`^ro-remember-${port}=`));
  const resumed = (await post(port, 'resume', { ...page, cookie })).json();
  assert.match(resumed.token, SHAPE);
  assert.equal(db.tokens.length, 1);
  assert.equal((await post(port, 'status', { ...page, origin: 'http://evil.example' })).status, 403);
  // Ordinary serving is unchanged.
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/data/fixture.txt`)).text(), 'synthetic archive bytes');
});
