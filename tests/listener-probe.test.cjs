'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const probe = require('../electron/listener-probe');

// A listener on the loopback, and a port next to it with nothing on it. Real
// sockets rather than mocks: the whole point of this module is what the local
// TCP stack does with a connection, and a mock would be asserting the
// classification table against itself.
async function withListener(t, run) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return run(server.address().port);
}

test('a reachable port is the one outcome that refuses sharing', async t => {
  await withListener(t, async port => {
    const report = await probe.probeListeners({ addresses: ['127.0.0.1'], ports: [port] });
    assert.deepEqual(report.results.map(r => r.outcome), ['open']);
    const decided = probe.verdict(report);
    assert.equal(decided.shareable, false);
    assert.match(decided.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
  });
});

test('a refused connection proves the port private and says nothing to the player', async () => {
  // Bind to learn a free port, then release it, so the refusal is certain
  // rather than a guess at a number nothing happens to be using.
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const free = server.address().port;
  await new Promise(resolve => server.close(resolve));

  const report = await probe.probeListeners({ addresses: ['127.0.0.1'], ports: [free] });
  assert.deepEqual(report.results.map(r => r.outcome), ['closed']);
  assert.deepEqual(probe.verdict(report), { shareable: true, message: '' });
});

// The shape that escaped the old inline check: connect() throws instead of
// emitting, and an uncaught throw here is an unexplained sharing failure.
test('an unprobeable address is a result rather than a thrown error', async () => {
  const report = await probe.probeListeners({ addresses: ['127.0.0.1'], ports: [65536] });
  assert.deepEqual(report.results.map(r => r.outcome), ['error']);
  assert.equal(probe.verdict(report).shareable, true);
});

// The Windows default: unsolicited inbound is dropped without a reset, so the
// probe times out on a machine whose ports are correctly private. This used to
// be the failure that made sharing impossible there.
test('a dropped probe explains itself and still allows sharing', async () => {
  const report = await probe.probeListeners({ addresses: ['10.255.255.1'], ports: [6900], timeoutMs: 250 });
  assert.deepEqual(report.results.map(r => r.outcome), ['filtered']);
  const decided = probe.verdict(report);
  assert.equal(decided.shareable, true);
  assert.match(decided.message, /firewall dropped the check on 10\.255\.255\.1/);
  assert.match(decided.message, /verified separately/);
});

test('every probe is named with its address, port and outcome', async () => {
  const report = await probe.probeListeners({ addresses: ['10.255.255.1'], ports: [6900, 6121], timeoutMs: 250 });
  assert.equal(probe.describe(report), [
    '10.255.255.1:6900 filtered (no answer, so a packet filter dropped it)',
    '10.255.255.1:6121 filtered (no answer, so a packet filter dropped it)',
  ].join('\n'));
});

// A machine with a dozen virtual adapters would otherwise put every one of
// them in a sentence a player is meant to read.
test('many affected adapters are summarised, not listed in full', async () => {
  const addresses = Array.from({ length: 6 }, (_, i) => `10.255.255.${i + 1}`);
  const report = await probe.probeListeners({ addresses, ports: [6900], timeoutMs: 250 });
  assert.equal(report.filtered.length, 6);
  assert.match(probe.verdict(report).message, /10\.255\.255\.4 and 2 more/);
});

// Serial probing cost one timeout per address per port, which on the machine
// this was reported from would have been the better part of a minute.
test('probes run concurrently rather than one timeout after another', async () => {
  const started = Date.now();
  const addresses = Array.from({ length: 4 }, (_, i) => `10.255.255.${i + 1}`);
  const report = await probe.probeListeners({ addresses, timeoutMs: 500 });
  assert.equal(report.results.length, 16);
  assert.ok(Date.now() - started < 2000, 'sixteen 500ms probes must not take eight seconds');
});

test('interface enumeration excludes loopback', () => {
  assert.ok(!probe.localAddresses().includes('127.0.0.1'));
});
