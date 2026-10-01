'use strict';
// Remembered logins, end to end short of a database and a game server:
// electron/remember-login.js (credentials, the host's file store, the IPC
// handler), the friend gateway's /_friend/remember/ routes, the client's
// api.account transport (patches/client/RememberLogin.mjs), and the autologin
// mod's flow (mods/autologin/client/index.js) against a stand-in client API.
// The SQL itself is tested in stack/src/remember.rs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createRememberLogin, createFileStore, handleLocal, proof, CREDENTIAL } = require('../electron/remember-login');
const { SHAPE } = require('../electron/sharing/login-token');
const { FriendGateway } = require('../electron/sharing/gateway');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const WEB_TOKEN = 'a1b2c3d4e5f60718';

// What remember.rs does to the database, in memory. Only hashes reach it.
function fakeSupervisor() {
  const db = { accounts: [{ id: '2000001', username: 'player_one', webToken: WEB_TOKEN, state: 0 }], remembered: new Map(), tokens: [], requests: [] };
  const run = async request => {
    db.requests.push(JSON.parse(JSON.stringify(request)));
    if (request.action === 'remember-issue') {
      const account = db.accounts.find(a => a.id === request.id && a.webToken === request.webToken && a.state === 0);
      if (!account) throw Error('This login could not be remembered: the game server no longer has this session. Log in again.');
      db.remembered.set(request.credentialHash, account.id);
      if (request.replacesHash) db.remembered.delete(request.replacesHash);
      return { username: account.username };
    }
    if (request.action === 'remember-resume') {
      const id = db.remembered.get(request.credentialHash);
      const account = db.accounts.find(a => a.id === id && a.state === 0);
      if (!account) throw Error('The remembered login is no longer valid. Log in again.');
      db.tokens.push({ id, hash: request.tokenHash });
      return { username: account.username };
    }
    if (request.action === 'remember-forget') { db.remembered.delete(request.credentialHash); return { forgotten: true }; }
    throw Error('Unknown account action');
  };
  return { db, run };
}

function memoryStore() {
  const values = new Map();
  return { values, get: key => values.get(key) ?? null, set: (key, value) => values.set(key, value), delete: key => values.delete(key) };
}

test('a remembered login is a random credential the supervisor only ever sees hashed', async () => {
  const { db, run } = fakeSupervisor();
  const remember = createRememberLogin({ run });
  const { credential, username } = await remember.issue({ accountId: 2000001, webToken: WEB_TOKEN });
  assert.match(credential, CREDENTIAL);
  assert.equal(username, 'player_one');
  assert.ok(db.remembered.has(sha(credential)));
  const resumed = await remember.resume(credential);
  assert.equal(resumed.username, 'player_one');
  assert.match(resumed.token, SHAPE);
  assert.equal(db.tokens.at(-1).hash, sha(resumed.token));
  // Neither secret ever crossed to the supervisor.
  const sent = JSON.stringify(db.requests);
  assert.ok(!sent.includes(credential) && !sent.includes(resumed.token));
  // Each resume is a new one-time token.
  assert.notEqual((await remember.resume(credential)).token, resumed.token);
  await remember.forget(credential);
  await assert.rejects(remember.resume(credential), error => error.code === 'revoked');
  await assert.rejects(remember.resume(null), error => error.code === 'none');
  await assert.rejects(remember.resume('not-a-credential'), error => error.code === 'none');
});

test('remembering needs the session the page is in, and a server that is down is not a revocation', async () => {
  const { run } = fakeSupervisor();
  const remember = createRememberLogin({ run });
  await assert.rejects(remember.issue({ accountId: 2000001, webToken: 'ffffffffffffffff' }), /no longer has this session/);
  await assert.rejects(remember.issue({ accountId: 5, webToken: WEB_TOKEN }), error => error.code === 'not-logged-in');
  await assert.rejects(remember.issue({ accountId: 2000001, webToken: '' }), error => error.code === 'unsupported');
  assert.equal(proof({ accountId: '2000001', webToken: WEB_TOKEN + '\0' }).webToken, WEB_TOKEN);
  assert.throws(() => proof({ accountId: '2000001', webToken: "a1b2'; DROP" }), /session token/);
  const down = createRememberLogin({ run: async () => { throw Error('Could not start the account supervisor'); } });
  await assert.rejects(down.resume('A'.repeat(43)), error => error.code === 'unavailable');
});

