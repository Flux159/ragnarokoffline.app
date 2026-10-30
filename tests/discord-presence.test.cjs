'use strict';
// Discord Rich Presence: the IPC framing, what the status says, the
// connection's behaviour against a fake Discord, and the game page's reporter.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { socketPaths, encode, decode, buildActivity, createPresence, fetchAssetNames, MIN_GAP_MS } = require('../electron/discord-presence');

test('frames round-trip, and a partial frame waits for the rest', () => {
  const a = encode(1, { cmd: 'SET_ACTIVITY', n: 1 });
  const b = encode(3, { ping: true });
  const both = Buffer.concat([a, b]);
  const first = decode(both.subarray(0, a.length + 5));
  assert.deepEqual(first.frames, [{ op: 1, data: { cmd: 'SET_ACTIVITY', n: 1 } }]);
  assert.equal(first.rest.length, 5);
  const second = decode(Buffer.concat([first.rest, both.subarray(a.length + 5)]));
  assert.deepEqual(second.frames, [{ op: 3, data: { ping: true } }]);
  assert.equal(second.rest.length, 0);
});

test('Linux looks in XDG_RUNTIME_DIR, then the Flatpak and Snap folders', () => {
  const paths = socketPaths({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
  assert.equal(paths[0], '/run/user/1000/discord-ipc-0');
  assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
  assert.ok(paths.includes('/run/user/1000/snap.discord/discord-ipc-0'));
  assert.ok(paths.includes('/tmp/discord-ipc-9'));
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(socketPaths({ platform: 'win32', env: {} })[0], '\\\\?\\pipe\\discord-ipc-0');
});

const STATE = { map: 'prontera', mapName: 'Prontera', name: 'Steve', job: 4013, baseLevel: 99, jobLevel: 50, partySize: 3 };
const jobName = id => ({ 4013: 'Assassin Cross' })[id] || '';

test('the status shows job and level, and only what the player allowed', () => {
  const all = buildActivity(STATE, { name: true, map: true, party: true }, { jobName, startedAt: 1000, joined: false });
  assert.equal(all.details, 'Steve · Lv 99/50 Assassin Cross');
  assert.equal(all.state, 'Prontera · In a party');
  assert.deepEqual(all.party, { size: [3, 12] });
  assert.deepEqual(all.timestamps, { start: 1000 });
  assert.equal(all.assets.large_image, 'map_prontera');
  assert.equal(all.assets.large_text, 'Prontera');
  assert.equal(all.assets.small_image, 'job_thief');
  assert.equal(all.assets.small_text, 'Assassin Cross');
  assert.equal(all.buttons, undefined, 'no buttons unless asked');

  const none = buildActivity(STATE, { name: false, map: false, party: false }, { jobName });
  assert.equal(none.details, 'Lv 99/50 Assassin Cross');
  assert.equal(none.state, undefined);
  assert.equal(none.party, undefined);
  assert.ok(!JSON.stringify(none).includes('Steve'));
  assert.ok(!JSON.stringify(none).includes('rontera'));

  assert.equal(buildActivity(null, {}, { joined: true }).details, 'Choosing a character');
  assert.match(buildActivity(null, {}, { joined: true }).assets.large_text, /friend/);
});

test('a map name that is not plain text falls back to the map id', () => {
  const a = buildActivity({ ...STATE, mapName: 'ÇÁ·ÐÅ×¶ó' }, { map: true }, { jobName });
  assert.equal(a.state, 'prontera');
  // Discord refuses fields over 128 characters.
  const long = buildActivity({ ...STATE, name: 'x'.repeat(24), job: 4013 }, { name: true }, { jobName: () => 'y'.repeat(200) });
  assert.ok(long.details.length <= 128);
});

function fakeDiscord() {
  const sockets = [];
  const connect = p => {
    const s = new EventEmitter();
    s.path = p;
    s.written = [];
    s.write = buf => { s.written.push(...decode(buf).frames); return true; };
    s.destroy = () => {};
    s.end = () => {};
    sockets.push(s);
    process.nextTick(() => (p === 'good' ? s.emit('connect') : s.emit('error', new Error('ENOENT'))));
    return s;
  };
  return { sockets, connect };
}
const tick = () => new Promise(r => setImmediate(r));

test('handshakes, waits for READY, then sets the activity; repeats are not sent', async () => {
  const d = fakeDiscord();
  let clock = 100000;
  const timers = [];
  const p = createPresence({ clientId: '123456789012345678', connect: d.connect, paths: ['missing', 'good'], now: () => clock,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} } });
  p.set({ details: 'one' });
  await tick(); await tick();
  const s = d.sockets.find(x => x.path === 'good');
  assert.deepEqual(s.written[0], { op: 0, data: { v: 1, client_id: '123456789012345678' } });
  assert.equal(s.written.length, 1, 'nothing before READY');
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
  assert.equal(s.written[1].data.cmd, 'SET_ACTIVITY');
  assert.deepEqual(s.written[1].data.args.activity, { details: 'one' });
  p.set({ details: 'one' });
  assert.equal(s.written.length, 2);
  // Pings are answered.
  s.emit('data', encode(3, { x: 1 }));
  assert.deepEqual(s.written[2], { op: 4, data: { x: 1 } });
  // A change right away waits out Discord's rate limit, then goes.
  p.set({ details: 'two' });
  assert.equal(s.written.length, 3);
  const wait = timers.at(-1);
  assert.ok(wait.ms > 0 && wait.ms <= MIN_GAP_MS);
  clock += MIN_GAP_MS;
  wait.fn();
  assert.deepEqual(s.written[3].data.args.activity, { details: 'two' });
  assert.equal(p.status().connected, true);
  p.stop();
  assert.equal(s.written[4].data.args.activity, undefined, 'stop clears the status');
});

