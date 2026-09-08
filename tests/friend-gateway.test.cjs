'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { FriendGateway, Frames } = require('../electron/sharing/gateway');
async function fixture(t) {
  const observed = [];
  const upstream = http.createServer((req, res) => { observed.push({ url: req.url, headers: req.headers }); res.setHeader('cache-control', 'public,max-age=99999'); res.end('asset'); });
  upstream.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => {}); socket.on('error', () => {}); socket.on('end', () => socket.destroy());
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  let registrations = 0;
  const gateway = new FriendGateway({ origin: 'https://play.example.com', upstreamPort: upstream.address().port, register: async () => { registrations++; } });
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
  return { gateway, port, observed, request, exchange, login, socket, registrations: () => registrations };
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
  assert.equal(response.status, 200); assert.equal(response.text, 'asset'); assert.match(response.headers['cache-control'], /no-store/);
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