test('the host window: the credential lives in a file of the app’s own, per era, and is cleared when revoked', async () => {
  const { db, run } = fakeSupervisor();
  const remember = createRememberLogin({ run });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-'));
  try {
    const file = path.join(directory, 'state', 'remembered-login.json');
    const store = createFileStore(file);
    const ask = (action, extra = {}, era = 'renewal') => handleLocal({ action, ...extra }, { remember, store, era });
    assert.deepEqual(await ask('status'), { ok: true, available: true, remembered: false });
    assert.deepEqual(await ask('resume'), { ok: false, code: 'none', error: 'Nothing is remembered.' });
    assert.deepEqual(await ask('issue', { accountId: '2000001', webToken: WEB_TOKEN }), { ok: true, username: 'player_one' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const first = store.get('renewal');
    assert.match(first, CREDENTIAL);
    assert.equal(store.get('prerenewal'), null, 'the other era has its own database');
    // Remembering again replaces, and revokes, the one before.
    await ask('issue', { accountId: '2000001', webToken: WEB_TOKEN });
    assert.notEqual(store.get('renewal'), first);
    assert.ok(!db.remembered.has(sha(first)));
    const resumed = await ask('resume');
    assert.equal(resumed.ok, true); assert.match(resumed.token, SHAPE);
    // Revoked elsewhere (a password change in Settings): forgotten here too.
    db.remembered.clear();
    const stale = await ask('resume');
    assert.equal(stale.code, 'revoked');
    assert.equal(store.get('renewal'), null);
    // Forgetting works even when the supervisor cannot be reached.
    await ask('issue', { accountId: '2000001', webToken: WEB_TOKEN });
    const offline = { remember: createRememberLogin({ run: async () => { throw Error('down'); } }), store, era: 'renewal' };
    assert.deepEqual(await handleLocal({ action: 'forget' }, offline), { ok: true, revoked: false });
    assert.equal(store.get('renewal'), null);
    // A damaged file reads as empty rather than failing.
    fs.writeFileSync(file, '{not json');
    assert.equal(store.get('renewal'), null);
    assert.equal((await ask('nonsense')).code, 'invalid');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

async function gatewayFixture(t, remember, origin = 'https://play.example.com') {
  const gateway = new FriendGateway({ origin, upstreamPort: 9, register: async () => {}, remember });
  const port = await gateway.start(0);
  t.after(() => gateway.stop());
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: new URL(origin).host, ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    }); req.on('error', reject); req.end(body);
  });
  const session = async () => (await request('/_friend/exchange', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ invite: gateway.invite }) })).headers['set-cookie'][0].split(';')[0];
  const post = (cookie, route, body = {}, origin = gateway.origin) => request('/_friend/remember/' + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { gateway, request, session, post };
}