test('no application id means no connection at all', async () => {
  const d = fakeDiscord();
  const p = createPresence({ clientId: '', connect: d.connect, paths: ['good'] });
  p.set({ details: 'x' });
  await tick();
  assert.equal(d.sockets.length, 0);
});

test('the game page reports changes only, and stops when the app says no', async () => {
  const { startPresence } = await import('../patches/client/DiscordPresence.mjs');
  const calls = [];
  let state = { map: 'prontera', baseLevel: 1 };
  let poll;
  const p = startPresence({ invoke: (name, args) => { calls.push([name, args]); return Promise.resolve(true); }, read: () => state, every: fn => { poll = fn; } });
  assert.deepEqual(calls, [['presence_update', { state: { map: 'prontera', baseLevel: 1 } }]]);
  poll(); p.poke();
  assert.equal(calls.length, 1);
  state = { map: 'prontera', baseLevel: 2 };
  poll();
  assert.equal(calls.length, 2);

  const refused = [];
  const q = startPresence({ invoke: () => { refused.push(1); return Promise.reject(new Error('unknown command')); }, read: () => ({ n: refused.length }), every() {} });
  await tick();
  q.poke();
  assert.equal(refused.length, 1);

  // A browser tab has no invoke.
  assert.doesNotThrow(() => startPresence({ invoke: undefined, read: () => ({}) }).poke());
});

test('the game page may call presence_update, and Settings may turn it off', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /GAME_PAGE_HANDLERS = new Set\(\[[^\]]*'presence_update'/);
  for (const key of ['discord_presence', 'discord_show_name', 'discord_show_map', 'discord_show_party']) {
    assert.match(main, new RegExp(`APP_PREFERENCES = new Set\\(\\[[^\\]]*'${key}'`));
  }
  assert.match(main, /discord_show_name: false/);
  const settings = require('../electron/settings-store');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ discord_presence: 'yes' }));
  assert.throws(() => settings.read(file, {}), /Discord/);
});

// ---------------------------------------------------------------------------
// Discord announcements (electron/discord-webhook.js, registry/mods/discord-announcements)
// ---------------------------------------------------------------------------
const hooks = require('../electron/discord-webhook');
const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABC-123';

