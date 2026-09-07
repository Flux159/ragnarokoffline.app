'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { effective } = require('../electron/hosting-policy');
const store = require('../electron/settings-store');

test('legacy LAN migrates only to LAN and explicit internet scopes keep loopback bindings', () => {
  assert.equal(effective({ lan: false }, {}).hosting_scope, 'local');
  assert.equal(effective({ lan: true }, {}).hosting_scope, 'lan');
  for (const lan of ['false', 'true', 1, null]) assert.throws(() => effective({ lan }, {}), /Invalid LAN setting/);
  for (const scope of ['local', 'lan', 'friends', 'public']) {
    const client = effective({ lan: true, mode: 'join', join_host: 'https://example.org' }, { hosting_scope: scope });
    assert.equal(client.lan, scope === 'lan');
    assert.equal(client.hosting_scope, scope);
    assert.equal(client.mode, 'join');
    assert.equal(client.join_host, 'https://example.org');
  }
  for (const scope of [null, undefined, true, '', 'Friends']) {
    assert.throws(() => effective({ lan: true }, { hosting_scope: scope }), /Invalid hosting scope/);
  }
});

test('scope is strict and survives unrelated account/era settings without silently changing legacy state', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.equal(Object.hasOwn(store.read(file, {}), 'hosting_scope'), false);
  store.write(file, { hosting_scope: 'friends', open_registration: true }, {});
  store.write(file, { prerenewal: true }, {});
  assert.deepEqual(store.read(file, {}), { hosting_scope: 'friends', open_registration: true, prerenewal: true });
  const before = fs.readFileSync(file, 'utf8');
  for (const hosting_scope of [null, '', 'Friends', false]) {
    assert.throws(() => store.write(file, { hosting_scope }, {}));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('real startup and Repair reject invalid or unprepared internet scopes before engine mutation', { skip: !process.env.STACK_BIN }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-scope-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'must-not-execute' + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(fake, 'not executable', { mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  for (const hosting_scope of ['friends', 'public', 'invalid', null]) {
    fs.writeFileSync(file, JSON.stringify({ hosting_scope, open_registration: true }));
    for (const verb of ['up', 'repair']) for (const flags of [[], ['--lan']]) {
      const r = spawnSync(process.env.STACK_BIN, [verb, ...flags], { encoding: 'utf8', timeout: 5000,
        env: { ...process.env, RAGNAROK_OFFLINE_ROOT: dir, RAGNAROKMAC_STATE: dir,
          NEBULA_HOME: path.join(dir, 'never-started'), NEBULA_BIN: fake, RAGNAROKMAC_DOCKER: fake } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Invalid hosting scope|conflicts with the saved hosting scope|managed service credentials/);
      assert.equal(fs.existsSync(path.join(dir, 'never-started')), false);
      assert.equal(fs.existsSync(path.join(dir, 'phase')), false);
    }
  }
});