test('a friend: the gateway keeps the credential in an HttpOnly cookie and trades it for login tokens', async t => {
  const { db, run } = fakeSupervisor();
  const f = await gatewayFixture(t, createRememberLogin({ run }));
  const friend = await f.session();
  assert.equal((await f.post('', 'status')).status, 401, 'an invitation session first');
  assert.equal((await f.post(friend, 'status', {}, 'https://evil.example')).status, 403);
  assert.deepEqual((await f.post(friend, 'status')).json(), { ok: true, available: true, remembered: false });
  const issued = await f.post(friend, 'issue', { accountId: '2000001', webToken: WEB_TOKEN });
  assert.deepEqual(issued.json(), { ok: true, username: 'player_one' });
  const set = issued.headers['set-cookie'][0];
  assert.match(set, /^__Host-ro-remember=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  const remembered = set.split(';')[0], credential = remembered.split('=')[1];
  assert.ok(!issued.text.includes(credential), 'the page never sees it');
  assert.ok(db.remembered.has(sha(credential)));
  const both = `${friend}; ${remembered}`;
  assert.equal((await f.post(both, 'status')).json().remembered, true);
  const resumed = (await f.post(both, 'resume')).json();
  assert.equal(resumed.username, 'player_one'); assert.match(resumed.token, SHAPE);
  // Forget: revoked in the database and the cookie cleared.
  const forgot = await f.post(both, 'forget');
  assert.match(forgot.headers['set-cookie'][0], /^__Host-ro-remember=; .*Max-Age=0$/);
  assert.equal(db.remembered.size, 0);
  // A revoked cookie is cleared on its next use, with the reason.
  const stale = await f.post(both, 'resume');
  assert.equal(stale.json().code, 'revoked');
  assert.match(stale.headers['set-cookie'][0], /Max-Age=0/);
  // Bounded like sign-in tokens.
  let last;
  for (let i = 0; i < 12; i++) last = await f.post(both, 'resume');
  assert.equal(last.status, 429);
});

test('a gateway without remembered logins answers 404, so the client says it is unavailable', async t => {
  const f = await gatewayFixture(t, null);
  assert.equal((await f.post(await f.session(), 'status')).status, 404);
});

for (const [kind, origin] of [['a quick trycloudflare tunnel', 'https://calm-river-1234.trycloudflare.com'], ['the host’s own domain (named tunnel)', 'https://play.my-guild.example']])
test(`through ${kind} the cookie is always __Host- and Secure, whatever the request claims`, async t => {
  const { run } = fakeSupervisor();
  const f = await gatewayFixture(t, createRememberLogin({ run }), origin);
  const friend = await f.session();
  const tunnel = /^__Host-ro-remember=[^;]*; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/;
  // A header saying "plain HTTP" changes nothing: the gateway only ever
  // answers through the HTTPS tunnel, and decides by that, not by headers.
  const claim = { 'x-forwarded-proto': 'http', 'x-forwarded-for': '192.168.1.30' };
  const send = (route, cookie, body = {}) => f.request('/_friend/remember/' + route, { method: 'POST',
    headers: { cookie, origin: f.gateway.origin, 'content-type': 'application/json', ...claim }, body: JSON.stringify(body) });
  const issued = await send('issue', friend, { accountId: '2000001', webToken: WEB_TOKEN });
  assert.match(issued.headers['set-cookie'][0], tunnel);
  const remembered = issued.headers['set-cookie'][0].split(';')[0];
  const resumed = await send('resume', `${friend}; ${remembered}`);
  assert.match(resumed.headers['set-cookie'][0], tunnel, 'refreshed on use, still Secure');
  const forgot = await send('forget', `${friend}; ${remembered}`);
  assert.match(forgot.headers['set-cookie'][0], tunnel, 'cleared the same way');
  for (const response of [issued, resumed, forgot]) assert.ok(!/ro-remember-\d/.test(response.headers['set-cookie'][0]), 'never the LAN cookie');
  // The LAN cookie is not read here either: a tunnel request carrying one is not remembered.
  const lanCookie = `ro-remember-3338=${'A'.repeat(43)}`;
  assert.equal((await send('status', `${friend}; ${lanCookie}`)).json().remembered, false);
});

test('api.account goes to the app in the host’s own window and to the gateway anywhere else', async () => {
  const { createAccount } = await import('../patches/client/RememberLogin.mjs');
  const invoked = [], fetched = [];
  const invoke = async (name, args) => { invoked.push([name, args]); return args.action === 'resume' ? { ok: true, username: 'player_one', token: '~AbCdEfGhIjKlMnOpQrStUv' } : { ok: true, available: true, remembered: true, username: 'player_one' }; };
  const fetch = async (url, options) => { fetched.push([url, options.method, JSON.parse(options.body)]); return { status: 404, json: async () => ({}) }; };
  const session = () => ({ accountId: 2000001, webToken: WEB_TOKEN });
  const local = createAccount({ session, invoke, fetch, origin: () => 'http://127.0.0.1:3338' });
  assert.deepEqual(await local.status(), { available: true, remembered: true });
  assert.deepEqual(await local.remember(), { username: 'player_one', secure: true });
  assert.deepEqual(invoked.at(-1), ['remember_login', { action: 'issue', accountId: '2000001', webToken: WEB_TOKEN }]);
  assert.equal((await local.resume()).token, '~AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(fetched.length, 0);
  // A friend's page (the IPC exists in a friend's app too, but is not used).
  const remote = createAccount({ session, invoke, fetch, origin: () => 'https://play.example.com' });
  assert.deepEqual(await remote.status(), { available: false, remembered: false });
  assert.equal(fetched.at(-1)[0], '/_friend/remember/status');
  await assert.rejects(remote.resume(), error => error.code === 'unavailable');
  assert.equal(await remote.forget(), false);
  // Not logged in, or no web token: nothing is asked for.
  const before = invoked.length;
  await assert.rejects(createAccount({ session: () => null, invoke, origin: () => 'http://127.0.0.1:3338' }).remember(), error => error.code === 'not-logged-in');
  await assert.rejects(createAccount({ session: () => ({ accountId: 2000001, webToken: '' }), invoke, origin: () => 'http://127.0.0.1:3338' }).remember(), error => error.code === 'unsupported');
  assert.equal(invoked.length, before);
});

// ---- The mod ---------------------------------------------------------------

function fakeClient({ prefs = {}, account = {} } = {}) {
  const storage = new Map(Object.entries(prefs).map(([k, v]) => [k, JSON.stringify(v)]));
  const listeners = {}, hooks = {}, calls = [];
  const timers = [];
  let player = null;
  const api = {
    version: 1,
    cleanup: () => () => {},
    on(event, fn) { (listeners[event] ||= []).push(fn); return () => {}; },
    snapshot: () => ({ player }),
    preferences: {
      get: (key, fallback) => storage.has(key) ? JSON.parse(storage.get(key)) : fallback,
      set: (key, value) => storage.set(key, JSON.stringify(value)),
    },
    screens: {
      supported: () => true,
      replace(screen, hook) { hooks[screen] = hook; calls.push(['replace', screen]); return () => { if (hooks[screen] === hook) delete hooks[screen]; calls.push(['give back', screen]); }; },
    },
    account: {
      status: async () => ({ available: true, remembered: true }),
      remember: account.remember || (async () => { calls.push(['remember']); return { username: 'player_one' }; }),
      resume: account.resume || (async () => { calls.push(['resume']); return { username: 'player_one', token: '~AbCdEfGhIjKlMnOpQrStUv' }; }),
      forget: async () => { calls.push(['forget']); return true; },
    },
  };
  const keys = {};
  const env = {
    window: { addEventListener: (type, fn) => { keys[type] = fn; }, removeEventListener() {} },
    document: null,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const i = timers.indexOf(timer); if (i > -1) timers.splice(i, 1); },
  };
  const emit = (event, value) => (listeners[event] || []).forEach(fn => fn(value));
  // Run every timer due now (0 ms), or all of them.
  const tick = (all = false) => {
    for (let round = 0; round < 10; round++) {
      const due = timers.filter(timer => all || timer.ms === 0);
      if (!due.length) return;
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    }
  };
  const login = { root: null, calls: [], login(user, pass) { this.calls.push([user, pass]); } };
  const charSelect = (characters, enabled = true) => ({ root: null, characters, enabled, played: [], play(slot) { this.played.push(slot); } });
  return {
    api, env, hooks, calls, emit, tick, login, charSelect,
    state: () => JSON.parse(storage.get('state') || '{}'),
    enterMap(characterId, name) { player = { id: 2000001, characterId, name }; emit('map:enter', { name: 'prontera' }); },
    shift(down) { keys[down ? 'keydown' : 'keyup']({ key: 'Shift', type: down ? 'keydown' : 'keyup' }); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const HERO = { id: 150001, slot: 2, name: 'Hero', deletePending: false };

test('the first game: nothing is driven, and the login and the character are remembered on the map', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient();
  assert.equal(createAutologin(c.api, {}, c.env).begin(), false);
  assert.deepEqual(c.hooks, {}, 'the screens are the client’s');
  c.enterMap(150001, 'Hero');
  await settle();
  assert.deepEqual(c.state(), { remembered: true, username: 'player_one', characterId: 150001, characterName: 'Hero', refusals: 0, plainHttpNoted: false });
  // Warping is not a new login.
  c.enterMap(150001, 'Hero');
  await settle();
  assert.equal(c.calls.filter(([name]) => name === 'remember').length, 1);
});

test('a relaunch logs in with a fresh token and plays the remembered character without drawing either screen', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient({ prefs: { state: { remembered: true, username: 'player_one', characterId: 150001, characterName: 'Hero' } } });
  const mod = createAutologin(c.api, {}, c.env);
  assert.equal(mod.begin(), true);
  assert.ok(c.hooks.login && c.hooks.charSelect);
  c.hooks.login.show(c.login);
  await settle();
  assert.deepEqual(c.login.calls, [['player_one', '~AbCdEfGhIjKlMnOpQrStUv']]);
  c.hooks.login.hide();
  const view = c.charSelect([]);
  c.hooks.charSelect.show(view);           // the list is still arriving
  assert.deepEqual(view.played, []);
  c.tick();                                // the login hook goes now
  assert.equal(c.hooks.login, undefined);
  const full = c.charSelect([{ id: 150002, slot: 0, name: 'Alt' }, HERO]);
  c.hooks.charSelect.update(full);
  assert.deepEqual(full.played, [2]);
  c.hooks.charSelect.hide();               // Play closes the window
  c.enterMap(150001, 'Hero');
  c.tick();
  assert.deepEqual(c.hooks, {}, 'both screens are the client’s again');
  assert.equal(mod.stage, 'idle');
  await settle();
  assert.equal(c.calls.filter(([name]) => name === 'remember').length, 0, 'already remembered');
});

test('Escape -> Character select forgets the character; the next launch logs in and stops there', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient({ prefs: { state: { remembered: true, username: 'player_one', characterId: 150001 } } });
  createAutologin(c.api, {}, c.env);
  c.emit('exit', { to: 'charSelect', from: 'escape' });
  assert.equal(c.state().characterId, null);
  assert.equal(c.state().remembered, true);
  const next = fakeClient({ prefs: { state: c.state() } });
  createAutologin(next.api, {}, next.env).begin();
  assert.ok(next.hooks.login);
  assert.equal(next.hooks.charSelect, undefined, 'character select is shown');
});

test('Escape -> Exit, or Cancel on character select, revokes the remembered login', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  for (const from of ['escape', 'charSelect']) {
    const c = fakeClient({ prefs: { state: { remembered: true, username: 'player_one', characterId: 150001 } } });
    createAutologin(c.api, {}, c.env);
    c.emit('exit', { to: 'login', from });
    assert.deepEqual(c.calls.at(-1), ['forget']);
    assert.equal(c.state().remembered, false);
    assert.equal(c.state().characterId, null);
  }
});