test('only Discord webhook links are taken', () => {
  assert.equal(hooks.parseWebhook(HOOK).hint, '…-123');
  assert.ok(hooks.parseWebhook(HOOK.replace('discord.com', 'canary.discord.com')));
  assert.ok(hooks.parseWebhook(HOOK.replace('discord.com', 'discordapp.com')));
  for (const bad of ['', 'http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
    'https://evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz',
    'https://discord.com.evil.example/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', HOOK + '?wait=true']) {
    assert.equal(hooks.parseWebhook(bad), null, bad);
  }
});

test('the webhook is kept in a private file and never comes back in full', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-'));
  const store = hooks.store(dir);
  assert.equal(store.read(), null);
  assert.throws(() => store.write('https://example.com/x'), /webhook link/);
  store.write(HOOK);
  assert.equal(store.read().url, HOOK);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'private', 'discord-webhook.json')).mode & 0o777, 0o600);
  store.clear();
  assert.equal(store.read(), null);
});

test('[discord] debug lines are announcements, other lines are not', () => {
  assert.equal(hooks.announcement('[Debug]: script debug : 2000001 110000123 : [discord] **Steve** reached base level 99!'), '**Steve** reached base level 99!');
  assert.equal(hooks.announcement('[Debug]: script debug : 0 110000123 : [discord] War of Emperium has begun.'), 'War of Emperium has begun.');
  assert.equal(hooks.announcement("[Info]: 'Steve' logged in. (AID/CID: '2000001/150000')"), null);
  assert.equal(hooks.announcement('[Debug]: script debug : 0 1 : map-spawn-rate: 3 maps changed'), null);
  assert.match(hooks.announcement("[Status]: Server is 'ready' and listening on port '5121'."), /online/);
  assert.equal(hooks.announcement("[Status]: Server is 'ready' and listening on port '5121'.", { world: false }), null);
});

function fakeTimers() {
  const pending = [];
  return { pending, timers: { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimeout() {} },
    async run() { const t = pending.shift(); t.fn(); await tick(); await tick(); } };
}

test('lines are batched into one message, with mentions off', async () => {
  const posts = [];
  const t = fakeTimers();
  const sender = hooks.createSender({ getUrl: () => HOOK, timers: t.timers,
    fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; } });
  for (let i = 0; i < 12; i++) sender.add(`line ${i}`);
  assert.equal(t.pending.length, 1);
  await t.run();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, HOOK);
  assert.equal(posts[0].body.content.split('\n').length, hooks.MAX_LINES);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  await t.run();
  assert.equal(posts[1].body.content, 'line 10\nline 11');
});

test('a 429 waits as long as Discord says, then sends the same lines', async () => {
  const posts = [];
  const t = fakeTimers();
  let first = true;
  const sender = hooks.createSender({ getUrl: () => HOOK, timers: t.timers,
    fetch: async (url, opts) => {
      posts.push(JSON.parse(opts.body).content);
      if (first) { first = false; return { ok: false, status: 429, json: async () => ({ retry_after: 3 }) }; }
      return { ok: true, status: 204 };
    } });
  sender.add('MVP!');
  await t.run();
  assert.equal(t.pending[0].ms, 3000);
  await t.run();
  assert.deepEqual(posts, ['MVP!', 'MVP!']);
});

test('a deleted webhook drops the queue; no webhook queues nothing', async () => {
  const logs = [];
  const t = fakeTimers();
  const sender = hooks.createSender({ getUrl: () => HOOK, timers: t.timers, log: m => logs.push(m), fetch: async () => ({ ok: false, status: 404 }) });
  sender.add('a'); sender.add('b');
  await t.run();
  assert.equal(sender.pending(), 0);
  assert.match(logs[0], /deleted/);
  const none = hooks.createSender({ getUrl: () => null, timers: t.timers, fetch: async () => { throw new Error('no'); } });
  none.add('x');
  assert.equal(none.pending(), 0);
});

