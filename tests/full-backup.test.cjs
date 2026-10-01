'use strict';
// `ragnarok-stack backup --full` / `restore --full`, end to end, against a
// stand-in engine (fixtures/backup-engine.rs) that models one MariaDB
// container: which era's volume it runs on, and that volume's data as a file.
// No VM, no real database. The archive is read back with Node's own zlib, so
// this also checks the supervisor's hand-rolled gzip is ordinary gzip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

function untar(file) {
  const bytes = zlib.gunzipSync(fs.readFileSync(file));
  const out = new Map();
  let at = 0;
  let pending = null;
  while (at + 512 <= bytes.length) {
    const h = bytes.subarray(at, at + 512);
    if (h.every(b => b === 0)) break;
    const field = (s, n) => h.subarray(s, s + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const body = bytes.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      pending = m && m[1];
      continue;
    }
    out.set(pending || field(0, 100), Buffer.from(body));
    pending = null;
  }
  return out;
}

function files(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, base, out);
    else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
  }
  return out;
}

test('a whole world backs up from both eras and restores into another install', { skip: !process.env.STACK_BIN }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-full-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine' + (process.platform === 'win32' ? '.exe' : ''));
  const built = spawnSync('rustc', [path.join(__dirname, 'fixtures/backup-engine.rs'), '-o', engine], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);

  // An install: its data root, state, runtime tree and engine fixture.
  function install(name, version, volumes) {
    const home = path.join(root, name);
    const fixture = path.join(home, 'engine');
    for (const d of ['state', 'runtime', 'engine/volumes']) fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, 'runtime/APP_VERSION'), version + '\n');
    for (const [volume, data] of Object.entries(volumes)) fs.writeFileSync(path.join(fixture, 'volumes', volume + '.sql'), data);
    fs.writeFileSync(path.join(fixture, 'current'), 'ragnarokmac-db');
    fs.writeFileSync(path.join(fixture, 'db-running'), '');
    fs.writeFileSync(path.join(home, 'state/.db-volume'), 'ragnarokmac-db');
    const run = (...args) => spawnSync(process.env.STACK_BIN, args, {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, RO_BACKUP_FIXTURE: fixture, RAGNAROK_OFFLINE_HOME: home, RAGNAROK_OFFLINE_ROOT: path.join(home, 'runtime'),
        RAGNAROKMAC_STATE: path.join(home, 'state'), RAGNAROKMAC_DOCKER: engine, NEBULA_HOME: path.join(home, 'nebula-never-started') },
    });
    return { home, fixture, state: path.join(home, 'state'), run,
      volume: v => fs.readFileSync(path.join(fixture, 'volumes', v + '.sql'), 'utf8'),
      calls: () => { try { return fs.readFileSync(path.join(fixture, 'calls'), 'utf8'); } catch { return ''; } } };
  }

  const source = install('source', '1.3.5', {
    'ragnarokmac-db': '-- renewal: Agent, level 150\n',
    'ragnarokmac-db-prere': '-- pre-renewal: Swordie, level 99\n',
  });
  const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
  put(path.join(source.state, 'settings.json'), '{\n  "base_exp_rate": 300,\n  "free_kafra_warp": true\n}\n');
  put(path.join(source.state, 'free_kafra_warp'), '');
  put(path.join(source.state, 'mod-settings.json'), '{\n  "cursor": {\n    "size": 2\n  }\n}\n');
  put(path.join(source.state, 'conf/battle_conf.txt'), 'base_exp_rate: 300\n');
  put(path.join(source.state, 'mods/disabled.txt'), 'npc-pack\n');
  put(path.join(source.state, 'mods/cursor/mod.json'), '{"name":"cursor","version":"1.0.0"}');
  put(path.join(source.state, 'mods/npc-pack/npc/custom/quest.txt'), 'prontera,150,150,4\tscript\tQuest\t4_M_01,{ end; }\n');
  put(path.join(source.state, 'agent/connection.json'), '{"token":"SECRET-agent-token"}');
  put(path.join(source.home, 'sharing/credentials.bin'), 'SECRET-cloudflare');
  put(path.join(source.home, 'client.json'), '{"mode":"host","data_grf":"/games/data.grf","join_host":"https://a.example/#SECRET-invite"}');

  const archive = path.join(root, 'world.tar.gz');
  let r = source.run('backup', '--full', archive);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /renewal and pre-renewal databases, 2 installed mods/);
  // It reached the pre-renewal volume and came back to the one that was running.
  assert.match(source.calls(), /-v ragnarokmac-db-prere:\/var\/lib\/mysql/);
  assert.equal(fs.readFileSync(path.join(source.fixture, 'current'), 'utf8'), 'ragnarokmac-db');
  assert.ok(fs.existsSync(path.join(source.fixture, 'db-running')));
  assert.equal(fs.readFileSync(path.join(source.state, '.db-volume'), 'utf8'), 'ragnarokmac-db');
  if (process.platform !== 'win32') assert.equal(fs.statSync(archive).mode & 0o777, 0o600);

  const entries = untar(archive);
  assert.equal([...entries.keys()][0], 'manifest.json');
  const manifest = JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.kind, 'backup');
  assert.equal(manifest.app_version, '1.3.5');
  assert.deepEqual(manifest.databases.map(d => d.era), ['renewal', 'prerenewal']);
  assert.equal(entries.get('database/prerenewal.sql').toString(), '-- pre-renewal: Swordie, level 99\n');
  assert.equal(entries.get('mods/disabled.txt').toString(), 'npc-pack\n');
  const crypto = require('node:crypto');
  for (const f of manifest.files) {
    assert.equal(crypto.createHash('sha256').update(entries.get(f.path)).digest('hex'), f.sha256, f.path);
  }
  for (const [name, body] of entries) assert.doesNotMatch(body.toString('latin1'), /SECRET-/, name);
  assert.equal(JSON.parse(entries.get('machine/client.json')).data_grf, '/games/data.grf');

  // A different install, with its own world, takes the archive.
  const target = install('target', '1.3.5', { 'ragnarokmac-db': '-- the target\'s own renewal world\n' });
  put(path.join(target.state, 'mods/old-mod/npc/a.txt'), 'old');
  put(path.join(target.state, 'settings.json'), '{\n  "base_exp_rate": 100\n}\n');
  r = target.run('restore', '--full', archive);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const safety = /saved everything as it was before this restore: (.*)/.exec(r.stdout)[1].trim();
  assert.match(r.stdout, new RegExp(`The pre-restore backup is ${safety.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  // Both eras' characters are back, in their own volumes.
  assert.equal(target.volume('ragnarokmac-db'), '-- renewal: Agent, level 150\n');
  assert.equal(target.volume('ragnarokmac-db-prere'), '-- pre-renewal: Swordie, level 99\n');
  // The game was left stopped, the running database is the one it was.
  assert.equal(fs.readFileSync(path.join(target.fixture, 'current'), 'utf8'), 'ragnarokmac-db');
  // The interserver login was reset to this install's (stock s1/p1 here).
  assert.match(fs.readFileSync(path.join(target.fixture, 'sql'), 'utf8'), /ragnarokmac-db-prere: UPDATE login SET user_pass='p1'/);
  // Settings and mods are the source's, file for file.
  const keep = o => Object.fromEntries(Object.entries(o).filter(([k]) => /^(mods\/|settings\.json|mod-settings\.json|free_kafra_warp|conf\/battle_conf\.txt)/.test(k)));
  assert.deepEqual(keep(files(target.state)), keep(files(source.state)));
  assert.ok(!fs.existsSync(path.join(target.state, 'agent')));
  // And the world it replaced is in the pre-restore backup.
  const before = untar(safety);
  assert.equal(before.get('database/renewal.sql').toString(), '-- the target\'s own renewal world\n');
  assert.equal(before.get('mods/old-mod/npc/a.txt').toString(), 'old');
  assert.equal(JSON.parse(before.get('manifest.json')).databases.length, 1);

  // An older app refuses it before touching anything, and says what to install.
  const older = install('older', '1.2.0', { 'ragnarokmac-db': '-- older world\n' });
  r = older.run('restore', '--full', archive);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Install Ragnarok Offline 1\.3\.5 or later/);
  assert.equal(older.volume('ragnarokmac-db'), '-- older world\n');
  assert.ok(!fs.existsSync(path.join(older.state, 'world-backups')));
  assert.match(safety, /world-backups/);
  assert.doesNotMatch(older.calls(), /stop|sh -c/);

  // A damaged archive is refused the same way.
  const bytes = fs.readFileSync(archive);
  bytes[bytes.length - 7] ^= 0xff;
  fs.writeFileSync(path.join(root, 'damaged.tar.gz'), bytes);
  r = target.run('restore', '--full', path.join(root, 'damaged.tar.gz'));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /damaged|checksum/);
});
