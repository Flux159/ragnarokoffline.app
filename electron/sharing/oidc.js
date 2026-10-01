'use strict';
// Sign in with Google or Apple (OpenID Connect), for a world shared with
// friends. docs/FRIENDS_SHARING.md, "Sign in with Google or Apple".
//
// Only when the host has supplied their own OAuth client: a Google client ID
// and secret, or an Apple Services ID with its team ID, key ID and .p8 key.
// Without one, nothing here runs and password login is unchanged.
//
// The flow is Authorization Code, run by the friend gateway (gateway.js):
//
//   1. /_friend/sign-in/start makes a state, a nonce and (Google) a PKCE pair,
//      binds them to the browser with a short-lived cookie, and redirects to
//      the provider.
//   2. The provider sends the browser back to /_friend/sign-in/callback with a
//      code. The gateway exchanges it for an ID token directly with the
//      provider, using the client secret, and checks that token here: its
//      signature against the provider's published keys (JWKS), and its
//      issuer, audience, expiry, issue time and nonce. Only a verified email
//      is accepted.
//
// Node's crypto verifies RS256 and ES256 and signs Apple's ES256 client
// secret, so no dependency is added.
const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({
  google: Object.freeze({
    name: 'Google',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    scope: 'openid email',
    pkce: true,
  }),
  // Apple returns to the redirect URI with a cross-site form POST whenever a
  // scope is asked for, and does not document PKCE, so it is not sent: the
  // client is confidential (a signed client secret), and the state is bound
  // to the browser and the nonce to the ID token all the same.
  apple: Object.freeze({
    name: 'Apple',
    issuers: ['https://appleid.apple.com'],
    authorization: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
    jwks: 'https://appleid.apple.com/auth/keys',
    scope: 'email',
    responseMode: 'form_post',
    pkce: false,
  }),
});

const base64url = bytes => Buffer.from(bytes).toString('base64url');
const random = (size = 32) => base64url(crypto.randomBytes(size));
const sha256 = value => crypto.createHash('sha256').update(value).digest();
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function pkce() {
  const verifier = random(32);
  return { verifier, challenge: base64url(sha256(verifier)) };
}

function decodeSegment(segment) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]*$/.test(segment)) throw Error('Malformed token');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

// What a JWT says, unverified. Only for reading the header's `kid`/`alg`.
function decodeJwt(token) {
  if (typeof token !== 'string' || token.length > 16384) throw Error('Malformed token');
  const parts = token.split('.');
  if (parts.length !== 3) throw Error('Malformed token');
  return { header: decodeSegment(parts[0]), payload: decodeSegment(parts[1]), signed: parts[0] + '.' + parts[1], signature: Buffer.from(parts[2], 'base64url') };
}

// Only the two algorithms the providers use. `none` and HMAC are refused
// outright: the key set is public, so an HMAC "signature" keyed with it would
// prove nothing.
const ALGORITHMS = {
  RS256: { kty: 'RSA', verify: (key, data, signature) => crypto.verify('sha256', data, key, signature) },
  ES256: { kty: 'EC', crv: 'P-256', verify: (key, data, signature) => signature.length === 64 && crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature) },
};

