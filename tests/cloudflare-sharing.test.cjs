'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provision, configuration } = require('../electron/sharing/cloudflare');
const { SharingSecrets } = require('../electron/sharing/secrets');
const zone = { id: 'a'.repeat(32), account: { id: 'b'.repeat(32) }, name: 'example.com' };
const id = '11111111-2222-3333-4444-555555555555';
function fake({ occupied = false, dnsFails = false } = {}) {
  const requests = [];
  const call = async (token, method, endpoint, input) => {
    requests.push({ method, endpoint, input });
    if (endpoint.startsWith('/zones?')) return endpoint.includes('name=example.com&') ? [zone] : [];
    if (endpoint.includes('/dns_records?')) return occupied ? [{}] : [];
    if (method === 'POST' && endpoint.endsWith('/cfd_tunnel')) return { id };
    if (method === 'POST' && endpoint.endsWith('/dns_records')) { if (dnsFails) throw Error('DNS unavailable'); return { id: 'c'.repeat(32) }; }
    if (method === 'DELETE') return {};
    throw Error('Unexpected request');
  };
  return { requests, call };
}
const request = { apiToken: 'test_token_' + 'a'.repeat(32), publicHostname: 'play.example.com' };
test('Cloudflare setup creates a dedicated locally managed tunnel and exact proxied DNS record', async () => {
  const f = fake(); const saved = await provision(request, f);
  assert.equal(saved.hostname, 'play.example.com'); assert.equal(saved.tunnelId, id);
  assert.match(saved.secret, /^[A-Za-z0-9+/]{43}=$/);
  const tunnel = f.requests.find(r => r.endpoint.endsWith('/cfd_tunnel'));
  assert.equal(tunnel.input.config_src, 'local');
  assert.equal(f.requests.at(-1).input.content, id + '.cfargotunnel.com');
  assert.equal(f.requests.at(-1).input.proxied, true);
  const routing = configuration(saved);
  assert.deepEqual(JSON.parse(routing.config).ingress, [{ hostname: 'play.example.com', service: 'http://127.0.0.1:3339' }, { service: 'http_status:404' }]);
  assert.ok(!routing.config.includes(saved.secret)); assert.ok(!JSON.stringify(saved).includes(request.apiToken));
});
test('setup refuses existing DNS and removes its new tunnel if DNS creation fails', async () => {
  const occupied = fake({ occupied: true }); await assert.rejects(provision(request, occupied), /already has a DNS record/);
  assert.equal(occupied.requests.filter(r => r.method !== 'GET').length, 0);
  const fail = fake({ dnsFails: true }); await assert.rejects(provision(request, fail), /DNS unavailable/);
  assert.equal(fail.requests.at(-1).method, 'DELETE'); assert.ok(fail.requests.at(-1).endpoint.endsWith(id));
});
test('tokens and hostname routing cannot become arbitrary command/config inputs', async () => {
  for (const host of ['https://play.example.com', 'play.example.com:3338', 'localhost', 'example.com\ningress:', '../etc/passwd']) await assert.rejects(provision({ ...request, publicHostname: host }, fake()));
  await assert.rejects(provision({ ...request, apiToken: 'bad\nheader' }, fake()));
  assert.throws(() => configuration({ hostname: 'play.example.com', tunnelId: '../etc', accountId: zone.account.id, secret: 'secret' }));
});
test('secure credential storage refuses missing Linux secret storage without writing plaintext', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-sharing-secrets-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const store of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const secrets = new SharingSecrets(directory, store); assert.throws(() => secrets.save({ secret: 'private-sentinel' }), /secure password storage/); assert.deepEqual(fs.readdirSync(directory), []);
  }
});