test('the announcer follows the map log only while a webhook is set, and skips the backlog', () => {
  let url = null;
  const added = [];
  let listener = null;
  let stopped = 0;
  const now = Date.parse('2026-10-27T21:00:00Z');
  const a = hooks.createAnnouncer({
    subscribe: (ids, fn) => { assert.deepEqual(ids, ['map']); listener = fn; return () => { stopped++; }; },
    getUrl: () => url, sender: { add: l => added.push(l) }, now: () => now,
  });
  a.refresh();
  assert.equal(listener, null);
  url = HOOK;
  a.refresh();
  assert.ok(a.following());
  listener({ time: '2026-10-27T20:50:00Z', text: 'script debug : 1 2 : [discord] old news', level: 'debug' });
  listener({ time: '2026-10-27T21:00:05Z', text: 'script debug : 1 2 : [discord] fresh', level: 'debug' });
  listener({ time: '2026-10-27T21:00:06Z', text: '— map server stopped —', level: 'marker' });
  assert.deepEqual(added, ['fresh']);
  url = null;
  a.refresh();
  assert.equal(stopped, 1);
  assert.ok(!a.following());
});

test('the discord-announcements mod writes [discord] lines and skips AI characters', () => {
  const dir = path.join(__dirname, '..', 'registry', 'mods', 'discord-announcements');
  const mod = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
  assert.equal(mod.default, 'off');
  const keys = mod.settings.map(s => s.key);
  for (const key of keys.filter(k => k.startsWith('announce_'))) {
    assert.ok(fs.existsSync(path.join(dir, 'npc', 'when', key)), `npc/when/${key}`);
  }
  const scripts = [path.join(dir, 'npc', 'levels.txt'), ...['announce_logins', 'announce_mvps'].map(k => path.join(dir, 'npc', 'when', k, fs.readdirSync(path.join(dir, 'npc', 'when', k))[0]))];
  for (const file of scripts) {
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /debugmes "\[discord\] /, file);
    assert.match(body, /population_is_shell\(getcharid\(3\)\)/, file);
  }
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  for (const name of ['discord_webhook_status', 'discord_webhook_set', 'discord_webhook_clear', 'discord_webhook_test']) {
    assert.ok(!new RegExp(`GAME_PAGE_HANDLERS = new Set\\(\\[[^\\]]*'${name}'`).test(main), `${name} is not for the game page`);
  }
});

test('a player can give their own application id, checked on the way in', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /discord_app_id: null/);
  assert.match(main, /discord_set_app_id: \(\{ id \}\)/);
  assert.ok(!/GAME_PAGE_HANDLERS = new Set\(\[[^\]]*'discord_set_app_id'/.test(main), 'not for the game page');
  // Environment first, then the saved id, then the build's.
  assert.match(main, /process\.env\.RAGNAROK_OFFLINE_DISCORD_APP_ID \|\| saved \|\| DISCORD_APP_ID/);
  const settings = require('../electron/settings-store');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-id-')), 'settings.json');
  assert.equal(settings.write(file, { discord_app_id: '123456789012345678' }, {}).discord_app_id, '123456789012345678');
  assert.equal(settings.write(file, { discord_app_id: null }, {}).discord_app_id, null);
  for (const bad of ['abc', '123', 123456789012345678, '1234567890123456789012345678']) {
    assert.throws(() => settings.write(file, { discord_app_id: bad }, {}), /application ID/, String(bad));
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'settings.html'), 'utf8');
  assert.match(html, /id="discord-app-id"/);
  assert.match(html, /discord\.com\/developers\/applications/);
});