// A provider's published signing keys, cached. An unknown `kid` refetches, so
// a key rotation is picked up at once, but not more than once a minute: a
// token naming a made-up kid cannot be used to make us hammer the provider.
class Jwks {
  constructor(url, { fetch = globalThis.fetch, now = Date.now, ttl = 60 * 60 * 1000 } = {}) {
    Object.assign(this, { url, fetch, now, ttl }); this.keys = null; this.fetched = 0; this.pending = null;
  }
  async load() {
    if (!this.pending) this.pending = (async () => {
      const response = await this.fetch(this.url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) throw Error('Could not read the provider’s signing keys');
      const text = await response.text();
      if (text.length > 64 * 1024) throw Error('Could not read the provider’s signing keys');
      const keys = JSON.parse(text).keys;
      if (!Array.isArray(keys)) throw Error('Could not read the provider’s signing keys');
      this.keys = keys; this.fetched = this.now();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async key(kid, alg) {
    const find = () => (this.keys || []).find(key => key.kid === kid && (!key.alg || key.alg === alg) && (!key.use || key.use === 'sig'));
    if (!this.keys || this.now() - this.fetched > this.ttl) await this.load();
    let jwk = find();
    if (!jwk && this.now() - this.fetched > 60000) { await this.load(); jwk = find(); }
    if (!jwk) throw Error('The sign-in was signed with an unknown key');
    const spec = ALGORITHMS[alg];
    if (jwk.kty !== spec.kty || (spec.crv && jwk.crv !== spec.crv)) throw Error('The sign-in was signed with an unexpected key');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }
}

// Check an ID token and return its claims. Every check is a refusal on
// failure; nothing is "probably fine".
async function verifyIdToken(token, { jwks, issuers, audience, nonce, now = Date.now, skew = 60, maxAge = 10 * 60 }) {
  const { header, payload, signed, signature } = decodeJwt(token);
  const spec = ALGORITHMS[header.alg];
  if (!spec || typeof header.kid !== 'string' || header.crit !== undefined) throw Error('The sign-in used an unsupported signature');
  const key = await jwks.key(header.kid, header.alg);
  if (!spec.verify(key, Buffer.from(signed), signature)) throw Error('The sign-in signature is not valid');
  const seconds = Math.floor(now() / 1000);
  if (!issuers.includes(payload.iss)) throw Error('The sign-in came from an unexpected issuer');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw Error('The sign-in was meant for another app');
  // With several audiences, OIDC says the authorised party must be us.
  if ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== audience) throw Error('The sign-in was meant for another app');
  if (!Number.isFinite(payload.exp) || payload.exp + skew <= seconds) throw Error('The sign-in has expired. Try again.');
  if (!Number.isFinite(payload.iat) || payload.iat - skew > seconds || seconds - payload.iat > maxAge + skew) throw Error('The sign-in is too old. Try again.');
  if (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce)) throw Error('The sign-in does not belong to this browser. Try again.');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw Error('The sign-in has no account id');
  // Apple sends "true" as a string; Google a boolean.
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (typeof payload.email !== 'string' || !verified) throw Error('Your sign-in has no verified email address.');
  return payload;
}

// Apple's client secret is a short-lived ES256 JWT signed with the host's .p8
// key, not a fixed string. Made fresh for each code exchange.
function appleClientSecret({ teamId, keyId, servicesId, privateKey }, now = Date.now) {
  const iat = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iss: teamId, iat, exp: iat + 300, aud: 'https://appleid.apple.com', sub: servicesId }));
  const signature = crypto.sign('sha256', Buffer.from(header + '.' + body), { key: crypto.createPrivateKey(privateKey), dsaEncoding: 'ieee-p1363' });
  return header + '.' + body + '.' + base64url(signature);
}

// The host's credentials, checked before they are saved, so a typo is found in
// Settings and not by a friend at the provider's error page.
function validateCredentials(provider, input = {}) {
  const text = (value, limit = 256) => typeof value === 'string' && value.trim() && value.length <= limit ? value.trim() : '';
  if (provider === 'google') {
    const clientId = text(input.clientId), clientSecret = text(input.clientSecret);
    if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw Error('Enter the Google client ID, ending in .apps.googleusercontent.com.');
    if (!clientSecret || /\s/.test(clientSecret)) throw Error('Enter the Google client secret.');
    return { clientId, clientSecret };
  }
  if (provider === 'apple') {
    const servicesId = text(input.servicesId), teamId = text(input.teamId), keyId = text(input.keyId), privateKey = text(input.privateKey, 4096);
    if (!/^[A-Za-z0-9.-]+$/.test(servicesId) || !servicesId.includes('.')) throw Error('Enter the Apple Services ID (the identifier, such as com.example.play).');
    if (!/^[A-Z0-9]{10}$/.test(teamId)) throw Error('Enter the 10-character Apple Team ID.');
    if (!/^[A-Z0-9]{10}$/.test(keyId)) throw Error('Enter the 10-character Apple Key ID.');
    let key;
    try { key = crypto.createPrivateKey(privateKey); } catch { throw Error('Paste the whole .p8 key, including its BEGIN and END lines.'); }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw Error('That is not an Apple Sign in with Apple key (.p8).');
    return { servicesId, teamId, keyId, privateKey: key.export({ format: 'pem', type: 'pkcs8' }) };
  }
  throw Error('Unknown sign-in provider');
}