const { SharingController } = require('../electron/sharing/controller');
const { FriendGateway } = require('../electron/sharing/gateway');
const { EventEmitter } = require('node:events');
function controller(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-sharing-controller-'));
  let child, launched, socketProof = 0;
  class Gateway extends FriendGateway { start() { return super.start(0); } }
  const instance = new SharingController({ directory, guard: async () => {}, ...overrides }, {
    Gateway, helper: async () => '/verified/helper',
    launch: (file, args, options) => {
      launched = { file, args, options }; child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = signal => { child.signalCode = signal || 'SIGTERM'; queueMicrotask(() => child.emit('exit', null, child.signalCode)); }; return child;
    },
    health: async () => ({ service: 'ragnarok-friends', challenge: instance.gateway.challenge }),
    websocket: async (origin, cookie) => { assert.equal(origin, 'https://play.example.com'); assert.match(cookie, /^__Host-ro-friend=/); socketProof++; },
  });
  t.after(async () => { await instance.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { instance, launched: () => launched, child: () => child, socketProof: () => socketProof };
}
const saved = { hostname: 'play.example.com', tunnelId: id, accountId: zone.account.id, secret: Buffer.alloc(32, 1).toString('base64') };
test('sharing becomes ready only after guarded HTTP and WSS proof; secrets stay outside argv and routing files', async t => {
  const f = controller(t); await f.instance.start(saved);
  assert.equal(f.instance.status().state, 'sharing'); assert.equal(f.socketProof(), 1);
  assert.match(f.instance.invitation(), /^https:\/\/play.example.com\/#invite=/);
  assert.equal(f.instance.gateway.sessions.size, 0, 'probe session is removed');
  const launch = f.launched(); assert.ok(!launch.args.join(' ').includes(saved.secret));
  assert.equal(JSON.parse(launch.options.env.TUNNEL_CRED_CONTENTS).TunnelSecret, saved.secret);
  assert.ok(!fs.readFileSync(path.join(f.instance.directory, 'tunnel.json'), 'utf8').includes(saved.secret));
  await f.instance.stop(); assert.equal(f.instance.status().state, 'stopped'); assert.ok(f.child().signalCode);
  assert.throws(() => f.instance.invitation(), /Start sharing/);
});
test('failed policy checks and cancellation cannot launch a connector later', async t => {
  const denied = controller(t, { guard: async () => { throw Error('Unsafe accounts'); } });
  await assert.rejects(denied.instance.start(saved), /Unsafe accounts/); assert.equal(denied.launched(), undefined);
  let release;
  const canceled = controller(t, { guard: () => new Promise(resolve => { release = resolve; }) });
  const pending = canceled.instance.start(saved); await canceled.instance.stop(); release(); await pending;
  assert.equal(canceled.launched(), undefined); assert.equal(canceled.instance.status().state, 'stopped');
});
// A check that could not confirm something is not a failure, but the player
// still has to see it -- previously it reached the log and stopped there.
test('a guard advisory reaches the player without failing the start', async t => {
  const f = controller(t, { guard: async () => 'Your firewall dropped the check on 192.168.1.5.' });
  await f.instance.start(saved);
  assert.equal(f.instance.status().state, 'sharing');
  assert.match(f.instance.status().notice, /firewall dropped the check on 192\.168\.1\.5/);
  // Stopping ends the session the advisory described.
  await f.instance.stop();
  assert.equal(f.instance.status().notice, '', 'a stopped session shows no advisory');
  f.instance.guard = async () => '';
  await f.instance.start(saved);
  assert.equal(f.instance.status().notice, '');
});
test('connector exit removes the public gateway and reports a failed link', async t => {
  const f = controller(t); await f.instance.start(saved);
  f.child().exitCode = 1; f.child().emit('exit', 1, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.instance.gateway, null); assert.equal(f.instance.status().state, 'failed');
});
test('canceling while the gateway starts cannot launch a helper or interfere with a later sharing session', async t => {
  const f = controller(t), Original = f.instance.Gateway;
  let release, ready;
  const listening = new Promise(resolve => { ready = resolve; });
  f.instance.Gateway = class extends Original {
    async start() { const port = await super.start(); ready(); await new Promise(resolve => { release = resolve; }); return port; }
  };
  const pending = f.instance.start(saved); await listening;
  await Promise.all([f.instance.stop(), f.instance.stop()]);
  assert.equal(f.launched(), undefined);
  f.instance.Gateway = Original; await f.instance.start(saved);
  const active = f.instance.gateway; release(); await pending;
  assert.equal(f.instance.gateway, active); assert.equal(f.instance.state, 'sharing');
});
test('temporary sharing binds its protected gateway before getting a public hostname and needs no credential', async t => {
  const f = controller(t), launch = f.instance.launch;
  f.instance.launch = (...args) => {
    assert.equal(f.instance.gateway.server.listening, true);
    assert.equal(f.instance.gateway.origin, 'https://pending.invalid');
    const child = launch(...args); child.stderr = new (require('node:stream').PassThrough)();
    queueMicrotask(() => child.stderr.write('Your tunnel: https://quick-test.trycloudflare.com'));
    return child;
  };
  f.instance.websocket = async (origin, cookie) => { assert.equal(origin, 'https://quick-test.trycloudflare.com'); assert.match(cookie, /^__Host-ro-friend=/); };
  await f.instance.start();
  assert.equal(f.instance.status().state, 'sharing');
  assert.match(f.instance.invitation(), /^https:\/\/quick-test\.trycloudflare\.com\/#invite=/);
  assert.equal(f.launched().options.env.TUNNEL_CRED_CONTENTS, undefined);
  assert.ok(f.launched().args.includes('--url'));
});
test('Stop cancels a temporary hostname request and removes the gateway and connector', async t => {
  const f = controller(t), launch = f.instance.launch;
  let ready; const launched = new Promise(resolve => { ready = resolve; });
  f.instance.launch = (...args) => { const child = launch(...args); child.stderr = new (require('node:stream').PassThrough)(); ready(); return child; };
  const pending = f.instance.start(); await launched; await f.instance.stop(); await pending;
  assert.equal(f.instance.state, 'stopped'); assert.equal(f.instance.gateway, null); assert.ok(f.child().signalCode);
});
test('a fresh DNS channel recovers from a cached NXDOMAIN and supports IPv6-only answers', async t => {
  const { publicLookup } = require('../electron/sharing/controller');
  let published = false, channels = 0;
  const servers = [];
  t.mock.method(require('node:dns').promises, 'Resolver', function(options) {
    assert.equal(options.timeout, 2000);
    channels++;
    const cached = published;
    return { setServers: value => servers.push(value),
      resolve4: async () => { throw Error('No IPv4 answer'); },
      resolve6: async () => { if (!cached) throw Error('Not published'); return ['2001:db8::1']; } };
  });
  const lookup = (hostname = 'new.trycloudflare.com') => new Promise((resolve, reject) => publicLookup(hostname, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  await assert.rejects(lookup(), /not in DNS yet/);
  published = true; assert.deepEqual(await lookup(), [{ address: '2001:db8::1', family: 6 }]);
  assert.equal(channels, 2); assert.deepEqual(servers, [['1.1.1.1', '1.0.0.1'], ['1.1.1.1', '1.0.0.1']]);
  await lookup('new.example.com'); await lookup('new.trycloudflare.com.example.com');
  assert.equal(servers.length, 2, 'Named domains and lookalike suffixes use configured DNS');
});
