'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { LoginPackets, LoginLimits } = require('../electron/sharing/login-limits');
const { Frames } = require('../electron/sharing/gateway');
function packet(name) { const p = Buffer.alloc(55); p.writeUInt16LE(0x64); p.write(name, 6, 24, 'latin1'); p.write('private-sentinel', 30); return p; }
function frame(payload, opcode = 0x82) { const mask = Buffer.from([5, 17, 1, 22]); return Buffer.concat([Buffer.from([opcode, 0x80 | payload.length]), mask, Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))]); }
test('login limits isolate accounts and browsers, survive fresh cookies, and expire after one minute', () => {
  let now = 100000; const limits = new LoginLimits(() => now), first = {}, second = {};
  for (let i = 0; i < 5; i++) assert.equal(limits.allow(first, 'friend-a'), true);
  assert.equal(limits.allow(second, 'friend-a'), false, 'new cookie cannot bypass account limit');
  assert.equal(limits.allow(first, 'friend-b'), false, 'new name cannot bypass browser limit');
  assert.equal(limits.allow(second, 'friend-b'), true, 'another friend can still log in');
  now += 60001; assert.equal(limits.allow(first, 'friend-a'), true);
  assert.ok(!JSON.stringify([...limits.accounts]).includes('friend-a'));
});
test('login stream counts split and batched packets and canonicalizes account spelling without retaining passwords', () => {
  const accounts = [], parser = new LoginPackets(name => { accounts.push(name); return true; });
  const one = packet('Friend-A  ');
  for (const byte of one) parser.consume(Buffer.from([byte]));
  parser.consume(Buffer.concat([packet('friend-B'), packet('friend-C')]));
  assert.deepEqual(accounts, ['friend-a', 'friend-b', 'friend-c']); assert.equal(parser.pending.length, 0);
  assert.throws(() => parser.consume(Buffer.from([0x10, 0x27])), /Unsupported/);
});
test('masked and fragmented login frames retain original wire bytes while enforcing the RO attempt limit', async () => {
  const limits = new LoginLimits(), entry = {}, parser = new LoginPackets(name => limits.allow(entry, name));
  const filter = new Frames(true, bytes => parser.consume(bytes)), output = [];
  filter.on('data', chunk => output.push(chunk));
  const login = packet('test-account');
  const wire = Buffer.concat([frame(login.subarray(0, 20), 0x02), frame(login.subarray(20), 0x80)]);
  for (const byte of wire) filter.write(Buffer.from([byte]));
  for (let i = 0; i < 4; i++) filter.write(frame(login));
  assert.deepEqual(Buffer.concat(output).subarray(0, wire.length), wire);
  const failure = once(filter, 'error'); filter.write(frame(login)); await failure;
  assert.equal(entry.logins.length, 5);
});
test('a single frame cannot batch enough login packets to bypass account limits', () => {
  const limits = new LoginLimits(), entry = {}, parser = new LoginPackets(name => limits.allow(entry, name));
  assert.throws(() => parser.consume(Buffer.concat(Array.from({ length: 6 }, () => packet('same-account')))), /attempt limit/);
  assert.equal(entry.logins.length, 5);
});
