'use strict';
// Remembered logins ("keep me signed in"), for the autologin mod.
//
// A remembered login is a random credential that stands for one account until
// it is revoked. At each launch it is exchanged for a one-time login token
// (sharing/login-token.js: 60 seconds, one use), which the game client sends
// in place of a password. Nothing here ever sees, stores or sends a password.
//
// This file makes the secrets and keeps them; the supervisor
// (stack/src/remember.rs, through `ragnarok-stack accounts`) is only ever given
// their SHA-256. Where the credential is kept depends on who is playing:
//
//   - the host's own game window: a file of the app's own (`createFileStore`),
//     outside the game page's storage, so no script in the page can read it;
//   - a friend through the gateway: an HttpOnly cookie (sharing/gateway.js).
//
// The page asks for three things -- remember the account I am logged in to,
// give me a login token, forget me -- and a fourth, whether anything is
// remembered. Issuing is the only one that needs proof, and the proof is the
// session the page is in: the account id and the web auth token rAthena gave
// the client at login (remember.rs explains why that is enough).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { issueLoginToken } = require('./sharing/login-token');

// 256 random bits, base64url: 43 characters.
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const makeCredential = () => crypto.randomBytes(32).toString('base64url');

// What a page may send. The account id is a game account (2000000 and up),
// the web token is what rAthena generates: letters and digits, 16 of them.
function proof(input) {
  const accountId = String(input?.accountId ?? '');
  const webToken = String(input?.webToken ?? '').replace(/\0+$/, '');
  if (!/^\d{7,10}$/.test(accountId) || Number(accountId) < 2000000) throw Object.assign(Error('Not logged in to a game account.'), { code: 'not-logged-in' });
  if (!/^[A-Za-z0-9]{8,16}$/.test(webToken)) throw Object.assign(Error('This game server did not give the client a session token, so the login cannot be remembered.'), { code: 'unsupported' });
  return { accountId, webToken };
}

// The supervisor's answer when the credential is gone (remember.rs): revoked,
// lapsed, or its account disabled or deleted. Anything else -- the server not
// running yet, a timeout -- is a reason to try again later, not to forget.
const REVOKED = /no longer valid/i;

/**
 * The three exchanges with the supervisor. `run(request)` sends one
 * `ragnarok-stack accounts` request (with the era already added).
 */
function createRememberLogin({ run }) {
  return {
    async issue(input, replaces = null) {
      const { accountId, webToken } = proof(input);
      const credential = makeCredential();
      const request = { action: 'remember-issue', id: accountId, webToken, credentialHash: digest(credential) };
      if (replaces && CREDENTIAL.test(replaces)) request.replacesHash = digest(replaces);
      const result = await run(request);
      return { credential, username: result.username };
    },
    async resume(credential) {
      if (!CREDENTIAL.test(credential || '')) throw Object.assign(Error('Nothing is remembered.'), { code: 'none' });
      const { token, hash } = issueLoginToken();
      try {
        const result = await run({ action: 'remember-resume', credentialHash: digest(credential), tokenHash: hash });
        return { username: result.username, token };
      } catch (error) {
        throw Object.assign(Error(error.message), { code: REVOKED.test(error.message) ? 'revoked' : 'unavailable' });
      }
    },
    async forget(credential) {
      if (!CREDENTIAL.test(credential || '')) return;
      await run({ action: 'remember-forget', credentialHash: digest(credential) });
    },
  };
}

/**
 * The host's own window keeps its credential here: one per era, because each
 * era is its own database. Written whole and atomically, readable only by the
 * user. A file that cannot be read is treated as empty -- the worst that does
 * is a login screen.
 */
function createFileStore(file) {
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  };
  const write = value => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    get: key => (CREDENTIAL.test(read()[key] || '') ? read()[key] : null),
    set(key, credential) { const value = read(); value[key] = credential; write(value); },
    delete(key) { const value = read(); if (key in value) { delete value[key]; write(value); } },
  };
}

/**
 * One request from the host's own game page (main.js, `remember_login`).
 * Answers `{ ok: true, ... }` or `{ ok: false, code, error }` rather than
 * throwing, so the page gets the reason and not Electron's wrapping of it.
 */
async function handleLocal(args, { remember, store, era }) {
  const action = args?.action;
  try {
    if (action === 'status') return { ok: true, available: true, remembered: Boolean(store.get(era)) };
    if (action === 'issue') {
      const previous = store.get(era);
      const { credential, username } = await remember.issue(args, previous);
      store.set(era, credential);
      return { ok: true, username };
    }
    if (action === 'resume') {
      const credential = store.get(era);
      try {
        return { ok: true, ...(await remember.resume(credential)) };
      } catch (error) {
        if (error.code === 'revoked') store.delete(era);
        throw error;
      }
    }
    if (action === 'forget') {
      const credential = store.get(era);
      // Forgotten here first: even if the supervisor cannot be reached, this
      // window will not sign in by itself again.
      // The row it leaves behind lapses unused after 30 days.
      store.delete(era);
      try { await remember.forget(credential); return { ok: true, revoked: true }; }
      catch { return { ok: true, revoked: false }; }
    }
    return { ok: false, code: 'invalid', error: 'Unknown request' };
  } catch (error) {
    return { ok: false, code: error.code || 'unavailable', error: error.message || 'The game server could not be reached.' };
  }
}

module.exports = { CREDENTIAL, createRememberLogin, createFileStore, handleLocal, proof };