// One sign-in at a time per browser, ten minutes to finish it. State lives
// here and nowhere else: the provider only ever sees its random handle.
class SignInFlow {
  constructor({ credentials, endpoints = PROVIDERS, fetch = globalThis.fetch, now = Date.now, maxPending = 64 }) {
    Object.assign(this, { credentials, endpoints, fetch, now, maxPending });
    this.pending = new Map(); this.keys = new Map();
  }
  providers() { return Object.keys(this.endpoints).filter(name => this.credentials[name]); }
  clientId(name) { return name === 'apple' ? this.credentials.apple.servicesId : this.credentials.google.clientId; }
  jwks(name) {
    if (!this.keys.has(name)) this.keys.set(name, new Jwks(this.endpoints[name].jwks, { fetch: this.fetch, now: this.now }));
    return this.keys.get(name);
  }
  prune() { for (const [key, value] of this.pending) if (value.expires <= this.now()) this.pending.delete(key); }
  // Returns where to send the browser, and the value of the cookie that ties
  // the callback to this browser. `session` is the gateway's own key for the
  // friend's session, never sent anywhere.
  start(name, { session, redirectUri }) {
    if (!this.providers().includes(name)) throw Error('That sign-in is not set up on this server.');
    this.prune();
    if (this.pending.size >= this.maxPending) throw Error('Too many sign-ins in progress. Try again in a few minutes.');
    const provider = this.endpoints[name], state = random(), nonce = random(), binding = random();
    const pair = provider.pkce ? pkce() : null;
    this.pending.set(sha256(state).toString('hex'), { name, session, redirectUri, nonce, binding, verifier: pair?.verifier, expires: this.now() + 10 * 60 * 1000 });
    const url = new URL(provider.authorization);
    const params = { client_id: this.clientId(name), redirect_uri: redirectUri, response_type: 'code', scope: provider.scope, state, nonce };
    if (provider.responseMode) params.response_mode = provider.responseMode;
    if (pair) Object.assign(params, { code_challenge: pair.challenge, code_challenge_method: 'S256' });
    if (name === 'google') params.prompt = 'select_account';
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { url: url.toString(), binding };
  }
  // The provider's answer. A state is good once: taken out of the map before
  // anything is awaited, so a replayed callback finds nothing.
  async finish({ state, code, error }, binding) {
    if (typeof state !== 'string' || state.length > 128) throw Error('This sign-in link is not valid. Try again.');
    const key = sha256(state).toString('hex'), entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry || entry.expires <= this.now()) throw Error('This sign-in expired. Try again.');
    if (typeof binding !== 'string' || !same(binding, entry.binding)) throw Error('This sign-in was started in another browser. Try again here.');
    if (error) throw Error(error === 'access_denied' || error === 'user_cancelled_authorize' ? 'Sign-in was cancelled.' : 'The provider refused the sign-in.');
    if (typeof code !== 'string' || !code || code.length > 2048) throw Error('The provider did not return a sign-in code.');
    const provider = this.endpoints[entry.name];
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: entry.redirectUri, client_id: this.clientId(entry.name),
      client_secret: entry.name === 'apple' ? appleClientSecret(this.credentials.apple, this.now) : this.credentials.google.clientSecret });
    if (entry.verifier) form.set('code_verifier', entry.verifier);
    const response = await this.fetch(provider.token, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } });
    const text = await response.text();
    if (!response.ok || text.length > 64 * 1024) throw Error('The provider did not accept the sign-in. Check the client settings in Settings.');
    const idToken = JSON.parse(text).id_token;
    const claims = await verifyIdToken(idToken, { jwks: this.jwks(entry.name), issuers: provider.issuers, audience: this.clientId(entry.name), nonce: entry.nonce, now: this.now });
    return { session: entry.session, identity: { provider: entry.name, subject: claims.sub, email: claims.email.toLowerCase() } };
  }
}

module.exports = { PROVIDERS, SignInFlow, Jwks, verifyIdToken, appleClientSecret, validateCredentials, decodeJwt, pkce };
