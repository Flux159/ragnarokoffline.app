// Validate the diagnostic runtime in the real guest, without starting SQL or
// rAthena. Only an explicitly marked, stopped disposable world is accepted.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
for (const key of ['RO_E2E_WORLD', 'RO_E2E_SANITIZER_ARCHIVE', 'RO_E2E_SANITIZER_SHA256', 'RO_E2E_SANITIZER_IMAGE'])
  if (!process.env[key]) throw Error(`Missing ${key}`);
const world = fs.realpathSync(process.env.RO_E2E_WORLD);
assert.equal(JSON.parse(fs.readFileSync(path.join(world, '.ragnarok-e2e.json'))).disposable, true);
const archive = fs.realpathSync(process.env.RO_E2E_SANITIZER_ARCHIVE);
const image = process.env.RO_E2E_SANITIZER_IMAGE;
assert.match(image, /^ragnarokmac\/rathena-diagnostics:[a-f0-9]{40}$/);
assert.match(process.env.RO_E2E_SANITIZER_SHA256, /^[a-f0-9]{64}$/);
const suffix = process.platform === 'win32' ? '.exe' : '';
const bin = path.join(world, 'runtime/bin');
const env = { ...process.env, NEBULA_HOME: path.join(world, 'nebula') };
const out = path.join(world, 'account-tests', 'sanitizer-guest-' + Date.now());
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const report = { image, checks: [], startedAt: new Date().toISOString() };
const call = (name, args, timeout = 30000) => spawnSync(path.join(bin, name + suffix), args,
  { env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
const dk = (args, timeout) => call('docker-slim', args, timeout);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePorts() {
  for (const port of [3338, 6900, 6121, 5121, 7462]) await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); reject(Error(`Occupied host port ${port}`)); });
    socket.once('error', e => e.code === 'ECONNREFUSED' ? resolve() : reject(e));
    socket.setTimeout(5000, () => { socket.destroy(); reject(Error(`Unknown host port ${port}`)); });
  });
}
async function main() {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(archive)) hash.update(bytes);
  report.archiveSha256 = hash.digest('hex');
  assert.equal(report.archiveSha256, process.env.RO_E2E_SANITIZER_SHA256, 'Archive checksum mismatch');
  await freePorts();
  let started = false, created = false, failure;
  const name = 'ragnarok-sanitizer-fixture';
  try {
    started = true;
    assert.equal(call('nebula', ['up'], 120000).status, 0, 'Disposable VM did not start');
    const socket = path.join(world, 'nebula/run/docker.sock');
    env.DOCKER_HOST = process.platform === 'win32'
      ? 'tcp://127.0.0.1:' + fs.readFileSync(socket, 'utf8').trim() : 'unix://' + socket;
    let ready = false;
    for (let n = 0; n < 60; n++) {
      if (dk(['ps', '-aq']).status === 0) { ready = true; break; }
      await pause(250);
    }
    assert.equal(ready, true, 'Disposable engine not ready');
    const existing = dk(['ps', '-aq']);
    assert.equal(existing.status, 0);
    assert.equal(existing.stdout.trim(), '', 'Refusing a world with existing containers');
    assert.equal(dk(['load', '-i', archive], 300000).status, 0, 'Diagnostic image import failed');
    const createdResult = dk(['run', '-d', '--name', name, image, 'sh', '/diagnostics/verify.sh', '/tmp/fixture-evidence']);
    assert.equal(createdResult.status, 0, 'Diagnostic fixture could not start');
    created = true;
    let meta;
    for (let n = 0; n < 120; n++) {
      const result = dk(['inspect', name]);
      assert.equal(result.status, 0);
      meta = JSON.parse(result.stdout)[0];
      if (meta.State.Status === 'exited') break;
      await pause(500);
    }
    const logs = dk(['logs', '--tail', '300', name]);
    const text = logs.stdout + logs.stderr;
    fs.writeFileSync(path.join(out, 'synthetic-faults.log'), text, { mode: 0o600 });
    report.container = meta.Id;
    report.imageId = meta.Image;
    report.exitCode = meta.State.ExitCode;
    assert.equal(meta.State.Status, 'exited', 'Fixture did not finish');
    assert.equal(meta.State.ExitCode, 0, 'Sanitizer validation failed; see private synthetic-faults.log');
    assert.match(text, /ASan use-after-free, UBSan overflow and original SIGSEGV source lookup passed/);
    report.checks.push('archive checksum matched', 'real guest ASan and UBSan faults symbolized',
      'legacy handler did not replace sanitizer SIGSEGV capture', 'no SQL or rAthena process started');
  } catch (error) {
    failure = error;
    report.failure = error.message;
  } finally {
    if (created) {
      const result = dk(['rm', '-f', name]);
      if (result.status !== 0) report.cleanupFailure = 'Could not remove the owned synthetic fixture';
    }
    if (started && call('nebula', ['down'], 120000).status !== 0)
      report.cleanupFailure = 'Could not stop the owned disposable VM';
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await freePorts(); break; } catch (error) {
        if (attempt === 59) report.cleanupFailure = error.message;
        else await pause(250);
      }
    }
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  if (failure) throw failure;
  if (report.cleanupFailure) throw Error(report.cleanupFailure);
  console.log('Real guest sanitizer validation passed. Evidence:', out);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