test('holding Shift at launch skips it once, and Shift during the sign-in stops it', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const prefs = { state: { remembered: true, username: 'player_one', characterId: 150001 } };
  let c = fakeClient({ prefs });
  let mod = createAutologin(c.api, {}, c.env);
  c.shift(true);
  assert.equal(mod.begin(), false);
  assert.deepEqual(c.hooks, {});
  assert.equal(c.state().remembered, true, 'nothing forgotten');
  c = fakeClient({ prefs });
  mod = createAutologin(c.api, {}, c.env);
  mod.begin();
  c.shift(true);
  c.hooks.login.show(c.login);
  c.tick();
  assert.deepEqual(c.login.calls, []);
  assert.deepEqual(c.hooks, {});
});

test('a revoked credential falls back to the login screen and clears what is stale', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient({ prefs: { state: { remembered: true, username: 'player_one', characterId: 150001 } },
    account: { resume: async () => { throw Object.assign(Error('The remembered login is no longer valid. Log in again.'), { code: 'revoked' }); } } });
  createAutologin(c.api, {}, c.env).begin();
  c.hooks.login.show(c.login);
  await settle();
  c.tick();
  assert.deepEqual(c.hooks, {});
  assert.equal(c.state().remembered, false);
  assert.equal(c.state().characterId, null);
});

