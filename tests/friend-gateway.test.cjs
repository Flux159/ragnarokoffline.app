'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { FriendGateway, Frames, cachePolicy, ifNoneMatch } = require('../electron/sharing/gateway');
async function fixture(t, options = {}) {
  const observed = [], connections = [];
  // Headers as robrowser-remoteclient sends them (src/http.rs, src/routes.rs).
  const upstream = http.createServer((req, res) => {
    observed.push({ url: req.url, headers: req.headers });
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/index.html' || path === '/Config.local.js' || path === '/overlay.id') { res.setHeader('cache-control', 'no-store'); return res.end('generated'); }
    if (path === '/Online.js') {
      const etag = 'W/"4-18f"', modified = 'Tue, 07 Oct 2025 10:00:00 GMT';
      res.setHeader('cache-control', 'public, max-age=0'); res.setHeader('etag', etag); res.setHeader('last-modified', modified);
      if (String(req.headers['if-none-match'] || '').split(',').map(s => s.trim()).includes(etag) || req.headers['if-modified-since'] === modified) { res.statusCode = 304; return res.end(); }
      return res.end('code');
    }
    if (/\.(spr|act|bmp)$/.test(path)) {
      const etag = '"5d41402abc4b2a76"';
      res.setHeader('cache-control', 'public, max-age=86400, immutable'); res.setHeader('etag', etag); res.setHeader('vary', 'Accept-Encoding');
      if (String(req.headers['if-none-match'] || '').split(',').map(s => s.trim()).includes(etag)) { res.statusCode = 304; return res.end(); }
      res.setHeader('last-modified', new Date().toUTCString()); return res.end('asset');
    }
    if (path === '/moved') { res.statusCode = 302; res.setHeader('location', 'https://evil.example/'); return res.end(); }
    res.setHeader('cache-control', 'no-cache, no-store, must-revalidate'); res.setHeader('etag', '"x"'); res.end('other');
  });
  upstream.on('connection', socket => connections.push(socket));
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {}); socket.on('error', () => {}); socket.on('end', () => socket.destroy());
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let registrations = 0;
  const gateway = new FriendGateway({ origin: 'https://play.example.com', upstreamPort: upstream.address().port, register: async () => { registrations++; }, ...options });
  const port = await gateway.start(0);
  t.after(async () => { await gateway.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: 'play.example.com', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
  const exchange = invite => request('/_friend/exchange', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ invite: invite || gateway.invite }) });
  const login = async () => (await exchange()).headers['set-cookie'][0].split(';')[0];
  const socket = (cookie, origin = gateway.origin, url = '/ws/127.0.0.1:6900') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers: { host: 'play.example.com', origin, cookie, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': crypto.randomBytes(16).toString('base64') } });
    req.on('upgrade', (_, socket) => resolve(socket)); req.on('response', res => { res.resume(); reject(Error(String(res.statusCode))); }); req.on('error', reject); req.end();
  });
  return { gateway, port, observed, connections, request, exchange, login, socket, registrations: () => registrations };
}
test('all game assets, search, batches and WS require an invitation, including loopback/forged forwarded peers', async t => {
  const f = await fixture(t);
  for (const url of ['/data/a.spr', '/search', '/batch', '/list-files', '/api/health', '/api/cache-stats']) {
    const r = await f.request(url, { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost' } }); assert.equal(r.status, 401, url);
  }
  await assert.rejects(f.socket(''), /403/);
  assert.equal(f.observed.length, 0);
  assert.equal((await f.request('/')).status, 401);
  const health = await f.request('/_friend/health'); assert.equal(health.status, 200); assert.doesNotMatch(health.text, /state|path|version|password|token/);
});
test('exchange cookies are secure, private, bounded; proxy strips credentials/cache policy and denies private paths', async t => {
  const f = await fixture(t), auth = await f.exchange();
  assert.equal(auth.status, 200); assert.match(auth.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
  const cookie = auth.headers['set-cookie'][0].split(';')[0];
  const response = await f.request('/data/a.spr', { headers: { cookie, authorization: 'Bearer private-sentinel', 'x-forwarded-host': 'forged' } });
  assert.equal(response.status, 200); assert.equal(response.text, 'asset'); assert.equal(response.headers['cache-control'], 'private, no-cache');
  assert.equal(response.headers['cdn-cache-control'], 'no-store'); assert.equal(response.headers['cloudflare-cdn-cache-control'], 'no-store');
  assert.equal(f.observed[0].headers.cookie, undefined); assert.equal(f.observed[0].headers.authorization, undefined);
  for (const url of ['/logs/a', '/%6cogs/a', '/%252e%252e/key', '/data/../.private', '/resources/a', '/data.grf', '/api/cache-stats', '/api/missing-files']) assert.equal((await f.request(url, { headers: { cookie } })).status, 404, url);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie, host: 'wrong.example.com' } })).status, 421);
  assert.equal((await f.request('/batch', { method: 'POST', headers: { cookie, origin: f.gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ files: ['data.grf'] }) })).status, 400);
});
test('only same-origin invited players may create one account; revocation closes active game sockets', async t => {
  const f = await fixture(t), cookie = await f.login();
  const post = origin => f.request('/_friend/register', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await post('https://evil.example')).status, 403); assert.equal(f.registrations(), 0);
  assert.equal((await post(f.gateway.origin)).status, 200); assert.equal((await post(f.gateway.origin)).status, 409); assert.equal(f.registrations(), 1);
  await assert.rejects(f.socket(cookie, 'https://evil.example'), /403/);
  await assert.rejects(f.socket(cookie, f.gateway.origin, '/ws/127.0.0.1:3306'), /403/);
  const socket = await f.socket(cookie), closed = once(socket, 'close'); socket.resume();
  const invite = f.gateway.invite; f.gateway.revoke(); await closed;
  assert.equal((await f.exchange(invite)).status, 403);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie } })).status, 401);
});
test('expired invitations and sessions stop HTTP and active WS access', async t => {
  const f = await fixture(t), cookie = await f.login(), socket = await f.socket(cookie); socket.resume();
  const closed = once(socket, 'close'); f.gateway.now = () => Date.now() + 24 * 60 * 60 * 1000;
  assert.equal((await f.exchange()).status, 403);
  assert.equal((await f.request('/data/a.spr', { headers: { cookie } })).status, 401);
  await closed;
});
test('an ended friend link logs which side ended it', async t => {
  const lines = [], f = await fixture(t, { log: line => lines.push(line) }), cookie = await f.login();
  const ended = async () => { for (let i = 0; i < 100 && lines.length === count; i++) await new Promise(resolve => setTimeout(resolve, 10)); count = lines.length; return lines.at(-1); };
  let count = 0;
  // A dropped connection: the socket just goes, with no WebSocket close frame.
  let socket = await f.socket(cookie); socket.resume(); socket.destroy();
  assert.match(await ended(), /^friend link \/ws\/127\.0\.0\.1:6900 ended after \d+ s: the friend's connection closed without a goodbye .*bytes out$/);
  // Leaving the game: a masked, empty close frame first.
  socket = await f.socket(cookie); socket.resume(); socket.end(Buffer.from([0x88, 0x80, 1, 2, 3, 4]));
  assert.match(await ended(), /: the friend closed the game;/);
  // A frame the gateway refuses.
  socket = await f.socket(cookie); socket.resume(); socket.on('error', () => {}); socket.write(Buffer.from([0x82, 0x01, 0, 0, 0, 0, 0]));
  assert.match(await ended(), /: the friend sent invalid or oversized game frame;/);
  // This host ending it.
  socket = await f.socket(cookie); socket.resume(); f.gateway.revoke();
  assert.match(await ended(), /: the invitation was replaced;/);
});
test('slow concurrent account requests cannot bypass the one-account limit or invitation revocation', async t => {
  const f = await fixture(t), cookie = await f.login();
  async function slow() {
    let finish;
    const response = new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, path: '/_friend/register', method: 'POST',
        headers: { host: 'play.example.com', origin: f.gateway.origin, cookie, 'content-type': 'application/json', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write('{'); finish = () => req.end('}');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    return { finish, response };
  }
  const first = await slow(), second = await slow();
  first.finish(); assert.equal(await first.response, 200);
  second.finish(); assert.equal(await second.response, 409); assert.equal(f.registrations(), 1);
  const g = await fixture(t), invite = await g.login();
  let complete;
  const rejected = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: g.port, path: '/_friend/register', method: 'POST',
      headers: { host: 'play.example.com', origin: g.gateway.origin, cookie: invite, 'content-type': 'application/json', 'content-length': 2 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{'); complete = () => req.end('}');
  });
  await new Promise(resolve => setTimeout(resolve, 20)); g.gateway.revoke(); complete();
  assert.equal(await rejected, 401); assert.equal(g.registrations(), 0);
});
test('WebSocket framing preserves split payloads and rejects oversized or unmasked client messages', async () => {
  const frame = Buffer.from([0x82, 0x83, 1, 2, 3, 4, 10, 11, 12]);
  const filter = new Frames(true), output = []; filter.on('data', chunk => output.push(chunk));
  for (const byte of frame) filter.write(Buffer.from([byte])); filter.end(); await once(filter, 'end'); assert.deepEqual(Buffer.concat(output), frame);
  for (const bad of [Buffer.from([0x82, 0]), Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0, 1, 2, 3, 4])]) {
    const invalid = new Frames(true); const error = once(invalid, 'error'); invalid.end(bad); assert.match((await error)[0].message, /Invalid|oversized|Incomplete/);
  }
});

