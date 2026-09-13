'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rebuildNeeded } = require('../electron/sharing/friends-mode');

// The one state in which Share can skip the rebuild: a running server, already
// in friends mode, that the supervisor has just confirmed is bound for it.
// Every test below takes this and breaks one thing (#120).
const inForce = { scope: 'friends', lan: false, assetsRunning: true, assetsReady: true, phase: 'Ready', backendReady: true };

test('a server already in friends mode is shared without being rebuilt', () => {
  assert.deepEqual(rebuildNeeded(inForce),
                   { rebuild: false, reason: 'the running server is already in friends mode' });
});

test('a server not yet in friends mode is rebuilt, which is the point of the button', () => {
  for (const scope of ['local', 'lan', 'public', undefined, '']) {
    const decision = rebuildNeeded({ ...inForce, scope });
    assert.equal(decision.rebuild, true, String(scope));
    assert.match(decision.reason, /not in friends mode/);
  }
  assert.equal(rebuildNeeded({ ...inForce, lan: true }).rebuild, true);
});

// The saved scope can say friends about a server that started Local, because a
// start narrows it for an era that was never prepared and leaves the setting
// alone. Only the supervisor's look at the running containers settles it.
test('the saved setting is not taken as proof of how the running server is bound', () => {
  for (const backendReady of [false, undefined, null, 'true', 1]) {
    const decision = rebuildNeeded({ ...inForce, backendReady });
    assert.equal(decision.rebuild, true, String(backendReady));
    assert.match(decision.reason, /not configured for friends/);
  }
});

test('a server that is not running, or whose last start did not finish, is rebuilt', () => {
  assert.equal(rebuildNeeded({ ...inForce, assetsRunning: false }).rebuild, true);
  assert.equal(rebuildNeeded({ ...inForce, assetsReady: false }).rebuild, true);
  for (const phase of ['Stopped', 'Repairing…', 'Starting…', 'Failed: the virtual machine did not come up', '', undefined]) {
    const decision = rebuildNeeded({ ...inForce, phase });
    assert.equal(decision.rebuild, true, String(phase));
    assert.match(decision.reason, /did not finish/);
  }
});

test('knowing nothing means rebuilding, as Share always did', () => {
  assert.equal(rebuildNeeded({}).rebuild, true);
  assert.equal(rebuildNeeded().rebuild, true);
});
