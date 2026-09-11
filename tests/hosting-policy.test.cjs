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

function engineFixture(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ro-scope-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Nothing here may be executed. If the supervisor reaches the engine, it
  // reaches this instead, and says so loudly.
  const fake = path.join(dir, 'must-not-execute' + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(fake, 'not executable', { mode: 0o700 });
  const file = path.join(dir, 'settings.json');
  const run = (verb, flags, timeout = 5000) => spawnSync(process.env.STACK_BIN, [verb, ...flags], {
    encoding: 'utf8', timeout,
    env: { ...process.env, RAGNAROK_OFFLINE_ROOT: dir, RAGNAROKMAC_STATE: dir,
      NEBULA_HOME: path.join(dir, 'never-started'), NEBULA_BIN: fake, RAGNAROKMAC_DOCKER: fake },
  });
  const save = settings => fs.writeFileSync(file, JSON.stringify({ open_registration: true, ...settings }));
  return { dir, file, run, save };
}

test('real startup and Repair reject an unusable hosting scope before engine mutation', { skip: !process.env.STACK_BIN }, t => {
  const { dir, run, save } = engineFixture(t, 'engine');
  // A scope that cannot be read is a hard stop. It is not narrowed to
  // something safe, because a setting nobody can read is not a preference --
  // it is damage, and guessing at it is how a player ends up hosting
  // something they never asked to host.
  for (const hosting_scope of ['invalid', null]) {
    save({ hosting_scope });
    for (const verb of ['up', 'repair']) for (const flags of [[], ['--lan']]) {
      const r = run(verb, flags);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Invalid hosting scope/);
      assert.equal(fs.existsSync(path.join(dir, 'never-started')), false);
      assert.equal(fs.existsSync(path.join(dir, 'phase')), false);
    }
  }
  // --lan against a saved internet scope stays a conflict rather than a
  // narrowing: internet modes require loopback game ports and the flag asks
  // for the opposite, so there is no reading of it that is safe to act on.
  for (const hosting_scope of ['friends', 'public']) {
    save({ hosting_scope });
    for (const verb of ['up', 'repair']) {
      const r = run(verb, ['--lan']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /conflicts with the saved hosting scope/);
      assert.equal(fs.existsSync(path.join(dir, 'never-started')), false);
      assert.equal(fs.existsSync(path.join(dir, 'phase')), false);
    }
  }
});

// The reported bug: prepare renewal for friends, switch to pre-renewal, and
// every start refused because the credentials are per era and the scope is
// not. Repair refused too, and the instructions in the error needed a running
// server, so there was no way out.
test('an internet scope with no credentials for this era starts Local rather than refusing', { skip: !process.env.STACK_BIN }, t => {
  const { file, run, save } = engineFixture(t, 'unprepared');
  // Both internet scopes and both verbs, paired rather than crossed: these
  // runs reach the engine and take seconds each, and the narrowing is one
  // decision made in one place before either verb gets going.
  for (const [hosting_scope, verb] of [['friends', 'up'], ['public', 'repair']]) {
    save({ hosting_scope });
    // The engine is a stub, so this still fails -- but it now fails *at the
    // engine*, which is the whole point: policy let it through.
    const r = run(verb, [], 20000);
    assert.match(r.stdout, /has not been prepared for internet hosting/);
    assert.doesNotMatch(r.stderr, /managed service credentials/);
    // Narrowing only, and only for this start: the player's setting is still
    // theirs, so going back to the era they prepared goes back to hosting.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hosting_scope, hosting_scope);
  }
});
