// Opt-in engine integration. Only a marked, stopped disposable world is allowed.
// The child shell faults; no rAthena process or player database is exercised.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
if (!process.env.RO_E2E_WORLD || !process.env.STACK_BIN)
  throw Error('Set RO_E2E_WORLD to a stopped disposable world and STACK_BIN to the collector build');
const world = fs.realpathSync(process.env.RO_E2E_WORLD);
assert.equal(JSON.parse(fs.readFileSync(path.join(world, '.ragnarok-e2e.json'))).disposable, true);
const suffix = process.platform === 'win32' ? '.exe' : '';
const supervisor = path.resolve(process.env.STACK_BIN);
const env = { ...process.env, NEBULA_HOME: path.join(world, 'nebula'),
  RAGNAROK_OFFLINE_ROOT: path.join(world, 'runtime'), RAGNAROKMAC_STATE: path.join(world, 'state'),
  RAGNAROKMAC_DOCKER: path.join(world, 'runtime/bin/docker-slim' + suffix),
  NEBULA_BIN: path.join(world, 'runtime/bin/nebula' + suffix) };
const invoke = (binary, args, timeout = 30000) => spawnSync(binary, args, { env, encoding: 'utf8', timeout });
const dk = args => invoke(env.RAGNAROKMAC_DOCKER, args);
const run = verb => invoke(supervisor, [verb], 120000);
const report = { supervisorSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(supervisor)).digest('hex'), fixture: 'A child Alpine shell receives SIGSEGV; not an rAthena reproducer', checks: [] };
async function freePorts() {
  for (const port of [3338, 6900, 6121, 5121, 7462]) await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); reject(Error('Occupied host port; stop the existing world first')); });
    socket.once('error', e => e.code === 'ECONNREFUSED' ? resolve() : reject(e));
    socket.setTimeout(1000, () => { socket.destroy(); reject(Error('Cannot verify a free host port')); });
  });
}
async function main() {
  await freePorts();
  const out = path.join(world, 'account-tests', 'crash-capture-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  let started = false, created = false;
  try {
    assert.equal(invoke(env.NEBULA_BIN, ['up']).status, 0, 'Could not start disposable VM');
    started = true;
    const socket = path.join(world, 'nebula/run/docker.sock');
    env.DOCKER_HOST = process.platform === 'win32'
      ? 'tcp://127.0.0.1:' + fs.readFileSync(socket, 'utf8').trim() : 'unix://' + socket;
    let healthy = false;
    for (let n = 0; n < 60; n++) {
      if (dk(['ps', '-aq']).status === 0) { healthy = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(healthy, true, 'Disposable engine did not become ready');
    for (const name of ['ragnarok-map', 'ragnarok-char', 'ragnarok-login', 'ragnarok-db']) {
      const result = dk(['ps', '-aq', '--filter', 'name=' + name]);
      assert.equal(result.status, 0, 'Cannot inspect owned engine');
      assert.equal(result.stdout.trim(), '', 'Existing world container; refused diagnostic fixture');
    }
    // A child process avoids Linux PID 1's special default signal semantics.
    const command = 'echo "diagnostic fixture: deliberate shell fault"; /bin/sh -c \'kill -SEGV $$\'; result=$?; echo "child exit: $result"; exit "$result"';
    assert.equal(dk(['run', '-d', '--name', 'ragnarok-map', 'ragnarokmac/rathena:20221005', '/bin/sh', '-c', command]).status, 0,
      'Cannot create diagnostic fixture');
    created = true;
    let meta;
    for (let n = 0; n < 60; n++) {
      const result = dk(['inspect', 'ragnarok-map']); assert.equal(result.status, 0);
      meta = JSON.parse(result.stdout)[0];
      if (meta.State.Status === 'exited') break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(meta.State.Status, 'exited'); assert.equal(meta.State.ExitCode, 139);
    const first = run('capture-crashes'); assert.equal(first.status, 0, 'Collector failed');
    assert.match(first.stdout, /private evidence saved/);
    const dir = path.join(world, 'state/crashes/reports');
    const matching = fs.readdirSync(dir).filter(name => name.endsWith('.log')
      && fs.readFileSync(path.join(dir, name), 'utf8').includes(meta.Id));
    assert.equal(matching.length, 1);
    const body = fs.readFileSync(path.join(dir, matching[0]), 'utf8');
    const manifest = JSON.parse(body.split('\n')[0]);
    assert.equal(manifest.reason, 'nonzero-exit'); assert.equal(manifest.exitCode, 139);
    assert.equal(manifest.backtraceAvailable, false); assert.match(body, /deliberate shell fault/);
    const second = run('capture-crashes'); assert.equal(second.status, 0); assert.equal(second.stdout.trim(), '');
    report.checks.push('actual guest exit139 captured', 'fault log retained', 'matching image/container identity retained',
      'second capture deduplicated', 'no native stack claimed');
    report.manifest = manifest; report.artifact = matching[0];
  } finally {
    if (created) {
      assert.equal(run('down').status, 0, 'Owned cleanup failed');
      if (report.artifact) assert.ok(fs.existsSync(path.join(world, 'state/crashes/reports', report.artifact)));
    } else if (started) assert.equal(invoke(env.NEBULA_BIN, ['down'], 120000).status, 0, 'Owned VM cleanup failed');
    await freePorts();
    report.checks.push('owned VM stopped and all fixed ports free');
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log('Actual guest fault-capture fixture passed. Evidence:', out);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