test('maps show their region, jobs their line, and the links are public ones', () => {
  const { regionOf, familyOf, REGIONS, FAMILIES } = require('../electron/discord-presence');
  assert.equal(regionOf('prt_fild08'), 'prontera');
  assert.equal(regionOf('pay_dun04'), 'payon');
  assert.equal(regionOf('gef_fild10'), 'geffen');
  assert.equal(regionOf('prtg_cas01'), 'guild');
  assert.equal(regionOf('iz_dun02'), 'izlude');
  assert.equal(regionOf('some_custom_map'), '');
  for (const [key] of REGIONS) assert.match(key, /^[a-z_]{2,24}$/);
  assert.equal(familyOf('Baby Rune Knight'), 'swordman');
  assert.equal(familyOf('Guillotine Cross T'), 'thief');
  assert.equal(familyOf('High Novice'), 'novice');
  assert.equal(familyOf('Spirit Handler'), 'summoner');
  assert.equal(familyOf('Wedding'), '');
  // Every job rAthena names, apart from the outfits, has a line.
  const body = fs.readFileSync(path.join(__dirname, '..', 'tools', 'control-panel', 'job-names.js'), 'utf8');
  const names = new Set(Object.values(JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1))));
  const outfits = new Set(['Wedding', 'Christmas', 'Summer', 'Hanbok', 'Oktoberfest', 'Gangsi', 'Death Knight', 'Dark Collector']);
  for (const n of names) if (!outfits.has(n)) assert.ok(familyOf(n), `no line for ${n}`);
  assert.equal(Object.keys(FAMILIES).length, 12);
  assert.equal(familyOf('Baby Karnos'), 'druid');

  const hidden = buildActivity(STATE, { map: false, buttons: true }, { jobName });
  assert.equal(hidden.assets.large_image, 'logo', 'a hidden map shows no map art either');
  assert.equal(hidden.buttons.length, 2);
  for (const b of hidden.buttons) {
    assert.match(b.url, /^https:\/\/(github\.com\/Flux159\/|discord\.gg\/)/);
    assert.ok(b.label.length <= 32);
  }
  assert.equal(buildActivity(null, { buttons: true }, {}).buttons.length, 2);
});

test('a picture the application has not uploaded is left out, so the logo shows', async () => {
  const state = { map: 'gon_fild01', mapName: 'Kunlun Field', job: 24, baseLevel: 50, jobLevel: 20 };
  const jobName = () => 'Gunslinger';
  const all = buildActivity(state, { map: true }, { jobName, assets: null });
  assert.equal(all.assets.large_image, 'map_gonryun');
  assert.equal(all.assets.small_image, 'job_gunslinger');
  const some = buildActivity(state, { map: true }, { jobName, assets: new Set(['logo', 'map_prontera']) });
  assert.equal(some.assets.large_image, 'logo');
  assert.equal(some.assets.small_image, undefined);

  let asked;
  const names = await fetchAssetNames('1564743117444354220', {
    fetch: async url => { asked = url; return { ok: true, json: async () => [{ name: 'logo' }, { name: 'job_mage' }, {}] }; },
  });
  assert.match(asked, /\/oauth2\/applications\/1564743117444354220\/assets$/);
  assert.deepEqual([...names].sort(), ['job_mage', 'logo']);
  assert.equal(await fetchAssetNames('1564743117444354220', { fetch: async () => ({ ok: false }) }), null);
  assert.equal(await fetchAssetNames('1564743117444354220', { fetch: async () => { throw new Error('offline'); } }), null);
  assert.equal(await fetchAssetNames('not-an-id', { fetch: async () => { throw new Error('asked'); } }), null);
});

// ---------------------------------------------------------------------------
// Ask to Join (electron/discord-presence.js, joinFromDiscord in main.js)
// ---------------------------------------------------------------------------
const LINK = 'https://play.example.com/#invite=' + 'A'.repeat(43);

