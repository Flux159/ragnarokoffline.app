'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../electron/sharing/auto-share');

// The one state in which resuming is the right answer. Every test below takes
// this and breaks one thing. There is no preference in it: a connected domain
// keeps its address, which is what makes resuming the plain answer rather than
// a question to put to the host.
const shared = { mode: 'host', scope: 'friends', state: 'stopped', configured: true, stoppedByHand: false, quitting: false };

test('a server already shared through its own domain is shared again once it is back', () => {
  assert.deepEqual(decide(shared),
                   { share: true, useDomain: true, reason: 'the connected domain keeps its address' });
  // A failed attempt is a state worth retrying from; the server coming back is
  // new information.
  assert.equal(decide({ ...shared, state: 'failed' }).share, true);
});

// The reason it stops at a named tunnel: that address survives the restart, so
// the link the friends are already holding starts working again with nothing
// sent to anyone. A temporary one would come back somewhere else.
test('a temporary link is never resumed, because its address does not survive', () => {
  const decision = decide({ ...shared, configured: false });
  assert.equal(decision.share, false);
  assert.equal(decision.useDomain, false);
  assert.match(decision.reason, /not resumed/);
});

test('nothing is shared that the player has not already shared themselves', () => {
  // The heart of it: hosting scope is the only durable record that sharing was
  // ever turned on, so a local or LAN server stays off the internet, and an
  // automatic start never changes how the server it found binds its ports.
  for (const scope of ['local', 'lan', 'public', undefined, '']) {
    const decision = decide({ ...shared, scope });
    assert.equal(decision.share, false, scope);
    assert.match(decision.reason, /not set up for friends/);
  }
  // Joining someone else's server shares nothing of ours.
  for (const mode of ['join', undefined]) assert.equal(decide({ ...shared, mode }).share, false);
  assert.equal(decide({}).share, false);
  assert.equal(decide().share, false);
});

test('Stop sharing is an instruction, not a state to be corrected', () => {
  const decision = decide({ ...shared, stoppedByHand: true });
  assert.equal(decision.share, false);
  assert.match(decision.reason, /stopped by hand/);
});

test('a quit in progress and a session already under way are both left alone', () => {
  assert.equal(decide({ ...shared, quitting: true }).share, false);
  // Quitting outranks everything, including a setup that says share.
  assert.match(decide({ ...shared, quitting: true }).reason, /quitting/);
  for (const state of ['preparing', 'connecting', 'sharing', 'reconnecting', 'stopping']) {
    const decision = decide({ ...shared, state });
    assert.equal(decision.share, false, state);
    assert.equal(decision.reason, `sharing is already ${state}`);
  }
});

// The caller logs one line per server operation, so the refusals that mean
// "this install was never going to share" have to be silent, and the ones that
// mean "it would have, but" have to not be.
test('only the refusals worth reading are worth logging', () => {
  for (const quiet of [{ mode: 'join' }, { scope: 'local' }, { configured: false }, { quitting: true }]) {
    assert.equal(decide({ ...shared, ...quiet }).quiet, true, JSON.stringify(quiet));
  }
  for (const loud of [{ stoppedByHand: true }, { state: 'sharing' }]) {
    assert.notEqual(decide({ ...shared, ...loud }).quiet, true, JSON.stringify(loud));
  }
});

// A refusal must never carry a domain with it: the caller reads useDomain
// without re-checking share, and a stray true would mean "share the fixed
// hostname" on an answer that said not to share at all.
test('every refusal is inert', () => {
  for (const broken of [{ mode: 'join' }, { scope: 'local' }, { stoppedByHand: true },
                        { quitting: true }, { state: 'sharing' }, { configured: false }]) {
    const decision = decide({ ...shared, ...broken });
    assert.equal(decision.share, false, JSON.stringify(broken));
    assert.equal(decision.useDomain, false, JSON.stringify(broken));
    assert.equal(typeof decision.reason, 'string');
    assert.ok(decision.reason.length, 'a refusal says why, for the log');
  }
});