test('a server that is unreachable leaves the remembered login for next time', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient({ prefs: { state: { remembered: true, characterId: 150001 } },
    account: { resume: async () => { throw Object.assign(Error('down'), { code: 'unavailable' }); } } });
  createAutologin(c.api, {}, c.env).begin();
  c.hooks.login.show(c.login);
  await settle();
  c.tick();
  assert.deepEqual(c.hooks, {});
  assert.equal(c.state().remembered, true);
});

test('a token the login server refuses twice in a row is given up on', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  let prefs = { state: { remembered: true, characterId: 150001 } };
  for (const expected of [true, false]) {
    const c = fakeClient({ prefs });
    createAutologin(c.api, {}, c.env).begin();
    c.hooks.login.show(c.login);
    await settle();
    c.hooks.login.hide();
    c.hooks.login.show(c.login);             // back again: refused
    c.tick();
    assert.deepEqual(c.hooks, {});
    assert.equal(c.state().remembered, expected);
    prefs = { state: c.state() };
  }
});

test('a character that is gone, or waiting to be deleted, stops at character select and is forgotten', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  for (const characters of [[{ id: 150002, slot: 0, name: 'Alt' }], [{ ...HERO, deletePending: true }]]) {
    const c = fakeClient({ prefs: { state: { remembered: true, characterId: 150001, characterName: 'Hero' } } });
    createAutologin(c.api, {}, c.env).begin();
    c.hooks.login.show(c.login);
    await settle();
    const view = c.charSelect(characters);
    c.hooks.charSelect.show(view);
    c.tick(true);
    assert.deepEqual(view.played, []);
    assert.deepEqual(c.hooks, {});
    assert.equal(c.state().characterId, null);
    assert.equal(c.state().remembered, true, 'still logged in for you');
  }
});

