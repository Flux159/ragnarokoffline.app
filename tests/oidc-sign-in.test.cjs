'use strict';
// Sign in with Google or Apple (electron/sharing/oidc.js, gateway.js,
// login-token.js), against a fake OpenID provider written here: its own keys,
// JWKS, authorization redirect and token endpoint. No real Google or Apple
// sign-in is made, and no game server is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { SignInFlow, Jwks, verifyIdToken, appleClientSecret, validateCredentials, decodeJwt } = require('../electron/sharing/oidc');
const { SHAPE, issueLoginToken, checkGameLogin } = require('../electron/sharing/login-token');
const { FriendGateway } = require('../electron/sharing/gateway');

const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (pair, kid, alg) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
function sign(payload, { key = rsa.privateKey, alg = 'RS256', kid = 'rsa-1', header = {} } = {}) {
  const head = b64({ alg, kid, typ: 'JWT', ...header }), body = b64(payload);
  const data = Buffer.from(head + '.' + body);
  const signature = alg === 'ES256' ? crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
    : alg === 'HS256' ? crypto.createHmac('sha256', 'public-key-as-secret').update(data).digest()
    : alg === 'none' ? Buffer.alloc(0) : crypto.sign('sha256', data, key);
  return head + '.' + body + '.' + signature.toString('base64url');
}
const NOW = 1_800_000_000_000;
const claims = (extra = {}) => ({ iss: 'https://issuer.test', aud: 'client-1', sub: 'subject-1', email: 'Friend@Example.com', email_verified: true,
  nonce: 'nonce-1', iat: NOW / 1000 - 5, exp: NOW / 1000 + 600, ...extra });
const staticKeys = (keys = [jwk(rsa, 'rsa-1', 'RS256'), jwk(ec, 'ec-1', 'ES256')]) => {
  let fetches = 0;
  return { fetches: () => fetches, fetch: async () => { fetches++; return new Response(JSON.stringify({ keys })); } };
};
const check = (token, options = {}, keys = staticKeys()) => verifyIdToken(token, { jwks: new Jwks('https://issuer.test/jwks', { fetch: keys.fetch, now: () => NOW }),
  issuers: ['https://issuer.test'], audience: 'client-1', nonce: 'nonce-1', now: () => NOW, ...options });

test('an ID token is accepted only with a valid RS256 or ES256 signature from the provider’s key set', async () => {
  assert.equal((await check(sign(claims()))).sub, 'subject-1');
  assert.equal((await check(sign(claims(), { key: ec.privateKey, alg: 'ES256', kid: 'ec-1' }))).sub, 'subject-1');
  // Apple writes email_verified as a string.
  assert.equal((await check(sign(claims({ email_verified: 'true' })))).email, 'Friend@Example.com');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(check(sign(claims(), { key: other.privateKey })), /signature is not valid/);
  const token = sign(claims()), [h, , s] = token.split('.');
  await assert.rejects(check(`${h}.${b64(claims({ sub: 'someone-else' }))}.${s}`), /signature is not valid/);
  await assert.rejects(check(sign(claims(), { alg: 'none' })), /unsupported signature/);
  await assert.rejects(check(sign(claims(), { alg: 'HS256' })), /unsupported signature/);
  await assert.rejects(check(sign(claims(), { header: { crit: ['exp'] } })), /unsupported signature/);
  // An EC key cannot stand in for an RSA one, or the reverse.
  await assert.rejects(check(sign(claims(), { key: ec.privateKey, alg: 'ES256', kid: 'rsa-1' })), /unexpected key|unknown key/);
  await assert.rejects(check('not.a.jwt'), /Malformed|Unexpected|JSON/);
});

