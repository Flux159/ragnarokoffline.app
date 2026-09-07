'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { AssetServer } = require('../electron/asset-server');

async function probe(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-port-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socket = new EventEmitter();
  socket.destroy = t.mock.fn();
  const connect = t.mock.method(net, 'connect', () => socket);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const result = new AssetServer().prepare(root, 3338).then(
    () => { settled = true; return { ok: true }; },
    error => { settled = true; return { error }; },
  );
  // Let the serialized prepare/stop promises reach the socket probe. Only
  // setTimeout is mocked; setImmediate also drains the promise callbacks.
  await new Promise(setImmediate);
  assert.equal(connect.mock.callCount(), 1);
  return { socket, result, settled: () => settled };
}

test('a loopback refusal arriving after one second still proves the port free', async t => {
  const p = await probe(t);
  t.mock.timers.tick(1500);
  await new Promise(setImmediate);
  assert.equal(p.settled(), false, 'must wait for the delayed refusal');
  p.socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  assert.deepEqual(await p.result, { ok: true });
  assert.equal(p.socket.destroy.mock.callCount(), 1);
});

test('an unresponsive port remains unknown and fails closed at the bounded deadline', async t => {
  const p = await probe(t);
  t.mock.timers.tick(5000);
  assert.match((await p.result).error.message, /cannot establish whether it is free/);
  assert.equal(p.socket.destroy.mock.callCount(), 1);
});

test('a connected port is rejected as occupied without taking ownership', async t => {
  const p = await probe(t);
  p.socket.emit('connect');
  assert.match((await p.result).error.message, /occupied by a server this app does not own/);
  assert.equal(p.socket.destroy.mock.callCount(), 1);
});
