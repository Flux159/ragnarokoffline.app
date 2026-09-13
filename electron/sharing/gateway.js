'use strict';
// The only tunnel origin. The Rust RemoteClient and all RO TCP listeners stay
// loopback-only. No request is privileged because its peer is loopback.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { LoginPackets, LoginLimits } = require('./login-limits');
const token = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE = '__Host-ro-friend';
const LIMIT = 64 * 1024;
const safeHeaders = {
  'cache-control': 'private, no-store', 'cdn-cache-control': 'no-store',
  'cloudflare-cdn-cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
};
function publicPath(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//')) return false;
  const decoded = raw.split('?')[0].replace(/%([a-f0-9]{2})/ig, (_, n) => String.fromCharCode(parseInt(n, 16))).toLowerCase();
  if (/[\\%\x00-\x1f\x7f]/.test(decoded)) return false;
  const pieces = decoded.split('/').filter(Boolean);
  if (pieces.some(p => p.startsWith('.'))) return false;
  if (['logs', 'resources', 'api', '_control', 'control', 'private', 'ws'].includes(pieces[0])) return false;
  if (/\.(grf|gpf|ini|conf|log|sql|pem|key)$/.test(decoded)) return false;
  if (['/list-files', '/overlay.id'].includes(decoded)) return false;
  return true;
}
async function body(req, limit = LIMIT) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Validate frame boundaries without buffering game payloads or changing RO
// bytes. Backpressure is preserved through the two pipes. An attacker cannot
// ask the Rust endpoint to accumulate an arbitrarily large fragmented message.
class Frames extends Transform {
  constructor(masked, inspect) { super(); this.masked = masked; this.inspect = inspect; this.header = Buffer.alloc(0); this.left = 0; this.message = 0; this.fragmented = false; }
  _flush(done) { done(this.header.length || this.left || this.fragmented ? Error('Incomplete game frame') : undefined); }
  _transform(chunk, encoding, done) {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.left) {
          const count = Math.min(this.left, chunk.length - offset);
          if (this.inspect && this.dataFrame) {
            const decoded = Buffer.alloc(count);
            for (let i = 0; i < count; i++) decoded[i] = chunk[offset + i] ^ this.mask[(this.position + i) % 4];
            this.inspect(decoded); this.position += count;
          }
          this.push(chunk.subarray(offset, offset + count)); offset += count; this.left -= count;
          continue;
        }
        this.header = Buffer.concat([this.header, chunk.subarray(offset, ++offset)]);
        if (this.header.length < 2) continue;
        const size = this.header[1] & 127;
        const length = 2 + (size === 126 ? 2 : size === 127 ? 8 : 0) + (this.masked ? 4 : 0);
        if (this.header.length < length) continue;
        const opcode = this.header[0] & 15, final = !!(this.header[0] & 128);
        if ((this.header[0] & 112) || !!(this.header[1] & 128) !== this.masked || ![0, 1, 2, 8, 9, 10].includes(opcode)) throw Error('Invalid frame');
        const bytes = size === 126 ? this.header.readUInt16BE(2) : size === 127 ? Number(this.header.readBigUInt64BE(2)) : size;
        if (this.inspect && (bytes > 1024 || opcode === 1)) throw Error('Invalid login frame');
        if (!Number.isSafeInteger(bytes) || bytes > 1024 * 1024 || (opcode >= 8 && (!final || bytes > 125))) throw Error('Frame limit');
        if (opcode < 8) {
          if ((opcode === 0) !== this.fragmented) throw Error('Invalid continuation');
          this.message += bytes;
          if (this.message > 1024 * 1024) throw Error('Message limit');
          this.fragmented = !final;
          if (final) this.message = 0;
        }
        this.dataFrame = opcode < 8; this.position = 0;
        if (this.inspect) this.mask = this.header.subarray(-4);
        this.left = bytes; this.push(this.header); this.header = Buffer.alloc(0);
      }
      done();
    } catch { done(Error('Invalid or oversized game frame')); }
  }
}
class FriendGateway {
  constructor({ origin, upstreamPort = 3338, register, now = Date.now, lifetime = 8 * 60 * 60 * 1000, maxSessions = 32, invite = null }) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw Error('An HTTPS game hostname is required');
    Object.assign(this, { origin, upstreamPort, register, now, lifetime, maxSessions });
    this.host = url.host; this.sessions = new Map(); this.sockets = new Set(); this.requests = new Set();
    // A supplied invitation survives restarts, so a link already sent to
    // friends keeps working after a crash or a repair. Only a token of the
    // right shape is accepted; anything else is replaced rather than trusted.
    this.invite = TOKEN.test(invite || '') ? invite : token();
    this.inviteHash = digest(this.invite); this.expires = now() + lifetime;
    this.challenge = token(); this.attempts = []; this.closed = false; this.pendingRegistrations = 0;
    this.loginLimits = new LoginLimits(now);
  }
  probeSession() {
    const value = token(), key = digest(value);
    const entry = { expires: this.now() + 30000, sockets: new Set(), registrations: 1, registering: false, attempts: 5 };
    this.sessions.set(key, entry);
    return { cookie: COOKIE + '=' + value, close: () => { for (const socket of entry.sockets) socket.destroy(); this.sessions.delete(key); } };
  }
  link() { return this.origin + '/#invite=' + this.invite; }
  session(req) {
    const values = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
    if (values.length !== 1) return null;
    const value = values[0].slice(COOKIE.length + 1);
    if (!TOKEN.test(value)) return null;
    const entry = this.sessions.get(digest(value));
    return entry && entry.expires > this.now() && this.expires > this.now() ? entry : null;
  }
  reply(res, status, data, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { ...safeHeaders, 'content-type': type, ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
  }
  sameOrigin(req) { return req.headers.origin === this.origin; }
  async handle(req, res) {
    if (this.closed || req.headers.host !== this.host) return this.reply(res, 421, { error: 'Unknown game host' });
    // Public readiness has no paths, versions, counters, identities or secrets.
    if (req.method === 'GET' && req.url === '/_friend/health') return this.reply(res, 200, { service: 'ragnarok-friends', challenge: this.challenge });
    if (req.method === 'GET' && req.url === '/_friend/portal.js') return this.reply(res, 200,
      fs.readFileSync(path.join(__dirname, 'portal.js')), 'text/javascript; charset=utf-8');
    const entry = this.session(req);
    if (req.method === 'POST' && req.url === '/_friend/exchange') {
      if (!this.sameOrigin(req) || req.headers['content-type'] !== 'application/json') return this.reply(res, 403, { error: 'Open the original invitation link' });
      this.attempts = this.attempts.filter(time => time > this.now() - 60000);
      if (this.attempts.length >= 60) return this.reply(res, 429, { error: 'Too many attempts. Try again in a minute.' });
      this.attempts.push(this.now());
      let input; try { input = JSON.parse(await body(req, 1024)); } catch { return this.reply(res, 400, { error: 'Invalid invitation' }); }
      if (!TOKEN.test(input.invite || '') || digest(input.invite) !== this.inviteHash || this.expires <= this.now()) return this.reply(res, 403, { error: 'This invitation expired or was replaced. Ask your friend for a new link.' });
      if (entry) return this.reply(res, 200, { ok: true });
      if (this.sessions.size >= this.maxSessions) return this.reply(res, 429, { error: 'This host has reached its friend limit.' });
      const value = token();
      this.sessions.set(digest(value), { expires: this.expires, sockets: new Set(), registrations: 0, registering: false, attempts: 0 });
      // An invitation set never to expire has Infinity here, which is not a
      // cookie value. Browsers cap Max-Age at 400 days anyway, so clamp to
      // that: the cookie outliving the process is harmless, because a session
      // is only valid while this gateway is the one holding it.
      const maxAge = Math.min(400 * 86400, Math.max(0, Math.floor((this.expires - this.now()) / 1000)));
      return this.reply(res, 200, { ok: true }, undefined, { 'set-cookie': `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` });
    }
    if (req.method === 'GET' && ['/','/api.html?app=ONLINE','/_friend/'].includes(req.url) && (!entry || req.url === '/_friend/')) {
      return this.reply(res, entry ? 200 : 401, fs.readFileSync(path.join(__dirname, 'portal.html')), 'text/html; charset=utf-8', {
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
    }
    if (!entry) return this.reply(res, 401, { error: 'A current invitation is required' });
    if (req.url === '/_friend/session' && req.method === 'GET') return this.reply(res, 200, { ok: true });
    if (req.url === '/_friend/register' && req.method === 'POST') {
      if (!this.sameOrigin(req) || req.headers['content-type'] !== 'application/json') return this.reply(res, 403, { error: 'Open the original invitation link' });
      if (this.pendingRegistrations >= 2) return this.reply(res, 429, { error: 'Another friend is creating an account. Try again shortly.' });
      if (!this.register || entry.registrations >= 1 || entry.registering || entry.attempts >= 5) return this.reply(res, 409, { error: 'Use your existing game account or ask the host for help.' });
      let input; try { input = JSON.parse(await body(req, 2048)); } catch { return this.reply(res, 400, { error: 'Invalid account details' }); }
      // Reading a body yields: another request can register or revoke this
      // invitation in the meantime. Reserve capacity only after rechecking.
      if (this.closed || this.session(req) !== entry) return this.reply(res, 401, { error: 'A current invitation is required' });
      if (this.pendingRegistrations >= 2 || entry.registrations >= 1 || entry.registering || entry.attempts >= 5) return this.reply(res, 409, { error: 'Use your existing game account or ask the host for help.' });
      entry.registering = true; entry.attempts++; this.pendingRegistrations++;
      try {
        await this.register({ username: input.username, password: input.password, confirmation: input.confirmation }, () => !this.closed && this.session(req) === entry);
        entry.registrations++; this.reply(res, 200, { ok: true });
      } catch { this.reply(res, 400, { error: 'Could not create that account. Check the name/password rules, or try another account name.' }); }
      finally { entry.registering = false; this.pendingRegistrations--; }
      return;
    }
    if (!['GET', 'HEAD', 'POST'].includes(req.method) || !publicPath(req.url)) return this.reply(res, 404, { error: 'Not found' });
    let bytes;
    if (req.method === 'POST') {
      if (!this.sameOrigin(req) || !['/', '/search', '/batch'].includes(req.url)) return this.reply(res, 403, { error: 'Not allowed' });
      try { bytes = await body(req); } catch { return this.reply(res, 413, { error: 'Request too large' }); }
      if (req.url === '/batch') {
        try {
          const input = JSON.parse(bytes);
          if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 50 || input.files.some(file => !publicPath('/' + file))) throw Error();
        } catch { return this.reply(res, 400, { error: 'Invalid asset batch' }); }
      }
    }
    if (this.closed || this.session(req) !== entry) return this.reply(res, 401, { error: 'A current invitation is required' });
    const headers = { host: '127.0.0.1:' + this.upstreamPort };
    for (const name of ['accept', 'accept-encoding', 'content-type']) if (req.headers[name]) headers[name] = req.headers[name];
    if (bytes) headers['content-length'] = bytes.length;
    const search = req.method === 'POST' && ['/', '/search'].includes(req.url);
    if (search) headers['accept-encoding'] = 'identity';
    const proxy = http.request({ host: '127.0.0.1', port: this.upstreamPort, path: req.url, method: req.method, headers, agent: false, timeout: 30000 }, response => {
      // Never forward cookies, redirects, CORS headers or public cache policy.
      const output = { ...safeHeaders };
      for (const name of ['content-type', 'content-encoding', 'content-length']) if (response.headers[name]) output[name] = response.headers[name];
      if (response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); return this.reply(res, 502, { error: 'Unexpected game redirect' }); }
      if (search) {
        let result = '', count = 0;
        response.on('data', chunk => { count += chunk.length; if (count > 1024 * 1024) response.destroy(); else result += chunk; });
        response.on('error', () => res.destroy());
        response.on('end', () => this.reply(res, response.statusCode, result.split('\n').filter(file => publicPath('/' + file)).join('\n'), 'text/plain; charset=utf-8'));
      } else { res.writeHead(response.statusCode, output); response.pipe(res); }
    });
    this.requests.add(proxy); proxy.once('close', () => this.requests.delete(proxy));
    proxy.on('timeout', () => proxy.destroy());
    proxy.on('error', () => { if (!res.headersSent) this.reply(res, 502, { error: 'The game server is reconnecting. Try again shortly.' }); else res.destroy(); });
    res.on('close', () => proxy.destroy()); proxy.end(bytes);
  }
  upgrade(req, socket, head) {
    const entry = this.session(req);
    const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
    if (this.closed || req.headers.host !== this.host || !entry || !this.sameOrigin(req) || !/^\/ws\/127\.0\.0\.1:(6900|6121|5121)$/.test(req.url) || entry.sockets.size >= 4 || req.headers['sec-websocket-version'] !== '13') return reject();
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject();
    const proxy = http.request({ host: '127.0.0.1', port: this.upstreamPort, path: req.url, agent: false, timeout: 10000,
      headers: { host: '127.0.0.1:' + this.upstreamPort, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': key } });
    this.requests.add(proxy); entry.sockets.add(socket);
    const close = () => { proxy.destroy(); socket.destroy(); entry.sockets.delete(socket); this.requests.delete(proxy); };
    socket.on('error', close); socket.on('close', close);
    proxy.on('error', close); proxy.on('timeout', close); proxy.on('response', close);
    proxy.on('upgrade', (response, upstream, initial) => {
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== accept) { upstream.destroy(); return close(); }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const login = req.url.endsWith(':6900') ? new LoginPackets(name => this.loginLimits.allow(entry, name)) : null;
      const incoming = new Frames(true, login ? bytes => login.consume(bytes) : undefined), outgoing = new Frames(false);
      incoming.on('error', close); outgoing.on('error', close); upstream.on('error', close);
      upstream.on('close', close); socket.once('close', () => upstream.destroy());
      if (head.length) incoming.write(head); if (initial.length) outgoing.write(initial);
      socket.pipe(incoming).pipe(upstream); upstream.pipe(outgoing).pipe(socket);
    });
    proxy.end();
  }
  async start(port = 3339) {
    this.server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) this.reply(res, 400, { error: 'Invalid request' }); else res.destroy(); });
    });
    this.server.maxConnections = 256;
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('clientError', (_, socket) => socket.destroy());
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    this.timer = setInterval(() => {
      for (const [key, entry] of this.sessions) if (entry.expires <= this.now()) {
        for (const socket of entry.sockets) socket.destroy(); this.sessions.delete(key);
      }
    }, 1000); this.timer.unref();
    return this.server.address().port;
  }
  revoke() {
    for (const entry of this.sessions.values()) for (const socket of entry.sockets) socket.destroy();
    this.sessions.clear(); this.invite = token(); this.inviteHash = digest(this.invite); this.expires = this.now() + this.lifetime;
    return this.link();
  }
  async stop() {
    this.closed = true; clearInterval(this.timer); this.revoke();
    for (const request of this.requests) request.destroy();
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
  }
}
module.exports = { FriendGateway, Frames, publicPath };