test('an ID token is refused for the wrong issuer, audience, nonce, age, or an unverified email', async () => {
  const cases = [
    [{ iss: 'https://evil.test' }, /unexpected issuer/],
    [{ aud: 'someone-elses-client' }, /another app/],
    [{ aud: ['client-1', 'other'] }, /another app/],
    [{ aud: ['client-1', 'other'], azp: 'other' }, /another app/],
    [{ exp: NOW / 1000 - 61 }, /expired/],
    [{ iat: NOW / 1000 + 3600 }, /too old/],
    [{ iat: NOW / 1000 - 3600 }, /too old/],
    [{ nonce: 'nonce-2' }, /another browser|belong/],
    [{ nonce: undefined }, /belong/],
    [{ email_verified: false }, /verified email/],
    [{ email_verified: 'false' }, /verified email/],
    [{ email: undefined }, /verified email/],
    [{ sub: '' }, /account id/],
  ];
  for (const [extra, message] of cases) await assert.rejects(check(sign(claims(extra))), message, JSON.stringify(extra));
  // Several audiences are fine when we are the authorised party.
  assert.ok(await check(sign(claims({ aud: ['client-1', 'other'], azp: 'client-1' }))));
});

test('the key set is cached, refetched for a new kid, but not hammered by made-up ones', async () => {
  let keys = [jwk(rsa, 'rsa-1', 'RS256')], fetches = 0, now = NOW;
  const jwks = new Jwks('https://issuer.test/jwks', { now: () => now, fetch: async () => { fetches++; return new Response(JSON.stringify({ keys })); } });
  const verify = (token) => verifyIdToken(token, { jwks, issuers: ['https://issuer.test'], audience: 'client-1', nonce: 'nonce-1', now: () => NOW });
  await verify(sign(claims())); await verify(sign(claims()));
  assert.equal(fetches, 1);
  await assert.rejects(verify(sign(claims(), { kid: 'made-up' })), /unknown key/);
  assert.equal(fetches, 1, 'a kid seen within the minute is not refetched');
  // Rotation: a new key is published, a minute passes, a token signed with it works.
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  keys = [jwk(rotated, 'rsa-2', 'RS256')]; now += 61000;
  await verify(sign(claims(), { key: rotated.privateKey, kid: 'rsa-2' }));
  assert.equal(fetches, 2);
});

