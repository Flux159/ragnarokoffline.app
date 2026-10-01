'use strict';
// Settings → Mods: the "not applied yet" warning and the "reopen the game"
// line that follows Apply. The rules live in src/mods-state.js so they can be
// exercised here without a window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/mods-state.js');

const mods = [
  { name: 'alpha', enabled: true },
  { name: 'beta', enabled: false },
  { name: 'broken', enabled: false, refused: true },
];
const present = list => list.map(m => m.name);

test('the first listing is taken as applied', () => {
  const baseline = M.adopt(null, mods);
  assert.deepEqual(baseline, { alpha: true, beta: false });
  assert.deepEqual(M.pending({ baseline, checked: { alpha: true, beta: false }, present: present(mods) }), []);
  assert.equal(M.pendingText([]), '');
});

test('toggling a mod is pending until Apply, and toggling it back is not', () => {
  const baseline = M.adopt(null, mods);
  const checked = { alpha: false, beta: true };
  assert.deepEqual(M.pending({ baseline, checked, present: present(mods) }),
    [{ name: 'alpha', change: 'off' }, { name: 'beta', change: 'on' }]);
  assert.match(M.pendingText(M.pending({ baseline, checked, present: present(mods) })), /press Apply/);
  assert.deepEqual(M.pending({ baseline, checked: { alpha: true, beta: false }, present: present(mods) }), []);
});

test('a changed setting is pending; the same values are not', () => {
  const baseline = M.adopt(null, mods);
  const settingsBaseline = { alpha: JSON.stringify({ rate: 1 }) };
  const checked = { alpha: true, beta: false };
  assert.deepEqual(M.pending({ baseline, checked, present: present(mods), settings: { alpha: { rate: 2 } }, settingsBaseline }),
    [{ name: 'alpha', change: 'settings' }]);
  assert.deepEqual(M.pending({ baseline, checked, present: present(mods), settings: { alpha: { rate: 1 } }, settingsBaseline }), []);
});

test('an install that is on waits for Apply; a skin installs itself', () => {
  let baseline = M.adopt(null, mods);
  const after = [...mods, { name: 'gamma', enabled: true }, { name: 'blue', enabled: true, kind: 'skin' }];
  baseline = M.adopt(baseline, after);
  assert.deepEqual(M.pending({ baseline, checked: { alpha: true, beta: false, gamma: true, blue: true }, present: present(after) }),
    [{ name: 'gamma', change: 'on' }]);
});

test('removing a mod that was on waits for Apply; one that was off does not', () => {
  const baseline = M.adopt(null, mods);
  const left = mods.filter(m => m.name !== 'alpha');
  assert.deepEqual(M.pending({ baseline, checked: { beta: false }, present: present(left) }),
    [{ name: 'alpha', change: 'removed' }]);
  const left2 = mods.filter(m => m.name !== 'beta');
  assert.deepEqual(M.pending({ baseline, checked: { alpha: true }, present: present(left2) }), []);
});

test('pending → applied → reopened', () => {
  let baseline = M.adopt(null, mods);
  const checked = { alpha: false, beta: true };
  assert.equal(M.pending({ baseline, checked, present: present(mods) }).length, 2);

  // Apply: the server now runs what was ticked.
  baseline = M.applied(mods, checked);
  assert.deepEqual(M.pending({ baseline, checked, present: present(mods) }), []);

  // With the game open, the line asks for a reopen...
  const after = 3;
  assert.deepEqual(M.appliedNotice(after, { open: true, launches: 3 }),
    { text: 'Mods applied. Reopen the game to load them.', button: 'Reopen game' });
  // ...with none open, it says the next launch picks them up...
  assert.deepEqual(M.appliedNotice(after, { open: false, launches: 3 }),
    { text: 'Mods applied. They load the next time you open the game.', button: 'Open game' });
  // ...and once the client has loaded again, there is nothing left to say.
  assert.equal(M.appliedNotice(after, { open: true, launches: 4 }), null);
  // No Apply yet: no line at all.
  assert.equal(M.appliedNotice(null, { open: true, launches: 0 }), null);
});

test('settings.html loads mods-state.js before the script that uses it', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/settings.html'), 'utf8');
  const loaded = html.indexOf('<script src="mods-state.js"></script>');
  assert.ok(loaded > 0);
  assert.ok(loaded < html.indexOf('ModsState.'));
});
