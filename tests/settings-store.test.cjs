const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../electron/settings-store');
const defaults = { open_registration: true, prerenewal: false };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-registration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'settings.json');
}

test('legacy settings retain local signup; owner policy survives partial updates and era changes', t => {
  const file = fixture(t);
  assert.deepEqual(store.read(file, defaults), defaults);
  fs.writeFileSync(file, '{"max_aspd":190}');
  assert.equal(store.read(file, defaults).open_registration, true);
  store.write(file, { open_registration: false }, defaults);
  store.write(file, { prerenewal: true }, defaults);
  assert.deepEqual(store.read(file, defaults), { open_registration: false, prerenewal: true, max_aspd: 190 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('malformed saved policy fails closed and is never overwritten with defaults', t => {
  const file = fixture(t);
  for (const body of ['{', 'null', '[]', '{"open_registration":"false"}', '{"open_registration":null}', ' '.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, body);
    assert.throws(() => store.read(file, defaults), /Cannot read account creation policy/);
    assert.throws(() => store.write(file, { prerenewal: true }, defaults), /Cannot read account creation policy/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});

test('invalid updates cannot erase or reopen owner policy', t => {
  const file = fixture(t);
  store.write(file, { open_registration: false }, defaults);
  const previous = fs.readFileSync(file, 'utf8');
  for (const update of [null, [], { open_registration: undefined }, { open_registration: 'true' }, { open_registration: 1 }]) {
    assert.throws(() => store.write(file, update, defaults));
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  }
});