test('Apple’s client secret is an ES256 JWT for the Services ID, signed with the .p8 key', () => {
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentials = validateCredentials('apple', { servicesId: 'com.example.play', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: key.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
  const secret = appleClientSecret(credentials, () => NOW), { header, payload, signed, signature } = decodeJwt(secret);
  assert.deepEqual([header.alg, header.kid], ['ES256', 'KEY1234567']);
  assert.deepEqual([payload.iss, payload.sub, payload.aud], ['TEAM123456', 'com.example.play', 'https://appleid.apple.com']);
  assert.ok(payload.exp > payload.iat && payload.exp - payload.iat <= 15777000);
  assert.ok(crypto.verify('sha256', Buffer.from(signed), { key: key.publicKey, dsaEncoding: 'ieee-p1363' }, signature));
});

test('host credentials are checked before they are saved', () => {
  assert.deepEqual(validateCredentials('google', { clientId: ' 123-abc.apps.googleusercontent.com ', clientSecret: 'GOCSPX-secret' }),
    { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' });
  assert.throws(() => validateCredentials('google', { clientId: 'abc', clientSecret: 'x' }), /client ID/);
  assert.throws(() => validateCredentials('google', { clientId: '1.apps.googleusercontent.com', clientSecret: '' }), /client secret/);
  const rsaKey = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const base = { servicesId: 'com.example.play', teamId: 'TEAM123456', keyId: 'KEY1234567' };
  assert.throws(() => validateCredentials('apple', { ...base, privateKey: 'nope' }), /whole \.p8/);
  assert.throws(() => validateCredentials('apple', { ...base, privateKey: rsaKey }), /not an Apple/);
  assert.throws(() => validateCredentials('apple', { ...base, teamId: 'short', privateKey: rsaKey }), /Team ID/);
  assert.throws(() => validateCredentials('github', {}), /Unknown/);
});

test('login tokens fit the login packet, are random, and only their hash is handed on', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const { token, hash } = issueLoginToken();
    assert.match(token, SHAPE); assert.equal(token.length, 23);
    assert.equal(hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!seen.has(token)); seen.add(token);
  }
});

// A login server that answers CA_LOGIN the way rAthena does: 0x69 accept, 0x6a refuse.
async function fakeLoginServer(t, accounts) {
  const packets = [];
  const server = net.createServer(socket => socket.once('data', data => {
    packets.push(data);
    const name = data.subarray(6, 30).toString('latin1').split('\0')[0], pass = data.subarray(30, 54).toString('latin1').split('\0')[0];
    socket.end(accounts[name] === pass ? Buffer.from([0x69, 0x00, 47, 0x00]) : Buffer.from([0x6a, 0x00, 1, ...Buffer.alloc(20)]));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, packets };
}

test('linking checks a game password with the login server itself, using the client’s own packet', async t => {
  const server = await fakeLoginServer(t, { friend_1: 'correct horse' });
  assert.equal(await checkGameLogin({ username: 'friend_1', password: 'correct horse', port: server.port }), true);
  assert.equal(await checkGameLogin({ username: 'friend_1', password: 'wrong', port: server.port }), false);
  assert.equal(server.packets[0].length, 55); assert.equal(server.packets[0].readUInt16LE(0), 0x64);
  assert.equal(await checkGameLogin({ username: 'x'.repeat(24), password: 'a', port: server.port }), false, 'too long for the packet');
  await assert.rejects(checkGameLogin({ username: 'friend_1', password: 'a', port: 1 }), /not reachable/);
});

// The fake provider: an authorization endpoint the test "visits", a token
// endpoint that swaps a code for an ID token, and a JWKS.
async function fakeProvider(t, { pkce = true, alg = 'RS256' } = {}) {
  const codes = new Map(), received = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk(rsa, 'rsa-1', 'RS256'), jwk(ec, 'ec-1', 'ES256')] }));
    if (req.url === '/token' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      const form = new URLSearchParams(text); received.push(form);
      const grant = codes.get(form.get('code')); codes.delete(form.get('code'));
      const challenge = v => crypto.createHash('sha256').update(v || '').digest('base64url');
      if (!grant || form.get('client_id') !== grant.clientId || form.get('redirect_uri') !== grant.redirectUri || (grant.challenge && challenge(form.get('code_verifier')) !== grant.challenge)) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      const id_token = sign({ iss: 'https://issuer.test', aud: grant.clientId, sub: grant.sub, email: grant.email, email_verified: true, nonce: grant.nonce,
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }, alg === 'ES256' ? { key: ec.privateKey, alg, kid: 'ec-1' } : {});
      return res.end(JSON.stringify({ id_token, access_token: 'unused' }));
    }
    res.statusCode = 404; res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoints = name => ({ name, issuers: ['https://issuer.test'], authorization: 'https://issuer.test/authorize', token: origin + '/token', jwks: origin + '/jwks',
    scope: 'openid email', pkce, ...(name === 'apple' ? { responseMode: 'form_post' } : {}) });
  // What the user's visit to the provider amounts to: a code bound to what the authorization request said.
  const authorize = (location, who = { sub: 'google-sub-1', email: 'Friend@Example.com' }) => {
    const url = new URL(location), code = crypto.randomBytes(8).toString('hex');
    codes.set(code, { clientId: url.searchParams.get('client_id'), redirectUri: url.searchParams.get('redirect_uri'), nonce: url.searchParams.get('nonce'),
      challenge: url.searchParams.get('code_challenge'), ...who });
    return { code, state: url.searchParams.get('state'), url };
  };
  return { endpoints, authorize, received };
}

