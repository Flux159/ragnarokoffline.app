'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CrashMonitor } = require('../electron/crash-monitor');

test('crash monitoring does not run for a stopped or non-owned world or overlap a collection', async () => {
  let active = false, calls = 0, finish;
  const logs = [];
  const monitor = new CrashMonitor({ active: () => active, log: x => logs.push(x),
    collect: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  await monitor.tick(); assert.equal(calls, 0);
  active = true;
  const pending = monitor.tick();
  await monitor.tick(); assert.equal(calls, 1);
  finish('private incident retained'); await pending;
  assert.deepEqual(logs, ['private incident retained']);
  active = false; await monitor.tick(); assert.equal(calls, 1);
});

test('monitor retries failures without logging raw errors or repeated noise', async () => {
  let fail = true;
  const logs = [];
  const monitor = new CrashMonitor({ active: () => true, log: x => logs.push(x),
    collect: async () => { if (fail) throw Error('private sentinel'); return ''; } });
  await monitor.tick(); await monitor.tick();
  assert.equal(logs.length, 1); assert.doesNotMatch(logs[0], /sentinel/);
  fail = false; await monitor.tick();
  fail = true; await monitor.tick(); assert.equal(logs.length, 2);
  monitor.start(); const timer = monitor.timer; monitor.start();
  assert.equal(monitor.timer, timer); monitor.stop(); assert.equal(monitor.timer, null);
});


test('a retained incident notifies recovery once per collection only while still owned', async () => {
  let active = true;
  const recovered = [];
  let reply = 'ragnarok-map stopped unexpectedly; private evidence saved at /private/report.log\n';
  const monitor = new CrashMonitor({ active: () => active, log: () => {},
    onCrash: services => recovered.push(services), collect: async () => reply });
  await monitor.tick();
  assert.deepEqual(recovered, [['map']]);
  reply = ''; await monitor.tick();
  assert.equal(recovered.length, 1);
  monitor.collect = async () => { active = false; return 'ragnarok-map stopped unexpectedly; private evidence saved at /private/late.log'; };
  await monitor.tick();
  assert.equal(recovered.length, 1);
});


test('an old collection cannot replace the UI of a new asset launch', async () => {
  let owner = 'first', notify = 0;
  const monitor = new CrashMonitor({ active: () => owner, log: () => {},
    onCrash: () => notify++, collect: async () => {
      owner = 'replacement';
      return 'ragnarok-map stopped unexpectedly; private evidence saved at /private/old.log';
    } });
  await monitor.tick();
  assert.equal(notify, 0);
});
