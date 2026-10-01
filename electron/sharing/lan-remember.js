'use strict';
// Remembered logins for players who join over LAN (the autologin mod).
//
// A LAN player loads the game straight from the host's asset server,
// http://<host LAN address>:<asset port>, so the remembered-login cookie has to
// belong to that origin. The asset server (robrowser-remoteclient, its
// APP_PROXY_PREFIX/APP_PROXY_TARGET) forwards POSTs under /_friend/remember/ to
// this endpoint, which listens on loopback only and answers with the same
// routes as the friend gateway (remember-routes.js) -- one implementation.
//
// Over plain HTTP the cookie cannot be `Secure` or `__Host-`. What it has:
// HttpOnly (no script in the page, mods included, can read it), SameSite=Strict,
// Path=/_friend/remember/ (it is sent nowhere else on the host), and a name
// with the asset port in it, because a cookie belongs to a host, not to a
// port. Anyone on the LAN who can watch the traffic can see it, as they can
// see the game's own login packets, which are not encrypted either.
//
// Same rules as the gateway, minus the invitation: the page's origin must be
// the one it was served from, the body is JSON, issuing needs the page's
// account id and web auth token, and each LAN address gets ten requests a
// minute. Off unless the host has LAN turned on (`enabled()`), checked on
// every request.
const http = require('node:http');
const RememberRoutes = require('./remember-routes');

const PREFIX = '/_friend/remember/';
const cookieValue = (req, name) => {
  const values = String(req.headers.cookie || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
};
// One request per connection: the asset server asks that anyway, and a
// refusal sent before the body was read must not leave it on a reused socket.
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', connection: 'close' };

class LanRemember {
  constructor({ remember, enabled = () => true, now = Date.now, log = () => {} }) {
    Object.assign(this, { remember, enabled, now, log });
    this.limit = RememberRoutes.createLimiter(now);
  }
  reply(res, status, body, extra = {}) {
    // A length, not chunks: the asset server passes on only a plain body.
    const text = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...headers, 'content-length': text.length, ...extra });
    res.end(text);
  }
  async handle(req, res) {
    if (!this.enabled() || !this.remember) return this.reply(res, 404, { error: 'Not found' });
    const route = String(req.url || '').startsWith(PREFIX) ? req.url.slice(PREFIX.length) : '';
    if (req.method !== 'POST' || !RememberRoutes.ROUTES.includes(route)) return this.reply(res, 404, { error: 'Not found' });
    // The page's own origin, and nothing else: Host is the one the browser
    // used (the asset server passes it on), so another site cannot ask.
    const host = String(req.headers.host || '');
    const port = /:(\d{1,5})$/.exec(host)?.[1];
    // Plain HTTP only. This endpoint is reached through the asset server's own
    // plain-HTTP listener, so that is what the cookie is made for. An HTTPS
    // page here means TLS the app does not terminate (a proxy of the user's in
    // front of the LAN port); it is refused rather than given a cookie whose
    // security would rest on a header. The app's HTTPS -- a quick tunnel or the
    // host's own domain -- is the friend gateway, which always sets the
    // `__Host-` Secure cookie.
    if (port && req.headers.origin === `https://${host}`) return this.reply(res, 403, { ok: false, code: 'unavailable', error: 'Over HTTPS, remembered logins work through the host’s sharing link (Cloudflare tunnel or their own domain).' });
    if (!port || req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json') return this.reply(res, 403, { error: 'Not allowed' });
    let input;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024) throw Error(); chunks.push(chunk); }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch { return this.reply(res, 400, { error: 'Invalid request' }); }
    const name = `ro-remember-${port}`;
    const peer = String(req.headers['x-forwarded-for'] || 'unknown');
    const result = await RememberRoutes.answer({ route, input, credential: cookieValue(req, name), remember: this.remember, allow: () => this.limit(peer) });
    const cookie = result.cookie === undefined ? {} : { 'set-cookie': `${name}=${result.cookie || ''}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${result.cookie ? RememberRoutes.DAYS * 86400 : 0}` };
    if (route !== 'status') this.log(`lan remember: ${route} from ${peer} -> ${result.body.ok ? 'ok' : result.body.code}`);
    return this.reply(res, result.status, result.body, cookie);
  }
  // Loopback only, on a port of the system's choosing; the asset server is
  // told which (APP_PROXY_TARGET).
  async start(port = 0) {
    this.server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 10000, headersTimeout: 5000 }, (req, res) => {
      this.handle(req, res).catch(() => { if (!res.headersSent) this.reply(res, 400, { error: 'Invalid request' }); else res.destroy(); });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    this.server.unref();
    return this.server.address().port;
  }
  async stop() { if (this.server) await new Promise(resolve => this.server.close(resolve)); }
}

module.exports = { LanRemember, PREFIX };