test('the code flow: PKCE, state and nonce round-trip, and a state works once', async t => {
  const provider = await fakeProvider(t);
  const flow = new SignInFlow({ credentials: { google: { clientId: 'client-1', clientSecret: 'secret-1' } }, endpoints: { google: provider.endpoints('google') } });
  assert.deepEqual(flow.providers(), ['google']);
  assert.throws(() => flow.start('apple', { session: 's', redirectUri: 'https://play.example.com/cb' }), /not set up/);
  const { url, binding } = flow.start('google', { session: 'session-key', redirectUri: 'https://play.example.com/_friend/sign-in/callback' });
  const grant = provider.authorize(url);
  assert.equal(grant.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(grant.url.searchParams.get('response_type'), 'code');
  await assert.rejects(flow.finish({ state: grant.state, code: grant.code }, 'another-browser'), /another browser/);
  // The failed attempt used the state up: it cannot be retried with the right binding either.
  await assert.rejects(flow.finish({ state: grant.state, code: grant.code }, binding), /expired/);
  const second = flow.start('google', { session: 'session-key', redirectUri: 'https://play.example.com/_friend/sign-in/callback' });
  const g2 = provider.authorize(second.url);
  const result = await flow.finish({ state: g2.state, code: g2.code }, second.binding);
  assert.deepEqual(result, { session: 'session-key', identity: { provider: 'google', subject: 'google-sub-1', email: 'friend@example.com' } });
  assert.equal(provider.received.at(-1).get('client_secret'), 'secret-1');
  await assert.rejects(flow.finish({ state: g2.state, code: g2.code }, second.binding), /expired/, 'replay');
  // Ten minutes to finish.
  let now = Date.now();
  const timed = new SignInFlow({ credentials: { google: { clientId: 'client-1', clientSecret: 'x' } }, endpoints: { google: provider.endpoints('google') }, now: () => now });
  const late = timed.start('google', { session: 's', redirectUri: 'https://play.example.com/cb' });
  now += 11 * 60 * 1000;
  await assert.rejects(timed.finish({ state: provider.authorize(late.url).state, code: 'x' }, late.binding), /expired/);
  // A cancelled sign-in says so.
  const cancelled = flow.start('google', { session: 's', redirectUri: 'https://play.example.com/cb' });
  await assert.rejects(flow.finish({ state: provider.authorize(cancelled.url).state, error: 'access_denied' }, cancelled.binding), /cancelled/);
});

// The whole gateway path a friend takes, with in-memory accounts standing in for the supervisor.
async function gatewayFixture(t, { pkce = true } = {}) {
  const provider = await fakeProvider(t, { pkce });
  const apple = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const flow = new SignInFlow({
    credentials: { google: { clientId: 'client-1', clientSecret: 'secret-1' },
      apple: validateCredentials('apple', { servicesId: 'com.example.play', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: apple.privateKey.export({ format: 'pem', type: 'pkcs8' }) }) },
    endpoints: { google: provider.endpoints('google'), apple: { ...provider.endpoints('apple'), pkce: false } },
  });
  const db = { accounts: [{ id: '2000001', username: 'old_friend', password: 'their-password' }], identities: [], tokens: [] };
  const find = async identity => {
    let row = db.identities.find(i => i.provider === identity.provider && i.subject === identity.subject);
    if (!row) { const byEmail = db.identities.find(i => i.email === identity.email); if (byEmail) db.identities.push(row = { ...identity, account: byEmail.account }); }
    const account = row && db.accounts.find(a => a.id === row.account);
    return account ? { id: account.id, username: account.username } : null;
  };
  const signIn = {
    flow,
    accounts: {
      find,
      create: async (identity, username) => {
        if (!/^[A-Za-z0-9_]{4,23}$/.test(username) || db.accounts.some(a => a.username === username)) throw Error('taken');
        const id = String(2000000 + db.accounts.length + 1); db.accounts.push({ id, username }); db.identities.push({ ...identity, account: id });
      },
      link: async (identity, username) => { db.identities.push({ ...identity, account: db.accounts.find(a => a.username === username).id }); },
      token: async (id, hash) => { db.tokens.push({ id, hash }); },
    },
    checkLogin: async ({ username, password }) => db.accounts.some(a => a.username === username && a.password === password),
  };
  const gateway = new FriendGateway({ origin: 'https://play.example.com', upstreamPort: 9, register: async () => {}, signIn });
  const port = await gateway.start(0);
  t.after(() => gateway.stop());
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { host: 'play.example.com', ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.on('error', reject); req.end(body);
  });
  const login = async () => (await request('/_friend/exchange', { method: 'POST', headers: { origin: gateway.origin, 'content-type': 'application/json' }, body: JSON.stringify({ invite: gateway.invite }) })).headers['set-cookie'][0].split(';')[0];
  const post = (cookie, route, body = {}, origin = gateway.origin) => request('/_friend/sign-in/' + route, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const status = async cookie => JSON.parse((await request('/_friend/sign-in/status', { headers: { cookie } })).text);
  // Start, "visit" the provider, and come back the way a browser does: with the binding cookie, without the Strict session cookie.
  const signInWith = async (cookie, providerName = 'google', who) => {
    const start = await request('/_friend/sign-in/start?provider=' + providerName, { headers: { cookie } });
    assert.equal(start.status, 302);
    const binding = start.headers['set-cookie'][0].split(';')[0];
    assert.match(start.headers['set-cookie'][0], /^__Host-ro-sign-in=[^;]+; Path=\/; Secure; HttpOnly; SameSite=None; Max-Age=600$/);
    const grant = provider.authorize(start.headers.location, who);
    assert.equal(grant.url.searchParams.get('redirect_uri'), 'https://play.example.com/_friend/sign-in/callback');
    return { grant, binding };
  };
  return { gateway, request, login, post, status, signInWith, db, provider };
}

test('a friend signs in with Google, makes an account, and gets one-time login tokens for it', async t => {
  const f = await gatewayFixture(t), cookie = await f.login();
  assert.deepEqual(await f.status(cookie), { enabled: true, providers: ['google', 'apple'], signedIn: false, email: '', username: '', needsAccount: false });
  assert.equal((await f.post(cookie, 'token')).status, 401, 'no token before signing in');
  const { grant, binding } = await f.signInWith(cookie);
  const back = await f.request(`/_friend/sign-in/callback?state=${grant.state}&code=${grant.code}`, { headers: { cookie: binding } });
  assert.equal(back.status, 200);
  assert.match(back.text, /http-equiv="refresh" content="0;url=\/_friend\/"/);
  assert.match(back.headers['content-security-policy'], /default-src 'none'/);
  assert.match(back.headers['set-cookie'][0], /Max-Age=0/);
  assert.deepEqual(await f.status(cookie), { enabled: true, providers: ['google', 'apple'], signedIn: true, email: 'friend@example.com', username: '', needsAccount: true });
  assert.equal((await f.post(cookie, 'token')).status, 409, 'no token until there is an account');
  assert.equal((await f.post(cookie, 'create', { username: 'new_friend' }, 'https://evil.example')).status, 403);
  const made = await f.post(cookie, 'create', { username: 'new_friend' });
  assert.equal(made.status, 200); assert.equal(JSON.parse(made.text).username, 'new_friend');
  assert.equal((await f.post(cookie, 'create', { username: 'second_one' })).status, 409, 'one account');
  const issued = await f.post(cookie, 'token');
  assert.equal(issued.status, 200); assert.match(issued.headers['cache-control'], /no-store/);
  const { username, token } = JSON.parse(issued.text);
  assert.equal(username, 'new_friend'); assert.match(token, SHAPE);
  // Only the hash went to the database; the token itself went only to the browser.
  assert.equal(f.db.tokens.at(-1).hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(f.db).includes(token));
  for (let i = 1; i < 10; i++) assert.equal((await f.post(cookie, 'token')).status, 200);
  assert.equal((await f.post(cookie, 'token')).status, 429, 'bounded');
  // Signing out ends it for this browser.
  assert.equal((await f.post(cookie, 'out')).status, 200);
  assert.equal((await f.status(cookie)).signedIn, false);
});

test('signing in again finds the account, by identity or by the same verified email through Apple', async t => {
  const f = await gatewayFixture(t);
  f.db.identities.push({ provider: 'google', subject: 'google-sub-1', email: 'friend@example.com', account: '2000001' });
  const cookie = await f.login();
  const { grant, binding } = await f.signInWith(cookie);
  const back = await f.request(`/_friend/sign-in/callback?state=${grant.state}&code=${grant.code}`, { headers: { cookie: binding } });
  assert.match(back.text, /url=\/api\.html\?app=ONLINE/);
  assert.equal((await f.status(cookie)).username, 'old_friend');
  // Apple returns with a cross-site form POST, carrying no session cookie.
  const other = await f.login();
  const apple = await f.signInWith(other, 'apple', { sub: 'apple-sub-9', email: 'friend@example.com' });
  assert.equal(apple.grant.url.searchParams.get('response_mode'), 'form_post');
  assert.equal(apple.grant.url.searchParams.get('code_challenge'), null);
  const posted = await f.request('/_friend/sign-in/callback', { method: 'POST', headers: { cookie: apple.binding, origin: 'https://appleid.apple.com', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ state: apple.grant.state, code: apple.grant.code }).toString() });
  assert.equal(posted.status, 200);
  assert.equal((await f.status(other)).username, 'old_friend');
  // Apple's client secret was a fresh ES256 JWT, not a stored string.
  assert.equal(decodeJwt(f.provider.received.at(-1).get('client_secret')).header.alg, 'ES256');
});