test('with "Also play my last character" off, it logs in and stops at character select', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const c = fakeClient({ prefs: { state: { remembered: true, characterId: 150001 } } });
  createAutologin(c.api, { remember_character: false }, c.env).begin();
  assert.ok(c.hooks.login);
  assert.equal(c.hooks.charSelect, undefined);
});

test('the client runtime: api.account goes through the bridge, and exit reaches plugins frozen', async () => {
  const { createRuntime } = await import('../patches/client/ExtensionRuntime.mjs');
  const runtime = createRuntime({ storage: null, report() {} });
  const asked = [];
  runtime.configure({ account: {
    status: async () => ({ available: true, remembered: false }),
    remember: async () => { asked.push('remember'); return { username: 'player_one' }; },
    resume: async () => { asked.push('resume'); return { username: 'player_one', token: '~AbCdEfGhIjKlMnOpQrStUv' }; },
    forget: async () => { asked.push('forget'); return true; },
  } });
  const { api, dispose } = runtime.scope('autologin');
  assert.deepEqual(await api.account.status(), { available: true, remembered: false });
  assert.ok(Object.isFrozen(await api.account.resume()));
  assert.equal(await api.account.forget(), true);
  const seen = [];
  api.on('exit', event => seen.push(event), { replay: false });
  runtime.exit({ to: 'charSelect', from: 'escape' });
  runtime.exit({ to: 'somewhere', from: 'escape' });   // not a destination
  assert.deepEqual(seen, [{ to: 'charSelect', from: 'escape' }]);
  assert.ok(Object.isFrozen(seen[0]));
  dispose();
  await assert.rejects(api.account.resume(), /disposed/);
  // A client without the bridge: unavailable, never a crash.
  const bare = createRuntime({ storage: null }).scope('x').api;
  assert.deepEqual(await bare.account.status(), { available: false, remembered: false });
  await assert.rejects(bare.account.remember(), error => error.code === 'unavailable');
  assert.deepEqual(asked, ['resume', 'forget']);
});

test('over plain HTTP (a LAN address) the player is told once that the network can see it', async () => {
  const { createAutologin } = await import('../mods/autologin/client/index.js');
  const notes = [];
  const c = fakeClient({ account: { remember: async () => ({ username: 'lan_player', secure: false }) } });
  c.env.document = { body: { appendChild: node => notes.push(node.textContent) }, createElement: () => ({ style: {}, remove() {} }) };
  createAutologin(c.api, {}, c.env);
  c.enterMap(150001, 'Hero');
  await settle();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /plain HTTP/);
  assert.equal(c.state().plainHttpNoted, true);
  // Not again, on a later login.
  const again = fakeClient({ prefs: { state: c.state() }, account: { remember: async () => ({ username: 'lan_player', secure: false }) } });
  const more = [];
  again.env.document = { body: { appendChild: node => more.push(node.textContent) }, createElement: () => ({ style: {}, remove() {} }) };
  createAutologin(again.api, {}, again.env);
  again.enterMap(150001, 'Hero');
  await settle();
  assert.equal(more.length, 0);
});
