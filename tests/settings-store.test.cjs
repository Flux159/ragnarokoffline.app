// windows-latest checks text files out with CRLF; normalise on read so assertions about file
// content do not depend on the checkout's newline convention.
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
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), body);
  }
});

test('a damaged deletion setting is refused rather than read as no wait', t => {
  const file = fixture(t);
  store.write(file, { instant_character_deletion: true }, defaults);
  assert.equal(store.read(file, defaults).instant_character_deletion, true);
  const previous = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const update of [{ instant_character_deletion: 'true' }, { instant_character_deletion: 1 }, { instant_character_deletion: null }]) {
    assert.throws(() => store.write(file, update, defaults), /character deletion setting/);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), previous);
  }
  // An install that has never opened the setting keeps rAthena's wait, and
  // reading one must not rewrite the file to say so.
  fs.writeFileSync(file, '{"max_aspd":190}');
  assert.equal(store.read(file, defaults).instant_character_deletion, undefined);
  assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), '{"max_aspd":190}');
});

test('invalid updates cannot erase or reopen owner policy', t => {
  const file = fixture(t);
  store.write(file, { open_registration: false }, defaults);
  const previous = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const update of [null, [], { open_registration: undefined }, { open_registration: 'true' }, { open_registration: 1 }]) {
    assert.throws(() => store.write(file, update, defaults));
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), previous);
  }
});

test('the real supervisor rejects corrupt policy before startup or Repair reaches the engine', { skip: !process.env.STACK_BIN }, t => {
  const { spawnSync } = require('node:child_process');
  const file = fixture(t);
  const root = path.dirname(file);
  const fake = path.join(root, 'must-not-execute' + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(fake, 'This is deliberately not an executable.', { mode: 0o700 });
  fs.writeFileSync(file, '{"open_registration":"false"}');
  for (const verb of ['up', 'repair']) {
    const result = spawnSync(process.env.STACK_BIN, [verb], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, RAGNAROK_OFFLINE_ROOT: root, RAGNAROKMAC_STATE: root,
        NEBULA_HOME: path.join(root, 'never-started'), NEBULA_BIN: fake, RAGNAROKMAC_DOCKER: fake },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot read account creation policy/);
    assert.equal(fs.existsSync(path.join(root, 'never-started')), false);
    assert.equal(fs.existsSync(path.join(root, 'phase')), false);
    assert.equal(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), '{"open_registration":"false"}');
  }
});

test('the server clock takes a zone name or null, and nothing that could leave the docker command line', t => {
  const file = fixture(t);
  for (const zone of [null, 'UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'America/Port-au-Prince']) {
    store.write(file, { server_timezone: zone }, defaults);
    assert.equal(store.read(file, defaults).server_timezone, zone);
  }
  for (const zone of ['', 'Europe/', '/UTC', 'Europe/Berlin; rm -rf /', 'UTC TZ=x', '../etc/passwd', 'a/b/c/d', 9, true, 'A'.repeat(65)]) {
    assert.throws(() => store.write(file, { server_timezone: zone }, defaults), /server clock setting/, String(zone));
  }
});

test('favourite mods are a list of mod folder names, and nothing else', t => {
  const file = fixture(t);
  for (const list of [[], ['prontera-vendors'], ['autoloot', 'royal-nightmare', 'whosell'], Array.from({ length: 500 }, (_, i) => `mod-${i}`)]) {
    store.write(file, { mod_favorites: list }, defaults);
    assert.deepEqual(store.read(file, defaults).mod_favorites, list);
  }
  for (const bad of ['autoloot', [''], ['../mods'], ['a b'], [7], [null], ['x'.repeat(65)], Array.from({ length: 501 }, (_, i) => `m${i}`)]) {
    assert.throws(() => store.write(file, { mod_favorites: bad }, defaults), /favourite mods/, JSON.stringify(bad).slice(0, 40));
  }
});