test('a stored invitation is reused so a shared link survives a restart', () => {
  const origin = 'https://example.invalid';
  // The shape the gateway mints: 32 random bytes, base64url, 43 characters.
  const saved = crypto.randomBytes(32).toString('base64url');
  const restarted = new FriendGateway({ origin, invite: saved });
  assert.equal(restarted.invite, saved, 'the stored token is adopted as-is');
  assert.ok(restarted.link().endsWith('#invite=' + saved));

  // Anything that is not a token of the right shape is replaced rather than
  // trusted -- a truncated or hand-edited store must not weaken the invitation.
  for (const bad of ['', 'short', null, undefined, 'x'.repeat(43) + '!', 'y'.repeat(44)]) {
    const fresh = new FriendGateway({ origin, invite: bad });
    assert.notEqual(fresh.invite, bad);
    assert.match(fresh.invite, /^[A-Za-z0-9_-]{43}$/, `replaced a bad stored value: ${bad}`);
  }

  // Replacing is still what changes it, and the new one is a different token.
  const before = restarted.invite;
  restarted.revoke();
  assert.notEqual(restarted.invite, before);
  assert.match(restarted.invite, /^[A-Za-z0-9_-]{43}$/);
});

// Host routes (electron/mod-host/): the gateway's half. The manager behind
// `modHost` has its own tests in mod-host.test.cjs.
test('a mod host route needs an invitation, a known mod, same-origin writes and a bounded body; only status/type/body come back', async t => {
  const calls = [];
  const modHost = async (name, request, meta) => {
    calls.push({ name, request, meta });
    if (name !== 'echo') return null;
    return { status: 201, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ got: request.body })) };
  };
  const f = await fixture(t, { modHost });
  const route = '/_friend/mod/echo/say/hi?x=1&y=2';
  // Before an invitation: nothing reaches a mod, whatever the peer claims.
  assert.equal((await f.request(route, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  assert.equal(calls.length, 0);
  const cookie = await f.login();
  const post = (url, { origin = f.gateway.origin, type = 'application/json', body = '{"a":1}', method = 'POST', extra = {} } = {}) =>
    f.request(url, { method, headers: { cookie, origin, 'content-type': type, ...extra }, body });
  // Unknown mod, a name that is not a mod name, an unsupported method.
  assert.equal((await f.request('/_friend/mod/nobody/x', { headers: { cookie } })).status, 404);
  assert.equal((await f.request('/_friend/mod/../x', { headers: { cookie } })).status, 404);
  assert.equal((await f.request('/_friend/mod/echo/x', { method: 'PATCH', headers: { cookie } })).status, 404);
  const before = calls.length;
  // Cross-origin writes, wrong body types and oversized bodies never reach it.
  assert.equal((await post(route, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(route, { method: 'DELETE', origin: 'https://evil.example', body: '' })).status, 403);
  assert.equal((await post(route, { type: 'application/x-www-form-urlencoded', body: 'a=1' })).status, 415);
  assert.equal((await post(route, { body: 'x'.repeat(201 * 1024) })).status, 413);
  assert.equal(calls.length, before);
  // A good one: what the handler sees, and what comes back.
  const ok = await post(route, { extra: { authorization: 'Bearer private-sentinel', accept: 'application/json', 'x-forwarded-for': '10.0.0.9' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(JSON.parse(ok.text), { got: '{"a":1}' });
  const seen = calls.at(-1);
  assert.equal(seen.name, 'echo');
  assert.deepEqual(seen.request, { method: 'POST', path: '/say/hi', query: 'x=1&y=2', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"a":1}' });
  assert.equal(seen.meta.from, 'friend');
  assert.match(seen.meta.client, /^[a-f0-9]{64}$/, 'rate-limited per invitation session, by its hash');
  assert.equal(JSON.stringify(seen).includes('private-sentinel'), false);
  assert.equal(JSON.stringify(seen).includes(cookie.split('=')[1]), false, 'the session cookie never reaches a mod');
  assert.match(ok.headers['cache-control'], /no-store/);
  assert.match(ok.headers['content-security-policy'], /sandbox/);
  assert.equal(ok.headers['set-cookie'], undefined);
  assert.equal(ok.headers['content-length'], String(Buffer.byteLength(ok.text)));
  // A GET needs no Origin (the session cookie is SameSite=Strict) and has no body.
  const get = await f.request('/_friend/mod/echo', { headers: { cookie } });
  assert.equal(get.status, 201);
  assert.deepEqual({ path: calls.at(-1).request.path, body: calls.at(-1).request.body, method: calls.at(-1).request.method }, { path: '/', body: null, method: 'GET' });
});

test('without a modHost every /_friend/mod/ path is a 404, and a throwing one is a 502', async t => {
  const plain = await fixture(t);
  const cookie = await plain.login();
  assert.equal((await plain.request('/_friend/mod/echo/x', { headers: { cookie } })).status, 404);
  const broken = await fixture(t, { modHost: async () => { throw Error('secret detail'); } });
  const cookie2 = await broken.login();
  const r = await broken.request('/_friend/mod/echo/x', { headers: { cookie: cookie2 } });
  assert.equal(r.status, 502);
  assert.doesNotMatch(r.text, /secret detail/);
});
test('cache policy: upstream caching becomes private revalidation; no-store and unknown stay no-store', () => {
  assert.equal(cachePolicy('public, max-age=86400, immutable'), 'private, no-cache');
  assert.equal(cachePolicy('public, max-age=0'), 'private, no-cache');
  assert.equal(cachePolicy('no-cache'), 'private, no-cache');
  assert.equal(cachePolicy('no-store'), 'private, no-store');
  assert.equal(cachePolicy('no-cache, no-store, must-revalidate'), 'private, no-store');
  assert.equal(cachePolicy('public'), 'private, no-store');
  assert.equal(cachePolicy(undefined), 'private, no-store');
  assert.equal(ifNoneMatch('W/"5d41402abc4b2a76"'), 'W/"5d41402abc4b2a76", "5d41402abc4b2a76"');
  assert.equal(ifNoneMatch('"a", W/"b"'), '"a", W/"b", "b"');
  assert.equal(ifNoneMatch('*'), '*');
  assert.equal(ifNoneMatch('junk\r\nx: y'), null);
});
test('assets pass validators and 304s through, privately; generated pages stay no-store', async t => {
  const f = await fixture(t), cookie = await f.login();
  const strict = r => {
    assert.equal(r.headers['cdn-cache-control'], 'no-store'); assert.equal(r.headers['cloudflare-cdn-cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['referrer-policy'], 'no-referrer'); assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.doesNotMatch(r.headers['cache-control'], /public|max-age|immutable/);
  };
  const cold = await f.request('/data/sprite/a.spr', { headers: { cookie } });
  assert.equal(cold.status, 200); assert.equal(cold.text, 'asset'); strict(cold);
  assert.equal(cold.headers['cache-control'], 'private, no-cache'); assert.equal(cold.headers.etag, '"5d41402abc4b2a76"'); assert.equal(cold.headers.vary, 'Accept-Encoding');
  // The second load: the browser revalidates and gets an empty 304, including
  // when Cloudflare handed it a weakened copy of the ETag.
  for (const tag of [cold.headers.etag, 'W/' + cold.headers.etag]) {
    const warm = await f.request('/data/sprite/a.spr', { headers: { cookie, 'if-none-match': tag } });
    assert.equal(warm.status, 304, tag); assert.equal(warm.text, ''); strict(warm);
    assert.equal(warm.headers['cache-control'], 'private, no-cache'); assert.equal(warm.headers.etag, cold.headers.etag);
    assert.match(f.observed.at(-1).headers['if-none-match'], /(^|, )"5d41402abc4b2a76"/);
  }
  const code = await f.request('/Online.js', { headers: { cookie } });
  assert.equal(code.headers['cache-control'], 'private, no-cache'); assert.equal(code.headers.etag, 'W/"4-18f"'); assert.ok(code.headers['last-modified']);
  assert.equal((await f.request('/Online.js', { headers: { cookie, 'if-none-match': code.headers.etag } })).status, 304);
  assert.equal((await f.request('/Online.js', { headers: { cookie, 'if-modified-since': code.headers['last-modified'] } })).status, 304);
  assert.equal(f.observed.at(-1).headers['if-modified-since'], code.headers['last-modified']);
  for (const url of ['/', '/index.html', '/Config.local.js', '/overlay.id', '/data/a.json']) {
    const r = await f.request(url, { headers: { cookie, 'if-none-match': '"x"' } });
    assert.equal(r.status, 200, url); assert.equal(r.headers['cache-control'], 'private, no-store', url); assert.equal(r.headers.etag, undefined, url); strict(r);
  }
  // Still no other redirect, and still nothing without a session.
  assert.equal((await f.request('/moved', { headers: { cookie } })).status, 502);
  const before = f.observed.length;
  const anonymous = await f.request('/data/sprite/a.spr', { headers: { 'if-none-match': cold.headers.etag } });
  assert.equal(anonymous.status, 401); assert.equal(anonymous.headers['cache-control'], 'private, no-store'); assert.equal(f.observed.length, before);
});
test('validators are not sent with a POST, and cookies and other headers still are not forwarded', async t => {
  const f = await fixture(t), cookie = await f.login();
  await f.request('/data/sprite/a.spr', { headers: { cookie, 'if-none-match': '"5d41402abc4b2a76"', 'if-modified-since': 'not a date', range: 'bytes=0-1', 'if-match': '"y"' } });
  const sent = f.observed.at(-1).headers;
  assert.equal(sent['if-modified-since'], undefined); assert.equal(sent.range, undefined); assert.equal(sent['if-match'], undefined); assert.equal(sent.cookie, undefined);
  await f.request('/batch', { method: 'POST', headers: { cookie, origin: f.gateway.origin, 'content-type': 'application/json', 'if-none-match': '"5d41402abc4b2a76"' }, body: JSON.stringify({ files: ['data/a.spr'] }) });
  assert.equal(f.observed.at(-1).headers['if-none-match'], undefined);
});
test('asset requests reuse a bounded pool of upstream connections, closed with the gateway', async t => {
  const f = await fixture(t), cookie = await f.login();
  for (let i = 0; i < 20; i++) assert.equal((await f.request(`/data/sprite/${i}.spr`, { headers: { cookie } })).status, 200);
  assert.equal(f.connections.length, 1);
  await Promise.all(Array.from({ length: 40 }, (_, i) => f.request(`/data/sprite/p${i}.spr`, { headers: { cookie } })));
  assert.ok(f.connections.length <= 16, String(f.connections.length));
  await f.gateway.stop();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(f.connections.every(socket => socket.destroyed));
});
