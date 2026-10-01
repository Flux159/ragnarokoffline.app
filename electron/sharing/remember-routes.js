'use strict';
// The /_friend/remember/ routes, once, for every way a player's browser can
// reach them that is not the host's own window (which asks over IPC):
//
//   - a friend through the HTTPS gateway (gateway.js), behind the invitation
//     session, with the credential in a `__Host-` Secure cookie;
//   - a LAN player through the host's asset server (lan-remember.js), which
//     forwards the prefix to a loopback endpoint of this app, with the
//     credential in a plain-HTTP cookie (no Secure, no `__Host-`).
//
// Each caller checks its own origin and session and formats its own cookie;
// what a route means, what it asks the supervisor and how often it may be
// asked is here. `remember` is remember-login.js's { issue, resume, forget }.
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const ROUTES = ['status', 'issue', 'resume', 'forget'];
const DAYS = 30;
const PER_MINUTE = 10;

// Requests a minute per key (an invitation session, or a LAN peer). Status is
// free: it asks the supervisor nothing.
function createLimiter(now = Date.now, limit = PER_MINUTE) {
  const seen = new Map();
  return key => {
    const recent = (seen.get(key) || []).filter(time => time > now() - 60000);
    if (recent.length >= limit) { seen.set(key, recent); return false; }
    recent.push(now());
    seen.set(key, recent);
    if (seen.size > 1024) seen.delete(seen.keys().next().value);
    return true;
  };
}

/**
 * One request. `credential` is the cookie's value, if it is one; `allow()`
 * spends one from the caller's limit. Resolves { status, body, cookie }:
 * cookie is undefined (leave it), a credential (set it) or null (clear it).
 */
async function answer({ route, input, credential, remember, allow }) {
  credential = CREDENTIAL.test(credential || '') ? credential : null;
  if (route === 'status') return { status: 200, body: { ok: true, available: true, remembered: Boolean(credential) } };
  if (!allow()) return { status: 429, body: { ok: false, code: 'unavailable', error: 'Too many requests. Try again in a minute.' } };
  const failed = (error, cookie) => ({ status: 200, cookie, body: { ok: false, code: error.code || 'unavailable', error: error.message || 'The game server could not be reached.' } });
  if (route === 'issue') {
    try {
      const result = await remember.issue(input, credential);
      return { status: 200, body: { ok: true, username: result.username }, cookie: result.credential };
    } catch (error) { return failed(error); }
  }
  if (route === 'resume') {
    try {
      const result = await remember.resume(credential);
      // Used, so it lasts another DAYS here as it does in the database.
      return { status: 200, body: { ok: true, username: result.username, token: result.token }, cookie: credential };
    } catch (error) { return failed(error, ['revoked', 'none'].includes(error.code) && credential ? null : undefined); }
  }
  // forget: the cookie goes whatever the supervisor says.
  try { await remember.forget(credential); } catch { /* lapses unused */ }
  return { status: 200, body: { ok: true }, cookie: null };
}

module.exports = { CREDENTIAL, ROUTES, DAYS, createLimiter, answer };
