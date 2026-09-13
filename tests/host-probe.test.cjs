const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { probeHost } = require('../electron/host-probe');
const fixtures = path.join(__dirname, 'fixtures/tls');
const cert = path.join(fixtures, 'localhost-cert.pem');
const key = path.join(fixtures, 'localhost-key.pem');

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
test('HTTP probes recognize invite-required hosts without transmitting fragments or credentials', async t => {
  const requests = [];
  const origin = await listen(t, http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(401).end('Invite required');
  }));
  assert.deepEqual(await probeHost(origin + '/api.html#invite=private-test-token'), { origin, status: 401, authenticationRequired: true });
  assert.deepEqual(requests, [{ url: '/', authorization: undefined, cookie: undefined }]);
});
test('redirects are bounded; server errors and stalled headers fail with safe messages', async t => {
  let mode = 'redirect';
  const origin = await listen(t, http.createServer((req, res) => {
    if (mode === 'redirect' && req.url === '/') return res.writeHead(302, { location: '/api.html' }).end();
    if (mode === 'redirect') return res.writeHead(200).end('Game');
    if (mode === 'loop') return res.writeHead(302, { location: '/' }).end();
    if (mode === 'cross') return res.writeHead(302, { location: 'http://example.invalid/' }).end();
    if (mode === 'error') return res.writeHead(503).end('private-test-token');
    // Deliberately do not send headers in stall mode.
  }));
  assert.deepEqual(await probeHost(origin), { origin, status: 200, authenticationRequired: false });
  mode = 'loop'; await assert.rejects(probeHost(origin), /redirected too many/);
  mode = 'cross'; await assert.rejects(probeHost(origin), /unsafe or invalid redirect/);
  mode = 'error'; await assert.rejects(probeHost(origin + '#invite=private-test-token'), e => {
    assert.ok(!e.message.includes('private-test-token')); return /HTTP 503/.test(e.message);
  });
  mode = 'stall'; await assert.rejects(probeHost(origin, { timeoutMs: 80 }), /did not answer in time/);
});
test('HTTPS rejects untrusted certificates, accepts an explicitly trusted fixture, and refuses downgrade', async t => {
  let downgrade = false;
  const origin = await listen(t, https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (_req, res) => {
    if (downgrade) res.writeHead(302, { location: 'http://127.0.0.1/' }).end();
    else res.writeHead(403).end('Invite required');
  }));
  await assert.rejects(probeHost(origin), /certificate could not be verified/);
  // Trust only this public test CA in an isolated child. The production probe
  // exposes no rejectUnauthorized override and retains hostname validation.
  const source = `require(${JSON.stringify(path.resolve(__dirname, '../electron/host-probe'))}).probeHost(process.argv[1]).then(r=>process.stdout.write(JSON.stringify(r)),e=>{process.stdout.write(e.message);process.exitCode=2;});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['-e', source, origin], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, timeout: 12000,
  }), error => /certificate could not be verified/.test(error.stdout));
  const run = (address = origin) => promisify(execFile)(process.execPath, ['-e', source, address], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 12000,
  });
  assert.deepEqual(JSON.parse((await run()).stdout), { origin, status: 403, authenticationRequired: true });
  const upgrade = await listen(t, http.createServer((_req, res) => res.writeHead(302, { location: origin + '/' }).end()));
  assert.deepEqual(JSON.parse((await run(upgrade)).stdout), { origin, status: 403, authenticationRequired: true });
  downgrade = true;
  await assert.rejects(run(), error => /unsafe or invalid redirect/.test(error.stdout));
});