test('an existing password account is linked only after its password logs in', async t => {
  const f = await gatewayFixture(t), cookie = await f.login();
  const { grant, binding } = await f.signInWith(cookie, 'google', { sub: 'google-sub-2', email: 'someone@example.com' });
  await f.request(`/_friend/sign-in/callback?state=${grant.state}&code=${grant.code}`, { headers: { cookie: binding } });
  assert.equal((await f.post(cookie, 'link', { username: 'old_friend', password: 'guess' })).status, 403);
  assert.equal(f.db.identities.length, 0);
  const linked = await f.post(cookie, 'link', { username: 'old_friend', password: 'their-password' });
  assert.equal(linked.status, 200);
  assert.equal((await f.status(cookie)).username, 'old_friend');
  // Guessing is bounded per account name, like logins from the game.
  const again = await f.login();
  const second = await f.signInWith(again, 'google', { sub: 'google-sub-3', email: 'third@example.com' });
  await f.request(`/_friend/sign-in/callback?state=${second.grant.state}&code=${second.grant.code}`, { headers: { cookie: second.binding } });
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await f.post(again, 'link', { username: 'victim', password: 'guess' + i })).status);
  assert.deepEqual(statuses.slice(-1), [429]);
});

test('a callback that is not this browser’s, or without sign-in configured, gets nowhere', async t => {
  const f = await gatewayFixture(t), cookie = await f.login();
  const { grant } = await f.signInWith(cookie);
  // An attacker's browser cannot finish this friend's sign-in, and the friend
  // cannot be signed in as the attacker by being sent the attacker's callback.
  const forged = await f.request(`/_friend/sign-in/callback?state=${grant.state}&code=${grant.code}`, { headers: { cookie: '__Host-ro-sign-in=wrong' } });
  assert.equal(forged.status, 403);
  assert.equal((await f.status(cookie)).signedIn, false);
  assert.equal((await f.request('/_friend/sign-in/callback?state=x&code=y')).status, 403);
  // Starting needs a session; the start link alone does nothing.
  assert.equal((await f.request('/_friend/sign-in/start?provider=google')).status, 401);
  // Without credentials every sign-in path but status is absent.
  const plain = new FriendGateway({ origin: 'https://plain.example.com', upstreamPort: 9, register: async () => {} });
  const port = await plain.start(0); t.after(() => plain.stop());
  const get = (url, cookie2) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: url, headers: { host: 'plain.example.com', cookie: cookie2 || '' } }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text }));
  }).on('error', reject));
  assert.equal((await get('/_friend/sign-in/callback?state=x&code=y')).status, 404);
  const probe = plain.probeSession(); t.after(() => probe.close());
  assert.deepEqual(JSON.parse((await get('/_friend/sign-in/status', probe.cookie)).text), { enabled: false });
  assert.equal((await get('/_friend/sign-in/start?provider=google', probe.cookie)).status, 404);
});