test('Ask to Join puts the link in the secret, a party id beside it, and drops the buttons', () => {
  const state = { map: 'prontera', job: 0, baseLevel: 10, jobLevel: 5, partySize: 3 };
  const join = { partyId: 'abcdef0123456789', secret: LINK };
  const a = buildActivity(state, { party: true, buttons: true }, { join });
  assert.deepEqual(a.secrets, { join: LINK });
  assert.deepEqual(a.party, { id: 'abcdef0123456789', size: [3, 12] });
  assert.equal(a.buttons, undefined);
  // Party hidden: still a party for Discord, of one.
  assert.deepEqual(buildActivity(state, { party: false }, { join }).party.size, [1, 12]);
  // At character select too.
  assert.deepEqual(buildActivity(null, {}, { join }).secrets, { join: LINK });
  // Too long for Discord, or no offer: an ordinary status, buttons kept.
  for (const bad of [null, { partyId: 'x1', secret: LINK + 'x'.repeat(100) }, { secret: LINK }]) {
    const plain = buildActivity(state, { buttons: true }, { join: bad });
    assert.equal(plain.secrets, undefined);
    assert.ok(plain.buttons);
  }
});

test('join events are asked for at READY, delivered, and requests are answered', async () => {
  const d = fakeDiscord();
  const joins = [];
  const asks = [];
  const p = createPresence({ clientId: '123456789012345678', connect: d.connect, paths: ['good'],
    onJoin: s => joins.push(s), onJoinRequest: u => asks.push(u) });
  p.set({ details: 'one' });
  await tick(); await tick();
  const s = d.sockets[0];
  assert.equal(p.respond('123456789012345678', true), false, 'nothing to answer on before READY');
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
  const subscribed = s.written.filter(f => f.data && f.data.cmd === 'SUBSCRIBE').map(f => f.data.evt);
  assert.deepEqual(subscribed, ['ACTIVITY_JOIN', 'ACTIVITY_JOIN_REQUEST']);
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN', data: { secret: LINK } }));
  assert.deepEqual(joins, [LINK]);
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN_REQUEST', data: { user: { id: '223456789012345678', username: 'pal', global_name: 'Pal' } } }));
  s.emit('data', encode(1, { cmd: 'DISPATCH', evt: 'ACTIVITY_JOIN_REQUEST', data: { user: { id: 'nope' } } }));
  assert.deepEqual(asks, [{ id: '223456789012345678', name: 'Pal' }]);
  assert.ok(p.respond('223456789012345678', true));
  assert.ok(p.respond('223456789012345678', false));
  assert.equal(p.respond('bad', true), false);
  const answers = s.written.slice(-2).map(f => [f.data.cmd, f.data.args.user_id]);
  assert.deepEqual(answers, [['SEND_ACTIVITY_JOIN_INVITE', '223456789012345678'], ['CLOSE_ACTIVITY_REQUEST', '223456789012345678']]);
  p.stop();
});

test('without join handlers nothing is subscribed', async () => {
  const d = fakeDiscord();
  const p = createPresence({ clientId: '123456789012345678', connect: d.connect, paths: ['good'] });
  p.set({ details: 'one' });
  await tick(); await tick();
  d.sockets[0].emit('data', encode(1, { cmd: 'DISPATCH', evt: 'READY', data: {} }));
  assert.equal(d.sockets[0].written.filter(f => f.data && f.data.cmd === 'SUBSCRIBE').length, 0);
  p.stop();
});

test('Ask to Join is off by default, a preference, and joins only an HTTPS invitation', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.match(main, /discord_ask_to_join: false/);
  assert.match(main, /APP_PREFERENCES = new Set\(\[[^\]]*'discord_ask_to_join'/);
  assert.match(main, /DISCORD_PREFERENCES = new Set\(\[[^\]]*'discord_ask_to_join'/);
  // Offered only while hosting and sharing; the joining side checks the link.
  assert.match(main, /settings\.discord_ask_to_join \|\| getClientPaths\(\)\.mode !== 'host' \|\| !sharing \|\| sharing\.state !== 'sharing'/);
  assert.match(main, /origin\.startsWith\('https:\/\/'\) \|\| !\/\^#invite=/);
  const settings = require('../electron/settings-store');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discord-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ discord_ask_to_join: 'yes' }));
  assert.throws(() => settings.read(file, {}), /Discord/);
});
